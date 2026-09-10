/**
 * The process-wide bound on message bytes held in DATA.
 *
 * Postfix's memory bound is its process count: one hung client is one
 * process holding at most one message, and `default_process_limit` says
 * how many of those there can be. A single-process server has no such
 * arithmetic unless it writes it down. Every connection in DATA holds its
 * message until the DATA hook has queued or refused it, so the worst case
 * was `maxConnections × maxMessageSize` — 25 GiB against a 1 GiB
 * container — and a peer needed no bandwidth to reach it, only patience.
 *
 * This budget is that arithmetic: bytes are reserved as they arrive in
 * DATA and released when the message is disposed of. A DATA command that
 * finds the budget spent is refused with `452 4.3.1` (the sender queues and
 * retries); a message that would overrun it mid-transfer is cut with
 * `421 4.3.1`. Every listener in the process shares one budget, since
 * they share the one heap.
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
