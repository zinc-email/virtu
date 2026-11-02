export const MAX_LINE_OCTETS = 998;
const LF = 0x0a;
const CR = 0x0d;

/** Reject overlong content without rewriting MIME bodies or signed bytes. */
export function assertLineLengths(message: Uint8Array, limit = MAX_LINE_OCTETS): void {
  let start = 0;
  for (let i = 0; i <= message.length; i++) {
    if (i !== message.length && message[i] !== LF) continue;
    const end = i > start && message[i - 1] === CR ? i - 1 : i;
    if (end - start > limit) throw new Error(`Message line exceeds ${limit} octets`);
    start = i + 1;
  }
}
