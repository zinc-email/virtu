/**
 * Operator mail: the RFC 2142 role addresses on the service domain
 * (postmaster@, abuse@, …) and who receives them.
 *
 * Why: RFC 5321 §4.5.1 requires postmaster@ to exist; every feedback loop,
 * DNSBL delisting form and receiver postmaster team writes to abuse@ or
 * postmaster@ of the sending domain (and our own DSN text says "contact
 * postmaster@"). Until this module, both 550'd — "user unknown" from the
 * very MX asking to be trusted. Now they deliver to the operators.
 *
 * Who: admins (users.flags admin bit) who opted in via the operatorMail
 * flag (admin API / `bin/operator-mail`). When nobody has opted in, the
 * FIRST admin (lowest id) receives by default — a fresh deploy with one
 * operator gets postmaster mail without a settings step. Delivery targets
 * the operator's DEFAULT mailbox, which must clear the usual bar
 * (verified, not disabled, not suppressed — policy.ts mailboxDeliverable).
 *
 * How: the mx delivers a re-signed copy per operator (mail/rewriteOperator.ts)
 * on the null reverse path — an operator's dead mailbox must never bounce
 * an abuse report back to the reporter. No alias, no contact, no
 * email_log: operator mail is the service's own mail, outside the
 * per-user ledger.
 */

import { asc, eq, inArray, sql } from "drizzle-orm";
import { isAdmin, receivesOperatorMail, USER_FLAGS } from "../auth/userFlags.ts";
import type { Db } from "../db/index.ts";
import { type Mailbox, mailboxes, type User, users } from "../db/schema.ts";

/** One delivery target for operator mail. */
export interface OperatorRecipient {
  user: User;
  /** The operator's default mailbox; null when unset. */
  mailbox: Mailbox | null;
}

/**
 * The localpart when `address` is a role address on the service domain,
 * else null. Case-insensitive; localparts come from config.operatorLocalparts.
 */
export function operatorLocalpart(
  address: string,
  mailDomain: string,
  localparts: readonly string[],
): string | null {
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const localpart = address.slice(0, at).trim().toLowerCase();
  const domain = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (domain !== mailDomain.toLowerCase()) return null;
  return localparts.includes(localpart) ? localpart : null;
}

/**
 * Every activated, non-disabled admin with their default mailbox, lowest
 * id first — the "operators list" the admin surface shows.
 */
export async function listOperators(db: Db): Promise<OperatorRecipient[]> {
  const rows = await db
    .select({ user: users, mailbox: mailboxes })
    .from(users)
    .leftJoin(mailboxes, eq(users.defaultMailboxId, mailboxes.id))
    .where(sql`(${users.flags} & ${USER_FLAGS.admin}) <> 0`)
    .orderBy(asc(users.id));
  return rows
    .filter((r) => isAdmin(r.user) && r.user.activated && !r.user.disabled)
    .map((r) => ({ user: r.user, mailbox: r.mailbox }));
}

/**
 * Which operators operator mail goes to: the opted-in set, or the first
 * operator when nobody opted in. Pure over the list so the admin DTO's
 * `effective` flag and the mx agree by construction.
 */
export function effectiveOperators(operators: OperatorRecipient[]): OperatorRecipient[] {
  const optedIn = operators.filter((o) => receivesOperatorMail(o.user));
  if (optedIn.length > 0) return optedIn;
  return operators.slice(0, 1);
}

/** Flip the opt-in flag on a user. Returns the updated row, or null if unknown. */
export async function setOperatorMail(
  db: Db,
  userId: number,
  receives: boolean,
): Promise<User | null> {
  const current = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (current === undefined) return null;
  const flags = receives
    ? current.flags | USER_FLAGS.operatorMail
    : current.flags & ~USER_FLAGS.operatorMail;
  if (flags === current.flags) return current;
  const updated = await db.update(users).set({ flags }).where(eq(users.id, userId)).returning();
  return updated[0] ?? null;
}

/** Re-read the given users (test helper for callers holding stale rows). */
export async function usersById(db: Db, ids: number[]): Promise<User[]> {
  if (ids.length === 0) return [];
  return db.select().from(users).where(inArray(users.id, ids));
}
