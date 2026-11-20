import { reportSigningFailure } from "./mailauth/sign.ts";
import { signedMessageLimit } from "./queue/enqueue.ts";
/**
 * submission — authenticated mail submission (PLAN Milestone 2): one options
 * object, two listeners — 587 (STARTTLS required before AUTH, always: with
 * no TLS configured the listener simply has no AUTH, unless the dev-only
 * SUBMISSION_ALLOW_PLAINTEXT_AUTH is set) and 465 (implicit TLS, only when
 * TLS is configured). Production refuses to start without TLS
 * (config.ts assertProductionSmtpTls).
 *
 * AUTH: email + device password (smtp_credentials — app passwords created/
 * revoked independently; the account has no password). The password's first
 * group is a plaintext selector resolving to one row — one lookup, one
 * argon2id verify (auth/smtpPassword.ts) — and a process-wide bulkhead caps
 * concurrent verifies (pipeline/verifyBulkhead.ts). The matched row gets
 * last_used_at stamped.
 *
 * Two sending modes, chosen by MAIL FROM (the outbound-alias metadata):
 *
 * - MAIL FROM = one of the user's ALIASES ("send mode"): each recipient is
 *   either a reverse alias of that alias (translated back to the contact's
 *   real address — the reply path) or any outside address (a COLD email: a
 *   contact is minted for (alias, recipient) so future replies thread, and
 *   the message goes out with From = the alias). To/Cc entries that are
 *   reverse aliases are translated; other entries pass through verbatim —
 *   except the user's own mailbox addresses (including plus-tagged variants),
 *   any OTHER reverse alias, and unknown local addresses, which refuse
 *   (never leak, never emit an internal address outsiders can't reply to).
 * - MAIL FROM = one of the user's MAILBOXES ("reply mode", what a stock MUA
 *   does when replying): every recipient must be a reverse alias, and they
 *   must all belong to the same alias — the contact rows decide WHICH alias
 *   the mail goes out as. Strict reply semantics: no external recipients.
 *
 * Both modes then share the pipeline: rewriteReply → DKIM-sign
 * (custom-domain aliases with the domain's own key once dkim_verified, else
 * the service key — pipeline/dkim.ts selectReplyDkimKey) → enqueue per
 * recipient (envelope from = VERP bounce_reply, rcpt = the real address).
 */

import { randomUUID } from "node:crypto";
import { assertProductionSmtpTls, config } from "./config.ts";
import { db } from "./db/index.ts";
import type { Db } from "./db/index.ts";
import { and, eq } from "drizzle-orm";
import {
  type Alias,
  aliases,
  type Contact,
  deletedAliases,
  domains,
  mailboxes,
  type SmtpCredential,
  smtpCredentials,
  type User,
  users,
} from "./db/schema.ts";
import { splitSmtpPassword, verifyAgainstDummy, warmDummyHash } from "./auth/smtpPassword.ts";
import { createLogger, type Logger } from "./log.ts";
import { buildVerp, MAX_HEADER_FIELDS, parseMessage, rewriteReply } from "./mail/index.ts";
import { signOutbound } from "./mailauth/index.ts";
import {
  smtpConnectionsTotal,
  submissionAuthTotal,
  submissionEnqueuedTotal,
  submissionQueueFullTotal,
  submissionQuotaRefusedTotal,
  submissionRcptRefusedTotal,
} from "./metrics/index.ts";
import { isPremium } from "./billing/premium.ts";
import { mailboxMatchKey } from "./pipeline/addressMatch.ts";
import { type AuthThrottle, authThrottleKey, createAuthThrottle } from "./pipeline/authThrottle.ts";
import { findOrCreateContact, resolveReverseAlias } from "./pipeline/contacts.ts";
import { selectReplyDkimKey } from "./pipeline/dkim.ts";
import { createReplyLog, resolveOurMessageId, setMessageIdMap } from "./pipeline/emailLog.ts";
import { senderOwnership } from "./pipeline/policy.ts";
import { recordSmtpRejection } from "./pipeline/smtpRejection.ts";
import {
  countRecentSends,
  dailySendLimit,
  decideSendQuota,
  type SendQuotaLimits,
} from "./pipeline/sendQuota.ts";
import { loadSmtpTls } from "./pipeline/tls.ts";
import { type Bulkhead, createBulkhead } from "./pipeline/verifyBulkhead.ts";
import { enqueue } from "./queue/index.ts";
import {
  decideQueueQuota,
  OUTBOUND_QUEUE_FULL_REPLY,
  pendingUsage,
  type QueueQuotaLimits,
} from "./queue/quota.ts";
import {
  createSmtpServer,
  rejectWith,
  type SmtpDataEvent,
  type SmtpHookResult,
  type SmtpServer,
  type SmtpServerOptions,
  type SmtpTlsConfig,
  type DataBudget,
  processDataBudget,
} from "./smtp/index.ts";

