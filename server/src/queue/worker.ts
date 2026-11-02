/**
 * Queue worker (PLAN Lane D — boring on purpose).
 *
 * Loop: claim a batch with SELECT … FOR UPDATE SKIP LOCKED (workers scale by
 * just running more of them), deliver each row over SMTP (MX lookup through
 * the container's resolver, opportunistic STARTTLS with certificate checks
 * off — better encrypted-to-anyone than plaintext-to-few), classify:
 *
 *   - 2xx end-of-data            → sent
 *   - 5xx on any step            → failed (permanent); onPermanentFailure
 *   - 4xx / transport / DNS      → pending again with exponential backoff,
 *                                  until maxTries — then failed + callback
 *
 * Permanent failures invoke onPermanentFailure (bounce accounting + DSN
 * generation — see deliverd.ts). Null-reverse-path rows never produce any
 * bounce action (never bounce a bounce).
 */

import { promises as dns } from "node:dns";
import net from "node:net";
import { and, asc, eq, getTableColumns, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type OutboundMessage, outboundMessages } from "../db/schema.ts";
import { createLogger, type Logger } from "../log.ts";
import { parseIpv6 } from "../pipeline/ipAddress.ts";
import {
  destinationPausesTotal,
  providerFor,
  queueClaimedTotal,
  queueDeliveriesTotal,
  queueDeliveryDurationSeconds,
  queueDestinationDeferredTotal,
  queueDestinationDeliveriesTotal,
  queueDestinationRepliesTotal,
  queueReapedTotal,
  queueRetentionDeletedTotal,
} from "../metrics/index.ts";
import {
  connectSmtp,
  SmtpClientError,
  SmtpCommandError,
  type SmtpReply,
  type SmtpSendResult,
} from "../smtp/index.ts";
import { backoffDelayMs } from "./backoff.ts";
import type { DeliveryStep } from "../db/schema.ts";
import {
  type DeliveryReply,
  destinationDomain,
  type DestinationThrottleOptions,
  isDeferralSignal,
  pausedUntilFor,
  recordDeferral,
  recordSuccess,
  stepForCommand,
} from "./destinationThrottle.ts";
import { reapStuckSending } from "./reaper.ts";
import {
  runProvisionalUserRetentionOnce,
  runRejectionRetentionOnce,
  runRetentionOnce,
  runSentAlertsRetentionOnce,
} from "./retention.ts";

/** Outcome of one delivery attempt. */
export type DeliveryOutcome =
  | { kind: "sent" }
  | {
      kind: "permanent";
      error: string;
      /**
       * RFC 3463 enhanced status code of the refusing reply, when the remote
       * sent one — the mailbox-suppression signal (ABUSE.md Tier 1). Absent
       * on retries-exhausted failures (those were transient replies).
       */
      enhancedCode?: string;
      /** The refusing reply itself, when there was one (metrics). */
      reply?: DeliveryReply;
    }
  | {
      kind: "transient";
      error: string;
      /**
       * The deferring reply, when the attempt got as far as an SMTP reply
       * (absent on DNS/transport failures). Feeds the per-destination
       * reply metrics and the domain pause (destinationThrottle.ts).
       */
      reply?: DeliveryReply;
      /**
       * The attempt ended on a timeout (connect, a reply, or the whole
       * delivery deadline) rather than a reply. A destination that accepts
       * the connection and then says nothing is the tarpit shape; it pauses
       * the domain like a 421 would, so its rows stop occupying the worker.
       */
      timeout?: { step: DeliveryStep; text: string };
    };

/** Format one SMTP reply for last_error. */
function describeReply(step: string, reply: SmtpReply): string {
  const enhanced = reply.enhancedCode === undefined ? "" : ` ${reply.enhancedCode}`;
  return `${step}: ${reply.code}${enhanced} ${reply.message.split("\n")[0] ?? ""}`.trim();
}

/** The reply in the shape the throttle/metrics consume. */
function toDeliveryReply(step: DeliveryReply["step"], reply: SmtpReply): DeliveryReply {
  return {
    code: reply.code,
    enhancedCode: reply.enhancedCode,
    step,
    text: reply.message.split("\n")[0] ?? "",
  };
}

function isPermanentCode(code: number): boolean {
  return code >= 500 && code < 600;
}

/**
 * Classify a completed SMTP transaction (pure; unit-tested). Single-recipient
 * rows mean any recipient-level refusal is THE refusal.
 */
