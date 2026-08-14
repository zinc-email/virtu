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
 *   2. take ownership — the guarded failed("bounced by operator") write.
 *      Only after this commits is the DSN composed: a row the worker
 *      delivered while we looked at it stays sent and NO failure notice is
 *      sent for a delivered message.
 *   3. send the DSN (24h-deduped; "suppressed" still counts as bounced —
 *      the originator was already told).
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

    // Take ownership before any DSN exists. Already-failed rows are already
    // terminal (their own lastError is kept); live rows must win the
    // guarded write — losing it means the worker just finished with the row
    // (or another operator did), so no notice may be sent from here.
    if (row.status !== "failed") {
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
        const [current] = await db
          .select({ status: outboundMessages.status })
          .from(outboundMessages)
          .where(eq(outboundMessages.id, id));
        skip(current?.status === "sent" ? "already_delivered" : "in_flight");
        continue;
      }
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
    result.bounced.push(id);
    logger.info("operator_bounce", { queueId: id, dsnOutcome: dsn.outcome });
  }

  queueAdminTotal.inc({ op: "bounce" }, result.bounced.length);
  return result;
}
