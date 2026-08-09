// GET /api/user_info — SimpleLogin-compatible (app/api/views/user_info.py's
// user_to_dict, field names verbatim). Doubles as the api-key validation
// endpoint. Registered in an authed child context guarded by requireApiAuth.

import type { FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { MAX_ALIAS_FREE_PLAN } from "../config";
import { hasActiveSubscription, trialActive } from "../billing/premium";
import type { User } from "../db/schema";
import { requireApiAuth } from "./apiAuth";
import { ErrorResponse, type UserInfo, UserInfoResponse } from "./schema";

export async function userToDict(user: User): Promise<UserInfo> {
  const hasSub = user.lifetime ? false : await hasActiveSubscription(user.id);
  const inTrialPeriod = trialActive(user);
  return {
    name: user.name ?? "",
    is_premium: user.lifetime || hasSub || inTrialPeriod,
    email: user.email,
    in_trial: !user.lifetime && !hasSub && inTrialPeriod,
    trial_end_timestamp: user.trialEnd ? Math.floor(user.trialEnd.getTime() / 1000) : null,
    max_alias_free_plan: MAX_ALIAS_FREE_PLAN,
    // No Proton partnership; always null.
    connected_proton_address: null,
    // TODO: false once free-plan contact limits land (Lane E).
    can_create_reverse_alias: true,
    // TODO: profile pictures are not implemented.
    profile_picture_url: null,
  };
}

export async function withUserInfoRoutes(api: FastifyInstance) {
  await api.register(async (authed) => {
    authed.addHook("onRequest", requireApiAuth);

    const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

    a.route({
      method: "GET",
      url: "/user_info",
      schema: {
        description: "Get the authenticated user's information. Also serves as api-key validation.",
        tags: ["Account"],
        security: [{ apiKeyAuth: [] }],
        response: { 200: UserInfoResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
      handler: async (req) => userToDict(req.user),
    });
  });
}
