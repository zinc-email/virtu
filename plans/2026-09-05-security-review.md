# Pre-launch security review

Companion to `PLAN.md` and `ABUSE.md`. Status: **P0 fixed 2026-09-05 (see
STATE.md "Pre-launch review batch"); P1/P2 open.** Written 2026-09-05, one week before zinc goes live, from a
red-team pass over the whole tree by an agent with the same view of the code
any attacker with the public repo has. Threat model: the legacy host was
already being probed for mail-processing RCE (192.243.105.20, 2026-08-30);
the rewrite has no shell path for that class, so this doc is about what the
rewrite *does* expose.

Severities are "what happens if nobody fixes it," not effort. P0 items ship
before the first public mail; P1 within the first weeks; P2 when convenient.

## P0 — fix before launch

### 1. SMTP smuggling at the MX — FIXED 2026-09-05

**Where:** `server/src/smtp/wire.ts` `DataDecoder.push`, and
`server/src/smtp/server.ts` `pump` (which feeds the post-terminator bytes
back in as command input).

**What:** the decoder ends DATA on any line consisting of a single dot,
whether the line is terminated by CRLF or a bare LF. Confirmed by feeding the
class a body containing `\n.\n` followed by a second envelope: the bytes after
the dot came back as pipelined input and the pump executes them as a new
transaction on the same session. `\r\n.\n` and `\n.\r\n` terminate too.

**Attack:** send through a large outbound relay that passes bare LF through
to the receiver (the CVE-2023-51764 class; several big providers did in 2023
and some still do for one of the variants). The inner, smuggled message
arrives with the relay's IP and a forged `MAIL FROM` at the relay's domain.
`verifyInbound` evaluates SPF against `session.remoteAddress` → pass → DMARC
pass → the forward goes out carrying zinc's DKIM signature and ARC seal
vouching for the spoof. Submission has the same decoder, lower impact (auth).

**Fix:**
- Only `<CRLF>.<CRLF>` terminates DATA. A dot line ending in a bare LF is
  data.
- Decide the bare-LF policy explicitly and write it down: either normalize
  bare LF to CRLF (Postfix `smtpd_forbid_bare_newline = normalize`) or
  reject the message at end of DATA with `5xx` (`= reject`). Normalize is
  the safe default for an MX that forwards; the decoder already emits CRLF,
  so the only change is *what counts as the terminator*.
- Check `takeLine` (the command-line splitter) for the same laxity.
- Add the crafted payload as a unit test in `wire.unit.test.ts`, one case per
  terminator variant, asserting the dot line is body and `push` returns
  null.

### 2. Infinite forwarding loop through a self-hosted mailbox — FIXED 2026-09-05

Landed: the mailbox refusal and the hop counter (limit 2, per the
discussion: one hop is every forward, two is a provider auto-forward into a
second alias, three has no honest shape). The enqueue guard was skipped on
purpose — alias→alias mail legitimately routes back through the mx and the
counter already bounds it.

**Where:** `server/src/routes/mailboxRoutes.ts` (create: rejects only
`ALIAS_DOMAINS`), `server/src/queue/enqueue.ts` / `worker.ts` (no local-domain
refusal), `server/src/mail/rewriteForward.ts` (whitelist strips every
`Received`, so nothing survives to count hops).

**What:** a trial user (premium for 7 days) adds a custom domain with
catch-all, then registers `x@their-domain` as a mailbox. The verification
code routes through the catch-all to their real inbox, so it verifies. Make
it the default mailbox: every message to any address on the domain loops
MX → queue → deliverd → MX forever, each hop re-signed, re-logged, and a
fresh `email_logs` + `contacts` row. The inbound rate limit only tempfails
(450), so deliverd retries with backoff for four days and the loop never
drains. Also constructible across two accounts (A's mailbox on B's catch-all,
B's default mailbox = A's alias) and stumble-into-able by an honest user.

**Fix (all three; each closes a different door):**
- Mailbox create/update: refuse an address whose domain has a `domains` row
  with `verified_mx`, or whose MX resolves to `MAIL_HOSTNAME` / our IPs.
- Enqueue: refuse (or flag for the operator) an `envelopeTo` on a domain we
  serve unless the caller says it's intentional (alias→alias mail is
  legitimate and routes back through the mx — keep that, but bound it).
- Loop guard: carry a hop count in an `X-Virtu-Hops` header that is *in* the
  forward whitelist, incremented per forward, dropped (blocked log,
  `blockedReason: "loop"`) above a small limit (SimpleLogin uses 10 via
  `Received` counting). Story test: two-account loop terminates.

## P1 — first weeks

### 3. The login endpoint as an email cannon and lockout tool

**Where:** `server/src/routes/auth.ts`, `server/src/pipeline/transactional.ts`
`createVerificationCode` (marks every prior code used).

**What:** anyone can make zinc send login mail to any address (10/min/IP,
3/hour/address). Three consequences:
- **Reputation.** Unsolicited mail to attacker-chosen addresses from our IP;
  spam-trap hits count against the sending reputation ABUSE.md is built to
  protect.
- **Lockout.** Each new code invalidates the previous one, and the 3/hour
  budget is per address, not per requester. Three attacker requests an hour
  kill a known user's in-flight code and 429 their own request. Indefinite,
  cheap, targeted.
- **DB growth.** Provisional `users` rows (`activated = false`) are created
  on every unknown address and never pruned.

