import { ensureTestSigningKey } from "../routes/intHarness.ts";
/**
 * The daily send quota under concurrency (review round 2 P1 #9): N parallel
 * submissions from one user, each under the limit alone, must not all pass
 * the same low count — the user's submissions are serialized in
 * submission.ts. Drives the real submission listener in-process against the
 * dockerized Postgres; unique user per run.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, count, eq } from "drizzle-orm";
import { type App, buildApp } from "../app/server.ts";
import { db } from "../db/index.ts";
import { emailLogs, users } from "../db/schema.ts";
import { createAlias, registerAndLogin } from "../routes/intHarness.ts";
import { RawClient } from "../smtp/testutil.ts";
import {
  createSubmissionServers,
  type SubmissionOptions,
  type SubmissionServers,
} from "../submission.ts";

let app: App;
let servers: SubmissionServers;
let port: number;
const LIMIT = 5;

const silent = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child() {
    return silent;
  },
};

beforeAll(async () => {
  await ensureTestSigningKey();
  app = await buildApp({ logger: false });
  await app.ready();
  servers = createSubmissionServers({
    db,
    mailDomain: "virtu.email",
    mailHostname: "mail.virtu.email",
    dkimSelector: "mail",
    verpSecret: "unit-test-verp-secret-unit-test-verp-secret",
    maxMessageSize: 1024 * 1024,
    allowPlaintextAuth: true,
    sendQuota: { freePerDay: LIMIT, premiumPerDay: LIMIT },
    queueQuota: { maxPendingRows: 500, maxPendingBytes: 256 << 20 },
    logger: silent as unknown as SubmissionOptions["logger"],
  });
  port = (await servers.starttls.listen(0, "127.0.0.1")).port;
}, 90_000);

afterAll(async () => {
  await servers.starttls.close();
  await app.close();
});

async function session(email: string, password: string, alias: string, rcpts: string[]) {
  const c = await RawClient.connect(port);
  await c.waitFor(/^220 /);
  c.write("EHLO mua.example\r\n");
  await c.waitFor(/^250 /);
  c.write(`AUTH PLAIN ${Buffer.from(`\0${email}\0${password}`).toString("base64")}\r\n`);
  await c.waitFor(/^235 /);
  c.write(`MAIL FROM:<${alias}>\r\n`);
  await c.waitFor(/^250 /);
  for (const r of rcpts) {
    c.write(`RCPT TO:<${r}>\r\n`);
    await c.waitFor(/^250 /);
  }
  c.write("DATA\r\n");
  await c.waitFor(/^354 /);
  return c;
}

test("concurrent submissions cannot exceed the daily send limit", async () => {
  const { email, apiKey } = await registerAndLogin(app);
  const cred = await app.inject({
    method: "POST",
    url: "/api/smtp/credentials",
    headers: { authentication: apiKey },
    payload: { name: "x" },
  });
  const password = cred.json<{ password: string }>().password;
  const alias = await createAlias(app, apiKey);
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  const N = 12; // concurrent connections, each with LIMIT-1 recipients
  // Sessions are set up one at a time (the verify bulkhead caps concurrent
  // AUTH at 4 by design); only the DATA bodies are fired concurrently.
  const sessions: RawClient[] = [];
  for (let i = 0; i < N; i++) {
    sessions.push(
      await session(
        email,
        password,
        alias.email,
        Array.from(
          { length: LIMIT - 1 },
          (_, j) => `r${i}-${j}-${crypto.randomUUID().slice(0, 8)}@example.com`,
        ),
      ),
    );
  }
  const msg = (i: number) =>
    `From: ${alias.email}\r\nTo: someone@example.com\r\nSubject: burst ${i}\r\n` +
    `Date: Mon, 07 Sep 2026 10:00:00 +0000\r\n\r\nhi\r\n.\r\n`;
  for (let i = 0; i < N; i++) sessions[i]!.write(msg(i));
  const replies = await Promise.all(sessions.map((c) => c.waitFor(/^(250|4\d\d|5\d\d) /, 30_000)));
  for (const c of sessions) c.end();
  const accepted = replies.filter((r) => r.startsWith("250")).length;
  const [row] = await db
    .select({ n: count() })
    .from(emailLogs)
    .where(and(eq(emailLogs.userId, u!.id), eq(emailLogs.isReply, true)));
  expect(accepted).toBe(1); // LIMIT-1 recipients fit once; the next batch would exceed
  expect(row!.n).toBeLessThanOrEqual(LIMIT);
  expect(replies.filter((r) => r.startsWith("452 4.7.1")).length).toBe(N - 1);
}, 90_000);
