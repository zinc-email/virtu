// Sudo-mode freshness, extracted from the POST /api_key handler so future
// sudo-gated operations (admin mutations, destructive deletes — PLAN Lane K
// P2) share one definition of "fresh". Sudo mode is a per-api-key window
// stamped by PATCH /sudo (api_keys.sudo_mode_at).

import type { ApiKey } from "../db/schema";
import { SUDO_MODE_MINUTES_VALID } from "./aliasConfig";
import { HttpError } from "./httpError";

/** True while the presented key's sudo window is open. */
export function isSudoFresh(apiKey: Pick<ApiKey, "sudoModeAt">, now = new Date()): boolean {
  return (
    apiKey.sudoModeAt !== null &&
    now.getTime() - apiKey.sudoModeAt.getTime() <= SUDO_MODE_MINUTES_VALID * 60_000
  );
}

/** Throw SimpleLogin's 440 {"error": "Need sudo"} unless sudo is fresh. */
export function assertSudoFresh(apiKey: Pick<ApiKey, "sudoModeAt">, now = new Date()): void {
  if (!isSudoFresh(apiKey, now)) throw new HttpError(440, "Need sudo");
}
