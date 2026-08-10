/**
 * Story: real transactional mail through our own pipeline. A brand-new
 * (unactivated) user signed up with Wes's qmail address; the activation
 * email is built, DKIM-signed and queued by `sendTransactional`, drained by
 * deliverd on the mail box, and lands in Wes's qmail Maildir with:
 *
 *   - a `transactional`-type VERP envelope sender (vt.*@virtu.email) that
 *     parses back to the verification-code row id,
 *   - our DKIM signature, verified by qmail (dkim=pass, header.d=virtu.email),
 *   - SPF pass for the VERP envelope sender @virtu.email,
 *   - X-Virtu-Type: Transactional provenance,
 *   - the 6-digit code in the body — which then activates the account,
 *     exactly as a user reading their inbox would.
 *
 * The trigger is a direct `sendTransactional` from the test-runner against
 * the shared DB (no api service runs in the test net); the HTTP routes over
 * the same helpers are covered by the int tier.
 *
 * Run from the test-runner: just test-story (or bun test story.test inside it).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config.ts";
import { db } from "../src/db/index.ts";
import { mailboxes, notifications, users, verificationCodes } from "../src/db/schema.ts";
import { parseVerp } from "../src/mail/index.ts";
import {
  accountActivationEmail,
  consumeVerificationCode,
  createVerificationCode,
  extractCodeFromBody,
  hashVerificationCode,
  sendTransactional,
} from "../src/pipeline/transactional.ts";
import { ensureDkimKey, ensureMailbox, pollUntil, randomTag } from "./fixtures.ts";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { wes } from "./personas.ts";
import { waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

beforeAll(async () => {
  // deliverd hands the message to qmail's MX; wait for the peer to be up.
  await waitForPort("mail.qmail.com", 25, 60_000);
  await ensureDkimKey();
});

describe("transactional", () => {
  test("activation email: queued here, delivered by deliverd, code activates", async () => {
    // A fresh unactivated user whose mailbox is Wes's real qmail address.
    const [user] = await db
      .insert(users)
      .values({
        email: `wes.activation.${randomTag()}@qmail.com`,
        name: "Wes (activation story)",
        passwordHash: "story-test-never-logs-in",
        activated: false,
      })
      .returning();
    expect(user).toBeDefined();

    const { code, row } = await createVerificationCode(db, {
      userId: user!.id,
      purpose: "account",
    });
    const { subject, textBody } = accountActivationEmail(code);
    const testId = newTestId();

    const sent = await sendTransactional(db, {
      to: wes.email,
      subject,
      textBody,
      testId,
      refId: row.id,
    });
    expect(sent.queued).toBe(true);

    const { raw } = await waitForMail(wes, testId, { timeoutMs: 60_000 });

    // Envelope: a transactional VERP sender on our domain that round-trips
    // to the verification-code row (same secret as the mail box).
    const returnPath = getHeader(raw, "Return-Path");
    expect(returnPath).toBeDefined();
    expect(returnPath!).toMatch(/^<vt\.[a-z2-7]+\.[a-z2-7]+@virtu\.email>$/);
    const verp = parseVerp(returnPath!.slice(1, -1), config.verpSecret);
    expect(verp).toEqual({ type: "transactional", id: row.id });

    // qmail verified our DKIM signature and the VERP sender's SPF.
    const qmailAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.qmail.com"))
      .join("\n");
    expect(qmailAuth).toContain("dkim=pass");
    expect(qmailAuth.toLowerCase()).toContain("header.d=virtu.email");
    const spf = getHeader(raw, "X-Received-SPF") ?? getHeader(raw, "Received-SPF");
    expect(spf).toBeDefined();
    expect(spf!.toLowerCase()).toMatch(/^pass/);

    // Message shape: noreply sender, provenance, plain text.
    expect(getHeader(raw, "From")).toContain("noreply@virtu.email");
    expect(getHeader(raw, "Subject")).toBe("Just one more step to join Virtu");
    expect(getHeader(raw, "X-Virtu-Type")).toBe("Transactional");
    expect(getHeader(raw, "X-Virtu-Test-Id")).toBe(testId);
    expect(getHeader(raw, "Content-Type")).toContain("text/plain");

    // The code Wes reads out of his inbox is the one we minted...
    const text = raw.toString("utf-8");
    const bodyStart = text.search(/\r?\n\r?\n/);
    const received = extractCodeFromBody(text.slice(bodyStart));
    expect(received).toBe(code);
    expect(hashVerificationCode(received!)).toBe(row.codeHash);

    // ...and it activates the account (single-use).
    const consumed = await consumeVerificationCode(db, {
      userId: user!.id,
      purpose: "account",
      code: received!,
      toEmail: wes.email,
    });
    expect(consumed).toBe("ok");
    await db.update(users).set({ activated: true }).where(eq(users.id, user!.id));

    const [codeRow] = await db
      .select()
      .from(verificationCodes)
      .where(eq(verificationCodes.id, row.id))
      .limit(1);
    expect(codeRow?.usedAt).not.toBeNull();
    const [activated] = await db.select().from(users).where(eq(users.id, user!.id)).limit(1);
    expect(activated?.activated).toBe(true);
  }, 120_000);

  test("a bounced verification email invalidates its code (transactional intake)", async () => {
    // Mailbox verification sent to a qmail localpart that does not exist:
    // qmail answers 550 at RCPT, deliverd classifies it permanent, and the
    // transactional VERP resolves back to the code row — which dies, with
    // the mailbox's failed-check counter bumped.
    const [user] = await db
      .insert(users)
      .values({
        email: `wes.bounce.${randomTag()}@qmail.com`,
        name: "Wes (bounce story)",
        passwordHash: "story-test-never-logs-in",
        activated: true,
      })
      .returning();
    expect(user).toBeDefined();

    const deadAddress = `nobody.${randomTag()}@qmail.com`;
    const mailbox = await ensureMailbox(user!.id, deadAddress);

    const { code, row } = await createVerificationCode(db, {
      userId: user!.id,
      purpose: "mailbox",
      mailboxId: mailbox.id,
    });
    expect(code).toHaveLength(6);

    const sent = await sendTransactional(db, {
      to: deadAddress,
      subject: "Please confirm your mailbox",
      textBody: `code:\n\n${code}\n`,
      testId: newTestId(),
      refId: row.id,
    });
    expect(sent.queued).toBe(true);

    // The failure propagates: code invalidated, mailbox flagged, user told.
    const deadCode = await pollUntil(
      async () => {
        const [r] = await db
          .select()
          .from(verificationCodes)
          .where(eq(verificationCodes.id, row.id))
          .limit(1);
        return r?.usedAt != null ? r : undefined;
      },
      { timeoutMs: 90_000, what: `verification code ${row.id} invalidated by bounce` },
    );
    expect(deadCode.usedAt).not.toBeNull();

    const [flagged] = await db
      .select()
      .from(mailboxes)
      .where(eq(mailboxes.id, mailbox.id))
      .limit(1);
    expect(flagged!.nbFailedChecks).toBeGreaterThanOrEqual(1);

    const alerts = await db.select().from(notifications).where(eq(notifications.userId, user!.id));
    expect(alerts.some((n) => n.title?.includes(deadAddress))).toBe(true);
  }, 120_000);
});
