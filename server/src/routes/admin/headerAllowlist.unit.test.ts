import { describe, expect, test } from "bun:test";
import type { HeaderField } from "../../mail/index.ts";
import { allowlistHeaders } from "./headerAllowlist.ts";

const field = (name: string, rawValue: string): HeaderField => ({ name, rawValue });

describe("allowlistHeaders", () => {
  test("keeps routing headers, drops Subject and unknown headers", () => {
    const result = allowlistHeaders([
      field("Date", " Thu, 14 Aug 2026 10:00:00 +0000"),
      field("Subject", " the user's private business"),
      field("From", " a@ra.virtu.email"),
      field("To", " user@qmail.com"),
      field("Received", " from somewhere"),
      field("Authentication-Results", " mail.virtu.email; spf=pass"),
      field("Message-ID", " <abc@virtu.email>"),
      field("X-Virtu-Test-Id", " t-123"),
      field("X-Virtu-Spam-Flag", " YES (spf hardfail)"),
      field("X-Mailer", " Foo 1.0"),
    ]);
    const names = result.map((h) => h.name);
    expect(names).toEqual([
      "Date",
      "From",
      "To",
      "Message-ID",
      "X-Virtu-Test-Id",
      "X-Virtu-Spam-Flag",
    ]);
    expect(names).not.toContain("Subject");
  });

  test("unfolds and trims values", () => {
    const result = allowlistHeaders([field("To", " a@b.test,\r\n\tc@d.test")]);
    expect(result[0]?.value).toBe("a@b.test,\tc@d.test");
  });

  test("case-insensitive matching preserves original casing", () => {
    const result = allowlistHeaders([field("MESSAGE-ID", " <x@y>"), field("subject", " nope")]);
    expect(result).toEqual([{ name: "MESSAGE-ID", value: "<x@y>" }]);
  });
});
