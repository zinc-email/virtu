/**
 * Custom-domain capability predicates — the "dumb code, smart data" seam.
 *
 * The `domains` table stores only the base verification facts (verified_owner,
 * verified_mx, verified_dkim, verified_spf, ...) and derives the winner-take-all
 * `name` column from verified_owner. The two *capabilities* a domain can have
 * are pure functions of those base flags, defined ONCE here and reused by both
 * the mail path and the API serializer (as computed can_receive/can_send
 * fields) — never re-derived at a call site.
 *
 * Receiving forwards inbound mail (re-signed with OUR service key), so it needs
 * only ownership + MX. Sending signs `d=customdomain`, so a broken DKIM/SPF
 * there would hurt deliverability/reputation — hence the stricter gate. DMARC
 * is surfaced as a quality flag but deliberately NOT gated: DKIM alignment
 * alone makes our outbound pass DMARC at the recipient.
 */

import type { Domain } from "../db/schema.ts";

/** Inbound forwarding is possible: the domain is owned and its MX points at us. */
export function canReceive(d: Pick<Domain, "verifiedOwner" | "verifiedMx">): boolean {
  return d.verifiedOwner && d.verifiedMx;
}

/** Outbound signing as the domain is safe: owned, with DKIM and SPF in place. */
export function canSend(
  d: Pick<Domain, "verifiedOwner" | "verifiedDkim" | "verifiedSpf">,
): boolean {
  return d.verifiedOwner && d.verifiedDkim && d.verifiedSpf;
}
