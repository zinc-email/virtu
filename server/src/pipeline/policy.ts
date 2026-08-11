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

/** Facts about one RCPT address, gathered by {@link evaluateRcpt}. */
export interface RcptFacts {
  /** Non-null when the address parsed (and HMAC-verified) as one of our VERPs. */
  verp: VerpInfo | null;
  /** True when the address's domain is one we accept mail for. */
  isLocalDomain: boolean;
  alias: Alias | null;
  /** The alias's primary mailbox (aliases.mailbox_id). */
  mailbox: Mailbox | null;
  /**
   * Every healthy mailbox the alias delivers to: the primary plus the
   * alias_mailboxes extras, disabled ones filtered out, primary first. The
   * mx enqueues one copy per entry; an unhealthy primary no longer drops
   * mail that a healthy extra mailbox could receive.
   */
  deliveryMailboxes: Mailbox[];
  user: User | null;
  /**
   * The owner's designated trash mailbox, only gathered when the alias is
   * disabled (the "off"-alias question): mail for a disabled alias forwards
   * here instead of being dropped. Null when unset or unhealthy.
   */
  trashMailbox: Mailbox | null;
  catchAll: CatchAllFacts | null;
}

/** What the mx should do with one RCPT address. */
export type RcptDecision =
  /** A signed bounce address of ours: accept; DATA runs bounce handling. */
  | { kind: "verp"; info: VerpInfo }
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
  | { kind: "drop"; reason: "alias_disabled" | "mailbox_unavailable" }
  | { kind: "reject"; code: number; enhanced: string; message: string };

/**
 * The policy table, pure over {@link RcptFacts}. Order matters and is part
 * of the contract (see unit tests): VERP first — bounce routing must work
 * even for addresses that look like nothing else — then existence, account
 * standing, alias standing, mailbox standing.
 */
export function decideRcpt(facts: RcptFacts): RcptDecision {
  if (facts.verp !== null) return { kind: "verp", info: facts.verp };

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
      !ca.mailbox.disabled
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
    if (
      facts.trashMailbox !== null &&
      facts.trashMailbox.verified &&
      !facts.trashMailbox.disabled
    ) {
      return { kind: "deliver", trash: true };
    }
    return { kind: "drop", reason: "alias_disabled" };
  }

  if (facts.deliveryMailboxes.length === 0) {
    return { kind: "drop", reason: "mailbox_unavailable" };
  }

  return { kind: "deliver" };
}

/** Options for {@link evaluateRcpt}. */
export interface EvaluateRcptOptions {
  verpSecret: string;
  /** Domains whose non-alias localparts are "user unknown" (vs relay denied). */
  mailDomain: string;
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

  let alias: Alias | null = null;
  let user: User | null = null;
  let mailbox: Mailbox | null = null;
  let deliveryMailboxes: Mailbox[] = [];
  let trashMailbox: Mailbox | null = null;
  let catchAll: CatchAllFacts | null = null;

  if (verp === null) {
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
        if (mb === null || mb.disabled || !mb.verified || seen.has(mb.id)) continue;
        seen.add(mb.id);
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
    isLocalDomain,
    alias,
    mailbox,
    deliveryMailboxes,
    user,
    trashMailbox,
    catchAll,
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
