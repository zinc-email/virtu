import { describe, expect, test } from "bun:test";
import { createLogger } from "./log.ts";

const FIXED_NOW = () => new Date("2026-08-14T15:04:05.678Z");

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("createLogger json", () => {
  test("emits one JSON object per line with ts/level/component/event leading", () => {
    const { lines, write } = capture();
    const log = createLogger("queue", { format: "json", write, now: FIXED_NOW });
    log.info("delivery_sent", { queueId: 42, to: "a@b.test", durationMs: 812 });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toEqual({
      ts: "2026-08-14T15:04:05.678Z",
      level: "info",
      component: "queue",
      event: "delivery_sent",
      queueId: 42,
      to: "a@b.test",
      durationMs: 812,
    });
    // Key order is part of the contract (grep-ability of raw logs).
    expect(Object.keys(entry).slice(0, 4)).toEqual(["ts", "level", "component", "event"]);
  });

  test("drops undefined fields, keeps null and false", () => {
    const { lines, write } = capture();
    const log = createLogger("mx", { format: "json", write, now: FIXED_NOW });
    log.warn("rcpt_reject", { reason: null, tlsUsed: false, detail: undefined });

    const entry = JSON.parse(lines[0]!);
    expect("detail" in entry).toBe(false);
    expect(entry.reason).toBeNull();
    expect(entry.tlsUsed).toBe(false);
  });

  test("child binds fields under every entry; call fields win on collision", () => {
    const { lines, write } = capture();
    const log = createLogger("queue", { format: "json", write, now: FIXED_NOW });
    const bound = log.child({ queueId: 7, phase: "claim" });
    bound.info("retry", { phase: "deliver", tries: 3 });

    const entry = JSON.parse(lines[0]!);
    expect(entry.queueId).toBe(7);
    expect(entry.phase).toBe("deliver");
    expect(entry.tries).toBe(3);
  });

  test("level filters below the minimum", () => {
    const { lines, write } = capture();
    const log = createLogger("mx", { format: "json", level: "warn", write, now: FIXED_NOW });
    log.debug("noise");
    log.info("noise");
    log.warn("kept");
    log.error("kept_too");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("kept");
    expect(JSON.parse(lines[1]!).event).toBe("kept_too");
  });
});

describe("createLogger pretty", () => {
  test("emits a human line: time, tag, component, event, k=v", () => {
    const { lines, write } = capture();
    const log = createLogger("queue", { format: "pretty", write, now: FIXED_NOW });
    log.info("delivery_sent", { queueId: 42, to: "a@b.test" });
    expect(lines[0]).toBe("15:04:05 INF queue delivery_sent queueId=42 to=a@b.test");
  });

  test("quotes values with spaces or shell-noise", () => {
    const { lines, write } = capture();
    const log = createLogger("queue", { format: "pretty", write, now: FIXED_NOW });
    log.error("delivery_failed", { error: "550 5.7.1 rejected by policy" });
    expect(lines[0]).toBe(
      '15:04:05 ERR queue delivery_failed error="550 5.7.1 rejected by policy"',
    );
  });
});
