/**
 * The process-wide metric set (PLAN decision #15). Every metric any
 * entrypoint emits is defined here, on one module-singleton registry —
 * api serves it at GET /meta/metrics, maild on the METRICS_PORT listener
 * (metrics/httpServer.ts). Metrics unused by a given process expose empty
 * (or zero) series, which is fine and keeps dashboards uniform.
 *
 * Label sets are deliberately bounded: enums, provider buckets
 * (provider.ts), route templates. Never label with free text.
 */

import { count, eq, min } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";
import { countPaused } from "../queue/destinationThrottle.ts";
import { providerFor } from "./provider.ts";
import { Registry } from "./registry.ts";

export { providerFor } from "./provider.ts";
export { Counter, Gauge, Histogram, Registry } from "./registry.ts";

export const registry = new Registry();

// ── Process ─────────────────────────────────────────────────────────────────

const processStartTimeSeconds = registry.gauge(
  "virtu_process_start_time_seconds",
  "Unix time the process started",
);
processStartTimeSeconds.set(Date.now() / 1000);

registry.gauge("virtu_process_rss_bytes", "Resident set size", [], async (gauge) => {
  gauge.set(process.memoryUsage().rss);
});

// ── mx (port 25 inbound) ────────────────────────────────────────────────────

export const smtpConnectionsTotal = registry.counter(
  "virtu_smtp_connections_total",
  "SMTP connections accepted, by listener",
  ["listener"], // mx | submission | submission_tls
);

export const mxRcptTotal = registry.counter(
  "virtu_mx_rcpt_total",
  "RCPT TO decisions at the MX",
  ["decision"], // deliver | mint | verp | trash | drop | reject
);

export const mxAuthVerdictsTotal = registry.counter(
  "virtu_mx_auth_verdicts_total",
  "SPF/DKIM/DMARC verdicts on inbound messages",
  ["verdict"], // pass | flag | reject
);

export const mxRateLimitedTotal = registry.counter(
  "virtu_mx_rate_limited_total",
  "RCPT TO tempfailed by the per-alias / per-mailbox inbound rate limit",
  ["scope"], // alias | mailbox
);

export const mxMessagesTotal = registry.counter(
  "virtu_mx_messages_total",
  "Inbound message outcomes at the MX",
  ["outcome"], // forwarded | trash | verp_bounce | verp_ignored | rejected | tempfailed | dropped | loop_dropped | error
);

// ── submission (587/465) ────────────────────────────────────────────────────

export const submissionAuthTotal = registry.counter(
  "virtu_submission_auth_total",
  "SMTP AUTH attempts on submission",
  ["result"], // ok | bad_credentials | throttled
);

export const submissionRcptRefusedTotal = registry.counter(
  "virtu_submission_rcpt_refused_total",
  "Refused RCPT TO on submission",
  ["reason"],
);

export const submissionEnqueuedTotal = registry.counter(
  "virtu_submission_enqueued_total",
  "Messages accepted from authenticated submission",
  ["mode"], // reply | send
);

export const submissionQuotaRefusedTotal = registry.counter(
  "virtu_submission_quota_refused_total",
  "Messages refused by the per-user daily send quota",
);

export const submissionQueueFullTotal = registry.counter(
  "virtu_submission_queue_full_total",
  "Messages refused because the user's pending queue is at its cap (queue/quota.ts)",
);

// Shared by mx and submission (pipeline/smtpRejection.ts).
export const smtpRejectionsTotal = registry.counter(
  "virtu_smtp_rejections_total",
  "SMTP-time refusals recorded to smtp_rejections",
  ["entrypoint", "phase"],
);

// Mailbox-level bounce suppression (pipeline/suppression.ts, ABUSE.md Tier 1).
export const mailboxSuppressedTotal = registry.counter(
  "virtu_mailbox_suppressed_total",
  "Mailboxes suppressed on a first-strike bounce code",
  ["code"], // 5.1.1 | 5.2.1
);

// ── delivery queue / deliverd ───────────────────────────────────────────────

export const queueClaimedTotal = registry.counter(
  "virtu_queue_claimed_total",
  "Rows claimed for delivery",
);

export const queueDeliveriesTotal = registry.counter(
  "virtu_queue_deliveries_total",
  "Delivery attempt outcomes",
  ["result"], // sent | transient | permanent
);

