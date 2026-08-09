import { describe, expect, test } from "bun:test";
import {
  checkAliasPrefix,
  convertToId,
  formatCreationDate,
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
