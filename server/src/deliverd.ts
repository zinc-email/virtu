/**
 * deliverd — drains the Postgres queue (PLAN Milestone 2/3).
 *
 * The generic worker loop lives in src/queue/worker.ts; this entrypoint
 * wires it to config and to bounce accounting: a permanent failure whose
 * envelope from parses as one of our VERP addresses marks the referenced
 * email_log bounced (which drives the alias auto-disable thresholds).
 *
 * DSN generation is a deliberate MVP STUB: permanent failures are logged
 * and recorded (status=failed + bounce accounting) but no DSN message is
 * composed yet. Null-reverse-path mail never triggers any bounce action.
 */

import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { parseVerp } from "./mail/index.ts";
import { recordBounce } from "./pipeline/bounce.ts";
import type { OutboundMessage } from "./db/schema.ts";
import { deliverOverSmtp, type QueueWorker, startQueueWorker } from "./queue/index.ts";

/** Bounce accounting + DSN stub for permanently-failed rows. */
export async function handlePermanentFailure(row: OutboundMessage, error: string): Promise<void> {
  if (row.envelopeFrom === "") {
    // Null reverse path: never bounce a bounce.
    return;
  }
  const verp = parseVerp(row.envelopeFrom, config.verpSecret);
  if (verp === null || verp.type === "transactional") {
    console.log(`deliverd: DSN stub — no VERP mapping for failed #${row.id} (${error})`);
    return;
  }
  const result = await recordBounce(db, verp.id);
  console.log(
    `deliverd: DSN stub — recorded ${verp.type} bounce on email_log ${verp.id}` +
      (result.aliasDisabled ? " (alias auto-disabled)" : "") +
      `; no DSN composed (MVP)`,
  );
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
    deliver: (row) => deliverOverSmtp(row, { heloName: config.mailHostname }),
    onPermanentFailure: handlePermanentFailure,
  });
}

if (import.meta.main) {
  startDeliverd();
}
