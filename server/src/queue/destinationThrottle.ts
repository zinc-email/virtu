/**
 * Per-destination outbound backpressure (ABUSE.md Tier 3 — "automated
 * reputation responses" from PLAN Lane K P4, the cheap half).
 *
 * Every queue row retries on its own exponential schedule, which is right
 * for a mailbox that is busy and wrong for a PROVIDER that is angry: when
 * Gmail answers "421 4.7.28 ... rate limited" or Yahoo "421 4.7.0 [TSS04]
 * temporarily deferred", the other forty rows in the batch bound for the
 * same domain are about to hear the same thing — and each of those
 * connections is another data point on the receiver's ledger for our IP.
 * A cold IP in its first weeks is exactly where this compounds.
 *
 * So: a deferral SIGNAL from a domain pauses the whole domain. While
 * paused, deliverd puts rows for it back to pending until the pause lifts
 * without attempting them (and without spending a try). Pauses escalate
 * (base·2^strikes, capped); one successful delivery resets the strikes.
 * State lives in `destination_throttles` so it survives restarts and is
 * shared by every worker; an operator can clear a pause from the admin
 * surface.
 *
 * What counts as a signal ({@link isDeferralSignal}) is deliberately
 * narrow — over-pausing is its own deliverability failure:
 *   - 421 at ANY step: the server is closing the channel on us.
 *   - 4.7.x (policy) at greeting / EHLO / MAIL FROM / DATA: a deferral of
 *     US, not of one recipient.
 *   - NOT 4.7.x at RCPT TO: that is where greylisting lives ("451 4.7.1
 *     please try again later" — per recipient, expected, harmless), and
 *     where per-recipient overload lands ("450 4.2.1 receiving mail at a
 *     rate…" — not 4.7 anyway). Those stay on the row's own backoff.
 */

import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type DeliveryStep, type DestinationThrottle, destinationThrottles } from "../db/schema.ts";

/** The remote reply that ended a delivery attempt, as the throttle sees it. */
export interface DeliveryReply {
  code: number;
  enhancedCode?: string;
  step: DeliveryStep;
  /** First line of the reply text (for the admin view / last_reply). */
  text: string;
}

/** Pause-length knobs (config.destinationPauseBaseMs / MaxMs); base 0 = off. */
export interface DestinationThrottleOptions {
  baseMs: number;
  maxMs: number;
}

/** Default pause shape: 5 minutes doubling to an hour. */
export const DEFAULT_PAUSE_BASE_MS = 5 * 60_000;
export const DEFAULT_PAUSE_MAX_MS = 60 * 60_000;

/** Map the SMTP client's command name to the step enum. */
export function stepForCommand(command: string): DeliveryStep {
  const c = command.trim().toUpperCase();
  if (c === "GREETING") return "greeting";
  if (c === "EHLO" || c === "HELO") return "ehlo";
  if (c === "STARTTLS") return "starttls";
  if (c.startsWith("MAIL")) return "mail_from";
  if (c.startsWith("RCPT")) return "rcpt_to";
  return "data";
}

/** True when a reply means "this DOMAIN wants us to back off" (see module doc). */
export function isDeferralSignal(
  reply: Pick<DeliveryReply, "code" | "enhancedCode" | "step">,
): boolean {
  if (reply.code === 421) return true;
  if (reply.code < 400 || reply.code >= 500) return false;
  if (reply.step === "rcpt_to") return false;
  return reply.enhancedCode?.startsWith("4.7.") === true;
}

/** Pause length after `strikes` consecutive signals (strikes >= 1). */
export function pauseDurationMs(strikes: number, opts: DestinationThrottleOptions): number {
  const attempt = Math.max(1, strikes);
  return Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1));
}

/** Recipient domain of an envelope address, lowercased ("" when malformed). */
export function destinationDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Result of {@link recordDeferral}. */
export interface DeferralRecorded {
  domain: string;
  strikes: number;
  pausedUntil: Date;
}

