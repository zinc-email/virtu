import { expect, test } from "bun:test";
import { DataSpool, withDataProcessing } from "./spool.ts";
import { DataDecoder, dotStuff, dotStuffChunks } from "./wire.ts";

test("DATA is drained to disk in bounded blocks, including millions of short lines", async () => {
  const spool = await DataSpool.create();
  try {
    const d = new DataDecoder(4 * 1024 * 1024, 998);
    const input = Buffer.from("\r\n".repeat(1024 * 1024));
    for (let offset = 0; offset < input.length; offset += 32768) {
      d.push(input.subarray(offset, offset + 32768));
      const output = d.drain();
      expect(output.length).toBeLessThanOrEqual(32768);
      expect(d.message().length).toBe(0);
      await spool.write(output);
    }
    expect(d.push(Buffer.from(".\r\n"))).toEqual(Buffer.alloc(0));
    expect(await spool.read()).toEqual(input);
  } finally {
    await spool.close();
  }
  await spool.close();
});

test("only one waiting DATA transaction materializes at a time; errors release the slot", async () => {
  let active = 0;
  let peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      withDataProcessing(async () => {
        active++;
        peak = Math.max(peak, active);
        try {
          await Bun.sleep(1);
          if (i === 3) throw new Error("injected");
        } finally {
          active--;
        }
      }),
    ),
  );
  expect(peak).toBe(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});

test("bounded outgoing blocks preserve dot transparency and line endings", () => {
  for (const text of [
    "",
    ".",
    "..\r\n.\n",
    "a\r",
    "a\r\r",
    "\r\n".repeat(10000),
    "é".repeat(5000),
  ]) {
    const raw = Buffer.from(text);
    const blocks = [...dotStuffChunks(raw, 127)];
    expect(blocks.every((b) => b.length <= 127)).toBe(true);
    expect(Buffer.concat(blocks).equals(dotStuff(raw))).toBe(true);
  }
});
