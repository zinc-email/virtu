/**
 * Address-equivalence for the "don't email your own mailbox" refuse-to-leak
 * guard (PLAN #9): an outbound recipient that would land back in the user's own
 * inbox must never go out. `mailboxMatchKey` maps an address to a comparison
 * key so a mailbox and a recipient that reach the SAME inbox compare equal.
 *
 * Normalizations, in order of confidence:
 *  - plus-tags are insignificant on essentially every provider → stripped.
 *  - Gmail treats localpart dots as insignificant and googlemail.com is an
 *    alias of gmail.com → dots removed and the domain folded, but ONLY for
 *    gmail.com/googlemail.com. Dot-stripping is deliberately Gmail-only:
 *    most providers treat dots as significant, so folding them elsewhere would
 *    wrongly refuse a legitimate cold email to a look-alike address.
 */
export function mailboxMatchKey(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at === -1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    domain = "gmail.com";
    local = local.replace(/\./g, "");
  }
  const plus = local.indexOf("+");
  if (plus !== -1) local = local.slice(0, plus);
  return `${local}@${domain}`;
}
