# STATE — progress against PLAN.md

Last updated: 2026-09-01 (Lane K P2 first slice — durable queue
attribution columns, per-user daily send quotas at submission pre-enqueue,
the `smtp_rejections` refusal log + retention, notifications API + bell UI
— PLUS the merge of the parked invite lane from 2026-08-22: ABUSE.md
Tier 0, `invites` table, `SIGNUP_INVITE_ONLY` graduation gate in
/auth/verify, `/api/admin/invites` mint/list/revoke + AdminInvites page +
Login invite flow, `bin/invite-create`). Companion to `PLAN.md` (the
design doc); this file tracks what is built, how it was verified, and
what remains.

## TL;DR

All nine PLAN lanes are implemented and merged, plus the outbound wave
(decisions #9–#12): submission now supports reply-from-mailbox (the contact
metadata picks the outbound alias), cold email straight from an alias,
per-device SMTP passwords, the per-user trash inbox for "off" aliases, and
one-copy-per-mailbox delivery for multi-mailbox aliases. The MVP loop is
closed and verified end to end: mail proxies through the full
verify → rewrite → sign/seal → queue → deliver pipeline inside the simulated
internet; the SimpleLogin-compatible API drives a working dashboard; billing
is live-verified against real (test-mode) Stripe. What remains is polish
(client gaps, deferred endpoints), a couple of explicitly-stubbed behaviors,
and the entire production/deploy story, which has not been started.

## Verification status

| Tier | Count | Command | Last state |
|---|---|---|---|
| Unit | ~477 tests / 37 files | `just test-unit` | green |
| Contract (bridge protocol) | 14 tests / 2 files | `just test-contract` | green |
| CI gauntlet | format + 2× tsc + SDK gen + unit + contract | `just check` | green |
| Integration (API vs real Postgres) | 152 tests / 12 files | `just up && just db push && just test-int` | green |
| Client DOM (real React vs running stack) | 16 tests / 6 files | `just up && just db push && just test-client` | green |
| Stories (simulated internet) | 24 stories / 13 files | `just test-net-up && just test-story` | green (2026-09-01, fresh volumes, post-P2 pipeline changes) |
| Live Stripe (test mode) | manual + watcher | see README billing section | verified 2026-08-08 |

Test-net gotcha found 2026-08-14: the `pg_test` volume had survived since
before the `domains` rename, and the mail container's boot-time
`drizzle-kit push --force` silently skipped the interactive rename question
(the same no-TTY exit-0 pitfall the deploy lane documents), so every story
failed on `column "domain_id" does not exist`. After a schema **rename**
(not additive changes), run `just test-net-down` (wipes volumes) before
`test-net-up`.

Story coverage: forward with `dkim=pass` at the receiving peer (M1), authed
reply with threading and zero real-address leakage (M2), bounce → auto-disable
at threshold (M3), DSN delivery + rate-limit suppression, custom-domain
forward AND custom-domain DKIM (`dkim=pass header.d=user.com` at initech),
transactional login-code email delivered through our own queue AND a bounced
verification email invalidating its code (transactional intake), policy edges
(nonexistent alias 550, disabled alias accept-and-drop, relay denied),
network smoke (peers verify SPF/DKIM/DMARC independently of our server),
the custom-domain API lifecycle (create → publish the exact GET .../dns
records via nsupdate → verify all five checks green → catch-all mints an
alias through the real pipeline → tombstones stay dead), and the outbound
wave: reply with MAIL FROM = the mailbox (contact metadata picks the alias),
mixed-alias recipients refused, cold email from an alias (`dkim=pass` at
initech + contact minted), Cc-of-own-mailbox refused, per-device SMTP
password lifecycle (API create → real 587 send → revoke → 535), disabled
alias → trash inbox with `X-Virtu-Trash` (and on-alias mail unmarked), and
multi-mailbox fan-out (one send → both Maildirs, one email_log per mailbox;
a dead extra mailbox detaches at the bounce threshold while the alias and
its healthy primary keep going, and re-adding it starts a fresh bounce
ledger — the detach writes a durable reset marker into sent_alerts).

The live Stripe pass caught a real bug the self-signed tests missed
(out-of-order `subscription.created` regressing status — fixed in `fdf36a2`
with a regression test encoding the observed sequence).

## Lane-by-lane

