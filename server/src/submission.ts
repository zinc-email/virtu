/**
 * submission — authenticated mail submission (PLAN Milestone 2): one options
 * object, two listeners — 587 (STARTTLS required before AUTH; the smtp
 * library enforces requireAuthTls whenever TLS is configured) and 465
 * (implicit TLS).
 *
 * AUTH: email + password against the account password OR any of the user's
 * per-device SMTP credentials (smtp_credentials — app passwords that are
 * created/revoked independently; the matched row gets last_used_at stamped).
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

import { config } from "./config.ts";
import { db } from "./db/index.ts";
import type { Db } from "./db/index.ts";
import { and, eq, inArray } from "drizzle-orm";
import {
  type Alias,
  aliases,
  type Contact,
  customDomains,
  mailboxes,
  smtpCredentials,
  type User,
  users,
} from "./db/schema.ts";
import { buildVerp, parseMessage, rewriteReply, serializeMessage } from "./mail/index.ts";
import { signOutbound } from "./mailauth/index.ts";
import { findOrCreateContact, resolveReverseAlias } from "./pipeline/contacts.ts";
import { selectReplyDkimKey } from "./pipeline/dkim.ts";
import { createReplyLog, resolveOurMessageId, setMessageIdMap } from "./pipeline/emailLog.ts";
import { senderOwnership } from "./pipeline/policy.ts";
import { loadSmtpTls } from "./pipeline/tls.ts";
import { enqueue } from "./queue/index.ts";
import {
  createSmtpServer,
  rejectWith,
  type SmtpDataEvent,
  type SmtpHookResult,
  type SmtpServer,
  type SmtpServerOptions,
  type SmtpTlsConfig,
} from "./smtp/index.ts";

/** Everything submission needs; a subset of config plus injectables. */
export interface SubmissionOptions {
  db: Db;
  mailDomain: string;
  mailHostname: string;
  dkimSelector: string;
  verpSecret: string;
  maxMessageSize: number;
  tls?: SmtpTlsConfig;
  log?: (message: string) => void;
}

/**
 * Verify (once) that credentials are usable for message submission: the
 * account password, or any of the user's per-device SMTP credentials. A
 * device-credential match stamps its last_used_at (the dashboard shows it).
 */
export async function verifyCredentials(
  opts: Pick<SubmissionOptions, "db">,
  username: string,
  password: string,
): Promise<boolean> {
  const email = username.trim().toLowerCase();
  const rows = await opts.db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (user === undefined || user.disabled) return false;

  if (await Bun.password.verify(password, user.passwordHash)) return true;

  const credentials = await opts.db
    .select()
    .from(smtpCredentials)
    .where(eq(smtpCredentials.userId, user.id));
  for (const credential of credentials) {
    if (await Bun.password.verify(password, credential.passwordHash)) {
      await opts.db
        .update(smtpCredentials)
        .set({ lastUsedAt: new Date() })
        .where(eq(smtpCredentials.id, credential.id));
      return true;
    }
  }
  return false;
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
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  if (domain !== mailDomain) {
    const domainRows = await db
      .select({ catchAll: customDomains.catchAll })
      .from(customDomains)
      .where(and(eq(customDomains.domain, domain), eq(customDomains.verified, true)))
      .limit(1);
    const custom = domainRows[0];
    if (custom === undefined) return false; // not a domain of ours
    if (custom.catchAll) return false; // the mx mints on arrival
  }
  const aliasRows = await db
    .select({ id: aliases.id })
    .from(aliases)
    .where(eq(aliases.email, normalized))
    .limit(1);
  return aliasRows[0] === undefined;
}

/** One resolved outbound recipient: the contact row that carries the metadata. */
interface OutboundTarget {
  contact: Contact;
  /** "reply" = rcpt was a reverse alias; "cold" = a real outside address. */
  kind: "reply" | "cold";
}

/**
 * Resolve the sending alias, the mode, and the outbound targets for one
 * submission. Returns a rejection when anything violates the mode rules
 * (all-or-nothing; nothing is created for cold recipients until every
 * recipient — and the alias itself — resolves cleanly).
 */
