// Pure text helpers for the alias surface, ported from SimpleLogin
// (app/utils.py convert_to_id/random_string, Contact.website_send_to,
// arrow's default format for creation_date). No DB, unit-testable.

import { randomInt } from "node:crypto";

const ALLOWED_ID_CHARS = /[^a-zA-Z0-9_\-.]/g;

/**
 * SimpleLogin `convert_to_id`: lowercase, drop spaces, keep only
 * `[a-z0-9_-.]`, truncate to 64. (Their unidecode accent-folding is skipped —
 * non-ASCII simply drops out.)
 */
export function convertToId(s: string): string {
  return s.toLowerCase().replace(/ /g, "").replace(ALLOWED_ID_CHARS, "").slice(0, 64);
}

/** SimpleLogin `check_alias_prefix`: `[0-9a-z-_.]{1,}`, max 40 chars. */
export function checkAliasPrefix(prefix: string): boolean {
  return prefix.length <= 40 && /^[0-9a-z\-_.]+$/.test(prefix);
}

/** SimpleLogin `random_string`: lowercase letters, optionally digits. */
export function randomString(length = 10, includeDigits = false): string {
  const alphabet = includeDigits
    ? "abcdefghijklmnopqrstuvwxyz0123456789"
    : "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// Multi-part TLD second labels: enough to make prefix suggestions sane for
// the common `example.co.uk` shape without a full public-suffix list.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "or", "ne"]);

/**
 * Prefix suggestion from a hostname: the registrable domain's first label
 * (SimpleLogin uses tldextract; this is a heuristic —
 * `www.groupon.com` -> `groupon`, `news.bbc.co.uk` -> `bbc`), run through
 * {@link convertToId}.
 */
export function prefixSuggestionFromHostname(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length === 0) return "";
  if (labels.length === 1) return convertToId(labels[0]!);
  let idx = labels.length - 2;
  if (
    labels.length >= 3 &&
    labels[labels.length - 1]!.length === 2 &&
    SECOND_LEVEL.has(labels[idx]!)
  ) {
    idx -= 1;
  }
  return convertToId(labels[idx]!);
}

/**
 * `creation_date` wire format — arrow's default `.format()`:
 * `2020-04-06 17:57:14+00:00` (always UTC).
 */
export function formatCreationDate(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}+00:00`;
}

/** Unix seconds for `*_timestamp` fields. */
export function timestampOf(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/**
 * SimpleLogin `Contact.website_send_to()`: the reverse alias as an email
 * client "send to" string —
 * `"First Last | first at example.com" <reverse@domain>` (always quoted;
 * sender_format AT, the only format we support).
 */
export function websiteSendTo(contact: {
  name: string | null;
  websiteEmail: string;
  replyEmail: string;
}): string {
  const email = contact.websiteEmail.replace("@", " at ");
  let name = contact.name ? contact.name.replace(/"/g, "") : "";
  name = name ? `${name} | ${email}` : email;
  return `"${name}" <${contact.replyEmail}>`;
}
