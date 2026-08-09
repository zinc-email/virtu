/**
 * VERP (Variable Envelope Return Path) addresses, SimpleLogin format.
 *
 * Ported verbatim from SimpleLogin `app/email_utils.py`
 * (`generate_verp_email` / `get_verp_info_from_email`):
 *
 * Address format (everything lowercased):
 *
 *     {prefix}.{b32(payload)}.{b32(hmac)}@{domain}
 *
 * - `payload` is the UTF-8 bytes of the JSON array `[type, id, minutes]`
 *   serialized exactly like Python's `json.dumps` (", " separators — this
 *   matters, the HMAC covers these bytes), where:
 *     - `type`  — numeric VERP type: bounce_forward=0, bounce_reply=1,
 *                 transactional=2 (SimpleLogin `VerpType` enum values)
 *     - `id`    — the object id (email log / transactional email row), `0`
 *                 when falsy
 *     - `minutes` — `floor((now_epoch_seconds - 1640995200) / 60)`: minutes
 *                 since 2022-01-01 UTC, to keep the address short
 * - `hmac` is the first 8 bytes of HMAC-SHA3-224(secret, payload)
 *   (SimpleLogin `VERP_HMAC_ALGO = "sha3-224"`, truncated to 8 bytes).
 * - `b32` is RFC 4648 base32 with `=` padding stripped; base32 is used
 *   (rather than base64) because localparts must survive case folding.
 * - The three parts are dot-joined and the whole address lowercased; parsing
 *   is therefore case-insensitive (base32 is decoded after uppercasing).
 *
 * Validity: 5 days (`VERP_MESSAGE_LIFETIME`). NOTE — the Python only rejects
 * timestamps more than 5 days in the *future* (`data[2] > (now + LIFETIME -
 * START)/60`), which never expires old addresses; that is a SimpleLogin bug.
 * We keep that future guard verbatim AND enforce the intended past expiry:
 * addresses older than 5 days are rejected. Signature comparison is
 * constant-time (`crypto.timingSafeEqual`), unlike the Python's `!=`.
 *
 * The secret must be at least 32 characters (SimpleLogin config invariant).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** VERP address types, mirroring SimpleLogin's `VerpType` enum. */
export type VerpType = "bounce_forward" | "bounce_reply" | "transactional";

/** Numeric wire codes for each VERP type (SimpleLogin `VerpType` values). */
export const VERP_TYPE_CODES: Record<VerpType, number> = {
  bounce_forward: 0,
  bounce_reply: 1,
  transactional: 2,
};

const CODE_TO_TYPE: Record<number, VerpType> = {
  0: "bounce_forward",
  1: "bounce_reply",
  2: "transactional",
};

/** Epoch offset: 2022-01-01T00:00:00Z, in seconds (SimpleLogin `VERP_TIME_START`). */
export const VERP_TIME_START = 1640995200;

/** VERP address validity window in seconds: 5 days (SimpleLogin `VERP_MESSAGE_LIFETIME`). */
export const VERP_MESSAGE_LIFETIME = 5 * 86400;

/** Default localpart prefix (SimpleLogin uses "sl"; ours is "vt"). */
export const VERP_DEFAULT_PREFIX = "vt";

/** Minimum accepted secret length (SimpleLogin config invariant). */
export const VERP_MIN_SECRET_LENGTH = 32;

const HMAC_ALGO = "sha3-224";
const HMAC_TRUNCATE = 8;

/** Options for {@link buildVerp}. */
export interface BuildVerpOptions {
  /** VERP address type. */
  type: VerpType;
  /** Object id to encode (email log id, transactional email id). */
  id: number;
  /** HMAC secret, >= 32 chars. */
  secret: string;
  /** Domain for the address (chosen by the caller for SPF alignment). */
  domain: string;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
  /** Localpart prefix; defaults to {@link VERP_DEFAULT_PREFIX}. */
  prefix?: string;
}

/** Options for {@link parseVerp}. */
export interface ParseVerpOptions {
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
  /** Expected localpart prefix; defaults to {@link VERP_DEFAULT_PREFIX}. */
  prefix?: string;
}

