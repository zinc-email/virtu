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
 * DSN generation is a STUB for MVP: permanent failures log loudly and rely
 * on the bounce-accounting callback (recordBounce) for user-visible state.
 * Null-reverse-path rows never produce any bounce action (never bounce a
 * bounce).
 */

import { promises as dns } from "node:dns";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { type OutboundMessage, outboundMessages } from "../db/schema.ts";
import {
  connectSmtp,
  SmtpClientError,
  SmtpCommandError,
  type SmtpReply,
  type SmtpSendResult,
} from "../smtp/index.ts";
import { backoffDelayMs } from "./backoff.ts";

/** Outcome of one delivery attempt. */
export type DeliveryOutcome =
  | { kind: "sent" }
  | { kind: "permanent"; error: string }
  | { kind: "transient"; error: string };

/** Format one SMTP reply for last_error. */
function describeReply(step: string, reply: SmtpReply): string {
  const enhanced = reply.enhancedCode === undefined ? "" : ` ${reply.enhancedCode}`;
  return `${step}: ${reply.code}${enhanced} ${reply.message.split("\n")[0] ?? ""}`.trim();
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
    return isPermanentCode(result.mailFrom.code)
      ? { kind: "permanent", error }
      : { kind: "transient", error };
  }

  const refusedRcpt = result.rcptTo.find((r) => !r.accepted);
  if (refusedRcpt !== undefined && !result.rcptTo.some((r) => r.accepted)) {
    const error = describeReply(`RCPT TO ${refusedRcpt.address}`, refusedRcpt.reply);
    return isPermanentCode(refusedRcpt.reply.code)
      ? { kind: "permanent", error }
      : { kind: "transient", error };
  }

  if (result.data !== undefined) {
    const error = describeReply("DATA", result.data);
    return isPermanentCode(result.data.code)
      ? { kind: "permanent", error }
      : { kind: "transient", error };
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

/** Options for the SMTP delivery path. */
export interface SmtpDeliveryOptions {
  /** EHLO name (config.mailHostname). */
  heloName: string;
  /** Per-connection/per-reply timeout. */
  timeoutMs?: number;
  /** How many MX hosts to try per attempt. */
  maxHosts?: number;
  /** Injectable MX resolution (tests). */
  resolveMx?: (domain: string) => Promise<MxTarget[]>;
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

  let lastError = `no MX targets for ${domain}`;
  for (const target of targets.slice(0, opts.maxHosts ?? 3)) {
    try {
      return await deliverToHost(row, target.exchange, opts, true);
    } catch (err) {
      if (err instanceof SmtpCommandError) {
        const outcome = describeReply(`${target.exchange} ${err.command}`, err.reply);
        if (isPermanentCode(err.reply.code)) return { kind: "permanent", error: outcome };
        lastError = outcome;
        continue; // 4xx from this host: try the next one
      }
      lastError = `${target.exchange}: ${(err as Error).message}`;
    }
  }
  return { kind: "transient", error: lastError };
}

/** One host attempt; throws SmtpClientError/SmtpCommandError upward. */
async function deliverToHost(
  row: OutboundMessage,
  host: string,
  opts: SmtpDeliveryOptions,
  tryStartTls: boolean,
): Promise<DeliveryOutcome> {
  const client = await connectSmtp({
    host,
    port: 25,
    name: opts.heloName,
    timeoutMs: opts.timeoutMs ?? 30_000,
    // Opportunistic TLS: encrypt when offered, verify nothing (deliverd
    // would otherwise refuse most of the real world's self-signed MTAs).
    tls: { rejectUnauthorized: false },
  });
  try {
    await client.ehlo();
    if (tryStartTls && client.capabilities.has("STARTTLS")) {
      try {
        await client.startTls();
      } catch (err) {
        // Upgrade failed: the connection is dead; retry this host once in
        // plaintext rather than skipping it.
        client.close();
        if (err instanceof SmtpCommandError) throw err;
        return deliverToHost(row, host, opts, false);
      }
    }
    const result = await client.send({
      mailFrom: row.envelopeFrom,
      rcptTo: [row.envelopeTo],
      data: row.raw,
    });
    await client.quit();
    return classifySendResult(result);
  } catch (err) {
    client.close();
    throw err;
  }
}

/** Options for {@link processQueueOnce} / {@link startQueueWorker}. */
export interface QueueWorkerOptions {
  batchSize: number;
  maxTries: number;
  deliver: DeliverFn;
  /** Called once per row that permanently failed (bounce accounting, DSN stub). */
  onPermanentFailure?: (row: OutboundMessage, error: string) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  log?: (message: string) => void;
}

/**
 * Claim and process one batch. Returns the number of rows processed (0 =>
 * the queue was empty and the caller may sleep).
 */
export async function processQueueOnce(db: Db, opts: QueueWorkerOptions): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m) => console.log(m));

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
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
        .set({ status: "sending", tries: sql`${outboundMessages.tries} + 1` })
        .where(
          inArray(
            outboundMessages.id,
            rows.map((r) => r.id),
          ),
        );
    }
    return rows;
  });

  for (const row of claimed) {
    const tries = row.tries + 1; // the claim above counted this attempt
    let outcome: DeliveryOutcome;
    try {
      outcome = await opts.deliver({ ...row, tries });
    } catch (err) {
      outcome = { kind: "transient", error: `deliver threw: ${(err as Error).message}` };
    }

    if (outcome.kind === "transient" && tries >= opts.maxTries) {
      outcome = { kind: "permanent", error: `retries exhausted: ${outcome.error}` };
    }

    switch (outcome.kind) {
      case "sent":
        await db
          .update(outboundMessages)
          .set({ status: "sent", lastError: null })
          .where(eq(outboundMessages.id, row.id));
        log(`queue: sent #${row.id} to ${row.envelopeTo}`);
        break;
      case "transient": {
        const delay = backoffDelayMs(tries, opts.random);
        await db
          .update(outboundMessages)
          .set({
            status: "pending",
            lastError: outcome.error,
            nextAttemptAt: new Date(now().getTime() + delay),
          })
          .where(eq(outboundMessages.id, row.id));
        log(
          `queue: retry #${row.id} to ${row.envelopeTo} in ${Math.round(delay / 1000)}s ` +
            `(try ${tries}/${opts.maxTries}): ${outcome.error}`,
        );
        break;
      }
      case "permanent":
        await db
          .update(outboundMessages)
          .set({ status: "failed", lastError: outcome.error })
          .where(eq(outboundMessages.id, row.id));
        log(`queue: FAILED #${row.id} to ${row.envelopeTo}: ${outcome.error}`);
        if (opts.onPermanentFailure !== undefined) {
          try {
            await opts.onPermanentFailure(row, outcome.error);
          } catch (err) {
            log(`queue: onPermanentFailure for #${row.id} threw: ${(err as Error).message}`);
          }
        }
        break;
    }
  }

  return claimed.length;
}

/** A running worker loop. */
export interface QueueWorker {
  stop(): Promise<void>;
}

/** Start the poll loop: drain until empty, then sleep pollMs. */
export function startQueueWorker(
  db: Db,
  opts: QueueWorkerOptions & { pollMs: number },
): QueueWorker {
  let stopped = false;
  let wake: (() => void) | null = null;

  const loop = (async () => {
    while (!stopped) {
      let processed = 0;
      try {
        processed = await processQueueOnce(db, opts);
      } catch (err) {
        (opts.log ?? console.error)(`queue: worker pass failed: ${(err as Error).message}`);
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
  };
}
