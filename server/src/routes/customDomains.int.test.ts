// Custom-domain routes int tests. Prerequisites: `just up` + `just db push`.
//
// Domains use random `.invalid` names (RFC 6761: guaranteed to never
// resolve), so the verify endpoint's REAL DNS lookups deterministically find
// nothing — every check must come back ok:false without throwing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { config } from "../config";
import { db } from "../db";
import { aliases, customDomains, deletedAliases, dkimKeys, users } from "../db/schema";
import { registerAndLogin, type TestUser } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

const uniqueDomain = () => `cd-${crypto.randomUUID().slice(0, 12)}.invalid`;

/** Register a fresh user and grant lifetime premium (custom domains gate). */
async function premiumUser(): Promise<TestUser> {
  const user = await registerAndLogin(app);
  await db.update(users).set({ lifetime: true }).where(eq(users.email, user.email));
  return user;
}

async function createDomain(apiKey: string, domain = uniqueDomain()) {
  const res = await app.inject({
    method: "POST",
    url: "/api/custom_domains",
    headers: auth(apiKey),
    payload: { domain },
  });
  if (res.statusCode !== 201) throw new Error(`create domain failed: ${res.body}`);
  return res.json<{ id: number; domain_name: string }>();
}

/** A user whose trial is over and who has no subscription: not premium. */
async function freeUser(): Promise<TestUser> {
  const user = await registerAndLogin(app);
  // Registration grants a 7-day trial (SimpleLogin behavior) — expire it.
  await db
    .update(users)
    .set({ trialEnd: new Date(Date.now() - 1_000) })
    .where(eq(users.email, user.email));
  return user;
}

