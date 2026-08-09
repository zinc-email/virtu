// The entire Stripe surface, hand-rolled (PLAN Lane I). Deliberately no
// `stripe` npm SDK: the needed surface is two form-encoded REST calls
// (Checkout Session + Billing Portal Session) and webhook signature
// verification, and the repo values zero-dep durability.
//
// Env is parsed here, NOT in config.ts — billing is optional. When the
// STRIPE_* vars are unset the billing routes answer 503 and the rest of the
// app is unaffected.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { loadConfigFromEnv } from "../app/env";

// ---------------------------------------------------------------------------
// Env (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID,
// BILLING_RETURN_URL — camelCase -> SCREAMING_SNAKE via app/env.ts)
// ---------------------------------------------------------------------------

const BillingConfigSchema = z.object({
  // sk_live_... / sk_test_... — auth for the two REST calls.
  stripeSecretKey: z.string().optional(),
  // whsec_... — endpoint secret for POST /webhooks/stripe verification.
  stripeWebhookSecret: z.string().optional(),
  // price_... — the premium subscription price Checkout sells.
  stripePriceId: z.string().optional(),
  // Where Checkout/Portal send the browser back to. Defaults to the dev
  // client origin (rsbuild on :9000); production must override.
  billingReturnUrl: z.string().default("http://localhost:9000"),
});

export type BillingConfig = z.infer<typeof BillingConfigSchema>;

export function loadBillingConfig(
  env: Record<string, string | undefined> = process.env,
): BillingConfig {
  return loadConfigFromEnv(BillingConfigSchema, "", env);
}

// Lazily parsed + cached so tests can inject a config regardless of module
// import order (config.ts-style import-time parsing would freeze env before
// a test file's body runs).
let cachedConfig: BillingConfig | undefined;

export function getBillingConfig(): BillingConfig {
  cachedConfig ??= loadBillingConfig();
  return cachedConfig;
}

/** Test seam: override (or with undefined, re-read from env) the cached config. */
export function setBillingConfigForTests(config: BillingConfig | undefined): void {
  cachedConfig = config;
}

export interface ConfiguredBillingConfig extends BillingConfig {
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  stripePriceId: string;
}

// All-or-nothing on purpose: a partially configured Stripe setup (say, a
// secret key but no webhook secret) would sell subscriptions it can never
// observe, so every billing route gates on the full trio.
export function isBillingConfigured(config: BillingConfig): config is ConfiguredBillingConfig {
  return Boolean(config.stripeSecretKey && config.stripeWebhookSecret && config.stripePriceId);
}

// ---------------------------------------------------------------------------
// REST calls (fetch, form-encoded, secret-key auth)
// ---------------------------------------------------------------------------

export const STRIPE_API_BASE = "https://api.stripe.com";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface StripeClientOptions {
  secretKey: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Test seam — defaults to the real Stripe API origin. */
  baseUrl?: string;
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

// Both calls return richer objects; `url` is all we consume (the browser
// redirect target).
const SessionResponse = z.looseObject({ id: z.string(), url: z.string() });
export type StripeSession = z.infer<typeof SessionResponse>;

const StripeErrorResponse = z.looseObject({
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

async function stripePost(
  path: string,
  form: Record<string, string>,
  options: StripeClientOptions,
): Promise<StripeSession> {
  const doFetch = options.fetchImpl ?? fetch;
  const res = await doFetch(`${options.baseUrl ?? STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new StripeApiError(res.status, `Stripe returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const parsed = StripeErrorResponse.safeParse(json);
    const message = parsed.success ? parsed.data.error?.message : undefined;
    throw new StripeApiError(res.status, message ?? `Stripe request failed (HTTP ${res.status})`);
  }

  const session = SessionResponse.safeParse(json);
  if (!session.success) {
    throw new StripeApiError(res.status, "Stripe response missing session id/url");
  }
  return session.data;
}

export interface CheckoutSessionParams {
  /** Reuse the customer from a previous subscription when we have one. */
  customerId?: string;
  /** Otherwise let Stripe create a customer with the account email. */
  customerEmail: string;
  /** Our user id — comes back verbatim on checkout.session.completed. */
  clientReferenceId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}

export async function createCheckoutSession(
  params: CheckoutSessionParams,
  options: StripeClientOptions,
): Promise<StripeSession> {
  const form: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": params.priceId,
    "line_items[0][quantity]": "1",
    client_reference_id: params.clientReferenceId,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
  };
  if (params.customerId) form.customer = params.customerId;
  else form.customer_email = params.customerEmail;
  return stripePost("/v1/checkout/sessions", form, options);
}

export interface PortalSessionParams {
  customerId: string;
  returnUrl: string;
}

export async function createPortalSession(
  params: PortalSessionParams,
  options: StripeClientOptions,
): Promise<StripeSession> {
  return stripePost(
    "/v1/billing_portal/sessions",
    { customer: params.customerId, return_url: params.returnUrl },
    options,
  );
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Stripe-Signature v1 scheme)
// ---------------------------------------------------------------------------

// Stripe's documented default tolerance.
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a Stripe-Signature header: v1 = HMAC-SHA256(secret, `${t}.${rawBody}`),
 * |now - t| <= 5 min, constant-time compare. rawBody must be the exact bytes
 * received — any re-serialization breaks the MAC.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  sigHeader: string | undefined,
  secret: string,
  now: Date = new Date(),
): VerifyResult {
  if (!sigHeader) return { ok: false, reason: "missing Stripe-Signature header" };

  // Header shape: `t=1712000000,v1=abc...,v1=def...,v0=...` (multiple v1
  // entries are legal during endpoint-secret rolls).
  let timestamp: number | undefined;
  const v1Signatures: string[] = [];
  for (const part of sigHeader.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = Number(value);
    else if (key === "v1") v1Signatures.push(value);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return { ok: false, reason: "malformed Stripe-Signature header (no timestamp)" };
  }
  if (v1Signatures.length === 0) {
    return { ok: false, reason: "malformed Stripe-Signature header (no v1 signature)" };
  }

  const ageSeconds = Math.abs(now.getTime() / 1000 - timestamp);
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const payload = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), payload]))
    .digest();

  for (const candidateHex of v1Signatures) {
    // Buffer.from(_, "hex") truncates at the first invalid character, so
    // garbage fails the length check rather than throwing.
    const candidate = Buffer.from(candidateHex, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature mismatch" };
}

// ---------------------------------------------------------------------------
// Event parsing
// ---------------------------------------------------------------------------

const StripeEventSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  data: z.looseObject({ object: z.record(z.string(), z.unknown()) }),
});

