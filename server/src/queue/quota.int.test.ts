/**
 * pendingUsage + the RCPT policy gate against the dockerized Postgres.
 * Parallel-safe: every test builds its own user/mailbox/alias with unique
 * addresses and only ever counts its own user's rows.
 */

import { describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { aliases, mailboxes, outboundMessages, users } from "../db/schema.ts";
import { evaluateRcpt } from "../pipeline/policy.ts";
import { pendingUsage } from "./quota.ts";

const tag = () => crypto.randomUUID().slice(0, 8);
const VERP_SECRET = "quota-int-test-verp-secret-quota-int-test";

async function fixture() {
  const t = tag();
  const user = (
    await db
      .insert(users)
      .values({ email: `qq-int-${t}@int.test`, activated: true })
      .returning()
  )[0]!;
  const mailbox = (
    await db
      .insert(mailboxes)
      .values({ userId: user.id, email: `qq-mb-${t}@int.test`, verified: true })
      .returning()
  )[0]!;
  const alias = (
    await db
      .insert(aliases)
      .values({ userId: user.id, email: `qq-${t}@virtu.email`, mailboxId: mailbox.id })
      .returning()
  )[0]!;
  return { user, mailbox, alias };
}

function rowFor(userId: number, status: "pending" | "sending" | "sent" | "failed", bytes: number) {
  return {
    raw: new Uint8Array(bytes),
    envelopeFrom: "",
    envelopeTo: `qq-rcpt-${tag()}@int.test`,
    status,
    userId,
  };
}

describe("pendingUsage", () => {
  test("counts pending + sending rows and their raw bytes, never terminal rows", async () => {
    const { user } = await fixture();
    expect(await pendingUsage(db, user.id)).toEqual({ rows: 0, bytes: 0 });

    await db.insert(outboundMessages).values([
      rowFor(user.id, "pending", 100),
      rowFor(user.id, "pending", 250),
      rowFor(user.id, "sending", 1000),
      rowFor(user.id, "sent", 0), // raw cleared on the terminal write
      rowFor(user.id, "failed", 5000), // operator forensics, not in flight
    ]);
    expect(await pendingUsage(db, user.id)).toEqual({ rows: 3, bytes: 1350 });
  });

  test("unowned rows (user_id null) belong to nobody's usage", async () => {
    const { user } = await fixture();
    await db.insert(outboundMessages).values({ ...rowFor(user.id, "pending", 10), userId: null });
    expect(await pendingUsage(db, user.id)).toEqual({ rows: 0, bytes: 0 });
  });
});

describe("evaluateRcpt with a queue quota", () => {
  test("a full owner queue tempfails 452 4.3.1 at RCPT; under the cap it delivers", async () => {
    const { user, alias } = await fixture();
    const opts = {
      verpSecret: VERP_SECRET,
      mailDomain: "virtu.email",
      queueQuota: { maxPendingRows: 2, maxPendingBytes: 0 },
    };

    await db.insert(outboundMessages).values(rowFor(user.id, "pending", 10));
    const under = await evaluateRcpt(db, alias.email, opts);
    expect(under.decision).toEqual({ kind: "deliver" });
    expect(under.facts.queueFull).toBe(false);

    await db.insert(outboundMessages).values(rowFor(user.id, "sending", 10));
    const full = await evaluateRcpt(db, alias.email, opts);
    expect(full.decision).toMatchObject({ kind: "reject", code: 452, enhanced: "4.3.1" });
    expect(full.facts.queueFull).toBe(true);

    // Without the option the same facts deliver — the mx decides enforcement.
    const unenforced = await evaluateRcpt(db, alias.email, {
      verpSecret: VERP_SECRET,
      mailDomain: "virtu.email",
    });
    expect(unenforced.decision).toEqual({ kind: "deliver" });
  });

  test("the bytes cap trips on raw size alone", async () => {
    const { user, alias } = await fixture();
    await db.insert(outboundMessages).values(rowFor(user.id, "pending", 4096));
    const full = await evaluateRcpt(db, alias.email, {
      verpSecret: VERP_SECRET,
      mailDomain: "virtu.email",
      queueQuota: { maxPendingRows: 0, maxPendingBytes: 4096 },
    });
    expect(full.decision).toMatchObject({ kind: "reject", code: 452 });
  });
});