/** Everything submission needs; a subset of config plus injectables. */
export interface SubmissionOptions {
  db: Db;
  mailDomain: string;
  mailHostname: string;
  dkimSelector: string;
  verpSecret: string;
  maxMessageSize: number;
  /** In-flight DATA byte budget shared with the mx (smtp/dataBudget.ts). */
  dataBudget?: DataBudget;
  tls?: SmtpTlsConfig;
  /** Failed-AUTH throttle override for tests; default {@link createAuthThrottle}. */
  authThrottle?: AuthThrottle;
  /** Concurrent-verify bulkhead override for tests; default {@link createBulkhead}. */
  verifyBulkhead?: Bulkhead;
  /** Daily send quota plan defaults; omitted = quota not enforced (tests). */
  sendQuota?: SendQuotaLimits;
  /** Per-user pending-queue cap (queue/quota.ts); omitted = not enforced (tests). */
  queueQuota?: QueueQuotaLimits;
  /**
   * Offer AUTH on the plaintext 587 listener when no TLS is configured.
   * Off by default: a listener without TLS then has no AUTH at all, so a
   * deploy whose mail certs never arrived cannot leak credentials in the
   * clear (it just cannot submit — loud, not silent). Dev-only; production
   * refuses it (config.ts assertProductionSmtpTls). Irrelevant once `tls`
   * is set: AUTH then always requires the TLS layer.
   */
  allowPlaintextAuth?: boolean;
  logger?: Logger;
}

// Lazy so tests that inject their own logger never construct the default.
let submissionLogger: Logger | null = null;
function defaultSubmissionLogger(): Logger {
  submissionLogger ??= createLogger("submission");
  return submissionLogger;
}

/** One SMTP AUTH attempt's verdict from {@link verifyCredentials}.
 * "saturated" = the verify bulkhead had no slot, so no credential was
 * examined — answer 454, not 535. */
export type SmtpAuthOutcome = "ok" | "invalid" | "saturated";

/**
 * Verify (once) that credentials are usable for message submission: one of
 * the user's per-device SMTP credentials — accounts have no password, so
 * device credentials are the only thing SMTP AUTH accepts.
 *
 * Selector scheme (auth/smtpPassword.ts, security review P2): the password's
 * first group resolves (user, selector) to at most ONE row — one indexed
 * lookup, one argon2id verify — never a loop over every credential. Any miss
 * (unknown user, unsplittable password, no selector match) burns the same
 * dummy verify before refusing, so misses cost
 * like wrong secrets. (The argon2 work dominates; the extra sub-ms
 * credential lookup on known users is the residual timing channel the
 * review notes and deliberately doesn't chase.) A match stamps the
 * credential's last_used_at (the dashboard shows it).
 *
 * When `opts.verifyBulkhead` is set it meters ONLY the argon2id call — the
 * DB lookups around it are cheap I/O that must not consume verify slots, or
 * DB latency alone would refuse legitimate clients with no hashing in
 * flight.
 */
export async function verifyCredentials(
  opts: Pick<SubmissionOptions, "db" | "verifyBulkhead">,
  username: string,
  password: string,
): Promise<SmtpAuthOutcome> {
  // Split before any DB work: an unsplittable password can never match, so
  // it goes straight to the dummy verify without spending a users lookup.
  const split = splitSmtpPassword(password);
  const email = username.trim().toLowerCase();

  let credential: SmtpCredential | undefined;
  if (split !== null) {
    const rows = await opts.db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];
    if (user !== undefined && !user.disabled) {
      credential = (
        await opts.db
          .select()
          .from(smtpCredentials)
          .where(
            and(eq(smtpCredentials.userId, user.id), eq(smtpCredentials.selector, split.selector)),
          )
          .limit(1)
      )[0];
    }
  }

  const bulkhead = opts.verifyBulkhead;
  if (bulkhead !== undefined && !bulkhead.tryAcquire()) return "saturated";
  let verified: boolean;
  try {
    verified =
      credential !== undefined && split !== null
        ? await Bun.password.verify(split.secret, credential.passwordHash)
        : await verifyAgainstDummy(split?.secret ?? password);
  } finally {
    bulkhead?.release();
  }
  if (!verified || credential === undefined) return "invalid";

  await opts.db
    .update(smtpCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(smtpCredentials.id, credential.id));
  return "ok";
}

