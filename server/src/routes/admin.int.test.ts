// Admin route int tests (PLAN Lane K P1): the 403 wall for non-admins, the
// overview aggregates, queue list/detail (VERP ownership + the no-Subject
// privacy assertion), drop and requeue. Prerequisites: `just up` + `just db
// push`. Parallel-safe: unique users per test, unique queue recipients, no
// truncation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { config } from "../config";
import { db } from "../db";
import { contacts, emailLogs, outboundMessages, users } from "../db/schema";
import { buildVerp, serializeMessage, HeaderBlock } from "../mail/index.ts";
import { makeAdmin, registerAndLogin, createAlias } from "./intHarness";

let app: App;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const auth = (apiKey: string) => ({ authentication: apiKey });

async function adminUser() {
  const user = await registerAndLogin(app);
  await makeAdmin(user.email);
  return user;
}

/** A queue row with realistic raw bytes (incl. Subject) and optional VERP. */
async function insertQueueRow(over: {
  envelopeFrom?: string;
  status?: "pending" | "sending" | "sent" | "failed";
  raw?: Uint8Array;
}): Promise<{ id: number; envelopeTo: string }> {
  const headers = new HeaderBlock();
  headers.append("Date", "Thu, 14 Aug 2026 10:00:00 +0000");
  headers.append("From", "someone@initech.com");
  headers.append("To", "target@qmail.com");
  headers.append("Subject", "extremely private user business");
  headers.append("Message-ID", `<${crypto.randomUUID()}@initech.com>`);
  const raw = over.raw ?? serializeMessage(headers, new TextEncoder().encode("private body\r\n"));
  const envelopeTo = `admin-int-${crypto.randomUUID()}@qmail.com`;
  const rows = await db
    .insert(outboundMessages)
    .values({
      raw,
      envelopeFrom: over.envelopeFrom ?? "",
      envelopeTo,
      status: over.status ?? "pending",
    })
    .returning({ id: outboundMessages.id });
  return { id: rows[0]!.id, envelopeTo };
}

type AdminRoute =
  | { method: "GET"; url: string }
  | { method: "POST"; url: string; payload: Record<string, unknown> };

const ADMIN_ROUTES: AdminRoute[] = [
  { method: "GET", url: "/api/admin/overview" },
  { method: "GET", url: "/api/admin/queue?page_id=0" },
  { method: "GET", url: "/api/admin/queue/1" },
  { method: "POST", url: "/api/admin/queue/drop", payload: { ids: [1] } },
  { method: "POST", url: "/api/admin/queue/requeue", payload: { ids: [1] } },
  { method: "POST", url: "/api/admin/queue/delete", payload: { ids: [1] } },
  { method: "POST", url: "/api/admin/queue/bounce", payload: { ids: [1] } },
];

describe("admin authz wall", () => {
  test("every admin route is 401 without a key and 403 for a non-admin", async () => {
    const { apiKey } = await registerAndLogin(app);
    const hit = (route: AdminRoute, headers?: Record<string, string>) =>
      route.method === "GET"
        ? app.inject({ method: "GET", url: route.url, headers })
        : app.inject({ method: "POST", url: route.url, payload: route.payload, headers });
    for (const route of ADMIN_ROUTES) {
      const anon = await hit(route);
      expect(anon.statusCode).toBe(401);

      const nonAdmin = await hit(route, auth(apiKey));
      expect(nonAdmin.statusCode).toBe(403);
      expect(nonAdmin.json<{ error: string }>()).toEqual({ error: "Forbidden" });
    }
  });

  test("granting the flag opens the surface", async () => {
    const { apiKey } = await adminUser();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/overview",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
  });

  test("user_info carries is_admin", async () => {
    const { apiKey } = await adminUser();
    const res = await app.inject({ method: "GET", url: "/api/user_info", headers: auth(apiKey) });
    expect(res.json<{ is_admin: boolean }>().is_admin).toBe(true);

    const { apiKey: plainKey } = await registerAndLogin(app);
    const plain = await app.inject({
      method: "GET",
      url: "/api/user_info",
      headers: auth(plainKey),
    });
    expect(plain.json<{ is_admin: boolean }>().is_admin).toBe(false);
  });
});

