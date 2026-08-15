/**
 * Queue hygiene against the dockerized Postgres: reaper, retention, the
 * operator drop/requeue primitives, and the status-guarded terminal writes
 * (stale worker vs reaper/operator races). Parallel-safe by construction:
 * every row minted here carries a unique recipient, synthetic-old rows use
 * timestamps no concurrent test produces, and the worker passes run with
 * maxTries high enough to never flip a foreign row permanent.
 */

import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { DROPPED_BY_OPERATOR, dropMessages, requeueMessages } from "./admin.ts";
import { reapStuckSending } from "./reaper.ts";
import { runRetentionOnce } from "./retention.ts";
import { processQueueOnce } from "./worker.ts";

const RAW = new TextEncoder().encode("Subject: hygiene\r\n\r\nbody\r\n");
const quietLogger = createLogger("queue-test", { write: () => {} });

const uniqueRcpt = () => `q-${crypto.randomUUID()}@hygiene.test`;

interface RowOverrides {
  status?: "pending" | "sending" | "sent" | "failed";
  claimedAt?: Date | null;
  updatedAt?: Date;
  nextAttemptAt?: Date;
  tries?: number;
  raw?: Uint8Array;
  envelopeTo?: string;
}

async function insertRow(over: RowOverrides = {}): Promise<{ id: number; envelopeTo: string }> {
  const envelopeTo = over.envelopeTo ?? uniqueRcpt();
  const rows = await db
    .insert(outboundMessages)
    .values({
      raw: over.raw ?? RAW,
      envelopeFrom: "",
      envelopeTo,
      status: over.status ?? "pending",
      tries: over.tries ?? 0,
      nextAttemptAt: over.nextAttemptAt ?? new Date(),
      claimedAt: over.claimedAt ?? null,
      ...(over.updatedAt !== undefined ? { updatedAt: over.updatedAt } : {}),
    })
    .returning({ id: outboundMessages.id });
  return { id: rows[0]!.id, envelopeTo };
}

async function rowById(id: number) {
  const rows = await db.select().from(outboundMessages).where(eq(outboundMessages.id, id)).limit(1);
  return rows[0];
}

const MINUTES = 60_000;

describe("reapStuckSending", () => {
  test("returns stale sending rows to pending, leaves fresh ones", async () => {
    const stale = await insertRow({
      status: "sending",
      claimedAt: new Date(Date.now() - 30 * MINUTES),
    });
    const fresh = await insertRow({ status: "sending", claimedAt: new Date() });

    const reaped = await reapStuckSending(db, { olderThanMs: 15 * MINUTES });

    expect(reaped).toContain(stale.id);
    expect(reaped).not.toContain(fresh.id);
    const staleRow = await rowById(stale.id);
    expect(staleRow?.status).toBe("pending");
    expect(staleRow?.claimedAt).toBeNull();
    expect((await rowById(fresh.id))?.status).toBe("sending");
    // Cleanup so later passes don't re-deliver these synthetic rows.
    await dropMessages(db, [stale.id, fresh.id]);
  });

  test("falls back to updatedAt for pre-claimedAt legacy rows", async () => {
    const legacy = await insertRow({
      status: "sending",
      claimedAt: null,
      updatedAt: new Date(Date.now() - 60 * MINUTES),
    });
    const reaped = await reapStuckSending(db, { olderThanMs: 15 * MINUTES });
    expect(reaped).toContain(legacy.id);
    expect((await rowById(legacy.id))?.status).toBe("pending");
    await dropMessages(db, [legacy.id]);
  });
});

