// Account/misc routes int tests (stats, setting, domains, sudo -> api_key,
// logout). Prerequisites: `just up` (migrates on boot).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { hashApiKey } from "../auth/apiKey";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { apiKeys, domains, emailLogs, users } from "../db/schema";
import { createAlias, latestEmailedCode, registerAndLogin } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

describe("GET /api/stats", () => {
  test("counts aliases and log kinds (bounces excluded)", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const zero = await app.inject({ method: "GET", url: "/api/stats", headers: auth(apiKey) });
    expect(zero.statusCode).toBe(200);
    expect(zero.json<Record<string, number>>()).toEqual({
      nb_alias: 0,
      nb_forward: 0,
      nb_reply: 0,
      nb_block: 0,
    });

    const alias = await createAlias(app, apiKey);
    const contactRes = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "stats@example.com" },
    });
    const contactId = contactRes.json<{ id: number }>().id;
    const userRow = (await db.select().from(users).where(eq(users.email, email)))[0]!;
    const base = { userId: userRow.id, contactId, aliasId: alias.id };
    await db.insert(emailLogs).values([
      { ...base, isReply: false },
      { ...base, isReply: false },
      { ...base, isReply: true },
      { ...base, isReply: false, blocked: true },
      { ...base, isReply: false, bounced: true }, // excluded from stats
    ]);

    const res = await app.inject({ method: "GET", url: "/api/stats", headers: auth(apiKey) });
    expect(res.json<Record<string, number>>()).toEqual({
      nb_alias: 1,
      nb_forward: 2,
      nb_reply: 1,
      nb_block: 1,
    });
  });
});

describe("GET+PATCH /api/setting", () => {
  test("returns SimpleLogin-shaped defaults and persists notification", async () => {
    const { apiKey } = await registerAndLogin(app);
    const get = await app.inject({ method: "GET", url: "/api/setting", headers: auth(apiKey) });
    expect(get.statusCode).toBe(200);
    expect(get.json<Record<string, unknown>>()).toEqual({
      alias_generator: "word",
      notification: true,
      random_alias_default_domain: "virtu.email",
      sender_format: "AT",
      random_alias_suffix: "random_string",
    });

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/setting",
      headers: auth(apiKey),
      payload: { notification: false, alias_generator: "uuid" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ notification: boolean }>().notification).toBe(false);

    const after = await app.inject({ method: "GET", url: "/api/setting", headers: auth(apiKey) });
    expect(after.json<{ notification: boolean }>().notification).toBe(false);
  });

  test("persists every setting column and round-trips through GET", async () => {
    const { apiKey } = await registerAndLogin(app);
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/setting",
      headers: auth(apiKey),
      payload: {
        alias_generator: "uuid",
        sender_format: "NAME_ONLY",
        random_alias_suffix: "word",
        notification: false,
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<Record<string, unknown>>()).toEqual({
      alias_generator: "uuid",
      notification: false,
      random_alias_default_domain: "virtu.email",
      sender_format: "NAME_ONLY",
      random_alias_suffix: "word",
    });

    const get = await app.inject({ method: "GET", url: "/api/setting", headers: auth(apiKey) });
    expect(get.json<Record<string, unknown>>()).toEqual({
      alias_generator: "uuid",
      notification: false,
      random_alias_default_domain: "virtu.email",
      sender_format: "NAME_ONLY",
      random_alias_suffix: "word",
    });
  });

  test("random_alias_default_domain accepts only usable domains", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userRow = (await db.select().from(users).where(eq(users.email, email)))[0]!;

    // Built-in alias domain: fine.
    const builtin = await app.inject({
      method: "PATCH",
      url: "/api/setting",
      headers: auth(apiKey),
      payload: { random_alias_default_domain: "virtu.email" },
    });
    expect(builtin.statusCode).toBe(200);

    // Unverified custom domain: rejected.
    const unverified = `u${crypto.randomUUID().slice(0, 8)}.example.com`;
    await db.insert(domains).values({ userId: userRow.id, nameRequested: unverified });
    const rejected = await app.inject({
      method: "PATCH",
      url: "/api/setting",
      headers: auth(apiKey),
      payload: { random_alias_default_domain: unverified },
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>()).toEqual({ error: "invalid domain" });

    // Someone else's verified custom domain: rejected.
    const other = await registerAndLogin(app);
    const otherRow = (await db.select().from(users).where(eq(users.email, other.email)))[0]!;
    const foreign = `f${crypto.randomUUID().slice(0, 8)}.example.com`;
    await db.insert(domains).values({
      userId: otherRow.id,
      nameRequested: foreign,
      verifiedOwner: true,
      verifiedMx: true,
    });
    const stolen = await app.inject({
      method: "PATCH",
      url: "/api/setting",
      headers: auth(apiKey),
      payload: { random_alias_default_domain: foreign },
    });
    expect(stolen.statusCode).toBe(400);
    expect(stolen.json<{ error: string }>()).toEqual({ error: "invalid domain" });

    // The user's own verified custom domain: accepted and round-trips.
    const mine = `m${crypto.randomUUID().slice(0, 8)}.example.com`;
    await db
      .insert(domains)
      .values({ userId: userRow.id, nameRequested: mine, verifiedOwner: true, verifiedMx: true });
    const accepted = await app.inject({
      method: "PATCH",
      url: "/api/setting",
      headers: auth(apiKey),
      payload: { random_alias_default_domain: mine },
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      accepted.json<{ random_alias_default_domain: string }>().random_alias_default_domain,
    ).toBe(mine);
  });

  test("validates enum fields with SimpleLogin's error strings", async () => {
    const { apiKey } = await registerAndLogin(app);
    const cases: [Record<string, unknown>, string][] = [
      [{ alias_generator: "banana" }, "Invalid alias_generator"],
      [{ sender_format: "banana" }, "Invalid sender_format"],
      [{ random_alias_suffix: "banana" }, "Invalid random_alias_suffix"],
      [{ random_alias_default_domain: "not-ours.test" }, "invalid domain"],
    ];
    for (const [payload, error] of cases) {
      const res = await app.inject({
        method: "PATCH",
        url: "/api/setting",
        headers: auth(apiKey),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>()).toEqual({ error });
    }
  });
});

describe("GET /api/v2/setting/domains", () => {
  test("lists the alias domains", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v2/setting/domains",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>()).toEqual([{ domain: "virtu.email", is_custom: false }]);
  });

  test("includes the user's verified custom domains", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userRow = (await db.select().from(users).where(eq(users.email, email)))[0]!;
    const verified = `v${crypto.randomUUID().slice(0, 8)}.example.com`;
    const unverified = `u${crypto.randomUUID().slice(0, 8)}.example.com`;
    await db.insert(domains).values([
      { userId: userRow.id, nameRequested: verified, verifiedOwner: true, verifiedMx: true },
      { userId: userRow.id, nameRequested: unverified },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/v2/setting/domains",
      headers: auth(apiKey),
    });
    expect(res.json<{ domain: string; is_custom: boolean }[]>()).toEqual([
      { domain: "virtu.email", is_custom: false },
      { domain: verified, is_custom: true },
    ]);
  });
});

