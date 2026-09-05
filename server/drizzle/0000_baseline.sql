CREATE TABLE "alias_mailboxes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alias_mailboxes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"alias_id" integer NOT NULL,
	"mailbox_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alias_used_on" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alias_used_on_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"alias_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"hostname" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "aliases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"email" varchar(256) NOT NULL,
	"name" varchar(128),
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text,
	"mailbox_id" integer NOT NULL,
	"domain_id" integer,
	"cannot_be_disabled" boolean DEFAULT false NOT NULL,
	"automatic_creation" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aliases_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"name" varchar(128),
	"last_used_at" timestamp with time zone,
	"times" integer DEFAULT 0 NOT NULL,
	"sudo_mode_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_keyHash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "contacts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"alias_id" integer NOT NULL,
	"website_email" varchar(512) NOT NULL,
	"reply_email" varchar(512) NOT NULL,
	"name" varchar(512),
	"mail_from" text,
	"block_forward" boolean DEFAULT false NOT NULL,
	"automatic_created" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deleted_aliases" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "deleted_aliases_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(256) NOT NULL,
	"reason" varchar(64),
	"alias_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_aliases_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "destination_throttles" (
	"domain" varchar(256) PRIMARY KEY NOT NULL,
	"paused_until" timestamp with time zone,
	"strikes" integer DEFAULT 0 NOT NULL,
	"pauses" integer DEFAULT 0 NOT NULL,
	"last_code" integer,
	"last_enhanced" varchar(16),
	"last_step" varchar(16),
	"last_reply" varchar(512),
	"last_deferred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dkim_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "dkim_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"domain" varchar(255) NOT NULL,
	"selector" varchar(63) DEFAULT 'dkim' NOT NULL,
	"algorithm" varchar(32) DEFAULT 'rsa-sha256' NOT NULL,
	"private_key_pem" text NOT NULL,
	"public_key_base64" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "domains_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"name_requested" varchar(128) NOT NULL,
	"name" varchar(128) GENERATED ALWAYS AS (case when verified_owner then name_requested end) STORED,
	"from_name" varchar(128),
	"verified_owner" boolean DEFAULT false NOT NULL,
	"verified_mx" boolean DEFAULT false NOT NULL,
	"verified_dkim" boolean DEFAULT false NOT NULL,
	"verified_spf" boolean DEFAULT false NOT NULL,
	"verified_dmarc" boolean DEFAULT false NOT NULL,
	"ownership_txt_token" varchar(128),
	"catch_all" boolean DEFAULT false NOT NULL,
	"nb_failed_checks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_logs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"alias_id" integer,
	"mailbox_id" integer,
	"bounced_mailbox_id" integer,
	"is_reply" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" varchar(32),
	"bounced" boolean DEFAULT false NOT NULL,
	"bounced_at" timestamp with time zone,
	"auto_replied" boolean DEFAULT false NOT NULL,
	"is_spam" boolean DEFAULT false NOT NULL,
	"spam_score" real,
	"spam_status" text,
	"message_id" varchar(1024),
	"our_message_id" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invites_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(64) NOT NULL,
	"note" varchar(256),
	"created_by" integer,
	"used_by" integer,
	"used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mailboxes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"email" varchar(256) NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"suppressed_at" timestamp with time zone,
	"nb_failed_checks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"title" varchar(512),
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbound_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"raw" "bytea" NOT NULL,
	"envelope_from" text NOT NULL,
	"envelope_to" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"user_id" integer,
	"email_log_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sent_alerts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sent_alerts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"to_email" varchar(256) NOT NULL,
	"alert_type" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smtp_credentials" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smtp_credentials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"name" varchar(128) NOT NULL,
	"password_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smtp_rejections" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smtp_rejections_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"entrypoint" varchar(16) NOT NULL,
	"phase" varchar(16) NOT NULL,
	"remote_address" varchar(64) NOT NULL,
	"helo_name" varchar(256),
	"mail_from" text,
	"rcpt_to" text,
	"smtp_code" integer NOT NULL,
	"enhanced_code" varchar(16),
	"reason" varchar(256) NOT NULL,
	"user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subscriptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_userId_unique" UNIQUE("user_id"),
	CONSTRAINT "subscriptions_stripeSubscriptionId_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"email" varchar(256) NOT NULL,
	"name" varchar(128),
	"activated" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"lifetime" boolean DEFAULT false NOT NULL,
	"trial_end" timestamp with time zone,
	"default_mailbox_id" integer,
	"max_spam_score" integer,
	"notification" boolean DEFAULT true NOT NULL,
	"alias_generator" varchar(16) DEFAULT 'word' NOT NULL,
	"sender_format" varchar(16) DEFAULT 'AT' NOT NULL,
	"random_alias_suffix" varchar(16) DEFAULT 'random_string' NOT NULL,
	"default_alias_domain" varchar(128),
	"flags" bigint DEFAULT 0 NOT NULL,
	"max_daily_sends" integer,
	"trash_mailbox_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_codes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verification_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"mailbox_id" integer,
	"purpose" varchar(16) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alias_mailboxes" ADD CONSTRAINT "alias_mailboxes_alias_id_aliases_id_fk" FOREIGN KEY ("alias_id") REFERENCES "public"."aliases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias_mailboxes" ADD CONSTRAINT "alias_mailboxes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias_used_on" ADD CONSTRAINT "alias_used_on_alias_id_aliases_id_fk" FOREIGN KEY ("alias_id") REFERENCES "public"."aliases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alias_used_on" ADD CONSTRAINT "alias_used_on_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_alias_id_aliases_id_fk" FOREIGN KEY ("alias_id") REFERENCES "public"."aliases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_alias_id_aliases_id_fk" FOREIGN KEY ("alias_id") REFERENCES "public"."aliases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_logs" ADD CONSTRAINT "email_logs_bounced_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("bounced_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_email_log_id_email_logs_id_fk" FOREIGN KEY ("email_log_id") REFERENCES "public"."email_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_alerts" ADD CONSTRAINT "sent_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smtp_credentials" ADD CONSTRAINT "smtp_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smtp_rejections" ADD CONSTRAINT "smtp_rejections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_default_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("default_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_trash_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("trash_mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alias_mailboxes_alias_mailbox_uq" ON "alias_mailboxes" USING btree ("alias_id","mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alias_used_on_alias_hostname_uq" ON "alias_used_on" USING btree ("alias_id","hostname");--> statement-breakpoint
CREATE INDEX "alias_used_on_user_hostname_idx" ON "alias_used_on" USING btree ("user_id","hostname");--> statement-breakpoint
CREATE INDEX "aliases_user_id_idx" ON "aliases" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "aliases_mailbox_id_idx" ON "aliases" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "aliases_domain_id_idx" ON "aliases" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_alias_id_website_email_uq" ON "contacts" USING btree ("alias_id","website_email");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_reply_email_uq" ON "contacts" USING btree ("reply_email");--> statement-breakpoint
CREATE INDEX "contacts_user_id_idx" ON "contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deleted_aliases_alias_id_idx" ON "deleted_aliases" USING btree ("alias_id");--> statement-breakpoint
CREATE INDEX "destination_throttles_paused_until_idx" ON "destination_throttles" USING btree ("paused_until");--> statement-breakpoint
CREATE UNIQUE INDEX "dkim_keys_domain_selector_uq" ON "dkim_keys" USING btree ("domain","selector");--> statement-breakpoint
CREATE INDEX "domains_user_id_idx" ON "domains" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_user_id_name_requested_uq" ON "domains" USING btree ("user_id","name_requested");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_uq" ON "domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "email_logs_user_id_idx" ON "email_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_logs_contact_id_idx" ON "email_logs" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "email_logs_alias_id_idx" ON "email_logs" USING btree ("alias_id");--> statement-breakpoint
CREATE INDEX "email_logs_mailbox_id_idx" ON "email_logs" USING btree ("mailbox_id");--> statement-breakpoint
CREATE INDEX "email_logs_created_at_idx" ON "email_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_logs_alias_id_bounced_at_idx" ON "email_logs" USING btree ("alias_id","bounced_at");--> statement-breakpoint
CREATE INDEX "invites_used_by_idx" ON "invites" USING btree ("used_by");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_user_id_email_uq" ON "mailboxes" USING btree ("user_id","email");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_status_next_attempt_at_idx" ON "outbound_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_status_updated_at_idx" ON "outbound_messages" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "outbound_messages_user_id_idx" ON "outbound_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbound_messages_email_log_id_idx" ON "outbound_messages" USING btree ("email_log_id");--> statement-breakpoint
CREATE INDEX "sent_alerts_user_id_idx" ON "sent_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sent_alerts_to_email_idx" ON "sent_alerts" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "sent_alerts_alert_type_idx" ON "sent_alerts" USING btree ("alert_type");--> statement-breakpoint
CREATE INDEX "smtp_credentials_user_id_idx" ON "smtp_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "smtp_rejections_created_at_idx" ON "smtp_rejections" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "smtp_rejections_remote_address_created_at_idx" ON "smtp_rejections" USING btree ("remote_address","created_at");--> statement-breakpoint
CREATE INDEX "smtp_rejections_user_id_idx" ON "smtp_rejections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_trash_mailbox_id_idx" ON "users" USING btree ("trash_mailbox_id");--> statement-breakpoint
CREATE INDEX "verification_codes_user_purpose_idx" ON "verification_codes" USING btree ("user_id","purpose");