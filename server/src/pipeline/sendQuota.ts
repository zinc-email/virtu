/**
 * Per-user outbound send quota, enforced at submission pre-enqueue (PLAN
 * Lane K P2). This is the cap on what a compromised device credential can
 * blast through our IP before an operator notices: forwards are inbound
 * traffic and never count; only user-initiated submission sends do — which
 * is exactly the rows createReplyLog writes (email_logs.is_reply), so the
 * count needs no extra bookkeeping table.
 *
 * Limit resolution: users.max_daily_sends when set (operator override; 0 =
 * unlimited), else the plan default from config. The window is a rolling
 * 24h, counted per RECIPIENT (one email_log per recipient), matching how
 * the queue rows fan out.
 */

import { and, count, eq, gt } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { emailLogs, type User } from "../db/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Plan defaults (config.sendQuotaFreePerDay / sendQuotaPremiumPerDay). */
export interface SendQuotaLimits {
  freePerDay: number;
  premiumPerDay: number;
}

/** The applicable daily limit for a user; 0 = unlimited. */
export function dailySendLimit(
  user: Pick<User, "maxDailySends">,
  premium: boolean,
  limits: SendQuotaLimits,
): number {
  if (user.maxDailySends !== null) return user.maxDailySends;
  return premium ? limits.premiumPerDay : limits.freePerDay;
}

export type SendQuotaDecision =
  | { allowed: true }
  /** Refuse the whole message: it would push the 24h count past the limit. */
  | { allowed: false; limit: number; used: number };

/** Pure decision: may `batchSize` more recipients go out right now? */
export function decideSendQuota(limit: number, used: number, batchSize: number): SendQuotaDecision {
  if (limit <= 0) return { allowed: true };
  if (used + batchSize <= limit) return { allowed: true };
  return { allowed: false, limit, used };
}

/** Recipients this user submitted in the trailing 24h (reply + cold sends). */
export async function countRecentSends(db: Db, userId: number, now: Date): Promise<number> {
  const windowStart = new Date(now.getTime() - DAY_MS);
  const [row] = await db
    .select({ n: count() })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.userId, userId),
        eq(emailLogs.isReply, true),
        gt(emailLogs.createdAt, windowStart),
      ),
    );
  return row?.n ?? 0;
}
