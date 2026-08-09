/**
 * Reverse-alias address generation: sanitization, shape, length cap, and the
 * guarantee that a reverse alias can never parse as a VERP address.
 */

import { describe, expect, test } from "bun:test";
import { parseVerp } from "../mail/index.ts";
import { buildReverseAliasAddress, randomSuffix, sanitizeForReverseAlias } from "./contacts.ts";

describe("sanitizeForReverseAlias", () => {
  test("lowercases and maps @ to _at_", () => {
    expect(sanitizeForReverseAlias("Milton@Initech.com")).toBe("milton_at_initech_com");
  });

  test("flattens dots and specials (no VERP-like dot structure survives)", () => {
    expect(sanitizeForReverseAlias("first.last+tag@sub.example.co")).toBe(
      "first_last_tag_at_sub_example_co",
    );
  });

  test("degenerate input still yields a usable prefix", () => {
    expect(sanitizeForReverseAlias("@@@")).not.toBe("");
  });
});

describe("buildReverseAliasAddress", () => {
  test("shape: {sanitized}_{random}@{domain}", () => {
    const addr = buildReverseAliasAddress("milton@initech.com", "virtu.email");
    expect(addr).toMatch(/^milton_at_initech_com_[a-z0-9]{8}@virtu\.email$/);
  });

  test("localpart never exceeds 64 chars, random suffix survives trimming", () => {
    const longEmail = `${"x".repeat(80)}@very-long-domain-name-example.com`;
    const addr = buildReverseAliasAddress(longEmail, "virtu.email");
    const localpart = addr.slice(0, addr.indexOf("@"));
    expect(localpart.length).toBeLessThanOrEqual(64);
    expect(localpart).toMatch(/_[a-z0-9]{8}$/);
  });

  test("two builds for the same contact differ (random suffix)", () => {
    const a = buildReverseAliasAddress("milton@initech.com", "virtu.email");
    const b = buildReverseAliasAddress("milton@initech.com", "virtu.email");
    expect(a).not.toBe(b);
  });

  test("a reverse alias never parses as a VERP address", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    for (const email of ["vt.abc@x.com", "vt.a.b@x.com", "milton@initech.com"]) {
      const addr = buildReverseAliasAddress(email, "virtu.email");
      expect(parseVerp(addr, secret)).toBeNull();
    }
  });
});

describe("randomSuffix", () => {
  test("length and alphabet", () => {
    const s = randomSuffix();
    expect(s).toMatch(/^[a-z0-9]{8}$/);
  });
});
