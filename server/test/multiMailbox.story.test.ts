/**
 * Story: multi-mailbox delivery. An alias associated with several mailboxes
 * (primary + alias_mailboxes extras) delivers ONE COPY PER MAILBOX, each
 * with its own email_log (bounce accounting stays per-mailbox) and its own
 * VERP envelope.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { aliasMailboxes, emailLogs, mailboxes } from "../src/db/schema.ts";
import {
  createAlias,
  ensureDkimKey,
  ensureMailbox,
  ensureWes,
  getAlias,
  pollUntil,
  randomTag,
  type UserFixture,
} from "./fixtures.ts";
import { getHeader, waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

/** Second deliverable qmail inbox (see docker vmailbox). */
const SECOND_INBOX = "new@qmail.com";

let fixture: UserFixture;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
});

describe("multi-mailbox delivery", () => {
  test("one inbound message fans out to every mailbox of the alias", async () => {
    const alias = await createAlias(fixture);
    const second = await ensureMailbox(fixture.user.id, SECOND_INBOX);
    await db
      .insert(aliasMailboxes)
      .values({ aliasId: alias.id, mailboxId: second.id })
      .onConflictDoNothing();

    const testId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "One send, two inboxes",
        testId,
      }),
    });

    // The same message (same test id) lands in BOTH real inboxes.
    const [primary, extra] = await Promise.all([
      waitForMail(wes, testId, { timeoutMs: 60_000 }),
      waitForMail(SECOND_INBOX, testId, { timeoutMs: 60_000 }),
    ]);

    // Each copy went through the full forward rewrite.
    for (const { raw } of [primary, extra]) {
      const from = getHeader(raw, "From")!;
      expect(from).toContain("@virtu.email");
      expect(from).not.toContain(milton.email);
    }

    // One email_log per mailbox — separate VERPs, separate bounce ledgers.
    const logs = await pollUntil(
      async () => {
        const rows = await db
          .select()
          .from(emailLogs)
          .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.isReply, false)));
        return rows.length >= 2 ? rows : undefined;
      },
      { what: `two email_logs for alias ${alias.id}` },
    );
    const mailboxIds = new Set(logs.map((l) => l.mailboxId));
    expect(mailboxIds.has(fixture.mailbox.id)).toBe(true);
    expect(mailboxIds.has(second.id)).toBe(true);
  }, 120_000);

  test("a dead extra mailbox suppresses on its FIRST bounce; the alias survives", async () => {
    // ABUSE.md Tier 1: a nonexistent qmail localpart 550 5.1.1s the dead
    // copy, and one strike suppresses that MAILBOX. The healthy primary
    // keeps receiving; the dead extra stays a member of the alias (unlike
    // the old detach-at-threshold) but is excluded from the delivery set
    // until the user re-verifies it. (Threshold detach still exists for
    // non-suppression bounce codes — pinned in pipeline/bounce.int.test.ts.)
    const alias = await createAlias(fixture);
    const dead = await ensureMailbox(fixture.user.id, `nobody.${randomTag()}@qmail.com`);
    await db
      .insert(aliasMailboxes)
      .values({ aliasId: alias.id, mailboxId: dead.id })
      .onConflictDoNothing();

    // One send: the primary's copy delivers, the dead copy 550s.
    const firstId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: milton.email,
        to: alias.email,
        subject: "First strike on the dead extra",
        testId: firstId,
      }),
    });
    await waitForMail(wes, firstId, { timeoutMs: 60_000 });

    // The dead mailbox suppresses on that single bounce.
    await pollUntil(
      async () => {
        const rows = await db.select().from(mailboxes).where(eq(mailboxes.id, dead.id)).limit(1);
        return rows[0]?.suppressedAt != null;
      },
      { timeoutMs: 120_000, what: `dead mailbox ${dead.id} to suppress` },
    );

    // Alias enabled, primary untouched, dead extra STILL attached (paused,
    // not removed — resuming is a re-verify away, not a re-add).
    const after = await getAlias(alias.id);
    expect(after?.enabled).toBe(true);
    expect(after?.mailboxId).toBe(fixture.mailbox.id);
    const attached = await db
      .select({ id: aliasMailboxes.id })
      .from(aliasMailboxes)
      .where(and(eq(aliasMailboxes.aliasId, alias.id), eq(aliasMailboxes.mailboxId, dead.id)));
    expect(attached).toHaveLength(1);

    // A second send fans out to the PRIMARY ONLY: one new email_log, none
    // for the suppressed extra, and exactly the one original bounce.
    const secondId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: milton.email,
        to: alias.email,
        subject: "Primary only now",
        testId: secondId,
      }),
    });
    await waitForMail(wes, secondId, { timeoutMs: 60_000 });

    const deadLogs = await db
      .select({ id: emailLogs.id, bounced: emailLogs.bounced })
      .from(emailLogs)
      .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.mailboxId, dead.id)));
    expect(deadLogs).toHaveLength(1); // only the first strike ever targeted it
    expect(deadLogs[0]!.bounced).toBe(true);
  }, 300_000);
});
