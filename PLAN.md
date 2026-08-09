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

rsbuild + React 19 + TanStack Router/Query + Mantine + Kubb
(`pluginOas/pluginTs/pluginReactQuery/pluginMsw`) — copy madi's `kubb.config.ts` and
`src/api/client.ts` axios adapter. **MSW handlers are the unblock:** as soon as
Lane E commits a spec, the client builds against generated mocks without a running
server. Port virtu's look: dark theme tokens
(`tmp/virtu/server/src/styles/variables.scss` — `#19191c` bg, `#fcbc17` CTA,
Fira Sans, single centered column, 58rem max), Mantine-themed to match.

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
7. **No milters.** All verification is in-process via `mailauth.authenticate()`
   (SPF/DKIM/DMARC/ARC in one call, custom DNS resolver, results in the shape the
   ARC sealer consumes). Drops the milter protocol client and both milter
   containers; the verify → rewrite → sign/seal chain lives in one process. Lane B
   is repurposed as the mailauth integration lane. Fallback if mailauth's SPF
   proves weak in practice: glts spf-milter (`tmp/virtu/server/docker/spf/`).

Open: none.
