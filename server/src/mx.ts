/**
 * mx — port 25 inbound SMTP (PLAN Milestone 1).
 *
 * Per-message flow (onData):
 *
 *   VERP recipients → bounce accounting (mark email_log, auto-disable)
 *   alias recipients → verifyInbound (SPF/DKIM/DMARC/ARC in-process;
 *     verdict reject → SMTP reject with its code/enhanced; flag → deliver
 *     with an `X-Virtu-Spam-Flag` annotation header — MVP treatment of the
 *     abstract "flag" verdict)
 *   → rewriteForward (contacts/email-log DB adapters injected)
 *   → prepend mailauth's Received-SPF / Authentication-Results
 *   → signOutbound (our domain DKIM key + ARC seal with the pre-rewrite
 *     context) → enqueue (envelope from = VERP bounce_forward, rcpt = the
 *     user's real mailbox)
 *
 * Policy at RCPT time (pipeline/policy.ts): nonexistent alias → 550,
 * disabled alias → 250 accept-and-drop (blocked email_log, nothing queued).
 */

import { config } from "./config.ts";
import { db } from "./db/index.ts";
import type { Db } from "./db/index.ts";
import { createLogger, type Logger } from "./log.ts";
import {
  mxAuthVerdictsTotal,
  mxMessagesTotal,
  mxRcptTotal,
  smtpConnectionsTotal,
} from "./metrics/index.ts";
import {
  type Address,
  buildVerp,
  formatDateHeader,
  type HeaderBlock,
  parseAddressList,
  parseMessage,
  rewriteForward,
  serializeMessage,
} from "./mail/index.ts";
import { type DnsResolver, signOutbound, verifyInbound } from "./mailauth/index.ts";
import { getOrCreateContact } from "./pipeline/contacts.ts";
import { loadDkimKey } from "./pipeline/dkim.ts";
import { makeVerifyResolver } from "./pipeline/dnsTxt.ts";
import {
  extractDsnStatus,
  looksLikeDsn,
  recordBounce,
  recordTransactionalBounce,
} from "./pipeline/bounce.ts";
import { isSuppressionCode, suppressMailbox } from "./pipeline/suppression.ts";
import {
  createBlockedLog,
  createForwardLog,
  resolveOriginalMessageId,
} from "./pipeline/emailLog.ts";
import { type EvaluatedRcpt, evaluateRcpt } from "./pipeline/policy.ts";
import { recordSmtpRejection } from "./pipeline/smtpRejection.ts";
import { loadSmtpTls } from "./pipeline/tls.ts";
import { enqueue } from "./queue/index.ts";
import {
  createSmtpServer,
  rejectWith,
  type SmtpDataEvent,
  type SmtpHookResult,
  type SmtpServer,
  type SmtpTlsConfig,
} from "./smtp/index.ts";

const encoder = new TextEncoder();

/** Lazy singleton for the default verify resolver. */
let cachedResolver: DnsResolver | null = null;
function defaultResolver(): DnsResolver {
  cachedResolver ??= makeVerifyResolver();
  return cachedResolver;
}

/** Everything the mx needs; a subset of config plus injectables for tests. */
export interface MxOptions {
  db: Db;
  mailDomain: string;
  mailHostname: string;
  dkimSelector: string;
  verpSecret: string;
  maxMessageSize: number;
  tls?: SmtpTlsConfig;
  /**
   * DNS resolver override for verifyInbound. Defaults to
   * {@link makeVerifyResolver} — node:dns except TXT, which goes through
   * the wire-format client (Bun's builtin TXT API loses record grouping).
   */
  resolver?: DnsResolver;
  logger?: Logger;
}

// Lazy so tests that inject their own logger never construct the default.
let mxLogger: Logger | null = null;
function defaultMxLogger(): Logger {
  mxLogger ??= createLogger("mx");
  return mxLogger;
}

