/**
 * DKIM key loading: signing keys live in the dkim_keys table (PLAN decision
 * 1), fetched per domain (+ optional selector preference) and cached briefly
 * so the mail path does not hit the DB once per message.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { dkimKeys } from "../db/schema.ts";
import type { DkimKeyConfig } from "../mailauth/index.ts";

/** Cache TTL. Small: key rotation must take effect quickly. */
const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  at: number;
  value: DkimKeyConfig | null;
}

const cache = new Map<string, CacheEntry>();

/** Drop all cached keys (tests, rotation hooks). */
export function clearDkimKeyCache(): void {
  cache.clear();
}

/**
 * Load the active signing key for a domain. When `selector` is given, an
 * active key with that selector wins; otherwise the first active key for the
 * domain (by id) is used. Returns null when the domain has no active key —
 * callers should deliver unsigned rather than drop mail.
 */
export async function loadDkimKey(
  db: Db,
  domain: string,
  selector?: string,
  now: () => number = Date.now,
): Promise<DkimKeyConfig | null> {
  const cacheKey = `${domain}\0${selector ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined && now() - hit.at < CACHE_TTL_MS) return hit.value;

  const preferred =
    selector === undefined
      ? []
      : await db
          .select()
          .from(dkimKeys)
          .where(
            and(
              eq(dkimKeys.domain, domain),
              eq(dkimKeys.selector, selector),
              eq(dkimKeys.active, true),
            ),
          )
          .limit(1);

  const row =
    preferred[0] ??
    (
      await db
        .select()
        .from(dkimKeys)
        .where(and(eq(dkimKeys.domain, domain), eq(dkimKeys.active, true)))
        .orderBy(dkimKeys.id)
        .limit(1)
    )[0];

  const value: DkimKeyConfig | null =
    row === undefined
      ? null
      : {
          signingDomain: row.domain,
          selector: row.selector,
          privateKey: row.privateKeyPem,
          algorithm: row.algorithm === "ed25519-sha256" ? "ed25519-sha256" : "rsa-sha256",
        };

  cache.set(cacheKey, { at: now(), value });
  return value;
}
