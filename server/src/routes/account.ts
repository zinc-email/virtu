// Account/misc endpoints — SimpleLogin-compatible:
//   GET   /stats               nb_alias/nb_forward/nb_reply/nb_block
//   GET   /setting             user settings (defaults for unimplemented ones)
//   PATCH /setting             persists `notification`; validates the rest
//   GET   /v2/setting/domains  domains usable for random aliases
//   PATCH /sudo                password -> sudo mode on the current api key
//   POST  /api_key             sudo-gated key creation (440 without sudo)
//   GET   /logout              revokes the presented api key
//
// Sources: app/api/views/{user_info,setting,sudo}.py + app/api/base.py.
//
// Deviations (documented in the lane report):
// - Settings other than `notification` have no schema columns yet: GET
//   returns SimpleLogin-shaped defaults; PATCH validates values (SimpleLogin
//   error strings) but only persists `notification`.
// - GET /logout revokes the presented API key (SimpleLogin only clears the
//   web session cookie — we have no cookie sessions, and revoking is the
//   only meaningful logout for an api-key client).

import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { generateApiKey, hashApiKey } from "../auth/apiKey";
import { db } from "../db";
import { aliases, apiKeys, emailLogs, users } from "../db/schema";
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

function settingToDict(user: { notification: boolean }) {
  return {
    // Defaults for settings without schema columns yet (see module doc).
    alias_generator: "word" as const,
    notification: user.notification,
    random_alias_default_domain: FIRST_ALIAS_DOMAIN,
    sender_format: "AT" as const,
    random_alias_suffix: "random_string" as const,
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
      description: "Get user settings (SimpleLogin-shaped; see PATCH for what persists).",
      tags: ["Setting"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: SettingDto, 401: ErrorResponse },
    },
    handler: async (req) => settingToDict(req.user),
  });

  a.route({
    method: "PATCH",
    url: "/setting",
    schema: {
      description:
        "Update user settings. Only `notification` persists today; the other fields are " +
        "validated (SimpleLogin error strings) but not yet stored.",
      tags: ["Setting"],
      security: [{ apiKeyAuth: [] }],
      body: UpdateSettingBody,
      response: { 200: SettingDto, 400: ErrorResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const body = req.body;

      if (body.alias_generator !== undefined && !["word", "uuid"].includes(body.alias_generator)) {
        throw new HttpError(400, "Invalid alias_generator");
      }
      if (
        body.sender_format !== undefined &&
        !SENDER_FORMATS.includes(body.sender_format as (typeof SENDER_FORMATS)[number])
      ) {
        throw new HttpError(400, "Invalid sender_format");
      }
      if (
        body.random_alias_suffix !== undefined &&
        !ALIAS_SUFFIX_SETTINGS.includes(
          body.random_alias_suffix as (typeof ALIAS_SUFFIX_SETTINGS)[number],
        )
      ) {
        throw new HttpError(400, "Invalid random_alias_suffix");
      }
      if (
        body.random_alias_default_domain !== undefined &&
        !ALIAS_DOMAINS.includes(body.random_alias_default_domain)
      ) {
        throw new HttpError(400, "invalid domain");
      }

      let notification = req.user.notification;
      if (body.notification !== undefined) {
        notification = body.notification;
        await db.update(users).set({ notification }).where(eq(users.id, req.user.id));
      }
      return settingToDict({ notification });
    },
  });

  a.route({
    method: "GET",
    url: "/v2/setting/domains",
    schema: {
      description: "Domains usable for random aliases.",
      tags: ["Setting"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: z.array(DomainDto), 401: ErrorResponse },
    },
    handler: async () => ALIAS_DOMAINS.map((domain) => ({ domain, is_custom: false })),
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
      body: CreateApiKeyBody.optional(),
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
