# STATE — progress against PLAN.md

Last updated: 2026-08-08, end of wave 3. Companion to `PLAN.md` (the design
doc); this file tracks what is built, how it was verified, and what remains.

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
| Unit | ~350 tests / 25 files | `just test-unit` | green |
| CI gauntlet | format + 2× tsc + SDK gen + unit | `just check` | green |
| Integration (API vs real Postgres) | 106 tests / 7 files | `just up && just db push && just test-int` | green ×2 consecutive |
| Stories (simulated internet) | 13 stories / 9 files | `just test-net-up && just test-story` | green ×2 against dirty state |
| Live Stripe (test mode) | manual + watcher | see README billing section | verified 2026-08-08 |

Story coverage: forward with `dkim=pass` at the receiving peer (M1), authed
reply with threading and zero real-address leakage (M2), bounce → auto-disable
at threshold (M3), DSN delivery + rate-limit suppression, custom-domain
forward AND custom-domain DKIM (`dkim=pass header.d=user.com` at initech),
transactional activation email delivered through our own queue, policy edges
(nonexistent alias 550, disabled alias accept-and-drop, relay denied),
network smoke (peers verify SPF/DKIM/DMARC independently of our server).

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
| F — Client | ~70% | Login, aliases (create/pin/toggle/multi-mailbox), contacts, settings, billing pages. Missing: register/activation UI, custom-domain UI, mailboxes page, notifications, activities view |
| G — Homepage | ✅ done | 7 static Astro pages, verbatim legacy copy/tokens, zero client JS. Assumes SPA mounts at `/app` behind the reverse proxy |
| H — Simulated internet | ✅ done | Subnets 192.168.34/43 (legacy stack owned 33/42; legacy now stopped — renumbering back is optional). Maildir + X-Virtu-Test-Id; no resets, parallel-safe |
| I — Billing | ✅ done | SDK-free Stripe; live-verified checkout → webhook → premium flip; keys in gitignored `server/.env` |

Milestones M1–M4 (PLAN sequencing diagram): all reached.

## Explicitly stubbed / known gaps (roughly priority-ordered)

1. **Client register + activation flow** — register API requires an emailed
   6-digit code; the client has no UI for it (terminal workaround in README
   territory). Biggest UX gap.
2. **Transactional bounce intake** — a bounced activation email only logs;
   the VERP id doesn't resolve to the verification_codes row. (Cross-branch
   timing artifact; small.)
3. **Custom-domain catch-all / automatic alias creation** — `catch_all`
   column exists, behavior not implemented.
4. **Reverse aliases always mint on the service domain** — SimpleLogin's
   `use_as_reverse_alias` per-domain option not implemented.
5. **Per-user disabled-alias behavior** — accept-and-drop is the only mode;
   SimpleLogin's `block_behaviour` 550 option not wired.
6. **No `Received:` header prepended at the mx** — minor RFC nicety.
7. **Spam-check hook** — pluggable pre-queue slot deliberately unwired
   (PLAN decision #4). Candidates: spamd/SPAMC or rspamd.
8. **API deferred endpoints** — list in Lane E row above; also GET-with-body
   alias search, multi-window rate limits collapsed to single-window,
   150-word wordlist, mailbox email-change returns 400.
9. **PGP** — fields accepted/serialized as unsupported (`support_pgp:false`).

## Not started

- **Production/deploy story** — prod compose, Dockerfile targets, caddy
  (serve `www/` at `/`, SPA at `/app`, API at `/api`, mail ports 25/465/587),
  real TLS (certs for MX + web), outbound deliverability setup (rDNS, SPF
  record, DKIM key publication, DMARC), backups, host provisioning docs.
- **LICENSE file** — PLAN says open-source; no license chosen/committed yet.
- **Mobile shells** — post-MVP by decision #7 (native Swift/Kotlin over the
  web client; share-extension is the flagship feature + App Store 4.2 answer).
- **README completeness** — quickstart exists; local-testing guide and
  architecture overview not yet written in.

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
