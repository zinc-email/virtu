/**
 * Byte-faithful RFC 5322 header-block handling.
 *
 * Scope (per PLAN Lane C): headers only. The message body stays opaque bytes —
 * there is deliberately NO MIME parsing here. The parser splits a raw message
 * into an ordered list of header fields plus the body bytes, preserving the
 * original bytes (including folding and line endings) of every field it did
 * not modify, so an untouched message round-trips byte-for-byte.
 *
 * Pragmatic, not a full ABNF engine: address-list parsing is sufficient for
 * From/To/Cc rewriting (quoted display names, angle-addr, comma-separated
 * lists, group syntax tolerated by flattening) and never corrupts a header it
 * didn't modify. UTF-8 header values (RFC 6532) pass through unharmed.
 */

const CR = 0x0d;
const LF = 0x0a;
const COLON = 0x3a;
const SP = 0x20;
const HTAB = 0x09;

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

/** A single header field. */
export interface HeaderField {
  /**
   * Field name exactly as it appeared in the message (e.g. `"Message-ID"`),
   * or as given at insertion time. Lookups are case-insensitive.
   */
  name: string;
  /**
   * Field body as decoded UTF-8, folding preserved. For parsed fields this is
   * every byte after the colon up to (but excluding) the final line break —
   * including any leading space and internal CRLF+WSP folds. For fields
   * created through {@link HeaderBlock.replace}/append/prepend it is the
   * clean, single-line value (the serializer re-folds it).
   */
  rawValue: string;
  /**
   * Exact original bytes of the whole field — name, colon, body, folding and
   * terminating line break. Present only on parsed, untouched fields; the
   * serializer emits these verbatim to guarantee byte fidelity. Synthesized
   * or replaced fields have no `raw` and are re-serialized canonically.
   */
  raw?: Uint8Array;
}

/** A parsed email address (mailbox). */
export interface Address {
  /** Display name, unquoted/unescaped. Absent when the mailbox had none. */
  name?: string;
  /** The addr-spec, e.g. `milton@initech.com`. */
  address: string;
}

/** Strip header folding: removes CRLF/LF line breaks that precede WSP. */
export function unfoldValue(value: string): string {
  return value.replace(/\r?\n([ \t])/g, "$1");
}

/**
 * Guard against header injection: collapse any line-break sequence in a
 * caller-supplied header value into a single space.
 */
function sanitizeValue(value: string): string {
  return value.replace(/[\r\n]+[ \t]*/g, " ").trim();
}

/** Case-insensitive header-name equality. */
function nameEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Fold a generated header line at whitespace so lines stay <= 78 chars where
 * possible (RFC 5322 recommendation). Words longer than the limit are left
 * intact — correctness over aesthetics; the 998 hard limit is not enforced.
 * Returns the full field text terminated with CRLF.
 */
function foldGeneratedField(name: string, value: string): string {
  const first = `${name}: ${value}`;
  if (first.length <= 78 || !/\s/.test(value)) {
    return `${first}\r\n`;
  }
  const words = value.split(" ");
  let out = `${name}:`;
  let lineLen = out.length;
  let firstWord = true;
  for (const word of words) {
    if (word === "") continue;
    if (!firstWord && lineLen + 1 + word.length > 78) {
      out += "\r\n";
      out += ` ${word}`;
      lineLen = 1 + word.length;
    } else {
      out += ` ${word}`;
      lineLen += 1 + word.length;
    }
    firstWord = false;
  }
  return `${out}\r\n`;
}

/**
 * Ordered list of header fields with case-insensitive helpers and a
 * byte-faithful serializer. `fields` is a plain mutable array — advanced
 * callers (e.g. prepending Authentication-Results blocks) may splice it
 * directly; the helpers below cover the common operations.
 */
