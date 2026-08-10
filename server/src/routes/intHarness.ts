// Shared helpers for the route int tier (*.int.test.ts). Parallel-safe by
// construction: every caller registers its own unique user; nothing here
// truncates or shares state.

import { desc, eq } from "drizzle-orm";
import type { App } from "../app/server";
import { db } from "../db";
import { outboundMessages } from "../db/schema";
import { extractCodeFromBody } from "../pipeline/transactional";

export const uniqueEmail = () => `it-${crypto.randomUUID()}@int.test`;

/**
 * The 6-digit verification code from the latest transactional email queued
 * for `email`. Login/sudo/mailbox-create enqueue into outbound_messages even
 * without a mail stack (unsigned when no DKIM key), so the int tier reads
 * the code straight off the queue row — the DB stand-in for an inbox.
 */
export async function latestEmailedCode(email: string): Promise<string> {
  const rows = await db
    .select()
    .from(outboundMessages)
    .where(eq(outboundMessages.envelopeTo, email))
    .orderBy(desc(outboundMessages.id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`no queued transactional mail for ${email}`);
  const text = Buffer.from(row.raw).toString("utf-8");
  const bodyStart = text.search(/\r?\n\r?\n/);
  const code = extractCodeFromBody(bodyStart === -1 ? text : text.slice(bodyStart));
  if (code === undefined) throw new Error(`no verification code in the mail to ${email}`);
  return code;
}

export interface TestUser {
  email: string;
  apiKey: string;
}

/** A unique source IP per call, so the per-IP auth rate limit (10/minute)
 * never couples tests together (inject's remoteAddress). */
function uniqueIp(): string {
  const b = () => 1 + Math.floor(Math.random() * 253);
  return `10.${b()}.${b()}.${b()}`;
}

/** Run a fresh email through the passwordless flow (request the login code,
 * verify it off the queue); returns the api key for the Authentication
 * header. Signup and login are the same flow, so this covers both. */
export async function registerAndLogin(app: App): Promise<TestUser> {
  const email = uniqueEmail();
  const remoteAddress = uniqueIp();
  const requested = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, device: "int-test" },
    remoteAddress,
  });
  if (requested.statusCode !== 200) throw new Error(`login request failed: ${requested.body}`);
  const verify = await app.inject({
    method: "POST",
    url: "/api/auth/verify",
    payload: { email, code: await latestEmailedCode(email), device: "int-test" },
    remoteAddress,
  });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.body}`);
  const apiKey = verify.json<{ api_key: string }>().api_key;
  return { email, apiKey };
}

/** Create an alias through the real options -> custom/new flow. */
export async function createAlias(
  app: App,
  apiKey: string,
  opts: { prefix?: string; note?: string; name?: string } = {},
): Promise<{ id: number; email: string; mailboxId: number }> {
  const options = await app.inject({
    method: "GET",
    url: "/api/v5/alias/options",
    headers: { authentication: apiKey },
  });
  if (options.statusCode !== 200) throw new Error(`options failed: ${options.body}`);
  const suffix = options.json<{ suffixes: { signed_suffix: string }[] }>().suffixes[0];
  if (!suffix) throw new Error("no suffixes returned");

  const mailboxesRes = await app.inject({
    method: "GET",
    url: "/api/v2/mailboxes",
    headers: { authentication: apiKey },
  });
  // Pick the DEFAULT mailbox deterministically — list order varies with
  // randomized emails, and tests assert which mailbox the alias landed on.
  const mailboxRows = mailboxesRes.json<{ mailboxes: { id: number; default: boolean }[] }>()
    .mailboxes;
  const mailboxId = (mailboxRows.find((m) => m.default) ?? mailboxRows[0])?.id;
  if (mailboxId === undefined) throw new Error("no mailbox");

  const created = await app.inject({
    method: "POST",
    url: "/api/v3/alias/custom/new",
    headers: { authentication: apiKey },
    payload: {
      alias_prefix: opts.prefix ?? `p${crypto.randomUUID().slice(0, 8)}`,
      signed_suffix: suffix.signed_suffix,
      mailbox_ids: [mailboxId],
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    },
  });
  if (created.statusCode !== 201) throw new Error(`create alias failed: ${created.body}`);
  const body = created.json<{ id: number; email: string }>();
  return { id: body.id, email: body.email, mailboxId };
}
