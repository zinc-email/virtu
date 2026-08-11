/**
 * Public contract types for the SMTP protocol library (Lane A).
 *
 * This module is pure protocol: no database, no MIME parsing, no policy.
 * The mx / submission / deliverd entrypoints build on these shapes.
 *
 * Line-ending policy (applies to both server and client, documented once here):
 *
 * - On receive, bare LF is accepted anywhere CRLF is expected (commands and
 *   DATA) and is normalized to CRLF in the stored message. Lone CR bytes are
 *   preserved literally. The end-of-data terminator is recognized as
 *   `<CRLF>.<CRLF>` with either line break allowed to be a bare LF.
 * - On send, `SmtpClient.send()` normalizes bare LF in the supplied data to
 *   CRLF before dot-stuffing, and ensures the data ends with CRLF. Data that
 *   is already CRLF-terminated round-trips byte-for-byte.
 *
 * Line-length policy:
 *
 * - Command lines are capped at 2048 octets (deliberately above RFC 5321's
 *   512 to leave headroom for SMTPUTF8 addresses and MAIL parameters).
 *   Longer command lines get `500 5.5.2 Line too long` and input is
 *   discarded until the next line break.
 * - DATA lines are capped at `maxDataLineLength` octets of content
 *   (excluding CRLF). RFC 5321 specifies 998; the default here is 10000 —
 *   deliberately tolerant, because rejecting real-world long-line mail is
 *   worse for a forwarder than accepting it. Set it to 998 for strict RFC
 *   behavior. A violating message is consumed to completion and then
 *   rejected with `500 5.6.0 Line too long`; the cap also bounds per-line
 *   memory.
 */

/** MAIL FROM / RCPT TO esmtp-parameters: `KEY=value` or bare `KEY` (=> `true`). Keys are uppercased. */
export type SmtpParams = Record<string, string | true>;

/** One accepted RCPT TO, with any (accepted) parameters it carried. */
export interface SmtpRecipient {
  /** Forward-path address with angle brackets and any source route removed. */
  address: string;
  /** RCPT TO parameters. Currently always empty (no RCPT extensions are advertised). */
  params: SmtpParams;
}

/**
 * The envelope accumulated across a mail transaction, as handed to `onData`.
 * Accumulates from EHLO/STARTTLS/AUTH/MAIL/RCPT; reset by RSET, EHLO/HELO,
 * STARTTLS, and after each completed DATA.
 */
export interface SmtpEnvelope {
  /** Argument of the last HELO/EHLO. */
  heloName: string;
  /** True when the transaction runs over TLS (STARTTLS or an implicit-TLS listener). */
  tls: boolean;
  /** Authenticated username (authcid), when AUTH succeeded on this connection. */
  authUser?: string;
  /** Reverse-path address. Empty string for the null reverse-path `<>` (bounces). */
  mailFrom: string;
  /** Parameters given on MAIL FROM (e.g. `SIZE`, `BODY`, `SMTPUTF8`, `AUTH`). */
  params: SmtpParams;
  /** Accepted recipients, in the order the client sent them. */
  rcptTo: SmtpRecipient[];
}

/** Per-connection facts passed to every hook. Fields fill in as the session progresses. */
export interface SmtpSession {
  /** Opaque per-connection id (unique within the process). */
  id: string;
  /** Remote peer address as seen at accept time (stable across STARTTLS). */
  remoteAddress: string;
  /** Remote peer port as seen at accept time. */
  remotePort: number;
  /** True once the connection is under TLS. */
  tls: boolean;
  /** Argument of the last HELO/EHLO, once given. */
  heloName?: string;
  /** Authenticated username, once AUTH succeeded. */
  authUser?: string;
}

/** A rejection a hook can return; becomes the SMTP reply verbatim. */
export interface SmtpRejection {
  /** Three-digit SMTP reply code, e.g. 550. */
  code: number;
  /** Enhanced status code per RFC 3463, e.g. "5.7.1". Optional but recommended. */
  enhanced?: string;
  /** Human-readable single-line reply text. */
  message: string;
}

