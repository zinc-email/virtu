/**
 * Retry backoff for the delivery queue: exponential with ±20% jitter,
 * capped. Pure and clock-free — the worker adds the delay to its own now.
 *
 * Defaults pair with config.queueMaxTries=25 and the 6h cap to give ≈4 days
 * of retrying (60s·2^n up to 6h, then flat 6h) — RFC 5321's customary
 * horizon. The simulated internet pins fast values in docker-compose.test.yml
 * so retry stories stay quick.
 */

/** First-retry delay. */
export const BASE_DELAY_MS = 60_000;
/** Default upper bound on any single delay (config.queueBackoffMaxMs). */
export const MAX_DELAY_MS = 6 * 60 * 60_000;
/** Jitter fraction applied symmetrically (±). */
export const JITTER = 0.2;

export interface BackoffOptions {
  /** First-retry delay. Default {@link BASE_DELAY_MS}. */
  baseMs?: number;
  /** Cap on any single delay. Default {@link MAX_DELAY_MS}. */
  maxMs?: number;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

/**
 * Delay before the next attempt after `tries` attempts have failed
 * (tries >= 1): base * 2^(tries-1), capped, jittered.
 */
export function backoffDelayMs(tries: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? BASE_DELAY_MS;
  const maxMs = opts.maxMs ?? MAX_DELAY_MS;
  const random = opts.random ?? Math.random;
  const attempt = Math.max(1, tries);
  const exact = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = 1 + JITTER * (random() * 2 - 1);
  return Math.round(exact * jitter);
}
