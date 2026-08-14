/**
 * Transactional email (PLAN Lane C `transactional` VERP type) and the
 * verification codes built on it: login codes (the passwordless login/signup
 * flow), sudo re-auth codes, and mailbox verification.
 *
 * Sending mirrors SimpleLogin's `send_email`: a plain-text message from the
 * noreply address, DKIM-signed with our service key, enqueued with a unique
 * `transactional`-type VERP envelope sender so bounces route back to us.
 * `sendWithRateLimit` is SimpleLogin's `send_email_with_rate_control`: at
 * most N sends per (user, recipient, alert type) window, ledgered through
 * `sent_alerts` (the same table the bounce pipeline dedupes alerts through).
 *
 * Degrades gracefully in environments without a DKIM key (pure int tests,
 * fresh dev stacks): the message is enqueued unsigned and a warning logged —
 * verification-code rows are created by the callers regardless, so the flows
 * stay testable without a mail path.
 *
 * Verification codes: 6 random digits, stored as sha256 (codes are secrets),
 * 15-minute expiry, single-use. Wrong attempts are counted durably as
 * `sent_alerts` rows (alert type `verification_attempt_{codeId}` — schema v1
 * has no tries column, and this table is the documented rate-control ledger);
 * on the 3rd wrong attempt the code is invalidated (SimpleLogin's
 * MAX_ACTIVATION_TRIES / AccountActivation.tries behavior).
 */

import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { sentAlerts, type VerificationCode, verificationCodes } from "../db/schema.ts";
import {
  type Address,
  buildVerp,
  formatAddress,
  formatDateHeader,
  HeaderBlock,
  serializeMessage,
} from "../mail/index.ts";
import { createLogger } from "../log.ts";
import { signOutbound } from "../mailauth/index.ts";
import { enqueue } from "../queue/index.ts";
import { loadDkimKey } from "./dkim.ts";

const log = createLogger("transactional");

// ---------------------------------------------------------------------------
// Message building + sending
// ---------------------------------------------------------------------------

/** The noreply sender, SimpleLogin's `get_noreply_address` shape. */
export function noreplyAddress(mailDomain: string = config.mailDomain): Address {
  return { name: "Virtu (noreply)", address: `noreply@${mailDomain}` };
}

/** Input for the pure message builder. */
export interface TransactionalMessageInput {
  from: Address;
  to: string;
  subject: string;
  /** Plain text body; line endings are normalized to CRLF. */
  textBody: string;
  /** Full Message-ID value including angle brackets. */
  messageId: string;
  date: Date;
  /** Story-test addressing (X-Virtu-Test-Id). */
  testId?: string;
}

/**
 * Build a simple text/plain RFC 5322 message (pure — exported for unit
 * tests). No MIME multipart, no HTML: plain text only for MVP.
 */
export function buildTransactionalMessage(input: TransactionalMessageInput): {
  headers: HeaderBlock;
  body: Uint8Array;
} {
  const headers = new HeaderBlock();
  headers.append("From", formatAddress(input.from));
  headers.append("To", input.to);
  headers.append("Subject", input.subject);
  headers.append("Date", formatDateHeader(input.date));
  headers.append("Message-ID", input.messageId);
  headers.append("MIME-Version", "1.0");
  headers.append("Content-Type", "text/plain; charset=utf-8");
  headers.append("Content-Transfer-Encoding", "8bit");
  headers.append("X-Virtu-Type", "Transactional");
  if (input.testId !== undefined) headers.append("X-Virtu-Test-Id", input.testId);

  const text = input.textBody.replace(/\r?\n/g, "\r\n");
  const body = new TextEncoder().encode(text.endsWith("\r\n") ? text : `${text}\r\n`);
  return { headers, body };
}

/** Options for {@link sendTransactional}. */
export interface SendTransactionalOptions {
  to: string;
  subject: string;
  textBody: string;
  /** Story-test addressing (X-Virtu-Test-Id). */
  testId?: string;
  /** Object id encoded in the VERP envelope sender (0 = none). */
  refId?: number;
  /** Clock override for tests. */
  now?: Date;
}

/** Result of {@link sendTransactional}. Never throws — see `queued`. */
export interface SendTransactionalResult {
  /** True when the message reached the outbound queue. */
  queued: boolean;
  queueId?: number;
  messageId: string;
  /** Why the message was not queued (already logged). */
  error?: string;
}

