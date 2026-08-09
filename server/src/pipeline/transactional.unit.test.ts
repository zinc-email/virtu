// Unit tier: the pure parts of the transactional pipeline (message building,
// code generation/hashing, templates). The DB-touching flows (sending,
// rate control, code consumption) are covered by the route int tests and the
// transactional story test.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseMessage, serializeMessage } from "../mail/index.ts";
import {
  accountActivationEmail,
  buildTransactionalMessage,
  extractCodeFromBody,
  generateVerificationCode,
  hashVerificationCode,
  mailboxVerificationEmail,
  noreplyAddress,
} from "./transactional.ts";

describe("generateVerificationCode", () => {
  test("always 6 digits, leading zeros kept", () => {
    for (let i = 0; i < 500; i++) {
      expect(generateVerificationCode()).toMatch(/^\d{6}$/);
    }
  });

  test("codes vary", () => {
    const seen = new Set(Array.from({ length: 50 }, generateVerificationCode));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("hashVerificationCode", () => {
  test("sha256 hex, 64 chars", () => {
    const hash = hashVerificationCode("123456");
    expect(hash).toBe(createHash("sha256").update("123456").digest("hex"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildTransactionalMessage", () => {
  const date = new Date("2026-08-08T12:34:56Z");
  const input = {
    from: noreplyAddress("virtu.email"),
    to: "wes@qmail.com",
    subject: "Just one more step to join Virtu",
    textBody: "Hi,\n\nYour code:\n\n123456\n",
    messageId: "<abc@virtu.email>",
    date,
  };

  test("headers: sender, provenance, plain-text MIME", () => {
    const { headers } = buildTransactionalMessage(input);
    // "(" in the display name forces quoting (formatAddress specials).
    expect(headers.get("From")).toBe('"Virtu (noreply)" <noreply@virtu.email>');
    expect(headers.get("To")).toBe("wes@qmail.com");
    expect(headers.get("Subject")).toBe("Just one more step to join Virtu");
    expect(headers.get("Date")).toBe("Sat, 08 Aug 2026 12:34:56 +0000");
    expect(headers.get("Message-ID")).toBe("<abc@virtu.email>");
    expect(headers.get("MIME-Version")).toBe("1.0");
    expect(headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(headers.get("X-Virtu-Type")).toBe("Transactional");
    expect(headers.has("X-Virtu-Test-Id")).toBe(false);
  });

  test("stamps X-Virtu-Test-Id only when given", () => {
    const { headers } = buildTransactionalMessage({ ...input, testId: "tid-1" });
    expect(headers.get("X-Virtu-Test-Id")).toBe("tid-1");
  });

  test("body is CRLF-normalized with a trailing break and round-trips", () => {
    const { headers, body } = buildTransactionalMessage(input);
    const text = new TextDecoder().decode(body);
    expect(text).toBe("Hi,\r\n\r\nYour code:\r\n\r\n123456\r\n");

    const parsed = parseMessage(serializeMessage(headers, body));
    expect(parsed.headers.get("X-Virtu-Type")).toBe("Transactional");
    expect(new TextDecoder().decode(parsed.body)).toBe(text);
  });

  test("already-CRLF input is not double-broken", () => {
    const { body } = buildTransactionalMessage({ ...input, textBody: "a\r\nb\r\n" });
    expect(new TextDecoder().decode(body)).toBe("a\r\nb\r\n");
  });
});

describe("templates", () => {
  test("activation email carries the code on its own line", () => {
    const { subject, textBody } = accountActivationEmail("042137");
    expect(subject).toBe("Just one more step to join Virtu");
    expect(extractCodeFromBody(textBody)).toBe("042137");
  });

  test("mailbox email names the mailbox and carries the code", () => {
    const { subject, textBody } = mailboxVerificationEmail("second@example.com", "998877");
    expect(subject).toBe("Please confirm your mailbox second@example.com");
    expect(textBody).toContain("second@example.com");
    expect(extractCodeFromBody(textBody)).toBe("998877");
  });

  test("extraction survives CRLF normalization (as read back off the wire)", () => {
    const { textBody } = accountActivationEmail("000123");
    const wire = textBody.replace(/\r?\n/g, "\r\n");
    expect(extractCodeFromBody(wire)).toBe("000123");
  });

  test("expiry note digits never match as a code", () => {
    const { textBody } = accountActivationEmail("654321");
    // "15 minutes" appears in the copy; the ^...$ anchors must ignore it.
    expect(textBody).toContain("15 minutes");
    expect(extractCodeFromBody(textBody)).toBe("654321");
  });
});
