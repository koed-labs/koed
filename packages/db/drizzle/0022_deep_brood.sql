ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'team_presence_changed' BEFORE 'workspace_lifecycle_access';--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "presence_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "manual_presence_status" text DEFAULT 'available' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "presence_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "last_human_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_presence_mode_check" CHECK ("team_memberships"."presence_mode" in ('auto', 'manual'));--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_manual_presence_status_check" CHECK ("team_memberships"."manual_presence_status" in ('available', 'do_not_disturb', 'out_of_office'));--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_presence_version_check" CHECK ("team_memberships"."presence_version" > 0);