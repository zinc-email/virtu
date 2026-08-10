# STATE — progress against PLAN.md

Last updated: 2026-08-09 (custom domains: full UI, API-driven DNS
verification story, catch-all minting in the mail pipeline). Companion to
`PLAN.md` (the design doc); this file tracks what is built, how it was
verified, and what remains.

## TL;DR

All nine PLAN lanes are implemented and merged. The MVP loop is closed and
verified end to end: mail proxies through the full
verify → rewrite → sign/seal → queue → deliver pipeline inside the simulated
internet; the SimpleLogin-compatible API drives a working dashboard; billing
is live-verified against real (test-mode) Stripe. What remains is polish
(client gaps, deferred endpoints), a handful of explicitly-stubbed behaviors,
and the entire production/deploy story, which has not been started.

## Verification status

| Tier | Count | Command | Last state |
|---|---|---|---|
| Unit | ~393 tests / 27 files | `just test-unit` | green |
| CI gauntlet | format + 2× tsc + SDK gen + unit | `just check` | green |
| Integration (API vs real Postgres) | 106 tests / 7 files | `just up && just db push && just test-int` | green ×2 consecutive |
| Client DOM (real React vs running stack) | 5 tests / 2 files | `just up && just db push && just test-client` | green |
| Stories (simulated internet) | 14 stories / 10 files | `just test-net-up && just test-story` | green ×2 against dirty state |
| Live Stripe (test mode) | manual + watcher | see README billing section | verified 2026-08-08 |

Story coverage: forward with `dkim=pass` at the receiving peer (M1), authed
reply with threading and zero real-address leakage (M2), bounce → auto-disable
at threshold (M3), DSN delivery + rate-limit suppression, custom-domain
forward AND custom-domain DKIM (`dkim=pass header.d=user.com` at initech),
transactional activation email delivered through our own queue, policy edges
(nonexistent alias 550, disabled alias accept-and-drop, relay denied),
network smoke (peers verify SPF/DKIM/DMARC independently of our server),
and the custom-domain API lifecycle (create → publish the exact GET .../dns
records via nsupdate → verify all five checks green → catch-all mints an
alias through the real pipeline → tombstones stay dead).

The live Stripe pass caught a real bug the self-signed tests missed
(out-of-order `subscription.created` regressing status — fixed in `fdf36a2`
with a regression test encoding the observed sequence).

## Lane-by-lane

| Lane | Status | Notes |
|---|---|---|
| 0 — Scaffold + schema | ✅ done | Contract pipeline (fastify-zod-openapi → committed spec → Kubb) proven; schema at v1 + wave-3 additions |
| A — SMTP library | ✅ done | 101 loopback tests, zero deps. One workaround: server-side STARTTLS via loopback bridge until Bun ships oven-sh/bun#34598 (merged upstream 2026-07-25, unreleased) |
| B — Email auth (mailauth) | ✅ done | All verification in-process; table-driven verdicts; glts spf-milter documented as fallback, unused |
| C — Rewrite core | ✅ done | VERP byte-compatible with SimpleLogin (CPython golden vector) + constant-time compare + real expiry; forward/reply whitelists; refuse-to-leak on replies |
| D — Queue + deliverd | ✅ done* | SKIP LOCKED worker, backoff, RFC 3464 DSNs (null reverse path, rate-limited). *Gap: bounces OF transactional mail are log-only |
| E — API (SimpleLogin-compat) | ~85% | 25+ spec paths incl. custom domains + billing extras. Deferred: MFA, forgot_password, PATCH user_info, DELETE /user, cookie_token, notifications, export, apple/phone |
| F — Client | ~80% | Restyled to the legacy virtu design on Panda CSS (semantic tokens in `panda.config.ts`, primitives in `src/ui.tsx`: Button/Field/Select/Switch/KeyValue/EntityList/CopyButton/Logo; root font-size 18px→24px@1200px, everything rem-based). Pages: login, register/activation, alias index (hero + one-click random alias), alias detail (new/used states + activities + contacts/delete), settings (native selects), billing (key/value + Stripe actions), domains index + detail (DNS records to publish, verify with per-check errors, catch-all switch, delete). Mantine is fully removed (banned — see CLAUDE.md): overlays are native `<dialog>` (`src/overlays.tsx`), PinInput/TextArea/CheckboxGroup are ours, color scheme is `src/colorScheme.ts` (`data-color-scheme` on html). Missing: mailboxes page, notifications, search |
| G — Homepage | ✅ done | 7 static Astro pages, verbatim legacy copy/tokens, zero client JS. Served at `/` behind the Caddy proxy; SPA under `/app`, API under `/api` — one origin, same topology dev and prod (dev proxy built; see below) |
| H — Simulated internet | ✅ done | Subnets 192.168.34/43 (legacy stack owned 33/42; legacy now stopped — renumbering back is optional). Maildir + X-Virtu-Test-Id; no resets, parallel-safe |
| I — Billing | ✅ done | SDK-free Stripe; live-verified checkout → webhook → premium flip; keys in gitignored `server/.env` |

Milestones M1–M4 (PLAN sequencing diagram): all reached.

## Explicitly stubbed / known gaps (roughly priority-ordered)