export class HeaderBlock {
  /** Ordered header fields, top of message first. */
  readonly fields: HeaderField[];
  /**
   * Exact bytes of the blank line separating headers from body (usually
   * `\r\n`, sometimes `\n`, empty when the message had no body separator).
   * Preserved so {@link serializeMessage} round-trips untouched messages.
   */
  separator: Uint8Array;

  constructor(fields: HeaderField[] = [], separator: Uint8Array = new Uint8Array(0)) {
    this.fields = fields;
    this.separator = separator;
  }

  /** Deep-ish copy: field objects are copied, raw byte arrays are shared. */
  clone(): HeaderBlock {
    return new HeaderBlock(
      this.fields.map((f) => ({ ...f })),
      this.separator,
    );
  }

  /** First field with the given name (case-insensitive), or undefined. */
  getField(name: string): HeaderField | undefined {
    return this.fields.find((f) => nameEquals(f.name, name));
  }

  /** All fields with the given name, in order. */
  getFields(name: string): HeaderField[] {
    return this.fields.filter((f) => nameEquals(f.name, name));
  }

  /** Unfolded, trimmed value of the first matching field, or undefined. */
  get(name: string): string | undefined {
    const f = this.getField(name);
    return f === undefined ? undefined : unfoldValue(f.rawValue).trim();
  }

  /** Unfolded, trimmed values of all matching fields, in order. */
  getAll(name: string): string[] {
    return this.getFields(name).map((f) => unfoldValue(f.rawValue).trim());
  }

  /** True when at least one field with this name exists. */
  has(name: string): boolean {
    return this.getField(name) !== undefined;
  }

