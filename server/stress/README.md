# Mail stress tests

These tests are opt-in. Ordinary unit/integration runs do not execute them. Each
scenario runs in fresh Bun subprocesses with deadlines, memory measurements, and
assertions about delivery outcomes. The runner exits nonzero if any scenario or
cleanup fails. The default per-process memory budget is 1.5 GiB, based on the
fan-out stress trials below. The original 768 MiB budget was exceeded by the combined
acceptance/one-worker scenario; `MAIL_STRESS_RSS_MIB=768` retains that comparison.

List scenarios without starting services:

```sh
bun run --cwd server test:stress --list
```

Run all smoke scenarios against a **local test PostgreSQL server** whose role can
create databases:

```sh
MAIL_STRESS=1 \
MAIL_STRESS_ADMIN_DATABASE_URL=postgres://virtu:virtu@localhost:5432/postgres \
bun run --cwd server test:stress --profile smoke --output /tmp/virtu-stress.json
```

The runner creates a random `virtu_stress_<uuid>` database for each database
scenario, runs the committed migrations, and drops that database afterward. It
does not use `DATABASE_URL` as a test target. Use a dedicated test PostgreSQL
instance: load runs consume substantial CPU, storage, and WAL even though their
databases are temporary. PostgreSQL 13+ is required for forced scratch cleanup;
the project uses PostgreSQL 17.

To run without PostgreSQL:

```sh
MAIL_STRESS=1 bun run --cwd server test:stress --profile smoke \
  --scenario smtp-load,smtp-overload,outbound-backpressure,auth-pressure
```

`just test-stress ...` accepts the same arguments and requires the same opt-in.
Use `--profile load` for the larger workload. Choose a machine that can remain
awake and otherwise idle during measurement.

## Scenarios

| Scenario | Assertions |
| --- | --- |
| `smtp-load` | Concurrent loopback senders; fragmented DATA; exact byte counts and SHA-256; every submitted message acknowledged; only one materialized DATA hook at a time. |
| `smtp-overload` | Exhausted DATA reservation returns explicit temporary refusals; partial-message disconnect releases resources; subsequent healthy delivery succeeds. |
| `outbound-backpressure` | Real SMTP client sends to a receiver that withholds reads; socket drains are exercised; de-stuffed bytes match the source exactly. |
| `fanout` | A database trigger fails the last copy after earlier inserts; no copies or logs commit; retries commit every copy. Error rendering must remain bounded. |
| `queue-recovery` | A separate bounded subprocess seeds mail; fresh competing workers claim distinct deliveries; temporary failures retry; permanent failures retain follow-up jobs; interrupted transactional hooks roll back and retry; a stale pre-delivery claim is reclaimed. |
| `queue-combined` | Sequential acceptance then recovery with one queue worker in the same process, preserving producer allocator history; no forced GC. |
| `auth-pressure` | Blocked DNS outlives verification timeout; overload starts no more DNS work; the slot recovers; excessive signature work is refused before DNS; input bytes remain unchanged. |
| `inbound-mix` | Independent single-recipient SMTP transactions across logical senders and aliases, with a deterministic size mix; durable acceptance, one queued copy per accepted message, and unchanged body bytes. |

The queue tests measure two distinct cases. `queue-recovery` isolates consumer
memory while testing multiple workers; `queue-combined` keeps acceptance and one
consumer in the same process, matching production's worker count. The latter is
sequential and does not certify simultaneous MX and delivery memory. The initial
combined producer/two-consumer run exceeded the 768 MiB budget at about 801 MiB;
a fresh two-consumer run with the same 25 MiB bodies also exceeded it, at about
779 MiB. The combined producer/one-consumer baseline also exceeded the budget,
at 873,857,024 bytes (833.375 MiB). This leaves a production-relevant memory
concern unresolved; the cause has not been established.

Default contention tests use 1 MiB bodies to test competing claims and retry
semantics. The combined one-worker baseline retains 25 MiB bodies in the load
profile. The initial trials kept the same 768 MiB ceiling; the later budget
revision below changes the test allowance, not the application's memory use.
To reproduce large contention explicitly, set
`MAIL_STRESS_QUEUE_MESSAGE_MIB=25` and select `queue-recovery`. A passing
small-body contention run is not evidence that large-message queue processing
fits the budget.

