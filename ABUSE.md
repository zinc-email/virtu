# ABUSE.md — abuse detection & mitigation program

Companion to `PLAN.md` (Lane K owns the implementation phases) and
`STATE.md`. This doc captures what we know about the abuse we actually
face, the industry practices that address it, and the order we should
implement them in. When a practice below names a Lane K phase, that phase
is the implementation home.

## The threat model (measured from the legacy database)

The legacy service was driven invite-only by one dominant abuse pattern:
**alias farming for fake Facebook accounts** (botted-likes / ad-boosting
sellers). The full evidence file — operation, account lifecycle,
countermeasure history with measured effects, validated detection
signature, response playbook — is **`docs/abuse/botted-likes.md`**; new
abuse types get sibling docs there. Summary, measured against the
legacy DB (accounts after id 1024, 2018–2026: 12,379 accounts, ~81k
aliases ever minted, 595,890 inbound messages) — **98.5% of all inbound
mail in the cohort is from facebookmail.com**:

- **A mass-signup wave, plus whales — both shapes at once.** Jul–Sep
  2025 brought ~9,200 signups against a baseline of a few hundred per
  *year*. 2,202 accounts are Facebook-dominated (>80% of their mail,
  ≥20 messages). Most are small — 1,212 of them show ≤2 live aliases —
  but 21 whales each minted 100+ (max 1,605 on one account, sustained
  ~4–5/day for ten months).
- **Mint → register → delete.** The load-bearing fact: 62% of all
  messages (370k) address aliases that were later hard-deleted — 60k
  deleted aliases across 6,205 accounts. Deleting the alias after the
  Facebook signup keeps the *live* alias count tiny, so any quota or
  per-account alias-count metric on live rows sees almost nothing.
  Detection must count **lifetime aliases minted** and treat
  delete-churn itself as a signal.
- **Activation is immediate and bursty, not slow.** 93% of
  Facebook-dominated accounts start same-day; 1,041 of them peaked at
  30–99 Facebook messages/day and 150 at 100+/day. (An earlier wave
  read as one-account-slow-minting; the 2025 wave was fast and wide.)
  Burst velocity limits do bite here — churn-aware counting required.
- **They pay** (operator testimony from the paywall era): stolen cards
  that cleared Braintree and later charged back, and sometimes real
  money. Unit economics (one account → hundreds of platform accounts)
  beat any price. **Payment is not a trust signal and pricing is not a
  gate.**
- **The mailbox fleet is disposable-heavy with a Gmail minority.** The
  2,202 flagged accounts used 261 distinct mailbox domains: ~20% Gmail,
  the rest throwaway domains *heavily reused* (snapbx.com 255 accounts,
  temailz.com 234, verum.email 95, …) — the same domain recurring
  across many fresh signups within days is itself a high-precision
  signup-time signal. Mailboxes eventually go dark (chains collapse,
  Google bans the accounts) and every dead mailbox becomes a bounce
  source charged against our outbound IP.
- **Domain lists lose.** 261 mailbox domains in one wave; blocklists
  can't keep up with registration. (Infrastructure fingerprints and
  reuse-velocity age better than name lists.)
- **Operator fingerprint.** Facebook's own alerts locate the logins
  near Lagos, with a parallel Brazilian-Portuguese segment; 44k+
  messages are "restricted from advertising" notices — these are
  ad-boosting farms, and the platform is visibly burning their accounts
  too.

Reputation reality that shapes the responses below: reputation is a set
of **per-receiver ledgers**, not a global score. Traffic delivered to
throwaway MTAs builds nothing that matters; unengaged bulk forwarded to
Gmail *drags* on the ledger that matters most; hard bounces are charged
by whoever receives them; and expired disposable domains get recycled
into spamtraps — so "went dark, then started accepting again" is a
red flag, never a recovery. Separately, mass fake-account signups burn
our *alias domains* with the platforms themselves (Facebook banning
alias domains from signup forms) — a product-quality loss independent
of SMTP reputation.

