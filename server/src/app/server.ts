// Fastify factory. Composition root only: zod compilers + type provider,
// OpenAPI registration, then the route modules. Entrypoints (src/api.ts) and
// tests (app.inject()) both build through here.

import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import {
  type FastifyZodOpenApiTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from "fastify-zod-openapi";
import { withApiRoutes } from "../routes";
import { withStripeWebhookRoutes } from "../routes/billing";
import { registerOpenApi } from "./openapi";

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const fastify = Fastify({ logger: opts.logger ?? true });

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);

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
  app.route({
    method: "GET",
    url: "/meta/health",
    handler: async () => ({ ok: true }),
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
