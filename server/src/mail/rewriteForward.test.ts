import { describe, expect, test } from "bun:test";
import { type Address, parseAddressList, parseMessage } from "./headers.ts";
import {
  applyHeaderWhitelist,
  FORWARD_HEADER_WHITELIST,
  type ForwardContext,
  forwardDisplayName,
  headerNameInList,
  rewriteForward,
} from "./rewriteForward.ts";

const enc = new TextEncoder();

/** In-memory contact directory standing in for the wave-2 DB adapter. */
function makeContactStub(): {
  calls: { addr: Address; source: string }[];
  getOrCreateContact: ForwardContext["getOrCreateContact"];
} {
  const calls: { addr: Address; source: string }[] = [];
  const byAddress = new Map<string, string>();
  let n = 0;
  return {
    calls,
    getOrCreateContact: async (addr, source) => {
      calls.push({ addr, source });
      let replyEmail = byAddress.get(addr.address.toLowerCase());
      if (replyEmail === undefined) {
        n++;
        replyEmail = `${addr.address.toLowerCase().replace("@", "_at_").replace(/\./g, "_")}_r${n}@proxy.virtu.test`;
        byAddress.set(addr.address.toLowerCase(), replyEmail);
      }
      return { replyEmail };
    },
  };
}

function baseCtx(stub = makeContactStub()): ForwardContext & { stub: typeof stub } {
  return {
    alias: { email: "asdf@user.com" },
    mailbox: { email: "wes@qmail.com" },
    envelopeFrom: "bounces-123@initech.com",
    emailLogId: 42,
    getOrCreateContact: stub.getOrCreateContact,
    now: new Date("2026-08-08T12:00:00Z"),
    stub,
  };
}

const BASIC =
  "Return-Path: <bounces-123@initech.com>\r\n" +
  "Received: from mail.initech.com by mx.virtu.test\r\n" +
  "DKIM-Signature: v=1; a=rsa-sha256; d=initech.com; s=sel; b=abc\r\n" +
  "From: Milton Waddams <milton@initech.com>\r\n" +
  "To: asdf@user.com\r\n" +
  "Subject: TPS reports\r\n" +
  "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
  "Message-ID: <orig-1@initech.com>\r\n" +
  "X-Mailer: OutlookExpress\r\n" +
  "Mime-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=utf-8\r\n" +
  "\r\n" +
  "Please find attached.\r\n";

describe("headerNameInList / whitelist", () => {
  test("exact and wildcard matching", () => {
    expect(headerNameInList("From", FORWARD_HEADER_WHITELIST)).toBe(true);
    expect(headerNameInList("LIST-UNSUBSCRIBE", FORWARD_HEADER_WHITELIST)).toBe(true);
    expect(headerNameInList("List-Post", FORWARD_HEADER_WHITELIST)).toBe(true);
    expect(headerNameInList("X-Mailer", FORWARD_HEADER_WHITELIST)).toBe(false);
    expect(headerNameInList("Received", FORWARD_HEADER_WHITELIST)).toBe(false);
    expect(headerNameInList("Bcc", FORWARD_HEADER_WHITELIST)).toBe(false);
  });

  test("applyHeaderWhitelist drops in place and reports order", () => {
    const { headers } = parseMessage(enc.encode(BASIC));
    const dropped = applyHeaderWhitelist(headers, FORWARD_HEADER_WHITELIST);
    expect(dropped).toEqual(["Return-Path", "Received", "DKIM-Signature", "X-Mailer"]);
    expect(headers.has("From")).toBe(true);
    expect(headers.has("Received")).toBe(false);
  });
});

describe("forwardDisplayName (SimpleLogin sender_format AT)", () => {
  test("name + address", () => {
    expect(forwardDisplayName({ name: "Milton Waddams", address: "milton@initech.com" })).toBe(
      "Milton Waddams - milton at initech.com",
    );
  });
  test("no name", () => {
    expect(forwardDisplayName({ address: "milton@initech.com" })).toBe(
      "milton at initech.com",
    );
  });
  test("name equal to address collapses", () => {
    expect(
      forwardDisplayName({ name: "milton@initech.com", address: "milton@initech.com" }),
    ).toBe("milton at initech.com");
  });
});