/** Successful {@link parseVerp} result. */
export interface VerpInfo {
  type: VerpType;
  id: number;
}

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 encode, `=` padding stripped. */
function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return out;
}

/** RFC 4648 base32 decode (case-insensitive, padding optional). Null on invalid input. */
function base32Decode(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/=+$/, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = B32_ALPHABET.indexOf(ch);
    if (val === -1) return null;
    buffer = (buffer << 5) | val;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * Serialize the payload array byte-identically to Python's `json.dumps`
 * (which uses ", " between items by default). The HMAC covers these exact
 * bytes, so this must match SimpleLogin for cross-compatibility.
 */
function pythonJsonDumps(data: number[]): string {
  return `[${data.join(", ")}]`;
}

function hmacTruncated(secret: string, payload: Uint8Array): Uint8Array {
  const digest = createHmac(HMAC_ALGO, secret).update(payload).digest();
  return new Uint8Array(digest.subarray(0, HMAC_TRUNCATE));
}

function assertSecret(secret: string): void {
  if (secret.length < VERP_MIN_SECRET_LENGTH) {
    throw new Error(`VERP secret must be at least ${VERP_MIN_SECRET_LENGTH} chars`);
  }
}

/**
 * Build a signed VERP address: `{prefix}.{b32(payload)}.{b32(hmac)}@{domain}`,
 * lowercased. See the module doc for the exact format.
 *
 * @throws when the secret is shorter than 32 characters.
 */
export function buildVerp(opts: BuildVerpOptions): string {
  assertSecret(opts.secret);
  const now = opts.now ?? new Date();
  const prefix = opts.prefix ?? VERP_DEFAULT_PREFIX;
  const minutes = Math.floor((now.getTime() / 1000 - VERP_TIME_START) / 60);
  const data = [VERP_TYPE_CODES[opts.type], opts.id || 0, minutes];
  const payload = new TextEncoder().encode(pythonJsonDumps(data));
  const signature = hmacTruncated(opts.secret, payload);
  const localpart = `${prefix}.${base32Encode(payload)}.${base32Encode(signature)}`;
  return `${localpart}@${opts.domain}`.toLowerCase();
}

/**
 * Parse and verify a VERP address. Returns the encoded `{ type, id }` when
 * the address is well-formed, carries a valid HMAC (constant-time compare),
 * and is within the 5-day validity window; null otherwise (never throws on
 * malformed input).
 *
 * Matching is case-insensitive: the address may have been case-folded
 * anywhere along the return path.
 *
 * @throws only when the secret is shorter than 32 characters.
 */
export function parseVerp(
  addr: string,
  secret: string,
  opts: ParseVerpOptions = {},
): VerpInfo | null {
  assertSecret(secret);
  const prefix = (opts.prefix ?? VERP_DEFAULT_PREFIX).toLowerCase();
  const now = opts.now ?? new Date();

  const at = addr.indexOf("@");
  if (at === -1) return null;
  const localpart = addr.slice(0, at);
  const parts = localpart.split(".");
  if (parts.length !== 3) return null;
  if (parts[0]!.toLowerCase() !== prefix) return null;

  const payload = base32Decode(parts[1]!);
  const signature = base32Decode(parts[2]!);
  if (payload === null || signature === null) return null;

  const expected = hmacTruncated(secret, payload);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(signature, expected)) return null;

  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length !== 3) return null;
  const [typeCode, id, minutes] = data;
  if (
    typeof typeCode !== "number" ||
    typeof id !== "number" ||
    typeof minutes !== "number"
  ) {
    return null;
  }
  const type = CODE_TO_TYPE[typeCode];
  if (type === undefined) return null;

  const nowSeconds = now.getTime() / 1000;
  // Verbatim SimpleLogin guard: reject timestamps > 5 days in the future.
  if (minutes > (nowSeconds + VERP_MESSAGE_LIFETIME - VERP_TIME_START) / 60) {
    return null;
  }
  // Intended expiry (missing in the Python — see module doc): reject
  // addresses generated more than 5 days ago.
  if (minutes < (nowSeconds - VERP_MESSAGE_LIFETIME - VERP_TIME_START) / 60) {
    return null;
  }

  return { type, id };
}
