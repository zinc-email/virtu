// Admin operator-mail + destination-throttle endpoints (Lane K). Parallel-safe:
// unique admins per test; destination domains are unique per test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { App } from "../app/server";
import { buildApp } from "../app/server";
import { db } from "../db";
import { destinationThrottles, users } from "../db/schema";
import { recordDeferral } from "../queue/destinationThrottle";
import { makeAdmin, registerAndLogin } from "./intHarness";

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
  const row = (await db.select().from(users).where(eq(users.email, user.email)))[0]!;
  return { ...user, id: row.id };
}

interface OperatorDto {
  id: number;
  email: string;
  receives_operator_mail: boolean;
  effective: boolean;
  mailbox: string | null;
  mailbox_deliverable: boolean;
}
interface OperatorList {
  localparts: string[];
  operators: OperatorDto[];
}

describe("GET/PATCH /api/admin/operators", () => {
  test("lists operators; opting in makes one effective; non-admins are 403", async () => {
    const me = await adminUser();
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/operators",
      headers: auth(me.apiKey),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<OperatorList>();
    expect(body.localparts).toContain("postmaster");
    const mine = body.operators.find((o) => o.id === me.id);
    expect(mine).toMatchObject({
      email: me.email,
      receives_operator_mail: false,
      mailbox: me.email, // the self-mailbox minted at graduation
      mailbox_deliverable: true,
    });

    const on = await app.inject({
      method: "PATCH",
      url: `/api/admin/operators/${me.id}`,
      headers: auth(me.apiKey),
      payload: { receives_operator_mail: true },
    });
    expect(on.statusCode).toBe(200);
    const after = on.json<OperatorList>().operators.find((o) => o.id === me.id);
    expect(after).toMatchObject({ receives_operator_mail: true, effective: true });
    // With at least one opt-in, every effective operator is an opted-in one.
    for (const o of on.json<OperatorList>().operators) {
      if (o.effective) expect(o.receives_operator_mail).toBe(true);
    }

    const off = await app.inject({
      method: "PATCH",
      url: `/api/admin/operators/${me.id}`,
      headers: auth(me.apiKey),
      payload: { receives_operator_mail: false },
    });
    expect(
      off.json<OperatorList>().operators.find((o) => o.id === me.id)?.receives_operator_mail,
    ).toBe(false);

    const plain = await registerAndLogin(app);
    const denied = await app.inject({
      method: "GET",
      url: "/api/admin/operators",
      headers: auth(plain.apiKey),
    });
    expect(denied.statusCode).toBe(403);
    // A non-operator id is 404 even for an admin.
    const plainRow = (await db.select().from(users).where(eq(users.email, plain.email)))[0]!;
    const notOp = await app.inject({
      method: "PATCH",
      url: `/api/admin/operators/${plainRow.id}`,
      headers: auth(me.apiKey),
      payload: { receives_operator_mail: true },
    });
    expect(notOp.statusCode).toBe(404);
  });
});

describe("GET/DELETE /api/admin/destinations", () => {
  test("lists a paused domain with its reply; DELETE lifts the pause; unknown is 404", async () => {
    const me = await adminUser();
    const domain = `d-${crypto.randomUUID().slice(0, 8)}.throttle.test`;
    await recordDeferral(
      db,
      domain,
      { code: 421, enhancedCode: "4.7.28", step: "greeting", text: "rate limited" },
      { baseMs: 600_000, maxMs: 600_000 },
    );

    const list = await app.inject({
      method: "GET",
      url: "/api/admin/destinations",
      headers: auth(me.apiKey),
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ paused: number; destinations: Record<string, unknown>[] }>();
    const row = body.destinations.find((d) => d.domain === domain);
    expect(row).toMatchObject({
      provider: "other",
      strikes: 1,
      pauses: 1,
      last_code: 421,
      last_enhanced: "4.7.28",
      last_step: "greeting",
      last_reply: "rate limited",
    });
    expect(typeof row?.paused_until).toBe("string");
    expect(body.paused).toBeGreaterThanOrEqual(1);
    // Paused rows sort first.
    const firstUnpaused = body.destinations.findIndex((d) => d.paused_until === null);
    const lastPaused = body.destinations.map((d) => d.paused_until !== null).lastIndexOf(true);
    if (firstUnpaused !== -1) expect(lastPaused).toBeLessThan(firstUnpaused);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/admin/destinations/${domain}`,
      headers: auth(me.apiKey),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json<{ domain: string; cleared: boolean }>()).toEqual({ domain, cleared: true });
    const again = await app.inject({
      method: "GET",
      url: "/api/admin/destinations",
      headers: auth(me.apiKey),
    });
    expect(
      again
        .json<{ destinations: { domain: string; paused_until: string | null }[] }>()
        .destinations.find((d) => d.domain === domain)?.paused_until,
    ).toBeNull();

    const unknown = await app.inject({
      method: "DELETE",
      url: "/api/admin/destinations/never-seen.example",
      headers: auth(me.apiKey),
    });
    expect(unknown.statusCode).toBe(404);

    await db.delete(destinationThrottles).where(eq(destinationThrottles.domain, domain));
  });
});
