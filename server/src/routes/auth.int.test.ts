// Route tests via app.inject() against the dockerized postgres.
//
// Prerequisites: `just up` (db on localhost:5432) + `just db push`.
// Run: `just test-int` (or `cd server && bun test int.test`).
//
// Parallel-safe by construction (madi RFC 0003): every test registers its own
// unique user (random localpart), nothing truncates, no ordering constraints.
// Each test also gets its own source IP so the per-IP auth rate limit
// (10/minute) never couples tests together.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { users, verificationCodes } from "../db/schema";
import { latestEmailedCode } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const uniqueEmail = () => `it-${crypto.randomUUID()}@int.test`;
const PASSWORD = "correct horse battery staple";

/** A per-test auth client with its own source IP (see file doc). */
function authClient() {
  const b = () => 1 + Math.floor(Math.random() * 253);
  const remoteAddress = `10.${b()}.${b()}.${b()}`;
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload, remoteAddress });
  return {
    register: (email: string, password = PASSWORD) =>
      post("/api/auth/register", { email, password }),
    activate: (email: string, code: string) => post("/api/auth/activate", { email, code }),
    reactivate: (email: string) => post("/api/auth/reactivate", { email }),
    login: (email: string, password = PASSWORD) =>
      post("/api/auth/login", { email, password, device: "int-test" }),
  };
}

/** Force-expire the user's active account-activation code. */
async function expireActiveCode(email: string): Promise<void> {
  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) throw new Error(`no user ${email}`);
  await db
    .update(verificationCodes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(
      and(
        eq(verificationCodes.userId, user.id),
        eq(verificationCodes.purpose, "account"),
        isNull(verificationCodes.usedAt),
      ),
    );
}

describe("register -> activate -> login -> user_info round trip", () => {
  test("happy path", async () => {
    const c = authClient();
    const email = uniqueEmail();

    const reg = await c.register(email);
    expect(reg.statusCode).toBe(200);
    expect(reg.json<{ msg: string }>()).toEqual({ msg: "User needs to confirm their account" });

    // The account starts unactivated: login is refused with SL's 422.
    const early = await c.login(email);
    expect(early.statusCode).toBe(422);
    expect(early.json<{ error: string }>()).toEqual({ error: "Account not activated" });

    const act = await c.activate(email, await latestEmailedCode(email));
    expect(act.statusCode).toBe(200);
    expect(act.json<{ msg: string }>()).toEqual({
      msg: "Account is activated, user can login now",
    });

    const log = await c.login(email);
    expect(log.statusCode).toBe(200);
    const body = log.json<{
      name: string;
      email: string;
      mfa_enabled: boolean;
      mfa_key: string | null;
      api_key: string;
    }>();
    expect(body.email).toBe(email);
    expect(body.mfa_enabled).toBe(false);
    expect(body.mfa_key).toBeNull();
    expect(typeof body.api_key).toBe("string");

    const info = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: { authentication: body.api_key },
    });
    expect(info.statusCode).toBe(200);
    const user = info.json<{
      email: string;
      in_trial: boolean;
      is_premium: boolean;
      trial_end_timestamp: number | null;
      max_alias_free_plan: number;
      connected_proton_address: string | null;
      profile_picture_url: string | null;
    }>();
    expect(user.email).toBe(email);
    expect(user.in_trial).toBe(true);
    expect(user.is_premium).toBe(true); // trial grants premium (SimpleLogin semantics)
    expect(typeof user.trial_end_timestamp).toBe("number");
    expect(user.max_alias_free_plan).toBe(5);
    expect(user.connected_proton_address).toBeNull();
    expect(user.profile_picture_url).toBeNull();
  });
});

describe("POST /api/auth/register", () => {
  test("rejects a duplicate email with SimpleLogin's error string", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.register(email);
    const dup = await c.register(email);
    expect(dup.statusCode).toBe(400);
    expect(dup.json<{ error: string }>()).toEqual({
      error: `cannot use ${email} as personal inbox`,
    });
  });

  test("rejects a short password", async () => {
    const res = await authClient().register(uniqueEmail(), "short");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "password too short" });
  });

  test("rejects a non-email", async () => {
    const res = await authClient().register("not-an-email");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "cannot use not-an-email as personal inbox",
    });
  });
});

