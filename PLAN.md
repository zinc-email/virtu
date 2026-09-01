# virtu-ts — Rewrite Plan & Work Breakdown

An email alias/proxy service (create a unique address per sign-up, revoke when leaked or
abused), rewritten from the legacy PHP/postfix stack to Bun + TypeScript. Open source.

Reference material (read-only, in `tmp/`):

- `tmp/virtu` — legacy system. Best docs: `server/docs/FILTERS.md` (rewrite spec),
  `server/docs/NETWORK.md` (test-domain semantics), `server/docker/test/` (simulated internet).
- `tmp/madi` — the server/client architecture template we copy (fastify + zod-openapi →
  committed spec → Kubb SDK → react-query).
- `tmp/simple-login/app` — API compatibility target (`docs/api.md`) and email-handling
  correctness source (`email_handler.py`, `app/email_utils.py`).
- `tmp/RFCs` — ABNF for message format (5322/2045/2046/6532).

Guiding principle: **simple, durable forms**. No postfix, no dovecot, no milters, no
Redis, no ORM magic. One Postgres database, one server package with several small
entrypoints, one library (`mailauth`) for all email authentication — verify and
sign — and a plain table for the queue.

---

## Architecture at a glance

One `server/` package, four entrypoints (madi runs api + worker from one package the
same way):

| Process | Entry | Role |
|---|---|---|
| `mx` | `src/mx.ts` | Port 25. Inbound SMTP. Milter checks → pre-queue policy → rewrite → sign → enqueue |
| `submission` | `src/submission.ts` | 587 (STARTTLS required) + 465 (implicit TLS). AUTH → policy → rewrite → sign → enqueue |
| `deliverd` | `src/deliverd.ts` | Drains the Postgres queue. MX lookup, SMTP client delivery, retries, bounce generation |
| `api` | `src/api.ts` | Fastify. SimpleLogin-compatible API + OpenAPI spec emission |

Everything shares `src/db/schema.ts` (Drizzle, Postgres, snake_case) and `src/config.ts`.

### The type-safety spine (the core structural bet)

One definition per fact, flowing outward — no type or schema hand-maintained on
both sides of a boundary. The whole server/client structure exists to serve this:

```
db/schema.ts (Drizzle tables)
  → drizzle-zod derives insert/select Zod shapes
  → route Zod schemas reuse those column shapes   (routes/schema.ts:
      createSelectSchema(users), e.g. userSelect.shape.email)
  → fastify-zod-openapi emits OpenAPI 3.1 from those exact schemas
  → committed server/spec/openapi.json
  → Kubb generates the typed client SDK + react-query hooks
  → the React app consumes them
```

A column rename in `db/schema.ts` ripples, **at compile time**, to a red
squiggle in the client — the contract cannot silently drift. Rules that keep the
spine intact:

- Where an API field mirrors a DB column, derive it from the drizzle-zod schema,
  don't re-type it (`routes/schema.ts`).
- The spec is generated, never hand-edited; the SDK is generated, never
  hand-edited. Regenerate downstream after any schema/route change (`just gen`).
- SimpleLogin wire-compat lives at exactly one seam — the route Zod schemas
  (snake_case field names from `serializer.py`). Inward of that seam everything
  is our own camelCase types; outward, everything is generated from those schemas.

Mail flow (inbound): accept DATA → `mailauth.authenticate()` (SPF/DKIM/DMARC/ARC
verify, in-process) → policy
(alias exists? enabled? user active? not abuse-flagged? spam score ok?) → **reject
before queue** on failure → header rewrite (forward rules) → DKIM sign as us →
insert into queue. Outbound (submission) mirrors it: AUTH + account standing →
reverse-alias resolution → header rewrite (reply rules) → sign with alias domain →
queue. The queue is the only writer of "sent" state.

Bounce addresses use SimpleLogin's VERP scheme (see Lane C) — every outbound message
gets a unique signed return path, so bounces route straight to the originating
email-log row with no scanning.

