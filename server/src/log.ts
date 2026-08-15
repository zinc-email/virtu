/**
 * Structured logging for the mail daemons (PLAN decision #15). One JSON
 * object per line on stdout — `{ts, level, component, event, ...fields}` —
 * or a human-readable line under LOG_FORMAT=pretty (the test network sets
 * that; see docker-compose.test.yml). First-party on purpose: the need is
 * ~100 lines of formatting, and pino's pretty transport rides worker
 * threads (thread-stream), a Bun surface this repo has already been burned
 * by twice (see the don't-break list). The API keeps Fastify's built-in
 * pino, which is already structured.
 *
 * Grafana Cloud side: Alloy tails container stdout; JSON lines parse at
 * query time in Loki (`| json`) — no ingest pipeline, no shipper coupling.
 */

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const PRETTY_TAG: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger with `bound` merged under every entry (e.g. queueId). */
  child(bound: LogFields): Logger;
}

export interface LoggerOptions {
  /** "json" (default; the deploy form) or "pretty" (humans, dev/test logs). */
  format?: "json" | "pretty";
  /** Minimum level emitted; below it entries are dropped. Default "info". */
  level?: LogLevel;
  /** Line sink, injectable for tests. Default: console.log. */
  write?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/** Pretty-mode value: bare when shell-safe, JSON-quoted otherwise. */
function prettyValue(value: string | number | boolean | null): string {
  if (typeof value !== "string") return String(value);
  return /^[\w@.:/#+-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * The four keys every line leads with. A field of the same name would
 * silently overwrite the header slot (`log.info("x", { level: "critical" })`
 * rewriting the real level), so they are reserved: a colliding field is
 * dropped rather than allowed to falsify the record.
 */
const RESERVED_FIELDS = new Set(["ts", "level", "component", "event"]);

function formatLine(
  format: "json" | "pretty",
  now: Date,
  level: LogLevel,
  component: string,
  event: string,
  fields: LogFields,
): string {
  if (format === "json") {
    // Spread order fixes key order: ts/level/component/event lead every line.
    const entry: Record<string, unknown> = {
      ts: now.toISOString(),
      level,
      component,
      event,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && !RESERVED_FIELDS.has(key)) entry[key] = value;
    }
    return JSON.stringify(entry);
  }
  const time = now.toISOString().slice(11, 19);
  const parts = [time, PRETTY_TAG[level], component, event];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && !RESERVED_FIELDS.has(key)) {
      parts.push(`${key}=${prettyValue(value)}`);
    }
  }
  return parts.join(" ");
}

/**
 * Create a logger for one daemon/component ("mx", "submission", "queue",
 * "deliverd", "transactional"). Options default from LOG_FORMAT/LOG_LEVEL
 * via config, read lazily so tests can construct pure instances.
 */
export function createLogger(component: string, opts: LoggerOptions = {}): Logger {
  const format = opts.format ?? defaultFormat();
  const minRank = LEVEL_RANK[opts.level ?? defaultLevel()];
  const write = opts.write ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => new Date());

  const make = (bound: LogFields): Logger => {
    const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
      if (LEVEL_RANK[level] < minRank) return;
      write(formatLine(format, now(), level, component, event, { ...bound, ...fields }));
    };
    return {
      debug: (event, fields) => emit("debug", event, fields),
      info: (event, fields) => emit("info", event, fields),
      warn: (event, fields) => emit("warn", event, fields),
      error: (event, fields) => emit("error", event, fields),
      child: (extra) => make({ ...bound, ...extra }),
    };
  };
  return make({});
}

// Read env directly (not via config.ts) to keep this module import-cycle-free
// and constructible in pure unit tests; validation is a fallback-to-default,
// not a parse error — a typo'd LOG_LEVEL must never take the mail path down.
function defaultFormat(): "json" | "pretty" {
  return process.env.LOG_FORMAT === "pretty" ? "pretty" : "json";
}

function defaultLevel(): LogLevel {
  const level = process.env.LOG_LEVEL;
  return level === "debug" || level === "info" || level === "warn" || level === "error"
    ? level
    : "info";
}
