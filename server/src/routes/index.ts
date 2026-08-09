// The SimpleLogin-compatible API surface, mounted under /api (the prefix is
// part of the public URL, exactly like app.simplelogin.io/api/...). The
// OpenAPI transform strips /api from spec paths and carries it in `servers`,
// so the generated SDK's baseURL ("/api") reassembles the same URLs.

import type { FastifyInstance } from "fastify";
import { withAuthRoutes } from "./auth";
import { errorEnvelopeHandler } from "./httpError";
import { withUserInfoRoutes } from "./userInfo";

export async function withApiRoutes(app: FastifyInstance) {
  await app.register(
    async (api) => {
      api.setErrorHandler(errorEnvelopeHandler);
      await withAuthRoutes(api);
      await withUserInfoRoutes(api);
    },
    { prefix: "/api" },
  );
}
