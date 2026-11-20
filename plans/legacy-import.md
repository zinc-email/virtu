# Legacy import: virtu (PHP/MariaDB) → virtu-ts (Bun/Postgres)

*Drafted 2026-08-19 from a read of `~/projects/virtu/server/src/schema.sql`,
`lib/Model/*.php`, `lib/Email/Controller/Table.php` and this repo's
`server/src/db/schema.ts`. This is the execution plan for the data-migration
lane; nothing here is built yet.*

## Verdict on the proposed approach

Yes — mysqldump → ephemeral MariaDB alongside Postgres → idempotent transfer
script is the right shape, with one refinement: keep the **transform pure**.

```
mysqldump (prod)  →  tmp/legacy.sql
                     ↓  bin/legacy-db-up        (mariadb container, compose profile `migrate`)
                     ↓  bin/legacy-import       (bun: read MySQL → map → upsert Postgres)
                     ↓  bin/legacy-verify       (row counts + spot-check invariants)
```

Structure the importer as `read (mysql2) → pure map → write (drizzle)` so the
mapping functions are `*.unit.test.ts` with fixture rows, and the loader is an
`*.int.test.ts` against the dockerized Postgres. That matters more than usual
here, because you will run this thing dozens of times in rehearsal and exactly
once for real.

**Idempotency comes free from natural keys.** Every entity we need to import
already has a unique index in the new schema:

| entity | natural key | new index |
|---|---|---|
| user | `email` | `users.email` unique |
| mailbox | `(userId, email)` | `mailboxes_user_id_email_uq` |
| alias | `email` | `aliases.email` unique |
| custom domain | `(userId, nameRequested)` | `domains_user_id_name_requested_uq` |
| contact | `(aliasId, websiteEmail)` | `contacts_alias_id_website_email_uq` |
| dkim key | `(domain, selector)` | `dkim_keys_domain_selector_uq` |
| tombstone | `email` | `deleted_aliases.email` unique |

So every write is an `onConflictDoUpdate` / `onConflictDoNothing`, and the run
carries an in-memory `legacyId → newId` map per table. **No `legacy_id` columns,
no `OVERRIDING SYSTEM VALUE`, no PK preservation** — the new tables use
`generatedAlwaysAsIdentity()` and legacy IDs would collide with rows already in
zinc/lmnop. The one exception is `email_logs`, which has no natural key; see
"Open decision 1".

Run order is forced by FKs: users → mailboxes → back-fill `users.default_mailbox_id`
→ domains → dkim_keys → aliases → alias_used_on → contacts → (email_logs) →
deleted_aliases.

## Structural mismatches worth knowing before you start

Three shape changes, none fatal:

1. **Legacy `users.email` is doing two jobs.** `Table.php:queryAddress` returns
   `$user->email` as the forwarding destination, and the same column is the
   login identity. The new system splits these: `users.email` (login) and
   `mailboxes.email` (destination). One legacy user therefore becomes one
   `users` row **plus** one `mailboxes` row (same address, `verified: true`,
   since delivery to it was already working), with `users.default_mailbox_id`
   pointing at it. `userEmails` exists in the dump's DDL but is dead — zero
   references anywhere in the PHP.

2. **`accounts` collapses into `users`.** Legacy has an `accounts` layer owning
   domains, billing and possibly several users (`users.accountId`,
   `accounts.ownerId`). The new model is per-user. For the common case
   (one account, one user) this is a straight fold: `accounts.domainId` →
   `users.defaultAliasDomain`. **The dump will tell us whether any account has
   more than one user** — `SELECT accountId, COUNT(*) FROM users WHERE deleted=0
   GROUP BY accountId HAVING COUNT(*) > 1`. If that returns rows, those users
   share custom domains and a subscription and the new schema can't express it;
   they'd need to be split by hand, with the domain landing on the owner.

3. **`channels` is not `contacts`.** Reading `Model/Channel.php`, a channel is a
   trust/policy edge between an *endpoint* (an external mailbox **or** an
   external domain) and either a virtual or the whole account. The new
   `contacts` table only models (alias, correspondent-mailbox) pairs. So:
   - channel with `virtualId` + a mailbox-shaped `endpoint` → `contacts` row,
     `blockForward = (trust == ChannelPolicy::BLOCK)`.
   - channel with a **domain-shaped** endpoint, or with `virtualId IS NULL`
     (account-level default) → **no equivalent exists.** The new system has no
     domain-level or account-level block rule.

   That last bullet is a genuine feature gap, not just a migration gap. It's
   probably a small number of rows; the dump will say.