const AUTH_REQUIRED = rejectWith(530, "5.7.0", "Authentication required");
const BAD_CREDENTIALS = rejectWith(535, "5.7.8", "Authentication credentials invalid");
const NOT_REVERSE_ALIAS = rejectWith(
  550,
  "5.7.1",
  "Recipient is not a reverse alias of the sending alias",
);
const MIXED_ALIASES = rejectWith(
  550,
  "5.7.1",
  "Recipients belong to different aliases; send one message per alias",
);
const MAILBOX_LEAK = rejectWith(
  550,
  "5.7.1",
  "To/Cc must not contain your own mailbox address (it would leak)",
);
const ALIAS_DISABLED = rejectWith(550, "5.7.1", "Alias is disabled");

/** Load the authenticated user for a session, or null. */
async function authedUser(db: Db, authUser: string | undefined): Promise<User | null> {
  if (authUser === undefined) return null;
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, authUser.trim().toLowerCase()))
    .limit(1);
  const user = rows[0];
  if (user === undefined || user.disabled) return null;
  return user;
}

/**
 * The one local-address rule, shared by RCPT-time and DATA-time checks so the
 * two can never diverge: on our domains an address must be an existing alias
 * (alias→alias mail routes back through the mx) or covered by the domain's
 * catch-all (the mx mints the alias on arrival); anything else is a
 * typo/probe — refuse rather than bounce later. Returns true when the
 * address is local AND undeliverable; non-local addresses never refuse here.
 */
async function refusesLocalAddress(db: Db, mailDomain: string, address: string): Promise<boolean> {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at === -1) return true; // malformed (no domain) — never a deliverable target
  const domain = normalized.slice(at + 1);
  if (domain !== mailDomain) {
    const domainRows = await db
      .select({ catchAll: domains.catchAll })
      .from(domains)
      .where(and(eq(domains.name, domain), eq(domains.verifiedMx, true)))
      .limit(1);
    const custom = domainRows[0];
    if (custom === undefined) return false; // not a domain of ours
    if (custom.catchAll) {
      // The mx mints on arrival — UNLESS the address is tombstoned, in which
      // case it stays dead (never re-minted) and the send would black-hole.
      const tomb = await db
        .select({ id: deletedAliases.id })
        .from(deletedAliases)
        .where(eq(deletedAliases.email, normalized))
        .limit(1);
      return tomb[0] !== undefined;
    }
  }
  const aliasRows = await db
    .select({ id: aliases.id })
    .from(aliases)
    .where(eq(aliases.email, normalized))
    .limit(1);
  return aliasRows[0] === undefined;
}

/** One classified envelope recipient (no rows created yet). */
type PlanEntry =
  /** rcpt was a reverse alias: the existing contact carries the metadata. */
  | { kind: "reply"; contact: Contact }
  /** rcpt is a real outside address; its contact is minted only after the
   * WHOLE message (headers included) has been accepted. */
  | { kind: "cold"; address: string };

/** One resolved outbound recipient: the contact row that carries the metadata. */
interface OutboundTarget {
  contact: Contact;
  /** "reply" = rcpt was a reverse alias; "cold" = a real outside address. */
  kind: "reply" | "cold";
}

/**
 * Classify the sending alias, the mode, and the envelope recipients for one
 * submission — READ-ONLY: refusal here (or later, by the header screen) must
 * leave no trace, so cold contacts are minted by the caller only once the
 * whole message is accepted.
 */
async function resolveOutbound(
  opts: SubmissionOptions,
  user: User,
  mailFrom: string,
  rcptAddresses: string[],
): Promise<
  | {
      alias: Alias;
      plan: PlanEntry[];
      mode: "send" | "reply";
      /** Reply mode: the authenticated MAIL FROM mailbox — email_logs record
       * it so a failed reply's DSN reaches the inbox that actually sent. */
      sendingMailboxId: number | null;
    }
  | { reject: SmtpHookResult }
