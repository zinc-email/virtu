import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { authenticate } from "mailauth";
import { parseMessage } from "../mail/headers.ts";
import { DKIM_SIGNED_HEADERS, DKIM_SIGNATURE_LIFETIME_MS, signOutbound } from "./sign.ts";
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
  "From: Milton Waddams - milton at initech.com <milton_r1@virtu.test>\r\n" +
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
    expect(result.dkimHeaders.match(/DKIM-Signature:/g)).toHaveLength(2);
    expect(result.dkimHeaders).toContain("d=user.com");
  });

  test("any required broken key aborts signing even when another key works", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    await expect(
      signOutbound(headers, body, {
        dkimKeys: [
          { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
          { signingDomain: "broken.test", selector: "bad", privateKey: "not a pem key" },
        ],
      }),
    ).rejects.toThrow("Required DKIM signing failed");
  });

  test("one policy covers From and core content headers", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const signed = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
    });
    const covered = /\bh=([^;]+)/
      .exec(signed.dkimHeaders)?.[1]
      ?.toLowerCase()
      .split(/\s*:\s*/);
    for (const name of ["from", "to", "subject", "date", "message-id"])
      expect(covered).toContain(name);
    expect(DKIM_SIGNED_HEADERS).toContain("Content-Type");
    const tampered = Buffer.from(signed.message)
      .toString()
      .replace("milton_r1@virtu.test", "attacker@virtu.test");
    const verified = await authenticate(tampered, {
      resolver: makeStubResolver(ourZones()) as never,
      disableBimi: true,
      disableDmarc: true,
    });
    expect(verified.dkim.results?.[0]?.status.result).toBe("fail");
  });

  test("refuses missing/ambiguous authors and unrelated signing identities", async () => {
    for (const from of [
      "",
      "From: a@virtu.test\r\nFrom: b@virtu.test\r\n",
      "From: a@virtu.test, b@virtu.test\r\n",
      "From: invalid\r\n",
      "From: a@unrelated.test\r\n",
    ]) {
      const parsed = parseMessage(enc.encode(from + "Subject: x\r\n\r\nbody\r\n"));
      await expect(
        signOutbound(parsed.headers, parsed.body, {
          dkimKeys: [
            { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
          ],
        }),
      ).rejects.toThrow();
    }
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
          state: "no-chain",
          cv: "none",
          nextInstance: 1,
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

  test("already-failed ARC chain is not extended; DKIM still applied", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    headers.prepend("ARC-Seal", "i=2; cv=fail; d=broken.test; b=bad");
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
      arc: {
        signingDomain: "virtu.test",
        selector: "arc1",
        privateKey: ourKey.privateKeyPem,
        context: { state: "already-failed", authResults: "mx.virtu.test; dkim=fail", cv: "fail" },
      },
    });
    expect(result.sealed).toBe(false);
    expect(result.arcHeaders).toBe("");
    expect(result.dkimHeaders).toContain("DKIM-Signature:");
    expect(parseMessage(result.message).headers.getAll("ARC-Seal")).toHaveLength(1);
  });

  test("newly failed malformed chains get a cv=fail seal over only our new set", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    // Deliberately malformed: no AMS/AAR, duplicate seals, and a gap in i.
    headers.prepend("ARC-Seal", "i=3; cv=pass; d=broken.test; b=bad");
    headers.prepend("ARC-Seal", "i=3; cv=pass; d=other.test; b=bad");
    const signed = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
      arc: {
        signingDomain: "virtu.test",
        selector: "arc1",
        privateKey: ourKey.privateKeyPem,
        context: {
          state: "newly-failed",
          cv: "fail",
          nextInstance: 4,
          authResults: "mx.virtu.test; arc=fail",
        },
      },
    });
    expect(signed.sealed).toBe(true);
    const sealFields = parseMessage(enc.encode(signed.arcHeaders)).headers;
    const seal = sealFields.get("ARC-Seal")!;
    expect(seal).toContain("i=4");
    expect(seal).toContain("cv=fail");
    expect(parseMessage(signed.message).headers.getFields("ARC-Seal")).toHaveLength(3);
    // Independent RFC 8617 §5.1.2 check: verify just our new AAR, AMS, AS.
    const canonical = (name: string, value: string) =>
      `${name.toLowerCase()}:${value
        .replace(/\r?\n[ \t]+/g, " ")
        .replace(/[ \t]+/g, " ")
        .trim()}`;
    const input = [
      canonical("ARC-Authentication-Results", sealFields.get("ARC-Authentication-Results")!) +
        "\r\n",
      canonical("ARC-Message-Signature", sealFields.get("ARC-Message-Signature")!) + "\r\n",
      canonical("ARC-Seal", seal).replace(/\bb=[^;]*/, "b="),
    ].join("");
    const signature = /\bb=([^;]+)/.exec(seal)![1]!.replace(/\s/g, "");
    expect(
      verifySignature(
        "RSA-SHA256",
        Buffer.from(input),
        ourKey.privateKeyPem,
        Buffer.from(signature, "base64"),
      ),
    ).toBe(true);
  });

  test("refuses ARC instance/context mismatch instead of emitting an invalid chain", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    headers.prepend("ARC-Seal", "i=1; cv=none; d=broken.test; b=bad");
    await expect(
      signOutbound(headers, body, {
        dkimKeys: [
          { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
        ],
        arc: {
          signingDomain: "virtu.test",
          selector: "arc1",
          privateKey: ourKey.privateKeyPem,
          context: {
            state: "newly-failed",
            cv: "fail",
            nextInstance: 3,
            authResults: "mx.virtu.test; arc=fail",
          },
        },
      }),
    ).rejects.toThrow("Invalid ARC sealing instance");
  });

  test("rejects unsupported hashes and weak RSA signing keys", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const weak = generateKeyPairSync("rsa", { modulusLength: 512 }).privateKey.export({
      format: "pem",
      type: "pkcs8",
    }) as string;
    for (const key of [
      { signingDomain: "virtu.test", selector: "weak", privateKey: weak },
      {
        signingDomain: "virtu.test",
        selector: "sha1",
        privateKey: ourKey.privateKeyPem,
        algorithm: "rsa-sha1" as never,
      },
    ])
      await expect(signOutbound(headers, body, { dkimKeys: [key] })).rejects.toThrow(
        "Required DKIM signing failed",
      );
  });

  test("rejects transport-normalized body inputs without modifying them", async () => {
    for (const text of ["hello\nworld\n", "hello\nworld\r\n", "hello"]) {
      const { headers } = parseMessage(enc.encode(RAW));
      const body = enc.encode(text);
      const original = body.slice();
      await expect(
        signOutbound(headers, body, {
          dkimKeys: [
            { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
          ],
        }),
      ).rejects.toThrow(/CRLF/);
      expect(body).toEqual(original);
    }
  });

  test("throws without keys", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    expect(signOutbound(headers, body, { dkimKeys: [] })).rejects.toThrow(/at least one/);
  });
});

describe("signOutbound signs what goes on the wire (review round 3)", () => {
  test("signatures carry an expiry a week out", async () => {
    const { headers, body } = parseMessage(enc.encode(RAW));
    const signTime = new Date("2026-08-07T10:00:00Z");
    const result = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
      ],
      signTime,
    });
    const t = Number(/\bt=(\d+)/.exec(result.dkimHeaders)?.[1]);
    const x = Number(/\bx=(\d+)/.exec(result.dkimHeaders)?.[1]);
    expect(t).toBe(Math.floor(signTime.getTime() / 1000));
    expect(x - t).toBe(DKIM_SIGNATURE_LIFETIME_MS / 1000);
  });

  test("rejects overlong body lines without changing MIME content", async () => {
    const long = `<a href="https://example.com/${"x".repeat(1100)}">link</a>`;
    const { headers, body } = parseMessage(enc.encode(RAW.replace("Please find attached.", long)));
    const original = body.slice();
    await expect(
      signOutbound(headers, body, {
        dkimKeys: [
          { signingDomain: "virtu.test", selector: "vs1", privateKey: ourKey.privateKeyPem },
        ],
      }),
    ).rejects.toThrow("Message line exceeds 998 octets");
    expect(body).toEqual(original);
  });
});
