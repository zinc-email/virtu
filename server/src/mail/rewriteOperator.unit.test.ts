import { describe, expect, test } from "bun:test";
import { parseMessage } from "./headers.ts";
import { rewriteOperator } from "./rewriteOperator.ts";

const enc = new TextEncoder();
const CTX = {
  localpart: "postmaster",
  mailDomain: "virtu.email",
  envelopeFrom: "bounce@reporter.example",
  now: new Date("2026-09-02T12:00:00Z"),
};

function headersOf(raw: string) {
  return parseMessage(enc.encode(raw.replace(/\n/g, "\r\n"))).headers;
}

describe("rewriteOperator", () => {
  test("From moves onto our domain in AT format, original sender lands in Reply-To", () => {
    const headers = headersOf(
      "From: Milton Waddams <milton@initech.com>\nTo: postmaster@virtu.email\nSubject: your IP\nMessage-ID: <1@initech.com>\nDate: Tue, 01 Sep 2026 10:00:00 +0000\nDKIM-Signature: v=1; d=initech.com\nReceived: from x by y\n\n",
    );
    const { headers: out, originalFrom } = rewriteOperator({ headers }, CTX);
    expect(out.get("From")).toBe(
      '"Milton Waddams - milton at initech.com" <postmaster@virtu.email>',
    );
    expect(out.get("Reply-To")).toBe("Milton Waddams <milton@initech.com>");
    expect(out.get("To")).toBe("postmaster@virtu.email");
    expect(out.get("Subject")).toBe("your IP");
    expect(out.get("X-Virtu-Operator-Mail")).toBe("postmaster");
    expect(out.has("DKIM-Signature")).toBe(false); // whitelist
    expect(out.has("Received")).toBe(false);
    expect(originalFrom).toEqual({ name: "Milton Waddams", address: "milton@initech.com" });
    // Input untouched.
    expect(headers.get("From")).toBe("Milton Waddams <milton@initech.com>");
  });

  test("an existing Reply-To survives; a missing Date is synthesized", () => {
    const headers = headersOf(
      "From: abuse-desk@isp.example\nReply-To: tickets@isp.example\nTo: abuse@virtu.email\n\n",
    );
    const { headers: out } = rewriteOperator({ headers }, { ...CTX, localpart: "abuse" });
    expect(out.get("Reply-To")).toBe("tickets@isp.example");
    expect(out.get("From")).toBe('"abuse-desk at isp.example" <abuse@virtu.email>');
    expect(out.get("Date")).toBe("Wed, 02 Sep 2026 12:00:00 +0000");
  });

  test("no From header: falls back to the envelope sender", () => {
    const headers = headersOf("To: postmaster@virtu.email\n\n");
    const { headers: out } = rewriteOperator({ headers }, CTX);
    expect(out.get("From")).toBe('"bounce at reporter.example" <postmaster@virtu.email>');
    expect(out.get("Reply-To")).toBe("bounce@reporter.example");
  });
});
