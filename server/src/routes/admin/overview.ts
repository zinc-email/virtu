// The admin landing numbers (PLAN Lane K P1): queue state now, 24h mail
// activity off email_logs, account totals. Plain aggregate queries over
// existing indexes — Postgres is the metrics store for the in-app admin
// surface (Grafana Cloud handles time series; decision #15).

import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { and, count, eq, gt, isNotNull, min } from "drizzle-orm";
import { db } from "../../db";
import { emailLogs, outboundMessages, users } from "../../db/schema";
import { ErrorResponse } from "../schema";
import { AdminOverviewResponse } from "./schema";

export async function withAdminOverviewRoutes(admin: FastifyInstance) {
  const a = admin.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/overview",
    schema: {
      description:
        "Operator landing numbers: queue depth by status, oldest due pending " +
        "row, 24h activity (forwards/replies/bounces/blocked), user counts.",
      tags: ["Admin"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: AdminOverviewResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async () => {
      const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);

      const byStatus = await db
        .select({ status: outboundMessages.status, n: count() })
        .from(outboundMessages)
        .groupBy(outboundMessages.status);
      const statusCount = (status: string) => byStatus.find((r) => r.status === status)?.n ?? 0;

      const [sent24h] = await db
        .select({ n: count() })
        .from(outboundMessages)
        .where(and(eq(outboundMessages.status, "sent"), gt(outboundMessages.updatedAt, dayAgo)));

      const [oldestPending] = await db
        .select({ oldest: min(outboundMessages.nextAttemptAt) })
        .from(outboundMessages)
        .where(eq(outboundMessages.status, "pending"));
      const oldest = oldestPending?.oldest ?? null;

      const activityCount = (isReply: boolean) =>
        db
          .select({ n: count() })
          .from(emailLogs)
          .where(
            and(
              gt(emailLogs.createdAt, dayAgo),
              eq(emailLogs.isReply, isReply),
              eq(emailLogs.blocked, false),
            ),
          );
      const [forwards] = await activityCount(false);
      const [replies] = await activityCount(true);
      // All blocked copies, whichever phase — forwards/replies exclude them.
      const [blocked] = await db
        .select({ n: count() })
        .from(emailLogs)
        .where(and(gt(emailLogs.createdAt, dayAgo), eq(emailLogs.blocked, true)));
      const [bounces] = await db
        .select({ n: count() })
        .from(emailLogs)
        .where(and(isNotNull(emailLogs.bouncedAt), gt(emailLogs.bouncedAt, dayAgo)));

      const [userTotal] = await db.select({ n: count() }).from(users);
      const [userDisabled] = await db
        .select({ n: count() })
        .from(users)
        .where(eq(users.disabled, true));

      return {
        queue: {
          pending: statusCount("pending"),
          sending: statusCount("sending"),
          failed: statusCount("failed"),
          sent_24h: sent24h?.n ?? 0,
          oldest_pending_age_seconds:
            oldest === null
              ? null
              : Math.max(0, Math.round((Date.now() - oldest.getTime()) / 1000)),
        },
        activity_24h: {
          forwards: forwards?.n ?? 0,
          replies: replies?.n ?? 0,
          bounces: bounces?.n ?? 0,
          blocked: blocked?.n ?? 0,
        },
        users: {
          total: userTotal?.n ?? 0,
          disabled: userDisabled?.n ?? 0,
        },
      };
    },
  });
}
