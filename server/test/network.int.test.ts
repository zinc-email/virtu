/**
 * Smoke story for the simulated internet itself — no virtu server involved.
 *
 * Milton (legit outsider at Initech) mails Wes's real mailbox at qmail.com
 * through Initech's own submission port. If this passes, the whole world
 * works: fake DNS answers MX/SPF/DKIM/DMARC lookups, peers route mail to
 * each other, Initech DKIM-signs outbound, qmail runs policyd-spf +
 * opendkim + opendmarc on inbound, Maildir delivery lands one file per
 * message, and the test-id harness finds it in dirty shared state.
 *
 * Run from the test-runner service:
 *   docker compose -f docker-compose.test.yml exec test-runner bun test test/
 */

import { describe, expect, test } from "bun:test";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

describe("simulated internet", () => {
  test(
    "milton@initech.com reaches wes@qmail.com with SPF/DKIM/DMARC evaluated",
    async () => {
      const testId = newTestId();

      // Peers may still be booting right after `up`.
      await waitForPort(milton.submission.host, milton.submission.port, 60_000);

      await smtpSend({
        host: milton.submission.host,
        port: milton.submission.port,
        from: milton.email,
        to: wes.email,
        data: [
          `From: Milton Waddams <${milton.email}>`,
          `To: <${wes.email}>`,
          "Subject: TPS Reports",
          `Date: ${new Date().toUTCString()}`,
          `Message-ID: <${testId}@initech.com>`,
          `X-Virtu-Test-Id: ${testId}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain",
          "",
          "Heyyy Peter,",
          "",
          "Yeahhh, did you get the memo? We're putting cover pages on all the",
          "TPS reports now. I'll make sure you get another copy of that memo.",
          "",
          ". <- also proves dot-stuffing survives the trip",
        ].join("\r\n"),
      });

      const { raw } = await waitForMail(wes, testId, { timeoutMs: 30_000 });

      // The harness found the exact message we sent.
      expect(getHeader(raw, "X-Virtu-Test-Id")).toBe(testId);
      expect(getHeader(raw, "Subject")).toBe("TPS Reports");

      // Initech's opendkim signed it on the way out.
      const dkimSig = getHeader(raw, "DKIM-Signature");
      expect(dkimSig).toBeDefined();
      expect(dkimSig).toContain("d=initech.com");

      // qmail's policyd-spf checked SPF (initech.com is "v=spf1 +a -all"
      // and the peer connects from initech's own address, so: pass).
      // policyd-spf-fs prepends the X- variant of the header.
      const spf = getHeader(raw, "X-Received-SPF") ?? getHeader(raw, "Received-SPF");
      expect(spf).toBeDefined();
      expect(spf!.toLowerCase()).toMatch(/^pass/);

      // qmail's opendkim verified the signature and opendmarc evaluated
      // initech's p=reject policy — both report via Authentication-Results.
      const authResults = getHeaders(raw, "Authentication-Results")
        .join("\n")
        .toLowerCase();
      expect(authResults).toContain("dkim=pass");
      expect(authResults).toContain("dmarc=pass");

      // It really did relay across the fake internet (two MTAs).
      expect(getHeaders(raw, "Received").length).toBeGreaterThanOrEqual(2);
    },
    120_000,
  );
});
