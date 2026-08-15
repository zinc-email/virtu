import { describe, expect, test } from "bun:test";
import { providerFor } from "./provider.ts";
import { Registry } from "./registry.ts";

describe("Counter", () => {
  test("labelled increments accumulate per label set", async () => {
    const r = new Registry();
    const c = r.counter("virtu_test_total", "help text", ["result"]);
    c.inc({ result: "sent" });
    c.inc({ result: "sent" }, 2);
    c.inc({ result: "failed" });

    expect(await r.expose()).toBe(
      [
        "# HELP virtu_test_total help text",
        "# TYPE virtu_test_total counter",
        'virtu_test_total{result="sent"} 3',
        'virtu_test_total{result="failed"} 1',
        "",
      ].join("\n"),
    );
  });

  test("unlabelled counter exposes 0 before any increment", async () => {
    const r = new Registry();
    r.counter("virtu_zero_total", "zero");
    expect(await r.expose()).toContain("virtu_zero_total 0");
  });

  test("missing label throws; label values are escaped", async () => {
    const r = new Registry();
    const c = r.counter("virtu_esc_total", "esc", ["reason"]);
    expect(() => c.inc({})).toThrow('missing label "reason"');
    c.inc({ reason: 'quote " backslash \\ newline \n end' });
    expect(await r.expose()).toContain(
      'virtu_esc_total{reason="quote \\" backslash \\\\ newline \\n end"} 1',
    );
  });
});

describe("Gauge", () => {
  test("set overwrites; collect callback fills values at expose time", async () => {
    const r = new Registry();
    let source = 5;
    r.gauge("virtu_depth", "depth", ["status"], async (g) => {
      g.set({ status: "pending" }, source);
    });
    expect(await r.expose()).toContain('virtu_depth{status="pending"} 5');
    source = 9;
    expect(await r.expose()).toContain('virtu_depth{status="pending"} 9');
  });

  test("failing collector keeps last-known values", async () => {
    const r = new Registry();
    let calls = 0;
    r.gauge("virtu_flaky", "flaky", [], async (g) => {
      calls += 1;
      if (calls > 1) throw new Error("db down");
      g.set(7);
    });
    await r.expose();
    expect(await r.expose()).toContain("virtu_flaky 7");
  });

  test("slow collector is bounded by the timeout, keeps last values", async () => {
    const r = new Registry();
    let first = true;
    r.gauge("virtu_slow", "slow", [], async (g) => {
      if (first) {
        first = false;
        g.set(3);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
      g.set(99);
    });
    await r.expose(50);
    const started = Date.now();
    const text = await r.expose(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toContain("virtu_slow 3");
  });
});

describe("Histogram", () => {
  test("cumulative buckets, +Inf, sum and count", async () => {
    const r = new Registry();
    const h = r.histogram("virtu_dur_seconds", "durations", [1, 5], ["result"]);
    h.observe({ result: "sent" }, 0.5);
    h.observe({ result: "sent" }, 3);
    h.observe({ result: "sent" }, 60);

    expect(await r.expose()).toBe(
      [
        "# HELP virtu_dur_seconds durations",
        "# TYPE virtu_dur_seconds histogram",
        'virtu_dur_seconds_bucket{result="sent",le="1"} 1',
        'virtu_dur_seconds_bucket{result="sent",le="5"} 2',
        'virtu_dur_seconds_bucket{result="sent",le="+Inf"} 3',
        'virtu_dur_seconds_sum{result="sent"} 63.5',
        'virtu_dur_seconds_count{result="sent"} 3',
        "",
      ].join("\n"),
    );
  });

  test("rejects empty or unsorted buckets", () => {
    const r = new Registry();
    expect(() => r.histogram("virtu_bad", "bad", [])).toThrow("ascending");
    expect(() => r.histogram("virtu_bad2", "bad", [5, 1])).toThrow("ascending");
  });
});

describe("Registry", () => {
  test("rejects duplicate metric names", () => {
    const r = new Registry();
    r.counter("virtu_dup", "one");
    expect(() => r.gauge("virtu_dup", "two")).toThrow("already registered");
  });
});

describe("providerFor", () => {
  test("buckets known consumer domains, everything else is other", () => {
    expect(providerFor("someone@gmail.com")).toBe("gmail");
    expect(providerFor("Someone@GoogleMail.com")).toBe("gmail");
    expect(providerFor("a@hotmail.com")).toBe("microsoft");
    expect(providerFor("a@aol.com")).toBe("yahoo");
    expect(providerFor("me.com")).toBe("icloud");
    expect(providerFor("a@pm.me")).toBe("proton");
    expect(providerFor("a@example.org")).toBe("other");
    expect(providerFor("not-an-address")).toBe("other");
    expect(providerFor("evil@internal\nnewline.example")).toBe("other");
  });
});
