import { describe, expect, test } from "bun:test";
import { createBulkhead } from "./verifyBulkhead";

describe("createBulkhead", () => {
  test("admits up to the limit, refuses past it, reopens on release", () => {
    const bulkhead = createBulkhead(2);
    expect(bulkhead.saturated()).toBe(false);
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.saturated()).toBe(true);
    expect(bulkhead.tryAcquire()).toBe(false);
    bulkhead.release();
    expect(bulkhead.saturated()).toBe(false);
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.tryAcquire()).toBe(false);
  });

  test("release never underflows into extra capacity", () => {
    const bulkhead = createBulkhead(1);
    bulkhead.release();
    bulkhead.release();
    expect(bulkhead.tryAcquire()).toBe(true);
    expect(bulkhead.tryAcquire()).toBe(false);
  });
});
