/**
 * Contact (reverse-alias) DB adapter — the stateful half of Lane C's
 * `getOrCreateContact` / `resolveReverseAlias` callback contracts.
 *
 * Reverse-alias format (SimpleLogin style):
 *
 *     {sanitized}_{random}@{mailDomain}
 *
 * where `sanitized` is the contact's real address lowercased with `@` →
 * `_at_` and everything outside [a-z0-9_-] flattened to `_` (dots included —
 * so a reverse-alias localpart can never look like a 3-dot-part VERP
 * localpart), and `random` is 8 chars of [a-z0-9]. Uniqueness is enforced by
 * the `contacts_reply_email_uq` DB constraint with regenerate-and-retry —
 * never by an application-side check.
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type Contact, contacts } from "../db/schema.ts";
import type { Address, ContactSource } from "../mail/index.ts";

/** Max localpart length (RFC 5321); the sanitized part is trimmed to fit. */
const MAX_LOCALPART = 64;

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const RANDOM_LENGTH = 8;

/** 8 chars of [a-z0-9] (modulo bias is irrelevant for uniqueness-with-retry). */
export function randomSuffix(length: number = RANDOM_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += RANDOM_ALPHABET[b % RANDOM_ALPHABET.length];
  return out;
}

/**
 * Sanitize a real address into a reverse-alias localpart prefix:
 * `Milton.W@initech.com` → `milton_w_at_initech_com`. Dots are flattened on
 * purpose so no reverse alias can ever parse as a VERP localpart.
 */
export function sanitizeForReverseAlias(email: string): string {
  const flattened = email
    .trim()
    .toLowerCase()
    .replace("@", "_at_")
    .replace(/[^a-z0-9_-]/g, "_");
  // Guarantee a non-empty prefix even for degenerate input.
  return flattened === "" ? "unknown" : flattened;
}

/** Build one candidate reverse-alias address (before uniqueness is known). */
export function buildReverseAliasAddress(websiteEmail: string, mailDomain: string): string {
  const suffix = `_${randomSuffix()}`;
  const prefix = sanitizeForReverseAlias(websiteEmail).slice(0, MAX_LOCALPART - suffix.length);
  return `${prefix}${suffix}@${mailDomain}`;
}

/** Which alias (and owner) a contact belongs to. */
export interface ContactScope {
  userId: number;
  aliasId: number;
}

/** Options for {@link getOrCreateContact}. */
export interface GetOrCreateContactOptions {
  /** Domain reverse aliases are minted on (config.mailDomain). */
  mailDomain: string;
  /** Envelope MAIL FROM observed when the contact is first seen (debugging aid). */
  envelopeFrom?: string;
  /** Created by the forward pipeline (vs. by the user via the API). */
  automaticCreated?: boolean;
}

const MAX_WEBSITE_EMAIL = 512;
const MAX_NAME = 512;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Find or create the contact row for (alias, outside address), reporting
 * which happened (the API needs `existed` / 200-vs-201). Concurrency-safe:
 * relies on the two unique constraints — (aliasId, websiteEmail) for
 * find-or-create races, replyEmail for reverse-alias collisions — and
 * retries on violation rather than pre-checking.
 */
export async function findOrCreateContact(
  db: Db,
  scope: ContactScope,
  addr: Address,
  source: ContactSource,
  opts: GetOrCreateContactOptions,
): Promise<{ contact: Contact; created: boolean }> {
  const websiteEmail = truncate(addr.address.trim().toLowerCase(), MAX_WEBSITE_EMAIL);
  const name = addr.name === undefined ? null : truncate(addr.name.trim(), MAX_NAME) || null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.aliasId, scope.aliasId), eq(contacts.websiteEmail, websiteEmail)))
      .limit(1);
    if (existing[0] !== undefined) return { contact: existing[0], created: false };

    const inserted = await db
      .insert(contacts)
      .values({
        userId: scope.userId,
        aliasId: scope.aliasId,
        websiteEmail,
        replyEmail: buildReverseAliasAddress(websiteEmail, opts.mailDomain),
        name,
        mailFrom: opts.envelopeFrom ?? null,
        automaticCreated: opts.automaticCreated ?? true,
      })
      // Any unique violation — a concurrent find-or-create of the same
      // contact, or a reply-email collision — yields an empty return and
      // loops back to the select / a fresh random suffix.
      .onConflictDoNothing()
      .returning();
    if (inserted[0] !== undefined) return { contact: inserted[0], created: true };
  }
  throw new Error(
    `findOrCreateContact: could not create contact for ${websiteEmail} (alias ${scope.aliasId})`,
  );
}

/** {@link findOrCreateContact} without the created flag (pipeline callers). */
export async function getOrCreateContact(
  db: Db,
  scope: ContactScope,
  addr: Address,
  source: ContactSource,
  opts: GetOrCreateContactOptions,
): Promise<Contact> {
  return (await findOrCreateContact(db, scope, addr, source, opts)).contact;
}

/**
 * Resolve a reverse-alias address back to its contact row, or null when the
 * address is not a known reverse alias (the caller then refuses — never
 * leaks). Case-insensitive: reverse aliases are minted lowercase.
 */
export async function resolveReverseAlias(db: Db, address: string): Promise<Contact | null> {
  const replyEmail = address.trim().toLowerCase();
  const found = await db
    .select()
    .from(contacts)
    .where(eq(contacts.replyEmail, replyEmail))
    .limit(1);
  return found[0] ?? null;
}

/** `source` is part of the Lane C callback signature; re-exported for wiring. */
export type { ContactSource };