export function classifySendResult(result: SmtpSendResult): DeliveryOutcome {
  if (result.accepted) return { kind: "sent" };

  if (result.mailFrom.code < 200 || result.mailFrom.code >= 300) {
    const error = describeReply("MAIL FROM", result.mailFrom);
    const reply = toDeliveryReply("mail_from", result.mailFrom);
    return isPermanentCode(result.mailFrom.code)
      ? { kind: "permanent", error, enhancedCode: result.mailFrom.enhancedCode, reply }
      : { kind: "transient", error, reply };
  }

  const refusedRcpt = result.rcptTo.find((r) => !r.accepted);
  if (refusedRcpt !== undefined && !result.rcptTo.some((r) => r.accepted)) {
    const error = describeReply(`RCPT TO ${refusedRcpt.address}`, refusedRcpt.reply);
    const reply = toDeliveryReply("rcpt_to", refusedRcpt.reply);
    return isPermanentCode(refusedRcpt.reply.code)
      ? { kind: "permanent", error, enhancedCode: refusedRcpt.reply.enhancedCode, reply }
      : { kind: "transient", error, reply };
  }

  if (result.data !== undefined) {
    const error = describeReply("DATA", result.data);
    const reply = toDeliveryReply("data", result.data);
    return isPermanentCode(result.data.code)
      ? { kind: "permanent", error, enhancedCode: result.data.enhancedCode, reply }
      : { kind: "transient", error, reply };
  }

  return { kind: "transient", error: "delivery ended without a DATA reply" };
}

/** One MX target. */
export interface MxTarget {
  exchange: string;
  priority: number;
}

/**
 * Resolve delivery targets for a domain via the container's configured DNS.
 * No MX records => RFC 5321 implicit MX (the domain itself, priority 0).
 */
export async function resolveMxTargets(
  domain: string,
  resolveMx: (domain: string) => Promise<MxTarget[]> = (d) => dns.resolveMx(d),
): Promise<MxTarget[]> {
  try {
    const records = await resolveMx(domain);
    if (records.length > 0) return [...records].sort((a, b) => a.priority - b.priority);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOTFOUND" && code !== "ENODATA") throw err;
  }
  return [{ exchange: domain, priority: 0 }];
}

/** Injectable delivery function; the default speaks real SMTP. */
export type DeliverFn = (row: OutboundMessage) => Promise<DeliveryOutcome>;

/** Resolve a host to its IP addresses (injectable for tests). */
export type ResolveHostFn = (host: string) => Promise<string[]>;

