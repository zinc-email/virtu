/**
 * virtu SMTP protocol library (Lane A).
 *
 * Pure protocol, no DB, no MIME parsing. Two entry points:
 *
 * - {@link createSmtpServer} — hook-style RFC 5321 server used by `mx` and
 *   `submission`. Extensions: PIPELINING, SIZE, 8BITMIME, SMTPUTF8,
 *   ENHANCEDSTATUSCODES, STARTTLS, AUTH PLAIN/LOGIN. Streaming DATA reader
 *   with dot-unstuffing, CRLF normalization, size cap, line-length limits,
 *   per-command and DATA timeouts, and max-errors cutoff.
 * - {@link connectSmtp} — transport-only client used by `deliverd` and the
 *   test harness. EHLO capability parsing, opportunistic STARTTLS, AUTH,
 *   dot-stuffing, multiline replies, per-recipient RCPT results with
 *   enhanced-status extraction.
 *
 * Policies (bare-LF normalization, line-length limits) are documented on
 * `./types.ts`; everything re-exported here is the contract other lanes
 * code against.
 */

export {
  /** Create a hook-style SMTP server; see {@link SmtpServerOptions}. */
  createSmtpServer,
  /** Sugar for building `{ reject: { code, enhanced, message } }` hook results. */
  rejectWith,
} from "./server.ts";

export {
  /** Connect to one SMTP host:port and read the greeting. */
  connectSmtp,
  /** Transport-level client failure (connect/timeout/drop/protocol garbage). */
  SmtpClientError,
  /** Session-level command refusal; carries the offending `SmtpReply`. */
  SmtpCommandError,
} from "./client.ts";

export type {
  // Server contract
  SmtpServer,
  SmtpServerOptions,
  SmtpServerHooks,
  SmtpTlsConfig,
  SmtpSession,
  SmtpEnvelope,
  SmtpRecipient,
  SmtpParams,
  SmtpHookResult,
  SmtpRejection,
  SmtpConnectEvent,
  SmtpEhloEvent,
  SmtpAuthEvent,
  SmtpMailFromEvent,
  SmtpRcptToEvent,
  SmtpDataEvent,
  MaybePromise,
  // Client contract
  SmtpClient,
  ConnectSmtpOptions,
  SmtpReply,
  SmtpSendOptions,
  SmtpSendResult,
  SmtpRcptResult,
} from "./types.ts";
