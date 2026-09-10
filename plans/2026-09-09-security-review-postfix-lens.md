# Pre-launch security review, round 3: virtu through the Postfix lens

Companion to `plans/2026-09-05-security-review.md` (round 1, fixed) and
`plans/2026-09-08-security-review-mail.md` (round 2, P0/P1 fixed, P2 open).
Status: **P0 and P1 all fixed 2026-09-09 (STATE.md "Mail-path review
batch, round 3"); the P2 list is open, plus two items found while fixing:
From oversigning is not possible with mailauth's signer (it builds `h=`
from the headers it finds), and mailauth honours `headerList` only as a
colon-separated string although its types say `string[]` — the fallback
chain in `sign.ts` had been a no-op and now passes the string.** Written
2026-09-09.

Method. Rounds 1 and 2 asked "what can an attacker do to this code?" This
round asks a different question: "what does thirty years of hostile mail
teach an MTA to do on purpose, and which of those reflexes does virtu
lack?" Three readers catalogued the *explicitly defensive* mechanisms in
the Postfix 3.12 source (`tmp/postfix`: smtpd/postscreen/anvil, then
cleanup/local/qmgr/bounce/smtp-client/dns/verify/rewrite) and in
dkim-milter 0.x + viadkim (`tmp/dkim-milter`, crate source fetched), each
entry pinned to a file:line and the parameter's current default. Three
auditors then held virtu against those catalogues, reading the real code
(including `mailauth` in `node_modules`) and running throwaway scripts
where a claim could be executed. Everything marked CONFIRMED was run;
PLAUSIBLE was traced end to end but not executed. I re-ran the load-bearing
reproductions myself and re-measured one (see P1 #6, where the auditor's
number was wrong by 30×).

Severities as before: "what happens if nobody fixes it," not effort. P0
before the first public mail; P1 in the first weeks; P2 when convenient.

The short version: the outbound SMTP client is round 2's P0 #1 in a
mirror, three per-session and per-client limits Postfix treats as basic
are absent, and `mailauth` lets two RFC 6376 rules slide that virtu's
policy assumes are enforced. SMTP smuggling in both directions, backscatter,
VERP forgery, loop injection via `Delivered-To`, and the parser differential
between virtu and `mailauth` all held up under direct attack.

## P0 — fix before launch

### 1. deliverd's SMTP client buffers a hostile MX reply without bound: one alias OOM-kills maild

**Where:** `server/src/smtp/client.ts` `onData` (`Buffer.concat` on every
chunk, never capped) and `drain` (consumes only when a full LF-terminated
line is present and a waiter is registered); `server/src/smtp/wire.ts`
`ReplyParser.feed` pushes every `NNN-` continuation line into an array with
no count or byte cap. The only backstop is the per-reply timeout, 30 s in
production.

**Attack.** Sign up, create an alias, point it at a mailbox on a domain
whose MX you run, send one message to the alias. deliverd connects and
awaits the greeting. The MX streams bytes with no LF, or an endless
`220-` multiline greeting. CONFIRMED (`s2_replyflood.ts`, one connection,
6 s reply timeout): +762 MB RSS for the multiline greeting, +1554 MB for
the no-LF stream, both still climbing when the timeout fired. maild is one
process holding mx, submission and deliverd, under the 1 GiB `mem_limit`
added in round 2, so the container is OOM-killed in a few seconds,
`restart: unless-stopped` brings it back, the queue row is re-claimed
after the stuck-sending reaper (15 min) or on the next batch, and the
cycle repeats for 25 tries. Inbound mail and submission are down for the
duration. Postfix caps exactly this in `smtp_chat.c` with the comment
"Defend against a denial of service attack by limiting the amount of
multi-line text that we are willing to store."

