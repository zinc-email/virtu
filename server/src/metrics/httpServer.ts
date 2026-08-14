/**
 * maild's metrics + health listener: a bare Bun.serve on
 * METRICS_HOST:METRICS_PORT (loopback by default; the serve compose sets
 * 0.0.0.0 so Alloy can scrape maild:9100 over the compose network — the
 * port is never published to the host). The API needs none of this: its
 * metrics ride the existing Fastify server at /meta/metrics.
 */

import type { Registry } from "./registry.ts";

export interface HealthReport {
  ok: boolean;
  detail: Record<string, string | number | boolean>;
}

export interface MetricsServerOptions {
  host: string;
  port: number;
  registry: Registry;
  /** Liveness probe — maild reports listener + worker-heartbeat state. */
  health?: () => HealthReport;
}

export interface MetricsServer {
  port: number;
  stop(): void;
}

export function startMetricsServer(opts: MetricsServerOptions): MetricsServer {
  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/metrics") {
        return new Response(await opts.registry.expose(), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      }
      if (path === "/health") {
        const report = opts.health?.() ?? { ok: true, detail: {} };
        return Response.json(
          { ok: report.ok, ...report.detail },
          { status: report.ok ? 200 : 503 },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port ?? opts.port,
    stop() {
      void server.stop(true);
    },
  };
}
