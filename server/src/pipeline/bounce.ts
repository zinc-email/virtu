/**
 * Bounce handling (PLAN Lane C notes, SimpleLogin `should_disable`):
 *
 * A VERP recipient on the mx — or a permanent delivery failure in deliverd —
 * marks the referenced email_log bounced, then applies the auto-disable
 * thresholds per (alias, mailbox) — forward phase only:
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

import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import {
  aliases,
  aliasMailboxes,
  type EmailLog,
  emailLogs,
  type Mailbox,
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
  /**
   * Decoded message body, when available: multipart/report DSNs carry
   * per-recipient `Action:` fields (RFC 3464 §2.3.3) that distinguish a
   * real failure from a delay/relay notification.
   */
  body?: string;
}

/**
 * True when a message addressed to one of our VERP addresses looks like a
 * real delivery FAILURE notification rather than an auto-responder reply or
 * a transient-delay notice. Real DSNs are multipart/report (RFC 3464) — but
 * only `Action: failed` reports count; a "delivery delayed" report means
 * the mail may yet arrive and must not invalidate anything. Outside
 * multipart/report, a null reverse path counts unless the message marks
 * itself `Auto-Submitted: auto-replied` (RFC 3834 vacation responders): a
 * vacation reply to a verification email's Return-Path must NOT count as a
 * bounce — the email was delivered fine.
 */
