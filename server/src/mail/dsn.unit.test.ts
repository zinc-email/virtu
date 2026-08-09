import { describe, expect, test } from "bun:test";
import { buildDsn, DSN_SUBJECT, statusFromReply } from "./dsn.ts";
import { parseMessage, serializeMessage } from "./headers.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sampleOriginalHeaders() {
  const raw = encoder.encode(
    "From: Milton Waddams <milton_at_initech_com_abc123@virtu.email>\r\n" +
      "To: dead@qmail.com\r\n" +
      "Subject: About my stapler\r\n" +
      "Message-ID: <orig-id@initech.com>\r\n" +
      "X-Virtu-Test-Id: 0a1b2c3d-original\r\n" +
      "\r\n" +
      "body bytes that must NOT be returned\r\n",
  );
  return parseMessage(raw).headers;
}

function build(overrides: Partial<Parameters<typeof buildDsn>[0]> = {}) {
  return buildDsn({
    originalHeaders: sampleOriginalHeaders(),
    failedRecipient: "dead@qmail.com",
    remoteReply: "RCPT TO dead@qmail.com: 550 5.1.1 <dead@qmail.com>: User unknown",
    reportingMta: "mail.virtu.email",
    mailDomain: "virtu.email",
    recipient: "milton@initech.com",
    now: new Date("2026-08-08T12:00:00Z"),
    boundary: "=_vt-dsn-test-boundary",
    messageId: "<dsn-test-id@virtu.email>",
    ...overrides,
  });
}

describe("statusFromReply", () => {
  test("prefers a literal enhanced code", () => {
    expect(statusFromReply("550 5.1.1 <x@y>: User unknown")).toBe("5.1.1");
    expect(statusFromReply("451 4.7.1 greylisted")).toBe("4.7.1");
  });

  test("falls back to the reply-code class", () => {
    expect(statusFromReply("550 mailbox unavailable")).toBe("5.0.0");
    expect(statusFromReply("retries exhausted: 452 too much mail")).toBe("4.0.0");
  });

  test("defaults to 5.0.0 when no code is recognizable", () => {
    expect(statusFromReply("connection reset by peer")).toBe("5.0.0");
  });

  test("never picks a 2.x.x success code out of the reply text", () => {
    expect(statusFromReply("smtp; 250 2.0.0 then 550 refused")).toBe("5.0.0");
  });
});

describe("buildDsn", () => {
  test("headers: MAILER-DAEMON from, fixed subject, auto-replied, multipart/report", () => {
    const { headers } = build();
    expect(headers.get("From")).toBe("Mail Delivery System <MAILER-DAEMON@virtu.email>");
    expect(headers.get("To")).toBe("milton@initech.com");
    expect(headers.get("Subject")).toBe(DSN_SUBJECT);
    expect(headers.get("Auto-Submitted")).toBe("auto-replied");
    expect(headers.get("Message-ID")).toBe("<dsn-test-id@virtu.email>");
    const contentType = headers.get("Content-Type")!;
    expect(contentType).toContain("multipart/report");
    expect(contentType).toContain("report-type=delivery-status");
    expect(contentType).toContain('boundary="=_vt-dsn-test-boundary"');
  });

  test("body: three parts, consistent boundary, closed", () => {
    const { body } = build();
    const text = decoder.decode(body);
    const delimiters = text.match(/--=_vt-dsn-test-boundary(?!-)/g) ?? [];
    expect(delimiters.length).toBe(3);
    expect(text).toContain("--=_vt-dsn-test-boundary--\r\n");
    expect(text).toContain("Content-Type: text/plain; charset=utf-8");
    expect(text).toContain("Content-Type: message/delivery-status");
    expect(text).toContain("Content-Type: text/rfc822-headers");
  });

  test("delivery-status part carries the machine-readable fields", () => {
    const text = decoder.decode(build().body);
    expect(text).toContain("Reporting-MTA: dns; mail.virtu.email");
    expect(text).toContain("Final-Recipient: rfc822; dead@qmail.com");
    expect(text).toContain("Action: failed");
    expect(text).toContain("Status: 5.1.1");
    expect(text).toContain(
      "Diagnostic-Code: smtp; RCPT TO dead@qmail.com: 550 5.1.1 <dead@qmail.com>: User unknown",
    );
  });

  test("returns the original headers byte-faithfully, but never the body", () => {
    const text = decoder.decode(build().body);
    expect(text).toContain("X-Virtu-Test-Id: 0a1b2c3d-original");
    expect(text).toContain("Message-ID: <orig-id@initech.com>");
    expect(text).toContain("Subject: About my stapler");
    expect(text).not.toContain("body bytes that must NOT be returned");
  });

  test("human part quotes the failed recipient and the remote reply", () => {
    const text = decoder.decode(build().body);
    expect(text).toContain("This is the mail system at host mail.virtu.email.");
    expect(text).toContain("<dead@qmail.com>: RCPT TO dead@qmail.com: 550 5.1.1");
  });

  test("multi-line remote replies are collapsed to one line", () => {
    const { body } = build({ remoteReply: "550 first line\r\n second line" });
    const text = decoder.decode(body);
    expect(text).toContain("Diagnostic-Code: smtp; 550 first line second line");
  });

  test("serializes into a parseable message (headers then body)", () => {
    const dsn = build();
    const raw = serializeMessage(dsn.headers, dsn.body);
    const reparsed = parseMessage(raw);
    expect(reparsed.headers.get("Subject")).toBe(DSN_SUBJECT);
    expect(decoder.decode(reparsed.body)).toContain("Final-Recipient: rfc822; dead@qmail.com");
  });

  test("random boundary/message-id when not overridden", () => {
    const dsn = buildDsn({
      originalHeaders: sampleOriginalHeaders(),
      failedRecipient: "dead@qmail.com",
      remoteReply: "550 no",
      reportingMta: "mail.virtu.email",
      mailDomain: "virtu.email",
      recipient: "milton@initech.com",
    });
    expect(dsn.headers.get("Content-Type")).toMatch(/boundary="=_vt-dsn-[0-9a-f]{24}"/);
    expect(dsn.headers.get("Message-ID")).toMatch(/^<[0-9a-f]{32}@virtu\.email>$/);
  });

  test("bare-LF original headers still get a clean closing delimiter", () => {
    const headers = parseMessage(encoder.encode("Subject: lf only\nFrom: a@b.c\n\nbody\n")).headers;
    const { body } = build({ originalHeaders: headers });
    const text = decoder.decode(body);
    expect(text).toContain("Subject: lf only");
    expect(text).toMatch(/\r\n--=_vt-dsn-test-boundary--\r\n$/);
  });
});
