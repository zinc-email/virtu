/**
 * Stuck-`sending` reaper. The claim transaction commits before delivery
 * starts (that's what lets FOR UPDATE SKIP LOCKED scale), so a worker crash
 * between claim and outcome strands rows in `sending` with no lock held —
 * before claimedAt existed they stayed there forever. Rows whose lease is
 * older than the cutoff go back to `pending` for immediate re-attempt.
 *
 * A live-but-slow delivery can be reaped once its lease lapses; the
 * worker's terminal updates are status-guarded so the stale worker can't
 * stomp the reclaimed row, and the result is at-least-once delivery —
 * standard for mail. Keep the lease comfortably above worst-case delivery
 * time (config.queueStuckSendingMinutes, default 15m vs ~3 hosts × 30s
 * timeouts).
 *
 * Concurrent reapers race harmlessly: the UPDATE is a single idempotent
 * statement. Rows claimed before the claimedAt column existed (NULL lease)
 * fall back to updatedAt, which the claim write always touches.
 */

import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";

export interface ReapOptions {
  /** Lease age beyond which a `sending` row is presumed orphaned. */
  olderThanMs: number;
  now?: () => Date;
}

/** Return stale `sending` rows to `pending`. Returns the reaped ids. */
export async function reapStuckSending(db: Db, opts: ReapOptions): Promise<number[]> {
  const now = opts.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - opts.olderThanMs);
  const rows = await db
    .update(outboundMessages)
    .set({
      status: "pending",
      claimedAt: null,
      nextAttemptAt: now(),
      lastError: sql`coalesce(${outboundMessages.lastError}, 'reaped: worker lost mid-delivery')`,
    })
    .where(
      and(
        eq(outboundMessages.status, "sending"),
        or(
          lt(outboundMessages.claimedAt, cutoff),
          and(isNull(outboundMessages.claimedAt), lt(outboundMessages.updatedAt, cutoff)),
        ),
      ),
    )
    .returning({ id: outboundMessages.id });
  return rows.map((r) => r.id);
}
