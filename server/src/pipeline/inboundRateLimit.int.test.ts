/**
 * countRecentInbound against the dockerized Postgres: the alias scope
 * collapses multi-mailbox copies onto one message, the mailbox scope counts
 * copies per mailbox, and the window is a trailing minute. Parallel-safe:
 * each test builds its own user/alias/mailboxes with unique addresses.
 */

import { describe, expect, test } from "bun:test";
import { db } from "../db/index.ts";
import { aliases, contacts, emailLogs, mailboxes, users } from "../db/schema.ts";
import { countRecentInbound } from "./inboundRateLimit.ts";

const tag = () => crypto.randomUUID().slice(0, 8);

async function fixture() {
  const t = tag();
  const user = (
    await db
      .insert(users)
      .values({ email: `irl-int-${t}@int.test`, activated: true })
      .returning()
  )[0]!;
  const [mbA, mbB] = await db
    .insert(mailboxes)
    .values([
      { userId: user.id, email: `irl-a-${t}@int.test`, verified: true },
      { userId: user.id, email: `irl-b-${t}@int.test`, verified: true },
    ])
    .returning();
  const alias = (
    await db
      .insert(aliases)
      .values({ userId: user.id, email: `irl-${t}@virtu.email`, mailboxId: mbA!.id })
      .returning()
  )[0]!;
  const contact = (
    await db
      .insert(contacts)
      .values({
        userId: user.id,
        aliasId: alias.id,
        websiteEmail: `sender-${t}@example.com`,
        replyEmail: `ra-${t}@virtu.email`,
      })
      .returning()
  )[0]!;
  return { user, alias, contact, mbA: mbA!, mbB: mbB! };
}

describe("countRecentInbound", () => {
  test("multi-mailbox copies count once per message for the alias, once per copy per mailbox", async () => {
    const f = await fixture();
    const now = new Date();
    // Three messages, each fanned out to both mailboxes (6 rows).
    for (let i = 0; i < 3; i++) {
      const messageId = `<m${i}-${tag()}@example.com>`;
      await db.insert(emailLogs).values([
        {
          userId: f.user.id,
          contactId: f.contact.id,
          aliasId: f.alias.id,
          mailboxId: f.mbA.id,
          messageId,
        },
        {
          userId: f.user.id,
          contactId: f.contact.id,
          aliasId: f.alias.id,
          mailboxId: f.mbB.id,
          messageId,
        },
      ]);
    }
    // One extra copy to mailbox A only, without a Message-ID (stands alone).
    await db.insert(emailLogs).values({
      userId: f.user.id,
      contactId: f.contact.id,
      aliasId: f.alias.id,
      mailboxId: f.mbA.id,
    });

    const counts = await countRecentInbound(
      db,
      { aliasId: f.alias.id, mailboxIds: [f.mbA.id, f.mbB.id] },
      now,
    );
    expect(counts.aliasMessages).toBe(4);
    expect(counts.mailboxCopiesMax).toBe(4); // A has 4 copies, B has 3
  });

  test("replies and rows older than a minute are outside the window", async () => {
    const f = await fixture();
    const now = new Date();
    await db.insert(emailLogs).values([
      // A reply from the alias: outbound, never inbound pressure.
      {
        userId: f.user.id,
        contactId: f.contact.id,
        aliasId: f.alias.id,
        mailboxId: f.mbA.id,
        isReply: true,
      },
      // Stale forward.
      {
        userId: f.user.id,
        contactId: f.contact.id,
        aliasId: f.alias.id,
        mailboxId: f.mbA.id,
        createdAt: new Date(now.getTime() - 61_000),
      },
      // Fresh forward.
      {
        userId: f.user.id,
        contactId: f.contact.id,
        aliasId: f.alias.id,
        mailboxId: f.mbA.id,
      },
    ]);
    const counts = await countRecentInbound(
      db,
      { aliasId: f.alias.id, mailboxIds: [f.mbA.id] },
      now,
    );
    expect(counts).toEqual({ aliasMessages: 1, mailboxCopiesMax: 1 });
  });

  test("empty mailbox set: mailbox scope is zero without a query", async () => {
    const f = await fixture();
    const counts = await countRecentInbound(db, { aliasId: f.alias.id, mailboxIds: [] });
    expect(counts).toEqual({ aliasMessages: 0, mailboxCopiesMax: 0 });
  });
});
