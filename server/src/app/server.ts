// Fastify factory. Composition root only: zod compilers + type provider,
// OpenAPI registration, then the route modules. Entrypoints (src/api.ts) and
// tests (app.inject()) both build through here.

import fastifyCookie from "@fastify/cookie";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import {
  type FastifyZodOpenApiTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from "fastify-zod-openapi";
import { config } from "../config";
import { db } from "../db";
import { httpRequestDurationSeconds, httpRequestsTotal, registry } from "../metrics";
import { withApiRoutes } from "../routes";
import { withStripeWebhookRoutes } from "../routes/billing";
import { registerOpenApi } from "./openapi";

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * Pino, reshaped to the daemons' record shape (src/log.ts):
 * `{ts, level, component, event, ...}`. Alloy ships API and maild stdout
 * into ONE Loki stream, so a query like `| json | level="error"` — or any
 * dashboard panel keyed on `component` — has to mean the same thing for
 * both. Stock pino would emit `{"level":30,"time":<epoch ms>,"msg":…}`,
 * a second incompatible schema in the same stream.
 *
 * This is a formatter config, not a logger swap: the API still keeps
 * Fastify's built-in pino (PLAN decision #15).
 */
const PINO_OPTIONS = {
  level: config.logLevel,
  // ISO-8601 under the same key the daemons use, not pino's epoch `time`.
  timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  // "info", not 30. `component` on every line, as the daemons stamp it.
  formatters: {
    level: (label: string) => ({ level: label }),
    bindings: () => ({ component: "api" }),
  },
  // Daemon lines name the thing that happened in `event`; pino's `msg`
  // becomes that field so one Loki query covers both.
  messageKey: "event",
};

export async function buildApp(opts: BuildAppOptions = {}) {
  // trustProxy: in every topology a Caddy reverse proxy fronts the API (see
  // CLAUDE.md) and is the only client that can reach api:3000, so honor its
  // X-Forwarded-For — otherwise req.ip is the proxy's address for every
  // request and the per-IP rate limits (auth login/verify) collapse into one
  // global bucket, a trivial pre-auth availability foot-gun.
  const fastify = Fastify({
    logger: opts.logger ?? PINO_OPTIONS,
    trustProxy: true,
  });

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

  // Request metrics (PLAN decision #15). Labels stay bounded: the ROUTE
  // TEMPLATE (/api/aliases/:alias_id), never the raw URL, and the status
  // class, never the exact code.
  fastify.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_class: `${Math.floor(reply.statusCode / 100)}xx`,
    });
    httpRequestDurationSeconds.observe({ route }, reply.elapsedTime / 1000);
  });

  const app = fastify.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  // Cookie parsing — unused by the three MVP routes but part of the surface
  // SimpleLogin clients expect later (cookie_token exchange).
  await app.register(fastifyCookie);

  // Before the route modules, so every route is captured by the swagger
  // onRoute hooks.
  await registerOpenApi(app);

  await withApiRoutes(app);

  // Stripe webhook — outside /api (Stripe posts here directly, no auth
  // header; authenticity is the signature). Its raw-body content-type parser
  // is encapsulated inside the module's own plugin scope, so no other
  // route's JSON parsing changes. Hidden from the spec like all non-/api
  // routes (see openapi.ts).
  await withStripeWebhookRoutes(app);

  // Public probes — outside /api and hidden from the spec (see openapi.ts).
  // Health probes the DB (bounded): the compose healthcheck and any LB need
  // "can this process serve requests", not "is the process alive".
  app.route({
    method: "GET",
    url: "/meta/health",
    handler: async (_req, reply) => {
      try {
        await Promise.race([
          db.execute(sql`select 1`),
          new Promise((_resolve, rejectFn) =>
            setTimeout(() => rejectFn(new Error("db probe timeout")), 2000),
          ),
        ]);
        return { ok: true, db: "ok" };
      } catch {
        return reply.code(503).send({ ok: false, db: "error" });
      }
    },
  });

  // Prometheus exposition for the API process — same /meta pattern (outside
  // /api, hidden from the spec); maild serves its own on METRICS_PORT.
  app.route({
    method: "GET",
    url: "/meta/metrics",
    handler: async (_req, reply) => {
      reply.header("content-type", "text/plain; version=0.0.4; charset=utf-8");
      return registry.expose();
    },
  });

  // The served spec matches the committed server/spec/openapi.json (both are
  // app.swagger()). No response schema on purpose: the spec must pass through
  // serialization untouched.
  app.route({
    method: "GET",
    url: "/meta/openapi.json",
    handler: async () => app.swagger(),
  });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
