ALTER TABLE "outbound_messages" ADD COLUMN "failure_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "failure_enhanced_code" text;--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN "dsn_queued" boolean DEFAULT false NOT NULL;
