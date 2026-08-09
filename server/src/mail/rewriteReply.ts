/**
 * Reply-phase header rewriting (mailbox → reverse alias → real recipient),
 * modeled on SimpleLogin's `email_handler.py` reply path. Pure over the
 * header block; everything stateful is injected through callbacks.
 *
 * The invariant this phase protects: the user's real mailbox address must
 * NEVER leak to the outside. Consequently any To/Cc entry that is not a
 * known reverse alias produces a typed refusal (SimpleLogin
 * `NonReverseAliasInReplyPhase`) instead of a rewritten message — we refuse
 * rather than leak the real recipient list. The mailbox-side Message-ID is
 * replaced with one of ours for the same reason, with the original↔ours pair
 * returned so the caller can persist it for thread reconstruction.
 */

import { randomBytes } from "node:crypto";
import {
  type Address,
  formatAddress,
  formatAddressList,
  formatDateHeader,
  type HeaderBlock,
  parseAddressList,
} from "./headers.ts";
import { applyHeaderWhitelist } from "./rewriteForward.ts";

/**
 * Reply-phase header whitelist (data, exported). Narrower than the forward
 * list: no List-* headers on outbound replies (SimpleLogin drops them too).
 * `x-virtu-test-id` kept for Lane H story tests.
 */
export const REPLY_HEADER_WHITELIST: readonly string[] = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "references",
  "in-reply-to",
  // MIME headers (SimpleLogin headers.MIME_HEADERS)
  "mime-version",
  "content-type",
  "content-disposition",
  "content-transfer-encoding",
  // virtu-specific passthrough
  "x-virtu-test-id",
];

/** A reverse alias resolved back to the real outside recipient. */
export interface ReverseAliasRef {
  /** The contact's real address (SimpleLogin `website_email`). */
  websiteEmail: string;
  /** Contact display name, when known. */
  name?: string | null;
}

/** Context (alias, callbacks) injected into {@link rewriteReply}. */
export interface ReplyContext {
  /** The alias the reply is sent as. `name` becomes the From display name. */
  alias: { email: string; name?: string | null };
  /** Email-log row id for this reply (returned in the message-id map action). */
  emailLogId: string | number;
  /**
   * Resolve a reverse-alias address back to the real recipient. Return null
   * when the address is NOT a known reverse alias — the rewrite then refuses
   * (never leaks). Async on purpose; wave 2 backs this with the contacts
   * table.
   */
  resolveReverseAlias(addr: string): Promise<ReverseAliasRef | null>;
  /**
   * Optional: look up OUR public Message-ID previously assigned to a
   * mailbox-side original id. Used to (a) reuse the same public id when the
   * user replies to several recipients, and (b) rewrite mailbox-side ids in
   * References / In-Reply-To so they never leak. Return null when unknown.
   */
  resolveOurMessageId?(originalMessageId: string): Promise<string | null>;
  /**
   * Optional Message-ID generator override for tests. Must return a full
   * msg-id including angle brackets, e.g. `<abc@domain>`.
   */
  generateMessageId?(): string;
  /** Domain used by the default Message-ID generator (default: alias domain). */
  messageIdDomain?: string;
  /** Clock override for tests (synthesized Date header). */
  now?: Date;
}

/** Typed refusal: a To/Cc entry was not a known reverse alias. */
export interface NonReverseAliasRefusal {
  reason: "non_reverse_alias";
  /** Which header carried the offending entry. */
  header: "to" | "cc";
  /** The offending address (a reverse-alias lookup miss). */
  address: string;
}

/** Actions/observations from a reply rewrite, for the caller to persist. */
export interface ReplyActions {
  /** Header names removed by the whitelist, original order. */
  droppedHeaders: string[];
  /**
   * The Message-ID translation pair to persist: `original` is the
   * mailbox-side id (null when the inbound reply had none), `ours` is the
   * public id now on the message. When `reused` is true the pair already
   * exists (resolveOurMessageId hit) and needs no insert.
   */
  messageIdMap: { original: string | null; ours: string; reused: boolean };
  /** True when the message had no Date and one was synthesized. */
  synthesizedDate: boolean;
}

/** Result of {@link rewriteReply}: either a rewritten block or a typed refusal. */
export type ReplyResult =
  | { ok: true; headers: HeaderBlock; actions: ReplyActions }
  | { ok: false; refusal: NonReverseAliasRefusal };

/** Matches SimpleLogin's BCC-mode To header, left untouched. */
const UNDISCLOSED_RECIPIENTS = /^undisclosed-recipients:\s*;?$/i;

/** Default public Message-ID generator: `<{emailLogId}.{random}@{domain}>`. */
function defaultMessageId(emailLogId: string | number, domain: string): string {
  const random = randomBytes(9).toString("base64url");
  return `<${emailLogId}.${random}@${domain}>`;
}