export const queueDeliveryDurationSeconds = registry.histogram(
  "virtu_queue_delivery_duration_seconds",
  "Wall time of one delivery attempt",
  [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  ["result"],
);

export const queueDestinationDeliveriesTotal = registry.counter(
  "virtu_queue_destination_deliveries_total",
  "Delivery attempt outcomes by destination provider bucket",
  ["provider", "result"],
);

export const queueDestinationRepliesTotal = registry.counter(
  "virtu_queue_destination_replies_total",
  "Failed delivery attempts by destination provider, SMTP step, reply code and enhanced class.subject",
  ["provider", "step", "code", "enhanced"],
);

// Per-destination backpressure (queue/destinationThrottle.ts).
export const destinationPausesTotal = registry.counter(
  "virtu_destination_pauses_total",
  "Domain pauses triggered by a deferral signal (421 / 4.7.x), by provider bucket",
  ["provider"],
);

export const queueDestinationDeferredTotal = registry.counter(
  "virtu_queue_destination_deferred_total",
  "Rows returned to pending without an attempt because their destination was paused",
  ["provider"],
);

export const queueReapedTotal = registry.counter(
  "virtu_queue_reaped_total",
  "Stuck 'sending' rows returned to pending by the reaper",
);

export const queueRetentionDeletedTotal = registry.counter(
  "virtu_queue_retention_deleted_total",
  "Rows deleted by the retention tick",
  ["status"], // sent | failed | smtp_rejections | provisional_users | sent_alerts
);

export const queueAdminTotal = registry.counter(
  "virtu_queue_admin_total",
  "Operator actions on the queue",
  ["op"], // drop | requeue | delete | bounce
);

export const dsnTotal = registry.counter(
  "virtu_dsn_total",
  "DSN generation outcomes for permanent failures",
  ["outcome"], // sent | suppressed | skipped
);

// ── transactional mail (pipeline/transactional.ts) ─────────────────────────

export const transactionalCeilingRefusedTotal = registry.counter(
  "virtu_transactional_ceiling_refused_total",
  "Login/sudo/mailbox-verification emails refused by the global hourly ceiling",
);

// ── api (Fastify) ───────────────────────────────────────────────────────────

export const httpRequestsTotal = registry.counter("virtu_http_requests_total", "API requests", [
  "method",
  "route",
  "status_class",
]);

export const httpRequestDurationSeconds = registry.histogram(
  "virtu_http_request_duration_seconds",
  "API request duration",
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  ["route"],
);

// ── On-scrape queue gauges (need a db handle, so registered explicitly) ─────

const OUTBOUND_STATUSES = ["pending", "sending", "sent", "failed"] as const;

let queueCollectorsRegistered = false;

/**
 * Register the scrape-time queue gauges. Called once per process that owns
 * a queue view (maild, standalone deliverd); guarded so double wiring is a
 * no-op rather than a duplicate-metric throw.
 */
export function registerQueueCollectors(db: Db): void {
  if (queueCollectorsRegistered) return;
  queueCollectorsRegistered = true;

  registry.gauge(
    "virtu_queue_depth",
    "outbound_messages rows by status",
    ["status"],
    async (gauge) => {
      const rows = await db
        .select({ status: outboundMessages.status, n: count() })
        .from(outboundMessages)
        .groupBy(outboundMessages.status);
      for (const status of OUTBOUND_STATUSES) {
        gauge.set({ status }, rows.find((r) => r.status === status)?.n ?? 0);
      }
    },
  );

  registry.gauge(
    "virtu_queue_oldest_pending_age_seconds",
    "Age of the most overdue pending row (0 when none is due)",
    [],
    async (gauge) => {
      const rows = await db
        .select({ oldest: min(outboundMessages.nextAttemptAt) })
        .from(outboundMessages)
        .where(eq(outboundMessages.status, "pending"));
      const oldest = rows[0]?.oldest ?? null;
      const age = oldest === null ? 0 : (Date.now() - oldest.getTime()) / 1000;
      gauge.set(Math.max(0, age));
    },
  );

  // Destinations currently paused by the throttle, by provider bucket —
  // the "is Gmail refusing us right now" panel.
  const PROVIDER_BUCKETS = ["gmail", "microsoft", "yahoo", "icloud", "proton", "other"];
  registry.gauge(
    "virtu_destination_paused",
    "Recipient domains currently paused by the per-destination throttle",
    ["provider"],
    async (gauge) => {
      const domains = await countPaused(db);
      const counts = new Map<string, number>();
      for (const d of domains) counts.set(providerFor(d), (counts.get(providerFor(d)) ?? 0) + 1);
      for (const provider of PROVIDER_BUCKETS) gauge.set({ provider }, counts.get(provider) ?? 0);
    },
  );
}
