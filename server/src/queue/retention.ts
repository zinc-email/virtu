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
import {
  type OutboundStatus,
  outboundMessages,
  sentAlerts,
  smtpRejections,
  users,
} from "../db/schema.ts";

export interface RetentionOptions {
  retainSentDays: number;
  retainFailedDays: number;
  /** Rows deleted per statement. */
  batchSize?: number;
  /**
   * Statements per status per pass. Retention runs INSIDE the delivery loop
   * (worker.ts), so a pass that drained an unbounded backlog would hold the
   * loop — and with it every outbound message — for as long as the backlog
   * took: the first tick after a box has accumulated months of terminal rows
   * is exactly that case. Capping the pass keeps each tick bounded; the
   * remainder goes on the next tick.
   */
  maxBatchesPerPass?: number;
  now?: () => Date;
}

async function deleteAged(
  db: Db,
  status: OutboundStatus,
  cutoff: Date,
  batchSize: number,
  maxBatches: number,
): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < maxBatches; pass++) {
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
  return total;
}

/** One retention pass. Returns rows deleted per status. */
export async function runRetentionOnce(
  db: Db,
  opts: RetentionOptions,
): Promise<{ sent: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatchesPerPass ?? 20;
  const dayMs = 86_400_000;
  const sentCutoff = new Date(now().getTime() - opts.retainSentDays * dayMs);
  const failedCutoff = new Date(now().getTime() - opts.retainFailedDays * dayMs);
  return {
    sent: await deleteAged(db, "sent", sentCutoff, batchSize, maxBatches),
    failed: await deleteAged(db, "failed", failedCutoff, batchSize, maxBatches),
  };
}

export interface RejectionRetentionOptions {
  retainDays: number;
  batchSize?: number;
  maxBatchesPerPass?: number;
  now?: () => Date;
}

/**
 * Age out smtp_rejections rows (append-only forensics, Lane K P2) past their
 * window. Same batched/bounded shape as the queue pass, same reason: this
 * runs inside the delivery loop.
 */
export async function runRejectionRetentionOnce(
  db: Db,
  opts: RejectionRetentionOptions,
): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatchesPerPass ?? 20;
  const cutoff = new Date(now().getTime() - opts.retainDays * 86_400_000);
  let total = 0;
  for (let pass = 0; pass < maxBatches; pass++) {
    const batch = db
      .select({ id: smtpRejections.id })
      .from(smtpRejections)
      .where(lt(smtpRejections.createdAt, cutoff))
      .limit(batchSize);
    const deleted = await db
      .delete(smtpRejections)
      .where(inArray(smtpRejections.id, batch))
      .returning({ id: smtpRejections.id });
    total += deleted.length;
    if (deleted.length < batchSize) return total;
  }
  return total;
}

export interface ProvisionalUserRetentionOptions {
  /** Provisional rows older than this are deleted; 0 disables. */
  retainHours: number;
  batchSize?: number;
  maxBatchesPerPass?: number;
  now?: () => Date;
}

/**
 * Prune provisional users: `users` rows that POST /auth/login created for an
 * address that never verified (activated = false). Anyone can mint one per
 * address they name, so without this the table grows at the attacker's
 * pace; a login code lives 15 minutes, so a row this old is an abandoned
 * signup. Age is `updated_at`, not `created_at`: /auth/login touches a
 * reused provisional row (routes/auth.ts findOrCreateUser), so a two-day-old
 * address that just asked for a code is live and stays. Operator-disabled
 * rows are kept — that flag is a decision, not debris. Cascades take the
 * row's codes, ledger entries and queued mail with it. Same batched/bounded
 * shape as the queue passes (this runs inside the delivery loop).
 */
export async function runProvisionalUserRetentionOnce(
  db: Db,
  opts: ProvisionalUserRetentionOptions,
): Promise<number> {
  if (opts.retainHours <= 0) return 0;
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatchesPerPass ?? 20;
  const cutoff = new Date(now().getTime() - opts.retainHours * 3_600_000);
  let total = 0;
  for (let pass = 0; pass < maxBatches; pass++) {
    const batch = db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(users.activated, false), eq(users.disabled, false), lt(users.updatedAt, cutoff)),
      )
      .limit(batchSize);
    const deleted = await db
      .delete(users)
      .where(inArray(users.id, batch))
      .returning({ id: users.id });
    total += deleted.length;
    if (deleted.length < batchSize) return total;
  }
  return total;
}

/**
 * Age out sent_alerts rows: the send-budget ledger (3/h per scope, the
 * trailing-hour global ceiling), the alert dedupe (<= a day) and the
 * per-code attempt counters (codes live 15 minutes). Nothing reads further
 * back than a day, so anything past the window is dead weight that every
 * budget count would otherwise walk past forever. Same shape as the
 * smtp_rejections pass.
 */
export async function runSentAlertsRetentionOnce(
  db: Db,
  opts: RejectionRetentionOptions,
): Promise<number> {
  if (opts.retainDays <= 0) return 0;
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? 500;
  const maxBatches = opts.maxBatchesPerPass ?? 20;
  const cutoff = new Date(now().getTime() - opts.retainDays * 86_400_000);
  let total = 0;
  for (let pass = 0; pass < maxBatches; pass++) {
    const batch = db
      .select({ id: sentAlerts.id })
      .from(sentAlerts)
      .where(lt(sentAlerts.createdAt, cutoff))
      .limit(batchSize);
    const deleted = await db
      .delete(sentAlerts)
      .where(inArray(sentAlerts.id, batch))
      .returning({ id: sentAlerts.id });
    total += deleted.length;
    if (deleted.length < batchSize) return total;
  }
  return total;
}