/**
 * What every hook returns: accept (optionally overriding the success reply
 * text, useful for `onData` queue ids) or reject with a specific reply.
 */
export type SmtpHookResult = { accept: true; message?: string } | { reject: SmtpRejection };

/** Hooks may be sync or async. */
export type MaybePromise<T> = T | Promise<T>;

/** Argument to `onConnect`. */
export interface SmtpConnectEvent {
  session: SmtpSession;
}

/** Argument to `onEhlo`. */
export interface SmtpEhloEvent {
  session: SmtpSession;
  /** The client's stated name (EHLO/HELO argument). */
  heloName: string;
  /** Which greeting command was used. */
  verb: "EHLO" | "HELO";
}

/** Argument to `onAuth`. */
export interface SmtpAuthEvent {
  session: SmtpSession;
  /** SASL mechanism the client used. */
  mechanism: "PLAIN" | "LOGIN";
  /** Authentication identity (authcid). */
  username: string;
  /** Password / credential, decoded from base64. */
  password: string;
  /** PLAIN only: authorization identity (authzid), when the client sent one. */
  authzid?: string;
}

/** Argument to `onMailFrom`. */
export interface SmtpMailFromEvent {
  session: SmtpSession;
  /** Reverse-path address ("" for the null path `<>`). */
  address: string;
  /** Accepted MAIL parameters (SIZE/BODY/SMTPUTF8/AUTH). */
  params: SmtpParams;
}

/** Argument to `onRcptTo`. */
export interface SmtpRcptToEvent {
  session: SmtpSession;
  /** Forward-path address (source route already stripped). */
  address: string;
  /** Accepted RCPT parameters (currently always empty). */
  params: SmtpParams;
  /** Recipients accepted so far in this transaction (not including this one). */
  rcptTo: SmtpRecipient[];
}

/**
 * Argument to `onData`, delivered after the whole message has been received,
 * dot-unstuffed and CRLF-normalized. No MIME parsing is performed.
 */
export interface SmtpDataEvent {
  session: SmtpSession;
  /** The completed envelope for this transaction. */
  envelope: SmtpEnvelope;
  /**
   * The raw header block: every byte up to but not including the blank line
   * separating headers from body (the final header line keeps its CRLF).
   * If the message contains no blank line, the whole message is `headers`
   * and `body` is empty. Zero-copy view into `raw`.
   */
  headers: Uint8Array;
  /** Message body: every byte after the blank line. Zero-copy view into `raw`. */
  body: Uint8Array;
  /** The full normalized message (headers + blank line + body). */
  raw: Uint8Array;
}

/** The hook set. Any omitted hook accepts by default. */
export interface SmtpServerHooks {
  /** Runs when a connection is established (after the TLS handshake on implicit-TLS listeners).
   * Rejecting sends the rejection as the greeting; the connection then answers
   * `503 5.5.1` to everything except QUIT until the client goes away. */
  onConnect?: (event: SmtpConnectEvent) => MaybePromise<SmtpHookResult>;
  /** Runs on EHLO/HELO. Rejecting refuses the greeting (default code applies if none given). */
  onEhlo?: (event: SmtpEhloEvent) => MaybePromise<SmtpHookResult>;
  /** Validates credentials for AUTH PLAIN / AUTH LOGIN. AUTH is only advertised
   * (and accepted) when this hook is configured. Accept => `235`; reject => your
   * code (use 535 5.7.8 for bad credentials). */
  onAuth?: (event: SmtpAuthEvent) => MaybePromise<SmtpHookResult>;
  /** Validates the reverse-path. */
  onMailFrom?: (event: SmtpMailFromEvent) => MaybePromise<SmtpHookResult>;
  /** Validates one forward-path. Rejecting refuses only this recipient. */
  onRcptTo?: (event: SmtpRcptToEvent) => MaybePromise<SmtpHookResult>;
  /** Receives the completed message. Accept => `250` (your `message` becomes the
   * reply text, e.g. "queued as 123"); reject => your reply. */
  onData?: (event: SmtpDataEvent) => MaybePromise<SmtpHookResult>;
}

