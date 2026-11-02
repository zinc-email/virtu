import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, type Db } from "./db/index.ts";
import {
  aliases,
  aliasMailboxes,
  dkimKeys,
  emailLogs,
  mailboxes,
  outboundMessages,
  users,
} from "./db/schema.ts";
import { handleInboundData, type MxOptions } from "./mx.ts";
import { makeRsaKeyPair, makeStubResolver } from "./mailauth/test-fixtures.ts";
import { createLogger } from "./log.ts";
import type { SmtpDataEvent } from "./smtp/types.ts";

async function fixture(key: "valid" | "broken" | "missing" = "valid") {
  const domain = `${crypto.randomUUID()}.test`;
  const [user] = await db
    .insert(users)
    .values({ email: `owner@${domain}`, activated: true })
    .returning();
  const boxes = await db
    .insert(mailboxes)
    .values([1, 2].map((i) => ({ userId: user!.id, email: `box${i}@${domain}`, verified: true })))
    .returning();
  const [alias] = await db
    .insert(aliases)
    .values({ userId: user!.id, email: `alias@${domain}`, mailboxId: boxes[0]!.id })
    .returning();
  await db
    .insert(aliasMailboxes)
    .values(boxes.map((box) => ({ aliasId: alias!.id, mailboxId: box.id })));
  if (key !== "missing") {
    const pair = makeRsaKeyPair();
    await db.insert(dkimKeys).values({
      domain,
      selector: "test",
      privateKeyPem: key === "broken" ? "broken" : pair.privateKeyPem,
      publicKeyBase64: "unused",
    });
  }
  const raw = new TextEncoder().encode(
    `From: sender@sender.test\r\nTo: ${alias!.email}\r\nSubject: atomic\r\n\r\nhello\r\n`,
  );
  const event: SmtpDataEvent = {
    raw,
    headers: raw,
    body: new Uint8Array(),
    session: { id: domain, remoteAddress: "192.0.2.1", remotePort: 1234, tls: false },
    envelope: {
      heloName: "sender.test",
      tls: false,
      mailFrom: "sender@sender.test",
      params: {},
      rcptTo: [{ address: alias!.email, params: {} }],
    },
  };
  const opts: MxOptions = {
    db,
    mailDomain: domain,
    mailHostname: `mx.${domain}`,
    dkimSelector: "test",
    verpSecret: "test-secret-long-enough-for-verp-12345",
    maxMessageSize: raw.length,
    resolver: makeStubResolver({ TXT: { "sender.test": "v=spf1 ip4:192.0.2.1 -all" } }),
    logger: createLogger("acceptance-test", { write: () => {} }),
  };
  return { user: user!, event, opts };
}

async function counts(userId: number) {
  return {
    logs: (await db.select().from(emailLogs).where(eq(emailLogs.userId, userId))).length,
    queue: (await db.select().from(outboundMessages).where(eq(outboundMessages.userId, userId)))
      .length,
  };
}

test("fan-out commits every copy with headroom for signatures at inbound SIZE limit", async () => {
  const f = await fixture();
  expect(await handleInboundData(f.event, f.opts)).toMatchObject({ accept: true });
  expect(await counts(f.user.id)).toEqual({ logs: 2, queue: 2 });
  await db.delete(users).where(eq(users.id, f.user.id));
});

test("database interruption on later fan-out insert rolls back all logs and copies; retry is clean", async () => {
  const f = await fixture();
  let inserts = 0;
  const injected = new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction")
        return (fn: (tx: Db) => Promise<unknown>) =>
          target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, p) {
                  if (p === "insert")
                    return (table: Parameters<typeof tx.insert>[0]) => {
                      if (table === outboundMessages && ++inserts === 2)
                        throw new Error("injected database interruption");
                      return t.insert(table);
                    };
                  const value = Reflect.get(t, p);
                  return typeof value === "function" ? value.bind(t) : value;
                },
              }),
            ),
          );
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(handleInboundData(f.event, { ...f.opts, db: injected })).rejects.toThrow(
    "injected database interruption",
  );
  expect(await counts(f.user.id)).toEqual({ logs: 0, queue: 0 });
  expect(await handleInboundData(f.event, f.opts)).toMatchObject({ accept: true });
  expect(await counts(f.user.id)).toEqual({ logs: 2, queue: 2 });
  await db.delete(users).where(eq(users.id, f.user.id));
});

for (const key of ["missing", "broken"] as const) {
  test(`${key} required key prevents acceptance and leaves no delivery logs or copies`, async () => {
    const f = await fixture(key);
    if (key === "missing")
      expect(await handleInboundData(f.event, f.opts)).toMatchObject({ reject: { code: 451 } });
    else
      await expect(handleInboundData(f.event, f.opts)).rejects.toThrow(
        "Required DKIM signing failed",
      );
    expect(await counts(f.user.id)).toEqual({ logs: 0, queue: 0 });
    await db.delete(users).where(eq(users.id, f.user.id));
  });
}

test("suspicious authentication is rejected unless the operator explicitly enables flagged forwarding", async () => {
  const f = await fixture();
  const opts = { ...f.opts, resolver: makeStubResolver({ TXT: { "sender.test": "v=spf1 -all" } }) };
  expect(await handleInboundData(f.event, opts)).toMatchObject({ reject: { code: 550 } });
  expect(await counts(f.user.id)).toEqual({ logs: 0, queue: 0 });
  expect(
    await handleInboundData(f.event, { ...opts, inboundFlagDisposition: "forward" }),
  ).toMatchObject({ accept: true });
  expect(await counts(f.user.id)).toEqual({ logs: 2, queue: 2 });
  await db.delete(users).where(eq(users.id, f.user.id));
});

test("DMARC-only failure is forwarded with its evidence instead of being rejected by a second MX policy", async () => {
  const f = await fixture();
  try {
    const result = await handleInboundData(f.event, {
      ...f.opts,
      inboundFlagDisposition: "reject",
      resolver: makeStubResolver({
        TXT: {
          "sender.test": "v=spf1 -all",
          "_dmarc.sender.test": "v=DMARC1; p=reject",
        },
      }),
    });
    expect(result).toMatchObject({ accept: true });
    const queued = await db
      .select({ raw: outboundMessages.raw })
      .from(outboundMessages)
      .where(eq(outboundMessages.userId, f.user.id));
    expect(queued).toHaveLength(2);
    for (const row of queued) {
      expect(new TextDecoder().decode(row.raw)).toContain("X-Virtu-Spam-Flag:");
    }
    const logs = await db
      .select({ isSpam: emailLogs.isSpam })
      .from(emailLogs)
      .where(eq(emailLogs.userId, f.user.id));
    expect(logs.every((log) => log.isSpam)).toBe(true);
  } finally {
    await db.delete(users).where(eq(users.id, f.user.id));
  }
});

for (const author of ["alice@one.test, bob@two.test", "undisclosed-recipients:;"]) {
  test(`ambiguous original author is refused before forwarding: ${author}`, async () => {
    const f = await fixture();
    try {
      f.event.raw = new TextEncoder().encode(
        new TextDecoder().decode(f.event.raw).replace("sender@sender.test", author),
      );
      expect(await handleInboundData(f.event, f.opts)).toMatchObject({ reject: { code: 550 } });
      expect(await counts(f.user.id)).toEqual({ logs: 0, queue: 0 });
    } finally {
      await db.delete(users).where(eq(users.id, f.user.id));
    }
  });
}
