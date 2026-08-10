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
import { and, desc, eq, isNull } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { mailboxes, outboundMessages, users, verificationCodes } from "../db/schema";
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

/** A per-test auth client with its own source IP (see file doc). */
function authClient() {
  const b = () => 1 + Math.floor(Math.random() * 253);
  const remoteAddress = `10.${b()}.${b()}.${b()}`;
  const post = (url: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url, payload, remoteAddress });
  return {
    login: (email: string) => post("/api/auth/login", { email, device: "int-test" }),
    verify: (email: string, code: string) =>
      post("/api/auth/verify", { email, code, device: "int-test" }),
  };
}

/** A code that differs from `code` in the last digit. */
const wrongify = (code: string) => `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`;

/** Force-expire the user's active login code. */
async function expireActiveCode(email: string): Promise<void> {
  const user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (!user) throw new Error(`no user ${email}`);
  await db
    .update(verificationCodes)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(
      and(
        eq(verificationCodes.userId, user.id),
        eq(verificationCodes.purpose, "login"),
        isNull(verificationCodes.usedAt),
      ),
    );
}

async function findUser(email: string) {
  return (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
}

describe("login -> verify -> user_info round trip (signup path)", () => {
  test("an unknown email becomes a provisional user, graduated on verify", async () => {
    const c = authClient();
    const email = uniqueEmail();

    const req = await c.login(email);
    expect(req.statusCode).toBe(200);
    expect(req.json<{ msg: string }>()).toEqual({ msg: "Login code sent" });

    // Provisional: the row exists but is not graduated, and has no mailbox.
    const provisional = await findUser(email);
    expect(provisional).toBeDefined();
    expect(provisional!.activated).toBe(false);
    expect(provisional!.trialEnd).toBeNull();
    expect(provisional!.defaultMailboxId).toBeNull();

    const verified = await c.verify(email, await latestEmailedCode(email));
    expect(verified.statusCode).toBe(200);
    const body = verified.json<{
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

    // Graduated: activated, trial started, self-mailbox born verified.
    const graduated = await findUser(email);
    expect(graduated!.activated).toBe(true);
    expect(graduated!.trialEnd).not.toBeNull();
    const mailbox = (
      await db.select().from(mailboxes).where(eq(mailboxes.id, graduated!.defaultMailboxId!))
    )[0];
    expect(mailbox?.email).toBe(email);
    expect(mailbox?.verified).toBe(true);

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
    }>();
    expect(user.email).toBe(email);
    expect(user.in_trial).toBe(true);
    expect(user.is_premium).toBe(true); // trial grants premium (SimpleLogin semantics)
    expect(typeof user.trial_end_timestamp).toBe("number");
    expect(user.max_alias_free_plan).toBe(5);
  });

  test("a second login round-trip does not re-graduate (login path)", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    expect((await c.verify(email, await latestEmailedCode(email))).statusCode).toBe(200);
    const first = await findUser(email);

    await c.login(email);
    const again = await c.verify(email, await latestEmailedCode(email));
    expect(again.statusCode).toBe(200);
    expect(typeof again.json<{ api_key: string }>().api_key).toBe("string");

    // Same trial clock, same single self-mailbox — graduation ran once.
    const second = await findUser(email);
    expect(second!.trialEnd?.getTime()).toBe(first!.trialEnd?.getTime());
    expect(second!.defaultMailboxId).toBe(first!.defaultMailboxId);
    const boxes = await db.select().from(mailboxes).where(eq(mailboxes.userId, second!.id));
    expect(boxes.length).toBe(1);
  });
});

