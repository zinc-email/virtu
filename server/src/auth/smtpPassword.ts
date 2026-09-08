// Device-password material for SMTP AUTH (smtp_credentials rows), shared by
// the credential-creation route and the submission listeners so the two
// halves of the selector scheme can never drift apart.
//
// The password the user pastes is four dash-separated groups of five chars:
//
//     xxxxx-xxxxx-xxxxx-xxxxx
//     └─┬─┘ └────────┬───────┘
//   selector       secret
//
// The FIRST group is a plaintext selector (25 bits, smtp_credentials.selector,
// unique per user): AUTH splits it off, does one indexed lookup, one argon2id
// verify of the remaining three groups. Without it, every wrong password paid
// up to MAX_SMTP_CREDENTIALS serial argon2id verifications — the
// CPU-amplification path from the pre-launch security review (P2). The wire
// format the user sees is unchanged; they still paste the whole thing.

import { randomBytes } from "node:crypto";

const CREDENTIAL_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/1/l

/**
 * Generate a device password: four dash-separated groups of five characters
 * from an unambiguous lowercase alphabet (~100 bits; 25 selector + 75 secret)
 * — app-password style, easy to type on a phone once, never shown again.
 */
export function generateSmtpPassword(): string {
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => CREDENTIAL_ALPHABET[b % CREDENTIAL_ALPHABET.length]);
  const groups = [];
  for (let i = 0; i < 20; i += 5) groups.push(chars.slice(i, i + 5).join(""));
  return groups.join("-");
}

/**
 * Split a presented password into the selector (everything before the first
 * dash) and the secret (everything after). Null when either half would be
 * empty — the caller then burns the dummy verify and refuses, same as a
 * wrong secret.
 */
export function splitSmtpPassword(password: string): { selector: string; secret: string } | null {
  const dash = password.indexOf("-");
  if (dash <= 0 || dash === password.length - 1) return null;
  return { selector: password.slice(0, dash), secret: password.slice(dash + 1) };
}

// A real argon2id hash (of material nobody knows: fresh randomness) with the
// same parameters as stored credentials, so a verify against it costs the
// same as a verify against a real row. The PROMISE is memoized, not the
// value: concurrent first misses must share one hash computation, not each
// run their own on the thread pool the verify bulkhead protects.
let dummyHashPromise: Promise<string> | null = null;

/** Kick off (or reuse) the one-time dummy-hash computation. Also called at
 * submission startup so the first real refusal doesn't pay hash + verify
 * (a timing wobble on the path built for cost uniformity). A failed
 * computation is NOT memoized — caching a rejected promise would break
 * every future AUTH miss until restart; the next call retries instead. */
export function warmDummyHash(): Promise<string> {
  if (dummyHashPromise === null) {
    const attempt = Bun.password.hash(randomBytes(32).toString("hex"), {
      algorithm: "argon2id",
    });
    attempt.catch(() => {
      if (dummyHashPromise === attempt) dummyHashPromise = null;
    });
    dummyHashPromise = attempt;
  }
  return dummyHashPromise;
}

/**
 * Constant-cost refusal: when the username or selector resolves to no row,
 * verify the presented secret against a dummy hash before failing, so a
 * selector miss costs like a wrong secret and valid selectors cannot be
 * enumerated for free.
 */
export async function verifyAgainstDummy(secret: string): Promise<false> {
  try {
    await Bun.password.verify(secret, await warmDummyHash());
  } catch {
    // The decoy could not be computed (thread-pool failure at hash time).
    // Still refuse: the constant-cost property degrades for this attempt,
    // but the mail path stays up and the next attempt retries the hash.
  }
  return false;
}
