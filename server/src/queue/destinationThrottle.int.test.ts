/**
 * The per-destination pause against the dockerized Postgres, driven through
 * processQueueOnce with an injected deliver: a 421 pauses the domain, rows
 * for a paused domain go back to pending without an attempt (no try spent),
 * a success resets the strikes, an operator clear lifts the pause.
 *
 * Parallel-safe: every test uses its own unique recipient DOMAIN, so no
 * pause here can touch another test's rows (and the hygiene tests' rows,
 * on hygiene.test, are answered "sent" by our deliver so they never pause).
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { destinationThrottles, outboundMessages } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import {
  clearThrottle,
  listThrottles,
  pausedUntilFor,
  recordDeferral,
  recordSuccess,
} from "./destinationThrottle.ts";
import { type DeliveryOutcome, processQueueOnce } from "./worker.ts";

const RAW = new TextEncoder().encode("Subject: throttle\r\n\r\nbody\r\n");
const quietLogger = createLogger("queue-test", { write: () => {} });
const EPOCH = new Date(0);
const THROTTLE = { baseMs: 60_000, maxMs: 600_000 };

const uniqueDomain = () => `d-${crypto.randomUUID().slice(0, 8)}.throttle.test`;

async function insertRow(envelopeTo: string): Promise<number> {
  const rows = await db
    .insert(outboundMessages)
    .values({ raw: RAW, envelopeFrom: "", envelopeTo, status: "pending", nextAttemptAt: EPOCH })
    .returning({ id: outboundMessages.id });
  return rows[0]!.id;
}

async function rowById(id: number) {
  return (await db.select().from(outboundMessages).where(eq(outboundMessages.id, id)).limit(1))[0];
}

/** Deliver: scripted outcome for our recipients, "sent" for everyone else's. */
function deliverFor(script: Map<string, DeliveryOutcome>) {
  const attempted: string[] = [];
  const deliver = async (row: { envelopeTo: string }): Promise<DeliveryOutcome> => {
    attempted.push(row.envelopeTo);
    return script.get(row.envelopeTo) ?? { kind: "sent" };
  };
  return { deliver, attempted };
}

const opts = (deliver: (row: { envelopeTo: string }) => Promise<DeliveryOutcome>) => ({
  batchSize: 50,
  maxTries: 1000,
  deliver,
  destinationThrottle: THROTTLE,
  logger: quietLogger,
});

async function cleanup(ids: number[], domain: string) {
  for (const id of ids) await db.delete(outboundMessages).where(eq(outboundMessages.id, id));
  await db.delete(destinationThrottles).where(eq(destinationThrottles.domain, domain));
}

describe("destination throttle through the worker", () => {
  test("a 421 pauses the domain; the next pass defers its rows without an attempt", async () => {
    const domain = uniqueDomain();
    const first = `a@${domain}`;
    const second = `b@${domain}`;
    const id1 = await insertRow(first);

    const pass1 = deliverFor(
      new Map<string, DeliveryOutcome>([
        [
          first,
          {
            kind: "transient",
            error: "421 4.7.0 go away",
            reply: { code: 421, enhancedCode: "4.7.0", step: "greeting", text: "go away" },
          },
        ],
      ]),
    );
    await processQueueOnce(db, opts(pass1.deliver));
    expect(pass1.attempted).toContain(first);

    const throttle = (
      await db.select().from(destinationThrottles).where(eq(destinationThrottles.domain, domain))
    )[0];
    expect(throttle?.strikes).toBe(1);
    expect(throttle?.pauses).toBe(1);
    expect(throttle?.lastCode).toBe(421);
    expect(throttle?.lastEnhanced).toBe("4.7.0");
    expect(throttle?.lastStep).toBe("greeting");
    expect(throttle?.lastReply).toBe("go away");
    expect(throttle?.pausedUntil?.getTime()).toBeGreaterThan(Date.now());

    // A fresh row for the paused domain: the worker must not attempt it.
    const id2 = await insertRow(second);
    const pass2 = deliverFor(new Map());
    await processQueueOnce(db, opts(pass2.deliver));
    expect(pass2.attempted).not.toContain(second);
    // ...and the first row (retrying on its own backoff, so not due yet)
    // isn't attempted either.
    expect(pass2.attempted).not.toContain(first);

    const deferred = await rowById(id2);
    expect(deferred?.status).toBe("pending");
    expect(deferred?.tries).toBe(0); // the claim's increment was undone
    expect(deferred?.claimedAt).toBeNull();
    expect(deferred?.lastError).toContain(`deferred: ${domain} paused until`);
    expect(deferred?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      throttle!.pausedUntil!.getTime(),
    );

    await cleanup([id1, id2], domain);
  });

  test("RCPT-time greylisting does not pause; a later success resets strikes", async () => {
    const domain = uniqueDomain();
    const rcpt = `grey@${domain}`;
    const id = await insertRow(rcpt);
    const pass = deliverFor(
      new Map<string, DeliveryOutcome>([
        [
          rcpt,
          {
            kind: "transient",
            error: "451 4.7.1 try later",
            reply: { code: 451, enhancedCode: "4.7.1", step: "rcpt_to", text: "try later" },
          },
        ],
      ]),
    );
    await processQueueOnce(db, opts(pass.deliver));
    expect(
      await db.select().from(destinationThrottles).where(eq(destinationThrottles.domain, domain)),
    ).toHaveLength(0);

    // Strike it by hand, then a delivered row clears it.
    await recordDeferral(
      db,
      domain,
      { code: 421, step: "greeting", text: "busy" },
      THROTTLE,
      new Date(Date.now() - 3_600_000), // already lifted
    );
    await db
      .update(outboundMessages)
      .set({ nextAttemptAt: EPOCH })
      .where(eq(outboundMessages.id, id));
    const ok = deliverFor(new Map([[rcpt, { kind: "sent" as const }]]));
    await processQueueOnce(db, opts(ok.deliver));
    expect(ok.attempted).toContain(rcpt);
    const after = (
      await db.select().from(destinationThrottles).where(eq(destinationThrottles.domain, domain))
    )[0];
    expect(after?.strikes).toBe(0);
    expect(after?.pausedUntil).toBeNull();
    expect(after?.pauses).toBe(1); // history survives the reset

    await cleanup([id], domain);
  });

  test("strikes escalate the pause and an operator clear lifts it", async () => {
    const domain = uniqueDomain();
    const now = new Date();
    const reply = { code: 421, step: "greeting" as const, text: "rate limited" };
    const s1 = await recordDeferral(db, domain, reply, THROTTLE, now);
    const s2 = await recordDeferral(db, domain, reply, THROTTLE, now);
    expect(s1.strikes).toBe(1);
    expect(s2.strikes).toBe(2);
    expect(s2.pausedUntil.getTime() - now.getTime()).toBe(120_000);

    expect((await pausedUntilFor(db, [domain, "nope.example"], now)).get(domain)).toEqual(
      s2.pausedUntil,
    );
    expect((await listThrottles(db, now)).some((t) => t.domain === domain)).toBe(true);

    expect(await clearThrottle(db, domain, now)).toBe(true);
    expect((await pausedUntilFor(db, [domain], now)).size).toBe(0);
    expect(await recordSuccess(db, domain, now)).toBe(false); // nothing left to reset
    expect(await clearThrottle(db, "never-seen.example", now)).toBe(false);

    await cleanup([], domain);
  });
});
