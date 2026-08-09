/**
 * Internal wire-format helpers shared by the SMTP server and client:
 * line splitting, DATA decoding (dot-unstuffing + CRLF normalization),
 * reply parsing/formatting, path & parameter parsing, base64.
 *
 * Not part of the public API (import from `./index.ts` instead).
 */
import { Buffer } from "node:buffer";
import type { SmtpParams, SmtpReply } from "./types.ts";

const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

/** Command lines longer than this (content, excluding line break) are refused. */
export const MAX_COMMAND_LINE = 2048;

/**
 * Take one line off the front of `buf`. Splits on LF; strips one trailing CR.
 * Returns null when no complete line is buffered yet.
 */
export function takeLine(buf: Buffer): { line: Buffer; rest: Buffer } | null {
  const lf = buf.indexOf(LF);
  if (lf === -1) return null;
  const end = lf > 0 && buf[lf - 1] === CR ? lf - 1 : lf;
  return { line: buf.subarray(0, end), rest: buf.subarray(lf + 1) };
}

/**
 * Streaming DATA decoder: dot-unstuffing, bare-LF -> CRLF normalization,
 * terminator detection, size + line-length accounting. Once a violation is
 * detected the decoded output is discarded (memory stays bounded) but input
 * is still consumed until the terminator so the connection can recover.
 */
export class DataDecoder {
  private chunks: Buffer[] = [];
  private pending: Buffer = Buffer.alloc(0);
  private pendingOverflow = false;
  private discarding = false;
  /** Normalized message size in bytes (approximate once discarding). */
  size = 0;
  tooBig = false;
  lineTooLong = false;

  constructor(
    private readonly maxSize: number,
    private readonly maxLineLength: number,
  ) {}

  /**
   * Consume a chunk. Returns the bytes that followed the end-of-data
   * terminator (possibly empty) once the terminator is seen, else null.
   */
  push(chunk: Buffer): Buffer | null {
    let buf = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    for (;;) {
      const lf = buf.indexOf(LF);
      if (lf === -1) {
        if (this.pendingOverflow) {
          // Still inside an overlong line: drop the bytes, keep scanning.
          this.size += buf.length;
          return null;
        }
        if (buf.length > this.maxLineLength + 1) {
          // +1 tolerates a trailing CR of a CRLF split across chunks.
          this.lineTooLong = true;
          this.discarding = true;
          this.pendingOverflow = true;
          this.size += buf.length;
          return null;
        }
        this.pending = Buffer.from(buf); // copy: chunk buffers get reused
        return null;
      }
      const end = lf > 0 && buf[lf - 1] === CR ? lf - 1 : lf;
      const content = buf.subarray(0, end);
      buf = buf.subarray(lf + 1);
      if (this.pendingOverflow) {
        // The tail end of an overlong line: swallow it and resync.
        this.pendingOverflow = false;
        this.size += end + 2;
        continue;
      }
      if (content.length === 1 && content[0] === DOT) {
        return buf; // end-of-data terminator; rest is pipelined input
      }
      const line = content[0] === DOT ? content.subarray(1) : content;
      this.size += line.length + 2;
      if (line.length > this.maxLineLength) {
        this.lineTooLong = true;
        this.discarding = true;
      }
      if (this.size > this.maxSize) {
        this.tooBig = true;
        this.discarding = true;
      }
      if (!this.discarding) {
        this.chunks.push(Buffer.from(line), CRLF_BUF);
      } else {
        this.chunks = [];
      }
    }
  }

  /** The normalized message received so far (empty once discarding). */
  message(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const CRLF_BUF = Buffer.from("\r\n");

/**
 * Split a normalized message into its raw header block and body at the first
 * blank line. `headers` keeps the final header line's CRLF; the blank line
 * itself is dropped. No blank line => everything is headers.
 */
export function splitMessage(raw: Buffer): { headers: Buffer; body: Buffer } {
  if (raw.length >= 2 && raw[0] === CR && raw[1] === LF) {
    return { headers: raw.subarray(0, 0), body: raw.subarray(2) };
  }
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) return { headers: raw, body: raw.subarray(raw.length) };
  return { headers: raw.subarray(0, sep + 2), body: raw.subarray(sep + 4) };
}

/**
 * Apply RFC 5321 §4.5.2 transparency for sending: normalize line endings to
 * CRLF, dot-stuff lines starting with ".", and guarantee a trailing CRLF.
 * (The `<CRLF>.<CRLF>` terminator itself is NOT appended here.)
 */
export function dotStuff(data: Uint8Array): Buffer {
  const src = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const out: Buffer[] = [];
  let rest: Buffer = src;
  for (;;) {
    const lf = rest.indexOf(LF);
    const lineEnd = lf === -1 ? rest.length : lf;
    const end = lineEnd > 0 && rest[lineEnd - 1] === CR ? lineEnd - 1 : lineEnd;
    const content = rest.subarray(0, end);
    if (lf === -1 && content.length === 0) break;
    if (content[0] === DOT) out.push(DOT_BUF);
    out.push(content, CRLF_BUF);
    if (lf === -1) break;
    rest = rest.subarray(lf + 1);
    if (rest.length === 0) break;
  }
  return Buffer.concat(out);
}

const DOT_BUF = Buffer.from(".");

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

/** Format a (possibly multiline) reply: `250-line1\r\n250 line2\r\n`. */
export function formatReply(code: number, lines: string[]): string {
  const all = lines.length > 0 ? lines : [""];
  return all
    .map((text, i) =>
      i === all.length - 1 ? `${code}${text ? " " + text : ""}\r\n` : `${code}-${text}\r\n`,
    )
    .join("");
}

/** Format a single-line reply with an optional enhanced status code. */
export function reply(code: number, enhanced: string | undefined, text: string): string {
  return `${code} ${enhanced ? enhanced + " " : ""}${text}\r\n`;
}

const REPLY_LINE = /^(\d{3})([ -])?(.*)$/s;
const ENHANCED = /^([245])\.\d{1,3}\.\d{1,3}(?=\s|$)/;

/**
 * Incremental reply parser for the client: feed complete lines (sans CRLF),
 * get the full SmtpReply once the final line arrives.
 */
export class ReplyParser {
  private lines: string[] = [];

