# Public data-leak reporting

Companion to `PLAN.md` and `ABUSE.md`. Status: **not started** — this doc
exists so the schema decisions that are cheap now don't become impossible
later.

## The goal

An alias service sees something nobody else can: the exact moment an address
that only one company ever held starts receiving mail from somewhere else. At
sufficient scale that is a breach detector — one that can fire before the
breached party has announced, and sometimes before it knows. The legacy
service already did this by hand once (Amtrak). The product is a periodical
public report: *these entities leaked, this is when we first saw it*.

Critical mass is the gate for publishing. It is not the gate for retaining
the evidence, which is why P0 below is dated now.

## The signal

The detection primitive is not "messages" — it is **first-contact events**: a
sender appeared on an alias it had no legitimate way to know about. Three
strengths of signal, weakest to strongest:

1. **Unexpected sender on a live alias.** Noisy on its own — entities hand
   addresses to legitimate partners, and users reuse aliases.
2. **Unexpected sender on an alias minted for a known entity.** The cohort
   makes it comparable: if aliases minted for `example.com` acquire unrelated
   senders at 30x their baseline rate inside one week, that is a leak, not a
   partnership.
3. **Any sender at all on a revoked alias.** The user killed this address;
   there is no innocent explanation for new traffic. Highest precision,
   lowest volume, and — per `ABUSE.md` — revocation-after-leak is exactly the
   behaviour our users exhibit.

(3) is the one legacy could not see well and we can. It is also the one most
at risk from P0's problem.

## What we already have

- **`contacts`** (`server/src/db/schema.ts:346`) — unique on `(aliasId,
  websiteEmail)`, so `contacts.createdAt` *is* a per-(alias, sender)
  first-seen timestamp. The event stream already exists and has been
  accumulating since the first inbound message. `automaticCreated`
  distinguishes pipeline-observed contacts from user-created ones.
- **Both sender identities.** `websiteEmail` (From — usually the brand) and
  `mailFrom` (envelope — usually the ESP). Needed to keep `sendgrid.net` from
  collapsing into one enormous fake entity.
- **`email_logs`** (`schema.ts:399`) — timestamped forward / reply / blocked /
  bounce events with `blockedReason`, `isSpam`, `spamScore`. Second axis:
  leaked addresses land on spam lists.
- **Revoked aliases still record.** `server/src/mx.ts:262` creates the contact
  *before* the accept-and-drop, so a disabled alias writes a real contact plus
  a `blockedReason: "alias_disabled"` log. Signal (3) is already being
  captured today.
- **`alias_used_on`** (`schema.ts:309`) — the cohort key: which hostname an
  alias was minted for.

## Gaps, ranked by cost-of-delay

1. **Cascade deletes destroy the evidence.** `contacts` and `email_logs` are
   `ON DELETE CASCADE` from both `aliases` and `users`. Per `ABUSE.md`,
   mint→register→delete churn is the dominant lifecycle — 62% of legacy
   inbound addressed later-deleted aliases — which means *the aliases most
   likely to have been leaked are the ones most likely to be deleted*.
   `deleted_aliases` keeps only the address and a reason. This is the only
   gap that is unrecoverable: every other item here can be filled in later
   against retained history.
2. **DKIM `d=` is thrown away.** `mx.ts:250` has the full mailauth result in
   hand and forwards only `verdict.reason` into `email_logs` as a spam flag.
   `d=` is the *authenticated* sender identity: forge-resistant, and it
   survives ESP relaying in a way the From header does not. It is the best
   entity key available to us, it costs a few lines at a point where the
   value is already loaded, and it is lost history if we don't start now.
3. **Attribution coverage is thin.** `alias_used_on` is only written when
   `?hostname=` is passed (`routes/aliasNew.ts:140`) — the extension and the
   Android share target do; the web UI mint does not. Mitigated by a
   retroactive heuristic: the first `automaticCreated` contact on an alias is
   nearly always the entity itself (the signup confirmation). Legacy learned
   entities exactly this way (`tmp/virtu/.../Model/Virtual.php:238`). Works on
   all existing data with no schema change.
4. **No entity normalization.** The dropped legacy `entities` table.
   `email.amtrak.com`, `amtrak.com.mktomail.com` and `noreply@amtrak.com` must
   collapse to one brand; `sendgrid.net` and `mktomail.com` must not collapse
   at all. Needs a curated ESP list plus `d=`, not string matching.
5. **Cohort query ergonomics.** `alias_used_on` is indexed `(userId,
   hostname)` and unique `(aliasId, hostname)`; cross-user cohort queries want
   `hostname` alone. Trivial and additive.
6. **`smtp_rejections` ages out** on queue retention — if rejected-at-the-door
   traffic ever becomes part of the signal, that is a second place evidence
   evaporates.

## Phases

**P0 — preserve the evidence (do now, before critical mass).** An
append-only observation table written at first-contact time: cohort key,
sender identity (including `d=`), first-seen bucket, and alias state at
contact (live / disabled / post-deletion). **No user FK, no alias FK** — the
row is a fact about an entity, not about a person. This simultaneously fixes
gap 1 and pre-empts the privacy problem in P3, because the analysis surface
never contains per-user rows. Plus gap 2 (persist `d=`) and gap 5 (index).

**P1 — attribution.** Backfill entity-per-alias from the first-contact
heuristic (gap 3); pass `hostname` from the web UI mint; build the ESP list
and the entity normalizer (gap 4). Offline work against retained data — no
rush, and it improves with age.

**P2 — detection.** Per-cohort baseline rates, then divergence. The hard part
is not the query, it is the denominator: "unusual" requires knowing the normal
rate at which a cohort acquires new senders, including seasonality and
legitimate partner hand-offs. Needs a k-anonymity floor before any cohort is
reportable — `n=4` will eventually generate a false accusation against a named
company.

**P3 — the report.** Publishing is an outward-facing claim about named
companies on statistical evidence. Every published finding must be
reconstructible from retained rows months later, on demand. Editorial policy
(notification-before-publication, right of reply, what confidence threshold
warrants naming) is a real deliverable, not a footnote — draft it before the
first report, not after the first dispute.

## Deliberate non-adoptions

- **Storing Subject lines.** Subject clustering would add a little signal, but
  the leak signal is *who*, not *what* — and content storage cuts hard against
  the privacy posture the report itself needs to stand on. See PLAN.md's
  envelope-only stance for the operator-facing analogue.
- **Per-user analysis surface.** The report pipeline reads the aggregate
  table, never user mail metadata. Falls out of P0 for free if P0 is done
  right, and is expensive to retrofit if it isn't.
- **Naming an entity off a single cohort.** No report without the
  k-anonymity floor and a reconstructible evidence trail.

## Sequencing

| When | What | Blocked on |
|---|---|---|
| Now | Observation table; persist DKIM `d=`; `hostname` index | nothing |
| Now | Pass `hostname` from web UI mint | nothing |
| Later | Entity backfill from first-contact; ESP list + normalizer | retained data |
| Critical mass | Baselines, divergence detector, k-anonymity floor | volume |
| Before publishing | Editorial + notification policy | P2 proven |

Publishing starts when the detector is proven against a known-good case
(Amtrak is the worked example we already have) — not on a date.
