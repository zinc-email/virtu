import { beforeAll } from "bun:test";
import { ensureTestSigningKey } from "../routes/intHarness.ts";
beforeAll(ensureTestSigningKey);
/**
 * The round-2 review's budget doors, closed, through the real MX against
 * the dockerized Postgres: duplicate RCPTs collapse to one copy, fresh
 * catch-all localparts are budgeted on the would-be mailbox BEFORE any
 * alias row exists (and minted only at DATA), a repeated Message-ID does
 * not hide drops from the per-alias budget, and role addresses have a
 * budget and a size cap of their own. Parallel-safe: unique data per test.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { db } from "../db/index.ts";
import { aliases, domains, emailLogs, mailboxes, outboundMessages, users } from "../db/schema.ts";
import { createMxServer, type MxOptions } from "../mx.ts";
import { RawClient } from "../smtp/testutil.ts";
import { createRoleMailBudget } from "./roleMailBudget.ts";

const tag = () => crypto.randomUUID().slice(0, 8);
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers) await c();
});

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silent;
  },
};

async function mx(over: Partial<MxOptions> = {}) {
  const server = createMxServer({
    db,
    mailDomain: "virtu.email",
    mailHostname: "mx.int.test",
    dkimSelector: "mail",
    verpSecret: "insecure-dev-verp-secret-change-me-00",
    maxMessageSize: 1024 * 1024,
    inboundRateLimits: { perAliasPerMinute: 10, perMailboxPerMinute: 15 },
    queueQuota: { maxPendingRows: 500, maxPendingBytes: 256 * 1024 * 1024 },
    resolver: async () => [],
    // The int tier has no logger contract to satisfy here; only silence.
    logger: silent as unknown as MxOptions["logger"],
    ...over,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  closers.push(() => server.close());
  const client = await RawClient.connect(port);
  await client.waitFor(/^220 /);
  client.write("EHLO peer.int.test\r\n");
  await client.waitFor(/^250 /);
  return client;
}

async function envelope(client: RawClient, from: string, rcpts: string[]): Promise<string[]> {
  client.write(`MAIL FROM:<${from}>\r\n`);
  await client.waitFor(/^250 /);
  const replies: string[] = [];
  for (const r of rcpts) {
    client.write(`RCPT TO:<${r}>\r\n`);
    replies.push(await client.waitFor(/^[245]\d\d /));
  }
  return replies;
}

async function data(client: RawClient, headers: string, body = "hello"): Promise<string> {
  client.write("DATA\r\n");
  await client.waitFor(/^354 /);
  client.write(`${headers}\r\n\r\n${body}\r\n.\r\n`);
  return client.waitFor(/^[245]\d\d /);
}

async function user(t: string) {
  const u = (
    await db
      .insert(users)
      .values({ email: `rb-${t}@int.test`, activated: true })
      .returning()
  )[0]!;
  const mb = (
    await db
      .insert(mailboxes)
      .values({ userId: u.id, email: `rb-mb-${t}@int.test`, verified: true })
      .returning()
  )[0]!;
  await db.update(users).set({ defaultMailboxId: mb.id }).where(eq(users.id, u.id));
  return { user: { ...u, defaultMailboxId: mb.id }, mailbox: mb };
}

describe("rcpt budgets (review round 2)", () => {
  test("the same alias a hundred times is one copy", async () => {
    const t = tag();
    const f = await user(t);
    const alias = (
      await db
        .insert(aliases)
        .values({ userId: f.user.id, email: `rb-${t}@virtu.email`, mailboxId: f.mailbox.id })
        .returning()
    )[0]!;
    const client = await mx();
    const replies = await envelope(
      client,
      "anon@peer.int.test",
      Array.from({ length: 100 }, () => alias.email),
    );
    expect(replies.every((r) => r.startsWith("250"))).toBe(true);
    expect(await data(client, `From: a@peer.int.test\r\nTo: ${alias.email}\r\nSubject: x`)).toMatch(
      /^250 /,
    );
    const queued = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(eq(outboundMessages.userId, f.user.id));
    expect(queued.length).toBe(1);
  });

  test("catch-all: RCPT mints nothing, DATA mints, and the mailbox budget counts the transaction", async () => {
    const t = tag();
    const f = await user(t);
    const domainName = `rb-${t}.example`;
    const domain = (
      await db
        .insert(domains)
        .values({
          userId: f.user.id,
          nameRequested: domainName,
          verifiedOwner: true,
          verifiedMx: true,
          catchAll: true,
        })
        .returning()
    )[0]!;
    const minted = () =>
      db.select({ id: aliases.id }).from(aliases).where(eq(aliases.domainId, domain.id));

    const client = await mx();
    // 20 fresh localparts: the per-mailbox budget (15) sees the copies this
    // transaction already accepted, so the tail tempfails — before any row.
    const replies = await envelope(
      client,
      "anon@peer.int.test",
      Array.from({ length: 20 }, (_, i) => `fresh-${i}-${t}@${domainName}`),
    );
    expect(replies.filter((r) => r.startsWith("250")).length).toBe(15);
    expect(replies.filter((r) => r.startsWith("450 4.7.1")).length).toBe(5);
    expect((await minted()).length).toBe(0);

    expect(
      await data(client, `From: a@peer.int.test\r\nTo: x@${domainName}\r\nSubject: x`),
    ).toMatch(/^250 /);
    expect((await minted()).length).toBe(15);
    const queued = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(eq(outboundMessages.userId, f.user.id));
    expect(queued.length).toBe(15);
  });

  test("catch-all: the per-domain hourly mint cap tempfails, and a RSET transaction leaves no row", async () => {
    const t = tag();
    const f = await user(t);
    const domainName = `rb-cap-${t}.example`;
    const domain = (
      await db
        .insert(domains)
        .values({
          userId: f.user.id,
          nameRequested: domainName,
          verifiedOwner: true,
          verifiedMx: true,
          catchAll: true,
        })
        .returning()
    )[0]!;
    const client = await mx({ catchAllMintsPerHour: 2 });
    // Two mints through DATA, one message each.
    for (let i = 0; i < 2; i++) {
      await envelope(client, "anon@peer.int.test", [`cap-${i}-${t}@${domainName}`]);
      await data(client, `From: a@peer.int.test\r\nSubject: ${i}`);
    }
    const [reply] = await envelope(client, "anon@peer.int.test", [`cap-3-${t}@${domainName}`]);
    expect(reply).toMatch(/^450 4\.7\.1 Domain is creating new addresses too fast/);
    // Probing without DATA writes nothing.
    client.write("RSET\r\n");
    await client.waitFor(/^250 /);
    await envelope(client, "anon@peer.int.test", [`probe-${t}@${domainName}`]);
    client.write("RSET\r\n");
    await client.waitFor(/^250 /);
    const rows = await db
      .select({ email: aliases.email })
      .from(aliases)
      .where(and(eq(aliases.domainId, domain.id), like(aliases.email, `probe-%`)));
    expect(rows.length).toBe(0);
    // And an address that could never be a row is plain "user unknown".
    const [tooLong] = await envelope(client, "anon@peer.int.test", [
      `${"a".repeat(80)}@${domainName}`,
    ]);
    expect(tooLong).toMatch(/^550 5\.1\.1/);
  });

  test("a repeated Message-ID does not hide accept-and-drop from the per-alias budget", async () => {
    const t = tag();
    const f = await user(t);
    const alias = (
      await db
        .insert(aliases)
        .values({
          userId: f.user.id,
          email: `rb-off-${t}@virtu.email`,
          mailboxId: f.mailbox.id,
          enabled: false,
        })
        .returning()
    )[0]!;
    const client = await mx({
      inboundRateLimits: { perAliasPerMinute: 3, perMailboxPerMinute: 0 },
    });
    const replies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [r] = await envelope(client, "anon@peer.int.test", [alias.email]);
      replies.push(r!);
      if (r!.startsWith("250")) {
        await data(
          client,
          `From: a@peer.int.test\r\nMessage-ID: <same@peer.int.test>\r\nSubject: ${i}`,
        );
      } else {
        client.write("RSET\r\n");
        await client.waitFor(/^250 /);
      }
    }
    expect(replies.filter((r) => r.startsWith("250")).length).toBe(3);
    expect(replies.filter((r) => r.startsWith("450")).length).toBe(2);
    const blocked = await db
      .select({ id: emailLogs.id })
      .from(emailLogs)
      .where(eq(emailLogs.aliasId, alias.id));
    expect(blocked.length).toBe(3);
  });

  test("role addresses: a per-minute budget and a size cap", async () => {
    const t = tag();
    const f = await user(t);
    // This user is the operator (admin flag bit 0).
    await db.update(users).set({ flags: 1 }).where(eq(users.id, f.user.id));
    const localpart = `postmaster`;
    const client = await mx({
      operatorLocalparts: [localpart],
      roleMailBudget: createRoleMailBudget(2),
      operatorMailMaxBytes: 2048,
    });
    const replies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [r] = await envelope(client, `reporter-${t}@peer.int.test`, [
        `${localpart}@virtu.email`,
      ]);
      replies.push(r!);
      client.write("RSET\r\n");
      await client.waitFor(/^250 /);
    }
    expect(replies.slice(0, 2).every((r) => r.startsWith("250"))).toBe(true);
    expect(replies[2]).toMatch(/^450 4\.7\.1 Role address/);

    const big = await mx({
      operatorLocalparts: [localpart],
      roleMailBudget: createRoleMailBudget(0),
      operatorMailMaxBytes: 2048,
    });
    await envelope(big, `reporter-${t}@peer.int.test`, [`${localpart}@virtu.email`]);
    expect(
      await data(
        big,
        `From: reporter-${t}@peer.int.test\r\nSubject: big`,
        ("x".repeat(512) + "\r\n").repeat(8),
      ),
    ).toMatch(/^552 5\.3\.4/);
  });
});

describe("header cardinality (review round 3)", () => {
  test("a message with two From headers is refused; one From is forwarded", async () => {
    const t = tag();
    const f = await user(t);
    const alias = (
      await db
        .insert(aliases)
        .values({ userId: f.user.id, email: `rb-from-${t}@virtu.email`, mailboxId: f.mailbox.id })
        .returning()
    )[0]!;
    const client = await mx();
    await envelope(client, "anon@peer.int.test", [alias.email]);
    expect(
      await data(
        client,
        `From: ceo@bank.int.test\r\nFrom: a@peer.int.test\r\nTo: ${alias.email}\r\nSubject: x`,
      ),
    ).toMatch(/^550 5\.6\.0 .*exactly one From/);
    await envelope(client, "anon@peer.int.test", [alias.email]);
    expect(await data(client, `From: a@peer.int.test\r\nTo: ${alias.email}\r\nSubject: x`)).toMatch(
      /^250 /,
    );
    const queued = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(eq(outboundMessages.userId, f.user.id));
    expect(queued.length).toBe(1);
  });
});
