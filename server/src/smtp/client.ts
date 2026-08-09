/**
 * Transport-only SMTP client (`connectSmtp`). MX resolution is the caller's
 * job (deliverd); this module speaks the protocol to one host:port.
 *
 * Error model:
 * - Transport problems (connect failure, timeouts, connection drops, garbage
 *   replies) throw {@link SmtpClientError}.
 * - Protocol refusals of session-level commands (bad greeting, EHLO/HELO
 *   refused, STARTTLS refused, AUTH refused) throw {@link SmtpCommandError},
 *   which carries the offending {@link SmtpReply} for classification.
 * - Envelope-level refusals during `send()` do NOT throw: `SmtpSendResult`
 *   reports `{ code, enhancedCode, message }` per step (MAIL, each RCPT,
 *   DATA) so deliverd can classify permanent vs transient per recipient.
 */
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import { Buffer } from "node:buffer";
import type {
  ConnectSmtpOptions,
  SmtpClient,
  SmtpReply,
  SmtpSendOptions,
  SmtpSendResult,
} from "./types.ts";
import {
  ReplyParser,
  bracket,
  dotStuff,
  encodeBase64,
  parseCapabilities,
  renderParams,
  takeLine,
} from "./wire.ts";

/** Transport-level client failure (connect/timeout/drop/unparseable reply). */
export class SmtpClientError extends Error {
  constructor(
    message: string,
    /** Machine-readable cause: "TIMEOUT" | "CLOSED" | "PROTOCOL" | "TLS". */
    readonly kind: "TIMEOUT" | "CLOSED" | "PROTOCOL" | "TLS",
  ) {
    super(message);
    this.name = "SmtpClientError";
  }
}

/** A session-level command was refused; `.reply` carries code/enhanced/message. */
export class SmtpCommandError extends Error {
  constructor(
    readonly command: string,
    readonly reply: SmtpReply,
  ) {
    super(`${command} failed: ${reply.code} ${reply.message.split("\n")[0] ?? ""}`);
    this.name = "SmtpCommandError";
  }
}

/**
 * Connect to an SMTP server and read its greeting. Rejects with
 * {@link SmtpCommandError} when the greeting is not 220 (e.g. 421 —
 * the reply is attached for transient/permanent classification), or
 * {@link SmtpClientError} on transport failures.
 */
export async function connectSmtp(options: ConnectSmtpOptions): Promise<SmtpClient> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new SmtpClientError(`Connect timeout to ${options.host}:${options.port}`, "TIMEOUT"));
    }, timeoutMs);
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(new SmtpClientError(`Connect failed: ${err.message}`, "CLOSED"));
    };
    const onReady = () => {
      clearTimeout(timer);
      sock.removeListener("error", onError);
      resolve(sock);
    };
    const sock: net.Socket | tls.TLSSocket = options.implicitTls
      ? tls.connect(
          { host: options.host, port: options.port, servername: options.host, ...options.tls },
          onReady,
        )
      : net.connect(options.port, options.host, onReady);
    sock.once("error", onError);
  });
  const session = new Session(socket, options, timeoutMs, options.implicitTls === true);
  const greeting = await session.readReply();
  session.greeting = greeting;
  if (greeting.code !== 220) {
    session.destroy();
    throw new SmtpCommandError("greeting", greeting);
  }
  return session;
}

class Session implements SmtpClient {
  greeting: SmtpReply = { code: 0, message: "", lines: [] };
  secure: boolean;
  capabilities: Map<string, string> = new Map();

