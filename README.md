# virtu-ts

An email alias/proxy service: create a unique address per sign-up, revoke it
when leaked or abused. Bun + TypeScript rewrite of the legacy PHP/postfix
stack. SimpleLogin-compatible API.

**The design doc is [PLAN.md](./PLAN.md)** — architecture, work breakdown,
and decisions live there.

## Layout

- `server/` — one package, several entrypoints (`api`, `mx`, `submission`,
  `deliverd`). Fastify + zod-openapi; Drizzle over Bun's native postgres.
  `server/spec/openapi.json` is the committed API contract.
- `client/` — React SPA (rsbuild + TanStack Router/Query + Mantine). SDK
  generated from the spec by Kubb into `client/src/gen` (gitignored).
- `justfile` / `bin/` — one-liner recipes delegating to scripts.

## Quickstart

```sh
bun install                      # root tooling (biome, lefthook)
(cd server && bun install)
(cd client && bun install)
bunx lefthook install            # pre-commit format hook (once per machine)

just up                          # docker compose: db + api + client
just db push                     # apply the Drizzle schema
```

- API: http://localhost:3000/api (docs spec: `server/spec/openapi.json`)
- Client: http://localhost:9000/

## Billing (optional, Stripe)

Billing is fully offloaded to Stripe (PLAN Lane I): Checkout to subscribe,
Customer Portal to manage, one webhook keeping the `subscriptions` table in
sync. All four vars are optional — leave them unset and the billing routes
answer 503 while the rest of the app runs normally.

```sh
STRIPE_SECRET_KEY=sk_...        # secret key for the Checkout/Portal REST calls
STRIPE_WEBHOOK_SECRET=whsec_... # endpoint secret for POST /webhooks/stripe
STRIPE_PRICE_ID=price_...       # the premium subscription price
BILLING_RETURN_URL=...          # browser return origin (default http://localhost:9000)
```

Point a Stripe webhook endpoint at `POST /webhooks/stripe` with the events
`checkout.session.completed` and `customer.subscription.created/updated/deleted`
(unknown events are acknowledged and ignored).

## Checks & tests

```sh
just check       # format-check + typecheck + unit tests (what CI runs)
just test-unit   # pure-function tests, no docker
just test-int    # route tests against the dockerized postgres (just up + just db push first)
just gen         # regenerate spec + client SDK after changing routes/schema
```
