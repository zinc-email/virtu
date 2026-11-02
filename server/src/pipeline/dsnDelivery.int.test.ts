import { beforeAll } from "bun:test";
import { ensureTestSigningKey } from "../routes/intHarness.ts";
beforeAll(ensureTestSigningKey);
/**
 * sendFailureDsn's backscatter guard against the dockerized Postgres: a
 * forward whose inbound verdict was "flag" (is_spam on the email_log) never
 * earns its sender a DSN; a clean forward does. Parallel-safe: unique
 * addresses per test, nothing truncated.
 */

import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { aliases, contacts, emailLogs, mailboxes, outboundMessages, users } from "../db/schema.ts";
import { sendFailureDsn } from "./dsnDelivery.ts";
import { createForwardLog } from "./emailLog.ts";

const tag = () => crypto.randomUUID().slice(0, 8);

async function fixture(
  spamFlag: string | null,
  sender: { envelopeFrom?: string; senderAuthenticated?: boolean } = {
    envelopeFrom: "bounces@example.com",
    senderAuthenticated: true,
  },
) {
  const t = tag();
  const user = (
    await db
      .insert(users)
      .values({ email: `dsn-int-${t}@int.test`, activated: true })
      .returning()
  )[0]!;
  const mailbox = (
    await db
      .insert(mailboxes)
      .values({ userId: user.id, email: `dsn-mb-${t}@int.test`, verified: true })
      .returning()
  )[0]!;
  const alias = (
    await db
      .insert(aliases)
      .values({ userId: user.id, email: `dsn-${t}@virtu.email`, mailboxId: mailbox.id })
      .returning()
  )[0]!;
  const contact = (
    await db
      .insert(contacts)
      .values({
        userId: user.id,
        aliasId: alias.id,
        websiteEmail: `sender-${t}@example.com`,
        replyEmail: `ra-${t}@virtu.email`,
      })
      .returning()
  )[0]!;
  const emailLog = await createForwardLog(db, {
    userId: user.id,
    contactId: contact.id,
    aliasId: alias.id,
    mailboxId: mailbox.id,
    messageId: `<${t}@example.com>`,
    spamFlag,
    ...sender,
  });
  const raw = new TextEncoder().encode(
    `From: sender-${t}@example.com\r\nTo: ${alias.email}\r\nSubject: hi\r\nMessage-ID: <${t}@example.com>\r\n\r\nbody\r\n`,
  );
  const [original] = await db
    .insert(outboundMessages)
    .values({
      userId: user.id,
      emailLogId: emailLog.id,
      raw,
      envelopeFrom: "sender@example.com",
      envelopeTo: mailbox.email,
      status: "failed",
    })
    .returning();
  return { user, mailbox, alias, contact, emailLog, raw, original: original! };
}

describe("sendFailureDsn backscatter guard", () => {
  test("flagged inbound: skipped, nothing enqueued", async () => {
    const f = await fixture("spf-hardfail");
    expect(f.emailLog.isSpam).toBe(true);
    expect(f.emailLog.spamStatus).toBe("spf-hardfail");

    const outcome = await sendFailureDsn(db, {
      row: { id: f.original.id, raw: f.raw, envelopeTo: f.mailbox.email },
      verp: { type: "bounce_forward", id: f.emailLog.id },
      emailLog: f.emailLog,
      diagnostic: "550 5.1.1 no such user",
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "flagged_inbound" });

    const queued = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.emailLogId, f.emailLog.id), eq(outboundMessages.envelopeFrom, "")),
      );
    expect(queued).toHaveLength(0);
  });

  test("clean inbound: the DSN is enqueued to the SPF-authenticated return path, not the header From", async () => {
    const f = await fixture(null);
    expect(f.emailLog.isSpam).toBe(false);
    expect(f.emailLog.senderAuthenticated).toBe(true);

    const outcome = await sendFailureDsn(db, {
      row: { id: f.original.id, raw: f.raw, envelopeTo: f.mailbox.email },
      verp: { type: "bounce_forward", id: f.emailLog.id },
      emailLog: f.emailLog,
      diagnostic: "550 5.1.1 no such user",
    });
    expect(outcome.outcome).toBe("sent");

    const queued = await db
      .select({
        envelopeTo: outboundMessages.envelopeTo,
        envelopeFrom: outboundMessages.envelopeFrom,
      })
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.emailLogId, f.emailLog.id), eq(outboundMessages.envelopeFrom, "")),
      );
    expect(queued).toEqual([{ envelopeTo: "bounces@example.com", envelopeFrom: "" }]);
    expect(f.contact.websiteEmail).not.toBe("bounces@example.com");
  });

  test("distinct failed deliveries each get a notice; replaying one does not", async () => {
    const f = await fixture(null);
    try {
      const send = (id: number) =>
        sendFailureDsn(db, {
          row: { id, raw: f.raw, envelopeTo: f.mailbox.email },
          verp: { type: "bounce_forward", id: f.emailLog.id },
          emailLog: f.emailLog,
          diagnostic: "550 5.1.1 no such user",
        });
      const [second] = await db
        .insert(outboundMessages)
        .values({
          userId: f.user.id,
          emailLogId: f.emailLog.id,
          raw: f.raw,
          envelopeFrom: "sender@example.com",
          envelopeTo: f.mailbox.email,
          status: "failed",
        })
        .returning();
      expect((await send(f.original.id)).outcome).toBe("sent");
      expect((await send(second!.id)).outcome).toBe("sent");
      await db
        .update(outboundMessages)
        .set({ createdAt: new Date(0) })
        .where(eq(outboundMessages.id, f.original.id));
      expect((await send(f.original.id)).outcome).toBe("suppressed");
      const queued = await db
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.emailLogId, f.emailLog.id),
            eq(outboundMessages.envelopeFrom, ""),
          ),
        );
      expect(queued).toHaveLength(2);
    } finally {
      await db.delete(users).where(eq(users.id, f.user.id));
    }
  });

  test("return path without an SPF pass: no DSN (it would be backscatter)", async () => {
    const f = await fixture(null, {
      envelopeFrom: "forged@victim.example",
      senderAuthenticated: false,
    });
    const outcome = await sendFailureDsn(db, {
      row: { id: f.original.id, raw: f.raw, envelopeTo: f.mailbox.email },
      verp: { type: "bounce_forward", id: f.emailLog.id },
      emailLog: f.emailLog,
      diagnostic: "550 5.7.1 rejected",
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "originator_unauthenticated" });
  });

  test("null envelope sender: no DSN", async () => {
    const f = await fixture(null, { envelopeFrom: "", senderAuthenticated: false });
    const outcome = await sendFailureDsn(db, {
      row: { id: f.original.id, raw: f.raw, envelopeTo: f.mailbox.email },
      verp: { type: "bounce_forward", id: f.emailLog.id },
      emailLog: f.emailLog,
      diagnostic: "550 5.1.1 no such user",
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "originator_unresolvable" });
  });

  test("reply-phase DSNs ignore the flag (they go to our own user)", async () => {
    const f = await fixture("dmarc-quarantine");
    const replyLog = (
      await db
        .update(emailLogs)
        .set({ isReply: true })
        .where(eq(emailLogs.id, f.emailLog.id))
        .returning()
    )[0]!;
    const outcome = await sendFailureDsn(db, {
      row: { id: f.original.id, raw: f.raw, envelopeTo: f.contact.websiteEmail },
      verp: { type: "bounce_reply", id: replyLog.id },
      emailLog: replyLog,
      diagnostic: "550 5.1.1 no such user",
    });
    expect(outcome.outcome).toBe("sent");
  });
});
