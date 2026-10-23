CREATE TABLE "share_origins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"team_backend_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"invite_id" uuid,
	"team_workspace_id" uuid,
	"team_user_id" uuid,
	"access_grant_version" integer,
	"source_invite_id" uuid,
	"origin_kind" text NOT NULL,
	"conversation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_origins_backend_check" CHECK (length(trim("share_origins"."team_backend_id")) > 0),
	CONSTRAINT "share_origins_target_shape_check" CHECK (("share_origins"."target_kind" = 'invitation' and "share_origins"."invite_id" is not null and "share_origins"."team_workspace_id" is null and "share_origins"."team_user_id" is null and "share_origins"."access_grant_version" is null and "share_origins"."source_invite_id" is null) or ("share_origins"."target_kind" = 'workspace_access' and "share_origins"."invite_id" is null and "share_origins"."team_workspace_id" is not null and "share_origins"."team_user_id" is not null and "share_origins"."access_grant_version" is not null and "share_origins"."access_grant_version" > 0)),
	CONSTRAINT "share_origins_origin_shape_check" CHECK (("share_origins"."origin_kind" = 'conversation' and "share_origins"."conversation_id" is not null) or ("share_origins"."origin_kind" in ('share_window', 'not_recorded') and "share_origins"."conversation_id" is null))
);
--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "actor_kind" text;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "access_mode" text;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "resulting_access_grant_version" integer;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD COLUMN "actor_kind" text;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD COLUMN "access_mode" text;--> statement-breakpoint
ALTER TABLE "share_origins" ADD CONSTRAINT "share_origins_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "share_origins_invitation_target_unique" ON "share_origins" USING btree ("owner_user_id","team_backend_id","invite_id") WHERE "share_origins"."target_kind" = 'invitation';--> statement-breakpoint
CREATE UNIQUE INDEX "share_origins_access_target_version_unique" ON "share_origins" USING btree ("owner_user_id","team_backend_id","team_workspace_id","team_user_id","access_grant_version") WHERE "share_origins"."target_kind" = 'workspace_access';--> statement-breakpoint
CREATE INDEX "share_origins_source_invite_idx" ON "share_origins" USING btree ("owner_user_id","team_backend_id","source_invite_id");--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_resulting_access_version_check" CHECK ("team_invites"."resulting_access_grant_version" is null or ("team_invites"."lifecycle" = 'accepted' and "team_invites"."resulting_access_grant_version" > 0));--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_origin_actor_check" CHECK (coalesce(("team_invites"."actor_kind" is null and "team_invites"."access_mode" is null) or ("team_invites"."actor_kind" = 'person' and "team_invites"."access_mode" is null) or ("team_invites"."actor_kind" = 'agent_on_behalf' and "team_invites"."access_mode" in ('ask_first', 'full_access')), false));--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_origin_actor_check" CHECK (coalesce(("team_workspace_access_grants"."actor_kind" is null and "team_workspace_access_grants"."access_mode" is null) or ("team_workspace_access_grants"."actor_kind" = 'person' and "team_workspace_access_grants"."access_mode" is null) or ("team_workspace_access_grants"."actor_kind" = 'agent_on_behalf' and "team_workspace_access_grants"."access_mode" in ('ask_first', 'full_access')), false));