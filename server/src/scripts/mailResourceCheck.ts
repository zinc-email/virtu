/** Explicit scratch-database stress check; all inserted rows roll back. */
import { eq, count, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  aliases,
  aliasMailboxes,
  dkimKeys,
  mailboxes,
  outboundMessages,
  users,
} from "../db/schema.ts";
import { handleInboundData } from "../mx.ts";
import { makeRsaKeyPair, makeStubResolver } from "../mailauth/test-fixtures.ts";
import { createLogger } from "../log.ts";
import { processQueueOnce } from "../queue/worker.ts";

if (process.env.MAIL_RESOURCE_CHECK !== "1")
  throw new Error("Set MAIL_RESOURCE_CHECK=1 and DATABASE_URL to an isolated scratch database");
const copies = Number(process.env.MAIL_RESOURCE_COPIES ?? 100);
const mib = Number(process.env.MAIL_RESOURCE_MIB ?? 25);
const rollback = new Error("resource check rollback");
let stats: Record<string, number> = {};
try {
  await db.transaction(async (tx) => {
    const domain = `${crypto.randomUUID()}.test`;
    const [user] = await tx
      .insert(users)
      .values({ email: `owner@${domain}`, activated: true })
      .returning();
    const boxes = await tx
      .insert(mailboxes)
      .values(
        Array.from({ length: copies }, (_, i) => ({
          userId: user!.id,
          email: `box${i}@${domain}`,
          verified: true,
        })),
      )
      .returning();
    const [alias] = await tx
      .insert(aliases)
      .values({ userId: user!.id, email: `alias@${domain}`, mailboxId: boxes[0]!.id })
      .returning();
    await tx
      .insert(aliasMailboxes)
      .values(boxes.map((box) => ({ aliasId: alias!.id, mailboxId: box.id })));
    const key = makeRsaKeyPair();
    await tx.insert(dkimKeys).values({
      domain,
      selector: "test",
      privateKeyPem: key.privateKeyPem,
      publicKeyBase64: key.publicKeyBase64,
    });
    const header = Buffer.from(
      `From: sender@sender.test\r\nTo: ${alias!.email}\r\nSubject: memory check\r\n\r\n`,
    );
    const line = Buffer.from(`${"x".repeat(996)}\r\n`);
    const raw = Buffer.alloc(mib * 1024 * 1024);
    header.copy(raw);
    for (let offset = header.length; offset < raw.length; offset += line.length)
      line.copy(raw, offset);
    raw[raw.length - 2] = 13;
    raw[raw.length - 1] = 10;
    const started = Date.now();
    const accepted = await handleInboundData(
      {
        raw,
        headers: header,
        body: raw.subarray(header.length),
        session: { id: domain, remoteAddress: "192.0.2.1", remotePort: 1234, tls: false },
        envelope: {
          heloName: "sender.test",
          tls: false,
          mailFrom: "sender@sender.test",
          params: {},
          rcptTo: [{ address: alias!.email, params: {} }],
        },
      },
      {
        db: tx,
        mailDomain: domain,
        mailHostname: `mx.${domain}`,
        dkimSelector: "test",
        verpSecret: "resource-check-secret-long-enough-12345",
        maxMessageSize: raw.length,
        resolver: makeStubResolver({ TXT: { "sender.test": "v=spf1 ip4:192.0.2.1 -all" } }),
        logger: createLogger("resource-check", { write: () => {} }),
      },
    );
    if (!("accept" in accepted)) throw new Error(JSON.stringify(accepted));
    const [queued] = await tx
      .select({
        n: count(),
        bytes: sql<number>`sum(octet_length(${outboundMessages.raw}))`.mapWith(Number),
      })
      .from(outboundMessages)
      .where(eq(outboundMessages.userId, user!.id));
    if (queued!.n !== copies) throw new Error("Fan-out incomplete");
    console.log(
      JSON.stringify({
        phase: "accepted",
        copies,
        queuedBytes: queued!.bytes,
        rss: process.memoryUsage().rss,
      }),
    );
    let delivered = 0;
    // Make only these rows due first; the scratch DB must have no live workers.
    await tx
      .update(outboundMessages)
      .set({ nextAttemptAt: new Date(-86400000) })
      .where(eq(outboundMessages.userId, user!.id));
    await processQueueOnce(tx, {
      batchSize: copies,
      maxTries: 100000,
      logger: createLogger("resource-check", { write: () => {} }),
      deliver: async (row) => {
        if (row.userId !== user!.id) throw new Error("Unexpected foreign row");
        if (row.raw.length < raw.length) throw new Error("Body missing");
        delivered++;
        return { kind: "sent" };
      },
    });
    if (delivered !== copies) throw new Error("Queue drain incomplete");
    stats = {
      copies,
      messageBytes: raw.length,
      totalQueuedBytes: queued!.bytes,
      elapsedMs: Date.now() - started,
      rssBytes: process.memoryUsage().rss,
      peakRssKiB: process.resourceUsage().maxRSS,
    };
    throw rollback;
  });
} catch (error) {
  if (error !== rollback) throw error;
}
console.log(JSON.stringify({ ...stats, rolledBack: true }));
process.exit(0);
