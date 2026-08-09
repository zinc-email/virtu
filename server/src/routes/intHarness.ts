// Shared helpers for the route int tier (*.int.test.ts). Parallel-safe by
// construction: every caller registers its own unique user; nothing here
// truncates or shares state.

import type { App } from "../app/server";

export const uniqueEmail = () => `it-${crypto.randomUUID()}@int.test`;
export const PASSWORD = "correct horse battery staple";

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

/** Register + login a fresh user; returns the api key for the Authentication header. */
export async function registerAndLogin(app: App): Promise<TestUser> {
  const email = uniqueEmail();
  const remoteAddress = uniqueIp();
  const reg = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email, password: PASSWORD },
    remoteAddress,
  });
  if (reg.statusCode !== 200) throw new Error(`register failed: ${reg.body}`);
  const log = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: PASSWORD, device: "int-test" },
    remoteAddress,
  });
  if (log.statusCode !== 200) throw new Error(`login failed: ${log.body}`);
  const apiKey = log.json<{ api_key: string }>().api_key;
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
  const mailboxId = mailboxesRes.json<{ mailboxes: { id: number }[] }>().mailboxes[0]?.id;
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
