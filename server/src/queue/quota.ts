/**
 * Per-user pending-queue cap (pre-launch review P1 #4). The queue holds a
 * full 25 MiB raw copy per recipient and retries a tempfailing destination
 * for four days, so one user whose mailbox is down — or who points an alias
 * at a mailbox that always tempfails — can hold hundreds of GB of Postgres
 * at SMTP speed. The cap bounds what any one account can have in flight:
 * pending + sending rows and their raw bytes. Over it, the mx tempfails at
 * RCPT and submission at DATA (452 4.3.1 "mail system full" — RFC 3463), so
 * the sender's MTA queues and retries on its side of the wire.
 *
 * `decideQueueQuota` is pure; `pendingUsage` is the one DB-touching
 * function. Terminal rows never count: sent rows have raw cleared, failed
 * rows are the operator's forensics, both age out under retention.
 *
 * Enforced at the two sites where a USER's action adds to their queue: the
 * mx forward (policy.ts RcptFacts.queueFull) and submission DATA. Three
 * enqueue sites bypass it on purpose, each bounded elsewhere: transactional
 * code mail (login codes must go out; per-address budget + global ceiling),
 * DSNs (small, and dsnDelivery.ts's own sent_alerts rate control), and
 * operator role mail (the service's own mail to admins). So "at most N
 * pending rows per user" is a bound on what a user can CAUSE, not a queue
 * invariant — enqueue.ts stays dumb by design (PLAN Lane D).
 */

import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";

/** Config knobs (QUEUE_MAX_PENDING_{ROWS,BYTES}_PER_USER); 0 = unlimited. */
export interface QueueQuotaLimits {
  maxPendingRows: number;
  maxPendingBytes: number;
}

/** What one user currently has in flight. */
export interface QueueUsage {
  rows: number;
  bytes: number;
}

/** Pure decision: true when the user's in-flight mail is at either cap. */
export function decideQueueQuota(limits: QueueQuotaLimits, usage: QueueUsage): boolean {
  if (limits.maxPendingRows > 0 && usage.rows >= limits.maxPendingRows) return true;
  if (limits.maxPendingBytes > 0 && usage.bytes >= limits.maxPendingBytes) return true;
  return false;
}

/** Non-terminal rows + their raw bytes for one user (outbound_messages_user_id_idx). */
export async function pendingUsage(db: Db, userId: number): Promise<QueueUsage> {
  const [row] = await db
    .select({
      rows: count(),
      bytes: sql`coalesce(sum(octet_length(${outboundMessages.raw})), 0)`.mapWith(Number),
    })
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.userId, userId),
        inArray(outboundMessages.status, ["pending", "sending"]),
      ),
    );
  return { rows: row?.rows ?? 0, bytes: row?.bytes ?? 0 };
}

/** The mx RCPT reply: the party over the cap is the alias's owner. */
export const QUEUE_FULL_REPLY = {
  code: 452,
  enhanced: "4.3.1",
  message: "Recipient's mail queue is full, try again later",
} as const;

/** The submission DATA reply: the party over the cap is the authenticated sender. */
export const OUTBOUND_QUEUE_FULL_REPLY = {
  code: 452,
  enhanced: "4.3.1",
  message: "Your outbound queue is full (too much mail still being delivered), try again later",
} as const;