export function looksLikeDsn(facts: DsnShapeFacts): boolean {
  if (facts.contentType !== undefined && /multipart\/report/i.test(facts.contentType)) {
    if (facts.body !== undefined) {
      const actions = [...facts.body.matchAll(/^action:\s*([a-z]+)/gim)].map((m) =>
        m[1]!.toLowerCase(),
      );
      // Reports that state only delayed/relayed/expanded actions are not
      // failures; no Action field at all is treated as a failure (the
      // conservative reading of a malformed report).
      if (actions.length > 0 && !actions.includes("failed")) return false;
    }
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

/**
 * sent_alerts ledger key marking "the (alias, mailbox) bounce ledger restarts
 * here" — written on detach so a fixed-and-re-added mailbox starts from zero.
 */
function ledgerResetType(aliasId: number, mailboxId: number): string {
  return `bounce_ledger_reset_${aliasId}_${mailboxId}`;
}

/** Result of {@link recordBounce}. */
export interface RecordBounceResult {
  emailLog: EmailLog | null;
  /** True when this bounce tripped a threshold and disabled the alias. */
  aliasDisabled: boolean;
  /**
   * Set when the threshold tripped for a MULTI-mailbox alias: the dead
   * mailbox was detached from the alias's delivery set instead of the whole
   * alias being disabled (PLAN #12: a broken extra must not cut off the
   * healthy mailboxes).
   */
  detachedMailboxId?: number;
}

/**
 * Mark an email_log bounced and apply the auto-disable thresholds (forward
 * phase only — reply bounces are recorded but never disable). Accounting is
 * per (alias, mailbox): only the bouncing mailbox's ledger counts. When the
 * threshold trips and the alias delivers to OTHER mailboxes too, the dead
 * mailbox is detached from this alias (extras dropped; a dead primary
 * promotes the first extra) and the alias stays enabled; only a sole
 * mailbox disables the alias itself. Idempotent: a log already marked
 * bounced keeps its first bouncedAt.
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

  // Per-(alias, mailbox) ledger window: bounded by the threshold window AND
  // by the newest ledger-reset marker — a mailbox that was detached and
  // later re-added starts from zero instead of being re-detached on its
  // first hiccup by the same still-in-window rows.
  let ledgerStart = new Date(now.getTime() - BOUNCE_DISABLE_THRESHOLDS.distinctDaysWindow * DAY_MS);
  if (log.mailboxId !== null) {
    const marker = (
      await db
        .select({ createdAt: sentAlerts.createdAt })
        .from(sentAlerts)
        .where(
          and(
            eq(sentAlerts.userId, alias.userId),
            eq(sentAlerts.alertType, ledgerResetType(alias.id, log.mailboxId)),
          ),
        )
        .orderBy(desc(sentAlerts.createdAt))
        .limit(1)
    )[0];
    if (marker !== undefined && marker.createdAt > ledgerStart) ledgerStart = marker.createdAt;
  }
  const bounceRows = await db
    .select({ bouncedAt: emailLogs.bouncedAt })
    .from(emailLogs)
    .where(
      and(
        eq(emailLogs.aliasId, alias.id),
        // Per-mailbox ledger: a dead extra's bounces must not count against
        // the copies the healthy mailboxes received.
        log.mailboxId === null
          ? isNull(emailLogs.mailboxId)
          : eq(emailLogs.mailboxId, log.mailboxId),
        eq(emailLogs.bounced, true),
        eq(emailLogs.isReply, false),
        isNotNull(emailLogs.bouncedAt),
        gt(emailLogs.bouncedAt, ledgerStart),
      ),
    );
  const bounceTimes = bounceRows.map((r) => r.bouncedAt).filter((d): d is Date => d !== null);

  const verdict = shouldDisable(bounceTimes, now);
  if (!verdict.disable) return { emailLog: log, aliasDisabled: false };

  // Threshold tripped. If the alias delivers to other HEALTHY mailboxes as
  // well, detach the dead one and keep the alias alive for the rest. All
  // rows are re-read INSIDE the transaction and the promote is guarded —
  // a concurrent mailbox-set change (replaceAliasMailboxes, API process)
  // must win over this path's snapshot, never be clobbered by it.
  if (log.mailboxId !== null) {
    const deadMailboxId = log.mailboxId;
    const detached = await db.transaction(async (tx) => {
      const fresh = (await tx.select().from(aliases).where(eq(aliases.id, alias.id)).limit(1))[0];
      if (fresh === undefined || !fresh.enabled) return false;
      const primaryRow = (
        await tx.select().from(mailboxes).where(eq(mailboxes.id, fresh.mailboxId)).limit(1)
      )[0];
      const extraRows = await tx
        .select({ mailbox: mailboxes })
        .from(aliasMailboxes)
        .innerJoin(mailboxes, eq(aliasMailboxes.mailboxId, mailboxes.id))
        .where(eq(aliasMailboxes.aliasId, alias.id))
        .orderBy(mailboxes.id);
      // Survivors must be deliverable (the delivery set's own predicate):
      // promoting an unverified/disabled mailbox would leave an enabled
      // alias that silently drops everything.
      const seen = new Set<number>();
      const survivors: Mailbox[] = [];
      for (const mb of [primaryRow, ...extraRows.map((r) => r.mailbox)]) {
        if (mb === undefined || mb.id === deadMailboxId || seen.has(mb.id)) continue;
        seen.add(mb.id);
        if (!mb.verified || mb.disabled) continue;
        survivors.push(mb);
      }
      if (survivors.length === 0) return false; // nothing healthy left → disable below

      if (fresh.mailboxId === deadMailboxId) {
        // Dead primary: promote the first healthy survivor — conditionally,
        // so a primary changed since the read is left alone.
        await tx
          .update(aliases)
          .set({ mailboxId: survivors[0]!.id })
          .where(and(eq(aliases.id, alias.id), eq(aliases.mailboxId, deadMailboxId)));
        await tx
          .delete(aliasMailboxes)
          .where(
            and(
              eq(aliasMailboxes.aliasId, alias.id),
              eq(aliasMailboxes.mailboxId, survivors[0]!.id),
            ),
          );
      }
      await tx
        .delete(aliasMailboxes)
        .where(
          and(eq(aliasMailboxes.aliasId, alias.id), eq(aliasMailboxes.mailboxId, deadMailboxId)),
        );
      // Durable ledger-reset marker (see the counting window above).
      await tx.insert(sentAlerts).values({
        userId: alias.userId,
        toEmail: alias.email,
        alertType: ledgerResetType(alias.id, deadMailboxId),
      });
      return true;
    });
    if (detached) {
      await sendAlertOnce(db, {
        userId: alias.userId,
        toEmail: alias.email,
        alertType: `bounce_detached_mailbox_${alias.id}_${deadMailboxId}`,
        title: `A mailbox was removed from ${alias.email}`,
        message:
          `Deliveries of ${alias.email} to one of its mailboxes kept bouncing ` +
          `(${verdict.reason}), so that mailbox was removed from the alias. ` +
          `Its other mailbox(es) continue to receive mail; re-add the mailbox ` +
          `from the dashboard once it works again.`,
        now,
      });
      return { emailLog: log, aliasDisabled: false, detachedMailboxId: deadMailboxId };
    }
  }

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
