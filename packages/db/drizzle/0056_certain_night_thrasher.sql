ALTER TABLE "shared_source_previews" ADD COLUMN "retention_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "retention_policy_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "member_retention_version" integer DEFAULT 1 NOT NULL;