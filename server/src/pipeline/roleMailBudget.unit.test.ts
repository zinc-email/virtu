import { describe, expect, test } from "bun:test";
import { createRoleMailBudget } from "./roleMailBudget.ts";

describe("createRoleMailBudget", () => {
  test("accepts up to the budget per localpart per trailing minute, then refuses", () => {
    const b = createRoleMailBudget(2);
    const t0 = new Date("2026-09-09T00:00:00Z");
    expect(b.take("abuse", t0)).toBe(true);
    expect(b.take("abuse", t0)).toBe(true);
    expect(b.take("abuse", t0)).toBe(false);
    expect(b.take("postmaster", t0)).toBe(true); // separate window
    expect(b.take("abuse", new Date(t0.getTime() + 61_000))).toBe(true); // window slid
  });

  test("0 means unlimited", () => {
    const b = createRoleMailBudget(0);
    for (let i = 0; i < 1000; i++) expect(b.take("abuse")).toBe(true);
  });
});
