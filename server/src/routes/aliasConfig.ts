// Alias-surface configuration shared by the alias/mailbox/contact/setting
// routes. Kept out of src/config.ts (owned by another lane): everything here
// is route-local and parsed with the same env helper.
//
// SECRET — suffix signing (SimpleLogin's CUSTOM_ALIAS_SECRET analog): the
// HMAC key for signed alias suffixes (see signedSuffix.ts). Signatures only
// need to be unforgeable by clients and stable across the ~10-minute
// create-alias window, so any stable server-side secret works. We read
// ALIAS_SIGNING_SECRET when set and otherwise derive a key from DATABASE_URL
// (server-only, contains the DB password, stable per deployment). Set
// ALIAS_SIGNING_SECRET in production so rotating DB credentials doesn't
// invalidate in-flight create-alias flows.

import { createHash } from "node:crypto";
import { z } from "zod";
import { loadConfigFromEnv } from "../app/env";
import { config } from "../config";

const AliasEnvSchema = z.object({
  // Comma-separated list of domains we create aliases on. The first entry is
  // the default (used for reverse aliases and random aliases). Empty =>
  // [MAIL_DOMAIN] — the domain aliases live on is ONE fact; set this only to
  // offer extra domains beyond it.
  aliasDomains: z.string().default(""),
  aliasSigningSecret: z.string().optional(),
});

const aliasEnv = loadConfigFromEnv(AliasEnvSchema);

const parsedAliasDomains: readonly string[] = aliasEnv.aliasDomains
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d.length > 0);

/** Domains available for alias creation ("SL domains" in SimpleLogin terms). */
export const ALIAS_DOMAINS: readonly string[] =
  parsedAliasDomains.length > 0 ? parsedAliasDomains : [config.mailDomain];

/** The default alias domain (SimpleLogin FIRST_ALIAS_DOMAIN / EMAIL_DOMAIN). */
export const FIRST_ALIAS_DOMAIN = ALIAS_DOMAINS[0] ?? config.mailDomain;

// Fail closed: in production, require an explicit ALIAS_SIGNING_SECRET rather
// than silently deriving the suffix HMAC key from DATABASE_URL (predictable if
// the DB URL is ever a default; deriving a signing key from a connection
// string is poor practice regardless). Mirrors config.ts:assertProductionSecrets.
if (
  (process.env.VIRTU_ENV ?? process.env.NODE_ENV) === "production" &&
  aliasEnv.aliasSigningSecret === undefined
) {
  throw new Error(
    "refusing to start with VIRTU_ENV=production and no ALIAS_SIGNING_SECRET set " +
      "— see server/.env.example.",
  );
}

/** HMAC key for signed suffixes — see the module doc for the derivation. */
export const SUFFIX_SIGNING_SECRET: string =
  aliasEnv.aliasSigningSecret ??
  createHash("sha256").update(`virtu-suffix:${config.databaseUrl}`).digest("hex");

/** SimpleLogin PAGE_LIMIT: max items per page on every paginated endpoint. */
export const PAGE_LIMIT = 20;

/** SimpleLogin SUDO_MODE_MINUTES_VALID: sudo mode lifetime after PATCH /sudo. */
export const SUDO_MODE_MINUTES_VALID = 5;

/** SimpleLogin's signed-suffix validity window (seconds): the create-alias flow. */
export const SUFFIX_MAX_AGE_SECONDS = 600;
