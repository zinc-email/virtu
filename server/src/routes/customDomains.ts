// Custom domains — SimpleLogin-shaped (docs/api.md + app/api/views/
// custom_domain.py custom_domain_to_dict). SimpleLogin's API only exposes
// GET /custom_domains + PATCH; creation, DNS records and the verification
// checks are web-dashboard-only there (app/dashboard/views/domain_detail.py)
// — we expose them as JSON with the same semantics. Deviations, all flagged
// inline:
//
//   - POST /custom_domains, GET .../dns, POST .../verify, DELETE have no
//     SimpleLogin API equivalent (web-only flows there).
//   - dict extensions: ownership/mx/spf/dkim/dmarc _verified flags (SL shows
//     these only in the dashboard); `random_prefix_generation` is always
//     false (not modeled yet); `mailboxes` is always the default mailbox
//     (per-domain mailboxes not modeled yet).
//   - The ownership TXT uses the `vt-verification=` prefix (SL: `sl-`).
//   - DKIM is a per-domain TXT with our generated key's p= value; SL uses a
//     CNAME to its own record because it signs with its service key.

import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { isPremium } from "../billing/premium";
import { config } from "../config";
import { db } from "../db";
import { isUniqueViolation } from "../db/pgError";
import {
  aliases,
  deletedAliases,
  dkimKeys,
  type Domain,
  domains,
  mailboxes,
  type User,
} from "../db/schema";
import {
  clearDkimKeyCache,
  CUSTOM_DOMAIN_DKIM_SELECTOR,
  ensureDkimKeyRow,
  loadDkimKeyRow,
} from "../pipeline/dkim";
import { canReceive, canSend } from "../pipeline/domainCapability";
import { expectedDnsRecords, newOwnershipToken, verifyCustomDomain } from "../pipeline/dnsCheck";
import { ALIAS_DOMAINS } from "./aliasConfig";
import { formatCreationDate, timestampOf } from "./aliasText";
import { HttpError } from "./httpError";
import { DeletedResponse, ErrorResponse, MailboxLite } from "./schema";

const DomainIdParams = z.object({ custom_domain_id: z.coerce.number().int() });

