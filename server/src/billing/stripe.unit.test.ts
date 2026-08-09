// Unit tests for the hand-rolled Stripe surface: env parsing, webhook
// signature verification (self-signed payloads), event parsing, and the two
// REST calls against a stubbed fetch. No network, no DB.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  createCheckoutSession,
  createPortalSession,
  isBillingConfigured,
  loadBillingConfig,
  parseCheckoutSessionObject,
  parseEvent,
  parseSubscriptionObject,
  STRIPE_API_BASE,
  StripeApiError,
  verifyWebhookSignature,
  WEBHOOK_TOLERANCE_SECONDS,
} from "./stripe";

const SECRET = "whsec_test_secret";

function signHeader(payload: string, secret: string, t: number, extra = ""): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}${extra}`;
}

describe("loadBillingConfig", () => {
  test("empty env parses with all keys unset and the dev return-url default", () => {
    const config = loadBillingConfig({});
    expect(config.stripeSecretKey).toBeUndefined();
    expect(config.stripeWebhookSecret).toBeUndefined();
    expect(config.stripePriceId).toBeUndefined();
    expect(config.billingReturnUrl).toBe("http://localhost:9000");
    expect(isBillingConfigured(config)).toBe(false);
  });

  test("reads the STRIPE_* / BILLING_RETURN_URL env names", () => {
    const config = loadBillingConfig({
      STRIPE_SECRET_KEY: "sk_test_123",
      STRIPE_WEBHOOK_SECRET: "whsec_123",
      STRIPE_PRICE_ID: "price_123",
      BILLING_RETURN_URL: "https://app.virtu.email",
    });
    expect(config).toEqual({
      stripeSecretKey: "sk_test_123",
      stripeWebhookSecret: "whsec_123",
      stripePriceId: "price_123",
      billingReturnUrl: "https://app.virtu.email",
    });
    expect(isBillingConfigured(config)).toBe(true);
  });

  test("a partial configuration does not count as configured", () => {
    const config = loadBillingConfig({ STRIPE_SECRET_KEY: "sk_test_123" });
    expect(isBillingConfigured(config)).toBe(false);
  });
});

describe("verifyWebhookSignature", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } });
  const nowSec = 1_754_000_000;
  const now = new Date(nowSec * 1000);

  test("accepts a correctly signed payload (string and bytes)", () => {
    const header = signHeader(payload, SECRET, nowSec);
    expect(verifyWebhookSignature(payload, header, SECRET, now)).toEqual({ ok: true });
    expect(verifyWebhookSignature(Buffer.from(payload), header, SECRET, now)).toEqual({ ok: true });
  });

  test("rejects a tampered payload", () => {
    const header = signHeader(payload, SECRET, nowSec);
    const verdict = verifyWebhookSignature(payload.replace("ping", "pong"), header, SECRET, now);
    expect(verdict).toEqual({ ok: false, reason: "signature mismatch" });
  });

  test("rejects a signature made with the wrong secret", () => {
    const header = signHeader(payload, "whsec_other", nowSec);
    expect(verifyWebhookSignature(payload, header, SECRET, now).ok).toBe(false);
  });

  test("rejects timestamps outside the 5-minute tolerance, both directions", () => {
    const stale = nowSec - WEBHOOK_TOLERANCE_SECONDS - 1;
    expect(
      verifyWebhookSignature(payload, signHeader(payload, SECRET, stale), SECRET, now),
    ).toEqual({ ok: false, reason: "timestamp outside tolerance" });
    const future = nowSec + WEBHOOK_TOLERANCE_SECONDS + 1;
    expect(
      verifyWebhookSignature(payload, signHeader(payload, SECRET, future), SECRET, now).ok,
    ).toBe(false);
  });

  test("accepts a timestamp just inside the tolerance", () => {
    const edge = nowSec - WEBHOOK_TOLERANCE_SECONDS + 1;
    expect(verifyWebhookSignature(payload, signHeader(payload, SECRET, edge), SECRET, now)).toEqual(
      { ok: true },
    );
  });

  test("rejects a missing or malformed header", () => {
    expect(verifyWebhookSignature(payload, undefined, SECRET, now).ok).toBe(false);
    expect(verifyWebhookSignature(payload, "", SECRET, now).ok).toBe(false);
    expect(verifyWebhookSignature(payload, "gibberish", SECRET, now).ok).toBe(false);
    expect(verifyWebhookSignature(payload, `t=${nowSec}`, SECRET, now).ok).toBe(false);
    expect(verifyWebhookSignature(payload, "t=abc,v1=deadbeef", SECRET, now).ok).toBe(false);
  });

  test("accepts when any one of multiple v1 signatures matches (secret roll)", () => {
    const good = createHmac("sha256", SECRET).update(`${nowSec}.${payload}`).digest("hex");
    const bad = "0".repeat(64);
    const header = `t=${nowSec},v1=${bad},v1=${good}`;
    expect(verifyWebhookSignature(payload, header, SECRET, now)).toEqual({ ok: true });
  });

  test("non-hex v1 values fail cleanly instead of throwing", () => {
    const header = `t=${nowSec},v1=${"z".repeat(64)}`;
    expect(verifyWebhookSignature(payload, header, SECRET, now).ok).toBe(false);
  });
});

describe("parseEvent", () => {
  test("parses a well-formed event", () => {
    const raw = JSON.stringify({
      id: "evt_1",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1" } },
    });
    const event = parseEvent(raw);
    expect(event?.id).toBe("evt_1");
    expect(event?.type).toBe("customer.subscription.updated");
    expect(event?.data.object).toEqual({ id: "sub_1" });
  });

  test("returns null for non-JSON and JSON of the wrong shape", () => {
    expect(parseEvent("not json {")).toBeNull();
    expect(parseEvent(JSON.stringify({ id: "evt_1" }))).toBeNull();
    expect(parseEvent(JSON.stringify({ id: "evt_1", type: "x", data: {} }))).toBeNull();
  });
});

describe("parseSubscriptionObject", () => {
  test("reads top-level current_period_end (pre-Basil API versions)", () => {
    const sub = parseSubscriptionObject({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      current_period_end: 1_760_000_000,
    });
    expect(sub).toEqual({
      subscriptionId: "sub_1",
      customerId: "cus_1",
      status: "active",
      currentPeriodEnd: new Date(1_760_000_000 * 1000),
    });
  });

  test("falls back to the max items.data[].current_period_end (Basil, 2025-03-31+)", () => {
    const sub = parseSubscriptionObject({
      id: "sub_1",
      customer: { id: "cus_1" },
      status: "trialing",
      items: {
        data: [{ current_period_end: 1_760_000_000 }, { current_period_end: 1_770_000_000 }],
      },
    });
    expect(sub?.customerId).toBe("cus_1");
    expect(sub?.currentPeriodEnd).toEqual(new Date(1_770_000_000 * 1000));
  });

  test("null period end and missing required fields", () => {
    const sub = parseSubscriptionObject({ id: "sub_1", customer: "cus_1", status: "canceled" });
    expect(sub?.currentPeriodEnd).toBeNull();
    expect(parseSubscriptionObject({ customer: "cus_1", status: "active" })).toBeNull();
  });
});

describe("parseCheckoutSessionObject", () => {
  test("normalizes id strings and expanded objects", () => {
    expect(
      parseCheckoutSessionObject({
        mode: "subscription",
        customer: "cus_1",
        subscription: { id: "sub_1" },
        client_reference_id: "42",
      }),
    ).toEqual({
      mode: "subscription",
      customerId: "cus_1",
      subscriptionId: "sub_1",
      clientReferenceId: "42",
    });
  });

  test("missing fields become nulls", () => {
    expect(parseCheckoutSessionObject({})).toEqual({
      mode: null,
      customerId: null,
      subscriptionId: null,
      clientReferenceId: null,
    });
  });
});

// -- REST calls against a stubbed fetch -------------------------------------

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(status: number, body: unknown) {
  const calls: Captured[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

const clientOptions = { secretKey: "sk_test_123" };

describe("createCheckoutSession", () => {
  test("posts a form-encoded subscription checkout and returns the session", async () => {
    const { calls, fetchImpl } = stubFetch(200, {
      id: "cs_1",
      url: "https://checkout.stripe.com/c/pay/cs_1",
    });
    const session = await createCheckoutSession(
      {
        customerEmail: "wes@example.com",
        clientReferenceId: "42",
        priceId: "price_123",
        successUrl: "https://app/billing?checkout=success",
        cancelUrl: "https://app/billing?checkout=canceled",
      },
      { ...clientOptions, fetchImpl },
    );
    expect(session.url).toBe("https://checkout.stripe.com/c/pay/cs_1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${STRIPE_API_BASE}/v1/checkout/sessions`);
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_123");
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const form = new URLSearchParams(call.init.body as string);
    expect(form.get("mode")).toBe("subscription");
    expect(form.get("line_items[0][price]")).toBe("price_123");
    expect(form.get("line_items[0][quantity]")).toBe("1");
    expect(form.get("client_reference_id")).toBe("42");
    expect(form.get("success_url")).toBe("https://app/billing?checkout=success");
    expect(form.get("cancel_url")).toBe("https://app/billing?checkout=canceled");
    expect(form.get("customer_email")).toBe("wes@example.com");
    expect(form.get("customer")).toBeNull();
  });

  test("prefers an existing customer id over customer_email", async () => {
    const { calls, fetchImpl } = stubFetch(200, { id: "cs_1", url: "https://x" });
    await createCheckoutSession(
      {
        customerId: "cus_1",
        customerEmail: "wes@example.com",
        clientReferenceId: "42",
        priceId: "price_123",
        successUrl: "https://s",
        cancelUrl: "https://c",
      },
      { ...clientOptions, fetchImpl },
    );
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("customer")).toBe("cus_1");
    expect(form.get("customer_email")).toBeNull();
  });

  test("surfaces Stripe error messages", async () => {
    const { fetchImpl } = stubFetch(400, { error: { message: "No such price: price_123" } });
    expect(
      createCheckoutSession(
        {
          customerEmail: "wes@example.com",
          clientReferenceId: "42",
          priceId: "price_123",
          successUrl: "https://s",
          cancelUrl: "https://c",
        },
        { ...clientOptions, fetchImpl },
      ),
    ).rejects.toThrow(new StripeApiError(400, "No such price: price_123"));
  });
});

describe("createPortalSession", () => {
  test("posts customer + return_url and returns the session", async () => {
    const { calls, fetchImpl } = stubFetch(200, {
      id: "bps_1",
      url: "https://billing.stripe.com/p/session/bps_1",
    });
    const session = await createPortalSession(
      { customerId: "cus_1", returnUrl: "https://app/billing" },
      { ...clientOptions, fetchImpl },
    );
    expect(session.url).toBe("https://billing.stripe.com/p/session/bps_1");
    const call = calls[0]!;
    expect(call.url).toBe(`${STRIPE_API_BASE}/v1/billing_portal/sessions`);
    const form = new URLSearchParams(call.init.body as string);
    expect(form.get("customer")).toBe("cus_1");
    expect(form.get("return_url")).toBe("https://app/billing");
  });

  test("throws on a session response without a url", async () => {
    const { fetchImpl } = stubFetch(200, { id: "bps_1", url: null });
    expect(
      createPortalSession(
        { customerId: "cus_1", returnUrl: "https://app/billing" },
        { ...clientOptions, fetchImpl },
      ),
    ).rejects.toThrow("Stripe response missing session id/url");
  });
});