> {
  const log = opts.logger ?? defaultSubmissionLogger();
  const ownership = await senderOwnership(opts.db, user.id, mailFrom);

  if (ownership.kind === "none") {
    return { reject: rejectWith(550, "5.7.1", "MAIL FROM must be one of your aliases") };
  }

  if (ownership.kind === "mailbox") {
    // Reply mode: the reverse-alias contact rows are the metadata that picks
    // the outbound alias. Every recipient must resolve, to the SAME alias.
    if (!ownership.mailbox.verified) {
      return { reject: rejectWith(550, "5.7.1", "Sending mailbox is not verified") };
    }
    if (ownership.mailbox.disabled) {
      // A disabled mailbox is excluded from inbound delivery; it must not
      // keep an outbound path either.
      return { reject: rejectWith(550, "5.7.1", "Sending mailbox is disabled") };
    }
    const contacts: Contact[] = [];
    for (const rcpt of rcptAddresses) {
      const contact = await resolveReverseAlias(opts.db, rcpt);
      if (contact === null || contact.userId !== user.id) {
        submissionRcptRefusedTotal.inc({ reason: "not_reverse_alias" });
        log.info("rcpt_refused", { rcpt, from: mailFrom, reason: "not_reverse_alias" });
        return { reject: NOT_REVERSE_ALIAS };
      }
      contacts.push(contact);
    }
    if (contacts.length === 0) return { reject: NOT_REVERSE_ALIAS };
    const aliasId = contacts[0]!.aliasId;
    if (contacts.some((c) => c.aliasId !== aliasId)) return { reject: MIXED_ALIASES };
    const aliasRows = await opts.db.select().from(aliases).where(eq(aliases.id, aliasId)).limit(1);
    const alias = aliasRows[0];
    if (alias === undefined || alias.userId !== user.id) return { reject: NOT_REVERSE_ALIAS };
    if (!alias.enabled) return { reject: ALIAS_DISABLED };
    return {
      alias,
      plan: contacts.map((contact) => ({ contact, kind: "reply" as const })),
      mode: "reply",
      sendingMailboxId: ownership.mailbox.id,
    };
  }

  // Send mode (MAIL FROM = the alias): reverse aliases reply; anything else
  // is a cold email, classified here and minted by the caller once the whole
  // message — envelope AND headers — is accepted.
  const alias = ownership.alias;
  if (!alias.enabled) return { reject: ALIAS_DISABLED };
  const plan: PlanEntry[] = [];
  for (const rcpt of rcptAddresses) {
    const reverse = await resolveReverseAlias(opts.db, rcpt);
    if (reverse !== null) {
      if (reverse.userId !== user.id || reverse.aliasId !== alias.id) {
        submissionRcptRefusedTotal.inc({ reason: "cross_alias" });
        log.info("rcpt_refused", { rcpt, from: alias.email, reason: "cross_alias" });
        return { reject: NOT_REVERSE_ALIAS };
      }
      plan.push({ kind: "reply", contact: reverse });
      continue;
    }
    if (await refusesLocalAddress(opts.db, opts.mailDomain, rcpt)) {
      submissionRcptRefusedTotal.inc({ reason: "unknown_local" });
      log.info("rcpt_refused", { rcpt, from: alias.email, reason: "unknown_local" });
      return { reject: NOT_REVERSE_ALIAS };
    }
    plan.push({ kind: "cold", address: rcpt });
  }
  if (plan.length === 0) return { reject: NOT_REVERSE_ALIAS };
  return { alias, plan, mode: "send", sendingMailboxId: null };
}

/** Handle a completed authenticated submission. */
async function handleSubmissionData(
  event: SmtpDataEvent,
  opts: SubmissionOptions,
): Promise<SmtpHookResult> {
  const { envelope, session } = event;
  // One submission fans out across recipients, refusals and enqueues. Bind
  // the connection id (smtp/server.ts) and the authenticated user once so
  // every line the message produces — here and inside resolveOutbound —
  // shares one handle to filter on.
  const log = (opts.logger ?? defaultSubmissionLogger()).child({
    sessionId: session.id,
    authUser: envelope.authUser ?? null,
  });

  const user = await authedUser(opts.db, envelope.authUser);
  if (user === null) return envelope.authUser === undefined ? AUTH_REQUIRED : BAD_CREDENTIALS;

  const resolved = await resolveOutbound(
    // The session-scoped logger, not the bare one: resolveOutbound's refusal
    // lines belong to the same message as everything below.
    { ...opts, logger: log },
    user,
    envelope.mailFrom,
    envelope.rcptTo.map((r) => r.address),
  );
  if ("reject" in resolved) return resolved.reject;
  const { alias, plan, mode, sendingMailboxId } = resolved;

  // Everything from the quota check down is check-then-act against rows
  // this same call writes, so a user's submissions run one at a time:
  // twenty parallel connections used to read the same low count and all
  // pass. One process (maild), one lock map; a second submission process
  // would have its own, which at worst doubles the quota, not unbounds it.
  return withUserSendLock(user.id, () =>
    opts.db.transaction((tx) =>
      completeSubmission(event, { ...opts, db: tx }, log, user, {
        alias,
        plan,
        mode,
        sendingMailboxId,
      }),
    ),
  );
}

/** Per-user serialization of the quota → write → enqueue section. */
const userSendLocks = new Map<number, Promise<void>>();
async function withUserSendLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const previous = userSendLocks.get(userId) ?? Promise.resolve();
  let release: () => void = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => mine);
  userSendLocks.set(userId, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (userSendLocks.get(userId) === chained) userSendLocks.delete(userId);
  }
}

