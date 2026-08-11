// Alias creation — SimpleLogin-compatible:
//   GET  /v5/alias/options     suffixes (signed), can_create, prefix suggestion
//   POST /v3/alias/custom/new  alias_prefix + signed_suffix + mailbox_ids
//   POST /alias/random/new     ?mode=uuid|word
//
// Sources: app/api/views/{alias_options,new_custom_alias,new_random_alias}.py.
// Error strings and status codes verbatim.
//
// `?hostname=` on the creation endpoints is recorded in alias_used_on
// (find-or-create on the unique pair) and drives the options
// `recommendation` object, exactly like SimpleLogin's AliasUsedOn.
//
// Suffix policy: shared ALIAS_DOMAINS always get a random suffix (the
// namespace is shared across users, so squatting/guessing must stay
// impossible). The user's own verified custom domains additionally offer the
// EMPTY suffix (`@domain`, is_custom) — full local-part control, SimpleLogin
// style — plus a random-suffix variant for unguessability.
//
// Deviations (documented in the lane report):
// - Multi-window rate limits (SimpleLogin ALIAS_LIMIT "100/day;50/hour;
//   5/minute") collapse to the tightest window, 5/minute.

import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { isPremium } from "../billing/premium";
import { MAX_ALIAS_FREE_PLAN } from "../config";
import { db } from "../db";
import {
  type Alias,
  aliases,
  aliasUsedOn,
  customDomains,
  mailboxes,
  type User,
  users,
} from "../db/schema";
import {
  ALIAS_DOMAINS,
  FIRST_ALIAS_DOMAIN,
  SUFFIX_MAX_AGE_SECONDS,
  SUFFIX_SIGNING_SECRET,
} from "./aliasConfig";
import { insertExtraAliasMailboxes } from "./aliasMailboxes";
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
      .meta({
        description:
          "Present when ?hostname= is given and the user already created an alias " +
          "for that hostname (latest one wins).",
      }),
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

/** Find-or-create the (alias, hostname) pair (SimpleLogin AliasUsedOn). */
async function recordAliasUsedOn(aliasId: number, userId: number, hostname: string | undefined) {
  if (!hostname) return;
  await db.insert(aliasUsedOn).values({ aliasId, userId, hostname }).onConflictDoNothing();
}

/**
 * The random suffix for custom-alias creation, honoring the user's
 * random_alias_suffix setting (SimpleLogin `User.get_random_alias_suffix`):
 * `word` -> one dictionary word + 3 digits, `random_string` -> 5 random
 * alphanumerics.
 */
function randomAliasSuffixFor(user: User): string {
  return user.randomAliasSuffix === "word" ? randomWords(1, 3) : randomString(5, true);
}

/**
 * The domain for a random alias, honoring default_alias_domain when it is
 * still usable: one of ALIAS_DOMAINS, or one of the user's verified custom
 * domains. Falls back to FIRST_ALIAS_DOMAIN.
 */