/** PEM key/cert material for TLS listeners and STARTTLS. */
export interface SmtpTlsConfig {
  /** PEM private key. */
  key: string;
  /** PEM certificate (leaf first, chain appended). */
  cert: string;
}

/** Options for {@link createSmtpServer}. */
export interface SmtpServerOptions extends SmtpServerHooks {
  /** Hostname used in the greeting banner and EHLO response. */
  hostname: string;
  /** Extra free text appended to the 220 greeting banner. */
  banner?: string;
  /**
   * TLS key/cert. When set, STARTTLS is advertised on plaintext listeners and
   * `implicitTls` listeners become possible.
   */
  tls?: SmtpTlsConfig;
  /** Speak TLS from byte 0 (port-465 style listener). Requires `tls`. */
  implicitTls?: boolean;
  /**
   * Only allow AUTH over TLS (`538 5.7.11` otherwise, and AUTH is not
   * advertised on plaintext EHLO). Defaults to `true` when `tls` is
   * configured, `false` otherwise (plaintext dev setups).
   */
  requireAuthTls?: boolean;
  /** Message size cap in bytes (of the normalized message), advertised via SIZE
   * and enforced both on the MAIL SIZE= parameter and during DATA (=> 552).
   * Default 25 MiB. */
  maxMessageSize?: number;
  /** Max accepted recipients per transaction (`452 4.5.3` beyond it). Default 100. */
  maxRecipients?: number;
  /** Max error replies per connection before `421 4.7.0` + disconnect. Default 10. */
  maxErrors?: number;
  /** Max concurrent connections server-wide (`421` + close beyond it). Default 1024. */
  maxConnections?: number;
  /** Max concurrent connections from one remote IP (`421` + close beyond it). Default 64. */
  maxConnectionsPerIp?: number;
  /** DATA line-length cap; see the line-length policy above. Default 10000. */
  maxDataLineLength?: number;
  /** Idle timeout while waiting for a command, ms (=> `421 4.4.2` + close). Default 300000. */
  commandTimeoutMs?: number;
  /** Idle timeout while receiving DATA, ms (=> `421 4.4.2` + close). Default 600000. */
  dataTimeoutMs?: number;
}

