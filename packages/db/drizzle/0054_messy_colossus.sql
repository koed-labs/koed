CREATE TABLE "team_memory_destinations" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_destinations_team_workspace_id_unique" UNIQUE("team_workspace_id")
);
--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_values_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_revision_check";--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" DROP CONSTRAINT "team_memory_share_grants_version_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "retention_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "retention_policy_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "member_retention_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "retention_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "retention_policy_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "member_retention_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "retention_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "retention_policy_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "member_retention_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "source_updates_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "source_updates_stopped_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_destinations" ADD CONSTRAINT "team_memory_destinations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_destinations" ADD CONSTRAINT "team_memory_destinations_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_source_updates_stopped_by_user_id_users_id_fk" FOREIGN KEY ("source_updates_stopped_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_values_check" CHECK ("shared_memory_candidate_previews"."preview_revision" = 1
        and "shared_memory_candidate_previews"."authority_source" in ('browser_session','device_action_grant','continuous_consent')
        and "shared_memory_candidate_previews"."source_revision" >= 0
        and "shared_memory_candidate_previews"."item_count" between 1 and 100
        and "shared_memory_candidate_previews"."excluded_item_count" >= 0
        and jsonb_typeof("shared_memory_candidate_previews"."candidate_manifest") = 'array'
        and jsonb_array_length("shared_memory_candidate_previews"."candidate_manifest") = "shared_memory_candidate_previews"."item_count"
        and "shared_memory_candidate_previews"."byte_count" between 1 and 262144
        and "shared_memory_candidate_previews"."representation_policy_revision" > 0
        and "shared_memory_candidate_previews"."content_policy_version" > 0
        and "shared_memory_candidate_previews"."classifier_version" > 0
        and "shared_memory_candidate_previews"."expires_at" > "shared_memory_candidate_previews"."created_at"
        and "shared_memory_candidate_previews"."member_retention_version" > 0);--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_revision_check" CHECK ("source_owner_representation_consents"."preview_revision" > 0
        and "source_owner_representation_consents"."source_revision" >= 0
        and "source_owner_representation_consents"."fidelity_policy_revision" > 0
        and "source_owner_representation_consents"."content_policy_version" > 0
        and "source_owner_representation_consents"."classifier_version" > 0
        and "source_owner_representation_consents"."source_owner_policy_version" > 0
        and "source_owner_representation_consents"."team_policy_version" > 0
        and "source_owner_representation_consents"."workspace_policy_version" > 0
        and "source_owner_representation_consents"."member_retention_version" > 0);--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_version_check" CHECK ("team_memory_share_grants"."grant_version" > 0 and "team_memory_share_grants"."revocation_epoch" >= 0
        and "team_memory_share_grants"."member_retention_version" > 0
        and (("team_memory_share_grants"."source_updates_stopped_at" is null and "team_memory_share_grants"."source_updates_stopped_by_user_id" is null)
          or "team_memory_share_grants"."source_updates_stopped_at" is not null));