async function defaultResolveHost(host: string): Promise<string[]> {
  const results = await dns.lookup(host, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/** IPv4 ranges deliverd must never open an SMTP connection to. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable => refuse
  }
  return isBlockedIpv4Octets(parts as [number, number, number, number]);
}

function isBlockedIpv4Octets([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

function ipv4Octets(bytes: Uint8Array, offset: number): [number, number, number, number] {
  return [bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!];
}

/** IPv6 addresses deliverd must never open an SMTP connection to (by value). */
function isBlockedIpv6(bytes: Uint8Array): boolean {
  const allZeroThrough = (end: number) => bytes.slice(0, end).every((b) => b === 0);
  // :: (unspecified) and ::1 (loopback)
  if (allZeroThrough(15) && (bytes[15] === 0 || bytes[15] === 1)) return true;
  // ::ffff:a.b.c.d — IPv4-mapped (any spelling: the bytes decide)
  if (allZeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4Octets(ipv4Octets(bytes, 12));
  }
  // ::a.b.c.d — deprecated IPv4-compatible; nothing legitimate uses it
  if (allZeroThrough(12)) return true;
  // 64:ff9b::/96 — NAT64 well-known prefix: the embedded IPv4 decides
  if (
    bytes[0] === 0 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((b) => b === 0)
  ) {
    return isBlockedIpv4Octets(ipv4Octets(bytes, 12));
  }
  // 2002::/16 — 6to4: the embedded IPv4 decides
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isBlockedIpv4Octets(ipv4Octets(bytes, 2));
  // 2001:0::/32 — Teredo: the server IPv4 decides (the client one is obfuscated)
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) {
    return isBlockedIpv4Octets(ipv4Octets(bytes, 4));
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  return false;
}

/**
 * True for addresses deliverd must never connect to: loopback, RFC1918
 * private, link-local, CGNAT, unspecified — and their IPv6 equivalents
 * (loopback ::1, unspecified ::, unique-local fc00::/7, link-local fe80::/10),
 * plus every IPv6 form that embeds an IPv4 (mapped ::ffff:a.b.c.d in any
 * spelling, NAT64, 6to4, Teredo). This is the SSRF guard: a recipient
 * domain whose MX (or implicit-MX A record) points at the internal network
 * would otherwise make deliverd open a blind SMTP connection there. The
 * decision is made on the parsed bytes, never on the text — `dns.lookup` on
 * an IP-literal MX hands back whatever spelling the zone published.
 * Anything unparseable is treated as blocked (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase();
  if (addr === "") return true;
  if (addr.includes(":")) {
    const bytes = parseIpv6(addr);
    return bytes === null ? true : isBlockedIpv6(bytes);
  }
  return isBlockedIpv4(addr);
}

/** Options for the SMTP delivery path. */
export interface SmtpDeliveryOptions {
  /** EHLO name (config.mailHostname). */
  heloName: string;
  /** Per-connection/per-reply timeout. Default 30 s. */
  timeoutMs?: number;
  /**
   * Whole-attempt deadline across every host, ms. Per-reply timeouts alone
   * let a destination that answers each command just inside the limit hold
   * one delivery for minutes; past this the connection is closed and the
   * attempt is a transient timeout. Default 5 min.
   */
  deadlineMs?: number;
  /** How many MX hosts to try per attempt. */
  maxHosts?: number;
  /** Destination port; SMTP relay is 25. Tests point it at a local listener. */
  port?: number;
  /** Injectable MX resolution (tests). */
  resolveMx?: (domain: string) => Promise<MxTarget[]>;
  /** Injectable host->IP resolution for the egress guard (tests). */
  resolveHost?: ResolveHostFn;
  /**
   * Skip the private-address egress guard. Default false. The simulated
   * internet (docker-compose.test.yml) uses 192.168.x peers and sets this;
   * production must leave it off (see {@link isBlockedAddress}).
   */
  allowPrivateTargets?: boolean;
}

/**
 * Attempt one delivery over SMTP: resolve MX, try hosts in priority order,
 * EHLO, opportunistic STARTTLS (fall back to a fresh plaintext connection if
 * the upgrade fails), send, classify. Transport-level failures move on to
 * the next host; a permanent SMTP refusal stops immediately.
 */
export async function deliverOverSmtp(
  row: OutboundMessage,
  opts: SmtpDeliveryOptions,
): Promise<DeliveryOutcome> {
  const at = row.envelopeTo.lastIndexOf("@");
  if (at === -1) return { kind: "permanent", error: `bad recipient: ${row.envelopeTo}` };
  const domain = row.envelopeTo.slice(at + 1).toLowerCase();

  let targets: MxTarget[];
  try {
    targets = await resolveMxTargets(domain, opts.resolveMx);
  } catch (err) {
    return {
      kind: "transient",
      error: `MX lookup failed for ${domain}: ${(err as Error).message}`,
    };
  }

  const allowPrivate = opts.allowPrivateTargets ?? false;
  const resolveHost = opts.resolveHost ?? defaultResolveHost;

  let lastError = `no MX targets for ${domain}`;
  let lastReply: DeliveryReply | undefined;
  let lastTimeout: { step: DeliveryStep; text: string } | undefined;
  let attempted = false;
  let sawBlocked = false;
  const deadlineAt = Date.now() + (opts.deadlineMs ?? 5 * 60_000);
  for (const target of targets.slice(0, opts.maxHosts ?? 3)) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      lastError = `delivery deadline exceeded before ${target.exchange}`;
      lastTimeout = { step: "greeting", text: lastError };
      break;
    }
    // Egress guard (SSRF): resolve the MX ourselves and refuse anything on the
    // internal network, then connect to the vetted IP so no re-resolution can
    // swap in a private address after the check.
    let connectHost = target.exchange;
    if (!allowPrivate) {
      // A real MX names a host. An IP literal in the exchange (a hostile
      // zone; RFC 5321 forbids it) skips resolution entirely, so it never
      // gets the canonical spelling the guard would otherwise see.
      if (net.isIP(target.exchange) !== 0) {
        sawBlocked = true;
        lastError = `refusing MX that is an IP literal: ${target.exchange}`;
        continue;
      }
      let addrs: string[];
      try {
        addrs = await resolveHost(target.exchange);
      } catch (err) {
        lastError = `${target.exchange}: address lookup failed: ${(err as Error).message}`;
        continue;
      }
      if (addrs.length === 0 || addrs.some(isBlockedAddress)) {
        sawBlocked = true;
        lastError = `refusing to deliver to non-public MX ${target.exchange} (${addrs.join(", ") || "no address"})`;
        continue;
      }
      connectHost = addrs[0]!;
    }

    attempted = true;
    lastTimeout = undefined;
    const step = { current: "greeting" as DeliveryStep };
    try {
      return await deliverToHost(row, connectHost, opts, true, deadlineAt, step);
    } catch (err) {
      if (err instanceof SmtpClientError && err.kind === "TIMEOUT") {
        lastTimeout = { step: step.current, text: `${connectHost}: ${err.message}` };
      }
      if (err instanceof SmtpCommandError) {
        const outcome = describeReply(`${connectHost} ${err.command}`, err.reply);
        const reply = toDeliveryReply(stepForCommand(err.command), err.reply);
        if (isPermanentCode(err.reply.code)) {
          return {
            kind: "permanent",
            error: outcome,
            enhancedCode: err.reply.enhancedCode,
            reply,
          };
        }
        lastError = outcome;
        lastReply = reply;
        continue; // 4xx from this host: try the next one
      }
      lastError = `${connectHost}: ${(err as Error).message}`;
    }
  }
  // Every candidate was a blocked internal address and none was even attempted:
  // that will never become deliverable, so fail permanently instead of burning
  // the full retry schedule reconnecting to nothing.
  if (!attempted && sawBlocked) return { kind: "permanent", error: lastError };
  return { kind: "transient", error: lastError, reply: lastReply, timeout: lastTimeout };
}

