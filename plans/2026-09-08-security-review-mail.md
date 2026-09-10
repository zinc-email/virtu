# Pre-launch security review, round 2: the mail path

Companion to `plans/2026-09-05-security-review.md` (round 1, all fixed) and
`ABUSE.md`. Status: **P0 and P1 all fixed 2026-09-09 (STATE.md "Mail-path
review batch, round 2"); the P2 list is open.** Written
2026-09-08 from a second red-team pass over the mail side only — the SMTP
protocol layer, the MX decision path, submission, mailauth/DNS, and
deliverd — by agents with the same view of the code any attacker with the
public repo has. Every item marked CONFIRMED was reproduced by running the
real module (unit-level, or `createMxServer`/submission in-process against
the dev Postgres); PLAUSIBLE means the code path was traced end to end but
not executed. Repro scripts were throwaway and are not in the repo.

Severities as in round 1: "what happens if nobody fixes it," not effort.
P0 ships before the first public mail; P1 within the first weeks; P2 when
convenient.

The short version: the SMTP server trusts its peer to stop sending, the
budgets added in round 1 have three doors around them (duplicate RCPTs,
repeated Message-IDs, and the two recipient kinds that never had a budget),
and the deliverd egress guard classifies IPv6 by spelling.

## P0 — fix before launch

### 1. One connection OOMs the mail process: no read or write backpressure

**Where:** `server/src/smtp/server.ts` — `attach` (`Buffer.concat` on every
`data` event), `pump` (parked while any hook is awaited), `write` (never
looks at `writableLength`). The socket is paused nowhere except during the
STARTTLS upgrade.

**What:** while `onMailFrom`/`onRcptTo`/`onAuth`/`onData` is awaited the
pump does not run, so every byte the peer sends is appended to `this.buf`
with no bound — `maxMessageSize` bounds only the decoder's output and
`MAX_COMMAND_LINE` is only checked inside the parked loop. The per-event
`Buffer.concat` reallocates the whole accumulated buffer, so growth is
super-linear. The write side is the mirror image: a peer that pipelines
`NOOP` and never reads has every reply queued in userland. The hook window
is attacker-controlled: `onData` runs `verifyInbound`, and a slow
authoritative nameserver for the sender's own domain stretches it by
seconds per lookup (see P1 #6).

**CONFIRMED** (server process measured alone, one loopback connection):

| scenario | bytes sent | server RSS |
| --- | --- | --- |
| DATA accepted, then junk while `onData` awaits | 346 MiB in 6 s | 20 MB → 2.2 GB |
| `NOOP` flood, replies never read | 223 MiB in 6 s | 20 MB → 2.5 GB |

maild runs mx, submission and deliverd in one process with no memory limit
in `docker-compose.serve.yml`, so this kills all three; `restart:
unless-stopped` brings it back for the next connection.

**Fix:** `socket.pause()` before every `runHook` await and `resume()`
after; cap `this.buf` in command mode independently of the pump (destroy
past a few KiB of unconsumed input); replace the per-chunk `Buffer.concat`
with a chunk list; and on the write side check `socket.writableNeedDrain`
(or `writableLength` against a small cap) before processing the next
command, pausing reads until `drain`. Add `mem_limit` to maild in the serve
compose so a future leak restarts one container instead of swapping the
box.

### 2. Duplicate RCPTs turn one message into 100 queued copies, past every cap

**Where:** `server/src/smtp/server.ts` `handleRcpt` (no dedupe on
`rcptTo`); `server/src/mx.ts` (RCPT and DATA re-evaluation both read
*existing* rows; step 4 enqueues one copy per evaluated recipient ×
mailbox).

**What:** `RCPT TO:<alias@zinc.email>` × 100 in one transaction is accepted
100 times. The per-mailbox budget (`countRecentInbound`) and the per-user
queue cap (`pendingUsage`) are consulted at RCPT and again at DATA, but
this transaction has written nothing yet, so all 100 pass and step 4 writes
100 email_logs and 100 full-size queue rows for one user, delivering 100
copies to their inbox. One 25 MiB message → 2.5 GB of `outbound_messages`.
Needs one known alias, no auth.

**CONFIRMED** through the real `createMxServer` against the DB with
`perMailboxPerMinute: 15` and `maxPendingRows: 5`:

```
RCPT 250s=100  DATA reply=250 2.6.0 Ok: queued  queue rows=100  email_logs=100  contacts=1
```

**Fix:** dedupe recipients in `handleRcpt` (normalized address already in
`rcptTo` → 250 without a second push), and make `evaluateRcpt` count the
transaction's own accepted recipients (the hook already receives `rcptTo`)
toward both the mailbox budget and the queue usage before deciding. Cap
fan-out bytes per transaction (`rcpts × raw.length` against the per-user
byte cap).

### 3. Catch-all mints alias rows before any budget, with no cap

**Where:** `server/src/pipeline/policy.ts` `evaluateRcpt` —
`mintCatchAllAlias` runs before the rate-limit and quota facts are
gathered; the budgets are keyed on `email_logs`, which only exist after
DATA.

**What:** for any domain with `catch_all = true`, every
`RCPT TO:<random@domain>` inserts an `aliases` row — even when the reply is
450/452, even if the client never sends DATA (`RCPT` × 100, `RSET`,
repeat). Rows are permanent (a later delete is a `deleted_aliases`
tombstone, so the address space is consumed either way), and an outside
sender can pre-mint names the owner would want. Unauthenticated,
unbounded, SMTP speed.

**CONFIRMED:** with the mailbox budget already saturated, 25 probes → 25 ×
`450` and `alias rows 1 → 26`; over the queue cap → `452` and the row still
minted. Also: a localpart over 256 chars throws out of the RCPT hook on
the `aliases.email varchar(256)` overflow → 451 plus an error log per
probe.

**Fix:** decide the rate limit and quota on the would-be delivery set
(`catchAll.mailbox` is known) *before* minting, and mint only on a
`deliver` decision — ideally at DATA, not RCPT (RCPT can say 250 for a
catch-all address without a row; the row is created when a message is
actually forwarded). Add a per-domain cap on automatic aliases per hour and
validate localpart length/charset before the insert.

### 4. Role addresses accept unlimited 25 MiB mail with no rate limit and no queue cap

**Where:** `server/src/pipeline/policy.ts` (`rateLimited`/`queueFull` are
gathered only for `deliver`/`drop`; `operator` skips both);
`server/src/mx.ts` step 5 (one full copy per effective operator, enqueued
with `userId = operator`, no email_log); `queue/quota.ts` documents the
bypass as intentional.

**What:** anonymous `RCPT TO:<postmaster@zinc.email>` (or `abuse@`,
`hostmaster@`, `security@`, `dmarc@`) with a 25 MiB body, repeated. Each
message becomes one 25 MiB queue row per operator, drained only as fast as
the operator's provider accepts (Gmail rate-limits a burst, so rows sit for
up to 25 tries / 4 days). The rows carry the operator's `userId`, so they
also fill the operator's own pending-queue cap and their real aliases start
answering 452. There is no per-IP throttle at the MX (Lane K P3), so the
bound is disk, and it mail-bombs the operators from our own IP.

**CONFIRMED** at the policy layer: with both limits set to 1 →
`decision: operator  recipients: 1  rateLimited: null  queueFull: false`.

**Fix:** budget role mail like a delivery (a per-localpart trailing-minute
count, or a small token bucket), apply the operator user's queue cap, and
use a much smaller size cap for role mail (abuse reports are small; 1 MiB
is generous). Consider collapsing bursts before enqueueing operator copies.

### 5. deliverd egress guard classifies IPv6 by spelling: SSRF to loopback, RFC1918, and cloud metadata

**Where:** `server/src/queue/worker.ts` `isBlockedAddress` (exact-string
`::`/`::1`, a dotted-only `::ffff:d.d.d.d` regex, prefix tests on the first
hextet) → `deliverOverSmtp` connects to `addrs[0]` verbatim.

**What:** `dns.lookup` on an IP-literal MX exchange returns it in whatever
spelling was published, and the guard misses every non-canonical one:

| address | means | blocked? |
| --- | --- | --- |
| `0:0:0:0:0:0:0:1` | ::1 | no |
| `::ffff:7f00:1` | 127.0.0.1 | no |
| `::ffff:0a00:0001` | 10.0.0.1 | no |
| `::ffff:a9fe:a9fe` | 169.254.169.254 | no |

A `net.connect` to `::ffff:7f00:1` reaches a 127.0.0.1 listener (verified),
so IPv4-mapped spellings hit the real IPv4 host on a dual-stack box. A
hostile receiving-domain operator (or a user's own custom domain) publishes
`MX 10 ::ffff:0a00:0001.` and routes any forward, reply or DSN there;
deliverd opens a blind SMTP session to the internal host on port 25 and
the outcome (connect/greeting/timing) shows up in bounce text and throttle
metrics. Port is fixed at 25, which limits it to internal MTAs and the
oracle, but the guard is the only thing between attacker DNS and the
compose network.

**CONFIRMED** (`isBlockedAddress` results above; `dns.lookup` passes the
literal through verbatim; `deliverOverSmtp` with an injected
`resolveMx → [{exchange: "::ffff:0a00:0001"}]` fell through the guard and
tried to connect). Not verified: how Bun's `dns.lookup` formats an
IPv4-mapped address that arrives via a real AAAA record (glibc gives the
dotted form, which the regex catches); the fix below covers both cases.

**Fix:** classify the numeric address, not the string: parse IPv6 to 16
bytes (`net.isIPv6` + a real parser), fold IPv4-mapped (`::ffff:` in any
radix) to its IPv4 and run `isBlockedIpv4`, compare loopback/unspecified
by value, and fail closed on anything unparseable. Also refuse an MX
exchange that is an IP literal at all — a real MX is a hostname.

## P1 — first weeks

### 6. One inbound message forces unlimited DNS lookups during `onData`

**Where:** `mailauth` `dkim-verifier.js` collects every `DKIM-Signature`
header with no cap and does one `_domainkey` TXT lookup per signature whose
body hash matches; `server/src/mailauth/verify.ts` passes no cap and no
concurrency bound; `pipeline/dnsTxt.ts` is 5 s per query per server.

**What:** the body hash is attacker-computable, so N signatures with N
distinct `d=` all proceed to DNS. Header count is bounded only by the 25
MiB message cap. Point the `d=` domains at a blackholed authoritative
server and one message pins its connection for N × 5 s inside the hook —
which is exactly the window finding #1 needs, and with no global bound on
in-flight verifications a handful of connections saturate the MX and turn
it into a query amplifier against third parties. Reachable with any real
alias (a disabled one routes to `drop`, which still verifies) or
`postmaster@`.

**CONFIRMED:** 200 `DKIM-Signature` headers (shared valid `bh`, distinct
`d=`) → 200 `_domainkey` TXT lookups through the injected resolver.

**Fix:** cap signatures evaluated per message (OpenDKIM/SimpleLogin use a
handful; ignore the rest), put a total-time budget around `verifyInbound`,
give `resolveTxt` a budget across servers, and bound concurrent
verifications process-wide (the verify bulkhead pattern from round 1).

### 7. Per-alias inbound budget is bypassed by repeating a Message-ID

**Where:** `server/src/pipeline/inboundRateLimit.ts` — the alias scope is
`countDistinct(coalesce(message_id, id))`.

**What:** every message carrying the same `Message-ID` collapses into one
"distinct message", so `aliasMessages` stays at 1 forever. For a delivery
the mailbox scope (distinct row ids) still bites at 15/min. For
accept-and-drop recipients — disabled alias, unavailable or suppressed
mailbox — `mailboxIds` is empty, the alias scope is the only gate, and it
is inert: each message writes a contact (attacker-chosen From → a new row
per message) plus a blocked email_log at SMTP speed. This re-opens round
1's P1 #4.

**CONFIRMED:** 200 blocked rows with one Message-ID →
`{ aliasMessages: 1, mailboxCopiesMax: 0 }`, verdict `null`.

**Fix:** collapse only genuine fan-out — count distinct
`(message_id, contact_id)` at most — and add a raw row cap per alias per
minute regardless of Message-ID.

### 8. Bare CR splits headers at the receiver but not in our whitelist or signer

**Where:** `server/src/smtp/wire.ts` `DataDecoder.push` (scans for LF; a
CR not followed by LF is content), `server/src/mail/headers.ts`
`parseMessage` (splits on LF only). `mailauth` parses the same way, so the
DKIM signature is computed over the joined value.

**What:** a submitting client sends
`Subject: hi<CR>From: CEO <ceo@victim.example><CR>Reply-To: a@evil.example<CRLF>`.
Our parser sees one `Subject` field whose value contains CRs; the whitelist
keeps it and emits the raw bytes; we DKIM-sign with one legitimate `From`.
A receiver that treats a bare CR as a line break (Python's `email` module
does; MTAs and MUAs vary) sees a second `From`, a `Reply-To`, a forged
`Received` — anything the whitelist was supposed to strip — under our valid
signature. The same bytes ride the MX inbound path.

Rated P1 rather than P0 because the impact depends on the receiver's
parser; it is P0 if any major receiver splits on CR. Sanitizing on our
side is cheap either way.

**CONFIRMED:** the decoder passes the CR through, `parseMessage` returns
two fields (`Subject`, `From`) with the injected headers inside the Subject
value, and the signed output DKIM-verifies while Python parses the
attacker's From.

**Fix:** treat a bare CR like the bare LF decision from round 1 — normalize
(or reject) in `DataDecoder`, and make `parseMessage` break on lone CR so
no field value can ever carry one. Unit cases in `wire.unit.test.ts` and
`headers.unit.test.ts`. Also drop `x-virtu-test-id` from the production
reply whitelist (`rewriteReply.ts`); it is a harness header.

### 9. Daily send quota is a check-then-act race

**Where:** `server/src/submission.ts` (quota gate before the DATA work) →
`pipeline/sendQuota.ts` `countRecentSends` (plain `count(*)`); the
email_log writes happen later, with no lock, reservation or constraint.

**What:** concurrent DATA handlers on separate connections read the same
low count and all pass. A leaked device credential opens N connections in
parallel instead of one.

**CONFIRMED** with the quota set to 5/day: 20 parallel connections × 4
recipients → `accepted=20`, `email_logs(is_reply)=80`.

**Fix:** reserve atomically — a per-user counter row updated with
`… SET used = used + :n WHERE used + :n <= :limit` (0 rows affected =
refuse), or `SELECT … FOR UPDATE` on that row inside the transaction that
writes the logs. `decideSendQuota` stays pure; only read+reserve becomes
one step.

### 10. Forward-failure DSNs go to the header From, so a forged From is a backscatter cannon

**Where:** `server/src/mx.ts` (the contact is keyed on the header `From`),
`pipeline/dsnDelivery.ts` `resolveDsnRecipient` (bounce_forward → the
contact's `websiteEmail`); the only guard is `emailLog.isSpam`.

**What:** an account with a catch-all domain and a mailbox whose MTA
answers a permanent code that is not a suppression code (`550 5.7.1`,
not 5.1.1/5.2.1) sends itself mail with `From: victim@gmail.com`. gmail.com
publishes DMARC p=none, so the verdict is `accept`, not `flag`. The forward
fails permanently → `sendFailureDsn` mails a MAILER-DAEMON DSN, DKIM-signed
by zinc, to the victim, carrying the attacker's Subject and headers. Dedupe
is per (user, victim, alias) per 24 h and the auto-disable ledger is per
alias — with catch-all both are unbounded. Also a correctness point: a DSN
belongs to the envelope return path, not the header From.

**PLAUSIBLE** (traced end to end; deliverd not driven).

**Fix:** address forward-phase DSNs to the envelope `MAIL FROM` only when
it authenticated (SPF pass) and aligns with the From domain, otherwise
withhold; add a per-user daily DSN ceiling and count DSNs against the
sender's send quota.

### 11. Slowloris: every byte re-arms the only timer

**Where:** `server/src/smtp/server.ts` `attach` → `armIdleTimer()` on every
chunk; defaults `commandTimeoutMs` 300 s, `dataTimeoutMs` 600 s; no
absolute connection lifetime.

**What:** one non-terminating byte every < 300 s holds a slot forever.
`maxConnectionsPerIp` 64 × 16 IPs = the whole `maxConnections` 1024, and
every honest MTA then gets `421`.

**CONFIRMED** (timer scaled to 300 ms): one byte every 180 ms kept the
connection open across 4.8 timeout windows.

**Fix:** an absolute per-connection deadline (Postfix-style), re-arm only
when a complete line is consumed, and a minimum data rate in DATA. Lower
`maxConnectionsPerIp` (Postfix's default is 50; 10–20 is plenty for an MX
that is not a relay).

### 12. A silent-tarpit destination serializes the whole worker

**Where:** `server/src/queue/worker.ts` `processQueueOnce` (sequential
`for` over the claimed batch, no per-domain concurrency bound);
`smtp/client.ts` (30 s per command/reply, so 4–5 min per row worst case);
`queue/destinationThrottle.ts` (`isDeferralSignal` needs a 421 / 4.7.x
reply, so pure timeouts never pause a domain).

**What:** a destination that accepts the TCP connection and answers each
command just under 30 s burns the full budget on every row, is classified
`transient`, and never trips the throttle. A user points an alias at a
tarpitting mailbox on their own domain, enqueues up to their 500-row cap,
and every other user's mail waits behind it.

**PLAUSIBLE** (mechanism confirmed in code; not load-tested).

**Fix:** bounded concurrency across the batch and a small per-destination
cap; a whole-delivery deadline in addition to the per-command one; treat
repeated connect/greeting timeouts from a domain as a throttle signal.

### 13. DKIM `l=` passes let us re-sign appended content

**Where:** `mailauth` records `canonBodyLengthLimited`/`underSized` as
warnings; `server/src/mailauth/verify.ts` never reads them;
`mx.ts` `signCopy` then DKIM-signs and ARC-seals the forward.

**What:** a message from a domain that signs with `l=` (some real senders
do) verifies over the covered prefix only. Appended text passes DKIM and
DMARC unchanged, and the forward goes out DKIM-signed and ARC-sealed under
our domain, vouching for the appended part.

**CONFIRMED:** signed with `maxBodyLength` = prefix, appended a line,
`verifyInbound` → `dkim.result = "pass"`, `underSized = 30`,
`canonBodyLengthLimited = true`.

**Fix:** in `verify.ts`, treat a pass with `canonBodyLengthLimited` (or
`underSized > 0`) as unauthenticated for forwarding — downgrade to `flag`
so the annotation and the backscatter guard apply.

### 14. To/Cc and References are unbounded write and query amplifiers; the forward whitelist is quadratic

**Where:** `server/src/mail/rewriteForward.ts` — a contact per To/Cc entry
with no cap (Reply-To is capped at 5); a DB query per References id fired
concurrently via `Promise.all`; `applyHeaderWhitelist` splices from the
end and `unshift`s, so alternating kept/dropped headers shift every
surviving field. All of it runs once per delivery mailbox.

**What:** a folded `To:` with N addresses costs N find-or-create round
trips and persists N `contacts` rows per alias; a `References:` with N ids
saturates the connection pool; header folding is unlimited so N ≈ 10⁵–10⁶
fits in 25 MiB. The rewritten `To:` can then exceed the enqueue cap → 451 →
the sender retries and the contact rows are already persisted.

**CONFIRMED:** 5 000 To entries → 5 000 contact callbacks (rewritten To
217 KB); 5 000 References ids → 5 000 concurrent resolves; the whitelist at
100k headers = 0.7 s, 400k = 5.3 s (quadratic; parse itself is linear).

**Fix:** map the first K To/Cc entries to contacts and pass the rest
through display-only (SimpleLogin's shape); keep the last ~20 References
and resolve them in one `IN (...)`; rebuild the whitelist with `filter`;
cap header count at parse time (a few thousand → `5.6.0`).

## P2 — hardening

- **Mailbox-scope budget is a lockout lever.** One known alias at 15/min
  holds `mailboxCopiesMax ≥ 15`, so every other alias on that mailbox
  answers 450 to real senders for as long as the flood runs (honest MTAs
  give up after 4–5 days). Count distinct contacts in the mailbox scope, or
  throttle only the flooding contact.
- **Reverse-alias existence oracle + uncapped contact minting** at
  `POST /aliases/:id/contacts`: the "is this a reverse alias" pre-check
  queries `contacts.reply_email` globally, not scoped to the user, so a
  400-vs-201 tells user B whether user A's reverse alias exists (8 random
  chars, so confirmation only, not enumeration). The route also has no
  `config.rateLimit` and no per-user cap: 300 contacts in 1.3 s, all 201.
  Scope the check (or rely on the unique constraint) and add the limit and
  cap the other routes have.
- **STARTTLS bridge has no handshake timeout of its own.** A client that
  sends STARTTLS and never handshakes holds a loopback `tls.Server`, an
  ephemeral port and three sockets for up to 300 s. Give
  `upgradeServerSocket` a 10–30 s deadline.
- **`smtp_rejections` rows per RCPT reject** with no per-IP throttle and an
  unclipped `mail_from`. Clip it; sample once a peer exceeds N/min.
- **`X-Virtu-Hops` is attacker-writable** (it is in the whitelist);
  garbage reads as 0, so a preset only drops the sender's own mail. Consider
  trusting it only when our own DKIM verifies on the inbound.
- **No retention on `contacts` / `email_logs`.** Findings 3, 7 and 14 all
  land there.
- **sha1 DKIM accepted on verify** (mailauth default). Reject `rsa-sha1`.
- **`dnsTxt.ts` skips the question section** instead of matching
  QNAME/QTYPE. Low risk over TCP with a random ID, but match it.
- **Outbound TLS is opportunistic with `rejectUnauthorized: false`** and
  silent plaintext fallback. Standard MTA tradeoff; there is no hook to
  require TLS for chosen destinations (MTA-STS later).
- **No DKIM oversigning** of From/To/Subject. Matches SimpleLogin; low
  impact.

## What held up

Recorded so the next review doesn't re-derive it. Everything in round 1's
list still holds; new confirmations:

- **Framing.** Only `<CRLF>.<CRLF>` ends DATA; bare LF is normalized;
  message size and line length are enforced while streaming and the
  decoded buffer stays bounded once discarding. Command lines are capped
  at 2048 with resync; `maxRecipients` 100, `maxErrors` 10 → 421.
- **No ReDoS** anywhere in `wire.ts`, `server.ts`, `headers.ts`,
  `bounce.ts`, `dsn.ts`, `addressMatch.ts` (all linear; 5 000-address list
  parses in 20 ms). Malformed input returns null/empty, never throws;
  `runHook` turns a thrown hook into 451, and Bun *does* exit on an
  unhandled rejection, so that catch is load-bearing and present.
- **No response splitting**: every echoed fragment comes from a line
  already delimited by LF with CR stripped.
- **STARTTLS pipelining injection** is discarded; the loopback bridge's
  pairing check keeps it off the network.
- **VERP**: HMAC checked constant-time before parse, 5-day window, a
  forged DSN needs a real VERP address (only the mailbox side sees one),
  `bounce_reply` cannot advance auto-disable, `looksLikeDsn` ignores
  vacation replies and delayed reports, so an auto-responder cannot disable
  an alias. Suppression is reachable only via a valid `bounce_forward` VERP
  with 5.1.1/5.2.1, or deliverd's own reply.
- **Spoofing on the forward**: DMARC p=reject fail → 550; the whitelist
  drops `Received`, `Authentication-Results`, `DKIM-Signature`, `Sender`,
  all `X-Virtu-*`; our trace/auth headers are prepended after it; the
  forwarded From is always a reverse alias on our domain. On submission,
  duplicate `From` fields and `Reply-To` are stripped and `From` is
  replaced unconditionally (finding 8 is the only way around it).
- **Envelope ownership on submission** is user-scoped for both aliases and
  mailboxes; reserved localparts cannot be aliases; the RCPT path resolves
  reverse aliases scoped to the user (no 250-vs-550 oracle at SMTP); the
  refuse-to-leak invariant holds on envelope and headers in both modes.
- **AUTH**: EHLO first, TLS unconditional, blocked during a transaction,
  failures count toward `maxErrors`, bulkhead sheds before hashing for PLAIN
  and LOGIN alike, throttle keyed (ip, username) so no cross-IP lockout,
  misses burn the dummy verify.
- **Loops**: hop counter bounded at 2 and only increments; mailboxes
  refuse alias domains and verified-MX domains; DSN → reverse alias is 550
  and null-sender; null reverse path never bounces.
- **Queue**: `FOR UPDATE SKIP LOCKED` claims with a lease nonce; terminal
  writes guarded on `(id, sending, claimedAt)`; reaper returns stale rows;
  backoff capped 6 h × 25.
- **mailauth**: sub-1024-bit keys never pass; ARC chain capped at 50 and
  sequence-validated; sealing skipped on `cv=fail`.
- **DSNs** are null-sender, headers-only (no body amplification), deduped
  per (user, recipient, alias) per 24 h, withheld on a `flag` verdict, and
  the forward diagnostic is sanitized so a forced bounce cannot
  de-anonymize the mailbox.
- **`dnsTxt.ts`** skips compression pointers rather than following them,
  bounds-checks every length, times out at 5 s and destroys its socket.
- **API side**: custom-domain verify is 10/min and the other domain routes
  are capped; transactional mail has the per-address budget and the global
  ceiling.

## Suggested order

Finding 1 first (it is one connection), then 5 (numeric egress guard),
then 2–4 together (they share the "count this transaction / budget every
recipient kind" change in `evaluateRcpt`). 6 and 7 close the hook window
and the drop budget; 8 and 9 are small. The rest can follow launch.
