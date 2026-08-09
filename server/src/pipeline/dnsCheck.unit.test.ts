import { describe, expect, test } from "bun:test";
import {
  allowedSpfIncludes,
  checkDkim,
  checkDmarc,
  checkMx,
  checkOwnership,
  checkSpf,
  DMARC_RECORD,
  type DnsCheckResolvers,
  dkimPublicKeyOf,
  expectedDnsRecords,
  expectedMxExchanges,
  type MxRecord,
  spfIncludes,
} from "./dnsCheck.ts";

/** Resolver stub: TXT by exact name; MX by domain. */
function stub(
  txt: Record<string, string[][]>,
  mx: Record<string, MxRecord[]> = {},
): DnsCheckResolvers {
  const notFound = (name: string) => {
    const err = new Error(`queryTxt ENOTFOUND ${name}`) as NodeJS.ErrnoException;
    err.code = "ENOTFOUND";
    return err;
  };
  return {
    resolveTxt: (name) => {
      const hit = txt[name];
      if (hit === undefined) return Promise.reject(notFound(name));
      return Promise.resolve(hit);
    },
    resolveMx: (name) => {
      const hit = mx[name];
      if (hit === undefined) return Promise.reject(notFound(name));
      return Promise.resolve(hit);
    },
  };
}

describe("checkOwnership", () => {
  test("passes when any apex TXT equals the expected value", async () => {
    const r = stub({
      "user.com": [["v=spf1 include:spf1.virtu.email ~all"], ["vt-verification=tok123"]],
    });
    const result = await checkOwnership("user.com", ["vt-verification=tok123"], r);
    expect(result).toEqual({ ok: true, errors: [] });
  });

  test("joins multi-string TXT records before comparing", async () => {
    const r = stub({ "user.com": [["vt-verification=", "tok123"]] });
    expect((await checkOwnership("user.com", ["vt-verification=tok123"], r)).ok).toBe(true);
  });

  test("fails with the found records as errors", async () => {
    const r = stub({ "user.com": [["something-else"]] });
    const result = await checkOwnership("user.com", ["vt-verification=tok123"], r);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["something-else"]);
  });

  test("NXDOMAIN fails cleanly with no errors", async () => {
    const result = await checkOwnership("user.com", ["vt-verification=tok123"], stub({}));
    expect(result).toEqual({ ok: false, errors: [] });
  });

  test("lookup failures are reported, never thrown", async () => {
    const r: DnsCheckResolvers = {
      resolveTxt: () => Promise.reject(new Error("boom")),
      resolveMx: () => Promise.resolve([]),
    };
    const result = await checkOwnership("user.com", ["vt-verification=tok123"], r);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("boom");
  });
});

describe("checkMx", () => {
  const expected = ["mail.virtu.email"];

  test("priority numbers are irrelevant; order and hosts must match", async () => {
    const r = stub({}, { "user.com": [{ exchange: "mail.virtu.email", priority: 42 }] });
    expect((await checkMx("user.com", expected, r)).ok).toBe(true);
  });

  test("trailing dots and case are normalized", async () => {
    const r = stub({}, { "user.com": [{ exchange: "MAIL.Virtu.Email.", priority: 10 }] });
    expect((await checkMx("user.com", expected, r)).ok).toBe(true);
  });

  test("extra records fail (count must match), found records reported", async () => {
    const r = stub(
      {},
      {
        "user.com": [
          { exchange: "mail.virtu.email", priority: 10 },
          { exchange: "backup.elsewhere.net", priority: 20 },
        ],
      },
    );
    const result = await checkMx("user.com", expected, r);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["10 mail.virtu.email", "20 backup.elsewhere.net"]);
  });

  test("wrong host fails", async () => {
    const r = stub({}, { "user.com": [{ exchange: "mx.gmail.com", priority: 10 }] });
    expect((await checkMx("user.com", expected, r)).ok).toBe(false);
  });

  test("multiple expected exchanges compare in priority order", async () => {
    const r = stub(
      {},
      {
        "user.com": [
          { exchange: "mx2.virtu.email", priority: 20 },
          { exchange: "mx1.virtu.email", priority: 5 },
        ],
      },
    );
    expect((await checkMx("user.com", ["mx1.virtu.email", "mx2.virtu.email"], r)).ok).toBe(true);
    expect((await checkMx("user.com", ["mx2.virtu.email", "mx1.virtu.email"], r)).ok).toBe(false);
  });

  test("NXDOMAIN fails cleanly", async () => {
    expect(await checkMx("user.com", expected, stub({}))).toEqual({ ok: false, errors: [] });
  });
});

