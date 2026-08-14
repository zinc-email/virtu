/**
 * Terminal-row retention. Without it, sent/failed rows (raw bytea and all)
 * accumulate forever. Policy:
 *
 *   - `sent` rows already had raw cleared on the terminal write (the bytes
 *     of a delivered message have no further use) and age out after
 *     config.queueRetainSentDays.
 *   - `failed` rows keep raw — that's what makes operator requeue possible
 *     — and age out after config.queueRetainFailedDays.
 *
 * Deletes are batched (id IN subquery, LIMIT per pass) so one retention
 * tick never holds a long transaction over a big backlog. updatedAt is the
 * terminal-write time (schema $onUpdate), indexed via
 * outbound_messages_status_updated_at_idx.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type OutboundStatus, outboundMessages } from "../db/schema.ts";

export interface RetentionOptions {
  retainSentDays: number;
  retainFailedDays: number;
  /** Rows deleted per statement (each status loops until drained). */
  batchSize?: number;
  now?: () => Date;
}

async function deleteAged(
  db: Db,
  status: OutboundStatus,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(and(eq(outboundMessages.status, status), lt(outboundMessages.updatedAt, cutoff)))
      .limit(batchSize);
    const deleted = await db
      .delete(outboundMessages)
      .where(inArray(outboundMessages.id, batch))
      .returning({ id: outboundMessages.id });
    total += deleted.length;
    if (deleted.length < batchSize) return total;
  }
}

/** One retention pass. Returns rows deleted per status. */
export async function runRetentionOnce(
  db: Db,
  opts: RetentionOptions,
): Promise<{ sent: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const dayMs = 86_400_000;
  const sentCutoff = new Date(now().getTime() - opts.retainSentDays * dayMs);
  const failedCutoff = new Date(now().getTime() - opts.retainFailedDays * dayMs);
  return {
    sent: await deleteAged(db, "sent", sentCutoff, batchSize),
    failed: await deleteAged(db, "failed", failedCutoff, batchSize),
  };
}
