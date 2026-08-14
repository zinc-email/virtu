// Account/misc endpoints — SimpleLogin-compatible:
//   GET   /stats               nb_alias/nb_forward/nb_reply/nb_block
//   GET   /setting             user settings, read from the users columns
//   PATCH /setting             validates (SimpleLogin error strings) + persists
//   GET   /v2/setting/domains  domains usable for random aliases (built-in +
//                              the user's verified custom domains)
//   PATCH /sudo                emailed code -> sudo mode on the current api
//                              key (two-step: no code = send one, code =
//                              verify it — accounts have no password)
//   POST  /api_key             sudo-gated key creation (440 without sudo)
//   GET   /logout              revokes the presented api key
//
// Sources: app/api/views/{user_info,setting,sudo}.py + app/api/base.py.
//
// Deviations (documented in the lane report):
// - GET /logout revokes the presented API key (SimpleLogin only clears the
//   web session cookie — we have no cookie sessions, and revoking is the
//   only meaningful logout for an api-key client).

import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "../auth/apiKey";
import { db } from "../db";
import { aliases, apiKeys, domains, emailLogs, type User, users } from "../db/schema";
import { canReceive } from "../pipeline/domainCapability";
import {
  consumeVerificationCode,
  createVerificationCode,
  isRateLimited,
  SUDO_CODE_ALERT_TYPE,
  sendWithRateLimit,
  sudoCodeEmail,
} from "../pipeline/transactional";
import { ALIAS_DOMAINS, FIRST_ALIAS_DOMAIN } from "./aliasConfig";
import { HttpError } from "./httpError";
import { assertSudoFresh } from "./sudoGuard";
import { ErrorResponse, OkResponse } from "./schema";

const StatsResponse = z
  .object({
    nb_alias: z.number().int(),
    nb_forward: z.number().int(),
    nb_reply: z.number().int(),
    nb_block: z.number().int(),
  })
  .meta({ id: "StatsResponse" });

const SENDER_FORMATS = ["AT", "A", "NAME_ONLY", "AT_ONLY", "NO_NAME"] as const;
const ALIAS_SUFFIX_SETTINGS = ["word", "random_string"] as const;

const SettingDto = z
  .object({
    alias_generator: z.enum(["word", "uuid"]),
    notification: z.boolean(),
    random_alias_default_domain: z.string(),
    sender_format: z.enum(SENDER_FORMATS),
    random_alias_suffix: z.enum(ALIAS_SUFFIX_SETTINGS),
  })
  .meta({ id: "Setting" });

const UpdateSettingBody = z
  .object({
    alias_generator: z.string().optional(),
    notification: z.boolean().optional(),
    random_alias_default_domain: z.string().optional(),
    sender_format: z.string().optional(),
    random_alias_suffix: z.string().optional(),
  })
  .meta({ id: "UpdateSettingRequest" });

const DomainDto = z
  .object({ domain: z.string(), is_custom: z.boolean() })
  .meta({ id: "SettingDomain" });

const SudoBody = z
  .object({ code: z.string().optional() })
  .meta({ id: "SudoRequest", example: { code: "662302" } });

const SudoCodeSentResponse = z.object({ msg: z.string() }).meta({ id: "SudoCodeSentResponse" });

const CreateApiKeyBody = z
  .object({ device: z.string().optional() })
  .meta({ id: "CreateApiKeyRequest", example: { device: "CLI script" } });

const ApiKeyResponse = z.object({ api_key: z.string() }).meta({ id: "ApiKeyResponse" });

const LogoutResponse = z.object({ msg: z.string() }).meta({ id: "LogoutResponse" });

/**
 * The user's default random-alias domain, verified still usable: one of
 * ALIAS_DOMAINS or one of the user's verified custom domains; anything else
 * (never set, custom domain deleted/unverified since) falls back to
 * FIRST_ALIAS_DOMAIN — SimpleLogin `User.default_random_alias_domain()`.
 */
async function usableDefaultAliasDomain(user: User): Promise<string> {
  const d = user.defaultAliasDomain;
  if (!d) return FIRST_ALIAS_DOMAIN;
  if (ALIAS_DOMAINS.includes(d)) return d;
  const rows = await db
    .select()
    .from(domains)
    .where(and(eq(domains.nameRequested, d), eq(domains.userId, user.id)))
    .limit(1);
  const cd = rows[0];
  if (cd && canReceive(cd)) return d;
  return FIRST_ALIAS_DOMAIN;
}