  /** Remove every field with this name. Returns the number removed. */
  remove(name: string): number {
    let removed = 0;
    for (let i = this.fields.length - 1; i >= 0; i--) {
      if (nameEquals(this.fields[i]!.name, name)) {
        this.fields.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Replace the first field with this name in place (keeping its position),
   * removing any duplicates; appends when the field does not exist.
   */
  replace(name: string, value: string): void {
    const idx = this.fields.findIndex((f) => nameEquals(f.name, name));
    const field: HeaderField = { name, rawValue: sanitizeValue(value) };
    if (idx === -1) {
      this.fields.push(field);
      return;
    }
    this.fields[idx] = field;
    for (let i = this.fields.length - 1; i > idx; i--) {
      if (nameEquals(this.fields[i]!.name, name)) {
        this.fields.splice(i, 1);
      }
    }
  }

  /** Append a new field at the bottom of the block. */
  append(name: string, value: string): void {
    this.fields.push({ name, rawValue: sanitizeValue(value) });
  }

  /** Prepend a new field at the top of the block. */
  prepend(name: string, value: string): void {
    this.fields.unshift({ name, rawValue: sanitizeValue(value) });
  }

  /**
   * Serialize the header block (headers only, no separator/body). Untouched
   * fields are emitted from their original bytes verbatim; modified or
   * synthesized fields are emitted as `Name: value` with CRLF endings and
   * folding at whitespace.
   */
  serialize(): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const f of this.fields) {
      if (f.raw !== undefined) {
        chunks.push(f.raw);
      } else {
        chunks.push(encoder.encode(foldGeneratedField(f.name, f.rawValue)));
      }
    }
    return concatBytes(chunks);
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Result of {@link parseMessage}: parsed headers plus the opaque body bytes. */
export interface ParsedMessage {
  headers: HeaderBlock;
  /** Message body, untouched bytes (may be empty). */
  body: Uint8Array;
}

/**
 * Split raw message bytes into a header block and opaque body. Accepts CRLF
 * and bare-LF line endings (both preserved byte-exactly in `raw`). A line
 * with no colon and no leading WSP is kept as an opaque field (name = whole
 * line, empty value) so it still round-trips.
 */
export function parseMessage(raw: Uint8Array): ParsedMessage {
  const fields: HeaderField[] = [];
  let separator: Uint8Array = new Uint8Array(0);
  let body: Uint8Array = new Uint8Array(0);

  let pos = 0;
  let fieldStart = -1; // start offset of the field currently being collected

  const finishField = (end: number): void => {
    if (fieldStart === -1) return;
    const bytes = raw.subarray(fieldStart, end);
    fields.push(bytesToField(bytes));
    fieldStart = -1;
  };

  while (pos < raw.length) {
    // find end of line
    let eol = pos;
    while (eol < raw.length && raw[eol] !== LF) eol++;
    const lineEnd = eol < raw.length ? eol + 1 : raw.length; // include LF
    // content length without line break
    let contentEnd = eol;
    if (contentEnd > pos && raw[contentEnd - 1] === CR) contentEnd--;

    const isBlank = contentEnd === pos;
    if (isBlank) {
      finishField(pos);
      separator = raw.subarray(pos, lineEnd);
      body = raw.subarray(lineEnd);
      return new ParsedMessageImpl(fields, separator, body);
    }

    const first = raw[pos];
    const isContinuation = first === SP || first === HTAB;
    if (isContinuation && fieldStart !== -1) {
      // folding: keep collecting into the current field
    } else {
      finishField(pos);
      fieldStart = pos;
    }
    pos = lineEnd;
  }
  finishField(raw.length);
  return new ParsedMessageImpl(fields, separator, body);
}

/** Internal: plain object implementing ParsedMessage. */
class ParsedMessageImpl implements ParsedMessage {
  headers: HeaderBlock;
  body: Uint8Array;
  constructor(fields: HeaderField[], separator: Uint8Array, body: Uint8Array) {
    this.headers = new HeaderBlock(fields, separator);
    this.body = body;
  }
}

/** Parse one collected field (all its lines, incl. line breaks) into a HeaderField. */
function bytesToField(bytes: Uint8Array): HeaderField {
  // find colon on the first line only
  let colon = -1;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === COLON) {
      colon = i;
      break;
    }
    if (b === LF) break;
  }
  if (colon === -1) {
    // opaque garbage line: round-trips via raw, never matches lookups
    return { name: decoder.decode(trimLineBreak(bytes)), rawValue: "", raw: bytes };
  }
  const name = decoder.decode(bytes.subarray(0, colon));
  const valueBytes = trimLineBreak(bytes.subarray(colon + 1));
  return { name, rawValue: decoder.decode(valueBytes), raw: bytes };
}

/** Strip a single trailing CRLF or LF. */
function trimLineBreak(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === LF) end--;
  if (end > 0 && bytes[end - 1] === CR) end--;
  return bytes.subarray(0, end);
}

/**
 * Serialize headers + separator + body back into full message bytes. When the
 * block has no recorded separator but a body is present (e.g. after heavy
 * rewriting), a canonical CRLF blank line is inserted.
 */
export function serializeMessage(headers: HeaderBlock, body: Uint8Array): Uint8Array {
  const head = headers.serialize();
  let sep = headers.separator;
  if (sep.length === 0 && body.length > 0) sep = encoder.encode("\r\n");
  return concatBytes([head, sep, body]);
}

// ---------------------------------------------------------------------------
// Address-list parsing / formatting (pragmatic subset of RFC 5322 §3.4)
// ---------------------------------------------------------------------------

/**
 * Parse a (previously unfolded) address-list header value into mailboxes.
 *
 * Handles: comma-separated lists, `display <addr>` angle-addr, quoted display
 * names containing commas, backslash escapes, comments `(...)` (dropped),
 * group syntax (`Team: a@x, b@y;` — flattened to its members; the group name
 * is discarded, so `undisclosed-recipients:;` yields an empty list), and raw
 * UTF-8 anywhere (RFC 6532). RFC 2047 encoded-words are NOT decoded — they
 * pass through as opaque display-name text.
 */