/** The rest of a submission, under the user's send lock. */
async function completeSubmission(
  event: SmtpDataEvent,
  opts: SubmissionOptions,
  log: Logger,
  user: User,
  resolved: Extract<Awaited<ReturnType<typeof resolveOutbound>>, { alias: unknown }>,
): Promise<SmtpHookResult> {
  const { envelope } = event;
  const { alias, plan, mode, sendingMailboxId } = resolved;

  // Compare final destinations, including existing reverse-alias contacts.
  const mailboxRows = await opts.db
    .select({ email: mailboxes.email })
    .from(mailboxes)
    .where(eq(mailboxes.userId, user.id));
  const privateAddresses = mailboxRows.map((row) => row.email.toLowerCase());
  const mailboxKeys = new Set(privateAddresses.map(mailboxMatchKey));
  const isOwnMailbox = (addr: string) => mailboxKeys.has(mailboxMatchKey(addr));
  if (
    plan.some((entry) =>
      isOwnMailbox(entry.kind === "reply" ? entry.contact.websiteEmail : entry.address),
    )
  ) {
    submissionRcptRefusedTotal.inc({ reason: "own_mailbox" });
    return MAILBOX_LEAK;
  }

  // Daily send quota (PLAN Lane K P2), pre-enqueue and pre-write: the cap on
  // what a leaked device credential can blast through our IP. Counted per
  // recipient over a rolling 24h; a multi-recipient message is refused whole
  // rather than partially sent. 452/4.7.1 = transient, so a legitimate MUA
  // retries tomorrow instead of erroring the message out of its outbox.
  if (opts.sendQuota !== undefined) {
    const limit = dailySendLimit(user, await isPremium(user), opts.sendQuota);
    const quota = decideSendQuota(
      limit,
      await countRecentSends(opts.db, user.id, new Date()),
      plan.length,
    );
    if (!quota.allowed) {
      submissionQuotaRefusedTotal.inc();
      log.info("quota_refused", {
        from: envelope.mailFrom,
        recipients: plan.length,
        used: quota.used,
        limit: quota.limit,
      });
      return rejectWith(
        452,
        "4.7.1",
        `Daily send limit reached (${quota.limit}/day); try again later`,
      );
    }
  }

  // Pending-queue cap (queue/quota.ts), also pre-write: what this account
  // already has in flight — retrying forwards included — bounds what it may
  // add. One user per submission, so one check covers every recipient.
  if (opts.queueQuota !== undefined) {
    const usage = await pendingUsage(opts.db, user.id);
    if (decideQueueQuota(opts.queueQuota, usage)) {
      submissionQueueFullTotal.inc();
      log.info("queue_full_refused", {
        from: envelope.mailFrom,
        pendingRows: usage.rows,
        pendingBytes: usage.bytes,
      });
      return rejectWith(
        OUTBOUND_QUEUE_FULL_REPLY.code,
        OUTBOUND_QUEUE_FULL_REPLY.enhanced,
        OUTBOUND_QUEUE_FULL_REPLY.message,
      );
    }
  }

  const parsed = parseMessage(event.raw);
  if (parsed.headers.fields.length > MAX_HEADER_FIELDS) {
    return rejectWith(550, "5.6.0", "Too many header fields");
  }
  // Exactly one From (RFC 5322 §3.6.2), as the mx requires of inbound
  // mail: the rewrite replaces the first From and would leave a second
  // one standing in a message we sign as our own.
  if (parsed.headers.getFields("From").length !== 1) {
    return rejectWith(550, "5.6.0", "Message must have exactly one From header");
  }
  const aliasDomain = alias.email.slice(alias.email.indexOf("@") + 1);

  // The rewrite (with its To/Cc leak screen) runs BEFORE anything is
  // written: a refusal — envelope earlier, headers here — leaves no contact
  // and no email_log behind. The public Message-ID is therefore minted
  // independently of any log row id.
  const result = await rewriteReply(
    { headers: parsed.headers },
    {
      alias: { email: alias.email, name: alias.name },
      isOwnMailbox,
      privateAddresses,
      emailLogId: 0, // unused: generateMessageId below never embeds it
      generateMessageId: () => `<${randomUUID()}@${aliasDomain}>`,
      resolveReverseAlias: async (addr) => {
        const contact = await resolveReverseAlias(opts.db, addr);
        if (contact === null || contact.userId !== user.id || contact.aliasId !== alias.id) {
          return null;
        }
        return { websiteEmail: contact.websiteEmail, name: contact.name };
      },
      resolveOurMessageId: (originalId) => resolveOurMessageId(opts.db, user.id, originalId),
      messageIdDomain: aliasDomain,
      // Send mode keeps unknown To/Cc entries (they're the real cold
      // recipients) after screening: the user's own mailbox addresses
      // (including plus-tagged variants) refuse — never leak; other users'
      // or aliases' reverse aliases refuse — internal ra+ addresses must not
      // go out verbatim (replies to them would hard-bounce); unknown local
      // addresses refuse under the same rule as the envelope side.
      externalRecipients:
        mode !== "send"
          ? undefined
          : {
              screen: async (addr) => {
                const normalized = addr.trim().toLowerCase();
                // Non-null here means SOME reverse alias — this alias's own
                // were already translated by resolveReverseAlias above.
                if ((await resolveReverseAlias(opts.db, normalized)) !== null) {
                  return "non_reverse_alias";
                }
                if (await refusesLocalAddress(opts.db, opts.mailDomain, normalized)) {
                  return "non_reverse_alias";
                }
                return null;
              },
            },
    },
  );
  if (!result.ok) {
    submissionRcptRefusedTotal.inc({
      reason: result.refusal.reason === "mailbox_address" ? "own_mailbox" : "cross_alias",
    });
    log.info("header_refused", {
      from: alias.email,
      reason: result.refusal.reason,
      header: result.refusal.header,
      entry: result.refusal.address,
    });
    return result.refusal.reason === "mailbox_address" ? MAILBOX_LEAK : NOT_REVERSE_ALIAS;
  }

  // The whole message is accepted — NOW mint cold contacts and the per-
  // target email_logs (metadata for threading + bounce accounting).
  const scope = { userId: user.id, aliasId: alias.id };
  const targets: OutboundTarget[] = [];
  for (const entry of plan) {
    if (entry.kind === "reply") {
      targets.push({ contact: entry.contact, kind: "reply" });
      continue;
    }
    const { contact } = await findOrCreateContact(
      opts.db,
      scope,
      { address: entry.address },
      "to",
      {
        mailDomain: opts.mailDomain,
        automaticCreated: false,
      },
    );
    targets.push({ contact, kind: "cold" });
  }
  const emailLogs = [];
  for (const target of targets) {
    emailLogs.push(
      await createReplyLog(opts.db, {
        userId: user.id,
        contactId: target.contact.id,
        aliasId: alias.id,
        // Reply mode: the mailbox that actually sent (DSNs route back to
        // it); send mode has no sending mailbox — the alias's primary.
        mailboxId: sendingMailboxId ?? alias.mailboxId,
      }),
    );
  }

  // Persist the Message-ID pair so future forwards/replies can thread.
  if (!result.actions.messageIdMap.reused) {
    for (const emailLog of emailLogs) {
      await setMessageIdMap(
        opts.db,
        emailLog.id,
        result.actions.messageIdMap.original,
        result.actions.messageIdMap.ours,
      );
    }
  }

  // Resolve the required identity: custom aliases require their own key;
  // service aliases use the service key. Missing keys defer acceptance.
  const dkimKey = await selectReplyDkimKey(opts.db, alias, {
    serviceDomain: opts.mailDomain,
    serviceSelector: opts.dkimSelector,
  });
  let message: Uint8Array;
  if (dkimKey === null) {
    reportSigningFailure(new Error("Required DKIM key unavailable"));
    log.error("dkim_key_missing", { domain: aliasDomain, consequence: "acceptance deferred" });
    throw new Error("Required DKIM key unavailable");
  } else {
    const signed = await signOutbound(result.headers, parsed.body, { dkimKeys: [dkimKey] });
    message = signed.message;
  }

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const emailLog = emailLogs[i]!;
    const envelopeFrom = buildVerp({
      type: "bounce_reply",
      id: emailLog.id,
      secret: opts.verpSecret,
      domain: opts.mailDomain,
    });
    const queueId = await enqueue(opts.db, {
      raw: message,
      envelopeFrom,
      envelopeTo: target.contact.websiteEmail,
      maxRawBytes: signedMessageLimit(opts.maxMessageSize),
      userId: user.id,
      emailLogId: emailLog.id,
    });
    submissionEnqueuedTotal.inc({ mode });
    log.info("submission_queued", {
      queueId,
      kind: target.kind,
      from: alias.email,
      to: target.contact.websiteEmail,
      emailLogId: emailLog.id,
    });
  }

  return { accept: true, message: "Ok: queued" };
}

