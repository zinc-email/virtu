import { expect, test } from "bun:test";
import { arcFieldInstance } from "./arcInstance.ts";

test("ARC instance uses decimal syntax consistently, including duplicate failed tags", () => {
  for (const value of ["+1", "1.0", "1e1", "001", "0", "-1"])
    expect(arcFieldInstance(`i=${value}; cv=pass`)).toBeNull();
  expect(arcFieldInstance("i=1; i=3; cv=pass")).toBe(3);
  expect(arcFieldInstance("(outer (nested)) i (tag) =\r\n\t02; cv=fail")).toBe(2);
  expect(arcFieldInstance("i=50; cv=pass")).toBe(50);
});
