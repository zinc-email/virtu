/**
 * DSN (bounce message) generation — RFC 3464 shaped, hand-assembled MIME.
 *
 * We deliberately have no MIME library (PLAN Lane C: the body is opaque
 * bytes everywhere else), and *generating* multipart/report is much easier
 * than parsing it: three parts with a fixed boundary scheme —
 *
 *   1. text/plain               human-readable explanation + the remote reply
 *   2. message/delivery-status  the machine-readable per-message/per-recipient
 *                               fields (Reporting-MTA, Final-Recipient,
 *                               Action, Status, Diagnostic-Code)
 *   3. text/rfc822-headers      the failed message's header block,
 *                               bounded to 64 KiB (returning headers keeps
 *                               DSNs small and never re-leaks large bodies)
 *
 * The caller owns the envelope contract (RFC 5321 §4.5.5): a DSN is sent
 * with the NULL reverse path (`MAIL FROM:<>`) and never in response to a
 * message that itself had a null reverse path — deliverd enforces both.
 */

import { assertLineLengths } from "./lineLength.ts";
import { randomBytes } from "node:crypto";
import { formatDateHeader, HeaderBlock } from "./headers.ts";

const encoder = new TextEncoder();

/** Subject used for every DSN we generate (the classic postfix wording). */
export const DSN_SUBJECT = "Undelivered Mail Returned to Sender";

/** Localpart of the DSN From address. */
export const MAILER_DAEMON = "MAILER-DAEMON";

/** Options for {@link buildDsn}. */
export interface BuildDsnOptions {
  /**
   * Header block of the failed message (as parsed off the queue row's raw
   * bytes). Complete fields are returned within a 64 KiB budget; omitted
   * fields are counted in X-Virtu-DSN-Headers-Omitted.
   */
  originalHeaders: HeaderBlock;
  /** The envelope recipient that permanently failed (queue row envelope_to). */
  failedRecipient: string;
  /** The remote refusal / final error, e.g. `RCPT TO x: 550 5.1.1 unknown`. */
  remoteReply: string;
  /** Our MTA hostname (config.mailHostname) — Reporting-MTA field. */
  reportingMta: string;
  /** Our mail domain (config.mailDomain) — From: MAILER-DAEMON@{domain}. */
  mailDomain: string;
  /** Where the DSN itself is addressed (the To: header). */
  recipient: string;
  /** Clock override for tests. */
  now?: Date;
  /** Fixed boundary override for tests; defaults to a random one. */
  boundary?: string;
  /** Message-ID override for tests; defaults to a random id on mailDomain. */
  messageId?: string;
}

/** Result of {@link buildDsn}: signOutbound/serializeMessage-ready. */
export interface BuiltDsn {
  headers: HeaderBlock;
  body: Uint8Array;
}

/**
 * Derive the RFC 3463 Status field from the remote reply text: a literal
 * enhanced code (`5.1.1`) when present, else the reply-code class (`5.0.0` /
 * `4.0.0`), defaulting to `5.0.0` — buildDsn is only called for permanent
 * failures.
 */
export function statusFromReply(remoteReply: string): string {
  const enhanced = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(remoteReply);
  if (enhanced !== null) return enhanced[1]!;
  const code = /\b([45])\d\d\b/.exec(remoteReply);
  return code === null ? "5.0.0" : `${code[1]}.0.0`;
}

/**
 * A forward-phase bounce is reported to the OUTSIDE sender, so the diagnostic
 * must never echo the real backing mailbox — the remote reply text (e.g.
 * `RCPT TO realmailbox@gmail.com: 550 5.1.1 ... User unknown`) contains it
 * verbatim. Keep only the SMTP status codes (the machine-readable signal) and
 * replace the free text, so the sender learns the message failed without
 * learning who actually receives the alias's mail. Reply-phase bounces go to
 * the user's own mailbox and keep the verbatim reply.
 */
export function sanitizeForwardDiagnostic(remoteReply: string): string {
  const enhanced = /\b[45]\.\d{1,3}\.\d{1,3}\b/.exec(remoteReply)?.[0];
  const basic = /\b[45]\d\d\b/.exec(remoteReply)?.[0] ?? "550";
  const code = enhanced === undefined ? basic : `${basic} ${enhanced}`;
  return `${code} the recipient's mail server rejected the message`;
}

