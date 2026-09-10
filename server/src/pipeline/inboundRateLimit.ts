/**
 * Per-alias / per-mailbox inbound rate limit at the MX (ABUSE.md Tier 1,
 * SimpleLogin's MAX_ACTIVITY_DURING_MINUTE_PER_ALIAS / _PER_MAILBOX).
 *
 * Why this exists: every forward leaves on OUR IP. One alias being flooded
 * (a mailing-list explosion, a subscription bomb, a contact's runaway
 * script) becomes a flood from us into the user's mailbox provider — the
 * exact shape Gmail answers with "receiving mail at a rate that prevents
 * additional messages" and charges to the sending IP's ledger. Tempfailing
 * the excess at RCPT keeps the burst on the sender's side of the wire: the
 * originating MTA queues and retries, nothing is lost, and our outbound
 * rate to any one mailbox stays bounded no matter what arrives.
 *
 * Counting rides email_logs (one row per forward copy, created before the
 * rewrite) over a trailing 60s window — no extra bookkeeping table:
 *   - alias scope counts DISTINCT inbound messages (a multi-mailbox alias
 *     writes one row per copy; those copies are one message, not N)
 *   - mailbox scope counts copies per delivery mailbox — that IS the rate
 *     the mailbox provider sees from us
 * Blocked (accept-and-drop) rows count too, as in SimpleLogin: a disabled
 * alias under a flood still costs the MX the DATA transaction.
 *
 * Decision is pure ({@link decideInboundRateLimit}); the count is the one
 * DB-touching function. The MX turns a hit into `450 4.7.1` at RCPT.
 */

import { and, count, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { emailLogs } from "../db/schema.ts";

const MINUTE_MS = 60_000;

/** Config knobs (INBOUND_RATE_LIMIT_PER_ALIAS_PER_MINUTE / _PER_MAILBOX_...). */
export interface InboundRateLimits {
  /** Distinct inbound messages per alias per minute; 0 = unlimited. */
  perAliasPerMinute: number;
  /** Forward copies per delivery mailbox per minute; 0 = unlimited. */
  perMailboxPerMinute: number;
}

/** Which scope tripped, or null when the message may proceed. */
export type InboundRateLimitScope = "alias" | "mailbox";

/** What the trailing-minute count found. */
export interface InboundRateCounts {
  /** Distinct messages to the alias in the window. */
  aliasMessages: number;
  /** The busiest delivery mailbox's copy count in the window. */
  mailboxCopiesMax: number;
}

/**
 * Pure decision: the alias scope wins ties (it names the flooded address,
 * the more useful thing for the smtp_rejections row to say). A limit of 0
 * disables that scope.
 */
export function decideInboundRateLimit(
  limits: InboundRateLimits,
  counts: InboundRateCounts,
): InboundRateLimitScope | null {
  if (limits.perAliasPerMinute > 0 && counts.aliasMessages >= limits.perAliasPerMinute) {
    return "alias";
  }
  if (limits.perMailboxPerMinute > 0 && counts.mailboxCopiesMax >= limits.perMailboxPerMinute) {
    return "mailbox";
  }
  return null;
}

/**
 * Trailing-60s inbound counts for one alias and its delivery set. One query
 * per scope, both over the alias_id / mailbox_id indexes + created_at.
 */
export async function countRecentInbound(
  db: Db,
  scope: { aliasId: number | null; mailboxIds: number[] },
  now: Date = new Date(),
  transaction?: InboundTransaction,
): Promise<InboundRateCounts> {
  const windowStart = new Date(now.getTime() - MINUTE_MS);
  let aliasMessages = 0;
  // One message fans out to one row per delivery mailbox, so "messages" is
  // the busiest mailbox's row count (drops have no mailbox and land in the
  // NULL group, one row per message). Counting rows per group — never
  // collapsing on the sender-controlled Message-ID — is what keeps a
  // sender who repeats one Message-ID from reading as one message forever.
  if (scope.aliasId !== null) {
    const perGroup = await db
      .select({ mailboxId: emailLogs.mailboxId, n: count() })
      .from(emailLogs)
      .where(
        and(
          eq(emailLogs.aliasId, scope.aliasId),
          eq(emailLogs.isReply, false),
          gt(emailLogs.createdAt, windowStart),
        ),
      )
      .groupBy(emailLogs.mailboxId);
    for (const row of perGroup) aliasMessages = Math.max(aliasMessages, row.n);
  }
  let mailboxCopiesMax = 0;
  if (scope.mailboxIds.length > 0) {
    const perMailbox = await db
      .select({ mailboxId: emailLogs.mailboxId, n: count() })
      .from(emailLogs)
      .where(
        and(
          inArray(emailLogs.mailboxId, scope.mailboxIds),
          eq(emailLogs.isReply, false),
          gt(emailLogs.createdAt, windowStart),
        ),
      )
      .groupBy(emailLogs.mailboxId);
    const byMailbox = new Map<number, number>();
    for (const row of perMailbox) if (row.mailboxId !== null) byMailbox.set(row.mailboxId, row.n);
    for (const id of scope.mailboxIds) {
      const inFlight = transaction?.copiesByMailbox.get(id) ?? 0;
      mailboxCopiesMax = Math.max(mailboxCopiesMax, (byMailbox.get(id) ?? 0) + inFlight);
    }
  }
  return { aliasMessages, mailboxCopiesMax };
}

/**
 * What the current SMTP transaction has already accepted (nothing of it is
 * in email_logs yet — that happens at DATA). Without it, a hundred RCPTs
 * for a hundred fresh addresses on one mailbox each see an empty window.
 */
export interface InboundTransaction {
  /** Forward copies already accepted for each delivery mailbox. */
  copiesByMailbox: Map<number, number>;
}
