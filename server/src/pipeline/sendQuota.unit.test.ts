import { describe, expect, test } from "bun:test";
import { dailySendLimit, decideSendQuota } from "./sendQuota.ts";

const LIMITS = { freePerDay: 50, premiumPerDay: 500 };

describe("dailySendLimit", () => {
  test("plan defaults by premium standing", () => {
    expect(dailySendLimit({ maxDailySends: null }, false, LIMITS)).toBe(50);
    expect(dailySendLimit({ maxDailySends: null }, true, LIMITS)).toBe(500);
  });

  test("per-user override beats the plan default in both directions", () => {
    expect(dailySendLimit({ maxDailySends: 5 }, true, LIMITS)).toBe(5);
    expect(dailySendLimit({ maxDailySends: 2000 }, false, LIMITS)).toBe(2000);
  });

  test("override of 0 means unlimited (not 'no sends')", () => {
    expect(dailySendLimit({ maxDailySends: 0 }, false, LIMITS)).toBe(0);
    expect(decideSendQuota(0, 1_000_000, 100)).toEqual({ allowed: true });
  });
});

describe("decideSendQuota", () => {
  test("allows up to the limit inclusive", () => {
    expect(decideSendQuota(10, 8, 2)).toEqual({ allowed: true });
  });

  test("refuses the batch that would cross the limit", () => {
    expect(decideSendQuota(10, 9, 2)).toEqual({ allowed: false, limit: 10, used: 9 });
  });

  test("refuses when already at the limit", () => {
    expect(decideSendQuota(10, 10, 1)).toEqual({ allowed: false, limit: 10, used: 10 });
  });

  test("a multi-recipient message is all-or-nothing", () => {
    // 3 recipients with 2 slots left: the whole message refuses rather than
    // silently sending to a subset.
    expect(decideSendQuota(10, 8, 3)).toEqual({ allowed: false, limit: 10, used: 8 });
  });
});
