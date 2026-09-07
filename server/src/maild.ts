/**
 * maild — single-process mail daemon for the MVP: starts mx (25),
 * submission (587 + 465) and deliverd in one Bun process.
 *
 * PLAN lists three separate entrypoints (mx / submission / deliverd) and
 * each still runs standalone (`bun src/mx.ts` etc.); this composite exists
 * because the test network runs everything on one container/IP
 * (mail.virtu.email = 192.168.34.101) and one process is the simplest
 * durable form for that. Scaling out later = running the individual
 * entrypoints on separate boxes; nothing here prevents it.
 *
 * maild also owns the metrics/health listener (PLAN decision #15): the
 * three daemons expose no HTTP of their own, so this composite serves
 * GET /metrics + GET /health on METRICS_HOST:METRICS_PORT
 * (metrics/httpServer.ts). Liveness = every listener still bound + the
 * queue worker's heartbeat fresh. The worker stamps that heartbeat per
 * ROW, not per batch (queue/worker.ts `onRowStart`), so the window below
 * bounds "no delivery has even STARTED in this long" — a whole batch of
 * tarpitting destinations is legitimate progress and stays healthy, while
 * a wedged loop still trips.
 */

import { assertProductionSmtpTls, config } from "./config.ts";
import { startDeliverd } from "./deliverd.ts";
import { createLogger } from "./log.ts";
import { registry } from "./metrics/index.ts";
import { startMetricsServer } from "./metrics/httpServer.ts";
import { startMx } from "./mx.ts";
import { startSubmission } from "./submission.ts";

const WORKER_HEARTBEAT_MAX_MS = Math.max(5 * config.queuePollMs, 10 * 60_000);

async function main(): Promise<void> {
  const logger = createLogger("maild");
  // Fail closed BEFORE anything binds: a production box without mail certs
  // must not come up as an MX that accepts connections and then dies when
  // submission refuses — with nothing bound, senders queue and retry.
  assertProductionSmtpTls(config);
  const mx = await startMx();
  const submission = await startSubmission();
  const worker = startDeliverd();

  // Liveness, as documented above: LISTENERS UP *and* a fresh worker
  // heartbeat. address() is null before listen() and after close(), so a
  // listener that died under a running process is visible here — checking
  // only the heartbeat would report a maild with no mx as healthy.
  const listenersUp = (): boolean =>
    mx.address() !== null &&
    submission.starttls.address() !== null &&
    (submission.implicitTls === null || submission.implicitTls.address() !== null);

  // The metrics/health listener is OBSERVABILITY: it must never be able to
  // take down the thing it observes. Bun.serve throws on a bound port, and
  // an unhandled rejection here would kill a process already running mx,
  // submission and deliverd — mail down because a scrape endpoint could not
  // start. Log it and keep delivering instead.
  try {
    startMetricsServer({
      host: config.metricsHost,
      port: config.metricsPort,
      registry,
      health: () => {
        const heartbeatAgeMs = Date.now() - worker.heartbeatAt().getTime();
        const listeners = listenersUp();
        return {
          ok: listeners && heartbeatAgeMs < WORKER_HEARTBEAT_MAX_MS,
          detail: { listenersUp: listeners, workerHeartbeatAgeMs: heartbeatAgeMs },
        };
      },
    });
    logger.info("started", {
      metricsHost: config.metricsHost,
      metricsPort: config.metricsPort,
    });
  } catch (err) {
    logger.error("metrics_server_failed", {
      metricsHost: config.metricsHost,
      metricsPort: config.metricsPort,
      error: err instanceof Error ? err.message : String(err),
    });
    logger.info("started", { metricsHost: config.metricsHost, metricsPort: null });
  }
}

if (import.meta.main) {
  void main();
}
