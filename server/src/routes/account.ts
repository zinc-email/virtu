// Account/misc endpoints — SimpleLogin-compatible:
//   GET   /stats               nb_alias/nb_forward/nb_reply/nb_block
//   GET   /setting             user settings, read from the users columns
//   PATCH /setting             validates (SimpleLogin error strings) + persists
//   GET   /v2/setting/domains  domains usable for random aliases (built-in +
//                              the user's verified custom domains)
//   PATCH /sudo                password -> sudo mode on the current api key
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
import { aliases, apiKeys, customDomains, emailLogs, type User, users } from "../db/schema";
import { ALIAS_DOMAINS, FIRST_ALIAS_DOMAIN, SUDO_MODE_MINUTES_VALID } from "./aliasConfig";
import { HttpError } from "./httpError";
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
  .object({ password: z.string().optional() })
  .meta({ id: "SudoRequest", example: { password: "yourpassword" } });

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
  const rows = await db.select().from(customDomains).where(eq(customDomains.domain, d)).limit(1);
  const cd = rows[0];
  if (cd && cd.userId === user.id && cd.verified) return d;
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
            .from(customDomains)
            .where(eq(customDomains.domain, domain))
            .limit(1);
          const cd = rows[0];
          if (!cd || cd.userId !== req.user.id || !cd.verified) {
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
      const custom = await db
        .select()
        .from(customDomains)
        .where(and(eq(customDomains.userId, req.user.id), eq(customDomains.verified, true)))
        .orderBy(customDomains.domain);
      return [
        ...ALIAS_DOMAINS.map((domain) => ({ domain, is_custom: false })),
        ...custom.map((cd) => ({ domain: cd.domain, is_custom: true })),
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
        "Enter sudo mode by re-entering the account password. Sudo lasts 5 minutes on " +
        "the presented api key and gates POST /api_key.",
      tags: ["Account"],
      security: [{ apiKeyAuth: [] }],
      body: SudoBody,
      response: { 200: OkResponse, 401: ErrorResponse, 403: ErrorResponse, 429: ErrorResponse },
    },
    handler: async (req) => {
      const password = req.body.password;
      if (password === undefined) throw new HttpError(403, "Invalid password");
      const ok = await Bun.password.verify(password, req.user.passwordHash);
      if (!ok) throw new HttpError(403, "Invalid password");

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
      const sudoAt = req.apiKey.sudoModeAt;
      const fresh =
        sudoAt !== null && Date.now() - sudoAt.getTime() <= SUDO_MODE_MINUTES_VALID * 60_000;
      if (!fresh) throw new HttpError(440, "Need sudo");

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
