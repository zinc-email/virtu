import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { booleanString, loadConfigFromEnv, toEnvKey } from "./env";

describe("toEnvKey", () => {
  test("camelCase -> SCREAMING_SNAKE", () => {
    expect(toEnvKey("databaseUrl")).toBe("DATABASE_URL");
    expect(toEnvKey("apiPort")).toBe("API_PORT");
    expect(toEnvKey("simple")).toBe("SIMPLE");
  });

  test("prefix is prepended verbatim", () => {
    expect(toEnvKey("databaseUrl", "APP_")).toBe("APP_DATABASE_URL");
  });
});

describe("loadConfigFromEnv", () => {
  const schema = z.object({
    databaseUrl: z.string().default("fallback"),
    apiPort: z.coerce.number().int().default(3000),
  });

  test("reads mapped env keys", () => {
    const config = loadConfigFromEnv(schema, "", {
      DATABASE_URL: "postgres://x",
      API_PORT: "4000",
    });
    expect(config).toEqual({ databaseUrl: "postgres://x", apiPort: 4000 });
  });

  test("applies defaults when keys are absent", () => {
    expect(loadConfigFromEnv(schema, "", {})).toEqual({ databaseUrl: "fallback", apiPort: 3000 });
  });

  test("treats empty strings as absent", () => {
    const config = loadConfigFromEnv(schema, "", { DATABASE_URL: "" });
    expect(config.databaseUrl).toBe("fallback");
  });

  test("fails loudly on invalid values", () => {
    expect(() => loadConfigFromEnv(schema, "", { API_PORT: "not-a-number" })).toThrow();
  });
});

describe("booleanString", () => {
  test("accepts the usual spellings, case-insensitive", () => {
    const schema = booleanString(false);
    expect(schema.parse("true")).toBe(true);
    expect(schema.parse("TRUE")).toBe(true);
    expect(schema.parse("1")).toBe(true);
    expect(schema.parse("yes")).toBe(true);
    expect(schema.parse("false")).toBe(false);
    expect(schema.parse(" 0 ")).toBe(false);
    expect(schema.parse("No")).toBe(false);
  });

  test("defaults when absent", () => {
    expect(booleanString(true).parse(undefined)).toBe(true);
    expect(booleanString(false).parse(undefined)).toBe(false);
  });

  test("rejects the z.coerce.boolean footgun input", () => {
    // "false" must parse to false (not truthy-coerce to true) and garbage
    // must throw rather than silently coerce.
    expect(booleanString(true).parse("false")).toBe(false);
    expect(() => booleanString(true).parse("banana")).toThrow();
  });
});
