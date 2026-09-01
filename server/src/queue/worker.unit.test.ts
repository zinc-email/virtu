/**
 * Pure parts of the queue worker: SMTP outcome classification and MX target
 * resolution (injected resolver — no network, no DB).
 */

import { describe, expect, test } from "bun:test";
import type { OutboundMessage } from "../db/schema.ts";
import type { SmtpReply, SmtpSendResult } from "../smtp/index.ts";
import {
  classifySendResult,
  deliverOverSmtp,
  isBlockedAddress,
  resolveMxTargets,
} from "./worker.ts";

function reply(code: number, message = "x", enhancedCode?: string): SmtpReply {
  return { code, enhancedCode, message, lines: [message] };
}

function sendResult(over: Partial<SmtpSendResult>): SmtpSendResult {
  return {
    accepted: false,
    mailFrom: reply(250),
    rcptTo: [{ address: "a@b.c", reply: reply(250), accepted: true }],
    data: reply(250),
    ...over,
  };
}

describe("classifySendResult", () => {
  test("accepted transaction: sent", () => {
    expect(classifySendResult(sendResult({ accepted: true }))).toEqual({ kind: "sent" });
  });

  test("5xx MAIL FROM: permanent", () => {
    const r = sendResult({ mailFrom: reply(550, "no", "5.1.8"), rcptTo: [], data: undefined });
    expect(classifySendResult(r)).toMatchObject({ kind: "permanent" });
  });

  test("4xx MAIL FROM: transient", () => {
    const r = sendResult({ mailFrom: reply(451, "later"), rcptTo: [], data: undefined });
    expect(classifySendResult(r)).toMatchObject({ kind: "transient" });
  });

  test("permanent outcomes carry the refusing reply's enhanced code (suppression signal)", () => {
    const rcpt = sendResult({
      rcptTo: [
        { address: "nx@qmail.com", reply: reply(550, "User unknown", "5.1.1"), accepted: false },
      ],
      data: undefined,
    });
    expect(classifySendResult(rcpt)).toMatchObject({ kind: "permanent", enhancedCode: "5.1.1" });

    const data = sendResult({
      rcptTo: [{ address: "a@qmail.com", reply: reply(250, "ok"), accepted: true }],
      data: reply(554, "rejected", "5.7.1"),
    });
    expect(classifySendResult(data)).toMatchObject({ kind: "permanent", enhancedCode: "5.7.1" });

    // No enhanced code from the remote → none invented.
    const bare = sendResult({
      rcptTo: [{ address: "b@qmail.com", reply: reply(550, "nope"), accepted: false }],
      data: undefined,
    });
    expect(classifySendResult(bare)).toMatchObject({ kind: "permanent", enhancedCode: undefined });
  });

  test("550 on the only recipient: permanent, error carries the reply", () => {
    const r = sendResult({
      rcptTo: [
        { address: "nx@qmail.com", reply: reply(550, "User unknown", "5.1.1"), accepted: false },
      ],
      data: undefined,
    });
    const outcome = classifySendResult(r);
    expect(outcome).toMatchObject({ kind: "permanent" });
    expect((outcome as { error: string }).error).toContain("nx@qmail.com");
    expect((outcome as { error: string }).error).toContain("550");
  });

  test("450 on the only recipient: transient", () => {
    const r = sendResult({
      rcptTo: [{ address: "x@y.z", reply: reply(450, "greylisted"), accepted: false }],
      data: undefined,
    });
    expect(classifySendResult(r)).toMatchObject({ kind: "transient" });
  });

  test("5xx after DATA: permanent", () => {
    const r = sendResult({ data: reply(554, "content rejected") });
    expect(classifySendResult(r)).toMatchObject({ kind: "permanent" });
  });

  test("4xx after DATA: transient", () => {
    const r = sendResult({ data: reply(451, "try again") });
    expect(classifySendResult(r)).toMatchObject({ kind: "transient" });
  });

  test("no DATA reply at all: transient", () => {
    const r = sendResult({ data: undefined, rcptTo: [] });
    expect(classifySendResult(r)).toMatchObject({ kind: "transient" });
  });
});

describe("isBlockedAddress", () => {
  test("blocks loopback, private, link-local, CGNAT, unspecified (IPv4)", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "0.0.0.0",
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.169.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  test("blocks IPv6 loopback, unspecified, ULA, link-local, and mapped IPv4", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  test("allows public IPv6 and mapped-public IPv4", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  test("treats unparseable input as blocked (fail closed)", () => {
    expect(isBlockedAddress("")).toBe(true);
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("999.1.1.1")).toBe(true);
  });
});

function outboundRow(over: Partial<OutboundMessage>): OutboundMessage {
  return {
    id: 1,
    raw: new Uint8Array(),
    envelopeFrom: "",
    envelopeTo: "user@example.com",
    status: "sending",
    tries: 1,
    nextAttemptAt: new Date("2026-08-11T00:00:00Z"),
    claimedAt: null,
    lastError: null,
    userId: null,
    emailLogId: null,
    createdAt: new Date("2026-08-11T00:00:00Z"),
    updatedAt: new Date("2026-08-11T00:00:00Z"),
    ...over,
  };
}

describe("deliverOverSmtp egress guard (SSRF)", () => {
  test("refuses an MX that resolves to a private address — permanent, no connection", async () => {
    const outcome = await deliverOverSmtp(outboundRow({ envelopeTo: "victim@evil.example" }), {
      heloName: "mail.virtu.email",
      resolveMx: async () => [{ exchange: "mx.evil.example", priority: 0 }],
      resolveHost: async () => ["127.0.0.1"],
    });
    expect(outcome).toMatchObject({ kind: "permanent" });
    expect((outcome as { error: string }).error).toContain("non-public MX");
  });

  test("refuses the implicit-MX A record pointing at cloud metadata", async () => {
    const enodata = Object.assign(new Error("no MX"), { code: "ENODATA" });
    const outcome = await deliverOverSmtp(outboundRow({ envelopeTo: "x@169.254.internal" }), {
      heloName: "mail.virtu.email",
      resolveMx: async () => {
        throw enodata;
      },
      resolveHost: async () => ["169.254.169.254"],
    });
    expect(outcome).toMatchObject({ kind: "permanent" });
  });
});

describe("resolveMxTargets", () => {
  test("sorts by priority", async () => {
    const targets = await resolveMxTargets("qmail.com", async () => [
      { exchange: "backup.qmail.com", priority: 20 },
      { exchange: "mail.qmail.com", priority: 10 },
    ]);
    expect(targets.map((t) => t.exchange)).toEqual(["mail.qmail.com", "backup.qmail.com"]);
  });

  test("no MX records: RFC 5321 implicit MX (the domain itself)", async () => {
    const enodata = Object.assign(new Error("queryMx ENODATA"), { code: "ENODATA" });
    const targets = await resolveMxTargets("bare.example", async () => {
      throw enodata;
    });
    expect(targets).toEqual([{ exchange: "bare.example", priority: 0 }]);
  });

  test("empty MX answer: implicit MX too", async () => {
    const targets = await resolveMxTargets("empty.example", async () => []);
    expect(targets).toEqual([{ exchange: "empty.example", priority: 0 }]);
  });

  test("real resolver failures propagate (transient at the caller)", async () => {
    const refused = Object.assign(new Error("query refused"), { code: "EREFUSED" });
    await expect(
      resolveMxTargets("down.example", async () => {
        throw refused;
      }),
    ).rejects.toThrow("query refused");
  });
});
