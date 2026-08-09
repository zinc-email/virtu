// Billing routes int tests: the webhook flow end-to-end with self-signed
// payloads (no live Stripe anywhere), plus the checkout/portal routes with
// auth/unconfigured paths and a stubbed global fetch for the happy paths.
// Prerequisites: `just up` + `just db push`.
//
// Parallel-safe: every test registers its own user and uses unique
// cus_/sub_ ids; billing config is injected via the stripe.ts test seam and
// restored where a test changes it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { type BillingConfig, setBillingConfigForTests } from "../billing/stripe";
import { db } from "../db";
import { subscriptions, users } from "../db/schema";
import { registerAndLogin } from "./intHarness";

const WEBHOOK_SECRET = "whsec_int_test_secret";
const CONFIGURED: BillingConfig = {
  stripeSecretKey: "sk_test_int",
  stripeWebhookSecret: WEBHOOK_SECRET,
  stripePriceId: "price_int_premium",
  billingReturnUrl: "http://client.test",
};
const UNCONFIGURED: BillingConfig = { billingReturnUrl: "http://client.test" };

let app: App;

beforeAll(async () => {
  setBillingConfigForTests(CONFIGURED);
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  setBillingConfigForTests(undefined);
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });
const uid = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

function sigHeader(payload: string, t = Math.floor(Date.now() / 1000), secret = WEBHOOK_SECRET) {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

async function postWebhook(payload: string, header: string = sigHeader(payload)) {
  return app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": header },
    payload,
  });
}

const eventBody = (type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id: `evt_${uid()}`, type, data: { object } });

const checkoutCompleted = (userId: number, customerId: string, subscriptionId: string) =>
  eventBody("checkout.session.completed", {
    mode: "subscription",
    customer: customerId,
    subscription: subscriptionId,
    client_reference_id: String(userId),
  });

async function userIdByEmail(email: string): Promise<number> {
  const row = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0];
  if (!row) throw new Error(`no user ${email}`);
  return row.id;
}

/** Fresh accounts get a 7-day trial; end it so premium reflects only the subscription. */
async function endTrial(userId: number) {
  await db
    .update(users)
    .set({ trialEnd: new Date(Date.now() - 60_000) })
    .where(eq(users.id, userId));
}

async function subRow(userId: number) {
  return (await db.select().from(subscriptions).where(eq(subscriptions.userId, userId)))[0];
}

async function isPremiumViaApi(apiKey: string): Promise<boolean> {
  const res = await app.inject({ method: "GET", url: "/api/user_info", headers: auth(apiKey) });
  expect(res.statusCode).toBe(200);
  return res.json<{ is_premium: boolean }>().is_premium;
}

/** Route the module-level `fetch` (what stripe.ts defaults to) at a stub. */
async function withStripeFetchStub<T>(
  body: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<{ result: T; calls: { url: string; form: URLSearchParams }[] }> {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

describe("POST /webhooks/stripe — signature gate", () => {
  const payload = eventBody("ping.ignored", {});

  test("correct signature -> 200 acknowledged", async () => {
    const res = await postWebhook(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ received: boolean }>()).toEqual({ received: true });
  });

  test("bad signature -> 400", async () => {
    const res = await postWebhook(payload, sigHeader(payload, undefined, "whsec_wrong"));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("Invalid signature");
  });

  test("stale timestamp -> 400", async () => {
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    const res = await postWebhook(payload, sigHeader(payload, stale));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain("tolerance");
  });

  test("missing signature header -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  test("valid signature over malformed JSON -> 400", async () => {
    const res = await postWebhook("not json {");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("Malformed event payload");
  });

  test("503 when billing is not configured", async () => {
    setBillingConfigForTests(UNCONFIGURED);
    try {
      const res = await postWebhook(payload);
      expect(res.statusCode).toBe(503);
    } finally {
      setBillingConfigForTests(CONFIGURED);
    }
  });
});

