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
import type { OutboundMessage } from "./db/schema.ts";
import { createLogger } from "./log.ts";
import { parseVerp } from "./mail/index.ts";
import { dsnTotal, registerQueueCollectors } from "./metrics/index.ts";
import { recordBounce, recordTransactionalBounce } from "./pipeline/bounce.ts";
import { sendFailureDsn } from "./pipeline/dsnDelivery.ts";
import { isSuppressionCode, suppressMailbox } from "./pipeline/suppression.ts";
import { deliverOverSmtp, type QueueWorker, startQueueWorker } from "./queue/index.ts";

const logger = createLogger("deliverd");

/** Bounce accounting + DSN generation for permanently-failed rows. */
export async function handlePermanentFailure(
  row: OutboundMessage,
  error: string,
  enhancedCode?: string,
): Promise<void> {
  if (row.envelopeFrom === "") {
    // Null reverse path: never bounce a bounce.
    return;
  }
  const verp = parseVerp(row.envelopeFrom, config.verpSecret);
  if (verp === null) {
    dsnTotal.inc({ outcome: "skipped" });
    logger.info("dsn_skipped", { queueId: row.id, reason: "no_verp_mapping", error });
    return;
  }
  if (verp.type === "transactional") {
    const result = await recordTransactionalBounce(db, verp.id);
    logger.info("transactional_bounce", {
      queueId: row.id,
      verpId: verp.id,
      codeInvalidated: result.code?.id ?? null,
      mailboxFlagged: result.mailboxFlagged,
      error,
    });
    return; // our own mail: notify in-app, never DSN
  }
  const result = await recordBounce(db, verp.id);
  const log = result.emailLog;
  logger.info("bounce_recorded", {
    queueId: row.id,
    verpType: verp.type,
    emailLogId: verp.id,
    aliasDisabled: result.aliasDisabled,
  });
  if (log === null) return;

  // Mailbox-level suppression (ABUSE.md Tier 1): a forward-phase 5.1.1/5.2.1
  // means the MAILBOX is gone — first strike, every alias delivering there
  // pauses. Forward phase only: a reply bounce's code describes the
  // contact's address, not our user's mailbox.
  if (
    verp.type === "bounce_forward" &&
    enhancedCode !== undefined &&
    isSuppressionCode(enhancedCode) &&
    log.mailboxId !== null
  ) {
    const suppressed = await suppressMailbox(db, log.mailboxId, { enhancedCode });
    if (suppressed.suppressed) {
      logger.warn("mailbox_suppressed", {
        queueId: row.id,
        mailboxId: log.mailboxId,
        enhancedCode,
      });
    }
  }

  // Composition, alias-naming/sanitization, rate limit, signing and the
  // enqueue all live in pipeline/dsnDelivery.ts (shared with the operator
  // bounce, which sends the DSN WITHOUT the accounting above).
  await sendFailureDsn(db, { row, verp, emailLog: log, diagnostic: error });
}

/** Start the queue worker with config-driven settings. */
export function startDeliverd(): QueueWorker {
  registerQueueCollectors(db);
  logger.info("started", {
    pollMs: config.queuePollMs,
    batchSize: config.queueBatchSize,
    maxTries: config.queueMaxTries,
  });
  return startQueueWorker(db, {
    pollMs: config.queuePollMs,
    batchSize: config.queueBatchSize,
    maxTries: config.queueMaxTries,
    backoff: { maxMs: config.queueBackoffMaxMs },
    hygiene: {
      stuckSendingMs: config.queueStuckSendingMinutes * 60_000,
      reapIntervalMs: config.queueReapIntervalMs,
      retainSentDays: config.queueRetainSentDays,
      retainFailedDays: config.queueRetainFailedDays,
      retentionIntervalMs: config.queueRetentionIntervalMs,
      retainRejectionsDays: config.smtpRejectionsRetainDays,
    },
    logger: createLogger("queue"),
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
