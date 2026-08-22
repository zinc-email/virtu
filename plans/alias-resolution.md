# Alias resolution: sending without reverse aliases

*Working draft, started 2026-08-21. Not settled — see "Open questions". This
plans the outbound side of PLAN Milestone 2: how `submission` picks which alias
a message goes out as, when the user's MUA only knows their real mailbox.*

## The one question

Every message virtu sends on a user's behalf must present as exactly one
alias, and the mail client cannot tell us which — it knows only the user's
real mailbox.

**The alias is a function of the correspondent.** Everything below is
machinery for evaluating that function:

| for a correspondent… | mechanism | form |
|---|---|---|
| who has written to us, or whom we have written to | **contact** | recorded — an exact, durable pairing |
| we have never exchanged mail with | **scope** | derived — a rule over the recipient address |
| being replied to from a client that may not route through us | **reverse alias** | the contact, made addressable |

These are not three competing designs. They are one mechanism seen at three
moments: a contact is the answer memoized when we first learn it, scope is the
rule that computes an answer when no memo exists, and a reverse alias is that
memo written into an address so it survives leaving our infrastructure.

Presenting them as separate features is what makes the system feel like an
accumulation of half-solutions. It is one function, with a cache, a fallback,
and a wire format.

## Where each one fires

Inbound mail to an alias hands us the pairing for free: we know the alias (it
was addressed) and the correspondent (they sent it). Record it as a contact,
and rewrite `From:` to its reverse alias so a reply carries the pairing back to
us regardless of which client or server the user replies from.

Outbound mail to someone who never wrote first has no such event. Nothing was
recorded, so the pairing must be derived from the only thing available — the
recipient address — and then recorded, so that it is derived exactly once.

That asymmetry is the entire design. Contacts answer the common case exactly;
scope answers the cold start. Today only the first half exists: with MAIL FROM
set to a mailbox, `submission.ts:277` refuses any recipient that is not
already a reverse alias, so a stock client can reply but can never start a
conversation.

## Why not the way legacy did it

Legacy virtu answered the same question in the same place —
`Outbound.php:188`, `findOrCreateAssociatedVirtual()`: the most recent message
from this address wins its virtual; else a virtual with a matching
`sourceDomain`; else mint one bound to that domain. `Inbound.php` left `From:`
untouched unless DMARC forced a rewrite, so replies addressed the real
correspondent and came back through submission to be resolved the same way.

Same shape as what follows, and flawed in three ways this design exists to fix:

1. **Fail-open.** With the real correspondent in `From:`, a reply stays private
   only if it routes through our submission server. Point the client at Gmail's
   SMTP instead and hitting reply mails the correspondent from the user's real
   address, with no opportunity for us to intervene — we are not in the path. A
   reverse alias makes that outcome unreachable: the address in `To:` is ours,
   so the message cannot arrive any other way.
2. **The memo was the message log.** Tier 1 resolved by scanning `messages` for
   one from that address, coupling routing correctness to log retention — prune
   old records and aliases silently start resolving differently. A contact is
   that memo made explicit: a small durable row that outlives log pruning, and
   that can be inspected, edited and blocked on its own.
3. **Domain-only binding.** New correspondents always bound by domain, so
   `joe@gmail.com` and `kat@gmail.com` resolve to the same alias and two
   strangers can correlate the user. That is the failure the scope model exists
   to prevent.

## Prior art

| | who picks the alias | cost |
|---|---|---|
| SimpleLogin | the user, via a reverse alias in `To:` | a dashboard visit per cold contact |
| Addy.io | the user, via an encoded recipient (`first+hello=example.com@…`) | no dashboard, still a hand-built address; paid tiers only |
| Apple Hide My Email | the mail client | requires owning the client |
| **this plan** | the server, from a contact or a scope | the server has to be right |

