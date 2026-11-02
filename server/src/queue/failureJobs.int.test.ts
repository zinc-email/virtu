import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";
import { createLogger } from "../log.ts";
import { deleteMessages, requeueMessages } from "./admin.ts";
import { enqueue } from "./enqueue.ts";
import { processFailureJobs, type QueueWorkerOptions } from "./worker.ts";

test("crash-persisted failure survives hook exception, retries atomically and completes once", async () => {
  const marker = `failure-${crypto.randomUUID()}@test.invalid`;
  const [row] = await db
    .insert(outboundMessages)
    .values({
      raw: new Uint8Array(),
      envelopeFrom: "",
      envelopeTo: marker,
      status: "failed",
      failurePending: true,
      nextAttemptAt: new Date(0),
      failureEnhancedCode: "5.1.1",
      lastError: "gone",
    })
    .returning();
  let fail = true;
  let calls = 0;
  const opts: QueueWorkerOptions = {
    batchSize: 100,
    maxTries: 3,
    deliver: async () => {
      throw new Error("must not deliver");
    },
    logger: createLogger("failure-test", { write: () => {} }),
    onPermanentFailure: async (failed, error, code, tx) => {
      if (failed.id !== row!.id) return;
      calls++;
      expect(error).toBe("gone");
      expect(code).toBe("5.1.1");
      await enqueue(tx, { raw: new Uint8Array(), envelopeFrom: "", envelopeTo: `dsn-${marker}` });
      if (fail) throw new Error("crash after side effect");
    },
  };
  const dsns = () =>
    db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.envelopeTo, `dsn-${marker}`));
  await processFailureJobs(db, opts);
  expect(await dsns()).toHaveLength(0);
  expect(calls).toBe(1);
  expect(await requeueMessages(db, [row!.id])).toEqual([]);
  expect(await deleteMessages(db, [row!.id])).toEqual([]);
  expect(
    (await db.select().from(outboundMessages).where(eq(outboundMessages.id, row!.id)))[0]
      ?.failurePending,
  ).toBe(true);
  fail = false;
  await db
    .update(outboundMessages)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(outboundMessages.id, row!.id));
  await Promise.all([processFailureJobs(db, opts), processFailureJobs(db, opts)]);
  expect(await dsns()).toHaveLength(1);
  expect(calls).toBe(2);
  await processFailureJobs(db, opts);
  expect(calls).toBe(2);
  await db.delete(outboundMessages).where(eq(outboundMessages.envelopeTo, `dsn-${marker}`));
  await db.delete(outboundMessages).where(eq(outboundMessages.id, row!.id));
});

test("real permanent-failure handler signs and queues a DSN for long diagnostics", async () => {
  const { ensureTestSigningKey } = await import("../routes/intHarness.ts");
  const { aliases, contacts, emailLogs, mailboxes, users } = await import("../db/schema.ts");
  const { handlePermanentFailure } = await import("../deliverd.ts");
  const { buildVerp } = await import("../mail/verp.ts");
  const { config } = await import("../config.ts");
  await ensureTestSigningKey();
  const tag = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({ email: `failure-${tag}@test.invalid`, activated: true })
    .returning();
  try {
    const [mailbox] = await db
      .insert(mailboxes)
      .values({ userId: user!.id, email: user!.email, verified: true })
      .returning();
    const [alias] = await db
      .insert(aliases)
      .values({ userId: user!.id, mailboxId: mailbox!.id, email: `${tag}@${config.mailDomain}` })
      .returning();
    const [contact] = await db
      .insert(contacts)
      .values({
        userId: user!.id,
        aliasId: alias!.id,
        websiteEmail: "contact@example.com",
        replyEmail: `ra-${tag}@${config.mailDomain}`,
      })
      .returning();
    const [log] = await db
      .insert(emailLogs)
      .values({
        userId: user!.id,
        aliasId: alias!.id,
        mailboxId: mailbox!.id,
        contactId: contact!.id,
        isReply: true,
      })
      .returning();
    const [failed] = await db
      .insert(outboundMessages)
      .values({
        userId: user!.id,
        emailLogId: log!.id,
        envelopeTo: contact!.websiteEmail,
        envelopeFrom: buildVerp({
          type: "bounce_reply",
          id: log!.id,
          domain: config.mailDomain,
          secret: config.verpSecret,
        }),
        raw: Buffer.from("From: sender@example.com\r\nSubject: test\r\n\r\nhello\r\n"),
        status: "failed",
        failurePending: true,
        nextAttemptAt: new Date(-86400000),
        lastError: `550 5.1.1 ${"x".repeat(1500)}`,
      })
      .returning();
    await processFailureJobs(db, {
      batchSize: 1,
      maxTries: 3,
      deliver: async () => ({ kind: "sent" }),
      onPermanentFailure: handlePermanentFailure,
    });
    const [after] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, failed!.id));
    expect(after!.failurePending).toBe(false);
    const [accounted] = await db.select().from(emailLogs).where(eq(emailLogs.id, log!.id));
    expect(accounted!.bounced).toBe(true);
    const notices = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.envelopeTo, user!.email));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.envelopeFrom).toBe("");
    expect(Buffer.from(notices[0]!.raw).toString()).toContain("DKIM-Signature:");
  } finally {
    await db.delete(users).where(eq(users.id, user!.id));
  }
});
