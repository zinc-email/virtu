# Legacy import — plan (not started)

Go live with virtu-ts on the box that runs the legacy PHP/postfix stack
today, carrying the legacy MySQL data into the new Postgres. Decided
2026-09-09; nothing below is built yet. Companion to README "Deploy",
`STATE.md` "Not started" and `ABUSE.md` (which accounts come across).

## The shape

**Same box, MySQL stays up, one script, rehearsed from a dump first.**

- The legacy stack (postfix, php-fpm, web on 443/25/587) is stopped; its
  MariaDB keeps running on `127.0.0.1:3306`. The serve stack comes up on
  the freed ports and publishes Postgres on `127.0.0.1:5433`. Both DBs
  are then reachable on loopback from the host, so the import runs on
  the host with the box's bun (`bin/host-provision` installs it for
  exactly this "break-glass CLI on the host" case), never inside the
  api container (a container's loopback is not the host's).
- **One importer, two sources.** `server/src/scripts/legacyImport.ts`
  reads MySQL through Bun's native SQL client (`new SQL("mysql://…")`,
  supported since Bun 1.3 — no new dependency) and writes Postgres
  through the server's drizzle. `MYSQL_URL` points at either the live
  MariaDB on the box or a throwaway `mariadb:10.6` container loaded from
  a `mysqldump`. The dump path is the rehearsal path on a workstation
  and the fallback on the box if MySQL is ever not running; it is the
  same code either way, which is what makes the rehearsal meaningful.
- **Idempotent and re-runnable.** Every insert is keyed on the legacy
  id (ids are preserved, see below), so a second run is a no-op and a
  partial failure is rerun, not cleaned up. Wrapped in one transaction
  per table group; `--dry-run` prints the counts and stops.
- **Legacy ids are preserved.** `users`, `domains`, `aliases`,
  `email_logs` keep the legacy `id`. The new tables are
  `generated always as identity`, so inserts use
  `OVERRIDING SYSTEM VALUE` and the script ends with
  `setval(pg_get_serial_sequence(...), max(id))` per table. Legacy ids
  fit `integer` by three orders of magnitude (13k users, 81k aliases
  ever minted, 596k messages). Preserving them is what makes the run
  idempotent and keeps `ABUSE.md`/`docs/abuse/` evidence (written in
  legacy ids) usable against the live DB.

Rejected: a SQL-only ETL (`mysqldump | sed | psql`). The mapping is not
column-to-column (mailboxes and contacts do not exist in legacy; reverse
aliases must be minted; identity columns need `OVERRIDING SYSTEM VALUE`),
and the server's drizzle schema is the one definition of the target
shapes — a hand-written SQL file would be a second copy that drifts.

## Cutover runbook

