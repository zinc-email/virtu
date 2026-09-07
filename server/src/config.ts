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
  // Invite-only signup (ABUSE.md Tier 0): when true, /auth/verify refuses to
  // graduate a provisional user without a valid invite code. Existing
  // (activated) users log in unaffected. Off by default so dev/lmnop stay
  // open; zinc sets it until the Tier 2 detector is proven.
  signupInviteOnly: booleanString(false),
  // GLOBAL hourly ceiling on login/sudo/mailbox-verification mail, across
  // every address (pipeline/transactional.ts). /auth/login lets anyone make
  // us mail any address they name; the per-address (3/h) and per-IP budgets
  // bound one target and one source, this bounds the TOTAL a distributed
  // flood can push through our IP at spam traps before it becomes a
  // reputation event. Tripped = 429 for everyone + an operator notification.
  // 0 = unlimited (dev compose and the int tier, which mint codes freely).
  transactionalMailHourlyMax: z.coerce.number().int().default(500),
  // Provisional users (activated = false: a /auth/login for an address that
  // never verified) are pruned on the retention tick once older than this;
  // 0 keeps them forever. A login code lives 15 minutes, so a day-old
  // provisional row is an abandoned signup or someone else's probe.
  provisionalUserRetainHours: z.coerce.number().int().default(24),

  // ── Mail path (mx / submission / deliverd — PLAN Milestones 1-3) ─────────
  // The domain aliases + reverse aliases + VERP addresses live on.
  mailDomain: z.string().default("virtu.email"),
  // Our MX hostname: SMTP banner, EHLO, Authentication-Results stamps.
  mailHostname: z.string().default("mail.virtu.email"),
  // DKIM selector for our signing key in dkim_keys ({selector}._domainkey.{domain}).
  dkimSelector: z.string().default("mail"),
  // Role addresses on the service domain (RFC 2142) routed to the operators
  // (pipeline/operatorMail.ts) — comma-separated localparts. `dmarc` is the
  // rua= target the telemetry runbook points receivers at.
  operatorLocalparts: z
    .string()
    .default("postmaster,abuse,hostmaster,security,dmarc")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s !== ""),
    ),
  // HMAC secret for VERP bounce addresses (>= 32 chars, SimpleLogin invariant).
  // The default is a dev-only value; production must override.
  verpSecret: z.string().min(32).default("insecure-dev-verp-secret-change-me-00"),
  // PEM cert/key for STARTTLS (25/587) and implicit TLS (465). Both unset =>
  // plaintext-only listeners (local dev) — and no AUTH on submission unless
  // the dev flag below says so. Required in production (assertProductionSmtpTls).
  smtpTlsCertFile: z.string().optional(),
  smtpTlsKeyFile: z.string().optional(),
  // Submission only: offer AUTH on the plaintext 587 listener when no TLS is
  // configured. Without it a TLS-less submission listener has no AUTH at
  // all (nothing works, nothing leaks). Dev-only — refused in production
  // (assertProductionSmtpTls).
  submissionAllowPlaintextAuth: booleanString(false),
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
  // Inbound rate limit at the MX (pipeline/inboundRateLimit.ts): trailing
  // 60s budgets, tempfailed 450 4.7.1 at RCPT so the sender retries. Per
  // alias = distinct messages; per mailbox = forward copies (the rate the
  // mailbox provider sees from our IP). 0 = unlimited. SimpleLogin's
  // defaults (10 / 15).
  inboundRateLimitPerAliasPerMinute: z.coerce.number().int().default(10),
  inboundRateLimitPerMailboxPerMinute: z.coerce.number().int().default(15),
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
  // Per-user cap on what sits in the queue (queue/quota.ts): pending +
  // sending rows and their raw bytes. Checked at the mx RCPT and at
  // submission before enqueue; over it = 452 4.3.1, so the sender retries
  // later. Bounds what one tempfailing mailbox (four days of retries at up
  // to SMTP_MAX_MESSAGE_SIZE a row) or one user's flood can hold in
  // Postgres. 0 = unlimited.
  queueMaxPendingRowsPerUser: z.coerce.number().int().default(500),
  queueMaxPendingBytesPerUser: z.coerce
    .number()
    .int()
    .default(256 * 1024 * 1024),
  // Per-destination backpressure (queue/destinationThrottle.ts): a 421 or a
  // 4.7.x policy deferral at a non-recipient step pauses the whole recipient
  // DOMAIN for base·2^strikes (capped), rows for it wait without attempts.
  // Base 0 disables. The test network disables it (shared peer domains).
  destinationPauseBaseMs: z.coerce
    .number()
    .int()
    .default(5 * 60_000),
  destinationPauseMaxMs: z.coerce
    .number()
    .int()
    .default(60 * 60_000),
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
  // sent_alerts (the send-budget / alert-dedupe / attempt ledger) ages out on
  // the same tick; every window read from it is <= a day. 0 keeps forever.
  sentAlertsRetainDays: z.coerce.number().int().default(30),
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

/**
 * Fail closed on the submission listeners: in production SMTP AUTH must
 * never be reachable in the clear. Without TLS material the 587 listener
 * would otherwise run without STARTTLS (and 465 never starts) — the deploy
 * where the mail-certs sync has not happened yet. Called from
 * startSubmission, not at import: the api has no SMTP listeners and must
 * boot without mail certs. Exported for unit testing.
 */
export function assertProductionSmtpTls(
  cfg: Pick<Config, "smtpTlsCertFile" | "smtpTlsKeyFile" | "submissionAllowPlaintextAuth">,
  env: Record<string, string | undefined> = process.env,
): void {
  if ((env.VIRTU_ENV ?? env.NODE_ENV) !== "production") return;
  const problems: string[] = [];
  if (cfg.smtpTlsCertFile === undefined || cfg.smtpTlsKeyFile === undefined) {
    problems.push("SMTP_TLS_CERT_FILE / SMTP_TLS_KEY_FILE are unset (AUTH would have no TLS)");
  }
  if (cfg.submissionAllowPlaintextAuth) {
    problems.push("SUBMISSION_ALLOW_PLAINTEXT_AUTH is set (dev-only)");
  }
  if (problems.length > 0) {
    throw new Error(
      `refusing to start submission with VIRTU_ENV=production and insecure config: ${problems.join("; ")}. ` +
        'Point the listeners at a real cert — see server/.env.example and README "Mail TLS".',
    );
  }
}

// SimpleLogin's MAX_NB_EMAIL_FREE_PLAN default.
export const MAX_ALIAS_FREE_PLAN = 5;
