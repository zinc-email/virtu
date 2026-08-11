/**
 * DNS wire-format TXT parsing — the Bun-workaround resolver's pure core.
 * The load-bearing property: character-strings of ONE record stay grouped,
 * distinct records stay separate (exactly what Bun's builtin API loses).
 */

import { describe, expect, test } from "bun:test";
import { DnsError, encodeTxtQuery, parseTxtResponse } from "./dnsTxt.ts";

/** Build a response for the given query with hand-rolled answer records. */
function buildResponse(
  query: Uint8Array,
  answers: { chunks: string[] }[],
  { rcode = 0, id }: { rcode?: number; id?: number } = {},
): Uint8Array {
  const encoder = new TextEncoder();
  const answerBytes: number[] = [];
  for (const answer of answers) {
    // Owner name via compression pointer to the question name at offset 12.
    answerBytes.push(0xc0, 12);
    answerBytes.push(0, 16, 0, 1, 0, 0, 0, 60); // TYPE TXT, CLASS IN, TTL 60
    const rdata: number[] = [];
    for (const chunk of answer.chunks) {
      const bytes = encoder.encode(chunk);
      rdata.push(bytes.length, ...bytes);
    }
    answerBytes.push((rdata.length >> 8) & 0xff, rdata.length & 0xff, ...rdata);
  }

  const out = new Uint8Array(query.length + answerBytes.length);
  out.set(query);
  out.set(new Uint8Array(answerBytes), query.length);
  const view = new DataView(out.buffer);
  if (id !== undefined) view.setUint16(0, id);
  view.setUint16(2, 0x8180 | rcode); // QR + RD + RA + rcode
  view.setUint16(6, answers.length); // ANCOUNT
  return out;
}

const NAME = "mail._domainkey.virtu.email";

describe("parseTxtResponse", () => {
  test("one record with two character-strings stays ONE grouped record", () => {
    const query = encodeTxtQuery(NAME, 42);
    const response = buildResponse(query, [{ chunks: ["v=DKIM1; k=rsa; ", "p=AAAA"] }]);
    expect(parseTxtResponse(response, 42, NAME)).toEqual([["v=DKIM1; k=rsa; ", "p=AAAA"]]);
  });

  test("two records stay two records", () => {
    const query = encodeTxtQuery(NAME, 7);
    const response = buildResponse(query, [{ chunks: ["first"] }, { chunks: ["second"] }]);
    expect(parseTxtResponse(response, 7, NAME)).toEqual([["first"], ["second"]]);
  });

  test("long DKIM-style chunks round-trip byte-exact", () => {
    const p1 = "x".repeat(255);
    const p2 = "y".repeat(140);
    const query = encodeTxtQuery(NAME, 1);
    const response = buildResponse(query, [{ chunks: [p1, p2] }]);
    expect(parseTxtResponse(response, 1, NAME)).toEqual([[p1, p2]]);
  });

  test("NXDOMAIN: ENOTFOUND", () => {
    const query = encodeTxtQuery(NAME, 9);
    const response = buildResponse(query, [], { rcode: 3 });
    expect(() => parseTxtResponse(response, 9, NAME)).toThrow(
      expect.objectContaining({ code: "ENOTFOUND" }),
    );
  });

  test("empty answer: ENODATA", () => {
    const query = encodeTxtQuery(NAME, 9);
    const response = buildResponse(query, []);
    expect(() => parseTxtResponse(response, 9, NAME)).toThrow(
      expect.objectContaining({ code: "ENODATA" }),
    );
  });

  test("SERVFAIL: ESERVFAIL", () => {
    const query = encodeTxtQuery(NAME, 9);
    const response = buildResponse(query, [], { rcode: 2 });
    expect(() => parseTxtResponse(response, 9, NAME)).toThrow(
      expect.objectContaining({ code: "ESERVFAIL" }),
    );
  });

  test("mismatched transaction id: EBADRESP", () => {
    const query = encodeTxtQuery(NAME, 9);
    const response = buildResponse(query, [{ chunks: ["x"] }], { id: 10 });
    expect(() => parseTxtResponse(response, 9, NAME)).toThrow(DnsError);
  });

  test("character-string length overrunning its RDATA: EBADRESP (no cross-record read)", () => {
    const query = encodeTxtQuery(NAME, 5);
    // One TXT answer: rdlength=3, rdata=[len=10, 'a','b'] — the length byte
    // claims 10 octets but only 2 remain inside the record.
    const answer = [0xc0, 12, 0, 16, 0, 1, 0, 0, 0, 60, 0, 3, 10, 0x61, 0x62];
    const out = new Uint8Array(query.length + answer.length);
    out.set(query);
    out.set(new Uint8Array(answer), query.length);
    const view = new DataView(out.buffer);
    view.setUint16(2, 0x8180); // QR + RD + RA, rcode 0
    view.setUint16(6, 1); // ANCOUNT
    expect(() => parseTxtResponse(out, 5, NAME)).toThrow(
      expect.objectContaining({ code: "EBADRESP" }),
    );
  });
});

describe("encodeTxtQuery", () => {
  test("encodes labels, type TXT, class IN", () => {
    const q = encodeTxtQuery("a.bc", 0x1234);
    const view = new DataView(q.buffer);
    expect(view.getUint16(0)).toBe(0x1234);
    expect(view.getUint16(4)).toBe(1); // QDCOUNT
    // 1 'a' 2 'b' 'c' 0
    expect([...q.subarray(12, 18)]).toEqual([1, 97, 2, 98, 99, 0]);
    expect(view.getUint16(18)).toBe(16); // TXT
    expect(view.getUint16(20)).toBe(1); // IN
  });

  test("rejects oversized labels", () => {
    expect(() => encodeTxtQuery(`${"x".repeat(64)}.com`, 1)).toThrow(DnsError);
  });
});
