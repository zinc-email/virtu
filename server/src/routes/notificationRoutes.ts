// Notifications — the dashboard bell (SimpleLogin-compatible; docs:
// tmp/simple-login/app/docs/api.md "Notification endpoints"). The rows are
// written by the mail pipeline (pipeline/bounce.ts sendAlertOnce: bounce
// auto-disable, mailbox detach, invalidated codes …); this surface only
// lists and marks them read.
//   GET  /notifications?page=N          unread first, newest first, 20/page
//   POST /notifications/:id/read        mark one as read

import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { db } from "../db";
import { type Notification, notifications } from "../db/schema";
import { HttpError } from "./httpError";
import { ErrorResponse, NotificationReadResponse, NotificationsResponse } from "./schema";
import { timeAgo } from "./timeAgo";

/** SimpleLogin PAGE_LIMIT. */
const PAGE_LIMIT = 20;

/** SL's `int(request.args.get("page"))` try/except, error text verbatim. */
function parsePage(raw: string | undefined): number {
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, "page must be provided in request query");
  }
  return n;
}

function notificationToDict(row: Notification, now: Date) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    read: row.read,
    created_at: timeAgo(row.createdAt, now),
  };
}

export async function withNotificationRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/notifications",
    schema: {
      description:
        "List the account's in-app notifications (bounce auto-disables, mailbox " +
        "problems, …), unread first then newest first, 20 per page. `page` starts " +
        "at 0; `more` says whether another page exists. `created_at` is a " +
        "humanized phrase ('2 minutes ago'), as in SimpleLogin.",
      tags: ["Notification"],
      security: [{ apiKeyAuth: [] }],
      querystring: z.object({ page: z.string().optional() }),
      response: { 200: NotificationsResponse, 400: ErrorResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const page = parsePage(req.query.page);
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, req.user.id))
        .orderBy(asc(notifications.read), desc(notifications.createdAt), desc(notifications.id))
        .limit(PAGE_LIMIT + 1) // one extra row = the `more` peek
        .offset(page * PAGE_LIMIT);
      const now = new Date();
      return {
        more: rows.length > PAGE_LIMIT,
        notifications: rows.slice(0, PAGE_LIMIT).map((row) => notificationToDict(row, now)),
      };
    },
  });

  a.route({
    method: "POST",
    url: "/notifications/:notification_id/read",
    schema: {
      description: "Mark one notification as read.",
      tags: ["Notification"],
      security: [{ apiKeyAuth: [] }],
      params: z.object({ notification_id: z.coerce.number().int() }),
      response: { 200: NotificationReadResponse, 401: ErrorResponse, 403: ErrorResponse },
    },
    handler: async (req) => {
      // User-scoped update: an id belonging to someone else is
      // indistinguishable from an unknown one (403 either way, per SL).
      const updated = await db
        .update(notifications)
        .set({ read: true })
        .where(
          and(
            eq(notifications.id, req.params.notification_id),
            eq(notifications.userId, req.user.id),
          ),
        )
        .returning({ id: notifications.id });
      if (updated[0] === undefined) throw new HttpError(403, "Forbidden");
      return { done: true };
    },
  });
}
