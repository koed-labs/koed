CREATE TABLE "team_session_share_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"session_id" uuid,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"granted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	"personal_deleted_at" timestamp with time zone,
	"personal_deleted_by_user_id" uuid,
	"personal_deletion_reason" text,
	"retained_by_team_at" timestamp with time zone DEFAULT now(),
	"retention_reason" text DEFAULT 'active_team_share' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_items" DROP CONSTRAINT "conversation_items_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_embeddings" DROP CONSTRAINT "memory_embeddings_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_events" DROP CONSTRAINT "memory_events_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_nodes" DROP CONSTRAINT "memory_nodes_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tool_events" DROP CONSTRAINT "tool_events_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "turns" DROP CONSTRAINT "turns_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_owner_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "audit_events_team_metadata_idx";--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "personal_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "personal_deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "personal_deletion_reason" text;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "personal_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "personal_deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "personal_deletion_reason" text;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "personal_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "personal_deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "personal_deletion_reason" text;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN "personal_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN "personal_deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN "personal_deletion_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "personal_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "personal_deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "personal_deletion_reason" text;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_session_share_grants_active_unique" ON "team_session_share_grants" USING btree ("session_id","team_workspace_id") WHERE "team_session_share_grants"."session_id" is not null and "team_session_share_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "team_session_share_grants_workspace_active_idx" ON "team_session_share_grants" USING btree ("team_workspace_id","created_at" DESC NULLS LAST) WHERE "team_session_share_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "team_session_share_grants_owner_idx" ON "team_session_share_grants" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_team_metadata_idx" ON "audit_events" USING btree (("metadata" ->> 'teamId'),"created_at" DESC NULLS LAST,"audit_sequence" DESC NULLS LAST) WHERE "audit_events"."action" like 'team.%' and "audit_events"."metadata" ? 'teamId';