export function parseAddressList(value: string): Address[] {
  const items: string[] = [];
  let cur = "";
  let inQuote = false;
  let commentDepth = 0;
  let inAngle = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (inQuote) {
      cur += ch;
      if (ch === "\\" && i + 1 < value.length) {
        cur += value[i + 1];
        i++;
      } else if (ch === '"') {
        inQuote = false;
      }
      continue;
    }
    if (commentDepth > 0) {
      if (ch === "\\") i++;
      else if (ch === "(") commentDepth++;
      else if (ch === ")") commentDepth--;
      continue; // comments are dropped
    }
    switch (ch) {
      case '"':
        inQuote = true;
        cur += ch;
        break;
      case "(":
        commentDepth++;
        break;
      case "<":
        inAngle = true;
        cur += ch;
        break;
      case ">":
        inAngle = false;
        cur += ch;
        break;
      case ",":
        if (inAngle) cur += ch;
        else {
          items.push(cur);
          cur = "";
        }
        break;
      case ":":
        // group start (display-name ":" ...) — discard the group name.
        // Heuristic: only outside angle brackets and before any addr chars.
        if (!inAngle && !cur.includes("<") && !cur.includes("@")) cur = "";
        else cur += ch;
        break;
      case ";":
        if (inAngle) cur += ch;
        else {
          items.push(cur);
          cur = "";
        }
        break;
      default:
        cur += ch;
    }
  }
  items.push(cur);

  const out: Address[] = [];
  for (const item of items) {
    const parsed = parseMailbox(item);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** Parse a single mailbox (one comma-separated item). Returns null for empty items. */
function parseMailbox(item: string): Address | null {
  const s = item.trim();
  if (s === "") return null;

  // locate a top-level angle-addr (quote-aware)
  let lt = -1;
  let gt = -1;
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === "\\") i++;
      else if (ch === '"') q = false;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === "<" && lt === -1) lt = i;
    else if (ch === ">" && lt !== -1 && gt === -1) gt = i;
  }

  if (lt !== -1 && gt !== -1 && gt > lt) {
    let address = s.slice(lt + 1, gt).trim();
    // tolerate obsolete route syntax: <@relay1,@relay2:user@dom>
    if (address.startsWith("@")) {
      const routeEnd = address.indexOf(":");
      if (routeEnd !== -1) address = address.slice(routeEnd + 1).trim();
    }
    const name = decodeDisplayName(s.slice(0, lt).trim());
    if (address === "") return null;
    return name === "" ? { address } : { name, address };
  }

  // bare addr-spec
  return { address: s };
}

/** Unquote/unescape a display-name token; collapse internal whitespace. */
function decodeDisplayName(text: string): string {
  const t = text.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  }
  return t.replace(/\s+/g, " ");
}

/**
 * Characters in a display name that force quoting (mirrors Python
 * `email.utils.formataddr` specials).
 */
const DISPLAY_NAME_SPECIALS = /[()<>@,:;\\".[\]]/;

/**
 * Format one mailbox for a structured header. Bare address when there is no
 * display name; otherwise `Name <addr>` with the name quoted (and `"`/`\`
 * escaped) when it contains specials. Non-ASCII names are emitted as raw
 * UTF-8 (RFC 6532) — no RFC 2047 encoding is performed here.
 */
export function formatAddress(addr: Address): string {
  const name = addr.name?.trim();
  if (name === undefined || name === "") return addr.address;
  if (DISPLAY_NAME_SPECIALS.test(name)) {
    const escaped = name.replace(/([\\"])/g, "\\$1");
    return `"${escaped}" <${addr.address}>`;
  }
  return `${name} <${addr.address}>`;
}

/** Format a list of mailboxes as a comma-separated address-list value. */
export function formatAddressList(addrs: Address[]): string {
  return addrs.map(formatAddress).join(", ");
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Format a Date as an RFC 5322 date-time header value (always UTC, `+0000`). */
export function formatDateHeader(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${DAY_NAMES[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
    `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}