/** RFC 1035-ish shape check; length-capped, lowercase, at least one dot. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const CustomDomainDto = z
  .object({
    id: z.number().int(),
    domain_name: z.string(),
    name: z.string().nullable(),
    is_verified: z.boolean(),
    nb_alias: z.number().int(),
    creation_date: z.string(),
    creation_timestamp: z.number().int(),
    catch_all: z.boolean(),
    // Deviation: constant false — random prefix generation is not modeled.
    random_prefix_generation: z.boolean(),
    // Deviation: always the user's default mailbox (no per-domain mailboxes).
    mailboxes: z.array(MailboxLite),
    // Deviation (extension): SL surfaces these only in its dashboard.
    ownership_verified: z.boolean(),
    mx_verified: z.boolean(),
    spf_verified: z.boolean(),
    dkim_verified: z.boolean(),
    dmarc_verified: z.boolean(),
    // Computed capabilities (Virtu extension): can_receive = owner+mx,
    // can_send = owner+dkim+spf. Derived from the flags above by the same
    // pipeline/domainCapability predicates the mail path uses.
    can_receive: z.boolean(),
    can_send: z.boolean(),
  })
  .meta({ id: "CustomDomain" });

const CustomDomainsResponse = z
  .object({ custom_domains: z.array(CustomDomainDto) })
  .meta({ id: "CustomDomainsResponse" });

const CreateCustomDomainBody = z
  .object({ domain: z.string() })
  .meta({ id: "CreateCustomDomainRequest", example: { domain: "example.com" } });

const UpdateCustomDomainBody = z
  .object({
    catch_all: z.boolean().optional(),
    name: z.string().max(128).nullable().optional(),
    random_prefix_generation: z.boolean().optional(),
    mailbox_ids: z.array(z.number().int()).optional(),
  })
  .meta({ id: "UpdateCustomDomainRequest" });

const UpdatedCustomDomainResponse = z
  .object({ custom_domain: CustomDomainDto })
  .meta({ id: "UpdatedCustomDomainResponse" });

const DnsRecordDto = z
  .object({
    type: z.enum(["TXT", "MX"]),
    hostname: z.string(),
    value: z.string(),
    priority: z.number().int().optional(),
  })
  .meta({ id: "DnsRecord" });

const CustomDomainDnsResponse = z
  .object({
    domain_name: z.string(),
    records: z.object({
      ownership: DnsRecordDto,
      mx: z.array(DnsRecordDto),
      spf: DnsRecordDto,
      // Null until the domain has a signing key row.
      dkim: DnsRecordDto.nullable(),
      dmarc: DnsRecordDto,
    }),
  })
  .meta({ id: "CustomDomainDnsResponse" });

const DnsCheckResultDto = z
  .object({ ok: z.boolean(), errors: z.array(z.string()) })
  .meta({ id: "DnsCheckResult" });

const VerifyCustomDomainResponse = z
  .object({
    ownership: DnsCheckResultDto,
    mx: DnsCheckResultDto,
    spf: DnsCheckResultDto,
    dkim: DnsCheckResultDto,
    dmarc: DnsCheckResultDto,
    custom_domain: CustomDomainDto,
  })
  .meta({ id: "VerifyCustomDomainResponse" });

export async function withCustomDomainRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  async function domainToDict(cd: Domain, user: User) {
    const [aliasCount] = await db
      .select({ n: count() })
      .from(aliases)
      .where(eq(aliases.domainId, cd.id));
    // SL CustomDomain.mailboxes falls back to the default mailbox when no
    // per-domain mailboxes are set; we don't model per-domain mailboxes.
    const mbs =
      user.defaultMailboxId === null
        ? []
        : await db
            .select({ id: mailboxes.id, email: mailboxes.email })
            .from(mailboxes)
            .where(eq(mailboxes.id, user.defaultMailboxId));
    return {
      id: cd.id,
      // SL wire keeps `domain_name`; it's the claimed FQDN (shown even while
      // unowned/provisional, so name_requested — not the NULL-until-owned name).
      domain_name: cd.nameRequested,
      name: cd.fromName,
      // "Verified/usable" now means can-receive (owner + MX).
      is_verified: canReceive(cd),
      nb_alias: aliasCount?.n ?? 0,
      creation_date: formatCreationDate(cd.createdAt),
      creation_timestamp: timestampOf(cd.createdAt),
      catch_all: cd.catchAll,
      random_prefix_generation: false,
      mailboxes: mbs,
      ownership_verified: cd.verifiedOwner,
      mx_verified: cd.verifiedMx,
      spf_verified: cd.verifiedSpf,
      dkim_verified: cd.verifiedDkim,
      dmarc_verified: cd.verifiedDmarc,
      can_receive: canReceive(cd),
      can_send: canSend(cd),
    };
  }

  /** Load a domain row and enforce ownership (403 like the mailbox routes). */
  async function ownedDomain(userId: number, domainId: number): Promise<Domain> {
    const rows = await db.select().from(domains).where(eq(domains.id, domainId)).limit(1);
    const cd = rows[0];
    if (!cd || cd.userId !== userId) throw new HttpError(403, "Forbidden");
    return cd;
  }

  a.route({
    method: "GET",
    url: "/custom_domains",
    schema: {
      description: "Get the user's custom domains, with per-record verification flags.",
      tags: ["CustomDomain"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: CustomDomainsResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const rows = await db
        .select()
        .from(domains)
        .where(eq(domains.userId, req.user.id))
        .orderBy(domains.id);
      const out = [];
      for (const cd of rows) out.push(await domainToDict(cd, req.user));
      return { custom_domains: out };
    },
  });

  a.route({
    method: "POST",
    url: "/custom_domains",
    config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    schema: {
      description:
        "Add a custom domain (premium only). Generates the ownership TXT token and a " +
        "per-domain DKIM signing key; publish the records from GET .../dns, then POST " +
        ".../verify. No SimpleLogin API equivalent (web-only there).",
      tags: ["CustomDomain"],
      security: [{ apiKeyAuth: [] }],
      body: CreateCustomDomainBody,
      response: {
        201: CustomDomainDto,
        400: ErrorResponse,
        401: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req, reply) => {
      if (!(await isPremium(req.user))) {
        throw new HttpError(400, "Only premium plan can add custom domain");
      }
      const domain = req.body.domain.trim().toLowerCase().replace(/\.$/, "");
      if (domain.length > 253 || !DOMAIN_RE.test(domain)) {
        throw new HttpError(400, "Invalid domain");
      }
      // Our own service/alias domains (and their subdomains) can never be
      // customer domains.
      const reserved = [config.mailDomain, ...ALIAS_DOMAINS];
      if (reserved.some((d) => domain === d || domain.endsWith(`.${d}`))) {
        throw new HttpError(400, "Invalid domain");
      }

      // A provisional claim: NOT globally unique (many users may claim the same
      // name), only unique per user. The winner-take-all lock lives on `name`
      // and fires at verify time, not here — so squatting a name doesn't block
      // the real owner, who wins by proving ownership.
      let cd: Domain | undefined;
      try {
        const inserted = await db
          .insert(domains)
          .values({
            userId: req.user.id,
            nameRequested: domain,
            ownershipTxtToken: newOwnershipToken(),
          })
          .returning();
        cd = inserted[0];
      } catch (err) {
        if (isUniqueViolation(err)) throw new HttpError(400, `${domain} already added`);
        throw err;
      }
      if (!cd) throw new Error("domain insert returned no row");

      // The domain signs its own mail: mint its key pair now so the DKIM
      // TXT value is available immediately.
      await ensureDkimKeyRow(db, domain, CUSTOM_DOMAIN_DKIM_SELECTOR);

      reply.status(201);
      return domainToDict(cd, req.user);
    },
  });

  a.route({
    method: "GET",
    url: "/custom_domains/:custom_domain_id/dns",
    schema: {
      description:
        "The DNS records to publish for this domain: ownership TXT (vt-verification=…), " +
        "MX, SPF include, the per-domain DKIM TXT and the recommended DMARC record. " +
        "No SimpleLogin API equivalent (web-only there).",
      tags: ["CustomDomain"],
      security: [{ apiKeyAuth: [] }],
      params: DomainIdParams,
      response: {
        200: CustomDomainDnsResponse,
        401: ErrorResponse,
        403: ErrorResponse,
      },
    },
    handler: async (req) => {
      const cd = await ownedDomain(req.user.id, req.params.custom_domain_id);

      // Generate the ownership token on first sight (SL domain_detail_dns).
      let token = cd.ownershipTxtToken;
      if (token === null || token === "") {
        token = newOwnershipToken();
        await db.update(domains).set({ ownershipTxtToken: token }).where(eq(domains.id, cd.id));
      }

      const keyRow = await loadDkimKeyRow(db, cd.nameRequested, CUSTOM_DOMAIN_DKIM_SELECTOR);
      const records = expectedDnsRecords(
        cd.nameRequested,
        token,
        keyRow === null
          ? null
          : { selector: keyRow.selector, publicKeyBase64: keyRow.publicKeyBase64 },
        { mailDomain: config.mailDomain },
      );
      return { domain_name: cd.nameRequested, records };
    },
  });

  a.route({
    method: "POST",
    url: "/custom_domains/:custom_domain_id/verify",
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      description:
        "Run the real DNS checks (ownership, MX, SPF, DKIM, DMARC) and update the " +
        "domain's verification flags. `errors` lists what was found when a check " +
        "fails. No SimpleLogin API equivalent (web-only forms there).",
      tags: ["CustomDomain"],
      security: [{ apiKeyAuth: [] }],
      params: DomainIdParams,
      response: {
        200: VerifyCustomDomainResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const cd = await ownedDomain(req.user.id, req.params.custom_domain_id);
      const result = await verifyCustomDomain(db, cd, { mailDomain: config.mailDomain });
      return {
        ownership: result.ownership,
        mx: result.mx,
        spf: result.spf,
        dkim: result.dkim,
        dmarc: result.dmarc,
        custom_domain: await domainToDict(result.domain, req.user),
      };
    },
  });

  a.route({
    method: "PATCH",
    url: "/custom_domains/:custom_domain_id",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Update a custom domain. `catch_all` and `name` are supported; " +
        "`random_prefix_generation` and `mailbox_ids` return 400 (not modeled yet).",
      tags: ["CustomDomain"],
      security: [{ apiKeyAuth: [] }],
      params: DomainIdParams,
      body: UpdateCustomDomainBody,
      response: {
        200: UpdatedCustomDomainResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const cd = await ownedDomain(req.user.id, req.params.custom_domain_id);
      if (req.body.random_prefix_generation !== undefined) {
        throw new HttpError(400, "random_prefix_generation is not supported yet");
      }
      if (req.body.mailbox_ids !== undefined) {
        throw new HttpError(400, "mailbox_ids is not supported yet");
      }

      const patch: Partial<typeof domains.$inferInsert> = {};
      if (req.body.catch_all !== undefined) patch.catchAll = req.body.catch_all;
      if (req.body.name !== undefined) patch.fromName = req.body.name;
      const updated =
        Object.keys(patch).length === 0
          ? cd
          : (await db.update(domains).set(patch).where(eq(domains.id, cd.id)).returning())[0]!;

      return { custom_domain: await domainToDict(updated, req.user) };
    },
  });

  a.route({
    method: "DELETE",
    url: "/custom_domains/:custom_domain_id",
    config: { rateLimit: { max: 100, timeWindow: "1 hour" } },
    schema: {
      description:
        "Delete a custom domain. Its aliases are deleted and tombstoned (never " +
        "reusable) and its DKIM keys are removed. Deletion is immediate — a " +
        "deviation from SimpleLogin, whose web-only flow schedules a background job.",
      tags: ["CustomDomain"],
      security: [{ apiKeyAuth: [] }],
      params: DomainIdParams,
      response: {
        200: DeletedResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        429: ErrorResponse,
      },
    },
    handler: async (req) => {
      const cd = await ownedDomain(req.user.id, req.params.custom_domain_id);

      await db.transaction(async (tx) => {
        const doomed = await tx
          .select({ id: aliases.id, email: aliases.email })
          .from(aliases)
          .where(eq(aliases.domainId, cd.id));
        if (doomed.length > 0) {
          await tx
            .insert(deletedAliases)
            .values(
              doomed.map((d) => ({
                email: d.email,
                reason: "custom_domain_deleted",
                aliasId: d.id,
              })),
            )
            .onConflictDoNothing();
        }
        // The aliases.domainId FK cascades, but delete explicitly so
        // the tombstone/delete pair stays atomic and visible.
        await tx.delete(aliases).where(eq(aliases.domainId, cd.id));
        await tx
          .delete(dkimKeys)
          .where(
            and(
              eq(dkimKeys.domain, cd.nameRequested),
              eq(dkimKeys.selector, CUSTOM_DOMAIN_DKIM_SELECTOR),
            ),
          );
        await tx.delete(domains).where(eq(domains.id, cd.id));
      });
      // This process's key cache only (the mail processes' TTL covers them).
      clearDkimKeyCache();

      return { deleted: true };
    },
  });
}
