/**
 * Story: per-custom-domain DKIM, full loop against real (fake-BIND) DNS.
 *
 * Wes brings user.com. The test mints the domain's own RSA signing key
 * (dkim_keys row, selector "dkim"), publishes its DKIM TXT and the
 * vt-verification ownership TXT into the dynamic user.com zone via nsupdate,
 * then runs the real verification checks (pipeline/dnsCheck.ts — the same
 * code the POST /custom_domains/:id/verify endpoint calls): ownership, MX
 * (already 10 mail.virtu.email in the zone), SPF (include:spf1.virtu.email)
 * and DKIM all flip true against live DNS; DMARC stays false (no record).
 *
 * With dkim_verified set, a reply from a user.com alias must be signed with
 * d=user.com (not the service key): Milton's copy at initech carries
 * dkim=pass header.d=user.com.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../src/config.ts";
import { db } from "../src/db/index.ts";
import { domains } from "../src/db/schema.ts";
import { CUSTOM_DOMAIN_DKIM_SELECTOR, ensureDkimKeyRow } from "../src/pipeline/dkim.ts";
import { OWNERSHIP_PREFIX, verifyCustomDomain } from "../src/pipeline/dnsCheck.ts";
import { connectSmtp } from "../src/smtp/index.ts";
import {
  createAlias,
  ensureCustomDomain,
  ensureDkimKey,
  ensureWes,
  type UserFixture,
  WES_PASSWORD,
} from "./fixtures.ts";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { nsupdate, publishTxt, quoteTxtValue } from "./nsupdate.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

const TEST_CA_URL = new URL("../docker/test/mkcert/rootCA.pem", import.meta.url);

let fixture: UserFixture;
let testCa: string;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await waitForPort(wes.submission.host, wes.submission.port, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
  testCa = await Bun.file(TEST_CA_URL).text();
});

describe("story: custom-domain DKIM (user.com)", () => {
  test("DNS checks flip the flags; replies sign with d=user.com", async () => {
    // ── Setup: domain row + its own signing key ─────────────────────────
    let domain = await ensureCustomDomain(fixture.user.id, "user.com");
    const keyRow = await ensureDkimKeyRow(db, "user.com", CUSTOM_DOMAIN_DKIM_SELECTOR);

    // First verification pass: generates + stores the ownership token. The
    // records may or may not exist yet (reruns against the same zone).
    let verification = await verifyCustomDomain(db, domain, { mailDomain: config.mailDomain });
    domain = verification.domain;
    const token = domain.ownershipTxtToken;
    expect(token).toBeTruthy();

    // ── Publish the records into the dynamic zone ───────────────────────
    // DKIM TXT gets its own name: replace is safe.
    await publishTxt(
      "user.com",
      `${CUSTOM_DOMAIN_DKIM_SELECTOR}._domainkey.user.com`,
      `v=DKIM1; k=rsa; p=${keyRow.publicKeyBase64}`,
    );
    // Ownership TXT lives at the APEX next to the zone's SPF record — add
    // without deleting (identical re-adds are no-ops in BIND).
    await nsupdate("user.com", [
      `update add user.com. 60 TXT ${quoteTxtValue(`${OWNERSHIP_PREFIX}=${token}`)}`,
    ]);

    // ── Verify against real DNS ─────────────────────────────────────────
    verification = await verifyCustomDomain(db, domain, { mailDomain: config.mailDomain });
    expect(verification.ownership).toEqual({ ok: true, errors: [] });
    expect(verification.mx).toEqual({ ok: true, errors: [] }); // zone: 10 mail.virtu.email
    expect(verification.spf).toEqual({ ok: true, errors: [] }); // include:spf1.virtu.email
    expect(verification.dkim).toEqual({ ok: true, errors: [] });
    expect(verification.dmarc.ok).toBe(false); // no _dmarc record on purpose

    domain = verification.domain;
    expect(domain.verifiedOwner).toBe(true);
    expect(domain.verifiedMx).toBe(true);
    expect(domain.verifiedSpf).toBe(true);
    expect(domain.verifiedDkim).toBe(true);
    expect(domain.verifiedDmarc).toBe(false);
    // Ownership verified => the generated `name` column is now populated.
    expect(domain.name).toBe("user.com");

    // DB round-trip really persisted the flags.
    const persisted = (
      await db.select().from(domains).where(eq(domains.id, domain.id)).limit(1)
    )[0]!;
    expect(persisted.verifiedDkim).toBe(true);

    // ── Forward mints the reverse alias ─────────────────────────────────
    const alias = await createAlias(fixture, { domain: "user.com", domainId: domain.id });
    const forwardId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "To your own domain",
        testId: forwardId,
      }),
    });
    const forwarded = await waitForMail(wes, forwardId, { timeoutMs: 60_000 });
    const reverseAlias = /<([^>]+)>/.exec(getHeader(forwarded.raw, "From")!)?.[1];
    expect(reverseAlias).toBeDefined();

    // ── Wes replies from the user.com alias via our submission ──────────
    const replyId = newTestId();
    const client = await connectSmtp({
      host: wes.submission.host,
      port: wes.submission.port,
      name: "wes-mua.internal",
      tls: { ca: testCa },
    });
    try {
      await client.ehlo();
      await client.startTls();
      await client.auth({ username: wes.email, password: WES_PASSWORD });
      const result = await client.send({
        mailFrom: alias.email,
        rcptTo: [reverseAlias!],
        data: buildMessage({
          from: alias.email,
          to: reverseAlias!,
          subject: "Re: To your own domain",
          testId: replyId,
          messageId: `<${replyId}@qmail.com>`, // mailbox-side id: must not leak
          body: "Sent from my own domain.",
        }),
      });
      expect(result.accepted).toBe(true);
    } finally {
      await client.quit();
    }

    // ── Milton sees dkim=pass for user.com ──────────────────────────────
    const { raw } = await waitForMail(milton, replyId, { timeoutMs: 60_000 });
    expect(getHeader(raw, "From")).toBe(alias.email);

    // The signature itself is d=user.com (the domain's own key)...
    const signatures = getHeaders(raw, "DKIM-Signature").join("\n");
    expect(signatures).toContain("d=user.com");

    // ...and initech VERIFIED it against the published TXT.
    const initechAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.initech.com"))
      .join("\n");
    expect(initechAuth).toContain("dkim=pass");
    expect(initechAuth.toLowerCase()).toContain("header.d=user.com");

    // Our public Message-ID lives on the alias domain now.
    const messageId = getHeader(raw, "Message-ID")!;
    expect(messageId).toContain("@user.com");
    expect(messageId).not.toContain("@qmail.com");

    // The user's real mailbox address leaks nowhere.
    expect(raw.toString("latin1")).not.toContain(wes.email);
  }, 300_000);
});