async function resolveOutbound(
  opts: SubmissionOptions,
  user: User,
  mailFrom: string,
  rcptAddresses: string[],
): Promise<
  { alias: Alias; targets: OutboundTarget[]; mode: "send" | "reply" } | { reject: SmtpHookResult }
> {
  const log = opts.log ?? ((m: string) => console.log(m));
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
        log(`submission: refused rcpt ${rcpt} for mailbox ${mailFrom}: not a reverse alias`);
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
      targets: contacts.map((contact) => ({ contact, kind: "reply" as const })),
      mode: "reply",
    };
  }

  // Send mode (MAIL FROM = the alias): reverse aliases reply; anything else
  // is a cold email, contact minted so future replies thread. Two passes so
  // refusal is all-or-nothing — nothing is created until every recipient
  // classifies cleanly (and the alias-disabled refusal fires before any
  // contact row exists).
  const alias = ownership.alias;
  if (!alias.enabled) return { reject: ALIAS_DISABLED };
  const scope = { userId: user.id, aliasId: alias.id };
  const plan: Array<{ kind: "reply"; contact: Contact } | { kind: "cold"; address: string }> = [];
  for (const rcpt of rcptAddresses) {
    const reverse = await resolveReverseAlias(opts.db, rcpt);
    if (reverse !== null) {
      if (reverse.userId !== user.id || reverse.aliasId !== alias.id) {
        log(`submission: refused rcpt ${rcpt} for ${alias.email}: another alias's reverse alias`);
        return { reject: NOT_REVERSE_ALIAS };
      }
      plan.push({ kind: "reply", contact: reverse });
      continue;
    }
    if (await refusesLocalAddress(opts.db, opts.mailDomain, rcpt)) {
      log(`submission: refused rcpt ${rcpt} for ${alias.email}: unknown local address`);
      return { reject: NOT_REVERSE_ALIAS };
    }
    plan.push({ kind: "cold", address: rcpt });
  }
  if (plan.length === 0) return { reject: NOT_REVERSE_ALIAS };

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
  return { alias, targets, mode: "send" };
}

/** Handle a completed authenticated submission. */
async function handleSubmissionData(
  event: SmtpDataEvent,
  opts: SubmissionOptions,
): Promise<SmtpHookResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { envelope } = event;

  const user = await authedUser(opts.db, envelope.authUser);
  if (user === null) return envelope.authUser === undefined ? AUTH_REQUIRED : BAD_CREDENTIALS;

  const resolved = await resolveOutbound(
    opts,
    user,
    envelope.mailFrom,
    envelope.rcptTo.map((r) => r.address),
  );
  if ("reject" in resolved) return resolved.reject;
  const { alias, targets, mode } = resolved;

  const parsed = parseMessage(event.raw);
  const emailLogs = [];
  for (const target of targets) {
    emailLogs.push(
      await createReplyLog(opts.db, {
        userId: user.id,
        contactId: target.contact.id,
        aliasId: alias.id,
        mailboxId: alias.mailboxId,
      }),
    );
  }
  const primaryLog = emailLogs[0]!;

  const aliasDomain = alias.email.slice(alias.email.indexOf("@") + 1);
  const result = await rewriteReply(
    { headers: parsed.headers },
    {
      alias: { email: alias.email, name: alias.name },
      emailLogId: primaryLog.id,
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
                const candidates = [normalized];
                const stripped = normalized.replace(/^([^@+]+)\+[^@]*(@.*)$/, "$1$2");
                if (stripped !== normalized) candidates.push(stripped);
                const rows = await opts.db
                  .select({ id: mailboxes.id })
                  .from(mailboxes)
                  .where(and(eq(mailboxes.userId, user.id), inArray(mailboxes.email, candidates)))
                  .limit(1);
                if (rows[0] !== undefined) return "mailbox_address";
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
    log(
      `submission: refused ${result.refusal.reason} from ${alias.email}: ` +
        `${result.refusal.header} entry ${result.refusal.address}`,
    );
    return result.refusal.reason === "mailbox_address" ? MAILBOX_LEAK : NOT_REVERSE_ALIAS;
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

  // Key selection: a custom-domain alias signs with its own domain's key
  // once the domain's DKIM record is verified (dkim_verified); otherwise —
  // and for service-domain aliases — the service key.
  const dkimKey = await selectReplyDkimKey(opts.db, alias, {
    serviceDomain: opts.mailDomain,
    serviceSelector: opts.dkimSelector,
  });
  let message: Uint8Array;
  if (dkimKey === null) {
    log(`submission: WARNING no active DKIM key for ${aliasDomain} — sending unsigned`);
    message = serializeMessage(result.headers, parsed.body);
  } else {
    const signed = await signOutbound(result.headers, parsed.body, { dkimKeys: [dkimKey] });
    for (const err of signed.errors) {
      log(
        `submission: DKIM signing error (${err.signingDomain}/${err.selector}): ${err.err.message}`,
      );
    }
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
      maxRawBytes: opts.maxMessageSize,
    });
    log(
      `submission: queued #${queueId} ${target.kind} from ${alias.email} -> ` +
        `${target.contact.websiteEmail} (log ${emailLog.id})`,
    );
  }

  return { accept: true, message: "Ok: queued" };
}