export async function randomAliasDomainFor(
  user: User,
): Promise<{ domain: string; customDomainId: number | null }> {
  const preferred = user.defaultAliasDomain;
  if (preferred && preferred !== FIRST_ALIAS_DOMAIN) {
    if (ALIAS_DOMAINS.includes(preferred)) return { domain: preferred, customDomainId: null };
    const rows = await db
      .select()
      .from(customDomains)
      .where(eq(customDomains.domain, preferred))
      .limit(1);
    const cd = rows[0];
    if (cd && cd.userId === user.id && cd.verified) {
      return { domain: preferred, customDomainId: cd.id };
    }
  }
  return { domain: FIRST_ALIAS_DOMAIN, customDomainId: null };
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
      const user = req.user;
      const hostname = req.query.hostname;

      const signed = (suffix: string, isCustom: boolean) => ({
        suffix,
        signed_suffix: signSuffix(suffix, SUFFIX_SIGNING_SECRET),
        is_custom: isCustom,
        is_premium: false,
      });

      // Custom domains come first, then shared domains; the user's default
      // domain sorts first within each group (SimpleLogin get_alias_suffixes).
      // Each verified custom domain offers the empty suffix (full local-part
      // control) and a random variant; shared domains are always random.
      const defaultDomainFirst = (a: string, b: string) =>
        a === user.defaultAliasDomain ? -1 : b === user.defaultAliasDomain ? 1 : 0;
      const userCustomDomains = (
        await db
          .select()
          .from(customDomains)
          .where(and(eq(customDomains.userId, user.id), eq(customDomains.verified, true)))
          .orderBy(customDomains.id)
      ).sort((a, b) => defaultDomainFirst(a.domain, b.domain));
      const domains = [...ALIAS_DOMAINS].sort(defaultDomainFirst);
      const suffixes = [
        ...userCustomDomains.flatMap((cd) => [
          signed(`@${cd.domain}`, true),
          signed(`.${randomAliasSuffixFor(user)}@${cd.domain}`, true),
        ]),
        ...domains.map((domain) => signed(`.${randomAliasSuffixFor(user)}@${domain}`, false)),
      ];

      // The latest alias already created for this hostname (AliasUsedOn).
      let recommendation: { alias: string; hostname: string } | undefined;
      if (hostname) {
        const rows = await db
          .select({ email: aliases.email })
          .from(aliasUsedOn)
          .innerJoin(aliases, eq(aliasUsedOn.aliasId, aliases.id))
          .where(and(eq(aliases.userId, user.id), eq(aliasUsedOn.hostname, hostname)))
          .orderBy(desc(aliasUsedOn.createdAt), desc(aliasUsedOn.id))
          .limit(1);
        const hit = rows[0];
        if (hit) recommendation = { alias: hit.email, hostname };
      }

      return {
        can_create: await canCreateNewAlias(user),
        prefix_suggestion: hostname ? prefixSuggestionFromHostname(hostname) : "",
        suffixes,
        ...(recommendation ? { recommendation } : {}),
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
        "GET /v5/alias/options. The first mailbox_ids entry becomes the primary " +
        "mailbox; the rest become extra delivery mailboxes. ?hostname= is recorded " +
        "and drives the options `recommendation`.",
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

      // Request order is preserved: the first id becomes the primary mailbox
      // (SimpleLogin new_custom_alias_v3), duplicates collapse.
      const mailboxIds = [...new Set(req.body.mailbox_ids)];
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

      // verify_prefix_suffix: `.something@one-of-our-domains`, or on the
      // user's OWN verified custom domain also the empty suffix `@domain`.
      // The suffix signature is not user-bound, so ownership is checked here.
      const at = aliasSuffix.lastIndexOf("@");
      const suffixDomain = at === -1 ? "" : aliasSuffix.slice(at + 1);
      const suffixLocal = at === -1 ? aliasSuffix : aliasSuffix.slice(0, at);
      let customDomainId: number | null = null;
      if (ALIAS_DOMAINS.includes(suffixDomain)) {
        if (!suffixLocal.startsWith(".")) {
          throw new HttpError(400, "wrong alias prefix or suffix");
        }
      } else {
        const cd = (
          await db
            .select()
            .from(customDomains)
            .where(eq(customDomains.domain, suffixDomain))
            .limit(1)
        )[0];
        const ownedVerified = cd !== undefined && cd.userId === user.id && cd.verified;
        if (!ownedVerified || (suffixLocal !== "" && !suffixLocal.startsWith("."))) {
          throw new HttpError(400, "wrong alias prefix or suffix");
        }
        customDomainId = cd.id;
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
        created = await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(aliases)
            .values({
              userId: user.id,
              email: fullAlias,
              note,
              name,
              customDomainId,
              // First mailbox is the primary; the rest go to alias_mailboxes.
              mailboxId: mailboxIds[0]!,
            })
            .returning();
          const alias = inserted[0];
          if (!alias) throw new Error("alias insert returned no row");
          await insertExtraAliasMailboxes(tx, alias.id, mailboxIds.slice(1));
          return alias;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HttpError(409, `alias ${fullAlias} already exists`);
        }
        throw err;
      }
      if (!created) throw new Error("alias insert returned no row");

      await recordAliasUsedOn(created.id, user.id, req.query.hostname);

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
        "Create a new random alias on the user's default alias domain. ?mode=uuid|word " +
        "overrides the user's alias_generator setting. ?hostname= is recorded and " +
        "drives the options `recommendation`.",
      tags: ["Alias"],
      security: [{ apiKeyAuth: [] }],
      querystring: z.object({
        hostname: z.string().optional(),
        mode: z.string().optional(),
      }),
      body: NewRandomAliasBody.nullish(),
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
      // ?mode= overrides the user's alias_generator setting (SimpleLogin).
      const scheme: "uuid" | "word" = mode ?? (user.aliasGenerator === "uuid" ? "uuid" : "word");
      const note = req.body?.note ?? null;
      const { domain, customDomainId } = await randomAliasDomainFor(user);

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
            .values({ userId: user.id, email, note, mailboxId, customDomainId })
            .returning();
          created = inserted[0];
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
        }
      }
      if (!created) throw new Error("Cannot generate alias after many retries");

      await recordAliasUsedOn(created.id, user.id, req.query.hostname);

      reply.status(201);
      return serializeCreated(created);
    },
  });
}
