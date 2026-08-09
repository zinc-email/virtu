/**
 * Backoff math: exponential growth, cap, jitter bounds. Deterministic via
 * the injected random source.
 */

import { describe, expect, test } from "bun:test";
import { BASE_DELAY_MS, JITTER, MAX_DELAY_MS, backoffDelayMs } from "./backoff.ts";

/** random() => 0.5 makes the jitter factor exactly 1. */
const noJitter = () => 0.5;

describe("backoffDelayMs", () => {
  test("doubles per attempt with jitter neutralized", () => {
    expect(backoffDelayMs(1, noJitter)).toBe(BASE_DELAY_MS);
    expect(backoffDelayMs(2, noJitter)).toBe(BASE_DELAY_MS * 2);
    expect(backoffDelayMs(3, noJitter)).toBe(BASE_DELAY_MS * 4);
    expect(backoffDelayMs(4, noJitter)).toBe(BASE_DELAY_MS * 8);
  });

  test("caps at MAX_DELAY_MS", () => {
    expect(backoffDelayMs(20, noJitter)).toBe(MAX_DELAY_MS);
  });

  test("tries below 1 behave like the first attempt", () => {
    expect(backoffDelayMs(0, noJitter)).toBe(BASE_DELAY_MS);
    expect(backoffDelayMs(-3, noJitter)).toBe(BASE_DELAY_MS);
  });

  test("jitter stays within ±20%", () => {
    const low = backoffDelayMs(3, () => 0);
    const high = backoffDelayMs(3, () => 1);
    expect(low).toBe(Math.round(BASE_DELAY_MS * 4 * (1 - JITTER)));
    expect(high).toBe(Math.round(BASE_DELAY_MS * 4 * (1 + JITTER)));
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(low);
      expect(d).toBeLessThanOrEqual(high);
    }
  });
});
