/**
 * Operator bounce (PLAN Lane K): kill a queued message AND tell its
 * originator — drop's polite sibling. Takes ownership of the row first,
 * then sends the same RFC 3464 DSN a permanent delivery failure would
 * (pipeline/dsnDelivery.ts, same sent_alerts dedupe).
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

import { and, eq, inArray, sql } from "drizzle-orm";
import { config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { aliases, emailLogs, outboundMessages } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { parseVerp } from "../mail/index.ts";
import { queueAdminTotal } from "../metrics/index.ts";
import { resolveDsnRecipient, sendFailureDsn } from "./dsnDelivery.ts";

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
  | "alias_unresolvable"
  | "in_flight";

export interface OperatorBounceResult {
  /** Rows terminal-marked (DSN sent, or deduped by the 24h rate limit). */
  bounced: number[];
  skipped: { id: number; reason: BounceSkipReason }[];
}

/**
 * Bounce queue rows. Order matters, per row:
 *
 *   1. pre-flight — is a DSN even possible (VERP decodes, email_log and
 *      originator resolve)? If not, the row is left UNTOUCHED and reported
 *      skipped: "bounce" must never quietly degrade into a silent drop —
 *      the operator can still Drop explicitly.
 *   2. take ownership — the guarded failed("bounced by operator") write,
 *      always attempted (never predicated on the possibly-stale status read
 *      in step 1). Only after it commits is the DSN composed, so a row the
 *      worker already finished stays sent and no failure notice goes out for
 *      a delivered message. Caveat inherent to drop's sibling: a `sending`
 *      row whose delivery is mid-wire can still land at the destination
 *      after we win the write — the recipient gets the mail AND the
 *      originator gets the notice. Durable in-flight cancellation is not
 *      something SMTP offers.
 *   3. send the DSN. "suppressed" counts as bounced (the originator was
 *      already told inside the 24h window); "skipped" does NOT — no notice
 *      went out, so it is reported as a skip, never as a bounce.
 */
export async function bounceQueuedMessages(db: Db, ids: number[]): Promise<OperatorBounceResult> {
  const result: OperatorBounceResult = { bounced: [], skipped: [] };
  if (ids.length === 0) return result;

  // Everything BUT the bytea: 100 ids × 25MB raw must not land in one
  // select. Raw is fetched per row, only once the row is actually ours.
  const rows = await db
    .select({
      id: outboundMessages.id,
      status: outboundMessages.status,
      envelopeFrom: outboundMessages.envelopeFrom,
      envelopeTo: outboundMessages.envelopeTo,
      sizeBytes: sql<number>`octet_length(${outboundMessages.raw})`.mapWith(Number),
    })
    .from(outboundMessages)
    .where(inArray(outboundMessages.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const id of ids) {
    const row = byId.get(id);
    const skip = (reason: BounceSkipReason) => {
      result.skipped.push({ id, reason });
      logger.info("operator_bounce_skipped", { queueId: id, reason });
    };

    // One row must not cost the operator the rest of the batch. sendFailureDsn
    // reaches DNS, the DKIM key and enqueue (which throws on an oversized
    // message), so a single bad row used to abort the loop mid-way: rows
    // already bounced were lost from the response, rows not yet reached were
    // never attempted, and the caller got a 500 describing none of it.
    try {
      if (row === undefined) {
        skip("unknown_id");
        continue;
      }
      if (row.status === "sent") {
        skip("already_delivered");
        continue;
      }
      if (row.envelopeFrom === "") {
        skip("null_reverse_path");
        continue;
      }
      if (row.sizeBytes === 0) {
        skip("raw_cleared");
        continue;
      }
      const verp = parseVerp(row.envelopeFrom, config.verpSecret);
      if (verp === null) {
        skip("no_verp_mapping");
        continue;
      }
      if (verp.type === "transactional") {
        skip("transactional");
        continue;
      }
      const logRows = await db.select().from(emailLogs).where(eq(emailLogs.id, verp.id)).limit(1);
      const emailLog = logRows[0];
      if (emailLog === undefined) {
        skip("email_log_missing");
        continue;
      }

      // Pre-flight the resolutions sendFailureDsn will need, so an
      // unresolvable originator skips BEFORE the row is touched.
      if ((await resolveDsnRecipient(db, emailLog, verp)) === null) {
        skip("originator_unresolvable");
        continue;
      }
      if (verp.type === "bounce_forward") {
        const aliasRows =
          emailLog.aliasId === null
            ? []
            : await db
                .select({ id: aliases.id })
                .from(aliases)
                .where(eq(aliases.id, emailLog.aliasId))
                .limit(1);
        if (aliasRows.length === 0) {
          skip("alias_unresolvable");
          continue;
        }
      }

      // Take ownership before any DSN exists. Always ATTEMPT the guarded
      // write and let the database decide — `row.status` is a snapshot from
      // the select above and may already be stale. Branching on it (skipping
      // the write for anything that looked "failed") let a row requeued in
      // that window get a failure notice while it was still queued for
      // delivery: the originator is told it failed, the recipient gets it
      // anyway. The row's CURRENT status is what settles it.
      const marked = await db
        .update(outboundMessages)
        .set({ status: "failed", lastError: BOUNCED_BY_OPERATOR, claimedAt: null })
        .where(
          and(
            eq(outboundMessages.id, id),
            inArray(outboundMessages.status, ["pending", "sending"]),
          ),
        )
        .returning({ id: outboundMessages.id });
      if (marked.length === 0) {
        // Nothing live to take: either it was already terminal, or it went
        // terminal underneath us.
        const [current] = await db
          .select({ status: outboundMessages.status })
          .from(outboundMessages)
          .where(eq(outboundMessages.id, id));
        if (current === undefined) {
          skip("unknown_id");
          continue;
        }
        if (current.status !== "failed") {
          // "sent" => delivered, never notify. Anything else => it moved
          // back under us; leave it alone rather than guess.
          skip(current.status === "sent" ? "already_delivered" : "in_flight");
          continue;
        }
        // Already failed (e.g. dropped earlier): the documented
        // notice-after-the-fact case. Its own lastError is preserved.
      }

      const rawRows = await db
        .select({ raw: outboundMessages.raw })
        .from(outboundMessages)
        .where(eq(outboundMessages.id, id))
        .limit(1);
      const raw = rawRows[0]?.raw ?? new Uint8Array(0);

      const dsn = await sendFailureDsn(db, {
        row: { id: row.id, raw, envelopeTo: row.envelopeTo },
        verp,
        emailLog,
        diagnostic: OPERATOR_DIAGNOSTIC,
      });
      logger.info("operator_bounce", { queueId: id, dsnOutcome: dsn.outcome });
      if (dsn.outcome === "skipped") {
        // The row is terminal but no notice went out — that is a DROP, and
        // reporting it as bounced would be the silent degradation this module
        // exists to prevent. Say so: the operator sees a skip reason, not a
        // success. ("suppressed" is different — the originator was already
        // told within the 24h window, so it still counts as bounced.)
        skip(dsn.reason);
        continue;
      }
      result.bounced.push(id);
    } catch (err) {
      result.skipped.push({ id, reason: "in_flight" });
      logger.error("operator_bounce_error", {
        queueId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  queueAdminTotal.inc({ op: "bounce" }, result.bounced.length);
  return result;
}
