// Admin gate (PLAN decision #16): an onRequest hook for the nested
// /api/admin scope in routes/index.ts. Layered AFTER requireApiAuth (the
// parent scope's hook runs first), so req.user is always set here. Plain
// 403 — the routes are in the committed public spec and the repo is AGPL;
// 404-hiding would buy nothing.

import type { onRequestAsyncHookHandler } from "fastify";
import { isAdmin } from "../auth/userFlags";
import { HttpError } from "./httpError";

export const requireAdmin: onRequestAsyncHookHandler = async (req) => {
  if (!isAdmin(req.user)) throw new HttpError(403, "Forbidden");
};
