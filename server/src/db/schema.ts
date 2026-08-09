// Schema v1 (PLAN.md Lane 0) — THE coordination point for every lane.
// Changes here go through review; everything else is additive.
//
// Shapes follow SimpleLogin's models (tmp/simple-login/app/app/models.py),
// trimmed to what the PLAN's lanes need. Column names are camelCase in TS and
// snake_case in Postgres via the drizzle `casing: "snake_case"` option (set
// in db/index.ts and drizzle.config.ts) — never name columns explicitly.
//
// Migrations are push-based: `just db push` (drizzle-kit push).

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

export const users = pgTable("users", {
  id: id(),
  email: varchar({ length: 256 }).unique().notNull(),
  name: varchar({ length: 128 }),
  // Bun.password argon2id encoded string (includes salt + params).
  passwordHash: text().notNull(),
  // TODO(MVP): email verification is skipped — register activates immediately.
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
  // Bitfield for misc account flags (SimpleLogin User.flags).
  flags: bigint({ mode: "number" }).default(0).notNull(),
  ...timestamps,
});

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

export const customDomains = pgTable(
  "custom_domains",
  {
    id: id(),
    userId: integer()
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    domain: varchar({ length: 128 }).unique().notNull(),
    // Default display name when the user replies/sends from an alias.
    name: varchar({ length: 128 }),
    // MX record points at us.
    verified: boolean().default(false).notNull(),
    dkimVerified: boolean().default(false).notNull(),
    spfVerified: boolean().default(false).notNull(),
    dmarcVerified: boolean().default(false).notNull(),
    ownershipVerified: boolean().default(false).notNull(),
    // Random TXT value proving domain ownership.
    ownershipTxtToken: varchar({ length: 128 }),
    // Auto-create an alias the first time it receives an email.
    catchAll: boolean().default(false).notNull(),
    nbFailedChecks: integer().default(0).notNull(),
    ...timestamps,
  },
  (t) => [index("custom_domains_user_id_idx").on(t.userId)],
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
    customDomainId: integer().references(() => customDomains.id, { onDelete: "cascade" }),
    // Bypass the bounce auto-disable mechanism (PLAN Lane C).
    cannotBeDisabled: boolean().default(false).notNull(),
    // Created "on the fly" via the custom-domain catch-all.
    automaticCreation: boolean().default(false).notNull(),
    ...timestamps,
  },
  (t) => [
    index("aliases_user_id_idx").on(t.userId),
    index("aliases_mailbox_id_idx").on(t.mailboxId),
    index("aliases_custom_domain_id_idx").on(t.customDomainId),
  ],
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
    index("contacts_reply_email_idx").on(t.replyEmail),
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
    // mailbox that sent it.
    mailboxId: integer().references(() => mailboxes.id, { onDelete: "cascade" }),
    // On bounce, which mailbox the email bounced at.
    bouncedMailboxId: integer().references(() => mailboxes.id, { onDelete: "cascade" }),
    isReply: boolean().default(false).notNull(),
    // E.g. alias disabled — the forward was blocked.
    blocked: boolean().default(false).notNull(),
    bounced: boolean().default(false).notNull(),
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
export type Alias = typeof aliases.$inferSelect;
export type Mailbox = typeof mailboxes.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type CustomDomain = typeof customDomains.$inferSelect;
export type EmailLog = typeof emailLogs.$inferSelect;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type SentAlert = typeof sentAlerts.$inferSelect;
export type DeletedAlias = typeof deletedAliases.$inferSelect;
export type DkimKey = typeof dkimKeys.$inferSelect;
