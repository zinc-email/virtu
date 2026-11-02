import { beforeAll, describe, expect, test } from "bun:test";
import { dkimSign } from "mailauth";
import {
  dkimTxtRecord,
  makeRsaKeyPair,
  makeStubResolver,
  type TestKeyPair,
} from "./test-fixtures.ts";
import { createBulkhead } from "../pipeline/verifyBulkhead.ts";
import {
  DEFAULT_VERIFY_POLICY,
  MAX_DKIM_SIGNATURES,
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

function zonesFor(
  dmarcPolicy: "reject" | "quarantine" | "none" | null,
): Parameters<typeof makeStubResolver>[0] {
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
    expect(result.raw.dkim.results?.[0]?.status).toMatchObject({ result: "pass" });
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

  test("DMARC reject alone flags rather than rejects without independent abuse evidence", async () => {
    const result = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, MESSAGE, {
      resolver: makeStubResolver(zonesFor("reject")),
      flagDisposition: "reject",
    });
    expect(result.verdict).toEqual({ action: "flag", reason: "dmarc-reject" });
    expect(result.raw.dmarc && result.raw.dmarc.status.result).toBe("fail");
  });

  test("spoofed mail, p=quarantine: verdict flag (deliver annotated)", async () => {
    const result = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, MESSAGE, {
      resolver: makeStubResolver(zonesFor("quarantine")),
    });
    expect(result.verdict).toEqual({ action: "flag", reason: "dmarc-quarantine" });
  });

  test("spoofed mail, p=none: accept (DMARC says monitor only)", async () => {
    const result = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, MESSAGE, {
      resolver: makeStubResolver(zonesFor("none")),
    });
    expect(result.verdict).toEqual({ action: "accept" });
  });

  test("SPF hard fail without DMARC record: default flag, configurable to reject", async () => {
    const zones = zonesFor(null);
    const flagged = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, MESSAGE, {
      resolver: makeStubResolver(zones),
    });
    expect(flagged.verdict).toEqual({ action: "flag", reason: "spf-hardfail" });

    const rejected = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, MESSAGE, {
      resolver: makeStubResolver(zones),
      policy: { onSpfHardFailWithoutDmarc: "reject" },
    });
    expect(rejected.verdict.action).toBe("reject");
    if (rejected.verdict.action !== "reject") throw new Error("unreachable");
    expect(rejected.verdict.enhanced).toBe("5.7.23");
  });

  test("SPF hard fail WITH passing DMARC does not trip the spf rule", async () => {
    // DKIM-signed (aligned, passes) but sent from the wrong IP → SPF fails,
    // DMARC still passes via DKIM. Conservative: accept.
    const message = await signedByInitech();
    const result = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, message, {
      resolver: makeStubResolver(zonesFor("reject")),
    });
    expect(result.raw.spf !== false && result.raw.spf.status.result).toBe("fail");
    expect(result.verdict).toEqual({ action: "accept" });
  });

  test("policy override: dmarc reject downgraded to flag", async () => {
    const result = await verifyInbound({ ...SESSION, remoteAddress: "198.51.100.99" }, MESSAGE, {
      resolver: makeStubResolver(zonesFor("reject")),
      policy: { onDmarcReject: "flag" },
    });
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
  test("rules are ordered dmarc-reject, dmarc-quarantine, spf-hardfail, dkim-body-length-limited", () => {
    expect(VERDICT_RULES.map((r) => r.reason)).toEqual([
      "dmarc-reject",
      "dmarc-quarantine",
      "spf-hardfail",
      "dkim-body-length-limited",
    ]);
  });

  test("default policy is conservative", () => {
    expect(DEFAULT_VERIFY_POLICY).toEqual({
      onDmarcReject: "flag",
      onDmarcQuarantine: "flag",
      onSpfHardFailWithoutDmarc: "flag",
      onDkimBodyLengthLimited: "flag",
    });
  });

  test("accept policy suppresses only its own finding", () => {
    const res = {
      dmarc: { status: { result: "fail" }, policy: "reject", p: "reject", domain: "x.com" },
      spf: false,
      dkim: {},
      arc: false,
      bimi: false,
      headers: "",
    } as never;
    expect(mapVerdict(res, { ...DEFAULT_VERIFY_POLICY, onDmarcReject: "accept" })).toEqual({
      action: "accept",
    });
  });
});