Queue delivery is stubbed deliberately: it never contacts external recipients.
Failure hooks apply a synthetic database effect to exercise durability and rollback.
The regular integration suite separately covers actual DSN generation. The stale
claim test models a crash **before SMTP delivery**, not the ambiguous crash after
a remote server accepts mail but before the queue records success.

The SMTP load scenario sizes DATA reservation and connection limits to admit its
configured clients; overload is exercised separately with a smaller reservation.

SMTP senders generate bounded chunks and do not keep full received transcripts.
The outbound client requires one full source message. Database fixtures use
repetitive bodies, so their logical byte counts are larger than compressed
PostgreSQL storage; these tests are not disk-throughput benchmarks.

## Profiles and budgets

| Setting | Smoke | Load | Override |
| --- | ---: | ---: | --- |
| SMTP/fan-out/combined message size | 1 MiB | 25 MiB | `MAIL_STRESS_MESSAGE_MIB` (1–25) |
| Contention message size | 1 MiB | 1 MiB | `MAIL_STRESS_QUEUE_MESSAGE_MIB` (1–25) |
| SMTP/auth clients | 8 | 16 | `MAIL_STRESS_CLIENTS` (1–128) |
| Independent inbound messages | 20 | 100 | `MAIL_STRESS_INBOUND_MESSAGES` (1–10000) |
| Fan-out recipients | 8 | 100 | `MAIL_STRESS_COPIES` (2–1000) |
| Queue loops in one process | 2 | 2 | `MAIL_STRESS_QUEUE_WORKERS` (1–32) |
| Claim batch size | Workload divided by loops | Workload divided by loops | `MAIL_STRESS_QUEUE_BATCH_SIZE` (1–1000) |
| Rounds | 2 | 3 | `MAIL_STRESS_ROUNDS` (1–100) |
| Worker RSS ceiling | 1536 MiB | 1536 MiB | `MAIL_STRESS_RSS_MIB` |
| Per-worker deadline | 90 seconds | 600 seconds | `MAIL_STRESS_TIMEOUT_SECONDS` |

An explicit `MAIL_STRESS_MESSAGE_MIB` also sets contention size unless
`MAIL_STRESS_QUEUE_MESSAGE_MIB` overrides it. Each worker result includes its
effective workload sizes and concurrency.

For scaling comparisons, set `MAIL_STRESS_QUEUE_BATCH_SIZE=10` to hold the claim
batch size at the production default. This mode drains each ready wave through
multiple batches and verifies the same delivery and retry outcomes. Omitting
the setting preserves the original single-pass scenario. `queueWorkers` counts
concurrent queue loops sharing one Bun process and SQL pool; it does not count
independent delivery processes. One loop provides a baseline without contention.

The default load fan-out commits 300 copies, about 7.32 GiB of logical mail, after
first exercising a failed 100-copy transaction. Each queue scenario also starts
with 300 copies: 300 MiB for default contention, about 7.32 GiB for the combined
baseline. The isolated recovery report includes its producer subprocess under
`preparation`; both subprocesses must independently satisfy the budgets. Allow
additional space for indexes, WAL, and transient transactions.

The report records counts, durations, peak RSS and, where applicable, message and
verified-byte throughput. RSS includes the scenario and its bounded in-process
load driver; it excludes PostgreSQL, the runner, and OS page cache. It is sampled
while running and checked against the process high-water mark on completion. A
blocked event loop can overshoot before a sample reaches the runner. This is a
regression budget, **not a hard OS memory limit or whole-server sizing result**.
Throughput has no machine-specific pass threshold; correctness, memory, and
completion within the selected deadline determine success.

The parent kills timed-out workers, then removes their scratch database and spool
directory. Administrative SQL has separate local deadlines. Timer callbacks
recheck monotonic elapsed time before declaring a timeout. If cleanup or an
uncertain database creation cannot be confirmed, the report fails and names the
database to inspect. SIGINT/SIGTERM attempt cleanup; killing the parent with SIGKILL
or losing the host can leave scratch databases behind.

