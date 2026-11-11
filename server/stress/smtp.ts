import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createSmtpServer } from "../src/smtp/server.ts";
import type { SmtpSendResult } from "../src/smtp/types.ts";
import { connectSmtp } from "../src/smtp/client.ts";
import { createDataBudget } from "../src/smtp/dataBudget.ts";
import { dotStuffChunks } from "../src/smtp/wire.ts";
import type { StressConfig } from "./config.ts";

const header = Buffer.from(
  "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: stress\r\n\r\n",
);
const line = Buffer.from(`.${"x".repeat(125)}\r\n`);

/** Exact-sized, CRLF-terminated content with dot-leading lines and bounded allocations. */
function* content(bytes: number): Generator<Buffer> {
  assert(bytes >= header.length + 128, "stress message is too small");
  yield header;
  let lines = Math.floor((bytes - header.length) / line.length);
  let tail = (bytes - header.length) % line.length;
  if (tail === 1) {
    lines--;
    tail += line.length;
  }
  while (lines > 0) {
    const count = Math.min(lines, 512);
    const block = Buffer.allocUnsafe(count * line.length);
    for (let i = 0; i < count; i++) line.copy(block, i * line.length);
    yield block;
    lines -= count;
  }
  if (tail > 128) {
    yield Buffer.from(`${"z".repeat(tail - 4)}\r\n`);
    tail = 2;
  }
  if (tail) yield Buffer.from(`${"z".repeat(tail - 2)}\r\n`);
}

function wireBytes(bytes: number): number {
  let total = 3; // DATA terminator
  for (const block of content(bytes))
    for (const wire of dotStuffChunks(block)) total += wire.length;
  return total;
}

function digest(bytes: number): string {
  const hash = createHash("sha256");
  for (const block of content(bytes)) hash.update(block);
  return hash.digest("hex");
}

/** Owns at most one unread socket chunk, not a transcript or whole message. */
class Peer {
  private readonly chunks: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  writesBlocked = 0;
  constructor(
    readonly socket: net.Socket,
    timeoutMs: number,
  ) {
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("SMTP stress socket timed out")));
    socket.on("error", () => {});
    this.chunks = socket[Symbol.asyncIterator]();
  }
  static async connect(port: number, timeout: number): Promise<Peer> {
    const socket = net.connect({ host: "127.0.0.1", port });
    const peer = new Peer(socket, timeout);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return peer;
  }
  async write(bytes: string | Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.socket.write(bytes, (error) => (error ? reject(error) : resolve())))
        this.writesBlocked++;
    });
  }
  async line(): Promise<Buffer> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end !== -1) {
        const result = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 2);
        return result;
      }
      assert(this.buffer.length <= 2048, "peer sent an overlong line");
      const next = await this.chunks.next();
      assert(!next.done, "peer disconnected without completing SMTP reply/data");
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next.value]) : next.value;
    }
  }
  async reply(): Promise<number> {
    let code = 0;
    for (let count = 0; count < 64; count++) {
      const line = (await this.line()).toString("ascii");
      assert(/^\d{3}[ -]/.test(line), "invalid SMTP reply");
      code = Number(line.slice(0, 3));
      if (line[3] === " ") return code;
    }
    throw new Error("too many SMTP reply lines");
  }
  async command(command: string): Promise<number> {
    await this.write(`${command}\r\n`);
    return this.reply();
  }
  close(): void {
    this.socket.destroy();
  }
}

async function begin(peer: Peer): Promise<number> {
  const greeting = await peer.reply();
  if (greeting !== 220) return greeting;
  assert.equal(await peer.command("EHLO stress.example.test"), 250);
  assert.equal(await peer.command("MAIL FROM:<sender@example.test>"), 250);
  assert.equal(await peer.command("RCPT TO:<recipient@example.test>"), 250);
  return peer.command("DATA");
}

