CREATE TYPE "public"."shared_memory_source_kind" AS ENUM('captured_session', 'personal_note');--> statement-breakpoint
ALTER TYPE "public"."memory_question_status" ADD VALUE 'pending' BEFORE 'answered';--> statement-breakpoint
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
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_origin_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_status_check";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_identity_check";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_fidelity_check";--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ALTER COLUMN "local_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "sync_relationship_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "logical_memory_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_note_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "ask_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "ask_turn_index" integer;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "mode" "shared_memory_consent_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_session_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_note_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "mode" "shared_memory_consent_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_projection_cursors" ADD CONSTRAINT "personal_note_projection_cursors_owner_thread_fk" FOREIGN KEY ("thread_id","owner_user_id") REFERENCES "public"."collaboration_threads"("id","personal_owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_note_id_collaboration_messages_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."collaboration_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_questions_owner_ask_turn_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","ask_turn_index") WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
CREATE INDEX "memory_questions_owner_ask_recent_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "csm_pending_source_work_source_check" CHECK (("collaboration_pending_share_source_work"."source_kind" = 'captured_session'
          and "collaboration_pending_share_source_work"."local_session_id" is not null
          and "collaboration_pending_share_source_work"."local_note_id" is null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is null)
        or ("collaboration_pending_share_source_work"."source_kind" = 'personal_note'
          and "collaboration_pending_share_source_work"."local_session_id" is null
          and "collaboration_pending_share_source_work"."local_note_id" is not null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is not null));--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_ask_identity_check" CHECK (("memory_questions"."origin" = 'mcp_memory_answer' and "memory_questions"."ask_thread_id" is null and "memory_questions"."ask_turn_index" is null)
        or ("memory_questions"."origin" = 'desktop_ask' and "memory_questions"."ask_thread_id" is not null and "memory_questions"."ask_turn_index" >= 0 and "memory_questions"."team_workspace_id" is null and "memory_questions"."search_domain" = 'global'));--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_origin_check" CHECK ("memory_questions"."origin" in ('mcp_memory_answer', 'desktop_ask'));--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_status_check" CHECK (("memory_questions"."status" = 'pending' and "memory_questions"."answer_markdown" is null and "memory_questions"."error_message" is null and "memory_questions"."answered_at" is null)
        or ("memory_questions"."status" = 'answered' and "memory_questions"."answer_markdown" is not null and "memory_questions"."error_message" is null and "memory_questions"."answered_at" is not null)
        or ("memory_questions"."status" = 'error' and "memory_questions"."answer_markdown" is null and "memory_questions"."error_message" is not null and "memory_questions"."answered_at" is not null));--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_source_binding_check" CHECK (cardinality("pending_share_operations"."source_capabilities") > 0
        and "pending_share_operations"."activation_representation" = any("pending_share_operations"."source_capabilities")
        and (("pending_share_operations"."activation_representation" = 'memory_events' and "pending_share_operations"."maximum_fidelity" = 'memory_events')
          or ("pending_share_operations"."activation_representation" = 'lcm_leaves' and "pending_share_operations"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("pending_share_operations"."activation_representation" = 'lcm_rollups')
          or ("pending_share_operations"."activation_representation"::text = 'curated_assertions' and "pending_share_operations"."include_curated_memory" = true))
        and (("pending_share_operations"."source_kind" = 'captured_session'
          and "pending_share_operations"."source_session_id" is not null
          and "pending_share_operations"."source_note_id" is null
          and "pending_share_operations"."source_memory_event_id" is null)
        or ("pending_share_operations"."source_kind" = 'personal_note'
          and "pending_share_operations"."source_session_id" is null
          and "pending_share_operations"."source_note_id" is not null
          and "pending_share_operations"."source_memory_event_id" is not null
          and "pending_share_operations"."mode" = 'snapshot'
          and "pending_share_operations"."representation" = 'memory_events'
          and "pending_share_operations"."maximum_fidelity" = 'memory_events'
          and "pending_share_operations"."include_curated_memory" = false
          and "pending_share_operations"."source_revision" = 1
          and "pending_share_operations"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "pending_share_operations"."activation_representation" = 'memory_events')));--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_source_binding_check" CHECK (cardinality("shared_memory_candidate_previews"."source_capabilities") > 0
        and "shared_memory_candidate_previews"."activation_representation" = any("shared_memory_candidate_previews"."source_capabilities")
        and (("shared_memory_candidate_previews"."activation_representation" = 'memory_events' and "shared_memory_candidate_previews"."maximum_fidelity" = 'memory_events')
          or ("shared_memory_candidate_previews"."activation_representation" = 'lcm_leaves' and "shared_memory_candidate_previews"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("shared_memory_candidate_previews"."activation_representation" = 'lcm_rollups')
          or ("shared_memory_candidate_previews"."activation_representation"::text = 'curated_assertions' and "shared_memory_candidate_previews"."include_curated_memory" = true))
        and (("shared_memory_candidate_previews"."source_kind" = 'captured_session'
          and "shared_memory_candidate_previews"."source_session_id" is not null
          and "shared_memory_candidate_previews"."source_note_id" is null
          and "shared_memory_candidate_previews"."source_memory_event_id" is null)
        or ("shared_memory_candidate_previews"."source_kind" = 'personal_note'
          and "shared_memory_candidate_previews"."source_session_id" is null
          and "shared_memory_candidate_previews"."source_note_id" is not null
          and "shared_memory_candidate_previews"."source_memory_event_id" is not null
          and "shared_memory_candidate_previews"."mode" = 'snapshot'
          and "shared_memory_candidate_previews"."representation" = 'memory_events'
          and "shared_memory_candidate_previews"."maximum_fidelity" = 'memory_events'
          and "shared_memory_candidate_previews"."include_curated_memory" = false
          and "shared_memory_candidate_previews"."source_revision" = 1
          and "shared_memory_candidate_previews"."item_count" = 1
          and "shared_memory_candidate_previews"."excluded_item_count" = 0
          and "shared_memory_candidate_previews"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "shared_memory_candidate_previews"."activation_representation" = 'memory_events')));--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_source_binding_check" CHECK (cardinality("shared_source_artifacts"."source_capabilities") > 0
        and "shared_source_artifacts"."activation_representation" = any("shared_source_artifacts"."source_capabilities")
        and (("shared_source_artifacts"."activation_representation" = 'memory_events' and "shared_source_artifacts"."maximum_fidelity" = 'memory_events')
          or ("shared_source_artifacts"."activation_representation" = 'lcm_leaves' and "shared_source_artifacts"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("shared_source_artifacts"."activation_representation" = 'lcm_rollups')
          or ("shared_source_artifacts"."activation_representation"::text = 'curated_assertions' and "shared_source_artifacts"."include_curated_memory" = true))
        and (("shared_source_artifacts"."source_kind" = 'captured_session'
          and "shared_source_artifacts"."source_session_id" is not null
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
          and "shared_source_artifacts"."package_sequence" = 1
          and "shared_source_artifacts"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "shared_source_artifacts"."activation_representation" = 'memory_events')));--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_source_binding_check" CHECK (cardinality("shared_source_previews"."source_capabilities") > 0
        and "shared_source_previews"."activation_representation" = any("shared_source_previews"."source_capabilities")
        and (("shared_source_previews"."source_kind" = 'captured_session'
          and "shared_source_previews"."source_session_id" is not null
          and "shared_source_previews"."source_note_id" is null
          and "shared_source_previews"."source_memory_event_id" is null
          and "shared_source_previews"."remote_replica_id" is not null)
        or ("shared_source_previews"."source_kind" = 'personal_note'
          and "shared_source_previews"."source_session_id" is null
          and "shared_source_previews"."source_note_id" is not null
          and "shared_source_previews"."source_memory_event_id" is not null
          and "shared_source_previews"."remote_replica_id" is null
          and "shared_source_previews"."representation" = 'memory_events'
          and "shared_source_previews"."source_revision" = 1
          and "shared_source_previews"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "shared_source_previews"."activation_representation" = 'memory_events')));--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_source_binding_check" CHECK (cardinality("source_owner_representation_consents"."source_capabilities") > 0
        and "source_owner_representation_consents"."activation_representation" = any("source_owner_representation_consents"."source_capabilities")
        and (("source_owner_representation_consents"."activation_representation" = 'memory_events' and "source_owner_representation_consents"."maximum_fidelity" = 'memory_events')
          or ("source_owner_representation_consents"."activation_representation" = 'lcm_leaves' and "source_owner_representation_consents"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("source_owner_representation_consents"."activation_representation" = 'lcm_rollups')
          or ("source_owner_representation_consents"."activation_representation"::text = 'curated_assertions' and "source_owner_representation_consents"."include_curated_memory" = true))
        and (("source_owner_representation_consents"."source_kind" = 'captured_session'
          and "source_owner_representation_consents"."source_session_id" is not null
          and "source_owner_representation_consents"."source_note_id" is null
          and "source_owner_representation_consents"."source_memory_event_id" is null
          and "source_owner_representation_consents"."remote_replica_id" is not null)
        or ("source_owner_representation_consents"."source_kind" = 'personal_note'
          and "source_owner_representation_consents"."source_session_id" is null
          and "source_owner_representation_consents"."source_note_id" is not null
          and "source_owner_representation_consents"."source_memory_event_id" is not null
          and "source_owner_representation_consents"."remote_replica_id" is null
          and "source_owner_representation_consents"."mode" = 'snapshot'
          and "source_owner_representation_consents"."maximum_fidelity" = 'memory_events'
          and "source_owner_representation_consents"."include_curated_memory" = false
          and "source_owner_representation_consents"."source_revision" = 1
          and "source_owner_representation_consents"."maximum_authorized_source_revision" = 1
          and "source_owner_representation_consents"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "source_owner_representation_consents"."activation_representation" = 'memory_events')));--> statement-breakpoint
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
        and cardinality("team_session_share_grants"."source_capabilities") > 0
        and "team_session_share_grants"."activation_representation" = any("team_session_share_grants"."source_capabilities")
        and (("team_session_share_grants"."source_kind" = 'captured_session'
            and "team_session_share_grants"."session_id" is not null
            and "team_session_share_grants"."source_note_id" is null
            and "team_session_share_grants"."source_memory_event_id" is null
            and "team_session_share_grants"."remote_replica_id" is not null)
          or ("team_session_share_grants"."source_kind" = 'personal_note'
            and "team_session_share_grants"."session_id" is null
            and "team_session_share_grants"."source_note_id" is not null
            and "team_session_share_grants"."source_memory_event_id" is not null
            and "team_session_share_grants"."remote_replica_id" is null
            and "team_session_share_grants"."source_capabilities" = array['memory_events']::shared_memory_representation[]
            and "team_session_share_grants"."activation_representation" = 'memory_events')));--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_fidelity_check" CHECK ("team_session_share_grants"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups')
        and "team_session_share_grants"."include_curated_memory" is not null
        and (("team_session_share_grants"."activation_representation" = 'memory_events' and "team_session_share_grants"."maximum_fidelity" = 'memory_events')
          or ("team_session_share_grants"."activation_representation" = 'lcm_leaves' and "team_session_share_grants"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("team_session_share_grants"."activation_representation" = 'lcm_rollups')
          or ("team_session_share_grants"."activation_representation"::text = 'curated_assertions' and "team_session_share_grants"."include_curated_memory" = true))
        and "team_session_share_grants"."fidelity_policy_revision" > 0
        and "team_session_share_grants"."content_policy_version" > 0
        and "team_session_share_grants"."classifier_version" > 0
        and "team_session_share_grants"."source_revision" >= 0
        and ("team_session_share_grants"."source_kind" <> 'personal_note'
          or ("team_session_share_grants"."maximum_fidelity" = 'memory_events'
            and "team_session_share_grants"."include_curated_memory" = false
            and "team_session_share_grants"."source_revision" = 1)));