/**
 * Correct TXT resolution for the mail path.
 *
 * KNOWN BUN BUG workaround: as of Bun 1.3.x, `node:dns` flattens the
 * character-strings of one TXT record into separate records —
 * `[["chunk1"],["chunk2"]]` instead of Node's `[["chunk1","chunk2"]]` — and
 * the two shapes are indistinguishable after the fact. DKIM keys longer
 * than 255 octets (every RSA-2048 key) are split across character-strings,
 * so verification through the builtin API is silently broken ("invalid
 * public key"). This module speaks the DNS wire format itself over TCP
 * (no truncation concerns) against the system-configured nameserver and
 * preserves record grouping.
 *
 * `makeVerifyResolver()` returns a mailauth-shaped resolver that answers
 * TXT queries through this client and everything else via node:dns.
 */

import { promises as dnsPromises, getServers } from "node:dns";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { DnsResolver } from "../mailauth/index.ts";

const TYPE_TXT = 16;
const TYPE_CNAME = 5;
const CLASS_IN = 1;

/** DNS error shaped like node:dns errors (mailauth branches on `code`). */
export class DnsError extends Error {
  code: string;
  constructor(code: string, name: string) {
    super(`query${code === "ENOTFOUND" ? "" : ` ${code}`} TXT ${name}`);
    this.name = "DnsError";
    this.code = code;
  }
}

/** Encode one QNAME (no compression on the request side). */
function encodeName(name: string): Uint8Array {
  const parts = name.replace(/\.$/, "").split(".");
  const bytes: number[] = [];
  for (const part of parts) {
    const label = new TextEncoder().encode(part);
    if (label.length === 0 || label.length > 63) throw new DnsError("EBADNAME", name);
    bytes.push(label.length, ...label);
  }
  bytes.push(0);
  return new Uint8Array(bytes);
}

/** Build a TXT query message (RD set). Exported for tests. */
export function encodeTxtQuery(name: string, id: number): Uint8Array {
  const qname = encodeName(name);
  const msg = new Uint8Array(12 + qname.length + 4);
  const view = new DataView(msg.buffer);
  view.setUint16(0, id);
  view.setUint16(2, 0x0100); // RD
  view.setUint16(4, 1); // QDCOUNT
  msg.set(qname, 12);
  view.setUint16(12 + qname.length, TYPE_TXT);
  view.setUint16(12 + qname.length + 2, CLASS_IN);
  return msg;
}

/** Skip an (optionally compressed) name starting at `offset`; return the offset after it. */
function skipName(msg: Uint8Array, offset: number): number {
  for (;;) {
    if (offset >= msg.length) throw new DnsError("EBADRESP", "truncated name");
    const len = msg[offset]!;
    if (len === 0) return offset + 1;
    if ((len & 0xc0) === 0xc0) return offset + 2; // compression pointer
    offset += 1 + len;
  }
}

/**
 * Parse a DNS response; returns TXT records with their character-strings
 * grouped per record (the whole point). Exported for tests.
 */
export function parseTxtResponse(msg: Uint8Array, expectId: number, name: string): string[][] {
  if (msg.length < 12) throw new DnsError("EBADRESP", name);
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  if (view.getUint16(0) !== expectId) throw new DnsError("EBADRESP", name);
  const flags = view.getUint16(2);
  const rcode = flags & 0xf;
  if (rcode === 3) throw new DnsError("ENOTFOUND", name);
  if (rcode !== 0) throw new DnsError(rcode === 2 ? "ESERVFAIL" : "EBADRESP", name);
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);

  let offset = 12;
  for (let i = 0; i < qdcount; i++) offset = skipName(msg, offset) + 4;

  const records: string[][] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let i = 0; i < ancount; i++) {
    offset = skipName(msg, offset);
    if (offset + 10 > msg.length) throw new DnsError("EBADRESP", name);
    const type = view.getUint16(offset);
    const rdlength = view.getUint16(offset + 8);
    const rdataStart = offset + 10;
    const rdataEnd = rdataStart + rdlength;
    if (rdataEnd > msg.length) throw new DnsError("EBADRESP", name);
    if (type === TYPE_TXT) {
      const chunks: string[] = [];
      let p = rdataStart;
      while (p < rdataEnd) {
        const len = msg[p]!;
        // A character-string must stay within its record's RDATA. A malformed
        // length byte that overruns rdataEnd would otherwise splice adjacent
        // answer bytes into the string — and TXT drives DKIM-key / ownership
        // comparisons, so a corrupted read is a security signal. Reject.
        if (p + 1 + len > rdataEnd) throw new DnsError("EBADRESP", name);
        chunks.push(decoder.decode(msg.subarray(p + 1, p + 1 + len)));
        p += 1 + len;
      }
      records.push(chunks);
    } else if (type !== TYPE_CNAME) {
      // Unexpected type in the answer section: ignore (CNAMEs are chased by
      // the server; their TXT answers arrive in the same section).
    }
    offset = rdataEnd;
  }
  if (records.length === 0) throw new DnsError("ENODATA", name);
  return records;
}

