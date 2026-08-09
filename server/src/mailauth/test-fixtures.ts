/**
 * Shared fixtures for Lane B unit tests: in-test RSA keypairs and a stub DNS
 * resolver so mailauth runs with ZERO network. Test-only — not exported from
 * the package index.
 */

import { generateKeyPairSync } from "node:crypto";
import type { DnsResolver } from "./verify.ts";

/** An in-test RSA signing identity. */
export interface TestKeyPair {
  /** PKCS#8 PEM private key (feed to dkimSign/sealMessage). */
  privateKeyPem: string;
  /** Base64 SPKI public key (the p= value of a DKIM TXT record). */
  publicKeyBase64: string;
}

/** Generate a fresh 2048-bit RSA keypair. */
export function makeRsaKeyPair(): TestKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyBase64: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
      "base64",
    ),
  };
}

/** The DKIM TXT record content for a public key. */
export function dkimTxtRecord(key: TestKeyPair): string {
  return `v=DKIM1; k=rsa; p=${key.publicKeyBase64}`;
}

/**
 * Zone data for {@link makeStubResolver}: `zones["TXT"]["initech.com"]` etc.
 * TXT values may be given as plain strings (wrapped to `[[value]]` shape).
 */
export interface StubZones {
  TXT?: Record<string, string | string[][]>;
  A?: Record<string, string[]>;
  AAAA?: Record<string, string[]>;
  MX?: Record<string, { exchange: string; priority: number }[]>;
}

/**
 * Build a mailauth-shaped resolver answering only from the given zones.
 * Missing names raise ENOTFOUND exactly like node:dns, so mailauth's
 * SPF/DMARC "no record" paths behave as in production.
 */
export function makeStubResolver(zones: StubZones): DnsResolver {
  return async (name: string, rrtype: string) => {
    const table = (zones as Record<string, Record<string, unknown> | undefined>)[rrtype];
    const entry = table?.[name.toLowerCase()];
    if (entry === undefined) {
      const err = new Error(`queryTxt ENOTFOUND ${name}`) as Error & { code: string };
      err.code = "ENOTFOUND";
      throw err;
    }
    if (rrtype === "TXT" && typeof entry === "string") return [[entry]];
    return entry;
  };
}
