import { describe, expect, test } from "bun:test";
import {
  checkAliasPrefix,
  convertToId,
  formatCreationDate,
  isReservedAliasPrefix,
  prefixSuggestionFromHostname,
  randomString,
  websiteSendTo,
} from "./aliasText";

describe("convertToId", () => {
  test("lowercases, strips spaces and specials", () => {
    expect(convertToId("Hello World!")).toBe("helloworld");
    expect(convertToId("Group-On_2.0")).toBe("group-on_2.0");
  });
  test("truncates to 64", () => {
    expect(convertToId("a".repeat(100))).toHaveLength(64);
  });
});

describe("checkAliasPrefix", () => {
  test("accepts SimpleLogin's pattern", () => {
    expect(checkAliasPrefix("news.site_1-a")).toBe(true);
  });
  test("rejects uppercase, empty, overlong, specials", () => {
    expect(checkAliasPrefix("")).toBe(false);
    expect(checkAliasPrefix("Nope")).toBe(false);
    expect(checkAliasPrefix("a".repeat(41))).toBe(false);
    expect(checkAliasPrefix("a b")).toBe(false);
  });
});

describe("isReservedAliasPrefix", () => {
  test("reserves the bare word and word + separator", () => {
    expect(isReservedAliasPrefix("noreply")).toBe(true);
    expect(isReservedAliasPrefix("no-reply")).toBe(true);
    expect(isReservedAliasPrefix("support.us")).toBe(true);
    expect(isReservedAliasPrefix("billing-2")).toBe(true);
    expect(isReservedAliasPrefix("admin_eu")).toBe(true);
    expect(isReservedAliasPrefix("zinc")).toBe(true);
  });

  test("reserves separator, digit-look-alike and digit-padding variants", () => {
    expect(isReservedAliasPrefix("no.reply")).toBe(true);
    expect(isReservedAliasPrefix("do_not_reply")).toBe(true);
    expect(isReservedAliasPrefix("s.u.p.p.o.r.t")).toBe(true);
    expect(isReservedAliasPrefix("supp0rt")).toBe(true);
    expect(isReservedAliasPrefix("b1lling")).toBe(true);
    expect(isReservedAliasPrefix("secur1ty")).toBe(true);
    expect(isReservedAliasPrefix("admin2")).toBe(true);
    expect(isReservedAliasPrefix("noreply2")).toBe(true);
    expect(isReservedAliasPrefix("billing2024")).toBe(true);
    expect(isReservedAliasPrefix("supp0rt.eu")).toBe(true);
  });

  test("folds in extra words (config.operatorLocalparts)", () => {
    expect(isReservedAliasPrefix("dmarc", ["dmarc"])).toBe(true);
    expect(isReservedAliasPrefix("dmarc.reports", ["dmarc"])).toBe(true);
    expect(isReservedAliasPrefix("dmarc", [])).toBe(false);
  });

  test("honest prefixes that merely contain a reserved word pass", () => {
    expect(isReservedAliasPrefix("supportive")).toBe(false);
    expect(isReservedAliasPrefix("adminton")).toBe(false);
    expect(isReservedAliasPrefix("groupon")).toBe(false);
    expect(isReservedAliasPrefix("my-support")).toBe(false);
    expect(isReservedAliasPrefix("teams")).toBe(false);
    expect(isReservedAliasPrefix("account4u")).toBe(false);
  });
});

describe("prefixSuggestionFromHostname", () => {
  test("www.groupon.com -> groupon", () => {
    expect(prefixSuggestionFromHostname("www.groupon.com")).toBe("groupon");
  });
  test("news.bbc.co.uk -> bbc", () => {
    expect(prefixSuggestionFromHostname("news.bbc.co.uk")).toBe("bbc");
  });
  test("localhost -> localhost", () => {
    expect(prefixSuggestionFromHostname("localhost")).toBe("localhost");
  });
});

describe("formatCreationDate", () => {
  test("arrow default format, UTC", () => {
    expect(formatCreationDate(new Date(1586195834000))).toBe("2020-04-06 17:57:14+00:00");
  });
});

describe("randomString", () => {
  test("length and alphabet", () => {
    const s = randomString(30, true);
    expect(s).toHaveLength(30);
    expect(s).toMatch(/^[a-z0-9]+$/);
    expect(randomString(30)).toMatch(/^[a-z]+$/);
  });
});

describe("websiteSendTo", () => {
  test("no name: quoted at-form", () => {
    expect(
      websiteSendTo({ name: null, websiteEmail: "c1@example.com", replyEmail: "re1@virtu.email" }),
    ).toBe('"c1 at example.com" <re1@virtu.email>');
  });
  test("with name: name | at-form", () => {
    expect(
      websiteSendTo({
        name: 'First "Last"',
        websiteEmail: "first@example.com",
        replyEmail: "ra@virtu.email",
      }),
    ).toBe('"First Last | first at example.com" <ra@virtu.email>');
  });
});