describe("GET /api/admin/overview", () => {
  test("counts move when a queue row appears", async () => {
    const { apiKey } = await adminUser();
    const before = await app
      .inject({ method: "GET", url: "/api/admin/overview", headers: auth(apiKey) })
      .then((r) => r.json<{ queue: { pending: number } }>());
    const row = await insertQueueRow({});
    const after = await app
      .inject({ method: "GET", url: "/api/admin/overview", headers: auth(apiKey) })
      .then((r) => r.json<{ queue: { pending: number }; users: { total: number } }>());
    expect(after.queue.pending).toBeGreaterThan(before.queue.pending);
    expect(after.users.total).toBeGreaterThan(0);
    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });
});

describe("GET /api/admin/queue", () => {
  test("filters by status, reports total, respects limit", async () => {
    const { apiKey } = await adminUser();
    const failed = await insertQueueRow({ status: "failed" });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/queue?status=failed&page_id=0&limit=5",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      total: number;
      messages: Array<{ id: number; status: string; size_bytes: number }>;
    }>();
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.messages.length).toBeLessThanOrEqual(5);
    const mine = body.messages.find((m) => m.id === failed.id);
    expect(mine?.status).toBe("failed");
    expect(mine?.size_bytes).toBeGreaterThan(0);
    await db.delete(outboundMessages).where(eq(outboundMessages.id, failed.id));
  });

  test("garbage paging is a 400", async () => {
    const { apiKey } = await adminUser();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/queue?page_id=banana",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/admin/queue/:id", () => {
  test("resolves VERP ownership for a forward bounce row", async () => {
    const admin = await adminUser();
    const owner = await registerAndLogin(app);
    const alias = await createAlias(app, owner.apiKey);
    const [ownerRow] = await db.select().from(users).where(eq(users.email, owner.email));
    const [contactRow] = await db
      .insert(contacts)
      .values({
        userId: ownerRow!.id,
        aliasId: alias.id,
        websiteEmail: `sender-${crypto.randomUUID()}@initech.com`,
        replyEmail: `ra+${crypto.randomUUID()}@virtu.email`,
      })
      .returning({ id: contacts.id });
    const [logRow] = await db
      .insert(emailLogs)
      .values({
        userId: ownerRow!.id,
        contactId: contactRow!.id,
        aliasId: alias.id,
      })
      .returning();

    const verp = buildVerp({
      type: "bounce_forward",
      id: logRow!.id,
      secret: config.verpSecret,
      domain: config.mailDomain,
    });
    const row = await insertQueueRow({ envelopeFrom: verp });

    const res = await app.inject({
      method: "GET",
      url: `/api/admin/queue/${row.id}`,
      headers: auth(admin.apiKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      headers: Array<{ name: string; value: string }>;
      owner: {
        verp_type: string;
        email_log_id: number | null;
        user: { email: string } | null;
        alias: { email: string } | null;
      } | null;
    }>();
    expect(body.owner?.verp_type).toBe("bounce_forward");
    expect(body.owner?.email_log_id).toBe(logRow!.id);
    expect(body.owner?.user?.email).toBe(owner.email);
    expect(body.owner?.alias?.email).toBe(alias.email);
    // The privacy line: routing headers come through, Subject and body never.
    expect(body.headers.some((h) => h.name.toLowerCase() === "message-id")).toBe(true);
    expect(body.headers.some((h) => h.name.toLowerCase() === "subject")).toBe(false);
    expect(res.body).not.toContain("extremely private user business");
    expect(res.body).not.toContain("private body");

    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
    await db.delete(emailLogs).where(eq(emailLogs.id, logRow!.id));
  });

  test("null owner for the null reverse path; 404 for unknown ids", async () => {
    const { apiKey } = await adminUser();
    const row = await insertQueueRow({ envelopeFrom: "" });
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/queue/${row.id}`,
      headers: auth(apiKey),
    });
    expect(res.json<{ owner: unknown }>().owner).toBeNull();

    const missing = await app.inject({
      method: "GET",
      url: "/api/admin/queue/999999999",
      headers: auth(apiKey),
    });
    expect(missing.statusCode).toBe(404);
    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });
});

/** A queue row whose VERP resolves: owner user + alias + contact + email_log. */
async function forwardVerpFixture(status: "pending" | "failed" = "pending") {
  const owner = await registerAndLogin(app);
  const alias = await createAlias(app, owner.apiKey);
  const [ownerRow] = await db.select().from(users).where(eq(users.email, owner.email));
  const websiteEmail = `sender-${crypto.randomUUID()}@initech.com`;
  const [contactRow] = await db
    .insert(contacts)
    .values({
      userId: ownerRow!.id,
      aliasId: alias.id,
      websiteEmail,
      replyEmail: `ra+${crypto.randomUUID()}@virtu.email`,
    })
    .returning({ id: contacts.id });
  const [logRow] = await db
    .insert(emailLogs)
    .values({ userId: ownerRow!.id, contactId: contactRow!.id, aliasId: alias.id })
    .returning();
  const verp = buildVerp({
    type: "bounce_forward",
    id: logRow!.id,
    secret: config.verpSecret,
    domain: config.mailDomain,
  });
  const row = await insertQueueRow({ envelopeFrom: verp, status });
  return { row, websiteEmail, alias, emailLogId: logRow!.id };
}

describe("POST /api/admin/queue/bounce", () => {
  test("DSNs the originator, fails the row, never touches the bounce ledger", async () => {
    const { apiKey } = await adminUser();
    const { row, websiteEmail, alias, emailLogId } = await forwardVerpFixture("pending");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/queue/bounce",
      headers: auth(apiKey),
      payload: { ids: [row.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ bounced: number; ids: number[] }>()).toMatchObject({
      bounced: 1,
      ids: [row.id],
    });

    // The row is terminal-marked as an operator bounce.
    const [after] = await db.select().from(outboundMessages).where(eq(outboundMessages.id, row.id));
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe("bounced by operator");

    // A DSN sits in the queue for the outside sender: null reverse path,
    // naming the ALIAS (never the backing mailbox — the privacy invariant).
    const dsnRows = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.envelopeTo, websiteEmail));
    expect(dsnRows.length).toBe(1);
    expect(dsnRows[0]?.envelopeFrom).toBe("");
    const dsnText = Buffer.from(dsnRows[0]!.raw).toString("utf-8");
    expect(dsnText).toContain(alias.email);
    // Forward bounces sanitize the diagnostic to the generic refusal text —
    // the outside sender learns neither the mailbox nor operator internals.
    expect(dsnText).toContain("550 5.7.1");
    expect(dsnText).not.toContain("operator");

    // NOT a mailbox-health signal: the email_log books no bounce.
    const [log] = await db.select().from(emailLogs).where(eq(emailLogs.id, emailLogId));
    expect(log?.bounced).toBe(false);

    // Bouncing again: still reported bounced, but the 24h DSN dedupe means
    // no second notice is enqueued.
    const again = await app.inject({
      method: "POST",
      url: "/api/admin/queue/bounce",
      headers: auth(apiKey),
      payload: { ids: [row.id] },
    });
    expect(again.json<{ bounced: number }>().bounced).toBe(1);
    const dsnRowsAfter = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.envelopeTo, websiteEmail));
    expect(dsnRowsAfter.length).toBe(1);

    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
    await db.delete(outboundMessages).where(eq(outboundMessages.envelopeTo, websiteEmail));
    await db.delete(emailLogs).where(eq(emailLogs.id, emailLogId));
  });

  test("skips what must never bounce: null reverse path, delivered, unknown", async () => {
    const { apiKey } = await adminUser();
    const nullPath = await insertQueueRow({ envelopeFrom: "", status: "pending" });
    const delivered = await insertQueueRow({ status: "sent" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/queue/bounce",
      headers: auth(apiKey),
      payload: { ids: [nullPath.id, delivered.id, 999999999] },
    });
    const body = res.json<{
      bounced: number;
      skipped: { id: number; reason: string }[];
    }>();
    expect(body.bounced).toBe(0);
    expect(body.skipped).toContainEqual({ id: nullPath.id, reason: "null_reverse_path" });
    expect(body.skipped).toContainEqual({ id: delivered.id, reason: "already_delivered" });
    expect(body.skipped).toContainEqual({ id: 999999999, reason: "unknown_id" });
    // The null-path row is untouched — never bounce a bounce.
    expect(
      (await db.select().from(outboundMessages).where(eq(outboundMessages.id, nullPath.id)))[0]
        ?.status,
    ).toBe("pending");

    await db.delete(outboundMessages).where(eq(outboundMessages.id, nullPath.id));
    await db.delete(outboundMessages).where(eq(outboundMessages.id, delivered.id));
  });
});

describe("POST /api/admin/queue/drop + requeue", () => {
  test("drop fails pending rows; requeue returns them; unknown ids skip", async () => {
    const { apiKey } = await adminUser();
    const row = await insertQueueRow({ status: "pending" });

    const drop = await app.inject({
      method: "POST",
      url: "/api/admin/queue/drop",
      headers: auth(apiKey),
      payload: { ids: [row.id, 999999999] },
    });
    expect(drop.statusCode).toBe(200);
    expect(drop.json<{ dropped: number; ids: number[] }>()).toEqual({
      dropped: 1,
      ids: [row.id],
    });
    const [afterDrop] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, row.id));
    expect(afterDrop?.status).toBe("failed");
    expect(afterDrop?.lastError).toBe("dropped by operator");

    const requeue = await app.inject({
      method: "POST",
      url: "/api/admin/queue/requeue",
      headers: auth(apiKey),
      payload: { ids: [row.id] },
    });
    expect(requeue.json<{ requeued: number; ids: number[] }>()).toEqual({
      requeued: 1,
      ids: [row.id],
    });
    const [afterRequeue] = await db
      .select()
      .from(outboundMessages)
      .where(eq(outboundMessages.id, row.id));
    expect(afterRequeue?.status).toBe("pending");
    expect(afterRequeue?.tries).toBe(0);

    await db.delete(outboundMessages).where(eq(outboundMessages.id, row.id));
  });

  test("delete removes terminal rows only; live rows must be dropped first", async () => {
    const { apiKey } = await adminUser();
    const failed = await insertQueueRow({ status: "failed" });
    const sent = await insertQueueRow({ status: "sent" });
    const pending = await insertQueueRow({ status: "pending" });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/queue/delete",
      headers: auth(apiKey),
      payload: { ids: [failed.id, sent.id, pending.id] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ deleted: number; ids: number[] }>();
    expect(body.deleted).toBe(2);
    expect(body.ids.sort()).toEqual([failed.id, sent.id].sort());

    const detail = await app.inject({
      method: "GET",
      url: `/api/admin/queue/${failed.id}`,
      headers: auth(apiKey),
    });
    expect(detail.statusCode).toBe(404);
    expect(
      (await db.select().from(outboundMessages).where(eq(outboundMessages.id, pending.id)))[0]
        ?.status,
    ).toBe("pending");
    await db.delete(outboundMessages).where(eq(outboundMessages.id, pending.id));
  });

  test("body validation: empty and oversized id lists are 400", async () => {
    const { apiKey } = await adminUser();
    const empty = await app.inject({
      method: "POST",
      url: "/api/admin/queue/drop",
      headers: auth(apiKey),
      payload: { ids: [] },
    });
    expect(empty.statusCode).toBe(400);
    const oversized = await app.inject({
      method: "POST",
      url: "/api/admin/queue/drop",
      headers: auth(apiKey),
      payload: { ids: Array.from({ length: 101 }, (_v, i) => i + 1) },
    });
    expect(oversized.statusCode).toBe(400);
  });
});
