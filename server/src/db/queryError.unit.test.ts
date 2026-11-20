import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { DrizzleQueryError } from "drizzle-orm/errors";

const require = createRequire(import.meta.url);
const CommonJsQueryError = require("drizzle-orm/errors")
  .DrizzleQueryError as typeof DrizzleQueryError;

for (const [format, QueryError] of [
  ["ESM", DrizzleQueryError],
  ["CommonJS", CommonJsQueryError],
] as const) {
  test(`${format} query errors never format bound mail bodies`, () => {
    const body = new Uint8Array(1024 * 1024).fill(120);
    Object.defineProperty(body, Symbol.toPrimitive, {
      value: () => {
        throw new Error("Body must never be formatted");
      },
    });
    const params = [body, "private mail content"];
    Object.defineProperty(params, "toString", {
      value: () => {
        throw new Error("Parameter array must never be formatted");
      },
    });
    const cause = new Error("connection failed");
    const query = "INSERT INTO messages VALUES ('private inline content', $1)";
    const error = new QueryError(query, params, cause);
    expect(error.message.length).toBeLessThan(128);
    expect(String(error)).not.toContain("private mail content");
    expect(error.stack).not.toContain("private mail content");
    expect(error.stack).not.toContain("private inline content");
    expect(error.query).toBe(query);
    expect(error.params).toBe(params);
    expect(error.cause).toBe(cause);
  });
}
