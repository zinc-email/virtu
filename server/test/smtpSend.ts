/**
 * Deliberately tiny raw-socket SMTP submit helper — just enough for a
 * persona to hand a message to their home MTA on the simulated internet:
 * EHLO, optional STARTTLS, MAIL FROM, RCPT TO, DATA with dot-stuffing.
 *
 * NOTE(lane-a): placeholder transport. Lane A's real SMTP client replaces
 * this at integration time; nothing outside server/test/ may import it.
 */

import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

export interface SmtpReply {
  code: number;
  lines: string[];
}

export interface SmtpSendOptions {
  host: string;
  port?: number;
  /** Envelope MAIL FROM (bare addr-spec). */
  from: string;
  /** Envelope RCPT TO recipient(s). */
  to: string | string[];
  /** Full RFC 5322 message; any line endings, normalized to CRLF on the wire. */
  data: string;
  /**
   * "never" (default): plaintext — every fake peer accepts it.
   * "require": fail unless the peer offers STARTTLS and the upgrade succeeds.
   * "auto": upgrade when offered, else continue in plaintext.
   */
  starttls?: "never" | "auto" | "require";
  heloName?: string;
  timeoutMs?: number;
  /** PEM CA for STARTTLS verification; defaults to the vendored test CA. */
  ca?: string;
}

const TEST_CA_URL = new URL("../docker/test/mkcert/rootCA.pem", import.meta.url);

/** Reads SMTP replies (incl. multiline) off a socket, one at a time. */
function replyReader(deadline: number) {
  let socket: Socket;
  let buf = "";
  const ready: SmtpReply[] = [];
  let waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | undefined;
  let dead: Error | undefined;

  const fail = (err: Error) => {
    dead ??= err;
    waiter?.reject(err);
    waiter = undefined;
  };
  const drain = () => {
    let m: RegExpMatchArray | null;
    // A reply ends at the first "NNN<SP>" (or bare "NNN") final line.
    while ((m = buf.match(/^([2-5]\d\d)(?: ([^\r\n]*))?\r?\n/m))) {
      const end = (m.index ?? 0) + m[0].length;
      const lines = buf
        .slice(0, end)
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.slice(4));
      ready.push({ code: Number(m[1]), lines });
      buf = buf.slice(end);
    }
    if (waiter && ready.length) {
      const w = waiter;
      waiter = undefined;
      w.resolve(ready.shift()!);
    }
  };

  return {
    /** (Re)attach after STARTTLS upgrades the socket. */
    attach(s: Socket) {
      socket = s;
      s.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        drain();
      });
      s.on("error", (err: Error) => fail(err));
      s.on("close", () => fail(new Error("SMTP connection closed")));
    },
    read(): Promise<SmtpReply> {
      if (ready.length) return Promise.resolve(ready.shift()!);
      if (dead) return Promise.reject(dead);
      return new Promise((resolve, reject) => {
        const ms = deadline - Date.now();
        const t = setTimeout(() => fail(new Error("SMTP reply timeout")), Math.max(ms, 1));
        waiter = {
          resolve: (r) => (clearTimeout(t), resolve(r)),
          reject: (e) => (clearTimeout(t), reject(e)),
        };
      });
    },
    write(s: string) {
      socket.write(s, "latin1");
    },
  };
}

function dial(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    const t = setTimeout(() => {
      s.destroy();
      reject(new Error(`Connect timeout: ${host}:${port}`));
    }, timeoutMs);
    s.once("connect", () => (clearTimeout(t), resolve(s)));
    s.once("error", (e) => (clearTimeout(t), reject(e)));
  });
}

export async function smtpSend(opts: SmtpSendOptions): Promise<void> {
  const port = opts.port ?? 587;
  const starttls = opts.starttls ?? "never";
  const helo = opts.heloName ?? "test-runner.internal";
  const rcpts = Array.isArray(opts.to) ? opts.to : [opts.to];
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);

  let socket = await dial(opts.host, port, deadline - Date.now());
  const wire = replyReader(deadline);
  wire.attach(socket);

  const expect = async (want: number, about: string): Promise<SmtpReply> => {
    const reply = await wire.read();
    if (reply.code !== want) {
      socket.destroy();
      throw new Error(`${about}: expected ${want}, got ${reply.code} ${reply.lines.join(" / ")}`);
    }
    return reply;
  };
  const command = (line: string, want: number): Promise<SmtpReply> => {
    wire.write(line + "\r\n");
    return expect(want, line.split(" ")[0] ?? line);
  };

  await expect(220, "greeting");
  let caps = await command(`EHLO ${helo}`, 250);

  if (starttls !== "never") {
    const offered = caps.lines.some((l) => l.toUpperCase().startsWith("STARTTLS"));
    if (!offered && starttls === "require") {
      socket.destroy();
      throw new Error(`${opts.host}:${port} does not offer STARTTLS`);
    }
    if (offered) {
      await command("STARTTLS", 220);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      const ca = opts.ca ?? (await Bun.file(TEST_CA_URL).text());
      socket = tlsConnect({ socket, servername: opts.host, ca });
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      wire.attach(socket);
      caps = await command(`EHLO ${helo}`, 250);
    }
  }

  await command(`MAIL FROM:<${opts.from}>`, 250);
  for (const rcpt of rcpts) await command(`RCPT TO:<${rcpt}>`, 250);
  await command("DATA", 354);

  let payload = opts.data.replace(/\r?\n/g, "\r\n");
  if (!payload.endsWith("\r\n")) payload += "\r\n";
  payload = payload.replace(/(^|\r\n)\./g, "$1.."); // dot-stuffing (RFC 5321 §4.5.2)
  wire.write(payload + ".\r\n");
  await expect(250, "end-of-data");

  wire.write("QUIT\r\n");
  socket.end();
}

/** Poll until a TCP port accepts connections (peers may still be booting). */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const s = await dial(host, port, 2_000);
      s.destroy();
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${host}:${port}: ${err}`);
      }
      await Bun.sleep(250);
    }
  }
}
