/**
 * Operator primitives for the queue — the ONLY sanctioned writers besides
 * enqueue and the worker itself. Both the admin API (routes/admin/) and the
 * break-glass CLI (bin/queue-drop, bin/queue-requeue) call these, so the
 * two surfaces can never diverge.
 *
 * Semantics:
 *   - drop: pending|sending -> failed ("dropped by operator"). A `sending`
 *     row's in-flight delivery may still complete on the wire, but the
 *     worker's terminal updates are status-guarded, so the row stays
 *     `failed` either way. Drop is an operator action, not a delivery
 *     outcome: it never writes `sent` and fires no bounce/DSN.
 *   - requeue: failed -> pending for immediate re-attempt, tries reset.
 *     Refuses rows whose raw was cleared (sent-then-retained rows have no
 *     bytes to resend). Does not undo bounce accounting a permanent
 *     failure already recorded.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";
import { queueAdminTotal } from "../metrics/index.ts";

export const DROPPED_BY_OPERATOR = "dropped by operator";

/** Drop pending/sending rows. Returns the ids actually dropped. */
export async function dropMessages(db: Db, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(outboundMessages)
    .set({ status: "failed", lastError: DROPPED_BY_OPERATOR, claimedAt: null })
    .where(
      and(
        inArray(outboundMessages.id, ids),
        inArray(outboundMessages.status, ["pending", "sending"]),
      ),
    )
    .returning({ id: outboundMessages.id });
  queueAdminTotal.inc({ op: "drop" }, rows.length);
  return rows.map((r) => r.id);
}

/**
 * Hard-delete terminal rows NOW instead of waiting out retention. Only
 * failed|sent — a pending/sending row must be dropped (or bounced) first,
 * so live delivery state can never vanish mid-flight.
 */
export async function deleteMessages(db: Db, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .delete(outboundMessages)
    .where(
      and(inArray(outboundMessages.id, ids), inArray(outboundMessages.status, ["failed", "sent"])),
    )
    .returning({ id: outboundMessages.id });
  queueAdminTotal.inc({ op: "delete" }, rows.length);
  return rows.map((r) => r.id);
}

/** Requeue failed rows (with raw intact). Returns the ids requeued. */
export async function requeueMessages(db: Db, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(outboundMessages)
    .set({
      status: "pending",
      tries: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      claimedAt: null,
    })
    .where(
      and(
        inArray(outboundMessages.id, ids),
        eq(outboundMessages.status, "failed"),
        sql`octet_length(${outboundMessages.raw}) > 0`,
      ),
    )
    .returning({ id: outboundMessages.id });
  queueAdminTotal.inc({ op: "requeue" }, rows.length);
  return rows.map((r) => r.id);
}
