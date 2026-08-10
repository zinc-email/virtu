/**
 * Story: the trash inbox. A user designates one mailbox as trash; mail for
 * any disabled ("off") alias is delivered THERE — marked X-Virtu-Trash —
 * instead of being silently dropped. The sender still sees plain 250s
 * (existence is never probed), and without a trash mailbox the old
 * accept-and-drop behavior stands (policy.story.test.ts covers that side).
 *
 * Parallel-safety: a per-run user (unique email) owns the trash setting, so
 * flipping it can never disturb Wes's accept-and-drop stories running
 * alongside. Deliveries land in the shared test@qmail.com Maildir and are
 * found by X-Virtu-Test-Id like all story mail.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { emailLogs, users } from "../src/db/schema.ts";
import {
  createAlias,
  ensureDkimKey,
  ensureMailbox,
  ensureUser,
  getAlias,
  pollUntil,
  randomTag,
  type UserFixture,
} from "./fixtures.ts";
import { getHeader, waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

/** Shared deliverable inbox used as this run's trash destination. */
const TRASH_INBOX = "test@qmail.com";

let fixture: UserFixture;
let trashMailboxId: number;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await ensureDkimKey();
  // A per-run user so the trash designation is ours alone.
  fixture = await ensureUser(`trash-user.${randomTag()}@qmail.com`, "trash-story-password-1");
  const trashMailbox = await ensureMailbox(fixture.user.id, TRASH_INBOX);
  trashMailboxId = trashMailbox.id;
  await db
    .update(users)
    .set({ trashMailboxId: trashMailbox.id })
    .where(eq(users.id, fixture.user.id));
});

describe("trash inbox", () => {
  test("mail for a disabled alias forwards to the trash mailbox, marked", async () => {
    const alias = await createAlias(fixture, { enabled: false, prefix: "off" });
    const testId = newTestId();

    // Milton sends to the off alias; his MTA sees a clean 250 accept.
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "To an off alias",
        testId,
      }),
    });

    // The message lands in the TRASH inbox, marked for mailbox-side filters,
    // fully rewritten like any forward (From = a reverse alias, no real
    // addresses beyond the trash destination itself).
    const { raw } = await waitForMail(TRASH_INBOX, testId, { timeoutMs: 60_000 });
    expect(getHeader(raw, "X-Virtu-Trash")).toBe("YES (alias disabled)");
    const from = getHeader(raw, "From")!;
    expect(from).toContain("@virtu.email");
    expect(from).not.toContain(milton.email);

    // Logged as a real delivery into the trash mailbox, not a blocked drop.
    const log = await pollUntil(
      async () =>
        (
          await db
            .select()
            .from(emailLogs)
            .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.mailboxId, trashMailboxId)))
            .limit(1)
        )[0],
      { what: `email_log for trash delivery of alias ${alias.id}` },
    );
    expect(log.blocked).toBe(false);

    // The alias itself stays off.
    expect((await getAlias(alias.id))?.enabled).toBe(false);
  }, 120_000);

  test("an enabled alias of the same user still delivers to its own mailbox", async () => {
    // Guard: trash routing must never siphon ON-alias mail. The user's
    // default mailbox is their own (undeliverable) address, so we point the
    // alias at the trash-adjacent deliverable inbox explicitly and assert
    // the copy arrives unmarked.
    const alias = await createAlias(fixture, { mailboxId: trashMailboxId, prefix: "on" });
    const testId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: milton.email,
        to: alias.email,
        subject: "To an on alias",
        testId,
      }),
    });
    const { raw } = await waitForMail(TRASH_INBOX, testId, { timeoutMs: 60_000 });
    expect(getHeader(raw, "X-Virtu-Trash")).toBeUndefined();
  }, 120_000);
});
