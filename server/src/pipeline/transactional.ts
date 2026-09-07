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
 * 15-minute expiry, single-use. The last {@link MAX_ACTIVE_CODES} unexpired
 * codes of a scope are ALL valid (a resend never kills the code already in
 * the user's inbox — see createVerificationCode), and a successful verify
 * consumes every outstanding one. Wrong attempts are counted durably as
 * `sent_alerts` rows (alert type `verification_attempt_{codeId}` — schema v1
 * has no tries column, and this table is the documented rate-control ledger);
 * on the 3rd wrong attempt a code is invalidated (SimpleLogin's
 * MAX_ACTIVATION_TRIES / AccountActivation.tries behavior).
 *
 * Global ceiling: on top of the per-scope budget, `isRateLimited` refuses
 * every send once {@link config.transactionalMailHourlyMax} code emails went
 * out in the trailing hour — /auth/login lets anyone make us mail any
 * address, and a distributed flood at spam traps is a reputation event the
 * per-address and per-IP budgets alone cannot bound.
 */

import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNull, like, or } from "drizzle-orm";
import { config } from "../config.ts";
import type { Db } from "../db/index.ts";
import { sentAlerts, type VerificationCode, verificationCodes } from "../db/schema.ts";
import { transactionalCeilingRefusedTotal } from "../metrics/index.ts";
import { sendAlertOnce } from "./bounce.ts";
import { effectiveOperators, listOperators } from "./operatorMail.ts";
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
  /** Recipient account, for durable queue attribution (Lane K P2).
   * sendWithRateLimit's RateLimitScope supplies it automatically. */
  userId?: number;
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
      userId: opts.userId,
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
  /**
   * Global hourly ceiling on code mail across every scope; default
   * `config.transactionalMailHourlyMax`, 0 = unlimited. Overridable so tests
   * can pin it against the shared database.
   */
  globalHourlyMax?: number;
  now?: Date;
}

/** Resend policy: at most 3 activation/verification emails per hour. */
export const ACTIVATION_RESEND_MAX = 3;
export const ACTIVATION_RESEND_WINDOW_MS = 60 * 60 * 1000;

/** Why a send is refused: its own scope's budget, or the global ceiling. */
export type SendRefusal = "scope" | "ceiling";

/**
 * The send budget for one (user, recipient, alertType) scope: refused when
 * the scope used up its window, or when the global hourly ceiling on code
 * mail is reached ({@link transactionalCeiling}). Pure — no logging, no
 * metrics, no notifications; callers that turn a refusal into a 429 report
 * it once via {@link noteCeilingRefusal}. Exposed so routes can refuse
 * BEFORE doing side effects like minting a code.
 */
export async function sendBudget(db: Db, scope: RateLimitScope): Promise<SendRefusal | null> {
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
  if ((row?.n ?? 0) >= (scope.maxPerWindow ?? ACTIVATION_RESEND_MAX)) return "scope";
  const ceiling = await transactionalCeiling(db, { max: scope.globalHourlyMax, now });
  return ceiling.reached ? "ceiling" : null;
}

/** Boolean form of {@link sendBudget}. */
export async function isRateLimited(db: Db, scope: RateLimitScope): Promise<boolean> {
  return (await sendBudget(db, scope)) !== null;
}

/** Ledger key for one mailbox's verification sends. */
export function mailboxVerificationAlertType(mailboxId: number): string {
  return `mailbox_verification_${mailboxId}`;
}

/** Ledger key for login-code sends (every /auth/login submit shares it). */
export const LOGIN_CODE_ALERT_TYPE = "login_code";

/** Ledger key for sudo re-auth code sends. */
export const SUDO_CODE_ALERT_TYPE = "sudo_code";

/** Once-per-hour dedupe key for the operator notification when the ceiling trips. */
const CEILING_ALERT_TYPE = "transactional_ceiling";

/**
 * Code emails (login, sudo, mailbox verification) sent in the trailing hour,
 * across every user and address — the sent_alerts ledger rows those sends
 * write, minus the attempt-counter and alert rows that share the table.
 */
