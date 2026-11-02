import { describe, expect, test } from "bun:test";
import { dkimSign, sealMessage, dmarc } from "mailauth";
import { verifyInbound } from "./verify.ts";
import { makeRsaKeyPair, makeStubResolver, dkimTxtRecord } from "./test-fixtures.ts";

const session = {
  remoteAddress: "203.0.113.1",
  envelopeFrom: "sender@other.example.com",
  mta: "mx.example.net",
};
const message = (domain = "department.example.com") =>
  `From: alice@${domain}\r\nTo: bob@example.net\r\nDate: Sun, 1 Nov 2026 12:00:00 +0000\r\nMessage-ID: <test@example.com>\r\nSubject: test\r\n\r\nbody\r\n`;
const zone = (txt: Record<string, string | string[][]>) =>
  makeStubResolver({ TXT: { "other.example.com": "v=spf1 ip4:203.0.113.1 -all", ...txt } });

describe("RFC 9989 engine discovery and alignment", () => {
  test("independent psd=n boundaries do not align despite common PSL domain", async () => {
    const result = await verifyInbound(session, message(), {
      resolver: zone({
        "_dmarc.department.example.com": "v=DMARC1; p=reject; psd=n",
        "_dmarc.other.example.com": "v=DMARC1; p=reject; psd=n",
      }),
    });
    expect(result.raw.dmarc && result.raw.dmarc.status.result).toBe("fail");
  });
  test("intermediate organizational policy and its sp apply", async () => {
    const result = await verifyInbound(session, message("a.department.example.com"), {
      resolver: zone({
        "_dmarc.department.example.com": "v=DMARC1; p=none; sp=reject; psd=n",
      }),
    });
    expect(result.raw.dmarc).toMatchObject({
      policy: "reject",
      status: { result: "fail", header: { d: "department.example.com" } },
    });
  });
  test("duplicate records are discarded and discovery continues", async () => {
    const result = await verifyInbound(session, message(), {
      resolver: zone({
        "_dmarc.department.example.com": [["v=DMARC1; p=reject"], ["v=DMARC1; p=none"]],
        "_dmarc.example.com": "v=DMARC1; p=quarantine; psd=n",
      }),
    });
    expect(result.raw.dmarc).toMatchObject({ policy: "quarantine", status: { result: "pass" } });
  });
  test("test mode downgrades reject exactly one level and missing p defaults none", async () => {
    for (const [record, expected] of [
      ["v=DMARC1; p=reject; t=y", "quarantine"],
      ["v=DMARC1; psd=n", "none"],
      ["v=DMARC1; p=invalid; rua=mailto:reports@example.com", "none"],
    ]) {
      const result = await verifyInbound(session, message(), {
        resolver: zone({ "_dmarc.department.example.com": record! }),
      });
      expect(result.raw.dmarc).toMatchObject({ policy: expected });
    }
  });
  test("transient discovery failure defers and supplies no ARC context", async () => {
    const resolver = zone({});
    const result = await verifyInbound(session, message(), {
      resolver: async (name, type) => {
        if (name.startsWith("_dmarc"))
          throw Object.assign(new Error("SERVFAIL"), { code: "ESERVFAIL" });
        return resolver(name, type);
      },
    });
    expect(result.completion).toBe("incomplete");
    expect(result.verdict).toMatchObject({ code: 451 });
    expect(result.arcContext).toBeNull();
  });
});

describe("immutable ARC verification and acceptance evidence", () => {
  test("ignored invalid DKIM stays present for AMS verification", async () => {
    const key = makeRsaKeyPair();
    const base = Buffer.from(message("example.com"));
    const signature = await dkimSign(base, {
      signatureData: [
        { signingDomain: "example.com", selector: "s", privateKey: key.privateKeyPem },
      ],
      headerList: "Message-ID:Date",
    } as never);
    const signed = Buffer.concat([Buffer.from(signature.signatures), base]);
    const seal = await sealMessage(signed, {
      signingDomain: "example.com",
      selector: "s",
      privateKey: key.privateKeyPem,
      authResults: "mx.example.com; dkim=fail",
      cv: "none",
      headerList: "From:To:Date:Message-ID:Subject:DKIM-Signature",
    } as never);
    const input = Buffer.concat([seal, signed]);
    const copy = Buffer.from(input);
    const result = await verifyInbound(session, input, {
      resolver: zone({ "s._domainkey.example.com": dkimTxtRecord(key) }),
    });
    expect(result.raw.arc && result.raw.arc.status.result).toBe("pass");
    expect(result.arcContext).toMatchObject({ state: "valid", nextInstance: 2 });
    expect(result.raw.dkim.results.some((r) => r.status.result === "pass")).toBe(false);
    expect(input.equals(copy)).toBe(true);
    const broken = await verifyInbound(
      session,
      Buffer.from(input.toString().replace("body\r\n", "tampered\r\n")),
      { resolver: zone({ "s._domainkey.example.com": dkimTxtRecord(key) }) },
    );
    expect(broken.arcContext).toMatchObject({ state: "newly-failed", cv: "fail", nextInstance: 2 });
  });
  test("trusted indirect evidence affects disposition, not authentication facts", async () => {
    const resolver = zone({ "_dmarc.department.example.com": "v=DMARC1; p=reject; psd=n" });
    const trusted = await verifyInbound(session, message(), {
      resolver,
      acceptanceEvidence: { kind: "trusted-indirect", source: "operator configured relay" },
    });
    expect(trusted.raw.dmarc && trusted.raw.dmarc.status.result).toBe("fail");
    expect(trusted.verdict).toEqual({ action: "accept" });
    const abuse = await verifyInbound(session, message(), {
      resolver,
      acceptanceEvidence: { kind: "abuse", reason: "content-classifier" },
    });
    expect(abuse.verdict).toMatchObject({ code: 550, reason: "content-classifier" });
  });
});