  /** Returns the completed reply, or null if more lines are needed. */
  feed(rawLine: string): SmtpReply | null {
    const m = REPLY_LINE.exec(rawLine);
    if (!m) throw new Error(`Unparseable SMTP reply line: ${JSON.stringify(rawLine)}`);
    const code = Number(m[1]);
    const text = m[3] ?? "";
    this.lines.push(text);
    if (m[2] === "-") return null;
    const lines = this.lines;
    this.lines = [];
    let enhancedCode: string | undefined;
    const em = ENHANCED.exec(lines[0] ?? "");
    if (em && Number(em[1]) === Math.floor(code / 100)) enhancedCode = em[0];
    return { code, enhancedCode, message: lines.join("\n"), lines };
  }
}

/** Parse EHLO reply lines (excluding the first greeting line) into a capability map. */
export function parseCapabilities(lines: string[]): Map<string, string> {
  const caps = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const sp = line.indexOf(" ");
    const keyword = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    if (!keyword) continue;
    caps.set(keyword, sp === -1 ? "" : line.slice(sp + 1).trim());
  }
  return caps;
}

// ---------------------------------------------------------------------------
// Paths and parameters
// ---------------------------------------------------------------------------

/**
 * Parse the argument of `MAIL FROM:` / `RCPT TO:` — an angle-bracketed path
 * followed by optional esmtp parameters. Tolerates space after the colon and
 * (for sloppy clients) a bare address without brackets. Strips RFC 5321
 * source routes (`<@relay1,@relay2:user@dom>` -> `user@dom`).
 * Returns null on syntax errors.
 */
export function parsePath(arg: string): { address: string; paramString: string } | null {
  let s = arg.trimStart();
  if (s.startsWith("<")) {
    // Find the closing ">" respecting quoted local parts and backslash escapes.
    let inQuote = false;
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === "\\") {
        i++;
      } else if (c === '"') {
        inQuote = !inQuote;
      } else if (c === ">" && !inQuote) {
        let address = s.slice(1, i);
        const paramString = s.slice(i + 1).trim();
        if (address.startsWith("@")) {
          const colon = address.indexOf(":");
          if (colon === -1) return null;
          address = address.slice(colon + 1);
        }
        return { address, paramString };
      }
    }
    return null; // unterminated
  }
  // No angle brackets: take up to the first space as the address.
  if (s.length === 0) return null;
  const sp = s.indexOf(" ");
  if (sp === -1) return { address: s, paramString: "" };
  return { address: s.slice(0, sp), paramString: s.slice(sp + 1).trim() };
}

/** Parse `KEY=value KEY2` esmtp parameters. Keys are uppercased. Null on syntax errors. */
export function parseParams(paramString: string): SmtpParams | null {
  const params: SmtpParams = {};
  for (const word of paramString.split(/\s+/)) {
    if (!word) continue;
    const eq = word.indexOf("=");
    if (eq === 0) return null;
    if (eq === -1) params[word.toUpperCase()] = true;
    else params[word.slice(0, eq).toUpperCase()] = word.slice(eq + 1);
  }
  return params;
}

/** Render esmtp params for the wire: `KEY=value` / bare `KEY`. */
export function renderParams(params: SmtpParams): string {
  return Object.entries(params)
    .map(([k, v]) => (v === true ? k : `${k}=${v}`))
    .join(" ");
}

/** Wrap an address in angle brackets unless already wrapped. "" stays "<>". */
export function bracket(address: string): string {
  const a = address.trim();
  if (a.startsWith("<") && a.endsWith(">")) return a;
  return `<${a}>`;
}

// ---------------------------------------------------------------------------
// Base64 (strict enough for SASL)
// ---------------------------------------------------------------------------

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode SASL base64; null when the input is not valid base64. */
export function decodeBase64(s: string): Buffer | null {
  const t = s.trim();
  if (t.length % 4 !== 0 || !B64.test(t)) return null;
  return Buffer.from(t, "base64");
}

/** Encode SASL base64. */
export function encodeBase64(data: string | Buffer): string {
  return (typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64");
}
