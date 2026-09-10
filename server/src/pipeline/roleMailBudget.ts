/**
 * Trailing-minute budget for role addresses (postmaster@, abuse@ …).
 *
 * Operator mail has no alias, no email_log and no user ledger — it is the
 * service's own — so none of the inbound budgets apply to it, and without
 * one anybody could enqueue a full-size copy per operator at SMTP speed.
 * This is the one bound: a sliding window per role localpart, in memory
 * (the mx is one process; a second one would have its own window, which
 * merely doubles the budget). Counted at RCPT, where the 450 goes.
 */

const MINUTE_MS = 60_000;

export interface RoleMailBudget {
  /** Accept one more message for `localpart` now? Counts it when yes. */
  take(localpart: string, now?: Date): boolean;
}

/** A budget of `perMinute` accepts per localpart; 0 = unlimited. */
export function createRoleMailBudget(perMinute: number): RoleMailBudget {
  const windows = new Map<string, number[]>();
  return {
    take(localpart, now = new Date()) {
      if (perMinute <= 0) return true;
      const t = now.getTime();
      const cutoff = t - MINUTE_MS;
      const hits = (windows.get(localpart) ?? []).filter((at) => at > cutoff);
      if (hits.length >= perMinute) {
        windows.set(localpart, hits);
        return false;
      }
      hits.push(t);
      windows.set(localpart, hits);
      return true;
    },
  };
}
