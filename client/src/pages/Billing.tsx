// Billing page ("/billing"): current plan, Upgrade via Stripe Checkout,
// Manage via the Stripe Customer Portal. Billing is fully offloaded to
// Stripe (PLAN Lane I) — this page only redirects to Stripe-hosted pages and
// renders what the webhook wrote. Servers without STRIPE_* configured get a
// clear "billing not configured" state instead of broken buttons.

import { Alert, Badge, Button, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { apiErrorMessage } from "src/api/errors";
import { useGetBillingStatus, usePostBillingCheckout, usePostBillingPortal } from "src/gen";

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

const PLAN_LABEL = { premium: "Premium", trial: "Trial", free: "Free" } as const;

export function BillingPage() {
  const navigate = useNavigate();
  const status = useGetBillingStatus();

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
    <Stack mt="3rem" mb="4rem" gap="lg">
      <Group justify="space-between" align="flex-start">
        <Title order={2}>Billing</Title>
        <Button variant="subtle" color="gray" onClick={() => void navigate({ to: "/" })}>
          Back to aliases
        </Button>
      </Group>

      {checkoutResult === "success" && (
        <Alert color="brand.5" variant="light">
          Payment received — your subscription activates as soon as Stripe confirms it (usually
          seconds).
        </Alert>
      )}
      {checkoutResult === "canceled" && (
        <Alert color="gray" variant="light">
          Checkout canceled. Your plan is unchanged.
        </Alert>
      )}

      {status.isPending ? (
        <Stack align="center" p="xl">
          <Loader color="brand.5" />
        </Stack>
      ) : status.isError ? (
        <Alert color="red" variant="light">
          {apiErrorMessage(status.error)}
        </Alert>
      ) : data ? (
        <Paper p="lg" radius="md" bg="dark.6">
          <Stack gap="md">
            <Group gap="xs">
              <Text fw={500}>Current plan</Text>
              <Badge
                size="lg"
                color={plan === "free" ? "gray" : "brand.5"}
                c={plan === "free" ? undefined : "dark.8"}
              >
                {PLAN_LABEL[plan]}
              </Badge>
            </Group>

            {plan === "trial" && data.trial_end !== null && (
              <Text size="sm" c="dimmed">
                Trial ends {fmtDate(data.trial_end)}. Upgrade to keep premium features.
              </Text>
            )}
            {data.subscription_status !== null && (
              <Text size="sm" c="dimmed">
                Subscription status:{" "}
                <Text span ff="monospace">
                  {data.subscription_status}
                </Text>
                {data.current_period_end !== null &&
                  ` — current period ends ${fmtDate(data.current_period_end)}`}
              </Text>
            )}
            {plan === "free" && (
              <Text size="sm" c="dimmed">
                The free plan is limited. Premium unlocks unlimited aliases.
              </Text>
            )}

            {!data.configured ? (
              <Alert color="gray" variant="light">
                Billing is not configured on this server.
              </Alert>
            ) : (
              <Group gap="xs">
                {plan !== "premium" && (
                  <Button
                    color="brand.5"
                    c="dark.8"
                    loading={checkout.isPending}
                    onClick={() => checkout.mutate()}
                  >
                    Upgrade to Premium
                  </Button>
                )}
                {data.has_customer && (
                  <Button
                    variant="default"
                    loading={portal.isPending}
                    onClick={() => portal.mutate()}
                  >
                    Manage subscription
                  </Button>
                )}
              </Group>
            )}

            {sessionError != null && (
              <Alert color={isNotConfigured(sessionError) ? "gray" : "red"} variant="light">
                {isNotConfigured(sessionError)
                  ? "Billing is not configured on this server."
                  : apiErrorMessage(sessionError)}
              </Alert>
            )}
          </Stack>
        </Paper>
      ) : null}
    </Stack>
  );
}
