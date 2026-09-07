/**
 * Pre-queue policy: what happens to one RCPT TO address at the mx, and
 * whether an authenticated submission sender owns the address they claim.
 *
 * The decision itself ({@link decideRcpt}) is a pure function over
 * pre-fetched facts so the policy table is unit-testable without a DB;
 * {@link evaluateRcpt} is the thin adapter that gathers the facts.
 *
 * Disabled-alias semantics (PLAN Lane C): default accept-and-drop — the
 * alias's existence is not probed, so RCPT gets 250 and DATA is logged as
 * blocked and never queued. Nonexistent aliases on our domains get 550.
 */

import { and, eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import {
  type Alias,
  aliases,
  aliasMailboxes,
  deletedAliases,
  type Domain,
  domains,
  type Mailbox,
  mailboxes,
  type User,
  users,
} from "../db/schema.ts";
import { parseVerp, type VerpInfo } from "../mail/index.ts";
import {
  decideQueueQuota,
  pendingUsage,
  QUEUE_FULL_REPLY,
  type QueueQuotaLimits,
} from "../queue/quota.ts";
import {
  countRecentInbound,
  decideInboundRateLimit,
  type InboundRateLimits,
  type InboundRateLimitScope,
} from "./inboundRateLimit.ts";
import { effectiveOperators, listOperators, operatorLocalpart } from "./operatorMail.ts";

/**
 * The one bar a mailbox must clear to receive mail, shared by every site
 * that builds a delivery set (RCPT delivery mailboxes, the trash inbox,
 * the catch-all default, bounce-detach survivors): proven ownership, not
 * operator-disabled, and not bounce-suppressed (ABUSE.md Tier 1 —
 * pipeline/suppression.ts; suppression clears only via re-verification).
 */
export function mailboxDeliverable(
  mb: Pick<Mailbox, "verified" | "disabled" | "suppressedAt">,
): boolean {
  return mb.verified && !mb.disabled && mb.suppressedAt === null;
}

/**
 * Facts about a VERIFIED custom domain matching the address's domain, only
 * gathered when no alias matched (the catch-all question).
 */
export interface CatchAllFacts {
  domain: Domain;
  /** The domain owner's account. */
  owner: User;
  /** The owner's default mailbox — where a minted alias would deliver. */
  mailbox: Mailbox | null;
  /** The exact address was deleted before; tombstones are never re-minted. */
  tombstoned: boolean;
}

/** A role address on the service domain and who receives it (operatorMail.ts). */
export interface OperatorFacts {
  localpart: string;
  /** Effective operators with a deliverable default mailbox; may be empty. */
  recipients: { user: User; mailbox: Mailbox }[];
}

/** Facts about one RCPT address, gathered by {@link evaluateRcpt}. */
export interface RcptFacts {
  /** Non-null when the address parsed (and HMAC-verified) as one of our VERPs. */
  verp: VerpInfo | null;
  /**
   * Non-null when the address is postmaster@/abuse@/… on the service domain
   * (config.operatorLocalparts). Beats the alias lookup: the role addresses
   * are reserved (routes/aliasNew.ts) and must route to operators even if
   * a legacy alias squats the name.
   */
  operator: OperatorFacts | null;
  /** True when the address's domain is one we accept mail for. */
  isLocalDomain: boolean;
  alias: Alias | null;
  /** The alias's primary mailbox (aliases.mailbox_id). */
  mailbox: Mailbox | null;
  /**
   * Every healthy mailbox the alias delivers to: the primary plus the
   * alias_mailboxes extras, disabled/suppressed ones filtered out, primary
   * first. The mx enqueues one copy per entry; an unhealthy primary no
   * longer drops mail that a healthy extra mailbox could receive.
   */
  deliveryMailboxes: Mailbox[];
  /**
   * True when at least one of the alias's mailboxes was excluded from the
   * delivery set because it is bounce-suppressed — distinguishes the
   * "mailbox_suppressed" drop from plain "mailbox_unavailable" when the
   * set comes up empty.
   */
  suppressedFromDelivery: boolean;
  user: User | null;
  /**
   * The owner's designated trash mailbox, only gathered when the alias is
   * disabled (the "off"-alias question): mail for a disabled alias forwards
   * here instead of being dropped. Null when unset or unhealthy.
   */
  trashMailbox: Mailbox | null;
  catchAll: CatchAllFacts | null;
  /**
   * Inbound rate limit (pipeline/inboundRateLimit.ts): which scope is over
   * its trailing-minute budget, or null. Gathered for a recipient that
   * would deliver OR accept-and-drop — a drop still costs a contact row and
   * a blocked log per message, so it needs the same per-alias bound; a
   * reject never needs the count.
   */
  rateLimited: InboundRateLimitScope | null;
  /**
   * Per-user pending-queue cap (queue/quota.ts): true when the alias
   * owner's in-flight mail is at the cap. Only gathered for a recipient
   * that would deliver — the one RCPT kind that enqueues on a USER's
   * behalf (operator mail is the service's own; see quota.ts for the
   * bypass list).
   */
  queueFull: boolean;
}

/** What the mx should do with one RCPT address. */
export type RcptDecision =
  /** A signed bounce address of ours: accept; DATA runs bounce handling. */
  | { kind: "verp"; info: VerpInfo }
  /**
   * A role address (postmaster@ …): accept; DATA delivers a re-signed copy
   * to each recipient (mail/rewriteOperator.ts). An empty recipient list
   * is still accepted — postmaster must never bounce — and logged.
   */
  | { kind: "operator"; localpart: string; recipients: { user: User; mailbox: Mailbox }[] }
  /** Deliverable alias: accept; DATA runs the forward pipeline. `trash` marks
   * a disabled alias routed to the owner's trash mailbox (facts.mailbox is
   * the trash mailbox by the time the mx sees the decision). */
  | { kind: "deliver"; trash?: boolean }
  /**
   * Catch-all: create the alias on the fly, then deliver. Internal to
   * {@link evaluateRcpt} — it performs the mint and returns "deliver", so mx
   * callers never see this kind.
   */
  | { kind: "mint" }
  /** Accept-and-drop (250, blocked log, no queue). */
  | { kind: "drop"; reason: "alias_disabled" | "mailbox_unavailable" | "mailbox_suppressed" }
  | { kind: "reject"; code: number; enhanced: string; message: string };

/**
 * The policy table, pure over {@link RcptFacts}. Order matters and is part
 * of the contract (see unit tests): VERP first — bounce routing must work
 * even for addresses that look like nothing else — then existence, account
 * standing, alias standing, mailbox standing.
 */
export function decideRcpt(facts: RcptFacts): RcptDecision {
  if (facts.verp !== null) return { kind: "verp", info: facts.verp };
  if (facts.operator !== null) {
    return {
      kind: "operator",
      localpart: facts.operator.localpart,
      recipients: facts.operator.recipients,
    };
  }

  if (facts.alias === null) {
    // Catch-all mint (SimpleLogin's on-the-fly creation): only when the
    // domain opted in AND everything the minted alias needs is healthy.
    // Every failed precondition falls through to the ordinary "user
    // unknown" — the address genuinely doesn't exist, and a probe must not
    // learn WHY (tombstone, disabled owner, broken mailbox).
    const ca = facts.catchAll;
    if (
      ca !== null &&
      ca.domain.catchAll &&
      !ca.tombstoned &&
      !ca.owner.disabled &&
      ca.mailbox !== null &&
      !ca.mailbox.disabled &&
      // A suppressed default mailbox must not mint aliases that would only
      // ever drop (same bar as the delivery set, minus the historical
      // verified quirk kept above it).
      ca.mailbox.suppressedAt === null
    ) {
      return { kind: "mint" };
    }
    if (!facts.isLocalDomain) {
      return { kind: "reject", code: 554, enhanced: "5.7.1", message: "Relay access denied" };
    }
    return {
      kind: "reject",
      code: 550,
      enhanced: "5.1.1",
      message: "Recipient address rejected: User unknown",
    };
  }

  if (facts.user === null || facts.user.disabled) {
    return { kind: "reject", code: 550, enhanced: "5.7.1", message: "Account is disabled" };
  }

  if (!facts.alias.enabled) {
    // The trash-inbox concept: an "off" alias forwards to the owner's
    // designated trash mailbox when one is set and healthy; otherwise the
    // default accept-and-drop (existence stays unprobeable either way).
    if (facts.trashMailbox !== null && mailboxDeliverable(facts.trashMailbox)) {
      if (facts.rateLimited !== null) return rateLimitReject(facts.rateLimited);
      if (facts.queueFull) return queueFullReject();
      return { kind: "deliver", trash: true };
    }
    // Accept-and-drop is still bounded: every dropped message writes a
    // contact + blocked log at SMTP speed, so the per-alias budget gates it
    // exactly like a delivery (450 reveals nothing an enabled alias's 450
    // would not — existence stays unprobeable).
    if (facts.rateLimited !== null) return rateLimitReject(facts.rateLimited);
    return { kind: "drop", reason: "alias_disabled" };
  }

  if (facts.deliveryMailboxes.length === 0) {
    if (facts.rateLimited !== null) return rateLimitReject(facts.rateLimited);
    return {
      kind: "drop",
      reason: facts.suppressedFromDelivery ? "mailbox_suppressed" : "mailbox_unavailable",
    };
  }

  // Last gates before delivery: the trailing-minute budget, then the owner's
  // pending-queue cap. Both tempfail, so the sending MTA queues and retries
  // — the burst stays on its side of the wire instead of becoming our
  // outbound flood into the mailbox (or our Postgres filling up).
  if (facts.rateLimited !== null) return rateLimitReject(facts.rateLimited);
  if (facts.queueFull) return queueFullReject();

  return { kind: "deliver" };
}

/** The RCPT reply when the owner's queue is at its cap (queue/quota.ts). */
function queueFullReject(): RcptDecision {
  return { kind: "reject", ...QUEUE_FULL_REPLY };
}

/** The RCPT reply for an over-budget recipient (pipeline/inboundRateLimit.ts). */
function rateLimitReject(scope: InboundRateLimitScope): RcptDecision {
  return {
    kind: "reject",
    code: 450,
    enhanced: "4.7.1",
    message:
      scope === "alias"
        ? "Recipient is receiving mail too fast, try again later"
        : "Recipient mailbox is receiving mail too fast, try again later",
  };
}

/** Options for {@link evaluateRcpt}. */
export interface EvaluateRcptOptions {
  verpSecret: string;
  /** Domains whose non-alias localparts are "user unknown" (vs relay denied). */
  mailDomain: string;
  /**
   * Per-alias / per-mailbox trailing-minute budgets. Omitted = not enforced
   * (unit/int callers that don't care); the mx passes config's values.
   */
  inboundRateLimits?: InboundRateLimits;
  /**
   * Role-address localparts routed to operators (config.operatorLocalparts).
   * Omitted = none (callers that don't care).
   */
  operatorLocalparts?: readonly string[];
  /**
   * Per-user pending-queue cap (queue/quota.ts). Omitted = not enforced;
   * the mx passes config's values.
   */
  queueQuota?: QueueQuotaLimits;
  /**
   * Apply the inbound rate limit to accept-and-drop recipients too (default
   * true — the RCPT-time gate). The mx passes false at its DATA-time
   * re-evaluation: a drop enqueues nothing, so a budget that filled between
   * RCPT and DATA has nothing to protect there, and turning the drop into a
   * 450 would tempfail the whole message for its healthy co-recipients.
   */
  budgetDrops?: boolean;
  now?: Date;
}

/** A decision plus the rows it was made from (the mx reuses them at DATA). */
export interface EvaluatedRcpt {
  address: string;
  decision: RcptDecision;
  facts: RcptFacts;
}

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/** Gather facts for one RCPT address and decide. */
export async function evaluateRcpt(
  db: Db,
  address: string,
  opts: EvaluateRcptOptions,
): Promise<EvaluatedRcpt> {
  const normalized = address.trim().toLowerCase();
  const domain = domainOf(normalized);

  const verp = parseVerp(normalized, opts.verpSecret, { now: opts.now });

  // Role addresses (postmaster@ …): resolved before the alias lookup — see
  // RcptFacts.operator.
  let operator: OperatorFacts | null = null;
  const roleLocalpart =
    verp === null && opts.operatorLocalparts !== undefined
      ? operatorLocalpart(normalized, opts.mailDomain, opts.operatorLocalparts)
      : null;
  if (roleLocalpart !== null) {
    const recipients: { user: User; mailbox: Mailbox }[] = [];
    for (const o of effectiveOperators(await listOperators(db))) {
      if (o.mailbox !== null && mailboxDeliverable(o.mailbox)) {
        recipients.push({ user: o.user, mailbox: o.mailbox });
      }
    }
    operator = { localpart: roleLocalpart, recipients };
  }

  let alias: Alias | null = null;
  let user: User | null = null;
  let mailbox: Mailbox | null = null;
  const deliveryMailboxes: Mailbox[] = [];
  let suppressedFromDelivery = false;
  let trashMailbox: Mailbox | null = null;
  let catchAll: CatchAllFacts | null = null;

  if (verp === null && operator === null) {
    const rows = await db
      .select({ alias: aliases, user: users, mailbox: mailboxes })
      .from(aliases)
      .innerJoin(users, eq(aliases.userId, users.id))
      .leftJoin(mailboxes, eq(aliases.mailboxId, mailboxes.id))
      .where(eq(aliases.email, normalized))
      .limit(1);
    if (rows[0] !== undefined) {
      alias = rows[0].alias;
      user = rows[0].user;
      mailbox = rows[0].mailbox;
    }

    // The full delivery set: primary + alias_mailboxes extras, healthy ones
    // only (verified AND not disabled — same bar as the trash mailbox and the
    // mailbox-set validation), primary first, deduped by id. Never forward to
    // an address the user has not proven they control.
    if (alias !== null && alias.enabled) {
      const extraRows = await db
        .select({ mailbox: mailboxes })
        .from(aliasMailboxes)
        .innerJoin(mailboxes, eq(aliasMailboxes.mailboxId, mailboxes.id))
        .where(eq(aliasMailboxes.aliasId, alias.id))
        .orderBy(mailboxes.id);
      const seen = new Set<number>();
      for (const mb of [mailbox, ...extraRows.map((r) => r.mailbox)]) {
        if (mb === null || seen.has(mb.id)) continue;
        seen.add(mb.id);
        if (!mailboxDeliverable(mb)) {
          if (mb.verified && !mb.disabled && mb.suppressedAt !== null) {
            suppressedFromDelivery = true;
          }
          continue;
        }
        deliveryMailboxes.push(mb);
      }
    }

    // Disabled alias with a designated trash inbox: gather it so decideRcpt
    // can route there instead of dropping.
    if (alias !== null && !alias.enabled && user !== null && user.trashMailboxId !== null) {
      trashMailbox =
        (
          await db.select().from(mailboxes).where(eq(mailboxes.id, user.trashMailboxId)).limit(1)
        )[0] ?? null;
    }

    // No alias: is this a VERIFIED custom domain of ours? (Also what makes
    // an unknown localpart there "user unknown" instead of "relay denied".)
    if (alias === null) {
      // Owned + can-receive: `name` is set only for the ownership winner, and
      // verified_mx completes canReceive. Keying on the unique `name` means a
      // squatter's provisional claim (name = NULL) can never match here.
      const cdRows = await db
        .select({ cd: domains, owner: users })
        .from(domains)
        .innerJoin(users, eq(domains.userId, users.id))
        .where(and(eq(domains.name, domain), eq(domains.verifiedMx, true)))
        .limit(1);
      if (cdRows[0] !== undefined) {
        const { cd, owner } = cdRows[0];
        const mb =
          owner.defaultMailboxId === null
            ? null
            : ((
                await db
                  .select()
                  .from(mailboxes)
                  .where(eq(mailboxes.id, owner.defaultMailboxId))
                  .limit(1)
              )[0] ?? null);
        const tombstoned =
          (
            await db
              .select({ id: deletedAliases.id })
              .from(deletedAliases)
              .where(eq(deletedAliases.email, normalized))
              .limit(1)
          ).length > 0;
        catchAll = { domain: cd, owner, mailbox: mb, tombstoned };
      }
    }
  }

  // A domain is "ours" when it's the service domain, the domain of a known
  // alias, or a verified custom domain.
  const isLocalDomain = domain === opts.mailDomain || alias !== null || catchAll !== null;

  const facts: RcptFacts = {
    verp,
    operator,
    isLocalDomain,
    alias,
    mailbox,
    deliveryMailboxes,
    suppressedFromDelivery,
    user,
    trashMailbox,
    catchAll,
    rateLimited: null,
    queueFull: false,
  };
  let decision = decideRcpt(facts);

  // Trash delivery targets ONLY the trash mailbox: swap it in so the mx's
  // forward pipeline (which reads the delivery set) needs no special case.
  if (decision.kind === "deliver" && decision.trash === true && trashMailbox !== null) {
    facts.mailbox = trashMailbox;
    facts.deliveryMailboxes = [trashMailbox];
  }

  // Perform the catch-all mint here so callers only ever see "deliver": the
  // alias row must exist before DATA runs the forward pipeline anyway.
  if (decision.kind === "mint" && catchAll !== null && catchAll.mailbox !== null) {
    const minted = await mintCatchAllAlias(db, normalized, {
      domain: catchAll.domain,
      owner: catchAll.owner,
      mailbox: catchAll.mailbox,
    });
    if (minted !== null) {
      facts.alias = minted;
      facts.user = catchAll.owner;
      facts.mailbox = catchAll.mailbox;
      facts.deliveryMailboxes = [catchAll.mailbox];
      decision = { kind: "deliver" };
    } else {
      // Lost every race AND the row vanished (concurrent delete): the
      // address is tombstoned now — same answer a fresh evaluation gives.
      decision = {
        kind: "reject",
        code: 550,
        enhanced: "5.1.1",
        message: "Recipient address rejected: User unknown",
      };
    }
  }

  // Inbound rate limit: counted once the recipient would deliver or drop
  // (the delivery set as finally settled above — trash swap, catch-all mint
  // — is exactly what the mailbox scope must measure; a drop has no
  // mailboxes and is bounded by the alias scope alone), then the table
  // re-decides with the fact filled in.
  if (
    (decision.kind === "deliver" || (decision.kind === "drop" && opts.budgetDrops !== false)) &&
    opts.inboundRateLimits !== undefined &&
    facts.alias !== null
  ) {
    const counts = await countRecentInbound(
      db,
      { aliasId: facts.alias.id, mailboxIds: facts.deliveryMailboxes.map((mb) => mb.id) },
      opts.now,
    );
    facts.rateLimited = decideInboundRateLimit(opts.inboundRateLimits, counts);
    if (facts.rateLimited !== null) decision = decideRcpt(facts);
  }

  // Pending-queue cap: only a delivery enqueues, so only a delivery asks.
  if (decision.kind === "deliver" && opts.queueQuota !== undefined && facts.user !== null) {
    facts.queueFull = decideQueueQuota(opts.queueQuota, await pendingUsage(db, facts.user.id));
    if (facts.queueFull) decision = decideRcpt(facts);
  }

  return { address: normalized, decision, facts };
}

/**
 * Insert the on-the-fly alias (SimpleLogin's automatic creation). Race-safe:
 * concurrent RCPTs for the same fresh address collapse onto one row via the
 * unique(email) constraint + re-select.
 */
async function mintCatchAllAlias(
  db: Db,
  email: string,
  ca: { domain: Domain; owner: User; mailbox: Mailbox },
): Promise<Alias | null> {
  const inserted = await db
    .insert(aliases)
    .values({
      userId: ca.owner.id,
      email,
      mailboxId: ca.mailbox.id,
      domainId: ca.domain.id,
      note: `Created by the catch-all of ${ca.domain.nameRequested}`,
      automaticCreation: true,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0] !== undefined) return inserted[0];
  const existing = await db.select().from(aliases).where(eq(aliases.email, email)).limit(1);
  return existing[0] ?? null;
}

/** How a submission sender address relates to the authed user. */
export type SenderOwnership =
  | { kind: "alias"; alias: Alias }
  | { kind: "mailbox"; mailbox: Mailbox }
  | { kind: "none" };

/**
 * Submission-time MAIL FROM check: the address must be an alias or a mailbox
 * belonging to the authenticated user.
 */
export async function senderOwnership(
  db: Db,
  userId: number,
  address: string,
): Promise<SenderOwnership> {
  const normalized = address.trim().toLowerCase();
  const aliasRows = await db
    .select()
    .from(aliases)
    .where(and(eq(aliases.email, normalized), eq(aliases.userId, userId)))
    .limit(1);
  if (aliasRows[0] !== undefined) return { kind: "alias", alias: aliasRows[0] };

  const mailboxRows = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.email, normalized), eq(mailboxes.userId, userId)))
    .limit(1);
  if (mailboxRows[0] !== undefined) return { kind: "mailbox", mailbox: mailboxRows[0] };

  return { kind: "none" };
}
