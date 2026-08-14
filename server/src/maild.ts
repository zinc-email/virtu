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
 * (metrics/httpServer.ts). Liveness = listeners started + the queue
 * worker's heartbeat fresher than a generous multiple of the poll
 * interval (a full batch of slow deliveries can legitimately take
 * minutes; a wedged loop cannot).
 */

import { config } from "./config.ts";
import { startDeliverd } from "./deliverd.ts";
import { createLogger } from "./log.ts";
import { registry } from "./metrics/index.ts";
import { startMetricsServer } from "./metrics/httpServer.ts";
import { startMx } from "./mx.ts";
import { startSubmission } from "./submission.ts";

const WORKER_HEARTBEAT_MAX_MS = Math.max(5 * config.queuePollMs, 10 * 60_000);

async function main(): Promise<void> {
  const logger = createLogger("maild");
  await startMx();
  await startSubmission();
  const worker = startDeliverd();

  startMetricsServer({
    host: config.metricsHost,
    port: config.metricsPort,
    registry,
    health: () => {
      const heartbeatAgeMs = Date.now() - worker.heartbeatAt().getTime();
      return {
        ok: heartbeatAgeMs < WORKER_HEARTBEAT_MAX_MS,
        detail: { workerHeartbeatAgeMs: heartbeatAgeMs },
      };
    },
  });

  logger.info("started", {
    metricsHost: config.metricsHost,
    metricsPort: config.metricsPort,
  });
}

if (import.meta.main) {
  void main();
}
