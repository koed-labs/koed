CREATE TYPE "public"."shared_memory_source_kind" AS ENUM('captured_session', 'personal_note');--> statement-breakpoint
ALTER TYPE "public"."memory_question_status" ADD VALUE 'pending' BEFORE 'answered';--> statement-breakpoint
ALTER TYPE "public"."sync_source_boundary" ADD VALUE 'personal_note';--> statement-breakpoint
ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'source_revision_changed' AFTER 'fidelity_changed';--> statement-breakpoint
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
ALTER TABLE "collaboration_participants" DROP CONSTRAINT "collaboration_participants_shape_check";--> statement-breakpoint
ALTER TABLE "collaboration_participants" DROP CONSTRAINT "collaboration_participants_thread_scope_fk";--> statement-breakpoint
ALTER TABLE "collaboration_threads" DROP CONSTRAINT "collaboration_threads_shape_check";--> statement-breakpoint
DROP INDEX "collaboration_threads_notes_owner_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_participant_key_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_personal_channel_active_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_workspace_channel_active_unique";--> statement-breakpoint
DROP INDEX "collaboration_threads_companion_unique";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_origin_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_status_check";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_identity_check";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_fidelity_check";--> statement-breakpoint
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
  SELECT *
    INTO target_thread
    FROM collaboration_threads
   WHERE id = target_thread_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*)::integer,
         min(ordinal),
         max(ordinal),
         count(DISTINCT ordinal)::integer
    INTO participant_count,
         minimum_ordinal,
         maximum_ordinal,
         distinct_ordinals
    FROM collaboration_participants
   WHERE thread_id = target_thread_id;

  IF target_thread.kind IN (
    'personal_channel',
    'workspace_channel',
    'shared_session_discussion'
  ) THEN
    IF participant_count <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        CONSTRAINT = 'collaboration_participant_set_check',
        MESSAGE = 'Channel participant set must be implicit';
    END IF;
    RETURN;
  END IF;

  IF target_thread.kind = 'dm' AND participant_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Direct message participant set is invalid';
  END IF;
  IF target_thread.kind = 'group_dm'
     AND (participant_count < 3 OR participant_count > 40) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Group direct message participant set is invalid';
  END IF;
  IF target_thread.kind NOT IN ('dm', 'group_dm') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration thread kind has no participant invariant';
  END IF;
  IF minimum_ordinal <> 0
     OR maximum_ordinal <> participant_count - 1
     OR distinct_ordinals <> participant_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration participant ordinals are invalid';
  END IF;

  SELECT encode(
           digest(
             E'koed:collaboration:participants:v1\n'
             || '{"teamId":"' || target_thread.team_id::text
             || '","userIds":['
             || string_agg(
                  '"' || participant.user_id::text || '"',
                  ',' ORDER BY participant.user_id::text
                )
             || ']}',
             'sha256'
           ),
           'hex'
         )
    INTO calculated_participant_key
    FROM collaboration_participants participant
   WHERE participant.thread_id = target_thread_id;

  IF calculated_participant_key IS DISTINCT FROM target_thread.participant_key THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'collaboration_participant_set_check',
      MESSAGE = 'Collaboration participant identity is invalid';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_thread_scope_fk" FOREIGN KEY ("thread_id","scope","thread_kind") REFERENCES "public"."collaboration_threads"("id","scope","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_participant_key_unique" ON "collaboration_threads" USING btree ("team_id","participant_key") WHERE "collaboration_threads"."kind" in ('dm', 'group_dm');--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_personal_channel_active_unique" ON "collaboration_threads" USING btree ("personal_owner_user_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'personal_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_workspace_channel_active_unique" ON "collaboration_threads" USING btree ("team_workspace_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'workspace_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_companion_unique" ON "collaboration_threads" USING btree ("team_workspace_id","shared_logical_memory_id") WHERE "collaboration_threads"."kind" = 'shared_session_discussion';--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ALTER COLUMN "local_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ALTER COLUMN "sync_relationship_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ALTER COLUMN "remote_replica_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "logical_memory_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "mode" "shared_memory_consent_mode" DEFAULT 'snapshot' NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_note_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_note_revision" integer;--> statement-breakpoint
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
ALTER TABLE "team_session_share_grants" ADD COLUMN "display_title_source_revision" bigint;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_note_id_personal_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."personal_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD CONSTRAINT "personal_note_revisions_note_owner_fk" FOREIGN KEY ("note_id","owner_user_id") REFERENCES "public"."personal_notes"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_notes" ADD CONSTRAINT "personal_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_note_revisions_memory_event_unique" ON "personal_note_revisions" USING btree ("memory_event_id") WHERE "personal_note_revisions"."memory_event_id" is not null;--> statement-breakpoint
CREATE INDEX "personal_note_revisions_owner_pending_idx" ON "personal_note_revisions" USING btree ("owner_user_id","created_at") WHERE "personal_note_revisions"."projection_state" in ('pending','failed');--> statement-breakpoint
CREATE INDEX "personal_notes_owner_sequence_idx" ON "personal_notes" USING btree ("owner_user_id","sequence" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_note_id_personal_notes_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."personal_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_questions_owner_ask_turn_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","ask_turn_index") WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
CREATE INDEX "memory_questions_owner_ask_recent_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_shape_check" CHECK ((
        "collaboration_participants"."scope" = 'team'
        and "collaboration_participants"."thread_kind" in ('dm', 'group_dm')
        and "collaboration_participants"."personal_owner_user_id" is null
        and "collaboration_participants"."team_id" is not null
        and "collaboration_participants"."ordinal" >= 0
      ));--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "csm_pending_source_work_source_check" CHECK (("collaboration_pending_share_source_work"."source_kind" = 'captured_session'
          and "collaboration_pending_share_source_work"."local_session_id" is not null
          and "collaboration_pending_share_source_work"."local_note_id" is null
          and "collaboration_pending_share_source_work"."local_note_revision" is null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is null)
        or ("collaboration_pending_share_source_work"."source_kind" = 'personal_note'
          and "collaboration_pending_share_source_work"."local_session_id" is null
          and "collaboration_pending_share_source_work"."local_note_id" is not null
          and "collaboration_pending_share_source_work"."local_note_revision" > 0
          and "collaboration_pending_share_source_work"."local_memory_event_id" is not null));--> statement-breakpoint
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
          or ("pending_share_operations"."activation_representation"::text = 'curated_assertions' and "pending_share_operations"."include_curated_memory" = true))
        and (("pending_share_operations"."source_kind" = 'captured_session'
          and "pending_share_operations"."source_session_id" is not null
          and "pending_share_operations"."source_note_id" is null
          and "pending_share_operations"."source_memory_event_id" is null)
        or ("pending_share_operations"."source_kind" = 'personal_note'
          and "pending_share_operations"."source_session_id" is null
          and "pending_share_operations"."source_note_id" is not null
          and "pending_share_operations"."source_memory_event_id" is not null
          and "pending_share_operations"."mode" in ('snapshot','continuous')
          and "pending_share_operations"."representation" = 'memory_events'
          and "pending_share_operations"."maximum_fidelity" = 'memory_events'
          and "pending_share_operations"."include_curated_memory" = false
          and "pending_share_operations"."source_revision" > 0
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
          and "shared_memory_candidate_previews"."mode" in ('snapshot','continuous')
          and "shared_memory_candidate_previews"."representation" = 'memory_events'
          and "shared_memory_candidate_previews"."maximum_fidelity" = 'memory_events'
          and "shared_memory_candidate_previews"."include_curated_memory" = false
          and "shared_memory_candidate_previews"."source_revision" > 0
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
          and "shared_source_artifacts"."source_revision" > 0
          and "shared_source_artifacts"."source_cursor" = "shared_source_artifacts"."source_revision"
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
          and "shared_source_previews"."source_revision" > 0
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
          and "source_owner_representation_consents"."maximum_fidelity" = 'memory_events'
          and "source_owner_representation_consents"."include_curated_memory" = false
          and "source_owner_representation_consents"."source_revision" > 0
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
            and "team_memory_representations"."source_revision" > 0));--> statement-breakpoint
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
          and "team_session_share_grants"."source_revision" > 0)));