/** One host attempt; throws SmtpClientError/SmtpCommandError upward. */
async function deliverToHost(
  row: OutboundMessage,
  host: string,
  opts: SmtpDeliveryOptions,
  tryStartTls: boolean,
  deadlineAt: number,
  step: { current: DeliveryStep },
): Promise<DeliveryOutcome> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new SmtpClientError("delivery deadline exceeded", "TIMEOUT");
  const client = await connectSmtp({
    host,
    port: opts.port ?? 25,
    name: opts.heloName,
    timeoutMs: Math.min(opts.timeoutMs ?? 30_000, remainingMs),
    // Opportunistic TLS: encrypt when offered, verify nothing (deliverd
    // would otherwise refuse most of the real world's self-signed MTAs).
    tls: { rejectUnauthorized: false },
  });
  // The whole-attempt deadline: closing the socket fails whatever reply is
  // being awaited, and the catch below turns that into a TIMEOUT.
  let deadlineHit = false;
  const deadline = setTimeout(
    () => {
      deadlineHit = true;
      client.close();
    },
    Math.max(1, deadlineAt - Date.now()),
  );
  try {
    step.current = "ehlo";
    await client.ehlo();
    if (tryStartTls && client.capabilities.has("STARTTLS")) {
      step.current = "starttls";
      try {
        await client.startTls();
      } catch (err) {
        // Upgrade failed: the connection is dead; retry this host once in
        // plaintext rather than skipping it.
        client.close();
        if (err instanceof SmtpCommandError) throw err;
        if (deadlineHit) throw new SmtpClientError("delivery deadline exceeded", "TIMEOUT");
        clearTimeout(deadline);
        return deliverToHost(row, host, opts, false, deadlineAt, step);
      }
    }
    step.current = "data";
    const result = await client.send({
      mailFrom: row.envelopeFrom,
      rcptTo: [row.envelopeTo],
      data: row.raw,
    });
    await client.quit();
    return classifySendResult(result);
  } catch (err) {
    client.close();
    if (deadlineHit) throw new SmtpClientError("delivery deadline exceeded", "TIMEOUT");
    throw err;
  } finally {
    clearTimeout(deadline);
  }
}

