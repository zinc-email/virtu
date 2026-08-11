/**
 * Story: real bounce messages (DSNs).
 *
 * Wes points an alias at a qmail localpart that doesn't exist. Milton mails
 * the alias; qmail 550s the forward at RCPT; deliverd marks the email_log
 * bounced AND composes an RFC 3464 multipart/report DSN back to Milton —
 * envelope MAIL FROM <> (null reverse path), From: MAILER-DAEMON@virtu.email,
 * DKIM-signed with the service key. Milton's Maildir receives it with the
 * original headers (including X-Virtu-Test-Id) in the text/rfc822-headers
 * part and a sanitized failure in the delivery-status part.
 *
 * Crucially, a forward bounce goes to the OUTSIDE sender, so it must name the
 * ALIAS as the failed recipient, never the real backing mailbox — and the
 * diagnostic must not echo the mailbox either. Leaking it would de-anonymize
 * the alias to anyone who can make a forward hard-bounce.
 *
 * A second doomed message to the same alias must NOT produce a second DSN:
 * DSNs are rate-limited per (user, sender, alias) through sent_alerts.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { emailLogs, sentAlerts } from "../src/db/schema.ts";
import {
  createAlias,
  ensureDkimKey,
  ensureMailbox,
  ensureWes,
  pollUntil,
  randomTag,
  type UserFixture,
} from "./fixtures.ts";
import { getHeader, getHeaders, listMail, type StoredMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton, type Persona } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

let fixture: UserFixture;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await waitForPort("mail.virtu.email", 25, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
});

/**
 * Find a DSN in a persona's Maildir. The original's X-Virtu-Test-Id lives in
 * the returned-headers PART (the DSN body), not the DSN's own header block,
 * so waitForMail can't see it — scan raw content instead and require the
 * MAILER-DAEMON originator so the original message itself never matches.
 */
async function findDsn(who: Persona, testId: string): Promise<StoredMail | undefined> {
  for (const path of await listMail(who)) {
    let raw: Buffer;
    try {
      raw = await Bun.file(path).bytes().then(Buffer.from);
    } catch {
      continue; // renamed mid-scan; next poll sees it
    }
    if (!raw.toString("latin1").includes(`X-Virtu-Test-Id: ${testId}`)) continue;
    if (!(getHeader(raw, "From") ?? "").includes("MAILER-DAEMON")) continue;
    return { path, raw };
  }
  return undefined;
}

describe("story: DSN on permanent forward failure", () => {
  test("milton gets a signed multipart/report DSN with the 550 detail", async () => {
    // A mailbox whose qmail localpart does not exist: qmail 550s at RCPT.
    const deadLocal = `dead-${randomTag()}`;
    const deadMailbox = await ensureMailbox(fixture.user.id, `${deadLocal}@qmail.com`);
    const alias = await createAlias(fixture, { mailboxId: deadMailbox.id });

    const testId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "Have you seen my stapler",
        testId,
      }),
    });

    const dsn = await pollUntil(() => findDsn(milton, testId), {
      timeoutMs: 120_000,
      pollMs: 500,
      what: `DSN for ${testId} in milton's Maildir`,
    });
    const { raw } = dsn;
    const text = raw.toString("latin1");

    // ── The DSN's own headers ─────────────────────────────────────────
    expect(getHeader(raw, "Subject")).toBe("Undelivered Mail Returned to Sender");
    expect(getHeader(raw, "From")).toContain("MAILER-DAEMON@virtu.email");
    expect(getHeader(raw, "To")).toContain(milton.email);
    expect(getHeader(raw, "Auto-Submitted")).toBe("auto-replied");
    const contentType = getHeader(raw, "Content-Type")!;
    expect(contentType).toContain("multipart/report");
    expect(contentType).toContain("report-type=delivery-status");

    // Null reverse path on the wire — recorded by initech's MTA.
    expect(getHeader(raw, "Return-Path")).toBe("<>");

    // ── delivery-status part: the machine-readable failure, in terms of
    //    the ALIAS (never the backing mailbox) ─────────────────────────
    expect(text).toContain("Reporting-MTA: dns; mail.virtu.email");
    expect(text).toContain(`Final-Recipient: rfc822; ${alias.email}`);
    expect(text).toContain("Action: failed");
    expect(text).toMatch(/Status: 5\.\d{1,3}\.\d{1,3}/);
    expect(text).toContain("Diagnostic-Code: smtp;");
    expect(text).toContain("the recipient's mail server rejected the message");

    // ── the real backing mailbox must NEVER leak to the outside sender ─
    expect(text).not.toContain(deadMailbox.email);
    expect(text).not.toContain(deadLocal);

    // ── returned headers: the original is correlatable ────────────────
    expect(text).toContain(`X-Virtu-Test-Id: ${testId}`);
    expect(text).toContain("Subject: Have you seen my stapler");

    // ── signed by us, verified at initech ─────────────────────────────
    const initechAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.initech.com"))
      .join("\n");
    expect(initechAuth).toContain("dkim=pass");
    expect(initechAuth.toLowerCase()).toContain("header.d=virtu.email");

    // ── bounce accounting still ran ───────────────────────────────────
    const bounced = await db
      .select()
      .from(emailLogs)
      .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.bounced, true)));
    expect(bounced.length).toBe(1);
    expect(bounced[0]!.bouncedAt).not.toBeNull();

    // ── rate limit: a second failure gets no second DSN ───────────────
    const secondId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "Doomed again",
        testId: secondId,
      }),
    });
    await pollUntil(
      async () => {
        const rows = await db
          .select({ id: emailLogs.id })
          .from(emailLogs)
          .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.bounced, true)));
        return rows.length >= 2;
      },
      { timeoutMs: 120_000, pollMs: 500, what: "second bounce to be recorded" },
    );
    // The DSN claim happens right after the bounce is recorded; give the
    // pipeline a beat, then assert the claim ledger held at one.
    await Bun.sleep(3_000);
    const claims = await db
      .select()
      .from(sentAlerts)
      .where(
        and(
          eq(sentAlerts.userId, fixture.user.id),
          eq(sentAlerts.toEmail, milton.email),
          eq(sentAlerts.alertType, `dsn_bounce_forward_${alias.id}`),
        ),
      );
    expect(claims.length).toBe(1);
    expect(await findDsn(milton, secondId)).toBeUndefined();
  }, 300_000);
});
