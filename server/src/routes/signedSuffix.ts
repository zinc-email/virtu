// Signed alias suffixes, SimpleLogin-style (their itsdangerous
// TimestampSigner over CUSTOM_ALIAS_SECRET). The GET /v5/alias/options
// response carries `signed_suffix` values; POST /v3/alias/custom/new round-
// trips one back, proving the suffix wasn't tampered with client-side and is
// fresh (<= 600s old — SimpleLogin's "user clicks the button within 600
// seconds" hypothesis).
//
// Wire format (opaque to clients, NOT itsdangerous-compatible — the value
// never leaves our server round trip):
//
//     {suffix}.{b64url(seconds-since-epoch)}.{b64url(hmac-sha256 prefix)}
//
// The HMAC covers `{suffix}.{b64url(ts)}` so neither part can be swapped.
// Verification is constant-time and never throws on malformed input.

import { createHmac, timingSafeEqual } from "node:crypto";

const HMAC_TRUNCATE = 20;

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest().subarray(0, HMAC_TRUNCATE);
}

function encodeTimestamp(seconds: number): string {
  let hex = seconds.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64url");
}

function decodeTimestamp(encoded: string): number | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(encoded, "base64url");
  } catch {
    return null;
  }
  if (buf.length === 0 || buf.length > 6) return null;
  let out = 0;
  for (const byte of buf) out = out * 256 + byte;
  return out;
}

/** Sign a suffix: `{suffix}.{b64url(ts)}.{b64url(mac)}`. */
export function signSuffix(suffix: string, secret: string, now: Date = new Date()): string {
  const ts = encodeTimestamp(Math.floor(now.getTime() / 1000));
  const payload = `${suffix}.${ts}`;
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

/** Why {@link verifySignedSuffix} rejected a value. */
export type SuffixRejection = "tampered" | "expired";

export type VerifySuffixResult =
  | { ok: true; suffix: string }
  | { ok: false; reason: SuffixRejection };

/**
 * Verify a signed suffix: signature (constant-time) then age (`maxAgeSeconds`).
 * Returns the original suffix on success; never throws on malformed input.
 */
export function verifySignedSuffix(
  signed: string,
  secret: string,
  maxAgeSeconds: number,
  now: Date = new Date(),
): VerifySuffixResult {
  // The suffix itself contains dots (".abc123@virtu.email"), so split on the
  // LAST two separators.
  const sigDot = signed.lastIndexOf(".");
  if (sigDot === -1) return { ok: false, reason: "tampered" };
  const tsDot = signed.lastIndexOf(".", sigDot - 1);
  if (tsDot === -1) return { ok: false, reason: "tampered" };

  const payload = signed.slice(0, sigDot);
  const suffix = signed.slice(0, tsDot);
  const tsPart = signed.slice(tsDot + 1, sigDot);
  const sigPart = signed.slice(sigDot + 1);

  let given: Buffer;
  try {
    given = Buffer.from(sigPart, "base64url");
  } catch {
    return { ok: false, reason: "tampered" };
  }
  const expected = mac(secret, payload);
  if (given.length !== expected.length) return { ok: false, reason: "tampered" };
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: "tampered" };

  const ts = decodeTimestamp(tsPart);
  if (ts === null) return { ok: false, reason: "tampered" };
  const age = Math.floor(now.getTime() / 1000) - ts;
  // A timestamp from the future is tampering, not expiry.
  if (age < -5) return { ok: false, reason: "tampered" };
  if (age > maxAgeSeconds) return { ok: false, reason: "expired" };

  return { ok: true, suffix };
}
