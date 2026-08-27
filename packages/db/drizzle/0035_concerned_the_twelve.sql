DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sessions" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "logical_memories" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "collaboration_pending_share_source_work" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "pending_share_operations" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "shared_memory_candidate_previews" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "shared_source_artifacts" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "shared_source_previews" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "source_owner_representation_consents" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "team_memory_representations" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "collaboration_shared_memory_grants" LIMIT 1)
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Koed alpha data reset required before enabling generic Shared Memory sources',
      DETAIL = 'Migration 0035 replaces source identity and sharing records that cannot be inferred safely from the previous schema.',
      HINT = 'Reset the disposable alpha database and restart Koed so migrations can run from an empty baseline.';
  END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."shared_memory_source_kind" AS ENUM('captured_session', 'personal_note');--> statement-breakpoint
ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'source_revision_changed' BEFORE 'memory_event_available';--> statement-breakpoint
ALTER TYPE "public"."memory_question_status" ADD VALUE 'pending' BEFORE 'answered';--> statement-breakpoint
ALTER TYPE "public"."sync_source_boundary" ADD VALUE 'personal_note';--> statement-breakpoint
CREATE TABLE "captured_session_logical_memories" (
	"logical_memory_id" uuid PRIMARY KEY NOT NULL,
	"source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL,
	"source_session_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captured_session_logical_memories_session_unique" UNIQUE("source_session_id"),
	CONSTRAINT "captured_session_logical_memories_memory_session_unique" UNIQUE("logical_memory_id","source_session_id"),
	CONSTRAINT "captured_session_logical_memories_kind_check" CHECK ("captured_session_logical_memories"."source_kind" = 'captured_session')
);
--> statement-breakpoint
CREATE TABLE "captured_session_source_revisions" (
	"source_revision_id" uuid PRIMARY KEY NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL,
	"revision" bigint NOT NULL,
	"source_session_id" uuid NOT NULL,
	"source_cursor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "captured_session_source_revisions_memory_cursor_unique" UNIQUE("logical_memory_id","source_cursor"),
	CONSTRAINT "captured_session_source_revisions_cursor_check" CHECK ("captured_session_source_revisions"."source_kind" = 'captured_session'
        and "captured_session_source_revisions"."revision" > 0
        and "captured_session_source_revisions"."source_cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collaboration_continuous_note_advancement_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"local_owner_user_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"redacted_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_note_advancement_revision_unique" UNIQUE("enrollment_id","source_revision_id"),
	CONSTRAINT "csm_note_advancement_state_check" CHECK ("collaboration_continuous_note_advancement_work"."state" in ('pending','processing','completed','failed')
        and "collaboration_continuous_note_advancement_work"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "local_captured_session_logical_memories" (
	"logical_memory_id" uuid PRIMARY KEY NOT NULL,
	"local_session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_captured_session_logical_memories_session_unique" UNIQUE("local_session_id")
);
--> statement-breakpoint
CREATE TABLE "local_personal_note_logical_memories" (
	"logical_memory_id" uuid PRIMARY KEY NOT NULL,
	"local_note_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_personal_note_logical_memories_note_unique" UNIQUE("local_note_id")
);
--> statement-breakpoint
CREATE TABLE "local_personal_note_source_revisions" (
	"source_revision_id" uuid PRIMARY KEY NOT NULL,
	"note_revision_id" uuid NOT NULL,
	"local_note_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"local_memory_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_personal_note_source_revisions_note_revision_unique" UNIQUE("local_note_id","revision"),
	CONSTRAINT "local_personal_note_source_revisions_revision_id_unique" UNIQUE("note_revision_id"),
	CONSTRAINT "local_personal_note_source_revisions_memory_event_unique" UNIQUE("local_memory_event_id")
);
--> statement-breakpoint
CREATE TABLE "logical_memory_source_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"source_kind" "shared_memory_source_kind" NOT NULL,
	"revision" bigint NOT NULL,
	"binding_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logical_memory_source_revisions_memory_revision_unique" UNIQUE("logical_memory_id","revision"),
	CONSTRAINT "logical_memory_source_revisions_id_memory_revision_unique" UNIQUE("id","logical_memory_id","revision"),
	CONSTRAINT "logical_memory_source_revisions_id_memory_unique" UNIQUE("id","logical_memory_id"),
	CONSTRAINT "logical_memory_source_revisions_id_memory_owner_unique" UNIQUE("id","logical_memory_id","owner_principal_id"),
	CONSTRAINT "logical_memory_source_revisions_owner_revision_unique" UNIQUE("id","logical_memory_id","owner_principal_id","revision"),
	CONSTRAINT "logical_memory_source_revisions_scope_unique" UNIQUE("id","logical_memory_id","owner_principal_id","source_kind","revision"),
	CONSTRAINT "logical_memory_source_revisions_revision_hash_check" CHECK ("logical_memory_source_revisions"."revision" > 0 and length("logical_memory_source_revisions"."binding_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "personal_note_logical_memories" (
	"logical_memory_id" uuid PRIMARY KEY NOT NULL,
	"source_kind" "shared_memory_source_kind" DEFAULT 'personal_note' NOT NULL,
	"source_note_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_note_logical_memories_note_unique" UNIQUE("source_note_id"),
	CONSTRAINT "personal_note_logical_memories_memory_note_unique" UNIQUE("logical_memory_id","source_note_id"),
	CONSTRAINT "personal_note_logical_memories_kind_check" CHECK ("personal_note_logical_memories"."source_kind" = 'personal_note')
);
--> statement-breakpoint
CREATE TABLE "personal_note_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"body_marker" text DEFAULT '[koed encrypted personal note body]' NOT NULL,
	"content_hash" text NOT NULL,
	"memory_event_id" uuid,
	"projection_state" text DEFAULT 'pending' NOT NULL,
	"projection_failure_code" text,
	"projected_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_by_device_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_note_revisions_note_revision_unique" UNIQUE("note_id","revision"),
	CONSTRAINT "personal_note_revisions_note_idempotency_unique" UNIQUE("note_id","idempotency_key_hash"),
	CONSTRAINT "personal_note_revisions_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "personal_note_revisions_values_check" CHECK ("personal_note_revisions"."revision" > 0 and length("personal_note_revisions"."content_hash") = 64
        and length("personal_note_revisions"."idempotency_key_hash") = 64 and length("personal_note_revisions"."request_hash") = 64),
	CONSTRAINT "personal_note_revisions_marker_check" CHECK ("personal_note_revisions"."body_marker" = '[koed encrypted personal note body]'),
	CONSTRAINT "personal_note_revisions_projection_check" CHECK (("personal_note_revisions"."projection_state" = 'pending' and "personal_note_revisions"."memory_event_id" is null and "personal_note_revisions"."projected_at" is null and "personal_note_revisions"."projection_failure_code" is null)
        or ("personal_note_revisions"."projection_state" = 'available' and "personal_note_revisions"."memory_event_id" is not null and "personal_note_revisions"."projected_at" is not null and "personal_note_revisions"."projection_failure_code" is null)
        or ("personal_note_revisions"."projection_state" = 'failed' and "personal_note_revisions"."memory_event_id" is null and "personal_note_revisions"."projected_at" is null and length(trim("personal_note_revisions"."projection_failure_code")) > 0)
        or ("personal_note_revisions"."projection_state" = 'superseded' and "personal_note_revisions"."superseded_at" is not null
          and (("personal_note_revisions"."memory_event_id" is null and "personal_note_revisions"."projected_at" is null)
            or ("personal_note_revisions"."memory_event_id" is not null and "personal_note_revisions"."projected_at" is not null))))
);
--> statement-breakpoint
CREATE TABLE "personal_note_source_revisions" (
	"source_revision_id" uuid PRIMARY KEY NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"source_kind" "shared_memory_source_kind" DEFAULT 'personal_note' NOT NULL,
	"source_note_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"source_memory_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_note_source_revisions_note_revision_unique" UNIQUE("source_note_id","revision"),
	CONSTRAINT "personal_note_source_revisions_memory_event_unique" UNIQUE("source_memory_event_id"),
	CONSTRAINT "personal_note_source_revisions_revision_check" CHECK ("personal_note_source_revisions"."source_kind" = 'personal_note' and "personal_note_source_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"title_marker" text DEFAULT '[koed encrypted personal note title]' NOT NULL,
	"title_version" integer DEFAULT 1 NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "personal_notes_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "personal_notes_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "personal_notes_owner_idempotency_unique" UNIQUE("owner_user_id","idempotency_key_hash"),
	CONSTRAINT "personal_notes_marker_check" CHECK ("personal_notes"."title_marker" = '[koed encrypted personal note title]'),
	CONSTRAINT "personal_notes_versions_check" CHECK ("personal_notes"."title_version" > 0 and "personal_notes"."current_revision" > 0),
	CONSTRAINT "personal_notes_hashes_check" CHECK (length("personal_notes"."idempotency_key_hash") = 64 and length("personal_notes"."request_hash") = 64),
	CONSTRAINT "personal_notes_lifecycle_check" CHECK (("personal_notes"."lifecycle" = 'active' and "personal_notes"."archived_at" is null and "personal_notes"."deleted_at" is null)
        or ("personal_notes"."lifecycle" = 'archived' and "personal_notes"."archived_at" is not null and "personal_notes"."deleted_at" is null)
        or ("personal_notes"."lifecycle" = 'deleted' and "personal_notes"."deleted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "team_memory_share_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_grant_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid,
	"source_revision_id" uuid,
	"remote_replica_id" uuid,
	"owner_user_id" uuid,
	"owner_principal_id" uuid,
	"display_title" text,
	"display_title_source_revision" bigint,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"consent_id" uuid,
	"source_owner_policy_id" uuid,
	"source_owner_policy_version" integer,
	"team_policy_id" uuid,
	"team_policy_version" integer,
	"workspace_policy_id" uuid,
	"workspace_policy_version" integer,
	"source_capabilities" "shared_memory_representation"[] NOT NULL,
	"activation_representation" "shared_memory_representation" NOT NULL,
	"mode" "shared_memory_consent_mode" NOT NULL,
	"maximum_fidelity" "shared_memory_representation",
	"include_curated_memory" boolean,
	"fidelity_policy_revision" integer,
	"content_policy_version" integer,
	"classifier_version" integer,
	"source_revision" bigint,
	"grant_version" integer DEFAULT 1 NOT NULL,
	"revocation_epoch" bigint DEFAULT 0 NOT NULL,
	"lifecycle" "share_grant_lifecycle" DEFAULT 'active' NOT NULL,
	"creator_authority" text,
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
	"retention_reason" text DEFAULT 'active_team_share' NOT NULL,
	"retention_policy_id" uuid,
	"retention_policy_version" integer,
	"retention_triggered_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"active_retention_decision_id" uuid,
	"active_purge_job_id" uuid,
	"tombstoned_at" timestamp with time zone,
	"purge_completed_at" timestamp with time zone,
	CONSTRAINT "team_memory_share_grants_logical_id_unique" UNIQUE("logical_grant_id"),
	CONSTRAINT "team_memory_share_grants_scope_unique" UNIQUE("id","team_id","team_workspace_id","logical_memory_id"),
	CONSTRAINT "team_memory_share_grants_source_scope_unique" UNIQUE("id","team_id","team_workspace_id"),
	CONSTRAINT "team_memory_share_grants_identity_check" CHECK ("team_memory_share_grants"."logical_memory_id" is not null
        and "team_memory_share_grants"."owner_principal_id" is not null
        and "team_memory_share_grants"."source_revision_id" is not null
        and "team_memory_share_grants"."consent_id" is not null
        and "team_memory_share_grants"."source_owner_policy_id" is not null
        and "team_memory_share_grants"."source_owner_policy_version" > 0
        and "team_memory_share_grants"."team_policy_id" is not null
        and "team_memory_share_grants"."team_policy_version" > 0
        and "team_memory_share_grants"."workspace_policy_id" is not null
        and "team_memory_share_grants"."workspace_policy_version" > 0
        and "team_memory_share_grants"."creator_authority" is not null
        and length(trim("team_memory_share_grants"."creator_authority")) > 0
        and cardinality("team_memory_share_grants"."source_capabilities") > 0
        and "team_memory_share_grants"."activation_representation" = any("team_memory_share_grants"."source_capabilities")),
	CONSTRAINT "team_memory_share_grants_fidelity_check" CHECK ("team_memory_share_grants"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups')
        and "team_memory_share_grants"."include_curated_memory" is not null
        and (("team_memory_share_grants"."activation_representation" = 'memory_events' and "team_memory_share_grants"."maximum_fidelity" = 'memory_events')
          or ("team_memory_share_grants"."activation_representation" = 'lcm_leaves' and "team_memory_share_grants"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("team_memory_share_grants"."activation_representation" = 'lcm_rollups')
          or ("team_memory_share_grants"."activation_representation"::text = 'curated_assertions' and "team_memory_share_grants"."include_curated_memory" = true))
        and "team_memory_share_grants"."fidelity_policy_revision" > 0
        and "team_memory_share_grants"."content_policy_version" > 0
        and "team_memory_share_grants"."classifier_version" > 0
        and "team_memory_share_grants"."source_revision" >= 0),
	CONSTRAINT "team_memory_share_grants_version_check" CHECK ("team_memory_share_grants"."grant_version" > 0 and "team_memory_share_grants"."revocation_epoch" >= 0),
	CONSTRAINT "team_memory_share_grants_retention_check" CHECK (("team_memory_share_grants"."retention_policy_id" is null and "team_memory_share_grants"."retention_policy_version" is null)
        or ("team_memory_share_grants"."retention_policy_id" is not null and "team_memory_share_grants"."retention_policy_version" > 0)),
	CONSTRAINT "team_memory_share_grants_active_retention_check" CHECK ((
        "team_memory_share_grants"."active_retention_decision_id" is null
        and "team_memory_share_grants"."active_purge_job_id" is null
      ) or (
        "team_memory_share_grants"."active_retention_decision_id" is not null
        and "team_memory_share_grants"."active_purge_job_id" is not null
        and "team_memory_share_grants"."retention_policy_id" is not null
        and "team_memory_share_grants"."retention_policy_version" > 0
        and "team_memory_share_grants"."retention_triggered_at" is not null
        and "team_memory_share_grants"."retain_until" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_origin_unique";--> statement-breakpoint
ALTER TABLE "collaboration_participants" DROP CONSTRAINT "collaboration_participants_shape_check";--> statement-breakpoint
ALTER TABLE "collaboration_threads" DROP CONSTRAINT "collaboration_threads_shape_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_captured_session_source_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_origin_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_status_check";--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP CONSTRAINT "memory_replicas_captured_session_source_check";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_replacement_values_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_values_check";--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" DROP CONSTRAINT "collaboration_pending_share_source_work_local_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "collaboration_threads" DROP CONSTRAINT "collaboration_threads_share_grant_id_team_session_share_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "collaboration_threads" DROP CONSTRAINT "collaboration_threads_share_scope_fk";
--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_local_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP CONSTRAINT "memory_replicas_local_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_grant_id_team_session_share_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_replacement_preview_fk";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_preview_fk";
--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_binding_unique";--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" DROP CONSTRAINT "privacy_sanitized_source_artifacts_share_grant_id_team_session_share_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "retention_policies" DROP CONSTRAINT "retention_policies_grant_scope_fk";
--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" DROP CONSTRAINT "team_conversation_source_grants_share_scope_fk";
--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_grant_scope_fk";
--> statement-breakpoint
DROP TABLE "team_session_share_grants";--> statement-breakpoint
ALTER TABLE "collaboration_participants" DROP CONSTRAINT "collaboration_participants_thread_scope_fk";--> statement-breakpoint
DROP INDEX "collaboration_threads_notes_owner_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_participant_key_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_personal_channel_active_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_workspace_channel_active_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_companion_unique";--> statement-breakpoint
DELETE FROM "encrypted_field_payloads" payload
USING "memory_events" event
WHERE payload."source_table" = 'memory_events'
  AND payload."source_id" = event."id"
  AND event."idempotency_key" LIKE 'personal-note:%';--> statement-breakpoint
DELETE FROM "memory_events"
WHERE "idempotency_key" LIKE 'personal-note:%';--> statement-breakpoint
DELETE FROM "encrypted_field_payloads" payload
USING "collaboration_messages" message, "collaboration_threads" thread
WHERE payload."source_table" = 'collaboration_messages'
  AND payload."source_id" = message."id"
  AND message."thread_id" = thread."id"
  AND thread."kind"::text = 'notes_to_self';--> statement-breakpoint
DELETE FROM "encrypted_field_payloads" payload
USING "collaboration_threads" thread
WHERE payload."source_table" = 'collaboration_threads'
  AND payload."source_id" = thread."id"
  AND thread."kind"::text = 'notes_to_self';--> statement-breakpoint
DELETE FROM "collaboration_outbox" event
USING "collaboration_threads" thread
WHERE event."thread_id" = thread."id"
  AND thread."kind"::text = 'notes_to_self';--> statement-breakpoint
DELETE FROM "collaboration_threads"
WHERE "kind"::text = 'notes_to_self';--> statement-breakpoint
ALTER TABLE "collaboration_participants" ALTER COLUMN "thread_kind" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."collaboration_thread_kind";--> statement-breakpoint
CREATE TYPE "public"."collaboration_thread_kind" AS ENUM('personal_channel', 'workspace_channel', 'dm', 'group_dm', 'shared_session_discussion');--> statement-breakpoint
ALTER TABLE "collaboration_participants" ALTER COLUMN "thread_kind" SET DATA TYPE "public"."collaboration_thread_kind" USING "thread_kind"::"public"."collaboration_thread_kind";--> statement-breakpoint
ALTER TABLE "collaboration_threads" ALTER COLUMN "kind" SET DATA TYPE "public"."collaboration_thread_kind" USING "kind"::"public"."collaboration_thread_kind";--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_thread_scope_fk" FOREIGN KEY ("thread_id","scope","thread_kind") REFERENCES "public"."collaboration_threads"("id","scope","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_participant_key_unique" ON "collaboration_threads" USING btree ("team_id","participant_key") WHERE "collaboration_threads"."kind" in ('dm', 'group_dm');--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_personal_channel_active_unique" ON "collaboration_threads" USING btree ("personal_owner_user_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'personal_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_workspace_channel_active_unique" ON "collaboration_threads" USING btree ("team_workspace_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'workspace_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_companion_unique" ON "collaboration_threads" USING btree ("team_workspace_id","shared_logical_memory_id") WHERE "collaboration_threads"."kind" = 'shared_session_discussion';--> statement-breakpoint
DROP INDEX "logical_memories_owner_session_unique";--> statement-breakpoint
DROP INDEX "logical_memories_owner_boundary_idx";--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "sync_relationship_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "mode" "shared_memory_consent_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" ADD COLUMN "mode" "shared_memory_consent_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "logical_memory_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "source_kind" "shared_memory_source_kind" NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_source_owner_scope_unique" UNIQUE("id","source_kind","owner_principal_id");--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "ask_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "ask_turn_index" integer;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "replacement_source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "mode" "shared_memory_consent_mode" NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_capabilities" "shared_memory_representation"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "activation_representation" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_revision_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "captured_session_logical_memories" ADD CONSTRAINT "captured_session_logical_memories_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_session_logical_memories" ADD CONSTRAINT "captured_session_logical_memories_identity_fk" FOREIGN KEY ("logical_memory_id","source_kind","owner_principal_id") REFERENCES "public"."logical_memories"("id","source_kind","owner_principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_session_source_revisions" ADD CONSTRAINT "captured_session_source_revisions_source_revision_id_logical_memory_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."logical_memory_source_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_session_source_revisions" ADD CONSTRAINT "captured_session_source_revisions_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id","owner_principal_id","source_kind","revision") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id","owner_principal_id","source_kind","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_session_source_revisions" ADD CONSTRAINT "captured_session_source_revisions_source_fk" FOREIGN KEY ("logical_memory_id","source_session_id") REFERENCES "public"."captured_session_logical_memories"("logical_memory_id","source_session_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_id_owner_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_enrollments" ADD CONSTRAINT "csm_enrollments_id_owner_unique" UNIQUE("id","local_owner_user_id");--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_local_owner_user_id_users_id_fk" FOREIGN KEY ("local_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_source_revision_id_personal_note_source_revisions_source_revision_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."personal_note_source_revisions"("source_revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "csm_note_advancement_enrollment_owner_fk" FOREIGN KEY ("enrollment_id","local_owner_user_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id","local_owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_captured_session_logical_memories" ADD CONSTRAINT "local_captured_session_logical_memories_logical_memory_id_captured_session_logical_memories_logical_memory_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."captured_session_logical_memories"("logical_memory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_captured_session_logical_memories" ADD CONSTRAINT "local_captured_session_logical_memories_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_captured_session_logical_memories" ADD CONSTRAINT "local_captured_session_logical_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_captured_session_logical_memories" ADD CONSTRAINT "local_captured_session_logical_memories_session_owner_fk" FOREIGN KEY ("local_session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_logical_memories" ADD CONSTRAINT "local_personal_note_logical_memories_logical_memory_id_personal_note_logical_memories_logical_memory_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."personal_note_logical_memories"("logical_memory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_logical_memories" ADD CONSTRAINT "local_personal_note_logical_memories_local_note_id_personal_notes_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."personal_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_logical_memories" ADD CONSTRAINT "local_personal_note_logical_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_logical_memories" ADD CONSTRAINT "local_personal_note_logical_memories_note_owner_fk" FOREIGN KEY ("local_note_id","owner_user_id") REFERENCES "public"."personal_notes"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_source_revisions" ADD CONSTRAINT "local_personal_note_source_revisions_source_revision_id_personal_note_source_revisions_source_revision_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."personal_note_source_revisions"("source_revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_source_revisions" ADD CONSTRAINT "local_personal_note_source_revisions_note_revision_id_personal_note_revisions_id_fk" FOREIGN KEY ("note_revision_id") REFERENCES "public"."personal_note_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_source_revisions" ADD CONSTRAINT "local_personal_note_source_revisions_local_note_id_personal_notes_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."personal_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_source_revisions" ADD CONSTRAINT "local_personal_note_source_revisions_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_personal_note_source_revisions" ADD CONSTRAINT "local_personal_note_source_revisions_note_revision_fk" FOREIGN KEY ("local_note_id","revision") REFERENCES "public"."personal_note_revisions"("note_id","revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memory_source_revisions" ADD CONSTRAINT "logical_memory_source_revisions_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memory_source_revisions" ADD CONSTRAINT "logical_memory_source_revisions_identity_fk" FOREIGN KEY ("logical_memory_id","source_kind","owner_principal_id") REFERENCES "public"."logical_memories"("id","source_kind","owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_logical_memories" ADD CONSTRAINT "personal_note_logical_memories_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_logical_memories" ADD CONSTRAINT "personal_note_logical_memories_identity_fk" FOREIGN KEY ("logical_memory_id","source_kind","owner_principal_id") REFERENCES "public"."logical_memories"("id","source_kind","owner_principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_note_id_personal_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."personal_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_note_owner_fk" FOREIGN KEY ("note_id","owner_user_id") REFERENCES "public"."personal_notes"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_source_revisions" ADD CONSTRAINT "personal_note_source_revisions_source_revision_id_logical_memory_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."logical_memory_source_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_source_revisions" ADD CONSTRAINT "personal_note_source_revisions_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id","owner_principal_id","source_kind","revision") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id","owner_principal_id","source_kind","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_source_revisions" ADD CONSTRAINT "personal_note_source_revisions_source_fk" FOREIGN KEY ("logical_memory_id","source_note_id") REFERENCES "public"."personal_note_logical_memories"("logical_memory_id","source_note_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_notes" ADD CONSTRAINT "personal_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_remote_replica_id_memory_replicas_id_fk" FOREIGN KEY ("remote_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_personal_deleted_by_user_id_users_id_fk" FOREIGN KEY ("personal_deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_active_retention_decision_id_retention_decisions_id_fk" FOREIGN KEY ("active_retention_decision_id") REFERENCES "public"."retention_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_active_purge_job_id_purge_jobs_id_fk" FOREIGN KEY ("active_purge_job_id") REFERENCES "public"."purge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id","owner_principal_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id","owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_consent_scope_fk" FOREIGN KEY ("consent_id","logical_memory_id","remote_replica_id","owner_principal_id","team_id","team_workspace_id") REFERENCES "public"."source_owner_representation_consents"("id","logical_memory_id","remote_replica_id","source_owner_principal_id","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_owner_policy_fk" FOREIGN KEY ("source_owner_policy_id","source_owner_policy_version","logical_memory_id","owner_principal_id") REFERENCES "public"."source_owner_representation_policies"("policy_id","version","logical_memory_id","source_owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_team_policy_fk" FOREIGN KEY ("team_policy_id","team_policy_version","team_id") REFERENCES "public"."team_representation_policies"("policy_id","version","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_workspace_policy_fk" FOREIGN KEY ("workspace_policy_id","workspace_policy_version","team_id","team_workspace_id") REFERENCES "public"."workspace_representation_policies"("policy_id","version","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csm_note_advancement_claim_idx" ON "collaboration_continuous_note_advancement_work" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE INDEX "logical_memory_source_revisions_owner_idx" ON "logical_memory_source_revisions" USING btree ("owner_principal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "personal_note_revisions_memory_event_unique" ON "personal_note_revisions" USING btree ("memory_event_id") WHERE "personal_note_revisions"."memory_event_id" is not null;--> statement-breakpoint
CREATE INDEX "personal_note_revisions_owner_pending_idx" ON "personal_note_revisions" USING btree ("owner_user_id","created_at") WHERE "personal_note_revisions"."projection_state" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "personal_notes_owner_sequence_idx" ON "personal_notes" USING btree ("owner_user_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_grants_destination_unique" ON "team_memory_share_grants" USING btree ("logical_memory_id","team_workspace_id") WHERE "team_memory_share_grants"."logical_memory_id" is not null;--> statement-breakpoint
CREATE INDEX "team_memory_share_grants_workspace_active_idx" ON "team_memory_share_grants" USING btree ("team_workspace_id","created_at" DESC NULLS LAST) WHERE "team_memory_share_grants"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "team_memory_share_grants_owner_idx" ON "team_memory_share_grants" USING btree ("owner_principal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_source_revision_id_logical_memory_source_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."logical_memory_source_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "csm_pending_source_work_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_share_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","shared_logical_memory_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_binding_unique" UNIQUE("id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision_id","source_revision");--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_id_owner_user_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_source_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_replacement_preview_fk" FOREIGN KEY ("replacement_preview_id","replacement_preview_hash","replacement_preview_revision","logical_memory_id","team_id","team_workspace_id","replacement_source_revision_id","replacement_source_revision") REFERENCES "public"."shared_memory_candidate_previews"("id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision_id","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_preview_fk" FOREIGN KEY ("preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision_id","source_revision") REFERENCES "public"."shared_memory_candidate_previews"("id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision_id","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" ADD CONSTRAINT "privacy_sanitized_source_artifacts_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_grant_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_source_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id","owner_principal_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id","owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id","owner_principal_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id","owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id","source_owner_principal_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id","owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_share_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_source_revision_fk" FOREIGN KEY ("source_revision_id","logical_memory_id") REFERENCES "public"."logical_memory_source_revisions"("id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_grant_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logical_memories_owner_source_kind_idx" ON "logical_memories" USING btree ("owner_principal_id","source_kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_questions_owner_ask_turn_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","ask_turn_index") WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
CREATE INDEX "memory_questions_owner_ask_recent_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" DROP COLUMN "local_session_id";--> statement-breakpoint
ALTER TABLE "logical_memories" DROP COLUMN "source_boundary";--> statement-breakpoint
ALTER TABLE "logical_memories" DROP COLUMN "origin_source_id";--> statement-breakpoint
ALTER TABLE "logical_memories" DROP COLUMN "local_session_id";--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP COLUMN "local_session_id";--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_shape_check" CHECK ((
        "collaboration_participants"."scope" = 'team'
        and "collaboration_participants"."thread_kind" in ('dm', 'group_dm')
        and "collaboration_participants"."personal_owner_user_id" is null
        and "collaboration_participants"."team_id" is not null
        and "collaboration_participants"."ordinal" >= 0
      ));--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_shape_check" CHECK ((
        "collaboration_threads"."scope" = 'personal'
        and "collaboration_threads"."kind" = 'personal_channel'
        and "collaboration_threads"."personal_owner_user_id" is not null
        and "collaboration_threads"."team_id" is null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
        and length("collaboration_threads"."normalized_name_hash") = 64
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" = 'workspace_channel'
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is not null
        and (
          (
            "collaboration_threads"."system_key" is null
            and "collaboration_threads"."name_marker" = '[koed encrypted collaboration name]'
            and length("collaboration_threads"."normalized_name_hash") = 64
          )
          or (
            "collaboration_threads"."system_key" = 'workspace.general'
            and (
              ("collaboration_threads"."name_marker" is null and "collaboration_threads"."normalized_name_hash" is null)
              or ("collaboration_threads"."name_marker" = '[koed encrypted collaboration name]' and length("collaboration_threads"."normalized_name_hash") = 64)
            )
          )
        )
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" in ('dm', 'group_dm')
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" is null
        and "collaboration_threads"."topic_marker" is null
        and "collaboration_threads"."normalized_name_hash" is null
        and length("collaboration_threads"."participant_key") = 64
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
        "collaboration_threads"."scope" = 'team'
        and "collaboration_threads"."kind" = 'shared_session_discussion'
        and "collaboration_threads"."personal_owner_user_id" is null
        and "collaboration_threads"."team_id" is not null
        and "collaboration_threads"."team_workspace_id" is not null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" is null
        and "collaboration_threads"."topic_marker" is null
        and "collaboration_threads"."normalized_name_hash" is null
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is not null
        and "collaboration_threads"."share_grant_id" is not null
      ));--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("encrypted_field_payloads"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'collaboration_messages',
        'collaboration_threads',
        'curated_memory_assertions',
        'curated_memory_proposals',
        'curated_memory_sources',
        'curated_memory_topics',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'personal_notes',
        'personal_note_revisions',
        'memory_replica_revisions',
        'messages',
        'privacy_classification_results',
        'privacy_sanitized_source_artifacts',
        'privacy_sanitized_source_chunks',
        'shared_source_artifacts',
        'shared_source_semantic_previews',
        'shared_source_previews',
        'team_workspaces',
        'team_memory_representations',
        'tool_events'
      ));--> statement-breakpoint
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
          or ("pending_share_operations"."activation_representation"::text = 'curated_assertions' and "pending_share_operations"."include_curated_memory" = true)));--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_replacement_values_check" CHECK (("pending_share_operations"."replacement_mutation_id" is null and
             "pending_share_operations"."replacement_request_hash" is null and
             "pending_share_operations"."replacement_consent_id" is null and
             "pending_share_operations"."replacement_authority_source" is null and
             "pending_share_operations"."replacement_authority_reference_id" is null and
             "pending_share_operations"."replacement_preview_id" is null and
             "pending_share_operations"."replacement_preview_hash" is null and
             "pending_share_operations"."replacement_preview_revision" is null and
             "pending_share_operations"."replacement_representation" is null and
             "pending_share_operations"."replacement_maximum_fidelity" is null and
             "pending_share_operations"."replacement_include_curated_memory" is null and
             "pending_share_operations"."replacement_mode" is null and
             "pending_share_operations"."replacement_source_revision_id" is null and
             "pending_share_operations"."replacement_source_revision" is null and
             "pending_share_operations"."replacement_source_hash" is null and
             "pending_share_operations"."replacement_expected_grant_version" is null)
        or ("pending_share_operations"."replacement_mutation_id" is not null and
             length("pending_share_operations"."replacement_request_hash") = 64 and
             "pending_share_operations"."replacement_consent_id" is not null and
             "pending_share_operations"."replacement_authority_source" in ('browser_session','device_action_grant','continuous_consent') and
             "pending_share_operations"."replacement_authority_reference_id" is not null and
             "pending_share_operations"."replacement_preview_id" is not null and
             length("pending_share_operations"."replacement_preview_hash") = 64 and
             "pending_share_operations"."replacement_preview_revision" > 0 and
             "pending_share_operations"."replacement_representation" is not null and
             "pending_share_operations"."replacement_maximum_fidelity" is not null and
             "pending_share_operations"."replacement_include_curated_memory" is not null and
             "pending_share_operations"."replacement_mode" is not null and
             "pending_share_operations"."replacement_source_revision_id" is not null and
             "pending_share_operations"."replacement_source_revision" >= 0 and
             length("pending_share_operations"."replacement_source_hash") = 64 and
             "pending_share_operations"."replacement_expected_grant_version" > 0));--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_source_binding_check" CHECK (cardinality("shared_memory_candidate_previews"."source_capabilities") > 0
        and "shared_memory_candidate_previews"."activation_representation" = any("shared_memory_candidate_previews"."source_capabilities")
        and (("shared_memory_candidate_previews"."activation_representation" = 'memory_events' and "shared_memory_candidate_previews"."maximum_fidelity" = 'memory_events')
          or ("shared_memory_candidate_previews"."activation_representation" = 'lcm_leaves' and "shared_memory_candidate_previews"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("shared_memory_candidate_previews"."activation_representation" = 'lcm_rollups')
          or ("shared_memory_candidate_previews"."activation_representation"::text = 'curated_assertions' and "shared_memory_candidate_previews"."include_curated_memory" = true)));--> statement-breakpoint
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
        and "shared_memory_candidate_previews"."expires_at" > "shared_memory_candidate_previews"."created_at");--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_source_binding_check" CHECK (cardinality("shared_source_artifacts"."source_capabilities") > 0
        and "shared_source_artifacts"."activation_representation" = any("shared_source_artifacts"."source_capabilities")
        and (("shared_source_artifacts"."activation_representation" = 'memory_events' and "shared_source_artifacts"."maximum_fidelity" = 'memory_events')
          or ("shared_source_artifacts"."activation_representation" = 'lcm_leaves' and "shared_source_artifacts"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("shared_source_artifacts"."activation_representation" = 'lcm_rollups')
          or ("shared_source_artifacts"."activation_representation"::text = 'curated_assertions' and "shared_source_artifacts"."include_curated_memory" = true)));--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_source_binding_check" CHECK (cardinality("shared_source_previews"."source_capabilities") > 0
        and "shared_source_previews"."activation_representation" = any("shared_source_previews"."source_capabilities")
        and "shared_source_previews"."source_revision" >= 0);--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_source_binding_check" CHECK (cardinality("source_owner_representation_consents"."source_capabilities") > 0
        and "source_owner_representation_consents"."activation_representation" = any("source_owner_representation_consents"."source_capabilities")
        and (("source_owner_representation_consents"."activation_representation" = 'memory_events' and "source_owner_representation_consents"."maximum_fidelity" = 'memory_events')
          or ("source_owner_representation_consents"."activation_representation" = 'lcm_leaves' and "source_owner_representation_consents"."maximum_fidelity" in ('memory_events','lcm_leaves'))
          or ("source_owner_representation_consents"."activation_representation" = 'lcm_rollups')
          or ("source_owner_representation_consents"."activation_representation"::text = 'curated_assertions' and "source_owner_representation_consents"."include_curated_memory" = true)));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_assert_collaboration_participant_set"("target_thread_id" uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target_thread collaboration_threads%ROWTYPE;
  participant_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  distinct_ordinals integer;
  calculated_participant_key text;
BEGIN
  SELECT * INTO target_thread FROM collaboration_threads
   WHERE id = target_thread_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*)::integer, min(ordinal), max(ordinal), count(DISTINCT ordinal)::integer
    INTO participant_count, minimum_ordinal, maximum_ordinal, distinct_ordinals
    FROM collaboration_participants WHERE thread_id = target_thread_id;

  IF target_thread.kind IN ('personal_channel', 'workspace_channel', 'shared_session_discussion') THEN
    IF participant_count <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
        MESSAGE = 'Channel participant set must be implicit';
    END IF;
    RETURN;
  END IF;
  IF target_thread.kind = 'dm' AND participant_count <> 2 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Direct message participant set is invalid';
  END IF;
  IF target_thread.kind = 'group_dm' AND (participant_count < 3 OR participant_count > 40) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Group direct message participant set is invalid';
  END IF;
  IF target_thread.kind NOT IN ('dm', 'group_dm') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration thread kind has no participant invariant';
  END IF;
  IF minimum_ordinal <> 0 OR maximum_ordinal <> participant_count - 1
     OR distinct_ordinals <> participant_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration participant ordinals are invalid';
  END IF;

  SELECT encode(digest(
           E'koed:collaboration:participants:v1\n'
           || '{"teamId":"' || target_thread.team_id::text || '","userIds":['
           || string_agg('"' || participant.user_id::text || '"', ',' ORDER BY participant.user_id::text)
           || ']}', 'sha256'), 'hex')
    INTO calculated_participant_key
    FROM collaboration_participants participant WHERE participant.thread_id = target_thread_id;

  IF calculated_participant_key IS DISTINCT FROM target_thread.participant_key THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration participant identity is invalid';
  END IF;
END;
$$;--> statement-breakpoint
CREATE VIEW "logical_memory_source_revision_bindings" AS
SELECT revision.id AS source_revision_id, revision.logical_memory_id,
       revision.owner_principal_id, revision.source_kind,
       revision.revision AS generic_revision,
       captured.source_cursor AS source_revision,
       captured.source_session_id, NULL::uuid AS source_note_id,
       NULL::uuid AS source_memory_event_id
  FROM logical_memory_source_revisions revision
  JOIN captured_session_source_revisions captured ON captured.source_revision_id = revision.id
UNION ALL
SELECT revision.id AS source_revision_id, revision.logical_memory_id,
       revision.owner_principal_id, revision.source_kind,
       revision.revision AS generic_revision,
       note.revision::bigint AS source_revision,
       NULL::uuid AS source_session_id, note.source_note_id, note.source_memory_event_id
  FROM logical_memory_source_revisions revision
  JOIN personal_note_source_revisions note ON note.source_revision_id = revision.id;--> statement-breakpoint
CREATE VIEW "shared_source_artifact_records" AS
SELECT artifact.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM shared_source_artifacts artifact
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = artifact.source_revision_id;--> statement-breakpoint
CREATE VIEW "shared_source_preview_records" AS
SELECT preview.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM shared_source_previews preview
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = preview.source_revision_id;--> statement-breakpoint
CREATE VIEW "shared_memory_candidate_preview_records" AS
SELECT candidate.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM shared_memory_candidate_previews candidate
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = candidate.source_revision_id;--> statement-breakpoint
CREATE VIEW "pending_share_operation_records" AS
SELECT pending.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM pending_share_operations pending
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = pending.source_revision_id;--> statement-breakpoint
CREATE VIEW "source_owner_representation_consent_records" AS
SELECT consent.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM source_owner_representation_consents consent
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = consent.source_revision_id;--> statement-breakpoint
CREATE VIEW "team_memory_share_grant_records" AS
SELECT grant_row.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM team_memory_share_grants grant_row
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = grant_row.source_revision_id;--> statement-breakpoint
CREATE VIEW "team_memory_representation_records" AS
SELECT representation.*, binding.source_kind, binding.source_session_id,
       binding.source_note_id, binding.source_memory_event_id
  FROM team_memory_representations representation
  JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id = representation.source_revision_id;--> statement-breakpoint
CREATE OR REPLACE FUNCTION record_sync_semantic_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_row memory_events%ROWTYPE;
  change_cursor bigint;
  change_operation sync_change_operation;
  change_hash text;
BEGIN
  source_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF source_row.session_id IS NULL OR source_row.event_type <> 'captured' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  change_operation := CASE
    WHEN TG_OP = 'DELETE'
      OR source_row.invalidated_at IS NOT NULL
      OR source_row.personal_deleted_at IS NOT NULL
      THEN 'delete'::sync_change_operation
    ELSE 'upsert'::sync_change_operation
  END;
  change_hash := encode(
    digest(
      concat_ws(
        '|',
        source_row.id::text,
        change_operation::text,
        coalesce(source_row.source_event_time::text, ''),
        coalesce(source_row.source_sequence::text, ''),
        coalesce(source_row.seal_reason, ''),
        coalesce(source_row.updated_at::text, source_row.created_at::text)
      ),
      'sha256'
    ),
    'hex'
  );

  INSERT INTO sync_semantic_changes (
    session_id, memory_event_id, origin_event_id, operation, revision_hash
  ) VALUES (
    source_row.session_id,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE source_row.id END,
    source_row.id,
    change_operation,
    change_hash
  ) RETURNING cursor INTO change_cursor;

  INSERT INTO sync_outbox_entries (
    sync_relationship_id, idempotency_key, request_hash, payload_manifest
  )
  SELECT
    relationship.id,
    'changes',
    encode(
      digest(relationship.id::text || ':' || change_cursor::text, 'sha256'),
      'hex'
    ),
    jsonb_build_object('latestChangeCursor', change_cursor)
  FROM cross_identity_sync_relationships relationship
  JOIN memory_replicas replica ON replica.id = relationship.local_replica_id
  JOIN local_captured_session_logical_memories local_memory
    ON local_memory.logical_memory_id = replica.logical_memory_id
  WHERE relationship.side = 'source'
    AND relationship.revoked_at IS NULL
    AND relationship.state NOT IN ('paused', 'revoked', 'purge_pending')
    AND local_memory.local_session_id = source_row.session_id
  ON CONFLICT (sync_relationship_id, idempotency_key) DO UPDATE SET
    state = CASE
      WHEN sync_outbox_entries.state = 'processing'
        AND sync_outbox_entries.lease_expires_at > now()
        THEN sync_outbox_entries.state
      ELSE 'pending'::sync_queue_entry_state
    END,
    attempt_count = CASE
      WHEN sync_outbox_entries.state = 'processing'
        AND sync_outbox_entries.lease_expires_at > now()
        THEN sync_outbox_entries.attempt_count
      ELSE 0
    END,
    request_hash = EXCLUDED.request_hash,
    payload_manifest = EXCLUDED.payload_manifest,
    available_at = now(),
    processed_at = NULL,
    claim_token = CASE
      WHEN sync_outbox_entries.state = 'processing'
        AND sync_outbox_entries.lease_expires_at > now()
        THEN sync_outbox_entries.claim_token
      ELSE NULL
    END,
    lease_expires_at = CASE
      WHEN sync_outbox_entries.state = 'processing'
        AND sync_outbox_entries.lease_expires_at > now()
        THEN sync_outbox_entries.lease_expires_at
      ELSE NULL
    END,
    last_error_message = NULL,
    updated_at = now();

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_session_recall_ready(candidate_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
      FROM local_captured_session_logical_memories local_memory
      JOIN memory_replicas replica
        ON replica.logical_memory_id = local_memory.logical_memory_id
      JOIN cross_identity_sync_relationships relationship
        ON relationship.local_replica_id = replica.id
     WHERE local_memory.local_session_id = candidate_session_id
       AND replica.replica_role = 'target'
       AND (
         relationship.side <> 'target'
         OR relationship.state NOT IN ('ready', 'revoked')
         OR replica.freshness_status <> 'fresh'
       )
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_curated_representations_for_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH invalidated AS (
    UPDATE team_memory_representations representation
       SET state='invalidated',
           invalidated_at=coalesce(representation.invalidated_at,now()),
           invalidation_reason_code=coalesce(
             representation.invalidation_reason_code,
             'curated_evidence_ineligible'
           ),
           record_version=representation.record_version+1,
           updated_at=now()
      FROM team_memory_share_grants share_grant,
           local_captured_session_logical_memories local_source
     WHERE share_grant.id=representation.share_grant_id
       AND local_source.logical_memory_id=share_grant.logical_memory_id
       AND local_source.local_session_id=NEW.session_id
       AND representation.representation='curated_assertions'
       AND representation.state IN ('pending','available','stale')
     RETURNING representation.id
  )
  DELETE FROM team_memory_semantic_items semantic_item
   USING invalidated
   WHERE semantic_item.representation_id=invalidated.id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_curated_representations_for_assertion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH affected_sessions AS (
    SELECT item.session_id
      FROM curated_memory_sources source
      JOIN conversation_items item ON item.id=source.conversation_item_id
     WHERE source.assertion_id=NEW.id
    UNION
    SELECT event.session_id
      FROM curated_memory_sources source
      JOIN memory_events event ON event.id=source.memory_event_id
     WHERE source.assertion_id=NEW.id
    UNION
    SELECT node.session_id
      FROM curated_memory_sources source
      JOIN memory_nodes node ON node.id=source.lcm_node_id
     WHERE source.assertion_id=NEW.id
  ), invalidated AS (
    UPDATE team_memory_representations representation
       SET state='invalidated',
           invalidated_at=coalesce(representation.invalidated_at,now()),
           invalidation_reason_code=coalesce(
             representation.invalidation_reason_code,
             'curated_assertion_changed'
           ),
           record_version=representation.record_version+1,
           updated_at=now()
      FROM team_memory_share_grants share_grant,
           local_captured_session_logical_memories local_source
     WHERE share_grant.id=representation.share_grant_id
       AND local_source.logical_memory_id=share_grant.logical_memory_id
       AND local_source.local_session_id IN (
         SELECT session_id FROM affected_sessions WHERE session_id IS NOT NULL
       )
       AND representation.representation='curated_assertions'
       AND representation.state IN ('pending','available','stale')
     RETURNING representation.id
  )
  DELETE FROM team_memory_semantic_items semantic_item
   USING invalidated
   WHERE semantic_item.representation_id=invalidated.id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_assert_logical_memory_source_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
  target_kind shared_memory_source_kind;
  binding_count integer;
BEGIN
  IF TG_TABLE_NAME = 'logical_memories' THEN
    target_id := coalesce(NEW.id, OLD.id);
  ELSE
    target_id := coalesce(NEW.logical_memory_id, OLD.logical_memory_id);
  END IF;
  SELECT source_kind INTO target_kind FROM logical_memories WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT CASE target_kind
    WHEN 'captured_session' THEN
      (SELECT count(*) FROM captured_session_logical_memories WHERE logical_memory_id = target_id)
    WHEN 'personal_note' THEN
      (SELECT count(*) FROM personal_note_logical_memories WHERE logical_memory_id = target_id)
  END INTO binding_count;

  IF binding_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'logical_memory_source_binding_check',
      MESSAGE = 'Logical Memory must have exactly one matching source binding';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "logical_memories_source_binding_check"
AFTER INSERT OR UPDATE ON logical_memories DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_logical_memory_source_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "captured_session_logical_memories_source_binding_check"
AFTER INSERT OR UPDATE OR DELETE ON captured_session_logical_memories DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_logical_memory_source_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "personal_note_logical_memories_source_binding_check"
AFTER INSERT OR UPDATE OR DELETE ON personal_note_logical_memories DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_logical_memory_source_binding();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_assert_logical_memory_revision_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_id uuid;
  target_kind shared_memory_source_kind;
  binding_count integer;
BEGIN
  IF TG_TABLE_NAME = 'logical_memory_source_revisions' THEN
    target_id := coalesce(NEW.id, OLD.id);
  ELSE
    target_id := coalesce(NEW.source_revision_id, OLD.source_revision_id);
  END IF;
  SELECT source_kind INTO target_kind FROM logical_memory_source_revisions WHERE id = target_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT CASE target_kind
    WHEN 'captured_session' THEN
      (SELECT count(*) FROM captured_session_source_revisions WHERE source_revision_id = target_id)
    WHEN 'personal_note' THEN
      (SELECT count(*) FROM personal_note_source_revisions WHERE source_revision_id = target_id)
  END INTO binding_count;

  IF binding_count <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'logical_memory_revision_binding_check',
      MESSAGE = 'Logical Memory source revision must have exactly one matching source binding';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "logical_memory_source_revisions_binding_check"
AFTER INSERT OR UPDATE ON logical_memory_source_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_logical_memory_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "captured_session_source_revisions_binding_check"
AFTER INSERT OR UPDATE OR DELETE ON captured_session_source_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_logical_memory_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "personal_note_source_revisions_binding_check"
AFTER INSERT OR UPDATE OR DELETE ON personal_note_source_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_logical_memory_revision_binding();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_enforce_immutable_source_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'logical_memories' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR
       NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
       NEW.logical_key IS DISTINCT FROM OLD.logical_key THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'logical_memory_identity_immutable_check',
        MESSAGE = 'Logical Memory source identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'captured_session_logical_memories' THEN
    IF NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id OR
       NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR
       NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
       NEW.source_session_id IS DISTINCT FROM OLD.source_session_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'captured_session_source_binding_immutable_check',
        MESSAGE = 'Captured Session source binding is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'personal_note_logical_memories' THEN
    IF NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id OR
       NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR
       NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
       NEW.source_note_id IS DISTINCT FROM OLD.source_note_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'personal_note_source_binding_immutable_check',
        MESSAGE = 'Personal Note source binding is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'logical_memory_source_revisions' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR
       NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id OR
       NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR
       NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
       NEW.revision IS DISTINCT FROM OLD.revision OR
       NEW.binding_hash IS DISTINCT FROM OLD.binding_hash THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'logical_memory_source_revision_immutable_check',
        MESSAGE = 'Logical Memory source revision identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'captured_session_source_revisions' THEN
    IF NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR
       NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id OR
       NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR
       NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
       NEW.revision IS DISTINCT FROM OLD.revision OR
       NEW.source_session_id IS DISTINCT FROM OLD.source_session_id OR
       NEW.source_cursor IS DISTINCT FROM OLD.source_cursor THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'captured_session_source_revision_immutable_check',
        MESSAGE = 'Captured Session source revision binding is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'personal_note_source_revisions' THEN
    IF NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id OR
       NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id OR
       NEW.owner_principal_id IS DISTINCT FROM OLD.owner_principal_id OR
       NEW.source_kind IS DISTINCT FROM OLD.source_kind OR
       NEW.revision IS DISTINCT FROM OLD.revision OR
       NEW.source_note_id IS DISTINCT FROM OLD.source_note_id OR
       NEW.source_memory_event_id IS DISTINCT FROM OLD.source_memory_event_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'personal_note_source_revision_immutable_check',
        MESSAGE = 'Personal Note source revision binding is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "logical_memories_identity_immutable_check"
BEFORE UPDATE ON logical_memories FOR EACH ROW EXECUTE FUNCTION koed_enforce_immutable_source_identity();--> statement-breakpoint
CREATE TRIGGER "captured_session_logical_memories_identity_immutable_check"
BEFORE UPDATE ON captured_session_logical_memories FOR EACH ROW EXECUTE FUNCTION koed_enforce_immutable_source_identity();--> statement-breakpoint
CREATE TRIGGER "personal_note_logical_memories_identity_immutable_check"
BEFORE UPDATE ON personal_note_logical_memories FOR EACH ROW EXECUTE FUNCTION koed_enforce_immutable_source_identity();--> statement-breakpoint
CREATE TRIGGER "logical_memory_source_revisions_identity_immutable_check"
BEFORE UPDATE ON logical_memory_source_revisions FOR EACH ROW EXECUTE FUNCTION koed_enforce_immutable_source_identity();--> statement-breakpoint
CREATE TRIGGER "captured_session_source_revisions_identity_immutable_check"
BEFORE UPDATE ON captured_session_source_revisions FOR EACH ROW EXECUTE FUNCTION koed_enforce_immutable_source_identity();--> statement-breakpoint
CREATE TRIGGER "personal_note_source_revisions_identity_immutable_check"
BEFORE UPDATE ON personal_note_source_revisions FOR EACH ROW EXECUTE FUNCTION koed_enforce_immutable_source_identity();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_assert_workflow_source_revision_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_source_revision bigint;
BEGIN
  SELECT binding.source_revision INTO bound_source_revision
    FROM logical_memory_source_revision_bindings binding
   WHERE binding.source_revision_id = NEW.source_revision_id
     AND binding.logical_memory_id = NEW.logical_memory_id;
  IF NOT FOUND OR bound_source_revision IS DISTINCT FROM NEW.source_revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'workflow_source_revision_binding_check',
      MESSAGE = 'Workflow source revision must match its immutable source binding';
  END IF;

  IF TG_TABLE_NAME = 'pending_share_operations' THEN
    IF NEW.replacement_source_revision_id IS NOT NULL THEN
      SELECT binding.source_revision INTO bound_source_revision
        FROM logical_memory_source_revision_bindings binding
       WHERE binding.source_revision_id = NEW.replacement_source_revision_id
         AND binding.logical_memory_id = NEW.logical_memory_id;
      IF NOT FOUND OR bound_source_revision IS DISTINCT FROM NEW.replacement_source_revision THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'workflow_replacement_source_revision_binding_check',
          MESSAGE = 'Replacement source revision must match its immutable source binding';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "shared_source_artifacts_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON shared_source_artifacts DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "shared_source_previews_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON shared_source_previews DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "shared_memory_candidate_previews_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON shared_memory_candidate_previews DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "pending_share_operations_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON pending_share_operations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "source_owner_consents_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON source_owner_representation_consents DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "team_memory_share_grants_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON team_memory_share_grants DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "team_memory_representations_revision_binding_constraint_trigger"
AFTER INSERT OR UPDATE ON team_memory_representations DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_assert_workflow_source_revision_binding();--> statement-breakpoint
CREATE INDEX "pending_share_operations_source_revision_idx" ON "pending_share_operations" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "shared_memory_candidate_previews_source_revision_idx" ON "shared_memory_candidate_previews" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "shared_source_artifacts_source_revision_idx" ON "shared_source_artifacts" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "shared_source_previews_source_revision_idx" ON "shared_source_previews" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "source_owner_consents_source_revision_idx" ON "source_owner_representation_consents" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "team_memory_representations_source_revision_idx" ON "team_memory_representations" USING btree ("source_revision_id");--> statement-breakpoint
CREATE INDEX "team_memory_share_grants_source_revision_idx" ON "team_memory_share_grants" USING btree ("source_revision_id");
