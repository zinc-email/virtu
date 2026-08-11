// Schema v1 (PLAN.md Lane 0) — THE coordination point for every lane.
// Changes here go through review; everything else is additive.
//
// Shapes follow SimpleLogin's models (tmp/simple-login/app/app/models.py),
// trimmed to what the PLAN's lanes need. Column names are camelCase in TS and
// snake_case in Postgres via the drizzle `casing: "snake_case"` option (set
// in db/index.ts and drizzle.config.ts) — never name columns explicitly.
//
// Migrations are push-based: `just db push` (drizzle-kit push).

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// drizzle-orm 0.45 has no builtin bytea; the queue stores raw message bytes.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

const id = () => integer().primaryKey().generatedAlwaysAsIdentity();

const timestamps = {
  createdAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: id(),
    email: varchar({ length: 256 }).unique().notNull(),
    name: varchar({ length: 128 }),
    // Auth is passwordless (emailed one-time codes) — there is no password
    // column. SMTP submission auths with per-device smtp_credentials.
    //
    // false = provisional: the row was created the moment this email was
    // first submitted to POST /auth/login and holds the address while the
    // code round-trips. Graduated to a full account (activated=true, trial
    // started, self-mailbox created) on the first successful /auth/verify.
    activated: boolean().default(false).notNull(),
    // An account can be disabled for harmful behavior.
    disabled: boolean().default(false).notNull(),
    // Lifetime premium (no subscription needed).
    lifetime: boolean().default(false).notNull(),
    // User can use all premium features until this date.
    trialEnd: timestamp({ withTimezone: true, mode: "date" }),
    // The mailbox used when creating a new alias. Nullable only because of the
    // users <-> mailboxes FK cycle; in practice always set after registration.
    defaultMailboxId: integer().references((): AnyPgColumn => mailboxes.id),
    // Stricter per-user spam threshold (null = server default).
    maxSpamScore: integer(),
    // Whether the user receives notification emails.
    notification: boolean().default(true).notNull(),
    // Settings (SimpleLogin GET/PATCH /setting) — values zod-validated at the
    // route layer: alias_generator word|uuid, sender_format AT|A|NAME_ONLY|
    // AT_ONLY|NO_NAME, random_alias_suffix word|random_string.
    aliasGenerator: varchar({ length: 16 }).default("word").notNull(),
    senderFormat: varchar({ length: 16 }).default("AT").notNull(),
    randomAliasSuffix: varchar({ length: 16 }).default("random_string").notNull(),
    defaultAliasDomain: varchar({ length: 128 }),
    // Bitfield for misc account flags (SimpleLogin User.flags).
    flags: bigint({ mode: "number" }).default(0).notNull(),
    // The "trash inbox": mail for a disabled ("off") alias is forwarded here
    // instead of being dropped. Null = accept-and-drop (the default).
    trashMailboxId: integer().references((): AnyPgColumn => mailboxes.id, { onDelete: "set null" }),
    ...timestamps,
    // Indexed so mailbox DELETEs (ON DELETE SET NULL back-reference) don't
    // seq-scan users to enforce the FK.
  },
  (t) => [index("users_trash_mailbox_id_idx").on(t.trashMailboxId)],
);

