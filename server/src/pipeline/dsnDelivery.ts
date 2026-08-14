/**
 * DSN composition + enqueue for a failed queue row — the shared half of
 * "bounce this message": resolve the originator, name the failure safely
 * (a forward bounce goes to the OUTSIDE sender, so it must describe the
 * failure in terms of the ALIAS — never envelope_to, the user's real
 * backing mailbox — and sanitize the diagnostic, which echoes it; leaking
 * either would de-anonymize the alias to anyone who can force a bounce),
 * rate-limit through sent_alerts, DKIM-sign, enqueue with the null reverse
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
import { aliases, contacts, type EmailLog, mailboxes } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { buildDsn, sanitizeForwardDiagnostic } from "../mail/dsn.ts";
import { parseMessage, serializeMessage, type VerpInfo } from "../mail/index.ts";
import { signOutbound } from "../mailauth/index.ts";
import { dsnTotal } from "../metrics/index.ts";
import { enqueue } from "../queue/index.ts";
import { claimAlertOnce } from "./bounce.ts";
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
    const rows = await db
      .select({ websiteEmail: contacts.websiteEmail })
      .from(contacts)
      .where(eq(contacts.id, log.contactId))
      .limit(1);
    return rows[0]?.websiteEmail ?? null;
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
  | { outcome: "skipped"; reason: "originator_unresolvable" | "alias_unresolvable" };

/** Compose, sign and enqueue the DSN for one failed row. */
export async function sendFailureDsn(db: Db, input: FailureDsnInput): Promise<FailureDsnOutcome> {
  const { row, verp, emailLog } = input;

  const recipient = await resolveDsnRecipient(db, emailLog, verp);
  if (recipient === null) {
    dsnTotal.inc({ outcome: "skipped" });
    logger.info("dsn_skipped", { queueId: row.id, reason: "originator_unresolvable" });
    return { outcome: "skipped", reason: "originator_unresolvable" };
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

  // Rate limit: one DSN per (user, recipient, alias) per 24h via sent_alerts.
  const claimed = await claimAlertOnce(db, {
    userId: emailLog.userId,
    toEmail: recipient,
    alertType: `dsn_${verp.type}_${emailLog.aliasId ?? emailLog.contactId}`,
  });
  if (!claimed) {
    dsnTotal.inc({ outcome: "suppressed" });
    logger.info("dsn_suppressed", { queueId: row.id, to: recipient, reason: "rate_limit" });
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

  // Sign with the service key; deliver unsigned rather than not at all.
  const key = await loadDkimKey(db, config.mailDomain, config.dkimSelector);
  let raw: Uint8Array;
  if (key === null) {
    logger.warn("dsn_unsigned", { queueId: row.id, reason: "no_active_dkim_key" });
    raw = serializeMessage(dsn.headers, dsn.body);
  } else {
    const signed = await signOutbound(dsn.headers, dsn.body, { dkimKeys: [key] });
    for (const err of signed.errors) {
      logger.error("dsn_dkim_sign_error", {
        queueId: row.id,
        domain: err.signingDomain,
        selector: err.selector,
        error: err.err.message,
      });
    }
    raw = signed.message;
  }

  const queueId = await enqueue(db, {
    raw,
    envelopeFrom: "", // RFC 5321 §4.5.5: DSNs use the null reverse path
    envelopeTo: recipient,
    maxRawBytes: config.smtpMaxMessageSize,
  });
  dsnTotal.inc({ outcome: "sent" });
  logger.info("dsn_enqueued", { queueId, to: recipient, failedQueueId: row.id });
  return { outcome: "sent", queueId };
}
