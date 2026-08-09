// Contacts (reverse aliases) — SimpleLogin-compatible:
//   GET    /aliases/:id/contacts   paginated serialize_contact list
//   POST   /aliases/:id/contacts   create contact -> mint a reverse alias
//   DELETE /contacts/:id
//   POST   /contacts/:id/toggle    block/unblock forwarding
//
// Sources: app/api/views/alias.py + app/api/serializer.py serialize_contact.
//
// DUPLICATION FLAG: generateReplyEmail() reimplements SimpleLogin's
// generate_reply_email (random 20-50 lowercase chars @ default domain). The
// mx/forward pipeline (wave 2) must create reverse aliases the same way via
// rewriteForward's getOrCreateContact callback — consolidate this helper into
// a shared module (or the pipeline's DB adapter) when that lands.

import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { db } from "../db";
import { type Contact, contacts, emailLogs } from "../db/schema";
import { parseAddressList } from "../mail";
import { FIRST_ALIAS_DOMAIN, PAGE_LIMIT } from "./aliasConfig";
import { emailAvailable } from "./aliasInfo";
import { formatCreationDate, randomString, timestampOf, websiteSendTo } from "./aliasText";
import { findOwnedAlias } from "./aliases";
import { HttpError } from "./httpError";
import { parsePageId } from "./paging";
import { ContactDto, DeletedResponse, ErrorResponse } from "./schema";

const AliasIdParams = z.object({ alias_id: z.coerce.number().int() });
const ContactIdParams = z.object({ contact_id: z.coerce.number().int() });

const ContactsResponse = z
  .object({ contacts: z.array(ContactDto) })
  .meta({ id: "ContactsResponse" });

const CreateContactBody = z.object({ contact: z.string() }).meta({
  id: "CreateContactRequest",
  example: { contact: "First Last <first@example.com>" },
});

const BlockForwardResponse = z
  .object({ block_forward: z.boolean() })
  .meta({ id: "BlockForwardResponse" });

/** Mint an unused reverse-alias address (SimpleLogin generate_reply_email). */
async function generateReplyEmail(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const length = 20 + Math.floor(Math.random() * 31);
    const candidate = `${randomString(length)}@${FIRST_ALIAS_DOMAIN}`;
    if (await emailAvailable(candidate)) return candidate;
  }
  throw new Error("Cannot generate reply email");
}

function contactToDict(contact: Contact, lastReplyAt: Date | null, existed: boolean) {
  return {
    id: contact.id,
    contact: contact.websiteEmail,
    creation_date: formatCreationDate(contact.createdAt),
    creation_timestamp: timestampOf(contact.createdAt),
    last_email_sent_date: lastReplyAt ? formatCreationDate(lastReplyAt) : null,
    last_email_sent_timestamp: lastReplyAt ? timestampOf(lastReplyAt) : null,
    reverse_alias: websiteSendTo(contact),
    reverse_alias_address: contact.replyEmail,
    block_forward: contact.blockForward,
    existed,
  };
}