## Field-by-field mapping

### Migrates cleanly

| legacy | new | notes |
|---|---|---|
| `users.email` | `users.email` + a `mailboxes` row | see mismatch 1; mailbox `verified: true` |
| `users.name` | `users.name` | truncate 127 → 128 is fine |
| `users.createdAt/updatedAt` | same | MariaDB `datetime` is UTC-naive; treat as UTC |
| `accounts.domainId` | `users.defaultAliasDomain` | resolve to the domain *name* |
| `domains` (free=0, deleted=0) | `domains` | `accountId` → owner's `userId` |
| `domains.verifiedMx/Dkim/Spf/Dmarc` | same four columns | `verifiedCname` has no counterpart (dropped) |
| `virtuals` (deleted=0) | `aliases` | `email`, `userId`, `disabled` → `!enabled`, `displayName` → `name`, `createdAt` |
| `virtuals.domainId` | `aliases.domainId` | **NULL** when the legacy domain is `free=1` |
| `virtuals.sourceDomain` / `sourceUrl` | `alias_used_on.hostname` | this is exactly what the column is for |
| `virtuals` (deleted=1) | `deleted_aliases` | tombstone, `reason: "legacy_import"` — keeps dead addresses unreusable |
| `channels` (mailbox endpoint + virtualId) | `contacts` | `endpoint` → `websiteEmail`; `replyEmail` freshly minted |
| `dkimKeys` | `dkim_keys` | see below — **these are reusable** |

**The DKIM keys are the quiet win.** `DkimKeyGen::generate` stores
`privateKey` as the opendkim-genkey `.private` file (PKCS#1 PEM — mailauth
accepts it as-is → `privateKeyPem`) and `publicKey` as the whole DNS TXT body
with quotes and whitespace stripped, i.e. `v=DKIM1;h=sha256;k=rsa;p=MIIB…`. The
new schema wants only the `p=` value in `publicKeyBase64`, so the import parses
that out. Do this and **custom-domain users never have to republish their DKIM
record** — the DNS they already have keeps validating against the new signer.

### Deliberately dropped

`users.passwordHash` (new auth is passwordless — a UX upgrade, no migration
needed, but announce it), `users.clientIp` (no column), `authKeys` (JWT
keypairs; the new API uses `Authentication:` API keys), `tokens` (one-time
nonces), `dkimLookups` (a cache), `entities` (global sender-name registry,
rederivable), `surveys`, `virtuals.senderCount` / `lastMessageAt` /
`lastMessageId` (derivable), `virtuals.flag`, `virtuals.entityId`.

### The three that need a decision — see below

`messages`, the Braintree billing tables, and the shared (`free=1`) domains.

## Hard problems

### 1. Billing does not migrate. At all.

Legacy is Braintree (`subscriptions.braintreeId`, `paymentMethods.token`,
`transactions`); new is Stripe. There is no Stripe customer, no payment method,
no card on file to move — a paying customer's card data lives in Braintree's
vault and cannot be exported into Stripe without a PCI-scoped vault-to-vault
transfer request through both providers.

Practical mitigation: read `subscriptions.paidThrough` per account and set
`users.trialEnd` to it (or later), so nobody loses service at cutover, then
email them to re-subscribe. `users.lifetime` is available for grandfathering.
Either way this is the item with real customer impact, and it wants a decision
before the script is written, not after.

### 2. Old reply and bounce addresses stop working

Legacy reverse paths are **per-message and stateless**:
`ret-{obfuscated messageId}-{secret}@zbounces.{domain}`, validated in
`Table.php:queryBounceAddress` by re-deriving the message row and checking
`secretHash`. The new system uses stored per-contact reverse aliases
(`contacts.replyEmail`) plus HMAC VERP for bounces. These schemes are not
compatible, and the legacy one can't be reconstructed anyway once the
`messages` rows are gone.

Consequence: every `ret-…@zbounces.*` address sitting in a user's sent folder
or in a correspondent's address book goes dead at cutover. Three options,
cheapest first:

- **Accept it.** Old threads break; new mail from the same sender mints a
  working contact on first receipt.
