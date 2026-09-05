/**
 * The cast of the simulated internet — plain data, no behavior.
 *
 * These are the same characters as the legacy stack
 * (tmp/virtu/server/tests/Integration/Fixture/Story) and their meanings are
 * preserved. DB fixtures (users, subscriptions, aliases) are a wave-2
 * concern; a persona here describes only the network-level facts: their real
 * mailbox on the fake internet and how they hand mail to their home MTA.
 */

import { join } from "node:path";

export interface Mailbox {
  domain: string;
  localpart: string;
}

export interface SmtpEndpoint {
  host: string;
  port: number;
}

export interface Persona {
  name: string;
  /** Primary address — where this persona's real mail lands. */
  email: string;
  /** Their Maildir on the shared spool ({domain}/{localpart}). */
  mailbox: Mailbox;
  /** Their home MTA's submission endpoint. */
  submission: SmtpEndpoint;
  /** Custom domain the persona brings to virtu, if any. */
  customDomain?: string;
}

/** Root of the shared Maildir spool volume (see docker-compose.test.yml). */
export const MAILDIR_ROOT = process.env.VIRTU_TEST_MAILDIR ?? "/var/mail";

export function mailboxOf(email: string): Mailbox {
  const at = email.lastIndexOf("@");
  const localpart = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (at < 1 || !localpart || !domain) {
    throw new Error(`Not an addr-spec: ${email}`);
  }
  return { domain, localpart };
}

/** Absolute path of a persona's Maildir (contains tmp/, new/, cur/). */
export function maildirPath(who: Persona | Mailbox | string, root: string = MAILDIR_ROOT): string {
  const box = typeof who === "string" ? mailboxOf(who) : "mailbox" in who ? who.mailbox : who;
  return join(root, box.domain, box.localpart);
}

/** Where new (unseen) messages arrive, one file per message. */
export function maildirNewPath(
  who: Persona | Mailbox | string,
  root: string = MAILDIR_ROOT,
): string {
  return join(maildirPath(who, root), "new");
}

// Our own submission service (wave 2). Until our server joins the network,
// this endpoint refuses connections — by design.
const virtuSubmission: SmtpEndpoint = { host: "mail.virtu.email", port: 587 };

/**
 * Wes — paying customer. Signed up with his real qmail.com address and
 * brings his own custom domain (user.com) to virtu.
 */
export const wes: Persona = {
  name: "Wes",
  email: "wes@qmail.com",
  mailbox: mailboxOf("wes@qmail.com"),
  submission: virtuSubmission,
  customDomain: "user.com",
};

/**
 * Alec — customer used for billing-path stories (subscribes through the
 * payment gateway rather than a hand-rolled subscription row).
 */
export const alec: Persona = {
  name: "Alec",
  email: "alec@qmail.com",
  mailbox: mailboxOf("alec@qmail.com"),
  submission: virtuSubmission,
};

/**
 * Bart — customer whose account is abuse-flagged; mail he tries to move
 * through virtu must be refused.
 */
export const bart: Persona = {
  name: "Bart",
  email: "bart@qmail.com",
  mailbox: mailboxOf("bart@qmail.com"),
  submission: virtuSubmission,
};

/**
 * Milton — legitimate outside correspondent, employee of Initech
 * (SPF + DKIM + DMARC p=reject). Not a virtu user; he submits through
 * Initech's own MTA.
 */
export const milton: Persona = {
  name: "Milton",
  email: "milton@initech.com",
  mailbox: mailboxOf("milton@initech.com"),
  submission: { host: "mail.initech.com", port: 587 },
};

/**
 * Spammer — abusive sender operating from a wide-open relay
 * (SPF-fails everywhere, spoofs everyone).
 */
export const spammer: Persona = {
  name: "Spammer",
  email: "spammer@open.relay",
  mailbox: mailboxOf("spammer@open.relay"),
  submission: { host: "mail.open.relay", port: 587 },
};

export const personas = { wes, alec, bart, milton, spammer } as const;

/**
 * The open.relay peer doubles as the simulated internet's misbehaving
 * neighbor: this address is refused at RCPT with exactly `code` and
 * `enhanced` — a genuine wire reply, not a faked DSN. See
 * server/docker/test/smtpd/.../scripted-replies.pcre for the grammar. Pass a
 * unique `tag` per test (parallel-safe convention).
 */
export function scriptedReplyAddress(code: number, enhanced: string, tag: string): string {
  return `reply-${code}-${enhanced.replaceAll(".", "-")}-${tag}@open.relay`;
}
