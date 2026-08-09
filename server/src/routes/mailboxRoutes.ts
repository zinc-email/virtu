// Mailboxes — SimpleLogin-compatible (docs/api.md + app/api/views/mailbox.py
// + app/mailbox_utils.py error strings):
//   GET    /v2/mailboxes        all mailboxes incl. unverified
//   POST   /mailboxes           create (MVP: created verified=true — see TODO)
//   PUT    /mailboxes/:id       set default; email change not supported yet
//   DELETE /mailboxes/:id       with optional transfer_aliases_to
//
// TODO(MVP deviation): SimpleLogin creates mailboxes unverified and sends a
// verification email. We have no outbound transactional mail yet, so new
// mailboxes are created verified=true. Flip to verified=false + send the
// activation email once the transactional-mail lane lands.

import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { db } from "../db";
import { aliases, deletedAliases, mailboxes, users } from "../db/schema";
import { ALIAS_DOMAINS } from "./aliasConfig";
import { timestampOf } from "./aliasText";
import { normalizeEmail } from "./auth";
import { HttpError } from "./httpError";
import { DeletedResponse, ErrorResponse, MailboxDto, UpdatedResponse } from "./schema";

const MailboxIdParams = z.object({ mailbox_id: z.coerce.number().int() });

const MailboxesResponse = z
  .object({ mailboxes: z.array(MailboxDto) })
  .meta({ id: "MailboxesResponse" });

const CreateMailboxBody = z
  .object({ email: z.string() })
  .meta({ id: "CreateMailboxRequest", example: { email: "second@example.com" } });

const UpdateMailboxBody = z
  .object({
    default: z.boolean().optional(),
    email: z.string().optional(),
    cancel_email_change: z.boolean().optional(),
  })
  .meta({ id: "UpdateMailboxRequest" });

