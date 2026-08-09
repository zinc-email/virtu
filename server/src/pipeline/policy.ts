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
import { type Alias, aliases, type Mailbox, mailboxes, type User, users } from "../db/schema.ts";
import { parseVerp, type VerpInfo } from "../mail/index.ts";

/** Facts about one RCPT address, gathered by {@link evaluateRcpt}. */
export interface RcptFacts {
  /** Non-null when the address parsed (and HMAC-verified) as one of our VERPs. */
  verp: VerpInfo | null;
  /** True when the address's domain is one we accept mail for. */
  isLocalDomain: boolean;
  alias: Alias | null;
  user: User | null;
  mailbox: Mailbox | null;
}

/** What the mx should do with one RCPT address. */
export type RcptDecision =
  /** A signed bounce address of ours: accept; DATA runs bounce handling. */
  | { kind: "verp"; info: VerpInfo }
  /** Deliverable alias: accept; DATA runs the forward pipeline. */
  | { kind: "deliver" }
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

  if (!facts.alias.enabled) return { kind: "drop", reason: "alias_disabled" };

  if (facts.mailbox === null || facts.mailbox.disabled) {
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
  }

  // A domain is "ours" when it's the service domain or the domain of a known
  // alias (covers verified custom domains without an extra lookup for MVP).
  const isLocalDomain = domain === opts.mailDomain || alias !== null;

  const facts: RcptFacts = { verp, isLocalDomain, alias, user, mailbox };
  return { address: normalized, decision: decideRcpt(facts), facts };
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
