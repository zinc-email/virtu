/**
 * DSN composition + enqueue for a failed queue row — the shared half of
 * "bounce this message": resolve the originator, name the failure safely
 * (a forward bounce goes to the OUTSIDE sender, so it must describe the
 * failure in terms of the ALIAS — never envelope_to, the user's real
 * backing mailbox — and sanitize the diagnostic, which echoes it; leaking
 * either would de-anonymize the alias to anyone who can force a bounce),
 * deduplicate on the original queue row, DKIM-sign, enqueue with the null reverse
 * path.
 *
 * Two callers, two policies around this core:
 *   - deliverd's handlePermanentFailure — records bounce accounting FIRST
 *     (the auto-disable thresholds), then sends the DSN.
 *   - the operator bounce (operatorBounce.ts) — sends ONLY the DSN. An
 *     operator killing a message is not a mailbox-health signal, so it must
 *     never touch the bounce ledger.
 */

import { eq } from "drizzle-orm";
import { config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { aliases, type EmailLog, mailboxes, outboundMessages } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { buildDsn, sanitizeForwardDiagnostic } from "../mail/dsn.ts";
import { parseMessage, type VerpInfo } from "../mail/index.ts";
import { signOutbound } from "../mailauth/index.ts";
import { dsnTotal } from "../metrics/index.ts";
import { enqueue } from "../queue/index.ts";
import { loadDkimKey } from "./dkim.ts";

const logger = createLogger("dsn");

/**
 * Where the DSN goes: the failed message's ORIGINATOR. Forward phase → the
 * outside contact's real address; reply phase → the user's own mailbox.
 */
export async function resolveDsnRecipient(
  db: Db,
  log: EmailLog,
  verp: VerpInfo,
): Promise<string | null> {
  if (verp.type === "bounce_forward") {
    // The return path, and only when SPF vouched for it. The contact's
    // address is the header From — the sender's choice, so a DSN there is
    // backscatter to whoever they named (mx.ts records both facts).
    if (log.envelopeFrom === null || log.envelopeFrom === "" || !log.senderAuthenticated) {
      return null;
    }
    return log.envelopeFrom;
  }
  if (log.mailboxId === null) return null;
  const rows = await db
    .select({ email: mailboxes.email })
    .from(mailboxes)
    .where(eq(mailboxes.id, log.mailboxId))
    .limit(1);
  return rows[0]?.email ?? null;
}

export interface FailureDsnInput {
  /** The failed row's identity + bytes (headers feed the DSN body). */
  row: { id: number; raw: Uint8Array; envelopeTo: string };
  /** Parsed VERP — bounce_forward | bounce_reply only (callers gate). */
  verp: VerpInfo;
  /** The email_log the VERP id resolves to. */
  emailLog: EmailLog;
  /** Failure text; forwarded diagnostics get sanitized here. */
  diagnostic: string;
}

export type FailureDsnOutcome =
  | { outcome: "sent"; queueId: number }
  | { outcome: "suppressed" }
  | {
      outcome: "skipped";
      reason:
        | "originator_unresolvable"
        | "originator_unauthenticated"
        | "alias_unresolvable"
        | "flagged_inbound";
    };

/** Compose, sign and enqueue the DSN for one failed row. */
export async function sendFailureDsn(db: Db, input: FailureDsnInput): Promise<FailureDsnOutcome> {
  return db.transaction((tx) => composeFailureDsn(tx, input));
}

async function composeFailureDsn(db: Db, input: FailureDsnInput): Promise<FailureDsnOutcome> {
  const { row, verp, emailLog } = input;

  // Backscatter guard: a forward the MX accepted only under a "flag" verdict
  // (SPF hard-fail with no DMARC, DMARC quarantine fail) has a sender we
  // could not authenticate — the classic forged envelope. Bouncing it back
  // would mail an innocent third party a copy of spam under our signature,
  // which is exactly what lands an IP on backscatter lists. The bounce
  // ledger has already counted the failure (mailbox health is real either
  // way); only the outbound DSN is withheld. Reply-phase DSNs go to our own
  // user and are never affected.
  if (verp.type === "bounce_forward" && emailLog.isSpam) {
    dsnTotal.inc({ outcome: "skipped" });
    logger.info("dsn_skipped", {
      queueId: row.id,
      reason: "flagged_inbound",
      flag: emailLog.spamStatus,
    });
    return { outcome: "skipped", reason: "flagged_inbound" };
  }

  const recipient = await resolveDsnRecipient(db, emailLog, verp);
  if (recipient === null) {
    // A forward whose envelope sender SPF could not vouch for: the failure
    // is still booked against the mailbox; only the outbound DSN is
    // withheld (a DSN to an unauthenticated return path is backscatter).
    const reason =
      verp.type === "bounce_forward" &&
      emailLog.envelopeFrom !== null &&
      emailLog.envelopeFrom !== "" &&
      !emailLog.senderAuthenticated
        ? "originator_unauthenticated"
        : "originator_unresolvable";
    dsnTotal.inc({ outcome: "skipped" });
    logger.info("dsn_skipped", { queueId: row.id, reason });
    return { outcome: "skipped", reason };
  }

  let failedRecipient = row.envelopeTo;
  let diagnostic = input.diagnostic;
  if (verp.type === "bounce_forward") {
    const aliasRows =
      emailLog.aliasId === null
        ? []
        : await db
            .select({ email: aliases.email })
            .from(aliases)
            .where(eq(aliases.id, emailLog.aliasId))
            .limit(1);
    const aliasEmail = aliasRows[0]?.email ?? null;
    if (aliasEmail === null) {
      dsnTotal.inc({ outcome: "skipped" });
      logger.info("dsn_skipped", { queueId: row.id, reason: "alias_unresolvable" });
      return { outcome: "skipped", reason: "alias_unresolvable" };
    }
    failedRecipient = aliasEmail;
    diagnostic = sanitizeForwardDiagnostic(diagnostic);
  }

  // The caller holds this lock too; the marker commits with the notice and
  // survives for exactly as long as the original delivery record.
  const [original] = await db
    .select({ dsnQueued: outboundMessages.dsnQueued })
    .from(outboundMessages)
    .where(eq(outboundMessages.id, row.id))
    .for("update");
  if (!original) throw new Error("Failed delivery row missing");
  if (original.dsnQueued) {
    dsnTotal.inc({ outcome: "suppressed" });
    return { outcome: "suppressed" };
  }

  const dsn = buildDsn({
    originalHeaders: parseMessage(row.raw).headers,
    failedRecipient,
    remoteReply: diagnostic,
    reportingMta: config.mailHostname,
    mailDomain: config.mailDomain,
    recipient,
  });

  // Required signing: the durable failure job retries with its effects rolled back.
  const key = await loadDkimKey(db, config.mailDomain, config.dkimSelector);
  let raw: Uint8Array;
  if (key === null) {
    throw new Error("Required DSN signing key unavailable");
  } else {
    const signed = await signOutbound(dsn.headers, dsn.body, { dkimKeys: [key] });
    raw = signed.message;
  }

  const queueId = await enqueue(db, {
    raw,
    envelopeFrom: "", // RFC 5321 §4.5.5: DSNs use the null reverse path
    envelopeTo: recipient,
    maxRawBytes: config.smtpMaxMessageSize,
    // Null reverse path defeats VERP decoding, so the DSN's owner is
    // recorded durably here (the user whose message failed).
    userId: emailLog.userId,
    emailLogId: emailLog.id,
  });
  await db.update(outboundMessages).set({ dsnQueued: true }).where(eq(outboundMessages.id, row.id));
  dsnTotal.inc({ outcome: "sent" });
  logger.info("dsn_enqueued", { queueId, to: recipient, failedQueueId: row.id });
  return { outcome: "sent", queueId };
}
