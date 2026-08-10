/**
 * Auto-disable thresholds (PLAN Lane C / SimpleLogin should_disable), pure
 * over bounce timestamps with an injected clock.
 */

import { describe, expect, test } from "bun:test";
import { looksLikeDsn, shouldDisable } from "./bounce.ts";

const NOW = new Date("2026-08-08T12:00:00Z");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** n bounce timestamps, `agoMs` before NOW (spread by a second each). */
function bounces(n: number, agoMs: number): Date[] {
  return Array.from({ length: n }, (_, i) => new Date(NOW.getTime() - agoMs - i * 1000));
}

describe("shouldDisable", () => {
  test("12 bounces in 24h: still allowed", () => {
    expect(shouldDisable(bounces(12, HOUR), NOW).disable).toBe(false);
  });

  test("13 bounces in 24h: disable (>12/day)", () => {
    const verdict = shouldDisable(bounces(13, HOUR), NOW);
    expect(verdict.disable).toBe(true);
  });

  test("bounces spread over 25h don't count toward the daily rule", () => {
    // 7 recent + 6 just outside the 24h window.
    const times = [...bounces(7, HOUR), ...bounces(6, 25 * HOUR)];
    expect(shouldDisable(times, NOW).disable).toBe(false);
  });

  test("11 earlier in the week + 2 today: disable (>10/week with repeat)", () => {
    const times = [...bounces(11, 3 * DAY), ...bounces(2, HOUR)];
    const verdict = shouldDisable(times, NOW);
    expect(verdict.disable).toBe(true);
  });

  test("11 earlier in the week but only 1 today: allowed", () => {
    const times = [...bounces(11, 3 * DAY), ...bounces(1, HOUR)];
    expect(shouldDisable(times, NOW).disable).toBe(false);
  });

  test("a single-day burst of 12 does not trip the weekly rule", () => {
    // 12 today, nothing earlier in the week: neither rule 1 (needs >12)
    // nor rule 2 (weekly count excludes the last 24h) fires.
    expect(shouldDisable(bounces(12, HOUR), NOW).disable).toBe(false);
  });

  test("one bounce on each of 9 distinct days out of 10: disable", () => {
    const times = Array.from({ length: 9 }, (_, i) => new Date(NOW.getTime() - (i + 1) * DAY));
    const verdict = shouldDisable(times, NOW);
    expect(verdict.disable).toBe(true);
  });

  test("one bounce on each of 8 distinct days: allowed", () => {
    const times = Array.from({ length: 8 }, (_, i) => new Date(NOW.getTime() - (i + 1) * DAY));
    expect(shouldDisable(times, NOW).disable).toBe(false);
  });

  test("ancient bounce storms outside the 10-day window are ignored", () => {
    expect(shouldDisable(bounces(50, 11 * DAY), NOW).disable).toBe(false);
  });

  test("no bounces: allowed", () => {
    expect(shouldDisable([], NOW).disable).toBe(false);
  });
});

describe("looksLikeDsn", () => {
  test("multipart/report is a DSN regardless of envelope sender", () => {
    expect(
      looksLikeDsn({
        envelopeFrom: "mailer-daemon@qmail.com",
        contentType: 'multipart/report; report-type=delivery-status; boundary="b"',
      }),
    ).toBe(true);
  });

  test("null reverse path without Auto-Submitted counts as a DSN", () => {
    expect(looksLikeDsn({ envelopeFrom: "" })).toBe(true);
  });

  test("null reverse path with Auto-Submitted: auto-generated counts (postfix DSNs)", () => {
    expect(looksLikeDsn({ envelopeFrom: "", autoSubmitted: "auto-generated" })).toBe(true);
  });

  test("a vacation auto-reply (auto-replied) is NOT a DSN even with null sender", () => {
    expect(
      looksLikeDsn({
        envelopeFrom: "",
        contentType: "text/plain; charset=utf-8",
        autoSubmitted: "auto-replied",
      }),
    ).toBe(false);
  });

  test("ordinary mail with a real sender is NOT a DSN", () => {
    expect(looksLikeDsn({ envelopeFrom: "milton@initech.com", contentType: "text/plain" })).toBe(
      false,
    );
  });
});
