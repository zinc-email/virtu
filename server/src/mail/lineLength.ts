/**
 * RFC 5321 §4.5.3.1.6: a line of message content is at most 998 octets
 * before its CRLF. The MX accepts longer lines (to 10 000, `maxDataLineLength`)
 * because refusing them loses real mail; but forwarding them verbatim loses
 * it too, later and worse: a receiver that folds or truncates changes the
 * bytes the DKIM body hash was computed over, so the forward fails DMARC
 * at the alias owner's provider, and one that rejects with 5.6.0 makes
 * the forward a permanent failure. Either was targetable by anyone who
 * could send a long line to an alias.
 *
 * Postfix breaks long lines on output (`smtp_line_length_limit`, "breaking
 * line > 998 bytes with <CR><LF>SPACE"). We do the same, and do it BEFORE
 * signing, so the signature covers exactly the bytes on the wire — the
 * same ordering rule as the bare-CR normalization in the DATA decoder.
 *
 * Where to break: at the last whitespace before the limit whenever the
 * remainder still has content (that is a legal header fold, and in a body
 * it moves a space to the next line and nothing else); otherwise at the
 * limit with CRLF+SPACE, backed off to a UTF-8 character boundary.
 */

/** RFC 5321 line length limit, octets before the CRLF. */
export const MAX_LINE_OCTETS = 998;

const LF = 0x0a;
const CR = 0x0d;
const SP = 0x20;
const HTAB = 0x09;
const CRLF = new Uint8Array([CR, LF]);
const CRLF_SP = new Uint8Array([CR, LF, SP]);

function isWsp(b: number | undefined): boolean {
  return b === SP || b === HTAB;
}

/** Break the octets of one over-long line into pieces that each fit `limit`. */
function foldLine(content: Uint8Array, limit: number, out: Uint8Array[]): void {
  let rest = content;
  // After a hard break the continuation line already starts with the
  // inserted space, which counts toward its length.
  let spaceEmitted = false;
  for (;;) {
    const room = spaceEmitted ? limit - 1 : limit;
    if (rest.length <= room) {
      out.push(rest);
      return;
    }
    let lastContent = rest.length - 1;
    while (lastContent >= 0 && isWsp(rest[lastContent])) lastContent--;
    let cut = -1;
    for (let i = Math.min(room, lastContent - 1); i >= 1; i--) {
      if (isWsp(rest[i])) {
        cut = i;
        break;
      }
    }
    if (cut !== -1) {
      out.push(rest.subarray(0, cut), CRLF);
      rest = rest.subarray(cut);
      spaceEmitted = false;
      continue;
    }
    // No usable whitespace: hard break, not inside a multi-byte character.
    let hard = room;
    while (hard > 1 && (rest[hard]! & 0xc0) === 0x80) hard--;
    out.push(rest.subarray(0, hard), CRLF_SP);
    rest = rest.subarray(hard);
    spaceEmitted = true;
  }
}

/**
 * Fold every line longer than `limit` octets (excluding its line ending).
 * Lines within the limit are copied byte for byte, line endings included.
 */
export function foldLongLines(message: Uint8Array, limit = MAX_LINE_OCTETS): Uint8Array {
  let start = 0;
  let needsFold = false;
  for (;;) {
    let lf = message.indexOf(LF, start);
    if (lf === -1) lf = message.length;
    let end = lf;
    if (end > start && message[end - 1] === CR) end--;
    if (end - start > limit) {
      needsFold = true;
      break;
    }
    if (lf >= message.length) break;
    start = lf + 1;
  }
  if (!needsFold) return message;

  const out: Uint8Array[] = [];
  start = 0;
  for (;;) {
    let lf = message.indexOf(LF, start);
    const atEnd = lf === -1;
    if (atEnd) lf = message.length;
    let end = lf;
    if (end > start && message[end - 1] === CR) end--;
    if (end - start > limit) {
      foldLine(message.subarray(start, end), limit, out);
      out.push(message.subarray(end, atEnd ? lf : lf + 1));
    } else {
      out.push(message.subarray(start, atEnd ? lf : lf + 1));
    }
    if (atEnd) break;
    start = lf + 1;
  }
  let total = 0;
  for (const c of out) total += c.length;
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of out) {
    joined.set(c, offset);
    offset += c.length;
  }
  return joined;
}
