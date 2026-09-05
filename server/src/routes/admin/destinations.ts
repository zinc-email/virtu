// Per-destination outbound throttle (queue/destinationThrottle.ts): the
// domains that have told us to back off, with the reply that did it, and
// the operator lever to lift a pause early. The time-series view of the
// same thing is Grafana (grafana/deliverability.json); this is the "what
// is paused right now and why" list. Registered inside the requireAdmin
// scope (routes/index.ts).

import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { db } from "../../db";
import { providerFor } from "../../metrics/provider";
import { clearThrottle, listThrottles } from "../../queue/destinationThrottle";
import { HttpError } from "../httpError";
import { ErrorResponse } from "../schema";
import { AdminDestinationClearedResponse, AdminDestinationListResponse } from "./schema";

export async function withAdminDestinationRoutes(admin: FastifyInstance) {
  const a = admin.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/destinations",
    schema: {
      description:
        "Recipient domains the outbound throttle has heard a deferral signal from " +
        "(421, or a 4.7.x policy deferral at a non-recipient step), paused ones " +
        "first, with the reply that caused the latest pause.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: AdminDestinationListResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async () => {
      const now = new Date();
      const rows = await listThrottles(db, now);
      const destinations = rows.map((r) => {
        const paused = r.pausedUntil !== null && r.pausedUntil > now;
        return {
          domain: r.domain,
          provider: providerFor(r.domain),
          paused_until: paused ? r.pausedUntil!.toISOString() : null,
          strikes: r.strikes,
          pauses: r.pauses,
          last_code: r.lastCode,
          last_enhanced: r.lastEnhanced,
          last_step: r.lastStep,
          last_reply: r.lastReply,
          last_deferred_at: r.lastDeferredAt?.toISOString() ?? null,
        };
      });
      return {
        paused: destinations.filter((d) => d.paused_until !== null).length,
        destinations,
      };
    },
  });

  a.route({
    method: "DELETE",
    url: "/destinations/:domain",
    schema: {
      description:
        "Lift a destination's pause now and reset its strikes (history stays). " +
        "404 when the domain has no throttle row.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      params: z.object({ domain: z.string().min(1).max(256) }),
      response: {
        200: AdminDestinationClearedResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        404: ErrorResponse,
      },
    },
    handler: async (req) => {
      const domain = req.params.domain.trim().toLowerCase();
      const cleared = await clearThrottle(db, domain);
      if (!cleared) throw new HttpError(404, "No throttle row for that domain");
      return { domain, cleared };
    },
  });
}