| Lane | Status | Notes |
|---|---|---|
| 0 — Scaffold + schema | ✅ done | Contract pipeline (fastify-zod-openapi → committed spec → Kubb) proven; schema at v1 + wave-3 additions |
| A — SMTP library | ✅ done | 101 loopback tests, zero deps. One workaround: server-side STARTTLS via loopback bridge until Bun ships oven-sh/bun#34598 (merged upstream 2026-07-25, unreleased) |
| B — Email auth (mailauth) | ✅ done | All verification in-process; table-driven verdicts; glts spf-milter documented as fallback, unused |
| C — Rewrite core | ✅ done | VERP byte-compatible with SimpleLogin (CPython golden vector) + constant-time compare + real expiry; forward/reply whitelists; refuse-to-leak on replies |
| D — Queue + deliverd | ✅ done* | SKIP LOCKED worker, backoff, RFC 3464 DSNs (null reverse path, rate-limited). *Gap: bounces OF transactional mail are log-only |
| E — API (SimpleLogin-compat) | ~90% | 28+ spec paths incl. custom domains, billing extras, SMTP credentials (Virtu extension) + mailbox `trash` flag. Auth is passwordless (PLAN decision #13): `/auth/login` + `/auth/verify` replace SL's register/activate/reactivate/login, sudo is an emailed code. Deferred: MFA, PATCH user_info, DELETE /user, cookie_token, notifications, export, apple/phone (forgot_password is moot — no passwords) |
| F — Client | ~85% | Restyled to the legacy virtu design on Panda CSS (semantic tokens in `panda.config.ts`, primitives in `src/ui.tsx`: Button/Field/Select/Switch/KeyValue/EntityList/CopyButton/Logo; root font-size 18px→24px@1200px, everything rem-based). Pages: login (the passwordless single entrypoint — one email field for login AND signup, styled after the legacy 401 page, code step with PinInput; /register redirects here), alias detail (new/used states + activities + contacts/delete), **mailboxes (add/verify-by-code/default/trash/delete-with-transfer; full-width index + `/mailboxes/$mailboxId` detail page owning the controls as KeyValue switch rows — default is one-way so the holder's switch is ON+locked; index rows carry buttons only while unverified)**, settings (native selects + SMTP device passwords: create-with-one-time-reveal, revoke), billing (key/value + Stripe actions), domains index + detail (DNS records to publish, verify with per-check errors, catch-all switch, delete). Mantine is fully removed (banned — see CLAUDE.md): overlays are native `<dialog>` (`src/overlays.tsx`), PinInput/TextArea/CheckboxGroup are ours, color scheme is `src/colorScheme.ts` (`data-color-scheme` on html). Responsive pass 2 (2026-08-10, screenshot-verified 360/700/1100/1440): index-row controls hide on small screens (aliases ≤480px, mailboxes ≤900px — the detail pages own them), drawers go full-width ≤650px, the hamburger demotes Log out to a bottom meta row (with the theme toggle), domain rows link instead of carrying a Verify button (verify lives top+bottom of the detail page), and `FieldRow` (ui.tsx) stacks every [input][button] pair ≤650px. Missing: notifications, search, per-alias mailbox picker UI (API supports `mailbox_ids`) |
| G — Homepage | ✅ done | 7 static Astro pages, verbatim legacy copy/tokens, zero client JS. Served at `/` behind the Caddy proxy; SPA under `/app`, API under `/api` — one origin, same topology dev and prod (dev proxy built; see below) |
| H — Simulated internet | ✅ done | Subnets 192.168.34/43 (legacy stack owned 33/42; legacy now stopped — renumbering back is optional). Maildir + X-Virtu-Test-Id; no resets, parallel-safe |
| I — Billing | ✅ done | SDK-free Stripe; live-verified checkout → webhook → premium flip; keys in gitignored `server/.env` |
| J — Observability & queue hygiene | ✅ done | 2026-08-14, decision #15. First-party structured logger (`src/log.ts`, all 6 daemon files migrated off console.log) + Prometheus registry (`src/metrics/`, `virtu_*` set) — api at `/meta/metrics`, maild on `:9100` (also its liveness: listeners + worker heartbeat); `/meta/health` now probes the DB; compose healthchecks on api+maild. Queue: `claimed_at` lease + reaper, retention (raw cleared on sent; 7d/30d windows), status-guarded terminal writes, `dropMessages`/`requeueMessages`, retry horizon 6→25 tries (~4 days, 6h cap; test net pins fast values). Alloy → Grafana Cloud under compose profile `observe` (`alloy/config.alloy`); creds go in `/opt/virtu/.env`. **Not yet verified against a real Grafana Cloud stack** — needs the account + creds on lmnop first |
| K — Admin & abuse | P1 ✅ | 2026-08-14, decision #16. `USER_FLAGS.admin` bit + `requireAdmin` nested `/api/admin` scope; endpoints: overview, queue list (status filter + limit + total), detail (allowlisted routing headers — never Subject/body — + VERP-decoded owner), drop, requeue, delete (terminal rows only, ahead of retention), bounce (operator DSN via the shared `pipeline/dsnDelivery.ts` — extracted from deliverd — then failed "bounced by operator"; NO recordBounce, so the auto-disable ledger never moves on an operator action; forward diagnostics sanitized as always); `is_admin` on user_info. Client: Admin nav item (admins only), AdminOverview/AdminQueue/AdminQueueMessage pages, in-kit, screenshot-verified 360/700/1100/1440. Break-glass CLI: `bin/admin-{grant,revoke}`, `bin/queue-{list,stats,drop,requeue}` + just recipes (verified live against the dev DB). `sudoGuard.ts` seam extracted (POST /api_key refactored onto it); admin ops NOT sudo-gated until P2. Roadmap P2–P4 in PLAN Lane K. **Invite lane** (2026-08-22, ABUSE.md Tier 0; merged 2026-09-01): `invites` table (code plaintext by design, created_by→used_by kept forever = the invite graph, SET NULL never CASCADE); `SIGNUP_INVITE_ONLY` env gates /auth/verify at graduation — invite consumed inside graduateUser's tx after code proof (no enumeration leak; a failed invite spends the login code, Login page offers the fresh-code retry); `/api/admin/invites` GET/POST/DELETE (revoke = unused only, 404 otherwise) riding the shared `auth/invites.ts` primitive with `bin/invite-create` + just recipe; AdminInvites page + Overview link + Login invite panel. Verified: 7 int tests (`invites.int.test.ts` — wall, lifecycle, gate incl. rollback/reuse/expiry/existing-user), full int tier + `just check` green, and a real-browser Playwright walk (fresh email → 403 → invite + resent code → app) + screenshots 360/700/1100/1440, no overflow. **P2 first slice ✅ 2026-09-01**: (1) durable attribution — `outbound_messages.user_id/email_log_id` written by every enqueue (mx forwards + trash copies, submission, transactional via sendWithRateLimit's userId, DSNs from the email_log), admin queue DTO carries `user_id`, `resolveQueueOwner` falls back to the columns when VERP doesn't decode (DSNs/trash/expired now name their user); (2) per-user daily send quota at submission pre-enqueue — counts `email_logs.is_reply` recipients over a rolling 24h (forwards never count), refuses whole messages 452/4.7.1, limits `users.max_daily_sends` override (0 = unlimited) else SEND_QUOTA_{FREE,PREMIUM}_PER_DAY (50/500); (3) `smtp_rejections` — every SMTP-time refusal from both daemons (auth/mail_from/rcpt_to/data phases) recorded fail-open with envelope context + the exact reply, aged out on the retention tick (SMTP_REJECTIONS_RETAIN_DAYS=30), metric `virtu_smtp_rejections_total`; (4) notifications — SL-compatible GET /notifications (unread-first, 20/page, humanized created_at via `routes/timeAgo.ts`) + POST /notifications/:id/read, header bell with unread badge + /notifications page (screenshot-verified 360–1440), `bin/notification-create` dev/announce tool. Still open from P2: sudo-gating the destructive ops, admin user views, notifications for quota hits |

Milestones M1–M4 (PLAN sequencing diagram): all reached.

## Explicitly stubbed / known gaps (roughly priority-ordered)

1. **Reverse aliases always mint on the service domain** — SimpleLogin's
   `use_as_reverse_alias` per-domain option not implemented.
2. **SimpleLogin's `block_behaviour` 550 option not wired** — disabled-alias
   handling is accept-and-drop or the trash inbox (decision #11); the
   per-user "return 550 instead" toggle SL offers is deliberately absent
   (it probes alias existence).
3. **Spam-check hook** — pluggable pre-queue slot deliberately unwired
   (PLAN decision #4). Candidates: spamd/SPAMC or rspamd.
4. **API deferred endpoints** — list in Lane E row above; also GET-with-body
   alias search, multi-window rate limits collapsed to single-window,
   150-word wordlist, mailbox email-change returns 400.
5. **PGP** — fields accepted/serialized as unsupported (`support_pgp:false`).
6. **Admin ops not sudo-gated** (Lane K P1) — drop/requeue sit behind the
   admin flag + a confirm dialog only; the `sudoGuard.ts` seam exists and
   P2 flips it on together with the SudoDialog the user-facing destructive
   deletes also need.
7. ~~**Queue ownership is VERP-only**~~ (resolved 2026-09-01: durable
   `outbound_messages.user_id`/`email_log_id` written at every enqueue;
   admin detail falls back to them when the VERP doesn't decode. Rows
   enqueued before the wave stay unattributed until retention ages them
   out.)
8. **Grafana Cloud shipping unverified** — the Alloy service + config are
   in the serve stack behind `COMPOSE_PROFILES=observe`, but no Grafana
   Cloud stack/credentials exist yet; first real scrape should happen on
   lmnop. The metrics endpoints themselves are int-tested and curl-able.

(Resolved 2026-08-10: custom-domain suffixes — `/v5/alias/options` now offers
each verified custom domain as `is_custom` suffixes: the EMPTY suffix
(`@domain`, full local-part control, SimpleLogin-style) first, plus a
random-suffix variant; custom domains sort before shared domains, the user's
default domain first. `/v3/alias/custom/new` accepts them, checks ownership +
verified at creation time (the suffix signature is not user-bound) and links
`custom_domain_id`. Shared-domain suffixes stay forced-random (shared
namespace). The create-alias modal shows an advisory note when a no-suffix
option is selected instead of blocking; no dictionary of "guessable" local
parts by design — with catch-all off a guessed address bounces, with catch-all
on every local part already delivers, so a blocklist protects nothing.
SimpleLogin's per-domain `random_prefix_generation` default-flip remains
unimplemented.)

(Resolved 2026-08-10: transactional bounce intake — the VERP id now resolves
to the verification_codes row in BOTH intake paths (mx inbound VERP + deliverd
permanent failure): code invalidated, mailbox `nb_failed_checks` bumped,
user notified; duplicate/late bounce copies are no-ops, and the mx path only
accepts DSN-shaped mail (`looksLikeDsn`: multipart/report, or null reverse
path without `Auto-Submitted: auto-replied`) so a vacation auto-reply to the
Return-Path can't kill a live code. Also resolved: the mx prepends a
`Received:` trace header, and submission AUTH sits behind a per-(IP,username)
failed-attempt throttle (`pipeline/authThrottle.ts`) so wrong passwords can't
buy unbounded argon2id work. Known residual: an auto-responder that emits
multipart/report — nonstandard but possible — still counts as a bounce
unless its Action fields say only delayed/relayed; an async bounce with a
NON-null sender and a plain-text body is ignored at the mx intake (the
deliverd SMTP-time path catches the dominant case); the forward/reply VERP
intake paths take any mail to the VERP address at face value, as before this
wave; and a broken trash mailbox fails silently — trash copies ride the null
reverse path by design (PLAN #11), so nothing bumps its nb_failed_checks.)

## Security hardening (2026-08-11)

First security audit pass; fixes landed on `main`. `just check` green.

1. **Forward-bounce DSN no longer leaks the backing mailbox** (was
   Critical). A permanently-failed forward sends its DSN to the outside
   sender; it now names the **alias** as the failed recipient and emits a
   sanitized diagnostic (`sanitizeForwardDiagnostic` in `mail/dsn.ts`,
   applied in `deliverd.ts`), never `envelope_to` (the real mailbox) or the
   verbatim remote reply. Reply-phase DSNs (to the user's own mailbox) are
   unchanged. `dsn.story.test.ts` now asserts the alias appears and the
   mailbox never does. **Not yet re-run in the story tier** (needs docker;
   run `just test-net-up && just test-story`).
2. **Production fail-closed on insecure secret defaults** (was High).
   `config.ts:assertProductionSecrets` refuses to boot when
   `VIRTU_ENV`/`NODE_ENV`=`production` and `VERP_SECRET` or `DATABASE_URL`
   is still the known dev default. Serve stack now sets `VIRTU_ENV` and
   sources `POSTGRES_PASSWORD` (no longer hardcoded `virtu`); `.env.example`
   documents both.
3. **deliverd SSRF egress guard** (was Medium). `queue/worker.ts` refuses to
   deliver to an MX/implicit-MX resolving to a private/loopback/link-local
   address and connects to the vetted IP (`isBlockedAddress`,
   `SMTP_ALLOW_PRIVATE_TARGETS`; the test net sets it true for its 192.168.x
   peers).
4. **`trustProxy` enabled** (was Medium) so per-IP auth rate limits work
   behind Caddy instead of collapsing to one global bucket.
5. **Login open-redirect closed** (was Medium). `client/app.tsx:safeRedirect`
   only accepts same-origin `/app` paths for the post-login `?redirect`.
6. **CSP + HSTS added** (was Medium). `Caddyfile`: strict CSP site-wide
   (`script-src 'self'`, no eval), HSTS on the public host only.

### Second batch (clear-cut hardening, 2026-08-11)

7. **Forward/reply VERP bounce intake gated by `looksLikeDsn`** (was Low). The
   `mx.ts` intake now applies the DSN-shape gate to ALL VERP types, not just
   transactional — a vacation/OOO auto-reply to a forward/reply return path no
   longer books a bounce (which could auto-disable a victim's alias).
8. **`isOwnMailboxAddress` is provider-aware** (was Low). New pure
   `pipeline/addressMatch.ts:mailboxMatchKey` folds Gmail dots + googlemail.com
   (dot-folding is Gmail-only, so look-alike cold emails elsewhere aren't
   wrongly refused); the own-mailbox refuse-to-leak guard uses it.
9. **DNS TXT character-string clamp** (was Low). `dnsTxt.ts` rejects a chunk
   whose length overruns its record's RDATA (`EBADRESP`) instead of splicing
   adjacent answer bytes into a DKIM/ownership comparison.
10. **Reverse-alias RCPT lookup scoped to the authed user** (was Low).
    `resolveReverseAlias` takes an optional `userId`; submission `onRcptTo`
    passes it so another account's reverse alias can't be probed (250 vs 550).
11. **SMTP connection caps** (was Low/Medium). `smtp/server.ts` bounds
    concurrent connections globally (1024) and per remote IP (64), refusing
    over the cap with `421` before allocating a session.
12. **`ALIAS_SIGNING_SECRET` required in production** (was Low). `aliasConfig.ts`
    refuses to boot under `VIRTU_ENV=production` if it's unset, rather than
    deriving the suffix HMAC key from `DATABASE_URL`.

### Custom-domain squatting fixed — the `domains` model (2026-08-11)

`custom_domains` was renamed to `domains` and reshaped so a squatter can no
longer permanently block a domain by POSTing it first:

- `name_requested` (varchar, NOT NULL) is the claimed FQDN — NOT globally
  unique (only `UNIQUE(user_id, name_requested)`), so any number of accounts
  can hold a provisional claim on the same name.
- `name` is a **STORED generated column** = `CASE WHEN verified_owner THEN
  name_requested END`, with `UNIQUE(name)` (NULLs distinct). That unique index
  is the winner-take-all lock: exactly one account can own an FQDN, and it's
  whoever proves DNS control (the per-row ownership TXT token — unraceable).
  App code never writes `name`; the DB derives it from `verified_owner`.
- The verified flags are a `verified_*` family (`verified_owner`,
  `verified_mx`, `verified_dkim`, `verified_spf`, `verified_dmarc`); the DNS
  re-check writes only these. `verifyCustomDomain` flips `verified_owner` and
  catches the `UNIQUE(name)` violation (`db/pgError.ts:isUniqueViolation`): the
  loser keeps its other checks but stays unowned (`name` NULL) and is told
  "already verified by another account". Ownership/MX are upgrade-only in the
  interactive path (demotion is the future cron's job, behind
  nb_failed_checks). The old display-name column `name` is now `from_name`;
  `aliases.custom_domain_id` is now `aliases.domain_id`.
- **Capabilities are code, not columns** (`pipeline/domainCapability.ts`):
  `canReceive = owner && mx` (inbound forwarding, re-signed with our key),
  `canSend = owner && dkim && spf` (outbound `d=customdomain` — reply signing
  falls back to the service key when false, so we never send from a
  misconfigured domain). Surfaced as additive `can_receive`/`can_send`
  computed fields on the CustomDomain API DTO. DMARC is a quality flag, not a
  gate. Every mail-path lookup keys on the unique `name` (a provisional row's
  NULL can never match); this also resolves the old "routing keys off MX, not
  ownership" note.
- The whole change stays **off the SimpleLogin wire**: the rename is internal;
  responses still serialize `domain_name`, `is_verified` (now = can_receive),
  `*_verified`, and `custom_domain_id`. Verified end to end: unit (capability
  predicates), int (`customDomains.int.test.ts` two-accounts-race:
  provisional coexist → first verify wins → second locked out), and the
  custom-domain story tier.

Still deferred (need a product/UX/architecture decision, or are accept-only):
sudo gating on destructive deletes (UX), moving the API key out of
`localStorage` into an httpOnly cookie (architecture + CSRF), 64-bit VERP MAC
(accepted, SL-compat), the `postcss` dev-only advisory, flipping the CSP from
reasoned-safe to violation-verified after a deploy, and the domain
DNS-re-check cron (writes debounced `verified_*` flags; `name` + capabilities
auto-derive — demotes a domain whose ownership TXT lapses, freeing the name
for the next controller).

## Not started

- **Production/deploy story** — _mostly built (2026-08-10), first target
  each.email:_ the serve stack (`docker-compose.serve.yml`) now runs the whole
  app — db, api, built frontends behind the **universal `Caddyfile`**, and
  `maild` (25/587/465, restart policies, a `server-deps` one-shot so api +
  maild don't race `bun install`). Mail TLS reuses Caddy's cert: a
  `mail.{VIRTU_HOST}` site exists for issuance, the `mail-certs` one-shot
  copies it into the `mail_certs` volume, `bin/mail-certs-sync` re-syncs +
  bounces maild after renewals (listeners read certs once at startup — weekly
  cron on the box). Provisioning + deploy are `bin/host-provision` (swap,
  docker, virtu user) and `bin/host-deploy` (fetch + checkout, build, up,
  cert sync — takes an optional ref, defaults origin/main; **never pushes
  the schema** — unattended `push --force` auto-accepts data-loss SQL, and
  drizzle-kit without a TTY errors yet exits 0, a silent skip). Schema
  changes are manual: `just db push` (interactive drizzle push, no
  --force, prompts on lossy statements); `bin/dkim-ensure`
  mints/prints the service-domain DKIM key.
  Runbook: README "Deploy"; annotated DNS record set: `each.email.zone`.
  Each-box facts (2026-08-10): each.email rDNS → mail.each.email, outbound 25
  open at Linode, Cloudflare DNS-only records live.
  **Deploy trigger (2026-08-13)**: `.github/workflows/deploy.yml` — every
  `v*` tag push SSHes to each.email as `virtu` with the `EACH_SSH_KEY` repo
  secret; an authorized_keys forced command (`restrict,command=`) pins that
  key to `bin/host-deploy "$SSH_ORIGINAL_COMMAND"`, host keys pinned in the
  workflow.
  What remains: backups, Linode Cloud Firewall, the zinc/lmnop boxes
  themselves.
  **Secrets management**: `server/.env` is gitignored, so nothing sensitive is
  in git — CI and any deploy must provide the production secrets out-of-band
  (`VERP_SECRET`, TLS cert/key paths, and the Stripe keys if billing is on).
  `server/.env.example` is the checklist of what to inject; on a box the
  compose-interpolation vars live in `/opt/virtu/.env` (also gitignored).
- **Mobile shells** — post-MVP by decision #7 (native Swift/Kotlin over the
  web client; share-extension is the flagship feature + App Store 4.2 answer).
  Execution plan drafted 2026-08-12 in **`plans/mobile.md`**: store-policy
  research findings, the bridge protocol contract, and nine workstreams (six
  parallelizable). Apple dev account + D-U-N-S already in hand; Play org
  account is the remaining paperwork.
  **Track A landed (2026-08-12):** bridge protocol v1 spec
  (`client/src/shell.md`) + shell seam (`client/src/shell.ts` —
  `window.virtuShell` detection, `apiKey.store/clear`, `share`,
  `external.open`, web fallbacks). Wired: login/logout mirror the API key over
  the bridge (`auth.ts`), Billing hides all purchase UI in-shell
  (consumption-only posture). Verified: `just check` + full dom tier green,
  incl. new shell-stub tests (Login bridge handoff, `Billing.dom.test.tsx`).
  Track A remainder: safe-area/touch/hover audit of the SPA in a real
  WebView; the blob-URL zone-file viewer needs shell-side handling (noted in
  shell.md).
  **Track C scaffolded (2026-08-13):** complete Android shell project in
  `mobile/android/` (Gradle/Kotlin, not a Bun package). Bridge protocol v1
  native side: `ShellProtocol.kt` (pure-JVM message layer + JUnit conformance
  tests), `ShellBridge.kt` (origin-allowlisted WebMessageListener +
  document-start shim, never `addJavascriptInterface`), `ApiKeyStore.kt`
  (Keystore AES-GCM at rest — the storage Tracks E/F will read), plus a
  localStorage healing script re-seeding `virtu.apiKey` from Keystore.
  `MainActivity` covers the plan's platform gotchas: native inset padding
  (edge-to-edge/targetSdk 36), native offline screen + retry, external links
  to the system browser, window.open/blob URLs in an in-app child WebView
  (the shell.md known gap), splash, rotation without SPA reload. Debug builds
  front the local dev stack (`10.0.2.2:8080`), release fronts zinc
  (`-PvirtuWebOrigin=https://lmnop.email` for staging). Verified on this
  box (no JDK/SDK locally): the shim + real `client/src/shell.ts` seam pass
  the bun contract suite `mobile/android/contract/shim.contract.test.ts`
  (id correlation, error slugs, key round-trip — runnable with bare bun);
  Kotlin compile + `./gradlew test` + the on-device checklist in
  `mobile/android/README.md` await a machine with Android Studio.
  `applicationId` (`email.zinc.virtu`) is placeholder-permanent — settle
  branding before the first Play upload.
  **Review pass (2026-08-13):** subagent direction review found no blockers;
  hardening applied: seam reply-timeout (10s) + `openExternal` http/https
  guard with error-reply fallback (`shell.ts`/`shell.md`); Billing's
  visit-the-web line is now **Android-only** (Apple anti-steering — decided
  in plans/mobile.md, enforced by a new iOS dom test); Android shell got a
  `restoreState`-empty fallback, an external-scheme allowlist for link
  navigations (http/https/mailto/tel — bridge parity), connectivity-only
  offline-screen triggers, error replies instead of silent drops for
  subframe bridge requests, gesture-only popups, and origin compare
  normalization. The contract tier is now official: `just test-contract`,
  wired into `bin/check` + CI + CLAUDE.md's tier list. Left alone
  deliberately: the paraspace root-package changes (user tooling, just keep
  them out of the mobile commit).
  **Track E scaffolded (2026-08-13):** Android share target — `ShareActivity`
  (dialog-themed mini-activity: options → reuse the server's per-site
  recommendation or mint random, copy, done — never launches the main app),
  `SharedHostname.kt` (pure-JVM hostname extraction from shared text, JUnit
  suite), `VirtuApi.kt` (the two-endpoint native API slice,
  `Authentication` header), sharing-shortcut plumbing (`shortcuts.xml` +
  dynamic "New alias" shortcut published from MainActivity). The API flow
  the native code bakes in was verified live against the dev stack via curl:
  options?hostname → mint random?hostname → options returns the minted alias
  as `recommendation`. Zero server changes, as the plan promised. On-device
  checklist items 11–12 added to mobile/android/README.md.
  **Track B scaffolded (2026-08-13):** complete iOS shell in `mobile/ios/` —
  XcodeGen `project.yml` is the committed project definition (the .xcodeproj
  is generated on the Mac, gitignored). Protocol v1 native side:
  `ShellProtocol.swift` (pure message layer + XCTest conformance suite
  mirroring the Kotlin one), `ShellBridge.swift`
  (`WKScriptMessageHandlerWithReply` in the page world — the reply promise
  replaces Android's id envelope — plus the document-start shim and the
  Keychain-backed localStorage healing script), `KeychainStore.swift`
  (shared access group `…virtu.shared`, entitlements committed, ready for
  Tracks D/G), `ShellViewController` (offline screen filtered to
  connectivity URLErrors, external-scheme allowlist matching Android,
  window.open/blob child WKWebView sharing the parent's browsing context,
  login kept in-webview, iPad share-sheet popover anchor),
  `PrivacyInfo.xcprivacy`. Verified on this box (no Mac): the iOS shim +
  real seam pass their own bun contract suite; `just test-contract` (and
  bin/check + CI) now runs `bun test mobile` — 14/14 across both platforms
  in one process (suites scrub each other's globals). Xcode compile +
  simulator checklist (mobile/ios/README.md) await a Mac;
  `PRODUCT_BUNDLE_IDENTIFIER` is placeholder-permanent like the Android
  applicationId.
  **Track F scaffolded (2026-08-13):** Android autofill — the plan's open
  competitive lane (SimpleLogin ships none). `VirtuAutofillService` walks the
  AssistStructure with `EmailField.kt` (pure-JVM heuristics, JUnit-tested:
  autofill/autocomplete hints → InputType variations → HTML input type →
  name fallback, password fields excluded at every layer) and answers email
  fields with ONE dataset — dropdown RemoteViews + inline keyboard chip
  (InlineSuggestionUi, API 30+, androidx.autofill) — whose value comes from
  **dataset authentication**: no network in `onFillRequest`; tapping the chip
  launches the translucent `AutofillMintActivity`, which runs the same
  options→reuse-recommendation-or-mint flow as the share target (`VirtuApi` +
  `ApiKeyStore`, the building blocks Tracks C/E laid) and returns the filled
  dataset via `EXTRA_AUTHENTICATION_RESULT`. Site context = browser
  `webDomain` (normalized by `SharedHostname.normalize`, now public); native
  apps mint hostname-less. Logged out → the service stays silent. Onboarding:
  `AutofillSetupActivity` (deep-link to the system autofill picker, live
  status via `hasEnabledAutofillServices`, Chrome's "Autofill using another
  service" walkthrough), reachable via a static long-press shortcut, as the
  service's `settingsActivity` gear, and as the inline chip's attribution
  target. Verified on this box: JUnit heuristics suite authored (runs with
  `./gradlew test` on a JDK machine); on-device checklist items 13–15 added
  to mobile/android/README.md. No client or server changes.

## Upstream workarounds to revisit

1. **Bun server-side STARTTLS** (`server/src/smtp/server.ts`,
   `upgradeServerSocket`): loopback tls.Server bridge until a Bun release
   ships PR #34598 (merged 2026-07-25; latest release 1.3.14 predates it).
   On upgrade: swap to native path, run `bun test server/src/smtp`, delete
   bridge; also pin the `oven/bun` compose image to the host version.
2. **Bun `node:dns` flattens multi-string TXT records**
   (`server/src/pipeline/dnsTxt.ts`): wire-format TCP client used for all
   TXT lookups (DKIM keys span multiple character-strings). Upstream-reportable;
   remove if Bun fixes grouping.
3. **Bun `node:http` WebSocket upgrades hang** (oven-sh/bun#35325: the
   upgrade event fires but bytes written to the handed-off socket are
   silently discarded — verified fixed upstream for 1.4.0, unreleased as of
   1.3.14). rsbuild's HMR socket never completes its handshake under bun
   (diagnosed 2026-08-10 by running the identical server under node, which
   connects instantly). The client dev container is therefore
   `node:26-bookworm-slim` with a one-shot `client-deps` service
   (`oven/bun:1.3`) doing the `bun install` — bun remains the only package
   manager, node is only the dev-server runtime. HMR ws moved under the base
   (`/app/rsbuild-hmr`) so the dev proxy needs no extra route. When a Bun
   release ≥1.4.0 ships: collapse the two services back to one `oven/bun`
   container and re-verify HMR live (workaround #1 lifts on the same
   release).
4. **Stripe account API version is 2018-02-28** — webhook payload shapes are
   version-pinned per account; the handler reads both pre-Basil and current
   `current_period_end` shapes, so upgrading the account's API version later
   is safe but should be followed by a re-run of the live loop.
5. **Astro dev-server lock is pid-based and can't cross a pid namespace**
   (diagnosed 2026-08-10, fixed same day): `www/.astro/dev.json` records the
   dev server's pid, and the file lives in the bind mount, so it outlives the
   container. Astro's staleness check is `process.kill(pid, 0)` — in a *fresh*
   pid namespace that pid is reliably alive (it's this astro process; the tree
   is deterministic, so it landed on 14 every time), so the lock never reads as
   stale. `--force` then "replaces the running server" by SIGTERMing that pid,
   i.e. itself: `www` died 0.5s after every start with exit 143, and
   `just up --wait` failed on it. Fixed by running the container's dev server
   with `--ignore-lock` (docker-compose.yml `www.command`) — the lock is
   neither read nor written, so no stale `dev.json` is ever left behind;
   host-side `just www-dev` keeps normal lock semantics. Upstream-reportable
   (the lock should carry a boot id / process start-time, not a bare pid);
   revisit if Astro hardens it.

## Deviations from SimpleLogin (all documented in code at the site)

API keys stored sha256 (every verify mints a new key; SL returns the stored
one) · **auth is passwordless** (PLAN decision #13): one login/verify code
flow replaces SL's register/activate/reactivate/login, `users` has no
password column, sudo re-auth is an emailed code (`PATCH /sudo` two-step) and
SMTP AUTH takes device credentials only ·
mailbox verification is a code endpoint (SL: web link) · logout revokes the
API key · ownership token prefix `vt-verification=` · per-domain DKIM TXT
instead of SL's CNAME (we sign with the domain's own key — better alignment) ·
custom-domain DELETE immediate (SL schedules) · `GET /api/billing/*` endpoints
exist beyond SL's surface (SL used Paddle) · default list sort matches SL
pinned-then-activity.

## Where things live

- Design doc + settled decisions: `PLAN.md`
- Mail pipeline: `server/src/{smtp,mailauth,mail,pipeline,queue}/`,
  entrypoints `server/src/{mx,submission,deliverd,maild,api}.ts`
- API + spec: `server/src/routes/`, committed `server/spec/openapi.json`
- Simulated internet: `docker-compose.test.yml`, `server/docker/test/`,
  harness + stories in `server/test/`
- Client: `client/src/` (SDK regenerated from spec, gitignored)
- Homepage: `www/`
