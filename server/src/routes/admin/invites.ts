// Operator invite endpoints (ABUSE.md Tier 0): list/mint/revoke over
// invites. Minting goes through the shared primitive (auth/invites.ts) —
// the same function bin/invite-create calls — so the API and the
// break-glass CLI can never diverge. Registered inside the requireAdmin
// scope (routes/index.ts). Used invites are the permanent invite graph
// (who vouched for whom) and can never be deleted; revoke touches unused
// rows only.

import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { createInvites } from "../../auth/invites";
import { db } from "../../db";
import { type Invite, invites, users } from "../../db/schema";
import { HttpError } from "../httpError";
import { ErrorResponse } from "../schema";
import {
  AdminInviteCreateBody,
  AdminInviteCreatedResponse,
  AdminInviteDeletedResponse,
  AdminInviteListResponse,
} from "./schema";

const LIST_LIMIT = 200;

/** Resolve the created_by/used_by user refs for a batch of invite rows. */
async function toInviteDtos(rows: Invite[]) {
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.createdBy, r.usedBy]).filter((id) => id !== null)),
  ];
  const refs =
    userIds.length === 0
      ? []
      : await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, userIds));
  const byId = new Map(refs.map((r) => [r.id, r]));
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    note: r.note,
    created_by: (r.createdBy !== null && byId.get(r.createdBy)) || null,
    used_by: (r.usedBy !== null && byId.get(r.usedBy)) || null,
    used_at: r.usedAt?.toISOString() ?? null,
    expires_at: r.expiresAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function withAdminInviteRoutes(admin: FastifyInstance) {
  const a = admin.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/invites",
    schema: {
      description:
        "List invites, newest first (up to 200), with total and unused counts. " +
        "Used invites carry the used_by linkage — the permanent invite graph.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: AdminInviteListResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async () => {
      const [rows, [total], [unused]] = await Promise.all([
        db.select().from(invites).orderBy(desc(invites.id)).limit(LIST_LIMIT),
        db.select({ n: count() }).from(invites),
        db.select({ n: count() }).from(invites).where(isNull(invites.usedAt)),
      ]);
      return {
        total: total?.n ?? 0,
        unused: unused?.n ?? 0,
        invites: await toInviteDtos(rows),
      };
    },
  });

  a.route({
    method: "POST",
    url: "/invites",
    schema: {
      description:
        "Mint invite codes (up to 100 at once), optionally with a note and an " +
        "expiry. Codes are returned here and remain readable in the list.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      body: AdminInviteCreateBody,
      response: { 200: AdminInviteCreatedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const expiresAt =
        req.body.expires_in_days === undefined
          ? null
          : new Date(Date.now() + req.body.expires_in_days * 24 * 60 * 60_000);
      const rows = await createInvites(db, {
        count: req.body.count,
        note: req.body.note,
        expiresAt,
        createdBy: req.user.id,
      });
      return { invites: await toInviteDtos(rows) };
    },
  });

  a.route({
    method: "DELETE",
    url: "/invites/:id",
    schema: {
      description:
        "Revoke an UNUSED invite. Used invites are the invite graph and can " +
        "never be deleted — 404 covers both a missing and a used id.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      params: z.object({ id: z.coerce.number().int().min(1) }),
      response: {
        200: AdminInviteDeletedResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (req) => {
      const deleted = await db
        .delete(invites)
        .where(and(eq(invites.id, req.params.id), isNull(invites.usedAt)))
        .returning({ id: invites.id });
      if (deleted.length === 0) throw new HttpError(404, "No unused invite with that id");
      return { deleted: deleted.length };
    },
  });
}
