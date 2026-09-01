// Operator queue endpoints (PLAN Lane K P1): list/detail/drop/requeue over
// outbound_messages. Mutations go through the queue's own primitives
// (queue/admin.ts) — the same functions bin/queue-drop and bin/queue-requeue
// call — so the API and the break-glass CLI can never diverge. Registered
// inside the requireAdmin scope (routes/index.ts).

import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import { type OutboundMessage, outboundMessages } from "../../db/schema";
import { config } from "../../config";
import { parseMessage, parseVerp } from "../../mail/index.ts";
import { bounceQueuedMessages } from "../../pipeline/operatorBounce.ts";
import { deleteMessages, dropMessages, requeueMessages } from "../../queue/index.ts";
import { HttpError } from "../httpError";
import { ErrorResponse } from "../schema";
import { allowlistHeaders } from "./headerAllowlist";
import { resolveQueueOwner } from "./ownership";
import {
  AdminBouncedResponse,
  AdminDeletedResponse,
  AdminDroppedResponse,
  AdminIdsBody,
  AdminQueueListResponse,
  AdminQueueMessage,
  AdminQueueMessageDetailResponse,
  AdminRequeuedResponse,
  OutboundStatusDto,
} from "./schema";

type QueueRow = Omit<OutboundMessage, "raw"> & { sizeBytes: number };

/**
 * How much of a row's raw bytes the detail endpoint reads. RFC 5322 caps a
 * header line at 998 octets and real mail keeps the whole block far under
 * this; anything past it is body, which no operator surface may show.
 */
const HEADER_SCAN_BYTES = 128 * 1024;

const listColumns = {
  id: outboundMessages.id,
  status: outboundMessages.status,
  tries: outboundMessages.tries,
  envelopeFrom: outboundMessages.envelopeFrom,
  envelopeTo: outboundMessages.envelopeTo,
  nextAttemptAt: outboundMessages.nextAttemptAt,
  claimedAt: outboundMessages.claimedAt,
  lastError: outboundMessages.lastError,
  createdAt: outboundMessages.createdAt,
  updatedAt: outboundMessages.updatedAt,
  userId: outboundMessages.userId,
  emailLogId: outboundMessages.emailLogId,
  sizeBytes: sql<number>`octet_length(${outboundMessages.raw})`.mapWith(Number),
};

function toDto(row: QueueRow): z.infer<typeof AdminQueueMessage> {
  return {
    id: row.id,
    status: row.status,
    tries: row.tries,
    envelope_from: row.envelopeFrom,
    envelope_to: row.envelopeTo,
    next_attempt_at: row.nextAttemptAt.toISOString(),
    claimed_at: row.claimedAt?.toISOString() ?? null,
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
    size_bytes: row.sizeBytes,
    verp_type:
      row.envelopeFrom === ""
        ? null
        : (parseVerp(row.envelopeFrom, config.verpSecret)?.type ?? null),
    // Durable attribution column (Lane K P2); null on system mail and rows
    // that predate it.
    user_id: row.userId,
  };
}

