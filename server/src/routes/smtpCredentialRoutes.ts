// SMTP credentials — per-device submission passwords (Virtu extension; no
// SimpleLogin equivalent — SL has no SMTP submission). One credential per
// device ("Phone", "Laptop"), each revocable independently of the account
// password and of each other:
//   GET    /smtp/settings                    host/ports/username to paste
//   GET    /smtp/credentials                 list (never the secret)
//   POST   /smtp/credentials                 create; plaintext returned ONCE
//   DELETE /smtp/credentials/:credential_id  revoke immediately

import { randomBytes } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { config } from "../config";
import { db } from "../db";
import { type SmtpCredential, smtpCredentials } from "../db/schema";
import { timestampOf } from "./aliasText";
import { HttpError } from "./httpError";
import {
  DeletedResponse,
  ErrorResponse,
  SmtpCredentialCreatedDto,
  SmtpCredentialDto,
  SmtpSettingsDto,
} from "./schema";

/** Keep runaway scripted creation in check (well past any real device count). */
export const MAX_SMTP_CREDENTIALS = 20;

const CREDENTIAL_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l

/**
 * Generate a device password: four dash-separated groups of five characters
 * from an unambiguous lowercase alphabet (~100 bits) — app-password style,
 * easy to type on a phone once, never shown again.
 */
export function generateSmtpPassword(): string {
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => CREDENTIAL_ALPHABET[b % CREDENTIAL_ALPHABET.length]);
  const groups = [];
  for (let i = 0; i < 20; i += 5) groups.push(chars.slice(i, i + 5).join(""));
  return groups.join("-");
}

const CredentialIdParams = z.object({ credential_id: z.coerce.number().int() });

const SmtpCredentialsResponse = z
  .object({ credentials: z.array(SmtpCredentialDto) })
  .meta({ id: "SmtpCredentialsResponse" });

const CreateSmtpCredentialBody = z
  .object({ name: z.string().trim().min(1).max(128) })
  .meta({ id: "CreateSmtpCredentialRequest", example: { name: "Phone" } });

function credentialToDict(row: SmtpCredential) {
  return {
    id: row.id,
    name: row.name,
    creation_timestamp: timestampOf(row.createdAt),
    last_used_timestamp: row.lastUsedAt === null ? null : timestampOf(row.lastUsedAt),
  };
}

export async function withSmtpCredentialRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/smtp/settings",
    schema: {
      description:
        "The server half of a mail-client setup: submission hostname, both ports " +
        "(587 STARTTLS / 465 implicit TLS) and the SMTP username to use — the " +
        "account's own email address, never an alias. Deployment config, so the " +
        "client must ask rather than hardcode it.",
      tags: ["SmtpCredential"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: SmtpSettingsDto, 401: ErrorResponse },
    },
    handler: async (req) => ({
      hostname: config.mailHostname,
      port_starttls: config.submissionPort,
      port_tls: config.submissionTlsPort,
      username: req.user.email,
      mail_domain: config.mailDomain,
    }),
  });

  a.route({
    method: "GET",
    url: "/smtp/credentials",
    schema: {
      description:
        "List the account's per-device SMTP submission passwords. The secret itself " +
        "is never returned — it is shown exactly once, on creation.",
      tags: ["SmtpCredential"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: SmtpCredentialsResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(smtpCredentials)
        .where(eq(smtpCredentials.userId, req.user.id))
        .orderBy(smtpCredentials.id);
      return { credentials: rows.map(credentialToDict) };
    },
  });

  a.route({
    method: "POST",
    url: "/smtp/credentials",
    config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    schema: {
      description:
        "Create a per-device SMTP password (use it with your email address as the SMTP " +
        "username on port 587/465). The plaintext password is in this response and " +
        "nowhere else — only a hash is stored. Revoke a device any time with DELETE; " +
        "other devices and the account password are unaffected.",
      tags: ["SmtpCredential"],
      security: [{ apiKeyAuth: [] }],
      body: CreateSmtpCredentialBody,
      response: {
        201: SmtpCredentialCreatedDto,
        400: ErrorResponse,
        401: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const [existing] = await db
        .select({ n: count() })
        .from(smtpCredentials)
        .where(eq(smtpCredentials.userId, req.user.id));
      if ((existing?.n ?? 0) >= MAX_SMTP_CREDENTIALS) {
        throw new HttpError(400, "Too many SMTP credentials");
      }

      const password = generateSmtpPassword();
      const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });
      const inserted = await db
        .insert(smtpCredentials)
        .values({ userId: req.user.id, name: req.body.name, passwordHash })
        .returning();
      const row = inserted[0];
      if (row === undefined) throw new Error("smtp_credentials insert returned no row");

      reply.status(201);
      return { ...credentialToDict(row), password };
    },
  });

  a.route({
    method: "DELETE",
    url: "/smtp/credentials/:credential_id",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Revoke one device's SMTP password. Takes effect on the next AUTH — existing " +
        "SMTP sessions are not torn down.",
      tags: ["SmtpCredential"],
      security: [{ apiKeyAuth: [] }],
      params: CredentialIdParams,
      response: {
        200: DeletedResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const deleted = await db
        .delete(smtpCredentials)
        .where(
          and(
            eq(smtpCredentials.id, req.params.credential_id),
            eq(smtpCredentials.userId, req.user.id),
          ),
        )
        .returning({ id: smtpCredentials.id });
      if (deleted[0] === undefined) throw new HttpError(403, "Forbidden");
      return { deleted: true };
    },
  });
}
