import { describe, expect, test } from "bun:test";
import { assertProductionSecrets } from "./config.ts";

const INSECURE = {
  verpSecret: "insecure-dev-verp-secret-change-me-00",
  databaseUrl: "postgres://virtu:virtu@localhost:5432/virtu",
};
const SECURE = {
  verpSecret: "a-real-32-char-minimum-secret-value-xx",
  databaseUrl: "postgres://virtu:strongpw@db:5432/virtu",
};

describe("assertProductionSecrets", () => {
  test("no-op when not in production, even with insecure defaults", () => {
    expect(() => assertProductionSecrets(INSECURE, {})).not.toThrow();
    expect(() => assertProductionSecrets(INSECURE, { NODE_ENV: "development" })).not.toThrow();
  });

  test("throws in production on the known VERP_SECRET default", () => {
    expect(() => assertProductionSecrets(INSECURE, { VIRTU_ENV: "production" })).toThrow(
      /VERP_SECRET/,
    );
  });

  test("throws in production on the known DATABASE_URL default", () => {
    expect(() =>
      assertProductionSecrets(
        { verpSecret: SECURE.verpSecret, databaseUrl: INSECURE.databaseUrl },
        { NODE_ENV: "production" },
      ),
    ).toThrow(/DATABASE_URL/);
  });

  test("passes in production with real secrets", () => {
    expect(() => assertProductionSecrets(SECURE, { VIRTU_ENV: "production" })).not.toThrow();
  });
});
