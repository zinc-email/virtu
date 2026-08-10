import { describe, expect, test } from "bun:test";
import { parseAddressList, parseMessage } from "./headers.ts";
import { REPLY_HEADER_WHITELIST, type ReplyContext, rewriteReply } from "./rewriteReply.ts";

const enc = new TextEncoder();

/** Known reverse aliases → real contacts. */
const REVERSE = new Map<string, { websiteEmail: string; name?: string }>([
  [
    "milton_at_initech_com_r1@proxy.virtu.test",
    { websiteEmail: "milton@initech.com", name: "Milton Waddams" },
  ],
  ["peter_at_initech_com_r2@proxy.virtu.test", { websiteEmail: "peter@initech.com" }],
]);

function baseCtx(overrides: Partial<ReplyContext> = {}): ReplyContext {
  return {
    alias: { email: "asdf@user.com" },
    emailLogId: 77,
    resolveReverseAlias: async (addr) => REVERSE.get(addr.toLowerCase()) ?? null,
    generateMessageId: () => "<77.fixed@user.com>",
    now: new Date("2026-08-08T12:00:00Z"),
    ...overrides,
  };
}

const BASIC =
  "Received: from mua by mail.qmail.com\r\n" +
  "From: Wes Smith <wes@qmail.com>\r\n" +
  "To: Milton Waddams - milton at initech.com <milton_at_initech_com_r1@proxy.virtu.test>\r\n" +
  "Subject: Re: TPS reports\r\n" +
  "Date: Sat, 08 Aug 2026 11:00:00 +0000\r\n" +
  "Message-ID: <gmail-123@mail.qmail.com>\r\n" +
  "X-Mailer: Gmail\r\n" +
  "Mime-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=utf-8\r\n" +
  "\r\n" +
  "Sounds good.\r\n";

describe("rewriteReply cold-send mode (externalRecipients)", () => {
  const coldCtx = (overrides: Partial<ReplyContext> = {}): ReplyContext =>
    baseCtx({
      externalRecipients: {
        screen: async (addr) => (addr.toLowerCase() === "wes@qmail.com" ? "mailbox_address" : null),
      },
      ...overrides,
    });

  test("unknown To entries pass through verbatim; reverse aliases still translate", async () => {
    const msg =
      "From: asdf@user.com\r\n" +
      "To: samir@initech.com, milton_at_initech_com_r1@proxy.virtu.test\r\n" +
      "Subject: Hello\r\n" +
      "Date: Sat, 08 Aug 2026 11:00:00 +0000\r\n" +
      "\r\n" +
      "Hi.\r\n";
    const result = await rewriteReply(
      { headers: parseMessage(enc.encode(msg)).headers },
      coldCtx(),
    );
    if (!result.ok) throw new Error("expected ok");
    const to = parseAddressList(result.headers.get("To")!);
    expect(to).toEqual([
      { address: "samir@initech.com" },
      { name: "Milton Waddams", address: "milton@initech.com" },
    ]);
    expect(result.headers.get("From")).toBe("asdf@user.com");
  });

  test("the user's own mailbox address in Cc refuses (mailbox_address)", async () => {
    const msg =
      "From: asdf@user.com\r\n" +
      "To: samir@initech.com\r\n" +
      "Cc: wes@qmail.com\r\n" +
      "Subject: Hello\r\n" +
      "\r\n" +
      "Hi.\r\n";
    const result = await rewriteReply(
      { headers: parseMessage(enc.encode(msg)).headers },
      coldCtx(),
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toEqual({
      reason: "mailbox_address",
      header: "cc",
      address: "wes@qmail.com",
    });
  });

  test("without the flag, unknown To entries still refuse (reply mode unchanged)", async () => {
    const msg =
      "From: asdf@user.com\r\n" +
      "To: samir@initech.com\r\n" +
      "Subject: Hello\r\n" +
      "\r\n" +
      "Hi.\r\n";
    const result = await rewriteReply(
      { headers: parseMessage(enc.encode(msg)).headers },
      baseCtx(),
    );
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal.reason).toBe("non_reverse_alias");
  });
});

