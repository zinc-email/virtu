/**
 * Bounce handling (PLAN Lane C notes, SimpleLogin `should_disable`):
 *
 * A VERP recipient on the mx — or a permanent delivery failure in deliverd —
 * marks the referenced email_log bounced, then applies the auto-disable
 * thresholds to the alias (forward phase only):
 *
 *   - more than 12 bounces in the last 24h, or
 *   - more than 10 bounces in the week BEFORE the last 24h AND more than 1
 *     in the last 24h (the exclusion mirrors SimpleLogin's 7d_1d window so
 *     a single-day burst below the daily threshold can't trip the weekly
 *     rule), or
 *   - bounces on at least 9 distinct days within the last 10 days.
 *
 * Disabling writes a notification row, de-duplicated through sent_alerts
 * (one alert per alias per 24h) so bounce storms never become alert storms.
 * `shouldDisable` is pure over bounce timestamps + an injected clock.
 */

import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import {
  aliases,
  type EmailLog,
  emailLogs,
  mailboxes,
  notifications,
  sentAlerts,
  users,
  type VerificationCode,
  verificationCodes,
} from "../db/schema.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The auto-disable thresholds, exported as data for tests/ops. */
export const BOUNCE_DISABLE_THRESHOLDS = {
  maxPerDay: 12,
  maxPerWeek: 10,
  weekRuleMinToday: 1,
  distinctDaysWindow: 10,
  distinctDaysTrigger: 9,
} as const;

/** Result of the pure threshold check. */
export type DisableVerdict = { disable: false } | { disable: true; reason: string };

/**
 * Pure threshold check over an alias's bounce timestamps. `bounceTimes` must
 * include the bounce being recorded; entries outside the 10-day window are
 * ignored. Clock injected for tests.
 */
export function shouldDisable(bounceTimes: Date[], now: Date): DisableVerdict {
  const t = now.getTime();
  const inWindow = bounceTimes.filter(
    (d) => d.getTime() > t - BOUNCE_DISABLE_THRESHOLDS.distinctDaysWindow * DAY_MS,
  );

  const last24h = inWindow.filter((d) => d.getTime() > t - DAY_MS).length;
  if (last24h > BOUNCE_DISABLE_THRESHOLDS.maxPerDay) {
    return {
      disable: true,
      reason: `more than ${BOUNCE_DISABLE_THRESHOLDS.maxPerDay} bounces in the last 24h`,
    };
  }

  // The week window deliberately EXCLUDES the last 24h (see module doc).
  const weekBeforeToday = inWindow.filter(
    (d) => d.getTime() > t - WEEK_MS - DAY_MS && d.getTime() <= t - DAY_MS,
  ).length;
  if (
    weekBeforeToday > BOUNCE_DISABLE_THRESHOLDS.maxPerWeek &&
    last24h > BOUNCE_DISABLE_THRESHOLDS.weekRuleMinToday
  ) {
    return {
      disable: true,
      reason: `more than ${BOUNCE_DISABLE_THRESHOLDS.maxPerWeek} bounces in the last week with repeats today`,
    };
  }

  const days = new Set<string>();
  for (const d of inWindow) days.add(d.toISOString().slice(0, 10));
  if (days.size >= BOUNCE_DISABLE_THRESHOLDS.distinctDaysTrigger) {
    return {
      disable: true,
      reason: `bounces on ${days.size} of the last ${BOUNCE_DISABLE_THRESHOLDS.distinctDaysWindow} days`,
    };
  }

  return { disable: false };
}

/** Dedup key for one rate-limited action (the sent_alerts row shape). */
export interface AlertClaimInput {
  userId: number;
  /** Address the alert/DSN would be mailed to (dedup key with alertType). */
  toEmail: string;
  /** Dedup key, e.g. `bounce_disabled_alias_42` or `dsn_bounce_forward_7`. */
  alertType: string;
  now?: Date;
  /** Dedup window; default 24h (SimpleLogin). */
  windowMs?: number;
}

/** Options for {@link sendAlertOnce}. */
export interface AlertInput extends AlertClaimInput {
  title: string;
  message: string;
}

/**
 * Claim a once-per-window slot in sent_alerts WITHOUT writing a notification
 * (used to rate-limit outbound mail such as DSNs, where the "alert" is the
 * message itself). Returns true when this call claimed the slot.
 */
