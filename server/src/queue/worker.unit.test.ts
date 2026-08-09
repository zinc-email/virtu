/**
 * Pure parts of the queue worker: SMTP outcome classification and MX target
 * resolution (injected resolver — no network, no DB).
 */

import { describe, expect, test } from "bun:test";
import type { SmtpReply, SmtpSendResult } from "../smtp/index.ts";
import { classifySendResult, resolveMxTargets } from "./worker.ts";

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
