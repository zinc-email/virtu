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
  /**
   * Even a limited key admits one attempt once this long has passed since
   * its newest failure — a trickle, not a hard lock. Caps an attacker at
   * ~windowMs/trickleMs hash attempts per key per window while letting a
   * VALID credential through within seconds; without it, one stale device
   * retrying a revoked password would 454-lock every other device of the
   * same user behind the same NAT. Default 5s.
   */
  trickleMs?: number;
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
  const trickleMs = opts.trickleMs ?? 5_000;
  // Insertion order doubles as recency: recordFailure re-inserts its key,
  // so the first map entry is always the least-recently-failing one.
  const failures = new Map<string, number[]>();

  const liveTimes = (key: string, nowMs: number): number[] => {
    const times = (failures.get(key) ?? []).filter((t) => t > nowMs - windowMs);
    if (times.length === 0) failures.delete(key);
    return times;
  };

  // How many stale entries an eviction pass may inspect. Bounds the work of
  // a single recordFailure while still letting eviction prefer NON-limited
  // keys — a flood of cheap unknown-username failures must not be able to
  // push a currently-limited (attacked) key out of the map and re-open the
  // hashing path for it.
  const EVICTION_SCAN_LIMIT = 100;

  const touch = (key: string, times: number[]) => {
    failures.delete(key); // re-insert to move the key to the recent end
    failures.set(key, times);
  };

  return {
    isLimited(key, now = new Date()) {
      const nowMs = now.getTime();
      const times = liveTimes(key, nowMs);
      if (times.length < maxFailures) return false;
      // Trickle: quiet for trickleMs since the newest failure → admit ONE
      // attempt. The admission is recorded immediately — the verifier takes
      // hundreds of ms, and N concurrent connections probing the same quiet
      // gap must not all be admitted (that would void the CPU cap). A
      // successful attempt clears the key; a failed one re-arms via
      // recordFailure like any other.
      if (nowMs - times[times.length - 1]! >= trickleMs) {
        times.push(nowMs);
        touch(key, times);
        return false;
      }
      touch(key, times); // a limited key stays recent for as long as it's probed
      return true;
    },
    recordFailure(key, now = new Date()) {
      const nowMs = now.getTime();
      const times = liveTimes(key, nowMs);
      times.push(nowMs);
      touch(key, times);
      if (failures.size <= maxKeys) return;
      // Evict the oldest NON-limited key (scan-bounded); only when every
      // scanned key is itself limited fall back to the oldest outright.
      let scanned = 0;
      for (const candidate of failures.keys()) {
        if (candidate === key || ++scanned > EVICTION_SCAN_LIMIT) break;
        if (liveTimes(candidate, nowMs).length < maxFailures) {
          failures.delete(candidate);
          return;
        }
      }
      const oldest = failures.keys().next().value;
      if (oldest !== undefined && oldest !== key) failures.delete(oldest);
    },
    clear(key) {
      failures.delete(key);
    },
  };
}
