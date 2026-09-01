/**
 * Story M3 (PLAN Milestone 3 + ABUSE.md Tier 1): the bounce loop.
 *
 * Two regimes, split by the bounce's enhanced status code:
 *
 * 1. SUPPRESSION (first strike). Wes points an alias at a qmail localpart
 *    that doesn't exist. The very first forward is 550 5.1.1'd at RCPT —
 *    the mailbox itself is gone, so deliverd suppresses the MAILBOX
 *    outright: suppressed_at set, an in-app notification, and every later
 *    inbound to the alias is accept-and-dropped (250 at the edge, a
 *    blocked email_log with reason "mailbox_suppressed", nothing queued,
 *    nothing bounced back out). The alias itself stays ENABLED — the
 *    problem is the mailbox, and re-verifying it resumes every alias at
 *    once.
 *
 * 2. THRESHOLD (the SimpleLogin-style ledger). Bounces whose codes say
 *    nothing about the mailbox (policy rejections and other async DSNs)
 *    never suppress; they accumulate per (alias, mailbox) until
 *    should_disable trips (>12/24h) and the ALIAS is disabled. Driven here
 *    through the mx's async-DSN intake: forwards deliver fine, then fake
 *    RFC 3464 reports with Status: 5.7.1 arrive at each VERP return path.
 *
 * Assertions run against the DB (test-runner shares Postgres with the mail
 * service) plus Maildir presence/absence.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { aliases, emailLogs, mailboxes, notifications } from "../src/db/schema.ts";
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
import { findMail, getHeader } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

/** >12 bounces in 24h trips the daily threshold. */
const BOUNCES_TO_DISABLE = 13;

let fixture: UserFixture;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await waitForPort("mail.virtu.email", 25, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
});

async function sendFromMilton(to: string, subject: string, testId: string): Promise<void> {
  await smtpSend({
    host: milton.submission.host,
    port: milton.submission.port,
    from: milton.email,
    to,
    data: buildMessage({
      from: `Milton Waddams <${milton.email}>`,
      to,
      subject,
      testId,
    }),
  });
}

describe("Tier 1: first-strike mailbox suppression on 5.1.1", () => {
  test("one bounce pauses the mailbox; later mail drops, never bounces", async () => {
    // A mailbox whose qmail localpart does not exist: qmail 550 5.1.1s at
    // RCPT.
    const deadLocal = `dead-${randomTag()}`;
    const deadMailbox = await ensureMailbox(fixture.user.id, `${deadLocal}@qmail.com`);
    const alias = await createAlias(fixture, { mailboxId: deadMailbox.id });

    await sendFromMilton(alias.email, "first and only strike", newTestId());

    // FIRST bounce → the mailbox is suppressed (no threshold).
    await pollUntil(
      async () => {
        const rows = await db
          .select()
          .from(mailboxes)
          .where(eq(mailboxes.id, deadMailbox.id))
          .limit(1);
        return rows[0]?.suppressedAt != null;
      },
      { timeoutMs: 120_000, pollMs: 500, what: `mailbox ${deadMailbox.email} to suppress` },
    );

    // Exactly one bounce was ever recorded, and the ALIAS stays enabled —
    // the mailbox is the sick party, not the alias.
    const bounced = await db
      .select()
      .from(emailLogs)
      .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.bounced, true)));
    expect(bounced.length).toBe(1);
    expect((await getAlias(alias.id))?.enabled).toBe(true);

    // The user was told, in-app.
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.user.id));
    expect(notes.some((n) => (n.title ?? "").includes(deadMailbox.email))).toBe(true);

    // ── Post-suppression: accept-and-drop, never bounce ───────────────
    const dropId = newTestId();
    await sendFromMilton(alias.email, "into the paused mailbox", dropId);

    await pollUntil(
      async () => {
        const blocked = await db
          .select()
          .from(emailLogs)
          .where(
            and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.blockedReason, "mailbox_suppressed")),
          );
        return blocked.length > 0;
      },
      { timeoutMs: 60_000, what: "blocked mailbox_suppressed email_log" },
    );

    // No new bounce (the drop never reached qmail), no Maildir file, and
    // still just the one bounce row from the first strike.
    const bouncedAfter = await db
      .select()
      .from(emailLogs)
      .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.bounced, true)));
    expect(bouncedAfter.length).toBe(1);
    expect(await findMail(`${deadLocal}@qmail.com`, dropId)).toBeUndefined();
  }, 300_000);
});

describe("M3: threshold auto-disable on non-suppression codes", () => {
  test("13 async 5.7.1 DSNs disable the alias; the mailbox is untouched", async () => {
    // Forwards land in wes's LIVE mailbox; the "bounces" arrive later as
    // RFC 3464 reports against each forward's VERP return path — the async
    // path every real MTA uses when it accepted the mail first.
    const alias = await createAlias(fixture);

    const verps: string[] = [];
    for (let i = 0; i < BOUNCES_TO_DISABLE; i++) {
      const testId = newTestId();
      await sendFromMilton(alias.email, `late bounce fodder ${i + 1}`, testId);
      const delivered = await pollUntil(() => findMail(fixture.mailbox.email, testId), {
        timeoutMs: 120_000,
        pollMs: 500,
        what: `forward ${i + 1} in wes's Maildir`,
      });
      const returnPath = getHeader(delivered.raw, "Return-Path");
      const verp = returnPath?.replace(/^<|>$/g, "");
      if (!verp) throw new Error(`no Return-Path on forward ${i + 1}`);
      verps.push(verp);
    }

    for (const verp of verps) {
      await smtpSend({
        host: "mail.virtu.email",
        port: 25,
        from: "", // null reverse path, like a real reporting MTA
        to: verp,
        data: fakeDsn(verp, "5.7.1"),
      });
    }

    await pollUntil(
      async () => {
        const row = await getAlias(alias.id);
        return row !== undefined && !row.enabled;
      },
      { timeoutMs: 120_000, pollMs: 500, what: `alias ${alias.email} to auto-disable` },
    );

    // Threshold hit the ALIAS; a policy code says nothing about the
    // mailbox, so wes's real mailbox must NOT be suppressed.
    const mb = (
      await db.select().from(mailboxes).where(eq(mailboxes.id, fixture.mailbox.id)).limit(1)
    )[0]!;
    expect(mb.suppressedAt).toBeNull();

    const bounced = await db
      .select()
      .from(emailLogs)
      .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.bounced, true)));
    expect(bounced.length).toBe(BOUNCES_TO_DISABLE);
  }, 300_000);
});

/** A minimal RFC 3464 failure report addressed to one VERP return path. */
function fakeDsn(verpAddress: string, status: string): string {
  const boundary = `dsn-${randomTag()}`;
  return [
    `From: MAILER-DAEMON@qmail.com`,
    `To: <${verpAddress}>`,
    `Subject: Undelivered Mail Returned to Sender`,
    `Date: ${new Date().toUTCString()}`,
    `Auto-Submitted: auto-replied`,
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain`,
    ``,
    `The mail you sent could not be delivered (spam policy).`,
    ``,
    `--${boundary}`,
    `Content-Type: message/delivery-status`,
    ``,
    `Reporting-MTA: dns; mx.qmail.com`,
    ``,
    `Final-Recipient: rfc822; someone@qmail.com`,
    `Action: failed`,
    `Status: ${status}`,
    `Diagnostic-Code: smtp; 554 ${status} message refused by policy`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}