/** Age out the sudo window a verify-minted key starts with. */
async function expireSudo(apiKey: string): Promise<void> {
  await db
    .update(apiKeys)
    .set({ sudoModeAt: null })
    .where(eq(apiKeys.keyHash, hashApiKey(apiKey)));
}

describe("sudo -> api_key flow", () => {
  test("api_key without fresh sudo -> 440 Need sudo", async () => {
    const { apiKey } = await registerAndLogin(app);
    await expireSudo(apiKey);
    const res = await app.inject({
      method: "POST",
      url: "/api/api_key",
      headers: auth(apiKey),
      payload: { device: "cli" },
    });
    expect(res.statusCode).toBe(440);
    expect(res.json<{ error: string }>()).toEqual({ error: "Need sudo" });
  });

  test("a verify-minted key starts in sudo mode", async () => {
    const { apiKey } = await registerAndLogin(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/api_key",
      headers: auth(apiKey),
      payload: { device: "cli" },
    });
    expect(created.statusCode).toBe(201);
  });

  test("no code -> 202 emails one; wrong code -> 403; right code -> sudo -> 201 api_key", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    await expireSudo(apiKey);

    const sent = await app.inject({
      method: "PATCH",
      url: "/api/sudo",
      headers: auth(apiKey),
      payload: {},
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json<{ msg: string }>()).toEqual({ msg: "Confirmation code sent" });

    const code = await latestEmailedCode(email);
    const bad = await app.inject({
      method: "PATCH",
      url: "/api/sudo",
      headers: auth(apiKey),
      payload: { code: code === "000000" ? "000001" : "000000" },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json<{ error: string }>()).toEqual({ error: "Invalid code" });

    const good = await app.inject({
      method: "PATCH",
      url: "/api/sudo",
      headers: auth(apiKey),
      payload: { code },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json<{ ok: boolean }>()).toEqual({ ok: true });

    const created = await app.inject({
      method: "POST",
      url: "/api/api_key",
      headers: auth(apiKey),
      payload: { device: "cli" },
    });
    expect(created.statusCode).toBe(201);
    const newKey = created.json<{ api_key: string }>().api_key;
    expect(typeof newKey).toBe("string");

    // The minted key authenticates (but has no sudo of its own).
    const info = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: auth(newKey),
    });
    expect(info.statusCode).toBe(200);
    const noSudo = await app.inject({
      method: "POST",
      url: "/api/api_key",
      headers: auth(newKey),
      payload: {},
    });
    expect(noSudo.statusCode).toBe(440);
  });
});

describe("GET /api/logout", () => {
  test("revokes the presented api key", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({ method: "GET", url: "/api/logout", headers: auth(apiKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ msg: string }>()).toEqual({ msg: "User is logged out" });

    const after = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: auth(apiKey),
    });
    expect(after.statusCode).toBe(401);
    expect(after.json<{ error: string }>()).toEqual({ error: "Wrong api key" });
  });
});