const ListQuery = z.object({
  status: OutboundStatusDto.optional(),
  page_id: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function withAdminQueueRoutes(admin: FastifyInstance) {
  const a = admin.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/queue",
    schema: {
      description:
        "List delivery-queue rows, newest first. Operator endpoint (admin flag " +
        "required); unlike the SimpleLogin surface it returns a total and takes " +
        "a limit. Raw message bytes are never returned — size_bytes only.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      querystring: ListQuery,
      response: { 200: AdminQueueListResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const { status, page_id, limit } = req.query;
      const where = status === undefined ? undefined : eq(outboundMessages.status, status);
      const [totalRow] = await db.select({ n: count() }).from(outboundMessages).where(where);
      const rows = await db
        .select(listColumns)
        .from(outboundMessages)
        .where(where)
        .orderBy(desc(outboundMessages.id))
        .limit(limit)
        .offset(page_id * limit);
      return { total: totalRow?.n ?? 0, messages: rows.map(toDto) };
    },
  });

  a.route({
    method: "GET",
    url: "/queue/:message_id",
    schema: {
      description:
        "One queue row: envelope, error state, an allowlisted set of ROUTING " +
        "headers (never Subject, never the body — the message is the user's " +
        "mail), and the owning user/alias — decoded from the VERP return path " +
        "when it verifies, else from the durable attribution columns (so DSNs, " +
        "trash copies and expired-VERP rows still name their user).",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      params: z.object({ message_id: z.coerce.number().int().min(1) }),
      response: {
        200: AdminQueueMessageDetailResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (req) => {
      // Only the HEAD of the bytea: the allowlist reads headers, and a row can
      // hold SMTP_MAX_MESSAGE_SIZE (25MB) of body the operator is never shown
      // anyway. Selecting the whole column pulled all of it through Postgres,
      // Bun and the parser to throw it away — `size_bytes` still reports the
      // true length via octet_length.
      const rows = await db
        .select({
          ...listColumns,
          rawHead: sql<Uint8Array>`substr(${outboundMessages.raw}, 1, ${HEADER_SCAN_BYTES})`,
        })
        .from(outboundMessages)
        .where(eq(outboundMessages.id, req.params.message_id))
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new HttpError(404, "Unknown queue message");

      const headers =
        row.rawHead.length === 0 ? [] : allowlistHeaders(parseMessage(row.rawHead).headers.fields);
      const owner = await resolveQueueOwner(db, {
        envelopeFrom: row.envelopeFrom,
        userId: row.userId,
        emailLogId: row.emailLogId,
      });
      return {
        message: toDto(row),
        headers,
        owner:
          owner === null
            ? null
            : {
                verp_type: owner.verpType,
                verp_id: owner.verpId,
                email_log_id: owner.emailLogId,
                verification_code_id: owner.verificationCodeId,
                user: owner.user,
                alias: owner.alias,
              },
      };
    },
  });

  a.route({
    method: "POST",
    url: "/queue/drop",
    schema: {
      description:
        "Drop queue rows: pending/sending become failed with last_error " +
        '"dropped by operator". Terminal rows and unknown ids are skipped. ' +
        "No DSN is generated — an operator drop is not a delivery outcome.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      body: AdminIdsBody,
      response: { 200: AdminDroppedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const ids = await dropMessages(db, req.body.ids);
      return { dropped: ids.length, ids };
    },
  });

  a.route({
    method: "POST",
    url: "/queue/requeue",
    schema: {
      description:
        "Return failed rows to pending for immediate re-attempt (tries reset). " +
        "Rows without raw bytes (cleared on successful delivery) are skipped.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      body: AdminIdsBody,
      response: { 200: AdminRequeuedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const ids = await requeueMessages(db, req.body.ids);
      return { requeued: ids.length, ids };
    },
  });

  a.route({
    method: "POST",
    url: "/queue/delete",
    schema: {
      description:
        "Hard-delete terminal rows (failed/sent) now, ahead of retention. " +
        "Pending/sending rows are skipped — drop (or bounce) them first.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      body: AdminIdsBody,
      response: { 200: AdminDeletedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const ids = await deleteMessages(db, req.body.ids);
      return { deleted: ids.length, ids };
    },
  });

  a.route({
    method: "POST",
    url: "/queue/bounce",
    schema: {
      description:
        "Bounce queue rows: send the originator the same RFC 3464 failure " +
        "notice a permanent delivery failure would (deduped per originator " +
        "per 24h), then mark the row failed ('bounced by operator'). Never " +
        "advances the alias auto-disable ledger — an operator decision is " +
        "not a mailbox-health signal. Skipped (with reasons): delivered " +
        "rows, null-reverse-path rows (DSNs, trash copies), transactional " +
        "system mail, and rows whose VERP no longer decodes.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      body: AdminIdsBody,
      response: { 200: AdminBouncedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const result = await bounceQueuedMessages(db, req.body.ids);
      return { bounced: result.bounced.length, ids: result.bounced, skipped: result.skipped };
    },
  });
}
