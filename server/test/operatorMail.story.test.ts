/**
 * Operator mail (pipeline/operatorMail.ts): Milton writes to
 * postmaster@virtu.email — a role address that is nobody's alias — and the
 * copy lands in the opted-in operator's real mailbox, DMARC-aligned on our
 * domain (dkim=pass header.d=virtu.email at qmail), with the original
 * sender preserved for reply and the role stamped in a provenance header.
 * The copy rides the null reverse path: an operator's dead mailbox must
 * never bounce a complaint back at its reporter.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { USER_FLAGS } from "../src/auth/userFlags.ts";
import { db } from "../src/db/index.ts";
import { users } from "../src/db/schema.ts";
import { ensureDkimKey, ensureWes, type UserFixture } from "./fixtures.ts";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

let fixture: UserFixture;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await waitForPort("mail.virtu.email", 25, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
  // Wes is an operator who opted in to operator mail (idempotent: the flag
  // bits are OR'd, and every other story is indifferent to them).
  await db
    .update(users)
    .set({ flags: fixture.user.flags | USER_FLAGS.admin | USER_FLAGS.operatorMail })
    .where(eq(users.id, fixture.user.id));
});

describe("operator mail", () => {
  test("postmaster@virtu.email → the opted-in operator's mailbox, aligned on our domain", async () => {
    const testId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: "postmaster@virtu.email",
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: "postmaster@virtu.email",
        subject: "Your server is mailing my stapler",
        testId,
        body: "Please look into it.",
      }),
    });

    const { raw } = await waitForMail(wes, testId, { timeoutMs: 60_000 });

    // From is ours (alignment), Milton legible in the display name, and the
    // real sender kept in Reply-To so the operator can answer directly.
    const from = getHeader(raw, "From");
    expect(from).toContain("<postmaster@virtu.email>");
    expect(from).toContain("milton at initech.com");
    expect(getHeader(raw, "Reply-To")).toContain("milton@initech.com");
    expect(getHeader(raw, "To")).toContain("postmaster@virtu.email");
    expect(getHeader(raw, "X-Virtu-Operator-Mail")).toBe("postmaster");
    expect(getHeader(raw, "Subject")).toBe("Your server is mailing my stapler");

    // Signed by us and verified by qmail.
    const dkimSigs = getHeaders(raw, "DKIM-Signature").join("\n");
    expect(dkimSigs).toContain("d=virtu.email");
    const qmailAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.qmail.com"))
      .join("\n");
    expect(qmailAuth).toContain("dkim=pass");
    expect(qmailAuth.toLowerCase()).toContain("header.d=virtu.email");

    // Null reverse path: never bounce a complaint back at its reporter.
    const returnPath = getHeader(raw, "Return-Path");
    if (returnPath !== undefined) expect(returnPath).toBe("<>");
  }, 90_000);
});
