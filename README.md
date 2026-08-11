# virtu-ts

An email alias/proxy service: create a unique address per sign-up, revoke it
when leaked or abused. Bun + TypeScript rewrite of the legacy PHP/postfix
stack. SimpleLogin-compatible API.

**The design doc is [PLAN.md](./PLAN.md)** — architecture, work breakdown,
and decisions live there. **[STATE.md](./STATE.md)** tracks how far along the
build is: what's done, verified, stubbed, and not yet started.

## Layout

- `server/` — one package, several entrypoints (`api`, `mx`, `submission`,
  `deliverd`). Fastify + zod-openapi; Drizzle over Bun's native postgres.
  `server/spec/openapi.json` is the committed API contract.
- `client/` — React SPA (rsbuild + TanStack Router/Query + Mantine), served
  under `/app`. SDK generated from the spec by Kubb into `client/src/gen`
  (gitignored).
- `www/` — static marketing homepage (Astro), served at `/`.
- A reverse proxy (Caddy) fronts all three at one origin — `/` homepage,
  `/app` the SPA, `/api` the API — the same path topology in dev and prod.
- `justfile` / `bin/` — one-liner recipes delegating to scripts.

## Quickstart

```sh
bun install                      # root tooling (biome, lefthook)
(cd server && bun install)
(cd client && bun install)
bunx lefthook install            # pre-commit format hook (once per machine)

cp server/.env.example server/.env  # optional; every var has a dev default
just up                          # docker compose: db, api, client, homepage, proxy
just db push                     # apply the Drizzle schema
```

Everything is behind one origin (the Caddy proxy), matching production:

- **http://localhost:8080/** — homepage (Astro)
- **http://localhost:8080/app** — the SPA (login, aliases, …)
- **http://localhost:8080/api** — the API (spec: `server/spec/openapi.json`)