export async function claimAlertOnce(db: Db, input: AlertClaimInput): Promise<boolean> {
  const now = input.now ?? new Date();
  const windowStart = new Date(now.getTime() - (input.windowMs ?? DAY_MS));

  const recent = await db
    .select({ id: sentAlerts.id })
    .from(sentAlerts)
    .where(
      and(
        eq(sentAlerts.userId, input.userId),
        eq(sentAlerts.toEmail, input.toEmail),
        eq(sentAlerts.alertType, input.alertType),
        gt(sentAlerts.createdAt, windowStart),
      ),
    )
    .limit(1);
  if (recent[0] !== undefined) return false;

  await db.insert(sentAlerts).values({
    userId: input.userId,
    toEmail: input.toEmail,
    alertType: input.alertType,
  });
  return true;
}

/**
 * Write a notification row unless the same (user, toEmail, alertType) alert
 * fired within the window. Returns true when the alert was actually written.
 * (Actual alert *email* delivery is a milestone-4 concern; the rows are the
 * durable record either way.)
 */
export async function sendAlertOnce(db: Db, input: AlertInput): Promise<boolean> {
  if (!(await claimAlertOnce(db, input))) return false;
  await db.insert(notifications).values({
    userId: input.userId,
    title: input.title,
    message: input.message,
  });
  return true;
}

/** Message-shape facts for {@link looksLikeDsn}. */
export interface DsnShapeFacts {
  /** Envelope MAIL FROM ("" = the null reverse path). */
  envelopeFrom: string;
  /** Content-Type header value, if any. */
  contentType?: string;
  /** Auto-Submitted header value, if any (RFC 3834). */
  autoSubmitted?: string;
}

/**
 * True when a message addressed to one of our VERP addresses looks like a
 * real delivery status notification rather than an auto-responder reply.
 * Real DSNs are multipart/report (RFC 3464) or at least use the null
 * reverse path; RFC 3834 auto-responses mark themselves `Auto-Submitted:
 * auto-replied`. A vacation reply to a verification email's Return-Path
 * must NOT count as a bounce — the email was delivered fine, and treating
 * the reply as a failure would invalidate a perfectly live code.
 */
export function looksLikeDsn(facts: DsnShapeFacts): boolean {
  if (facts.contentType !== undefined && /multipart\/report/i.test(facts.contentType)) {
    return true;
  }
  if (facts.envelopeFrom !== "") return false;
  const auto = facts.autoSubmitted?.trim().toLowerCase();
  return auto === undefined || !auto.startsWith("auto-replied");
}

/** Result of {@link recordTransactionalBounce}. */
export interface TransactionalBounceResult {
  /**
   * The verification_codes row this bounce invalidated; null when the VERP
   * id was unknown or the code was no longer live (already used, already
   * invalidated by an earlier bounce copy) — in which case nothing happened.
   */
  code: VerificationCode | null;
  /** True when a mailbox-verification bounce bumped nb_failed_checks. */
  mailboxFlagged: boolean;
}

/**
 * Intake for a bounced transactional email (VERP type `transactional`): the
 * VERP id is the verification_codes row the email carried (0 = none — e.g.
 * plain alert mail). The code is invalidated — the address demonstrably
 * cannot receive it, so letting it linger only invites confusion — and a
 * bounced mailbox-verification additionally bumps the mailbox's
 * nb_failed_checks. Either way the user gets a notification, de-duplicated
 * through sent_alerts like every other alert.
 *
 * Every side effect is gated on the guarded invalidation below actually
 * claiming a still-live code: duplicate bounce copies (MTA retries,
 * auto-responders re-mailing the VERP address) and late bounces of a code
 * the user already consumed are no-ops — one bounce event is one strike,
 * and a verified mailbox's health is never dinged retroactively.
 */
