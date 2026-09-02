/**
 * Header rewrite for operator mail (pipeline/operatorMail.ts): an inbound
 * message to a role address (postmaster@, abuse@ …) on its way to an
 * operator's real mailbox. Pure over the header block, like rewriteForward.
 *
 * The one thing that matters here is DMARC alignment at the operator's
 * mailbox provider: the copy leaves on our IP under our DKIM signature, so
 * the From domain must be ours or Gmail junks every abuse report.
 *
 *   From:      "<original display> - user at domain" <postmaster@ours>
 *              (the forward-phase AT format, so the sender stays legible)
 *   Reply-To:  the original Reply-To when present, else the original From —
 *              an operator answers a complaint from their own mailbox.
 *   To/Cc:     verbatim (they name the role address; nothing to hide)
 *   plus X-Virtu-Operator-Mail: <localpart>, a synthesized Date when missing,
 *   and the forward-phase header whitelist (nothing else leaks through).
 */

import {
  type Address,
  formatAddress,
  formatDateHeader,
  type HeaderBlock,
  parseAddressList,
} from "./headers.ts";
import {
  applyHeaderWhitelist,
  FORWARD_HEADER_WHITELIST,
  forwardDisplayName,
} from "./rewriteForward.ts";

/** Everything the rewrite needs to know. */
export interface OperatorContext {
  /** The role address's localpart ("postmaster"). */
  localpart: string;
  /** Service domain the role address lives on. */
  mailDomain: string;
  /** Inbound envelope sender (fallback From when the header is missing). */
  envelopeFrom: string;
  now?: Date;
}

export interface OperatorResult {
  headers: HeaderBlock;
  /** The original From, for logging. */
  originalFrom: Address;
}

/** Forward whitelist plus Reply-To (kept verbatim here, unlike forwards). */
export const OPERATOR_HEADER_WHITELIST: readonly string[] = [
  ...FORWARD_HEADER_WHITELIST,
  "reply-to",
];

export function rewriteOperator(
  msg: { headers: HeaderBlock },
  ctx: OperatorContext,
): OperatorResult {
  const headers = msg.headers.clone();
  const now = ctx.now ?? new Date();

  applyHeaderWhitelist(headers, OPERATOR_HEADER_WHITELIST);

  const originalFromValue = headers.get("From");
  const originalFrom: Address = (originalFromValue !== undefined
    ? parseAddressList(originalFromValue)[0]
    : undefined) ?? {
    address: ctx.envelopeFrom !== "" ? ctx.envelopeFrom : "unknown-sender@invalid",
  };

  if (!headers.has("Date")) headers.append("Date", formatDateHeader(now));

  headers.replace(
    "From",
    formatAddress({
      name: forwardDisplayName(originalFrom),
      address: `${ctx.localpart}@${ctx.mailDomain}`,
    }),
  );
  if (!headers.has("Reply-To")) headers.append("Reply-To", formatAddress(originalFrom));
  headers.append("X-Virtu-Operator-Mail", ctx.localpart);

  return { headers, originalFrom };
}
