// Mailboxes — SimpleLogin-compatible (docs/api.md + app/api/views/mailbox.py
// + app/mailbox_utils.py error strings):
//   GET    /v2/mailboxes        all mailboxes incl. unverified
//   POST   /mailboxes           create unverified + email a 6-digit code
//   POST   /mailboxes/:id/verify  enter the code (deviation: SimpleLogin
//                               verifies via a web LINK; an API needs a code
//                               flow, so we mail a code and accept it here —
//                               error strings from mailbox_utils.py)
//   PUT    /mailboxes/:id       set default / set-or-clear trash (Virtu
//                               extension); email change not supported yet
//   DELETE /mailboxes/:id       with optional transfer_aliases_to (deleting
//                               the trash mailbox clears users.trash_mailbox_id
//                               via its ON DELETE SET NULL)

import { count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { db } from "../db";
import { aliases, deletedAliases, mailboxes, users } from "../db/schema";
import {
  consumeVerificationCode,
  createVerificationCode,
  mailboxVerificationAlertType,
  mailboxVerificationEmail,
  sendWithRateLimit,
} from "../pipeline/transactional";
import { ALIAS_DOMAINS } from "./aliasConfig";
import { transferAliasMailboxJoins } from "./aliasMailboxes";
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
    // Virtu extension: designate (true) or clear (false) this mailbox as the
    // account's trash inbox — mail for disabled aliases lands there.
    trash: z.boolean().optional(),
  })
  .meta({ id: "UpdateMailboxRequest" });

const DeleteMailboxBody = z
  .object({ transfer_aliases_to: z.number().int().optional() })
  .meta({ id: "DeleteMailboxRequest" });

const VerifyMailboxBody = z
  .object({ code: z.string() })
  .meta({ id: "VerifyMailboxRequest", example: { code: "662302" } });

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function withMailboxRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  async function mailboxToDict(
    mb: typeof mailboxes.$inferSelect,
    defaultMailboxId: number | null,
    trashMailboxId: number | null,
  ) {
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
      trash: trashMailboxId === mb.id,
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
      for (const mb of rows)
        out.push(await mailboxToDict(mb, req.user.defaultMailboxId, req.user.trashMailboxId));
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
        "Create a new mailbox. It starts unverified: a 6-digit code (15-minute expiry) " +
        "is emailed to the address; confirm it via POST /mailboxes/{mailbox_id}/verify.",
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
          .values({ userId: req.user.id, email, verified: false })
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

      const { code, row } = await createVerificationCode(db, {
        userId: req.user.id,
        purpose: "mailbox",
        mailboxId: mb.id,
      });
      const { subject, textBody } = mailboxVerificationEmail(email, code);
      await sendWithRateLimit(db, {
        userId: req.user.id,
        alertType: mailboxVerificationAlertType(mb.id),
        to: email,
        subject,
        textBody,
        refId: row.id,
      });

      reply.status(201);
      return mailboxToDict(mb, req.user.defaultMailboxId, req.user.trashMailboxId);
    },
  });

  a.route({
    method: "POST",
    url: "/mailboxes/:mailbox_id/verify",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Verify a mailbox with the emailed 6-digit code. Deviation from SimpleLogin " +
        "(which verifies through a web link): the API accepts the code directly. " +
        "Error strings follow mailbox_utils.py; 410 once the code has been tried " +
        "wrongly too many times (re-create the mailbox to get a fresh code). " +
        "Verifying an already-verified mailbox is a no-op that returns it.",
      tags: ["Mailbox"],
      security: [{ apiKeyAuth: [] }],
      params: MailboxIdParams,
      body: VerifyMailboxBody,
      response: {
        200: MailboxDto,
        400: ErrorResponse,
        401: ErrorResponse,
        410: ErrorResponse,
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
      // Same string for "not yours" and "no such mailbox" (SimpleLogin's
      // verify_mailbox_code) — ownership is not probeable.
      if (!mb || mb.userId !== req.user.id) throw new HttpError(400, "Invalid mailbox");
      if (mb.verified) return mailboxToDict(mb, req.user.defaultMailboxId, req.user.trashMailboxId);

      const result = await consumeVerificationCode(db, {
        userId: req.user.id,
        purpose: "mailbox",
        mailboxId: mb.id,
        code: req.body.code,
        toEmail: mb.email,
      });
      if (result === "none") throw new HttpError(400, "Invalid code");
      if (result === "expired") {
        throw new HttpError(400, "Invalid activation code. Please request another code.");
      }
      if (result === "too_many") {
        throw new HttpError(410, "Invalid activation code. Please request another code.");
      }
      if (result === "wrong") throw new HttpError(400, "Invalid activation code");

      await db.update(mailboxes).set({ verified: true }).where(eq(mailboxes.id, mb.id));
      return mailboxToDict(
        { ...mb, verified: true },
        req.user.defaultMailboxId,
        req.user.trashMailboxId,
      );
    },
  });

  a.route({
    method: "PUT",
    url: "/mailboxes/:mailbox_id",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Update a mailbox. `default` sets the default mailbox; `trash` designates " +
        "(true) or clears (false) it as the account's trash inbox, where mail for " +
        "disabled aliases is delivered. `email` change returns 400 (not implemented " +
        "yet) and `cancel_email_change` is a no-op.",
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

      if (req.body.trash === true) {
        if (!mb.verified) {
          throw new HttpError(400, "Unverified mailbox cannot be used as trash mailbox");
        }
        // decideRcpt only routes to a verified AND enabled trash mailbox;
        // accepting a disabled one here would silently drop the very mail
        // the user configured trash to collect.
        if (mb.disabled) {
          throw new HttpError(400, "Disabled mailbox cannot be used as trash mailbox");
        }
        await db.update(users).set({ trashMailboxId: mb.id }).where(eq(users.id, req.user.id));
      } else if (req.body.trash === false && req.user.trashMailboxId === mb.id) {
        await db.update(users).set({ trashMailboxId: null }).where(eq(users.id, req.user.id));
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
          // Extra-mailbox (alias_mailboxes) rows follow the transfer too.
          await transferAliasMailboxJoins(tx, mb.id, transferId);
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
