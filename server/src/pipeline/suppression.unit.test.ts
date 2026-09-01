import { describe, expect, test } from "bun:test";
import { extractDsnStatus } from "./bounce.ts";
import { isSuppressionCode } from "./suppression.ts";

describe("isSuppressionCode", () => {
  test("first-strike codes: the mailbox itself is gone", () => {
    expect(isSuppressionCode("5.1.1")).toBe(true);
    expect(isSuppressionCode("5.2.1")).toBe(true);
    expect(isSuppressionCode(" 5.1.1 ")).toBe(true);
  });

  test("everything else stays on the normal retry/threshold path", () => {
    expect(isSuppressionCode("5.2.2")).toBe(false); // mailbox full: may recover
    expect(isSuppressionCode("5.7.1")).toBe(false); // policy: says nothing about the mailbox
    expect(isSuppressionCode("4.1.1")).toBe(false); // transient by class
    expect(isSuppressionCode("5.1.10")).toBe(false);
    expect(isSuppressionCode(undefined)).toBe(false);
    expect(isSuppressionCode(null)).toBe(false);
    expect(isSuppressionCode("")).toBe(false);
  });
});

describe("extractDsnStatus", () => {
  test("reads the per-recipient Status field from a DSN body", () => {
    const body = [
      "--boundary",
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; mx.qmail.com",
      "",
      "Final-Recipient: rfc822; dead@qmail.com",
      "Action: failed",
      "Status: 5.1.1",
      "Diagnostic-Code: smtp; 550 5.1.1 User unknown",
      "--boundary--",
    ].join("\r\n");
    expect(extractDsnStatus(body)).toBe("5.1.1");
  });

  test("case-insensitive field name, multi-digit subcodes", () => {
    expect(extractDsnStatus("STATUS: 4.2.2\r\n")).toBe("4.2.2");
    expect(extractDsnStatus("status: 5.7.26\r\n")).toBe("5.7.26");
  });

  test("no Status field, prose mentions, or no body → undefined", () => {
    expect(extractDsnStatus("Action: failed\r\n")).toBeUndefined();
    // Mid-line text must not match — only a Status field at line start.
    expect(extractDsnStatus("the status: 5.1.1 was seen")).toBeUndefined();
    expect(extractDsnStatus(undefined)).toBeUndefined();
  });
});