**Fix.** Mirror round 2's server-side fix on the client: destroy the
connection (surface as `PROTOCOL`, which the worker already treats as a
transient step failure) once the unconsumed buffer exceeds a few KiB with
no line boundary; cap a reply line at 2048 bytes and a reply at, say, 64
lines / 16 KiB, discarding rather than storing the excess. Keep the timer.
The same shape applies to any other place a peer's bytes are accumulated
without a line bound (there is none other on the client path; the server
side was done in round 2).

## P1 — first weeks

### 2. No junk-command or command-count limit: one connection drives the MX at full command rate for 30 minutes

**Where:** `server/src/smtp/server.ts` — only replies sent through
`sayError` increment `errors` (limit 10 → 421). NOOP, RSET, EHLO, VRFY,
`MAIL FROM` reset cycles and RCPT to a known alias are successes and never
count.

**Attack.** CONFIRMED (`junk.ts`, stub hooks): 60,007 successful commands
acknowledged in 0.30 s on one connection, no disconnect. On the real MX
each RCPT to a real alias runs the full `evaluateRcpt` fact gather (alias
join, mailbox join, the trailing-minute GROUP BY, `pendingUsage`), so a
peer can drive several indexed queries per line at pipeline speed for the
whole 30-minute session, across 20 connections per IP. Round 2's
backpressure means this no longer costs memory; it costs database and CPU.
Postfix: `smtpd_junk_command_limit = 100` (1 under stress) after which
each junk command counts as an error; `smtpd_soft_error_limit = 10` after
which every reply sleeps `smtpd_error_sleep_time = 1s`; postscreen's
`postscreen_command_count_limit = 20`.

**Fix.** Count NOOP/RSET/HELO/EHLO/VRFY and empty transactions against a
per-session junk limit (100), after which each counts as an error; sleep
1 s before every reply past 10 errors; and a hard per-session command
ceiling (a few thousand) → `421 4.7.0`. An MX that is not a relay has no
legitimate client that needs more.

### 3. DATA bodies accumulate with no process-wide budget, no minimum data rate, and a per-byte idle re-arm

**Where:** `server/src/smtp/wire.ts` `DataDecoder` keeps the normalized
message in `chunks` up to `maxMessageSize` (25 MiB) before `onData` runs;
`server/src/smtp/server.ts` `attach` re-arms the idle timer on every byte
while in DATA; `maxConnections` is 1024.

**Attack.** Postfix's memory bound is its process count: one hung client
is one process holding at most one message. virtu is one process, so the
bound is `maxConnections × maxMessageSize` ≈ 25 GiB against the 1 GiB
`mem_limit`. CONFIRMED (`mem.ts`): 20 decoders, one IP's cap, each holding
24 MiB, drove RSS from 11 MB to 723 MB (about 1.5× the raw bytes from
per-line chunk objects). Two source IPs are enough to OOM maild. A peer
does not even need bandwidth: sending one byte every 29 s keeps the DATA
idle timer alive for the full 30-minute session deadline, so 40 slow
connections hold 1 GB for half an hour. Postfix: `smtpd_min_data_rate =
500` B/s credits `bytes/500` seconds per read in DATA, so a dribbler is
cut in roughly one timeout; `smtpd_per_request_deadline` turns the
timeout into an absolute budget under stress.

**Fix.** A process-wide in-flight DATA byte budget (reply `452 4.3.1` at
DATA when it would be exceeded) sized so budget + baseline fits the
`mem_limit`; a DATA minimum data rate (credit the deadline per bytes
received, cap at the timeout) instead of the per-byte re-arm; and lower
`maxConnections` so the arithmetic closes even without the budget.

### 4. Client identity is the full IPv6 address, and the deploy may not preserve it at all

**Where:** `server/src/smtp/server.ts` `normalizeRemoteIp` folds only
`::ffff:` IPv4-mapped addresses; the per-IP connection map and
`authThrottleKey` (`server/src/pipeline/authThrottle.ts`) key on the full
string. `docker-compose.serve.yml` publishes 25/587/465 as ordinary
Docker port mappings; nothing in the repo mentions `ip6tables`, PROXY
protocol, or host networking.