/** The shared hook set both listeners run. */
function submissionServerOptions(opts: SubmissionOptions): SmtpServerOptions {
  return {
    hostname: opts.mailHostname,
    banner: "virtu submission",
    tls: opts.tls,
    maxMessageSize: opts.maxMessageSize,
    // AUTH is refused (and unadvertised) before STARTTLS whenever TLS is
    // configured — the library's requireAuthTls default.
    onAuth: async (event) => {
      const ok = await verifyCredentials(opts, event.username, event.password);
      return ok ? { accept: true } : BAD_CREDENTIALS;
    },
    onMailFrom: async (event) => {
      if (event.session.authUser === undefined) return AUTH_REQUIRED;
      const user = await authedUser(opts.db, event.session.authUser);
      if (user === null) return BAD_CREDENTIALS;
      const ownership = await senderOwnership(opts.db, user.id, event.address);
      if (ownership.kind === "none") {
        return rejectWith(553, "5.7.1", "Sender address rejected: not owned by user");
      }
      return { accept: true };
    },
    onRcptTo: async (event) => {
      if (event.session.authUser === undefined) return AUTH_REQUIRED;
      // Early refusal only for what is wrong in EVERY mode: a local-domain
      // address that is neither a reverse alias nor otherwise deliverable
      // (same refusesLocalAddress rule as DATA, so the two never diverge).
      // Mode rules (reply vs cold) need MAIL FROM context and run at DATA.
      const address = event.address.trim().toLowerCase();
      const contact = await resolveReverseAlias(opts.db, address);
      if (contact !== null) return { accept: true };
      if (await refusesLocalAddress(opts.db, opts.mailDomain, address)) return NOT_REVERSE_ALIAS;
      return { accept: true };
    },
    onData: (event) => handleSubmissionData(event, opts),
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
    tls: loadSmtpTls(config.smtpTlsCertFile, config.smtpTlsKeyFile),
  };
}

/** Start the 587 listener (and 465 when TLS is configured). */
export async function startSubmission(): Promise<SubmissionServers> {
  const servers = createSubmissionServers(submissionOptionsFromConfig());
  const bound = await servers.starttls.listen(config.submissionPort, config.smtpHost);
  console.log(`submission: listening on ${bound.host}:${bound.port}`);
  if (servers.implicitTls !== null) {
    const tlsBound = await servers.implicitTls.listen(config.submissionTlsPort, config.smtpHost);
    console.log(`submission: implicit-TLS listening on ${tlsBound.host}:${tlsBound.port}`);
  }
  return servers;
}

if (import.meta.main) {
  void startSubmission();
}