/** A bound-and-listening SMTP server, from {@link createSmtpServer}. */
export interface SmtpServer {
  /** Start listening. Port 0 picks an ephemeral port (returned). Host defaults to "0.0.0.0". */
  listen(port?: number, host?: string): Promise<{ port: number; host: string }>;
  /** The bound address, once listening. */
  address(): { port: number; host: string } | null;
  /** Stop listening and drop all active connections. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** One parsed (possibly multiline) SMTP reply. */
export interface SmtpReply {
  /** Three-digit reply code from the final line. */
  code: number;
  /** RFC 3463 enhanced status code extracted from the reply text, when present
   * and its class digit matches the reply code class. */
  enhancedCode?: string;
  /** Text of every line (after code and separator), joined with "\n". */
  message: string;
  /** Text of each line individually, in order. */
  lines: string[];
}

/** Options for {@link connectSmtp}. */
export interface ConnectSmtpOptions {
  /** Host to connect to (MX resolution is the caller's job, not this library's). */
  host: string;
  /** Port to connect to (25, 465, 587, ...). */
  port: number;
  /** Speak TLS from byte 0 (port-465 style). */
  implicitTls?: boolean;
  /** Name to send in EHLO/HELO. Defaults to the OS hostname. */
  name?: string;
  /** Timeout for connect and for each awaited reply, ms. Default 30000. */
  timeoutMs?: number;
  /**
   * Options merged into `tls.connect` for implicit TLS and `startTls()`, e.g.
   * `{ rejectUnauthorized: false }` for opportunistic delivery or `{ ca }` in tests.
   */
  tls?: Record<string, unknown>;
}

/** Per-recipient outcome from {@link SmtpClient.send}. */
export interface SmtpRcptResult {
  /** The recipient address as given. */
  address: string;
  /** The server's reply to this RCPT TO. */
  reply: SmtpReply;
  /** True when the reply was 2xx. */
  accepted: boolean;
}

/** Structured outcome of one send attempt (nothing envelope-level throws;
 * transport errors — drops, timeouts — do throw {@link SmtpClientError}). */
export interface SmtpSendResult {
  /** True when at least one recipient was accepted and DATA got a 2xx. */
  accepted: boolean;
  /** Reply to MAIL FROM. */
  mailFrom: SmtpReply;
  /** Per-recipient replies (empty when MAIL FROM was refused). */
  rcptTo: SmtpRcptResult[];
  /** Reply to the DATA dialog: the post-message 2xx/4xx/5xx, or the non-354
   * refusal of DATA itself. Absent when DATA was never attempted (MAIL
   * refused or no recipient accepted). */
  data?: SmtpReply;
}

/** Arguments to {@link SmtpClient.send}. */
export interface SmtpSendOptions {
  /** Reverse-path. "" (or "<>") sends the null path. Angle brackets optional. */
  mailFrom: string;
  /** Forward-paths, tried in order. Angle brackets optional. */
  rcptTo: string[];
  /** Message bytes (headers + body). Strings are encoded as UTF-8. Line
   * endings are normalized to CRLF and dot-stuffing is applied on the wire. */
  data: string | Uint8Array;
  /** Extra MAIL FROM parameters, e.g. `{ SIZE: "1234", BODY: "8BITMIME", SMTPUTF8: true }`. */
  mailParams?: SmtpParams;
}

/** An established SMTP client session, from {@link connectSmtp}. */
export interface SmtpClient {
  /** The server's 220 greeting. */
  readonly greeting: SmtpReply;
  /** True once the connection is under TLS. */
  readonly secure: boolean;
  /**
   * EHLO capabilities from the most recent EHLO: keyword (uppercased) to
   * parameter string ("" when none). Empty until `ehlo()` runs, or after a
   * HELO fallback.
   */
  readonly capabilities: ReadonlyMap<string, string>;
  /** Send EHLO (falling back to HELO on 500/502) and parse capabilities. */
  ehlo(name?: string): Promise<SmtpReply>;
  /**
   * Upgrade to TLS via STARTTLS and re-EHLO (capabilities are replaced, per
   * RFC 3207). Throws {@link SmtpCommandError} if the server refuses, or
   * {@link SmtpClientError} if STARTTLS was not advertised (pass
   * `{ force: true }` to try anyway) or the handshake fails.
   */
  startTls(options?: { force?: boolean }): Promise<void>;
  /**
   * Authenticate. PLAIN uses the initial-response form; LOGIN uses the
   * challenge dialog. Defaults to PLAIN when advertised, else LOGIN.
   * Resolves with the 235 reply; throws {@link SmtpCommandError} on refusal.
   */
  auth(credentials: {
    username: string;
    password: string;
    mechanism?: "PLAIN" | "LOGIN";
  }): Promise<SmtpReply>;
  /** Run one mail transaction. Envelope-level refusals come back structured
   * (per step, so partial failures are reportable); transport failures throw. */
  send(options: SmtpSendOptions): Promise<SmtpSendResult>;
  /** Send QUIT (best-effort: ignores refusals/drops) and close the connection. */
  quit(): Promise<void>;
  /** Drop the connection immediately. */
  close(): void;
}
