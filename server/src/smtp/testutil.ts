/**
 * Test-only helpers for the SMTP test suites in this directory: start a
 * server on an ephemeral loopback port, and a raw-socket client for driving
 * the server byte-by-byte (and for playing hostile server against the real
 * client). Not part of the public API.
 */
import net from "node:net";
import { Buffer } from "node:buffer";
import { createSmtpServer } from "./server.ts";
import type { SmtpServer, SmtpServerOptions } from "./types.ts";

/** Start an SMTP server on 127.0.0.1:0; returns the server and its port. */
export async function listen(
  options: SmtpServerOptions,
): Promise<{ server: SmtpServer; port: number }> {
  const server = createSmtpServer(options);
  const { port } = await server.listen(0, "127.0.0.1");
  return { server, port };
}

/** A raw TCP client that accumulates received text and lets tests await patterns. */
export class RawClient {
  private received = "";
  private cursor = 0;
  private waiters: {
    pattern: RegExp;
    resolve: (s: string) => void;
    reject: (e: Error) => void;
  }[] = [];
  private socket!: net.Socket;
  closed = false;

  static async connect(port: number): Promise<RawClient> {
    const c = new RawClient();
    await new Promise<void>((resolve, reject) => {
      c.socket = net.connect(port, "127.0.0.1", resolve);
      c.socket.once("error", reject);
      c.socket.on("data", (chunk: Buffer) => {
        c.received += chunk.toString("utf8");
        c.check();
      });
      c.socket.on("close", () => {
        c.closed = true;
        c.check();
      });
    });
    return c;
  }

  write(s: string): void {
    this.socket.write(s);
  }

  /** All text received so far. */
  get all(): string {
    return this.received;
  }

  /**
   * Wait until a complete line matching `pattern` arrives at or after the
   * read cursor; consumes through the end of that line and resolves with it.
   */
  waitFor(pattern: RegExp, timeoutMs = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped.resolve);
        reject(
          new Error(
            `Timed out waiting for ${pattern}. Unconsumed input: ${JSON.stringify(this.received.slice(this.cursor))}`,
          ),
        );
      }, timeoutMs);
      const wrapped = {
        pattern,
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(wrapped);
      queueMicrotask(() => this.check());
    });
  }

  /** Try to match one waiter against the unread input. */
  private matchWaiter(pattern: RegExp): string | null {
    const unread = this.received.slice(this.cursor);
    let pos = 0;
    for (;;) {
      const nl = unread.indexOf("\n", pos);
      if (nl === -1) return null;
      const end = nl > pos && unread[nl - 1] === "\r" ? nl - 1 : nl;
      const line = unread.slice(pos, end);
      pos = nl + 1;
      if (pattern.test(line)) {
        this.cursor += pos;
        return line;
      }
    }
  }

  private check(): void {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      const line = this.matchWaiter(w.pattern);
      if (line !== null) {
        this.waiters.splice(i--, 1);
        w.resolve(line);
      } else if (this.closed) {
        this.waiters.splice(i--, 1);
        w.reject(new Error(`Connection closed while waiting for ${w.pattern}`));
      }
    }
  }

  /** Resolves when the server closes the connection. */
  waitForClose(timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) return resolve();
      const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
      this.socket.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  end(): void {
    this.socket.destroy();
  }

  /** Direct access for TLS upgrades in tests. */
  get raw(): net.Socket {
    return this.socket;
  }
}

/**
 * A scripted hostile server for client tests: for each connection, runs the
 * given handler with a tiny line-oriented API.
 */
export interface HostileConn {
  /** Send raw bytes (caller supplies CRLF). */
  write(s: string): void;
  /** Await the next received line (without CRLF). */
  nextLine(timeoutMs?: number): Promise<string>;
  /** Sever the connection immediately. */
  destroy(): void;
  socket: net.Socket;
}

export async function hostileServer(
  handler: (conn: HostileConn) => Promise<void>,
): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((socket) => {
    let buf = "";
    const lineWaiters: ((line: string) => void)[] = [];
    const lines: string[] = [];
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const idx = buf.indexOf("\n");
        if (idx === -1) break;
        let line = buf.slice(0, idx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buf = buf.slice(idx + 1);
        const w = lineWaiters.shift();
        if (w) w(line);
        else lines.push(line);
      }
    });
    socket.on("error", () => {});
    const conn: HostileConn = {
      write: (s) => void socket.write(s),
      nextLine: (timeoutMs = 5000) =>
        new Promise<string>((resolve, reject) => {
          const buffered = lines.shift();
          if (buffered !== undefined) return resolve(buffered);
          const timer = setTimeout(() => reject(new Error("hostile server: no line")), timeoutMs);
          lineWaiters.push((line) => {
            clearTimeout(timer);
            resolve(line);
          });
        }),
      destroy: () => socket.destroy(),
      socket,
    };
    void handler(conn).catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => server.close() };
}
