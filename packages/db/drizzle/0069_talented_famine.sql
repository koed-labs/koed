CREATE TABLE "workspace_project_share_cancellations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_team_member_id" uuid NOT NULL,
	"share_attempt_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_share_cancellations_attempt_unique" UNIQUE("team_id","owner_team_member_id","share_attempt_key")
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" DROP CONSTRAINT "personal_workspace_project_share_attempt_state_check";--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" ADD COLUMN "target_team_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" ADD COLUMN "target_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "workspace_project_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_project_share_cancellations" ADD CONSTRAINT "workspace_project_share_cancellations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_cancellations" ADD CONSTRAINT "workspace_project_share_cancellations_workspace_id_team_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."team_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_cancellations" ADD CONSTRAINT "workspace_project_share_cancellations_owner_team_member_id_team_memberships_id_fk" FOREIGN KEY ("owner_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_cancellations" ADD CONSTRAINT "workspace_project_share_cancellations_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_cancellations" ADD CONSTRAINT "workspace_project_share_cancellations_owner_team_fk" FOREIGN KEY ("team_id","owner_team_member_id") REFERENCES "public"."team_memberships"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" ADD CONSTRAINT "personal_workspace_project_share_attempt_target_pair_check" CHECK (("personal_workspace_project_share_attempts"."target_team_id" is null and "personal_workspace_project_share_attempts"."target_workspace_id" is null)
        or ("personal_workspace_project_share_attempts"."target_team_id" is not null and "personal_workspace_project_share_attempts"."target_workspace_id" is not null));--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" ADD CONSTRAINT "personal_workspace_project_share_attempt_state_check" CHECK ("personal_workspace_project_share_attempts"."state" in ('pending','confirmed','canceled'));
--> statement-breakpoint
CREATE FUNCTION workspace_project_share_cancellation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Workspace Project share cancellation receipt is immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_project_share_cancellations_immutable
  BEFORE UPDATE OR DELETE ON workspace_project_share_cancellations
  FOR EACH ROW EXECUTE FUNCTION workspace_project_share_cancellation_immutable();