/** Handle the completed DATA for one inbound message. */
async function handleInboundData(event: SmtpDataEvent, opts: MxOptions): Promise<SmtpHookResult> {
  const { envelope, session } = event;
  // One inbound message fans out: several RCPTs, several verdicts, several
  // queued forwards, each its own line. Bind the connection id (minted by
  // smtp/server.ts) and the peer once, so every line this DATA produces
  // carries the same handle — `sessionId=…` in Loki returns the whole
  // message's story instead of lines that have to be re-correlated by eye.
  const log = (opts.logger ?? defaultMxLogger()).child({
    sessionId: session.id,
    remote: session.remoteAddress,
  });

  // Policy re-evaluation per recipient (RCPT accepted them; rows may have
  // changed since — the DATA-time decision is authoritative).
  const evaluated: EvaluatedRcpt[] = [];
  for (const rcpt of envelope.rcptTo) {
    evaluated.push(
      await evaluateRcpt(opts.db, rcpt.address, {
        verpSecret: opts.verpSecret,
        mailDomain: opts.mailDomain,
      }),
    );
  }

  const parsed = parseMessage(event.raw);

  // 1. Bounce handling: VERP recipients route straight to their email_log
  //    (or, for transactional mail, to the verification_codes row).
  for (const rcpt of evaluated) {
    if (rcpt.decision.kind !== "verp") continue;
    const info = rcpt.decision.info;
    // Only a failure-DSN-shaped message counts as a bounce — for EVERY VERP
    // type. A vacation/OOO auto-reply to the return path, or a "delivery
    // delayed" report, must not invalidate a live code (transactional) NOR
    // book a bounce against the user's own alias (forward/reply) — the latter
    // could trip auto-disable on a victim whose mailbox answers the return
    // path. (utf-8 with replacement chars is fine: the Action fields are ASCII.)
    const bodyText = new TextDecoder().decode(parsed.body);
    const dsnish = looksLikeDsn({
      envelopeFrom: envelope.mailFrom,
      contentType: parsed.headers.get("Content-Type"),
      autoSubmitted: parsed.headers.get("Auto-Submitted"),
      body: bodyText,
    });
    if (!dsnish) {
      mxMessagesTotal.inc({ outcome: "verp_ignored" });
      log.info("verp_non_dsn_ignored", { verpType: info.type, verpId: info.id });
      continue;
    }
    mxMessagesTotal.inc({ outcome: "verp_bounce" });
    if (info.type === "transactional") {
      const result = await recordTransactionalBounce(opts.db, info.id);
      log.info("transactional_bounce", {
        verpId: info.id,
        codeInvalidated: result.code?.id ?? null,
        mailboxFlagged: result.mailboxFlagged,
      });
      continue;
    }
    const result = await recordBounce(opts.db, info.id);
    log.info("bounce_recorded", {
      verpType: info.type,
      emailLogId: info.id,
      aliasDisabled: result.aliasDisabled,
    });
    // Async-bounce suppression (ABUSE.md Tier 1): the DSN's per-recipient
    // Status field is the enhanced code deliverd would have seen at SMTP
    // time. Forward phase only, same as the deliverd path.
    const status = extractDsnStatus(bodyText);
    if (
      info.type === "bounce_forward" &&
      status !== undefined &&
      isSuppressionCode(status) &&
      result.emailLog?.mailboxId != null
    ) {
      const suppressed = await suppressMailbox(opts.db, result.emailLog.mailboxId, {
        enhancedCode: status,
      });
      if (suppressed.suppressed) {
        log.warn("mailbox_suppressed", {
          emailLogId: info.id,
          mailboxId: result.emailLog.mailboxId,
          enhancedCode: status,
        });
      }
    }
  }

  const deliverable = evaluated.filter((r) => r.decision.kind === "deliver");
  const drops = evaluated.filter((r) => r.decision.kind === "drop");
  if (deliverable.length === 0 && drops.length === 0) {
    return { accept: true, message: "Ok" };
  }

  // 2. Authenticate the inbound message (once per message, not per rcpt).
  const verification = await verifyInbound(
    {
      remoteAddress: session.remoteAddress,
      heloHostname: envelope.heloName,
      envelopeFrom: envelope.mailFrom,
      mta: opts.mailHostname,
    },
    event.raw,
    { resolver: opts.resolver ?? defaultResolver() },
  );
  mxAuthVerdictsTotal.inc({ verdict: verification.verdict.action });
  if (verification.verdict.action === "reject") {
    const v = verification.verdict;
    mxMessagesTotal.inc({ outcome: "rejected" });
    log.info("inbound_rejected", {
      from: envelope.mailFrom || "<>",
      reason: v.reason,
      smtpCode: v.code,
    });
    return rejectWith(v.code, v.enhanced, v.message);
  }

  const fromValue = parsed.headers.get("From");
  const fromAddr: Address = (fromValue !== undefined
    ? parseAddressList(fromValue)[0]
    : undefined) ?? {
    address: envelope.mailFrom !== "" ? envelope.mailFrom : "unknown-sender@invalid",
  };
  const originalMessageId = parsed.headers.get("Message-ID") ?? null;
  const prepended = parseMessage(encoder.encode(verification.prependHeaders));
  const dkimKey =
    deliverable.length > 0 ? await loadDkimKey(opts.db, opts.mailDomain, opts.dkimSelector) : null;
  if (deliverable.length > 0 && dkimKey === null) {
    log.warn("dkim_key_missing", { domain: opts.mailDomain, consequence: "forwarding unsigned" });
  }

  // 3. Accept-and-drop recipients: blocked log (with the drop reason —
  //    "mailbox_suppressed" is how a paused mailbox's dropped mail stays
  //    auditable), nothing queued.
  for (const drop of drops) {
    const { alias, user } = drop.facts;
    if (alias === null || user === null) continue;
    const reason = drop.decision.kind === "drop" ? drop.decision.reason : "unknown";
    const scope = { userId: user.id, aliasId: alias.id };
    const contact = await getOrCreateContact(opts.db, scope, fromAddr, "from", {
      mailDomain: opts.mailDomain,
      envelopeFrom: envelope.mailFrom,
    });
    await createBlockedLog(opts.db, {
      userId: user.id,
      contactId: contact.id,
      aliasId: alias.id,
      mailboxId: drop.facts.mailbox?.id ?? null,
      messageId: originalMessageId,
      blockedReason: reason,
    });
    mxMessagesTotal.inc({ outcome: "dropped" });
    log.info("inbound_dropped", { to: drop.address, reason });
  }

  // Trace header for the hop we handled (RFC 5321 §4.4): topmost on every
  // forwarded copy, above the auth results we prepend. HeaderBlock folds
  // and sanitizes at serialize time.
  const receivedValue =
    `from ${envelope.heloName || "unknown"} (${session.remoteAddress}) ` +
    `by ${opts.mailHostname} (virtu) with ESMTP; ${formatDateHeader(new Date())}`;

  // 4. Forward pipeline per deliverable recipient × delivery mailbox (an
  //    alias can deliver to several mailboxes; each copy gets its own
  //    email_log so bounce accounting stays per-mailbox).
  for (const rcpt of deliverable) {
    const alias = rcpt.facts.alias!;
    const user = rcpt.facts.user!;
    const scope = { userId: user.id, aliasId: alias.id };
    const isTrash = rcpt.decision.kind === "deliver" && rcpt.decision.trash === true;

    const fromContact = await getOrCreateContact(opts.db, scope, fromAddr, "from", {
      mailDomain: opts.mailDomain,
      envelopeFrom: envelope.mailFrom,
    });

    for (const mailbox of rcpt.facts.deliveryMailboxes) {
      const emailLog = await createForwardLog(opts.db, {
        userId: user.id,
        contactId: fromContact.id,
        aliasId: alias.id,
        mailboxId: mailbox.id,
        messageId: originalMessageId,
      });

      const rewritten = await rewriteForwardForAlias(opts, {
        alias,
        mailbox,
        user,
        emailLogId: emailLog.id,
        parsedHeaders: parsed.headers,
        envelopeFrom: envelope.mailFrom,
      });

      // Prepend the auth results (fields keep their raw bytes → verbatim),
      // then our Received on top.
      rewritten.fields.unshift(...prepended.headers.fields.map((f) => ({ ...f })));
      rewritten.prepend("Received", receivedValue);
      if (verification.verdict.action === "flag") {
        rewritten.append("X-Virtu-Spam-Flag", `YES (${verification.verdict.reason})`);
      }
      if (isTrash) {
        // The alias is off: the copy goes to the trash inbox, marked so
        // mailbox-side filters can file it.
        rewritten.append("X-Virtu-Trash", "YES (alias disabled)");
      }

      let message: Uint8Array;
      if (dkimKey === null) {
        message = serializeMessage(rewritten, parsed.body);
      } else {
        const signed = await signOutbound(rewritten, parsed.body, {
          dkimKeys: [dkimKey],
          arc:
            verification.arcContext === null
              ? undefined
              : {
                  signingDomain: opts.mailDomain,
                  selector: dkimKey.selector,
                  privateKey: dkimKey.privateKey,
                  context: verification.arcContext,
                },
        });
        for (const err of signed.errors) {
          log.error("dkim_sign_error", {
            domain: err.signingDomain,
            selector: err.selector,
            error: err.err.message,
          });
        }
        message = signed.message;
      }

      // Trash copies use the NULL reverse path: an off alias must not start
      // emitting delivery-failure signals (DSNs to the outside sender,
      // bounce accounting) that accept-and-drop never produced. A broken
      // trash mailbox fails silently in the queue log — the dumpster's
      // health is the user's dashboard concern, not the sender's.
      const envelopeFrom = isTrash
        ? ""
        : buildVerp({
            type: "bounce_forward",
            id: emailLog.id,
            secret: opts.verpSecret,
            domain: opts.mailDomain,
          });
      const queueId = await enqueue(opts.db, {
        raw: message,
        envelopeFrom,
        envelopeTo: mailbox.email,
        maxRawBytes: opts.maxMessageSize,
        userId: user.id,
        emailLogId: emailLog.id,
      });
      mxMessagesTotal.inc({ outcome: isTrash ? "trash" : "forwarded" });
      log.info("forward_queued", {
        queueId,
        alias: rcpt.address,
        to: mailbox.email,
        trash: isTrash,
        emailLogId: emailLog.id,
      });
    }
  }

  return { accept: true, message: "Ok: queued" };
}

