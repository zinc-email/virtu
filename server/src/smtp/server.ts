/**
 * RFC 5321 SMTP server with a hook-style interface (`createSmtpServer`),
 * so mx/submission stay thin: the state machine, extensions and framing live
 * here; policy lives in the hooks.
 *
 * Extensions: PIPELINING, SIZE, 8BITMIME, SMTPUTF8, ENHANCEDSTATUSCODES,
 * STARTTLS (when TLS is configured), AUTH PLAIN LOGIN (when `onAuth` is
 * configured). Implicit-TLS listeners (465) via `implicitTls: true`.
 *
 * Bun note: server-side `new tls.TLSSocket(socket, { isServer: true })` does
 * not complete handshakes on Bun (oven-sh/bun#21541), so STARTTLS upgrades
 * are performed by piping the accepted socket's encrypted bytes through a
 * one-shot loopback `tls.Server`. See `upgradeServerSocket`.
 */
import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import type {
  SmtpEnvelope,
  SmtpHookResult,
  SmtpParams,
  SmtpRecipient,
  SmtpRejection,
  SmtpServer,
  SmtpServerOptions,
  SmtpSession,
} from "./types.ts";
import { clientKey } from "../pipeline/ipAddress.ts";
import { createDataBudget, type DataBudget } from "./dataBudget.ts";
import {
  DataDecoder,
  MAX_COMMAND_LINE,
  decodeBase64,
  formatReply,
  parseParams,
  parsePath,
  reply,
  splitMessage,
  takeLine,
} from "./wire.ts";

const DEFAULTS = {
  maxMessageSize: 25 * 1024 * 1024,
  maxRecipients: 100,
  maxErrors: 10,
  maxConnections: 1024,
  // Postfix's smtpd_client_connection_count_limit is 50; an MX that is not a
  // relay for anyone needs far fewer, and every slot a dribbling peer holds
  // is one an honest MTA cannot have (sessionTimeoutMs bounds the hold).
  maxConnectionsPerIp: 20,
  maxDataLineLength: 10_000,
  commandTimeoutMs: 300_000,
  dataTimeoutMs: 600_000,
  sessionTimeoutMs: 30 * 60_000,
  maxPipelinedBytes: 1024 * 1024,
  maxJunkCommands: 100,
  softErrorLimit: 5,
  errorSleepMs: 1000,
  maxCommands: 10_000,
  minDataRate: 500,
  maxDataBytesInFlight: 256 * 1024 * 1024,
};

/** Commands that do no work for anyone (Postfix's junk command list). */
const JUNK_COMMANDS = new Set(["NOOP", "RSET", "HELO", "EHLO", "VRFY"]);

type Resolved = SmtpServerOptions & typeof DEFAULTS & { requireAuthTls: boolean };

/**
 * Create an SMTP server. Call `.listen()` to bind. See `SmtpServerOptions`
 * for hooks and limits; any omitted hook accepts.
 */
