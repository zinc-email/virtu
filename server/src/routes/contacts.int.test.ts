// Contact routes int tests. Prerequisites: `just up` (migrates on boot).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { createAlias, registerAndLogin } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

describe("POST /api/aliases/:id/contacts", () => {
  test("creates a contact with a minted reverse alias", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);

    const res = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "First Last <first@example.com>" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body.contact).toBe("first@example.com");
    expect(body.existed).toBe(false);
    expect(body.block_forward).toBe(false);
    expect(body.last_email_sent_date).toBeNull();
    expect(body.last_email_sent_timestamp).toBeNull();
    // Pipeline reverse-alias format: {sanitized}_at_{domain}_{random8}@mailDomain
    // (shared with the forward pipeline via src/pipeline/contacts.ts).
    expect(body.reverse_alias_address).toMatch(/^[a-z0-9_-]+_[a-z0-9]{8}@virtu\.email$/);
    expect(body.reverse_alias).toBe(
      `"First Last | first at example.com" <${body.reverse_alias_address}>`,
    );
  });

  test("duplicate -> 200 with existed=true", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const first = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "dup@example.com" },
    });
    expect(first.statusCode).toBe(201);
    const again = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "dup@example.com" },
    });
    expect(again.statusCode).toBe(200);
    const body = again.json<{ id: number; existed: boolean }>();
    expect(body.existed).toBe(true);
    expect(body.id).toBe(first.json<{ id: number }>().id);
  });

  test("invalid address -> 400", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const res = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "not-an-email is not a valid email address",
    });
  });

  test("cannot create a contact for a reverse alias", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const first = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "real@example.com" },
    });
    const reverse = first.json<{ reverse_alias_address: string }>().reverse_alias_address;
    const res = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: reverse },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "You can't create contact for a reverse alias",
    });
  });

  test("another user's alias -> 403 Forbidden", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const alias = await createAlias(app, alice.apiKey);
    const res = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(bob.apiKey),
      payload: { contact: "x@example.com" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>()).toEqual({ error: "Forbidden" });
  });
});

describe("GET /api/aliases/:id/contacts", () => {
  test("requires page_id and paginates newest-first", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);

    const noPage = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
    });
    expect(noPage.statusCode).toBe(400);

    for (const addr of ["a@example.com", "b@example.com", "c@example.com"]) {
      await app.inject({
        method: "POST",
        url: `/api/aliases/${alias.id}/contacts`,
        headers: auth(apiKey),
        payload: { contact: addr },
      });
    }
    const res = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}/contacts?page_id=0`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json<{ contacts: { contact: string; existed: boolean }[] }>().contacts;
    expect(list.map((c) => c.contact)).toEqual(["c@example.com", "b@example.com", "a@example.com"]);
    expect(list.every((c) => c.existed === false)).toBe(true);
  });

  test("unknown alias -> 404", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/aliases/999999999/contacts?page_id=0",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>()).toEqual({ error: "No such alias" });
  });
});

describe("POST /api/contacts/:id/toggle + DELETE /api/contacts/:id", () => {
  test("block, unblock, delete", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const created = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "toggle@example.com" },
    });
    const contactId = created.json<{ id: number }>().id;

    const block = await app.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/toggle`,
      headers: auth(apiKey),
    });
    expect(block.statusCode).toBe(200);
    expect(block.json<{ block_forward: boolean }>()).toEqual({ block_forward: true });

    const unblock = await app.inject({
      method: "POST",
      url: `/api/contacts/${contactId}/toggle`,
      headers: auth(apiKey),
    });
    expect(unblock.json<{ block_forward: boolean }>()).toEqual({ block_forward: false });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/contacts/${contactId}`,
      headers: auth(apiKey),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>()).toEqual({ deleted: true });

    const after = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}/contacts?page_id=0`,
      headers: auth(apiKey),
    });
    expect(after.json<{ contacts: unknown[] }>().contacts).toEqual([]);
  });

  test("someone else's contact -> 403", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const alias = await createAlias(app, alice.apiKey);
    const created = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(alice.apiKey),
      payload: { contact: "priv@example.com" },
    });
    const contactId = created.json<{ id: number }>().id;

    for (const [method, url] of [
      ["DELETE", `/api/contacts/${contactId}`],
      ["POST", `/api/contacts/${contactId}/toggle`],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(bob.apiKey) });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>()).toEqual({ error: "Forbidden" });
    }
  });
});