/** The shared hook set both listeners run. */
function submissionServerOptions(opts: SubmissionOptions): SmtpServerOptions {
  // One throttle shared by both listeners (587 + 465): repeated bad
  // credentials from one (address, username) get a 454 BEFORE any argon2id
  // work. The bulkhead is the other half (security review P2): the throttle
  // bounds one (address, username) pair, the bulkhead bounds the TOTAL
  // concurrent argon2id work a distributed attacker can pin the thread pool
  // with — one cheap attempt per source at a time.
  const throttle = opts.authThrottle ?? createAuthThrottle();
  const bulkhead = opts.verifyBulkhead ?? createBulkhead();
  return {
    hostname: opts.mailHostname,
    banner: "virtu submission",
    tls: opts.tls,
    maxMessageSize: opts.maxMessageSize,
    dataBudget: opts.dataBudget,
    // AUTH is refused (and unadvertised) off the TLS layer — always, not
    // only when TLS happens to be configured: a listener with no TLS then
    // has no AUTH rather than plaintext AUTH. Only the explicit dev flag
    // relaxes that, and only when there is no TLS to require.
    requireAuthTls: opts.tls !== undefined || opts.allowPlaintextAuth !== true,
    // session.tls is already true at connect time on the implicit-TLS
    // listener (byte-0 TLS), still false on the STARTTLS one — that's the
    // listener discriminator.
    onConnect: (event) => {
      smtpConnectionsTotal.inc({
        listener: event.session.tls ? "submission_tls" : "submission",
      });
      return { accept: true };
    },
    onAuth: async (event) => {
      // One shape for every auth refusal: count it and (unless told not to)
      // record it for forensics before answering.
      const refuseAuth = async (
        result: ReturnType<typeof rejectWith>,
        metric: "throttled" | "saturated" | "bad_credentials",
        record = true,
      ) => {
        submissionAuthTotal.inc({ result: metric });
        if (record) {
          await recordSmtpRejection(
            opts.db,
            {
              entrypoint: "submission",
              phase: "auth",
              remoteAddress: event.session.remoteAddress,
              heloName: event.session.heloName,
              reject: result.reject,
            },
            opts.logger ?? defaultSubmissionLogger(),
          );
        }
        return result;
      };

      // No forensics row on the saturated paths: they are globally
      // triggerable at raw connection rate with nothing (argon2, a throttle
      // key) pacing them, so a per-attempt INSERT would turn the bounded-CPU
      // defense into unbounded DB growth. The counter metric still tracks
      // them; 454 = transient, so a real client retries.
      const SATURATED = () => rejectWith(454, "4.7.0", "Server busy; try again later");

      const key = authThrottleKey(event.session.remoteAddress, event.username);
      if (throttle.isLimited(key)) {
        return refuseAuth(
          rejectWith(454, "4.7.0", "Too many failed authentication attempts; try again later"),
          "throttled",
        );
      }
      // Shed a pinned verify pool before spending ANY work on the attempt —
      // the flood case. The slot itself is claimed inside verifyCredentials
      // around just the argon2 call, so this peek admitting an attempt that
      // later loses the slot race is fine: it gets the same 454 there.
      if (bulkhead.saturated()) {
        return refuseAuth(SATURATED(), "saturated", false);
      }
      const outcome = await verifyCredentials(
        { db: opts.db, verifyBulkhead: bulkhead },
        event.username,
        event.password,
      );
      if (outcome === "saturated") {
        return refuseAuth(SATURATED(), "saturated", false);
      }
      if (outcome === "invalid") {
        throttle.recordFailure(key);
        return refuseAuth(BAD_CREDENTIALS, "bad_credentials");
      }
      throttle.clear(key);
      submissionAuthTotal.inc({ result: "ok" });
      return { accept: true };
    },
    onMailFrom: async (event) => {
      if (event.session.authUser === undefined) return AUTH_REQUIRED;
      const user = await authedUser(opts.db, event.session.authUser);
      if (user === null) return BAD_CREDENTIALS;
      const ownership = await senderOwnership(opts.db, user.id, event.address);
      if (ownership.kind === "none") {
        const result = rejectWith(553, "5.7.1", "Sender address rejected: not owned by user");
        await recordSmtpRejection(
          opts.db,
          {
            entrypoint: "submission",
            phase: "mail_from",
            remoteAddress: event.session.remoteAddress,
            heloName: event.session.heloName,
            mailFrom: event.address,
            userId: user.id,
            reject: result.reject,
          },
          opts.logger ?? defaultSubmissionLogger(),
        );
        return result;
      }
      return { accept: true };
    },
    onRcptTo: async (event) => {
      if (event.session.authUser === undefined) return AUTH_REQUIRED;
      const user = await authedUser(opts.db, event.session.authUser);
      if (user === null) return BAD_CREDENTIALS;
      // Early refusal only for what is wrong in EVERY mode: a local-domain
      // address that is neither a reverse alias nor otherwise deliverable
      // (same refusesLocalAddress rule as DATA, so the two never diverge).
      // Mode rules (reply vs cold) need MAIL FROM context and run at DATA.
      // Scope the reverse-alias lookup to the authed user so another account's
      // reverse alias can't be probed for existence here (250 vs 550).
      const address = event.address.trim().toLowerCase();
      const contact = await resolveReverseAlias(opts.db, address, user.id);
      if (contact !== null) return { accept: true };
      if (await refusesLocalAddress(opts.db, opts.mailDomain, address)) {
        await recordSmtpRejection(
          opts.db,
          {
            entrypoint: "submission",
            phase: "rcpt_to",
            remoteAddress: event.session.remoteAddress,
            heloName: event.session.heloName,
            rcptTo: event.address,
            userId: user.id,
            reject: NOT_REVERSE_ALIAS.reject,
          },
          opts.logger ?? defaultSubmissionLogger(),
        );
        return NOT_REVERSE_ALIAS;
      }
      return { accept: true };
    },
    // Every DATA-phase refusal — mode rules, leak screens, the send quota —
    // funnels through handleSubmissionData's return, so one wrapper records
    // them all with the completed envelope. (The extra user lookup runs only
    // on the reject path.)
    onData: async (event) => {
      const result = await handleSubmissionData(event, opts);
      if ("reject" in result) {
        const user = await authedUser(opts.db, event.envelope.authUser);
        await recordSmtpRejection(
          opts.db,
          {
            entrypoint: "submission",
            phase: "data",
            remoteAddress: event.session.remoteAddress,
            heloName: event.envelope.heloName,
            mailFrom: event.envelope.mailFrom,
            rcptTo: event.envelope.rcptTo.map((r) => r.address).join(", "),
            userId: user?.id,
            reject: result.reject,
          },
          opts.logger ?? defaultSubmissionLogger(),
        );
      }
      return result;
    },
  };
}