**Attack, half one.** A routine /64 allocation is 2^64 distinct keys. The
per-IP cap of 20 never bites, the global cap of 1024 is reachable from one
allocation (locking out honest MTAs with 421), and the `(ip, username)`
AUTH throttle is bypassed by rotating the low bits, giving a password
guesser a fresh argon2 budget per address. Postfix aggregates at
`smtpd_client_ipv6_prefix_length = 84`. PLAUSIBLE from code; not run.

**Attack, half two.** Docker publishes IPv4 ports by DNAT, which preserves
the source address, but IPv6 connections to a published port go through
the userland `docker-proxy` unless the daemon has `ipv6` and `ip6tables`
enabled, and then every IPv6 peer arrives from the bridge gateway address.
If the MX has an AAAA record, all IPv6 senders share one per-IP bucket:
one attacker fills 20 connections and every IPv6 MTA in the world gets
421 from virtu. The same collapse happens behind any L4 balancer without
PROXY protocol. UNVERIFIED on the real host; it is a deploy check, and if
it holds it is a P0 because per-IP caps are most of the DoS defence.

**Fix.** Key both maps on a /64 prefix for IPv6 (exact for IPv4). Document
and verify at deploy that maild sees real source addresses on both
families (`docker` daemon `ip6tables: true`, or host networking for maild,
or PROXY protocol from a fronting proxy with an authorized-upstream list
and hang-up on a malformed header, Postfix's
`smtpd_upstream_proxy_protocol` stance). A one-line health check would
be: log the remote address of the first connection from a known IPv6 test
host.

### 5. A second `From:` header switches DMARC off, so `p=reject` domains can be spoofed through the forward

**Where:** `mailauth` `lib/dmarc/verify.js` returns `false` (not
evaluated) whenever the message has any number of `From` headers other
than one. virtu's `noDmarcRecord` (`server/src/mailauth/verify.ts`) treats
`dmarc === false` as "no record", so neither `dmarc-reject` nor
`dmarc-quarantine` fires. `rewriteForward` then rewrites the *first* From
into the reverse alias and its display name.

**Attack.** CONFIRMED (`b.ts`): a message with a forged
`From: ceo@bank.test` on top and any second From below, for a domain
publishing `p=reject`, comes back `dmarc: false`, `dmarcFailed: false`,
`policy: none`; the reject rule does not fire. The same message with a
single From is rejected with 550. The alias owner receives a virtu-signed,
ARC-sealed message whose display name is the forged identity. RFC 5322
requires exactly one From; viadkim and Postfix's cleanup both note the
cardinality, and DMARC (RFC 7489 §6.6.1) says a message with multiple From
headers should be rejected outright.

**Fix.** In `handleInboundData` (and submission), count From fields after
parsing and reject with `550 5.6.0` on anything but exactly one, next to
the existing header-count check. Cheap, and it removes a whole class.

### 6. Verification is synchronous on maild's only event loop, and the budget cannot cancel it

**Where:** `server/src/mailauth/verify.ts` runs `authenticate()` in a
`Promise.race` against a 20 s timer and releases the bulkhead in
`finally`; `mailauth`'s body canonicalization and hashing are synchronous
JS per chunk; there are no worker threads anywhere in the server.

**What it costs.** The auditor first measured 19.6 s for one 20 MiB
message with 8 signatures, but that message was a single 20 MiB line,
which virtu's decoder rejects at 10,000 bytes. Re-measured with 76-byte
lines (`e.ts`, run from `server/`):

| message | wall time | longest event-loop stall |
| --- | --- | --- |
| 1 signature, 20 MiB | 339 ms | 338 ms |
| 8 signatures, distinct `l=`, 20 MiB | 628 ms | 626 ms |
| 8 signatures, no `l=`, 20 MiB | 307 ms | 304 ms |