describe("POST /api/custom_domains", () => {
  test("requires premium (expired trial, no subscription)", async () => {
    const { apiKey } = await freeUser();
    const res = await app.inject({
      method: "POST",
      url: "/api/custom_domains",
      headers: auth(apiKey),
      payload: { domain: uniqueDomain() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("Only premium plan can add custom domain");
  });

  test("creates the domain unverified, with an ownership token and a DKIM key", async () => {
    const { apiKey } = await premiumUser();
    const domain = uniqueDomain();
    const res = await app.inject({
      method: "POST",
      url: "/api/custom_domains",
      headers: auth(apiKey),
      payload: { domain: `${domain.toUpperCase()}.` }, // normalized
    });
    expect(res.statusCode).toBe(201);
    const dto = res.json<Record<string, unknown>>();
    expect(dto.domain_name).toBe(domain);
    expect(dto.is_verified).toBe(false);
    expect(dto.catch_all).toBe(false);
    expect(dto.random_prefix_generation).toBe(false);
    expect(dto.name).toBeNull();
    expect(dto.nb_alias).toBe(0);
    expect(dto.ownership_verified).toBe(false);
    expect(dto.mx_verified).toBe(false);
    expect(dto.spf_verified).toBe(false);
    expect(dto.dkim_verified).toBe(false);
    expect(dto.dmarc_verified).toBe(false);
    // mailboxes: the default mailbox (SL fallback shape).
    expect(dto.mailboxes).toHaveLength(1);

    const row = (
      await db.select().from(customDomains).where(eq(customDomains.domain, domain)).limit(1)
    )[0]!;
    expect(row.ownershipTxtToken).toMatch(/^[0-9a-f]{30}$/);
    const key = (
      await db
        .select()
        .from(dkimKeys)
        .where(and(eq(dkimKeys.domain, domain), eq(dkimKeys.selector, "dkim")))
        .limit(1)
    )[0];
    expect(key).toBeDefined();
    expect(key!.publicKeyBase64.length).toBeGreaterThan(300); // RSA-2048 SPKI

    // And it shows up in the list.
    const list = await app.inject({
      method: "GET",
      url: "/api/custom_domains",
      headers: auth(apiKey),
    });
    expect(list.statusCode).toBe(200);
    const domains = list.json<{ custom_domains: { domain_name: string }[] }>().custom_domains;
    expect(domains.some((d) => d.domain_name === domain)).toBe(true);
  });

  test("rejects duplicates, invalid shapes and our own domains", async () => {
    const { apiKey } = await premiumUser();
    const created = await createDomain(apiKey);

    const dup = await app.inject({
      method: "POST",
      url: "/api/custom_domains",
      headers: auth(apiKey),
      payload: { domain: created.domain_name },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json<{ error: string }>().error).toBe(`${created.domain_name} already used`);

    for (const bad of ["not a domain", "nodots", "-bad.com", `sub.${config.mailDomain}`]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/custom_domains",
        headers: auth(apiKey),
        payload: { domain: bad },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("GET /api/custom_domains/:id/dns", () => {
  test("returns the records to publish, including the per-domain DKIM TXT", async () => {
    const { apiKey } = await premiumUser();
    const created = await createDomain(apiKey);

    const res = await app.inject({
      method: "GET",
      url: `/api/custom_domains/${created.id}/dns`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      domain_name: string;
      records: {
        ownership: { hostname: string; value: string };
        mx: { type: string; hostname: string; priority: number; value: string }[];
        spf: { value: string };
        dkim: { hostname: string; value: string } | null;
        dmarc: { hostname: string; value: string };
      };
    }>();
    expect(body.domain_name).toBe(created.domain_name);
    expect(body.records.ownership.hostname).toBe(created.domain_name);
    expect(body.records.ownership.value).toMatch(/^vt-verification=[0-9a-f]{30}$/);
    expect(body.records.mx).toEqual([
      {
        type: "MX",
        hostname: created.domain_name,
        priority: 10,
        value: `mail.${config.mailDomain}.`,
      },
    ]);
    expect(body.records.spf.value).toBe(`v=spf1 include:${config.mailDomain} ~all`);
    expect(body.records.dkim).not.toBeNull();
    expect(body.records.dkim!.hostname).toBe(`dkim._domainkey.${created.domain_name}`);
    const key = (
      await db.select().from(dkimKeys).where(eq(dkimKeys.domain, created.domain_name)).limit(1)
    )[0]!;
    expect(body.records.dkim!.value).toBe(`v=DKIM1; k=rsa; p=${key.publicKeyBase64}`);
    expect(body.records.dmarc.hostname).toBe(`_dmarc.${created.domain_name}`);
    expect(body.records.dmarc.value).toBe("v=DMARC1; p=quarantine; pct=100; adkim=s; aspf=s");
  });

  test("403 for another user's domain", async () => {
    const owner = await premiumUser();
    const created = await createDomain(owner.apiKey);
    const stranger = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/custom_domains/${created.id}/dns`,
      headers: auth(stranger.apiKey),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/custom_domains/:id/verify", () => {
  test("real DNS checks on an unresolvable domain all fail cleanly", async () => {
    const { apiKey } = await premiumUser();
    const created = await createDomain(apiKey);

    const res = await app.inject({
      method: "POST",
      url: `/api/custom_domains/${created.id}/verify`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      ownership: { ok: boolean };
      mx: { ok: boolean };
      spf: { ok: boolean };
      dkim: { ok: boolean };
      dmarc: { ok: boolean };
      custom_domain: Record<string, unknown>;
    }>();
    expect(body.ownership.ok).toBe(false);
    expect(body.mx.ok).toBe(false);
    expect(body.spf.ok).toBe(false);
    expect(body.dkim.ok).toBe(false);
    expect(body.dmarc.ok).toBe(false);
    expect(body.custom_domain.is_verified).toBe(false);
    expect(body.custom_domain.ownership_verified).toBe(false);
    expect(body.custom_domain.dkim_verified).toBe(false);
  }, 60_000);
});

describe("PATCH /api/custom_domains/:id", () => {
  test("updates catch_all and name; returns the SimpleLogin envelope", async () => {
    const { apiKey } = await premiumUser();
    const created = await createDomain(apiKey);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/custom_domains/${created.id}`,
      headers: auth(apiKey),
      payload: { catch_all: true, name: "Wes" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ custom_domain: { catch_all: boolean; name: string | null } }>();
    expect(body.custom_domain.catch_all).toBe(true);
    expect(body.custom_domain.name).toBe("Wes");

    // Clearing the name with null.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/custom_domains/${created.id}`,
      headers: auth(apiKey),
      payload: { name: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      cleared.json<{ custom_domain: { name: string | null } }>().custom_domain.name,
    ).toBeNull();
  });

  test("unmodeled fields are refused, not silently dropped", async () => {
    const { apiKey } = await premiumUser();
    const created = await createDomain(apiKey);
    for (const payload of [{ random_prefix_generation: true }, { mailbox_ids: [1] }]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/custom_domains/${created.id}`,
        headers: auth(apiKey),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  test("403 for another user's domain", async () => {
    const owner = await premiumUser();
    const created = await createDomain(owner.apiKey);
    const stranger = await registerAndLogin(app);
    const res = await app.inject({
      method: "PATCH",
      url: `/api/custom_domains/${created.id}`,
      headers: auth(stranger.apiKey),
      payload: { catch_all: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("DELETE /api/custom_domains/:id", () => {
  test("deletes the domain, tombstones its aliases, removes its DKIM keys", async () => {
    const user = await premiumUser();
    const created = await createDomain(user.apiKey);

    // Plant an alias on the domain directly (alias creation via API only
    // covers the service alias domains).
    const dbUser = (await db.select().from(users).where(eq(users.email, user.email)).limit(1))[0]!;
    const aliasEmail = `hello@${created.domain_name}`;
    await db.insert(aliases).values({
      userId: dbUser.id,
      email: aliasEmail,
      mailboxId: dbUser.defaultMailboxId!,
      customDomainId: created.id,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/custom_domains/${created.id}`,
      headers: auth(user.apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ deleted: boolean }>().deleted).toBe(true);

    const remaining = await db.select().from(customDomains).where(eq(customDomains.id, created.id));
    expect(remaining).toHaveLength(0);
    expect(await db.select().from(aliases).where(eq(aliases.email, aliasEmail))).toHaveLength(0);
    const tombstones = await db
      .select()
      .from(deletedAliases)
      .where(eq(deletedAliases.email, aliasEmail));
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]!.reason).toBe("custom_domain_deleted");
    expect(
      await db.select().from(dkimKeys).where(eq(dkimKeys.domain, created.domain_name)),
    ).toHaveLength(0);
  });

  test("403 for another user's domain", async () => {
    const owner = await premiumUser();
    const created = await createDomain(owner.apiKey);
    const stranger = await registerAndLogin(app);
    const res = await app.inject({
      method: "DELETE",
      url: `/api/custom_domains/${created.id}`,
      headers: auth(stranger.apiKey),
    });
    expect(res.statusCode).toBe(403);
  });
});
