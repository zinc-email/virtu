/**
 * Process-wide reservation for unaccepted DATA, spooled to disk.
 * Bytes are reserved as they arrive and released after acceptance/refusal.
 * A full budget refuses DATA with 452; a mid-transfer overrun closes with
 * 421, leaving the sender responsible for retrying. All listeners share
 * this disk budget; spool.ts separately serializes buffer materialization.
 */

export interface DataBudget {
  /** The ceiling, bytes. */
  readonly maxBytes: number;
  /** Bytes currently reserved. */
  inFlight(): number;
  /** Reserve `n` bytes; false (and nothing reserved) when they do not fit. */
  reserve(n: number): boolean;
  /** Give back `n` reserved bytes. */
  release(n: number): void;
}

export function createDataBudget(maxBytes: number): DataBudget {
  let held = 0;
  return {
    maxBytes,
    inFlight: () => held,
    reserve(n) {
      if (held + n > maxBytes) return false;
      held += n;
      return true;
    },
    release(n) {
      held = Math.max(0, held - n);
    },
  };
}

let shared: DataBudget | null = null;

/**
 * The budget every SMTP listener in this process shares (maild runs the
 * mx and both submission listeners in one process). The first caller
 * sizes it; later callers get the same object regardless of the argument,
 * so pass the one configured value everywhere.
 */
export function processDataBudget(maxBytes: number): DataBudget {
  if (shared === null) shared = createDataBudget(maxBytes);
  return shared;
}
