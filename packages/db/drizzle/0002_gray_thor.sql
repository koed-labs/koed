CREATE TYPE "public"."team_membership_status" AS ENUM('invited', 'enabled', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."team_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."team_workspace_access" AS ENUM('disabled', 'read', 'write');--> statement-breakpoint
CREATE TABLE "team_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "team_role" NOT NULL,
	"status" "team_membership_status" DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "team_memberships_team_user_unique" UNIQUE("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "team_workspace_access_grants" (
	"team_workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access" "team_workspace_access" DEFAULT 'disabled' NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_workspace_access_grants_team_workspace_id_user_id_pk" PRIMARY KEY("team_workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "team_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_id_team_unique" UNIQUE("id","team_id");--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_team_workspace_id_team_workspaces_id_fk" FOREIGN KEY ("team_workspace_id") REFERENCES "public"."team_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_membership_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_memberships"("team_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_memberships_user_idx" ON "team_memberships" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "team_memberships_team_idx" ON "team_memberships" USING btree ("team_id","role");--> statement-breakpoint
CREATE INDEX "team_workspace_access_grants_user_idx" ON "team_workspace_access_grants" USING btree ("user_id","access");--> statement-breakpoint
CREATE INDEX "team_workspaces_team_idx" ON "team_workspaces" USING btree ("team_id","created_at" DESC NULLS LAST) WHERE "team_workspaces"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "teams_active_idx" ON "teams" USING btree ("created_at" DESC NULLS LAST) WHERE "teams"."archived_at" is null;
