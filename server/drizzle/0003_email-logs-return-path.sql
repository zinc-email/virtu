ALTER TABLE "email_logs" ADD COLUMN "envelope_from" varchar(512);--> statement-breakpoint
ALTER TABLE "email_logs" ADD COLUMN "sender_authenticated" boolean DEFAULT false NOT NULL;