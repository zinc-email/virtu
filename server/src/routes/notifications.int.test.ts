// Notification routes int tests (list paging/ordering, mark-as-read,
// cross-user isolation). Prerequisites: `just up` (migrates on boot).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { notifications, users } from "../db/schema";
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

interface NotificationDto {
  id: number;
  title: string | null;
  message: string;
  read: boolean;
  created_at: string;
}

async function userIdOf(email: string): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return rows[0]!.id;
}

/** Insert a notification the way the pipeline does (sendAlertOnce's write). */
async function insertNotification(
  userId: number,
  over: { title?: string | null; message?: string; read?: boolean; createdAt?: Date } = {},
): Promise<number> {
  const rows = await db
    .insert(notifications)
    .values({
      userId,
      title: over.title === undefined ? "Alias disabled" : over.title,
      message: over.message ?? "Your alias was disabled after repeated bounces.",
      read: over.read ?? false,
      ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
    })
    .returning({ id: notifications.id });
  return rows[0]!.id;
}

describe("GET /api/notifications", () => {
  test("empty account: no notifications, no more", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "GET",
      url: "/api/notifications?page=0",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ more: boolean; notifications: NotificationDto[] }>()).toEqual({
      more: false,
      notifications: [],
    });
  });

  test("unread sort first, then newest; humanized created_at", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdOf(email);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const readOld = await insertNotification(userId, { read: true, createdAt: dayAgo });
    const unreadOld = await insertNotification(userId, { createdAt: dayAgo });
    const unreadNew = await insertNotification(userId, { title: null });

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications?page=0",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ more: boolean; notifications: NotificationDto[] }>();
    expect(body.more).toBe(false);
    expect(body.notifications.map((n) => n.id)).toEqual([unreadNew, unreadOld, readOld]);
    expect(body.notifications[0]!.title).toBeNull();
    expect(body.notifications[0]!.created_at).toBe("just now");
    expect(body.notifications[1]!.created_at).toBe("a day ago");
    expect(body.notifications[2]!.read).toBe(true);
  });

  test("pages of 20 with a more flag", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const userId = await userIdOf(email);
    for (let i = 0; i < 21; i++) await insertNotification(userId, { message: `n${i}` });

    const page0 = await app.inject({
      method: "GET",
      url: "/api/notifications?page=0",
      headers: auth(apiKey),
    });
    const body0 = page0.json<{ more: boolean; notifications: NotificationDto[] }>();
    expect(body0.more).toBe(true);
    expect(body0.notifications).toHaveLength(20);

    const page1 = await app.inject({
      method: "GET",
      url: "/api/notifications?page=1",
      headers: auth(apiKey),
    });
    const body1 = page1.json<{ more: boolean; notifications: NotificationDto[] }>();
    expect(body1.more).toBe(false);
    expect(body1.notifications).toHaveLength(1);
  });

  test("missing or malformed page is the SL 400", async () => {
    const { apiKey } = await registerAndLogin(app);
    for (const url of ["/api/notifications", "/api/notifications?page=x"]) {
      const res = await app.inject({ method: "GET", url, headers: auth(apiKey) });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>()).toEqual({
        error: "page must be provided in request query",
      });
    }
  });

  test("never leaks another account's notifications", async () => {
    const alice = await registerAndLogin(app);
    const bob = await registerAndLogin(app);
    await insertNotification(await userIdOf(alice.email), { message: "alice-only" });

    const res = await app.inject({
      method: "GET",
      url: "/api/notifications?page=0",
      headers: auth(bob.apiKey),
    });
    expect(res.json<{ notifications: NotificationDto[] }>().notifications).toHaveLength(0);
  });
});

describe("POST /api/notifications/:id/read", () => {
  test("marks own notification read", async () => {
    const { email, apiKey } = await registerAndLogin(app);
    const id = await insertNotification(await userIdOf(email));

    const res = await app.inject({
      method: "POST",
      url: `/api/notifications/${id}/read`,
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ done: boolean }>()).toEqual({ done: true });
    const rows = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(rows[0]!.read).toBe(true);
  });

  test("another user's id is 403 and stays unread", async () => {
    const alice = await registerAndLogin(app);
    const mallory = await registerAndLogin(app);
    const id = await insertNotification(await userIdOf(alice.email));

    const res = await app.inject({
      method: "POST",
      url: `/api/notifications/${id}/read`,
      headers: auth(mallory.apiKey),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>()).toEqual({ error: "Forbidden" });
    const rows = await db.select().from(notifications).where(eq(notifications.id, id));
    expect(rows[0]!.read).toBe(false);
  });

  test("unknown id is 403 (indistinguishable from foreign)", async () => {
    const { apiKey } = await registerAndLogin(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/notifications/999999999/read",
      headers: auth(apiKey),
    });
    expect(res.statusCode).toBe(403);
  });
});
