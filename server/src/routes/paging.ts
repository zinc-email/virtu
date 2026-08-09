// SimpleLogin's page_id contract: required, integer, starts at 0; anything
// else is the exact 400 below (their int(request.args.get(...)) try/except).

import { HttpError } from "./httpError";

export function parsePageId(raw: string | undefined): number {
  const n = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, "page_id must be provided in request query");
  }
  return n;
}
