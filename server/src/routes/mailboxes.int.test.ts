// Mailbox routes int tests. Prerequisites: `just up` (migrates on boot).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { domains, notifications, users } from "../db/schema";
import { suppressMailbox } from "../pipeline/suppression";
import { createAlias, latestEmailedCode, registerAndLogin, uniqueEmail } from "./intHarness";

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

async function verifyMailbox(apiKey: string, mailboxId: number, email: string) {
  const res = await app.inject({
    method: "POST",
    url: `/api/mailboxes/${mailboxId}/verify`,
    headers: auth(apiKey),
    payload: { code: await latestEmailedCode(email) },
  });
  if (res.statusCode !== 200) throw new Error(`verify mailbox failed: ${res.body}`);
  return res.json<{ id: number; email: string; verified: boolean; default: boolean }>();
}

async function createVerifiedMailbox(apiKey: string, email = uniqueEmail()) {
  const mb = await createMailbox(apiKey, email);
  return verifyMailbox(apiKey, mb.id, email);
}

describe("GET /api/v2/mailboxes", () => {
  test("registration seeds the default mailbox, already verified", async () => {
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
  test("creates an unverified mailbox; the emailed code verifies it", async () => {
    const { apiKey } = await registerAndLogin(app);
    const email = uniqueEmail();
    const mb = await createMailbox(apiKey, email);
    expect(mb.verified).toBe(false);
    expect(mb.default).toBe(false);

    const verified = await verifyMailbox(apiKey, mb.id, email);
    expect(verified.verified).toBe(true);

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

  test("refuses a mailbox on a custom domain whose MX is us (forwarding loop setup)", async () => {
    // The loop: a mailbox on a served domain gets its forwards routed
    // straight back through our mx. Anyone's served domain counts — the
    // two-account ring is the same loop — so the owner here is a stranger.
    const { apiKey } = await registerAndLogin(app);
    const owner = await registerAndLogin(app);
    const ownerRow = (await db.select().from(users).where(eq(users.email, owner.email)))[0]!;
    const served = `s${crypto.randomUUID().slice(0, 8)}.example.com`;
    await db.insert(domains).values({
      userId: ownerRow.id,
      nameRequested: served,
      verifiedOwner: true,
      verifiedMx: true,
    });

    const refused = await app.inject({
      method: "POST",
      url: "/api/mailboxes",
      headers: auth(apiKey),
      payload: { email: `inbox@${served}` },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: string }>()).toEqual({ error: "Invalid email" });

    // A claimed-but-unverified domain (no MX at us) is still a fine mailbox
    // provider: the refusal keys on verified_mx, not on the claim.
    const claimed = `c${crypto.randomUUID().slice(0, 8)}.example.com`;
    await db.insert(domains).values({ userId: ownerRow.id, nameRequested: claimed });
    const allowed = await app.inject({
      method: "POST",
      url: "/api/mailboxes",
      headers: auth(apiKey),
      payload: { email: `inbox@${claimed}` },
    });
    expect(allowed.statusCode).toBe(201);
  });
});

describe("POST /api/mailboxes/:id/verify", () => {
  test("wrong code 400 twice, dead code 410 on the third try", async () => {
    const { apiKey } = await registerAndLogin(app);
    const email = uniqueEmail();
    const mb = await createMailbox(apiKey, email);
    const code = await latestEmailedCode(email);
    const wrongCode = `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`;

    const attempt = () =>
      app.inject({
        method: "POST",
        url: `/api/mailboxes/${mb.id}/verify`,
        headers: auth(apiKey),
        payload: { code: wrongCode },
      });

    for (let i = 0; i < 2; i++) {
      const res = await attempt();
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>()).toEqual({ error: "Invalid activation code" });
    }
    const third = await attempt();
    expect(third.statusCode).toBe(410);
    expect(third.json<{ error: string }>()).toEqual({
      error: "Invalid activation code. Please request another code.",
    });

    // The real code is dead too now ("none" -> Invalid code).
    const late = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify`,
      headers: auth(apiKey),
      payload: { code },
    });
    expect(late.statusCode).toBe(400);
    expect(late.json<{ error: string }>()).toEqual({ error: "Invalid code" });
  });

  test("verifying an already-verified mailbox is an idempotent 200", async () => {
    const { apiKey } = await registerAndLogin(app);
    const email = uniqueEmail();
    const mb = await createVerifiedMailbox(apiKey, email);
    const again = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify`,
      headers: auth(apiKey),
      payload: { code: "000000" },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ verified: boolean }>().verified).toBe(true);
  });

  test("missing and foreign mailboxes are the same Invalid mailbox", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    const email = uniqueEmail();
    const mb = await createMailbox(alice.apiKey, email);

    const missing = await app.inject({
      method: "POST",
      url: "/api/mailboxes/999999999/verify",
      headers: auth(alice.apiKey),
      payload: { code: "123456" },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json<{ error: string }>()).toEqual({ error: "Invalid mailbox" });

    const foreign = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify`,
      headers: auth(bob.apiKey),
      payload: { code: await latestEmailedCode(email) },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json<{ error: string }>()).toEqual({ error: "Invalid mailbox" });
  });

  test("unverified mailboxes cannot own new aliases", async () => {
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
        alias_prefix: "unverified",
        signed_suffix: suffix.signed_suffix,
        mailbox_ids: [mb.id],
      },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json<{ error: string }>()).toEqual({ error: "Errors with Mailbox" });
  });
});

describe("PUT /api/mailboxes/:id", () => {
  test("sets the default mailbox once verified; refuses while unverified", async () => {
    const { apiKey } = await registerAndLogin(app);
    const email = uniqueEmail();
    const mb = await createMailbox(apiKey, email);

    const tooEarly = await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { default: true },
    });
    expect(tooEarly.statusCode).toBe(400);
    expect(tooEarly.json<{ error: string }>()).toEqual({
      error: "Unverified mailbox cannot be used as default mailbox",
    });

    await verifyMailbox(apiKey, mb.id, email);
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
    const mb = await createVerifiedMailbox(apiKey);
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
    const mb = await createVerifiedMailbox(apiKey);
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

describe("PUT /api/mailboxes/:id trash flag (Virtu extension)", () => {
  async function listMailboxes(apiKey: string) {
    const res = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    return res.json<{ mailboxes: { id: number; trash: boolean; default: boolean }[] }>().mailboxes;
  }

  test("set, move, and clear the trash mailbox", async () => {
    const { apiKey } = await registerAndLogin(app);
    const second = await createVerifiedMailbox(apiKey);
    const third = await createVerifiedMailbox(apiKey);

    // Nothing is trash to start with.
    expect((await listMailboxes(apiKey)).every((m) => !m.trash)).toBe(true);

    // Set: only the designated mailbox reads trash=true.
    const set = await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${second.id}`,
      headers: auth(apiKey),
      payload: { trash: true },
    });
    expect(set.statusCode).toBe(200);
    let mbs = await listMailboxes(apiKey);
    expect(mbs.find((m) => m.id === second.id)?.trash).toBe(true);
    expect(mbs.filter((m) => m.trash)).toHaveLength(1);

    // Moving it re-points the single slot.
    await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${third.id}`,
      headers: auth(apiKey),
      payload: { trash: true },
    });
    mbs = await listMailboxes(apiKey);
    expect(mbs.find((m) => m.id === third.id)?.trash).toBe(true);
    expect(mbs.filter((m) => m.trash)).toHaveLength(1);

    // trash:false on the current holder clears it; on another mailbox it's
    // a no-op.
    await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${second.id}`,
      headers: auth(apiKey),
      payload: { trash: false },
    });
    expect((await listMailboxes(apiKey)).find((m) => m.id === third.id)?.trash).toBe(true);
    await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${third.id}`,
      headers: auth(apiKey),
      payload: { trash: false },
    });
    expect((await listMailboxes(apiKey)).every((m) => !m.trash)).toBe(true);
  });

  test("an unverified mailbox cannot be the trash mailbox", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createMailbox(apiKey);
    const res = await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${mb.id}`,
      headers: auth(apiKey),
      payload: { trash: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>()).toEqual({
      error: "Unverified mailbox cannot be used as trash mailbox",
    });
  });

  test("deleting the trash mailbox clears the designation", async () => {
    const { apiKey } = await registerAndLogin(app);
    const doomed = await createVerifiedMailbox(apiKey);
    await app.inject({
      method: "PUT",
      url: `/api/mailboxes/${doomed.id}`,
      headers: auth(apiKey),
      payload: { trash: true },
    });
    const del = await app.inject({
      method: "DELETE",
      url: `/api/mailboxes/${doomed.id}`,
      headers: auth(apiKey),
      payload: { transfer_aliases_to: -1 },
    });
    expect(del.statusCode).toBe(200);
    expect((await listMailboxes(apiKey)).every((m) => !m.trash)).toBe(true);
  });
});

