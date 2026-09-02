// The SimpleLogin-compatible API surface, mounted under /api (the prefix is
// part of the public URL, exactly like app.simplelogin.io/api/...). The
// OpenAPI transform strips /api from spec paths and carries it in `servers`,
// so the generated SDK's baseURL ("/api") reassembles the same URLs.

import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { withAccountRoutes } from "./account";
import { withAdminDestinationRoutes } from "./admin/destinations";
import { withAdminInviteRoutes } from "./admin/invites";
import { withAdminOperatorRoutes } from "./admin/operators";
import { withAdminOverviewRoutes } from "./admin/overview";
import { withAdminQueueRoutes } from "./admin/queue";
import { requireAdmin } from "./adminAuth";
import { withAliasNewRoutes } from "./aliasNew";
import { withAliasRoutes } from "./aliases";
import { requireApiAuth } from "./apiAuth";
import { withAuthRoutes } from "./auth";
import { withBillingRoutes } from "./billing";
import { withContactRoutes } from "./contacts";
import { withCustomDomainRoutes } from "./customDomains";
import { errorEnvelopeHandler, HttpError } from "./httpError";
import { withMailboxRoutes } from "./mailboxRoutes";
import { withNotificationRoutes } from "./notificationRoutes";
import { withSmtpCredentialRoutes } from "./smtpCredentialRoutes";
import { withUserInfoRoutes } from "./userInfo";

export async function withApiRoutes(app: FastifyInstance) {
  await app.register(
    async (api) => {
      api.setErrorHandler(errorEnvelopeHandler);
      await withAuthRoutes(api);
      await withUserInfoRoutes(api);

      // Everything below requires the Authentication header. The rate-limit
      // plugin is registered non-globally: routes opt in via
      // `config.rateLimit` (limits keyed per user — auth runs first, so
      // req.user is set by the time the limiter's hook fires).
      await api.register(async (authed) => {
        authed.addHook("onRequest", requireApiAuth);
        await authed.register(rateLimit, {
          global: false,
          keyGenerator: (req) => `u:${req.user?.id ?? req.ip}`,
          errorResponseBuilder: () => new HttpError(429, "Too many requests"),
        });
        await withAliasRoutes(authed);
        await withAliasNewRoutes(authed);
        await withContactRoutes(authed);
        await withCustomDomainRoutes(authed);
        await withMailboxRoutes(authed);
        await withNotificationRoutes(authed);
        await withSmtpCredentialRoutes(authed);
        await withAccountRoutes(authed);
        await withBillingRoutes(authed);

        // Operator surface (PLAN decision #16): a nested child so
        // requireAdmin layers on top of the parent's requireApiAuth (parent
        // hooks run first). /api/admin/* rides the same spec + SDK pipeline
        // as everything else, tagged Admin.
        await authed.register(
          async (admin) => {
            admin.addHook("onRequest", requireAdmin);
            await withAdminOverviewRoutes(admin);
            await withAdminQueueRoutes(admin);
            await withAdminInviteRoutes(admin);
            await withAdminOperatorRoutes(admin);
            await withAdminDestinationRoutes(admin);
          },
          { prefix: "/admin" },
        );
      });
    },
    { prefix: "/api" },
  );
}