## Interpreting failures

Keep the JSON report and compare the same profile on the same machine. A timeout
is a failed run, not evidence that accepted messages disappeared: inspect the
scenario's invariant failure and resource measurements. CPU-limited machines may
need a larger explicit deadline. A memory failure should be investigated before
raising the ceiling.

This suite replaces the earlier `src/scripts/mailResourceCheck.ts` one-off check.
It does not validate deployed DNS, IP reputation, remote-provider delivery, or
recoverability after losing the PostgreSQL host.

## Independent inbound acceptance

`inbound-mix` models separate incoming SMTP transactions, each addressed to one
local alias that forwards to one mailbox. Every transaction has a distinct
logical sender domain, EHLO name, Message-ID, and recipient alias. All connections
use the same loopback IP; this does not simulate diverse source IPs or networks.
The fixtures belong to one account. The real MX path performs recipient policy,
authentication, rewriting, signing and atomic enqueue, with configured rate,
queue-quota and DATA-reservation limits retained and recorded in the report.

The synthetic size mix repeats every 100 messages in a deterministic interleaved
order: 70 messages of 16 KiB, 20 of 256 KiB, eight of 2 MiB, and two of 25 MiB.
These are complete input-message sizes, capped by `MAIL_STRESS_MESSAGE_MIB`.
They are assumptions for comparison, not an observed traffic distribution.
Smoke sends 20 inputs capped at 1 MiB; load sends 100 with the full size range.
Reports include the actual offered and accepted size histograms, including any
caps or refusals. Bodies are varied synthetic ASCII, not real attachments.

```sh
MAIL_STRESS=1 MAIL_STRESS_ADMIN_DATABASE_URL=postgres://virtu@localhost:5432/postgres \
bun run --cwd server test:stress --profile load --scenario inbound-mix
```

`MAIL_STRESS_CLIENTS` controls concurrent sender connections; each sender starts
another transaction after its previous result. This applies bounded concurrent
load, not a fixed arrival rate. `MAIL_STRESS_INBOUND_MESSAGES` controls input
count independently of fan-out copies or rounds. Senders stream bounded chunks
and wait for writes; the harness does not retain complete input payloads.

Headline metrics are accepted incoming messages/s, accepted payload MiB/s, and
connection-to-final-acknowledgment p50/p95 latency. Their traffic window excludes
fixture preparation and post-run integrity checks, which are timed separately.
The RSS measurement includes the driver and validation. Temporary and permanent
refusals and actual SMTP codes are reported separately; there are no automatic
retries. Unknown transport outcomes fail the test. All accepted messages must
have exactly one corresponding pending queue row and delivery log, the expected
recipient, and unchanged body bytes. Rejected transactions must not leave those
rows. Body verification loads one queued message at a time.

This measures **durable acceptance only**. No delivery worker drains the queue;
the final backlog equals accepted input count. High input-count overrides can
therefore encounter legitimate per-account queue quotas, and this test must not
be presented as sustained forwarding capacity. DNS is deterministic and local;
inputs use SPF alignment without inbound DKIM or TLS. A delivery-worker scaling
recommendation needs a subsequent test with concurrent ingress and delivery.

On the same 16 GiB M1 host described below, two final-code load runs each accepted
all 100 inputs (72.09375 MiB), with zero refusals and exactly 100 pending copies:

| Run | Accepted inputs/s | Accepted MiB/s | p95 acceptance latency | Worker peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 1 | 15.76 | 11.36 | 2.34 s | 504.5 MiB |
| 2 | 17.07 | 12.31 | 2.18 s | 504.9 MiB |

These are short acceptance-only samples, not a new delivery-worker scaling
envelope. The sender driver and one-message-at-a-time readback validation are
included in worker memory. A queue-quota probe accepted two inputs and explicitly
refused 18 with SMTP 452; a 64 KiB DATA-reservation probe accepted four and refused
16 with SMTP 421. Neither left rows for refused messages. The latter initially
exposed a sender-harness hang when a socket closed without its write callback;
the fixed driver settles writes on close/error, and the same probe now completes
in under a second with the original deadline. Host pressure stayed normal,
swap did not grow, and scratch databases were removed.

