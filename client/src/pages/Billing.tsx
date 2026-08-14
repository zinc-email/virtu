// Billing ("/billing") — legacy "Your account." page: narrow column, key/value
// table, "»" action links. Billing is fully offloaded to Stripe (PLAN Lane I):
// actions only redirect to Stripe-hosted pages and the table renders what the
// webhook wrote. Servers without STRIPE_* get a clear "not configured" state.

import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  useGetBillingStatus,
  useGetUserInfo,
  usePostBillingCheckout,
  usePostBillingPortal,
} from "src/gen";
import { isShell, shellPlatform } from "src/shell";
import { Alert, KV, KVAction, KeyValue, Section, ui } from "src/ui";

function isNotConfigured(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    (err as { response?: { status?: number } }).response?.status === 503
  );
}

const fmtDate = (epochSeconds: number) =>
  new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

const PLAN_LABEL = { premium: "Premium", trial: "Free trial", free: "Free" } as const;

export function BillingPage() {
  const status = useGetBillingStatus();
  const userInfo = useGetUserInfo();

  const checkout = usePostBillingCheckout({
    mutation: { onSuccess: (data) => window.location.assign(data.url) },
  });
  const portal = usePostBillingPortal({
    mutation: { onSuccess: (data) => window.location.assign(data.url) },
  });

  // Stripe sends the browser back with ?checkout=success|canceled.
  const checkoutResult = new URLSearchParams(window.location.search).get("checkout");

  const data = status.data;
  const plan = data?.plan ?? "free";
  const sessionError = checkout.error ?? portal.error;

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Your account.</h1>
      </header>

      {checkoutResult === "success" && (
        <Alert kind="success">
          Payment received — your subscription activates as soon as Stripe confirms it (usually
          seconds).
        </Alert>
      )}
      {checkoutResult === "canceled" && (
        <p className={ui.finePrint}>Checkout canceled. Your plan is unchanged.</p>
      )}

      {status.isPending ? (
        <p className={css({ padding: "2rem 0", color: "textDim" })}>Loading…</p>
      ) : status.isError ? (
        <Alert>{apiErrorMessage(status.error)}</Alert>
      ) : data ? (
        <>
          <KeyValue>
            {userInfo.data && <KV k="Email">{userInfo.data.email}</KV>}
            <KV k="Plan">
              {PLAN_LABEL[plan]}
              {plan === "trial" && data.trial_end !== null && (
                <div className={ui.finePrint}>ends {fmtDate(data.trial_end)}</div>
              )}
            </KV>
            {data.subscription_status !== null && (
              <KV k="Status">
                {data.subscription_status}
                {data.current_period_end !== null && (
                  <div className={ui.finePrint}>
                    current period ends {fmtDate(data.current_period_end)}
                  </div>
                )}
              </KV>
            )}
          </KeyValue>

          {isShell() ? (
            // Store rule (plans/mobile.md): consumption-only — no purchase UI
            // in the mobile apps. Google explicitly permits the plain-text
            // "visit our website" wording; Apple's anti-steering rule outside
            // the US storefront has caught even non-tappable versions of that
            // sentence, so iOS shows subscription status only.
            shellPlatform() === "android" ? (
              <p className={ui.finePrint}>
                To upgrade or manage your subscription, visit {window.location.host} in your web
                browser.
              </p>
            ) : null
          ) : !data.configured ? (
            <p className={ui.finePrint}>Billing is not configured on this server.</p>
          ) : (
            <KeyValue>
              {plan !== "premium" && (
                <KVAction>
                  <button
                    type="button"
                    className={ui.link}
                    disabled={checkout.isPending}
                    onClick={() => checkout.mutate()}
                  >
                    » Upgrade to Premium
                  </button>
                </KVAction>
              )}
              {data.has_customer && (
                <KVAction>
                  <button
                    type="button"
                    className={ui.link}
                    disabled={portal.isPending}
                    onClick={() => portal.mutate()}
                  >
                    » Manage subscription
                  </button>
                </KVAction>
              )}
            </KeyValue>
          )}

          {sessionError != null &&
            (isNotConfigured(sessionError) ? (
              <p className={ui.finePrint}>Billing is not configured on this server.</p>
            ) : (
              <Alert>{apiErrorMessage(sessionError)}</Alert>
            ))}
        </>
      ) : null}
    </Section>
  );
}
