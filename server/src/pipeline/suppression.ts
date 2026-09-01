/**
 * Mailbox-level bounce suppression (ABUSE.md Tier 1 — "the single
 * highest-value control"). The alias auto-disable ledger is per (alias,
 * mailbox) and threshold-based; one dead mailbox behind 40 aliases bleeds
 * bounce-by-bounce, alias-by-alias. This module keys on the ENHANCED status
 * code of a forward-phase bounce instead:
 *
 *   5.1.1 (no such user) / 5.2.1 (account disabled) → suppress the MAILBOX,
 *   first strike, no threshold: a banned Gmail account or a dead disposable
 *   domain earns nothing by retry. Every alias delivering there pauses
 *   (policy.ts drops inbound with a "mailbox_suppressed" blocked log —
 *   never bounces it), and the user is notified in-app.
 *
 *   Anything else (4.x.x, mailbox-full, policy rejections) → untouched;
 *   retries/backoff and the threshold ledger keep working.
 *
 * Resumption requires RE-VERIFICATION (the user clicks a fresh emailed
 * code — mailboxRoutes clears suppressed_at on success). Never auto-resume
 * when the domain answers again: an expired disposable domain recycled into
 * a spamtrap looks exactly like a recovery.
 *
 * Forward phase only: a reply-phase 5.1.1 means the CONTACT's address is
 * dead, which says nothing about our user's mailbox.
 */

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type Mailbox, mailboxes } from "../db/schema.ts";
import { mailboxSuppressedTotal } from "../metrics/index.ts";
import { sendAlertOnce } from "./bounce.ts";

/** The first-strike enhanced codes: the mailbox itself is gone. */
export const SUPPRESSION_ENHANCED_CODES = ["5.1.1", "5.2.1"] as const;

/** True when a bounce's enhanced status code warrants first-strike suppression. */
export function isSuppressionCode(enhancedCode: string | undefined | null): boolean {
  if (enhancedCode == null) return false;
  return (SUPPRESSION_ENHANCED_CODES as readonly string[]).includes(enhancedCode.trim());
}

export interface SuppressResult {
  /** True when THIS call flipped the mailbox to suppressed. */
  suppressed: boolean;
  mailbox: Mailbox | null;
}

/**
 * Suppress one mailbox (idempotent: only the call that claims the flip
 * notifies). The notification rides sent_alerts de-dupe like every alert.
 */
export async function suppressMailbox(
  db: Db,
  mailboxId: number,
  opts: { enhancedCode: string; now?: Date } = { enhancedCode: "5.1.1" },
): Promise<SuppressResult> {
  const now = opts.now ?? new Date();
  const updated = await db
    .update(mailboxes)
    .set({ suppressedAt: now })
    .where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.suppressedAt)))
    .returning();
  const mailbox = updated[0];
  if (mailbox === undefined) {
    // Already suppressed, or no such row — either way nothing to do.
    const rows = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
    return { suppressed: false, mailbox: rows[0] ?? null };
  }

  mailboxSuppressedTotal.inc({ code: opts.enhancedCode });
  const meaning = opts.enhancedCode === "5.2.1" ? "the account is disabled" : "no such user exists";
  await sendAlertOnce(db, {
    userId: mailbox.userId,
    toEmail: mailbox.email,
    alertType: `mailbox_suppressed_${mailbox.id}`,
    title: `Deliveries to ${mailbox.email} are paused`,
    message:
      `Your mailbox ${mailbox.email} rejected a forwarded email saying ${meaning} ` +
      `(${opts.enhancedCode}), so forwarding to it is paused for every alias that ` +
      `delivers there — retrying a dead mailbox only hurts deliverability. Incoming ` +
      `mail is dropped while paused. When the mailbox works again, re-verify it ` +
      `from the dashboard to resume.`,
    now,
  });
  return { suppressed: true, mailbox };
}