// One-time codes for login (which doubles as signup), sudo re-auth and
// mailbox verification, sent via transactional email (VERP type
// `transactional`).
export const verificationCodes = pgTable(
  "verification_codes",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // Set for mailbox verification; null for login and sudo codes.
    mailboxId: integer().references(() => mailboxes.id, { onDelete: "cascade" }),
    purpose: varchar({ length: 16 }).notNull(), // "login" | "sudo" | "mailbox"
    // sha256 hex of the code (codes are secrets; never store plaintext).
    codeHash: varchar({ length: 64 }).notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "date" }).notNull(),
    usedAt: timestamp({ withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [index("verification_codes_user_purpose_idx").on(t.userId, t.purpose)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // sha256 hex of the key material. The plaintext code is shown once at
    // creation and never stored (deviation from SimpleLogin, which stores
    // the code in clear).
    keyHash: varchar({ length: 64 }).unique().notNull(),
    // Device name, humanly readable ("Chrome extension") — SimpleLogin's
    // ApiKey.name, set from the `device` login parameter.
    name: varchar({ length: 128 }),
    lastUsedAt: timestamp({ withTimezone: true, mode: "date" }),
    times: integer().default(0).notNull(),
    sudoModeAt: timestamp({ withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [index("api_keys_user_id_idx").on(t.userId)],
);

// Per-device SMTP submission passwords ("app passwords"): one row per device
// ("my phone", "my laptop"), each revocable/replaceable independently of the
// others. The account itself has no password, so these are the ONLY
// credentials SMTP AUTH accepts. The plaintext is generated server-side,
// shown once at creation, and only its argon2id hash is stored.
export const smtpCredentials = pgTable(
  "smtp_credentials",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // Device name, humanly readable ("Phone", "Laptop").
    name: varchar({ length: 128 }).notNull(),
    // Bun.password argon2id encoded string (includes salt + params).
    passwordHash: text().notNull(),
    lastUsedAt: timestamp({ withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [index("smtp_credentials_user_id_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Aliases & mail routing
// ---------------------------------------------------------------------------

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    email: varchar({ length: 256 }).notNull(),
    verified: boolean().default(false).notNull(),
    // A mailbox can be disabled if it can't be reached.
    disabled: boolean().default(false).notNull(),
    // Incremented when a delivery/DNS check fails; alert past a threshold.
    nbFailedChecks: integer().default(0).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("mailboxes_user_id_email_uq").on(t.userId, t.email)],
);

// Custom domains. Winner-take-all ownership WITHOUT blocking provisional
// claims: `nameRequested` is the FQDN the user claimed (always set, not
// globally unique — many users may hold a provisional claim on the same name),
// while `name` is a GENERATED column that mirrors nameRequested ONLY once the
// per-row ownership TXT token verifies (`verifiedOwner`). The unique index on
// `name` (NULLs distinct) is the winner-take-all lock: exactly one account can
// own a given FQDN, and it's the one that proved control of DNS — unraceable,
// because the token is per-row. Every routing lookup keys on `name`, so a
// provisional claim (name = NULL) can never be selected. `name` is DB-derived
// and un-writable by app code; the app only ever writes the base flags.
//
// Capabilities are NOT columns — see pipeline/domainCapability.ts
// (canReceive = owner+mx, canSend = owner+dkim+spf). The DNS re-check writes
// only the base verified_* flags (debounced by nbFailedChecks); name and the
// capabilities derive from them.
export const domains = pgTable(
  "domains",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    // The claimed FQDN (source of truth); always present, even while unowned.
    nameRequested: varchar({ length: 128 }).notNull(),
    // The owned/live FQDN: nameRequested once ownership verifies, else NULL.
    // Generated + unique => the winner-take-all lock; routing keys on this.
    name: varchar({ length: 128 }).generatedAlwaysAs(
      sql`case when verified_owner then name_requested end`,
    ),
    // Default display name when the user replies/sends from an alias.
    fromName: varchar({ length: 128 }),
    // Base verification facts — the ONLY columns the DNS checker writes.
    verifiedOwner: boolean().default(false).notNull(), // ownership TXT token present
    verifiedMx: boolean().default(false).notNull(), // MX points at us
    verifiedDkim: boolean().default(false).notNull(),
    verifiedSpf: boolean().default(false).notNull(),
    verifiedDmarc: boolean().default(false).notNull(),
    // Random TXT value proving domain ownership (per-row → unraceable).
    ownershipTxtToken: varchar({ length: 128 }),
    // Auto-create an alias the first time it receives an email.
    catchAll: boolean().default(false).notNull(),
    nbFailedChecks: integer().default(0).notNull(),
    ...timestamps,
  },
  (t) => [
    index("domains_user_id_idx").on(t.userId),
    // One provisional claim per user per name.
    uniqueIndex("domains_user_id_name_requested_uq").on(t.userId, t.nameRequested),
    // Winner-take-all: at most one owner per FQDN (NULLs distinct, so any
    // number of provisional claims coexist).
    uniqueIndex("domains_name_uq").on(t.name),
  ],
);

export const aliases = pgTable(
  "aliases",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    email: varchar({ length: 256 }).unique().notNull(),
    // The name to use when the user replies/sends from the alias.
    name: varchar({ length: 128 }),
    enabled: boolean().default(true).notNull(),
    note: text(),
    mailboxId: integer()
      .references(() => mailboxes.id)
      .notNull(),
    domainId: integer().references(() => domains.id, { onDelete: "cascade" }),
    // Bypass the bounce auto-disable mechanism (PLAN Lane C).
    cannotBeDisabled: boolean().default(false).notNull(),
    // Created "on the fly" via the custom-domain catch-all.
    automaticCreation: boolean().default(false).notNull(),
    // Pinned aliases sort first in the dashboard (SimpleLogin Alias.pinned).
    pinned: boolean().default(false).notNull(),
    ...timestamps,
  },
  (t) => [
    index("aliases_user_id_idx").on(t.userId),
    index("aliases_mailbox_id_idx").on(t.mailboxId),
    index("aliases_domain_id_idx").on(t.domainId),
  ],
);

// Which website an alias was created for (SimpleLogin AliasUsedOn) — recorded
// from the `?hostname=` param on creation, drives options' `recommendation`.
export const aliasUsedOn = pgTable(
  "alias_used_on",
  {
    id: id(),
    aliasId: integer()
      .references(() => aliases.id, { onDelete: "cascade" })
      .notNull(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    hostname: varchar({ length: 256 }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("alias_used_on_alias_hostname_uq").on(t.aliasId, t.hostname),
    index("alias_used_on_user_hostname_idx").on(t.userId, t.hostname),
  ],
);

// Additional delivery mailboxes beyond aliases.mailbox_id (SimpleLogin
// alias_mailbox). The primary mailbox stays on the alias row.
export const aliasMailboxes = pgTable(
  "alias_mailboxes",
  {
    id: id(),
    aliasId: integer()
      .references(() => aliases.id, { onDelete: "cascade" })
      .notNull(),
    mailboxId: integer()
      .references(() => mailboxes.id, { onDelete: "cascade" })
      .notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("alias_mailboxes_alias_mailbox_uq").on(t.aliasId, t.mailboxId)],
);

// Reverse aliases: one row per (alias, outside correspondent) pair.
export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    aliasId: integer()
      .references(() => aliases.id, { onDelete: "cascade" })
      .notNull(),
    // The outside correspondent's address (SimpleLogin's website_email).
    websiteEmail: varchar({ length: 512 }).notNull(),
    // The reverse alias: replying to this address reaches websiteEmail.
    replyEmail: varchar({ length: 512 }).notNull(),
    // Display name parsed from the From header.
    name: varchar({ length: 512 }),
    // The envelope MAIL FROM observed when this contact was created (kept to
    // debug From-header parsing, like SimpleLogin's contact.mail_from).
    mailFrom: text(),
    // Emails from this contact are dropped.
    blockForward: boolean().default(false).notNull(),
    // Created automatically during the forward phase (vs. by the user).
    automaticCreated: boolean().default(false).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contacts_alias_id_website_email_uq").on(t.aliasId, t.websiteEmail),
    // UNIQUE (wave 2): reverse-alias addresses are generated with a random
    // suffix and made collision-safe by constraint-violation retry.
    uniqueIndex("contacts_reply_email_uq").on(t.replyEmail),
    index("contacts_user_id_idx").on(t.userId),
  ],
);

// Tombstones: deleted alias addresses are never reused.
export const deletedAliases = pgTable(
  "deleted_aliases",
  {
    id: id(),
    email: varchar({ length: 256 }).unique().notNull(),
    // Free-form reason ("user_deleted", "custom_domain_deleted", ...).
    reason: varchar({ length: 64 }),
    // The id the alias had before deletion (row itself is gone).
    aliasId: integer(),
    ...timestamps,
  },
  (t) => [index("deleted_aliases_alias_id_idx").on(t.aliasId)],
);

// ---------------------------------------------------------------------------
// Mail activity
// ---------------------------------------------------------------------------

export const emailLogs = pgTable(
  "email_logs",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    contactId: integer()
      .references(() => contacts.id, { onDelete: "cascade" })
      .notNull(),
    aliasId: integer().references(() => aliases.id, { onDelete: "cascade" }),
    // Forward phase: the mailbox that receives the email. Reply phase: the
    // mailbox that SENT it (DSNs route back there). SET NULL on mailbox
    // deletion: the activity/threading history (message-id maps) must
    // outlive the mailbox — cascading here would break thread
    // reconstruction for every reply ever sent from a deleted mailbox.
    mailboxId: integer().references(() => mailboxes.id, { onDelete: "set null" }),
    // On bounce, which mailbox the email bounced at.
    bouncedMailboxId: integer().references(() => mailboxes.id, { onDelete: "set null" }),
    isReply: boolean().default(false).notNull(),
    // E.g. alias disabled — the forward was blocked.
    blocked: boolean().default(false).notNull(),
    bounced: boolean().default(false).notNull(),
    // When the bounce was recorded (wave 2): the auto-disable thresholds
    // (>12/day, >10/week, 9-of-10 days — PLAN Lane C) count on this, not on
    // createdAt, so late bounces land in the right window.
    bouncedAt: timestamp({ withTimezone: true, mode: "date" }),
    autoReplied: boolean().default(false).notNull(),
    isSpam: boolean().default(false).notNull(),
    spamScore: real(),
    spamStatus: text(),
    // Original Message-ID header (truncated to 250 chars like SimpleLogin).
    messageId: varchar({ length: 1024 }),
    // Our replacement Message-ID (SimpleLogin's sl_message_id) so threading
    // survives the reply phase.
    ourMessageId: varchar({ length: 512 }),
    ...timestamps,
  },
  (t) => [
    index("email_logs_user_id_idx").on(t.userId),
    index("email_logs_contact_id_idx").on(t.contactId),
    index("email_logs_alias_id_idx").on(t.aliasId),
    index("email_logs_mailbox_id_idx").on(t.mailboxId),
    index("email_logs_created_at_idx").on(t.createdAt),
    // Bounce accounting (wave 2): count recent bounces per alias.
    index("email_logs_alias_id_bounced_at_idx").on(t.aliasId, t.bouncedAt),
  ],
);

// The delivery queue (PLAN Lane D — boring on purpose). deliverd drains it
// with SELECT ... FOR UPDATE SKIP LOCKED; the queue is the only writer of
// "sent" state.
export type OutboundStatus = "pending" | "sending" | "sent" | "failed";

export const outboundMessages = pgTable(
  "outbound_messages",
  {
    id: id(),
    // The full signed RFC 5322 message, size-capped at enqueue time.
    raw: bytea().notNull(),
    // VERP return path (or empty string for the null reverse path — never
    // bounce a bounce).
    envelopeFrom: text().notNull(),
    // One recipient per row: retries/failures are per-recipient.
    envelopeTo: text().notNull(),
    status: varchar({ length: 16 }).$type<OutboundStatus>().default("pending").notNull(),
    tries: integer().default(0).notNull(),
    nextAttemptAt: timestamp({ withTimezone: true, mode: "date" }).defaultNow().notNull(),
    lastError: text(),
    ...timestamps,
  },
  (t) => [index("outbound_messages_status_next_attempt_at_idx").on(t.status, t.nextAttemptAt)],
);

// ---------------------------------------------------------------------------
// Billing (PLAN Lane I — Stripe only, fully offloaded)
// ---------------------------------------------------------------------------

export const subscriptions = pgTable("subscriptions", {
  id: id(),
  userId: integer()
    .references(() => users.id, { onDelete: "cascade" })
    .unique()
    .notNull(),
  stripeCustomerId: text().notNull(),
  stripeSubscriptionId: text().unique().notNull(),
  // Stripe subscription status verbatim: active | trialing | past_due |
  // canceled | incomplete | incomplete_expired | unpaid | paused.
  status: varchar({ length: 32 }).notNull(),
  currentPeriodEnd: timestamp({ withTimezone: true, mode: "date" }),
  ...timestamps,
});

// ---------------------------------------------------------------------------
// Notifications & alerts
// ---------------------------------------------------------------------------

// In-app notifications (dashboard bell).
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    title: varchar({ length: 512 }),
    message: text().notNull(),
    read: boolean().default(false).notNull(),
    ...timestamps,
  },
  (t) => [index("notifications_user_id_idx").on(t.userId)],
);

// De-dupe ledger for alert emails (bounce alerts etc.) — rate controls are
// implemented by querying this table, which stops bounce storms becoming
// alert storms (SimpleLogin SentAlert).
export const sentAlerts = pgTable(
  "sent_alerts",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    toEmail: varchar({ length: 256 }).notNull(),
    alertType: varchar({ length: 256 }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("sent_alerts_user_id_idx").on(t.userId),
    index("sent_alerts_to_email_idx").on(t.toEmail),
    index("sent_alerts_alert_type_idx").on(t.alertType),
  ],
);

// ---------------------------------------------------------------------------
// DKIM (PLAN Lane C — signing keys live in Postgres, not on disk)
// ---------------------------------------------------------------------------

export const dkimKeys = pgTable(
  "dkim_keys",
  {
    id: id(),
    domain: varchar({ length: 255 }).notNull(),
    selector: varchar({ length: 63 }).default("dkim").notNull(),
    // rsa-sha256 (default) or ed25519-sha256.
    algorithm: varchar({ length: 32 }).default("rsa-sha256").notNull(),
    privateKeyPem: text().notNull(),
    // The DNS TXT p= value (base64 SubjectPublicKeyInfo), published by the
    // domain owner.
    publicKeyBase64: text().notNull(),
    active: boolean().default(true).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("dkim_keys_domain_selector_uq").on(t.domain, t.selector)],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type SmtpCredential = typeof smtpCredentials.$inferSelect;
export type Alias = typeof aliases.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type AliasUsedOn = typeof aliasUsedOn.$inferSelect;
export type AliasMailbox = typeof aliasMailboxes.$inferSelect;
export type VerificationCode = typeof verificationCodes.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type EmailLog = typeof emailLogs.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type SentAlert = typeof sentAlerts.$inferSelect;
export type DeletedAlias = typeof deletedAliases.$inferSelect;
export type DkimKey = typeof dkimKeys.$inferSelect;
