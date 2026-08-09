import { beforeAll, describe, expect, test } from "bun:test";
import { dkimSign } from "mailauth";
import {
  dkimTxtRecord,
  makeRsaKeyPair,
  makeStubResolver,
  type TestKeyPair,
} from "./test-fixtures.ts";
import {
  DEFAULT_VERIFY_POLICY,
  mapVerdict,
  VERDICT_RULES,
  verifyInbound,
} from "./verify.ts";

let initechKey: TestKeyPair;

beforeAll(() => {
  initechKey = makeRsaKeyPair();
});

const INITECH_IP = "203.0.113.5";
const SESSION = {
  remoteAddress: INITECH_IP,
  heloHostname: "mail.initech.com",
  envelopeFrom: "milton@initech.com",
  mta: "mx.virtu.test",
};

function zonesFor(dmarcPolicy: "reject" | "quarantine" | "none" | null): Parameters<
  typeof makeStubResolver
>[0] {
  const txt: Record<string, string> = {
    "initech.com": `v=spf1 ip4:${INITECH_IP} -all`,
    "sel1._domainkey.initech.com": dkimTxtRecord(initechKey),
  };
  if (dmarcPolicy !== null) {
    txt["_dmarc.initech.com"] = `v=DMARC1; p=${dmarcPolicy}`;
  }
  return { TXT: txt };
}

const MESSAGE =
  "From: Milton Waddams <milton@initech.com>\r\n" +
  "To: asdf@user.com\r\n" +
  "Subject: TPS reports\r\n" +
  "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
  "Message-ID: <orig-1@initech.com>\r\n" +
  "\r\n" +
  "Please find attached.\r\n";

async function signedByInitech(): Promise<string> {
  const res = await dkimSign(MESSAGE, {
    signingDomain: "initech.com",
    selector: "sel1",
    privateKey: initechKey.privateKeyPem,
    signatureData: [
      {
        signingDomain: "initech.com",
        selector: "sel1",
        privateKey: initechKey.privateKeyPem,
        canonicalization: "relaxed/relaxed",
      },
    ] as never,
  });
  return res.signatures + MESSAGE;
}

describe("verifyInbound", () => {
  test("authentic mail: dkim+spf+dmarc pass, verdict accept, headers + arc context", async () => {
    const message = await signedByInitech();
    const result = await verifyInbound(SESSION, message, {
      resolver: makeStubResolver(zonesFor("reject")),
    });

    expect(result.verdict).toEqual({ action: "accept" });
    expect(result.raw.dkim.results?.[0]?.status.result).toBe("pass");
    expect(result.raw.spf !== false && result.raw.spf.status.result).toBe("pass");
    expect(result.raw.dmarc !== false && result.raw.dmarc.status.result).toBe("pass");

    // ready-to-prepend headers
    expect(result.prependHeaders).toContain("Received-SPF: pass");
    expect(result.prependHeaders).toContain("Authentication-Results: mx.virtu.test");

    // ARC context in the sealer's shape (no chain yet → cv=none)
    expect(result.arcContext).not.toBeNull();
    expect(result.arcContext!.cv).toBe("none");
    expect(result.arcContext!.authResults).toContain("mx.virtu.test");
    expect(result.arcContext!.authResults).toContain("dkim=pass");
  });

  test("spoofed mail, p=reject: verdict reject 550 5.7.1", async () => {
    // unsigned + wrong source IP → dkim none, spf fail, dmarc fail
    const result = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      MESSAGE,
      { resolver: makeStubResolver(zonesFor("reject")) },
    );
    expect(result.verdict.action).toBe("reject");
    if (result.verdict.action !== "reject") throw new Error("unreachable");
    expect(result.verdict.code).toBe(550);
    expect(result.verdict.enhanced).toBe("5.7.1");
    expect(result.verdict.reason).toBe("dmarc-reject");
    expect(result.verdict.message).toContain("initech.com");
  });

  test("spoofed mail, p=quarantine: verdict flag (deliver annotated)", async () => {
    const result = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      MESSAGE,
      { resolver: makeStubResolver(zonesFor("quarantine")) },
    );
    expect(result.verdict).toEqual({ action: "flag", reason: "dmarc-quarantine" });
  });

  test("spoofed mail, p=none: accept (DMARC says monitor only)", async () => {
    const result = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      MESSAGE,
      { resolver: makeStubResolver(zonesFor("none")) },
    );
    expect(result.verdict).toEqual({ action: "accept" });
  });

  test("SPF hard fail without DMARC record: default flag, configurable to reject", async () => {
    const zones = zonesFor(null);
    const flagged = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      MESSAGE,
      { resolver: makeStubResolver(zones) },
    );
    expect(flagged.verdict).toEqual({ action: "flag", reason: "spf-hardfail" });

    const rejected = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      MESSAGE,
      {
        resolver: makeStubResolver(zones),
        policy: { onSpfHardFailWithoutDmarc: "reject" },
      },
    );
    expect(rejected.verdict.action).toBe("reject");
    if (rejected.verdict.action !== "reject") throw new Error("unreachable");
    expect(rejected.verdict.enhanced).toBe("5.7.23");
  });

  test("SPF hard fail WITH passing DMARC does not trip the spf rule", async () => {
    // DKIM-signed (aligned, passes) but sent from the wrong IP → SPF fails,
    // DMARC still passes via DKIM. Conservative: accept.
    const message = await signedByInitech();
    const result = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      message,
      { resolver: makeStubResolver(zonesFor("reject")) },
    );
    expect(result.raw.spf !== false && result.raw.spf.status.result).toBe("fail");
    expect(result.verdict).toEqual({ action: "accept" });
  });

  test("policy override: dmarc reject downgraded to flag", async () => {
    const result = await verifyInbound(
      { ...SESSION, remoteAddress: "198.51.100.99" },
      MESSAGE,
      {
        resolver: makeStubResolver(zonesFor("reject")),
        policy: { onDmarcReject: "flag" },
      },
    );
    expect(result.verdict).toEqual({ action: "flag", reason: "dmarc-reject" });
  });

  test("zero network: resolver misses surface as no-record results, not crashes", async () => {
    const result = await verifyInbound(SESSION, MESSAGE, {
      resolver: makeStubResolver({ TXT: {} }),
    });
    expect(result.verdict).toEqual({ action: "accept" });
    expect(result.raw.dmarc !== false && result.raw.dmarc.status.result).toBe("none");
  });
});

describe("mapVerdict table", () => {
  test("rules are ordered dmarc-reject, dmarc-quarantine, spf-hardfail", () => {
    expect(VERDICT_RULES.map((r) => r.reason)).toEqual([
      "dmarc-reject",
      "dmarc-quarantine",
      "spf-hardfail",
    ]);
  });

  test("default policy is conservative", () => {
    expect(DEFAULT_VERIFY_POLICY).toEqual({
      onDmarcReject: "reject",
      onDmarcQuarantine: "flag",
      onSpfHardFailWithoutDmarc: "flag",
    });
  });

  test("accept action short-circuits any rule", () => {
    const res = {
      dmarc: { status: { result: "fail" }, policy: "reject", p: "reject", domain: "x.com" },
      spf: false,
      dkim: {},
      arc: false,
      bimi: false,
      headers: "",
    } as never;
    expect(
      mapVerdict(res, { ...DEFAULT_VERIFY_POLICY, onDmarcReject: "accept" }),
    ).toEqual({ action: "accept" });
  });
});
