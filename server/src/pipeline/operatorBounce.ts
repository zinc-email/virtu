/**
 * Operator bounce (PLAN Lane K): kill a queued message AND tell its
 * originator. Locks the row and commits its terminal status together with
 * the queued RFC 3464 DSN (pipeline/dsnDelivery.ts). A failure rolls back
 * both, so the original remains available for delivery or another attempt.
 *
 * Deliberately NOT the same as a delivery failure:
 *   - no recordBounce — an operator decision is not a mailbox-health
 *     signal, so it must never advance the alias auto-disable ledger;
 *   - transactional rows are skipped — bouncing our own system mail would
 *     invalidate a live verification code from an operator action;
 *   - null-reverse-path rows (DSNs, trash copies) are skipped — never
 *     bounce a bounce.
 *
 * Already-failed rows may be bounced (a dropped-silently row can get its
 * notice after the fact); their lastError is preserved. sent rows cannot —
 * the message was delivered.
 */

import { eq, sql } from "drizzle-orm";
import { config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { emailLogs, outboundMessages } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { parseVerp } from "../mail/index.ts";
import { queueAdminTotal } from "../metrics/index.ts";
import { sendFailureDsn } from "./dsnDelivery.ts";

const logger = createLogger("dsn");

export const BOUNCED_BY_OPERATOR = "bounced by operator";

/**
 * What the DSN tells the originator. Forward bounces never show it —
 * sendFailureDsn sanitizes forward diagnostics to the generic refusal text
 * (the outside sender learns neither the mailbox nor operator internals);
 * reply bounces go to the user's own mailbox, which may know.
 */
const OPERATOR_DIAGNOSTIC = "5.7.1 Delivery not completed: message removed by the mail operator";

export type BounceSkipReason =
  | "unknown_id"
  | "already_delivered"
  | "null_reverse_path"
  | "no_verp_mapping"
  | "transactional"
  | "raw_cleared"
  | "email_log_missing"
  | "originator_unresolvable"
  | "originator_unauthenticated"
  | "alias_unresolvable"
  // The inbound message was accepted flagged (unauthenticated sender);
  // bouncing it would be backscatter — see dsnDelivery.ts.
  | "flagged_inbound"
  | "in_flight"
  | "temporarily_unavailable";

export interface OperatorBounceResult {
  /** Rows terminal-marked (DSN sent, or deduplicated for this failed delivery). */
  bounced: number[];
  skipped: { id: number; reason: BounceSkipReason }[];
}

/** Stop delivery and enqueue its notice in one transaction, or change nothing. */
export async function bounceQueuedMessages(db: Db, ids: number[]): Promise<OperatorBounceResult> {
  const result: OperatorBounceResult = { bounced: [], skipped: [] };
  for (const id of ids) {
    try {
      const reason = await db.transaction(async (tx): Promise<BounceSkipReason | null> => {
        // Fetch metadata first, then at most one body's bytes. The row lock
        // excludes delivery claims, failure jobs and concurrent operators.
        const [row] = await tx
          .select({
            id: outboundMessages.id,
            status: outboundMessages.status,
            envelopeFrom: outboundMessages.envelopeFrom,
            envelopeTo: outboundMessages.envelopeTo,
            createdAt: outboundMessages.createdAt,
            failurePending: outboundMessages.failurePending,
            sizeBytes: sql<number>`octet_length(${outboundMessages.raw})`.mapWith(Number),
          })
          .from(outboundMessages)
          .where(eq(outboundMessages.id, id))
          .for("update");
        if (row === undefined) return "unknown_id";
        if (row.status === "sent") return "already_delivered";
        // SMTP delivery already in flight cannot safely be recalled.
        if (row.status === "sending" || row.failurePending) return "in_flight";
        if (row.envelopeFrom === "") return "null_reverse_path";
        if (row.sizeBytes === 0) return "raw_cleared";
        const verp = parseVerp(row.envelopeFrom, config.verpSecret, { now: row.createdAt });
        if (verp === null) return "no_verp_mapping";
        if (verp.type === "transactional") return "transactional";
        const [emailLog] = await tx.select().from(emailLogs).where(eq(emailLogs.id, verp.id));
        if (emailLog === undefined) return "email_log_missing";
        const [message] = await tx
          .select({ raw: outboundMessages.raw })
          .from(outboundMessages)
          .where(eq(outboundMessages.id, id));
        const dsn = await sendFailureDsn(tx, {
          row: { id, raw: message!.raw, envelopeTo: row.envelopeTo },
          verp,
          emailLog,
          diagnostic: OPERATOR_DIAGNOSTIC,
        });
        if (dsn.outcome === "skipped") return dsn.reason;
        if (row.status !== "failed") {
          await tx
            .update(outboundMessages)
            .set({ status: "failed", lastError: BOUNCED_BY_OPERATOR, claimedAt: null })
            .where(eq(outboundMessages.id, id));
        }
        return null;
      });
      if (reason === null) result.bounced.push(id);
      else result.skipped.push({ id, reason });
    } catch (error) {
      result.skipped.push({ id, reason: "temporarily_unavailable" });
      logger.error("operator_bounce_error", { queueId: id, error: String(error) });
    }
  }
  queueAdminTotal.inc({ op: "bounce" }, result.bounced.length);
  return result;
}
