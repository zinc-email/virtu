import { describe, expect, test } from "bun:test";
import { decideQueueQuota, QUEUE_FULL_REPLY } from "./quota.ts";

const limits = { maxPendingRows: 10, maxPendingBytes: 1000 };

describe("decideQueueQuota", () => {
  test("under both caps: not full", () => {
    expect(decideQueueQuota(limits, { rows: 9, bytes: 999 })).toBe(false);
    expect(decideQueueQuota(limits, { rows: 0, bytes: 0 })).toBe(false);
  });

  test("at either cap: full (rows and bytes are independent)", () => {
    expect(decideQueueQuota(limits, { rows: 10, bytes: 0 })).toBe(true);
    expect(decideQueueQuota(limits, { rows: 0, bytes: 1000 })).toBe(true);
    expect(decideQueueQuota(limits, { rows: 50, bytes: 5000 })).toBe(true);
  });

  test("0 disables a cap", () => {
    expect(
      decideQueueQuota({ maxPendingRows: 0, maxPendingBytes: 0 }, { rows: 1e9, bytes: 1e12 }),
    ).toBe(false);
    expect(
      decideQueueQuota({ maxPendingRows: 0, maxPendingBytes: 1000 }, { rows: 1e9, bytes: 1 }),
    ).toBe(false);
    expect(
      decideQueueQuota({ maxPendingRows: 10, maxPendingBytes: 0 }, { rows: 1, bytes: 1e12 }),
    ).toBe(false);
  });

  test("the reply is a tempfail with the mail-system-full enhanced code", () => {
    expect(QUEUE_FULL_REPLY.code).toBe(452);
    expect(QUEUE_FULL_REPLY.enhanced).toBe("4.3.1");
  });
});
