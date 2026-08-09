// Billing routes (PLAN Lane I — Stripe only, fully offloaded):
//
//   GET  /api/billing/status    current plan for the dashboard
//   POST /api/billing/checkout  authed -> Stripe Checkout session url
//   POST /api/billing/portal    authed -> Stripe Customer Portal url
//   POST /webhooks/stripe       NO auth; raw-body signature verification
//
// These are virtu-native (SimpleLogin's paid API has no billing endpoints —
// its Paddle/Coinbase flows are web-only). When the STRIPE_* env vars are
// unset the authed routes answer 503 and the webhook route 503s too; the
// rest of the app never notices.
//
// Webhook events handled (everything else is acknowledged with 200 and
// ignored so Stripe doesn't retry):
// - checkout.session.completed: attach customer+subscription to the user via
//   client_reference_id (our user id, stamped at checkout). Status starts as
//   "active" — completion of a subscription-mode checkout means payment
//   succeeded — and the subscription events below overwrite it verbatim.
// - customer.subscription.created/updated: upsert status + current_period_end
//   verbatim, matched by stripe_subscription_id. `created` may also re-target
//   an existing row for the same customer (re-subscribe where the
//   subscription event raced ahead of checkout.session.completed).
// - customer.subscription.deleted: status -> canceled, matched strictly by
//   stripe_subscription_id (never by customer, so a stale delete for an old
//   subscription can't clobber a newer one).
//
// Idempotent by construction: subscription events upsert on the unique
// stripe_subscription_id; checkout.session.completed upserts on the unique
// user_id and is a no-op when the row already points at the same
// subscription. Replays converge on the same row.

import { eq, sql } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { FastifyZodOpenApiTypeProvider } from "fastify-zod-openapi";
import { z } from "zod";
import { hasActiveSubscription, trialActive } from "../billing/premium";
import {
  createCheckoutSession,
  createPortalSession,
  getBillingConfig,
  isBillingConfigured,
  parseCheckoutSessionObject,
  parseEvent,
  parseSubscriptionObject,
  StripeApiError,
  type StripeEvent,
  verifyWebhookSignature,
} from "../billing/stripe";
import { db } from "../db";
import { type Subscription, subscriptions, users } from "../db/schema";
import { HttpError } from "./httpError";
import { ErrorResponse } from "./schema";

// ---------------------------------------------------------------------------
// Authed routes (registered in the /api authed context)
// ---------------------------------------------------------------------------

const BillingStatusResponse = z
  .object({
    configured: z.boolean(),
    plan: z.enum(["premium", "trial", "free"]),
    subscription_status: z.string().nullable(),
    current_period_end: z.number().int().nullable(),
    trial_end: z.number().int().nullable(),
    has_customer: z.boolean(),
  })
  .meta({ id: "BillingStatusResponse" });

const BillingSessionResponse = z
  .object({ url: z.string() })
  .meta({ id: "BillingSessionResponse", description: "Stripe-hosted page to redirect to" });

const epoch = (d: Date | null): number | null => (d ? Math.floor(d.getTime() / 1000) : null);

async function findSubscription(userId: number): Promise<Subscription | undefined> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return rows[0];
}

function requireConfigured() {
  const config = getBillingConfig();
  if (!isBillingConfigured(config)) {
    throw new HttpError(503, "Billing is not configured on this server");
  }
  return config;
}