**Fix:**
- Keep earlier unexpired, unused codes valid (accept any of the last N; N=3
  matches the send budget), so an attacker's request can't kill the user's.
- Prune unactivated users older than 24h on the retention tick.
- A global hourly ceiling on login/verification mail (circuit breaker →
  429 for everyone, alert the operator) so a flood cannot burn the IP.
- Later: proof-of-work or captcha on `/auth/login` for unknown addresses.

### 4. Unbounded storage from accept-and-drop and retries

**Where:** `server/src/mx.ts` step 3 (drops mint a contact + blocked log
with no rate limit — `policy.ts` gathers `rateLimited` only for a
deliverable recipient), `server/src/queue/` (25 MiB raw per queued copy,
retried up to `QUEUE_MAX_TRIES`).

**What:** mail to a disabled alias writes rows per message at SMTP speed
(64 connections/IP). Separately, an attacker's own account with a
tempfailing mailbox holds 25 MiB rows retrying for four days at ten a minute
— hundreds of GB/day of Postgres.

**Fix:** apply the per-alias inbound budget to drops too; cap queued bytes
(and pending rows) per user at enqueue, 452 above it; consider a lower
`SMTP_MAX_MESSAGE_SIZE` for free-plan recipients.

### 5. Plaintext SMTP AUTH if the cert is missing

**Where:** `server/src/config.ts` `assertProductionSecrets`,
`server/src/submission.ts`.

**What:** with no `SMTP_TLS_*` files the 587 listener accepts AUTH in the
clear (`requireAuthTls` defaults to `tls != null`) and 465 never starts. The
production boot guard checks secrets, not TLS. A deploy where the mail-certs
sync hasn't run yet silently runs plaintext AUTH.

**Fix:** require `SMTP_TLS_CERT_FILE`/`KEY_FILE` when `VIRTU_ENV=production`
(fail closed like the secrets), and/or default `requireAuthTls: true`
regardless of TLS config so a plaintext listener simply has no AUTH.

## P2 — hardening

- **Look-alike service aliases.** Only `OPERATOR_LOCALPARTS` are reserved at
  mint time (`aliasNew.ts`). Bare `noreply@` can't be minted on the service
  domain (custom suffixes must start with a dot) but `noreply.xxxxx@` with a
  chosen display name goes out DKIM-signed by the service key. Add a reserved
  prefix list (`noreply`, `no-reply`, `support`, `admin`, `billing`, `help`,
  `team`, `zinc`, …) for service-domain aliases.
- **argon2 amplification in SMTP AUTH.** `verifyCredentials` tries up to
  `MAX_SMTP_CREDENTIALS` (20) hashes per attempt; the throttle is keyed
  (ip, username), so a distributed attacker gets 20× CPU per try. Add a
  per-username budget, or embed a credential id in the password format so
  one hash is checked.
- **Length caps** on `device` (login/api_key) and mailbox/credential `name`
  fields — unbounded strings straight into the DB.
- **Timing side channel on address existence** in `/auth/login` (insert vs
  no insert) and `/auth/verify` (early 400 vs code lookup). Low value to an
  attacker; note it, don't chase it.

## Deploy bug found on the way (not security)

The Caddyfile proxies only `/api/*` to the API. The Stripe webhook is mounted
at `/webhooks/stripe` (outside `/api`, by design), so in the serve stack
Stripe's POSTs land on the `www` file server as 404. Either add a
`handle /webhooks/*` proxy block or move the route under `/api/webhooks/`.
Verify on lmnop before enabling billing on zinc.

## What held up

Recorded so the next review doesn't re-derive it.

- No shell, no subprocess, no eval anywhere in the server; the only spawn is
  the test harness's `nsupdate` with an argv array.
- All SQL parameterized (Drizzle; the `sql` tag binds values).
- Owner checks on every id lookup traced (aliases, contacts, mailboxes,
  notifications, api keys); admin gated by flag on top of api auth.
- API keys 256-bit, stored sha256; codes `randomInt`, sha256, constant-time
  compare, 3 attempts, 15-min expiry; invites 72-bit.
- VERP: HMAC-SHA3 constant-time, 5-day expiry both directions; a forged DSN
  to a `bounce_reply` address cannot advance the alias auto-disable ledger
  (`recordBounce` returns early on `isReply`).
- Reverse aliases are dead at the MX (not alias, not VERP → 550), so learning
  one gains nothing; the reply path requires AUTH and scopes reverse-alias
  resolution to the authed user.
- Header injection: `HeaderBlock` collapses CR/LF on every synthesized
  value; display names are quoted; the reply whitelist drops `Reply-To`,
  `Sender`, `Bcc`, `Received`, `Authentication-Results`.
- Caddy strips untrusted `X-Forwarded-*` by default, so Fastify's
  `trustProxy: true` is safe; `/meta/*` is unreachable from outside.
- CSP: `script-src 'self'`, no inline scripts; API key in `localStorage`
  is only exfiltrable via XSS and React escapes everything (no
  `dangerouslySetInnerHTML`).
- Extension: closed shadow root, no `externally_connectable`, the API relay
  only answers the extension's own content scripts, alias list scoped to the
  current hostname.
- deliverd egress guard blocks loopback, RFC1918, link-local, CGNAT,
  unspecified and the IPv6 equivalents, and connects to the vetted IP.
- Stripe webhook verifies the signature over the raw body; DKIM private keys
  never appear in any route.
