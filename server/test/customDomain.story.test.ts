/**
 * Stretch story (milestone 4 preview): Wes's custom domain user.com.
 *
 * The test zone already gives user.com an MX at mail.virtu.email and SPF
 * delegated to spf1.virtu.email — exactly what onboarding docs would tell a
 * customer. With a verified custom_domains row and an alias on it, the
 * forward path works unchanged: Milton mails wes.{tag}@user.com, it lands
 * in Wes's qmail Maildir, rewritten and signed.
 *
 * MVP limits (documented, asserted here as-is): forwards are signed with
 * the service-domain key (d=virtu.email), and reverse aliases are minted on
 * the service domain — per-custom-domain DKIM is milestone 4+.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
  createAlias,
  ensureCustomDomain,
  ensureDkimKey,
  ensureWes,
  type UserFixture,
} from "./fixtures.ts";
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
});

describe("stretch: custom domain user.com", () => {
  test("milton -> wes.{tag}@user.com forwards into wes@qmail.com", async () => {
    const domain = await ensureCustomDomain(fixture.user.id, "user.com");
    const alias = await createAlias(fixture, { domain: "user.com", customDomainId: domain.id });
    const testId = newTestId();

    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "To your own domain",
        testId,
      }),
    });

    const { raw } = await waitForMail(wes, testId, { timeoutMs: 60_000 });

    // Rewritten From: reverse alias (service domain for MVP), Milton in the
    // display name only.
    const from = getHeader(raw, "From");
    expect(from).toBeDefined();
    expect(from!).toMatch(/<milton_at_initech_com_[a-z0-9]{8}@virtu\.email>/);

    // The custom-domain alias stays visible in To.
    expect(getHeader(raw, "To")).toContain(alias.email);

    // Signed by us; verified at qmail.
    const qmailAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.qmail.com"))
      .join("\n");
    expect(qmailAuth).toContain("dkim=pass");

    // SPF pass for the VERP envelope (minted on the service domain).
    const spf = getHeader(raw, "X-Received-SPF") ?? getHeader(raw, "Received-SPF");
    expect(spf).toBeDefined();
    expect(spf!.toLowerCase()).toMatch(/^pass/);

    expect(getHeader(raw, "X-Virtu-Type")).toBe("Forward");
    expect(getHeader(raw, "X-Virtu-Envelope-To")).toBe(alias.email);
  }, 120_000);
});