describe("dropMessages / requeueMessages", () => {
  test("drop takes pending and sending, never terminal rows or unknown ids", async () => {
    const pending = await insertRow({ status: "pending" });
    const sending = await insertRow({ status: "sending", claimedAt: new Date() });
    const sent = await insertRow({ status: "sent" });
    const failed = await insertRow({ status: "failed" });

    const dropped = await dropMessages(db, [pending.id, sending.id, sent.id, failed.id, 999999999]);

    expect(dropped.sort()).toEqual([pending.id, sending.id].sort());
    for (const id of [pending.id, sending.id]) {
      const row = await rowById(id);
      expect(row?.status).toBe("failed");
      expect(row?.lastError).toBe(DROPPED_BY_OPERATOR);
      expect(row?.claimedAt).toBeNull();
    }
    expect((await rowById(sent.id))?.status).toBe("sent");
    expect((await rowById(failed.id))?.status).toBe("failed");
    expect((await rowById(failed.id))?.lastError).toBeNull();
  });

  test("requeue takes failed rows with raw, refuses cleared-raw and non-failed", async () => {
    const failed = await insertRow({ status: "failed", tries: 6 });
    const rawCleared = await insertRow({ status: "failed", raw: new Uint8Array(0) });
    const pending = await insertRow({ status: "pending" });

    const requeued = await requeueMessages(db, [failed.id, rawCleared.id, pending.id]);

    expect(requeued).toEqual([failed.id]);
    const row = await rowById(failed.id);
    expect(row?.status).toBe("pending");
    expect(row?.tries).toBe(0);
    expect(row?.lastError).toBeNull();
    expect(row?.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect((await rowById(rawCleared.id))?.status).toBe("failed");
    await dropMessages(db, [failed.id, pending.id]);
  });
});

describe("runRetentionOnce", () => {
  test("deletes terminal rows past their windows, keeps young and non-terminal", async () => {
    const ancient = new Date("2020-01-01T00:00:00Z");
    const oldSent = await insertRow({ status: "sent", updatedAt: ancient });
    const oldFailed = await insertRow({ status: "failed", updatedAt: ancient });
    const oldPending = await insertRow({ status: "pending", updatedAt: ancient });
    const youngSent = await insertRow({ status: "sent" });

    // Cutoffs land ~2023: only this test's synthetic 2020 rows qualify, so a
    // concurrent test's fresh terminal rows are untouchable by construction.
    const deleted = await runRetentionOnce(db, {
      retainSentDays: 3 * 365,
      retainFailedDays: 3 * 365,
    });

    expect(deleted.sent).toBeGreaterThanOrEqual(1);
    expect(deleted.failed).toBeGreaterThanOrEqual(1);
    expect(await rowById(oldSent.id)).toBeUndefined();
    expect(await rowById(oldFailed.id)).toBeUndefined();
    expect((await rowById(oldPending.id))?.status).toBe("pending");
    expect((await rowById(youngSent.id))?.status).toBe("sent");
    await db
      .delete(outboundMessages)
      .where(inArray(outboundMessages.id, [oldPending.id, youngSent.id]));
  });
});

describe("processQueueOnce with hygiene semantics", () => {
  // The deliver stub answers "sent" only for rows this test minted; any
  // foreign pending row that gets claimed is answered transient, which just
  // bumps tries and reschedules — maxTries stays far away so no foreign row
  // can be flipped permanent by this test.
  const opts = (mine: Map<string, "sent" | "permanent">, onPermanent?: (id: number) => void) => ({
    batchSize: 100,
    maxTries: 100000,
    logger: quietLogger,
    deliver: async (row: { id: number; envelopeTo: string }) => {
      const outcome = mine.get(row.envelopeTo);
      if (outcome === "sent") return { kind: "sent" as const };
      if (outcome === "permanent") return { kind: "permanent" as const, error: "550 5.1.1 no" };
      return { kind: "transient" as const, error: "not this test's row" };
    },
    onPermanentFailure: async (row: { id: number }) => onPermanent?.(row.id),
  });

  // Claims order by next_attempt_at ASC — epoch timestamps put our rows first.
  const EPOCH = new Date(0);

  test("sent terminal write clears raw", async () => {
    const row = await insertRow({ nextAttemptAt: EPOCH });
    await processQueueOnce(db, opts(new Map([[row.envelopeTo, "sent"]])));
    const after = await rowById(row.id);
    expect(after?.status).toBe("sent");
    expect(after?.raw.length).toBe(0);
    expect(after?.claimedAt).toBeNull();
    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });

  test("a row dropped mid-delivery stays failed and fires no bounce hook", async () => {
    const row = await insertRow({ nextAttemptAt: EPOCH });
    const permanentCalls: number[] = [];
    await processQueueOnce(db, {
      ...opts(new Map(), (id) => permanentCalls.push(id)),
      deliver: async (claimed: { id: number; envelopeTo: string }) => {
        if (claimed.envelopeTo === row.envelopeTo) {
          // Operator drops the row while the delivery is on the wire...
          await dropMessages(db, [row.id]);
          // ...and the wire comes back permanent. The guarded write must not
          // stomp the drop, and the bounce hook must not fire for it.
          return { kind: "permanent" as const, error: "550 5.7.1 rejected" };
        }
        return { kind: "transient" as const, error: "not this test's row" };
      },
    });
    const after = await rowById(row.id);
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe(DROPPED_BY_OPERATOR);
    expect(permanentCalls).not.toContain(row.id);
    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });

  test("a stale worker cannot stomp a row another worker re-claimed", async () => {
    // Worker A claims; mid-delivery the reaper returns the row to pending
    // and worker B claims it (status "sending" again, NEWER claimedAt). A's
    // late permanent outcome must not stomp B's claim nor fire the bounce
    // hook — the claim-nonce (claimedAt) guard is what stands in the way.
    const row = await insertRow({ nextAttemptAt: EPOCH });
    const bClaimTime = new Date(Date.now() + 1000);
    const permanentCalls: number[] = [];
    await processQueueOnce(db, {
      ...opts(new Map(), (id) => permanentCalls.push(id)),
      deliver: async (claimed: { id: number; envelopeTo: string }) => {
        if (claimed.envelopeTo === row.envelopeTo) {
          // Reap + re-claim by another worker while A's delivery is on the wire.
          await db
            .update(outboundMessages)
            .set({ status: "sending", claimedAt: bClaimTime, tries: 2 })
            .where(eq(outboundMessages.id, row.id));
          return { kind: "permanent" as const, error: "550 5.1.1 late loser" };
        }
        return { kind: "transient" as const, error: "not this test's row" };
      },
    });
    const after = await rowById(row.id);
    expect(after?.status).toBe("sending");
    expect(after?.claimedAt?.getTime()).toBe(bClaimTime.getTime());
    expect(after?.lastError).toBeNull();
    expect(permanentCalls).not.toContain(row.id);
    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });

  test("a row taken over before its turn in the batch is not delivered", async () => {
    // Two rows in one batch: while row 1 delivers, an operator drops row 2.
    // The per-row lease refresh must detect the takeover and skip row 2's
    // delivery entirely.
    const first = await insertRow({ nextAttemptAt: new Date(0) });
    const second = await insertRow({ nextAttemptAt: new Date(1) });
    const delivered: string[] = [];
    await processQueueOnce(db, {
      ...opts(new Map()),
      deliver: async (claimed: { id: number; envelopeTo: string }) => {
        delivered.push(claimed.envelopeTo);
        if (claimed.envelopeTo === first.envelopeTo) {
          await dropMessages(db, [second.id]);
          return { kind: "sent" as const };
        }
        return { kind: "transient" as const, error: "not this test's row" };
      },
    });
    expect(delivered).toContain(first.envelopeTo);
    expect(delivered).not.toContain(second.envelopeTo);
    const droppedRow = await rowById(second.id);
    expect(droppedRow?.status).toBe("failed");
    expect(droppedRow?.lastError).toBe(DROPPED_BY_OPERATOR);
    await db.delete(outboundMessages).where(inArray(outboundMessages.id, [first.id, second.id]));
  });

  test("claim stamps claimedAt", async () => {
    const row = await insertRow({ nextAttemptAt: EPOCH });
    let claimedAtDuringDelivery: Date | null | undefined;
    await processQueueOnce(db, {
      ...opts(new Map()),
      deliver: async (claimed: { id: number; envelopeTo: string }) => {
        if (claimed.envelopeTo === row.envelopeTo) {
          claimedAtDuringDelivery = (await rowById(row.id))?.claimedAt;
          return { kind: "sent" as const };
        }
        return { kind: "transient" as const, error: "not this test's row" };
      },
    });
    expect(claimedAtDuringDelivery).toBeInstanceOf(Date);
    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });
});
