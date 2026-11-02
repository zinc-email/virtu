import { expect, test } from "bun:test";
import { assertLineLengths } from "./lineLength.ts";
const enc = new TextEncoder();
test("checks octets including final unterminated lines without changing input", () => {
  for (const ending of ["", "\r\n", "\n"]) {
    const raw = enc.encode("x".repeat(998) + ending);
    const original = raw.slice();
    expect(() => assertLineLengths(raw)).not.toThrow();
    expect(raw).toEqual(original);
    expect(() => assertLineLengths(enc.encode("x".repeat(999) + ending))).toThrow();
  }
  expect(() => assertLineLengths(enc.encode("é".repeat(500)))).toThrow();
});