/** Collapse line breaks: reply text must not corrupt the line-oriented parts. */
function singleLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Encode only generated/returned MIME parts; never fold an original body. */
function textPart(contentType: string, bytes: Uint8Array): Uint8Array {
  let encoded = bytes.some((b) => b > 127);
  try {
    assertLineLengths(bytes);
  } catch {
    encoded = true;
  }
  if (!encoded) return concatBytes([encoder.encode(`Content-Type: ${contentType}\r\n\r\n`), bytes]);
  const base64 =
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "";
  return encoder.encode(
    `Content-Type: ${contentType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64}`,
  );
}

/** Bound returned headers so even a header-heavy original can be bounced. */
function returnedHeaders(original: HeaderBlock): Uint8Array {
  const fields = [];
  let size = 0;
  let omitted = 0;
  for (const field of original.fields) {
    const bytes = new HeaderBlock([field]).serialize();
    if (size + bytes.length > 64 * 1024) {
      omitted++;
      continue;
    }
    fields.push(bytes);
    size += bytes.length;
  }
  if (omitted > 0) fields.push(encoder.encode(`X-Virtu-DSN-Headers-Omitted: ${omitted}\r\n`));
  return concatBytes(fields);
}

/**
 * Build a multipart/report delivery-status notification for one permanently
 * failed recipient. Returns headers + body separately so the caller can DKIM
 * sign (`signOutbound`) or serialize (`serializeMessage`) as needed.
 */
export function buildDsn(opts: BuildDsnOptions): BuiltDsn {
  const now = opts.now ?? new Date();
  const boundary = opts.boundary ?? `=_vt-dsn-${randomBytes(12).toString("hex")}`;
  const messageId = opts.messageId ?? `<${randomBytes(16).toString("hex")}@${opts.mailDomain}>`;
  const date = formatDateHeader(now);
  const reply = singleLine(opts.remoteReply);
  const status = statusFromReply(reply);

  const headers = new HeaderBlock();
  headers.append("From", `Mail Delivery System <${MAILER_DAEMON}@${opts.mailDomain}>`);
  headers.append("To", opts.recipient);
  headers.append("Subject", DSN_SUBJECT);
  headers.append("Date", date);
  headers.append("Message-ID", messageId);
  // RFC 3834: DSNs are auto-generated; responders must not answer them.
  headers.append("Auto-Submitted", "auto-replied");
  headers.append("MIME-Version", "1.0");
  headers.append(
    "Content-Type",
    `multipart/report; report-type=delivery-status; boundary="${boundary}"`,
  );

  const humanPart = [
    `This is the mail system at host ${opts.reportingMta}.`,
    "",
    "I'm sorry to have to inform you that your message could not",
    "be delivered to one or more recipients. Its headers are attached",
    "below.",
    "",
    `For further assistance, please contact <postmaster@${opts.mailDomain}>.`,
    "",
    "If you do so, please include this problem report.",
    "",
    `<${opts.failedRecipient}>: ${reply}`,
  ].join("\r\n");

  // RFC 3464 §2.3.6 makes Diagnostic-Code optional. Keep the actual
  // diagnostic when representable in a legal 7-bit field; otherwise the
  // full diagnostic remains lossless in the encoded human-readable part.
  const diagnosticField = `Diagnostic-Code: smtp; ${reply}`;
  const includeDiagnostic =
    /^[\x20-\x7e\t]*$/.test(diagnosticField) && Buffer.byteLength(diagnosticField) <= 998;
  const statusPart = [
    `Reporting-MTA: dns; ${opts.reportingMta}`,
    `Arrival-Date: ${date}`,
    "",
    `Final-Recipient: rfc822; ${opts.failedRecipient}`,
    "Action: failed",
    `Status: ${status}`,
    ...(includeDiagnostic ? [diagnosticField] : []),
  ].join("\r\n");

  const originalHeaderBytes = returnedHeaders(opts.originalHeaders);
  const body = concatBytes([
    encoder.encode(`This is a MIME-encapsulated message.\r\n\r\n--${boundary}\r\n`),
    textPart("text/plain; charset=utf-8", encoder.encode(humanPart)),
    encoder.encode(
      `\r\n\r\n--${boundary}\r\nContent-Type: message/delivery-status\r\n\r\n${statusPart}\r\n\r\n--${boundary}\r\n`,
    ),
    textPart("text/rfc822-headers", originalHeaderBytes),
    encoder.encode(`\r\n\r\n--${boundary}--\r\n`),
  ]);

  return { headers, body };
}
