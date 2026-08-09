/**
 * Story M3 (PLAN Milestone 3): the bounce loop.
 *
 * Wes points an alias at a qmail localpart that doesn't exist. Every
 * forward is 550'd by qmail at RCPT, deliverd marks the email_log bounced
 * (via the VERP-encoded id), and once the >12-bounces-in-24h threshold
 * trips, the alias is auto-disabled with a deduped notification. Mail to
 * the now-disabled alias gets accept-and-drop: 250 at the edge, a blocked
 * email_log, nothing queued, nothing delivered.
 *
 * Assertions run against the DB (test-runner shares Postgres with the mail
 * service) plus Maildir absence.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { config } from "../src/config.ts";
import { db } from "../src/db/index.ts";
import { emailLogs, notifications, outboundMessages, sentAlerts } from "../src/db/schema.ts";
import { parseVerp } from "../src/mail/index.ts";
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
import { findMail } from "./maildir.ts";
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

describe("M3: bounce loop", () => {
  test("bounces mark email_logs, trip auto-disable, then accept-and-drop", async () => {
    // A mailbox whose qmail localpart does not exist: qmail 550s at RCPT.
    const deadLocal = `dead-${randomTag()}`;
    const deadMailbox = await ensureMailbox(fixture.user.id, `${deadLocal}@qmail.com`);
    const alias = await createAlias(fixture, { mailboxId: deadMailbox.id });

    // ── Loop to the threshold ─────────────────────────────────────────
    for (let i = 0; i < BOUNCES_TO_DISABLE; i++) {
      await smtpSend({
        host: milton.submission.host,
        port: milton.submission.port,
        from: milton.email,
        to: alias.email,
        data: buildMessage({
          from: `Milton Waddams <${milton.email}>`,
          to: alias.email,
          subject: `bounce fodder ${i + 1}`,
          testId: newTestId(),
        }),
      });
    }

    // The 13th recorded bounce must disable the alias.
    await pollUntil(
      async () => {
        const row = await getAlias(alias.id);
        return row !== undefined && !row.enabled;
      },
      { timeoutMs: 180_000, pollMs: 500, what: `alias ${alias.email} to auto-disable` },
    );

    // Every forward was logged and marked bounced (blocked drops excluded).
    const bounced = await db
      .select()
      .from(emailLogs)
      .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.bounced, true)));
    expect(bounced.length).toBe(BOUNCES_TO_DISABLE);
    for (const log of bounced) expect(log.bouncedAt).not.toBeNull();

    // The disable produced exactly one deduped alert + notification.
    const alerts = await db
      .select()
      .from(sentAlerts)
      .where(
        and(
          eq(sentAlerts.userId, fixture.user.id),
          eq(sentAlerts.alertType, `bounce_disabled_alias_${alias.id}`),
        ),
      );
    expect(alerts.length).toBe(1);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, fixture.user.id));
    expect(notes.some((n) => n.message.includes(alias.email))).toBe(true);

    // ── Post-disable: accept-and-drop ─────────────────────────────────
    const outboundBefore = await countOutboundForAlias(alias.id);
    const dropId = newTestId();
    // Still accepted end-to-end (250 at initech means our mx said 250).
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "into the void",
        testId: dropId,
      }),
    });

    // A blocked email_log appears...
    await pollUntil(
      async () => {
        const blocked = await db
          .select()
          .from(emailLogs)
          .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.blocked, true)));
        return blocked.length > 0;
      },
      { timeoutMs: 60_000, what: "blocked email_log for the dropped mail" },
    );

    // ...but nothing new was queued for this alias, and no Maildir file
    // ever appears for the dead mailbox.
    expect(await countOutboundForAlias(alias.id)).toBe(outboundBefore);
    expect(await findMail(`${deadLocal}@qmail.com`, dropId)).toBeUndefined();

    // The queue rows for the bounced forwards all ended in failed.
    const rows = await outboundForAlias(alias.id);
    expect(rows.length).toBe(BOUNCES_TO_DISABLE);
    for (const row of rows) {
      expect(row.status).toBe("failed");
      expect(row.lastError ?? "").toContain("550");
    }
  }, 300_000);
});

/** Outbound queue rows whose VERP envelope maps to this alias's email logs. */
async function outboundForAlias(aliasId: number) {
  const logs = await db
    .select({ id: emailLogs.id })
    .from(emailLogs)
    .where(eq(emailLogs.aliasId, aliasId));
  const logIds = new Set(logs.map((l) => l.id));
  if (logIds.size === 0) return [];
  // Queue rows don't reference logs directly — the VERP localpart does.
  // (Columns only — never drag every queued message's raw bytes over.)
  const recent = await db
    .select({
      id: outboundMessages.id,
      envelopeFrom: outboundMessages.envelopeFrom,
      status: outboundMessages.status,
      lastError: outboundMessages.lastError,
    })
    .from(outboundMessages);
  return recent.filter((row) => {
    const verp = parseVerp(row.envelopeFrom, config.verpSecret);
    return verp !== null && verp.type === "bounce_forward" && logIds.has(verp.id);
  });
}

async function countOutboundForAlias(aliasId: number): Promise<number> {
  return (await outboundForAlias(aliasId)).length;
}
