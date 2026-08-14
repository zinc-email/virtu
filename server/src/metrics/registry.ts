/**
 * Prometheus metrics, first-party (PLAN decision #15). Counters, gauges
 * (optionally filled by an on-scrape collect callback) and fixed-bucket
 * histograms, with text exposition. Hand-rolled rather than prom-client:
 * the exposition format is small and stable, and prom-client's default
 * collectors lean on perf_hooks/V8 hooks with patchy Bun support — this is
 * the ~5% of it we'd use, with zero Bun risk and full unit-testability.
 */

type LabelValues = Record<string, string>;

/** Escape a label value per the Prometheus text format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderLabels(labels: LabelValues, extra?: string): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  if (extra !== undefined) parts.push(extra);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

/** Stable map key for one label combination. */
function labelKey(labelNames: readonly string[], labels: LabelValues): string {
  return JSON.stringify(labelNames.map((name) => labels[name] ?? ""));
}

function assertLabels(
  metric: string,
  labelNames: readonly string[],
  labels: LabelValues,
): LabelValues {
  const normalized: LabelValues = {};
  for (const name of labelNames) {
    const value = labels[name];
    if (value === undefined) {
      throw new Error(`metric ${metric}: missing label "${name}"`);
    }
    normalized[name] = value;
  }
  return normalized;
}

export class Counter {
  private readonly values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[] = [],
  ) {}

  inc(labels: LabelValues = {}, value = 1): void {
    const normalized = assertLabels(this.name, this.labelNames, labels);
    const key = labelKey(this.labelNames, normalized);
    const entry = this.values.get(key);
    if (entry === undefined) {
      this.values.set(key, { labels: normalized, value });
    } else {
      entry.value += value;
    }
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0 && this.labelNames.length === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  private readonly values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[] = [],
    /**
     * On-scrape filler: called (with a deadline) by Registry.expose before
     * rendering. On failure/timeout the gauge keeps its last-known values —
     * a slow Postgres must degrade the queue-depth gauge, not the scrape.
     */
    readonly collect?: (gauge: Gauge) => Promise<void>,
  ) {}

  set(labels: LabelValues, value: number): void;
  set(value: number): void;
  set(labelsOrValue: LabelValues | number, maybeValue?: number): void {
    const labels = typeof labelsOrValue === "number" ? {} : labelsOrValue;
    const value = typeof labelsOrValue === "number" ? labelsOrValue : (maybeValue as number);
    const normalized = assertLabels(this.name, this.labelNames, labels);
    this.values.set(labelKey(this.labelNames, normalized), { labels: normalized, value });
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${value}`);
    }
    return lines.join("\n");
  }
}

export class Histogram {
  private readonly series = new Map<
    string,
    { labels: LabelValues; buckets: number[]; sum: number; count: number }
  >();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[],
    private readonly labelNames: readonly string[] = [],
  ) {
    const sorted = [...buckets].every((b, i) => i === 0 || b > buckets[i - 1]!);
    if (buckets.length === 0 || !sorted) {
      throw new Error(`metric ${name}: buckets must be non-empty and ascending`);
    }
  }

  observe(labels: LabelValues, value: number): void;
  observe(value: number): void;
  observe(labelsOrValue: LabelValues | number, maybeValue?: number): void {
    const labels = typeof labelsOrValue === "number" ? {} : labelsOrValue;
    const value = typeof labelsOrValue === "number" ? labelsOrValue : (maybeValue as number);
    const normalized = assertLabels(this.name, this.labelNames, labels);
    const key = labelKey(this.labelNames, normalized);
    let entry = this.series.get(key);
    if (entry === undefined) {
      entry = {
        labels: normalized,
        buckets: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) entry.buckets[i]! += 1;
    }
    entry.sum += value;
    entry.count += 1;
  }

  expose(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${this.name}_bucket${renderLabels(labels, `le="${this.buckets[i]}"`)} ${buckets[i]}`,
        );
      }
      lines.push(`${this.name}_bucket${renderLabels(labels, 'le="+Inf"')} ${count}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${count}`);
    }
    return lines.join("\n");
  }
}

/** How long expose() waits on collect callbacks before falling back. */
const COLLECT_TIMEOUT_MS = 2000;

export class Registry {
  private readonly metrics: Array<Counter | Gauge | Histogram> = [];
  /** In-flight collect pass, if any — see expose(). */
  private collecting: Promise<unknown> | null = null;

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    const metric = new Counter(name, help, labelNames);
    this.register(metric);
    return metric;
  }

  gauge(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    collect?: (gauge: Gauge) => Promise<void>,
  ): Gauge {
    const metric = new Gauge(name, help, labelNames, collect);
    this.register(metric);
    return metric;
  }

  histogram(
    name: string,
    help: string,
    buckets: readonly number[],
    labelNames: readonly string[] = [],
  ): Histogram {
    const metric = new Histogram(name, help, buckets, labelNames);
    this.register(metric);
    return metric;
  }

  private register(metric: Counter | Gauge | Histogram): void {
    if (this.metrics.some((m) => m.name === metric.name)) {
      throw new Error(`metric ${metric.name} already registered`);
    }
    this.metrics.push(metric);
  }

  /**
   * Render the Prometheus text exposition. Gauge collect callbacks run
   * first, bounded together by one deadline; failures keep last values.
   * Collect passes are serialized: when a previous pass outlived its
   * deadline and is still running, this scrape waits on THAT pass instead
   * of launching a second — two concurrent passes could interleave so a
   * late write from the older one overwrites the newer one's values.
   */
  async expose(timeoutMs = COLLECT_TIMEOUT_MS): Promise<string> {
    const collectors = this.metrics.filter(
      (m): m is Gauge => m instanceof Gauge && m.collect !== undefined,
    );
    if (collectors.length > 0) {
      if (this.collecting === null) {
        const pass: Promise<unknown> = Promise.allSettled(
          collectors.map((g) => g.collect!(g)),
        ).finally(() => {
          if (this.collecting === pass) this.collecting = null;
        });
        this.collecting = pass;
      }
      await Promise.race([
        this.collecting,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    return `${this.metrics.map((m) => m.expose()).join("\n")}\n`;
  }
}