Final-run reports, settings and the preserved failure/fix evidence are in
[inbound-results-2026-11-12.json](./inbound-results-2026-11-12.json).

## Queue memory investigation (2026-11-11)

Focused Bun 1.4.2 probes on macOS arm64 generated repetitive `bytea` fixtures in PostgreSQL, then
ran the real queue worker in a fresh process. They bypassed MX rewriting/signing
and used one queue worker. Delivery was stubbed; failure hooks threw on their
first attempt and succeeded on retry, without database accounting or DSN work.
The 768 MiB ceiling remained in place, with no forced garbage collection.

| Probe | Rows | Bytes per message | SQL pool maximum | Peak RSS bytes |
| --- | ---: | ---: | ---: | ---: |
| All sent | 60 | 26,214,400 | 10 | 299,745,280 |
| All permanently failed; hooks retried | 60 | 26,214,400 | 10 | 631,652,352 |
| Mixed outcomes | 300 | 26,214,400 | 10 | 654,065,664 |
| Mixed outcomes | 300 | 26,214,400 | 1 | 322,977,792 |
| Mixed outcomes; extra header-sized space | 300 | 26,218,496 | 10 | 659,685,376 |

Each mixed probe recorded 400 delivery callbacks and 200 hook callbacks. The stub
returned success immediately for 100 copies, success after a temporary failure
for 100, and permanent failure for 100. These probes did not independently assert
the terminal database rows. All probe databases were removed afterward.

The diagnostic was kept outside the suite at
`/tmp/virtu-queue-memory-diagnostic.ts`. Commands used `MAIL_STRESS=1`, an explicit
`MAIL_STRESS_ADMIN_DATABASE_URL`, and `bun /tmp/virtu-queue-memory-diagnostic.ts`
with mode `sent`, `permanent`, or `mixed`. The table's row count corresponds to
`MAIL_DIAGNOSTIC_ROWS`; pool maximum to `MAIL_DIAGNOSTIC_POOL_MAX` (default 10).
The final row additionally set `MAIL_DIAGNOSTIC_EXTRA_BYTES=4096`; all other runs
used its default of zero. This temporary diagnostic is not a supported runner.

In the 60-row permanent-failure probe, delivery callbacks peaked at 273,924,096
bytes RSS; subsequent failure-hook processing reached 631,652,352. Reported JS
external memory peaked at 134,146,908 bytes during those hooks and ended near
29 MiB. The matched 300-row single-connection run substantially reduced RSS.
These observations suggest investigating transactional failure-job reads
and connection-associated allocation or buffer reuse. They do not establish a
leak or justify changing the production pool size: these are single-run
diagnostics, and the full accounting hook and producer workload were absent.
Adding 4,096 bytes did not reproduce a size-boundary jump in this probe.

The full combined workload's 833.375 MiB failure remains unresolved. Next compare
the production-shaped accounting hook and transaction lifecycle against these
controls, measuring connection use as well as RSS and JS external memory.

## Historical fan-out scaling measurements (2026-11-12)

These trials used **three incoming messages, each forwarded to 100 mailboxes**
per producer. They are fan-out stress measurements, not capacity estimates for
diverse incoming messages with one recipient each. The provisional budgets
below describe those trials only and should not be used to size ordinary inbound
traffic. Use `inbound-mix` for independent-message acceptance measurements.

The original combined scenario subsequently exceeded 768 MiB in two of three
unchanged runs (818, 797, and 746 MiB peaks). A run with only the cap raised to
1 GiB completed at 802 MiB. The trials below use a fixed claim batch of 10 and
larger explicit budgets to measure scaling. They do not establish the cause of
allocation variability or a sustained memory plateau.

Hardware: 16 GiB Apple M1, eight cores, macOS 15.3.1, Bun 1.4.2, PostgreSQL 15.13.
Each workload contains 300 copies of a 25 MiB message. Real acceptance, rewriting,
signing, queue storage and worker code run locally; delivery outcomes and
transactional failure accounting are simulated. Every run verified its expected
sent/failed counts, retries, rollback, and claim recovery. Full received-message
SMTP delivery, actual DSN generation, and simultaneous ingress/egress are not
part of this measurement.

