import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { inboundBody, inboundMessageSize, writeInboundChunk } from "./inbound.ts";

test("pending SMTP writes settle on close or error without retaining listeners", async () => {
  for (const event of ["close", "error"] as const) {
    const fake = Object.assign(new EventEmitter(), {
      destroyed: false,
      writable: true,
      write: (_value: unknown, _callback: unknown) => true,
    });
    const pending = writeInboundChunk(fake as unknown as Socket, "payload");
    queueMicrotask(() => fake.emit(event, new Error("write failure")));
    await expect(pending).rejects.toThrow(event === "close" ? "closed" : "write failure");
    expect(fake.listenerCount("close")).toBe(0);
    expect(fake.listenerCount("error")).toBe(0);
  }
});

test("successful SMTP writes and already closed peers clean up write listeners", async () => {
  const fake = Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    write: (_value: unknown, callback: (error?: Error) => void) => {
      callback();
      return true;
    },
  });
  for (let i = 0; i < 100; i++) await writeInboundChunk(fake as unknown as Socket, "payload");
  expect(fake.listenerCount("close")).toBe(0);
  expect(fake.listenerCount("error")).toBe(0);
  fake.destroyed = true;
  await expect(writeInboundChunk(fake as unknown as Socket, "payload")).rejects.toThrow("closed");
  expect(fake.listenerCount("close")).toBe(0);
  expect(fake.listenerCount("error")).toBe(0);
});

test("the full synthetic cycle contains the declared mix and respects message caps", () => {
  const counts = new Map<number, number>();
  for (let i = 0; i < 100; i++) {
    const size = inboundMessageSize(i, 25 * 1024 * 1024);
    counts.set(size, (counts.get(size) ?? 0) + 1);
  }
  expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
    [16384, 70],
    [262144, 20],
    [2097152, 8],
    [26214400, 2],
  ]);
  for (let i = 0; i < 100; i++)
    expect(inboundMessageSize(i, 1024 * 1024)).toBeLessThanOrEqual(1024 * 1024);
});

test("streamed synthetic bodies preserve exact bytes and CRLF across awkward tails", () => {
  for (const bytes of [2, 127, 128, 129, 65536, 65537, 65538, 131073]) {
    const chunks = [...inboundBody(bytes, 123)];
    expect(chunks.every((chunk) => chunk.length <= 65536)).toBe(true);
    const body = Buffer.concat(chunks);
    expect(body.length).toBe(bytes);
    expect(body.subarray(-2).toString()).toBe("\r\n");
    expect(
      body
        .toString()
        .split("\r\n")
        .every((line) => line.length <= 126),
    ).toBe(true);
    expect(body.toString().replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  }
  const hash = (seed: number) => {
    const h = createHash("sha256");
    for (const chunk of inboundBody(100000, seed)) h.update(chunk);
    return h.digest("hex");
  };
  expect(hash(1)).toBe(hash(1));
  expect(hash(1)).not.toBe(hash(2));
});