const DeleteMailboxBody = z
  .object({ transfer_aliases_to: z.number().int().optional() })
  .meta({ id: "DeleteMailboxRequest" });

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function withMailboxRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  async function mailboxToDict(mb: typeof mailboxes.$inferSelect, defaultMailboxId: number | null) {
    const [aliasCount] = await db
      .select({ n: count() })
      .from(aliases)
      .where(eq(aliases.mailboxId, mb.id));
    return {
      id: mb.id,
      email: mb.email,
      verified: mb.verified,
      default: defaultMailboxId === mb.id,
      creation_timestamp: timestampOf(mb.createdAt),
      nb_alias: aliasCount?.n ?? 0,
    };
  }

  a.route({
    method: "GET",
    url: "/v2/mailboxes",
    schema: {
      description: "Get the user's mailboxes, including unverified ones.",
      tags: ["Mailbox"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: MailboxesResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const rows = await db.select().from(mailboxes).where(eq(mailboxes.userId, req.user.id));
      const out = [];
      for (const mb of rows) out.push(await mailboxToDict(mb, req.user.defaultMailboxId));
      return { mailboxes: out };
    },
  });

  a.route({
    method: "POST",
    url: "/mailboxes",
    // SimpleLogin: 20/hour.
    config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    schema: {
      description:
        "Create a new mailbox. MVP deviation: created verified=true (no verification " +
        "email is sent yet).",
      tags: ["Mailbox"],
      security: [{ apiKeyAuth: [] }],
      body: CreateMailboxBody,
      response: { 201: MailboxDto, 400: ErrorResponse, 401: ErrorResponse, 429: ErrorResponse },
    },
    handler: async (req, reply) => {
      const email = normalizeEmail(req.body.email);
      if (!looksLikeEmail(email)) throw new HttpError(400, "Invalid email");
      // An address on one of our alias domains can never be a mailbox.
      const domain = email.slice(email.lastIndexOf("@") + 1);
      if (ALIAS_DOMAINS.includes(domain)) throw new HttpError(400, "Invalid email");

      // Uniqueness is per user in schema v1 (unlike SimpleLogin's global
      // check); the unique index catches the race.
      const mine = await db.select().from(mailboxes).where(eq(mailboxes.userId, req.user.id));
      if (mine.some((m) => m.email === email)) {
        throw new HttpError(400, "Email already used");
      }

      let mb: typeof mailboxes.$inferSelect | undefined;
      try {
        const inserted = await db
          .insert(mailboxes)
          .values({ userId: req.user.id, email, verified: true })
          .returning();
        mb = inserted[0];
      } catch (err) {
        const message = err instanceof Error ? err.message : "";
        const code =
          typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
        if (code === "23505" || message.includes("duplicate key")) {
          throw new HttpError(400, "Email already used");
        }
        throw err;
      }
      if (!mb) throw new Error("mailbox insert returned no row");

      reply.status(201);
      return mailboxToDict(mb, req.user.defaultMailboxId);
    },
  });

  a.route({
    method: "PUT",
    url: "/mailboxes/:mailbox_id",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Update a mailbox. Only `default` is supported; `email` change returns 400 " +
        "(not implemented yet) and `cancel_email_change` is a no-op.",
      tags: ["Mailbox"],
      security: [{ apiKeyAuth: [] }],
      params: MailboxIdParams,
      body: UpdateMailboxBody,
      response: {
        200: UpdatedResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, req.params.mailbox_id))
        .limit(1);
      const mb = rows[0];
      if (!mb || mb.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      if (req.body.email !== undefined) {
        throw new HttpError(400, "Mailbox email change is not supported yet");
      }

      if (req.body.default) {
        if (!mb.verified) {
          throw new HttpError(400, "Unverified mailbox cannot be used as default mailbox");
        }
        await db.update(users).set({ defaultMailboxId: mb.id }).where(eq(users.id, req.user.id));
      }

      return { updated: true };
    },
  });

  a.route({
    method: "DELETE",
    url: "/mailboxes/:mailbox_id",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Delete a mailbox. Its aliases are deleted (and tombstoned) unless " +
        "transfer_aliases_to names another of your verified mailboxes (-1 = delete).",
      tags: ["Mailbox"],
      security: [{ apiKeyAuth: [] }],
      params: MailboxIdParams,
      body: DeleteMailboxBody.nullish(),
      response: {
        200: DeletedResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, req.params.mailbox_id))
        .limit(1);
      const mb = rows[0];
      if (!mb || mb.userId !== req.user.id) throw new HttpError(403, "Forbidden");
      if (req.user.defaultMailboxId === mb.id) {
        throw new HttpError(400, "Cannot delete your default mailbox");
      }

      const rawTransfer = req.body?.transfer_aliases_to;
      const transferId = rawTransfer !== undefined && rawTransfer >= 0 ? rawTransfer : null;

      if (transferId !== null) {
        if (transferId === mb.id) {
          throw new HttpError(
            400,
            "You can not transfer the aliases to the mailbox you want to delete",
          );
        }
        const targetRows = await db
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.id, transferId))
          .limit(1);
        const target = targetRows[0];
        if (!target || target.userId !== req.user.id) {
          throw new HttpError(400, "You must transfer the aliases to a mailbox you own");
        }
        if (!target.verified) {
          throw new HttpError(400, "Your new mailbox is not verified");
        }
      }

      await db.transaction(async (tx) => {
        if (transferId !== null) {
          await tx
            .update(aliases)
            .set({ mailboxId: transferId })
            .where(eq(aliases.mailboxId, mb.id));
        } else {
          const doomed = await tx
            .select({ id: aliases.id, email: aliases.email })
            .from(aliases)
            .where(eq(aliases.mailboxId, mb.id));
          if (doomed.length > 0) {
            await tx
              .insert(deletedAliases)
              .values(
                doomed.map((d) => ({ email: d.email, reason: "mailbox_deleted", aliasId: d.id })),
              )
              .onConflictDoNothing();
            await tx.delete(aliases).where(eq(aliases.mailboxId, mb.id));
          }
        }
        await tx.delete(mailboxes).where(eq(mailboxes.id, mb.id));
      });

      return { deleted: true };
    },
  });
}
