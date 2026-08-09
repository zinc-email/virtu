import { describe, expect, test } from "bun:test";
import {
  buildVerp,
  parseVerp,
  VERP_MESSAGE_LIFETIME,
  VERP_TIME_START,
  type VerpType,
} from "./verp.ts";

const SECRET = "secretsecretsecretsecretsecretsecret"; // 36 chars
const DOMAIN = "example.com";

/** Date for a given "minutes since 2022-01-01" value. */
function minutesToDate(minutes: number): Date {
  return new Date((VERP_TIME_START + minutes * 60) * 1000);
}

describe("golden vector (generated with CPython)", () => {
  // python3:
  //   secret = 'secret'*6; data = [0, 123, 456]
  //   payload = json.dumps(data).encode()          -> b'[0, 123, 456]'
  //   hmac.new(secret, payload, 'sha3-224').digest()[:8].hex() -> 6a407e9923cef786
  //   addr -> vt.lmycyibrgizsyibugu3f2.njah5gjdz33ym@example.com
  test("buildVerp matches SimpleLogin's generate_verp_email byte-for-byte", () => {
    const addr = buildVerp({
      type: "bounce_forward",
      id: 123,
      secret: SECRET,
      domain: DOMAIN,
      now: minutesToDate(456),
    });
    expect(addr).toBe("vt.lmycyibrgizsyibugu3f2.njah5gjdz33ym@example.com");
  });

  test("golden vector parses back", () => {
    const info = parseVerp("vt.lmycyibrgizsyibugu3f2.njah5gjdz33ym@example.com", SECRET, {
      now: minutesToDate(456 + 60),
    });
    expect(info).toEqual({ type: "bounce_forward", id: 123 });
  });
});

describe("round-trip", () => {
  const types: VerpType[] = ["bounce_forward", "bounce_reply", "transactional"];
  for (const type of types) {
    test(`type ${type}`, () => {
      const now = new Date("2026-08-08T12:00:00Z");
      const addr = buildVerp({ type, id: 987654, secret: SECRET, domain: DOMAIN, now });
      expect(parseVerp(addr, SECRET, { now })).toEqual({ type, id: 987654 });
    });
  }

  test("id 0 and falsy ids encode as 0", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const addr = buildVerp({ type: "transactional", id: 0, secret: SECRET, domain: DOMAIN, now });
    expect(parseVerp(addr, SECRET, { now })).toEqual({ type: "transactional", id: 0 });
  });

  test("address is fully lowercased and parse is case-insensitive", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const addr = buildVerp({ type: "bounce_reply", id: 42, secret: SECRET, domain: DOMAIN, now });
    expect(addr).toBe(addr.toLowerCase());
    expect(parseVerp(addr.toUpperCase(), SECRET, { now })).toEqual({
      type: "bounce_reply",
      id: 42,
    });
  });

  test("custom prefix honored on both sides", () => {
    const now = new Date("2026-08-08T12:00:00Z");
    const addr = buildVerp({
      type: "bounce_forward",
      id: 7,
      secret: SECRET,
      domain: DOMAIN,
      now,
      prefix: "sl",
    });
    expect(addr.startsWith("sl.")).toBe(true);
    expect(parseVerp(addr, SECRET, { now, prefix: "sl" })).toEqual({
      type: "bounce_forward",
      id: 7,
    });
    // wrong prefix expectation → reject
    expect(parseVerp(addr, SECRET, { now })).toBeNull();
  });
});

describe("tampering", () => {
  const now = new Date("2026-08-08T12:00:00Z");
  const addr = buildVerp({ type: "bounce_forward", id: 999, secret: SECRET, domain: DOMAIN, now });
  const [prefix, payload, sig] = addr.split("@")[0]!.split(".") as [string, string, string];

  test("tampered payload rejected", () => {
    // flip one base32 char of the payload
    const flipped = payload[0] === "a" ? "b" : "a";
    const tampered = `${prefix}.${flipped}${payload.slice(1)}.${sig}@${DOMAIN}`;
    expect(parseVerp(tampered, SECRET, { now })).toBeNull();
  });

  test("tampered signature rejected", () => {
    const flipped = sig[0] === "a" ? "b" : "a";
    const tampered = `${prefix}.${payload}.${flipped}${sig.slice(1)}@${DOMAIN}`;
    expect(parseVerp(tampered, SECRET, { now })).toBeNull();
  });

  test("wrong secret rejected", () => {
    expect(parseVerp(addr, "anothersecretanothersecretanother!", { now })).toBeNull();
  });

  test("cross-type confusion impossible: payload of one type re-signed check", () => {
    // An attacker cannot change the type code without invalidating the hmac.
    const forward = buildVerp({
      type: "bounce_forward",
      id: 1,
      secret: SECRET,
      domain: DOMAIN,
      now,
    });
    const reply = buildVerp({ type: "bounce_reply", id: 1, secret: SECRET, domain: DOMAIN, now });
    const [, fPayload] = forward.split("@")[0]!.split(".");
    const [, , rSig] = reply.split("@")[0]!.split(".");
    // splice reply's signature onto forward's payload
    const spliced = `vt.${fPayload}.${rSig}@${DOMAIN}`;
    expect(parseVerp(spliced, SECRET, { now })).toBeNull();
    // and the honest ones still parse to their own types
    expect(parseVerp(forward, SECRET, { now })!.type).toBe("bounce_forward");
    expect(parseVerp(reply, SECRET, { now })!.type).toBe("bounce_reply");
  });
});

