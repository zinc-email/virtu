import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { eq } from "drizzle-orm";
import { config as production } from "../src/config.ts";
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
import { parseMessage } from "../src/mail/headers.ts";
import { makeRsaKeyPair } from "../src/mailauth/test-fixtures.ts";
import { createMxServer } from "../src/mx.ts";
import { createDataBudget } from "../src/smtp/dataBudget.ts";
import { dotStuffChunks } from "../src/smtp/wire.ts";
import { assertScratchDatabase, type StressConfig } from "./config.ts";

/** Synthetic complete-message size, not a claim about observed traffic or attachments. */
export function inboundMessageSize(index: number, cap: number): number {
  const slot = (index * 37) % 100;
  return Math.min(
    cap,
    slot < 70 ? 16 * 1024 : slot < 90 ? 256 * 1024 : slot < 98 ? 2 * 1024 * 1024 : 25 * 1024 * 1024,
  );
}

/** Varied printable ASCII with CRLF lines; no whole-payload cache and no MIME attachment claim. */
export function* inboundBody(bytes: number, seed: number): Generator<Buffer> {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = seed + 1;
  while (bytes > 0) {
    let size = Math.min(64 * 1024, bytes);
    if (bytes - size === 1) size--;
    const block = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      let width = Math.min(128, size - offset);
      if (size - offset - width === 1) width--;
      assert(width >= 2);
      for (let j = 0; j < width - 2; j++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        block[offset++] = alphabet.charCodeAt(state & 63);
      }
      block[offset++] = 13;
      block[offset++] = 10;
    }
    yield block;
    bytes -= size;
  }
}