/** Options for {@link processQueueOnce} / {@link startQueueWorker}. */
export interface QueueWorkerOptions {
  batchSize: number;
  maxTries: number;
  /**
   * Destination domains delivered at once within a batch (rows for one
   * domain always go one at a time). Default 1 bounds materialized mail.
   * Raising this requires memory for additional message buffers. After a
   * destination timeout, its domain pause defers the remaining rows.
   */
  concurrency?: number;
  deliver: DeliverFn;
  /** Retried transactionally for each permanent failure; all database effects
   * MUST use the supplied transaction. No external side effects. (bounce accounting, DSN,
   * mailbox suppression — `enhancedCode` is the refusing reply's RFC 3463
   * code when the remote sent one). */
  onPermanentFailure?: (
    row: OutboundMessage,
    error: string,
    enhancedCode: string | undefined,
    transaction: Db,
  ) => Promise<void>;
  /** Retry-delay shape; defaults are the ~4-day horizon (backoff.ts). */
  backoff?: { baseMs?: number; maxMs?: number };
  /**
   * Per-destination pause (destinationThrottle.ts). Omitted = off: rows
   * retry on their own backoff only, as before.
   */
  destinationThrottle?: DestinationThrottleOptions;
  now?: () => Date;
  random?: () => number;
  logger?: Logger;
  /**
   * Called as each claimed row starts. The worker loop uses it to advance
   * its heartbeat per ROW rather than per batch: one batch of `batchSize`
   * rows to tarpitting destinations legitimately outlives any sane liveness
   * window, and a batch-granular heartbeat would report maild unhealthy for
   * doing exactly what it is supposed to do.
   */
  onRowStart?: () => void;
}

/**
 * Claim and process one batch. Returns the number of rows processed (0 =>
 * the queue was empty and the caller may sleep).
 */