## Repo layout (madi conventions)

```
justfile             # one-liner recipes delegating to bin/
bin/                 # compose wrapper, check, gen, test-int, db-*
biome.json           # formatter only; eslint per-package
lefthook.yml
docker-compose.yml   # dev stack
docker-compose.test.yml  # simulated-internet overlay (dns, fake peers)
server/              # own package.json; entrypoints above
  spec/openapi.json  # committed contract, generated in-process
  docker/            # test-network images: dns (bind), fake peer smtpd
client/              # React SPA; Kubb output in src/gen (gitignored)
www/                 # static homepage
docs/                # RFCs/decisions as we go
```

No Bun workspaces (madi deliberately avoids them): each of `server/`, `client/`,
`www/` owns its own `package.json` and lockfile; root holds only biome + lefthook.

---

## Workstreams

Nine lanes. Lane 0 is the serial foundation; A–I run in parallel after it. Each lane
lists its contract (what others depend on) so integration is a wiring exercise.

### Lane 0 — Scaffold + schema (serial, do first)

Copy madi's skeleton: justfile/bin scripts, biome, lefthook, CI, compose dev stack
(`db` postgres:17, `caddy`, `api`, `client`), fastify + `fastify-zod-openapi` +
`@fastify/swagger` boilerplate with the spec-emission script
(`tmp/madi/server/src/app/openapi.ts` is worth copying nearly wholesale, minus the
internal-spec half), Drizzle setup, rsbuild + Kubb client shell.

Then the **schema v1**, shaped by SimpleLogin's models (`tmp/simple-login/app/app/models.py`)
but trimmed: `users`, `api_keys`, `aliases`, `mailboxes`, `contacts` (reverse aliases),
`custom_domains`, `email_logs`, `outbound_messages` (the queue), `subscriptions`,
`notifications`, `sent_alerts`, `deleted_aliases` (tombstones), `dkim_keys`.

**Contract:** `server/src/db/schema.ts` — the coordination point for every lane.
Changes to it go through review; everything else is additive.

### Lane A — SMTP protocol library (`server/src/smtp/`)

Pure library, no DB. RFC 5321 server state machine on `Bun.listen`: EHLO, STARTTLS,
implicit TLS, AUTH PLAIN/LOGIN, PIPELINING, SIZE, 8BITMIME, SMTPUTF8, and a streaming
DATA reader (dot-unstuffing, size cap). Plus an SMTP **client** (used by deliverd and
the test harness): MX connect, STARTTLS-opportunistic, EHLO capability parse.

Hook-style interface so mx/submission stay thin:

```ts
createSmtpServer({ onConnect, onEhlo, onAuth, onMailFrom, onRcptTo, onData })
// each hook returns { accept } | { reject: { code, enhanced, message } }
```

No MIME parsing here — DATA is bytes plus a parsed header block (Lane C owns headers).
The legacy PHP `src/lib/Email/Smtp/` is a working reference for edge cases.

**Contract:** the hook interface + client interface. Unit-testable with loopback
sockets; no docker needed.

### Lane B — Email authentication (`server/src/mailauth/`)

No milters (decided 2026-08-08 — see Decisions). All inbound verification is
in-process via `mailauth`: one `authenticate()` call covers SPF + DKIM + DMARC +
ARC and returns ready-to-prepend `Received-SPF`/`Authentication-Results` headers
plus the ARC context (`arc.authResults`, chain status) in exactly the shape Lane
C's sealer consumes. This lane owns:

- **The Bun spike, day one:** confirm mailauth runs on Bun (pure JS + node:crypto,
  so it should). This is the plan's only load-bearing compatibility bet.
- **DNS resolver plumbing:** pass a custom `resolver` wired to the container's
  configured nameserver so the simulated-internet BIND answers SPF/DKIM/DMARC
  lookups in dev/test unchanged.