/** A closed peer must settle a write even when its callback never fires. */
export function writeInboundChunk(socket: net.Socket, value: Buffer | string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Connection closed during SMTP write"));
    socket.once("error", onError);
    socket.once("close", onClose);
    if (socket.destroyed || !socket.writable) return onClose();
    try {
      socket.write(value, finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** One bounded unread socket chunk plus a partial SMTP reply line. */
class Sender {
  private readonly chunks: AsyncIterator<Buffer>;
  private buffered: Buffer = Buffer.alloc(0);
  constructor(
    readonly socket: net.Socket,
    timeout: number,
  ) {
    socket.on("error", () => {});
    socket.setTimeout(timeout, () => socket.destroy(new Error("Inbound stress socket deadline")));
    this.chunks = socket[Symbol.asyncIterator]();
  }
  static async connect(port: number, timeout: number): Promise<Sender> {
    const socket = net.connect({ host: "127.0.0.1", port });
    const sender = new Sender(socket, timeout);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return sender;
  }
  async write(value: Buffer | string): Promise<void> {
    await writeInboundChunk(this.socket, value);
  }
  async reply(): Promise<number> {
    for (let lines = 0; lines < 64; ) {
      const cut = this.buffered.indexOf("\r\n");
      if (cut < 0) {
        assert(this.buffered.length <= 2048, "Unbounded SMTP reply");
        const next = await this.chunks.next();
        assert(!next.done, "Connection lost before SMTP outcome");
        this.buffered = this.buffered.length
          ? Buffer.concat([this.buffered, next.value])
          : next.value;
        continue;
      }
      const line = this.buffered.subarray(0, cut).toString("ascii");
      this.buffered = this.buffered.subarray(cut + 2);
      lines++;
      assert(/^\d{3}[ -]/.test(line), "Invalid SMTP reply");
      if (line[3] === " ") return Number(line.slice(0, 3));
    }
    throw new Error("Too many SMTP reply lines");
  }
  async command(value: string): Promise<number> {
    await this.write(`${value}\r\n`);
    return this.reply();
  }
  close(): void {
    this.socket.destroy();
  }
}

type Accepted = { index: number; bytes: number; bodyHash: string; latencyMs: number };

export async function runInboundMix(config: StressConfig): Promise<Record<string, number>> {
  const setupStarted = performance.now();
  assert.equal(process.env.MAIL_STRESS_WORKER, "1");
  assertScratchDatabase(process.env.DATABASE_URL ?? "");
  const domain = `${crypto.randomUUID()}.test`;
  const [owner] = await db
    .insert(users)
    .values({ email: `inbound-owner@${domain}`, activated: true })
    .returning();
  assert(owner);
  const destinations: { aliasId: number; mailboxId: number; alias: string; mailbox: string }[] = [];
  // Fixture state is metadata only. Every incoming transaction targets one alias
  // that is bound to exactly one mailbox, without a fan-out multiplier.
  for (let start = 0; start < config.inboundMessages; start += 100) {
    const indices = Array.from(
      { length: Math.min(100, config.inboundMessages - start) },
      (_, i) => start + i,
    );
    const boxes = await db
      .insert(mailboxes)
      .values(
        indices.map((i) => ({
          userId: owner.id,
          email: `box${i}@destination${i}.test`,
          verified: true,
        })),
      )
      .returning();
    const routes = await db
      .insert(aliases)
      .values(
        indices.map((i, j) => ({
          userId: owner.id,
          email: `alias${i}@${domain}`,
          mailboxId: boxes[j]!.id,
        })),
      )
      .returning();
    await db
      .insert(aliasMailboxes)
      .values(routes.map((route, j) => ({ aliasId: route.id, mailboxId: boxes[j]!.id })));
    routes.forEach((route, j) =>
      destinations.push({
        aliasId: route.id,
        mailboxId: boxes[j]!.id,
        alias: route.email,
        mailbox: boxes[j]!.email,
      }),
    );
  }
  const key = makeRsaKeyPair();
  await db.insert(dkimKeys).values({
    domain,
    selector: "stress",
    privateKeyPem: key.privateKeyPem,
    publicKeyBase64: key.publicKeyBase64,
  });
  const budget = createDataBudget(production.smtpMaxDataBytesInFlight);
  const server = createMxServer({
    db,
    mailDomain: domain,
    mailHostname: `mx.${domain}`,
    dkimSelector: "stress",
    verpSecret: "inbound-stress-secret-long-enough-12345",
    maxMessageSize: config.messageBytes,
    inboundFlagDisposition: production.inboundFlagDisposition,
    inboundRateLimits: {
      perAliasPerMinute: production.inboundRateLimitPerAliasPerMinute,
      perMailboxPerMinute: production.inboundRateLimitPerMailboxPerMinute,
    },
    queueQuota: {
      maxPendingRows: production.queueMaxPendingRowsPerUser,
      maxPendingBytes: production.queueMaxPendingBytesPerUser,
    },
    dataBudget: budget,
    logger: createLogger("inbound-stress", { write: () => {} }),
    resolver: async (name, type) => {
      if (type === "TXT" && /^sender\d+\.inbound\.test$/.test(name))
        return [["v=spf1 ip4:127.0.0.1 -all"]];
      if (type === "TXT" && /^_dmarc\.sender\d+\.inbound\.test$/.test(name))
        return [["v=DMARC1; p=reject; psd=n"]];
      throw Object.assign(new Error("Synthetic DNS has no record"), { code: "ENODATA" });
    },
  });
  const { port } = await server.listen(0, "127.0.0.1");
  let next = 0,
    offered = 0,
    offeredBytes = 0,
    retryable = 0,
    permanent = 0;
  const accepted: Accepted[] = [];
  const clients = new Set<Sender>();
  const setupElapsedMs = performance.now() - setupStarted;
  const replyCounts: Record<string, number> = {};
  const trafficStarted = performance.now();
  try {
    await Promise.all(
      Array.from({ length: Math.min(config.clients, config.inboundMessages) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= config.inboundMessages) return;
          const target = destinations[index]!;
          const bytes = inboundMessageSize(index, config.messageBytes);
          const started = performance.now();
          offered++;
          offeredBytes += bytes;
          const sender = await Sender.connect(port, config.timeoutMs);
          clients.add(sender);
          let outcome = 0,
            bodyHash = "";
          try {
            outcome = await sender.reply();
            if (outcome === 220) {
              const commands = [
                `EHLO mx.sender${index}.inbound.test`,
                `MAIL FROM:<sender@sender${index}.inbound.test>`,
                `RCPT TO:<${target.alias}>`,
                "DATA",
              ];
              for (const command of commands) {
                outcome = await sender.command(command);
                if (outcome >= 400) break;
              }
              if (outcome === 354) {
                const header = Buffer.from(
                  `From: Sender ${index} <sender@sender${index}.inbound.test>\r\nTo: ${target.alias}\r\nSubject: synthetic independent input ${index}\r\nMessage-ID: <input-${index}@sender${index}.inbound.test>\r\nX-Virtu-Test-ID: inbound-${index}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=us-ascii\r\nContent-Transfer-Encoding: 7bit\r\n\r\n`,
                );
                // Read concurrently so a mid-DATA 421 is classified even if
                // the server closes while the sender is still writing.
                let earlyReply: number | undefined;
                const finalReply = sender.reply().then((code) => {
                  earlyReply = code;
                  return code;
                });
                void finalReply.catch(() => {});
                try {
                  await sender.write(header);
                  const hash = createHash("sha256");
                  for (const block of inboundBody(bytes - header.length, index)) {
                    if (earlyReply !== undefined) {
                      assert(
                        earlyReply >= 400 && earlyReply < 600,
                        "Unexpected reply before DATA completion",
                      );
                      break;
                    }
                    hash.update(block);
                    for (const wire of dotStuffChunks(block)) await sender.write(wire);
                  }
                  if (earlyReply !== undefined)
                    assert(
                      earlyReply >= 400 && earlyReply < 600,
                      "Unexpected reply before DATA completion",
                    );
                  bodyHash = hash.digest("hex");
                  if (earlyReply === undefined) await sender.write(".\r\n");
                  outcome = await finalReply;
                } catch (error) {
                  try {
                    outcome = await finalReply;
                  } catch {
                    throw error;
                  }
                  if (outcome < 400 || outcome >= 600) throw error;
                }
              }
            }
            const replyKey = `smtpReply${outcome}Messages`;
            replyCounts[replyKey] = (replyCounts[replyKey] ?? 0) + 1;
            if (outcome === 250 && bodyHash)
              accepted.push({ index, bytes, bodyHash, latencyMs: performance.now() - started });
            else if (outcome >= 400 && outcome < 500) retryable++;
            else if (outcome >= 500 && outcome < 600) permanent++;
            else throw new Error(`Unclassified SMTP outcome ${outcome}`);
          } finally {
            sender.close();
            clients.delete(sender);
          }
        }
      }),
    );
  } finally {
    for (const sender of clients) sender.close();
    await server.close();
  }
  const trafficElapsedMs = performance.now() - trafficStarted;
  assert.equal(offered, config.inboundMessages);
  assert.equal(offered, accepted.length + retryable + permanent);
  assert.equal(permanent, 0, "Valid synthetic input received a permanent refusal");
  assert(accepted.length > 0, "No inputs accepted");
  assert.equal(budget.inFlight(), 0);
  const validationStarted = performance.now();
  const logs = await db
    .select({
      id: emailLogs.id,
      aliasId: emailLogs.aliasId,
      mailboxId: emailLogs.mailboxId,
      senderAuthenticated: emailLogs.senderAuthenticated,
    })
    .from(emailLogs)
    .where(eq(emailLogs.userId, owner.id));
  const rows = await db
    .select({
      id: outboundMessages.id,
      emailLogId: outboundMessages.emailLogId,
      envelopeTo: outboundMessages.envelopeTo,
      status: outboundMessages.status,
      tries: outboundMessages.tries,
    })
    .from(outboundMessages)
    .where(eq(outboundMessages.userId, owner.id));
  assert.equal(logs.length, accepted.length);
  assert.equal(rows.length, accepted.length);
  const acceptedByAlias = new Map(
    accepted.map((item) => [destinations[item.index]!.aliasId, item]),
  );
  const logById = new Map(logs.map((log) => [log.id, log]));
  const checked = new Set<number>();
  for (const row of rows) {
    assert.equal(row.status, "pending");
    assert.equal(row.tries, 0);
    const log = logById.get(row.emailLogId!);
    assert(log);
    assert.equal(
      log.senderAuthenticated,
      true,
      "Accepted sender did not pass envelope authentication",
    );
    const item = acceptedByAlias.get(log.aliasId!);
    assert(item, "Unaccepted input left durable rows");
    assert(!checked.has(item.index), "Accepted input duplicated");
    checked.add(item.index);
    const target = destinations[item.index]!;
    assert.equal(row.envelopeTo, target.mailbox);
    assert.equal(log.mailboxId, target.mailboxId);
    const [stored] = await db
      .select({ raw: outboundMessages.raw })
      .from(outboundMessages)
      .where(eq(outboundMessages.id, row.id));
    assert(stored);
    const parsed = parseMessage(stored.raw);
    assert(parsed.headers.has("DKIM-Signature"), "Accepted forward missing DKIM signature");
    assert(parsed.headers.has("ARC-Seal"), "Accepted forward missing custody seal");
    assert.equal(parsed.headers.get("X-Virtu-Test-ID"), `inbound-${item.index}`);
    assert.equal(
      createHash("sha256").update(parsed.body).digest("hex"),
      item.bodyHash,
      "Forwarding altered accepted body bytes",
    );
  }
  assert.equal(checked.size, accepted.length);
  const latencies = accepted.map((item) => item.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)]!;
  const acceptedBytes = accepted.reduce((sum, item) => sum + item.bytes, 0);
  const buckets: Record<string, number> = {};
  for (let index = 0; index < offered; index++) {
    const bytes = inboundMessageSize(index, config.messageBytes);
    const key = `offeredMessagesAtBytes${bytes}`;
    buckets[key] = (buckets[key] ?? 0) + 1;
    buckets[`acceptedMessagesAtBytes${bytes}`] ??= 0;
  }
  for (const item of accepted) buckets[`acceptedMessagesAtBytes${item.bytes}`]!++;
  return {
    ...buckets,
    ...replyCounts,
    setupElapsedMs,
    validationElapsedMs: performance.now() - validationStarted,
    offeredInputMessages: offered,
    acceptedInputMessages: accepted.length,
    retryableInputMessages: retryable,
    permanentlyRejectedInputMessages: permanent,
    offeredInputBytes: offeredBytes,
    acceptedInputBytes: acceptedBytes,
    logicalSenderDomains: offered,
    logicalSenderHelos: offered,
    recipientAliases: destinations.length,
    remoteIpCount: 1,
    accountOwners: 1,
    recipientsPerInput: 1,
    queueBacklogMessages: rows.length,
    deliveryLogs: logs.length,
    trafficElapsedMs,
    acceptedInputMessagesPerSecond: (accepted.length * 1000) / trafficElapsedMs,
    acceptedPayloadMiBPerSecond: (acceptedBytes * 1000) / trafficElapsedMs / 1024 / 1024,
    acceptanceLatencyP50Ms: percentile(0.5),
    acceptanceLatencyP95Ms: percentile(0.95),
    automaticRetries: 0,
    policyAliasMessagesPerMinute: production.inboundRateLimitPerAliasPerMinute,
    policyMailboxMessagesPerMinute: production.inboundRateLimitPerMailboxPerMinute,
    policyQueueMaxPendingRows: production.queueMaxPendingRowsPerUser,
    policyQueueMaxPendingBytes: production.queueMaxPendingBytesPerUser,
    policyDataBudgetBytes: budget.maxBytes,
    tlsSessions: 0,
    inboundDkimSignatures: 0,
  };
}
