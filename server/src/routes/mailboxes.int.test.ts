// Mailbox routes int tests. Prerequisites: `just up` + `just db push`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { createAlias, registerAndLogin, uniqueEmail } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

async function createMailbox(apiKey: string, email = uniqueEmail()) {
  const res = await app.inject({
    method: "POST",
    url: "/api/mailboxes",
    headers: auth(apiKey),
    payload: { email },
  });
  if (res.statusCode !== 201) throw new Error(`create mailbox failed: ${res.body}`);
  return res.json<{ id: number; email: string; verified: boolean; default: boolean }>();
}

describe("GET /api/v2/mailboxes", () => {
  test("registration seeds the default mailbox", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const mbs = res.json<{
      mailboxes: {
        email: string;
        default: boolean;
        verified: boolean;
        nb_alias: number;
        creation_timestamp: number;
      }[];
    }>().mailboxes;
    expect(mbs).toHaveLength(1);
    expect(mbs[0]!.email).toBe(email);
    expect(mbs[0]!.default).toBe(true);
    expect(mbs[0]!.verified).toBe(true);
    expect(mbs[0]!.nb_alias).toBe(0);
    expect(typeof mbs[0]!.creation_timestamp).toBe("number");
  });
});

describe("POST /api/mailboxes", () => {
  test("creates a mailbox (MVP: verified immediately) and counts aliases", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createMailbox(apiKey);
    expect(mb.verified).toBe(true);
    expect(mb.default).toBe(false);

    await createAlias(app, apiKey);
    const list = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const rows = list.json<{ mailboxes: { id: number; nb_alias: number }[] }>().mailboxes;
    expect(rows.find((m) => m.id !== mb.id)?.nb_alias).toBe(1);
    expect(rows.find((m) => m.id === mb.id)?.nb_alias).toBe(0);
  });

  test("rejects invalid, duplicate, and alias-domain addresses", async () => {
    const { email, apiKey } = await registerAndLogin(app);

    const bad = await app.inject({
      method: "POST",
      url: "/api/mailboxes",
      headers: auth(apiKey),
      payload: { email: "nope" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>()).toEqual({ error: "Invalid email" });

    const dup = await app.inject({
      method: "POST",
      url: "/api/mailboxes",
      headers: auth(apiKey),
      payload: { email },
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json<{ error: string }>()).toEqual({ error: "Email already used" });

    const aliasDomain = await app.inject({
      method: "POST",
      url: "/api/mailboxes",
      headers: auth(apiKey),
      payload: { email: "self@virtu.email" },
    });
    expect(aliasDomain.statusCode).toBe(400);
    expect(aliasDomain.json<{ error: string }>()).toEqual({ error: "Invalid email" });
  });
});

describe("PUT /api/mailboxes/:id", () => {
  test("sets the default mailbox", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createMailbox(apiKey);
    const res = await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { default: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ updated: boolean }>()).toEqual({ updated: true });

    const list = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const rows = list.json<{ mailboxes: { id: number; default: boolean }[] }>().mailboxes;
    expect(rows.find((m) => m.id === mb.id)?.default).toBe(true);
    expect(rows.filter((m) => m.default)).toHaveLength(1);
  });

  test("email change is not supported yet", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createMailbox(apiKey);
    const res = await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { email: uniqueEmail() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("DELETE /api/mailboxes/:id", () => {
  test("cannot delete the default mailbox", async () => {
    const { apiKey } = await registerAndLogin(app);
    const list = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const def = list.json<{ mailboxes: { id: number }[] }>().mailboxes[0]!;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailboxes/${def.id}`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "Cannot delete your default mailbox" });
  });

  test("transfers aliases to another mailbox", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createMailbox(apiKey);
    await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { default: true },
    });
    // Alias created on the (new default) mailbox mb.
    const list = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const original = list
      .json<{ mailboxes: { id: number; default: boolean }[] }>()
      .mailboxes.find((m) => !m.default)!;

    // createAlias uses the first mailbox from /v2/mailboxes: pin it to mb by
    // creating via custom/new with explicit mailbox id instead.
    const options = await app.inject({
      method: "GET",
      url: "/api/v5/alias/options",
      headers: auth(apiKey),
    });
    const suffix = options.json<{ suffixes: { signed_suffix: string }[] }>().suffixes[0]!;
    const created = await app.inject({
      method: "POST",
      url: "/api/v3/alias/custom/new",
      headers: auth(apiKey),
      payload: {
        alias_prefix: "movable",
        signed_suffix: suffix.signed_suffix,
        mailbox_ids: [mb.id],
      },
    });
    expect(created.statusCode).toBe(201);
    const aliasId = created.json<{ id: number }>().id;

    // Make `original` default again so mb becomes deletable.
    await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${original.id}`,
      headers: auth(apiKey),
      payload: { default: true },
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { transfer_aliases_to: original.id },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>()).toEqual({ deleted: true });

    const alias = await app.inject({
      method: "GET",
      url: `/api/aliases/${aliasId}`,
      headers: auth(apiKey),
    });
    expect(alias.statusCode).toBe(200);
    expect(alias.json<{ mailbox: { id: number } }>().mailbox.id).toBe(original.id);
  });

  test("deletes aliases (tombstoned) when not transferring", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createMailbox(apiKey);
    const options = await app.inject({
      method: "GET",
      url: "/api/v5/alias/options",
      headers: auth(apiKey),
    });
    const suffix = options.json<{ suffixes: { signed_suffix: string }[] }>().suffixes[0]!;
    const created = await app.inject({
      method: "POST",
      url: "/api/v3/alias/custom/new",
      headers: auth(apiKey),
      payload: {
        alias_prefix: "doomed",
        signed_suffix: suffix.signed_suffix,
        mailbox_ids: [mb.id],
      },
    });
    const aliasId = created.json<{ id: number }>().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { transfer_aliases_to: -1 },
    });
    expect(del.statusCode).toBe(200);

    const alias = await app.inject({
      method: "GET",
      url: `/api/aliases/${aliasId}`,
      headers: auth(apiKey),
    });
    expect(alias.statusCode).toBe(403);
  });

  test("transfer target must be your own mailbox", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const aliceMb = await createMailbox(alice.apiKey);
    const bobList = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(bob.apiKey),
    });
    const bobMb = bobList.json<{ mailboxes: { id: number }[] }>().mailboxes[0]!;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/mailboxes/${aliceMb.id}`,
      headers: auth(alice.apiKey),
      payload: { transfer_aliases_to: bobMb.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "You must transfer the aliases to a mailbox you own",
    });
  });
});