- **Policy mapping:** translate results into pre-queue verdicts — DMARC
  `p=reject`/`quarantine` handling (crib SimpleLogin's `app/handler/dmarc.py` and
  its E215/E216 status codes), SPF-fail treatment, and which failures reject vs.
  annotate. Keep enforcement conservative and configurable; over-rejection is how
  forwarders lose mail.

Legacy note for posterity: virtu never actually ran glts dkim-milter — it used
OpenDKIM 2.11-beta built from source (its weakest piece). glts spf-milter remains
the documented fallback if mailauth's SPF proves weak in practice.

**Contract:** `verifyInbound(session, rawMessage) → { verdict, prependHeaders,
arcContext }`. Pure-ish (network = DNS only); integration-tested against the fake
BIND + peer MTAs from Lane H.

### Lane C — Routing & rewrite engine (`server/src/mail/`)

The heart. Pure functions over `{ headers, rawBody }` — header-only rewriting, no
full MIME (rfc5322 ABNF in `tmp/RFCs`). Spec sources: `tmp/virtu/server/docs/FILTERS.md`
and SimpleLogin's `email_handler.py` (its 30-line top docstring is the envelope
contract).

- **Forward path:** alias → mailbox. Header **whitelist** (SimpleLogin keeps only
  From/To/Cc/Subject/Date/Message-ID/References/In-Reply-To/List-* + MIME headers,
  drops the rest); From → reverse alias; To/Cc mapped to reverse aliases with
  auto-created contacts so reply-all works; `X-Virtu-*` provenance headers.
- **Reply path:** reverse alias → real recipient. Refuse to send if any To/Cc entry
  is not a known reverse alias (SimpleLogin's `NonReverseAliasInReplyPhase` — it
  refuses to leak). Message-ID translation table so threading survives.
- **VERP:** copy SimpleLogin's format verbatim
  (`app/email_utils.py:1665`): localpart =
  `{prefix}.{base32(json([type, id, minutes]))}.{base32(hmac[:8])}`, types
  `bounce_forward | bounce_reply | transactional`, 5-day validity, ≥32-char secret.
  VERP domain chosen for SPF alignment; keep virtu's `zbounces.{domain}` CNAME →
  central SPF include trick for custom domains.
- **Bounce handling:** parse VERP on inbound, mark the email-log bounced, apply
  SimpleLogin's auto-disable thresholds (`should_disable`: >12/day, or >10/week with
  repeat, or 9-of-10 distinct days), notify with rate-limited alerts
  (`sent_alerts` de-dupe — copy this, it stops bounce storms becoming alert storms).
- **Disabled alias behavior:** default accept-and-drop (250) so the alias's
  existence isn't probed; optional 550 per user setting. SimpleLogin's exact codes.
- **DKIM + ARC signing (in-process, via `mailauth`):** sign forwards with our
  domain, replies with the alias domain when its key is verified. Relaxed/relaxed,
  rsa-sha256 (ed25519 optional), keys from the `dkim_keys` table. Per-forward flow
  is exactly what mailauth documents for forwarders: `authenticate(original)` →
  capture `arc.authResults` + `arc.status.result` → rewrite headers →
  `dkimSign()` + `sealMessage()` with the captured results. SimpleLogin's
  header-set fallback chain (`[Message-ID,Date,Subject,From,To] → [From,To] → …`)
  is worth copying for hostile real-world messages. The legacy PHP
  signer/sealer/validator (`tmp/virtu/server/src/lib/Email/`) stays as reference
  if mailauth falls short. (Bun-compat spike lives in Lane B.)

**Contract:** `rewriteForward(msg, ctx)` / `rewriteReply(msg, ctx)` /
`buildVerp()`/`parseVerp()` — pure, exhaustively unit-testable without docker.

### Lane D — Delivery queue + deliverd (`server/src/queue/`, `src/deliverd.ts`)

