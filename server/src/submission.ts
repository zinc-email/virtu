/**
 * submission — authenticated mail submission (PLAN Milestone 2): one options
 * object, two listeners — 587 (STARTTLS required before AUTH; the smtp
 * library enforces requireAuthTls whenever TLS is configured) and 465
 * (implicit TLS).
 *
 * Flow: AUTH (email + password against users via Bun.password.verify) →
 * MAIL FROM must be an alias or mailbox of the authed user → DATA →
 * rewriteReply (any To/Cc or envelope recipient that is not one of this
 * alias's reverse aliases → 550 5.7.1, the real recipient list is never
 * leaked) → DKIM-sign (custom-domain aliases with the domain's own key once
 * dkim_verified, else the service key — pipeline/dkim.ts selectReplyDkimKey)
 * → enqueue per recipient (envelope from = VERP bounce_reply, rcpt = the
 * contact's real address).
 */

import { config } from "./config.ts";
import { db } from "./db/index.ts";
import type { Db } from "./db/index.ts";
import { eq } from "drizzle-orm";
import { type Alias, users } from "./db/schema.ts";
import { buildVerp, parseMessage, rewriteReply, serializeMessage } from "./mail/index.ts";
import { signOutbound } from "./mailauth/index.ts";
import { resolveReverseAlias } from "./pipeline/contacts.ts";
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

/** Verify (once) that credentials are usable for message submission. */
async function verifyCredentials(
  opts: SubmissionOptions,
  username: string,
  password: string,
): Promise<boolean> {
  const email = username.trim().toLowerCase();
  const rows = await opts.db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = rows[0];
  if (user === undefined || user.disabled) return false;
  return Bun.password.verify(password, user.passwordHash);
}

const AUTH_REQUIRED = rejectWith(530, "5.7.0", "Authentication required");
const BAD_CREDENTIALS = rejectWith(535, "5.7.8", "Authentication credentials invalid");
const NOT_REVERSE_ALIAS = rejectWith(
  550,
  "5.7.1",
  "Recipient is not a reverse alias of the sending alias",
);

/** Handle a completed authenticated submission. */
async function handleSubmissionData(
  event: SmtpDataEvent,
  opts: SubmissionOptions,
): Promise<SmtpHookResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { envelope } = event;

  if (envelope.authUser === undefined) return AUTH_REQUIRED;
  const userRows = await opts.db
    .select()
    .from(users)
    .where(eq(users.email, envelope.authUser.trim().toLowerCase()))
    .limit(1);
  const user = userRows[0];
  if (user === undefined || user.disabled) return BAD_CREDENTIALS;

  // The sending identity must be one of the user's aliases (a bare mailbox
  // passes MAIL FROM ownership but cannot run the reply pipeline).
  const ownership = await senderOwnership(opts.db, user.id, envelope.mailFrom);
  if (ownership.kind !== "alias") {
    return rejectWith(550, "5.7.1", "MAIL FROM must be one of your aliases");
  }
  const alias: Alias = ownership.alias;
  if (!alias.enabled) return rejectWith(550, "5.7.1", "Alias is disabled");

  // Resolve every envelope recipient to a contact of THIS alias, all before
  // any work: refusal is all-or-nothing and never leaks a real address.
  const contacts = [];
  for (const rcpt of envelope.rcptTo) {
    const contact = await resolveReverseAlias(opts.db, rcpt.address);
    if (contact === null || contact.userId !== user.id || contact.aliasId !== alias.id) {
      log(`submission: refused rcpt ${rcpt.address} for ${alias.email}: not a reverse alias`);
      return NOT_REVERSE_ALIAS;
    }
    contacts.push(contact);
  }
  if (contacts.length === 0) return NOT_REVERSE_ALIAS;

  const parsed = parseMessage(event.raw);
  const emailLogs = [];
  for (const contact of contacts) {
    emailLogs.push(
      await createReplyLog(opts.db, {
        userId: user.id,
        contactId: contact.id,
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
    },
  );
  if (!result.ok) {
    log(
      `submission: refused reply from ${alias.email}: ${result.refusal.header} ` +
        `entry ${result.refusal.address} is not a reverse alias`,
    );
    return NOT_REVERSE_ALIAS;
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

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i]!;
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
      envelopeTo: contact.websiteEmail,
      maxRawBytes: opts.maxMessageSize,
    });
    log(
      `submission: queued #${queueId} reply from ${alias.email} -> ` +
        `${contact.replyEmail} (log ${emailLog.id})`,
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
      const userRows = await opts.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, event.session.authUser.trim().toLowerCase()))
        .limit(1);
      const userId = userRows[0]?.id;
      if (userId === undefined) return BAD_CREDENTIALS;
      const ownership = await senderOwnership(opts.db, userId, event.address);
      if (ownership.kind === "none") {
        return rejectWith(553, "5.7.1", "Sender address rejected: not owned by user");
      }
      return { accept: true };
    },
    onRcptTo: async (event) => {
      if (event.session.authUser === undefined) return AUTH_REQUIRED;
      // Early refusal for addresses that are not reverse aliases at all;
      // ownership against the sending alias is checked again at DATA.
      const contact = await resolveReverseAlias(opts.db, event.address);
      if (contact === null) return NOT_REVERSE_ALIAS;
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
