import assert from "node:assert/strict";
import { and, count, eq, sql } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import {
  aliases,
  aliasMailboxes,
  dkimKeys,
  emailLogs,
  mailboxes,
  outboundMessages,
  users,
} from "../src/db/schema.ts";
import { createLogger } from "../src/log.ts";
import { makeRsaKeyPair, makeStubResolver } from "../src/mailauth/test-fixtures.ts";
import { handleInboundData } from "../src/mx.ts";
import {
  processFailureJobs,
  processQueueOnce,
  type QueueWorkerOptions,
} from "../src/queue/worker.ts";
import { reapStuckSending } from "../src/queue/reaper.ts";
import { assertScratchDatabase, type StressConfig } from "./config.ts";

const logger = createLogger("mail-stress-db", { write: () => {} });
const QUEUE_OWNER = "queue-owner@mail-stress.invalid";

function progress(scenario: string, phase: string, round?: number) {
  console.error(JSON.stringify({ type: "progress", scenario, phase, round }));
}

function guard() {
  assert.equal(
    process.env.MAIL_STRESS_WORKER,
    "1",
    "Only the isolated stress worker may run DB scenarios",
  );
  assertScratchDatabase(process.env.DATABASE_URL ?? "");
}

function message(bytes: number, recipient: string): Buffer {
  const header = Buffer.from(
    `From: sender@sender.test\r\nTo: ${recipient}\r\nSubject: database stress\r\n\r\n`,
  );
  assert(bytes >= header.length + 2);
  const raw = Buffer.alloc(bytes);
  header.copy(raw);
  const line = Buffer.from(`${"x".repeat(990)}\r\n`);
  for (let offset = header.length; offset < bytes; offset += line.length) line.copy(raw, offset);
  // Avoid truncating a CRLF into a bare CR or exceeding the line limit.
  raw[bytes - 2] = 13;
  raw[bytes - 1] = 10;
  return raw;
}

async function fixture(config: StressConfig, ownerEmail?: string) {
  guard();
  const domain = `${crypto.randomUUID()}.test`;
  const [user] = await db
    .insert(users)
    .values({ email: ownerEmail ?? `owner@${domain}`, activated: true })
    .returning();
  assert(user);
  const boxes = await db
    .insert(mailboxes)
    .values(
      Array.from({ length: config.copies }, (_, i) => ({
        userId: user.id,
        email: `box${i}@dest${i}.${domain}`,
        verified: true,
      })),
    )
    .returning();
  const [alias] = await db
    .insert(aliases)
    .values({ userId: user.id, email: `alias@${domain}`, mailboxId: boxes[0]!.id })
    .returning();
  assert(alias);
  await db
    .insert(aliasMailboxes)
    .values(boxes.map((box) => ({ aliasId: alias.id, mailboxId: box.id })));
  const key = makeRsaKeyPair();
  await db.insert(dkimKeys).values({
    domain,
    selector: "stress",
    privateKeyPem: key.privateKeyPem,
    publicKeyBase64: key.publicKeyBase64,
  });
  const raw = message(config.messageBytes, alias.email);
  const end = raw.indexOf("\r\n\r\n") + 4;
  const accept = () =>
    handleInboundData(
      {
        raw,
        headers: raw.subarray(0, end),
        body: raw.subarray(end),
        session: { id: domain, remoteAddress: "192.0.2.1", remotePort: 1234, tls: false },
        envelope: {
          heloName: "sender.test",
          tls: false,
          mailFrom: "sender@sender.test",
          params: {},
          rcptTo: [{ address: alias.email, params: {} }],
        },
      },
      {
        db,
        mailDomain: domain,
        mailHostname: `mx.${domain}`,
        dkimSelector: "stress",
        verpSecret: "stress-test-secret-long-enough-12345",
        maxMessageSize: raw.length,
        resolver: makeStubResolver({ TXT: { "sender.test": "v=spf1 ip4:192.0.2.1 -all" } }),
        logger,
      },
    );
  return { user, boxes, alias, accept };
}