Boring on purpose. `outbound_messages` table: raw bytes (bytea, size-capped),
envelope from/to, `status`, `tries`, `next_attempt_at`, `last_error`. Worker loop:
`SELECT … FOR UPDATE SKIP LOCKED`, exponential backoff, permanent-failure
classification (5xx vs 4xx), DSN generation on final failure (simple single-part
DSN, addressed via the VERP rules — and never bounce a bounce: null reverse path
mail gets no DSN). MX resolution must honor the container's configured DNS so the
simulated internet works unchanged.

**Contract:** `enqueue(message) → id` + queue row shape. Depends on Lane A's client
interface (stub it until A lands).

### Lane E — API server, SimpleLogin-compatible (`server/src/routes/`)

Implement the inventory in `tmp/simple-login/app/docs/api.md` (1111 lines of
request/response JSON — the compatibility spec). Preserve the quirks exactly:
`Authentication: <key>` header (not `Authorization`), `{"error": "…"}` envelope,
`440` for sudo-required, dual `creation_date`/`creation_timestamp` fields, the
current endpoint versions (v2 aliases, v3 custom/new, v5 alias options) plus the
v1s clients still call. Copy field names from `app/api/serializer.py` verbatim.
Per-endpoint rate limits via `@fastify/rate-limit` matching SimpleLogin's numbers.

Madi patterns: routes as `app.route({ schema: { … zod … } })`, encapsulated authed
child contexts, hooks that throw `HttpError`, contract tests enumerating registered
routes. Emit `spec/openapi.json` in-process and commit it.

**Contract:** the committed `spec/openapi.json`. Land auth + aliases first so Lane F
has a real spec early.

### Lane F — Client (`client/`)

rsbuild + React 19 + TanStack Router/Query + Panda CSS + Kubb
(`pluginOas/pluginTs/pluginReactQuery/pluginMsw`) — copy madi's `kubb.config.ts` and
`src/api/client.ts` axios adapter. **MSW handlers are the unblock:** as soon as
Lane E commits a spec, the client builds against generated mocks without a running
server. Port virtu's look: dark theme tokens
(`tmp/virtu/server/src/styles/variables.scss` — `#19191c` bg, `#fcbc17` CTA,
Fira Sans, single centered column, 58rem max) as Panda CSS tokens + a small
in-repo component kit (`client/src/ui.tsx`); no UI component framework.

**Contract:** consumes `spec/openapi.json`; no one depends on F.

### Lane G — Homepage (`www/`)

Static compile of the legacy `views/hello/*` content (hello/how/why/pricing/faq/
terms/privacy — nine pages) with the same design tokens and single-column layout.
Recommendation: Astro (static-first, zero client JS by default, boring). Output is
plain files served by caddy.

**Contract:** none. Fully independent.

### Lane H — Simulated internet + story tests (`server/docker/test/`, `server/test/`)

Port virtu's test network nearly as-is (it's language-agnostic):

- BIND with the zone set from `tmp/virtu/server/docker/test/dns/` — domains keep
  their meanings (`qmail.com` = pretend Gmail, `initech.com` = DMARC p=reject
  correspondent, `open.relay` = spammer origin, `user.com` = dynamically-updatable
  custom domain, `void.com` = blackhole). Two networks (internal + "pretend"
  internet), every container pointed at the fake DNS, mkcert CA baked in.
- Fake peer MTAs from `tmp/virtu/server/docker/test/smtpd/` (postfix + opendkim +
  opendmarc + policyd-spf), **changed to deliver into Maildir instead of mbox** —
  one file per message makes parallel tests trivial.
- **Personas** (TS helpers, same cast): Wes (paying user, custom domain `user.com`),
  Milton (legit outside correspondent at initech), Alec (billing-path user),
  Bart (abuse-flagged), Spammer (open relay).
- **Test-ID addressing instead of inbox resets:** every test stamps
  `X-Virtu-Test-Id: {ulid}` on what it sends; `waitForMail(persona, testId)` polls
  the persona's Maildir for a file containing that id. No truncation, no ordering
  constraints — tests run in any order, in parallel, against a shared dirty state.
  DB fixtures are find-or-create with per-test unique aliases.

