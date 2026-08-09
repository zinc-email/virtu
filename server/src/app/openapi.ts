// OpenAPI spec emission, adapted from madi's app/openapi.ts (single public
// spec — no internal-spec half). One @fastify/swagger registration; the
// transform hides everything outside /api and strips the /api prefix from
// paths, carrying it in `servers` instead — so Kubb's baseURL ("/api")
// reassembles the real URLs. Kept out of app/server.ts so buildApp stays a
// readable composition root.

import type { FastifyInstance } from "fastify";
import {
  fastifyZodOpenApiPlugin,
  fastifyZodOpenApiTransform,
  fastifyZodOpenApiTransformObject,
} from "fastify-zod-openapi";

const isApiRoute = (url: string) => url === "/api" || url.startsWith("/api/");

// Hide non-/api routes (health probe, served spec) from the spec, and strip
// the /api prefix from the surviving paths.
type ZodTransform = typeof fastifyZodOpenApiTransform;
const transform: ZodTransform = (data) => {
  const result = fastifyZodOpenApiTransform(data);
  if (!isApiRoute(data.url)) {
    result.schema = { ...result.schema, hide: true };
  }
  return { ...result, url: result.url.replace(/^\/api/, "") };
};

// Hiding a route drops its path but NOT the component schemas it referenced —
// those are registered globally by zod-openapi, so the spec would carry every
// schema. Prune components.schemas down to those transitively referenced by
// the surviving (non-hidden) paths. transformObject runs after hidden paths
// are already excluded, so this is reference-driven, not name-based.
type OpenApiDoc = ReturnType<typeof fastifyZodOpenApiTransformObject>;

function pruneUnreferencedSchemas(doc: OpenApiDoc): OpenApiDoc {
  if (!("components" in doc) || !doc.components) return doc;
  const schemas = doc.components.schemas;
  if (!schemas) return doc;

  const referenced = new Set<string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        const name = value.replace(/^#\/components\/schemas\//, "");
        if (name !== value && !referenced.has(name)) {
          referenced.add(name);
          visit(schemas[name]); // follow transitive refs
        }
      } else {
        visit(value);
      }
    }
  };
  visit(doc.paths);

  const pruned: typeof schemas = {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (referenced.has(name)) pruned[name] = schema;
  }
  // Mutate in place: doc is the fresh object fastifyZodOpenApiTransformObject
  // just returned, and reassigning the same schemas type sidesteps the
  // union-reconstruction that a {...doc} spread would trip over.
  doc.components.schemas = pruned;
  return doc;
}

const transformObject: typeof fastifyZodOpenApiTransformObject = (data) =>
  pruneUnreferencedSchemas(fastifyZodOpenApiTransformObject(data));

// Must run after the zod compilers are set (buildApp does that) and before
// the route modules register, so every route is captured by the swagger
// onRoute hooks.
export async function registerOpenApi(app: FastifyInstance) {
  await app.register(fastifyZodOpenApiPlugin);

  await app.register(import("@fastify/swagger"), {
    transform,
    transformObject,

    openapi: {
      openapi: "3.1.0",
      info: {
        title: "virtu API",
        description:
          "SimpleLogin-compatible email alias API. Authenticate with the " +
          "`Authentication: <api_key>` header (SimpleLogin's exact header name — " +
          'not Authorization). Errors use the {"error": "..."} envelope.',
        version: "0.1.0",
      },
      servers: [{ url: "/api", description: "API root" }],
      tags: [{ name: "Account", description: "Registration, login, and account info" }],
      components: {
        securitySchemes: {
          apiKeyAuth: {
            type: "apiKey",
            in: "header",
            name: "Authentication",
            description: "API key obtained from POST /auth/login",
          },
        },
      },
    },
  });
}