async function queueStats(userId: number) {
  const [stats] = await db
    .select({
      count: count(),
      bytes: sql<number>`coalesce(sum(octet_length(${outboundMessages.raw})), 0)`.mapWith(Number),
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, userId));
  return stats!;
}

export async function runFanout(config: StressConfig): Promise<Record<string, number>> {
  const started = Date.now();
  const f = await fixture(config);
  progress("fanout", "fixture-created");
  assert(config.copies >= 2, "Fanout fault requires at least two copies");
  const name = `stress_insert_${f.user.id}`;
  await db.execute(sql.raw(`CREATE SEQUENCE ${name}_hits`));
  // The trigger is scoped to this fixture and fails only after earlier inserts
  // have succeeded inside the real acceptance transaction.
  await db.execute(
    sql.raw(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id = ${f.user.id} AND (SELECT count(*) FROM outbound_messages WHERE user_id = ${f.user.id}) >= ${config.copies - 1} THEN PERFORM nextval('${name}_hits'); RAISE EXCEPTION 'injected later fanout insert'; END IF; RETURN NEW; END $$`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE INSERT ON outbound_messages FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    ),
  );
  let refused = false;
  let insertError: unknown;
  progress("fanout", "fault-transaction-started");
  try {
    const result = await f.accept();
    refused = !("accept" in result);
  } catch (error) {
    insertError = error;
    refused = true;
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON outbound_messages`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  }
  assert(refused, "Injected insert failure must prevent acceptance");
  assert(insertError instanceof Error, "Expected the injected database failure");
  assert(insertError.message.length < 1024, "Query error expanded message content");
  assert(String(insertError).length < 1024, "Query error representation is unbounded");
  // Sequence advancement survives rollback and proves the later-insert fault fired.
  const hits = await db.execute(sql.raw(`SELECT is_called FROM ${name}_hits`));
  assert.equal(hits[0]!.is_called, true, "Failure injection was never reached");
  await db.execute(sql.raw(`DROP SEQUENCE ${name}_hits`));
  assert.equal((await queueStats(f.user.id)).count, 0, "Partial fanout survived failed DATA");
  const [logs] = await db
    .select({ n: count() })
    .from(emailLogs)
    .where(eq(emailLogs.userId, f.user.id));
  assert.equal(logs!.n, 0, "Delivery logs survived failed DATA");
  progress("fanout", "rollback-verified");
  for (let i = 0; i < config.rounds; i++) {
    assert("accept" in (await f.accept()), "Retry was not accepted");
    progress("fanout", "round-accepted", i + 1);
  }
  const stats = await queueStats(f.user.id);
  assert.equal(stats.count, config.copies * config.rounds);
  assert(stats.bytes >= stats.count * config.messageBytes);
  return {
    acceptedCopies: stats.count,
    queuedBytes: stats.bytes,
    failedTransactionRows: 0,
    failureErrorBytes: insertError.message.length,
    elapsedMs: Date.now() - started,
  };
}

/** Producer runs in its own bounded process; its buffers and allocator caches
 * must not become part of the independently measured delivery process. */
export async function seedQueue(config: StressConfig): Promise<Record<string, number>> {
  const started = Date.now();
  const f = await fixture(config, QUEUE_OWNER);
  progress("queue-seed", "fixture-created");
  for (let i = 0; i < config.rounds; i++) {
    assert("accept" in (await f.accept()));
    progress("queue-seed", "round-accepted", i + 1);
  }
  const stats = await queueStats(f.user.id);
  assert.equal(stats.count, config.copies * config.rounds);
  assert(stats.bytes >= stats.count * config.messageBytes);
  progress("queue-seed", "seeded");
  return { acceptedCopies: stats.count, queuedBytes: stats.bytes, elapsedMs: Date.now() - started };
}

/** Sequential shared-heap baseline for maild's producer plus one delivery
 * worker. No forced GC: producer allocator history remains part of the limit. */
export async function runQueueCombined(config: StressConfig): Promise<Record<string, number>> {
  const started = Date.now();
  const seed = await seedQueue(config);
  const seedPeakRssBytes = Math.max(
    process.memoryUsage().rss,
    process.resourceUsage().maxRSS * 1024,
  );
  progress("queue-combined", "producer-finished");
  // seedQueue returned, so its source buffer/accept closure is out of scope.
  // The isolated recovery scenario separately checks two competing workers.
  const recovery = await runQueueRecovery({ ...config, queueWorkers: 1 });
  return {
    ...recovery,
    seedPeakRssBytes,
    seedElapsedMs: seed.elapsedMs!,
    consumerElapsedMs: recovery.elapsedMs!,
    elapsedMs: Date.now() - started,
  };
}

export async function runQueueRecovery(config: StressConfig): Promise<Record<string, number>> {
  guard();
  const started = Date.now();
  const owners = await db.select({ id: users.id }).from(users).where(eq(users.email, QUEUE_OWNER));
  assert.equal(owners.length, 1, "Queue recovery requires its completed seed process");
  const ownerId = owners[0]!.id;
  const before = await queueStats(ownerId);
  assert.equal(before.count, config.copies * config.rounds, "Queue seed is incomplete");
  assert(before.bytes >= before.count * config.messageBytes);
  const rows = await db
    .select({
      id: outboundMessages.id,
      emailLogId: outboundMessages.emailLogId,
      status: outboundMessages.status,
      tries: outboundMessages.tries,
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, ownerId))
    .orderBy(outboundMessages.id);
  for (const row of rows) {
    assert.equal(row.status, "pending", "Seeded queue must be untouched before recovery");
    assert.equal(row.tries, 0);
  }
  progress("queue-recovery", "seed-loaded");
  const permanent = new Set(rows.filter((_, i) => i % 3 === 0).map((row) => row.id));
  const transient = new Set(rows.filter((_, i) => i % 3 === 1).map((row) => row.id));
  const attempts = new Map<number, number>();
  const successes = new Set<number>();
  const hookAttempts = new Map<number, number>();
  let clock = Date.now() + 1000;
  let active = 0;
  let peak = 0;
  let workerPeak = 0;
  const batchSize =
    config.queueBatchSize ?? Math.max(1, Math.ceil(rows.length / config.queueWorkers));
  const competingWorkers = Math.min(config.queueWorkers, Math.ceil(rows.length / batchSize));
  let arrivals = 0;
  let release!: () => void;
  const overlap = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstWave = true;
  // Model a worker crash after claim commit but before SMTP, then use the real reaper.
  const stranded = rows.at(-1)!;
  await db
    .update(outboundMessages)
    .set({ status: "sending", claimedAt: new Date(clock - 120_000) })
    .where(eq(outboundMessages.id, stranded.id));
  const reaped = await reapStuckSending(db, { olderThanMs: 60_000, now: () => new Date(clock) });
  assert.deepEqual(reaped, [stranded.id]);
  const options = (): QueueWorkerOptions => {
    let localActive = 0;
    let firstDelivery = true;
    return {
      batchSize,
      maxTries: 5,
      now: () => new Date(clock),
      backoff: { baseMs: 100, maxMs: 100 },
      random: () => 0,
      logger,
      deliver: async (row) => {
        assert.equal(row.userId, ownerId, "Foreign queue row claimed");
        assert(row.raw.length >= config.messageBytes);
        assert(!successes.has(row.id), "Duplicate successful claim");
        const n = (attempts.get(row.id) ?? 0) + 1;
        attempts.set(row.id, n);
        active++;
        localActive++;
        peak = Math.max(peak, active);
        workerPeak = Math.max(workerPeak, localActive);
        try {
          if (firstWave && firstDelivery) {
            firstDelivery = false;
            if (++arrivals === competingWorkers) release();
            await overlap;
          }
          await Bun.sleep(2);
          if (permanent.has(row.id))
            return { kind: "permanent", error: "injected mailbox failure", enhancedCode: "5.1.1" };
          if (transient.has(row.id) && n === 1)
            return { kind: "transient", error: "injected temporary failure" };
          successes.add(row.id);
          return { kind: "sent" };
        } finally {
          active--;
          localActive--;
        }
      },
      onPermanentFailure: async (row, _error, _enhanced, tx) => {
        assert.equal(row.userId, ownerId);
        const n = (hookAttempts.get(row.id) ?? 0) + 1;
        hookAttempts.set(row.id, n);
        assert(row.emailLogId);
        const [log] = await tx
          .select({ bounced: emailLogs.bounced })
          .from(emailLogs)
          .where(eq(emailLogs.id, row.emailLogId));
        assert.equal(
          log!.bounced,
          false,
          "Partial hook effects persisted or job repeated after completion",
        );
        await tx.update(emailLogs).set({ bounced: true }).where(eq(emailLogs.id, row.emailLogId));
        if (n === 1) throw new Error("injected hook interruption after database effect");
      },
    };
  };
  const compete = () =>
    Promise.all(
      Array.from({ length: config.queueWorkers }, async () => {
        const opts = options();
        // Fixed-size claims let scaling trials hold the production batch size
        // constant while still draining the entire ready wave.
        for (;;) {
          const claimed = await processQueueOnce(db, opts);
          if (config.queueBatchSize === undefined || claimed === 0) break;
        }
      }),
    );
  await compete();
  firstWave = false;
  progress("queue-recovery", "first-claims-finished");
  assert.equal(arrivals, competingWorkers, "Workers did not overlap delivery claims");
  const [pendingJobs] = await db
    .select({ n: count() })
    .from(outboundMessages)
    .where(and(eq(outboundMessages.userId, ownerId), eq(outboundMessages.failurePending, true)));
  assert.equal(pendingJobs!.n, permanent.size);
  const [partialEffects] = await db
    .select({ n: count() })
    .from(emailLogs)
    .where(and(eq(emailLogs.userId, ownerId), eq(emailLogs.bounced, true)));
  assert.equal(partialEffects!.n, 0);
  clock += 120_000;
  await compete();
  progress("queue-recovery", "retry-claims-finished");
  const failureBatches =
    config.queueBatchSize === undefined ? 1 : Math.ceil(permanent.size / batchSize);
  for (let batch = 0; batch < failureBatches; batch++) {
    await Promise.all(
      Array.from({ length: config.queueWorkers }, () => processFailureJobs(db, options())),
    );
  }
  progress("queue-recovery", "failure-jobs-drained");
  const terminal = await db
    .select({
      status: outboundMessages.status,
      failurePending: outboundMessages.failurePending,
      n: count(),
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, ownerId))
    .groupBy(outboundMessages.status, outboundMessages.failurePending);
  assert.equal(
    terminal.reduce((n, row) => n + row.n, 0),
    before.count,
  );
  for (const row of terminal) {
    assert(["sent", "failed"].includes(row.status));
    assert.equal(row.failurePending, false);
  }
  assert.equal(successes.size, before.count - permanent.size);
  assert.equal(workerPeak, 1, "Default delivery concurrency exceeded one");
  for (const row of rows) {
    assert.equal(attempts.get(row.id), transient.has(row.id) ? 2 : 1);
    if (permanent.has(row.id)) assert.equal(hookAttempts.get(row.id), 2);
  }
  return {
    acceptedCopies: before.count,
    queuedBytes: before.bytes,
    sentCopies: successes.size,
    failedCopies: permanent.size,
    hookRetries: permanent.size,
    reapedClaims: reaped.length,
    peakDeliveryConcurrency: peak,
    peakPerWorkerConcurrency: workerPeak,
    queueWorkers: config.queueWorkers,
    claimBatchSize: batchSize,
    elapsedMs: Date.now() - started,
  };
}
