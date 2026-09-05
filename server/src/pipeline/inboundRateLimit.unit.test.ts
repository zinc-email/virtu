import { describe, expect, test } from "bun:test";
import { decideInboundRateLimit } from "./inboundRateLimit.ts";

const LIMITS = { perAliasPerMinute: 10, perMailboxPerMinute: 15 };

describe("decideInboundRateLimit", () => {
  test("under both budgets: null", () => {
    expect(decideInboundRateLimit(LIMITS, { aliasMessages: 9, mailboxCopiesMax: 14 })).toBeNull();
  });

  test("at the alias budget: the next message trips (limit is the count already seen)", () => {
    expect(decideInboundRateLimit(LIMITS, { aliasMessages: 10, mailboxCopiesMax: 0 })).toBe(
      "alias",
    );
  });

  test("at the mailbox budget: mailbox scope", () => {
    expect(decideInboundRateLimit(LIMITS, { aliasMessages: 3, mailboxCopiesMax: 15 })).toBe(
      "mailbox",
    );
  });

  test("both over: alias scope wins (names the flooded address)", () => {
    expect(decideInboundRateLimit(LIMITS, { aliasMessages: 50, mailboxCopiesMax: 50 })).toBe(
      "alias",
    );
  });

  test("0 disables a scope independently", () => {
    expect(
      decideInboundRateLimit(
        { perAliasPerMinute: 0, perMailboxPerMinute: 15 },
        { aliasMessages: 1000, mailboxCopiesMax: 1 },
      ),
    ).toBeNull();
    expect(
      decideInboundRateLimit(
        { perAliasPerMinute: 10, perMailboxPerMinute: 0 },
        { aliasMessages: 1, mailboxCopiesMax: 1000 },
      ),
    ).toBeNull();
    expect(
      decideInboundRateLimit(
        { perAliasPerMinute: 0, perMailboxPerMinute: 0 },
        { aliasMessages: 1000, mailboxCopiesMax: 1000 },
      ),
    ).toBeNull();
  });
});
