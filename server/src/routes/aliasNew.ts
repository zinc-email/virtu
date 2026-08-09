// Alias creation — SimpleLogin-compatible:
//   GET  /v5/alias/options     suffixes (signed), can_create, prefix suggestion
//   POST /v3/alias/custom/new  alias_prefix + signed_suffix + mailbox_ids
//   POST /alias/random/new     ?mode=uuid|word
//
// Sources: app/api/views/{alias_options,new_custom_alias,new_random_alias}.py.
// Error strings and status codes verbatim.
//
// Deviations (documented in the lane report):
// - No alias_used_on table in schema v1: the `hostname` query param is
//   accepted but not recorded, and options never returns `recommendation`.
// - Custom domains are out of scope: suffixes are built from ALIAS_DOMAINS
//   only (is_custom always false).
// - Multi-window rate limits (SimpleLogin ALIAS_LIMIT "100/day;50/hour;
//   5/minute") collapse to the tightest window, 5/minute.

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { isPremium } from "../billing/premium";
import { MAX_ALIAS_FREE_PLAN } from "../config";
import { db } from "../db";
import { type Alias, aliases, mailboxes, users } from "../db/schema";
import { ALIAS_DOMAINS, SUFFIX_MAX_AGE_SECONDS, SUFFIX_SIGNING_SECRET } from "./aliasConfig";
import { aliasToDict, emailAvailable, loadAliasInfos } from "./aliasInfo";
import {
  checkAliasPrefix,
  convertToId,
  prefixSuggestionFromHostname,
  randomString,
} from "./aliasText";
import { HttpError } from "./httpError";
import { CreatedAliasResponse, ErrorResponse } from "./schema";
import { signSuffix, verifySignedSuffix } from "./signedSuffix";
import { randomWords } from "./wordlist";

const ALIAS_CREATION_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };

const SuffixDto = z
  .object({
    suffix: z.string(),
    signed_suffix: z.string(),
    is_custom: z.boolean(),
    is_premium: z.boolean(),
  })
  .meta({ id: "AliasSuffix" });

const AliasOptionsResponse = z
  .object({
    can_create: z.boolean(),
    prefix_suggestion: z.string(),
    suffixes: z.array(SuffixDto),
    recommendation: z
      .object({ alias: z.string(), hostname: z.string() })
      .optional()
      .meta({ description: "Never returned yet (alias_used_on tracking not implemented)" }),
  })
  .meta({ id: "AliasOptionsResponse" });

const HostnameQuery = z.object({ hostname: z.string().optional() });

