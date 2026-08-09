// The single premium predicate (PLAN Lane I contract). Lane I's Stripe
// webhook upserts `subscriptions`; everything else reads through here.
// Semantics copy SimpleLogin's User.is_premium(): lifetime deal OR active
// subscription OR in trial period.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { subscriptions, type User } from "../db/schema";

// Stripe statuses that still grant access. past_due keeps access during the
// dunning window (Stripe's recommended default).
const ACTIVE_STATUSES = ["active", "trialing", "past_due"];

export async function hasActiveSubscription(userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.status, ACTIVE_STATUSES)))
    .limit(1);
  return rows.length > 0;
}

export function trialActive(user: User): boolean {
  return user.trialEnd !== null && user.trialEnd.getTime() > Date.now();
}

export async function isPremium(user: User): Promise<boolean> {
  if (user.lifetime) return true;
  if (await hasActiveSubscription(user.id)) return true;
  return trialActive(user);
}