/** One TCP exchange with one server. */
function queryOverTcp(
  server: { host: string; port: number },
  message: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const framed = new Uint8Array(2 + message.length);
    new DataView(framed.buffer).setUint16(0, message.length);
    framed.set(message, 2);

    let buf = new Uint8Array(0);
    let done = false;
    const socket: Socket = connect(server.port, server.host, () => {
      socket.write(framed);
    });
    const finish = (err: Error | null, out?: Uint8Array) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err !== null) reject(err);
      else resolve(out!);
    };
    const timer = setTimeout(() => finish(new DnsError("ETIMEOUT", server.host)), timeoutMs);
    socket.on("error", (err) =>
      finish(new DnsError("ECONNREFUSED", `${server.host}: ${err.message}`)),
    );
    socket.on("close", () => finish(new DnsError("ECONNRESET", server.host)));
    socket.on("data", (chunk: Uint8Array) => {
      const next = new Uint8Array(buf.length + chunk.length);
      next.set(buf);
      next.set(chunk, buf.length);
      buf = next;
      if (buf.length < 2) return;
      const expected = new DataView(buf.buffer, buf.byteOffset).getUint16(0);
      if (buf.length >= 2 + expected) finish(null, buf.subarray(2, 2 + expected));
    });
  });
}

function configuredServers(): { host: string; port: number }[] {
  const servers = getServers();
  const parsed = servers.map((s) => {
    // "1.2.3.4" | "1.2.3.4:53" | "[::1]:53"
    const m = /^\[(.+)\](?::(\d+))?$/.exec(s) ?? /^([^:]+)(?::(\d+))?$/.exec(s);
    return m === null
      ? { host: s, port: 53 }
      : { host: m[1]!, port: m[2] === undefined ? 53 : Number(m[2]) };
  });
  return parsed.length > 0 ? parsed : [{ host: "127.0.0.1", port: 53 }];
}

/** Options for {@link resolveTxt}. */
export interface ResolveTxtOptions {
  /** Override the nameservers (defaults to the system-configured set). */
  servers?: { host: string; port: number }[];
  timeoutMs?: number;
}

/**
 * Resolve TXT records for a name over TCP with correct per-record
 * character-string grouping. Throws {@link DnsError} with node-style codes
 * (ENOTFOUND / ENODATA / ETIMEOUT / ...).
 */
export async function resolveTxt(name: string, opts: ResolveTxtOptions = {}): Promise<string[][]> {
  const servers = opts.servers ?? configuredServers();
  const timeoutMs = opts.timeoutMs ?? 5000;
  let lastError: Error = new DnsError("ENOTFOUND", name);
  for (const server of servers) {
    const id = randomBytes(2).readUInt16BE(0);
    try {
      const response = await queryOverTcp(server, encodeTxtQuery(name, id), timeoutMs);
      return parseTxtResponse(response, id, name);
    } catch (err) {
      // Definitive answers (name/data missing) are not retryable elsewhere.
      const code = (err as DnsError).code;
      if (code === "ENOTFOUND" || code === "ENODATA") throw err;
      lastError = err as Error;
    }
  }
  throw lastError;
}

/**
 * Mailauth-shaped resolver: TXT through the wire-format client above,
 * everything else via node:dns (whose other rrtypes are fine on Bun).
 */
export function makeVerifyResolver(opts: ResolveTxtOptions = {}): DnsResolver {
  return async (name, rrtype) => {
    if (rrtype === "TXT") return resolveTxt(name, opts);
    return dnsPromises.resolve(name, rrtype as never);
  };
}
