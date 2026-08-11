/**
 * deliverd — drains the Postgres queue (PLAN Milestone 2/3).
 *
 * The generic worker loop lives in src/queue/worker.ts; this entrypoint
 * wires it to config, bounce accounting and DSN generation. A permanent
 * failure whose envelope from parses as one of our VERP addresses:
 *
 *   1. marks the referenced email_log bounced (recordBounce — drives the
 *      alias auto-disable thresholds), then
 *   2. composes a real RFC 3464 DSN (mail/dsn.ts) addressed by phase:
 *      bounce_forward → the original SENDER (the contact's real address);
 *      bounce_reply   → our own user's mailbox (their real address).
 *      The DSN is DKIM-signed with the service key and enqueued with the
 *      NULL reverse path.
 *
 * Never bounce a bounce: null-reverse-path rows (DSNs themselves) trigger
 * no bounce action. Transactional VERP failures resolve the id back to the
 * verification_codes row (recordTransactionalBounce): the code dies, a
 * mailbox-verification failure bumps the mailbox's failed checks, the user
 * gets a notification — and no DSN (it's our own mail). DSNs are
 * rate-limited per (user, recipient, alias) through sent_alerts so a
 * broken mailbox never becomes a bounce storm at the sender.
 */

import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { parseMessage, parseVerp, serializeMessage, type VerpInfo } from "./mail/index.ts";
import { buildDsn, sanitizeForwardDiagnostic } from "./mail/dsn.ts";
import { signOutbound } from "./mailauth/index.ts";
import { claimAlertOnce, recordBounce, recordTransactionalBounce } from "./pipeline/bounce.ts";
import { loadDkimKey } from "./pipeline/dkim.ts";
import { eq } from "drizzle-orm";
import { aliases, contacts, type EmailLog, mailboxes, type OutboundMessage } from "./db/schema.ts";
import { deliverOverSmtp, enqueue, type QueueWorker, startQueueWorker } from "./queue/index.ts";

/**
 * Where the DSN goes: the failed message's ORIGINATOR. Forward phase → the
 * outside contact's real address; reply phase → the user's own mailbox.
 */
async function resolveDsnRecipient(log: EmailLog, verp: VerpInfo): Promise<string | null> {
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

/** The alias address for a forward bounce's email_log (what the DSN names). */
async function resolveAliasEmail(aliasId: number): Promise<string | null> {
  const rows = await db
    .select({ email: aliases.email })
    .from(aliases)
    .where(eq(aliases.id, aliasId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/** Bounce accounting + DSN generation for permanently-failed rows. */
export async function handlePermanentFailure(row: OutboundMessage, error: string): Promise<void> {
  if (row.envelopeFrom === "") {
    // Null reverse path: never bounce a bounce.
    return;
  }
  const verp = parseVerp(row.envelopeFrom, config.verpSecret);
  if (verp === null) {
    console.log(`deliverd: no DSN — no VERP mapping for failed #${row.id} (${error})`);
    return;
  }
  if (verp.type === "transactional") {
    const result = await recordTransactionalBounce(db, verp.id);
    console.log(
      `deliverd: transactional failure #${row.id} (ref ${verp.id})` +
        (result.code !== null ? ` — code ${result.code.id} invalidated` : "") +
        (result.mailboxFlagged ? ", mailbox flagged" : "") +
        ` (${error})`,
    );
    return; // our own mail: notify in-app, never DSN
  }
  const result = await recordBounce(db, verp.id);
  const log = result.emailLog;
  console.log(
    `deliverd: recorded ${verp.type} bounce on email_log ${verp.id}` +
      (result.aliasDisabled ? " (alias auto-disabled)" : ""),
  );
  if (log === null) return;

  const recipient = await resolveDsnRecipient(log, verp);
  if (recipient === null) {
    console.log(`deliverd: no DSN for #${row.id} — originator no longer resolvable`);
    return;
  }

  // What the DSN names as the failed recipient. A forward bounce goes to the
  // OUTSIDE sender, so it must describe the failure in terms of the ALIAS —
  // never row.envelopeTo, which for a forward is the user's real backing
  // mailbox — and must sanitize the remote reply (which echoes that mailbox).
  // Leaking it would de-anonymize the alias to anyone who can make a forward
  // hard-bounce. A reply bounce goes to the user's own mailbox, so it keeps the
  // real recipient and the verbatim reply.
  let failedRecipient = row.envelopeTo;
  let diagnostic = error;
  if (verp.type === "bounce_forward") {
    const aliasEmail = log.aliasId === null ? null : await resolveAliasEmail(log.aliasId);
    if (aliasEmail === null) {
      console.log(
        `deliverd: no DSN for #${row.id} — alias for forward bounce no longer resolvable`,
      );
      return;
    }
    failedRecipient = aliasEmail;
    diagnostic = sanitizeForwardDiagnostic(error);
  }

  // Rate limit: one DSN per (user, recipient, alias) per 24h via sent_alerts.
  const claimed = await claimAlertOnce(db, {
    userId: log.userId,
    toEmail: recipient,
    alertType: `dsn_${verp.type}_${log.aliasId ?? log.contactId}`,
  });
  if (!claimed) {
    console.log(`deliverd: DSN to ${recipient} suppressed (rate limit) for #${row.id}`);
    return;
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
    console.log(`deliverd: WARNING no active DKIM key for ${config.mailDomain} — DSN unsigned`);
    raw = serializeMessage(dsn.headers, dsn.body);
  } else {
    const signed = await signOutbound(dsn.headers, dsn.body, { dkimKeys: [key] });
    for (const err of signed.errors) {
      console.log(
        `deliverd: DSN DKIM signing error (${err.signingDomain}/${err.selector}): ${err.err.message}`,
      );
    }
    raw = signed.message;
  }

  const queueId = await enqueue(db, {
    raw,
    envelopeFrom: "", // RFC 5321 §4.5.5: DSNs use the null reverse path
    envelopeTo: recipient,
    maxRawBytes: config.smtpMaxMessageSize,
  });
  console.log(`deliverd: queued DSN #${queueId} to ${recipient} for failed #${row.id}`);
}

/** Start the queue worker with config-driven settings. */
export function startDeliverd(): QueueWorker {
  console.log(
    `deliverd: polling every ${config.queuePollMs}ms ` +
      `(batch ${config.queueBatchSize}, max tries ${config.queueMaxTries})`,
  );
  return startQueueWorker(db, {
    pollMs: config.queuePollMs,
    batchSize: config.queueBatchSize,
    maxTries: config.queueMaxTries,
    deliver: (row) =>
      deliverOverSmtp(row, {
        heloName: config.mailHostname,
        allowPrivateTargets: config.smtpAllowPrivateTargets,
      }),
    onPermanentFailure: handlePermanentFailure,
  });
}

if (import.meta.main) {
  startDeliverd();
}