1. **Transactional bounce intake** — a bounced activation email only logs;
   the VERP id doesn't resolve to the verification_codes row. (Cross-branch
   timing artifact; small.)
2. **Reverse aliases always mint on the service domain** — SimpleLogin's
   `use_as_reverse_alias` per-domain option not implemented.
3. **Per-user disabled-alias behavior** — accept-and-drop is the only mode;
   SimpleLogin's `block_behaviour` 550 option not wired.
4. **No `Received:` header prepended at the mx** — minor RFC nicety.
5. **Spam-check hook** — pluggable pre-queue slot deliberately unwired
   (PLAN decision #4). Candidates: spamd/SPAMC or rspamd.
6. **API deferred endpoints** — list in Lane E row above; also GET-with-body
   alias search, multi-window rate limits collapsed to single-window,
   150-word wordlist, mailbox email-change returns 400.
7. **PGP** — fields accepted/serialized as unsupported (`support_pgp:false`).

## Not started

- **Production/deploy story** — mail ports 25/465/587 in the serve stack,
  outbound deliverability setup (rDNS, SPF record, DKIM key publication,
  DMARC), backups, host provisioning docs, a deploy trigger. _Web serving is
  built and verified:_ the SPA is served under `/app` (rsbuild base + router
  basepath); a **universal `Caddyfile`** (host + TLS from env, `VIRTU_HOST`)
  serves the built `www/dist` + `client/dist` and proxies `/api`, run by
  `docker-compose.serve.yml` — one config for local prod-like preview, **zinc**
  (prod), and **lmnop** (staging). Verified end-to-end against real builds at
  `https://localhost:8443` (homepage, SPA deep links + hashed assets under
  `/app/static`, `/api`). Dev uses `Caddyfile.dev` (HMR proxy) via `just up`.
  What remains: fold the mail processes into the serve stack, per-box TLS/DNS,
  host provisioning, and the deploy trigger.
  **Secrets management**: `server/.env` is gitignored, so nothing sensitive is
  in git — CI and any deploy must provide the production secrets out-of-band
  (`VERP_SECRET`, TLS cert/key paths, and the Stripe keys if billing is on).
  `server/.env.example` is the checklist of what to inject.
- **Mobile shells** — post-MVP by decision #7 (native Swift/Kotlin over the
  web client; share-extension is the flagship feature + App Store 4.2 answer).

## Upstream workarounds to revisit

1. **Bun server-side STARTTLS** (`server/src/smtp/server.ts`,
   `upgradeServerSocket`): loopback tls.Server bridge until a Bun release
   ships PR #34598 (merged 2026-07-25; latest release 1.3.14 predates it).
   On upgrade: swap to native path, run `bun test server/src/smtp`, delete
   bridge; also pin the `oven/bun` compose image to the host version.
2. **Bun `node:dns` flattens multi-string TXT records**
   (`server/src/pipeline/dnsTxt.ts`): wire-format TCP client used for all
   TXT lookups (DKIM keys span multiple character-strings). Upstream-reportable;
   remove if Bun fixes grouping.
3. **Bun `node:http` WebSocket upgrades hang** (oven-sh/bun#35325: the
   upgrade event fires but bytes written to the handed-off socket are
   silently discarded — verified fixed upstream for 1.4.0, unreleased as of
   1.3.14). rsbuild's HMR socket never completes its handshake under bun
   (diagnosed 2026-08-10 by running the identical server under node, which
   connects instantly). The client dev container is therefore
   `node:26-bookworm-slim` with a one-shot `client-deps` service
   (`oven/bun:1.3`) doing the `bun install` — bun remains the only package
   manager, node is only the dev-server runtime. HMR ws moved under the base
   (`/app/rsbuild-hmr`) so the dev proxy needs no extra route. When a Bun
   release ≥1.4.0 ships: collapse the two services back to one `oven/bun`
   container and re-verify HMR live (workaround #1 lifts on the same
   release).
3. **Stripe account API version is 2018-02-28** — webhook payload shapes are
   version-pinned per account; the handler reads both pre-Basil and current
   `current_period_end` shapes, so upgrading the account's API version later
   is safe but should be followed by a re-run of the live loop.

## Deviations from SimpleLogin (all documented in code at the site)

API keys stored sha256 (login mints a new key; SL returns the stored one) ·
register activates via 6-digit code but SL parity strings/codes kept ·
mailbox verification is a code endpoint (SL: web link) · logout revokes the
API key · ownership token prefix `vt-verification=` · per-domain DKIM TXT
instead of SL's CNAME (we sign with the domain's own key — better alignment) ·
custom-domain DELETE immediate (SL schedules) · `GET /api/billing/*` endpoints
exist beyond SL's surface (SL used Paddle) · default list sort matches SL
pinned-then-activity.

## Where things live

- Design doc + settled decisions: `PLAN.md`
- Mail pipeline: `server/src/{smtp,mailauth,mail,pipeline,queue}/`,
  entrypoints `server/src/{mx,submission,deliverd,maild,api}.ts`
- API + spec: `server/src/routes/`, committed `server/spec/openapi.json`
- Simulated internet: `docker-compose.test.yml`, `server/docker/test/`,
  harness + stories in `server/test/`
- Client: `client/src/` (SDK regenerated from spec, gitignored)
- Homepage: `www/`
