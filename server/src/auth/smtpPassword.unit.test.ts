import { describe, expect, test } from "bun:test";
import { generateSmtpPassword, splitSmtpPassword, verifyAgainstDummy } from "./smtpPassword";

describe("generateSmtpPassword", () => {
  test("four dash-separated groups of five, unambiguous alphabet", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateSmtpPassword()).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    }
  });

  test("splits back into a 5-char selector and the remaining groups", () => {
    const password = generateSmtpPassword();
    const split = splitSmtpPassword(password);
    expect(split).not.toBeNull();
    expect(split!.selector).toHaveLength(5);
    expect(split!.secret).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){2}$/);
    expect(`${split!.selector}-${split!.secret}`).toBe(password);
  });
});

describe("splitSmtpPassword", () => {
  test("splits on the FIRST dash only", () => {
    expect(splitSmtpPassword("aaaaa-bbbbb-ccccc-ddddd")).toEqual({
      selector: "aaaaa",
      secret: "bbbbb-ccccc-ddddd",
    });
  });

  test("null when either half would be empty", () => {
    expect(splitSmtpPassword("")).toBeNull();
    expect(splitSmtpPassword("nodashes")).toBeNull();
    expect(splitSmtpPassword("-secret")).toBeNull();
    expect(splitSmtpPassword("selector-")).toBeNull();
    expect(splitSmtpPassword("-")).toBeNull();
  });
});

describe("verifyAgainstDummy", () => {
  test("always false, and costs a real argon2id verify", async () => {
    const start = performance.now();
    expect(await verifyAgainstDummy("whatever")).toBe(false);
    expect(await verifyAgainstDummy("")).toBe(false);
    // argon2id is deliberately slow; two verifies in well under a
    // millisecond would mean the dummy path is being skipped.
    expect(performance.now() - start).toBeGreaterThan(1);
  });
});