async function send(
  port: number,
  config: StressConfig,
  barrier?: () => Promise<void>,
): Promise<{ code: number; blocked: number }> {
  const peer = await Peer.connect(port, config.timeoutMs);
  try {
    const ready = await begin(peer);
    if (ready !== 354) return { code: ready, blocked: peer.writesBlocked };
    await barrier?.();
    let wireIndex = 0;
    for (const block of content(config.messageBytes)) {
      for (const wire of dotStuffChunks(block)) {
        // Separate writes/yields target CR|LF and dot|dot boundaries without
        // assuming TCP preserves those writes as packet boundaries.
        const split = wireIndex === 0 ? wire.indexOf("\r\n") + 1 : wireIndex === 1 ? 1 : 0;
        if (split > 0) {
          await peer.write(wire.subarray(0, split));
          await nextTurn();
        }
        await peer.write(wire.subarray(split));
        wireIndex++;
      }
    }
    for (const fragment of [".", "\r", "\n"]) {
      await peer.write(fragment);
      await nextTurn();
    }
    const resultCode = await peer.reply();
    return { code: resultCode, blocked: peer.writesBlocked };
  } finally {
    peer.close();
  }
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
}

export async function runSmtpLoad(config: StressConfig): Promise<Record<string, number>> {
  const expected = digest(config.messageBytes);
  let received = 0,
    activeHooks = 0,
    peakHooks = 0;
  const budget = createDataBudget(wireBytes(config.messageBytes) * config.clients);
  const server = createSmtpServer({
    hostname: "stress.example.test",
    maxMessageSize: config.messageBytes,
    maxConnectionsPerIp: config.clients + 2,
    maxConnections: config.clients + 2,
    dataBudget: budget,
    onData: async ({ raw }) => {
      activeHooks++;
      peakHooks = Math.max(peakHooks, activeHooks);
      try {
        assert.equal(raw.length, config.messageBytes);
        assert.equal(createHash("sha256").update(raw).digest("hex"), expected);
        await nextTurn();
        received++;
        return { accept: true };
      } finally {
        activeHooks--;
      }
    },
  });
  const { port } = await server.listen(0, "127.0.0.1");
  let accepted = 0,
    writesBlocked = 0;
  try {
    for (let round = 0; round < config.rounds; round++) {
      const ready = gate();
      let waiting = 0;
      const results = await Promise.all(
        Array.from({ length: config.clients }, () =>
          send(port, config, async () => {
            if (++waiting === config.clients) ready.release();
            await ready.promise;
          }).then(
            (result) => {
              if (result.code !== 250) ready.release();
              return result;
            },
            (error) => {
              ready.release();
              throw error;
            },
          ),
        ),
      );
      for (const result of results) {
        assert.equal(result.code, 250);
        accepted++;
        writesBlocked += result.blocked;
      }
    }
    assert.equal(received, accepted);
    assert.equal(peakHooks, 1, "only one inbound body may materialize at a time");
    return {
      accepted,
      received,
      bytesVerified: received * config.messageBytes,
      writesBlocked,
      peakHooks,
    };
  } finally {
    await server.close();
    assert.equal(budget.inFlight(), 0);
  }
}

