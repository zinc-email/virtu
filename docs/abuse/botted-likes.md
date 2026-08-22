# Abuse type: botted-likes farms (fake Facebook accounts)

Status: **active** — legacy service is invite-only; eviction of the
standing accounts is in progress (2026-08). This is the abuse type that
drove the legacy service invite-only and shaped the program in
`ABUSE.md` (repo root — the ranked mitigation program; this doc is the
evidence file for one abuse type).

Everything quantified below was measured from a dump of the legacy
MySQL DB (accounts after id 1024, 2018-08 → 2026-08: 12,379 accounts,
~81k aliases ever minted, 595,890 inbound messages), analyzed
2026-08-22. Artifacts are local-only (`tmp/` is gitignored, and they
contain real addresses): `tmp/abuse-dump.sql.gz` (the dump),
`tmp/abuse-flagged-accounts.csv` (2,202 flagged accounts),
`tmp/abuse-flag-legacy.sql` (ready-to-run flag statement). Analysis
env: load the dump into a `mariadb:10.11.3` container — strip the
`/*M!999999` sandbox line, `SET NAMES utf8mb4`, autocommit off.

## The operation

Sellers of botted Facebook likes / ad-boosting. Each fake Facebook
account needs a working email address for registration; our aliases
are that address. The operator's own mailbox sits behind the alias —
throwaway domains mostly, Gmail sometimes — and receives Facebook's
verification and notification mail through our forwarding.

Operator fingerprint from the mail itself: Facebook login alerts
locate the operators near **Lagos, Nigeria**, with a parallel
**Brazilian-Portuguese** segment (~15% of subject lines). 44.6k
messages are "restricted from advertising" notices — these are
ad-boosting accounts, and Facebook burns them steadily, which is why
the operators need a continuous supply of new aliases.

**Their economics beat pricing.** One account → hundreds of platform
accounts; each sold FB account is worth more than our subscription.
They demonstrably pay when payment is required (operator testimony
from the paywall era: stolen cards that cleared Braintree and later
charged back, and sometimes real money).

## The account lifecycle

1. Sign up with a throwaway or Gmail mailbox. 93% of flagged accounts
   start minting the same day.
2. Mint alias → register a Facebook account with it → **delete the
   alias**. Repeat at 30–100+/day (burst accounts) or ~4–5/day
   sustained for months (whales).
3. The operator's mailbox eventually goes dark (throwaway chain
   collapses, or Google bans the Gmail account) — from then on, every
   forwarded Facebook notification is a bounce charged against our
   outbound IP. Expired throwaway domains can also come back as
   recycled spamtraps ("accepts again" ≠ recovered).

## Measured fingerprint (the numbers)

- **98.5%** of all cohort inbound is from facebookmail.com. The
  flagged accounts' mail is >80% one sender domain at every account
  size.
- **2,202 accounts** flagged (≥20 messages, >80% facebookmail/meta):
  1,212 with ≤2 *live* aliases, 21 whales with 100+ (max **1,605** on
  one account).
- **Mint→register→delete is the load-bearing behavior**: 62% of all
  messages (370k) address hard-deleted aliases — 60k deleted aliases
  across 6,205 accounts. Live alias counts see almost nothing.
- **Signup wave**: Jul–Sep 2025 = ~9,200 signups vs a baseline of a
  few hundred per *year* (monthly: 500 → 5,510 → 3,204).
- **Mailbox fleet**: 261 distinct mailbox domains; ~20% Gmail; the
  throwaways heavily reused — single domains served 200+ accounts
  each within the wave. Domain *reuse velocity* across fresh signups
  is therefore a high-precision signal even though the domain *names*
  are unlistable.
- Peak per-account rates: 1,041 accounts peaked at 30–99 Facebook
  messages/day; 150 at 100+/day.

## Countermeasure history, with measured effect

| When | Countermeasure | Effect (signups/mo) |
|---|---|---|
| pre-2025 | disposable-domain blocklist | lost the arms race (261 domains in one wave) |
| Oct 2025 | paywall on alias creation | 5,510 → 498 (~90% cut) — slowed, did **not** stop; they paid |
| Apr 2026 | invite-only signup | → 0 after 2026-04-22 — stopped **intake** |
| Aug 2026 | eviction of standing accounts | in progress (`tmp/abuse-flag-legacy.sql`) |

The invite wall's blind spot, measured: intake stopped but the
standing stock kept operating — 117 flagged accounts active in the
last 7 weeks of the dump, 74k Facebook messages forwarded after
2026-05-01, whales still minting the week of the dump. **Intake
controls never touch existing inventory; only detection + eviction
do.** Eviction also destroys inventory retroactively: sold Facebook
accounts die when re-verification mail stops flowing.

## Detection signature (validated on this corpus)

Flag: ≥20 lifetime messages AND >80% from
facebookmail/facebook/meta sender domains. Then split by evidence:

- **≥3 distinct lifetime aliases** receiving that mail (deleted ones
  count) → farm-certain, act mechanically: 2,083 of 2,202.
- 1–2 lifetime aliases → manual review (could be a legit
  Facebook-only user): 119 of 2,202.

Requirements this places on virtu (carried into `ABUSE.md`):

- Count **lifetime** mints; deletes must not refund quota or erase
  per-alias stats (soft-delete or roll up before removal — the legacy
  schema's hard deletes hid 62% of the evidence).
- Delete-churn rate is itself a detector input.
- Sender-concentration rollups need only envelope data — no Subject,
  no body — so the privacy stance holds.
- This corpus is the detector's **labeled test set**: virtu's
  implementation should recover these 2,202 accounts with near-zero
  false positives before invite-only is lifted.

## Response playbook

1. Flag/disable the accounts (legacy: users abuse flag +
   `virtuals.disabled` belt-and-braces; virtu: sudo-gated disable via
   `/api/admin`, audit-logged).
2. Suppress their mailboxes so nothing more is forwarded or bounced.
3. Seed the hashed abuser archive (ABUSE.md Tier 2) with every
   identifier: signup emails, all alias addresses incl. deleted,
   mailbox domains → re-entry blocks and account linking.
4. Keep the invite graph forever; if farm accounts reappear through
   invites, cut the inviter branch.
5. Optional: bulk-report the recipient addresses to Meta (44.6k
   ad-restriction notices make the case).

## Open questions / gaps in the evidence

- Payment/chargeback data wasn't in the dump (no `accounts`/billing
  tables) — the "they paid" claims rest on operator testimony.
- No signup IP/user-agent data was retained — geo attribution rides
  on Facebook's login alerts only. virtu should retain signup IP +
  ASN (Lane K P2 `smtp_rejections` sibling) to close this.
- Whether the Oct 2025 drop was entirely the paywall or partly
  exhaustion of the wave is unknowable from this data.