Strategy in one line: we cannot price them out, and rate limits alone
only slow them down; we detect them on pattern (lifetime-alias churn +
sender concentration), make bans sticky, and cap the damage a dead
mailbox can do while they're active. Slow-but-certain detection beats
up-front gating against an adversary who pays to get in — suspension
costs them their subscription *and* their farm (platform accounts die
when re-verification mail starts bouncing).

## Tier 0 — before open signup (now)

**Invite-only signup gate.** *Built 2026-08-22 (see STATE.md).* The proven
stopgap from the legacy service;
open signup stays off until Tier 2 detection is live and proven. Design
(the "invite lane"):

- Gate at **verify-time graduation**, not at the login request. The
  passwordless flow creates a provisional user (`activated: false`) and
  `POST /auth/verify` graduates it — that's the seam
  (`server/src/routes/auth.ts`). Rejecting there ("this deployment is
  invite-only") leaks nothing: the caller has already proven mailbox
  ownership, so the never-reveal-registration stance survives. Existing
  activated users log in untouched.
- `invites` table: code, created_by (admin user), used_by, created_at,
  expires_at. Verify accepts an optional invite code; a valid unused
  code lets graduation proceed and burns the code.
- `SIGNUP_INVITE_ONLY` env switch (default on for zinc until further
  notice) so lmnop/dev can stay open.
- Tooling: admin API + page for minting/listing invites (Lane K
  surface), `bin/invite-create` break-glass CLI, per the CLI-mirrors-API
  convention.
- Exit criterion: lift when the Tier 2 concentration detector has run
  against real traffic long enough to trust (see below), not on a date.

**Mechanical payment-failure policy.** Chargeback or failed rebill →
account suspended and all aliases disabled immediately, recorded in the
audit log. No judgment call, no delay. Stripe Radar handles the
stolen-card slice better than the Braintree era did; this policy makes
the remainder mechanical. (Billing lane + Lane K P2 audit log.)

## Tier 1 — damage control (Lane K P2)

These cap what an active abuser costs us, independent of detection.

**Mailbox-level bounce suppression.** The single highest-value control.
Today the ledger auto-disables per *alias*, so one dead mailbox behind
40 aliases bleeds bounce-by-bounce, alias-by-alias. Instead, key on the
enhanced status code of the forward-phase bounce:

- `5.1.1` (no such user) / `5.2.1` (account disabled) → suppress the
  **mailbox**: pause forwarding for every alias behind it, drop (never
  bounce) subsequent inbound with a "mailbox suppressed" email_log
  status, notify in-app. First strike, no threshold — a banned Gmail
  account or dead disposable domain earns nothing by retry.
- `4.x.x` / mailbox-full variants → normal retry/backoff, untouched.
- **Resumption requires re-verification** (the user clicks a fresh
  code). Never auto-resume when the domain answers again — the
  domain-recycled-into-spamtrap case looks exactly like recovery.
  `classifySendResult` already parses enhanced codes; the suppression
  check rides the same seam as `recordBounce`.

Reference point: SimpleLogin's equivalent (`should_disable()`) is
per-alias and threshold-based (>12 bounces/24h). Mailbox-level
first-strike is strictly stronger for our bounce exposure.

**Admin action audit log.** Every mutation through `queue/admin.ts` and
every future disable/enable/suspend writes an `admin_actions` row
(actor, action, target, reason, timestamp) — API and break-glass CLI
alike (CLI actor recorded as `cli:<username>`). Lands *before*
sudo-gating so the first destructive ops are born logged. SimpleLogin
runs three audit tables (user/abuser/admin); one honest one is enough
to start.

**Bounce-ledger inspect & reset.** The complement to auto-disable: an
admin view of *why* an alias/mailbox tripped, and a reset lever for
false positives (flaky recipient MX). Operator bounces already don't
advance the ledger; this is the un-advance tool.

**User & alias admin views.** Lookup by user email, alias address, or
custom domain; sudo-gated disable/enable at both account and
single-alias granularity. Real abuse reports arrive as "this alias
spammed me," not "this user is bad."

**Quotas and burst limits — on lifetime mints, not live rows.** Per-plan
alias caps and creation rate limits *including paid users* (SimpleLogin
binds paid accounts to 50/15min, 200/hour). The legacy data shows these
bite harder than the old war story suggested — the 2025 wave ran
30–100+ registrations/day per account — **but only if the counter is
churn-proof**: quotas and velocity must count aliases *ever minted*
(deletes don't refund quota), because mint→register→delete kept live
counts near zero on 6,205 abusing accounts. Delete velocity itself
feeds the Tier 2 detector.

## Tier 2 — detection & memory (Lane K P2/P4)

The centerpiece. Detection on pattern, then bans that stick.

**Sender-domain concentration detector.** The abuse fingerprint is
unmistakable in envelope data alone, and the legacy DB validates it
brutally: 98.5% of the cohort's inbound was facebookmail.com, and the
flagged accounts' mail was >80% one sender domain at every account
size. Per-account rollup from `email_logs` (top sender domain, its
share of all inbound, **lifetime** alias count including deleted,
delete-churn rate, distinct-correspondent count) — **no Subject, no
body**, fits the privacy stance as-is. Aliases must be soft-deleted or
their stats rolled up before removal: the legacy schema hard-deleted
alias rows, which is exactly how 62% of the abuse traffic vanished
from per-alias accounting. Admin
view sorted by concentration × alias count first; automated
flag → notify → suspend escalation once thresholds are trusted. This
detector works identically whether the mailbox is a disposable domain,
a nested alias service, or Gmail. It is also the invite-only exit
criterion: signup reopens when this is proven on live traffic.

**Hashed abuser archive (ban memory).** SimpleLogin's strongest idea
(`app/abuser_utils.py`), worth adopting wholesale: marking an account
as an abuser archives *every identifier it touched* — signup email,
all aliases, all mailboxes — as an encrypted bundle (AES-GCM), and
writes an HMAC-SHA256 of each address to an `abuser_lookup` table. New
signups and new mailboxes are checked against the hashes. Effect: the
mailbox addresses they used — including the nested-alias-service
addresses — permanently block re-entry and link any future account
sharing an identifier with a banned one, with no plaintext retained.
This is what makes Tier 2 compound: detect once, ban forever, across
their whole flock.

**Signup risk scoring (score, never a hard gate).** Inputs, all cached
per domain:

- **RDAP domain age** — registered <30–90 days is a strong disposable
  signal (burning domains fast is their cost model). Unknown-age ccTLDs
  score neutral, never penalized.
- **MX/NS infrastructure fingerprint** — domains churn daily, but the
  mail infrastructure behind them churns slowly; a thousand throwaways
  share a handful of MX/NS/IP ranges. Score against a fingerprint list
  seeded by hand and **grown automatically from our own bounce data**:
  when a mailbox dies dead, record its domain's MX fingerprint; enough
  dead mailboxes on one fingerprint → new signups pointing at it start
  penalized. A feedback loop domain-registration can't outrun. (The
  wire-format DNS client does the lookups.)
- **Mailbox-domain signup velocity** — the same mailbox domain
  recurring across many fresh signups in a short window. In the legacy
  wave single throwaway domains served 200+ accounts each (snapbx.com
  255, temailz.com 234); no legitimate signup pattern does that.
  Computable from our own `users` rows alone, no external lookup.
- **Disposable-domain list** as a floor, nothing more — it lost the
  arms race once already (261 distinct mailbox domains in one wave).
- **Abuser-lookup hash hit** (above) — the heaviest input.

High score → not a denial but a **restricted tier**: tiny alias quota,
forwarding-only, quota grows with account age. A hard deny teaches them
what to randomize; a quota makes each account worthless while costing a
false-positive legit user almost nothing.

**Structure when this lands (decided 2026-08-22):** graduation-time
policies compose behind a `signupGate` seam (sudoGuard-shaped: a
callable invoked inside the verify handler at the graduation point,
NOT route middleware — anything before code proof leaks registration
status, and the checks must be atomic with activation). Extract the
inline invite check into it as the first policy; abuser-hash lookup,
domain scoring and the restricted-tier decision join it. Do the auth
dance descent in the same refactor: move login-code consumption into
the graduation transaction (widen `consumeVerificationCode`'s Db type
to accept a tx), so a failed policy check rolls back the code too and
an invite typo stops costing a fresh login email.

## Tier 3 — reputation program (Lane K P3/P4 + deploy lane)

Protect and measure the asset the abusers spend.

- **Inbound hardening** (P3, already planned): `smtp_rejections`
  table, per-IP MX throttling, cheap in-process spam checks (DNSBL via
  the wire-format TXT client, rDNS/HELO sanity) writing
  `email_logs.isSpam/spamScore`; rspamd stays deferred until a bigger
  box.
- **Reputation telemetry** (P4, already planned, plus additions):
  `domain_delivery_stats` daily aggregates, DMARC rua ingestion
  (self-hosted MX — point rua at ourselves), Google Postmaster Tools,
  **Microsoft SNDS**, and **automated DNSBL self-checks of our own IPs
  and rDNS/SPF/DKIM/DMARC posture**, surfaced on AdminOverview — turns
  "Gmail suddenly defers" from a mystery into a dashboard line.
- **Pool separation, not rotation** (deploy lane, next box). Split
  transactional mail (login codes, DSNs) and user-forwarded traffic
  onto separate IPs so a bounce storm can never take down our own login
  emails. Keep one warmed standby for failover. **No rotating fleet**:
  warmth is per-receiver and rotation is snowshoe mechanics that
  receivers punish; a warm IP with history beats a fresh one every
  time. Two clean IPs + Tier 1 suppression outperform a rotated fleet
  at any scale we'll reach.
- **Alias-domain supply** (someday, accepted risk until then). The
  platforms will eventually ban our alias domains from signup forms
  regardless of abuse (it happens to every alias service); SimpleLogin's
  answer is a steady supply of fresh domains. Revisit when the first
  ban lands.

## Deliberate non-adoptions

Industry-adjacent practices we've considered and rejected, so they
don't get re-proposed:

- **Paywalls as the primary defense** — empirically falsified on the
  legacy service; they paid (see threat model). Velocity limits are
  demoted, not rejected: useful against the measured 30–100+/day
  bursts, but only churn-proof lifetime counters, never a primary
  defense.
- **Catch-all/wildcard MX probing at signup** — unreliable
  (accept-then-bounce, greylisting), false-positives on exactly the
  users an alias service should welcome, and unsolicited RCPT probing
  is itself abuse-shaped.
- **Greylisting** — latency for weak returns (PLAN Lane K, decided).
- **IP rotation by warmth** — see Tier 3; rotation is the spammer's
  move and receivers are tuned to punish it.
- **Admin impersonation ("view as user")** — cuts against the
  envelope-only privacy stance; allowlisted-header detail views cover
  the legitimate debugging need.

## Sequencing summary

| When | What | Home |
|---|---|---|
| Now | Invite gate at verify-graduation; chargeback policy | invite lane, billing |
| P2 | Mailbox suppression; audit log; ledger reset; user/alias views; quotas | Lane K P2 |
| P2/P4 | Concentration detector; abuser archive; signup scoring + restricted tier | Lane K P2 groundwork, P4 detection |
| P3/P4 | Inbound hardening; reputation telemetry | Lane K P3/P4 |
| Next box | Pool separation + warmed standby | deploy lane |

Signup reopens when the concentration detector + abuser archive are
proven on live traffic — not on a date.