/** SimpleLogin `setting_to_dict` — unexpected stored values degrade to the
 * SimpleLogin defaults rather than failing serialization. */
function settingToDict(user: User, defaultDomain: string) {
  return {
    alias_generator: user.aliasGenerator === "uuid" ? ("uuid" as const) : ("word" as const),
    notification: user.notification,
    random_alias_default_domain: defaultDomain,
    sender_format: (SENDER_FORMATS as readonly string[]).includes(user.senderFormat)
      ? (user.senderFormat as (typeof SENDER_FORMATS)[number])
      : ("AT" as const),
    random_alias_suffix:
      user.randomAliasSuffix === "word" ? ("word" as const) : ("random_string" as const),
  };
}

export async function withAccountRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/stats",
    schema: {
      description: "Aggregate counts: aliases, forwards, replies, blocks.",
      tags: ["Account"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: StatsResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const userId = req.user.id;
      const [aliasCount] = await db
        .select({ n: count() })
        .from(aliases)
        .where(eq(aliases.userId, userId));
      // SimpleLogin get_stats: bounced rows are excluded from every counter.
      const countLogs = async (isReply: boolean, blocked: boolean) => {
        const [row] = await db
          .select({ n: count() })
          .from(emailLogs)
          .where(
            and(
              eq(emailLogs.userId, userId),
              eq(emailLogs.isReply, isReply),
              eq(emailLogs.blocked, blocked),
              eq(emailLogs.bounced, false),
            ),
          );
        return row?.n ?? 0;
      };
      return {
        nb_alias: aliasCount?.n ?? 0,
        nb_forward: await countLogs(false, false),
        nb_reply: await countLogs(true, false),
        nb_block: await countLogs(false, true),
      };
    },
  });

  a.route({
    method: "GET",
    url: "/setting",
    schema: {
      description: "Get user settings.",
      tags: ["Setting"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: SettingDto, 401: ErrorResponse },
    },
    handler: async (req) => settingToDict(req.user, await usableDefaultAliasDomain(req.user)),
  });

  a.route({
    method: "PATCH",
    url: "/setting",
    schema: {
      description:
        "Update user settings (SimpleLogin error strings on invalid values). " +
        "`random_alias_default_domain` must be a usable domain: one of the alias " +
        "domains or one of your verified custom domains.",
      tags: ["Setting"],
      security: [{ apiKeyAuth: [] }],
      body: UpdateSettingBody,
      response: { 200: SettingDto, 400: ErrorResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const body = req.body;
      const updates: Partial<typeof users.$inferInsert> = {};

      if (body.notification !== undefined) updates.notification = body.notification;

      if (body.alias_generator !== undefined) {
        if (!["word", "uuid"].includes(body.alias_generator)) {
          throw new HttpError(400, "Invalid alias_generator");
        }
        updates.aliasGenerator = body.alias_generator;
      }

      if (body.sender_format !== undefined) {
        if (!SENDER_FORMATS.includes(body.sender_format as (typeof SENDER_FORMATS)[number])) {
          throw new HttpError(400, "Invalid sender_format");
        }
        updates.senderFormat = body.sender_format;
      }

      if (body.random_alias_suffix !== undefined) {
        if (
          !ALIAS_SUFFIX_SETTINGS.includes(
            body.random_alias_suffix as (typeof ALIAS_SUFFIX_SETTINGS)[number],
          )
        ) {
          throw new HttpError(400, "Invalid random_alias_suffix");
        }
        updates.randomAliasSuffix = body.random_alias_suffix;
      }

      if (body.random_alias_default_domain !== undefined) {
        const domain = body.random_alias_default_domain;
        if (!ALIAS_DOMAINS.includes(domain)) {
          // Not a built-in domain: must be one of the user's verified custom
          // domains (SimpleLogin's "invalid domain").
          const rows = await db
            .select()
            .from(domains)
            .where(and(eq(domains.nameRequested, domain), eq(domains.userId, req.user.id)))
            .limit(1);
          const cd = rows[0];
          if (!cd || !canReceive(cd)) {
            throw new HttpError(400, "invalid domain");
          }
        }
        updates.defaultAliasDomain = domain;
      }

      if (Object.keys(updates).length > 0) {
        await db.update(users).set(updates).where(eq(users.id, req.user.id));
      }
      const updated: User = { ...req.user, ...updates } as User;
      return settingToDict(updated, await usableDefaultAliasDomain(updated));
    },
  });

  a.route({
    method: "GET",
    url: "/v2/setting/domains",
    schema: {
      description:
        "Domains usable for random aliases: the built-in alias domains plus the " +
        "user's verified custom domains.",
      tags: ["Setting"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: z.array(DomainDto), 401: ErrorResponse },
    },
    handler: async (req) => {
      const custom = (
        await db
          .select()
          .from(domains)
          .where(eq(domains.userId, req.user.id))
          .orderBy(domains.nameRequested)
      ).filter(canReceive);
      return [
        ...ALIAS_DOMAINS.map((domain) => ({ domain, is_custom: false })),
        ...custom.map((cd) => ({ domain: cd.nameRequested, is_custom: true })),
      ];
    },
  });

  a.route({
    method: "PATCH",
    url: "/sudo",
    // SimpleLogin: 5/minute.
    config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    schema: {
      description:
        "Enter sudo mode by confirming an emailed one-time code (accounts have no " +
        "password). Two-step on this one endpoint: call without a code to have one " +
        "emailed (202; budgeted 3/hour → 429), then call again with {code} — 403 on " +
        "a wrong code, 410 once it has been tried wrongly too many times. Sudo lasts " +
        "5 minutes on the presented api key and gates POST /api_key.",
      tags: ["Account"],
      security: [{ apiKeyAuth: [] }],
      body: SudoBody,
      response: {
        200: OkResponse,
        202: SudoCodeSentResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        410: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const submitted = req.body.code;
      if (submitted === undefined) {
        // Budget check BEFORE minting, so hammering this endpoint cannot
        // invalidate a code that is still in flight.
        if (
          await isRateLimited(db, {
            userId: req.user.id,
            toEmail: req.user.email,
            alertType: SUDO_CODE_ALERT_TYPE,
          })
        ) {
          throw new HttpError(429, "Too many confirmation emails requested, try again later");
        }
        const { code, row } = await createVerificationCode(db, {
          userId: req.user.id,
          purpose: "sudo",
        });
        const { subject, textBody } = sudoCodeEmail(code);
        await sendWithRateLimit(db, {
          userId: req.user.id,
          alertType: SUDO_CODE_ALERT_TYPE,
          to: req.user.email,
          subject,
          textBody,
          refId: row.id,
        });
        reply.status(202);
        return { msg: "Confirmation code sent" };
      }

      const result = await consumeVerificationCode(db, {
        userId: req.user.id,
        purpose: "sudo",
        code: submitted,
        toEmail: req.user.email,
      });
      if (result === "too_many") throw new HttpError(410, "Too many wrong tries");
      if (result !== "ok") throw new HttpError(403, "Invalid code");

      await db.update(apiKeys).set({ sudoModeAt: new Date() }).where(eq(apiKeys.id, req.apiKey.id));
      return { ok: true };
    },
  });

  a.route({
    method: "POST",
    url: "/api_key",
    schema: {
      description:
        "Create a new API key. Requires sudo mode (PATCH /sudo first); responds " +
        '440 {"error": "Need sudo"} otherwise.',
      tags: ["Account"],
      security: [{ apiKeyAuth: [] }],
      body: CreateApiKeyBody.nullish(),
      response: { 201: ApiKeyResponse, 401: ErrorResponse, 440: ErrorResponse },
    },
    handler: async (req, reply) => {
      assertSudoFresh(req.apiKey);

      const code = generateApiKey();
      await db.insert(apiKeys).values({
        userId: req.user.id,
        keyHash: hashApiKey(code),
        name: req.body?.device ?? null,
      });

      reply.status(201);
      return { api_key: code };
    },
  });

  a.route({
    method: "GET",
    url: "/logout",
    schema: {
      description:
        "Log out: revokes the presented API key (deviation — SimpleLogin only clears its " +
        "web-session cookie; we have no cookie sessions).",
      tags: ["Account"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: LogoutResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      await db.delete(apiKeys).where(eq(apiKeys.id, req.apiKey.id));
      return { msg: "User is logged out" };
    },
  });
}
