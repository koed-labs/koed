CREATE TABLE "team_conversation_source_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"logical_source_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"maximum_segment_index" integer,
	"maximum_source_offset" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"mutation_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"creator_authority" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	CONSTRAINT "team_conversation_source_grants_share_unique" UNIQUE("share_grant_id"),
	CONSTRAINT "team_conversation_source_grants_mutation_unique" UNIQUE("mutation_id"),
	CONSTRAINT "team_conversation_source_grants_mode_check" CHECK (("team_conversation_source_grants"."mode" = 'continuous'
          and "team_conversation_source_grants"."maximum_segment_index" is null
          and "team_conversation_source_grants"."maximum_source_offset" is null)
        or ("team_conversation_source_grants"."mode" = 'snapshot'
          and "team_conversation_source_grants"."maximum_segment_index" >= 0
          and "team_conversation_source_grants"."maximum_source_offset" >= 0)),
	CONSTRAINT "team_conversation_source_grants_lifecycle_check" CHECK (("team_conversation_source_grants"."lifecycle" = 'active'
          and "team_conversation_source_grants"."revoked_at" is null
          and "team_conversation_source_grants"."revoked_by_user_id" is null
          and "team_conversation_source_grants"."revocation_reason" is null)
        or ("team_conversation_source_grants"."lifecycle" = 'revoked'
          and "team_conversation_source_grants"."revoked_at" is not null
          and "team_conversation_source_grants"."revoked_by_user_id" is not null
          and length(trim("team_conversation_source_grants"."revocation_reason")) between 1 and 120)),
	CONSTRAINT "team_conversation_source_grants_version_check" CHECK ("team_conversation_source_grants"."version" > 0 and length(trim("team_conversation_source_grants"."creator_authority")) > 0)
);
--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_artifact_id_conversation_source_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."conversation_source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_source_scope_unique" UNIQUE("id","team_id","team_workspace_id");--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_share_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id") REFERENCES "public"."team_session_share_grants"("id","team_id","team_workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_conversation_source_grants_workspace_active_idx" ON "team_conversation_source_grants" USING btree ("team_id","team_workspace_id","updated_at" DESC NULLS LAST) WHERE "team_conversation_source_grants"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX "team_conversation_source_grants_artifact_active_idx" ON "team_conversation_source_grants" USING btree ("artifact_id","updated_at" DESC NULLS LAST) WHERE "team_conversation_source_grants"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX "team_conversation_source_grants_logical_source_active_idx" ON "team_conversation_source_grants" USING btree ("logical_source_id","updated_at" DESC NULLS LAST) WHERE "team_conversation_source_grants"."lifecycle" = 'active';
