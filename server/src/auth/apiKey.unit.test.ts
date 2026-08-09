import { describe, expect, test } from "bun:test";
import { generateApiKey, hashApiKey } from "./apiKey";

describe("generateApiKey", () => {
  test("returns a url-safe long string", () => {
    const key = generateApiKey();
    expect(key.length).toBeGreaterThanOrEqual(40);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("keys are unique", () => {
    const keys = new Set(Array.from({ length: 100 }, generateApiKey));
    expect(keys.size).toBe(100);
  });
});

describe("hashApiKey", () => {
  test("sha256 hex, deterministic", () => {
    // Known vector: sha256("abc")
    expect(hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashApiKey("abc")).toBe(hashApiKey("abc"));
  });

  test("64 lowercase hex chars, distinct per input", () => {
    const a = hashApiKey(generateApiKey());
    const b = hashApiKey(generateApiKey());
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
