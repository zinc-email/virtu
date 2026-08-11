import { describe, expect, test } from "bun:test";
import { mailboxMatchKey } from "./addressMatch.ts";

describe("mailboxMatchKey", () => {
  test("strips plus-tags on any provider", () => {
    expect(mailboxMatchKey("wes+work@fastmail.com")).toBe("wes@fastmail.com");
    expect(mailboxMatchKey("Wes+A+B@Example.com")).toBe("wes@example.com");
  });

  test("Gmail: dots and googlemail fold to the same inbox", () => {
    const key = "wes@gmail.com";
    expect(mailboxMatchKey("w.es@gmail.com")).toBe(key);
    expect(mailboxMatchKey("w.e.s@googlemail.com")).toBe(key);
    expect(mailboxMatchKey("wes+shopping@googlemail.com")).toBe(key);
  });

  test("dot-stripping is Gmail-only (dots stay significant elsewhere)", () => {
    expect(mailboxMatchKey("w.es@fastmail.com")).not.toBe(mailboxMatchKey("wes@fastmail.com"));
    expect(mailboxMatchKey("w.es@fastmail.com")).toBe("w.es@fastmail.com");
  });

  test("case and surrounding whitespace normalized", () => {
    expect(mailboxMatchKey("  WES@Gmail.COM ")).toBe("wes@gmail.com");
  });

  test("no @ returns the trimmed lowercased input", () => {
    expect(mailboxMatchKey("  MAILER-DAEMON ")).toBe("mailer-daemon");
  });
});