ALTER TABLE "collaboration_shared_memory_enrollments" ADD CONSTRAINT "csm_enrollments_id_owner_unique" UNIQUE("id","local_owner_user_id");--> statement-breakpoint
CREATE TABLE "collaboration_continuous_note_advancement_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"local_owner_user_id" uuid NOT NULL,
	"local_note_id" uuid NOT NULL,
	"local_note_revision" integer NOT NULL,
	"local_memory_event_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"redacted_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_note_advancement_revision_unique" UNIQUE("enrollment_id","local_note_id","local_note_revision"),
	CONSTRAINT "csm_note_advancement_state_check" CHECK ("collaboration_continuous_note_advancement_work"."state" in ('pending','processing','completed','failed')
        and "collaboration_continuous_note_advancement_work"."local_note_revision" > 0
        and "collaboration_continuous_note_advancement_work"."attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_replacement_values_check";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_source_binding_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_values_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_source_binding_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_source_binding_check";--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_local_owner_user_id_users_id_fk" FOREIGN KEY ("local_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_local_note_id_personal_notes_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."personal_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "collaboration_continuous_note_advancement_work_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "csm_note_advancement_enrollment_owner_fk" FOREIGN KEY ("enrollment_id","local_owner_user_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id","local_owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_continuous_note_advancement_work" ADD CONSTRAINT "csm_note_advancement_note_owner_fk" FOREIGN KEY ("local_note_id","local_owner_user_id") REFERENCES "public"."personal_notes"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csm_note_advancement_claim_idx" ON "collaboration_continuous_note_advancement_work" USING btree ("state","available_at","id");--> statement-breakpoint
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
             "pending_share_operations"."replacement_source_revision" >= 0 and
             length("pending_share_operations"."replacement_source_hash") = 64 and
             "pending_share_operations"."replacement_expected_grant_version" > 0));--> statement-breakpoint
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
          and "pending_share_operations"."mode" in ('snapshot','continuous')
          and "pending_share_operations"."representation" = 'memory_events'
          and "pending_share_operations"."maximum_fidelity" = 'memory_events'
          and "pending_share_operations"."include_curated_memory" = false
          and "pending_share_operations"."source_revision" > 0
          and "pending_share_operations"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "pending_share_operations"."activation_representation" = 'memory_events')));--> statement-breakpoint
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
          and "shared_memory_candidate_previews"."mode" in ('snapshot','continuous')
          and "shared_memory_candidate_previews"."representation" = 'memory_events'
          and "shared_memory_candidate_previews"."maximum_fidelity" = 'memory_events'
          and "shared_memory_candidate_previews"."include_curated_memory" = false
          and "shared_memory_candidate_previews"."source_revision" > 0
          and "shared_memory_candidate_previews"."item_count" = 1
          and "shared_memory_candidate_previews"."excluded_item_count" = 0
          and "shared_memory_candidate_previews"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "shared_memory_candidate_previews"."activation_representation" = 'memory_events')));--> statement-breakpoint
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
          and "source_owner_representation_consents"."maximum_fidelity" = 'memory_events'
          and "source_owner_representation_consents"."include_curated_memory" = false
          and "source_owner_representation_consents"."source_revision" > 0
          and "source_owner_representation_consents"."source_capabilities" = array['memory_events']::shared_memory_representation[]
          and "source_owner_representation_consents"."activation_representation" = 'memory_events')));
