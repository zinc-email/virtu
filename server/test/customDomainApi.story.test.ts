/**
 * Story: the full custom-domain lifecycle THROUGH THE HTTP API against the
 * fake internet — the exact flow the dashboard drives:
 *
 *   POST /custom_domains        → domain registered (premium gate)
 *   GET  .../dns                → the records the UI tells the user to publish
 *   (nsupdate publishes EXACTLY those records into the dynamic user.com zone)
 *   POST .../verify             → all five checks green against live DNS
 *   PATCH catch_all=true        → mail to a never-seen localpart mints an
 *                                 alias on the fly and forwards through the
 *                                 real pipeline into the user's Maildir
 *   PATCH catch_all=false       → unknown localparts are 550 again
 *   DELETE /aliases/:id (mint)  → the tombstoned address stays dead even
 *                                 with catch-all back on
 *
 * Publishing verbatim from the GET .../dns response is the point: it pins
 * expectedDnsRecords and verifyCustomDomain together — drift between what we
 * tell users to publish and what we check for fails this story.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app/server.ts";
import { db } from "../src/db/index.ts";
import { aliases, users } from "../src/db/schema.ts";
import { createApiKey, ensureDkimKey, ensureWes, randomTag, type UserFixture } from "./fixtures.ts";
import { waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { nsupdate, publishTxt, quoteTxtValue } from "./nsupdate.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

type App = Awaited<ReturnType<typeof buildApp>>;

interface DnsRecord {
  type: string;
  hostname: string;
  value: string;
  priority?: number;
}
interface DnsRecords {
  ownership: DnsRecord;
  mx: DnsRecord[];
  spf: DnsRecord;
  dkim: DnsRecord | null;
  dmarc: DnsRecord;
}
interface CheckResult {
  ok: boolean;
  errors: string[];
}
interface DomainDto {
  id: number;
  domain_name: string;
  is_verified: boolean;
  catch_all: boolean;
  ownership_verified: boolean;
  spf_verified: boolean;
  dkim_verified: boolean;
  dmarc_verified: boolean;
}

let app: App;
let fixture: UserFixture;
let apiKey: string;

async function api<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    headers: { authentication: apiKey },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: res.json<T>() };
}

/** Send straight to our mx and expect an RCPT-time rejection code. */
async function expectRcptReject(to: string, code: string): Promise<void> {
  let error: Error | null = null;
  try {
    await smtpSend({
      host: "mail.virtu.email",
      port: 25,
      from: milton.email,
      to,
      data: buildMessage({ from: milton.email, to, subject: "probe", testId: newTestId() }),
    });
  } catch (err) {
    error = err as Error;
  }
  expect(error).not.toBeNull();
  expect(error!.message).toContain("RCPT");
  expect(error!.message).toContain(code);
}

beforeAll(async () => {
  await waitForPort("mail.virtu.email", 25, 60_000);
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();

  // The custom-domain routes are premium-gated.
  await db.update(users).set({ lifetime: true }).where(eq(users.id, fixture.user.id));

  app = await buildApp({ logger: false });
  // Minted directly in the DB — the emailed login code is already on its way
  // to a peer Maildir, so the HTTP flow can't be round-tripped here.
  apiKey = await createApiKey(fixture.user.id);
});

afterAll(async () => {
  await app?.close();
});