  private buf: Buffer = Buffer.alloc(0);
  private parser = new ReplyParser();
  private waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(
    private socket: net.Socket | tls.TLSSocket,
    private readonly options: ConnectSmtpOptions,
    private readonly timeoutMs: number,
    secure: boolean,
  ) {
    this.secure = secure;
    this.attach(socket);
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) =>
      this.failWaiter(new SmtpClientError(`Connection error: ${err.message}`, "CLOSED")),
    );
    socket.on("close", () => {
      this.closed = true;
      this.failWaiter(new SmtpClientError("Connection closed by server", "CLOSED"));
    });
  }

  private detach(socket: net.Socket | tls.TLSSocket): void {
    socket.removeAllListeners("data");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    socket.on("error", () => {});
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    this.drain();
  }

  private drain(): void {
    while (this.waiter) {
      const split = takeLine(this.buf);
      if (split === null) return;
      this.buf = Buffer.from(split.rest);
      let complete: SmtpReply | null;
      try {
        complete = this.parser.feed(split.line.toString("utf8"));
      } catch (err) {
        this.failWaiter(new SmtpClientError((err as Error).message, "PROTOCOL"));
        return;
      }
      if (complete) {
        const w = this.waiter;
        this.waiter = null;
        w.resolve(complete);
      }
    }
  }

  private failWaiter(err: Error): void {
    const w = this.waiter;
    this.waiter = null;
    if (w) w.reject(err);
  }

  /** Await the next full (possibly multiline) reply. */
  readReply(): Promise<SmtpReply> {
    if (this.closed) {
      return Promise.reject(new SmtpClientError("Connection already closed", "CLOSED"));
    }
    if (this.waiter) {
      return Promise.reject(new SmtpClientError("Overlapping readReply", "PROTOCOL"));
    }
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.destroy();
        reject(new SmtpClientError("Timeout waiting for server reply", "TIMEOUT"));
      }, this.timeoutMs);
      this.waiter = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.drain();
    });
  }

  private command(line: string): Promise<SmtpReply> {
    this.socket.write(line + "\r\n");
    return this.readReply();
  }

  async ehlo(name?: string): Promise<SmtpReply> {
    const heloName = name ?? this.options.name ?? (os.hostname() || "localhost");
    let r = await this.command(`EHLO ${heloName}`);
    if (r.code === 500 || r.code === 502) {
      // Ancient server: fall back to HELO (no capabilities).
      r = await this.command(`HELO ${heloName}`);
      if (r.code !== 250) throw new SmtpCommandError("HELO", r);
      this.capabilities = new Map();
      return r;
    }
    if (r.code !== 250) throw new SmtpCommandError("EHLO", r);
    this.capabilities = parseCapabilities(r.lines);
    return r;
  }

  async startTls(opts?: { force?: boolean }): Promise<void> {
    if (this.secure) return;
    if (!this.capabilities.has("STARTTLS") && !opts?.force) {
      throw new SmtpClientError("Server did not advertise STARTTLS", "TLS");
    }
    const r = await this.command("STARTTLS");
    if (r.code !== 220) throw new SmtpCommandError("STARTTLS", r);
    const plain = this.socket;
    this.detach(plain);
    this.buf = Buffer.alloc(0);
    const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.destroy();
        reject(new SmtpClientError("TLS handshake timeout", "TIMEOUT"));
      }, this.timeoutMs);
      const t: tls.TLSSocket = tls.connect(
        { socket: plain, servername: this.options.host, ...this.options.tls },
        () => {
          clearTimeout(timer);
          t.removeListener("error", onError);
          resolve(t);
        },
      );
      const onError = (err: Error) => {
        clearTimeout(timer);
        this.destroy();
        reject(new SmtpClientError(`TLS handshake failed: ${err.message}`, "TLS"));
      };
      t.once("error", onError);
    });
    this.socket = upgraded;
    this.secure = true;
    this.attach(upgraded);
    // RFC 3207: capabilities must be re-learned after the handshake.
    await this.ehlo();
  }

  async auth(credentials: {
    username: string;
    password: string;
    mechanism?: "PLAIN" | "LOGIN";
  }): Promise<SmtpReply> {
    const advertised = (this.capabilities.get("AUTH") ?? "").toUpperCase().split(/\s+/);
    const mechanism =
      credentials.mechanism ?? (advertised.includes("PLAIN") || !advertised.includes("LOGIN") ? "PLAIN" : "LOGIN");
    if (mechanism === "PLAIN") {
      const payload = encodeBase64(`\0${credentials.username}\0${credentials.password}`);
      const r = await this.command(`AUTH PLAIN ${payload}`);
      if (r.code !== 235) throw new SmtpCommandError("AUTH PLAIN", r);
      return r;
    }
    let r = await this.command("AUTH LOGIN");
    if (r.code !== 334) throw new SmtpCommandError("AUTH LOGIN", r);
    r = await this.command(encodeBase64(credentials.username));
    if (r.code !== 334) throw new SmtpCommandError("AUTH LOGIN username", r);
    r = await this.command(encodeBase64(credentials.password));
    if (r.code !== 235) throw new SmtpCommandError("AUTH LOGIN password", r);
    return r;
  }

  async send(options: SmtpSendOptions): Promise<SmtpSendResult> {
    const params = options.mailParams ? " " + renderParams(options.mailParams) : "";
    const from = options.mailFrom.trim() === "" ? "<>" : bracket(options.mailFrom);
    const mailReply = await this.command(`MAIL FROM:${from}${params.trimEnd()}`);
    const result: SmtpSendResult = { accepted: false, mailFrom: mailReply, rcptTo: [] };
    if (mailReply.code < 200 || mailReply.code >= 300) return result;

    let anyAccepted = false;
    for (const rcpt of options.rcptTo) {
      const r = await this.command(`RCPT TO:${bracket(rcpt)}`);
      const accepted = r.code >= 200 && r.code < 300;
      anyAccepted ||= accepted;
      result.rcptTo.push({ address: rcpt, reply: r, accepted });
    }
    if (!anyAccepted) {
      // Nothing to send; clear the transaction so the session stays usable.
      try {
        await this.command("RSET");
      } catch {
        // Connection-level failure on cleanup is not a send failure.
      }
      return result;
    }

    const dataReply = await this.command("DATA");
    result.data = dataReply;
    if (dataReply.code !== 354) return result;

    const bytes =
      typeof options.data === "string" ? Buffer.from(options.data, "utf8") : options.data;
    this.socket.write(dotStuff(bytes));
    this.socket.write(".\r\n");
    const final = await this.readReply();
    result.data = final;
    result.accepted = final.code >= 200 && final.code < 300;
    return result;
  }

  async quit(): Promise<void> {
    if (this.closed) return;
    try {
      await this.command("QUIT");
    } catch {
      // Server hung up first or refused; either way we are done.
    }
    this.destroy();
  }

  close(): void {
    this.destroy();
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }
}