describe("spf", () => {
  test("spfIncludes extracts include targets, qualifiers tolerated", () => {
    expect(spfIncludes("v=spf1 a mx +include:foo.com ~include:Bar.Net. -all")).toEqual([
      "foo.com",
      "bar.net",
    ]);
    expect(spfIncludes("v=spf1 ip4:1.2.3.4 -all")).toEqual([]);
  });

  test("passes on either allowed include (apex or spf1 host)", async () => {
    const allowed = allowedSpfIncludes("virtu.email");
    const apex = stub({ "user.com": [["v=spf1 include:virtu.email ~all"]] });
    const spf1 = stub({ "user.com": [["v=spf1 include:spf1.virtu.email ~all"]] });
    expect((await checkSpf("user.com", allowed, apex)).ok).toBe(true);
    expect((await checkSpf("user.com", allowed, spf1)).ok).toBe(true);
  });

  test("fails with only the spf records as errors (ownership TXT not leaked)", async () => {
    const r = stub({
      "user.com": [["vt-verification=tok"], ["v=spf1 include:elsewhere.net -all"]],
    });
    const result = await checkSpf("user.com", allowedSpfIncludes("virtu.email"), r);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["v=spf1 include:elsewhere.net -all"]);
  });
});

describe("checkDkim", () => {
  const p = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAbase64base64base64";

  test("dkimPublicKeyOf parses the p= tag and strips whitespace", () => {
    expect(dkimPublicKeyOf(`v=DKIM1; k=rsa; p=${p}`)).toBe(p);
    expect(dkimPublicKeyOf(`v=DKIM1;p= ${p.slice(0, 10)} ${p.slice(10)} `)).toBe(p);
    expect(dkimPublicKeyOf("v=DKIM1; k=rsa")).toBeNull();
  });

  test("passes when the selector TXT carries our key (chunked TXT joined)", async () => {
    const r = stub({
      "dkim._domainkey.user.com": [[`v=DKIM1; k=rsa; p=${p.slice(0, 20)}`, p.slice(20)]],
    });
    expect((await checkDkim("user.com", "dkim", p, r)).ok).toBe(true);
  });

  test("fails on a different key, reporting what was found", async () => {
    const r = stub({ "dkim._domainkey.user.com": [["v=DKIM1; k=rsa; p=SOMEOTHERKEY"]] });
    const result = await checkDkim("user.com", "dkim", p, r);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["v=DKIM1; k=rsa; p=SOMEOTHERKEY"]);
  });

  test("fails cleanly when the record is absent", async () => {
    expect(await checkDkim("user.com", "dkim", p, stub({}))).toEqual({ ok: false, errors: [] });
  });
});

describe("checkDmarc", () => {
  test("exact match on the recommended record", async () => {
    const r = stub({ "_dmarc.user.com": [[DMARC_RECORD]] });
    expect((await checkDmarc("user.com", r)).ok).toBe(true);
  });

  test("any other policy fails and is reported", async () => {
    const r = stub({ "_dmarc.user.com": [["v=DMARC1; p=none"]] });
    const result = await checkDmarc("user.com", r);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["v=DMARC1; p=none"]);
  });
});

describe("expectedDnsRecords", () => {
  test("builds the full customer-facing record set", () => {
    const records = expectedDnsRecords(
      "user.com",
      "tok123",
      { selector: "dkim", publicKeyBase64: "PUBKEY" },
      { mailDomain: "virtu.email" },
    );
    expect(records.ownership).toEqual({
      type: "TXT",
      hostname: "user.com",
      value: "vt-verification=tok123",
    });
    expect(records.mx).toEqual([
      { type: "MX", hostname: "user.com", priority: 10, value: "mail.virtu.email." },
    ]);
    expect(records.spf.value).toBe("v=spf1 include:virtu.email ~all");
    expect(records.dkim).toEqual({
      type: "TXT",
      hostname: "dkim._domainkey.user.com",
      value: "v=DKIM1; k=rsa; p=PUBKEY",
    });
    expect(records.dmarc).toEqual({
      type: "TXT",
      hostname: "_dmarc.user.com",
      value: DMARC_RECORD,
    });
    expect(expectedMxExchanges("virtu.email")).toEqual(["mail.virtu.email"]);
  });

  test("dkim record is null before a key exists", () => {
    const records = expectedDnsRecords("user.com", "tok", null, { mailDomain: "virtu.email" });
    expect(records.dkim).toBeNull();
  });
});