export async function runSmtpOverload(config: StressConfig): Promise<Record<string, number>> {
  const expected = digest(config.messageBytes);
  const held = gate(),
    entered = gate();
  const budget = createDataBudget(wireBytes(config.messageBytes));
  let received = 0;
  const server = createSmtpServer({
    hostname: "stress.example.test",
    maxMessageSize: config.messageBytes,
    maxConnectionsPerIp: config.clients + 3,
    maxConnections: config.clients + 3,
    dataBudget: budget,
    onData: async ({ raw }) => {
      assert.equal(raw.length, config.messageBytes);
      assert.equal(createHash("sha256").update(raw).digest("hex"), expected);
      received++;
      if (received === 1) {
        entered.release();
        await held.promise;
      }
      return { accept: true };
    },
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const first = send(port, config);
  // Ensure a failing first transfer is observed even while the hook-entry barrier is pending.
  void first.catch(() => entered.release());
  try {
    await entered.promise;
    assert.equal(budget.inFlight(), budget.maxBytes);
    const attempts = await Promise.all(
      Array.from({ length: config.clients }, () => send(port, config)),
    );
    for (const attempt of attempts)
      assert(
        attempt.code >= 400 && attempt.code < 500,
        "overload needs an explicit retryable reply",
      );
    assert.equal(received, 1, "refused transfers must not reach acceptance");
    held.release();
    assert.equal((await first).code, 250);
    while (budget.inFlight()) await nextTurn();
    const partial = await Peer.connect(port, config.timeoutMs);
    assert.equal(await begin(partial), 354);
    await partial.write(header);
    while (!budget.inFlight()) await nextTurn();
    partial.close();
    while (budget.inFlight()) await nextTurn();
    const retry = await send(port, config);
    assert.equal(retry.code, 250);
    assert.equal(received, 2);
    return {
      accepted: 2,
      refused: attempts.length,
      disconnected: 1,
      recovered: 1,
      bytesVerified: 2 * config.messageBytes,
    };
  } finally {
    held.release();
    await server.close();
    await first.catch(() => {});
    assert.equal(budget.inFlight(), 0);
  }
}

export async function runOutboundBackpressure(
  config: StressConfig,
): Promise<Record<string, number>> {
  const expected = digest(config.messageBytes);
  const source = Buffer.allocUnsafe(config.messageBytes);
  let offset = 0;
  for (const block of content(config.messageBytes)) {
    block.copy(source, offset);
    offset += block.length;
  }
  assert.equal(offset, source.length);
  const finished = gate();
  let failure: unknown;
  let releaseReader: (() => void) | undefined;
  let pausedReads = 0;
  let received = 0,
    receivedBytes = 0;
  const peers = new Set<Peer>();
  const server = net.createServer((socket) => {
    const peer = new Peer(socket, config.timeoutMs);
    peers.add(peer);
    void (async () => {
      await peer.write("220 slow.example.test ready\r\n");
      for (;;) {
        const command = (await peer.line()).toString("ascii");
        if (command.startsWith("EHLO")) await peer.write("250 slow.example.test\r\n");
        else if (command.startsWith("MAIL") || command.startsWith("RCPT"))
          await peer.write("250 OK\r\n");
        else if (command === "DATA") {
          const mayRead = gate();
          releaseReader = mayRead.release;
          await peer.write("354 Send data\r\n");
          // Deliberately withhold application reads until the real sender
          // has observed socket write backpressure and drained once.
          await mayRead.promise;
          releaseReader = undefined;
          pausedReads++;
          const hash = createHash("sha256");
          let bytes = 0,
            lines = 0;
          for (;;) {
            let line = await peer.line();
            if (line.equals(Buffer.from("."))) break;
            if (line[0] === 46) line = line.subarray(1);
            hash.update(line).update("\r\n");
            bytes += line.length + 2;
            // Yield with the reader's bounded buffer retained; async socket iteration
            // applies real TCP backpressure rather than accumulating a transcript.
            if (++lines % 64 === 0) await nextTurn();
          }
          assert.equal(bytes, config.messageBytes);
          assert.equal(hash.digest("hex"), expected);
          received++;
          receivedBytes += bytes;
          await peer.write("250 Accepted\r\n");
        } else if (command === "QUIT") {
          await peer.write("221 Bye\r\n");
          break;
        } else throw new Error(`Unexpected SMTP command: ${command.slice(0, 20)}`);
      }
    })()
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        peer.close();
        peers.delete(peer);
        finished.release();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  let client: Awaited<ReturnType<typeof connectSmtp>> | undefined;
  try {
    client = await connectSmtp({ host: "127.0.0.1", port, timeoutMs: config.timeoutMs });
    // Observation only: SmtpClient intentionally does not expose transport metrics.
    // Assert the real implementation's socket drains; do not replace its writes.
    const transport = Reflect.get(client, "socket") as net.Socket;
    assert(transport instanceof net.Socket, "SMTP transport observation needs updating");
    let drains = 0;
    transport.on("drain", () => {
      drains++;
      releaseReader?.();
    });
    await client.ehlo("stress.example.test");
    for (let round = 0; round < config.rounds; round++) {
      const result: SmtpSendResult = await client.send({
        mailFrom: "sender@example.test",
        rcptTo: ["recipient@example.test"],
        data: source,
      });
      assert(result.accepted);
    }
    await client.quit();
    await finished.promise;
    if (failure) throw failure;
    assert.equal(received, config.rounds);
    assert(drains > 0, "scenario did not exercise output backpressure");
    assert.equal(pausedReads, config.rounds);
    return { accepted: received, bytesVerified: receivedBytes, drains, pausedReads };
  } finally {
    releaseReader?.();
    client?.close();
    for (const peer of peers) peer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