export async function recordTransactionalBounce(
  db: Db,
  refId: number,
  now: Date = new Date(),
): Promise<TransactionalBounceResult> {
  if (refId <= 0) return { code: null, mailboxFlagged: false };
  const invalidated = await db
    .update(verificationCodes)
    .set({ usedAt: now })
    .where(and(eq(verificationCodes.id, refId), isNull(verificationCodes.usedAt)))
    .returning();
  const code = invalidated[0];
  if (code === undefined) return { code: null, mailboxFlagged: false };

  if (code.mailboxId !== null) {
    const bumped = await db
      .update(mailboxes)
      .set({ nbFailedChecks: sql`${mailboxes.nbFailedChecks} + 1` })
      .where(eq(mailboxes.id, code.mailboxId))
      .returning();
    const mailbox = bumped[0];
    if (mailbox === undefined) return { code, mailboxFlagged: false };
    await sendAlertOnce(db, {
      userId: code.userId,
      toEmail: mailbox.email,
      alertType: `transactional_bounce_mailbox_${mailbox.id}`,
      title: `Verification email to ${mailbox.email} bounced`,
      message:
        `The verification email for your mailbox ${mailbox.email} could not be ` +
        `delivered. Check the address and request a new code.`,
      now,
    });
    return { code, mailboxFlagged: true };
  }

  const userRows = await db.select().from(users).where(eq(users.id, code.userId)).limit(1);
  const user = userRows[0];
  if (user !== undefined) {
    await sendAlertOnce(db, {
      userId: user.id,
      toEmail: user.email,
      alertType: `transactional_bounce_account_${user.id}`,
      title: "Your activation email bounced",
      message:
        `The activation email for your account could not be delivered to ` +
        `${user.email}. Check the address and request a new code.`,
      now,
    });
  }
  return { code, mailboxFlagged: false };
}

/** Result of {@link recordBounce}. */
export interface RecordBounceResult {
  emailLog: EmailLog | null;
  /** True when this bounce tripped a threshold and disabled the alias. */
  aliasDisabled: boolean;
}

/**
 * Mark an email_log bounced and apply the auto-disable thresholds to its
 * alias (forward phase only — reply bounces are recorded but never disable).
 * Idempotent: a log already marked bounced keeps its first bouncedAt.
 */
export async function recordBounce(
  db: Db,
  emailLogId: number,
  now: Date = new Date(),
): Promise<RecordBounceResult> {
  const found = await db.select().from(emailLogs).where(eq(emailLogs.id, emailLogId)).limit(1);
  const log = found[0];
  if (log === undefined) return { emailLog: null, aliasDisabled: false };

  if (!log.bounced) {
    await db
      .update(emailLogs)
      .set({ bounced: true, bouncedAt: log.bouncedAt ?? now })
      .where(eq(emailLogs.id, log.id));
    log.bounced = true;
    log.bouncedAt = log.bouncedAt ?? now;
  }

  if (log.isReply || log.aliasId === null) return { emailLog: log, aliasDisabled: false };

  const aliasRows = await db.select().from(aliases).where(eq(aliases.id, log.aliasId)).limit(1);
  const alias = aliasRows[0];
  if (alias === undefined || !alias.enabled || alias.cannotBeDisabled) {
    return { emailLog: log, aliasDisabled: false };
  }

  const windowStart = new Date(
    now.getTime() - BOUNCE_DISABLE_THRESHOLDS.distinctDaysWindow * DAY_MS,
  );
  const bounceRows = await db
    .select({ bouncedAt: emailLogs.bouncedAt })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.aliasId, alias.id),
        eq(emailLogs.bounced, true),
        eq(emailLogs.isReply, false),
        isNotNull(emailLogs.bouncedAt),
        gt(emailLogs.bouncedAt, windowStart),
      ),
    );
  const bounceTimes = bounceRows.map((r) => r.bouncedAt).filter((d): d is Date => d !== null);

  const verdict = shouldDisable(bounceTimes, now);
  if (!verdict.disable) return { emailLog: log, aliasDisabled: false };

  await db.update(aliases).set({ enabled: false }).where(eq(aliases.id, alias.id));
  await sendAlertOnce(db, {
    userId: alias.userId,
    toEmail: alias.email,
    alertType: `bounce_disabled_alias_${alias.id}`,
    title: `Alias ${alias.email} has been disabled`,
    message:
      `Your alias ${alias.email} was automatically disabled because forwarded ` +
      `emails kept bouncing (${verdict.reason}). Re-enable it from the dashboard ` +
      `once the destination mailbox works again.`,
    now,
  });
  return { emailLog: log, aliasDisabled: true };
}
