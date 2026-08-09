/**
 * Story M2 (PLAN Milestone 2): Wes replies through OUR submission service.
 *
 * Phase 1 replays an M1 forward to mint a reverse alias; phase 2 connects
 * to mail.virtu.email:587, upgrades with STARTTLS (verified against the
 * mkcert test CA), authenticates as Wes and sends To: the reverse alias.
 * The reply lands in Milton's initech Maildir with From: = the alias,
 * To: = milton@initech.com (the reverse alias never appears), a fresh
 * Message-ID on our domain, dkim=pass at initech — and Wes's real mailbox
 * address appears nowhere.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { connectSmtp } from "../src/smtp/index.ts";
import {
  createAlias,
  ensureDkimKey,
  ensureWes,
  type UserFixture,
  WES_PASSWORD,
} from "./fixtures.ts";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

const TEST_CA_URL = new URL("../docker/test/mkcert/rootCA.pem", import.meta.url);

let fixture: UserFixture;
let testCa: string;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await waitForPort(wes.submission.host, wes.submission.port, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
  testCa = await Bun.file(TEST_CA_URL).text();
});

describe("M2: reply via submission", () => {
  test("wes replies to a reverse alias; milton sees the alias, dkim passes", async () => {
    const alias = await createAlias(fixture);

    // ── Phase 1: a forward mints the reverse alias ──────────────────────
    const forwardId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "About my stapler",
        testId: forwardId,
      }),
    });
    const forwarded = await waitForMail(wes, forwardId, { timeoutMs: 60_000 });
    const forwardedFrom = getHeader(forwarded.raw, "From")!;
    const reverseAlias = /<([^>]+)>/.exec(forwardedFrom)?.[1];
    expect(reverseAlias).toBeDefined();
    expect(reverseAlias!).toEndWith("@virtu.email");
    const originalMessageId = getHeader(forwarded.raw, "Message-ID")!;

    // ── Phase 2: Wes submits the reply through mail.virtu.email:587 ─────
    const replyId = newTestId();
    const client = await connectSmtp({
      host: wes.submission.host,
      port: wes.submission.port,
      name: "wes-mua.internal",
      tls: { ca: testCa },
    });
    try {
      await client.ehlo();
      // AUTH must not be offered before the TLS upgrade.
      expect(client.capabilities.has("AUTH")).toBe(false);
      await client.startTls();
      expect(client.capabilities.has("AUTH")).toBe(true);
      await client.auth({ username: wes.email, password: WES_PASSWORD });

      const result = await client.send({
        mailFrom: alias.email,
        rcptTo: [reverseAlias!],
        data: buildMessage({
          from: alias.email,
          to: reverseAlias!,
          subject: "Re: About my stapler",
          testId: replyId,
          inReplyTo: originalMessageId,
          messageId: `<${replyId}@qmail.com>`, // mailbox-side id: must not leak
          body: "You can have it back on Friday.",
        }),
      });
      expect(result.accepted).toBe(true);
    } finally {
      await client.quit();
    }

    // ── The reply lands at initech, fully translated ────────────────────
    const { raw } = await waitForMail(milton, replyId, { timeoutMs: 60_000 });

    // From: the alias (not Wes's real mailbox).
    expect(getHeader(raw, "From")).toBe(alias.email);

    // To: the real recipient — the reverse alias is gone.
    const to = getHeader(raw, "To");
    expect(to).toBeDefined();
    expect(to!).toContain(milton.email);
    expect(to!).not.toContain(reverseAlias!);

    // Our public Message-ID replaced the mailbox-side one; threading kept.
    const messageId = getHeader(raw, "Message-ID")!;
    expect(messageId).toContain("@virtu.email");
    expect(messageId).not.toContain("@qmail.com");
    expect(getHeader(raw, "In-Reply-To")).toBe(originalMessageId);

    // initech verified our DKIM signature (opendkim and opendmarc each
    // write their own Authentication-Results header).
    const initechAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.initech.com"))
      .join("\n");
    expect(initechAuth).toContain("dkim=pass");
    expect(initechAuth.toLowerCase()).toContain("header.d=virtu.email");

    // SPF pass for the VERP bounce_reply envelope on our domain.
    const spf = getHeader(raw, "X-Received-SPF") ?? getHeader(raw, "Received-SPF");
    expect(spf).toBeDefined();
    expect(spf!.toLowerCase()).toMatch(/^pass/);

    // The user's real mailbox address leaks nowhere.
    expect(raw.toString("latin1")).not.toContain(wes.email);
  }, 180_000);

  test("submission refuses recipients that are not reverse aliases (550, no leak)", async () => {
    const alias = await createAlias(fixture);
    const client = await connectSmtp({
      host: wes.submission.host,
      port: wes.submission.port,
      name: "wes-mua.internal",
      tls: { ca: testCa },
    });
    try {
      await client.ehlo();
      await client.startTls();
      await client.auth({ username: wes.email, password: WES_PASSWORD });
      const result = await client.send({
        mailFrom: alias.email,
        rcptTo: ["not-a-reverse-alias@virtu.email"],
        data: buildMessage({
          from: alias.email,
          to: "not-a-reverse-alias@virtu.email",
          subject: "should never send",
          testId: newTestId(),
        }),
      });
      expect(result.accepted).toBe(false);
      expect(result.rcptTo[0]?.reply.code).toBe(550);
      expect(result.rcptTo[0]?.reply.enhancedCode).toBe("5.7.1");
    } finally {
      await client.quit();
    }
  }, 60_000);

  test("submission refuses bad credentials", async () => {
    const client = await connectSmtp({
      host: wes.submission.host,
      port: wes.submission.port,
      name: "wes-mua.internal",
      tls: { ca: testCa },
    });
    try {
      await client.ehlo();
      await client.startTls();
      await expect(
        client.auth({ username: wes.email, password: "wrong-password" }),
      ).rejects.toThrow(/535/);
    } finally {
      await client.quit();
    }
  }, 60_000);
});
