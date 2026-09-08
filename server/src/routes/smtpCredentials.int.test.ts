// SMTP credential routes int tests (per-device submission passwords).
// Prerequisites: `just up` (migrates on boot).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { verifyCredentials } from "../submission";
import { db } from "../db";
import { registerAndLogin } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

interface CreatedCredential {
  id: number;
  name: string;
  password: string;
  creation_timestamp: number;
  last_used_timestamp: number | null;
}

async function createCredential(apiKey: string, name: string): Promise<CreatedCredential> {
  const res = await app.inject({
    method: "POST",
    url: "/api/smtp/credentials",
    headers: auth(apiKey),
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`create credential failed: ${res.body}`);
  return res.json<CreatedCredential>();
}

describe("POST /api/smtp/credentials", () => {
  test("creates a credential; the password appears once and never in the list", async () => {
    const { apiKey } = await registerAndLogin(app);
    const created = await createCredential(apiKey, "Phone");

    expect(created.name).toBe("Phone");
    // app-password shape: 4 dash-separated groups of 5
    expect(created.password).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    expect(created.last_used_timestamp).toBeNull();

    const list = await app.inject({
      method: "GET",
      url: "/api/smtp/credentials",
      headers: auth(apiKey),
    });
    expect(list.statusCode).toBe(200);
    const { credentials } = list.json<{ credentials: Record<string, unknown>[] }>();
    expect(credentials.map((c) => c.id)).toContain(created.id);
    for (const c of credentials) expect(c).not.toContainKey("password");
  });
});

describe("SMTP AUTH against credentials (verifyCredentials)", () => {
  test("device password authenticates; revoking it stops working; others unaffected", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const phone = await createCredential(apiKey, "Phone");
    const laptop = await createCredential(apiKey, "Laptop");

    // Both device passwords authenticate; nothing else does — the account
    // itself has no password.
    expect(await verifyCredentials({ db }, email, phone.password)).toBe("ok");
    expect(await verifyCredentials({ db }, email, laptop.password)).toBe("ok");
    expect(await verifyCredentials({ db }, email, "wrong-password")).toBe("invalid");

    // A successful device AUTH stamps last_used_timestamp.
    const list = await app.inject({
      method: "GET",
      url: "/api/smtp/credentials",
      headers: auth(apiKey),
    });
    const rows = list.json<{ credentials: { id: number; last_used_timestamp: number | null }[] }>()
      .credentials;
    expect(rows.find((c) => c.id === phone.id)?.last_used_timestamp).not.toBeNull();

    // Revoke the phone: it stops authenticating, the laptop keeps working
    // (independent revocation is the point).
    const del = await app.inject({
      method: "DELETE",
      url: `/api/smtp/credentials/${phone.id}`,
      headers: auth(apiKey),
    });
    expect(del.statusCode).toBe(200);
    expect(await verifyCredentials({ db }, email, phone.password)).toBe("invalid");
    expect(await verifyCredentials({ db }, email, laptop.password)).toBe("ok");
  });

  test("partial pastes fail: the first group is part of the password", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const cred = await createCredential(apiKey, "Phone");

    // Missing the selector group, selector alone, or an undashed mash all
    // refuse — only the whole pasted password authenticates.
    const secretOnly = cred.password.slice(cred.password.indexOf("-") + 1);
    expect(await verifyCredentials({ db }, email, secretOnly)).toBe("invalid");
    expect(await verifyCredentials({ db }, email, cred.password.slice(0, 5))).toBe("invalid");
    expect(await verifyCredentials({ db }, email, cred.password.replaceAll("-", ""))).toBe(
      "invalid",
    );
    expect(await verifyCredentials({ db }, email, cred.password)).toBe("ok");
  });

  // No "selectorless row" test: smtp_credentials.selector is NOT NULL since
  // migration 0002 (which also deletes every pre-selector row), so the
  // dead-credential class is unrepresentable at the schema level — a
  // stronger pin than any test could be.

  test("credentials never cross accounts", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const cred = await createCredential(alice.apiKey, "Phone");

    // Bob can't use Alice's device password…
    expect(await verifyCredentials({ db }, bob.email, cred.password)).toBe("invalid");

    // …and can't revoke it either (403, not found-for-you).
    const del = await app.inject({
      method: "DELETE",
      url: `/api/smtp/credentials/${cred.id}`,
      headers: auth(bob.apiKey),
    });
    expect(del.statusCode).toBe(403);
  });
});