const NewCustomAliasBody = z
  .object({
    alias_prefix: z.string(),
    signed_suffix: z.string(),
    mailbox_ids: z.array(z.number().int()),
    note: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .meta({
    id: "NewCustomAliasRequest",
    example: {
      alias_prefix: "groupon",
      signed_suffix: ".abc12@virtu.email.XXXX.YYYY",
      mailbox_ids: [1],
      note: "For groupon.com",
      name: "Group On",
    },
  });

const NewRandomAliasBody = z
  .object({ note: z.string().nullable().optional() })
  .meta({ id: "NewRandomAliasRequest" });

/** SimpleLogin `User.can_create_new_alias`: premium, or under the free cap. */
export async function canCreateNewAlias(user: typeof users.$inferSelect): Promise<boolean> {
  if (await isPremium(user)) return true;
  const rows = await db.select({ id: aliases.id }).from(aliases).where(eq(aliases.userId, user.id));
  return rows.length < MAX_ALIAS_FREE_PLAN;
}

const LIMIT_REACHED_ERROR =
  "You have reached the limitation of a free account with the maximum of " +
  `${MAX_ALIAS_FREE_PLAN} aliases, please upgrade your plan to create more aliases`;

async function serializeCreated(alias: Alias) {
  const infos = await loadAliasInfos([alias]);
  const info = infos[0];
  if (!info) throw new Error("created alias vanished");
  return { alias: alias.email, ...aliasToDict(info) };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = "code" in err ? err.code : undefined;
  const message = err instanceof Error ? err.message : "";
  return code === "23505" || message.includes("duplicate key");
}

export async function withAliasNewRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/v5/alias/options",
    schema: {
      description:
        "Options for creating a new alias: available (signed) suffixes, whether the user " +
        "can create one, and a prefix suggestion derived from ?hostname=.",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      querystring: HostnameQuery,
      response: { 200: AliasOptionsResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const suffixes = ALIAS_DOMAINS.map((domain) => {
        const suffix = `.${randomString(5, true)}@${domain}`;
        return {
          suffix,
          signed_suffix: signSuffix(suffix, SUFFIX_SIGNING_SECRET),
          is_custom: false,
          is_premium: false,
        };
      });
      return {
        can_create: await canCreateNewAlias(req.user),
        prefix_suggestion: req.query.hostname
          ? prefixSuggestionFromHostname(req.query.hostname)
          : "",
        suffixes,
      };
    },
  });

  a.route({
    method: "POST",
    url: "/v3/alias/custom/new",
    config: { rateLimit: ALIAS_CREATION_RATE_LIMIT },
    schema: {
      description:
        "Create a new custom alias from a prefix and a signed suffix obtained from " +
        "GET /v5/alias/options. ?hostname= is accepted but not recorded yet.",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      querystring: HostnameQuery,
      body: NewCustomAliasBody,
      response: {
        201: CreatedAliasResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        409: ErrorResponse,
        412: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const user = req.user;
      if (!(await canCreateNewAlias(user))) {
        throw new HttpError(400, LIMIT_REACHED_ERROR);
      }

      const aliasPrefix = convertToId(req.body.alias_prefix.trim().toLowerCase().replace(/ /g, ""));
      const signedSuffix = req.body.signed_suffix.trim();
      const note = req.body.note ?? null;
      const name = req.body.name ? req.body.name.replace(/\n/g, "") : null;

      if (!checkAliasPrefix(aliasPrefix)) {
        throw new HttpError(400, "alias prefix invalid format or too long");
      }

      const mailboxIds = req.body.mailbox_ids;
      if (mailboxIds.length === 0) {
        throw new HttpError(400, "At least one mailbox must be selected");
      }
      const owned = await db.select().from(mailboxes).where(eq(mailboxes.userId, user.id));
      const ownedById = new Map(owned.map((m) => [m.id, m]));
      for (const id of mailboxIds) {
        const mb = ownedById.get(id);
        if (!mb || !mb.verified) throw new HttpError(400, "Errors with Mailbox");
      }

      const verdict = verifySignedSuffix(
        signedSuffix,
        SUFFIX_SIGNING_SECRET,
        SUFFIX_MAX_AGE_SECONDS,
      );
      if (!verdict.ok) {
        if (verdict.reason === "expired") {
          throw new HttpError(412, "Alias creation time is expired, please retry");
        }
        throw new HttpError(400, "Tampered suffix");
      }
      const aliasSuffix = verdict.suffix;

      // verify_prefix_suffix: `.something@one-of-our-domains`.
      const at = aliasSuffix.lastIndexOf("@");
      const suffixDomain = at === -1 ? "" : aliasSuffix.slice(at + 1);
      const suffixLocal = at === -1 ? aliasSuffix : aliasSuffix.slice(0, at);
      if (!ALIAS_DOMAINS.includes(suffixDomain) || !suffixLocal.startsWith(".")) {
        throw new HttpError(400, "wrong alias prefix or suffix");
      }

      const fullAlias = (aliasPrefix + aliasSuffix).toLowerCase();
      if (fullAlias.includes("..")) {
        throw new HttpError(400, "2 consecutive dot signs aren't allowed in an email address");
      }
      if (!/^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+$/.test(fullAlias)) {
        throw new HttpError(400, "Email alias is invalid");
      }
      if (!(await emailAvailable(fullAlias))) {
        throw new HttpError(409, `alias ${fullAlias} already exists`);
      }

      let created: Alias | undefined;
      try {
        const inserted = await db
          .insert(aliases)
          .values({
            userId: user.id,
            email: fullAlias,
            note,
            name,
            // Single-mailbox aliases: extra mailbox_ids entries are validated
            // but only the first is stored (documented deviation).
            mailboxId: mailboxIds[0]!,
          })
          .returning();
        created = inserted[0];
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, `alias ${fullAlias} already exists`);
        }
        throw err;
      }
      if (!created) throw new Error("alias insert returned no row");

      reply.status(201);
      return serializeCreated(created);
    },
  });

  a.route({
    method: "POST",
    url: "/alias/random/new",
    config: { rateLimit: ALIAS_CREATION_RATE_LIMIT },
    schema: {
      description:
        "Create a new random alias. ?mode=uuid|word overrides the user's alias generator " +
        "setting (default: word).",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      querystring: z.object({
        hostname: z.string().optional(),
        mode: z.string().optional(),
      }),
      body: NewRandomAliasBody.optional(),
      response: {
        201: CreatedAliasResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      const user = req.user;
      if (!(await canCreateNewAlias(user))) {
        throw new HttpError(400, LIMIT_REACHED_ERROR);
      }

      const mode = req.query.mode;
      if (mode !== undefined && mode !== "uuid" && mode !== "word") {
        throw new HttpError(400, `${mode} must be either word or uuid`);
      }
      // No per-user alias_generator column yet: default is word (matches the
      // GET /setting default we return).
      const scheme: "uuid" | "word" = mode ?? "word";
      const note = req.body?.note ?? null;
      const domain = ALIAS_DOMAINS[0]!;

      // Always set after registration; null only in a half-created account.
      const mailboxId = user.defaultMailboxId;
      if (mailboxId === null) throw new Error(`user ${user.id} has no default mailbox`);

      let created: Alias | undefined;
      for (let attempt = 0; attempt < 10 && !created; attempt++) {
        const local = scheme === "uuid" ? crypto.randomUUID() : randomWords(2, 3);
        const email = `${local}@${domain}`.toLowerCase();
        if (!(await emailAvailable(email))) continue;
        try {
          const inserted = await db
            .insert(aliases)
            .values({ userId: user.id, email, note, mailboxId })
            .returning();
          created = inserted[0];
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      if (!created) throw new Error("Cannot generate alias after many retries");

      reply.status(201);
      return serializeCreated(created);
    },
  });
}