describe("verifyInbound bounds the sender-controlled work (review round 2)", () => {
  test("DKIM `l=`: a pass over a body prefix is flagged, not accepted", async () => {
    const covered = "Please find attached.\r\n";
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
          maxBodyLength: covered.length,
        },
      ] as never,
    });
    const appended = res.signatures + MESSAGE + "PS: wire the money to attacker\r\n";
    const result = await verifyInbound(SESSION, appended, {
      resolver: makeStubResolver(zonesFor("reject")),
    });
    expect(result.verdict).toEqual({ action: "flag", reason: "dkim-body-length-limited" });
    // The unlimited signature from signedByInitech still accepts.
    const clean = await verifyInbound(SESSION, await signedByInitech(), {
      resolver: makeStubResolver(zonesFor("reject")),
    });
    expect(clean.verdict).toEqual({ action: "accept" });
  });

  test("more DKIM-Signature headers than the cap cost no extra lookups", async () => {
    const signed = await signedByInitech();
    const sigLine = signed.slice(0, signed.indexOf(MESSAGE));
    // 40 copies of the signature, each naming a different selector.
    const many =
      Array.from({ length: 40 }, (_, i) => sigLine.replace("s=sel1", `s=sel${i}`)).join("") +
      MESSAGE;
    const looked: string[] = [];
    const stub = makeStubResolver(zonesFor("none"));
    const resolver: typeof stub = async (name, rrtype) => {
      if (name.endsWith("._domainkey.initech.com")) looked.push(name);
      return stub(name, rrtype);
    };
    const outcome = await verifyInbound(SESSION, many, { resolver });
    expect(outcome.completion).toBe("incomplete");
    expect(outcome.verdict).toMatchObject({ code: 451 });
    expect(new Set(looked).size).toBeLessThanOrEqual(MAX_DKIM_SIGNATURES);
  });

  test("a resolver that never answers becomes a 451 within the budget", async () => {
    const started = Date.now();
    const result = await verifyInbound(SESSION, await signedByInitech(), {
      resolver: () => new Promise(() => {}),
      bulkhead: createBulkhead(1), // intentionally never released; isolate from the shared process slot
      timeoutMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.verdict).toMatchObject({ action: "reject", code: 451, reason: "verify-timeout" });
    expect(result.prependHeaders).toBe("");
  });

  test("a saturated bulkhead tempfails before any work", async () => {
    const bulkhead = createBulkhead(1);
    expect(bulkhead.tryAcquire()).toBe(true);
    let lookups = 0;
    const result = await verifyInbound(SESSION, MESSAGE, {
      resolver: async () => {
        lookups++;
        return [];
      },
      bulkhead,
    });
    expect(result.verdict).toMatchObject({
      action: "reject",
      code: 451,
      reason: "verify-bulkhead",
    });
    expect(lookups).toBe(0);
    bulkhead.release();
  });
});

describe("verifyInbound enforces what mailauth leaves to policy (review round 3)", () => {
  // SPF fails from here (initech publishes -all for one address), so DMARC
  // can only pass through an aligned DKIM signature.
  const ELSEWHERE = { ...SESSION, remoteAddress: "198.51.100.7" };

  async function initechSigned(extra: Record<string, unknown>, headerList?: string) {
    const res = await dkimSign(MESSAGE, {
      signingDomain: "initech.com",
      selector: "sel1",
      privateKey: initechKey.privateKeyPem,
      // mailauth's types say string[]; its signer only honours the
      // colon-separated string form (lib/tools.js getSigningHeaderLines).
      headerList: headerList as never,
      signatureData: [
        {
          signingDomain: "initech.com",
          selector: "sel1",
          privateKey: initechKey.privateKeyPem,
          canonicalization: "relaxed/relaxed",
          ...extra,
        },
      ] as never,
    });
    return res.signatures + MESSAGE;
  }

  test("a signature whose h= omits From is not a pass (RFC 6376 §5.4)", async () => {
    const unsigned = await initechSigned({}, "to:subject:date");
    expect(unsigned).toMatch(/h=[^;]*to/i);
    expect(unsigned).not.toMatch(/h=[^;]*from/i);
    const result = await verifyInbound(ELSEWHERE, unsigned, {
      resolver: makeStubResolver(zonesFor("reject")),
    });
    expect(result.verdict).toMatchObject({ action: "flag", reason: "dmarc-reject" });
    // The same message with From signed passes DMARC through DKIM alone.
    const signed = await verifyInbound(ELSEWHERE, await initechSigned({}), {
      resolver: makeStubResolver(zonesFor("reject")),
    });
    expect(signed.verdict).toEqual({ action: "accept" });
  });

  test("rsa-sha1 signatures are dropped (RFC 8301)", async () => {
    const sha1 = await initechSigned({ algorithm: "rsa-sha1" });
    expect(sha1).toContain("a=rsa-sha1");
    const result = await verifyInbound(ELSEWHERE, sha1, {
      resolver: makeStubResolver(zonesFor("reject")),
    });
    expect(result.verdict).toMatchObject({ action: "flag", reason: "dmarc-reject" });
  });

  test("distinct body-hash variants exceeding the cap defer before any lookup", async () => {
    const signed = await signedByInitech();
    const sigLine = signed.slice(0, signed.indexOf(MESSAGE));
    // Six signatures, each naming its own selector and its own l= value.
    const many =
      Array.from({ length: 6 }, (_, i) =>
        sigLine.replace("s=sel1", `s=sel${i}`).replace("bh=", `l=${100 + i}; bh=`),
      ).join("") + MESSAGE;
    const looked = new Set<string>();
    const stub = makeStubResolver(zonesFor("none"));
    const resolver: typeof stub = async (name, rrtype) => {
      if (name.endsWith("._domainkey.initech.com")) looked.add(name);
      return stub(name, rrtype);
    };
    const result = await verifyInbound(SESSION, many, { resolver });
    expect(result.completion).toBe("incomplete");
    expect(result.verdict).toMatchObject({ code: 451 });
    expect(result.arcContext).toBeNull();
    expect(looked.size).toBe(0);
  });

  test("the bulkhead slot stays taken until timed-out work settles", async () => {
    const bulkhead = createBulkhead(1);
    // Every lookup hangs until told otherwise; mailauth issues several.
    let open = false;
    const pending: (() => void)[] = [];
    const resolver = () =>
      open
        ? Promise.reject(new Error("done"))
        : new Promise<never>((_, reject) => {
            pending.push(() => reject(new Error("done")));
          });
    const result = await verifyInbound(SESSION, await signedByInitech(), {
      resolver,
      timeoutMs: 50,
      bulkhead,
    });
    expect(result.verdict).toMatchObject({ code: 451, reason: "verify-timeout" });
    expect(bulkhead.tryAcquire()).toBe(false);
    open = true;
    for (let i = 0; i < 10 && !bulkhead.tryAcquire(); i++) {
      for (const reject of pending.splice(0)) reject();
      await Bun.sleep(10);
    }
    expect(bulkhead.tryAcquire()).toBe(false); // the one slot is ours now
    bulkhead.release();
  });
});
