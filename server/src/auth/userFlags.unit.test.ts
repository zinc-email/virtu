import { describe, expect, test } from "bun:test";
import { hasFlag, isAdmin, USER_FLAGS } from "./userFlags.ts";

describe("userFlags", () => {
  test("fresh users (flags 0) hold no flags", () => {
    expect(hasFlag(0, USER_FLAGS.admin)).toBe(false);
    expect(isAdmin({ flags: 0 })).toBe(false);
  });

  test("admin bit sets and reads independently of other bits", () => {
    expect(isAdmin({ flags: USER_FLAGS.admin })).toBe(true);
    expect(isAdmin({ flags: USER_FLAGS.admin | (1 << 5) })).toBe(true);
    expect(isAdmin({ flags: 1 << 5 })).toBe(false);
  });

  test("granting is idempotent, revoking clears only the one bit", () => {
    const granted = 0 | USER_FLAGS.admin;
    expect(granted | USER_FLAGS.admin).toBe(granted);
    const withOther = granted | (1 << 3);
    expect(withOther & ~USER_FLAGS.admin).toBe(1 << 3);
  });
});