export type StripeEvent = z.infer<typeof StripeEventSchema>;

/** Parse a raw webhook body into an event; null when malformed. */
export function parseEvent(rawBody: string | Uint8Array): StripeEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(
      typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
    );
  } catch {
    return null;
  }
  const parsed = StripeEventSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// In webhook payloads `customer`/`subscription` are id strings, but Stripe
// also serializes expanded objects in places — accept both shapes.
const IdOrObject = z.union([z.string(), z.looseObject({ id: z.string() })]);
const asId = (v: z.infer<typeof IdOrObject> | null | undefined): string | null =>
  v == null ? null : typeof v === "string" ? v : v.id;

const CheckoutSessionObject = z.looseObject({
  mode: z.string().nullish(),
  customer: IdOrObject.nullish(),
  subscription: IdOrObject.nullish(),
  client_reference_id: z.string().nullish(),
});

export interface CheckoutSessionCompleted {
  mode: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  clientReferenceId: string | null;
}

export function parseCheckoutSessionObject(
  object: Record<string, unknown>,
): CheckoutSessionCompleted | null {
  const parsed = CheckoutSessionObject.safeParse(object);
  if (!parsed.success) return null;
  return {
    mode: parsed.data.mode ?? null,
    customerId: asId(parsed.data.customer),
    subscriptionId: asId(parsed.data.subscription),
    clientReferenceId: parsed.data.client_reference_id ?? null,
  };
}

const SubscriptionObject = z.looseObject({
  id: z.string(),
  customer: IdOrObject,
  status: z.string(),
  // Pre-Basil API versions carry current_period_end on the subscription;
  // 2025-03-31+ moved it to items.data[].current_period_end. Read both.
  current_period_end: z.number().nullish(),
  items: z
    .looseObject({ data: z.array(z.looseObject({ current_period_end: z.number().nullish() })) })
    .nullish(),
});

export interface SubscriptionEventObject {
  subscriptionId: string;
  customerId: string;
  status: string;
  currentPeriodEnd: Date | null;
}

export function parseSubscriptionObject(
  object: Record<string, unknown>,
): SubscriptionEventObject | null {
  const parsed = SubscriptionObject.safeParse(object);
  if (!parsed.success) return null;
  const sub = parsed.data;

  let endEpoch = sub.current_period_end ?? null;
  if (endEpoch === null && sub.items) {
    for (const item of sub.items.data) {
      if (
        item.current_period_end != null &&
        (endEpoch === null || item.current_period_end > endEpoch)
      ) {
        endEpoch = item.current_period_end;
      }
    }
  }

  return {
    subscriptionId: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    status: sub.status,
    currentPeriodEnd: endEpoch === null ? null : new Date(endEpoch * 1000),
  };
}
