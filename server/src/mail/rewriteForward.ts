/**
 * Forward-phase header rewriting (contact → alias → real mailbox), modeled on
 * SimpleLogin's `email_handler.py` forward path. Pure over the header block:
 * no DB, no network — everything stateful is injected through callbacks on
 * the context. The body is never touched.
 *
 * Envelope contract (caller's responsibility, provenance recorded here):
 *   mail from: VERP bounce address        rcpt to: real mailbox
 * Header contract produced here:
 *   From:     reverse alias for the contact (display name preserved,
 *             SimpleLogin sender_format AT style:
 *             `Wes Smith - wes at example.com <contact_at_example_com_abc@…>`)
 *   To/Cc:    every non-alias entry mapped to its reverse alias (contacts
 *             auto-created via callback so reply-all works); the alias entry
 *             itself is kept verbatim
 *   Reply-To: reverse alias(es) for the original Reply-To (max 5)
 *   plus X-Virtu-* provenance headers and a synthesized Date when missing.
 */

import {
  type Address,
  formatAddress,
  formatAddressList,
  formatDateHeader,
  type HeaderBlock,
  parseAddressList,
} from "./headers.ts";

/**
 * Forward-phase header whitelist (data, exported for wave 2 / tests).
 * Lowercase names; a trailing `*` is a prefix wildcard. Everything not
 * matching is dropped (SimpleLogin `delete_all_headers_except`).
 *
 * `x-virtu-test-id` is kept deliberately: Lane H's story tests address mail
 * by that header and must see it survive the rewrite.
 */
export const FORWARD_HEADER_WHITELIST: readonly string[] = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "references",
  "in-reply-to",
  "list-*",
  // MIME headers (SimpleLogin headers.MIME_HEADERS)
  "mime-version",
  "content-type",
  "content-disposition",
  "content-transfer-encoding",
  // virtu-specific passthrough
  "x-virtu-test-id",
];