Preconditions on the box: serve stack env files written (README "Deploy
→ A new box"), DNS untouched (same IP, same MX host), `ALIAS_DOMAINS` set
to the legacy public domains (below), `SIGNUP_INVITE_ONLY=1`.

1. **Freeze.** Stop postfix and php-fpm/web (`docker compose stop` for
   the legacy compose, or the systemd units if they run on the host);
   leave `db` (MariaDB) running. Inbound mail queues at senders' MTAs
   for the gap — SMTP retries cover hours.
2. **Backup.** `mysqldump virtu | gzip > /opt/virtu/backups/legacy-$(date -I).sql.gz`
   and copy it to the workstation. This is both the rollback point and
   the rehearsal input.
3. **Bring up the new stack** (`bin/host-deploy <tag>`), confirm
   `db-migrate` applied the ledger and `/meta/health` is green.
4. **Import:** `MYSQL_URL=mysql://virtu:…@127.0.0.1:3306/virtu
   DATABASE_URL=postgres://virtu:…@127.0.0.1:5433/virtu
   bin/legacy-import --dry-run`, read the counts, then without
   `--dry-run`.
5. **Verify** (checklist below), then `bin/admin-grant`,
   `bin/operator-mail --on`, and send a real message to a migrated alias
   and a reply from its mailbox.
6. **Do not run `bin/dkim-ensure` for the service domain** until DNS is
   ready to change — the import carries the legacy signing keys under
   their legacy selectors so the published DKIM records stay valid (see
   `dkim_keys` below).

Rollback: `docker compose down` the serve stack, start the legacy stack
again. MariaDB was never written to, so there is nothing to restore.
Keep MariaDB up for a week after cutover, then dump once more and stop it.

## Mapping, table by table

Legacy semantics from `tmp/virtu/server/src/lib/Model/*.php`; target
shapes from `server/src/db/schema.ts`.

**Which accounts come across.** A legacy user is imported when
`users.deleted = 0` and `users.accountId IS NOT NULL` (accountId-NULL is
legacy's provisional state; `PLAN.md` decision on `users.activated`
mirrors it) and the account is not abuse-flagged (`users.abuseFlags = 0`;
run `tmp/abuse-flag-legacy.sql` on MariaDB **before** the dump so the
2,083 farm accounts carry the flag). Skipped users still contribute
tombstones: every virtual they ever held goes into `deleted_aliases`
(reason `legacy_abuse` / `legacy_deleted` / `legacy_provisional`), so no
farmed address can be re-minted, and `SIGNUP_INVITE_ONLY` keeps their
mailboxes from signing up fresh.

| Legacy | New | Notes |
|---|---|---|
| `users` (kept set) | `users` | `id`, `email` (lowercased), `name`, `createdAt`/`updatedAt`; `activated=true`; `flags=0`; `passwordHash` dropped (passwordless now). `trialEnd` per the billing decision below. `disabled=false`. |
| `users.email` | `mailboxes` | One row per user: `email=users.email`, `verified=true` (legacy verified it at signup), and `users.defaultMailboxId` → it. Legacy has no mailbox table; this row is the "self-mailbox" `graduateUser` would have created. |
| `accounts` | — | Only `ownerId`/`domainId`/`active` are read. `domainId` (the account's preferred domain) → `users.defaultAliasDomain` when it is a public domain. The script asserts each account has exactly one user and stops if not (multi-user accounts were designed for but never shipped). |
| `domains` where `free=1` | — (env) | The public alias domains. Not rows: `ALIAS_DOMAINS=<legacy free domains, id order>`, first = `MAIL_DOMAIN`. The script prints the list it found and refuses to run if `ALIAS_DOMAINS` does not contain every one of them. |
| `domains` where `free=0`, `deleted=0`, owner kept | `domains` | `id`; `userId=accounts.ownerId`; `nameRequested=name`; `verifiedOwner=verified` (legacy proved control via CNAME/MX — accepted as ownership; the generated `name` column then makes it live), `verifiedMx/Dkim/Spf/Dmarc` straight across; `ownershipTxtToken` minted (`newOwnershipToken()`) so the DNS page has a token to show; `catchAll=false`; `nbFailedChecks=0`. |
| `virtuals` where `deleted=0`, `disabled` any, user kept | `aliases` | `id`; `email` lowercased; `name=displayName` (empty → null); `enabled = !disabled`; `mailboxId` = the user's self-mailbox; `domainId` = the custom domain's id or null for public domains; `note=sourceUrl` (empty → null); `createdAt`. |
| `virtuals.sourceDomain` | `alias_used_on` | When non-empty: `(aliasId, userId, hostname=sourceDomain)`. Drives the extension's recommendation. |
| `virtuals` where `deleted=1`, or owner skipped | `deleted_aliases` | `email`, `aliasId=id`, reason as above. Never an `aliases` row. |
| `messages` | `contacts` + `email_logs` | One `contacts` row per distinct `(virtualId, lower(fromEmail))` with `websiteEmail=fromEmail`, `name=fromName`, a freshly minted `replyEmail` (`buildReverseAliasAddress`, retry on unique violation), `automaticCreated=true`; then one `email_logs` row per message: `id`, `userId`, `contactId`, `aliasId`, `mailboxId`, `isReply=false`, `isSpam = flag & FLAG_UNTRUSTED`, `createdAt=sentAt`. This is what fills the alias detail page's activity and gives every legacy correspondent a reverse alias to reply through. `headers`/`subject`/`secretHash` dropped (the per-message `ret-` bounce paths die with the legacy queue). Depth is a decision below. |
| `channels` where `trust=3` (BLOCK) and `endpoint` contains `@` | `contacts.blockForward=true` | Find-or-create the contact for `(virtualId, endpoint)`; `blockForward=true`. Account-level blocks (`virtualId` null) and domain endpoints have no target and are logged and skipped. TRUST/DISTRUST/NA and the counters are dropped — the new pipeline has no trust model (`FILTERS.md` was not carried into PLAN.md). |
| `dkimKeys` for kept custom domains **and** for the public domains | `dkim_keys` | `domain=domainName`, `selector` verbatim (legacy minted timestamp selectors, e.g. `20181006003900z`), `privateKeyPem=privateKey` (already PKCS#1 PEM), `publicKeyBase64` = the `p=` value parsed out of the stored TXT string, `algorithm=rsa-sha256`, `active=true`. `loadDkimKey` prefers the configured selector and otherwise takes the first active key for the domain — so with no `mail`/`dkim` row present the legacy key signs and the published DNS record stays correct with **no DNS change at cutover**. Rotating onto the new selectors is a later, per-domain DNS step. |
| `subscriptions`, `transactions`, `paymentMethods` | — | Braintree; the new lane is Stripe-only (PLAN Lane I). Read once for the billing decision below, never imported. |
| `authKeys`, `tokens`, `entities`, `dkimLookups`, `surveys`, `migrations` | — | Login keys, one-time tokens, sender-entity cache, ODKIM lookup cache, surveys. Not carried. Everyone logs in again with an emailed code; API keys and the browser extension re-pair. |

Nothing legacy maps onto `api_keys`, `smtp_credentials`,
`verification_codes`, `invites`, `alias_mailboxes`, `outbound_messages`,
`smtp_rejections`, `destination_throttles`, `notifications`,
`sent_alerts`. They start empty.

## Decisions to take before building

1. **Paying customers.** Braintree subscriptions cannot move to Stripe.
   Recommended: accounts with a live subscription (`canceledAt IS NULL`
   or `paidThrough > now`) get `users.trialEnd = greatest(paidThrough,
   now + 90 days)`; everyone else gets `trialEnd = now + 30 days` (the
   7-day signup trial is for strangers, not a migration). Alternative:
   `lifetime=true` for anyone who ever paid. Note `isPremium` returns
   true for everyone while Stripe is unconfigured on the box, so this
   only bites once billing goes live.
2. **Message history depth.** Recommended: all of it for kept users
   (the 596k total is dominated by the skipped farm accounts; the
   remainder is small) — it is the users' activity and their reverse
   aliases. Alternative: last 12 months, which drops contacts for
   dormant correspondents.
3. **Flagged accounts: skip (recommended) vs import disabled.** Skipping
   with tombstones keeps the DB clean; importing with
   `users.disabled=true` keeps the evidence queryable in Postgres. The
   evidence already lives in `docs/abuse/` keyed by legacy id, which
   the preserved ids keep valid, so skip.
4. **Legacy-verified custom domains as owner-verified.** Recommended
   yes (above). The alternative — import them unverified and make every
   custom-domain user publish a TXT token before their aliases route —
   is a cutover-day outage for exactly the users who care most.

## Verification checklist (the script prints most of this)

- Counts: kept users = MySQL `count(*) where deleted=0 and accountId is
  not null and abuseFlags=0`; aliases = live virtuals of kept users;
  tombstones = everything else that ever held an address;
  `aliases.email ∪ deleted_aliases.email` = all `virtuals.email` (no
  address is neither live nor tombstoned).
- Every kept user has `defaultMailboxId` set and exactly one mailbox.
- Every `email_logs` row resolves `contactId` → `aliasId` → `userId`
  consistently; every contact's `replyEmail` is unique and on
  `MAIL_DOMAIN`.
- `select setval(...)` ran for every preserved-id table (next insert via
  the API must not collide).
- `dkim_keys`: one active row per public domain and per kept custom
  domain; `bin/dkim-ensure --check`-style comparison of each row's
  `p=` against the live DNS TXT for its selector.
- Real traffic: forward to a migrated alias arrives DKIM-passing at
  Gmail; reply from the mailbox through a freshly minted device
  password reaches the correspondent from the alias.

## Build list (when this lands)

- `server/src/scripts/legacyImport.ts` + `bin/legacy-import`
  (`#!/usr/bin/env bash` wrapper that runs bun on the host, not
  `bin/server-run`, and requires `MYSQL_URL` + `DATABASE_URL`).
- `docker-compose.legacy.yml`: a `mariadb:10.6` service that loads
  `LEGACY_DUMP` from `/docker-entrypoint-initdb.d`, published on
  `127.0.0.1:3307` — the rehearsal source. `just legacy-up` /
  `legacy-down` / `legacy-import`.
- A unit-tier test for the pure mapping functions (TXT `p=` extraction,
  the keep/skip predicate, the alias/tombstone split) and a rehearsal
  note in `STATE.md` with the counts from the real dump.
- After landing: settled decisions move into PLAN.md (cutover model,
  legacy DKIM selectors kept), progress into STATE.md; this file stays.
