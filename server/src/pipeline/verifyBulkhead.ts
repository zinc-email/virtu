/**
 * Process-wide bulkhead on argon2id password verifies in submission.
 * Bun.password.verify runs on the libuv thread pool, so even with the
 * selector scheme (one verify per attempt) a distributed attacker can pin
 * every core one cheap attempt at a time. Capping concurrent verifies keeps
 * the mail path responsive: a saturated pool answers 454 4.7.0 before any
 * hashing, like the failed-attempt throttle (pre-launch security review P2).
 *
 * In-process state on purpose, like authThrottle: each submission process
 * bulkheads exactly the CPU it owns. No queueing — SMTP clients retry, and a
 * wait line under attack is just a slower way to saturate.
 */

export interface Bulkhead {
  /** Claim a slot; false = saturated, refuse without hashing. */
  tryAcquire(): boolean;
  /** Return a slot claimed by a successful tryAcquire. */
  release(): void;
  /** Peek without claiming — the cheap shed-before-any-work check. */
  saturated(): boolean;
}

/** Default concurrent argon2id verifies per submission process. */
export const VERIFY_BULKHEAD_LIMIT = 4;

export function createBulkhead(limit: number = VERIFY_BULKHEAD_LIMIT): Bulkhead {
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= limit) return false;
      inFlight += 1;
      return true;
    },
    release() {
      if (inFlight > 0) inFlight -= 1;
    },
    saturated() {
      return inFlight >= limit;
    },
  };
}