/** True when a header name matches a whitelist (supports `prefix-*` wildcards). */
export function headerNameInList(name: string, list: readonly string[]): boolean {
  const lower = name.toLowerCase();
  for (const entry of list) {
    if (entry.endsWith("*")) {
      if (lower.startsWith(entry.slice(0, -1))) return true;
    } else if (lower === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Apply a whitelist to a header block in place. Returns the names of dropped
 * headers in original order (duplicates included).
 */
export function applyHeaderWhitelist(headers: HeaderBlock, whitelist: readonly string[]): string[] {
  const dropped: string[] = [];
  for (let i = headers.fields.length - 1; i >= 0; i--) {
    const field = headers.fields[i]!;
    if (!headerNameInList(field.name, whitelist)) {
      dropped.unshift(field.name);
      headers.fields.splice(i, 1);
    }
  }
  return dropped;
}

/** A contact's reverse alias, as resolved/created by the caller (DB in wave 2). */
export interface ContactRef {
  /** The reverse-alias address, e.g. `contact_at_example_com_abc12@virtu.tld`. */
  replyEmail: string;
}

/** Where in the message a contact reference was encountered. */
export type ContactSource = "from" | "reply-to" | "to" | "cc";

/** Context (alias, mailbox, callbacks) injected into {@link rewriteForward}. */
export interface ForwardContext {
  /** The alias that received the mail. */
  alias: { email: string };
  /** The real mailbox the mail is being forwarded to (recorded for provenance). */
  mailbox: { email: string };
  /** Original SMTP MAIL FROM of the inbound message. */
  envelopeFrom: string;
  /** Email-log row id for this forward (provenance + bounce correlation). */
  emailLogId: string | number;
  /**
   * Resolve or create the contact (reverse alias) for an external address.
   * Async on purpose — wave 2 backs this with the contacts table. May throw
   * (e.g. contact creation refused); the error propagates to the caller.
   */
  getOrCreateContact(addr: Address, source: ContactSource): Promise<ContactRef>;
  /**
   * Optional: translate one of OUR Message-IDs (generated in a previous
   * reply phase) back to the mailbox-side original, so threading survives
   * when a contact replies. Applied to In-Reply-To and References. Return
   * null when unknown (id kept as-is).
   */
  resolveOriginalMessageId?(ourMessageId: string): Promise<string | null>;
  /** Clock override for tests (synthesized Date header). */
  now?: Date;
}

/** Actions/observations from a forward rewrite, for the caller to act on. */
export interface ForwardActions {
  /** Header names removed by the whitelist, original order. */
  droppedHeaders: string[];
  /** True when the message had no Date and one was synthesized. */
  synthesizedDate: boolean;
  /** To/Cc entries skipped because their address was not plausibly valid. */
  invalidRecipients: string[];
}

/** Result of {@link rewriteForward}. */
export interface ForwardResult {
  /** The rewritten header block (input headers are not mutated). */
  headers: HeaderBlock;
  actions: ForwardActions;
}

/** Cheap plausibility check for an addr-spec (SL validates contact emails too). */
function isPlausibleAddress(addr: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr) || /^[^@\s]+@[^@\s]+$/.test(addr);
}

/**
 * SimpleLogin sender_format AT (the default): the reverse alias's display
 * name carries the original identity as `Name - user at example.com`, or just
 * `user at example.com` when there is no distinct display name.
 */
export function forwardDisplayName(original: Address): string {
  const formattedEmail = original.address.replace("@", " at ").trim();
  const name = original.name?.trim();
  if (name !== undefined && name !== "" && name !== original.address.trim()) {
    return `${name} - ${formattedEmail}`;
  }
  return formattedEmail;
}

/** Max Reply-To entries mapped (SimpleLogin caps at 5). */
const MAX_REPLY_TO_CONTACTS = 5;

/**
 * Rewrite headers for the forward phase. Pure: clones the input block,
 * consults only the injected callbacks. See module doc for the contract.
 */
export async function rewriteForward(
  msg: { headers: HeaderBlock },
  ctx: ForwardContext,
): Promise<ForwardResult> {
  const headers = msg.headers.clone();
  const now = ctx.now ?? new Date();
  const aliasEmail = ctx.alias.email.toLowerCase();

  // Capture Reply-To BEFORE the whitelist drops it (SimpleLogin computes
  // reply_to_contacts before delete_all_headers_except for the same reason).
  const originalReplyTo = headers.get("Reply-To");

  // 1. Whitelist: drop everything we do not explicitly forward.
  const droppedHeaders = applyHeaderWhitelist(headers, FORWARD_HEADER_WHITELIST);

  // Capture originals before rewriting.
  const originalFromValue = headers.get("From");
  const originalFrom: Address = (originalFromValue !== undefined
    ? parseAddressList(originalFromValue)[0]
    : undefined) ?? { address: ctx.envelopeFrom };

  // 2. Missing Date → synthesize (some MTAs/MUAs omit it; mailboxes want it).
  let synthesizedDate = false;
  if (!headers.has("Date")) {
    headers.append("Date", formatDateHeader(now));
    synthesizedDate = true;
  }

  // 3. Translate OUR Message-IDs back to mailbox-side originals in
  //    In-Reply-To / References (SimpleLogin
  //    `replace_sl_message_id_by_original_message_id`).
  if (ctx.resolveOriginalMessageId !== undefined) {
    const inReplyTo = headers.get("In-Reply-To");
    if (inReplyTo !== undefined) {
      const original = await ctx.resolveOriginalMessageId(inReplyTo);
      if (original !== null) headers.replace("In-Reply-To", original);
    }
    const references = headers.get("References");
    if (references !== undefined) {
      const ids = references.split(/\s+/).filter((s) => s !== "");
      const mapped = await Promise.all(
        ids.map(async (id) => (await ctx.resolveOriginalMessageId!(id)) ?? id),
      );
      headers.replace("References", mapped.join(" "));
    }
  }

  // 4. From → reverse alias, display name preserved (AT format).
  const fromContact = await ctx.getOrCreateContact(originalFrom, "from");
  headers.replace(
    "From",
    formatAddress({ name: forwardDisplayName(originalFrom), address: fromContact.replyEmail }),
  );

  // 5. Reply-To → reverse alias(es), capped at 5 (SimpleLogin).
  if (originalReplyTo !== undefined) {
    const replyTos = parseAddressList(originalReplyTo).slice(0, MAX_REPLY_TO_CONTACTS);
    const mapped: Address[] = [];
    for (const rt of replyTos) {
      if (!isPlausibleAddress(rt.address)) continue;
      const contact = await ctx.getOrCreateContact(rt, "reply-to");
      mapped.push({ name: forwardDisplayName(rt), address: contact.replyEmail });
    }
    if (mapped.length > 0) headers.replace("Reply-To", formatAddressList(mapped));
    else headers.remove("Reply-To");
  }

  // 6. To/Cc → each non-alias entry mapped to its reverse alias.
  const invalidRecipients: string[] = [];
  for (const headerName of ["To", "Cc"] as const) {
    const value = headers.get(headerName);
    if (value === undefined) continue;
    const entries = parseAddressList(value);
    const mapped: Address[] = [];
    for (const entry of entries) {
      if (entry.address.toLowerCase() === aliasEmail) {
        mapped.push(entry); // keep the alias itself verbatim
        continue;
      }
      if (!isPlausibleAddress(entry.address)) {
        invalidRecipients.push(entry.address);
        continue;
      }
      const contact = await ctx.getOrCreateContact(entry, headerName === "To" ? "to" : "cc");
      mapped.push({ name: forwardDisplayName(entry), address: contact.replyEmail });
    }
    if (mapped.length > 0) headers.replace(headerName, formatAddressList(mapped));
    else headers.remove(headerName);
  }

  // 7. Make sure the alias shows up somewhere (BCC case: alias in neither
  //    To nor Cc — SimpleLogin `add_alias_to_header_if_needed`).
  const hasAlias = (name: string): boolean => {
    const v = headers.get(name);
    if (v === undefined) return false;
    return parseAddressList(v).some((a) => a.address.toLowerCase() === aliasEmail);
  };
  if (!hasAlias("To") && !hasAlias("Cc")) {
    const to = headers.get("To");
    headers.replace("To", to === undefined ? ctx.alias.email : `${to}, ${ctx.alias.email}`);
  }

  // 8. Provenance headers.
  headers.replace("X-Virtu-Type", "Forward");
  headers.replace("X-Virtu-EmailLog-ID", String(ctx.emailLogId));
  headers.replace("X-Virtu-Envelope-From", ctx.envelopeFrom);
  headers.replace("X-Virtu-Envelope-To", ctx.alias.email);
  headers.replace("X-Virtu-Original-From", formatAddress(originalFrom));

  return {
    headers,
    actions: { droppedHeaders, synthesizedDate, invalidRecipients },
  };
}
