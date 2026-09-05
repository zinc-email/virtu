// Invite lane int tests (ABUSE.md Tier 0): the admin mint/list/revoke
// surface and the /auth/verify graduation gate. Prerequisites: `just up`
// (migrates on boot). Parallel-safe: unique users and codes per test, no
// truncation; the gate tests toggle config.signupInviteOnly and restore it
// (test files run serially in one bun process, so nothing else observes the
// toggle).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { config } from "../config";
import { db } from "../db";
import { invites, users } from "../db/schema";
import { latestEmailedCode, makeAdmin, registerAndLogin, uniqueEmail } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

async function adminUser() {
  const user = await registerAndLogin(app);
  await makeAdmin(user.email);
  return user;
}

/** Mint invites through the real admin API; returns the codes. */
async function mintInvites(
  apiKey: string,
  body: Record<string, unknown> = {},
): Promise<{ id: number; code: string }[]> {
  const res = await app.inject({
    method: "POST",
    url: "/api/admin/invites",
    headers: auth(apiKey),
    payload: body,
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ invites: { id: number; code: string }[] }>().invites;
}

/** A unique IP per flow so the per-IP auth rate limit never couples tests. */
const uniqueIp = () => {
  const b = () => 1 + Math.floor(Math.random() * 253);
  return `10.${b()}.${b()}.${b()}`;
};

/** Request a login code for `email` and return it (from the queue). */
async function requestCode(email: string, remoteAddress: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email },
    remoteAddress,
  });
  expect(res.statusCode).toBe(200);
  return latestEmailedCode(email);
}

describe("admin invites surface", () => {
  test("401 without a key, 403 for a non-admin", async () => {
    const { apiKey } = await registerAndLogin(app);
    const routes = [
      { method: "GET" as const, url: "/api/admin/invites" },
      { method: "POST" as const, url: "/api/admin/invites", payload: { count: 1 } },
      { method: "DELETE" as const, url: "/api/admin/invites/1" },
    ];
    for (const r of routes) {
      const anon = await app.inject({ method: r.method, url: r.url, payload: r.payload });
      expect(anon.statusCode).toBe(401);
      const nonAdmin = await app.inject({
        method: r.method,
        url: r.url,
        payload: r.payload,
        headers: auth(apiKey),
      });
      expect(nonAdmin.statusCode).toBe(403);
    }
  });

  test("mint -> list -> revoke lifecycle", async () => {
    const admin = await adminUser();
    const note = `int-test batch ${crypto.randomUUID()}`;
    const minted = await mintInvites(admin.apiKey, { count: 2, note });
    expect(minted).toHaveLength(2);
    for (const inv of minted) expect(inv.code.length).toBeGreaterThanOrEqual(12);

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/invites",
      headers: auth(admin.apiKey),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      total: number;
      unused: number;
      invites: { id: number; note: string | null; created_by: { email: string } | null }[];
    }>();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.unused).toBeGreaterThanOrEqual(2);
    const mine = body.invites.filter((i) => i.note === note);
    expect(mine).toHaveLength(2);
    expect(mine[0]?.created_by?.email).toBe(admin.email);

    const first = minted[0]!;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/admin/invites/${first.id}`,
      headers: auth(admin.apiKey),
    });
    expect(del.statusCode).toBe(200);
    const delAgain = await app.inject({
      method: "DELETE",
      url: `/api/admin/invites/${first.id}`,
      headers: auth(admin.apiKey),
    });
    expect(delAgain.statusCode).toBe(404);
  });
});

describe("invite-only graduation gate", () => {
  let wasInviteOnly: boolean;

  beforeAll(() => {
    wasInviteOnly = config.signupInviteOnly;
    config.signupInviteOnly = true;
  });

  afterAll(() => {
    config.signupInviteOnly = wasInviteOnly;
  });

  test("new email without an invite is 403, stays provisional, code is spent", async () => {
    const email = uniqueEmail();
    const ip = uniqueIp();
    const code = await requestCode(email, ip);

    const noInvite = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email, code },
      remoteAddress: ip,
    });
    expect(noInvite.statusCode).toBe(403);
    expect(noInvite.json<{ error: string }>().error).toContain("invite");

    const row = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row[0]?.activated).toBe(false);

    // The 403 came after code proof, so the code is consumed — replaying it
    // (now with any invite) is a plain wrong-code 400.
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email, code, invite: "whatever" },
      remoteAddress: ip,
    });
    expect(replay.statusCode).toBe(400);
  });

  test("bogus invite is 403 and rolls the activation back", async () => {
    const email = uniqueEmail();
    const ip = uniqueIp();
    const code = await requestCode(email, ip);

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email, code, invite: "not-a-real-code" },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(403);

    const row = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(row[0]?.activated).toBe(false);
  });

  test("valid invite graduates, is burned with the linkage, and cannot be reused", async () => {
    // The admin itself needs the gate open to register.
    config.signupInviteOnly = false;
    const admin = await adminUser();
    config.signupInviteOnly = true;
    const [invite] = await mintInvites(admin.apiKey, { note: "gate test" });

    const email = uniqueEmail();
    const ip = uniqueIp();
    const code = await requestCode(email, ip);
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email, code, invite: invite!.code },
      remoteAddress: ip,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ api_key: string | null }>().api_key).toBeTruthy();

    const userRow = await db.select().from(users).where(eq(users.email, email)).limit(1);
    expect(userRow[0]?.activated).toBe(true);
    const inviteRow = await db.select().from(invites).where(eq(invites.id, invite!.id)).limit(1);
    expect(inviteRow[0]?.usedBy).toBe(userRow[0]!.id);
    expect(inviteRow[0]?.usedAt).not.toBeNull();

    // A used invite is dead for the next signup...
    const second = uniqueEmail();
    const ip2 = uniqueIp();
    const code2 = await requestCode(second, ip2);
    const reuse = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email: second, code: code2, invite: invite!.code },
      remoteAddress: ip2,
    });
    expect(reuse.statusCode).toBe(403);

    // ...and can no longer be revoked (it is the invite graph now).
    const del = await app.inject({
      method: "DELETE",
      url: `/api/admin/invites/${invite!.id}`,
      headers: auth(admin.apiKey),
    });
    expect(del.statusCode).toBe(404);
  });

  test("expired invite is 403", async () => {
    const inserted = await db
      .insert(invites)
      // Same 12-char shape as real codes — the admin UI renders these rows.
      .values({
        code: `xp${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
        expiresAt: new Date(Date.now() - 1),
      })
      .returning();
    const email = uniqueEmail();
    const ip = uniqueIp();
    const code = await requestCode(email, ip);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email, code, invite: inserted[0]!.code },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(403);
  });

  test("existing activated users log in without an invite", async () => {
    // Register while the gate is momentarily open, then log in gated.
    config.signupInviteOnly = false;
    const user = await registerAndLogin(app);
    config.signupInviteOnly = true;

    const ip = uniqueIp();
    const code = await requestCode(user.email, ip);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/verify",
      payload: { email: user.email, code },
      remoteAddress: ip,
    });
    expect(res.statusCode).toBe(200);
  });
});
