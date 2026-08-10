/**
 * Failed-AUTH throttle for the submission listeners (587/465): a sliding
 * window of failures per (remote IP, username), consulted BEFORE any
 * password hashing. Without it, every wrong password buys up to 21 serial
 * argon2id verifications (account hash + a full smtp_credentials set) — an
 * unauthenticated CPU-amplification path; with it, a repeat offender gets a
 * 454 before a single hash is computed.
 *
 * In-process state on purpose (no schema, no Redis — the PLAN's guiding
 * principle): each submission process throttles independently, which is
 * exactly the scope of the CPU it protects. Memory is bounded by evicting
 * the least-recently-failing key past `maxKeys`.
 */

export interface AuthThrottleOptions {
  /** Sliding window length. Default 60s. */
  windowMs?: number;
  /** Failures within the window before the key is refused. Default 10. */
  maxFailures?: number;
  /** Max tracked keys (bounded memory). Default 10_000. */
  maxKeys?: number;
}

export interface AuthThrottle {
  /** True when this key must be refused without any hashing work. */
  isLimited(key: string, now?: Date): boolean;
  /** Record one failed AUTH for the key. */
  recordFailure(key: string, now?: Date): void;
  /** Forget the key after a successful AUTH (the typo run is over). */
  clear(key: string): void;
}

/** The throttle key: one budget per (client address, claimed identity). */
export function authThrottleKey(remoteAddress: string, username: string): string {
  return `${remoteAddress}|${username.trim().toLowerCase()}`;
}

export function createAuthThrottle(opts: AuthThrottleOptions = {}): AuthThrottle {
  const windowMs = opts.windowMs ?? 60_000;
  const maxFailures = opts.maxFailures ?? 10;
  const maxKeys = opts.maxKeys ?? 10_000;
  // Insertion order doubles as recency: recordFailure re-inserts its key,
  // so the first map entry is always the least-recently-failing one.
  const failures = new Map<string, number[]>();

  const liveTimes = (key: string, nowMs: number): number[] => {
    const times = (failures.get(key) ?? []).filter((t) => t > nowMs - windowMs);
    if (times.length === 0) failures.delete(key);
    return times;
  };

  return {
    isLimited(key, now = new Date()) {
      return liveTimes(key, now.getTime()).length >= maxFailures;
    },
    recordFailure(key, now = new Date()) {
      const nowMs = now.getTime();
      const times = liveTimes(key, nowMs);
      times.push(nowMs);
      failures.delete(key); // re-insert to move the key to the recent end
      failures.set(key, times);
      if (failures.size > maxKeys) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
    },
    clear(key) {
      failures.delete(key);
    },
  };
}
