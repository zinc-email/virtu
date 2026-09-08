-- Pre-selector device passwords hash the WHOLE password, so they can never
-- match a selector-split verify: dead rows that would otherwise sit in the
-- dashboard looking healthy and count against MAX_SMTP_CREDENTIALS. Delete
-- them all BEFORE adding the NOT NULL column (an ADD COLUMN NOT NULL with no
-- default fails on a populated table) — cleared for launch 2026-09-07: every
-- existing device password is regenerated (plans/2026-09-05-security-review.md
-- P2; each.email is the only box with real ones).
DELETE FROM "smtp_credentials";--> statement-breakpoint
ALTER TABLE "smtp_credentials" ADD COLUMN "selector" varchar(5) NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "smtp_credentials_user_id_selector_uq" ON "smtp_credentials" USING btree ("user_id","selector");
