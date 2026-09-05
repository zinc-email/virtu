/**
 * recordBounce threshold behavior against the dockerized Postgres — the
 * detach-vs-disable decision table that used to ride the multi-mailbox
 * story's qmail 550 loop. First-strike suppression (5.1.1/5.2.1) now
 * preempts that loop in the stories, but the threshold path stays live for
 * bounces WITHOUT suppression codes (async DSNs with policy codes etc.), so
 * it is pinned here: 13 bounces on a (alias, mailbox) ledger detach a dead
 * extra when a healthy survivor remains, disable the alias when none does —
 * and a suppressed mailbox is never a survivor.
 *
 * Parallel-safe: every test builds its own user/alias/mailboxes with
 * unique addresses; nothing is truncated.
 */

import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { aliases, aliasMailboxes, contacts, emailLogs, mailboxes, users } from "../db/schema.ts";
import { recordBounce } from "./bounce.ts";

const tag = () => crypto.randomUUID().slice(0, 8);

async function fixture(opts: { primarySuppressed?: boolean } = {}) {
  const t = tag();
  const user = (
    await db
      .insert(users)
      .values({ email: `bounce-int-${t}@int.test`, activated: true })
      .returning()
  )[0]!;
  const primary = (
    await db
      .insert(mailboxes)
      .values({
        userId: user.id,
        email: `primary-${t}@int.test`,
        verified: true,
        suppressedAt: opts.primarySuppressed ? new Date() : null,
      })
      .returning()
  )[0]!;
  const extra = (
    await db
      .insert(mailboxes)
      .values({ userId: user.id, email: `extra-${t}@int.test`, verified: true })
      .returning()
  )[0]!;
  const alias = (
    await db
      .insert(aliases)
      .values({ userId: user.id, email: `alias-${t}@virtu.email`, mailboxId: primary.id })
      .returning()
  )[0]!;
  await db.insert(aliasMailboxes).values({ aliasId: alias.id, mailboxId: extra.id });
  const contact = (
    await db
      .insert(contacts)
      .values({
        userId: user.id,
        aliasId: alias.id,
        websiteEmail: `sender-${t}@ext.test`,
        replyEmail: `ra+${t}@virtu.email`,
      })
      .returning()
  )[0]!;
  return { user, primary, extra, alias, contact };
}

/** 13 bounced forward logs on (alias, mailbox); returns the 13th's id. */
async function bounceToThreshold(f: Awaited<ReturnType<typeof fixture>>, mailboxId: number) {
  let lastId = 0;
  for (let i = 0; i < 13; i++) {
    const log = (
      await db
        .insert(emailLogs)
        .values({
          userId: f.user.id,
          contactId: f.contact.id,
          aliasId: f.alias.id,
          mailboxId,
        })
        .returning()
    )[0]!;
    lastId = log.id;
    await recordBounce(db, log.id);
  }
  return lastId;
}

describe("recordBounce thresholds (non-suppression bounce codes)", () => {
  test("dead extra with a healthy primary: detached at 13, alias survives", async () => {
    const f = await fixture();
    await bounceToThreshold(f, f.extra.id);

    const join = await db
      .select()
      .from(aliasMailboxes)
      .where(and(eq(aliasMailboxes.aliasId, f.alias.id), eq(aliasMailboxes.mailboxId, f.extra.id)));
    expect(join).toHaveLength(0);
    const alias = (await db.select().from(aliases).where(eq(aliases.id, f.alias.id)))[0]!;
    expect(alias.enabled).toBe(true);
    expect(alias.mailboxId).toBe(f.primary.id);
  });

  test("dead extra whose only other mailbox is SUPPRESSED: no detach — alias disabled", async () => {
    // A suppressed survivor would leave an enabled alias that silently
    // drops everything; the decision table must fall through to disable.
    const f = await fixture({ primarySuppressed: true });
    await bounceToThreshold(f, f.extra.id);

    const alias = (await db.select().from(aliases).where(eq(aliases.id, f.alias.id)))[0]!;
    expect(alias.enabled).toBe(false);
    const join = await db
      .select()
      .from(aliasMailboxes)
      .where(and(eq(aliasMailboxes.aliasId, f.alias.id), eq(aliasMailboxes.mailboxId, f.extra.id)));
    expect(join).toHaveLength(1); // still attached: disable, not detach
  });

  test("dead primary with a healthy extra: extra promoted to primary", async () => {
    const f = await fixture();
    await bounceToThreshold(f, f.primary.id);

    const alias = (await db.select().from(aliases).where(eq(aliases.id, f.alias.id)))[0]!;
    expect(alias.enabled).toBe(true);
    expect(alias.mailboxId).toBe(f.extra.id);
  });
});