/** The two bound-together listeners (587 STARTTLS + 465 implicit TLS). */
export interface SubmissionServers {
  starttls: SmtpServer;
  /** Present only when TLS material is configured. */
  implicitTls: SmtpServer | null;
}

/** Build both servers from one options object (not yet listening). */
export function createSubmissionServers(opts: SubmissionOptions): SubmissionServers {
  // Pre-compute the dummy hash so the first AUTH miss costs one verify like
  // every later one, not hash + verify.
  void warmDummyHash();
  const base = submissionServerOptions(opts);
  return {
    starttls: createSmtpServer(base),
    implicitTls: opts.tls === undefined ? null : createSmtpServer({ ...base, implicitTls: true }),
  };
}

/** Options assembled from config + env (the real entrypoint path). */
export function submissionOptionsFromConfig(): SubmissionOptions {
  return {
    db,
    mailDomain: config.mailDomain,
    mailHostname: config.mailHostname,
    dkimSelector: config.dkimSelector,
    verpSecret: config.verpSecret,
    maxMessageSize: config.smtpMaxMessageSize,
    dataBudget: processDataBudget(config.smtpMaxDataBytesInFlight),
    tls: loadSmtpTls(config.smtpTlsCertFile, config.smtpTlsKeyFile),
    sendQuota: {
      freePerDay: config.sendQuotaFreePerDay,
      premiumPerDay: config.sendQuotaPremiumPerDay,
    },
    queueQuota: {
      maxPendingRows: config.queueMaxPendingRowsPerUser,
      maxPendingBytes: config.queueMaxPendingBytesPerUser,
    },
    allowPlaintextAuth: config.submissionAllowPlaintextAuth,
  };
}

/**
 * Start the 587 listener (and 465 when TLS is configured). In production
 * this refuses to start without TLS material — fail closed, like the secret
 * checks at boot — rather than run a listener whose AUTH cannot happen.
 */
export async function startSubmission(): Promise<SubmissionServers> {
  assertProductionSmtpTls(config);
  const servers = createSubmissionServers(submissionOptionsFromConfig());
  const bound = await servers.starttls.listen(config.submissionPort, config.smtpHost);
  defaultSubmissionLogger().info("listening", { host: bound.host, port: bound.port });
  if (servers.implicitTls !== null) {
    const tlsBound = await servers.implicitTls.listen(config.submissionTlsPort, config.smtpHost);
    defaultSubmissionLogger().info("listening_implicit_tls", {
      host: tlsBound.host,
      port: tlsBound.port,
    });
  }
  return servers;
}

if (import.meta.main) {
  void startSubmission();
}
