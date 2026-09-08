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

// Look-alike guard (pre-launch security review P2): a service-domain alias
// goes out DKIM-signed by the service key with a user-chosen display name,
// so `noreply.x4f2q@` + "Zinc Billing" reads as the service itself. Words a
// recipient would attribute to the operator (or that RFC 2142 reserves) are
// refused as the leading word of a shared-domain prefix. Custom domains are
// exempt — the user owns that namespace.
//
// Best-effort BY DESIGN (decision 2026-09-07): the walk below catches the
// mechanical variants the prefix alphabet allows (separators, digits that
// read as letters, digit padding) and stops there — creative misspellings
// and the like are accepted residual risk, not a bug backlog. The alphabet
// itself (checkAliasPrefix) already excludes unicode confusables. Abuse
// handling, not minting rules, owns whatever slips through.
const RESERVED_ALIAS_PREFIX_WORDS = [
  "abuse",
  "account",
  "accounts",
  "admin",
  "administrator",
  "alert",
  "alerts",
  "billing",
  "contact",
  "donotreply",
  "do-not-reply",
  "help",
  "helpdesk",
  "hostmaster",
  "info",
  "invoice",
  "legal",
  "mailer-daemon",
  "no-reply",
  "noreply",
  "no_reply",
  "notification",
  "notifications",
  "official",
  "payment",
  "payments",
  "postmaster",
  "root",
  "sales",
  "security",
  "service",
  "staff",
  "support",
  "team",
  "verification",
  "verify",
  "virtu",
  "webmaster",
  "zinc",
];

// checkAliasPrefix's alphabet is [0-9a-z-_.], so a look-alike can only vary
// a reserved word by inserting separators (`no.reply`), substituting the
// digits that read as letters (`supp0rt`), or appending digits (`admin2`).
const SEPARATORS = new Set(["-", "_", "."]);
const DIGIT_LOOKALIKES: Record<string, string> = {
  "0": "o",
  "1": "il",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
};

/** True when `prefix` spells out `word` at its start, ignoring separators and
 * reading look-alike digits as their letters, and the match ends at a word
 * boundary (end of prefix, a separator, or a trailing digit run). */
function leadsWithReservedWord(prefix: string, word: string): boolean {
  let i = 0;
  for (const wc of word) {
    while (i < prefix.length && SEPARATORS.has(prefix[i]!)) i++;
    const pc = prefix[i];
    if (pc === undefined) return false;
    if (pc !== wc && !(DIGIT_LOOKALIKES[pc] ?? "").includes(wc)) return false;
    i++;
  }
  const rest = prefix.slice(i);
  return rest === "" || SEPARATORS.has(rest[0]!) || /^[0-9]+$/.test(rest);
}

// The walk skips separators in the prefix, so words are matched bare —
// `no-reply` and `noreply` in the list are equivalent spellings. Normalized
// once here; only per-call extraWords normalize at call time.
const normalizeReservedWord = (word: string) => word.toLowerCase().replace(/[-_.]/g, "");
const RESERVED_WORDS_NORMALIZED = [
  ...new Set(RESERVED_ALIAS_PREFIX_WORDS.map(normalizeReservedWord)),
];

/**
 * True when a shared-domain alias prefix leads with a reserved word —
 * exactly (`support`), behind a separator (`support.us`, `billing-2`), with
 * separators or look-alike digits inside it (`no.reply`, `supp0rt`), or
 * padded with digits (`admin2`). `supportive` is honest and passes.
 * `extraWords` folds in deployment-specific reservations
 * (config.operatorLocalparts) so the two lists can't drift.
 */
export function isReservedAliasPrefix(prefix: string, extraWords: readonly string[] = []): boolean {
  const lower = prefix.toLowerCase();
  return (
    RESERVED_WORDS_NORMALIZED.some((word) => leadsWithReservedWord(lower, word)) ||
    extraWords.some((word) => leadsWithReservedWord(lower, normalizeReservedWord(word)))
  );
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
