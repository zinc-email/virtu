import { describe, expect, test } from "bun:test";
import { timeAgo } from "./timeAgo.ts";

const NOW = new Date("2026-09-01T12:00:00Z");
const ago = (ms: number) => timeAgo(new Date(NOW.getTime() - ms), NOW);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("timeAgo", () => {
  test("bands from seconds to years", () => {
    expect(ago(5 * SECOND)).toBe("just now");
    expect(ago(60 * SECOND)).toBe("a minute ago");
    expect(ago(2 * MINUTE)).toBe("2 minutes ago");
    expect(ago(44 * MINUTE)).toBe("44 minutes ago");
    expect(ago(HOUR)).toBe("an hour ago");
    expect(ago(5 * HOUR)).toBe("5 hours ago");
    expect(ago(24 * HOUR)).toBe("a day ago");
    expect(ago(3 * DAY)).toBe("3 days ago");
    expect(ago(30 * DAY)).toBe("a month ago");
    expect(ago(90 * DAY)).toBe("3 months ago");
    expect(ago(400 * DAY)).toBe("a year ago");
    expect(ago(3 * 366 * DAY)).toBe("3 years ago");
  });

  test("future dates clamp to just now (clock skew tolerance)", () => {
    expect(timeAgo(new Date(NOW.getTime() + 60 * SECOND), NOW)).toBe("just now");
  });
});