(Direct access still works for debugging: the SPA at http://localhost:9000/app,
the API at http://localhost:3000/api.)

Config lives in `server/.env` (gitignored); `server/.env.example` documents
every variable and which ones production must override.

### Logging in

Login is passwordless: one email field for login and signup, confirmed by an
emailed 6-digit code — and the dev stack runs no `deliverd`, so codes sit in
the outbound queue. Two shortcuts:

```sh
just user-create                 # log in wes@qmail.com through the code flow
                                 #   (prints the API key; idempotent; takes [email])
just login-code <email>          # print the newest emailed code for an address
```

Then sign in at http://localhost:8080/app/login with the email + the code
from `just login-code`.

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

### Story tests (the simulated internet)

End-to-end mail tests run against a self-contained fake internet — BIND with
fake zones, peer MTAs (a pretend Gmail, a DMARC-strict correspondent, an open
relay), and our own mail service — so SPF/DKIM/DMARC are verified for real, no
external network. Messages are found by an `X-Virtu-Test-Id` header in
Maildir, so tests run in any order without resets.

```sh
(cd server && bun install)       # containers bind-mount server/node_modules
just test-net-up                 # build + start the fake internet
just test-story                  # forwards, replies, bounces, DSNs, custom-domain DKIM
just test-net-logs               # follow the mail pipeline (best debugging view)
just test-net-down               # tear down
```

## Homepage

Static Astro site in `www/`: `just www-dev` (dev server) or `just www-build`
(static output to `www/dist/`).

## Deploy

One **universal `Caddyfile`** serves every environment — it fronts the built
`www/dist` (`/`) + `client/dist` (`/app`) and proxies the API (`/api`), with
the host and TLS driven by env. The only per-box difference is `VIRTU_HOST`.
Environments are named **zinc** (prod, `zinc.email`) and **lmnop** (staging,
`lmnop.email`) — never "prod"/"staging". The plan is a single box per
environment, vertically scaled, running the whole stack via docker compose.

`docker-compose.serve.yml` runs the whole stack — db, api, built frontends
behind Caddy, and `maild` (mx + submission + deliverd in one process, ports
25/587/465):

```sh
# Local prod-like preview (own project, self-signed cert; won't touch dev;
# mail listeners on loopback high ports):
bin/compose -p virtu-serve -f docker-compose.serve.yml up --build -d
#   -> https://localhost:8443   (curl -k)
```

Deploy env vars (all optional; sensible defaults): `VIRTU_HOST` (the box's
hostname), `VIRTU_TLS_MODE` (default `internal` self-signed; set an ACME
account email — that is Caddy's "use ACME" spelling, e.g.
`VIRTU_TLS_MODE=you@example.com`),
`VIRTU_TLS_CHALLENGE` / `VIRTU_TLS_RESOLVERS` (DNS-challenge providers),
`HTTP_PUBLISH`/`HTTPS_PUBLISH`/`MX_PUBLISH`/`SUBMISSION_PUBLISH`/
`SUBMISSION_TLS_PUBLISH` (host port bindings). `Caddyfile.dev` is the
dev-only variant (proxies the HMR dev servers).

### Mail TLS

Caddy owns TLS for the box, including the MX hostname: the `Caddyfile` has a
`mail.{VIRTU_HOST}` site purely so Caddy obtains + renews that cert, and the
`mail-certs` one-shot copies it into the `mail_certs` volume as
`/mail-certs/fullchain.pem` + `privkey.pem`, which `server/.env` points the
SMTP listeners at. The listeners read cert files **once at startup**, so
renewals need `bin/mail-certs-sync` (sync + maild restart) — run it from a
weekly root cron on the box:

```sh
printf '#!/bin/sh\ncd /opt/virtu && runuser -u virtu -- bin/mail-certs-sync\n' \
  > /etc/cron.weekly/virtu-mail-certs && chmod +x /etc/cron.weekly/virtu-mail-certs
```

### A new box, start to finish

DNS first (see `each.email.zone` for the full annotated record set): apex A +
`mail` A → the box IP (**DNS-only** if Cloudflare — the orange cloud breaks
both SMTP and ACME), `MX 10 mail.{domain}`, SPF, DMARC. Then rDNS — outbound
IP must reverse-resolve to the MX hostname (Linode:
`linode-cli networking ip-update <ip> --rdns mail.{domain}`) — and verify
outbound port 25 isn't blocked by the host
(`ssh root@box 'bash -c "exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25 && head -1 <&3"'`).

```sh
# 1. Provision (root): swap, docker, git, the virtu app user (uid 1000).
ssh root@box 'bash -s' < bin/host-provision

# 2. Clone as virtu, then write the two env files (both gitignored):
ssh root@box 'runuser -u virtu -- git clone https://github.com/zinc-email/virtu.git /opt/virtu'
#    /opt/virtu/.env          — compose interpolation: VIRTU_HOST=each.email,
#                               VIRTU_TLS_MODE=<acme account email>, and the
#                               five *_PUBLISH vars bound to 0.0.0.0
#                               (80/443/25/587/465).
#    /opt/virtu/server/.env   — MAIL_DOMAIN, MAIL_HOSTNAME, a real VERP_SECRET,
#                               SMTP_TLS_CERT_FILE=/mail-certs/fullchain.pem,
#                               SMTP_TLS_KEY_FILE=/mail-certs/privkey.pem.
#                               See server/.env.example.

# 3. Deploy (as virtu, from /opt/virtu) — build, up, schema push, cert sync:
bin/host-deploy

# 4. Once per domain: mint the DKIM key and publish the TXT it prints:
bin/dkim-ensure
```

Redeploys are step 3 alone. `bin/host-deploy` is idempotent: pull, rebuild,
`up -d`, `drizzle-kit push`, cert sync.

## License

[AGPL-3.0](./LICENSE). Network use counts as distribution: run a modified
version as a service and you must offer users its source.