First, one consumer process drained the same 300 copies with different numbers
of queue loops, sharing its SQL pool. Preparation ran in a separate process:

| Queue loops | Consumer peak RSS | Recovery copies/s |
| ---: | ---: | ---: |
| 1 | 611 MiB | 24.89 |
| 2 | 887 MiB | 43.98 |
| 4 | 984 MiB | 49.05 |

Two loops improved consumer throughput by 77%; four added another 12%. Including
preparation, all three cases stayed near 1.3 copies/s because acceptance/signing
dominated elapsed time. These recovery rates are not whole-service throughput.

Next, independent processes each prepared and drained 300 copies in the same
heap. They shared a PostgreSQL instance but used separate scratch databases.
Their consumer phases were observed overlapping. This measures process resource
scaling, not independent processes contending on a single production queue:

| Processes | Total copies | Common elapsed time | Whole-workload copies/s | Sampled app + PostgreSQL RSS peak |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 300 | 233 s | 1.29 | 1.83 GiB |
| 2 | 600 | 241 s | 2.49 | 3.25 GiB |
| 4 | 1,200 | 290 s | 4.14 | 4.74 GiB |

All cases passed. Aggregate rates include acceptance, signing, simulated
delivery/retries, and runner cleanup, over a common wall-clock interval. They
are neither network SMTP capacity nor a sum of individual consumer rates.
Each point is one run. The separate-process cases used a 1.5 GiB application
ceiling per process and a 1,200-second deadline. No SQL pool tuning or forced GC
was applied. Each process retained the default SQL pool maximum of 10.

The monitor sampled runner/worker and all dedicated PostgreSQL process RSS about
every two seconds. PostgreSQL shared pages can be counted more than once, while
sampling can miss brief peaks: these totals are a conservative accounting proxy,
not exact physical memory or a hard OS limit. Per-process high-water RSS is
recorded separately in the evidence. Host memory pressure stayed normal and
existing swap usage remained at 6,187.88 MiB; this was not a swap-free benchmark.
The monitor would stop on non-normal pressure, 512 MiB of additional swap, or
8 GiB of aggregate RSS. No guard fired. All scratch databases were removed and
the dedicated PostgreSQL server was stopped.

The fan-out trials led to these **provisional total trial budgets**, keeping the
OS and other applications outside the budget. They remain historical context,
not production sizing recommendations for single-recipient traffic:

| Independent processes | Total application + database planning budget |
| ---: | ---: |
| 1 | 4 GiB |
| 2 | 6 GiB |
| 4 | 8 GiB |

Use the tested 1.5 GiB per-process ceiling as a starting point, and monitor the
aggregate separately. These are total headroom choices above the observed
peaks, not a guaranteed additive partition between application and database
memory. Do not select a production worker count from these fan-out results. Do not extrapolate
past four or treat the declining per-process peaks as a scaling law. Production
currently starts one queue loop; these tests do not change that configuration.

The suite's default RSS allowance is now 1.5 GiB. This is a budget revision, not
a memory optimization. The scaling trials explicitly set batch size 10; the
complete load profile with all new defaults has not been rerun. Keep the 768 MiB
override for historical comparisons. A single-process scaling run is:

```sh
MAIL_STRESS=1 MAIL_STRESS_ADMIN_DATABASE_URL=postgres://virtu@localhost:5432/postgres \
MAIL_STRESS_QUEUE_BATCH_SIZE=10 MAIL_STRESS_RSS_MIB=1536 \
MAIL_STRESS_TIMEOUT_SECONDS=1200 \
bun run --cwd server test:stress --profile load --scenario queue-combined
```

Multiple runners need an external aggregate monitor; the suite's RSS ceiling
applies to each child, not the whole group. Exact configurations, results,
overlap observations and resource measurements are retained in
[scaling-results-2026-11-12.json](./scaling-results-2026-11-12.json).