/**
 * Register a deferral signal from `domain`: bump strikes, extend the pause,
 * remember the reply. Concurrent workers hitting the same domain race
 * harmlessly — the upsert is idempotent in shape and a double-counted
 * strike only lengthens a pause the domain asked for anyway.
 */
export async function recordDeferral(
  db: Db,
  domain: string,
  reply: DeliveryReply,
  opts: DestinationThrottleOptions,
  now: Date = new Date(),
): Promise<DeferralRecorded> {
  const existing = await db
    .select({ strikes: destinationThrottles.strikes })
    .from(destinationThrottles)
    .where(eq(destinationThrottles.domain, domain))
    .limit(1);
  const strikes = (existing[0]?.strikes ?? 0) + 1;
  const pausedUntil = new Date(now.getTime() + pauseDurationMs(strikes, opts));
  const lastReply = reply.text.split("\n")[0]?.slice(0, 512) ?? "";
  const values = {
    strikes,
    pausedUntil,
    lastCode: reply.code,
    lastEnhanced: reply.enhancedCode ?? null,
    lastStep: reply.step,
    lastReply,
    lastDeferredAt: now,
    updatedAt: now,
  };
  await db
    .insert(destinationThrottles)
    .values({ domain, pauses: 1, ...values })
    .onConflictDoUpdate({
      target: destinationThrottles.domain,
      set: { ...values, pauses: sql`${destinationThrottles.pauses} + 1` },
    });
  return { domain, strikes, pausedUntil };
}

/**
 * A delivery to `domain` succeeded: clear the strikes and any pause. One
 * guarded UPDATE that matches nothing for the common (never-throttled)
 * domain — the history columns stay for the admin view.
 */
export async function recordSuccess(
  db: Db,
  domain: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(destinationThrottles)
    .set({ strikes: 0, pausedUntil: null, updatedAt: now })
    .where(and(eq(destinationThrottles.domain, domain), gt(destinationThrottles.strikes, 0)))
    .returning({ domain: destinationThrottles.domain });
  return updated.length > 0;
}

/** Which of `domains` are paused right now → their pause end. */
export async function pausedUntilFor(
  db: Db,
  domains: string[],
  now: Date = new Date(),
): Promise<Map<string, Date>> {
  const unique = [...new Set(domains.filter((d) => d !== ""))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ domain: destinationThrottles.domain, pausedUntil: destinationThrottles.pausedUntil })
    .from(destinationThrottles)
    .where(
      and(inArray(destinationThrottles.domain, unique), gt(destinationThrottles.pausedUntil, now)),
    );
  const result = new Map<string, Date>();
  for (const row of rows) if (row.pausedUntil !== null) result.set(row.domain, row.pausedUntil);
  return result;
}

/** Every throttle row (paused first, then most recently deferred). */
export async function listThrottles(
  db: Db,
  now: Date = new Date(),
): Promise<DestinationThrottle[]> {
  const rows = await db.select().from(destinationThrottles);
  const paused = (r: DestinationThrottle) => r.pausedUntil !== null && r.pausedUntil > now;
  return rows.sort((a, b) => {
    const pa = paused(a) ? 1 : 0;
    const pb = paused(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.lastDeferredAt?.getTime() ?? 0) - (a.lastDeferredAt?.getTime() ?? 0);
  });
}

/** Operator lever: lift the pause and reset strikes. Returns false when unknown. */
export async function clearThrottle(
  db: Db,
  domain: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(destinationThrottles)
    .set({ strikes: 0, pausedUntil: null, updatedAt: now })
    .where(eq(destinationThrottles.domain, domain))
    .returning({ domain: destinationThrottles.domain });
  return updated.length > 0;
}

/** Paused-domain count now, for the on-scrape gauge (queue collectors). */
export async function countPaused(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db
    .select({ domain: destinationThrottles.domain })
    .from(destinationThrottles)
    .where(gt(destinationThrottles.pausedUntil, now));
  return rows.map((r) => r.domain);
}