export async function processQueueOnce(db: Db, opts: QueueWorkerOptions): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? defaultLogger();

  await processFailureJobs(db, opts);

  const { raw: _raw, ...metadata } = getTableColumns(outboundMessages);
  const batchClaimTime = now();
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select(metadata)
      .from(outboundMessages)
      .where(
        and(eq(outboundMessages.status, "pending"), lte(outboundMessages.nextAttemptAt, now())),
      )
      .orderBy(asc(outboundMessages.nextAttemptAt))
      .limit(opts.batchSize)
      .for("update", { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(outboundMessages)
        .set({
          status: "sending",
          tries: sql`${outboundMessages.tries} + 1`,
          claimedAt: batchClaimTime,
        })
        .where(
          inArray(
            outboundMessages.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows;
  });
  queueClaimedTotal.inc({}, claimed.length);

  // Destination pauses, looked up once per batch: rows bound for a domain
  // that told us to back off go straight back to pending (no attempt, no
  // try spent) until the pause lifts.
  const throttle = opts.destinationThrottle;
  const paused =
    throttle === undefined || claimed.length === 0
      ? new Map<string, Date>()
      : await pausedUntilFor(
          db,
          claimed.map((r) => destinationDomain(r.envelopeTo)),
          now(),
        );

  // One claimed row, start to finish. `continue` in the old loop is `return`.
  const processRow = async (row: (typeof claimed)[number]): Promise<void> => {
    opts.onRowStart?.();
    const domain = destinationDomain(row.envelopeTo);
    const pausedUntil = paused.get(domain);
    if (pausedUntil !== undefined) {
      // Spread the wake-ups so the whole batch doesn't reconnect in the
      // same second the pause lifts.
      const jitterMs = Math.round((opts.random ?? Math.random)() * 30_000);
      const deferred = await db
        .update(outboundMessages)
        .set({
          status: "pending",
          tries: row.tries, // the claim counted an attempt that never happened
          nextAttemptAt: new Date(pausedUntil.getTime() + jitterMs),
          lastError: `deferred: ${domain} paused until ${pausedUntil.toISOString()}`,
          claimedAt: null,
        })
        .where(
          and(
            eq(outboundMessages.id, row.id),
            eq(outboundMessages.status, "sending"),
            eq(outboundMessages.claimedAt, batchClaimTime),
          ),
        )
        .returning({ id: outboundMessages.id });
      if (deferred.length > 0) {
        queueDestinationDeferredTotal.inc({ provider: providerFor(domain) });
        logger
          .child({ queueId: row.id, to: row.envelopeTo })
          .info("delivery_deferred_destination", {
            domain,
            pausedUntil: pausedUntil.toISOString(),
          });
      }
      return;
    }
    // Every line below is about THIS row: bind its id once instead of
    // repeating `queueId` at each call site, so a grep/Loki filter on
    // `queueId` returns the row's whole story (skip, retry, failure, the
    // hook error) rather than the subset that remembered to pass it.
    const rowLogger = logger.child({ queueId: row.id, to: row.envelopeTo });
    // Refresh the lease per ROW, immediately before its delivery starts. The
    // batch stamped one claimedAt for up to batchSize rows delivered
    // sequentially, so tail rows behind a tarpitting destination could blow
    // the lease before their own delivery even began. The refresh doubles as
    // the ownership check: it only matches OUR lease timestamp, so a row the
    // reaper reclaimed (and another worker re-claimed) or an operator
    // dropped/bounced is detected here and skipped — no delivery, no
    // duplicate bounce accounting.
    const rowClaimTime = now();
    const refreshed = await db
      .update(outboundMessages)
      .set({ claimedAt: rowClaimTime })
      .where(
        and(
          eq(outboundMessages.id, row.id),
          eq(outboundMessages.status, "sending"),
          eq(outboundMessages.claimedAt, batchClaimTime),
        ),
      )
      .returning({ id: outboundMessages.id, raw: outboundMessages.raw });
    if (refreshed.length === 0) {
      rowLogger.warn("delivery_skipped_row_taken_over");
      return;
    }

    const tries = row.tries + 1; // the claim above counted this attempt
    const startedMs = now().getTime();
    let outcome: DeliveryOutcome;
    try {
      outcome = await opts.deliver({ ...row, raw: refreshed[0]!.raw, tries });
    } catch (err) {
      outcome = { kind: "transient", error: `deliver threw: ${(err as Error).message}` };
    }
    const durationMs = now().getTime() - startedMs;

    if (outcome.kind === "transient" && tries >= opts.maxTries) {
      outcome = { kind: "permanent", error: `retries exhausted: ${outcome.error}` };
    }

    queueDeliveriesTotal.inc({ result: outcome.kind });
    queueDeliveryDurationSeconds.observe({ result: outcome.kind }, durationMs / 1000);
    const provider = providerFor(row.envelopeTo);
    queueDestinationDeliveriesTotal.inc({ provider, result: outcome.kind });
    if (outcome.kind !== "sent" && outcome.reply !== undefined) {
      // Bounded labels: provider bucket × step × 3-digit code × the
      // class.subject prefix of the enhanced code ("4.7"). "How angry is
      // Gmail, and about what" is a rate over this series.
      queueDestinationRepliesTotal.inc({
        provider,
        step: outcome.reply.step,
        code: String(outcome.reply.code),
        enhanced: outcome.reply.enhancedCode?.split(".").slice(0, 2).join(".") ?? "",
      });
    }
    if (throttle !== undefined && domain !== "") {
      if (outcome.kind === "sent") {
        if (await recordSuccess(db, domain, now())) {
          rowLogger.info("destination_recovered", { domain });
        }
      } else {
        // A deferral reply, or a timeout (the tarpit shape — no reply at
        // all), pauses the domain. Code 0 records "no reply" honestly.
        const signal: DeliveryReply | undefined =
          outcome.reply !== undefined && isDeferralSignal(outcome.reply)
            ? outcome.reply
            : outcome.kind === "transient" && outcome.timeout !== undefined
              ? { code: 0, step: outcome.timeout.step, text: outcome.timeout.text }
              : undefined;
        if (signal !== undefined) {
          const recorded = await recordDeferral(db, domain, signal, throttle, now());
          // The rest of this batch's rows for the domain see the pause too.
          paused.set(domain, recorded.pausedUntil);
          destinationPausesTotal.inc({ provider });
          rowLogger.warn("destination_paused", {
            domain,
            strikes: recorded.strikes,
            pausedUntil: recorded.pausedUntil.toISOString(),
            code: signal.code,
            enhanced: signal.enhancedCode ?? null,
            step: signal.step,
          });
        }
      }
    }

    // Terminal/retry writes are guarded on status AND our own lease
    // timestamp. Status alone is not enough: reaper → re-claim by another
    // worker puts the row back in "sending" under a NEWER claimedAt, and a
    // stale worker matching on status would stomp that claim (and could fire
    // bounce accounting twice for one row). claimedAt is the claim nonce —
    // every transition out of "sending" nulls it, every claim/refresh sets a
    // fresh timestamp, so it only matches the worker that owns THIS attempt.
    const guard = and(
      eq(outboundMessages.id, row.id),
      eq(outboundMessages.status, "sending"),
      eq(outboundMessages.claimedAt, rowClaimTime),
    );

    switch (outcome.kind) {
      case "sent": {
        // A delivered message's bytes have no further use: clear raw on the
        // terminal write so retention only has cheap rows to age out.
        const updated = await db
          .update(outboundMessages)
          .set({ status: "sent", lastError: null, claimedAt: null, raw: new Uint8Array(0) })
          .where(guard)
          .returning({ id: outboundMessages.id });
        if (updated.length > 0) {
          rowLogger.info("delivery_sent", { tries, durationMs });
        }
        break;
      }
      case "transient": {
        const delay = backoffDelayMs(tries, { ...opts.backoff, random: opts.random });
        const updated = await db
          .update(outboundMessages)
          .set({
            status: "pending",
            lastError: outcome.error,
            nextAttemptAt: new Date(now().getTime() + delay),
            claimedAt: null,
          })
          .where(guard)
          .returning({ id: outboundMessages.id });
        if (updated.length > 0) {
          rowLogger.info("delivery_retry", {
            tries,
            maxTries: opts.maxTries,
            delaySeconds: Math.round(delay / 1000),
            durationMs,
            error: outcome.error,
          });
        }
        break;
      }
      case "permanent": {
        const updated = await db
          .update(outboundMessages)
          .set({
            status: "failed",
            lastError: outcome.error,
            claimedAt: null,
            failurePending: true,
            failureEnhancedCode: outcome.enhancedCode ?? null,
            nextAttemptAt: now(),
          })
          .where(guard)
          .returning({ id: outboundMessages.id });
        if (updated.length === 0) break; // row taken over: no bounce action
        rowLogger.warn("delivery_failed", {
          tries,
          durationMs,
          error: outcome.error,
        });

        break;
      }
    }
  };

  // Rows grouped by destination domain: domains run concurrently (bounded),
  // a domain's own rows one after another, so one destination can never
  // hold more than one slot of the batch. The pause map is re-read per row
  // because a deferral earlier in this batch updates it.
  const groups = new Map<string, (typeof claimed)[number][]>();
  for (const row of claimed) {
    const domain = destinationDomain(row.envelopeTo);
    const group = groups.get(domain);
    if (group === undefined) groups.set(domain, [row]);
    else group.push(row);
  }
  const queue = [...groups.values()];
  const limit = Math.max(1, opts.concurrency ?? 1);
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (let group = queue.shift(); group !== undefined; group = queue.shift()) {
        for (const row of group) await processRow(row);
      }
    }),
  );
  await processFailureJobs(db, opts);
  return claimed.length;
}

