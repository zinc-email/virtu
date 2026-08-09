/**
 * Retry backoff for the delivery queue: exponential with ±20% jitter,
 * capped. Pure and clock-free — the worker adds the delay to its own now.
 */

/** First-retry delay. */
export const BASE_DELAY_MS = 60_000;
/** Upper bound on any single delay. */
export const MAX_DELAY_MS = 60 * 60_000;
/** Jitter fraction applied symmetrically (±). */
export const JITTER = 0.2;

/**
 * Delay before the next attempt after `tries` attempts have failed
 * (tries >= 1): base * 2^(tries-1), capped, jittered. `random` injectable
 * for tests; defaults to Math.random.
 */
export function backoffDelayMs(tries: number, random: () => number = Math.random): number {
  const attempt = Math.max(1, tries);
  const exact = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = 1 + JITTER * (random() * 2 - 1);
  return Math.round(exact * jitter);
}
