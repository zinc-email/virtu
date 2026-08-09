// Alias CRUD — SimpleLogin-compatible (docs/api.md + app/api/views/alias.py):
//   GET/POST /v2/aliases          list (paginated, pinned/disabled/enabled
//                                 filters, POST variant carries {query})
//   GET      /aliases/:id         serialize_alias_info_v2
//   PUT/PATCH /aliases/:id        note, name, mailbox_id(s), pinned+disable_pgp
//                                 (accepted-but-ignored — not in schema v1)
//   DELETE   /aliases/:id         tombstone + delete
//   POST     /aliases/:id/toggle  flip enabled
//   GET      /aliases/:id/activities  from email_logs
//
// Error strings and status codes verbatim from the Python views.

import { and, desc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { db } from "../db";
import { aliases, contacts, deletedAliases, emailLogs, mailboxes } from "../db/schema";
import { PAGE_LIMIT } from "./aliasConfig";
import { aliasToDict, emailLogAction, loadAliasInfo, loadAliasInfos } from "./aliasInfo";
import { timestampOf, websiteSendTo } from "./aliasText";
import { HttpError } from "./httpError";
import { parsePageId } from "./paging";
import {
  ActivityAction,
  AliasDto,
  AliasesResponse,
  DeletedResponse,
  EnabledResponse,
  ErrorResponse,
  OkResponse,
} from "./schema";

const ListQuery = z.object({
  page_id: z.string().optional(),
  // Presence-only flags (SimpleLogin checks `in request.args`).
  pinned: z.string().optional(),
  disabled: z.string().optional(),
  enabled: z.string().optional(),
});

const ListBody = z
  .object({ query: z.string().optional() })
  .meta({ id: "AliasListQueryBody", description: "Optional search query (email/name/note ilike)" });

const AliasIdParams = z.object({ alias_id: z.coerce.number().int() });

const UpdateAliasBody = z
  .object({
    note: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    mailbox_id: z.number().int().optional(),
    mailbox_ids: z.array(z.number().int()).optional(),
    disable_pgp: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .meta({ id: "UpdateAliasRequest" });

const ActivityDto = z
  .object({
    action: ActivityAction,
    from: z.string(),
    to: z.string(),
    timestamp: z.number().int(),
    reverse_alias: z.string(),
    reverse_alias_address: z.string(),
  })
  .meta({ id: "AliasActivity" });

const ActivitiesResponse = z
  .object({ activities: z.array(ActivityDto) })
  .meta({ id: "AliasActivitiesResponse" });

type ListFilters = {
  pageId: number;
  filter: "pinned" | "disabled" | "enabled" | null;
  query: string | null;
};

async function listAliases(userId: number, { pageId, filter, query }: ListFilters) {
  // Pinning is not in schema v1: the pinned filter matches nothing.
  if (filter === "pinned") return { aliases: [] };

  const conds: SQL[] = [eq(aliases.userId, userId)];
  if (filter === "disabled") conds.push(eq(aliases.enabled, false));
  if (filter === "enabled") conds.push(eq(aliases.enabled, true));
  if (query) {
    const like = `%${query}%`;
    const searchCond = or(
      ilike(aliases.email, like),
      ilike(aliases.note, like),
      ilike(aliases.name, like),
    );
    if (searchCond) conds.push(searchCond);
  }

  const rows = await db
    .select()
    .from(aliases)
    .where(and(...conds))
    .orderBy(desc(aliases.createdAt), desc(aliases.id))
    .limit(PAGE_LIMIT)
    .offset(pageId * PAGE_LIMIT);

  const infos = await loadAliasInfos(rows);
  return { aliases: infos.map(aliasToDict) };
}

export async function withAliasRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  // ---- list (GET + POST-with-body variant) --------------------------------
  const listSchema = {
    description:
      "Get user aliases, paginated (20 per page). Filters pinned/disabled/enabled are " +
      "presence-based and exclusive. The POST variant additionally accepts a JSON body " +
      "with a `query` search string (some frameworks cannot send GET bodies).",
    tags: ["Alias"],
    security: [{ apiKeyAuth: [] }],
    querystring: ListQuery,
    response: { 200: AliasesResponse, 400: ErrorResponse, 401: ErrorResponse, 429: ErrorResponse },
  };

  const parseFilters = (query: z.infer<typeof ListQuery>): Omit<ListFilters, "query"> => ({
    pageId: parsePageId(query.page_id),
    filter:
      query.pinned !== undefined
        ? "pinned"
        : query.disabled !== undefined
          ? "disabled"
          : query.enabled !== undefined
            ? "enabled"
            : null,
  });

  a.route({
    method: "GET",
    url: "/v2/aliases",
    // SimpleLogin: 50/minute per user on the alias list.
    config: { rateLimit: { max: 50, timeWindow: "1 minute" } },
    schema: listSchema,
    handler: async (req) => listAliases(req.user.id, { ...parseFilters(req.query), query: null }),
  });

  a.route({
    method: "POST",
    url: "/v2/aliases",
    config: { rateLimit: { max: 50, timeWindow: "1 minute" } },
    schema: { ...listSchema, body: ListBody.nullish() },
    handler: async (req) =>
      listAliases(req.user.id, { ...parseFilters(req.query), query: req.body?.query ?? null }),
  });

  // ---- single alias -------------------------------------------------------
  a.route({
    method: "GET",
    url: "/aliases/:alias_id",
    schema: {
      description: "Get alias info (same shape as the /v2/aliases items).",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      response: { 200: AliasDto, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const info = await loadAliasInfo(req.user.id, req.params.alias_id);
      if (!info) throw new HttpError(403, "Forbidden");
      return aliasToDict(info);
    },
  });

  a.route({
    method: ["PUT", "PATCH"],
    url: "/aliases/:alias_id",
    schema: {
      description:
        "Update alias fields. `disable_pgp` and `pinned` are accepted but ignored " +
        "(PGP and pinning are not implemented yet). `mailbox_ids` keeps only the first " +
        "id (single-mailbox aliases for now).",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      body: UpdateAliasBody,
      response: { 200: OkResponse, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const body = req.body;
      if (Object.keys(body).length === 0) {
        throw new HttpError(400, "request body cannot be empty");
      }

      const rows = await db
        .select()
        .from(aliases)
        .where(eq(aliases.id, req.params.alias_id))
        .limit(1);
      const alias = rows[0];
      if (!alias || alias.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      const updates: Partial<typeof aliases.$inferInsert> = {};

      if ("note" in body) updates.note = body.note ?? null;

      if ("name" in body) {
        const newName = body.name ?? null;
        if (newName && newName.length > 128) {
          throw new HttpError(400, "Name can't be longer than 128 characters");
        }
        updates.name = newName ? newName.replace(/\n/g, "") : newName;
      }

      // mailbox_id / mailbox_ids: must be the user's own verified mailbox.
      const requestedMailboxIds =
        body.mailbox_ids !== undefined
          ? body.mailbox_ids
          : body.mailbox_id !== undefined
            ? [body.mailbox_id]
            : null;
      if (requestedMailboxIds !== null) {
        if (requestedMailboxIds.length === 0) {
          throw new HttpError(400, "Must include at least one mailbox");
        }
        const owned = await db
          .select()
          .from(mailboxes)
          .where(inArray(mailboxes.id, requestedMailboxIds));
        const allValid =
          owned.length === requestedMailboxIds.length &&
          owned.every((m) => m.userId === req.user.id && m.verified);
        if (!allValid) throw new HttpError(400, "Forbidden");
        // Single-mailbox aliases: keep the first (documented deviation).
        updates.mailboxId = requestedMailboxIds[0];
      }

      // disable_pgp / pinned: accepted for compatibility, ignored (no columns).

      if (Object.keys(updates).length > 0) {
        await db.update(aliases).set(updates).where(eq(aliases.id, alias.id));
      }
      return { ok: true };
    },
  });

  a.route({
    method: "DELETE",
    url: "/aliases/:alias_id",
    schema: {
      description: "Delete an alias. The address is tombstoned and never reusable.",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      response: { 200: DeletedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(aliases)
        .where(eq(aliases.id, req.params.alias_id))
        .limit(1);
      const alias = rows[0];
      if (!alias || alias.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      await db.transaction(async (tx) => {
        await tx
          .insert(deletedAliases)
          .values({ email: alias.email, reason: "user_deleted", aliasId: alias.id })
          .onConflictDoNothing();
        await tx.delete(aliases).where(eq(aliases.id, alias.id));
      });
      return { deleted: true };
    },
  });

  a.route({
    method: "POST",
    url: "/aliases/:alias_id/toggle",
    // SimpleLogin: 100/hour.
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description: "Enable/disable an alias; returns the new status.",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      response: {
        200: EnabledResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(aliases)
        .where(eq(aliases.id, req.params.alias_id))
        .limit(1);
      const alias = rows[0];
      if (!alias || alias.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      const enabled = !alias.enabled;
      await db.update(aliases).set({ enabled }).where(eq(aliases.id, alias.id));
      return { enabled };
    },
  });

  a.route({
    method: "GET",
    url: "/aliases/:alias_id/activities",
    // SimpleLogin: 30/minute.
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    schema: {
      description: "Get alias activities (email log entries), paginated (20 per page).",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      querystring: z.object({ page_id: z.string().optional() }),
      response: {
        200: ActivitiesResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const pageId = parsePageId(req.query.page_id);
      const rows = await db
        .select()
        .from(aliases)
        .where(eq(aliases.id, req.params.alias_id))
        .limit(1);
      const alias = rows[0];
      if (!alias || alias.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      const logs = await db
        .select({ log: emailLogs, contact: contacts })
        .from(emailLogs)
        .innerJoin(contacts, eq(emailLogs.contactId, contacts.id))
        .where(eq(emailLogs.aliasId, alias.id))
        .orderBy(desc(emailLogs.createdAt), desc(emailLogs.id))
        .limit(PAGE_LIMIT)
        .offset(pageId * PAGE_LIMIT);

      const activities = logs.map(({ log, contact }) => {
        const action = emailLogAction(log);
        return {
          action,
          from: log.isReply ? alias.email : contact.websiteEmail,
          to: log.isReply ? contact.websiteEmail : alias.email,
          timestamp: timestampOf(log.createdAt),
          reverse_alias: websiteSendTo(contact),
          reverse_alias_address: contact.replyEmail,
        };
      });
      return { activities };
    },
  });
}

// Shared with contacts.ts: fetch an alias only when it belongs to the user.
export async function findOwnedAlias(userId: number, aliasId: number) {
  const rows = await db.select().from(aliases).where(eq(aliases.id, aliasId)).limit(1);
  const alias = rows[0];
  if (!alias || alias.userId !== userId) return null;
  return alias;
}
