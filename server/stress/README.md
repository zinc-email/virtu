# Mail stress tests

These tests are opt-in. Ordinary unit/integration runs do not execute them. Each
scenario runs in fresh Bun subprocesses with deadlines, memory measurements, and
assertions about delivery outcomes. The runner exits nonzero if any scenario or
cleanup fails. The full load profile has not passed the 768 MiB memory budget:
the combined acceptance/one-worker scenario exceeded it during validation.

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
profile and the same 768 MiB ceiling. This separation does not resolve or waive
the observed memory failures. To reproduce large contention explicitly, set
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
| Fan-out recipients | 8 | 100 | `MAIL_STRESS_COPIES` (2–1000) |
| Competing queue workers | 2 | 2 | `MAIL_STRESS_QUEUE_WORKERS` (2–32) |
| Rounds | 2 | 3 | `MAIL_STRESS_ROUNDS` (1–100) |
| Worker RSS ceiling | 768 MiB | 768 MiB | `MAIL_STRESS_RSS_MIB` |
| Per-worker deadline | 90 seconds | 600 seconds | `MAIL_STRESS_TIMEOUT_SECONDS` |

An explicit `MAIL_STRESS_MESSAGE_MIB` also sets contention size unless
`MAIL_STRESS_QUEUE_MESSAGE_MIB` overrides it. Each worker result includes its
effective workload sizes and concurrency.

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