/**
 * Failed rows are also durable jobs. Row locks exclude concurrent workers;
 * a crash/exception rolls back the accounting, suppression, DSN enqueue and
 * completion marker together. A failed job never re-enters SMTP delivery.
 */
export async function processFailureJobs(db: Db, opts: QueueWorkerOptions): Promise<void> {
  const hook = opts.onPermanentFailure;
  if (hook === undefined) return;
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? defaultLogger();
  for (let i = 0; i < opts.batchSize; i++) {
    const processed = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.status, "failed"),
            eq(outboundMessages.failurePending, true),
            lte(outboundMessages.nextAttemptAt, now()),
          ),
        )
        .orderBy(asc(outboundMessages.nextAttemptAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (row === undefined) return false;
      try {
        // Savepoint lets us roll back partial hook effects while retaining
        // the outer lock to schedule the next attempt safely.
        await tx.transaction(async (effects) => {
          await hook(
            row,
            row.lastError ?? "Delivery failed",
            row.failureEnhancedCode ?? undefined,
            effects,
          );
          await effects
            .update(outboundMessages)
            .set({ failurePending: false })
            .where(eq(outboundMessages.id, row.id));
        });
      } catch (err) {
        await tx
          .update(outboundMessages)
          .set({ nextAttemptAt: new Date(now().getTime() + 60_000) })
          .where(eq(outboundMessages.id, row.id));
        logger.error("permanent_failure_hook_error", {
          queueId: row.id,
          error: (err as Error).message,
        });
      }
      return true;
    });
    if (!processed) break;
  }
}

// Lazy so pure unit tests never construct a logger they didn't inject.
let workerLogger: Logger | null = null;
function defaultLogger(): Logger {
  workerLogger ??= createLogger("queue");
  return workerLogger;
}

/** A running worker loop. */
export interface QueueWorker {
  stop(): Promise<void>;
  /** Last loop-iteration start — maild's liveness probe reads this. */
  heartbeatAt(): Date;
}

/** Queue-hygiene knobs for the worker loop (all optional; 0 disables). */
export interface QueueHygieneOptions {
  /** Reap `sending` rows with leases older than this. */
  stuckSendingMs?: number;
  reapIntervalMs?: number;
  /** Delete terminal rows past their retention windows. */
  retainSentDays?: number;
  retainFailedDays?: number;
  retentionIntervalMs?: number;
  /** Age out smtp_rejections rows (Lane K P2); 0 disables. */
  retainRejectionsDays?: number;
  /** Prune never-verified provisional users (retention.ts); 0 disables. */
  retainProvisionalUsersHours?: number;
  /** Age out sent_alerts ledger rows (retention.ts); 0 disables. */
  retainSentAlertsDays?: number;
}

