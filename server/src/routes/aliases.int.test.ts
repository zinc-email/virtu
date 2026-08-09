// Alias surface int tests via app.inject() against the dockerized postgres.
// Prerequisites: `just up` + `just db push`. Parallel-safe: unique user per test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { aliases, contacts, emailLogs, users } from "../db/schema";
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

describe("GET /api/v5/alias/options", () => {
  test("returns signed suffixes and a prefix suggestion from hostname", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v5/alias/options?hostname=www.groupon.com",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      can_create: boolean;
      prefix_suggestion: string;
      suffixes: {
        suffix: string;
        signed_suffix: string;
        is_custom: boolean;
        is_premium: boolean;
      }[];
    }>();
    expect(body.can_create).toBe(true);
    expect(body.prefix_suggestion).toBe("groupon");
    expect(body.suffixes.length).toBeGreaterThan(0);
    const s = body.suffixes[0]!;
    expect(s.suffix).toMatch(/^\.[a-z0-9]{5}@/);
    expect(s.signed_suffix.startsWith(s.suffix)).toBe(true);
    expect(s.is_custom).toBe(false);
    expect(s.is_premium).toBe(false);
  });
});

describe("POST /api/v3/alias/custom/new", () => {
  test("creates an alias and returns serialize_alias_info_v2 + alias", async () => {
    const { apiKey } = await registerAndLogin(app);
    const options = await app.inject({
      method: "GET",
      url: "/api/v5/alias/options",
      headers: auth(apiKey),
    });
    const suffix = options.json<{ suffixes: { suffix: string; signed_suffix: string }[] }>()
      .suffixes[0]!;
    const mbs = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const mailbox = mbs.json<{ mailboxes: { id: number; email: string }[] }>().mailboxes[0]!;

    const res = await app.inject({
      method: "POST",
      url: "/api/v3/alias/custom/new",
      headers: auth(apiKey),
      payload: {
        alias_prefix: "groupon",
        signed_suffix: suffix.signed_suffix,
        mailbox_ids: [mailbox.id],
        note: "created by int test",
        name: "Group On",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body.alias).toBe(`groupon${suffix.suffix}`);
    expect(body.email).toBe(`groupon${suffix.suffix}`);
    expect(body.enabled).toBe(true);
    expect(body.note).toBe("created by int test");
    expect(body.name).toBe("Group On");
    expect(body.nb_forward).toBe(0);
    expect(body.nb_block).toBe(0);
    expect(body.nb_reply).toBe(0);
    expect(body.support_pgp).toBe(false);
    expect(body.disable_pgp).toBe(false);
    expect(body.pinned).toBe(false);
    expect(body.latest_activity).toBeNull();
    expect(body.mailbox).toEqual({ id: mailbox.id, email: mailbox.email });
    expect(body.mailboxes).toEqual([{ id: mailbox.id, email: mailbox.email }]);
    expect(typeof body.creation_timestamp).toBe("number");
    expect(body.creation_date).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00:00$/);
  });

  test("rejects a tampered suffix", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mbs = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const mailboxId = mbs.json<{ mailboxes: { id: number }[] }>().mailboxes[0]!.id;
    const res = await app.inject({
      method: "POST",
      url: "/api/v3/alias/custom/new",
      headers: auth(apiKey),
      payload: {
        alias_prefix: "x",
        signed_suffix: ".abc12@virtu.email.AAAA.BBBB",
        mailbox_ids: [mailboxId],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "Tampered suffix" });
  });

  test("409 when the alias already exists (and after deletion: tombstoned)", async () => {
    const { apiKey } = await registerAndLogin(app);
    const created = await createAlias(app, apiKey, { prefix: "dupe" });

    // Same prefix + a fresh signed suffix for the SAME suffix string is not
    // possible (suffixes are random per options call), so re-use the email
    // via the tombstone path: delete, then try to recreate the exact address.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/aliases/${created.id}`,
      headers: auth(apiKey),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>()).toEqual({ deleted: true });

    // Craft a signed suffix for the exact same suffix part using the server's
    // own signer (white-box, avoids waiting for a matching random suffix).
    const { SUFFIX_SIGNING_SECRET } = await import("./aliasConfig");
    const { signSuffix } = await import("./signedSuffix");
    const suffixPart = created.email.slice(created.email.indexOf("."));
    const res = await app.inject({
      method: "POST",
      url: "/api/v3/alias/custom/new",
      headers: auth(apiKey),
      payload: {
        alias_prefix: "dupe",
        signed_suffix: signSuffix(suffixPart, SUFFIX_SIGNING_SECRET),
        mailbox_ids: [created.mailboxId],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>()).toEqual({
      error: `alias ${created.email} already exists`,
    });
  });

  test("free plan limit: 400 with SimpleLogin's message once 5 aliases exist", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    // End the trial so the user is a plain free account.
    await db
      .update(users)
      .set({ trialEnd: new Date(Date.now() - 1000) })
      .where(eq(users.email, email));
    const userRow = (await db.select().from(users).where(eq(users.email, email)))[0]!;
    const mbs = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const mailboxId = mbs.json<{ mailboxes: { id: number }[] }>().mailboxes[0]!.id;
    // Seed 5 aliases directly (the API path would trip the 5/min creation
    // rate limit before the quota).
    for (let i = 0; i < 5; i++) {
      await db.insert(aliases).values({
        userId: userRow.id,
        email: `limit-${crypto.randomUUID()}@virtu.email`,
        mailboxId,
      });
    }
    const options = await app.inject({
      method: "GET",
      url: "/api/v5/alias/options",
      headers: auth(apiKey),
    });
    expect(options.json<{ can_create: boolean }>().can_create).toBe(false);

    const suffix = options.json<{ suffixes: { signed_suffix: string }[] }>().suffixes[0]!;
    const res = await app.inject({
      method: "POST",
      url: "/api/v3/alias/custom/new",
      headers: auth(apiKey),
      payload: {
        alias_prefix: "toomany",
        signed_suffix: suffix.signed_suffix,
        mailbox_ids: [mailboxId],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain(
      "limitation of a free account with the maximum of 5 aliases",
    );
  });
});

describe("POST /api/alias/random/new", () => {
  test("uuid mode", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/alias/random/new?mode=uuid",
      headers: auth(apiKey),
      payload: { note: "random uuid" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ alias: string; email: string; note: string }>();
    expect(body.alias).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}@virtu\.email$/);
    expect(body.email).toBe(body.alias);
    expect(body.note).toBe("random uuid");
  });

  test("word mode (default)", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/alias/random/new?mode=word",
      headers: auth(apiKey),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ alias: string }>().alias).toMatch(/^[a-z]+_[a-z]+\d{3}@virtu\.email$/);
  });

  test("invalid mode -> SimpleLogin error string", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/alias/random/new?mode=banana",
      headers: auth(apiKey),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "banana must be either word or uuid" });
  });
});

