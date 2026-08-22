# Alias resolution: sending without reverse aliases

*Working draft, started 2026-08-21. Not settled — see "Open questions". This
plans the outbound side of PLAN Milestone 2: how `submission` picks which alias
a message goes out as, when the user's MUA only knows their real mailbox.*

## The problem

`resolveOutbound` (`server/src/submission.ts:239`) picks a mode from MAIL FROM
via `senderOwnership` (`server/src/pipeline/policy.ts:356`):

- **MAIL FROM = an alias** → *send mode*. Any outside recipient is a cold email;
  a contact is minted, `From:` is rewritten to the alias. The alias was
  declared, so nothing needs inferring.
- **MAIL FROM = a mailbox** → *reply mode*. Every recipient must be a reverse
  alias resolving to the same alias. A real outside address is refused at
  `submission.ts:277`.

Send mode requires setting the envelope sender per-alias, which mutt does and
roughly no other MUA does well. So in practice a stock client is stuck in reply
mode, and reply mode can't start a conversation.

**Design position: reverse aliases are a maintenance burden and a cognitive
tax, not a feature.** They stay in the product — they're how inbound replies
work, they're the explicit escape hatch, and they're the fallback when
resolution is ambiguous — but they must not be the price of sending a normal
email to a new person.

## Prior art: nobody does this

| | who picks the alias | cost |
|---|---|---|
| SimpleLogin | the user, via a reverse alias in `To:` | dashboard visit per cold contact |
| Addy.io | the user, via an encoded recipient (`first+hello=example.com@…`) | no dashboard, still a hand-built address; paid tiers only |
| Apple Hide My Email | the mail client | requires owning the client |
| **this plan** | the server, from a recorded scope | the server has to be right |