describe("rewriteReply", () => {
  test("happy path: From→alias, To→real contact, Message-ID swapped", async () => {
    const ctx = baseCtx();
    const { headers } = parseMessage(enc.encode(BASIC));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");

    // whitelist: Received/X-Mailer gone, List-* not allowed on replies
    expect(result.actions.droppedHeaders).toEqual(["Received", "X-Mailer"]);
    expect(result.headers.has("X-Mailer")).toBe(false);

    // From is the alias, mailbox identity gone
    expect(result.headers.get("From")).toBe("asdf@user.com");
    const serialized = new TextDecoder().decode(result.headers.serialize());
    expect(serialized).not.toContain("wes@qmail.com");
    expect(serialized).not.toContain("gmail-123@mail.qmail.com");

    // To resolved to the real contact with contact name
    const to = parseAddressList(result.headers.get("To")!);
    expect(to).toEqual([{ name: "Milton Waddams", address: "milton@initech.com" }]);

    // Message-ID replaced with ours; map action returned for persistence
    expect(result.headers.get("Message-ID")).toBe("<77.fixed@user.com>");
    expect(result.actions.messageIdMap).toEqual({
      original: "<gmail-123@mail.qmail.com>",
      ours: "<77.fixed@user.com>",
      reused: false,
    });

    // direction marker
    expect(result.headers.get("X-Virtu-Type")).toBe("Reply");

    // input untouched (pure)
    expect(headers.get("From")).toBe("Wes Smith <wes@qmail.com>");
  });

  test("alias display name used in From when set", async () => {
    const ctx = baseCtx({ alias: { email: "asdf@user.com", name: "ASDF" } });
    const { headers } = parseMessage(enc.encode(BASIC));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headers.get("From")).toBe("ASDF <asdf@user.com>");
  });

  test("refuses when a To entry is not a known reverse alias (never leaks)", async () => {
    const ctx = baseCtx();
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: milton_at_initech_com_r1@proxy.virtu.test, leak-target@initech.com\r\n" +
      "Message-ID: <gmail-124@mail.qmail.com>\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal).toEqual({
      reason: "non_reverse_alias",
      header: "to",
      address: "leak-target@initech.com",
    });
  });

  test("refuses on unknown Cc entry too, reporting the header", async () => {
    const ctx = baseCtx();
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: milton_at_initech_com_r1@proxy.virtu.test\r\n" +
      "Cc: shadow@initech.com\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (result.ok) throw new Error("expected refusal");
    expect(result.refusal.header).toBe("cc");
    expect(result.refusal.address).toBe("shadow@initech.com");
  });

  test("refusal is all-or-nothing: original headers untouched", async () => {
    const ctx = baseCtx();
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: unknown@initech.com\r\n" +
      "Message-ID: <gmail-125@mail.qmail.com>\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    expect(result.ok).toBe(false);
    expect(headers.get("From")).toBe("wes@qmail.com");
    expect(headers.get("Message-ID")).toBe("<gmail-125@mail.qmail.com>");
  });

  test("alias echo in To/Cc (reply-all) is dropped, not refused", async () => {
    const ctx = baseCtx();
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: milton_at_initech_com_r1@proxy.virtu.test, asdf@user.com\r\n" +
      "Cc: ASDF <asdf@user.com>\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(parseAddressList(result.headers.get("To")!)).toEqual([
      { name: "Milton Waddams", address: "milton@initech.com" },
    ]);
    // Cc contained only the alias → header removed entirely
    expect(result.headers.has("Cc")).toBe(false);
  });

  test("multiple reverse aliases across To and Cc all resolve", async () => {
    const ctx = baseCtx();
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: milton_at_initech_com_r1@proxy.virtu.test\r\n" +
      "Cc: peter_at_initech_com_r2@proxy.virtu.test\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(parseAddressList(result.headers.get("Cc")!)).toEqual([{ address: "peter@initech.com" }]);
  });

  test("undisclosed-recipients To is left untouched (BCC mode)", async () => {
    const ctx = baseCtx();
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: undisclosed-recipients:;\r\n" +
      "Cc: milton_at_initech_com_r1@proxy.virtu.test\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headers.get("To")).toBe("undisclosed-recipients:;");
    expect(parseAddressList(result.headers.get("Cc")!)[0]!.address).toBe("milton@initech.com");
  });

  test("Message-ID reused from existing mapping (multi-recipient reply)", async () => {
    const ctx = baseCtx({
      resolveOurMessageId: async (orig) =>
        orig === "<gmail-123@mail.qmail.com>" ? "<77.earlier@user.com>" : null,
    });
    const { headers } = parseMessage(enc.encode(BASIC));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headers.get("Message-ID")).toBe("<77.earlier@user.com>");
    expect(result.actions.messageIdMap).toEqual({
      original: "<gmail-123@mail.qmail.com>",
      ours: "<77.earlier@user.com>",
      reused: true,
    });
  });

  test("no Message-ID on input: ours generated, original null", async () => {
    const ctx = baseCtx();
    const raw = "From: wes@qmail.com\r\nTo: milton_at_initech_com_r1@proxy.virtu.test\r\n\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headers.get("Message-ID")).toBe("<77.fixed@user.com>");
    expect(result.actions.messageIdMap.original).toBeNull();
    expect(result.actions.messageIdMap.reused).toBe(false);
  });

  test("default Message-ID generator uses alias domain and log id", async () => {
    const ctx = baseCtx({ generateMessageId: undefined });
    const { headers } = parseMessage(enc.encode(BASIC));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headers.get("Message-ID")).toMatch(/^<77\.[A-Za-z0-9_-]+@user\.com>$/);
  });

  test("References and In-Reply-To swap mailbox-side ids for ours", async () => {
    const map = new Map([
      ["<gmail-100@mail.qmail.com>", "<77.a@user.com>"],
      ["<gmail-123@mail.qmail.com>", "<77.b@user.com>"],
    ]);
    const ctx = baseCtx({ resolveOurMessageId: async (id) => map.get(id) ?? null });
    const raw =
      "From: wes@qmail.com\r\n" +
      "To: milton_at_initech_com_r1@proxy.virtu.test\r\n" +
      "Message-ID: <gmail-123@mail.qmail.com>\r\n" +
      "In-Reply-To: <gmail-100@mail.qmail.com>\r\n" +
      "References: <orig-1@initech.com> <gmail-100@mail.qmail.com>\r\n" +
      "\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.headers.get("In-Reply-To")).toBe("<77.a@user.com>");
    expect(result.headers.get("References")).toBe("<orig-1@initech.com> <77.a@user.com>");
    // message-id reused from mapping
    expect(result.headers.get("Message-ID")).toBe("<77.b@user.com>");
  });

  test("missing Date synthesized on replies", async () => {
    const ctx = baseCtx();
    const raw = "From: wes@qmail.com\r\nTo: milton_at_initech_com_r1@proxy.virtu.test\r\n\r\nbody";
    const { headers } = parseMessage(enc.encode(raw));
    const result = await rewriteReply({ headers }, ctx);
    if (!result.ok) throw new Error("expected ok");
    expect(result.actions.synthesizedDate).toBe(true);
    expect(result.headers.get("Date")).toBe("Sat, 08 Aug 2026 12:00:00 +0000");
  });

  test("List-* headers are NOT whitelisted on replies", () => {
    expect(REPLY_HEADER_WHITELIST.some((h) => h.startsWith("list-"))).toBe(false);
  });
});