SimpleLogin never answers the question server-side because it has nowhere to
answer it: there is no submission server in its path, so the alias has to reach
it inside the recipient address. [Discussion #1770](https://github.com/simple-login/app/discussions/1770)
asked for exactly this and their SMTP work was abandoned. virtu has per-device
SMTP credentials and a submission server, so the question is answerable where
the user never has to see it.

## The scope model

An alias binds to a **correspondent scope** — the unit of counterparty identity:

| recipient | scope | recorded as | why |
|---|---|---|---|
| `dev@facebook.com` | the domain, `facebook.com` | an `alias_scopes` row | the domain *is* the counterparty; everyone behind it is one relationship |
| `kat@gmail.com` | the address, `kat@gmail.com` | a `contacts` row | the domain is infrastructure; the counterparty is the person |

Getting this wrong is asymmetric, which sets every default below:

- **Provider treated as a domain scope** — `joe@gmail.com` and `kat@gmail.com`
  share an alias, and two unrelated people can correlate you. *A privacy
  failure.*
- **Organization treated as address scope** — a separate alias per person at
  `facebook.com`. Sprawl, and Facebook correlates them internally anyway since
  they hold the account. *Untidy, not a leak.*

So every default leans toward address scope. Domain scope is only ever set by a
positive signal of intent.

**Scope is only consulted on the outbound path.** Inbound routes on
`aliases.email` directly (`pipeline/policy.ts:194`) and never touches scope.
This matters more than it first appears: it means the classic mismatch —
signing up at `facebook.com` while their mail arrives from `facebookmail.com` —
mostly doesn't bite, because you cold-email the human-facing domain, which is
the one that got recorded.

## Why the scope model is not just a provider list

The smallest thing that could work: scope is the recipient's registrable
domain, unless that domain is a known shared-mailbox provider, in which case
scope is the full address. One rule, one list, no `scope_mode`, no binding
table. That covers both motivating examples above.

What the machinery below adds:

- **Independence from list completeness, in the direction that matters.** If
  the list is the only mechanism, every domain *not* on it defaults to domain
  scope — so an unlisted provider (regional, new, small, self-hosted) silently
  shares one alias between strangers. That is the privacy failure, arriving by
  omission, and omission is what a curated list is worst at. The extension's
  "this is a signup form" signal is positive evidence that does not decay as
  the list goes stale.
- **Multi-binding** — `facebook.com` + `facebookmail.com` + `fb.com` as one
  scope. A convenience; see open question 4.
- **Pinning** — two live aliases on one scope, deterministically ordered. Also
  a convenience.

Honest accounting: the first bullet carries the design, the other two ride
along. If the extension signal proves unreliable, or the list proves easy to
keep complete, cut back to the one-rule version.

## Where each mechanism lives

**`contacts` is the address-level memo.** It already records exactly the
pairing resolution needs — `(aliasId, websiteEmail)`, unique
(`contacts_alias_id_website_email_uq`), minted by both the forward path and by
cold sends via `findOrCreateContact`. There is no separate address-scope
binding, because that would be the same fact stored twice.

**`alias_scopes` is the domain-level binding**, and only that. Many-to-many in
both directions — one alias covers several domains after manual additions, one
domain carries several aliases after a revoke-and-replace — so it is a table.

```
alias_scopes
  id
  userId    integer -> users.id   on delete cascade   (denormalized for the lookup index)
  aliasId   integer -> aliases.id on delete cascade
  domain    varchar(255)  registrable domain, lowercased
  source    varchar(16)   'extension' | 'mobile' | 'manual' | 'inbound' | 'import'
  pinned    boolean default false
  createdAt / updatedAt

  unique (aliasId, domain)
  index  (userId, domain)                   -- the resolution lookup
  unique (userId, domain) where pinned      -- at most one pin per domain
```

`userId` is denormalized so RCPT-time resolution is one index hit with no join
— the same shape as `alias_used_on` (`server/src/db/schema.ts:269`), for the
same reason. `source` drives the UI ("bound when you signed up at
facebook.com") and distinguishes user-declared bindings from automatic ones
during conflicts.

**`aliases.scopeMode`** — enum `'address' | 'domain'`, default `'address'`.
Not a scope; a *binding policy*. It says what granularity this alias records at
when it meets someone new: `address` writes only a contact, `domain` also
writes an `alias_scopes` row. Singular per alias, so it is a column, and it is
what lets a freshly minted alias with no bindings still know what to do the
first time it is used.

**`alias_used_on` stays as it is** — SimpleLogin wire-compat feeding the
`recommendation` field (`routes/aliasNew.ts:227`), keyed on a *website
hostname*. Populate it and `alias_scopes` from the same mint-time signal; do
not overload one table with two jobs.

Registrable domains come from `tldts`, already in the tree transitively via
mailauth — promote it to a direct dependency. `mail.facebook.com` collapses to
`facebook.com`; `foo.co.uk` does not collapse to `co.uk`.

## The four minting paths

| # | path | scopeMode | recorded at mint |
|---|---|---|---|
| 1 | Browser extension filling an email field on `example.com` | `domain` | `alias_scopes` row for `example.com` |
| 2 | Mobile share sheet / password-manager / Android autofill | `domain` | `alias_scopes` row for the site's domain |
| 3 | Manual creation (dashboard, API, no hostname) | `address` (default) | nothing |
| 4 | Cold send to an address that resolves to nothing | `address` | the contact minted by the send |

Paths 1 and 2 are declarations of intent: the extension knows it is filling an
email input on a signup form, so the counterparty is a product or a service,
not a person. That signal is the entire basis for domain scope — it is never
inferred from the recipient address alone.

The extension can also mint with no field association, which lands on path 3.

Path 3 produces an alias nothing resolves to until it is bound: by its first
cold send (a contact), or by the user in the UI (either level).

## Resolution

Runs only when MAIL FROM is one of the user's verified mailboxes and the
recipient is not a reverse alias — exactly where `submission.ts:277` refuses
today. Send mode and reverse-alias replies are untouched.

For each envelope recipient:

1. **Contact** — a `contacts` row for this user with `websiteEmail` = the
   recipient, under an enabled alias. The memo: exact, needs no
   classification, always safe.
2. **Domain scope** — an `alias_scopes` row for the recipient's registrable
   domain. Subject to the shared-domain guard below.
3. **Nothing** — mint an alias, `scopeMode = 'address'`, and let the send's own
   `findOrCreateContact` record the pairing.

Earlier tiers beat later ones: a contact always overrides a domain scope, so
one deliberate exception at a company never gets overwritten by the company's
own scope.

Within a tier returning several candidates:

- Drop aliases where `enabled = false`. This is what makes revoke-and-replace
  work with no configuration — the leaked alias falls out, its replacement
  takes over.
- A `pinned` binding wins outright.
- Otherwise most-recently-created wins, subject to open question 3.

## Conflicts and refusals

**Mixed scopes in one message.** `To: dev@facebook.com, Cc: kat@gmail.com`
resolves to two aliases, and a message has one `From:`. This is already a hard
refuse (`MIXED_ALIASES`), but under resolution it goes from rare to routine.
Refuse with a 550 naming both recipients and both aliases — silently picking
one is precisely how you leak. The user's remedy is to send two messages, or to
set MAIL FROM explicitly.

**Ambiguity within a scope.** Several enabled aliases, no pin. See open
question 3.

**Own-mailbox and local-address recipients.** Unchanged — the existing
refuse-to-leak screens (`isOwnMailboxAddress`, `refusesLocalAddress`) run
before any of this.

## The shared-domain guard

A domain binding whose value is a known shared-mailbox provider
(`gmail.com`, `outlook.com`, `proton.me`, `icloud.com`, `yahoo.com`, …) must
never resolve. Framed as a **resolution-time invariant rather than a mint-time
check**, because a bad binding can arrive from directions the extension never
sees: the legacy import, a manual UI entry, an API caller, a future minting
path nobody has written yet. Enforcing it at the point of use covers all of
them at once.

MX is not a usable signal — half the organizational domains on earth are Google
Workspace, so `acme.com` and `gmail.com` look identical from the MX. The list
has to be domain-based. The sibling `disposable-email-domains` repo is the same
shape of artifact and its tooling may be reusable, though it's a different list
for a different purpose.

*This section's rationale is not settled — see open question 1.*

## Legacy import

Ties into `plans/legacy-import.md`. The old system already worked this way:
`Virtual::findOrCreateBySourceDomainAndUser()` reused one virtual per
correspondent domain per user, recorded in `virtuals.sourceDomain`.

- `virtuals.sourceDomain` non-empty → `scopeMode = 'domain'` plus an
  `alias_scopes` row for `registrable(sourceDomain)`, `source = 'import'`.
- `virtuals.sourceDomain` empty → `scopeMode = 'address'`, no binding.
- The shared-domain guard applies to imported bindings like any other, which is
  the main reason it belongs at resolution time.

Imported aliases therefore arrive already bound, and the behavior a long-time
virtu user is used to carries over intact.

## Open questions

1. **The shared-domain guard's real justification.** The resolution-time
   framing above is one argument. The mint-time failure I originally proposed
   (minting domain scope while browsing webmail) doesn't actually occur, since
   the extension only sets domain scope when filling an email input on a signup
   form. What's the reasoning that should drive the list's contents and its
   placement?
2. **Auto-promotion.** After N address-scoped aliases accumulate at one
   registrable domain, should the UI offer to merge them into a domain scope?
   Useful against sprawl; the guard would suppress the offer for providers.
   Not obviously worth the complexity.
3. **Ambiguity policy.** Most-recent-wins is predictable but arbitrary.
   Refuse-and-name is safe but turns a normal send into an error the MUA
   renders badly. Possibly: most-recent-wins when all candidates share a
   `source`, refuse otherwise.
4. **Related-domain grouping.** `facebook.com` / `fb.com` / `facebookmail.com`
   / `meta.com` are one counterparty and four registrable domains. Manual
   multi-binding already covers it (that's what the many-to-many is for), but
   nothing suggests the grouping to the user.
5. **Explicit override for the 1%.** Send mode already covers it for mutt. Is a
   plus-tag on MAIL FROM (`me+aliasname@mailbox.com`) or an `X-Virtu-Alias:`
   header worth adding for clients that can set neither?
6. **Bcc.** Does a Bcc recipient participate in scope resolution and the
   mixed-scope refusal? It's not in `To:`/`Cc:`, so the header screen doesn't
   see it, but it is an envelope recipient.
