// Route tests via app.inject() against the dockerized postgres.
//
// Prerequisites: `just up` (db on localhost:5432) + `just db push`.
// Run: `just test-int` (or `cd server && bun test int.test`).
//
// Parallel-safe by construction (madi RFC 0003): every test registers its own
// unique user (random localpart), nothing truncates, no ordering constraints.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../app/server";
import { buildApp } from "../app/server";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const uniqueEmail = () => `it-${crypto.randomUUID()}@int.test`;
const PASSWORD = "correct horse battery staple";

async function register(email: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: PASSWORD },
  });
}

async function login(email: string, password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password, device: "int-test" },
  });
}

describe("register -> login -> user_info round trip", () => {
  test("happy path", async () => {
    const email = uniqueEmail();

    const reg = await register(email);
    expect(reg.statusCode).toBe(200);
    expect(reg.json<{ msg: string }>()).toEqual({ msg: "User needs to confirm their account" });

    const log = await login(email);
    expect(log.statusCode).toBe(200);
    const body = log.json<{
      name: string;
      email: string;
      mfa_enabled: boolean;
      mfa_key: string | null;
      api_key: string;
    }>();
    expect(body.email).toBe(email);
    expect(body.mfa_enabled).toBe(false);
    expect(body.mfa_key).toBeNull();
    expect(typeof body.api_key).toBe("string");

    const info = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: { authentication: body.api_key },
    });
    expect(info.statusCode).toBe(200);
    const user = info.json<{
      email: string;
      in_trial: boolean;
      is_premium: boolean;
      trial_end_timestamp: number | null;
      max_alias_free_plan: number;
      connected_proton_address: string | null;
      profile_picture_url: string | null;
    }>();
    expect(user.email).toBe(email);
    expect(user.in_trial).toBe(true);
    expect(user.is_premium).toBe(true); // trial grants premium (SimpleLogin semantics)
    expect(typeof user.trial_end_timestamp).toBe("number");
    expect(user.max_alias_free_plan).toBe(5);
    expect(user.connected_proton_address).toBeNull();
    expect(user.profile_picture_url).toBeNull();
  });
});

describe("POST /api/auth/register", () => {
  test("rejects a duplicate email with SimpleLogin's error string", async () => {
    const email = uniqueEmail();
    await register(email);
    const dup = await register(email);
    expect(dup.statusCode).toBe(400);
    expect(dup.json<{ error: string }>()).toEqual({
      error: `cannot use ${email} as personal inbox`,
    });
  });

  test("rejects a short password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: uniqueEmail(), password: "short" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "password too short" });
  });

  test("rejects a non-email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "not-an-email", password: PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "cannot use not-an-email as personal inbox",
    });
  });
});

describe("POST /api/auth/login", () => {
  test("wrong password and unknown user get the same generic 400", async () => {
    const email = uniqueEmail();
    await register(email);

    const wrongPassword = await login(email, "wrong-password");
    expect(wrongPassword.statusCode).toBe(400);
    expect(wrongPassword.json<{ error: string }>()).toEqual({
      error: "Email or password incorrect",
    });

    const unknownUser = await login(uniqueEmail());
    expect(unknownUser.statusCode).toBe(400);
    expect(unknownUser.json<{ error: string }>()).toEqual({ error: "Email or password incorrect" });
  });
});

describe("GET /api/user_info auth hook", () => {
  test("missing key -> 401 with SimpleLogin's error string", async () => {
    const res = await app.inject({ method: "GET", url: "/api/user_info" });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>()).toEqual({ error: "Wrong api key" });
  });

  test("garbage key -> 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: { authentication: "not-a-real-key" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: string }>()).toEqual({ error: "Wrong api key" });
  });
});