describe("POST /api/auth/login", () => {
  test("new and existing emails get the identical response (no enumeration)", async () => {
    const c = authClient();
    const email = uniqueEmail();
    const first = await c.login(email);
    const second = await c.login(email);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual(second.json());
  });

  test("rejects a non-email", async () => {
    const res = await authClient().login("not-an-email");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "Invalid email address" });
  });

  test("a resend invalidates the previous code; the newest one wins", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    const stale = await latestEmailedCode(email);
    await c.login(email);
    const fresh = await latestEmailedCode(email);

    if (stale !== fresh) {
      const dead = await c.verify(email, stale);
      expect(dead.statusCode).toBe(400);
    }
    expect((await c.verify(email, fresh)).statusCode).toBe(200);
  });

  test("the send budget (3/hour) returns 429 when spent", async () => {
    const c = authClient();
    const email = uniqueEmail();
    expect((await c.login(email)).statusCode).toBe(200); // send #1
    expect((await c.login(email)).statusCode).toBe(200); // #2
    expect((await c.login(email)).statusCode).toBe(200); // #3

    const over = await c.login(email);
    expect(over.statusCode).toBe(429);
    expect(over.json<{ error: string }>()).toEqual({
      error: "Too many login emails requested, try again later",
    });

    // The budget rejection did NOT invalidate the last emailed code.
    const ok = await c.verify(email, await latestEmailedCode(email));
    expect(ok.statusCode).toBe(200);
  });

  test("a disabled account gets the uniform response but no email", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    expect((await c.verify(email, await latestEmailedCode(email))).statusCode).toBe(200);
    await db.update(users).set({ disabled: true }).where(eq(users.email, email));

    const before = (
      await db
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(eq(outboundMessages.envelopeTo, email))
        .orderBy(desc(outboundMessages.id))
        .limit(1)
    )[0];
    const res = await c.login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ msg: string }>()).toEqual({ msg: "Login code sent" });
    const after = (
      await db
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(eq(outboundMessages.envelopeTo, email))
        .orderBy(desc(outboundMessages.id))
        .limit(1)
    )[0];
    expect(after?.id).toBe(before?.id);
  });
});

describe("POST /api/auth/verify", () => {
  test("unknown email and wrong code get the same generic 400", async () => {
    const c = authClient();
    const unknown = await c.verify(uniqueEmail(), "123456");
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });

    const email = uniqueEmail();
    await c.login(email);
    const code = await latestEmailedCode(email);
    const wrong = await c.verify(email, wrongify(code));
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });

    // The right code still works after one wrong try.
    const ok = await c.verify(email, code);
    expect(ok.statusCode).toBe(200);
  });

  test("the third wrong try kills the code (410); a new login issues a fresh one", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    const code = await latestEmailedCode(email);

    for (const expected of [400, 400]) {
      const res = await c.verify(email, wrongify(code));
      expect(res.statusCode).toBe(expected);
      expect(res.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });
    }
    const third = await c.verify(email, wrongify(code));
    expect(third.statusCode).toBe(410);
    expect(third.json<{ error: string }>()).toEqual({ error: "Too many wrong tries" });

    // The code is dead now — even the correct one is refused.
    const late = await c.verify(email, code);
    expect(late.statusCode).toBe(400);

    // Submitting the email again mints a fresh, working code.
    const re = await c.login(email);
    expect(re.statusCode).toBe(200);
    const fresh = await latestEmailedCode(email);
    expect(fresh).not.toBe(code);
    expect((await c.verify(email, fresh)).statusCode).toBe(200);
  });

  test("an expired code is refused; a new login recovers", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    const code = await latestEmailedCode(email);
    await expireActiveCode(email);

    const expired = await c.verify(email, code);
    expect(expired.statusCode).toBe(400);
    expect(expired.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });

    await c.login(email);
    const ok = await c.verify(email, await latestEmailedCode(email));
    expect(ok.statusCode).toBe(200);
  });

  test("a consumed code cannot be reused", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    const code = await latestEmailedCode(email);
    expect((await c.verify(email, code)).statusCode).toBe(200);

    // Same code again -> the generic 400 (never probeable).
    const again = await c.verify(email, code);
    expect(again.statusCode).toBe(400);
    expect(again.json<{ error: string }>()).toEqual({ error: "Wrong email or code" });
  });

  test("a disabled account is refused even with a valid stale code", async () => {
    const c = authClient();
    const email = uniqueEmail();
    await c.login(email);
    expect((await c.verify(email, await latestEmailedCode(email))).statusCode).toBe(200);

    // A code minted just before the account was disabled.
    await c.login(email);
    const code = await latestEmailedCode(email);
    await db.update(users).set({ disabled: true }).where(eq(users.email, email));

    const res = await c.verify(email, code);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "Account disabled" });
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