async function lastReplyAtFor(contactIds: number[]): Promise<Map<number, Date>> {
  if (contactIds.length === 0) return new Map();
  const rows = await db
    .select({ contactId: emailLogs.contactId, at: max(emailLogs.createdAt) })
    .from(emailLogs)
    .where(and(inArray(emailLogs.contactId, contactIds), eq(emailLogs.isReply, true)))
    .groupBy(emailLogs.contactId);
  const out = new Map<number, Date>();
  for (const r of rows) if (r.at) out.set(r.contactId, r.at);
  return out;
}

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function withContactRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/aliases/:alias_id/contacts",
    schema: {
      description: "Get contacts (reverse aliases) for an alias, paginated (20 per page).",
      tags: ["Contact"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      querystring: z.object({ page_id: z.string().optional() }),
      response: {
        200: ContactsResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (req) => {
      const pageId = parsePageId(req.query.page_id);
      const alias = await findOwnedAlias(req.user.id, req.params.alias_id);
      if (!alias) throw new HttpError(404, "No such alias");

      const rows = await db
        .select()
        .from(contacts)
        .where(eq(contacts.aliasId, alias.id))
        .orderBy(desc(contacts.id))
        .limit(PAGE_LIMIT)
        .offset(pageId * PAGE_LIMIT);

      const lastReplies = await lastReplyAtFor(rows.map((c) => c.id));
      return {
        contacts: rows.map((c) => contactToDict(c, lastReplies.get(c.id) ?? null, false)),
      };
    },
  });

  a.route({
    method: "POST",
    url: "/aliases/:alias_id/contacts",
    schema: {
      description:
        "Create a contact for an alias; a reverse alias is minted for it. Accepts a bare " +
        'address or a full mailbox ("First Last <first@example.com>"). Returns 201, or 200 ' +
        "with existed=true when the contact was already added.",
      tags: ["Contact"],
      security: [{ apiKeyAuth: [] }],
      params: AliasIdParams,
      body: CreateContactBody,
      response: {
        200: ContactDto,
        201: ContactDto,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const alias = await findOwnedAlias(req.user.id, req.params.alias_id);
      if (!alias) throw new HttpError(403, "Forbidden");

      const raw = req.body.contact.trim();
      if (!raw) throw new HttpError(400, "Empty address is not a valid email address");

      const parsed = parseAddressList(raw)[0];
      const address = (parsed?.address ?? raw).trim().toLowerCase();
      const name = parsed?.name?.trim() || null;
      if (!looksLikeEmail(address)) {
        throw new HttpError(400, `${raw} is not a valid email address`);
      }

      // SimpleLogin CannotCreateContactForReverseAlias.
      const reverseHit = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.replyEmail, address))
        .limit(1);
      if (reverseHit.length > 0) {
        throw new HttpError(400, "You can't create contact for a reverse alias");
      }

      const existing = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.aliasId, alias.id), eq(contacts.websiteEmail, address)))
        .limit(1);
      if (existing[0]) {
        const lastReplies = await lastReplyAtFor([existing[0].id]);
        reply.status(200);
        return contactToDict(existing[0], lastReplies.get(existing[0].id) ?? null, true);
      }

      const replyEmail = await generateReplyEmail();
      let created: Contact | undefined;
      try {
        const inserted = await db
          .insert(contacts)
          .values({
            userId: req.user.id,
            aliasId: alias.id,
            websiteEmail: address,
            replyEmail,
            name,
          })
          .returning();
        created = inserted[0];
      } catch (err) {
        // Unique (alias_id, website_email) race: someone else won -> existed.
        const isUnique =
          typeof err === "object" &&
          err !== null &&
          (("code" in err && err.code === "23505") ||
            (err instanceof Error && err.message.includes("duplicate key")));
        if (!isUnique) throw err;
        const winner = await db
          .select()
          .from(contacts)
          .where(and(eq(contacts.aliasId, alias.id), eq(contacts.websiteEmail, address)))
          .limit(1);
        if (!winner[0]) throw err;
        reply.status(200);
        return contactToDict(winner[0], null, true);
      }
      if (!created) throw new Error("contact insert returned no row");

      reply.status(201);
      return contactToDict(created, null, false);
    },
  });

  a.route({
    method: "DELETE",
    url: "/contacts/:contact_id",
    schema: {
      description: "Delete a contact.",
      tags: ["Contact"],
      security: [{ apiKeyAuth: [] }],
      params: ContactIdParams,
      response: { 200: DeletedResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, req.params.contact_id))
        .limit(1);
      const contact = rows[0];
      if (!contact || contact.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      await db.delete(contacts).where(eq(contacts.id, contact.id));
      return { deleted: true };
    },
  });

  a.route({
    method: "POST",
    url: "/contacts/:contact_id/toggle",
    schema: {
      description: "Block/unblock forwarding from a contact; returns the new state.",
      tags: ["Contact"],
      security: [{ apiKeyAuth: [] }],
      params: ContactIdParams,
      response: { 200: BlockForwardResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(contacts)
        .where(eq(contacts.id, req.params.contact_id))
        .limit(1);
      const contact = rows[0];
      if (!contact || contact.userId !== req.user.id) throw new HttpError(403, "Forbidden");

      const blockForward = !contact.blockForward;
      await db.update(contacts).set({ blockForward }).where(eq(contacts.id, contact.id));
      return { block_forward: blockForward };
    },
  });
}
