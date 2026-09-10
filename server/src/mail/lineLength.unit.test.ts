import { describe, expect, test } from "bun:test";
import { parseMessage } from "./headers.ts";
import { foldLongLines, MAX_LINE_OCTETS } from "./lineLength.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function longestLine(bytes: Uint8Array): number {
  return Math.max(
    ...dec
      .decode(bytes)
      .split("\n")
      .map((l) => l.replace(/\r$/, "").length),
  );
}

describe("foldLongLines", () => {
  test("a message within the limit is returned untouched, byte for byte", () => {
    const msg = enc.encode(`Subject: hi\r\n\r\n${"x".repeat(MAX_LINE_OCTETS)}\r\nend\r\n`);
    expect(foldLongLines(msg)).toBe(msg);
  });

  test("breaks at the last whitespace before the limit (a legal header fold)", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const msg = enc.encode(`Subject: ${words}\r\n\r\nbody\r\n`);
    const out = foldLongLines(msg);
    expect(longestLine(out)).toBeLessThanOrEqual(MAX_LINE_OCTETS);
    // The fold is transparent to a header parser: the unfolded value is the original.
    expect(parseMessage(out).headers.get("Subject")).toBe(words);
    expect(dec.decode(out)).toEndWith("\r\n\r\nbody\r\n");
  });

  test("a line with no whitespace is hard-broken with CRLF+SPACE", () => {
    const msg = enc.encode(`Subject: hi\r\n\r\n${"a".repeat(2500)}\r\n`);
    const out = dec.decode(foldLongLines(msg));
    const lines = out.split("\r\n");
    expect(lines[2]).toBe("a".repeat(998));
    expect(lines[3]).toBe(` ${"a".repeat(997)}`);
    expect(lines[4]).toBe(` ${"a".repeat(505)}`);
    expect(lines[5]).toBe("");
    expect(longestLine(foldLongLines(msg))).toBeLessThanOrEqual(MAX_LINE_OCTETS);
  });

  test("a hard break never lands inside a multi-byte character", () => {
    const msg = enc.encode(`\r\n${"é".repeat(1500)}\r\n`);
    const out = foldLongLines(msg);
    expect(longestLine(out)).toBeLessThanOrEqual(MAX_LINE_OCTETS);
    // Decoding with fatal: true throws on a split sequence.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(out)).not.toThrow();
    expect(dec.decode(out).replace(/\r\n /g, "")).toBe(`\r\n${"é".repeat(1500)}\r\n`);
  });

  test("trailing whitespace is not a fold point that would leave an empty line", () => {
    const msg = enc.encode(`${"b".repeat(1200)}${" ".repeat(50)}\r\n`);
    const out = dec.decode(foldLongLines(msg));
    for (const line of out.split("\r\n")) expect(line.trim() === "" && line !== "").toBe(false);
    expect(out.replace(/\r\n /g, "")).toBe(`${"b".repeat(1200)}${" ".repeat(50)}\r\n`);
  });

  test("bare-LF and unterminated final lines keep their endings", () => {
    const msg = enc.encode(`${"c".repeat(1000)}\n${"d".repeat(1000)}`);
    const out = dec.decode(foldLongLines(msg));
    expect(out.split("\n").length).toBe(4);
    expect(out.endsWith("\n")).toBe(false);
    expect(out.replace(/\r\n /g, "")).toBe(`${"c".repeat(1000)}\n${"d".repeat(1000)}`);
  });
});
