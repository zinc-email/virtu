// The single premium predicate (PLAN Lane I contract). Lane I's Stripe
// webhook upserts `subscriptions`; everything else reads through here.
// Semantics copy SimpleLogin's User.is_premium(): lifetime deal OR active
// subscription OR in trial period.
//
// Subscription-status policy (documented choice):
// - `active` / `trialing` grant premium while current_period_end is unexpired
//   (+1 day of grace so a slightly late renewal webhook never flickers a
//   paying user to free). A null current_period_end grants premium — the
//   checkout.session.completed upsert creates the row before the first
//   subscription event fills the period in.
// - `past_due` keeps premium through Stripe's dunning window, but bounded:
//   current_period_end + 14 days. Stripe ends dunning by flipping the status
//   to `canceled`/`unpaid` via webhook; the bound means a lost webhook still
//   can't grant indefinite free premium.
// - Everything else (`canceled`, `unpaid`, `incomplete`, `incomplete_expired`,
//   `paused`) grants nothing.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { subscriptions, type User } from "../db/schema";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Renewal-webhook slack for active/trialing subscriptions. */
export const PERIOD_END_GRACE_DAYS = 1;
/** Dunning-window bound for past_due subscriptions. */
export const PAST_DUE_GRACE_DAYS = 14;

export interface SubscriptionStanding {
  /** Stripe subscription status, stored verbatim by the webhook. */
  status: string;
  currentPeriodEnd: Date | null;
}

/** Pure policy core — unit-tested with an injected clock. */
export function subscriptionGrantsPremium(
  sub: SubscriptionStanding,
  now: Date = new Date(),
): boolean {
  const end = sub.currentPeriodEnd?.getTime();
  switch (sub.status) {
    case "active":
    case "trialing":
      return end === undefined || now.getTime() < end + PERIOD_END_GRACE_DAYS * DAY_MS;
    case "past_due":
      return end === undefined || now.getTime() < end + PAST_DUE_GRACE_DAYS * DAY_MS;
    default:
      return false;
  }
}

export async function hasActiveSubscription(userId: number, now: Date = new Date()) {
  const rows = await db
    .select({ status: subscriptions.status, currentPeriodEnd: subscriptions.currentPeriodEnd })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  const sub = rows[0];
  return sub !== undefined && subscriptionGrantsPremium(sub, now);
}

export function trialActive(user: Pick<User, "trialEnd">, now: Date = new Date()): boolean {
  return user.trialEnd !== null && user.trialEnd.getTime() > now.getTime();
}

export async function isPremium(user: User, now: Date = new Date()): Promise<boolean> {
  if (user.lifetime) return true;
  if (await hasActiveSubscription(user.id, now)) return true;
  return trialActive(user, now);
}