/**
 * Rewrite headers for the reply phase. Pure: clones the input block. Returns
 * a typed refusal (never a partial rewrite) when any To/Cc entry is not a
 * known reverse alias. See module doc for the contract.
 */
export async function rewriteReply(
  msg: { headers: HeaderBlock },
  ctx: ReplyContext,
): Promise<ReplyResult> {
  const headers = msg.headers.clone();
  const aliasEmail = ctx.alias.email.toLowerCase();
  const now = ctx.now ?? new Date();

  // 1. Whitelist.
  const droppedHeaders = applyHeaderWhitelist(headers, REPLY_HEADER_WHITELIST);

  // 2. Resolve every To/Cc entry BEFORE touching anything: refusal must be
  //    all-or-nothing so no partially-rewritten message can escape.
  const rewrittenRecipients = new Map<"To" | "Cc", Address[] | "keep">();
  for (const headerName of ["To", "Cc"] as const) {
    const value = headers.get(headerName);
    if (value === undefined) continue;
    if (headerName === "To" && UNDISCLOSED_RECIPIENTS.test(value)) {
      rewrittenRecipients.set(headerName, "keep"); // BCC mode (SimpleLogin)
      continue;
    }
    const mapped: Address[] = [];
    for (const entry of parseAddressList(value)) {
      if (entry.address.toLowerCase() === aliasEmail) {
        // reply-all echo of the alias itself: drop (SimpleLogin `continue`)
        continue;
      }
      const contact = await ctx.resolveReverseAlias(entry.address);
      if (contact === null) {
        return {
          ok: false,
          refusal: {
            reason: "non_reverse_alias",
            header: headerName === "To" ? "to" : "cc",
            address: entry.address,
          },
        };
      }
      const name = contact.name ?? undefined;
      mapped.push(
        name !== undefined && name !== ""
          ? { name, address: contact.websiteEmail }
          : { address: contact.websiteEmail },
      );
    }
    rewrittenRecipients.set(headerName, mapped);
  }

  for (const [headerName, mapped] of rewrittenRecipients) {
    if (mapped === "keep") continue;
    if (mapped.length > 0) headers.replace(headerName, formatAddressList(mapped));
    else headers.remove(headerName);
  }

  // 3. From → the alias (SimpleLogin `get_alias_recipient_name`).
  const aliasName = ctx.alias.name ?? undefined;
  headers.replace(
    "From",
    aliasName !== undefined && aliasName !== ""
      ? formatAddress({ name: aliasName, address: ctx.alias.email })
      : ctx.alias.email,
  );

  // 4. Message-ID → ours (mailbox-side ids never leak). Reuse the existing
  //    mapping when the same original was already assigned a public id.
  const originalMessageId = headers.get("Message-ID") ?? null;
  let ours: string | null = null;
  let reused = false;
  if (originalMessageId !== null && ctx.resolveOurMessageId !== undefined) {
    ours = await ctx.resolveOurMessageId(originalMessageId);
    reused = ours !== null;
  }
  if (ours === null) {
    const domain = ctx.messageIdDomain ?? ctx.alias.email.slice(ctx.alias.email.indexOf("@") + 1);
    ours = ctx.generateMessageId?.() ?? defaultMessageId(ctx.emailLogId, domain);
  }
  headers.replace("Message-ID", ours);

  // 5. References / In-Reply-To: swap mailbox-side ids for our public ids.
  //    (SimpleLogin only rewrites References here; we also cover In-Reply-To
  //    — when a user replies to their own earlier reply, the mailbox id
  //    would otherwise leak.)
  if (ctx.resolveOurMessageId !== undefined) {
    const references = headers.get("References");
    if (references !== undefined) {
      const ids = references.split(/\s+/).filter((s) => s !== "");
      const mapped = await Promise.all(
        ids.map(async (id) => (await ctx.resolveOurMessageId!(id)) ?? id),
      );
      headers.replace("References", mapped.join(" "));
    }
    const inReplyTo = headers.get("In-Reply-To");
    if (inReplyTo !== undefined) {
      const mapped = await ctx.resolveOurMessageId(inReplyTo);
      if (mapped !== null) headers.replace("In-Reply-To", mapped);
    }
  }

  // 6. Missing Date → synthesize.
  let synthesizedDate = false;
  if (!headers.has("Date")) {
    headers.append("Date", formatDateHeader(now));
    synthesizedDate = true;
  }

  // 7. Direction marker (no other X-Virtu headers: this message goes to an
  //    outside recipient).
  headers.replace("X-Virtu-Type", "Reply");

  return {
    ok: true,
    headers,
    actions: {
      droppedHeaders,
      messageIdMap: { original: originalMessageId, ours, reused },
      synthesizedDate,
    },
  };
}
