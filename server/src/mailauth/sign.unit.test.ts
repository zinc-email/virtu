import { beforeAll, describe, expect, test } from "bun:test";
import { authenticate } from "mailauth";
import { parseMessage } from "../mail/headers.ts";
import { DKIM_HEADER_FALLBACK_CHAINS, signOutbound } from "./sign.ts";
import {
  dkimTxtRecord,
  makeRsaKeyPair,
  makeStubResolver,
  type TestKeyPair,
} from "./test-fixtures.ts";

let ourKey: TestKeyPair;

beforeAll(() => {
  ourKey = makeRsaKeyPair();
});

const enc = new TextEncoder();

const RAW =
  "From: Milton Waddams - milton at initech.com <milton_r1@proxy.virtu.test>\r\n" +
  "To: wes@qmail.com\r\n" +
  "Subject: TPS reports\r\n" +
  "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
  "Message-ID: <orig-1@initech.com>\r\n" +
  "\r\n" +
  "Please find attached.\r\n";

function ourZones(): Parameters<typeof makeStubResolver>[0] {
  return {
    TXT: {
      "vs1._domainkey.virtu.test": dkimTxtRecord(ourKey),
      "arc1._domainkey.virtu.test": dkimTxtRecord(ourKey),
    },
  };
}

describe("signOutbound", () => {
  test("DKIM signature verifies against our published key", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.sealed).toBe(false);
    expect(result.dkimHeaders).toContain("DKIM-Signature:");
    expect(result.dkimHeaders).toContain("d=virtu.test");

    const auth = await authenticate(Buffer.from(result.message), {
      resolver: makeStubResolver(ourZones()) as never,
      disableBimi: true,
      disableDmarc: true,
      mta: "mx.qmail.com",
      ip: "192.0.2.1",
      helo: "out.virtu.test",
      sender: "vt.x.y@virtu.test",
    });
    const dkim = auth.dkim.results?.find((r) => r.signingDomain === "virtu.test");
    expect(dkim?.status.result).toBe("pass");
    expect(dkim?.selector).toBe("vs1");
  });

  test("multiple keys → multiple signatures", async () => {
    const second = makeRsaKeyPair();
    const { headers, body } = parseMessage(enc.encode(RAW));
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
        { signingDomain: "user.com", selector: "u1", privateKey: second.privateKeyPem },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.dkimHeaders.match(/DKIM-Signature:/g)).toHaveLength(2);
    expect(result.dkimHeaders).toContain("d=user.com");
  });

  test("a broken key fails through every fallback and is reported; good key still signs", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
        { signingDomain: "broken.test", selector: "bad", privateKey: "not a pem key" },
      ],
    });
    // good key produced its signature
    expect(result.dkimHeaders).toContain("d=virtu.test");
    expect(result.dkimHeaders).not.toContain("d=broken.test");
    // broken key reported after exhausting the fallback chain
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]!.signingDomain).toBe("broken.test");
    expect(result.errors[0]!.selector).toBe("bad");
  });

  test("fallback chain constant matches SimpleLogin's DKIM_HEADERS", () => {
    expect(DKIM_HEADER_FALLBACK_CHAINS).toEqual([
      ["Message-ID", "Date", "Subject", "From", "To"],
      ["From", "To"],
      ["Message-ID", "Date"],
      ["From"],
    ]);
  });

  test("ARC seal added with captured context; chain validates downstream", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
      arc: {
        signingDomain: "virtu.test",
        selector: "arc1",
        privateKey: ourKey.privateKeyPem,
        context: {
          authResults:
            "mx.virtu.test;\r\n dkim=pass header.d=initech.com;\r\n spf=pass smtp.mailfrom=milton@initech.com;\r\n dmarc=pass header.from=initech.com",
          cv: "none",
        },
      },
    });

    expect(result.sealed).toBe(true);
    expect(result.arcHeaders).toContain("ARC-Seal:");
    expect(result.arcHeaders).toContain("ARC-Message-Signature:");
    expect(result.arcHeaders).toContain("ARC-Authentication-Results: i=1;");
    expect(result.arcHeaders).toContain("cv=none");

    const auth = await authenticate(Buffer.from(result.message), {
      resolver: makeStubResolver(ourZones()) as never,
      disableBimi: true,
      disableDmarc: true,
      mta: "mx.qmail.com",
      ip: "192.0.2.1",
      sender: "vt.x.y@virtu.test",
    });
    expect(auth.arc !== false && auth.arc.status.result).toBe("pass");
    expect(auth.arc !== false && auth.arc.i).toBe(1);
  });

  test("cv=fail: seal skipped per RFC 8617, DKIM still applied", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
      arc: {
        signingDomain: "virtu.test",
        selector: "arc1",
        privateKey: ourKey.privateKeyPem,
        context: { authResults: "mx.virtu.test; dkim=fail", cv: "fail" },
      },
    });
    expect(result.sealed).toBe(false);
    expect(result.arcHeaders).toBe("");
    expect(result.dkimHeaders).toContain("DKIM-Signature:");
  });

  test("throws without keys", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    expect(signOutbound(headers, body, { dkimKeys: [] })).rejects.toThrow(/at least one/);
  });
});
