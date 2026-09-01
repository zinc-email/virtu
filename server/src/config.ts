// Shared config for every entrypoint (api, mx, submission, deliverd — see
// PLAN.md). Parsed once from env at import; keys map camelCase -> SCREAMING
// snake env names via app/env.ts (databaseUrl -> DATABASE_URL, ...).

import { z } from "zod";
import { booleanString, loadConfigFromEnv } from "./app/env";

const ConfigSchema = z.object({
  databaseUrl: z.string().default("postgres://virtu:virtu@localhost:5432/virtu"),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().default(3000),

  // ── Observability (PLAN decision #15) ────────────────────────────────────
  // Daemon log lines: "json" for the deploy form, "pretty" for humans.
  // (src/log.ts also reads these from env directly to stay cycle-free; these
  // entries carry the same defaults and the .env.example documentation.)
  //
  // `.catch()`, not a hard parse error, on purpose: this schema is parsed at
  // import by EVERY entrypoint, so a strict enum would turn a typo'd
  // LOG_LEVEL into a boot crash for mx/submission/deliverd — exactly the
  // failure src/log.ts goes out of its way to avoid ("a typo'd LOG_LEVEL must
  // never take the mail path down"). A misconfigured logger degrades to the
  // default; it never takes mail down.
  logFormat: z.enum(["json", "pretty"]).default("json").catch("json"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info").catch("info"),
  // maild's metrics/health listener (Prometheus text format). Loopback by
  // default; the serve compose sets METRICS_HOST=0.0.0.0 so Alloy can scrape
  // maild:9100 on the compose network (the port is never published).
  metricsHost: z.string().default("127.0.0.1"),
  metricsPort: z.coerce.number().int().default(9100),
  // Requests/minute per IP across the auth routes (register/activate/login).
  // The dev compose raises it: the DOM test tier registers users freely.
  authRateLimitMax: z.coerce.number().int().default(10),

  // ── Mail path (mx / submission / deliverd — PLAN Milestones 1-3) ─────────
  // The domain aliases + reverse aliases + VERP addresses live on.
  mailDomain: z.string().default("virtu.email"),
  // Our MX hostname: SMTP banner, EHLO, Authentication-Results stamps.
  mailHostname: z.string().default("mail.virtu.email"),
  // DKIM selector for our signing key in dkim_keys ({selector}._domainkey.{domain}).
  dkimSelector: z.string().default("mail"),
  // HMAC secret for VERP bounce addresses (>= 32 chars, SimpleLogin invariant).
  // The default is a dev-only value; production must override.
  verpSecret: z.string().min(32).default("insecure-dev-verp-secret-change-me-00"),
  // PEM cert/key for STARTTLS (25/587) and implicit TLS (465). Both unset =>
  // plaintext-only listeners (local dev); requireAuthTls then defaults off.
  smtpTlsCertFile: z.string().optional(),
  smtpTlsKeyFile: z.string().optional(),
  smtpHost: z.string().default("0.0.0.0"),
  mxPort: z.coerce.number().int().default(25),
  submissionPort: z.coerce.number().int().default(587),
  submissionTlsPort: z.coerce.number().int().default(465),
  smtpMaxMessageSize: z.coerce
    .number()
    .int()
    .default(25 * 1024 * 1024),
  // Per-user outbound send quota (submission pre-enqueue, Lane K P2):
  // recipients per rolling 24h, by plan. 0 = unlimited. Overridable per user
  // via users.max_daily_sends. Caps what a leaked device credential can
  // blast through our IP; forwards never count.
  sendQuotaFreePerDay: z.coerce.number().int().default(50),
  sendQuotaPremiumPerDay: z.coerce.number().int().default(500),
  // deliverd egress guard: when false (the default), deliverd refuses to open
  // an SMTP connection to a recipient domain whose MX (or implicit-MX A record)
  // resolves to a private/loopback/link-local address — the SSRF where an
  // attacker points a domain's MX at the internal network. The simulated
  // internet legitimately uses 192.168.x peers, so its compose sets this true.
  smtpAllowPrivateTargets: booleanString(false),

  // ── Delivery queue (deliverd) ────────────────────────────────────────────
  queuePollMs: z.coerce.number().int().default(1000),
  queueBatchSize: z.coerce.number().int().default(10),
  // Max delivery attempts before a transient failure becomes permanent. With
  // the 6h backoff cap below, 25 tries ≈ 4 days of retrying — RFC 5321's
  // customary "4-5 days" horizon. (The test network pins the old fast values.)
  queueMaxTries: z.coerce.number().int().default(25),
  // Upper bound on any single retry delay (backoff.ts caps here).
  queueBackoffMaxMs: z.coerce
    .number()
    .int()
    .default(6 * 60 * 60_000),
  // ── Queue hygiene (reaper + retention, run inside the worker loop) ───────
  // A `sending` row whose claim is older than this is presumed orphaned by a
  // crashed worker and returned to `pending` (at-least-once delivery).
  queueStuckSendingMinutes: z.coerce.number().int().default(15),
  queueReapIntervalMs: z.coerce.number().int().default(60_000),
  // Terminal rows are eventually deleted: sent rows keep no raw (cleared on
  // the terminal write) and age out fast; failed rows keep raw for requeue
  // and stick around longer for forensics.
  queueRetentionIntervalMs: z.coerce
    .number()
    .int()
    .default(60 * 60_000),
  queueRetainSentDays: z.coerce.number().int().default(7),
  queueRetainFailedDays: z.coerce.number().int().default(30),
  // smtp_rejections rows (Lane K P2 forensics) age out on the same retention
  // tick; 0 keeps them forever.
  smtpRejectionsRetainDays: z.coerce.number().int().default(30),
});

export const config = loadConfigFromEnv(ConfigSchema);
export type Config = typeof config;

// Values every reader of this open-source repo knows. They exist as dev
// defaults so an empty .env runs locally; production must never run on them
// (a known VERP_SECRET lets anyone forge bounce/reply routing tokens).
const KNOWN_INSECURE_DEFAULTS = new Set<string>([
  "insecure-dev-verp-secret-change-me-00",
  "postgres://virtu:virtu@localhost:5432/virtu",
]);

/**
 * Fail closed in production: when VIRTU_ENV (or NODE_ENV) is "production",
 * refuse to boot on a known-insecure secret rather than start silently
 * compromised. A real deploy sets VIRTU_ENV=production alongside real secrets
 * (see server/.env.example). Exported for unit testing; called at import.
 */
export function assertProductionSecrets(
  cfg: Pick<Config, "verpSecret" | "databaseUrl">,
  env: Record<string, string | undefined> = process.env,
): void {
  if ((env.VIRTU_ENV ?? env.NODE_ENV) !== "production") return;
  const problems: string[] = [];
  if (KNOWN_INSECURE_DEFAULTS.has(cfg.verpSecret)) {
    problems.push("VERP_SECRET is unset or the known dev default");
  }
  if (KNOWN_INSECURE_DEFAULTS.has(cfg.databaseUrl)) {
    problems.push("DATABASE_URL is unset or the known dev default");
  }
  if (problems.length > 0) {
    throw new Error(
      `refusing to start with VIRTU_ENV=production and insecure config: ${problems.join("; ")}. ` +
        "Set real values — see server/.env.example.",
    );
  }
}

assertProductionSecrets(config);

// SimpleLogin's MAX_NB_EMAIL_FREE_PLAN default.
export const MAX_ALIAS_FREE_PLAN = 5;