test("independent body-coverage rejection is not masked by a DMARC annotation", async () => {
  const { mapVerdict, DEFAULT_VERIFY_POLICY } = await import("./verify.ts");
  const result = {
    dmarc: { status: { result: "fail" }, policy: "reject" },
    spf: false,
    dkim: { results: [{ status: { result: "pass" }, canonBodyLengthLimited: true }] },
  } as never;
  expect(mapVerdict(result, DEFAULT_VERIFY_POLICY, undefined, "reject")).toMatchObject({
    code: 550,
    reason: "dkim-body-length-limited",
  });
});

test("invalid parent policy cannot establish an alignment boundary", async () => {
  const result = await dmarc({
    headerFrom: "alice@a.example.com",
    dkimDomains: [{ domain: "b.example.com" }],
    spfDomains: [],
    resolver: zone({
      "_dmarc.a.example.com": "v=DMARC1; p=reject",
      "_dmarc.example.com": "v=DMARC1; p=bad; psd=n",
    }) as never,
  });
  expect(result && result.status.result).toBe("fail");
});

test("DMARC parser ignores unknown duplicate tags but distinguishes empty policy from absent policy", async () => {
  for (const [record, expected] of [
    ["v=DMARC1; p=reject; future=a; future=b", "reject"],
    ["v=DMARC1; p=", undefined],
    ["v=DMARC1; p=reject; sp=", undefined],
    ["v=DMARC1; p=reject; np=; rua=mailto:reports@example.com", "none"],
  ] as const) {
    const result = await verifyInbound(session, message(), {
      resolver: zone({ "_dmarc.department.example.com": record }),
    });
    if (expected === undefined) expect(result.raw.dmarc && result.raw.dmarc.policy).toBeUndefined();
    else expect(result.raw.dmarc && result.raw.dmarc.policy).toBe(expected);
  }
});

test("tree walk bounds deep author names to eight queries", async () => {
  const queried: string[] = [];
  const result = await dmarc({
    headerFrom: "alice@a.b.c.d.e.f.g.h.i.j.mail.example.com",
    spfDomains: [],
    dkimDomains: [],
    resolver: async (name) => {
      queried.push(name);
      throw Object.assign(new Error("No data"), { code: "ENODATA" });
    },
  });
  expect(result && result.status.result).toBe("none");
  expect(queried).toEqual([
    "_dmarc.a.b.c.d.e.f.g.h.i.j.mail.example.com",
    "_dmarc.g.h.i.j.mail.example.com",
    "_dmarc.h.i.j.mail.example.com",
    "_dmarc.i.j.mail.example.com",
    "_dmarc.j.mail.example.com",
    "_dmarc.mail.example.com",
    "_dmarc.example.com",
    "_dmarc.com",
  ]);
});

test("psd=y boundary aligns children within a tenant, not separate tenants", async () => {
  for (const [candidate, expected] of [
    ["b.tenant.example.com", "pass"],
    ["other.example.com", "fail"],
  ] as const) {
    const result = await dmarc({
      headerFrom: "alice@a.tenant.example.com",
      spfDomains: [candidate!],
      dkimDomains: [],
      resolver: zone({ "_dmarc.example.com": "v=DMARC1; p=reject; psd=y" }) as never,
    });
    expect(result && result.status.result).toBe(expected);
  }
});

test("np applies only to NXDOMAIN while existing empty nonterminals use sp", async () => {
  for (const [code, expected] of [
    ["ENOTFOUND", "reject"],
    ["ENODATA", "quarantine"],
  ]) {
    const stub = zone({
      "_dmarc.example.com": "v=DMARC1; p=none; sp=quarantine; np=reject; psd=n",
    });
    const result = await verifyInbound(session, message(), {
      resolver: async (name, type) => {
        if (type === "A") throw Object.assign(new Error(code), { code });
        return stub(name, type);
      },
    });
    if (expected === undefined) expect(result.raw.dmarc && result.raw.dmarc.policy).toBeUndefined();
    else expect(result.raw.dmarc && result.raw.dmarc.policy).toBe(expected);
  }
});

test("unrelated ARC extension headers do not create a chain; instance50 cannot be extended", async () => {
  const none = await verifyInbound(session, `ARC-Foo: i=49\r\n${message()}`, {
    resolver: zone({}),
  });
  expect(none.arcContext).toMatchObject({ state: "no-chain", nextInstance: 1 });
  const capped = await verifyInbound(session, `ARC-Seal: i=50; cv=pass\r\n${message()}`, {
    resolver: zone({}),
  });
  expect(capped.completion).toBe("incomplete");
  expect(capped.verdict).toMatchObject({ code: 451 });
  expect(capped.arcContext).toBeNull();
});
