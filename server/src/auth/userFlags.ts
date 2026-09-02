/**
 * users.flags bit registry (PLAN decision #16). The column is SimpleLogin's
 * User.flags shape (bigint, default 0), but the bits are OURS — flags never
 * crosses the SimpleLogin wire — so assignment starts at bit 0.
 *
 * HARD BOUND: bits 0–30 only. JS bitwise operators (`&`, `|`, `~`, `<<`)
 * truncate to int32, so a flag at bit 31+ would misbehave and a
 * read-modify-write (bin/admin-grant) would silently CLEAR any high bits.
 * If bit 31 is ever needed, this module must move to BigInt first.
 */

export const USER_FLAGS = {
  /** Operator: sees /api/admin/* and the SPA admin section. */
  admin: 1 << 0,
  /**
   * Opted in to operator mail: this admin's default mailbox receives the
   * RFC 2142 role addresses on the service domain (postmaster@, abuse@, …
   * — pipeline/operatorMail.ts). When no admin opts in, the first admin
   * receives them by default; postmaster must always land somewhere.
   */
  operatorMail: 1 << 1,
} as const;

export function hasFlag(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

export function isAdmin(user: { flags: number }): boolean {
  return hasFlag(user.flags, USER_FLAGS.admin);
}

export function receivesOperatorMail(user: { flags: number }): boolean {
  return hasFlag(user.flags, USER_FLAGS.operatorMail);
}