**Contract:** persona helpers + `waitForMail` + compose overlay. Every other lane's
integration tests build on this, so start it day one.

### Lane I — Billing (`server/src/billing/`)

Stripe only, fully offloaded: Checkout for subscribe, Customer Portal for manage,
one webhook endpoint (`checkout.session.completed`,
`customer.subscription.updated/deleted`) upserting the `subscriptions` table.
The app reads a single `isPremium(user)` predicate (SimpleLogin's
`get_active_subscription()`-funnel pattern, minus the four extra providers).
No prices, invoices, or payment state in our DB.

**Contract:** `subscriptions` rows + `isPremium()`. Small; pairs well with Lane E.

---

### Lane J — Observability & queue hygiene (`server/src/{log.ts,metrics/}`, `alloy/`)

Visibility into maild (decision #15). Structured JSON logs from a thin
first-party logger (`log.ts` — component/event/fields, `LOG_FORMAT=pretty`
for humans; the test network sets it so `just test-net-logs` stays readable);
the API keeps Fastify's pino. First-party Prometheus registry
(`metrics/registry.ts` — counters/gauges-with-collect/histograms + text
exposition; provider buckets in `metrics/provider.ts` keep label cardinality
bounded). Exposition: api at `GET /meta/metrics`, maild on an unpublished
`METRICS_HOST:METRICS_PORT` listener (`metrics/httpServer.ts`) that doubles
as its liveness probe (listeners up + queue-worker heartbeat). A Grafana
Alloy container (compose profile `observe`, `alloy/config.alloy`) scrapes
both and tails container logs, remote-writing to Grafana Cloud.

Queue hygiene, same lane: `claimed_at` lease on `outbound_messages` + a
reaper returning stale `sending` rows to `pending` (worker terminal writes
are status-guarded, so a reaped/dropped row can't be stomped — at-least-once
delivery); retention (raw cleared on the `sent` terminal write; sent rows
deleted after `QUEUE_RETAIN_SENT_DAYS`, failed after
`QUEUE_RETAIN_FAILED_DAYS`), both piggybacking time-gated on the worker
loop; retry horizon extended to RFC-customary ~4 days
(`QUEUE_MAX_TRIES=25`, `QUEUE_BACKOFF_MAX_MS=6h` — the test network pins
fast values); operator primitives `dropMessages`/`requeueMessages`
(`queue/admin.ts`) — the ONLY sanctioned queue writers besides enqueue and
the worker, shared by the admin API and the `bin/queue-*` CLI.

**Contract:** the `virtu_*` metric names; `Logger`/`createLogger`;
`queue/admin.ts` primitives; the `observe` compose profile.

### Lane K — Admin & abuse (`server/src/routes/admin/`, `client/src/pages/Admin*`)

Operator surface + the abuse/reputation program. The threat model,
industry-practice catalog, and implementation ranking (including the
invite-only signup gate) live in **`ABUSE.md`** — it names which Lane K
phase each practice lands in. Admin = the `users.flags`
admin bit (`auth/userFlags.ts`) + a `requireAdmin` hook on a nested
`/api/admin` scope inside the authed context (decision #16) — same spec,
same Kubb SDK, tagged `Admin` (escape hatch if the public spec must ever be
SL-clean: split by tag at emission in `openapiEmit.ts`, madi's two-spec
shape). First admin is minted by `bin/admin-grant` (direct DB,
break-glass); `bin/queue-{list,stats,drop,requeue}` mirror the API's queue
primitives so CLI and API can never diverge. Privacy stance: admins see
envelope + an allowlisted routing-header set
(`routes/admin/headerAllowlist.ts`), never Subject or body, no raw
download. Destructive admin ops gate behind sudo from P2
(`routes/sudoGuard.ts` seam is in place).

Phases: **P1** (landed) admin bit + queue inspect/drop/requeue/delete/bounce
+ overview + first admin pages + `is_admin` on user_info. The operator
bounce (`pipeline/operatorBounce.ts`) sends the standard failure DSN via the
shared `pipeline/dsnDelivery.ts` (also deliverd's DSN path) and then
terminal-marks the row — WITHOUT recordBounce: an operator decision is not a
mailbox-health signal, so it never advances the auto-disable ledger. Delete
is terminal-rows-only (drop or bounce first), ahead of retention. **P2** queue attribution
columns (`outbound_messages.user_id`/`email_log_id` — needs a decision:
durable ownership beyond VERP's 5-day window), per-user outbound send
quotas at submission pre-enqueue (closes the compromised-SMTP-cred hole),
an `smtp_rejections` table (RCPT/DATA rejects currently write nothing),
notifications routes + bell UI, admin user views with sudo-gated
disable/enable. **P3** per-IP mx throttling (authThrottle-shaped, fed by
smtp_rejections), spam hook wiring per decision #4 — in-process cheap
checks first (DNSBL via the wire-format TXT client, rDNS/HELO sanity)
writing the never-yet-written `email_logs.isSpam/spamScore/spamStatus`;
rspamd deferred until a bigger box (200–400MB against a 1GB nanode). No
greylisting (latency for weak returns). **P4** `domain_delivery_stats`
daily aggregates tapped from `classifySendResult`, DMARC rua ingestion (we
run the MX — point `rua=` at ourselves and parse our own reports in a
contained ingest worker), Google Postmaster Tools pull, admin abuse views
(top bouncing aliases, threshold-disabled list, per-domain deliverability);
automated reputation responses (per-domain slow-start) are their own
decision when they come up.

**Contract:** `requireAdmin` + the `/api/admin/*` spec paths; `USER_FLAGS`
registry in `auth/userFlags.ts`; the header allowlist.

---

## Sequencing

```
Week 0:   Lane 0 (scaffold + schema)          ── serial
Then:     A  B  C  D  E  F  G  H  I           ── all parallel
              │  │  │  │
Milestone 1:  A+B+C wired into mx.ts  ────────── "Milton → Wes forward" story passes
Milestone 2:  + submission + deliverd ────────── "Wes replies via alias, DKIM passes
                                                  at initech" story passes
Milestone 3:  bounce loop (C+D)  ─────────────── "bounce auto-disables alias" story
Milestone 4:  E+F+I ─────────────────────────── dashboard manages aliases end-to-end
```

Dependency notes: D stubs A's client until A lands. E and F overlap via the
committed spec + MSW. H blocks nobody but unblocks everyone's integration tests —
prioritize it alongside Lane 0.

## Decisions

Settled (2026-08-08):

1. **Signing is in-process** (Lane C), keys in Postgres. Primary implementation:
   `mailauth` (`dkimSign` + `sealMessage`); legacy PHP signer/sealer as reference
   or port-source if it falls short.
2. **Both DKIM and ARC are signed** on forwarded mail — ARC is in scope, not
   deferred.
3. **VERP scheme** as specced in Lane C (SimpleLogin format, no SRS).
4. **Spam check** is a pluggable pre-queue hook, initially wired to nothing.
5. **Homepage** uses Astro (Lane G).
6. **This file is the design doc**; decisions get recorded here as they're made.
7. **Mobile: native thin shells, never react-native** (2026-08-08). iOS/Android
   apps (post-MVP) are small Swift/Kotlin shells hosting the production React
   client in a WKWebView / Android WebView, plus native-only capabilities where
   they earn their place: a share/action extension ("new alias for this site"
   from the browser share sheet — also the App Store guideline 4.2 answer),
   push notifications, Keychain/Keystore for the API key. JS↔native bridge is a
   small enumerable message protocol, not a generic eval channel. Precedent:
   HEY (an email product) ships this architecture; expo/react-native/RNW is
   rejected from experience (upgrade treadmill, RNW jank). Implication for
   Lane F **now**: the client stays webview-friendly — safe-area CSS, `100dvh`,
   touch targets, no hover-only affordances, and a platform seam for
   shell detection. Execution plan: **`plans/mobile.md`** (2026-08-12) —
   verified store-policy findings, the enumerable bridge vocabulary, autofill
   strategy per platform, and the parallel workstream map.
8. **No milters.** All verification is in-process via `mailauth.authenticate()`
   (SPF/DKIM/DMARC/ARC in one call, custom DNS resolver, results in the shape the
   ARC sealer consumes). Drops the milter protocol client and both milter
   containers; the verify → rewrite → sign/seal chain lives in one process. Lane B
   is repurposed as the mailauth integration lane. Fallback if mailauth's SPF
   proves weak in practice: glts spf-milter (`tmp/virtu/server/docker/spf/`).
9. **SMTP outbound modes are chosen by MAIL FROM** (2026-08-10). Submission
   supports two sending modes: MAIL FROM = one of the user's **aliases** is
   "send mode" — recipients that are reverse aliases translate back to their
   contact (reply), any other recipient is a **cold email** (contact minted for
   (alias, recipient) so the reply threads back; To/Cc entries that aren't
   reverse aliases pass through verbatim). MAIL FROM = one of the user's
   **mailboxes** is strict "reply mode" — what a stock MUA does — every
   recipient must be a reverse alias and all must belong to one alias; the
   contact rows are the metadata that picks the outbound alias. The
   refuse-to-leak invariant holds in both modes: a To/Cc entry naming one of
   the user's own mailboxes is refused (550), never sent.
10. **Per-device SMTP passwords** (2026-08-10). `smtp_credentials` rows are
    app-style passwords (generated server-side, shown once, argon2id-hashed),
    one per device, revocable independently of each other. Accounts have no
    password (decision #13), so device credentials are the ONLY thing SMTP
    AUTH accepts; device use stamps `last_used_at`. API: GET/POST/DELETE
    `/smtp/credentials` (a Virtu extension — SimpleLogin has no SMTP
    submission).
11. **Trash inbox** (2026-08-10). A user may designate one verified mailbox as
    the account's trash inbox (`users.trash_mailbox_id`, set via
    PUT /mailboxes/:id `{trash}`). Mail for a disabled ("off") alias is then
    forwarded there — stamped `X-Virtu-Trash: YES (alias disabled)` — instead
    of accept-and-dropped; with no trash mailbox the default accept-and-drop
    stands. Either way the sender sees 250: existence is never probed. Trash
    copies are enqueued with the NULL reverse path — an off alias must not
    start emitting DSNs or bounce accounting that accept-and-drop never
    produced; a broken trash mailbox fails silently in the queue log.
12. **Multi-mailbox delivery** (2026-08-10). An alias delivers one copy per
    associated mailbox (primary + `alias_mailboxes` extras, unhealthy ones
    skipped), each copy with its own email_log and VERP so bounce accounting
    stays per-mailbox. A broken primary no longer drops mail that a healthy
    extra mailbox can receive.
13. **Passwordless single-entrypoint auth** (2026-08-10). Login and signup
    are ONE flow, re-adopting legacy virtu (and Zinc-from-day-one): a single
    email field; `POST /auth/login {email}` creates a *provisional* user
    (`users.activated = false` — the modern form of legacy's accountId-NULL
    row) when the address is unknown and emails a 6-digit code either way
    (uniform response — registration status is never revealed);
    `POST /auth/verify {email, code}` graduates a provisional user
    (activated, trial started, self-mailbox created) and mints the api key.
    No `password_hash` column exists. Unlike legacy, codes keep the modern
    hardening: sha256-stored, 15-min TTL, dead after 3 wrong tries, sends
    budgeted 3/hour/address behind the per-IP limit. Sudo re-auth
    (`PATCH /sudo`) is the same code machinery (purpose `sudo`, two-step on
    one endpoint), and a verify-minted key starts inside the sudo window — a
    code round-trip is our strongest re-auth. This deliberately breaks
    SimpleLogin wire-compat on the auth surface only (third-party SL apps
    can't do an OTP round-trip anyway); everything behind the
    `Authentication` header stays SL-shaped. The www homepage CTA submits its
    email field to `/app/login?email=…`, which auto-requests the code — the
    old "redirects into a create-user flow unconditionally" seam is gone.

14. **Custom domains are winner-take-all via a generated `name` column**
    (2026-08-11). The `domains` table (renamed from `custom_domains`) stores
    the claimed FQDN as `name_requested` (unique only per user) and derives
    `name` as a STORED generated column (`CASE WHEN verified_owner THEN
    name_requested END`) with `UNIQUE(name)`. Provisional claims on the same
    name coexist; the unique index lets exactly one account own it — the one
    that proves DNS control via the per-row ownership TXT token (unraceable).
    Two capabilities, `canReceive` (owner+mx) and `canSend` (owner+dkim+spf),
    are pure functions in `pipeline/domainCapability.ts` (not columns), reused
    by the mail path and surfaced as `can_receive`/`can_send` API fields; the
    DNS re-check writes only the base `verified_*` flags and everything else
    derives. Internal rename only — the SimpleLogin wire is unchanged.

15. **Observability: structured logs + Prometheus metrics, shipped by Alloy
    to Grafana Cloud; Postgres remains the only database on the box**
    (2026-08-14). The mail daemons log JSON lines through a thin first-party
    logger (`server/src/log.ts` — pino-pretty's worker-thread transport is
    the same Bun surface the don't-break list already documents twice); the
    API keeps Fastify's pino. Every process exposes Prometheus text-format
    metrics from a first-party registry (`server/src/metrics/` — prom-client
    rejected: its default collectors lean on perf_hooks Bun doesn't fully
    support) — the API at `/meta/metrics`, maild on an unpublished
    `METRICS_PORT` listener that doubles as its health endpoint. One Grafana
    Alloy container in the serve stack (compose profile `observe`,
    credentials in `/opt/virtu/.env`) scrapes both and tails container logs,
    remote-writing to Grafana Cloud (free tier). No self-hosted
    Prometheus/Grafana/Loki, no TSDB on the box — queue observability
    (depth gauges, `claimed_at` reaper, retention, operator drop/requeue)
    stays in the one Postgres queue table, and the queue remains the only
    writer of "sent". In-app admin dashboards ride Postgres aggregates;
    Grafana owns time series and alerting. See Lane J.

16. **Admin is a `users.flags` bit behind a nested `/api/admin` scope, in
    the one public spec** (2026-08-14). No role column, no second auth
    system: `USER_FLAGS.admin` (bit 0 — the flags bigint never crosses the
    SL wire, so the bits are ours), a `requireAdmin` onRequest hook layered
    inside the authed context, and `is_admin` added to `user_info` (additive;
    SL clients ignore unknown fields). Admin routes ride the same committed
    spec + Kubb SDK, tagged `Admin` — the two-spec split (madi's shape)
    stays available by tag-filtering at emission if the public spec must
    ever be SL-clean. First admin is minted by `bin/admin-grant`, direct DB
    (no admin exists to call an API). The API answers a 403 (the routes are
    in the committed public spec — nothing to hide server-side), but the
    SPA renders that 403 as the same not-found page any bogus URL gets
    (`pages/NotFound.tsx`, also the router's defaultNotFoundComponent) —
    the browser surface never advertises an operator area. Privacy:
    operators see envelope + allowlisted routing headers, never Subject or
    body — the raw bytea is users' mail. Sudo-gating of destructive admin
    ops is deferred to Lane K P2 with the `sudoGuard.ts` seam extracted
    now. See Lane K.

Open: none.