describe("story: custom-domain API flow", () => {
  test("create → publish dns → verify green → catch-all lifecycle", async () => {
    // ── Register a fresh (sub)domain through the API ────────────────────
    const domainName = `cd-${randomTag()}.user.com`;
    const created = await api<DomainDto>("POST", "/api/custom_domains", { domain: domainName });
    expect(created.status).toBe(201);
    expect(created.body.domain_name).toBe(domainName);
    expect(created.body.is_verified).toBe(false);
    const domainId = created.body.id;

    // ── The records the dashboard shows ─────────────────────────────────
    const dnsRes = await api<{ domain_name: string; records: DnsRecords }>(
      "GET",
      `/api/custom_domains/${domainId}/dns`,
    );
    expect(dnsRes.status).toBe(200);
    const records = dnsRes.body.records;
    expect(records.ownership.value).toStartWith("vt-verification=");
    expect(records.dkim).not.toBeNull();
    expect(records.mx.length).toBeGreaterThan(0);

    // ── Publish EXACTLY those records into the dynamic zone ─────────────
    // Ownership + SPF share the apex name: one update writes both TXTs.
    await nsupdate("user.com", [
      `update delete ${records.ownership.hostname}. TXT`,
      `update add ${records.ownership.hostname}. 60 TXT ${quoteTxtValue(records.ownership.value)}`,
      `update add ${records.spf.hostname}. 60 TXT ${quoteTxtValue(records.spf.value)}`,
      ...records.mx.map((m) => `update add ${m.hostname}. 60 MX ${m.priority ?? 10} ${m.value}`),
    ]);
    await publishTxt("user.com", records.dkim!.hostname, records.dkim!.value);
    await publishTxt("user.com", records.dmarc.hostname, records.dmarc.value);

    // ── Verify through the API: every check green ───────────────────────
    const verify = await api<{
      ownership: CheckResult;
      mx: CheckResult;
      spf: CheckResult;
      dkim: CheckResult;
      dmarc: CheckResult;
      custom_domain: DomainDto;
    }>("POST", `/api/custom_domains/${domainId}/verify`);
    expect(verify.status).toBe(200);
    expect(verify.body.ownership).toEqual({ ok: true, errors: [] });
    expect(verify.body.mx).toEqual({ ok: true, errors: [] });
    expect(verify.body.spf).toEqual({ ok: true, errors: [] });
    expect(verify.body.dkim).toEqual({ ok: true, errors: [] });
    expect(verify.body.dmarc).toEqual({ ok: true, errors: [] });
    expect(verify.body.custom_domain.is_verified).toBe(true);
    expect(verify.body.custom_domain.ownership_verified).toBe(true);
    expect(verify.body.custom_domain.dkim_verified).toBe(true);
    expect(verify.body.custom_domain.dmarc_verified).toBe(true);

    // The flags persisted (a fresh GET agrees).
    const listed = await api<{ custom_domains: DomainDto[] }>("GET", "/api/custom_domains");
    expect(listed.body.custom_domains.find((d) => d.id === domainId)?.is_verified).toBe(true);

    // ── Catch-all OFF (default): unknown localpart is user-unknown ──────
    // (550, not 554 — a verified custom domain is local to us.)
    await expectRcptReject(`nobody-${randomTag()}@${domainName}`, "550");

    // ── Catch-all ON: the same class of address mints and forwards ──────
    const patched = await api<{ custom_domain: DomainDto }>(
      "PATCH",
      `/api/custom_domains/${domainId}`,
      { catch_all: true },
    );
    expect(patched.body.custom_domain.catch_all).toBe(true);

    const mintAddr = `shop-${randomTag()}@${domainName}`;
    const forwardId = newTestId();
    // Through initech's submission so the message is fully DMARC-clean.
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: mintAddr,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: mintAddr,
        subject: "First contact via catch-all",
        testId: forwardId,
      }),
    });
    await waitForMail(wes, forwardId, { timeoutMs: 60_000 });

    // The alias was minted on the fly, marked automatic, on the domain.
    const mintedRows = await db.select().from(aliases).where(eq(aliases.email, mintAddr));
    const minted = mintedRows[0];
    expect(minted).toBeDefined();
    expect(minted!.automaticCreation).toBe(true);
    expect(minted!.domainId).toBe(domainId);
    expect(minted!.note).toContain("catch-all");

    // ── Catch-all back OFF: fresh localparts are refused again ──────────
    await api("PATCH", `/api/custom_domains/${domainId}`, { catch_all: false });
    await expectRcptReject(`nobody-${randomTag()}@${domainName}`, "550");

    // ── Tombstones win over catch-all ───────────────────────────────────
    const del = await api<{ deleted: boolean }>("DELETE", `/api/aliases/${minted!.id}`);
    expect(del.status).toBe(200);
    await api("PATCH", `/api/custom_domains/${domainId}`, { catch_all: true });
    await expectRcptReject(mintAddr, "550");
  }, 300_000);
});
