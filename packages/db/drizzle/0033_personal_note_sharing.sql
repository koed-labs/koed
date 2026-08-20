CREATE TYPE "public"."shared_memory_source_kind" AS ENUM('captured_session', 'personal_note');--> statement-breakpoint
ALTER TYPE "public"."sync_source_boundary" ADD VALUE 'personal_note';--> statement-breakpoint
CREATE TABLE "personal_note_projection_cursors" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"last_thread_sequence" bigint DEFAULT 0 NOT NULL,
	"scanned_count" bigint DEFAULT 0 NOT NULL,
	"existing_count" bigint DEFAULT 0 NOT NULL,
	"created_count" bigint DEFAULT 0 NOT NULL,
	"embedding_queued_count" bigint DEFAULT 0 NOT NULL,
	"failure_count" bigint DEFAULT 0 NOT NULL,
	"last_failure_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_note_projection_cursors_thread_unique" UNIQUE("thread_id"),
	CONSTRAINT "personal_note_projection_cursors_counts_check" CHECK ("personal_note_projection_cursors"."last_thread_sequence" >= 0
        and "personal_note_projection_cursors"."scanned_count" >= 0
        and "personal_note_projection_cursors"."existing_count" >= 0
        and "personal_note_projection_cursors"."created_count" >= 0
        and "personal_note_projection_cursors"."embedding_queued_count" >= 0
        and "personal_note_projection_cursors"."failure_count" >= 0
        and "personal_note_projection_cursors"."existing_count" + "personal_note_projection_cursors"."created_count" + "personal_note_projection_cursors"."failure_count" = "personal_note_projection_cursors"."scanned_count")
);
--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_identity_check";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_representation_check";--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ALTER COLUMN "local_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "sync_relationship_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "logical_memory_id" uuid;--> statement-breakpoint
UPDATE "collaboration_pending_share_source_work"
   SET "logical_memory_id" = "local_session_id",
       "state" = CASE
         WHEN "state" IN ('pending', 'processing') THEN 'failed'
         ELSE "state"
       END,
       "redacted_failure_code" = CASE
         WHEN "state" IN ('pending', 'processing')
           THEN 'source_binding_migration_review_required'
         ELSE "redacted_failure_code"
       END,
       "locked_at" = CASE
         WHEN "state" IN ('pending', 'processing') THEN NULL
         ELSE "locked_at"
       END,
       "updated_at" = now()
 WHERE "logical_memory_id" IS NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work"
  ALTER COLUMN "logical_memory_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_note_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_owner_thread_fk" FOREIGN KEY ("thread_id","owner_user_id") REFERENCES "public"."collaboration_threads"("id","personal_owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_note_id_collaboration_messages_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."collaboration_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "csm_pending_source_work_source_check" CHECK (("collaboration_pending_share_source_work"."source_kind" = 'captured_session'
          and "collaboration_pending_share_source_work"."local_session_id" is not null
          and "collaboration_pending_share_source_work"."local_note_id" is null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is null)
        or ("collaboration_pending_share_source_work"."source_kind" = 'personal_note'
          and "collaboration_pending_share_source_work"."local_session_id" is null
          and "collaboration_pending_share_source_work"."local_note_id" is not null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is not null));--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_source_binding_check" CHECK (("pending_share_operations"."source_kind" = 'captured_session'
          and "pending_share_operations"."source_note_id" is null
          and "pending_share_operations"."source_memory_event_id" is null)
        or ("pending_share_operations"."source_kind" = 'personal_note'
          and "pending_share_operations"."source_session_id" is null
          and "pending_share_operations"."source_note_id" is not null
          and "pending_share_operations"."source_memory_event_id" is not null
          and "pending_share_operations"."mode" = 'snapshot'
          and "pending_share_operations"."representation" = 'memory_events'
          and "pending_share_operations"."allowed_representations" = array['memory_events']::shared_memory_representation[]
          and "pending_share_operations"."source_revision" = 1));--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_source_binding_check" CHECK (("shared_memory_candidate_previews"."source_kind" = 'captured_session'
          and "shared_memory_candidate_previews"."source_note_id" is null
          and "shared_memory_candidate_previews"."source_memory_event_id" is null)
        or ("shared_memory_candidate_previews"."source_kind" = 'personal_note'
          and "shared_memory_candidate_previews"."source_session_id" is null
          and "shared_memory_candidate_previews"."source_note_id" is not null
          and "shared_memory_candidate_previews"."source_memory_event_id" is not null
          and "shared_memory_candidate_previews"."mode" = 'snapshot'
          and "shared_memory_candidate_previews"."representation" = 'memory_events'
          and "shared_memory_candidate_previews"."allowed_representations" = array['memory_events']::shared_memory_representation[]
          and "shared_memory_candidate_previews"."source_revision" = 1
          and "shared_memory_candidate_previews"."item_count" = 1
          and "shared_memory_candidate_previews"."excluded_item_count" = 0));--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_source_binding_check" CHECK (("shared_source_artifacts"."source_kind" = 'captured_session'
          and "shared_source_artifacts"."source_note_id" is null
          and "shared_source_artifacts"."source_memory_event_id" is null
          and "shared_source_artifacts"."remote_replica_id" is not null
          and "shared_source_artifacts"."sync_relationship_id" is not null)
        or ("shared_source_artifacts"."source_kind" = 'personal_note'
          and "shared_source_artifacts"."source_session_id" is null
          and "shared_source_artifacts"."source_note_id" is not null
          and "shared_source_artifacts"."source_memory_event_id" is not null
          and "shared_source_artifacts"."remote_replica_id" is null
          and "shared_source_artifacts"."sync_relationship_id" is null
          and "shared_source_artifacts"."representation" = 'memory_events'
          and "shared_source_artifacts"."source_revision" = 1
          and "shared_source_artifacts"."source_cursor" = 1
          and "shared_source_artifacts"."package_sequence" = 1));--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_source_binding_check" CHECK (("shared_source_previews"."source_kind" = 'captured_session'
          and "shared_source_previews"."source_note_id" is null
          and "shared_source_previews"."source_memory_event_id" is null
          and "shared_source_previews"."remote_replica_id" is not null)
        or ("shared_source_previews"."source_kind" = 'personal_note'
          and "shared_source_previews"."source_session_id" is null
          and "shared_source_previews"."source_note_id" is not null
          and "shared_source_previews"."source_memory_event_id" is not null
          and "shared_source_previews"."remote_replica_id" is null
          and "shared_source_previews"."representation" = 'memory_events'
          and "shared_source_previews"."source_revision" = 1));--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_source_binding_check" CHECK (("source_owner_representation_consents"."source_kind" = 'captured_session'
          and "source_owner_representation_consents"."source_note_id" is null
          and "source_owner_representation_consents"."source_memory_event_id" is null
          and "source_owner_representation_consents"."remote_replica_id" is not null)
        or ("source_owner_representation_consents"."source_kind" = 'personal_note'
          and "source_owner_representation_consents"."source_session_id" is null
          and "source_owner_representation_consents"."source_note_id" is not null
          and "source_owner_representation_consents"."source_memory_event_id" is not null
          and "source_owner_representation_consents"."remote_replica_id" is null
          and "source_owner_representation_consents"."mode" = 'snapshot'
          and "source_owner_representation_consents"."selected_representation" = 'memory_events'
          and "source_owner_representation_consents"."allowed_representations" = array['memory_events']::shared_memory_representation[]
          and "source_owner_representation_consents"."source_revision" = 1
          and "source_owner_representation_consents"."maximum_authorized_source_revision" = 1));--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_source_binding_check" CHECK (("team_memory_representations"."source_kind" = 'captured_session'
          and "team_memory_representations"."source_note_id" is null
          and "team_memory_representations"."source_memory_event_id" is null)
        or ("team_memory_representations"."source_kind" = 'personal_note'
          and "team_memory_representations"."source_session_id" is null
          and "team_memory_representations"."source_note_id" is not null
          and "team_memory_representations"."source_memory_event_id" is not null
          and "team_memory_representations"."representation" = 'memory_events'
          and "team_memory_representations"."source_revision" = 1));--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_identity_check" CHECK ("team_session_share_grants"."logical_memory_id" is not null
        and "team_session_share_grants"."owner_principal_id" is not null
        and "team_session_share_grants"."consent_id" is not null
        and "team_session_share_grants"."source_owner_policy_id" is not null
        and "team_session_share_grants"."source_owner_policy_version" > 0
        and "team_session_share_grants"."team_policy_id" is not null
        and "team_session_share_grants"."team_policy_version" > 0
        and "team_session_share_grants"."workspace_policy_id" is not null
        and "team_session_share_grants"."workspace_policy_version" > 0
        and "team_session_share_grants"."creator_authority" is not null
        and length(trim("team_session_share_grants"."creator_authority")) > 0
        and (("team_session_share_grants"."source_kind" = 'captured_session'
            and "team_session_share_grants"."source_note_id" is null
            and "team_session_share_grants"."source_memory_event_id" is null
            and "team_session_share_grants"."remote_replica_id" is not null)
          or ("team_session_share_grants"."source_kind" = 'personal_note'
            and "team_session_share_grants"."session_id" is null
            and "team_session_share_grants"."source_note_id" is not null
            and "team_session_share_grants"."source_memory_event_id" is not null
            and "team_session_share_grants"."remote_replica_id" is null)));--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_representation_check" CHECK ("team_session_share_grants"."owner_allowed_representations" is not null
        and cardinality("team_session_share_grants"."owner_allowed_representations") > 0
        and "team_session_share_grants"."representation_policy_revision" > 0
        and "team_session_share_grants"."content_policy_version" > 0
        and "team_session_share_grants"."classifier_version" > 0
        and "team_session_share_grants"."source_revision" >= 0
        and ("team_session_share_grants"."source_kind" <> 'personal_note'
          or ("team_session_share_grants"."active_representation" = 'memory_events'
            and "team_session_share_grants"."owner_allowed_representations" = array['memory_events']::shared_memory_representation[]
            and "team_session_share_grants"."source_revision" = 1))
        and (
          ("team_session_share_grants"."lifecycle" = 'active'
            and "team_session_share_grants"."active_representation" is not null
            and "team_session_share_grants"."active_representation" = any("team_session_share_grants"."owner_allowed_representations"))
          or "team_session_share_grants"."lifecycle" <> 'active'
        ));
