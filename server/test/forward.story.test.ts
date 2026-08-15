/**
 * Story M1 (PLAN Milestone 1): Milton mails Wes's alias through Initech's
 * MTA; our mx verifies, rewrites, signs and queues; deliverd hands it to
 * qmail; the message lands in Wes's Maildir with:
 *
 *   - From rewritten to a reverse alias (Milton's identity in the display
 *     name only),
 *   - our DKIM signature, verified by qmail (dkim=pass, header.d=virtu.email),
 *   - SPF pass for the VERP envelope sender @virtu.email,
 *   - X-Virtu-Type: Forward provenance.
 *
 * Run from the test-runner: just test-story (or bun test test/ inside it).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { createAlias, ensureDkimKey, ensureWes, type UserFixture } from "./fixtures.ts";
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

describe("M1: forward", () => {
  test("milton -> wes alias -> wes@qmail.com, rewritten + signed + SPF-aligned", async () => {
    const alias = await createAlias(fixture);
    const testId = newTestId();

    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "TPS reports, cover sheets",
        testId,
        body: "Did you get the memo?",
      }),
    });

    const { raw } = await waitForMail(wes, testId, { timeoutMs: 60_000 });

    // From: rewritten to a reverse alias on our domain; Milton's address
    // survives only inside the display name ("milton at initech.com").
    const from = getHeader(raw, "From");
    expect(from).toBeDefined();
    expect(from!).toMatch(/<milton_at_initech_com_[a-z0-9]{8}@virtu\.email>/);
    expect(from!).toContain("milton at initech.com");
    expect(from!).not.toContain("<milton@initech.com>");

    // The alias stays visible in To (reply-all ergonomics).
    expect(getHeader(raw, "To")).toContain(alias.email);

    // Our DKIM signature is present — and initech's original signature was
    // dropped by the forward whitelist (ARC carries that attestation).
    const dkimSigs = getHeaders(raw, "DKIM-Signature");
    expect(dkimSigs.length).toBeGreaterThanOrEqual(1);
    expect(dkimSigs.join("\n")).toContain("d=virtu.email");
    expect(dkimSigs.join("\n")).not.toContain("d=initech.com");

    // qmail verified our signature: its Authentication-Results (opendkim
    // and opendmarc each write their own header) say dkim=pass for
    // header.d=virtu.email.
    const qmailAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.qmail.com"))
      .join("\n");
    expect(qmailAuth).toContain("dkim=pass");
    expect(qmailAuth.toLowerCase()).toContain("header.d=virtu.email");

    // And OUR mx authenticated the inbound leg: the ARC-Authentication-
    // Results we sealed show initech's SPF+DKIM+DMARC all passing.
    const arcAuth = getHeader(raw, "ARC-Authentication-Results");
    expect(arcAuth).toBeDefined();
    expect(arcAuth!).toContain("mail.virtu.email");
    expect(arcAuth!).toContain("dkim=pass");
    expect(arcAuth!).toContain("dmarc=pass");

    // SPF pass at qmail for our VERP envelope sender on virtu.email.
    const spf = getHeader(raw, "X-Received-SPF") ?? getHeader(raw, "Received-SPF");
    expect(spf).toBeDefined();
    expect(spf!.toLowerCase()).toMatch(/^pass/);
    const returnPath = getHeader(raw, "Return-Path");
    expect(returnPath).toBeDefined();
    expect(returnPath!).toMatch(/^<vt\.[a-z2-7]+\.[a-z2-7]+@virtu\.email>$/);

    // Provenance + ARC seal.
    expect(getHeader(raw, "X-Virtu-Type")).toBe("Forward");
    expect(getHeader(raw, "ARC-Seal")).toBeDefined();

    // qmail stamped its own Received hop. (Upstream Received headers were
    // dropped by the forward whitelist; our mx adds none for MVP.)
    expect(getHeaders(raw, "Received").length).toBeGreaterThanOrEqual(1);

    // Observability (Lane J): the delivery that just landed is on maild's
    // metrics listener — the same endpoint Alloy scrapes in production.
    const metrics = await fetch("http://mail.virtu.email:9100/metrics").then((r) => r.text());
    const sent = /virtu_queue_deliveries_total\{result="sent"\} (\d+)/.exec(metrics);
    expect(Number(sent?.[1] ?? 0)).toBeGreaterThanOrEqual(1);
    expect(metrics).toContain('virtu_mx_messages_total{outcome="forwarded"}');
    expect(metrics).toContain("virtu_queue_depth{");
  }, 120_000);
});