describe("POST /webhooks/stripe — subscription lifecycle", () => {
  test("checkout -> active -> period end -> deleted flips isPremium end to end", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    await endTrial(userId);
    expect(await isPremiumViaApi(apiKey)).toBe(false);

    // 1. Checkout completes: row attached to the user, premium immediately.
    const customerId = `cus_${uid()}`;
    const subscriptionId = `sub_${uid()}`;
    const completed = await postWebhook(checkoutCompleted(userId, customerId, subscriptionId));
    expect(completed.statusCode).toBe(200);
    let row = await subRow(userId);
    expect(row?.stripeCustomerId).toBe(customerId);
    expect(row?.stripeSubscriptionId).toBe(subscriptionId);
    expect(row?.status).toBe("active");
    expect(row?.currentPeriodEnd).toBeNull();
    expect(await isPremiumViaApi(apiKey)).toBe(true);

    // 2. Subscription event fills status + current_period_end verbatim.
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        current_period_end: periodEnd,
      }),
    );
    row = await subRow(userId);
    expect(row?.status).toBe("active");
    expect(row?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
    expect(await isPremiumViaApi(apiKey)).toBe(true);

    // 3. An expired period (beyond the 1-day grace) revokes premium even
    //    while the status still says active.
    const expired = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        current_period_end: expired,
      }),
    );
    expect(await isPremiumViaApi(apiKey)).toBe(false);

    // 4. Renewal restores it; deletion cancels it.
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        current_period_end: periodEnd,
      }),
    );
    expect(await isPremiumViaApi(apiKey)).toBe(true);

    const deleted = await postWebhook(
      eventBody("customer.subscription.deleted", {
        id: subscriptionId,
        customer: customerId,
        status: "canceled",
        current_period_end: periodEnd,
      }),
    );
    expect(deleted.statusCode).toBe(200);
    row = await subRow(userId);
    expect(row?.status).toBe("canceled");
    expect(await isPremiumViaApi(apiKey)).toBe(false);
  });

  test("replayed checkout.session.completed is a no-op (does not reset status/period)", async () => {
    const { email } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const customerId = `cus_${uid()}`;
    const subscriptionId = `sub_${uid()}`;
    const payload = checkoutCompleted(userId, customerId, subscriptionId);

    await postWebhook(payload);
    const periodEnd = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "past_due",
        current_period_end: periodEnd,
      }),
    );

    const replay = await postWebhook(payload);
    expect(replay.statusCode).toBe(200);
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("past_due"); // replay did not reset to active
    expect(rows[0]?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
  });

  test("out-of-order subscription.created after updated does not regress status (live-observed)", async () => {
    // Stripe delivers events out of order: in the live test, `updated`
    // (active, with period end) arrived before `created` (incomplete — the
    // subscription's birth state) and the status regressed. `created` must
    // never overwrite the status of a row already tracking the same
    // subscription; it may only backfill a missing period end.
    const { email } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const customerId = `cus_${uid()}`;
    const subscriptionId = `sub_${uid()}`;
    await postWebhook(checkoutCompleted(userId, customerId, subscriptionId));

    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        current_period_end: periodEnd,
      }),
    );
    await postWebhook(
      eventBody("customer.subscription.created", {
        id: subscriptionId,
        customer: customerId,
        status: "incomplete",
        current_period_end: periodEnd,
      }),
    );

    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active"); // birth state did not clobber current state
    expect(rows[0]?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);

    // The backfill path: a row attached by checkout (period end null) gets
    // its period end from a late `created` without a status change.
    const sub2 = `sub_${uid()}`;
    const { email: email2 } = await registerAndLogin(app);
    const userId2 = await userIdByEmail(email2);
    await postWebhook(checkoutCompleted(userId2, `cus_${uid()}`, sub2));
    await postWebhook(
      eventBody("customer.subscription.created", {
        id: sub2,
        customer: customerId,
        status: "incomplete",
        current_period_end: periodEnd,
      }),
    );
    const rows2 = await db.select().from(subscriptions).where(eq(subscriptions.userId, userId2));
    expect(rows2[0]?.status).toBe("active"); // checkout's status kept
    expect(rows2[0]?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000); // backfilled
  });

  test("trialing status and Basil-style items[].current_period_end are stored verbatim", async () => {
    const { email } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const customerId = `cus_${uid()}`;
    const subscriptionId = `sub_${uid()}`;
    await postWebhook(checkoutCompleted(userId, customerId, subscriptionId));

    const periodEnd = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "trialing",
        items: { data: [{ current_period_end: periodEnd }] },
      }),
    );
    const row = await subRow(userId);
    expect(row?.status).toBe("trialing");
    expect(row?.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
  });

  test("subscription events for an untracked subscription are acknowledged and ignored", async () => {
    const orphan = `sub_${uid()}`;
    const res = await postWebhook(
      eventBody("customer.subscription.updated", {
        id: orphan,
        customer: `cus_${uid()}`,
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    expect(res.statusCode).toBe(200);
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.stripeSubscriptionId, orphan));
    expect(rows).toHaveLength(0);
  });

  test("customer.subscription.created re-targets the customer's row (re-subscribe race)", async () => {
    const { email } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const customerId = `cus_${uid()}`;
    const oldSub = `sub_${uid()}`;
    await postWebhook(checkoutCompleted(userId, customerId, oldSub));
    await postWebhook(
      eventBody("customer.subscription.deleted", {
        id: oldSub,
        customer: customerId,
        status: "canceled",
      }),
    );

    // The new subscription's created event arrives before its checkout event.
    const newSub = `sub_${uid()}`;
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await postWebhook(
      eventBody("customer.subscription.created", {
        id: newSub,
        customer: customerId,
        status: "active",
        current_period_end: periodEnd,
      }),
    );
    let row = await subRow(userId);
    expect(row?.stripeSubscriptionId).toBe(newSub);
    expect(row?.status).toBe("active");

    // A stale delete for the OLD subscription must not clobber the new one.
    await postWebhook(
      eventBody("customer.subscription.deleted", {
        id: oldSub,
        customer: customerId,
        status: "canceled",
      }),
    );
    row = await subRow(userId);
    expect(row?.stripeSubscriptionId).toBe(newSub);
    expect(row?.status).toBe("active");
  });

  test("checkout.session.completed for an unknown user is acknowledged and ignored", async () => {
    const res = await postWebhook(checkoutCompleted(999_999_999, `cus_${uid()}`, `sub_${uid()}`));
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/billing/checkout", () => {
  test("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/checkout" });
    expect(res.statusCode).toBe(401);
  });

  test("503 with a clear error when billing is not configured", async () => {
    const { apiKey } = await registerAndLogin(app);
    setBillingConfigForTests(UNCONFIGURED);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/billing/checkout",
        headers: auth(apiKey),
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: string }>().error).toBe("Billing is not configured on this server");
    } finally {
      setBillingConfigForTests(CONFIGURED);
    }
  });

  test("happy path (stubbed fetch): session url returned, user stamped as client_reference_id", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const { result, calls } = await withStripeFetchStub(
      { id: "cs_int", url: "https://checkout.stripe.com/c/pay/cs_int" },
      () => app.inject({ method: "POST", url: "/api/billing/checkout", headers: auth(apiKey) }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.json<{ url: string }>().url).toBe("https://checkout.stripe.com/c/pay/cs_int");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const form = calls[0]?.form;
    expect(form?.get("mode")).toBe("subscription");
    expect(form?.get("line_items[0][price]")).toBe(CONFIGURED.stripePriceId ?? "");
    expect(form?.get("client_reference_id")).toBe(String(userId));
    expect(form?.get("customer_email")).toBe(email);
    expect(form?.get("customer")).toBeNull();
    expect(form?.get("success_url")).toBe("http://client.test/billing?checkout=success");
  });

  test("reuses the existing Stripe customer instead of customer_email", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const customerId = `cus_${uid()}`;
    await postWebhook(checkoutCompleted(userId, customerId, `sub_${uid()}`));

    const { calls } = await withStripeFetchStub({ id: "cs_2", url: "https://x" }, () =>
      app.inject({ method: "POST", url: "/api/billing/checkout", headers: auth(apiKey) }),
    );
    expect(calls[0]?.form.get("customer")).toBe(customerId);
    expect(calls[0]?.form.get("customer_email")).toBeNull();
  });
});