export async function countTransactionalSends(db: Db, now: Date = new Date()): Promise<number> {
  const windowStart = new Date(now.getTime() - ACTIVATION_RESEND_WINDOW_MS);
  const [row] = await db
    .select({ n: count() })
    .from(sentAlerts)
    .where(
      and(
        gt(sentAlerts.createdAt, windowStart),
        or(
          eq(sentAlerts.alertType, LOGIN_CODE_ALERT_TYPE),
          eq(sentAlerts.alertType, SUDO_CODE_ALERT_TYPE),
          like(sentAlerts.alertType, "mailbox\\_verification\\_%"),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** What {@link transactionalCeiling} found. */
export interface CeilingState {
  reached: boolean;
  /** Code emails in the trailing hour (0 when the ceiling is disabled). */
  sent: number;
  max: number;
}

/**
 * The circuit breaker, pure: is the trailing-hour count of code emails at
 * the ceiling? `max` defaults to config.transactionalMailHourlyMax; 0
 * disables. Reporting a refusal is {@link noteCeilingRefusal}'s job.
 */
export async function transactionalCeiling(
  db: Db,
  opts: { max?: number; now?: Date } = {},
): Promise<CeilingState> {
  const max = opts.max ?? config.transactionalMailHourlyMax;
  if (max <= 0) return { reached: false, sent: 0, max };
  const sent = await countTransactionalSends(db, opts.now ?? new Date());
  return { reached: sent >= max, sent, max };
}

/** Boolean form of {@link transactionalCeiling}. */
export async function isTransactionalCeilingReached(
  db: Db,
  opts: { max?: number; now?: Date } = {},
): Promise<boolean> {
  return (await transactionalCeiling(db, opts)).reached;
}

/**
 * Report one request refused by the ceiling: the counter
 * (`virtu_transactional_ceiling_refused_total`), a warn line, and one in-app
 * notification per hour to the operators — so a flood is noticed while it
 * is happening, not on the postmaster dashboards a week later. Called by
 * the route layer once per 429, never from the predicate.
 */
export async function noteCeilingRefusal(db: Db, now: Date = new Date()): Promise<void> {
  const { sent, max } = await transactionalCeiling(db, { now });
  transactionalCeilingRefusedTotal.inc();
  log.warn("ceiling_reached", {
    sentLastHour: sent,
    max,
    consequence: "refusing every login/sudo/mailbox-verification email (429) until the hour rolls",
  });
  for (const operator of effectiveOperators(await listOperators(db))) {
    await sendAlertOnce(db, {
      userId: operator.user.id,
      toEmail: operator.user.email,
      alertType: CEILING_ALERT_TYPE,
      windowMs: ACTIVATION_RESEND_WINDOW_MS,
      title: "Login-email ceiling reached",
      message:
        `${sent} login/verification emails went out in the last hour, at the ` +
        `TRANSACTIONAL_MAIL_HOURLY_MAX ceiling of ${max}. Every further request is ` +
        `refused (429) until the hour rolls. Normal growth: raise the ceiling. A ` +
        `flood: check the api logs for the source IPs and the addresses targeted.`,
      now,
    });
  }
}

/** Result of {@link sendWithRateLimit}. */
export interface SendWithRateLimitResult extends SendTransactionalResult {
  /** True when the send was suppressed by the budget or the ceiling. */
  rateLimited: boolean;
  /** Which of the two refused, when `rateLimited`. */
  refusal?: SendRefusal;
}

/**
 * `sendTransactional` behind the `sent_alerts` budget (SimpleLogin's
 * `send_email_with_rate_control`) and the global ceiling: when either
 * refuses, nothing is sent; otherwise a ledger row is written first, then
 * the send happens. Callers MUST look at `rateLimited` — a refused send that
 * still answers "code sent" leaves the user waiting for mail that never
 * comes (routes/verificationMail.ts is the one place routes do this).
 */
export async function sendWithRateLimit(
  db: Db,
  opts: SendTransactionalOptions & Omit<RateLimitScope, "toEmail">,
): Promise<SendWithRateLimitResult> {
  const scope: RateLimitScope = { ...opts, toEmail: opts.to };
  const refusal = await sendBudget(db, scope);
  if (refusal !== null) {
    log.info("rate_limited", {
      alertType: opts.alertType,
      to: opts.to,
      userId: opts.userId,
      refusal,
    });
    return { queued: false, messageId: "", rateLimited: true, refusal, error: "rate limited" };
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

/**
 * How many unused codes stay valid per scope — BY DEFINITION the send budget
 * ({@link ACTIVATION_RESEND_MAX}): within one hour a scope can mint at most
 * that many (routes/verificationMail.ts refuses before minting), so no
 * mint ever retires a code that was actually emailed. The point is the
 * lockout: /auth/login is unauthenticated, so anyone can request a code for
 * anyone — if a resend killed the previous code, three requests an hour
 * would keep a known user's in-flight code dead forever.
 */
export const MAX_ACTIVE_CODES: number = ACTIVATION_RESEND_MAX;

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
 * Create a fresh single-use code for the scope. Earlier unused codes stay
 * valid — the newest {@link MAX_ACTIVE_CODES} of them; anything older is
 * retired — so a stranger's request for someone else's address can never
 * kill the code that address is about to type in (SimpleLogin's delete-
 * then-create would). Returns the plaintext code exactly once — only its
 * hash is stored.
 */
export async function createVerificationCode(
  db: Db,
  opts: CreateCodeOptions,
): Promise<{ code: string; row: VerificationCode }> {
  const now = opts.now ?? new Date();
  const code = generateVerificationCode();
  const scope = codeScope(opts.userId, opts.purpose, opts.mailboxId);

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

  // Retire every unused code past the window (newest first, the row just
  // inserted counted): one statement, subquery-in-IN like retention.ts.
  const beyondWindow = db
    .select({ id: verificationCodes.id })
    .from(verificationCodes)
    .where(and(...scope, isNull(verificationCodes.usedAt)))
    .orderBy(desc(verificationCodes.id))
    .offset(MAX_ACTIVE_CODES);
  await db
    .update(verificationCodes)
    .set({ usedAt: now })
    .where(inArray(verificationCodes.id, beyondWindow));
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
 * Check a submitted code against the scope's active codes (the unused ones,
 * up to {@link MAX_ACTIVE_CODES}, all unexpired ones among them valid). A
 * match consumes EVERY outstanding code of the scope — the login happened,
 * nothing else should still open it. A wrong code books one attempt against
 * each live code in the durable ledger; a code whose budget is exhausted is
 * invalidated, and once no live code is left the result is "too_many"
 * (callers answer 410, the SimpleLogin behavior).
 */
export async function consumeVerificationCode(
  db: Db,
  opts: ConsumeCodeOptions,
): Promise<ConsumeVerificationResult> {
  const now = opts.now ?? new Date();
  const unused = and(
    ...codeScope(opts.userId, opts.purpose, opts.mailboxId),
    isNull(verificationCodes.usedAt),
  );
  // createVerificationCode caps the unused set at MAX_ACTIVE_CODES; no limit
  // here, so a row that slipped past it is consumed rather than hidden.
  const rows = await db
    .select()
    .from(verificationCodes)
    .where(unused)
    .orderBy(desc(verificationCodes.id));
  if (rows.length === 0) return "none";
  const live = rows.filter((row) => row.expiresAt.getTime() > now.getTime());
  if (live.length === 0) return "expired";

  const candidate = Buffer.from(hashVerificationCode(opts.code));
  // Compare against every live code, never short-circuiting.
  let matched = false;
  for (const row of live) {
    const expected = Buffer.from(row.codeHash);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }

  if (!matched) {
    const maxAttempts = opts.maxAttempts ?? MAX_VERIFICATION_ATTEMPTS;
    const dead: number[] = [];
    for (const row of live) {
      const attemptType = `verification_attempt_${row.id}`;
      await db
        .insert(sentAlerts)
        .values({ userId: opts.userId, toEmail: opts.toEmail, alertType: attemptType });
      const [attempts] = await db
        .select({ n: count() })
        .from(sentAlerts)
        .where(and(eq(sentAlerts.userId, opts.userId), eq(sentAlerts.alertType, attemptType)));
      if ((attempts?.n ?? 0) >= maxAttempts) dead.push(row.id);
    }
    if (dead.length > 0) {
      await db
        .update(verificationCodes)
        .set({ usedAt: now })
        .where(inArray(verificationCodes.id, dead));
    }
    return dead.length === live.length ? "too_many" : "wrong";
  }

  // Scope-wide, not the ids selected above: a code minted between that
  // SELECT and this UPDATE must die with the login too.
  await db.update(verificationCodes).set({ usedAt: now }).where(unused);
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
