// The privacy boundary of the admin queue detail (PLAN decision #16): the
// raw bytea is users' mail, and an operator debugging the queue needs
// ROUTING facts, not content. Fixed allowlist — Date, addressing (which at
// this point in the pipeline is rewritten reverse-alias/mailbox data the
// operator can already see in the DB), threading ids, content-type,
// auto-submitted, and our own X-Virtu-* annotations. Deliberately absent:
// Subject (content), and everything not listed. No raw download exists.

import type { HeaderField } from "../../mail/index.ts";
import { unfoldValue } from "../../mail/headers.ts";

const ALLOWED = new Set([
  "date",
  "from",
  "to",
  "cc",
  "message-id",
  "in-reply-to",
  "references",
  "content-type",
  "auto-submitted",
]);

export interface AllowedHeader {
  name: string;
  value: string;
}

/** Filter parsed header fields down to the routing allowlist, in order. */
export function allowlistHeaders(fields: readonly HeaderField[]): AllowedHeader[] {
  const out: AllowedHeader[] = [];
  for (const field of fields) {
    const lower = field.name.toLowerCase();
    if (!ALLOWED.has(lower) && !lower.startsWith("x-virtu-")) continue;
    out.push({ name: field.name, value: unfoldValue(field.rawValue).trim() });
  }
  return out;
}
