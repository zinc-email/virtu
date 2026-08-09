/**
 * Test-only helper: generate a throwaway self-signed RSA certificate for
 * `localhost`/`127.0.0.1` using nothing but `node:crypto` (minimal DER
 * construction — no openssl, no checked-in key material). Used by the TLS
 * tests in this directory; wave-2 integration tests may import it directly.
 * Not part of the public API.
 */
import { Buffer } from "node:buffer";
import { createSign, generateKeyPairSync } from "node:crypto";

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

const SEQ = (...c: Buffer[]) => der(0x30, ...c);
const SET = (...c: Buffer[]) => der(0x31, ...c);
const INT = (b: Buffer) => der(0x02, b);
const NULL = Buffer.from([0x05, 0x00]);
const UTF8 = (s: string) => der(0x0c, Buffer.from(s, "utf8"));
const UTCTIME = (s: string) => der(0x17, Buffer.from(s, "ascii"));
const BITSTR = (b: Buffer) => der(0x03, Buffer.concat([Buffer.from([0]), b]));

function OID(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    if (p < 0x80) {
      bytes.push(p);
    } else {
      const stack: number[] = [];
      let v = p;
      while (v > 0) {
        stack.unshift(v & 0x7f);
        v >>= 7;
      }
      for (let i = 0; i < stack.length - 1; i++) bytes.push(stack[i]! | 0x80);
      bytes.push(stack[stack.length - 1]!);
    }
  }
  return der(0x06, Buffer.from(bytes));
}

const SHA256_RSA = SEQ(OID("1.2.840.113549.1.1.11"), NULL);

/** Generate a self-signed cert + key (PEM) valid for localhost/127.0.0.1. */
export function makeTestCert(): { key: string; cert: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const name = SEQ(SET(SEQ(OID("2.5.4.3"), UTF8("localhost"))));
  const san = SEQ(
    OID("2.5.29.17"), // subjectAltName
    der(
      0x04, // OCTET STRING
      SEQ(
        der(0x82, Buffer.from("localhost", "ascii")), // dNSName
        der(0x87, Buffer.from([127, 0, 0, 1])), // iPAddress
      ),
    ),
  );
  const tbs = SEQ(
    der(0xa0, INT(Buffer.from([2]))), // version: v3
    INT(Buffer.from([0x01, 0x00, 0x01])), // serialNumber
    SHA256_RSA,
    name, // issuer (= subject: self-signed)
    SEQ(UTCTIME("250101000000Z"), UTCTIME("400101000000Z")), // validity
    name, // subject
    spki,
    der(0xa3, SEQ(san)), // extensions
  );
  const signer = createSign("sha256");
  signer.update(tbs);
  const cert = SEQ(tbs, SHA256_RSA, BITSTR(signer.sign(privateKey)));
  const certPem =
    "-----BEGIN CERTIFICATE-----\n" +
    (cert.toString("base64").match(/.{1,64}/g) ?? []).join("\n") +
    "\n-----END CERTIFICATE-----\n";
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: certPem };
}