export async function withBillingRoutes(authed: FastifyInstance) {
  const a = authed.withTypeProvider<FastifyZodOpenApiTypeProvider>();

  a.route({
    method: "GET",
    url: "/billing/status",
    schema: {
      description:
        "Current billing standing: plan, Stripe subscription status (verbatim), and whether " +
        "billing is configured on this server at all.",
      tags: ["Billing"],
      security: [{ apiKeyAuth: [] }],
      response: { 200: BillingStatusResponse, 401: ErrorResponse },
    },
    handler: async (req) => {
      const sub = await findSubscription(req.user.id);
      // Mirrors userToDict: lifetime/subscription outrank the trial; the
      // trial only shows as "trial" when it's the sole source of premium.
      const hasSub = req.user.lifetime ? false : await hasActiveSubscription(req.user.id);
      const inTrial = !req.user.lifetime && !hasSub && trialActive(req.user);
      const plan =
        req.user.lifetime || hasSub
          ? ("premium" as const)
          : inTrial
            ? ("trial" as const)
            : ("free" as const);
      return {
        configured: isBillingConfigured(getBillingConfig()),
        plan,
        subscription_status: sub?.status ?? null,
        current_period_end: epoch(sub?.currentPeriodEnd ?? null),
        trial_end: epoch(req.user.trialEnd),
        has_customer: sub !== undefined,
      };
    },
  });

  a.route({
    method: "POST",
    url: "/billing/checkout",
    schema: {
      description:
        "Create a Stripe Checkout session for the premium subscription. Redirect the browser " +
        "to the returned url. 503 when billing is not configured.",
      tags: ["Billing"],
      security: [{ apiKeyAuth: [] }],
      response: {
        200: BillingSessionResponse,
        401: ErrorResponse,
        502: ErrorResponse,
        503: ErrorResponse,
      },
    },
    handler: async (req) => {
      const config = requireConfigured();
      const sub = await findSubscription(req.user.id);
      try {
        const session = await createCheckoutSession(
          {
            customerId: sub?.stripeCustomerId,
            customerEmail: req.user.email,
            clientReferenceId: String(req.user.id),
            priceId: config.stripePriceId,
            successUrl: `${config.billingReturnUrl}/billing?checkout=success`,
            cancelUrl: `${config.billingReturnUrl}/billing?checkout=canceled`,
          },
          { secretKey: config.stripeSecretKey },
        );
        return { url: session.url };
      } catch (err) {
        req.log.error(err, "stripe checkout session creation failed");
        throw new HttpError(
          502,
          err instanceof StripeApiError ? err.message : "Stripe request failed",
        );
      }
    },
  });

  a.route({
    method: "POST",
    url: "/billing/portal",
    schema: {
      description:
        "Create a Stripe Customer Portal session (manage/cancel the subscription). Requires an " +
        "existing Stripe customer, i.e. a past checkout. 503 when billing is not configured.",
      tags: ["Billing"],
      security: [{ apiKeyAuth: [] }],
      response: {
        200: BillingSessionResponse,
        400: ErrorResponse,
        401: ErrorResponse,
        502: ErrorResponse,
        503: ErrorResponse,
      },
    },
    handler: async (req) => {
      const config = requireConfigured();
      const sub = await findSubscription(req.user.id);
      if (!sub) throw new HttpError(400, "No billing account yet — subscribe first");
      try {
        const session = await createPortalSession(
          { customerId: sub.stripeCustomerId, returnUrl: `${config.billingReturnUrl}/billing` },
          { secretKey: config.stripeSecretKey },
        );
        return { url: session.url };
      } catch (err) {
        req.log.error(err, "stripe portal session creation failed");
        throw new HttpError(
          502,
          err instanceof StripeApiError ? err.message : "Stripe request failed",
        );
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Webhook endpoint (registered on the root app — outside /api, no auth;
// authenticity comes from the signature)
// ---------------------------------------------------------------------------

export async function handleStripeEvent(event: StripeEvent, log: FastifyBaseLogger): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = parseCheckoutSessionObject(event.data.object);
      if (!session || session.mode !== "subscription") return;
      if (!session.customerId || !session.subscriptionId || !session.clientReferenceId) {
        log.warn({ eventId: event.id }, "checkout.session.completed missing ids; ignoring");
        return;
      }
      const userId = Number(session.clientReferenceId);
      if (!Number.isInteger(userId)) {
        log.warn({ eventId: event.id }, "checkout.session.completed bad client_reference_id");
        return;
      }
      const user = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (user.length === 0) {
        log.warn({ eventId: event.id, userId }, "checkout.session.completed for unknown user");
        return;
      }
      // Upsert on the unique user_id. setWhere makes replays (same
      // subscription id) a pure no-op, so a late replay can never reset the
      // status of a subscription that has since moved on.
      await db
        .insert(subscriptions)
        .values({
          userId,
          stripeCustomerId: session.customerId,
          stripeSubscriptionId: session.subscriptionId,
          status: "active",
          currentPeriodEnd: null,
        })
        .onConflictDoUpdate({
          target: subscriptions.userId,
          set: {
            stripeCustomerId: session.customerId,
            stripeSubscriptionId: session.subscriptionId,
            status: "active",
            currentPeriodEnd: null,
            updatedAt: new Date(),
          },
          setWhere: sql`${subscriptions.stripeSubscriptionId} is distinct from ${session.subscriptionId}`,
        });
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = parseSubscriptionObject(event.data.object);
      if (!sub) {
        log.warn({ eventId: event.id }, "subscription event with unparseable object; ignoring");
        return;
      }
      const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
      const set = {
        stripeCustomerId: sub.customerId,
        status,
        currentPeriodEnd: sub.currentPeriodEnd,
        updatedAt: new Date(),
      };

      if (event.type === "customer.subscription.created") {
        // `created` carries the subscription's BIRTH state (typically
        // `incomplete`) and Stripe delivers events out of order — observed
        // live: `updated` (active) landed before `created` (incomplete),
        // and the old unconditional update regressed the status. A row
        // already tracking this subscription keeps its status; only a
        // missing period end is backfilled.
        const existing = await db
          .select({ id: subscriptions.id, cpe: subscriptions.currentPeriodEnd })
          .from(subscriptions)
          .where(eq(subscriptions.stripeSubscriptionId, sub.subscriptionId))
          .limit(1);
        if (existing[0] !== undefined) {
          if (existing[0].cpe === null && sub.currentPeriodEnd !== null) {
            await db
              .update(subscriptions)
              .set({ currentPeriodEnd: sub.currentPeriodEnd, updatedAt: new Date() })
              .where(eq(subscriptions.id, existing[0].id));
          }
          return;
        }
        // A brand-new subscription for a customer we already track
        // (re-subscribe where this event raced ahead of
        // checkout.session.completed): re-target that customer's row.
        // Restricted to `created` so stale updates/deletes for an old
        // subscription can never steal the row back. No row at all: the
        // checkout.session.completed that maps customer -> user hasn't
        // arrived yet; ignore — it creates the row and later subscription
        // events fill in status/period.
        await db
          .update(subscriptions)
          .set({ ...set, stripeSubscriptionId: sub.subscriptionId })
          .where(eq(subscriptions.stripeCustomerId, sub.customerId));
        return;
      }

      // updated/deleted are authoritative for the subscription's CURRENT
      // state: apply unconditionally, matched by subscription id.
      await db
        .update(subscriptions)
        .set(set)
        .where(eq(subscriptions.stripeSubscriptionId, sub.subscriptionId));
      return;
    }

    default:
      // Unknown/unhandled event types: acknowledge and ignore.
      return;
  }
}

export async function withStripeWebhookRoutes(app: FastifyInstance) {
  await app.register(async (scope) => {
    // Raw-body parser, encapsulated in this plugin scope only — signature
    // verification needs the exact bytes Stripe signed, not re-serialized
    // JSON. No other route's parsing changes.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );

    scope.route({
      method: "POST",
      url: "/webhooks/stripe",
      handler: async (req, reply) => {
        const config = getBillingConfig();
        if (!config.stripeWebhookSecret) {
          return reply.status(503).send({ error: "Billing is not configured on this server" });
        }

        const rawBody = req.body as Buffer;
        const sigHeader = req.headers["stripe-signature"];
        const verdict = verifyWebhookSignature(
          rawBody,
          typeof sigHeader === "string" ? sigHeader : undefined,
          config.stripeWebhookSecret,
        );
        if (!verdict.ok) {
          req.log.warn({ reason: verdict.reason }, "stripe webhook rejected");
          return reply.status(400).send({ error: `Invalid signature: ${verdict.reason}` });
        }

        const event = parseEvent(rawBody);
        if (!event) return reply.status(400).send({ error: "Malformed event payload" });

        await handleStripeEvent(event, req.log);
        return { received: true };
      },
    });
  });
}