describe("GET /api/v2/aliases", () => {
  test("requires page_id", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/v2/aliases",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "page_id must be provided in request query",
    });
  });

  test("lists aliases with filters and search", async () => {
    const { apiKey } = await registerAndLogin(app);
    const a1 = await createAlias(app, apiKey, { note: "needle-note" });
    const a2 = await createAlias(app, apiKey);

    // Disable a2.
    await app.inject({
      method: "POST",
      url: `/api/aliases/${a2.id}/toggle`,
      headers: auth(apiKey),
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/v2/aliases?page_id=0",
      headers: auth(apiKey),
    });
    expect(all.statusCode).toBe(200);
    const allAliases = all.json<{ aliases: { id: number }[] }>().aliases;
    expect(allAliases.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());

    const disabled = await app.inject({
      method: "GET",
      url: "/api/v2/aliases?page_id=0&disabled",
      headers: auth(apiKey),
    });
    expect(disabled.json<{ aliases: { id: number }[] }>().aliases.map((x) => x.id)).toEqual([
      a2.id,
    ]);

    const enabled = await app.inject({
      method: "GET",
      url: "/api/v2/aliases?page_id=0&enabled",
      headers: auth(apiKey),
    });
    expect(enabled.json<{ aliases: { id: number }[] }>().aliases.map((x) => x.id)).toEqual([a1.id]);

    const pinned = await app.inject({
      method: "GET",
      url: "/api/v2/aliases?page_id=0&pinned",
      headers: auth(apiKey),
    });
    expect(pinned.json<{ aliases: unknown[] }>().aliases).toEqual([]);

    const search = await app.inject({
      method: "POST",
      url: "/api/v2/aliases?page_id=0",
      headers: auth(apiKey),
      payload: { query: "needle-note" },
    });
    expect(search.json<{ aliases: { id: number }[] }>().aliases.map((x) => x.id)).toEqual([a1.id]);
  });

  test("does not leak other users' aliases", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const aliasA = await createAlias(app, alice.apiKey);

    const bobList = await app.inject({
      method: "GET",
      url: "/api/v2/aliases?page_id=0",
      headers: auth(bob.apiKey),
    });
    expect(bobList.json<{ aliases: { id: number }[] }>().aliases).toEqual([]);

    const bobGet = await app.inject({
      method: "GET",
      url: `/api/aliases/${aliasA.id}`,
      headers: auth(bob.apiKey),
    });
    expect(bobGet.statusCode).toBe(403);
    expect(bobGet.json<{ error: string }>()).toEqual({ error: "Forbidden" });
  });
});

