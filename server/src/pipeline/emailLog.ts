/**
 * email_logs DB adapter: one row per forward / reply / blocked drop, created
 * BEFORE the rewrite so the rewrite can stamp the row id into provenance
 * headers and VERP addresses. Also owns the Message-ID translation table
 * (messageId ↔ ourMessageId on the same rows) that keeps threading alive
 * across the reply phase.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type EmailLog, emailLogs } from "../db/schema.ts";

const MAX_MESSAGE_ID = 1024;
const MAX_OUR_MESSAGE_ID = 512;

function clip(value: string | null | undefined, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return value.length > max ? value.slice(0, max) : value;
}

/** Common insert shape. */
export interface EmailLogInput {
  userId: number;
  contactId: number;
  aliasId: number;
  mailboxId: number | null;
  /** Original Message-ID header of the inbound message, if any. */
  messageId?: string | null;
  /**
   * The inbound auth verdict's "flag" reason (SPF hard-fail without DMARC,
   * DMARC quarantine fail — mailauth/verify.ts) when the message was
   * delivered annotated rather than clean. Persisted as is_spam/spam_status
   * so downstream decisions can see it: a flagged message that later
   * bounces at the mailbox must NOT earn its (likely forged) sender a DSN.
   */
  spamFlag?: string | null;
}

/** is_spam/spam_status columns from the optional flag. */
function spamColumns(flag: string | null | undefined): {
  isSpam: boolean;
  spamStatus: string | null;
} {
  return flag === undefined || flag === null
    ? { isSpam: false, spamStatus: null }
    : { isSpam: true, spamStatus: flag.slice(0, 256) };
}

/** Create the log row for a forward (phase: contact → alias → mailbox). */
export async function createForwardLog(db: Db, input: EmailLogInput): Promise<EmailLog> {
  const rows = await db
    .insert(emailLogs)
    .values({
      userId: input.userId,
      contactId: input.contactId,
      aliasId: input.aliasId,
      mailboxId: input.mailboxId,
      isReply: false,
      messageId: clip(input.messageId, MAX_MESSAGE_ID),
      ...spamColumns(input.spamFlag),
    })
    .returning();
  return rows[0]!;
}

/** Create the log row for a reply (phase: mailbox → reverse alias → contact). */
export async function createReplyLog(db: Db, input: EmailLogInput): Promise<EmailLog> {
  const rows = await db
    .insert(emailLogs)
    .values({
      userId: input.userId,
      contactId: input.contactId,
      aliasId: input.aliasId,
      mailboxId: input.mailboxId,
      isReply: true,
      messageId: clip(input.messageId, MAX_MESSAGE_ID),
    })
    .returning();
  return rows[0]!;
}

/** Create a blocked-drop log row (disabled alias accept-and-drop etc.). */
export async function createBlockedLog(
  db: Db,
  input: EmailLogInput & {
    /** Why the drop happened ("alias_disabled" | "mailbox_suppressed" | …). */
    blockedReason?: string;
  },
): Promise<EmailLog> {
  const rows = await db
    .insert(emailLogs)
    .values({
      userId: input.userId,
      contactId: input.contactId,
      aliasId: input.aliasId,
      mailboxId: input.mailboxId,
      isReply: false,
      blocked: true,
      blockedReason: clip(input.blockedReason, 32),
      messageId: clip(input.messageId, MAX_MESSAGE_ID),
      ...spamColumns(input.spamFlag),
    })
    .returning();
  return rows[0]!;
}

/**
 * Persist a Message-ID translation pair on a log row: `original` is the
 * mailbox-side id (never leaked), `ours` the public id now on the message.
 */
export async function setMessageIdMap(
  db: Db,
  emailLogId: number,
  original: string | null,
  ours: string,
): Promise<void> {
  await db
    .update(emailLogs)
    .set({
      messageId: clip(original, MAX_MESSAGE_ID),
      ourMessageId: clip(ours, MAX_OUR_MESSAGE_ID),
    })
    .where(eq(emailLogs.id, emailLogId));
}

/**
 * Forward phase: translate one of OUR public Message-IDs back to the
 * mailbox-side original so the user's client threads a contact's reply.
 * Scoped per user so ids can never cross accounts.
 */
export async function resolveOriginalMessageId(
  db: Db,
  userId: number,
  ourMessageId: string,
): Promise<string | null> {
  const rows = await db
    .select({ messageId: emailLogs.messageId })
    .from(emailLogs)
    .where(and(eq(emailLogs.userId, userId), eq(emailLogs.ourMessageId, ourMessageId)))
    .limit(1);
  return rows[0]?.messageId ?? null;
}

/**
 * Reply phase: look up the public Message-ID previously assigned to a
 * mailbox-side original id (reuse on multi-recipient replies; rewrite of
 * References / In-Reply-To so mailbox ids never leak).
 */
export async function resolveOurMessageId(
  db: Db,
  userId: number,
  originalMessageId: string,
): Promise<string | null> {
  const rows = await db
    .select({ ourMessageId: emailLogs.ourMessageId })
    .from(emailLogs)
    .where(and(eq(emailLogs.userId, userId), eq(emailLogs.messageId, originalMessageId)))
    .limit(1);
  return rows[0]?.ourMessageId ?? null;
}
