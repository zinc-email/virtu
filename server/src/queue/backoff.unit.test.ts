/**
 * Backoff math: exponential growth, cap, jitter bounds, and the retry
 * horizon the defaults promise. Deterministic via the injected random.
 */

import { describe, expect, test } from "bun:test";
import { BASE_DELAY_MS, JITTER, MAX_DELAY_MS, backoffDelayMs } from "./backoff.ts";

/** random() => 0.5 makes the jitter factor exactly 1. */
const noJitter = { random: () => 0.5 };

describe("backoffDelayMs", () => {
  test("doubles per attempt with jitter neutralized", () => {
    expect(backoffDelayMs(1, noJitter)).toBe(BASE_DELAY_MS);
    expect(backoffDelayMs(2, noJitter)).toBe(BASE_DELAY_MS * 2);
    expect(backoffDelayMs(3, noJitter)).toBe(BASE_DELAY_MS * 4);
    expect(backoffDelayMs(4, noJitter)).toBe(BASE_DELAY_MS * 8);
  });

  test("caps at MAX_DELAY_MS by default", () => {
    expect(backoffDelayMs(20, noJitter)).toBe(MAX_DELAY_MS);
  });

  test("caps at a configured maxMs (the test network pins 60s)", () => {
    expect(backoffDelayMs(20, { ...noJitter, maxMs: 60_000 })).toBe(60_000);
    expect(backoffDelayMs(1, { ...noJitter, maxMs: 60_000 })).toBe(BASE_DELAY_MS);
  });

  test("configurable baseMs", () => {
    expect(backoffDelayMs(2, { ...noJitter, baseMs: 1000 })).toBe(2000);
  });

  test("tries below 1 behave like the first attempt", () => {
    expect(backoffDelayMs(0, noJitter)).toBe(BASE_DELAY_MS);
    expect(backoffDelayMs(-3, noJitter)).toBe(BASE_DELAY_MS);
  });

  test("jitter stays within ±20%", () => {
    const low = backoffDelayMs(3, { random: () => 0 });
    const high = backoffDelayMs(3, { random: () => 1 });
    expect(low).toBe(Math.round(BASE_DELAY_MS * 4 * (1 - JITTER)));
    expect(high).toBe(Math.round(BASE_DELAY_MS * 4 * (1 + JITTER)));
    for (let i = 0; i < 50; i++) {
      const d = backoffDelayMs(3);
      expect(d).toBeGreaterThanOrEqual(low);
      expect(d).toBeLessThanOrEqual(high);
    }
  });

  test("default horizon: 25 tries ≈ 4 days (RFC 5321 customary)", () => {
    // Sum of delays after tries 1..24 = time until the 25th (final) attempt.
    let totalMs = 0;
    for (let tries = 1; tries < 25; tries++) totalMs += backoffDelayMs(tries, noJitter);
    const days = totalMs / 86_400_000;
    expect(days).toBeGreaterThan(3.5);
    expect(days).toBeLessThan(5);
  });
});