/**
 * Build, DKIM-sign and enqueue one transactional email. Envelope: MAIL FROM
 * is a `transactional` VERP address on our domain, RCPT TO the recipient.
 * Failures (no queue, oversized, DB down) are logged and reported in the
 * result rather than thrown — transactional mail must never break the API
 * flow that triggered it. A missing DKIM key downgrades to unsigned.
 */
export async function sendTransactional(
  db: Db,
  opts: SendTransactionalOptions,
): Promise<SendTransactionalResult> {
  const now = opts.now ?? new Date();
  const messageId = `<${randomUUID()}@${config.mailDomain}>`;
  const { headers, body } = buildTransactionalMessage({
    from: noreplyAddress(),
    to: opts.to,
    subject: opts.subject,
    textBody: opts.textBody,
    messageId,
    date: now,
    testId: opts.testId,
  });

  try {
    let raw: Uint8Array;
    const dkimKey = await loadDkimKey(db, config.mailDomain, config.dkimSelector);
    if (dkimKey === null) {
      log.warn("dkim_key_missing", { domain: config.mailDomain, messageId });
      raw = serializeMessage(headers, body);
    } else {
      const signed = await signOutbound(headers, body, { dkimKeys: [dkimKey] });
      for (const err of signed.errors) {
        log.error("dkim_sign_error", {
          domain: err.signingDomain,
          selector: err.selector,
          error: err.err.message,
        });
      }
      raw = signed.message;
    }

    const envelopeFrom = buildVerp({
      type: "transactional",
      id: opts.refId ?? 0,
      secret: config.verpSecret,
      domain: config.mailDomain,
      now,
    });
    const queueId = await enqueue(db, {
      raw,
      envelopeFrom,
      envelopeTo: opts.to,
      maxRawBytes: config.smtpMaxMessageSize,
    });
    return { queued: true, queueId, messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("enqueue_failed", { messageId, to: opts.to, error: message });
    return { queued: false, messageId, error: message };
  }
}

// ---------------------------------------------------------------------------
// Rate-controlled sending (SimpleLogin send_email_with_rate_control)
// ---------------------------------------------------------------------------

/** Rate-control scope: at most `maxPerWindow` sends per window. */
export interface RateLimitScope {
  userId: number;
  /** Recipient (part of the ledger key, like SimpleLogin's SentAlert). */
  toEmail: string;
  /** Ledger key, e.g. `account_activation`. */
  alertType: string;
  /** Default {@link ACTIVATION_RESEND_MAX}. */
  maxPerWindow?: number;
  /** Default {@link ACTIVATION_RESEND_WINDOW_MS}. */
  windowMs?: number;
  now?: Date;
}

/** Resend policy: at most 3 activation/verification emails per hour. */
export const ACTIVATION_RESEND_MAX = 3;
export const ACTIVATION_RESEND_WINDOW_MS = 60 * 60 * 1000;

/**
 * True when the (user, recipient, alertType) scope already used up its send
 * budget for the current window. Exposed so routes can reject (429) BEFORE
 * doing side effects like invalidating a previous code.
 */
export async function isRateLimited(db: Db, scope: RateLimitScope): Promise<boolean> {
  const now = scope.now ?? new Date();
  const windowStart = new Date(now.getTime() - (scope.windowMs ?? ACTIVATION_RESEND_WINDOW_MS));
  const [row] = await db
    .select({ n: count() })
    .from(sentAlerts)
    .where(
      and(
        eq(sentAlerts.userId, scope.userId),
        eq(sentAlerts.toEmail, scope.toEmail),
        eq(sentAlerts.alertType, scope.alertType),
        gt(sentAlerts.createdAt, windowStart),
      ),
    );
  return (row?.n ?? 0) >= (scope.maxPerWindow ?? ACTIVATION_RESEND_MAX);
}

/** Result of {@link sendWithRateLimit}. */
export interface SendWithRateLimitResult extends SendTransactionalResult {
  /** True when the send was suppressed by the sent_alerts budget. */
  rateLimited: boolean;
}

/**
 * `sendTransactional` behind a `sent_alerts` budget (SimpleLogin's
 * `send_email_with_rate_control`): when the scope is over budget nothing is
 * sent; otherwise a ledger row is written first, then the send happens.
 */
export async function sendWithRateLimit(
  db: Db,
  opts: SendTransactionalOptions & Omit<RateLimitScope, "toEmail">,
): Promise<SendWithRateLimitResult> {
  const scope: RateLimitScope = { ...opts, toEmail: opts.to };
  if (await isRateLimited(db, scope)) {
    log.info("rate_limited", { alertType: opts.alertType, to: opts.to, userId: opts.userId });
    return { queued: false, messageId: "", rateLimited: true, error: "rate limited" };
  }
  await db.insert(sentAlerts).values({
    userId: opts.userId,
    toEmail: opts.to,
    alertType: opts.alertType,
  });
  const sent = await sendTransactional(db, opts);
  return { ...sent, rateLimited: false };
}

// ---------------------------------------------------------------------------
// Verification codes (account activation + mailbox verification)
// ---------------------------------------------------------------------------

/** Code lifetime: 15 minutes (SimpleLogin MailboxActivation expiry). */
export const VERIFICATION_CODE_TTL_MS = 15 * 60 * 1000;

/** Wrong attempts before the code dies (SimpleLogin MAX_ACTIVATION_TRIES). */
export const MAX_VERIFICATION_ATTEMPTS = 3;

export type VerificationPurpose = "login" | "sudo" | "mailbox";

/** 6 random digits, leading zeros kept (SimpleLogin's activation format). */
export function generateVerificationCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** sha256 hex of a code — the only form that touches the database. */
export function hashVerificationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Options for {@link createVerificationCode}. */
export interface CreateCodeOptions {
  userId: number;
  purpose: VerificationPurpose;
  /** Required for purpose "mailbox". */
  mailboxId?: number;
  ttlMs?: number;
  now?: Date;
}

/**
 * Create a fresh single-use code for the scope, invalidating any previous
 * unused code (one active code per scope, like SimpleLogin's delete-then-
 * create). Returns the plaintext code exactly once — only its hash is stored.
 */
export async function createVerificationCode(
  db: Db,
  opts: CreateCodeOptions,
): Promise<{ code: string; row: VerificationCode }> {
  const now = opts.now ?? new Date();
  const code = generateVerificationCode();

  await db
    .update(verificationCodes)
    .set({ usedAt: now })
    .where(
      and(
        ...codeScope(opts.userId, opts.purpose, opts.mailboxId),
        isNull(verificationCodes.usedAt),
      ),
    );

  const rows = await db
    .insert(verificationCodes)
    .values({
      userId: opts.userId,
      mailboxId: opts.mailboxId ?? null,
      purpose: opts.purpose,
      codeHash: hashVerificationCode(code),
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? VERIFICATION_CODE_TTL_MS)),
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error("verification_codes insert returned no row");
  return { code, row };
}

/** Outcome of {@link consumeVerificationCode}. */
export type ConsumeVerificationResult =
  /** Code matched; the row is now used. */
  | "ok"
  /** No active code exists for the scope. */
  | "none"
  /** The active code expired. */
  | "expired"
  /** Wrong code (attempt recorded). */
  | "wrong"
  /** Wrong code AND the attempt budget is spent — the code is now dead. */
  | "too_many";

/** Options for {@link consumeVerificationCode}. */
export interface ConsumeCodeOptions {
  userId: number;
  purpose: VerificationPurpose;
  /** Required for purpose "mailbox". */
  mailboxId?: number;
  code: string;
  /** Recipient the code was mailed to (attempt-ledger key). */
  toEmail: string;
  maxAttempts?: number;
  now?: Date;
}

/**
 * Check a submitted code against the scope's active (latest unused) code.
 * Single-use: a match marks the row used. A wrong code books one attempt in
 * the durable ledger; the attempt that exhausts the budget invalidates the
 * code ("too_many" — callers answer 410, the SimpleLogin behavior).
 */
export async function consumeVerificationCode(
  db: Db,
  opts: ConsumeCodeOptions,
): Promise<ConsumeVerificationResult> {
  const now = opts.now ?? new Date();
  const rows = await db
    .select()
    .from(verificationCodes)
    .where(
      and(
        ...codeScope(opts.userId, opts.purpose, opts.mailboxId),
        isNull(verificationCodes.usedAt),
      ),
    )
    .orderBy(desc(verificationCodes.id))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return "none";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";

  const candidate = Buffer.from(hashVerificationCode(opts.code));
  const expected = Buffer.from(row.codeHash);
  const match = candidate.length === expected.length && timingSafeEqual(candidate, expected);

  if (!match) {
    const attemptType = `verification_attempt_${row.id}`;
    await db
      .insert(sentAlerts)
      .values({ userId: opts.userId, toEmail: opts.toEmail, alertType: attemptType });
    const [attempts] = await db
      .select({ n: count() })
      .from(sentAlerts)
      .where(and(eq(sentAlerts.userId, opts.userId), eq(sentAlerts.alertType, attemptType)));
    if ((attempts?.n ?? 0) >= (opts.maxAttempts ?? MAX_VERIFICATION_ATTEMPTS)) {
      await db
        .update(verificationCodes)
        .set({ usedAt: now })
        .where(eq(verificationCodes.id, row.id));
      return "too_many";
    }
    return "wrong";
  }

  await db.update(verificationCodes).set({ usedAt: now }).where(eq(verificationCodes.id, row.id));
  return "ok";
}

/** WHERE fragment selecting one code scope. */
function codeScope(userId: number, purpose: VerificationPurpose, mailboxId?: number) {
  return [
    eq(verificationCodes.userId, userId),
    eq(verificationCodes.purpose, purpose),
    mailboxId === undefined
      ? isNull(verificationCodes.mailboxId)
      : eq(verificationCodes.mailboxId, mailboxId),
  ];
}

// ---------------------------------------------------------------------------
// Email templates (plain text only — MVP)
// ---------------------------------------------------------------------------

/** Ledger key for login-code sends (every /auth/login submit shares it). */
export const LOGIN_CODE_ALERT_TYPE = "login_code";

/** Ledger key for sudo re-auth code sends. */
export const SUDO_CODE_ALERT_TYPE = "sudo_code";

/** Ledger key for one mailbox's verification sends. */
export function mailboxVerificationAlertType(mailboxId: number): string {
  return `mailbox_verification_${mailboxId}`;
}

/**
 * The login-code email — one template for login AND signup, since the flow
 * can't (and shouldn't) reveal which one is happening. Copy carried over
 * from legacy virtu (views/emails/auth.php), minus the magic link.
 */
export function loginCodeEmail(code: string): { subject: string; textBody: string } {
  return {
    subject: `Your login code: ${code}`,
    textBody: [
      "Hello!",
      "",
      "We received a sign-in request for your email address.",
      "",
      "To authenticate your account, enter this one-time access code:",
      "",
      code,
      "",
      "The code expires in 15 minutes.",
      "",
      "We sent this message because you (or someone) entered your email address",
      "into our sign-in form. If you did not expect this email, you can safely",
      "ignore it. Please do not mark it as spam.",
    ].join("\n"),
  };
}

/** The sudo re-auth email: confirm a sensitive action on a logged-in account. */
export function sudoCodeEmail(code: string): { subject: string; textBody: string } {
  return {
    subject: `Your confirmation code: ${code}`,
    textBody: [
      "Hello!",
      "",
      "Someone logged in to your account asked to perform a sensitive action.",
      "",
      "To confirm it's you, enter this one-time confirmation code:",
      "",
      code,
      "",
      "The code expires in 15 minutes. If this wasn't you, log out of your",
      "other sessions and revoke any devices you don't recognize.",
    ].join("\n"),
  };
}

/** The mailbox-verification email (SimpleLogin's mailbox confirmation). */
export function mailboxVerificationEmail(
  mailboxEmail: string,
  code: string,
): { subject: string; textBody: string } {
  return {
    subject: `Please confirm your mailbox ${mailboxEmail}`,
    textBody: [
      "Hi,",
      "",
      `Enter this code to verify ${mailboxEmail} as a mailbox for your Virtu account:`,
      "",
      code,
      "",
      "The code expires in 15 minutes. If you did not request this, you can safely ignore this email.",
    ].join("\n"),
  };
}

/**
 * Extract the code from a verification email's text body (the code sits
 * alone on its own line). Shared with tests so the template and the
 * extraction can't drift apart.
 */
export function extractCodeFromBody(textBody: string): string | undefined {
  return /^(\d{6})\r?$/m.exec(textBody)?.[1];
}
