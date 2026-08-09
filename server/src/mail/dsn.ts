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
 *   3. text/rfc822-headers      the failed message's full header block,
 *                               byte-faithful (returning only headers keeps
 *                               DSNs small and never re-leaks large bodies)
 *
 * The caller owns the envelope contract (RFC 5321 §4.5.5): a DSN is sent
 * with the NULL reverse path (`MAIL FROM:<>`) and never in response to a
 * message that itself had a null reverse path — deliverd enforces both.
 */

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
   * bytes). Returned verbatim in the text/rfc822-headers part, so anything
   * the sender needs to correlate (Message-ID, X-Virtu-Test-Id, ...) is
   * preserved.
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

  const statusPart = [
    `Reporting-MTA: dns; ${opts.reportingMta}`,
    `Arrival-Date: ${date}`,
    "",
    `Final-Recipient: rfc822; ${opts.failedRecipient}`,
    "Action: failed",
    `Status: ${status}`,
    `Diagnostic-Code: smtp; ${reply}`,
  ].join("\r\n");

  const originalHeaderBytes = opts.originalHeaders.serialize();
  const needsBreak =
    originalHeaderBytes.length > 0 && originalHeaderBytes[originalHeaderBytes.length - 1] !== 0x0a;

  const body = concatBytes([
    encoder.encode(
      "This is a MIME-encapsulated message.\r\n" +
        "\r\n" +
        `--${boundary}\r\n` +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "\r\n" +
        `${humanPart}\r\n` +
        "\r\n" +
        `--${boundary}\r\n` +
        "Content-Type: message/delivery-status\r\n" +
        "\r\n" +
        `${statusPart}\r\n` +
        "\r\n" +
        `--${boundary}\r\n` +
        "Content-Type: text/rfc822-headers\r\n" +
        "\r\n",
    ),
    originalHeaderBytes,
    encoder.encode(`${needsBreak ? "\r\n" : ""}\r\n--${boundary}--\r\n`),
  ]);

  return { headers, body };
}