So roughly 15–30 ms per MiB, doubled when every signature carries a
different `l=` (mailauth keys its body-hash cache on `canon:algo:l`, so
distinct `l=` values defeat the shared pass; viadkim shares one stream per
algorithm). The whole cost lands on the one thread that also runs every
other SMTP connection, submission, and deliverd: during those 600 ms no
other socket is pumped. A peer with 100 Mbit/s of upload can keep the
loop about 30–40 % busy with verify alone, before signing (two more body
passes) and rewrite. The bulkhead of 16 bounds nothing here because the
work is not concurrent, and when the 20 s timer wins the race the
computation keeps running to completion with its slot already released.
CONFIRMED for the cost; PLAUSIBLE for the aggregate throughput claim.

**Fix.** Treat `l=` as unsupported for verification (drop signatures
carrying it before `authenticate`, which also retires round 2's flag rule)
so there is one body pass per canonicalization; make the budget real
(abort the work, or release the bulkhead only when `authenticate` settles);
and, longer term, move verify + sign onto a worker so a 25 MiB message
cannot stall the listener. Postfix gets this for free from
process-per-connection; a single-process design has to buy it.

### 7. `mailauth` does not require `From` in `h=`, and virtu does not oversign its own `From`

**Where:** `mailauth` `lib/dkim/dkim-verifier.js` verifies whatever
headers `h=` lists and never checks that `from` is among them; RFC 6376
§5.4 makes a signature that omits From invalid, and viadkim returns
permerror. `server/src/mailauth/sign.ts` signs the default header list
once each with no oversigning and no `x=`.

**Attack.** CONFIRMED (`a.ts`, `b.ts`): a signature whose `h=` omits From
yields DKIM `pass`, and because DMARC aligns `d=` with the From *domain*,
DMARC `pass` for a `p=reject` domain, though From was never covered. An
attacker who holds any validly signed message from a domain whose signer
omits From (some bulk senders do; prevalence UNVERIFIED) rewrites the From
to any same-domain address and virtu forwards it as authenticated. Half
two: because virtu's own signatures do not oversign From, a party holding
a virtu-signed message can prepend a second From and virtu's signature
still verifies at the next hop (mostly neutralized by #5's fix at
receivers that also reject duplicate From, but not all do).

**Fix.** Post-filter `res.dkim.results`: a `pass` whose
`signingHeaders.keys` lacks `from` is not a pass for policy or DMARC (same
shape as the `l=` rule). On the signing side pass an explicit header list
with From listed twice so mailauth emits `h=from:from:…` (viadkim's
`oversign_headers`), and set `x=` (viadkim default 5 days, the RFC 5321
retry window) so a captured virtu signature cannot be replayed a year
later.

### 8. Lines longer than 998 octets are accepted, signed, and forwarded verbatim

**Where:** `server/src/smtp/server.ts` `maxDataLineLength` default 10,000
and the MX never overrides it; `server/src/smtp/wire.ts` `dotStuff`
normalizes endings and dot-stuffs but never folds.

**What happens.** CONFIRMED (`s5_rewrite.ts`): a 9,999-byte line passes
the decoder and leaves `dotStuff` at 9,999 bytes. RFC 5321's limit is
998. Receivers that fold or truncate (many) change the byte stream, so the
DKIM `bh=` virtu just computed no longer matches and the forward fails
DMARC at the alias owner's provider; receivers that reject with 5.6.0
make the forward a permanent failure, and with round 2's DSN rules that
means a DSN to the authenticated sender. Either way an attacker can send a
victim domain's legitimate-looking mail with one long line to a target
alias and make every such forward fail. Postfix folds at
`smtp_line_length_limit = 998` with CRLF+SPACE on output ("to minimize the
damage to MIME formatted mail") and chops at 2048 on input.

**Fix.** Either lower `maxDataLineLength` to 998 at the MX (reject, simple,
loses a little mail) or fold at 998 in the copy *before* signing, so the
signature covers what goes on the wire, the same ordering rule as round
2's bare-CR fix.

## P2 — hardening

Deployment and edge:

- **STARTTLS handshake has no deadline of its own** (round 2 P2, still
  open). `upgradeServerSocket` waits for `secureConnection` until the 300 s
  command idle timer; each stalled upgrade holds a one-shot `tls.Server`,
  an ephemeral port and three sockets. Postfix `smtpd_starttls_timeout =
  300s`, 10 s under stress. Give the bridge a 30 s deadline.
- **No stress mode.** Postfix's master flips `stress=yes` when the process
  cap is hit and every timeout, error limit and greet-wait shrinks. virtu's
  only reaction to load is the hard connection cap. When connections or
  the in-flight DATA budget (#3) cross a threshold, shorten
  `commandTimeoutMs`/`dataTimeoutMs`, lower the junk limit (#2) to 1, and
  421 new sessions early.
- **HELO is neither length-capped nor neutered before it reaches a
  Received header and the log.** CRLF is collapsed by `sanitizeValue`, but
  control characters pass. Postfix stores HELO through `printable()` and
  `neuter()`. Cap at 255 and replace non-printables.
- **No TLS floor or cipher policy** on the submission listeners or the
  bridge; Bun's defaults apply. Set `minVersion: "TLSv1.2"` and an explicit
  cipher list, and confirm renegotiation is disabled (Postfix sets
  `SSL_OP_NO_RENEGOTIATION` unconditionally).
- **`smtp_rejections.mail_from` is written unclipped and every reject is a
  row** (round 2 P2, still open). Clip to 256 and sample per peer past N
  rejects a minute.
- **No forward-confirmed reverse DNS** on the peer for Received/log. Not a
  defence by itself; Postfix keeps the PTR only when it resolves back.

Authentication:

- **`rsa-sha1` signatures verify to `pass` and cannot be disabled in
  mailauth** (RFC 8301 says reject; viadkim compiles the floor in). Drop
  `a=*-sha1` signatures in `boundSignatureHeaders`. The key-size floor
  needs no change: 1024 is the RFC floor and mailauth already maps shorter
  keys to `policy`, which virtu correctly does not count as pass
  (CONFIRMED `a.ts`).
- **DMARC `temperror` fails open.** A fast SERVFAIL on the DMARC record is
  classified as "no record" and the message is forwarded unauthenticated
  with at most a flag; only the whole-call timeout is fail-closed (451).
  Postfix's stance is `reject_tempfail_action = defer_if_permit`. Make
  temperror on a domain that would otherwise be evaluated a 451.
- **ARC sealing produces an invalid `i=1; cv=pass` for relayed mail.** The
  forward whitelist strips inbound `ARC-*` before sealing, so the seal
  starts a new chain but carries the inbound chain's `cv`. RFC 8617
  requires `cv=none` at `i=1`. Not forgeable (mailauth verifies the chain
  cryptographically; `cv=fail` correctly skips sealing), but downstream
  ARC validation fails for exactly the mailing-list mail ARC exists for.
  Either keep the inbound ARC set and seal at `i=n+1`, or seal a fresh
  `i=1; cv=none`.
- mailauth also skips record `t=s`, `i=`⊆`d=`, the key record's `h=` hash
  restriction, and future-dated `t=`. None yields a spoofed pass on its
  own; note for the day mailauth is swapped or wrapped.

Pipeline and queue:

- **Null MX (RFC 7505) and NXDOMAIN defer for the full retry window.**
  CONFIRMED (`s4_mx.ts`): both classify as transient, so a domain that
  will never accept mail costs 25 tries × a 25 MiB re-send over four days.
  Postfix bounces 5.1.0 / 5.4.4 immediately. Also validate MX exchange
  names (`valid_hostname`) and fail fast rather than letting `dns.lookup`
  reject `evil\0.example`.
- **MX is re-resolved on every attempt of every row**, no TTL or negative
  cache. Batch size bounds it today.
- **`dnsTxt.ts` still does not match the question section** (round 2 P2).
- **A message near the SIZE cap is undeliverable.** SIZE advertises
  `maxMessageSize`, the enqueue cap is the same number, and `signCopy`
  prepends a few KiB of headers, so a legitimate message within that
  margin throws in `enqueue`, 451s, and the sender retries for days.
  Advertise SIZE minus a 64 KiB header margin.
- **Silent non-delivery of verification codes on a queue error.**
  `routes/verificationMail.ts` checks `sent.rateLimited` but not
  `sent.queued`, so a DB or size failure inside `sendTransactional`
  returns "code sent" while nothing was queued. CONFIRMED by reading;
  treat `queued === false` as a retryable 5xx.
- **No per-user fair share in the queue.** Claims are oldest-first, batch
  10, 8 domains concurrent, each with a 5-minute whole-attempt deadline.
  One account whose backlog is oldest and whose 8 destinations are fresh
  tarpits owns the batch for one deadline per pause window; round 2's
  timeout-to-pause bounds the repeat. Postfix's scheduler preempts so a
  bulk sender inflates others' latency by at most k/(k−1). Interleave
  claims by owner.
- **DSNs quote the whole header block.** `MAX_HEADER_FIELDS` caps count,
  not bytes; CONFIRMED (`s3_parsers.ts`) that a 25 MiB message that is one
  folded Subject parses as 2 fields and yields a 25 MB DSN. Guards keep it
  to the SPF-authenticated sender at one per (user, recipient, alias) per
  day, so it is size amplification against oneself. Postfix
  `bounce_size_limit = 50000`; truncate at a field boundary.
- **From-contact minted without validation.** To/Cc/Reply-To run
  `isPlausibleAddress`; the From contact does not, so
  `victim@gmail.com@attacker.example` mints a contact routed to the
  rightmost `@` on reply. Self-directed today; Postfix refuses source-routed
  recipients (554). Validate the From contact like the others.
- **Forward whitelist drops `Auto-Submitted` and `Precedence`.** RFC 3834
  wants them kept so the owner's vacation responder does not answer
  forwarded auto-mail; the reverse alias is dead at the MX so the loop is
  bounded, but keep `Auto-Submitted`.
- **`X-Virtu-Hops` is attacker-writable** (round 2 P2). CONFIRMED harmless:
  garbage and overlong values parse to 0 and each real hop still adds 1,
  so a preset only drops the sender's own mail. Trust it only when our own
  inbound DKIM verifies, when convenient.

## What Postfix and dkim-milter do that virtu should adopt as design, not as fixes

The findings above are the concrete gaps. These are the reflexes behind
them, worth writing into PLAN.md when the P0/P1 batch lands.

1. **Name the memory bound and make it arithmetic.** Postfix's bound is
   `default_process_limit × one message`, and the docs say so. virtu's is
   `maxConnections × maxMessageSize` plus the client buffers plus verify's
   copies, and today it is not written down anywhere the `mem_limit` can be
   checked against. Every buffer a peer fills needs a cap with a reply
   code, on both directions of both sockets (#1, #3).
2. **Deadline, inactivity, and rate are three different clocks.** Postfix
   keeps all three: an inactivity timeout per read, an absolute per-request
   deadline under stress, and a minimum data rate in DATA. virtu has the
   first two since round 2 and lacks the third (#3).
3. **Count everything the peer does, not only its failures.** Junk
   commands, recipients past the limit, AUTH attempts, TLS handshakes,
   messages and recipients per client per minute: each has its own counter
   and its own 421/450 in Postfix. virtu counts errors only (#2, #4).
4. **Client identity is a prefix, and it must survive the deployment.**
   Postfix aggregates IPv6 at /84 and refuses XCLIENT/XFORWARD/PROXY from
   anyone not on an explicit list (#4).
5. **Stress is a mode.** When the process cap is hit, master restarts the
   service with `stress=yes` and every limit tightens through
   `${stress?{a}:{b}}` defaults. A single-process server needs the same
   lever, driven by its own connection count and byte budget.
6. **Reject at RCPT, never bounce; and never bounce more than 50 KB.**
   virtu already holds this line well (round 2 #10, the SPF-vouched return
   path, headers-only DSNs). The remaining gap is the size cap.
7. **Fail closed on backend errors, fail open on abuse counters.** Postfix
   450s on any table or DNS error and permits when anvil is down. virtu's
   runHook → 451 matches; the DMARC temperror branch does not.
8. **Every stage distrusts the previous one, and normalizes before it
   signs.** Postfix replaces stray CR/LF in cleanup *before* any milter
   signs; folds long lines on output; drops Bcc/Return-Path/Delivered-To on
   the way in. virtu does all of this except the fold (#8), and the
   ordering rule (normalize, then sign, then send exactly those bytes) is
   the one to keep repeating.
9. **RFC floors belong in code, not config.** viadkim compiles in the
   1024-bit RSA floor and the sha1 rejection and exposes only stricter
   knobs; From must be signed, every instance of it. virtu inherits
   mailauth's more permissive defaults and has to wrap them (#5, #7, sha1).
10. **Annotate, don't decide, and strip your own name.** dkim-milter
    deletes inbound Authentication-Results carrying its own authserv-id
    before adding its own. virtu goes further and drops all of them via
    the whitelist, which is right for a forwarder.
11. **Policy returns a reply string; mechanism sends it.** Postfix's
    `smtpd_check.c` has five entry points that return the reply and never
    touch the socket. virtu's `policy.ts` already has this shape. Keep it
    that way when adding #2 and #3 (the counters live in the connection
    class, the decision text does not).
12. **A dead destination costs one connect, not one per message.** Postfix
    marks a site dead after one failed window and defers the rest without
    connecting. virtu's destination pause is the same idea; the queue's
    fairness gap and the null-MX classification are the loose ends.

## What held up

Recorded so the next round does not re-audit them. All CONFIRMED by running
the real module unless noted.

- **SMTP smuggling, inbound.** Only `\r\n.\r\n` ends DATA; `\n.\n`,
  `\r\n.\n`, `\n.\r\n` and `\r.\r\n` are consumed as content, and every
  bare LF is rewritten to CRLF in the decoder (`smug2.ts`). Postfix 3.9's
  `smtpd_forbid_bare_newline = normalize` behaviour.
- **SMTP smuggling, outbound.** `dotStuff` emits no bare LF and dot-stuffs;
  a crafted stored raw with `\r.\rMAIL FROM…` reached a byte-logging fake
  MX with every bare-LF `.` form as `..` and only the true terminator on
  the wire (`s1_smuggle.ts`). Bare CR survives in the body, as in Postfix,
  and no LF-terminating receiver treats it as end-of-data.
- **Parser differential virtu vs mailauth.** `parseMessage` and mailauth
  agree on the header/body boundary for CRLF, bare LF, `\r\n\n`, CR-CR-LF,
  a whitespace-only "blank" line and NUL in a value (`c.ts`). The one
  divergence (a message whose first line starts with whitespace) is
  neutralized by the whitelist.
- **Command line cap 2048 with resync**, AUTH lines through the same cap
  (Postfix allows 12288; virtu is stricter), `maxErrors` 10 → 421, the
  101st RCPT refused before any lookup, DATA with zero recipients → 554.
- **Round 2's backpressure** re-tested: socket paused around every hook and
  on `writableNeedDrain`, 1 MiB pipelined cap → 421, 30-minute session
  deadline.
- **Fail-closed hooks.** An exception in any hook is a 451; verify
  timeout and bulkhead are 451; unknown alias is a correct 550 5.1.1.
- **AUTH.** EHLO first, TLS unconditional, refused during a transaction,
  failures count as errors, throttle checked before hashing, bulkhead of 4
  sheds with 454 before argon2, misses burn a dummy verify.
- **Signature cap ordering.** `boundSignatureHeaders` runs on raw bytes
  before mailauth and keeps the top-most 8, as viadkim does; ARC sets past
  10 drop all ARC headers before mailauth.
- **Forged Authentication-Results / ARC.** All inbound A-R and ARC-* are
  dropped by the whitelist; policy reads the structured result, never
  header text.
- **Multi-string TXT keys.** The wire-format TXT client is what mailauth
  gets, and it reassembles character-strings, so 2048-bit keys split across
  strings verify. The CLAUDE.md `node:dns` caveat is correctly handled.
- **Weak keys.** A 512-bit key maps to `policy`, which DMARC does not
  count; `k=` mismatch, empty `p=`, wrong `v=` are all non-pass.
- **The `l=` flag rule** reads `canonBodyLengthLimited`, the right field,
  and does not fire when a full-body signature also passes.
- **Submission's signing boundary.** MAIL FROM ownership is enforced and
  `rewriteReply` replaces From with the authenticated user's own alias;
  no free user can obtain a virtu signature over a third-party From.
- **Loop injection via `Delivered-To`.** Inbound `Return-Path`,
  `Delivered-To`, `X-Original-To`, `Bcc`, `Received` are all dropped and
  virtu adds no `Delivered-To`, so an attacker cannot make the owner's
  Postfix reject every forward as 5.4.6.
- **Hop counter** drops at 2; the mailbox route refuses alias-domain and
  verified-MX-domain addresses; reverse aliases are dead at the MX, so
  auto-responder ping-pong cannot form.
- **VERP.** HMAC-SHA3-224 truncated to 64 bits, constant-time compare,
  5-day window, message-scoped id, idempotent bounce recording; a captured
  address replays to a no-op and `looksLikeDsn` gates intake.
- **Never bounce a bounce**, forward DSNs only to SPF-vouched return paths,
  `flag` verdicts get no DSN, DSNs carry `Auto-Submitted: auto-replied`.
- **Egress guard** by parsed bytes, IP-literal MX refused, blocked targets
  fail permanently.
- **Parsers are linear.** 100k addresses in 183 ms, 1M nested comments in
  76 ms, a 25 MiB single folded field in 128 ms; DSN bodies are matched by
  regex, not a MIME walk, so there is no nesting to exhaust.

## Unverified

- Whether the production host preserves IPv6 source addresses through
  Docker (#4, half two). A deploy-time check; decides P1 vs P0.
- The aggregate throughput claim in #6 (one peer keeping the loop 30–40 %
  busy) is arithmetic from the measured per-MiB cost, not a load test
  against maild.
- The prevalence of DKIM signers that omit From from `h=` (#7).
- The OOM in #1 was measured on the bare client in a Bun process, not
  inside the container under `mem_limit`; the crash-loop consequence is
  inferred from the compose file.
- mailauth computes `t=` twice with independent `Date.now()` calls; across
  a second boundary the emitted `t=` could differ from the signed one and
  invalidate an outbound signature. Noticed in code, not reproduced.

## Suggested order

1. #1 client reply cap (an afternoon; mirrors round 2's server fix; unit
   test with a fake MX that streams).
2. #5 exactly-one-From at DATA (an hour; unit + int test).
3. #4 /64 keying plus the deploy check for IPv6 source addresses (an
   hour of code, a README "Deploy" paragraph, one test on a real box).
4. #2 junk/command limits and #3 DATA byte budget + min data rate, together
   in the connection class, with the stress lever from the P2 list if it
   is cheap once the counters exist.
5. #7 From-in-`h=` post-filter and From oversigning + `x=`; #8 the 998
   fold before signing.
6. #6 `l=` drop and a real budget for verify; the worker-thread move can
   wait for evidence of load.
7. The P2 list, starting with the verification-code `queued` check and the
   null-MX classification since both are correctness bugs, not hardening.
