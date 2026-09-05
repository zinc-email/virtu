// Unit tests for the pure premium-policy core (injected clock, no DB).
// The DB-backed wrappers (hasActiveSubscription/isPremium) are exercised by
// the billing int tier through the webhook flow.

import { afterEach, describe, expect, test } from "bun:test";
import {
  billingEnforced,
  isPremium,
  PAST_DUE_GRACE_DAYS,
  PERIOD_END_GRACE_DAYS,
  subscriptionGrantsPremium,
  trialActive,
} from "./premium";
import { setBillingConfigForTests } from "./stripe";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-08-08T12:00:00Z");
const daysFromNow = (days: number) => new Date(now.getTime() + days * DAY_MS);

describe("subscriptionGrantsPremium", () => {
  test.each(["active", "trialing"] as const)("%s with a future period end grants", (status) => {
    expect(subscriptionGrantsPremium({ status, currentPeriodEnd: daysFromNow(20) }, now)).toBe(
      true,
    );
  });

  test.each(["active", "trialing"] as const)(
    "%s keeps premium through the renewal grace window, then loses it",
    (status) => {
      const justInside = daysFromNow(-PERIOD_END_GRACE_DAYS + 0.5);
      const justOutside = daysFromNow(-PERIOD_END_GRACE_DAYS - 0.5);
      expect(subscriptionGrantsPremium({ status, currentPeriodEnd: justInside }, now)).toBe(true);
      expect(subscriptionGrantsPremium({ status, currentPeriodEnd: justOutside }, now)).toBe(false);
    },
  );

  test("active with a null period end grants (checkout landed before the first subscription event)", () => {
    expect(subscriptionGrantsPremium({ status: "active", currentPeriodEnd: null }, now)).toBe(true);
  });

  test("past_due keeps premium through the dunning bound, then loses it", () => {
    const inside = daysFromNow(-PAST_DUE_GRACE_DAYS + 1);
    const outside = daysFromNow(-PAST_DUE_GRACE_DAYS - 1);
    expect(subscriptionGrantsPremium({ status: "past_due", currentPeriodEnd: inside }, now)).toBe(
      true,
    );
    expect(subscriptionGrantsPremium({ status: "past_due", currentPeriodEnd: outside }, now)).toBe(
      false,
    );
  });

  test.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "whatever"])(
    "status %s never grants, even with a future period end",
    (status) => {
      expect(subscriptionGrantsPremium({ status, currentPeriodEnd: daysFromNow(30) }, now)).toBe(
        false,
      );
    },
  );

  test("the clock is injected, not read from Date.now", () => {
    const sub = { status: "active", currentPeriodEnd: daysFromNow(2) };
    expect(subscriptionGrantsPremium(sub, daysFromNow(1))).toBe(true);
    expect(subscriptionGrantsPremium(sub, daysFromNow(10))).toBe(false);
  });
});

describe("trialActive", () => {
  test("future trialEnd is active, past is not, null is not", () => {
    expect(trialActive({ trialEnd: daysFromNow(1) }, now)).toBe(true);
    expect(trialActive({ trialEnd: daysFromNow(-1) }, now)).toBe(false);
    expect(trialActive({ trialEnd: null }, now)).toBe(false);
  });
});

describe("billingEnforced / isPremium without Stripe", () => {
  afterEach(() => setBillingConfigForTests(undefined));

  test("an unconfigured server enforces nothing: expired trial, no lifetime → still premium", async () => {
    setBillingConfigForTests({ billingReturnUrl: "http://client.test" });
    expect(billingEnforced()).toBe(false);
    // Returns before any DB lookup.
    const expired = { id: 1, lifetime: false, trialEnd: daysFromNow(-30) };
    expect(await isPremium(expired, now)).toBe(true);
  });

  test("the full Stripe trio turns enforcement on", () => {
    setBillingConfigForTests({
      stripeSecretKey: "sk_test_unit",
      stripeWebhookSecret: "whsec_unit",
      stripePriceId: "price_unit",
      billingReturnUrl: "http://client.test",
    });
    expect(billingEnforced()).toBe(true);
  });
});
