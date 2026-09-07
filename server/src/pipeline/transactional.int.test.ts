/**
 * The DB-touching verification-code flows against the dockerized Postgres:
 * the last-N active window, consume-any / consume-all, the per-code attempt
 * budget, and the global send ceiling. Parallel-safe: every test mints its
 * own user; the ceiling test pins its own max instead of assuming counts.
 */

import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { sentAlerts, users, verificationCodes } from "../db/schema.ts";
import {
  consumeVerificationCode,
  createVerificationCode,
  isRateLimited,
  isTransactionalCeilingReached,
  LOGIN_CODE_ALERT_TYPE,
  MAX_ACTIVE_CODES,
} from "./transactional.ts";

const tag = () => crypto.randomUUID().slice(0, 8);

async function newUser() {
  const email = `tx-int-${tag()}@int.test`;
  const user = (await db.insert(users).values({ email, activated: true }).returning())[0]!;
  return { user, email };
}

async function activeCodeIds(userId: number): Promise<number[]> {
  const rows = await db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(and(eq(verificationCodes.userId, userId), isNull(verificationCodes.usedAt)))
    .orderBy(verificationCodes.id);
  return rows.map((r) => r.id);
}

describe("createVerificationCode", () => {
  test("keeps the newest MAX_ACTIVE_CODES codes valid and retires older ones", async () => {
    const { user } = await newUser();
    const minted: number[] = [];
    for (let i = 0; i < MAX_ACTIVE_CODES + 2; i++) {
      minted.push((await createVerificationCode(db, { userId: user.id, purpose: "login" })).row.id);
    }
    expect(await activeCodeIds(user.id)).toEqual(minted.slice(-MAX_ACTIVE_CODES));
  });

  test("scopes are independent: a sudo code never retires a login code", async () => {
    const { user } = await newUser();
    const login = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    for (let i = 0; i < MAX_ACTIVE_CODES; i++) {
      await createVerificationCode(db, { userId: user.id, purpose: "sudo" });
    }
    expect(await activeCodeIds(user.id)).toContain(login.row.id);
  });
});

describe("consumeVerificationCode", () => {
  test("any of the active codes verifies, and success consumes all of them", async () => {
    const { user, email } = await newUser();
    const first = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    const second = await createVerificationCode(db, { userId: user.id, purpose: "login" });

    const scope = { userId: user.id, purpose: "login" as const, toEmail: email };
    expect(await consumeVerificationCode(db, { ...scope, code: first.code })).toBe("ok");
    expect(await activeCodeIds(user.id)).toEqual([]);
    // The other code died with the login.
    if (second.code !== first.code) {
      expect(await consumeVerificationCode(db, { ...scope, code: second.code })).toBe("none");
    }
  });

  test("wrong guesses spend every live code's budget; the last death is too_many", async () => {
    const { user, email } = await newUser();
    const a = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    const b = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    const scope = { userId: user.id, purpose: "login" as const, toEmail: email };
    const wrong = a.code === "000000" && b.code === "000000" ? "000001" : "000000";
    const guess = wrong === a.code || wrong === b.code ? "999999" : wrong;

    expect(await consumeVerificationCode(db, { ...scope, code: guess })).toBe("wrong");
    expect(await consumeVerificationCode(db, { ...scope, code: guess })).toBe("wrong");
    expect(await consumeVerificationCode(db, { ...scope, code: guess })).toBe("too_many");
    expect(await activeCodeIds(user.id)).toEqual([]);
    expect(await consumeVerificationCode(db, { ...scope, code: a.code })).toBe("none");
  });

  test("a newer code has its own budget: the old one dies first, the new one still works", async () => {
    const { user, email } = await newUser();
    const scope = { userId: user.id, purpose: "login" as const, toEmail: email };
    const old = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    const notOld = old.code === "000000" ? "000001" : "000000";
    // Two wrong guesses against the old code alone...
    expect(await consumeVerificationCode(db, { ...scope, code: notOld })).toBe("wrong");
    expect(await consumeVerificationCode(db, { ...scope, code: notOld })).toBe("wrong");
    // ...then the user asks again; the third wrong guess kills only the old code.
    const fresh = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    const guess = notOld === fresh.code ? "999999" : notOld;
    expect(await consumeVerificationCode(db, { ...scope, code: guess })).toBe("wrong");
    expect(await activeCodeIds(user.id)).toEqual([fresh.row.id]);
    expect(await consumeVerificationCode(db, { ...scope, code: fresh.code })).toBe("ok");
  });

  test("expired codes are ignored; all-expired is 'expired'", async () => {
    const { user, email } = await newUser();
    const past = new Date(Date.now() - 60 * 60_000);
    const stale = await createVerificationCode(db, {
      userId: user.id,
      purpose: "login",
      now: past,
    });
    const scope = { userId: user.id, purpose: "login" as const, toEmail: email };
    expect(await consumeVerificationCode(db, { ...scope, code: stale.code })).toBe("expired");
    const live = await createVerificationCode(db, { userId: user.id, purpose: "login" });
    expect(await consumeVerificationCode(db, { ...scope, code: live.code })).toBe("ok");
  });
});

describe("the global transactional ceiling", () => {
  test("0 = unlimited; a max at or below the trailing-hour count trips it", async () => {
    const { user, email } = await newUser();
    // One send on the ledger so the count is at least 1.
    await db
      .insert(sentAlerts)
      .values({ userId: user.id, toEmail: email, alertType: LOGIN_CODE_ALERT_TYPE });

    expect(await isTransactionalCeilingReached(db, { max: 0 })).toBe(false);
    expect(await isTransactionalCeilingReached(db, { max: 1 })).toBe(true);
    expect(await isTransactionalCeilingReached(db, { max: 1_000_000_000 })).toBe(false);
  });

  test("isRateLimited reports the ceiling even for a fresh scope", async () => {
    const { user, email } = await newUser();
    const scope = { userId: user.id, toEmail: email, alertType: LOGIN_CODE_ALERT_TYPE };
    await db.insert(sentAlerts).values(scope);
    expect(await isRateLimited(db, { ...scope, globalHourlyMax: 0 })).toBe(false);
    expect(await isRateLimited(db, { ...scope, globalHourlyMax: 1 })).toBe(true);
  });
});
