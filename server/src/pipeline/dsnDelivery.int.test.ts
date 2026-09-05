/**
 * sendFailureDsn's backscatter guard against the dockerized Postgres: a
 * forward whose inbound verdict was "flag" (is_spam on the email_log) never
 * earns its sender a DSN; a clean forward does. Parallel-safe: unique
 * addresses per test, nothing truncated.
 */

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { aliases, contacts, emailLogs, mailboxes, outboundMessages, users } from "../db/schema.ts";
import { sendFailureDsn } from "./dsnDelivery.ts";
import { createForwardLog } from "./emailLog.ts";

const tag = () => crypto.randomUUID().slice(0, 8);

async function fixture(spamFlag: string | null) {
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
  });
  const raw = new TextEncoder().encode(
    `From: sender-${t}@example.com\r\nTo: ${alias.email}\r\nSubject: hi\r\nMessage-ID: <${t}@example.com>\r\n\r\nbody\r\n`,
  );
  return { user, mailbox, alias, contact, emailLog, raw };
}

describe("sendFailureDsn backscatter guard", () => {
  test("flagged inbound: skipped, nothing enqueued", async () => {
    const f = await fixture("spf-hardfail");
    expect(f.emailLog.isSpam).toBe(true);
    expect(f.emailLog.spamStatus).toBe("spf-hardfail");

    const outcome = await sendFailureDsn(db, {
      row: { id: 0, raw: f.raw, envelopeTo: f.mailbox.email },
      verp: { type: "bounce_forward", id: f.emailLog.id },
      emailLog: f.emailLog,
      diagnostic: "550 5.1.1 no such user",
    });
    expect(outcome).toEqual({ outcome: "skipped", reason: "flagged_inbound" });

    const queued = await db
      .select({ id: outboundMessages.id })
      .from(outboundMessages)
      .where(eq(outboundMessages.emailLogId, f.emailLog.id));
    expect(queued).toHaveLength(0);
  });

  test("clean inbound: the DSN is enqueued to the originator", async () => {
    const f = await fixture(null);
    expect(f.emailLog.isSpam).toBe(false);

    const outcome = await sendFailureDsn(db, {
      row: { id: 0, raw: f.raw, envelopeTo: f.mailbox.email },
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
      .where(eq(outboundMessages.emailLogId, f.emailLog.id));
    expect(queued).toEqual([{ envelopeTo: f.contact.websiteEmail, envelopeFrom: "" }]);
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
      row: { id: 0, raw: f.raw, envelopeTo: f.contact.websiteEmail },
      verp: { type: "bounce_reply", id: replyLog.id },
      emailLog: replyLog,
      diagnostic: "550 5.1.1 no such user",
    });
    expect(outcome.outcome).toBe("sent");
  });
});
