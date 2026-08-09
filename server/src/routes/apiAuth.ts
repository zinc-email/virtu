// The SimpleLogin auth hook: `Authentication: <api_key>` header (their exact
// header name — NOT Authorization). Keys are stored sha256; lookup is by
// digest. On success the request carries { user, apiKey } for handlers.

import type { onRequestAsyncHookHandler } from "fastify";
import { eq } from "drizzle-orm";
import { hashApiKey } from "../auth/apiKey";
import { db } from "../db";
import { type ApiKey, apiKeys, type User, users } from "../db/schema";

declare module "fastify" {
  interface FastifyRequest {
    // Set by requireApiAuth; only routes inside the authed context read them.
    user: User;
    apiKey: ApiKey;
  }
}

import { HttpError } from "./httpError";

export const requireApiAuth: onRequestAsyncHookHandler = async (req) => {
  const header = req.headers.authentication;
  const code = typeof header === "string" ? header : undefined;
  if (!code) throw new HttpError(401, "Wrong api key");

  const rows = await db
    .select({ apiKey: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.keyHash, hashApiKey(code)))
    .limit(1);
  const hit = rows[0];
  if (!hit) throw new HttpError(401, "Wrong api key");
  if (hit.user.disabled) throw new HttpError(403, "Disabled account");

  req.user = hit.user;
  req.apiKey = hit.apiKey;

  // Usage stats, SimpleLogin-style (last_used + times).
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date(), times: hit.apiKey.times + 1 })
    .where(eq(apiKeys.id, hit.apiKey.id));
};