- **Bounce politely.** Keep `zbounces.*` MX pointed at the new server and
  return a 550 with a human-readable "this address has been retired" — costs a
  few lines in `pipeline/policy.ts`.
- **Full compat shim.** Import `messages` (id + secretHash + from), teach the
  new MX to parse the `ret-` form, and map it to the imported contact. Real
  work, and it keeps a legacy code path alive indefinitely.

### 3. One shared mail domain, possibly several legacy ones

The new config has a single `mailDomain` (`server/src/config.ts:37`) used for
minting aliases, reverse aliases and VERP. Legacy models shared domains as
`domains` rows with `free=1` (the reset fixture seeds `a.virtu.email`;
production is presumably `a.zinc.email` and possibly others).

The good news: **inbound routing does not care.** `pipeline/policy.ts:194`
resolves a recipient by exact `aliases.email` match with no domain constraint,
so imported aliases on any legacy free domain keep receiving as long as that
domain's MX points at the new server. What's single-domain is only *outbound*
address generation. So a multi-free-domain legacy prod imports fine; users on
the secondary domains just get new aliases and reverse aliases on `mailDomain`.

`SELECT id, name FROM domains WHERE free = 1 AND deleted = 0` answers this.

### 4. Everything that isn't in the database

- **Browser-extension users must re-auth** — legacy extension holds a JWT from
  `authKeys`; the new API wants an API key.
- **Service-domain DKIM** must either be imported (preferred, per above) or the
  DNS republished from `dkim_keys` before the MX flip.
- **In-flight mail.** Postfix's queue on the legacy box is not migratable;
  drain it before flipping MX rather than after.

## Cutover shape

The script being idempotent is what makes this safe — rehearse freely, then run
it once more at the end for the delta.

1. Rehearse repeatedly against a scratch Postgres from a recent dump. Iterate
   on the mapping until `bin/legacy-verify` is clean.
2. Publish `dkim_keys` DNS for the shared domain(s) if not importing.
3. Freeze: stop legacy web writes (alias creation), let mail keep flowing.
4. Final `mysqldump`, final import run (delta only, by natural-key upsert).
5. Flip MX + web DNS to the new box. Watch `virtu_*` metrics and
   `outbound_messages`.
6. Keep the legacy box up but MX-less for a rollback window; keep the final
   dump forever as the lossless archive.

## Deliverables

Following repo convention (`bin/` scripts, one-line justfile recipes,
concern-first naming):

- `docker-compose.migrate.yml` (or a `migrate` profile) — a `mariadb:10.5`
  service on the dbnet, loading `tmp/legacy.sql` on boot. Never in the default
  `just up`.
- `bin/legacy-db-up` / `bin/legacy-db-down`
- `bin/legacy-import` → `server/src/scripts/legacyImport.ts`, with `--dry-run`
  and a per-table summary (inserted / updated / skipped-with-reason).
- `bin/legacy-verify` → row-count reconciliation plus invariants: every
  imported alias resolves through `evaluateRcpt`, every user has a default
  mailbox, no alias points at an unverified mailbox.
- `server/src/scripts/legacy/map.unit.test.ts` — the pure mapping, fixture-driven.
- `server/src/scripts/legacy/import.int.test.ts` — loader against real Postgres.
- `mysql2` added to `server/package.json` (Bun has no native MySQL driver).
- Justfile: `legacy-db-up`, `legacy-import`, `legacy-verify`.
- A `## Legacy import` section in STATE.md when it lands.

Rough size: the mapping and loader are a day; verification and the compose
plumbing another; the rehearsal loop is however long the surprises in the real
data take.

## Open decisions

1. **Import `messages` (the activity log)?** It's likely most of the 10MB
   (`headers` is a full header blob per message). `email_logs.contactId` is NOT
   NULL, so importing means synthesizing a contact per `(virtualId, fromEmail)`
   pair — which is arguably the *right* way to reconstruct `contacts` and makes
   "reply to an old sender" work from day one. But `email_logs` has nowhere to
   put `subject`, `headers` or `secretHash`, so the import is lossy no matter
   what, and it's the only table needing a `legacy_id` column for idempotency.
   Middle path: derive contacts from messages, skip the log rows, keep the
   dump as the archive.
2. **Braintree subscribers** — extend `trialEnd` to `paidThrough`, grandfather
   as `lifetime`, or require immediate re-subscription?
3. **Legacy `ret-` addresses** — accept the break, bounce politely, or build
   the compat shim?