describe("POST /api/auth/activate", () => {
  test("unknown email and wrong code get the same generic 400", async () => {
    const c = authClient();
    const unknown = await c.activate(uniqueEmail(), "123456");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });

    const email = uniqueEmail();
    await c.register(email);
    const code = await latestEmailedCode(email);
    const wrongCode = `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`;
    const wrong = await c.activate(email, wrongCode);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });

    // The right code still works after one wrong try.
    const ok = await c.activate(email, code);
    expect(ok.statusCode).toBe(200);
  });

  test("the third wrong try kills the code (410); reactivate issues a new one", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.register(email);
    const code = await latestEmailedCode(email);
    const wrongCode = `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`;

    for (const expected of [400, 400]) {
      const res = await c.activate(email, wrongCode);
      expect(res.statusCode).toBe(expected);
      expect(res.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });
    }
    const third = await c.activate(email, wrongCode);
    expect(third.statusCode).toBe(410);
    expect(third.json<{ error: string }>()).toEqual({ error: "Too many wrong tries" });

    // The code is dead now — even the correct one is refused.
    const late = await c.activate(email, code);
    expect(late.statusCode).toBe(400);

    // Reactivate mints a fresh code that activates the account.
    const re = await c.reactivate(email);
    expect(re.statusCode).toBe(200);
    const fresh = await latestEmailedCode(email);
    expect(fresh).not.toBe(code);
    const ok = await c.activate(email, fresh);
    expect(ok.statusCode).toBe(200);
    expect((await c.login(email)).statusCode).toBe(200);
  });

  test("an expired code is refused; reactivate recovers", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.register(email);
    const code = await latestEmailedCode(email);
    await expireActiveCode(email);

    const expired = await c.activate(email, code);
    expect(expired.statusCode).toBe(400);
    expect(expired.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });

    await c.reactivate(email);
    const ok = await c.activate(email, await latestEmailedCode(email));
    expect(ok.statusCode).toBe(200);
  });

  test("a consumed code cannot be reused", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.register(email);
    const code = await latestEmailedCode(email);
    expect((await c.activate(email, code)).statusCode).toBe(200);

    // Activated user + same code -> the generic 400 (never probeable).
    const again = await c.activate(email, code);
    expect(again.statusCode).toBe(400);
    expect(again.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });
  });
});

describe("POST /api/auth/reactivate", () => {
  test("unknown or already-activated accounts get the vague 400", async () => {
    const c = authClient();
    const unknown = await c.reactivate(uniqueEmail());
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>()).toEqual({ error: "Something went wrong" });

    const email = uniqueEmail();
    await c.register(email);
    await c.activate(email, await latestEmailedCode(email));
    const activated = await c.reactivate(email);
    expect(activated.statusCode).toBe(400);
    expect(activated.json<{ error: string }>()).toEqual({ error: "Something went wrong" });
  });

  test("the send budget (3/hour incl. register) returns 429 when spent", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.register(email); // send #1
    expect((await c.reactivate(email)).statusCode).toBe(200); // #2
    expect((await c.reactivate(email)).statusCode).toBe(200); // #3

    const over = await c.reactivate(email);
    expect(over.statusCode).toBe(429);
    expect(over.json<{ error: string }>()).toEqual({
      error: "Too many activation emails requested, try again later",
    });

    // The budget rejection did NOT invalidate the last emailed code.
    const ok = await c.activate(email, await latestEmailedCode(email));
    expect(ok.statusCode).toBe(200);
  });
});

describe("POST /api/auth/login", () => {
  test("wrong password and unknown user get the same generic 400", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.register(email);
    await c.activate(email, await latestEmailedCode(email));

    const wrongPassword = await c.login(email, "wrong-password");
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json<{ error: string }>()).toEqual({
      error: "Email or password incorrect",
    });

    const unknownUser = await c.login(uniqueEmail());
    expect(unknownUser.statusCode).toBe(400);
    expect(unknownUser.json<{ error: string }>()).toEqual({ error: "Email or password incorrect" });
  });
});

describe("GET /api/user_info auth hook", () => {
  test("missing key -> 401 with SimpleLogin's error string", async () => {
    const res = await app.inject({ method: "GET", url: "/api/user_info" });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>()).toEqual({ error: "Wrong api key" });
  });

  test("garbage key -> 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: { authentication: "not-a-real-key" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>()).toEqual({ error: "Wrong api key" });
  });
});
