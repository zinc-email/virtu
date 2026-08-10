/**
 * Stories: SMTP outbound beyond the basic alias reply (M2) — the contact
 * metadata deciding WHICH alias goes on the wire, cold email straight from
 * an alias, per-device SMTP passwords, and the refuse-to-leak guards.
 *
 *   1. Reply with MAIL FROM = the MAILBOX (what a stock MUA does): the
 *      reverse-alias contact row picks the outbound alias.
 *   2. Cold email with MAIL FROM = the ALIAS to a never-contacted outside
 *      address: delivered with From = the alias, DKIM passing, and a contact
 *      minted so the outside party's reply routes back.
 *   3. A per-device SMTP password created over the API authenticates a real
 *      submission; revoking it kills AUTH while the other device's lives.
 *   4. Leak guards: a Cc of the user's own mailbox refuses; recipients
 *      spanning two aliases refuse (ambiguous outbound identity).
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app/server.ts";
import { db } from "../src/db/index.ts";
import { contacts } from "../src/db/schema.ts";
import { connectSmtp } from "../src/smtp/index.ts";
import {
  createAlias,
  createApiKey,
  ensureDkimKey,
  ensureWes,
  type UserFixture,
  WES_PASSWORD,
} from "./fixtures.ts";
import { getHeader, getHeaders, waitForMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

const TEST_CA_URL = new URL("../docker/test/mkcert/rootCA.pem", import.meta.url);

/** A quiet initech inbox for cold-email stories (see docker vmailbox). */
const COLD_RECIPIENT = "lumberg@initech.com";

let fixture: UserFixture;
let testCa: string;

beforeAll(async () => {
  await waitForPort(milton.submission.host, milton.submission.port, 60_000);
  await waitForPort(wes.submission.host, wes.submission.port, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
  testCa = await Bun.file(TEST_CA_URL).text();
});

/** Connect + STARTTLS + AUTH to our submission service. */
async function submissionClient(password: string = WES_PASSWORD) {
  const client = await connectSmtp({
    host: wes.submission.host,
    port: wes.submission.port,
    name: "wes-mua.internal",
    tls: { ca: testCa },
  });
  await client.ehlo();
  await client.startTls();
  await client.auth({ username: wes.email, password });
  return client;
}

/** Milton → alias forward; returns the minted reverse alias. */
async function mintReverseAlias(aliasEmail: string): Promise<string> {
  const forwardId = newTestId();
  await smtpSend({
    host: milton.submission.host,
    port: milton.submission.port,
    from: milton.email,
    to: aliasEmail,
    data: buildMessage({
      from: `Milton Waddams <${milton.email}>`,
      to: aliasEmail,
      subject: "Original",
      testId: forwardId,
    }),
  });
  const forwarded = await waitForMail(wes, forwardId, { timeoutMs: 60_000 });
  const reverseAlias = /<([^>]+)>/.exec(getHeader(forwarded.raw, "From")!)?.[1];
  expect(reverseAlias).toBeDefined();
  return reverseAlias!;
}

describe("outbound: reply with MAIL FROM = mailbox", () => {
  test("the reverse-alias contact metadata picks the outbound alias", async () => {
    const alias = await createAlias(fixture);
    const reverseAlias = await mintReverseAlias(alias.email);

    // A stock MUA replies as its configured identity — the MAILBOX. The
    // contact row behind the reverse alias must select the alias.
    const replyId = newTestId();
    const client = await submissionClient();
    try {
      const result = await client.send({
        mailFrom: wes.email,
        rcptTo: [reverseAlias],
        data: buildMessage({
          from: `Wes <${wes.email}>`,
          to: reverseAlias,
          subject: "Re: Original",
          testId: replyId,
          messageId: `<${replyId}@qmail.com>`,
        }),
      });
      expect(result.accepted).toBe(true);
    } finally {
      await client.quit();
    }

    const { raw } = await waitForMail(milton, replyId, { timeoutMs: 60_000 });
    // Outbound identity is the alias the contact belongs to…
    expect(getHeader(raw, "From")).toBe(alias.email);
    // …the real recipient is restored, and the mailbox leaks nowhere.
    expect(getHeader(raw, "To")).toContain(milton.email);
    expect(raw.toString("latin1")).not.toContain(wes.email);
  }, 180_000);

  test("recipients spanning two aliases refuse (ambiguous identity)", async () => {
    const aliasA = await createAlias(fixture);
    const aliasB = await createAlias(fixture);
    const reverseA = await mintReverseAlias(aliasA.email);
    const reverseB = await mintReverseAlias(aliasB.email);

    const client = await submissionClient();
    try {
      const result = await client.send({
        mailFrom: wes.email,
        rcptTo: [reverseA, reverseB],
        data: buildMessage({
          from: wes.email,
          to: `${reverseA}, ${reverseB}`,
          subject: "which alias?",
          testId: newTestId(),
        }),
      });
      expect(result.accepted).toBe(false);
      expect(result.data?.code).toBe(550);
    } finally {
      await client.quit();
    }
  }, 180_000);
});

describe("outbound: cold email with MAIL FROM = alias", () => {
  test("delivered From the alias with dkim=pass; a contact is minted", async () => {
    const alias = await createAlias(fixture);
    const testId = newTestId();

    const client = await submissionClient();
    try {
      const result = await client.send({
        mailFrom: alias.email,
        rcptTo: [COLD_RECIPIENT],
        data: buildMessage({
          from: alias.email,
          to: COLD_RECIPIENT,
          subject: "Cold outreach",
          testId,
          messageId: `<${testId}@qmail.com>`, // mailbox-side id must not leak
          body: "Hi Bill — about those TPS reports.",
        }),
      });
      expect(result.accepted).toBe(true);
    } finally {
      await client.quit();
    }

    const { raw } = await waitForMail(COLD_RECIPIENT, testId, { timeoutMs: 60_000 });
    expect(getHeader(raw, "From")).toBe(alias.email);
    expect(getHeader(raw, "To")).toContain(COLD_RECIPIENT);

    // Fresh public Message-ID on the alias domain; mailbox-side id gone.
    const messageId = getHeader(raw, "Message-ID")!;
    expect(messageId).toContain("@virtu.email");
    expect(messageId).not.toContain("@qmail.com");

    // initech verified our signature.
    const initechAuth = getHeaders(raw, "Authentication-Results")
      .filter((v) => v.includes("mail.initech.com"))
      .join("\n");
    expect(initechAuth).toContain("dkim=pass");
    expect(initechAuth.toLowerCase()).toContain("header.d=virtu.email");

    // No trace of the real mailbox.
    expect(raw.toString("latin1")).not.toContain(wes.email);

    // The metadata survives: a contact for (alias, recipient) now exists, so
    // Lumbergh's reply will route back through the reverse alias.
    const contactRows = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.aliasId, alias.id), eq(contacts.websiteEmail, COLD_RECIPIENT)));
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0]!.replyEmail).toEndWith("@virtu.email");
  }, 180_000);

  test("a Cc of the user's own mailbox refuses at DATA (never leaks)", async () => {
    const alias = await createAlias(fixture);
    const client = await submissionClient();
    try {
      const result = await client.send({
        mailFrom: alias.email,
        rcptTo: [COLD_RECIPIENT],
        data: buildMessage({
          from: alias.email,
          to: COLD_RECIPIENT,
          subject: "oops",
          testId: newTestId(),
          extraHeaders: [`Cc: ${wes.email}`],
        }),
      });
      expect(result.accepted).toBe(false);
      expect(result.data?.code).toBe(550);
    } finally {
      await client.quit();
    }
  }, 60_000);
});

