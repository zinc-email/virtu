/**
 * Story: multi-mailbox delivery. An alias associated with several mailboxes
 * (primary + alias_mailboxes extras) delivers ONE COPY PER MAILBOX, each
 * with its own email_log (bounce accounting stays per-mailbox) and its own
 * VERP envelope.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { aliasMailboxes, emailLogs } from "../src/db/schema.ts";
import {
  createAlias,
  ensureDkimKey,
  ensureMailbox,
  ensureWes,
  pollUntil,
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
});
