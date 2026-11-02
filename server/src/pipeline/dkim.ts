/**
 * DKIM key loading: signing keys live in the dkim_keys table (PLAN decision
 * 1), fetched per domain (+ optional selector preference) and cached briefly
 * so the mail path does not hit the DB once per message.
 *
 * Custom domains get their own key (selector "dkim", RSA-2048), generated at
 * domain-creation time; `selectReplyDkimKey` picks it for replies/sends once
 * the domain can send. Missing/unusable custom-domain keys never fall back
 * to an unrelated service-domain identity. Forwards always sign with the service key.
 */

import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type DkimKey, dkimKeys, domains } from "../db/schema.ts";
import { canSend } from "./domainCapability.ts";
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
 * callers must defer acceptance or retry instead of delivering unsigned.
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

/** Selector for per-custom-domain signing keys ({selector}._domainkey.{domain}). */
export const CUSTOM_DOMAIN_DKIM_SELECTOR = "dkim";

/**
 * Load the full active key ROW for a domain (uncached — used by the DNS
 * check / dns-records endpoints, which need publicKeyBase64 and are not on
 * the per-message hot path). Selector preference mirrors {@link loadDkimKey}.
 */
export async function loadDkimKeyRow(
  db: Db,
  domain: string,
  selector?: string,
): Promise<DkimKey | null> {
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
  return row ?? null;
}

/**
 * Find-or-create the signing key row for a domain (RSA-2048, selector
 * "dkim" by default). Concurrency-safe via the (domain, selector) unique
 * index + retry. Used at custom-domain creation and by test fixtures.
 */
export async function ensureDkimKeyRow(
  db: Db,
  domain: string,
  selector: string = CUSTOM_DOMAIN_DKIM_SELECTOR,
): Promise<DkimKey> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = (
      await db
        .select()
        .from(dkimKeys)
        .where(and(eq(dkimKeys.domain, domain), eq(dkimKeys.selector, selector)))
        .limit(1)
    )[0];
    if (existing !== undefined) return existing;

    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const inserted = await db
      .insert(dkimKeys)
      .values({
        domain,
        selector,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
        publicKeyBase64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
          "base64",
        ),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return inserted[0];
  }
  throw new Error(`ensureDkimKeyRow lost every race for ${domain}/${selector}`);
}

/** Options for {@link selectReplyDkimKey}. */
export interface ReplyKeySelection {
  /** config.mailDomain — the signing domain for service-domain aliases only. */
  serviceDomain: string;
  /** config.dkimSelector — the service key's selector. */
  serviceSelector: string;
}

/**
 * Custom-domain aliases require the send-enabled domain's published selector.
 * A missing domain, revoked capability or missing key prevents acceptance.
 * Service-domain aliases alone use the service key; the signer enforces
 * author alignment and rejects unusable keys without weakening the policy.
 */
export async function selectReplyDkimKey(
  db: Db,
  alias: { domainId: number | null },
  opts: ReplyKeySelection,
): Promise<DkimKeyConfig | null> {
  if (alias.domainId === null) return loadDkimKey(db, opts.serviceDomain, opts.serviceSelector);
  const [domain] = await db.select().from(domains).where(eq(domains.id, alias.domainId)).limit(1);
  if (domain === undefined || !canSend(domain)) return null;
  const key = await loadDkimKey(db, domain.nameRequested, CUSTOM_DOMAIN_DKIM_SELECTOR);
  // verifiedDkim covers this selector; another active but unpublished key
  // for the same domain is not an acceptable substitute either.
  return key?.selector === CUSTOM_DOMAIN_DKIM_SELECTOR ? key : null;
}