describe("outbound: per-device SMTP passwords", () => {
  test("create over the API, authenticate a real send, revoke, AUTH dies", async () => {
    const app = await buildApp({ logger: false });
    try {
      // Minted directly in the DB — the emailed login code is already on its
      // way to a peer Maildir, so the HTTP flow can't be round-tripped here.
      const apiKey = await createApiKey(fixture.user.id);

      const created = await app.inject({
        method: "POST",
        url: "/api/smtp/credentials",
        headers: { authentication: apiKey },
        payload: { name: `story-phone-${newTestId()}` },
      });
      expect(created.statusCode).toBe(201);
      const credential = created.json<{ id: number; password: string }>();

      // The device password drives a full cold send through port 587.
      const alias = await createAlias(fixture);
      const testId = newTestId();
      const client = await submissionClient(credential.password);
      try {
        const result = await client.send({
          mailFrom: alias.email,
          rcptTo: [COLD_RECIPIENT],
          data: buildMessage({
            from: alias.email,
            to: COLD_RECIPIENT,
            subject: "From my phone",
            testId,
          }),
        });
        expect(result.accepted).toBe(true);
      } finally {
        await client.quit();
      }
      await waitForMail(COLD_RECIPIENT, testId, { timeoutMs: 60_000 });

      // Revoke THIS device; its password stops working at the next AUTH…
      const del = await app.inject({
        method: "DELETE",
        url: `/api/smtp/credentials/${credential.id}`,
        headers: { authentication: apiKey },
      });
      expect(del.statusCode).toBe(200);
      await expect(submissionClient(credential.password)).rejects.toThrow(/535/);

      // …while the fixture's own device credential is untouched.
      const stillWorks = await submissionClient();
      await stillWorks.quit();
    } finally {
      await app.close();
    }
  }, 180_000);
});