/** The pure rewrite with its DB callbacks wired up. */
async function rewriteForwardForAlias(
  opts: MxOptions,
  ctx: {
    alias: { id: number; email: string };
    mailbox: { email: string };
    user: { id: number };
    emailLogId: number;
    parsedHeaders: HeaderBlock;
    envelopeFrom: string;
  },
): Promise<HeaderBlock> {
  const scope = { userId: ctx.user.id, aliasId: ctx.alias.id };
  const result = await rewriteForward(
    { headers: ctx.parsedHeaders },
    {
      alias: { email: ctx.alias.email },
      mailbox: { email: ctx.mailbox.email },
      envelopeFrom: ctx.envelopeFrom,
      emailLogId: ctx.emailLogId,
      getOrCreateContact: async (addr, source) => {
        const contact = await getOrCreateContact(opts.db, scope, addr, source, {
          mailDomain: opts.mailDomain,
          envelopeFrom: ctx.envelopeFrom,
        });
        return { replyEmail: contact.replyEmail };
      },
      resolveOriginalMessageId: (ourId) => resolveOriginalMessageId(opts.db, ctx.user.id, ourId),
    },
  );
  return result.headers;
}

/** Build the port-25 server (listeners not yet bound). */
export function createMxServer(opts: MxOptions): SmtpServer {
  return createSmtpServer({
    hostname: opts.mailHostname,
    banner: "virtu mx",
    tls: opts.tls,
    maxMessageSize: opts.maxMessageSize,
    onConnect: () => {
      smtpConnectionsTotal.inc({ listener: "mx" });
      return { accept: true };
    },
    onRcptTo: async (event) => {
      const { decision } = await evaluateRcpt(opts.db, event.address, {
        verpSecret: opts.verpSecret,
        mailDomain: opts.mailDomain,
      });
      mxRcptTotal.inc({ decision: decision.kind });
      if (decision.kind === "reject") {
        const result = rejectWith(decision.code, decision.enhanced, decision.message);
        await recordSmtpRejection(
          opts.db,
          {
            entrypoint: "mx",
            phase: "rcpt_to",
            remoteAddress: event.session.remoteAddress,
            heloName: event.session.heloName,
            rcptTo: event.address,
            reject: result.reject,
          },
          opts.logger ?? defaultMxLogger(),
        );
        return result;
      }
      return { accept: true };
    },
    // Any DATA-time reject (today: the SPF/DKIM/DMARC verdict) is recorded
    // with the full envelope before the reply goes out.
    onData: async (event) => {
      const result = await handleInboundData(event, opts);
      if ("reject" in result) {
        await recordSmtpRejection(
          opts.db,
          {
            entrypoint: "mx",
            phase: "data",
            remoteAddress: event.session.remoteAddress,
            heloName: event.envelope.heloName,
            mailFrom: event.envelope.mailFrom,
            rcptTo: event.envelope.rcptTo.map((r) => r.address).join(", "),
            reject: result.reject,
          },
          opts.logger ?? defaultMxLogger(),
        );
      }
      return result;
    },
  });
}

/** Options assembled from config + env (the real entrypoint path). */
export function mxOptionsFromConfig(): MxOptions {
  return {
    db,
    mailDomain: config.mailDomain,
    mailHostname: config.mailHostname,
    dkimSelector: config.dkimSelector,
    verpSecret: config.verpSecret,
    maxMessageSize: config.smtpMaxMessageSize,
    tls: loadSmtpTls(config.smtpTlsCertFile, config.smtpTlsKeyFile),
  };
}

/** Start the mx listener on config.mxPort. */
export async function startMx(): Promise<SmtpServer> {
  const server = createMxServer(mxOptionsFromConfig());
  const bound = await server.listen(config.mxPort, config.smtpHost);
  defaultMxLogger().info("listening", { host: bound.host, port: bound.port });
  return server;
}

if (import.meta.main) {
  void startMx();
}