describe("rewriteForward", () => {
  test("full rewrite: whitelist, From→reverse alias, provenance", async () => {
    const ctx = baseCtx();
    const { headers } = parseMessage(enc.encode(BASIC));
    const result = await rewriteForward({ headers }, ctx);

    // whitelist applied
    expect(result.actions.droppedHeaders).toEqual([
      "Return-Path",
      "Received",
      "DKIM-Signature",
      "X-Mailer",
    ]);
    expect(result.headers.has("X-Mailer")).toBe(false);

    // From → reverse alias with AT display name
    const from = parseAddressList(result.headers.get("From")!)[0]!;
    expect(from.name).toBe("Milton Waddams - milton at initech.com");
    expect(from.address).toMatch(/^milton_at_initech_com_r\d+@proxy\.virtu\.test$/);

    // To keeps the alias untouched
    expect(result.headers.get("To")).toBe("asdf@user.com");

    // untouched whitelisted headers keep exact original value
    expect(result.headers.get("Subject")).toBe("TPS reports");
    expect(result.headers.get("Message-ID")).toBe("<orig-1@initech.com>");
    expect(result.headers.get("Date")).toBe("Fri, 07 Aug 2026 10:00:00 +0000");
    expect(result.actions.synthesizedDate).toBe(false);

    // provenance
    expect(result.headers.get("X-Virtu-Type")).toBe("Forward");
    expect(result.headers.get("X-Virtu-EmailLog-ID")).toBe("42");
    expect(result.headers.get("X-Virtu-Envelope-From")).toBe("bounces-123@initech.com");
    expect(result.headers.get("X-Virtu-Envelope-To")).toBe("asdf@user.com");
    expect(result.headers.get("X-Virtu-Original-From")).toBe(
      "Milton Waddams <milton@initech.com>",
    );

    // input untouched (pure)
    expect(headers.get("From")).toBe("Milton Waddams <milton@initech.com>");
    expect(headers.has("X-Virtu-Type")).toBe(false);
  });

  test("To/Cc third parties map to reverse aliases; alias entry kept", async () => {
    const ctx = baseCtx();
    const raw =
      "From: milton@initech.com\r\n" +
      "To: asdf@user.com, Peter <peter@initech.com>\r\n" +
      "Cc: samir@initech.com\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);

    const to = parseAddressList(result.headers.get("To")!);
    expect(to).toHaveLength(2);
    expect(to[0]!.address).toBe("asdf@user.com");
    expect(to[1]!.name).toBe("Peter - peter at initech.com");
    expect(to[1]!.address).toMatch(/^peter_at_initech_com_r\d+@proxy\.virtu\.test$/);

    const cc = parseAddressList(result.headers.get("Cc")!);
    expect(cc).toHaveLength(1);
    expect(cc[0]!.address).toMatch(/^samir_at_initech_com_r\d+@proxy\.virtu\.test$/);

    // the same contact resolves consistently: From and any repeat share mapping
    const sources = ctx.stub.calls.map((c) => c.source);
    expect(sources).toEqual(["from", "to", "cc"]);
  });

  test("Reply-To mapped to reverse aliases, capped at 5", async () => {
    const ctx = baseCtx();
    const replyTos = Array.from({ length: 7 }, (_, i) => `rt${i}@initech.com`).join(", ");
    const raw =
      "From: milton@initech.com\r\n" +
      `Reply-To: ${replyTos}\r\n` +
      "To: asdf@user.com\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    const mapped = parseAddressList(result.headers.get("Reply-To")!);
    expect(mapped).toHaveLength(5);
    for (const m of mapped) {
      expect(m.address).toMatch(/@proxy\.virtu\.test$/);
    }
  });

  test("missing Date is synthesized", async () => {
    const ctx = baseCtx();
    const raw = "From: milton@initech.com\r\nTo: asdf@user.com\r\n\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    expect(result.actions.synthesizedDate).toBe(true);
    expect(result.headers.get("Date")).toBe("Sat, 08 Aug 2026 12:00:00 +0000");
  });

  test("missing From falls back to envelope sender", async () => {
    const ctx = baseCtx();
    const raw = "To: asdf@user.com\r\nDate: Fri, 07 Aug 2026 10:00:00 +0000\r\n\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    const from = parseAddressList(result.headers.get("From")!)[0]!;
    expect(from.name).toBe("bounces-123 at initech.com");
    expect(from.address).toMatch(/^bounces-123_at_initech_com_r\d+@proxy\.virtu\.test$/);
  });

  test("BCC delivery: alias added to To when absent everywhere", async () => {
    const ctx = baseCtx();
    const raw =
      "From: milton@initech.com\r\n" +
      "To: someone-else@initech.com\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    const to = parseAddressList(result.headers.get("To")!);
    expect(to.map((a) => a.address)).toContain("asdf@user.com");
  });

  test("no To at all: alias becomes To", async () => {
    const ctx = baseCtx();
    const raw = "From: milton@initech.com\r\nDate: Fri, 07 Aug 2026 10:00:00 +0000\r\n\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    expect(result.headers.get("To")).toBe("asdf@user.com");
  });

  test("implausible recipient addresses are skipped and reported", async () => {
    const ctx = baseCtx();
    const raw =
      "From: milton@initech.com\r\n" +
      "To: asdf@user.com, not-an-address\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    expect(result.actions.invalidRecipients).toEqual(["not-an-address"]);
    expect(parseAddressList(result.headers.get("To")!)).toHaveLength(1);
  });

  test("List-* headers survive the whitelist", async () => {
    const ctx = baseCtx();
    const raw =
      "From: news@initech.com\r\n" +
      "To: asdf@user.com\r\n" +
      "List-Unsubscribe: <mailto:unsub@initech.com>\r\n" +
      "List-Id: TPS <tps.initech.com>\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    expect(result.headers.get("List-Unsubscribe")).toBe("<mailto:unsub@initech.com>");
    expect(result.headers.get("List-Id")).toBe("TPS <tps.initech.com>");
  });

  test("In-Reply-To/References translated back to mailbox-side originals", async () => {
    const ctx = baseCtx();
    const map = new Map([
      ["<ours-9@user.com>", "<gmail-abc@mail.qmail.com>"],
    ]);
    ctx.resolveOriginalMessageId = async (id) => map.get(id) ?? null;
    const raw =
      "From: milton@initech.com\r\n" +
      "To: asdf@user.com\r\n" +
      "In-Reply-To: <ours-9@user.com>\r\n" +
      "References: <orig-1@initech.com> <ours-9@user.com>\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    expect(result.headers.get("In-Reply-To")).toBe("<gmail-abc@mail.qmail.com>");
    expect(result.headers.get("References")).toBe(
      "<orig-1@initech.com> <gmail-abc@mail.qmail.com>",
    );
  });

  test("UTF-8 display names survive the rewrite", async () => {
    const ctx = baseCtx();
    const raw =
      "From: Renée Müller <renee@initech.com>\r\n" +
      "To: asdf@user.com\r\n" +
      "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteForward({ headers }, ctx);
    const from = parseAddressList(result.headers.get("From")!)[0]!;
    expect(from.name).toBe("Renée Müller - renee at initech.com");
  });
});