describe("mailbox bounce suppression (ABUSE.md Tier 1)", () => {
  async function suppress(mailboxId: number) {
    const result = await suppressMailbox(db, mailboxId, { enhancedCode: "5.1.1" });
    if (!result.suppressed) throw new Error(`mailbox ${mailboxId} did not suppress`);
    return result;
  }

  async function getMailboxDto(apiKey: string, id: number) {
    const res = await app.inject({
      method: "GET",
      url: "/api/v2/mailboxes",
      headers: auth(apiKey),
    });
    const rows = res.json<{ mailboxes: { id: number; verified: boolean; suppressed: boolean }[] }>()
      .mailboxes;
    const row = rows.find((m) => m.id === id);
    if (!row) throw new Error(`mailbox ${id} not in list`);
    return row;
  }

  test("suppression surfaces on the DTO; re-verify with a fresh code clears it", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mbEmail = uniqueEmail();
    const mb = await createVerifiedMailbox(apiKey, mbEmail);

    await suppress(mb.id);
    expect(await getMailboxDto(apiKey, mb.id)).toMatchObject({ verified: true, suppressed: true });

    // Resume path: request a fresh code (allowed while suppressed), then verify.
    const requested = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify/request`,
      headers: auth(apiKey),
    });
    expect(requested.statusCode).toBe(200);
    const verify = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify`,
      headers: auth(apiKey),
      payload: { code: await latestEmailedCode(mbEmail) },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json<{ suppressed: boolean }>().suppressed).toBe(false);
    expect(await getMailboxDto(apiKey, mb.id)).toMatchObject({ verified: true, suppressed: false });
  });

  test("suppression is first-strike idempotent and notifies once", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const mb = await createVerifiedMailbox(apiKey);
    const userId = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]!
      .id;

    await suppress(mb.id);
    const second = await suppressMailbox(db, mb.id, { enhancedCode: "5.1.1" });
    expect(second.suppressed).toBe(false);

    const notes = await db.select().from(notifications).where(eq(notifications.userId, userId));
    expect(notes.filter((n) => n.title?.includes("paused")).length).toBe(1);
  });

  test("wrong code leaves the mailbox suppressed", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createVerifiedMailbox(apiKey);
    await suppress(mb.id);
    await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify/request`,
      headers: auth(apiKey),
    });
    const verify = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify`,
      headers: auth(apiKey),
      payload: { code: "000000" },
    });
    expect(verify.statusCode).toBe(400);
    expect(await getMailboxDto(apiKey, mb.id)).toMatchObject({ suppressed: true });
  });

  test("verify/request on a healthy verified mailbox is refused", async () => {
    const { apiKey } = await registerAndLogin(app);
    const mb = await createVerifiedMailbox(apiKey);
    const res = await app.inject({
      method: "POST",
      url: `/api/mailboxes/${mb.id}/verify/request`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("Mailbox is already verified");
  });
});