describe("PUT/PATCH /api/aliases/:id", () => {
  test("updates note and name; accepts-but-ignores disable_pgp and pinned", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/aliases/${alias.id}`,
      headers: auth(apiKey),
      payload: { note: "new note", name: "New\nName", disable_pgp: true, pinned: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ ok: boolean }>()).toEqual({ ok: true });

    const get = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}`,
      headers: auth(apiKey),
    });
    const body = get.json<{ note: string; name: string; disable_pgp: boolean; pinned: boolean }>();
    expect(body.note).toBe("new note");
    expect(body.name).toBe("NewName"); // linebreaks stripped like SimpleLogin
    expect(body.disable_pgp).toBe(false);
    expect(body.pinned).toBe(false);
  });

  test("empty body -> SimpleLogin's dev error", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const res = await app.inject({
      method: "PUT",
      url: `/api/aliases/${alias.id}`,
      headers: auth(apiKey),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({ error: "request body cannot be empty" });
  });
});

describe("POST /api/aliases/:id/toggle", () => {
  test("flips enabled", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const off = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/toggle`,
      headers: auth(apiKey),
    });
    expect(off.statusCode).toBe(200);
    expect(off.json<{ enabled: boolean }>()).toEqual({ enabled: false });
    const on = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/toggle`,
      headers: auth(apiKey),
    });
    expect(on.json<{ enabled: boolean }>()).toEqual({ enabled: true });
  });
});

describe("GET /api/aliases/:id/activities", () => {
  test("serializes email logs as forward/reply/block/bounced", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const userRow = (await db.select().from(users).where(eq(users.email, email)))[0]!;

    // Contact via the API (mints the reverse alias).
    const contactRes = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "Marketing <marketing@example.com>" },
    });
    expect(contactRes.statusCode).toBe(201);
    const contact = contactRes.json<{ id: number; reverse_alias_address: string }>();

    // Seed one log of each kind directly (the mail pipeline isn't wired yet).
    const base = { userId: userRow.id, contactId: contact.id, aliasId: alias.id };
    await db.insert(emailLogs).values([
      { ...base, isReply: false }, // forward
      { ...base, isReply: true }, // reply
      { ...base, isReply: false, blocked: true }, // block
      { ...base, isReply: false, bounced: true }, // bounced
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}/activities?page_id=0`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const activities = res.json<{
      activities: {
        action: string;
        from: string;
        to: string;
        reverse_alias: string;
        reverse_alias_address: string;
      }[];
    }>().activities;
    expect(activities).toHaveLength(4);
    expect(activities.map((a) => a.action).sort()).toEqual(
      ["block", "bounced", "forward", "reply"].sort(),
    );
    const reply = activities.find((a) => a.action === "reply")!;
    expect(reply.from).toBe(alias.email);
    expect(reply.to).toBe("marketing@example.com");
    const forward = activities.find((a) => a.action === "forward")!;
    expect(forward.from).toBe("marketing@example.com");
    expect(forward.to).toBe(alias.email);
    expect(forward.reverse_alias).toBe(
      `"Marketing | marketing at example.com" <${contact.reverse_alias_address}>`,
    );

    // Counts + latest_activity surface on the alias too (construct_alias_query
    // semantics: bounces count as forwards).
    const get = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}`,
      headers: auth(apiKey),
    });
    const aliasBody = get.json<{
      nb_forward: number;
      nb_block: number;
      nb_reply: number;
      latest_activity: { contact: { email: string } };
    }>();
    expect(aliasBody.nb_forward).toBe(2);
    expect(aliasBody.nb_block).toBe(1);
    expect(aliasBody.nb_reply).toBe(1);
    expect(aliasBody.latest_activity?.contact.email).toBe("marketing@example.com");
  });
});

describe("DELETE /api/aliases/:id", () => {
  test("deletes and cascades contacts", async () => {
    const { apiKey } = await registerAndLogin(app);
    const alias = await createAlias(app, apiKey);
    const contactRes = await app.inject({
      method: "POST",
      url: `/api/aliases/${alias.id}/contacts`,
      headers: auth(apiKey),
      payload: { contact: "someone@example.com" },
    });
    const contactId = contactRes.json<{ id: number }>().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/aliases/${alias.id}`,
      headers: auth(apiKey),
    });
    expect(del.statusCode).toBe(200);

    const gone = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(gone).toEqual([]);

    const get = await app.inject({
      method: "GET",
      url: `/api/aliases/${alias.id}`,
      headers: auth(apiKey),
    });
    expect(get.statusCode).toBe(403);
  });
});

describe("alias creation rate limit", () => {
  test("6th creation attempt within a minute -> 429", async () => {
    const { apiKey } = await registerAndLogin(app);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v3/alias/custom/new",
        headers: auth(apiKey),
        payload: { alias_prefix: "x", signed_suffix: "garbage", mailbox_ids: [] },
      });
      last = res.statusCode;
    }
    expect(last).toBe(429);
  });
});