export function createSmtpServer(options: SmtpServerOptions): SmtpServer {
  const opts: Resolved = {
    ...DEFAULTS,
    ...options,
    requireAuthTls: options.requireAuthTls ?? options.tls != null,
  };
  if (opts.implicitTls && !opts.tls) {
    throw new Error("implicitTls requires the tls option (key/cert)");
  }

  const connections = new Set<Connection>();
  const perIp = new Map<string, number>();
  const dataBudget = options.dataBudget ?? createDataBudget(opts.maxDataBytesInFlight);
  let server: net.Server | null = null;
  let bound: { port: number; host: string } | null = null;

  const onSocket = (socket: net.Socket | tls.TLSSocket, secure: boolean) => {
    // Backpressure: cap concurrent connections globally and per client so a
    // flood of slow/idle sockets (each alive up to commandTimeoutMs) can't
    // exhaust memory/timers. Refuse over the cap without allocating a session.
    // The client key is the /64 for IPv6 (pipeline/ipAddress.ts).
    const ip = clientKey(socket.remoteAddress ?? undefined);
    const ipCount = perIp.get(ip) ?? 0;
    if (connections.size >= opts.maxConnections || ipCount >= opts.maxConnectionsPerIp) {
      try {
        socket.write(reply(421, "4.7.0", "Too many concurrent connections; try again later"));
      } catch {
        // socket may already be gone; destroying below is enough.
      }
      socket.destroy();
      return;
    }
    perIp.set(ip, ipCount + 1);
    const conn = new Connection(socket, secure, opts, dataBudget, () => {
      connections.delete(conn);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    connections.add(conn);
    conn.start();
  };

  return {
    listen(port = 0, host = "0.0.0.0") {
      return new Promise((resolve, rejectPromise) => {
        server = opts.implicitTls
          ? tls.createServer({ key: opts.tls!.key, cert: opts.tls!.cert }, (s) => onSocket(s, true))
          : net.createServer((s) => onSocket(s, false));
        server.once("error", rejectPromise);
        server.listen(port, host, () => {
          const addr = server!.address() as net.AddressInfo;
          bound = { port: addr.port, host: addr.address };
          server!.removeListener("error", rejectPromise);
          resolve(bound);
        });
      });
    },
    address: () => bound,
    close() {
      return new Promise((resolve) => {
        for (const conn of [...connections]) conn.destroy();
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
        bound = null;
      });
    },
  };
}

/**
 * Server-side STARTTLS upgrade that works on Bun: run the TLS handshake in a
 * one-shot loopback `tls.Server`, piping the accepted socket's (encrypted)
 * bytes through it; the resulting cleartext socket replaces the raw one.
 * A pairing check (remote port of the accepted loopback connection must be
 * our own bridge socket's local port) guards against loopback hijacking.
 */
function upgradeServerSocket(
  raw: net.Socket,
  tlsConfig: { key: string; cert: string },
): Promise<{ clear: tls.TLSSocket; bridge: net.Socket }> {
  return new Promise((resolve, rejectPromise) => {
    const oneShot = tls.createServer({ key: tlsConfig.key, cert: tlsConfig.cert });
    let expectedPort = -1;
    let bridge: net.Socket | undefined;
    const unverified: net.Socket[] = [];
    const verify = (conn: net.Socket) => {
      const ok =
        conn.remotePort === expectedPort &&
        (conn.remoteAddress === "127.0.0.1" || conn.remoteAddress === "::ffff:127.0.0.1");
      if (!ok) conn.destroy();
    };
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      oneShot.close();
      bridge?.destroy();
      rejectPromise(err);
    };
    // If the peer vanishes before the handshake completes, tear everything down.
    raw.once("close", () => fail(new Error("connection closed during TLS upgrade")));
    oneShot.on("tlsClientError", fail);
    oneShot.on("error", fail);
    oneShot.on("connection", (conn) => {
      if (expectedPort === -1) unverified.push(conn);
      else verify(conn);
    });
    oneShot.on("secureConnection", (clear) => {
      oneShot.close();
      if (settled) return clear.destroy();
      settled = true;
      resolve({ clear, bridge: bridge! });
    });
    oneShot.listen(0, "127.0.0.1", () => {
      const port = (oneShot.address() as net.AddressInfo).port;
      const b = net.connect(port, "127.0.0.1", () => {
        expectedPort = b.localPort ?? -2;
        for (const conn of unverified.splice(0)) verify(conn);
        raw.pipe(b);
        b.pipe(raw);
      });
      bridge = b;
      b.on("error", fail);
    });
  });
}

let nextConnectionId = 0;

class Connection {
  private socket: net.Socket | tls.TLSSocket;
  /** The originally accepted TCP socket (kept for teardown across STARTTLS). */
  private readonly rawSocket: net.Socket;
  private bridgeSocket: net.Socket | null = null;
  private readonly session: SmtpSession;
  /** Input consumed by the pump: what is left of the last joined chunk list. */
  private buf: Buffer = Buffer.alloc(0);
  /**
   * Input received but not yet joined into `buf`. Chunks are joined once per
   * pump run (linear), never per `data` event (quadratic on a flood).
   */
  private chunks: Buffer[] = [];
  private buffered = 0;
  private mode: "command" | "data" | "closed" = "command";
  private destroyed = false;
  private greeted = false;
  private pumping = false;
  private skipUntilLf = false;
  private greetingRejected = false;
  private errors = 0;
  private junkCommands = 0;
  private commands = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current DATA transfer times out; credited per chunk received. */
  private dataDeadlineAt = 0;
  /** Bytes of the current message reserved from the shared data budget. */
  private dataHeld = 0;

  // Transaction state
  private mailFrom: string | null = null;
  private mailParams: SmtpParams = {};
  private rcptTo: SmtpRecipient[] = [];
  private dataDecoder: DataDecoder | null = null;

  // AUTH continuation state
  private authDialog: { mechanism: "PLAIN" | "LOGIN"; username?: string } | null = null;

  constructor(
    socket: net.Socket | tls.TLSSocket,
    private secure: boolean,
    private readonly opts: Resolved,
    private readonly dataBudget: DataBudget,
    private readonly onClose: () => void,
  ) {
    this.socket = socket;
    this.rawSocket = socket as net.Socket;
    this.session = {
      id: (++nextConnectionId).toString(36),
      remoteAddress: socket.remoteAddress ?? "",
      remotePort: socket.remotePort ?? 0,
      tls: secure,
    };
  }

  async start(): Promise<void> {
    this.attach(this.socket);
    this.armIdleTimer();
    // Absolute session lifetime: the idle timers re-arm on activity, so a
    // peer dribbling one byte per timeout would otherwise hold its slot
    // forever (slowloris). Nothing legitimate needs half an hour on one
    // SMTP session; deliverd-class clients reconnect.
    this.sessionTimer = setTimeout(() => {
      this.write(reply(421, "4.4.2", `${this.opts.hostname} Error: session time limit exceeded`));
      this.destroy();
    }, this.opts.sessionTimeoutMs);
    this.sessionTimer.unref?.();
    const result = await this.runHook(this.opts.onConnect, { session: this.session });
    if (this.destroyed) return;
    if ("reject" in result) {
      this.greetingRejected = true;
      this.write(reply(result.reject.code, result.reject.enhanced, result.reject.message));
    } else {
      const banner = this.opts.banner ? ` ${this.opts.banner}` : "";
      this.write(`220 ${this.opts.hostname} ESMTP${banner}\r\n`);
    }
    this.greeted = true;
    void this.pump();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mode = "closed";
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.releaseDataHeld();
    this.socket.destroy();
    if (this.bridgeSocket) this.bridgeSocket.destroy();
    if (this.rawSocket !== this.socket) this.rawSocket.destroy();
    this.onClose();
  }

  private releaseDataHeld(): void {
    if (this.dataHeld === 0) return;
    this.dataBudget.release(this.dataHeld);
    this.dataHeld = 0;
  }

  // -- plumbing -------------------------------------------------------------

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on("data", (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (this.mode === "data") {
        // Every byte in DATA is held until the message is queued or refused,
        // and the process has one budget for all of them.
        if (!this.dataBudget.reserve(chunk.length)) {
          this.write(
            reply(421, "4.3.1", `${this.opts.hostname} Error: insufficient system storage`),
          );
          this.destroy();
          return;
        }
        this.dataHeld += chunk.length;
        // Bytes flowing keep a DATA session alive at the minimum data rate;
        // in command mode only a consumed line does (see pump) — a
        // byte-at-a-time dribble is not activity either way.
        this.creditDataDeadline(chunk.length);
      }
      if (this.pumping) {
        // The pump is parked at an await, and the socket is paused there:
        // whatever still arrives (an in-flight segment) is bounded here so
        // a peer can never make us hold more than this on its behalf.
        if (this.buffered > this.opts.maxPipelinedBytes) {
          this.write(reply(421, "4.7.0", `${this.opts.hostname} Error: too much pipelined input`));
          this.destroy();
        }
        return;
      }
      void this.pump();
    });
    socket.on("error", () => this.destroy());
    socket.on("close", () => this.destroy());
  }

  private detach(socket: net.Socket | tls.TLSSocket): void {
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    socket.on("error", () => {});
  }

  private write(s: string): void {
    if (this.mode === "closed") return;
    this.socket.write(s);
  }

  /**
   * Extend the DATA deadline for `bytes` received: `bytes / minDataRate`
   * seconds, never beyond a full `dataTimeoutMs` from now (Postfix
   * `smtpd_min_data_rate`). The timer itself is not touched per chunk; it
   * re-arms against this deadline when it fires (`armIdleTimer`).
   */
  private creditDataDeadline(bytes: number): void {
    const now = Date.now();
    const cap = now + this.opts.dataTimeoutMs;
    if (this.opts.minDataRate <= 0) {
      this.dataDeadlineAt = cap;
      return;
    }
    this.dataDeadlineAt = Math.min(
      this.dataDeadlineAt + (bytes * 1000) / this.opts.minDataRate,
      cap,
    );
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.mode === "closed") return;
    const ms =
      this.mode === "data"
        ? Math.max(0, this.dataDeadlineAt - Date.now())
        : this.opts.commandTimeoutMs;
    this.idleTimer = setTimeout(() => {
      if (this.mode === "data" && Date.now() < this.dataDeadlineAt) {
        this.armIdleTimer();
        return;
      }
      this.write(reply(421, "4.4.2", `${this.opts.hostname} Error: timeout exceeded`));
      this.destroy();
    }, ms);
  }

  /** Reply with an error, counting toward maxErrors (421 + close beyond it). */
  private sayError(code: number, enhanced: string | undefined, text: string): void {
    this.write(reply(code, enhanced, text));
    this.noteError();
  }

  /** Count one error; true when that ended the session (`421 4.7.0`). */
  private noteError(): boolean {
    this.errors++;
    if (this.errors > this.opts.maxErrors) {
      this.write(reply(421, "4.7.0", `${this.opts.hostname} Error: too many errors`));
      this.endAfterFlush();
      return true;
    }
    return false;
  }

  private endAfterFlush(): void {
    const s = this.socket;
    this.mode = "closed";
    if (this.idleTimer) clearTimeout(this.idleTimer);
    s.end();
    // Guard against peers that never close their half.
    setTimeout(() => this.destroy(), 2000).unref?.();
  }

  private async runHook<A>(
    hook: ((arg: A) => SmtpHookResult | Promise<SmtpHookResult>) | undefined,
    arg: A,
  ): Promise<SmtpHookResult> {
    if (!hook) return { accept: true };
    // Backpressure: while the hook runs (DB, DNS — seconds, and the peer
    // can stretch it) stop reading. Bytes stay in the kernel receive
    // buffer, the window closes, and the peer's sends block — TCP's own
    // flow control, which a socket that never stops reading defeats.
    const socket = this.socket;
    socket.pause();
    try {
      return await hook(arg);
    } catch {
      return { reject: { code: 451, enhanced: "4.3.0", message: "Internal server error" } };
    } finally {
      if (!this.destroyed && this.socket === socket) socket.resume();
    }
  }

  /** Resolve once the socket's write buffer drains (or the socket goes away). */
  private waitForDrain(): Promise<void> {
    const socket = this.socket;
    return new Promise((resolve) => {
      const done = () => {
        socket.off("drain", done);
        socket.off("close", done);
        resolve();
      };
      socket.once("drain", done);
      socket.once("close", done);
    });
  }

  /** Join received chunks into `buf` (once per pump run). */
  private takeBuffered(): void {
    if (this.chunks.length === 0) return;
    const parts = this.buf.length > 0 ? [this.buf, ...this.chunks] : this.chunks;
    this.buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
    this.chunks = [];
    this.buffered = 0;
  }

  private resetTransaction(): void {
    this.mailFrom = null;
    this.mailParams = {};
    this.rcptTo = [];
    this.dataDecoder = null;
  }

  // -- the pump: consume buffered input line by line ------------------------

  private async pump(): Promise<void> {
    if (this.pumping || !this.greeted) return;
    this.pumping = true;
    try {
      while (this.mode !== "closed") {
        this.takeBuffered();
        if (this.mode === "data") {
          if (this.buf.length === 0) break;
          const chunk = this.buf;
          this.buf = Buffer.alloc(0);
          const rest = this.dataDecoder!.push(chunk);
          if (rest === null) break;
          this.buf = Buffer.from(rest);
          this.mode = "command";
          this.armIdleTimer();
          await this.finishData();
          continue;
        }
        // Command mode
        if (this.skipUntilLf) {
          const cut = this.buf.indexOf(0x0a);
          if (cut === -1) {
            this.buf = Buffer.alloc(0);
            break;
          }
          this.buf = this.buf.subarray(cut + 1);
          this.skipUntilLf = false;
          continue;
        }
        const split = takeLine(this.buf);
        if (split === null) {
          if (this.buf.length > MAX_COMMAND_LINE) {
            this.buf = Buffer.alloc(0);
            this.skipUntilLf = true;
            this.sayError(500, "5.5.2", "Line too long");
          }
          break;
        }
        this.buf = split.rest;
        if (split.line.length > MAX_COMMAND_LINE) {
          this.sayError(500, "5.5.2", "Line too long");
          continue;
        }
        // Honour our own write backpressure: a peer that pipelines commands
        // and never reads the replies would otherwise have every reply
        // queued in our memory. Stop reading until it catches up (the idle
        // timer still runs — a peer that never reads is idle to us).
        if (this.socket.writableNeedDrain) {
          this.socket.pause();
          await this.waitForDrain();
          if (this.destroyed) break;
          this.socket.resume();
        }
        // Past the soft error limit every command pays a delay first
        // (Postfix error_sleep_time): a peer that keeps failing spends
        // its time on our schedule until it hits the hard limit.
        if (this.errors >= this.opts.softErrorLimit && this.opts.errorSleepMs > 0) {
          this.socket.pause();
          await Bun.sleep(this.opts.errorSleepMs);
          if (this.destroyed) break;
          this.socket.resume();
        }
        this.armIdleTimer();
        await this.handleLine(split.line.toString("utf8"));
      }
    } finally {
      this.pumping = false;
    }
  }

  // -- command dispatch -----------------------------------------------------

  private async handleLine(line: string): Promise<void> {
    if (++this.commands > this.opts.maxCommands) {
      this.write(reply(421, "4.7.0", `${this.opts.hostname} Error: too many commands`));
      return this.endAfterFlush();
    }
    if (this.authDialog) return this.handleAuthLine(line);

    const sp = line.indexOf(" ");
    const verb = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp === -1 ? "" : line.slice(sp + 1);

    if (this.greetingRejected && verb !== "QUIT") {
      return this.sayError(503, "5.5.1", "Bad sequence of commands");
    }
    // Junk past the limit is an error each (Postfix smtpd_junk_command_limit);
    // the command is still answered unless that error ended the session.
    if (
      JUNK_COMMANDS.has(verb) &&
      ++this.junkCommands > this.opts.maxJunkCommands &&
      this.noteError()
    ) {
      return;
    }

    switch (verb) {
      case "EHLO":
      case "HELO":
        return this.handleEhlo(verb, arg.trim());
      case "MAIL":
        return this.handleMail(arg);
      case "RCPT":
        return this.handleRcpt(arg);
      case "DATA":
        return this.handleData(arg);
      case "RSET":
        this.resetTransaction();
        return this.write(reply(250, "2.0.0", "Ok"));
      case "NOOP":
        return this.write(reply(250, "2.0.0", "Ok"));
      case "QUIT":
        this.write(reply(221, "2.0.0", `${this.opts.hostname} closing connection`));
        return this.endAfterFlush();
      case "VRFY":
        return this.write(
          reply(252, "2.0.0", "Cannot VRFY user, but will accept message and attempt delivery"),
        );
      case "STARTTLS":
        return this.handleStartTls(arg);
      case "AUTH":
        return this.handleAuth(arg);
      case "HELP":
      case "EXPN":
      case "ETRN":
      case "TURN":
        return this.sayError(502, "5.5.1", `${verb} command not implemented`);
      case "":
        return this.sayError(500, "5.5.2", "Empty command");
      default:
        return this.sayError(500, "5.5.2", "Command not recognized");
    }
  }

  private async handleEhlo(verb: "EHLO" | "HELO", heloName: string): Promise<void> {
    if (!heloName) return this.sayError(501, "5.5.4", `${verb} requires a domain or address`);
    const result = await this.runHook(this.opts.onEhlo, { session: this.session, heloName, verb });
    if ("reject" in result) {
      const r = result.reject;
      return this.sayError(r.code, r.enhanced, r.message);
    }
    this.session.heloName = heloName;
    this.resetTransaction();
    if (verb === "HELO") return this.write(`250 ${this.opts.hostname}\r\n`);
    const lines = [
      `${this.opts.hostname}`,
      "PIPELINING",
      `SIZE ${this.opts.maxMessageSize}`,
      "8BITMIME",
      "SMTPUTF8",
      "ENHANCEDSTATUSCODES",
    ];
    if (this.opts.tls && !this.secure) lines.push("STARTTLS");
    if (this.opts.onAuth && (this.secure || !this.opts.requireAuthTls)) {
      lines.push("AUTH PLAIN LOGIN");
    }
    this.write(formatReply(250, lines));
  }

  private async handleMail(arg: string): Promise<void> {
    if (!this.session.heloName) return this.sayError(503, "5.5.1", "Send HELO/EHLO first");
    if (this.mailFrom !== null) return this.sayError(503, "5.5.1", "Nested MAIL command");
    const m = /^FROM:\s*(.*)$/is.exec(arg);
    if (!m) return this.sayError(501, "5.5.4", "Syntax: MAIL FROM:<address>");
    // An empty address can only come from "<>" (the null reverse-path), which is legal.
    const parsed = parsePath(m[1]!);
    if (parsed === null) return this.sayError(501, "5.1.7", "Bad sender address syntax");
    const params = parseParams(parsed.paramString);
    if (params === null) return this.sayError(501, "5.5.4", "Bad MAIL parameter syntax");
    for (const [key, value] of Object.entries(params)) {
      switch (key) {
        case "SIZE": {
          if (value === true || !/^\d+$/.test(value)) {
            return this.sayError(501, "5.5.4", "Bad SIZE parameter");
          }
          if (Number(value) > this.opts.maxMessageSize) {
            return this.sayError(552, "5.3.4", "Message size exceeds fixed maximum message size");
          }
          break;
        }
        case "BODY": {
          const body = String(value).toUpperCase();
          if (body !== "7BIT" && body !== "8BITMIME") {
            return this.sayError(555, "5.5.4", "Unsupported BODY value");
          }
          break;
        }
        case "SMTPUTF8": {
          if (value !== true) return this.sayError(501, "5.5.4", "SMTPUTF8 takes no value");
          break;
        }
        case "AUTH":
          break; // accepted and recorded; we make no use of it
        default:
          return this.sayError(555, "5.5.4", `Unsupported MAIL parameter: ${key}`);
      }
    }
    const result = await this.runHook(this.opts.onMailFrom, {
      session: this.session,
      address: parsed.address,
      params,
    });
    if ("reject" in result) {
      const r = result.reject;
      return this.sayError(r.code, r.enhanced, r.message);
    }
    this.mailFrom = parsed.address;
    this.mailParams = params;
    this.rcptTo = [];
    this.write(reply(250, "2.1.0", "Ok"));
  }

  private async handleRcpt(arg: string): Promise<void> {
    if (this.mailFrom === null) return this.sayError(503, "5.5.1", "Need MAIL command first");
    const m = /^TO:\s*(.*)$/is.exec(arg);
    if (!m) return this.sayError(501, "5.5.4", "Syntax: RCPT TO:<address>");
    const parsed = parsePath(m[1]!);
    if (parsed === null || parsed.address === "") {
      return this.sayError(501, "5.1.3", "Bad recipient address syntax");
    }
    const params = parseParams(parsed.paramString);
    if (params === null) return this.sayError(501, "5.5.4", "Bad RCPT parameter syntax");
    if (Object.keys(params).length > 0) {
      return this.sayError(555, "5.5.4", "Unsupported RCPT parameters");
    }
    if (this.rcptTo.length >= this.opts.maxRecipients) {
      return this.sayError(452, "4.5.3", "Too many recipients");
    }
    // A recipient named twice is delivered once (RFC 5321 §4.5.3 says
    // duplicates MAY be deduplicated; a server that does not is a fan-out
    // amplifier — the same alias a hundred times was a hundred queued
    // copies past every per-mailbox budget, since each RCPT only sees the
    // rows already written). The peer still gets its 250.
    const dedupeKey = parsed.address.trim().toLowerCase();
    if (this.rcptTo.some((r) => r.address.trim().toLowerCase() === dedupeKey)) {
      return this.write(reply(250, "2.1.5", "Ok"));
    }
    const result = await this.runHook(this.opts.onRcptTo, {
      session: this.session,
      address: parsed.address,
      params,
      rcptTo: this.rcptTo,
    });
    if ("reject" in result) {
      const r = result.reject;
      return this.sayError(r.code, r.enhanced, r.message);
    }
    this.rcptTo.push({ address: parsed.address, params });
    this.write(reply(250, "2.1.5", "Ok"));
  }

  private handleData(arg: string): void {
    if (arg.trim() !== "") return this.sayError(501, "5.5.4", "DATA takes no arguments");
    if (this.mailFrom === null) return this.sayError(503, "5.5.1", "Need MAIL command first");
    if (this.rcptTo.length === 0) return this.sayError(503, "5.5.1", "Need RCPT command first");
    if (this.dataBudget.inFlight() >= this.dataBudget.maxBytes) {
      return this.sayError(452, "4.3.1", "Insufficient system storage, try again later");
    }
    this.dataDecoder = new DataDecoder(this.opts.maxMessageSize, this.opts.maxDataLineLength);
    this.mode = "data";
    this.dataDeadlineAt = Date.now() + this.opts.dataTimeoutMs;
    this.armIdleTimer();
    this.write("354 End data with <CR><LF>.<CR><LF>\r\n");
  }

  private async finishData(): Promise<void> {
    try {
      await this.disposeData();
    } finally {
      // The message is queued or refused either way: its bytes are free.
      this.releaseDataHeld();
    }
  }

  private async disposeData(): Promise<void> {
    const decoder = this.dataDecoder!;
    const envelope: SmtpEnvelope = {
      heloName: this.session.heloName ?? "",
      tls: this.secure,
      authUser: this.session.authUser,
      mailFrom: this.mailFrom ?? "",
      params: this.mailParams,
      rcptTo: this.rcptTo,
    };
    this.resetTransaction();
    if (decoder.tooBig) {
      return this.sayError(552, "5.3.4", "Message size exceeds fixed maximum message size");
    }
    if (decoder.lineTooLong) {
      return this.sayError(500, "5.6.0", "Line too long");
    }
    const raw = decoder.message();
    const { headers, body } = splitMessage(raw);
    const result = await this.runHook(this.opts.onData, {
      session: this.session,
      envelope,
      headers,
      body,
      raw,
    });
    if ("reject" in result) {
      const r = result.reject;
      return this.sayError(r.code, r.enhanced, r.message);
    }
    this.write(reply(250, "2.6.0", result.message ?? "Message accepted"));
  }

  // -- STARTTLS -------------------------------------------------------------

  private async handleStartTls(arg: string): Promise<void> {
    if (arg.trim() !== "") return this.sayError(501, "5.5.4", "STARTTLS takes no arguments");
    if (!this.opts.tls) return this.sayError(502, "5.5.1", "TLS not available");
    if (this.secure) return this.sayError(503, "5.5.1", "TLS already active");
    this.write("220 2.0.0 Ready to start TLS\r\n");
    // RFC 3207: discard any plaintext pipelined after STARTTLS (injection guard)
    // and reset all SMTP state.
    this.buf = Buffer.alloc(0);
    this.chunks = [];
    this.buffered = 0;
    const raw = this.socket as net.Socket;
    this.detach(raw);
    raw.pause();
    try {
      const { clear, bridge } = await upgradeServerSocket(raw, this.opts.tls);
      if (this.destroyed) {
        clear.destroy();
        bridge.destroy();
        return;
      }
      this.bridgeSocket = bridge;
      this.socket = clear;
      this.secure = true;
      this.session.tls = true;
      this.session.heloName = undefined;
      this.session.authUser = undefined;
      this.resetTransaction();
      this.attach(clear);
      raw.on("close", () => this.destroy());
      this.armIdleTimer();
    } catch {
      this.destroy();
    }
  }

  // -- AUTH -----------------------------------------------------------------

  private async handleAuth(arg: string): Promise<void> {
    if (!this.opts.onAuth) return this.sayError(502, "5.5.1", "AUTH not available");
    if (!this.session.heloName) return this.sayError(503, "5.5.1", "Send HELO/EHLO first");
    if (this.session.authUser) return this.sayError(503, "5.5.1", "Already authenticated");
    if (this.mailFrom !== null)
      return this.sayError(503, "5.5.1", "AUTH not allowed during a mail transaction");
    if (this.opts.requireAuthTls && !this.secure) {
      return this.sayError(
        538,
        "5.7.11",
        "Encryption required for requested authentication mechanism",
      );
    }
    const [mechRaw, initial] = arg.trim().split(/\s+/, 2);
    const mechanism = (mechRaw ?? "").toUpperCase();
    if (mechanism === "PLAIN") {
      if (initial !== undefined) return this.finishAuthPlain(initial);
      this.authDialog = { mechanism: "PLAIN" };
      return this.write("334 \r\n");
    }
    if (mechanism === "LOGIN") {
      if (initial !== undefined) {
        const user = decodeBase64(initial);
        if (user === null) return this.sayError(501, "5.5.2", "Cannot decode base64");
        this.authDialog = { mechanism: "LOGIN", username: user.toString("utf8") };
        return this.write("334 UGFzc3dvcmQ6\r\n"); // "Password:"
      }
      this.authDialog = { mechanism: "LOGIN" };
      return this.write("334 VXNlcm5hbWU6\r\n"); // "Username:"
    }
    return this.sayError(504, "5.5.4", "Unrecognized authentication type");
  }

  private async handleAuthLine(line: string): Promise<void> {
    const dialog = this.authDialog!;
    const input = line.trim();
    if (input === "*") {
      this.authDialog = null;
      return this.sayError(501, "5.7.0", "Authentication aborted");
    }
    if (dialog.mechanism === "PLAIN") {
      this.authDialog = null;
      return this.finishAuthPlain(input);
    }
    // LOGIN
    const decoded = decodeBase64(input);
    if (decoded === null) {
      this.authDialog = null;
      return this.sayError(501, "5.5.2", "Cannot decode base64");
    }
    if (dialog.username === undefined) {
      dialog.username = decoded.toString("utf8");
      return this.write("334 UGFzc3dvcmQ6\r\n");
    }
    this.authDialog = null;
    return this.finishAuth("LOGIN", dialog.username, decoded.toString("utf8"), undefined);
  }

  private async finishAuthPlain(b64: string): Promise<void> {
    this.authDialog = null;
    const decoded = decodeBase64(b64);
    if (decoded === null) return this.sayError(501, "5.5.2", "Cannot decode base64");
    const parts = decoded.toString("utf8").split("\0");
    if (parts.length !== 3) return this.sayError(501, "5.5.2", "Malformed AUTH PLAIN credentials");
    const [authzid, username, password] = parts as [string, string, string];
    return this.finishAuth("PLAIN", username, password, authzid || undefined);
  }

  private async finishAuth(
    mechanism: "PLAIN" | "LOGIN",
    username: string,
    password: string,
    authzid: string | undefined,
  ): Promise<void> {
    const result = await this.runHook(this.opts.onAuth, {
      session: this.session,
      mechanism,
      username,
      password,
      authzid,
    });
    if ("reject" in result) {
      const r = result.reject;
      return this.sayError(r.code || 535, r.enhanced ?? "5.7.8", r.message);
    }
    this.session.authUser = username;
    this.write(reply(235, "2.7.0", "Authentication successful"));
  }
}

/** Reusable rejection shape helper (sugar for hooks). */
export function rejectWith(
  code: number,
  enhanced: string,
  message: string,
): { reject: SmtpRejection } {
  return { reject: { code, enhanced, message } };
}
