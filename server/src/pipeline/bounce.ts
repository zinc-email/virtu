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

import { and, eq, gt, isNotNull } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { aliases, type EmailLog, emailLogs, notifications, sentAlerts } from "../db/schema.ts";

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

/** Options for {@link sendAlertOnce}. */
export interface AlertInput {
  userId: number;
  /** Address the alert would be mailed to (dedup key with alertType). */
  toEmail: string;
  /** Dedup key, e.g. `bounce_disabled_alias_42`. */
  alertType: string;
  title: string;
  message: string;
  now?: Date;
  /** Dedup window; default 24h (SimpleLogin). */
  windowMs?: number;
}

/**
 * Write a notification row unless the same (user, toEmail, alertType) alert
 * fired within the window. Returns true when the alert was actually written.
 * (Actual alert *email* delivery is a milestone-4 concern; the rows are the
 * durable record either way.)
 */
export async function sendAlertOnce(db: Db, input: AlertInput): Promise<boolean> {
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
  await db.insert(notifications).values({
    userId: input.userId,
    title: input.title,
    message: input.message,
  });
  return true;
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