describe("POST /api/billing/portal", () => {
  test("requires auth", async () => {
    const res = await app.inject({ method: "POST", url: "/api/billing/portal" });
    expect(res.statusCode).toBe(401);
  });

  test("400 without an existing Stripe customer", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/billing/portal",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(400);
  });

  test("503 when billing is not configured", async () => {
    const { apiKey } = await registerAndLogin(app);
    setBillingConfigForTests(UNCONFIGURED);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/billing/portal",
        headers: auth(apiKey),
      });
      expect(res.statusCode).toBe(503);
    } finally {
      setBillingConfigForTests(CONFIGURED);
    }
  });

  test("happy path (stubbed fetch): portal url for the stored customer", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);
    const customerId = `cus_${uid()}`;
    await postWebhook(checkoutCompleted(userId, customerId, `sub_${uid()}`));

    const { result, calls } = await withStripeFetchStub(
      { id: "bps_int", url: "https://billing.stripe.com/p/session/bps_int" },
      () => app.inject({ method: "POST", url: "/api/billing/portal", headers: auth(apiKey) }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.json<{ url: string }>().url).toBe("https://billing.stripe.com/p/session/bps_int");
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
    expect(calls[0]?.form.get("customer")).toBe(customerId);
    expect(calls[0]?.form.get("return_url")).toBe("http://client.test/billing");
  });
});

describe("GET /api/billing/status", () => {
  test("walks trial -> free -> premium as the webhook writes arrive", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdByEmail(email);

    const trial = await app.inject({
      method: "GET",
      url: "/api/billing/status",
      headers: auth(apiKey),
    });
    expect(trial.statusCode).toBe(200);
    expect(trial.json<Record<string, unknown>>()).toMatchObject({
      configured: true,
      plan: "trial",
      subscription_status: null,
      current_period_end: null,
      has_customer: false,
    });

    await endTrial(userId);
    const free = await app.inject({
      method: "GET",
      url: "/api/billing/status",
      headers: auth(apiKey),
    });
    expect(free.json<{ plan: string }>().plan).toBe("free");

    const customerId = `cus_${uid()}`;
    const subscriptionId = `sub_${uid()}`;
    const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
    await postWebhook(checkoutCompleted(userId, customerId, subscriptionId));
    await postWebhook(
      eventBody("customer.subscription.updated", {
        id: subscriptionId,
        customer: customerId,
        status: "active",
        current_period_end: periodEnd,
      }),
    );

    const premium = await app.inject({
      method: "GET",
      url: "/api/billing/status",
      headers: auth(apiKey),
    });
    expect(premium.json<Record<string, unknown>>()).toMatchObject({
      plan: "premium",
      subscription_status: "active",
      current_period_end: periodEnd,
      has_customer: true,
    });
  });
});