SimpleLogin's reverse alias is a clever dodge: it moves alias selection out of
`From:` (which MUAs won't let you set) into `To:` (which they all will). The
side effect is that the "which alias?" question never reaches the server — the
user answers it by hand every time. [Discussion #1770](https://github.com/simple-login/app/discussions/1770)
asked for exactly what this plan describes; the maintainers didn't take it up.

Deleting the user-side step necessarily moves the decision server-side. That's
the whole design problem below.

## The scope model

An alias binds to a **correspondent scope** — the unit of counterparty identity:

| recipient | scope | why |
|---|---|---|
| `dev@facebook.com` | `domain:facebook.com` | the domain *is* the counterparty; everyone behind it is one relationship |
| `kat@gmail.com` | `address:kat@gmail.com` | the domain is infrastructure; the counterparty is the person |

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

## Why not something simpler

Legacy virtu's rule was one line — `findOrCreateBySourceDomainAndUser()`, one
alias per correspondent domain, forever. No modes, no bindings, no lists. It
worked for years, and any design that replaces it owes an explanation.

It has exactly one hole, and it is the reason this plan exists: under pure
domain scoping `joe@gmail.com` and `kat@gmail.com` share an alias, so two
unrelated people can correlate you.

The smallest possible fix is **a provider list and nothing else**. Scope is the
registrable domain, unless that domain is a known shared-mailbox provider, in
which case scope is the full address. One rule, one list, no `scopeMode`, no
binding table — the scope is derived from the recipient at send time and kept
as a single value on the alias. That covers both motivating examples above and
it is genuinely simple.

What the extra machinery buys:

- **Independence from list completeness, in the direction that matters.** If
  the list is the only mechanism, every domain *not* on it defaults to domain
  scope — so an unlisted provider (regional, new, small, self-hosted) silently
  shares one alias between strangers. That is the privacy failure, arriving by
  omission, and omission is the failure mode a curated list is worst at. The
  extension's "this is a signup form" signal is positive evidence that does not
  degrade as the list goes stale.
- **Multi-binding** — `facebook.com` + `facebookmail.com` + `fb.com` as one
  scope. A convenience; see open question 4.
- **Pinning** — two live aliases on one scope, deterministically ordered. Also
  a convenience.

The honest accounting: the first bullet justifies the design, the other two are
conveniences that ride along. If the extension signal proves unreliable in
practice, or the provider list proves easy to keep complete, the simpler
version is the better system and this plan should be cut back to it. Worth
re-checking that judgement before any of this is built.

## Two facts, two homes

**`aliases.scopeMode`** — enum `'address' | 'domain'`, default `'address'`.
The granularity at which this alias acquires *new* bindings. Singular per
alias, so it's a column. This is what makes a freshly created alias with no
bindings still know what to do the first time it's used.

**`alias_scopes`** — the actual bindings that resolution looks up.
Many-to-many in both directions (one alias covers several domains after manual
additions; one domain can have several aliases after a revoke-and-replace), so
it's a table.

```
alias_scopes
  id
  userId    integer  -> users.id   on delete cascade   (denormalized for the lookup index)
  aliasId   integer  -> aliases.id on delete cascade
  kind      varchar(8)   'domain' | 'address'
  value     varchar(512) registrable domain (lowercased), or full address (lowercased)
  source    varchar(16)  'extension' | 'mobile' | 'manual' | 'cold_send' | 'inbound' | 'import'
  pinned    boolean default false
  createdAt / updatedAt

  unique (aliasId, kind, value)
  index  (userId, kind, value)                        -- the resolution lookup
  unique (userId, kind, value) where pinned           -- at most one pin per scope
```

`userId` is denormalized so RCPT-time resolution is a single index hit with no
join — same shape as `alias_used_on` (`server/src/db/schema.ts:269`), which
carries both for the same reason.

`source` is for the UI ("bound when you signed up at facebook.com") and for
telling user-declared bindings apart from automatic ones during conflicts.

**`alias_used_on` stays as it is.** It's SimpleLogin wire-compat (it feeds the
`recommendation` field, `routes/aliasNew.ts:227`) and its column is a *website
hostname*. Populate both from the same signal at mint time; don't overload one
table with two jobs.

Registrable domains come from `tldts`, already in the tree transitively via
mailauth — promote to a direct dependency. `mail.facebook.com` and
`facebook.com` collapse; `foo.co.uk` does not collapse to `co.uk`.

## The four minting paths

| # | path | scopeMode | binding written |
|---|---|---|---|
| 1 | Browser extension filling an email field on `example.com` | `domain` | `domain:example.com` |
| 2 | Mobile share sheet / password-manager / Android autofill on a known app or site | `domain` | `domain:example.com` |
| 3 | Manual creation (dashboard, API, no hostname) | `address` (default) | none yet |
| 4 | Cold send to an address with no resolving alias | `address` | `address:<recipient>` |

Paths 1 and 2 are declarations of intent: the extension knows it is filling an
email input on a signup form, which means the counterparty is a product or
service, not a person. That signal is the whole basis for domain scope, and
it's why domain scope is never inferred from the address alone.

The extension can also mint with no field association at all — that lands on
path 3, mode `address`, no binding.

Path 3 produces an alias that is never auto-selected until something binds it:
either the first cold send (which binds at whatever `scopeMode` says) or the
user, in the UI.

## Resolution

Only runs when MAIL FROM is one of the user's verified mailboxes and the
recipient is not a reverse alias — i.e. exactly where `submission.ts:277`
refuses today. Send mode and reverse-alias replies are untouched.

For each envelope recipient:

1. **Exact address binding** — `alias_scopes` where `kind='address'` and
   `value` = the recipient. Never needs classification; always safe.
2. **Domain binding** — `alias_scopes` where `kind='domain'` and `value` = the
   recipient's registrable domain. Subject to the shared-domain guard below.
3. **Existing correspondence** — a `contacts` row for this user with
   `websiteEmail` = the recipient, under an enabled alias. Covers aliases that
   predate scopes and anything imported without one.
4. **No match** — mint a new alias, bind `address:<recipient>`, `source`
   `cold_send`.

Within any tier that returns several candidates:

- Drop aliases where `enabled = false`. This is what makes revoke-and-replace
  work with no configuration: the leaked alias falls out, its replacement takes
  over.
- A `pinned` binding wins outright.
- Otherwise the most recently created binding wins, and the refusal path below
  applies if that's judged too arbitrary (open question 3).

Earlier tiers always beat later ones — an exact address binding overrides a
domain binding on the same message.

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
  `alias_scopes` row `domain:<registrable(sourceDomain)>`, `source = 'import'`.
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