describe("expiry", () => {
  const created = new Date("2026-08-01T00:00:00Z");
  const addr = buildVerp({
    type: "bounce_forward",
    id: 5,
    secret: SECRET,
    domain: DOMAIN,
    now: created,
  });

  test("valid within the 5-day window", () => {
    const fourDaysLater = new Date(created.getTime() + 4 * 86400 * 1000);
    expect(parseVerp(addr, SECRET, { now: fourDaysLater })).toEqual({
      type: "bounce_forward",
      id: 5,
    });
  });

  test("expired after 5 days", () => {
    const sixDaysLater = new Date(created.getTime() + 6 * 86400 * 1000);
    expect(parseVerp(addr, SECRET, { now: sixDaysLater })).toBeNull();
  });

  test("rejects timestamps too far in the future (verbatim SimpleLogin guard)", () => {
    const sixDaysEarlier = new Date(created.getTime() - 6 * 86400 * 1000);
    expect(parseVerp(addr, SECRET, { now: sixDaysEarlier })).toBeNull();
  });

  test("lifetime constant is 5 days", () => {
    expect(VERP_MESSAGE_LIFETIME).toBe(432000);
  });
});

describe("malformed input", () => {
  const now = new Date("2026-08-08T12:00:00Z");
  const cases: [string, string][] = [
    ["no @", "vt.abc.def"],
    ["empty", ""],
    ["wrong prefix", "xx.lmycyibrgizsyibugu3f2.njah5gjdz33ym@example.com"],
    ["two fields", "vt.onlyonepart@example.com"],
    ["four fields", "vt.a.b.c@example.com"],
    ["invalid base32 payload", "vt.1111!!.njah5gjdz33ym@example.com"],
    ["invalid base32 signature", "vt.lmycyibrgizsyibugu3f2.!!@example.com"],
    ["plain address", "milton@initech.com"],
    ["verp-ish localpart, empty fields", "vt..@example.com"],
  ];
  for (const [name, addr] of cases) {
    test(name, () => {
      expect(parseVerp(addr, SECRET, { now })).toBeNull();
    });
  }

  test("payload that is valid base32 but not a JSON array is rejected", () => {
    // craft: payload "notjson" signed correctly → passes hmac, fails JSON parse
    const payload = new TextEncoder().encode("notjson");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha3-224", SECRET).update(payload).digest().subarray(0, 8);
    const b32 = (b: Uint8Array): string => {
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      let out = "";
      let buf = 0;
      let bits = 0;
      for (const byte of b) {
        buf = (buf << 8) | byte;
        bits += 8;
        while (bits >= 5) {
          out += A[(buf >>> (bits - 5)) & 31];
          bits -= 5;
        }
      }
      if (bits > 0) out += A[(buf << (5 - bits)) & 31];
      return out;
    };
    const addr = `vt.${b32(payload)}.${b32(new Uint8Array(sig))}@example.com`.toLowerCase();
    expect(parseVerp(addr, SECRET, { now })).toBeNull();
  });

  test("JSON array of wrong arity or types is rejected", () => {
    const mk = (json: string): string => {
      const payload = new TextEncoder().encode(json);
      const { createHmac } = require("node:crypto") as typeof import("node:crypto");
      const sig = new Uint8Array(
        createHmac("sha3-224", SECRET).update(payload).digest().subarray(0, 8),
      );
      const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      const b32 = (b: Uint8Array): string => {
        let out = "";
        let buf = 0;
        let bits = 0;
        for (const byte of b) {
          buf = (buf << 8) | byte;
          bits += 8;
          while (bits >= 5) {
            out += A[(buf >>> (bits - 5)) & 31];
            bits -= 5;
          }
        }
        if (bits > 0) out += A[(buf << (5 - bits)) & 31];
        return out;
      };
      return `vt.${b32(payload)}.${b32(sig)}@example.com`.toLowerCase();
    };
    expect(parseVerp(mk("[0, 1]"), SECRET, { now })).toBeNull();
    expect(parseVerp(mk("[0, 1, 2, 3]"), SECRET, { now })).toBeNull();
    expect(parseVerp(mk('["a", 1, 2]'), SECRET, { now })).toBeNull();
    expect(parseVerp(mk("[9, 1, 2]"), SECRET, { now })).toBeNull(); // unknown type code
    expect(parseVerp(mk("{}"), SECRET, { now })).toBeNull();
  });
});

describe("secret validation", () => {
  test("short secret throws on build and parse", () => {
    expect(() =>
      buildVerp({ type: "bounce_forward", id: 1, secret: "short", domain: DOMAIN }),
    ).toThrow(/32/);
    expect(() => parseVerp("vt.a.b@x.com", "short")).toThrow(/32/);
  });
});