/**
 * Start the poll loop: drain until empty, then sleep pollMs. Reaping and
 * retention piggyback on the loop (time-gated) — no extra process, and
 * concurrent workers running them is an idempotent race.
 */
export function startQueueWorker(
  db: Db,
  opts: QueueWorkerOptions & { pollMs: number; hygiene?: QueueHygieneOptions },
): QueueWorker {
  let stopped = false;
  let wake: (() => void) | null = null;
  let heartbeat = new Date();
  const logger = opts.logger ?? defaultLogger();
  const now = opts.now ?? (() => new Date());
  const hygiene = opts.hygiene ?? {};
  let nextReapAt = 0;
  let nextRetentionAt = 0;

  const runHygiene = async (): Promise<void> => {
    const nowMs = now().getTime();
    const reapEvery = hygiene.reapIntervalMs ?? 0;
    if (reapEvery > 0 && (hygiene.stuckSendingMs ?? 0) > 0 && nowMs >= nextReapAt) {
      nextReapAt = nowMs + reapEvery;
      const reaped = await reapStuckSending(db, {
        olderThanMs: hygiene.stuckSendingMs ?? 0,
        now: opts.now,
      });
      if (reaped.length > 0) {
        queueReapedTotal.inc({}, reaped.length);
        logger.warn("reaped_stuck_sending", { count: reaped.length, ids: reaped.join(",") });
      }
    }
    const retainEvery = hygiene.retentionIntervalMs ?? 0;
    if (retainEvery > 0 && nowMs >= nextRetentionAt) {
      nextRetentionAt = nowMs + retainEvery;
      const deleted = await runRetentionOnce(db, {
        retainSentDays: hygiene.retainSentDays ?? 7,
        retainFailedDays: hygiene.retainFailedDays ?? 30,
        now: opts.now,
      });
      if (deleted.sent > 0) queueRetentionDeletedTotal.inc({ status: "sent" }, deleted.sent);
      if (deleted.failed > 0) queueRetentionDeletedTotal.inc({ status: "failed" }, deleted.failed);
      if (deleted.sent > 0 || deleted.failed > 0) {
        logger.info("retention_deleted", { sent: deleted.sent, failed: deleted.failed });
      }
      if ((hygiene.retainRejectionsDays ?? 0) > 0) {
        const rejections = await runRejectionRetentionOnce(db, {
          retainDays: hygiene.retainRejectionsDays ?? 0,
          now: opts.now,
        });
        if (rejections > 0) {
          queueRetentionDeletedTotal.inc({ status: "smtp_rejections" }, rejections);
          logger.info("rejection_retention_deleted", { deleted: rejections });
        }
      }
      if ((hygiene.retainProvisionalUsersHours ?? 0) > 0) {
        const pruned = await runProvisionalUserRetentionOnce(db, {
          retainHours: hygiene.retainProvisionalUsersHours ?? 0,
          now: opts.now,
        });
        if (pruned > 0) {
          queueRetentionDeletedTotal.inc({ status: "provisional_users" }, pruned);
          logger.info("provisional_users_pruned", { deleted: pruned });
        }
      }
      if ((hygiene.retainSentAlertsDays ?? 0) > 0) {
        const aged = await runSentAlertsRetentionOnce(db, {
          retainDays: hygiene.retainSentAlertsDays ?? 0,
          now: opts.now,
        });
        if (aged > 0) {
          queueRetentionDeletedTotal.inc({ status: "sent_alerts" }, aged);
          logger.info("sent_alerts_retention_deleted", { deleted: aged });
        }
      }
    }
  };

  const loop = (async () => {
    while (!stopped) {
      heartbeat = now();
      let processed = 0;
      // Hygiene gets its OWN try: a reaper/retention failure is housekeeping
      // noise and must not cost the pass its delivery — sharing one try meant
      // a single failing DELETE skipped every queued message that tick.
      try {
        await runHygiene();
      } catch (err) {
        logger.error("hygiene_pass_error", { error: (err as Error).message });
      }
      heartbeat = now();
      try {
        processed = await processQueueOnce(db, { ...opts, onRowStart: () => (heartbeat = now()) });
      } catch (err) {
        logger.error("worker_pass_error", { error: (err as Error).message });
      }
      if (stopped) break;
      if (processed === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, opts.pollMs);
        });
        wake = null;
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
    heartbeatAt: () => heartbeat,
  };
}
