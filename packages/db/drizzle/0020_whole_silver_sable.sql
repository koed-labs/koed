CREATE TYPE "public"."collaboration_event_family" AS ENUM('team_lifecycle', 'team_membership_access', 'workspace_lifecycle_access', 'thread_lifecycle', 'message_created', 'read_state_updated', 'share_grant_lifecycle', 'representation_changed', 'memory_event_available', 'lcm_leaf_available', 'lcm_rollup_available', 'shared_session_discussion_activity', 'personal_memory_changed', 'access_revoked');--> statement-breakpoint
CREATE TYPE "public"."collaboration_lifecycle" AS ENUM('active', 'archived', 'tombstoned', 'purge_pending', 'purged');--> statement-breakpoint
CREATE TYPE "public"."collaboration_scope" AS ENUM('personal', 'team');--> statement-breakpoint
CREATE TYPE "public"."collaboration_sender_kind" AS ENUM('user', 'system', 'imported');--> statement-breakpoint
CREATE TYPE "public"."collaboration_stream_state" AS ENUM('active', 'requires_snapshot', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."collaboration_thread_kind" AS ENUM('notes_to_self', 'personal_channel', 'workspace_channel', 'dm', 'group_dm', 'shared_session_discussion');--> statement-breakpoint
CREATE TYPE "public"."high_risk_action_grant_state" AS ENUM('active', 'consumed', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."high_risk_confirmation_state" AS ENUM('pending', 'approved', 'denied', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."invite_lifecycle" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."legal_hold_scope" AS ENUM('team', 'workspace', 'thread', 'grant_representation', 'team_message_range', 'owner_private_replica');--> statement-breakpoint
CREATE TYPE "public"."legal_hold_state" AS ENUM('active', 'release_pending', 'released');--> statement-breakpoint
CREATE TYPE "public"."memory_replica_lifecycle" AS ENUM('active', 'stale', 'revoked', 'tombstoned', 'purge_pending', 'purged');--> statement-breakpoint
CREATE TYPE "public"."memory_representation_policy_scope" AS ENUM('source_owner', 'team', 'workspace');--> statement-breakpoint
CREATE TYPE "public"."memory_representation_state" AS ENUM('pending', 'available', 'stale', 'invalidated', 'purge_pending', 'purged');--> statement-breakpoint
CREATE TYPE "public"."purge_artifact_kind" AS ENUM('database_row', 'encrypted_payload', 'wrapped_key', 'search_index', 'vector', 'outbox_replay', 'backup_copy');--> statement-breakpoint
CREATE TYPE "public"."purge_attempt_state" AS ENUM('running', 'retryable_failure', 'terminal_failure', 'completed');--> statement-breakpoint
CREATE TYPE "public"."purge_evidence_state" AS ENUM('pending', 'cleaned', 'scheduled_expiry', 'verified', 'not_applicable', 'failed');--> statement-breakpoint
CREATE TYPE "public"."purge_job_state" AS ENUM('pending', 'canceled', 'blocked', 'running', 'retry_wait', 'failed', 'verified');--> statement-breakpoint
CREATE TYPE "public"."purge_target_kind" AS ENUM('team', 'workspace', 'thread', 'message', 'share_grant', 'grant_representation', 'owner_private_replica');--> statement-breakpoint
CREATE TYPE "public"."retention_policy_scope" AS ENUM('team', 'workspace', 'share_grant', 'thread', 'owner_private_replica');--> statement-breakpoint
CREATE TYPE "public"."retention_policy_shortening_state" AS ENUM('pending', 'confirmed', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."retention_trigger" AS ENUM('share_revoked', 'team_deletion', 'workspace_policy', 'user_erasure', 'source_purge', 'policy_migration');--> statement-breakpoint
CREATE TYPE "public"."share_grant_lifecycle" AS ENUM('active', 'unavailable', 'revoked', 'tombstoned', 'purge_pending', 'purged');--> statement-breakpoint
CREATE TYPE "public"."shared_memory_consent_mode" AS ENUM('snapshot', 'continuous');--> statement-breakpoint
CREATE TYPE "public"."shared_memory_consent_state" AS ENUM('pending', 'active', 'paused', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."shared_memory_representation" AS ENUM('memory_events', 'lcm_leaves', 'lcm_rollups');--> statement-breakpoint
CREATE TYPE "public"."team_lifecycle" AS ENUM('active', 'suspended', 'deletion_requested', 'purge_pending', 'purged');--> statement-breakpoint
CREATE TYPE "public"."workspace_lifecycle" AS ENUM('active', 'archived', 'purge_pending', 'purged');--> statement-breakpoint
CREATE TABLE "collaboration_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"thread_sequence" bigint NOT NULL,
	"scope" "collaboration_scope" NOT NULL,
	"personal_owner_user_id" uuid,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"sender_kind" "collaboration_sender_kind" NOT NULL,
	"sender_principal_id" uuid,
	"sender_user_id" uuid,
	"idempotency_key_hash" text,
	"request_hash" text,
	"body_marker" text NOT NULL,
	"metadata_marker" text NOT NULL,
	"provenance_kind" text NOT NULL,
	"provenance_id" text NOT NULL,
	"provenance_marker" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"edited_body_marker" text,
	"deleted_at" timestamp with time zone,
	"deleted_body_marker" text,
	"retention_policy_id" uuid,
	"retention_policy_version" integer,
	"retain_until" timestamp with time zone,
	CONSTRAINT "collaboration_messages_thread_sequence_unique" UNIQUE("thread_id","thread_sequence"),
	CONSTRAINT "collaboration_messages_thread_id_sequence_unique" UNIQUE("thread_id","id","thread_sequence"),
	CONSTRAINT "collaboration_messages_thread_id_unique" UNIQUE("thread_id","id"),
	CONSTRAINT "collaboration_messages_sequence_check" CHECK ("collaboration_messages"."thread_sequence" > 0),
	CONSTRAINT "collaboration_messages_marker_check" CHECK ("collaboration_messages"."body_marker" = '[koed encrypted collaboration message]'
        and "collaboration_messages"."metadata_marker" = '[koed encrypted collaboration metadata]'
        and "collaboration_messages"."provenance_marker" = '[koed encrypted collaboration provenance]'),
	CONSTRAINT "collaboration_messages_idempotency_check" CHECK ((
        "collaboration_messages"."sender_kind" = 'user'
        and "collaboration_messages"."sender_principal_id" is not null
        and length("collaboration_messages"."idempotency_key_hash") = 64
        and length("collaboration_messages"."request_hash") = 64
      ) or (
        "collaboration_messages"."sender_kind" in ('system', 'imported')
        and "collaboration_messages"."idempotency_key_hash" is null
        and "collaboration_messages"."request_hash" is null
      )),
	CONSTRAINT "collaboration_messages_provenance_check" CHECK (length(trim("collaboration_messages"."provenance_kind")) > 0
        and length(trim("collaboration_messages"."provenance_id")) > 0),
	CONSTRAINT "collaboration_messages_reserved_lifecycle_check" CHECK ("collaboration_messages"."edited_at" is null
        and "collaboration_messages"."edited_body_marker" is null
        and "collaboration_messages"."deleted_at" is null
        and "collaboration_messages"."deleted_body_marker" is null),
	CONSTRAINT "collaboration_messages_retention_check" CHECK (("collaboration_messages"."retention_policy_id" is null and "collaboration_messages"."retention_policy_version" is null)
        or ("collaboration_messages"."retention_policy_id" is not null and "collaboration_messages"."retention_policy_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "collaboration_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cursor" bigserial NOT NULL,
	"protocol_version" integer NOT NULL,
	"family" "collaboration_event_family" NOT NULL,
	"scope" "collaboration_scope" NOT NULL,
	"personal_owner_user_id" uuid,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"thread_id" uuid,
	"message_id" uuid,
	"share_grant_id" uuid,
	"logical_memory_id" uuid,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"actor_principal_id" uuid,
	"mutation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"replay_until" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "collaboration_outbox_cursor_unique" UNIQUE("cursor"),
	CONSTRAINT "collaboration_outbox_mutation_family_unique" UNIQUE("mutation_id","family"),
	CONSTRAINT "collaboration_outbox_id_cursor_unique" UNIQUE("id","cursor"),
	CONSTRAINT "collaboration_outbox_scope_check" CHECK ((
        "collaboration_outbox"."scope" = 'personal'
        and "collaboration_outbox"."personal_owner_user_id" is not null
        and "collaboration_outbox"."team_id" is null
        and "collaboration_outbox"."team_workspace_id" is null
      ) or (
        "collaboration_outbox"."scope" = 'team'
        and "collaboration_outbox"."personal_owner_user_id" is null
        and "collaboration_outbox"."team_id" is not null
      )),
	CONSTRAINT "collaboration_outbox_protocol_check" CHECK ("collaboration_outbox"."protocol_version" > 0
        and length(trim("collaboration_outbox"."resource_type")) > 0
        and "collaboration_outbox"."replay_until" > "collaboration_outbox"."occurred_at")
);
--> statement-breakpoint
CREATE TABLE "collaboration_participants" (
	"thread_id" uuid NOT NULL,
	"scope" "collaboration_scope" NOT NULL,
	"thread_kind" "collaboration_thread_kind" NOT NULL,
	"personal_owner_user_id" uuid,
	"team_id" uuid,
	"user_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_participants_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id"),
	CONSTRAINT "collaboration_participants_thread_ordinal_unique" UNIQUE("thread_id","ordinal"),
	CONSTRAINT "collaboration_participants_shape_check" CHECK ((
        "collaboration_participants"."scope" = 'personal'
        and "collaboration_participants"."thread_kind" = 'notes_to_self'
        and "collaboration_participants"."personal_owner_user_id" = "collaboration_participants"."user_id"
        and "collaboration_participants"."team_id" is null
        and "collaboration_participants"."ordinal" = 0
      ) or (
        "collaboration_participants"."scope" = 'team'
        and "collaboration_participants"."thread_kind" in ('dm', 'group_dm')
        and "collaboration_participants"."personal_owner_user_id" is null
        and "collaboration_participants"."team_id" is not null
        and "collaboration_participants"."ordinal" >= 0
      ))
);
--> statement-breakpoint
CREATE TABLE "collaboration_read_states" (
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_message_id" uuid,
	"last_read_sequence" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_read_states_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id"),
	CONSTRAINT "collaboration_read_states_cursor_check" CHECK ("collaboration_read_states"."last_read_sequence" >= 0
        and "collaboration_read_states"."version" > 0
        and (("collaboration_read_states"."last_read_message_id" is null and "collaboration_read_states"."last_read_sequence" = 0)
          or ("collaboration_read_states"."last_read_message_id" is not null and "collaboration_read_states"."last_read_sequence" > 0)))
);
--> statement-breakpoint
CREATE TABLE "collaboration_replay_watermarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "collaboration_scope" NOT NULL,
	"personal_owner_user_id" uuid,
	"team_id" uuid,
	"replay_low_water_cursor" bigint NOT NULL,
	"high_water_cursor" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collaboration_replay_watermarks_scope_check" CHECK (("collaboration_replay_watermarks"."scope" = 'personal' and "collaboration_replay_watermarks"."personal_owner_user_id" is not null and "collaboration_replay_watermarks"."team_id" is null)
        or ("collaboration_replay_watermarks"."scope" = 'team' and "collaboration_replay_watermarks"."personal_owner_user_id" is null and "collaboration_replay_watermarks"."team_id" is not null)),
	CONSTRAINT "collaboration_replay_watermarks_cursor_check" CHECK ("collaboration_replay_watermarks"."replay_low_water_cursor" > 0
        and "collaboration_replay_watermarks"."high_water_cursor" >= "collaboration_replay_watermarks"."replay_low_water_cursor")
);
--> statement-breakpoint
CREATE TABLE "collaboration_shared_memory_companion_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"companion_thread_id" uuid NOT NULL,
	"shared_session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "csm_companion_bindings_scope_unique" UNIQUE("id","enrollment_id","share_grant_id","logical_memory_id","team_id","team_workspace_id")
);
--> statement-breakpoint
CREATE TABLE "collaboration_shared_memory_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"consent_version" integer NOT NULL,
	"preview_id" uuid NOT NULL,
	"preview_hash" text NOT NULL,
	"preview_revision" integer NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"source_revision" bigint NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"protected_dto" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_consents_version_unique" UNIQUE("enrollment_id","consent_id","consent_version"),
	CONSTRAINT "csm_consents_version_revision_check" CHECK ("collaboration_shared_memory_consents"."consent_version" > 0 and "collaboration_shared_memory_consents"."preview_revision" > 0 and "collaboration_shared_memory_consents"."source_revision" >= 0),
	CONSTRAINT "csm_consents_hashes_check" CHECK (length("collaboration_shared_memory_consents"."preview_hash") = 64 and length("collaboration_shared_memory_consents"."protected_dto_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "collaboration_shared_memory_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backend_id" text NOT NULL,
	"local_owner_user_id" uuid NOT NULL,
	"upstream_user_id" uuid NOT NULL,
	"remote_device_id" uuid NOT NULL,
	"binding_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	CONSTRAINT "csm_enrollments_identity_unique" UNIQUE("id","backend_id","local_owner_user_id","upstream_user_id"),
	CONSTRAINT "csm_enrollments_backend_id_check" CHECK ("collaboration_shared_memory_enrollments"."backend_id" ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$'),
	CONSTRAINT "csm_enrollments_binding_version_check" CHECK ("collaboration_shared_memory_enrollments"."binding_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "collaboration_shared_memory_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"companion_binding_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"logical_grant_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"active_representation" "shared_memory_representation",
	"source_revision" bigint NOT NULL,
	"grant_version" integer NOT NULL,
	"lifecycle" "share_grant_lifecycle" NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"protected_dto" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_grants_version_unique" UNIQUE("enrollment_id","share_grant_id","grant_version"),
	CONSTRAINT "csm_grants_version_revision_check" CHECK ("collaboration_shared_memory_grants"."grant_version" > 0 and "collaboration_shared_memory_grants"."source_revision" >= 0),
	CONSTRAINT "csm_grants_protected_dto_hash_check" CHECK (length("collaboration_shared_memory_grants"."protected_dto_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "collaboration_shared_memory_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"preview_hash" text NOT NULL,
	"preview_revision" integer NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_hash" text NOT NULL,
	"redacted_content_hash" text NOT NULL,
	"item_count" integer NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"protected_dto" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_previews_identity_unique" UNIQUE("enrollment_id","preview_id"),
	CONSTRAINT "csm_previews_hash_unique" UNIQUE("enrollment_id","preview_hash"),
	CONSTRAINT "csm_previews_consent_binding_unique" UNIQUE("enrollment_id","preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision"),
	CONSTRAINT "csm_previews_revision_count_check" CHECK ("collaboration_shared_memory_previews"."preview_revision" > 0 and "collaboration_shared_memory_previews"."source_revision" >= 0 and "collaboration_shared_memory_previews"."item_count" > 0),
	CONSTRAINT "csm_previews_hashes_check" CHECK (length("collaboration_shared_memory_previews"."preview_hash") = 64
        and length("collaboration_shared_memory_previews"."source_hash") = 64
        and length("collaboration_shared_memory_previews"."redacted_content_hash") = 64
        and length("collaboration_shared_memory_previews"."protected_dto_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "collaboration_stream_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backend_identity_hash" text NOT NULL,
	"principal_id_hash" text NOT NULL,
	"device_credential_id" uuid,
	"client_instance_hash" text NOT NULL,
	"subscription_key_hash" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"scope" "collaboration_scope" NOT NULL,
	"personal_owner_user_id" uuid,
	"team_id" uuid,
	"state" "collaboration_stream_state" DEFAULT 'active' NOT NULL,
	"snapshot_high_water_cursor" bigint,
	"acknowledged_event_id" uuid,
	"acknowledged_cursor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_acknowledged_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "collaboration_stream_subscriptions_binding_unique" UNIQUE("backend_identity_hash","principal_id_hash","client_instance_hash","subscription_key_hash","protocol_version"),
	CONSTRAINT "collaboration_stream_subscriptions_hash_check" CHECK (length("collaboration_stream_subscriptions"."backend_identity_hash") = 64
        and length("collaboration_stream_subscriptions"."principal_id_hash") = 64
        and length("collaboration_stream_subscriptions"."client_instance_hash") = 64
        and length("collaboration_stream_subscriptions"."subscription_key_hash") = 64),
	CONSTRAINT "collaboration_stream_subscriptions_scope_check" CHECK (("collaboration_stream_subscriptions"."scope" = 'personal' and "collaboration_stream_subscriptions"."personal_owner_user_id" is not null and "collaboration_stream_subscriptions"."team_id" is null)
        or ("collaboration_stream_subscriptions"."scope" = 'team' and "collaboration_stream_subscriptions"."personal_owner_user_id" is null and "collaboration_stream_subscriptions"."team_id" is not null)),
	CONSTRAINT "collaboration_stream_subscriptions_cursor_check" CHECK ("collaboration_stream_subscriptions"."protocol_version" > 0
        and "collaboration_stream_subscriptions"."acknowledged_cursor" >= 0
        and ("collaboration_stream_subscriptions"."snapshot_high_water_cursor" is null or "collaboration_stream_subscriptions"."snapshot_high_water_cursor" >= "collaboration_stream_subscriptions"."acknowledged_cursor")
        and (("collaboration_stream_subscriptions"."acknowledged_event_id" is null and "collaboration_stream_subscriptions"."acknowledged_cursor" = 0)
          or ("collaboration_stream_subscriptions"."acknowledged_event_id" is not null and "collaboration_stream_subscriptions"."acknowledged_cursor" > 0)))
);
--> statement-breakpoint
CREATE TABLE "collaboration_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"scope" "collaboration_scope" NOT NULL,
	"kind" "collaboration_thread_kind" NOT NULL,
	"personal_owner_user_id" uuid,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"shared_logical_memory_id" uuid,
	"share_grant_id" uuid,
	"system_key" text,
	"name_marker" text,
	"topic_marker" text,
	"normalized_name_hash" text,
	"participant_key" text,
	"created_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"next_sequence" bigint DEFAULT 1 NOT NULL,
	"lifecycle" "collaboration_lifecycle" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"retention_policy_id" uuid,
	"retention_policy_version" integer,
	"retention_triggered_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"purge_completed_at" timestamp with time zone,
	CONSTRAINT "collaboration_threads_logical_id_unique" UNIQUE("logical_id"),
	CONSTRAINT "collaboration_threads_id_scope_kind_unique" UNIQUE("id","scope","kind"),
	CONSTRAINT "collaboration_threads_id_scope_unique" UNIQUE("id","scope"),
	CONSTRAINT "collaboration_threads_id_personal_owner_unique" UNIQUE("id","personal_owner_user_id"),
	CONSTRAINT "collaboration_threads_id_team_unique" UNIQUE("id","team_id"),
	CONSTRAINT "collaboration_threads_id_workspace_unique" UNIQUE("id","team_workspace_id"),
	CONSTRAINT "collaboration_threads_shape_check" CHECK ((
        "collaboration_threads"."scope" = 'personal'
        and "collaboration_threads"."kind" = 'notes_to_self'
        and "collaboration_threads"."personal_owner_user_id" is not null
        and "collaboration_threads"."team_id" is null
        and "collaboration_threads"."team_workspace_id" is null
        and "collaboration_threads"."system_key" is null
        and "collaboration_threads"."name_marker" is null
        and "collaboration_threads"."topic_marker" is null
        and "collaboration_threads"."normalized_name_hash" is null
        and "collaboration_threads"."participant_key" is null
        and "collaboration_threads"."shared_logical_memory_id" is null
        and "collaboration_threads"."share_grant_id" is null
      ) or (
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
      )),
	CONSTRAINT "collaboration_threads_system_key_check" CHECK ("collaboration_threads"."system_key" is null or "collaboration_threads"."system_key" = 'workspace.general'),
	CONSTRAINT "collaboration_threads_version_check" CHECK ("collaboration_threads"."version" > 0),
	CONSTRAINT "collaboration_threads_sequence_check" CHECK ("collaboration_threads"."next_sequence" > 0),
	CONSTRAINT "collaboration_threads_topic_marker_check" CHECK ("collaboration_threads"."topic_marker" is null or "collaboration_threads"."topic_marker" = '[koed encrypted collaboration topic]'),
	CONSTRAINT "collaboration_threads_lifecycle_check" CHECK (("collaboration_threads"."lifecycle" = 'active' and "collaboration_threads"."archived_at" is null and "collaboration_threads"."tombstoned_at" is null and "collaboration_threads"."purge_completed_at" is null)
        or ("collaboration_threads"."lifecycle" = 'archived' and "collaboration_threads"."archived_at" is not null and "collaboration_threads"."tombstoned_at" is null and "collaboration_threads"."purge_completed_at" is null)
        or ("collaboration_threads"."lifecycle" in ('tombstoned', 'purge_pending') and "collaboration_threads"."tombstoned_at" is not null and "collaboration_threads"."purge_completed_at" is null)
        or ("collaboration_threads"."lifecycle" = 'purged' and "collaboration_threads"."tombstoned_at" is not null and "collaboration_threads"."purge_completed_at" is not null)),
	CONSTRAINT "collaboration_threads_retention_check" CHECK (("collaboration_threads"."retention_policy_id" is null and "collaboration_threads"."retention_policy_version" is null)
        or ("collaboration_threads"."retention_policy_id" is not null and "collaboration_threads"."retention_policy_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "high_risk_action_grant_execution_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_grant_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status_code" integer NOT NULL,
	"receipt_body" jsonb NOT NULL,
	"receipt_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "high_risk_action_grant_execution_receipts_action_grant_unique" UNIQUE("action_grant_id"),
	CONSTRAINT "high_risk_action_grant_execution_receipts_status_code_check" CHECK ("high_risk_action_grant_execution_receipts"."status_code" between 100 and 599),
	CONSTRAINT "high_risk_action_grant_execution_receipts_hash_check" CHECK (length("high_risk_action_grant_execution_receipts"."receipt_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "high_risk_browser_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"selector" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"decision_user_session_id" uuid,
	"device_credential_id" uuid NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"team_id" uuid,
	"operation_family" text NOT NULL,
	"action" text NOT NULL,
	"target_id" uuid,
	"scope_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"secret_commitment" text NOT NULL,
	"state" "high_risk_confirmation_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decision_freshly_authenticated_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason_code" text,
	CONSTRAINT "high_risk_browser_confirmations_selector_unique" UNIQUE("selector"),
	CONSTRAINT "high_risk_browser_confirmations_secret_commitment_unique" UNIQUE("secret_commitment"),
	CONSTRAINT "high_risk_confirmations_device_request_unique" UNIQUE("device_credential_id","client_request_id"),
	CONSTRAINT "high_risk_confirmations_operation_check" CHECK ("high_risk_browser_confirmations"."operation_family" ~ '^[A-Za-z0-9_.:-]+$'
        and "high_risk_browser_confirmations"."action" ~ '^[A-Za-z0-9_.:-]+$'),
	CONSTRAINT "high_risk_confirmations_hash_check" CHECK (length("high_risk_browser_confirmations"."scope_hash") = 64
        and length("high_risk_browser_confirmations"."request_hash") = 64
        and "high_risk_browser_confirmations"."secret_commitment" ~ '^v1:[0-9A-Fa-f]{64}$'),
	CONSTRAINT "high_risk_confirmations_time_check" CHECK ("high_risk_browser_confirmations"."expires_at" > "high_risk_browser_confirmations"."created_at"
        and ("high_risk_browser_confirmations"."decided_at" is null or "high_risk_browser_confirmations"."decision_freshly_authenticated_at" <= "high_risk_browser_confirmations"."decided_at")),
	CONSTRAINT "high_risk_confirmations_lifecycle_check" CHECK ((
        "high_risk_browser_confirmations"."state" = 'pending'
        and "high_risk_browser_confirmations"."decision_user_session_id" is null
        and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null
        and "high_risk_browser_confirmations"."decided_at" is null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'approved'
        and "high_risk_browser_confirmations"."decision_user_session_id" is not null
        and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is not null
        and "high_risk_browser_confirmations"."decided_at" is not null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'denied'
        and "high_risk_browser_confirmations"."decision_user_session_id" is not null
        and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is not null
        and "high_risk_browser_confirmations"."decided_at" is not null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'expired'
        and "high_risk_browser_confirmations"."decision_user_session_id" is null
        and "high_risk_browser_confirmations"."decision_freshly_authenticated_at" is null
        and "high_risk_browser_confirmations"."decided_at" is null
        and "high_risk_browser_confirmations"."revoked_at" is null
      ) or (
        "high_risk_browser_confirmations"."state" = 'revoked'
        and "high_risk_browser_confirmations"."revoked_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "high_risk_device_action_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"team_id" uuid,
	"operation_family" text NOT NULL,
	"action" text NOT NULL,
	"target_id" uuid,
	"scope_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"secret_commitment" text NOT NULL,
	"state" "high_risk_action_grant_state" DEFAULT 'active' NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason_code" text,
	CONSTRAINT "high_risk_device_action_grants_secret_commitment_unique" UNIQUE("secret_commitment"),
	CONSTRAINT "high_risk_action_grants_confirmation_unique" UNIQUE("confirmation_id"),
	CONSTRAINT "high_risk_action_grants_operation_check" CHECK ("high_risk_device_action_grants"."operation_family" ~ '^[A-Za-z0-9_.:-]+$'
        and "high_risk_device_action_grants"."action" ~ '^[A-Za-z0-9_.:-]+$'),
	CONSTRAINT "high_risk_action_grants_hash_check" CHECK (length("high_risk_device_action_grants"."scope_hash") = 64
        and length("high_risk_device_action_grants"."request_hash") = 64
        and "high_risk_device_action_grants"."secret_commitment" ~ '^v1:[0-9A-Fa-f]{64}$'),
	CONSTRAINT "high_risk_action_grants_use_check" CHECK ("high_risk_device_action_grants"."max_uses" = 1
        and "high_risk_device_action_grants"."use_count" between 0 and "high_risk_device_action_grants"."max_uses"
        and "high_risk_device_action_grants"."expires_at" > "high_risk_device_action_grants"."created_at"),
	CONSTRAINT "high_risk_action_grants_lifecycle_check" CHECK ((
        "high_risk_device_action_grants"."state" = 'active'
        and "high_risk_device_action_grants"."use_count" = 0
        and "high_risk_device_action_grants"."consumed_at" is null
        and "high_risk_device_action_grants"."revoked_at" is null
      ) or (
        "high_risk_device_action_grants"."state" = 'consumed'
        and "high_risk_device_action_grants"."use_count" = 1
        and "high_risk_device_action_grants"."consumed_at" is not null
        and "high_risk_device_action_grants"."revoked_at" is null
      ) or (
        "high_risk_device_action_grants"."state" = 'expired'
        and "high_risk_device_action_grants"."use_count" = 0
        and "high_risk_device_action_grants"."consumed_at" is null
        and "high_risk_device_action_grants"."revoked_at" is null
      ) or (
        "high_risk_device_action_grants"."state" = 'revoked'
        and "high_risk_device_action_grants"."use_count" = 0
        and "high_risk_device_action_grants"."consumed_at" is null
        and "high_risk_device_action_grants"."revoked_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "legal_hold_scope" NOT NULL,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"thread_id" uuid,
	"share_grant_id" uuid,
	"representation_id" uuid,
	"representation" "shared_memory_representation",
	"source_revision" bigint,
	"owner_private_replica_id" uuid,
	"logical_memory_id" uuid,
	"message_range_start" bigint,
	"message_range_end" bigint,
	"message_time_start" timestamp with time zone,
	"message_time_end" timestamp with time zone,
	"authority" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_hash" text NOT NULL,
	"state" "legal_hold_state" DEFAULT 'active' NOT NULL,
	"placed_by_user_id" uuid,
	"freshly_authenticated_at" timestamp with time zone NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"release_requested_by_user_id" uuid,
	"release_requested_at" timestamp with time zone,
	"release_confirmed_by_user_id" uuid,
	"release_confirmed_at" timestamp with time zone,
	"single_holder_release_exception" boolean DEFAULT false NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "legal_holds_reason_check" CHECK (length(trim("legal_holds"."authority")) > 0
        and length(trim("legal_holds"."reason_code")) > 0
        and length("legal_holds"."reason_hash") = 64),
	CONSTRAINT "legal_holds_target_check" CHECK ((
        "legal_holds"."scope" = 'team' and "legal_holds"."team_id" is not null
        and "legal_holds"."team_workspace_id" is null and "legal_holds"."thread_id" is null
        and "legal_holds"."share_grant_id" is null and "legal_holds"."representation_id" is null
        and "legal_holds"."owner_private_replica_id" is null and "legal_holds"."logical_memory_id" is null
      ) or (
        "legal_holds"."scope" = 'workspace' and "legal_holds"."team_id" is not null
        and "legal_holds"."team_workspace_id" is not null and "legal_holds"."thread_id" is null
        and "legal_holds"."share_grant_id" is null and "legal_holds"."representation_id" is null
        and "legal_holds"."owner_private_replica_id" is null and "legal_holds"."logical_memory_id" is null
      ) or (
        "legal_holds"."scope" = 'thread' and "legal_holds"."team_id" is not null
        and "legal_holds"."thread_id" is not null and "legal_holds"."share_grant_id" is null
        and "legal_holds"."representation_id" is null and "legal_holds"."owner_private_replica_id" is null
        and "legal_holds"."logical_memory_id" is null
      ) or (
        "legal_holds"."scope" = 'grant_representation' and "legal_holds"."team_id" is not null
        and "legal_holds"."team_workspace_id" is not null and "legal_holds"."share_grant_id" is not null
        and "legal_holds"."representation_id" is not null and "legal_holds"."representation" is not null
        and "legal_holds"."source_revision" >= 0 and "legal_holds"."owner_private_replica_id" is null
        and "legal_holds"."logical_memory_id" is not null
      ) or (
        "legal_holds"."scope" = 'team_message_range' and "legal_holds"."team_id" is not null
        and "legal_holds"."thread_id" is not null and "legal_holds"."share_grant_id" is null
        and "legal_holds"."representation_id" is null and "legal_holds"."owner_private_replica_id" is null
        and "legal_holds"."logical_memory_id" is null
        and (("legal_holds"."message_range_start" > 0 and "legal_holds"."message_range_end" >= "legal_holds"."message_range_start")
          or ("legal_holds"."message_time_start" is not null and "legal_holds"."message_time_end" >= "legal_holds"."message_time_start"))
      ) or (
        "legal_holds"."scope" = 'owner_private_replica' and "legal_holds"."team_id" is null
        and "legal_holds"."team_workspace_id" is null and "legal_holds"."thread_id" is null
        and "legal_holds"."share_grant_id" is null and "legal_holds"."representation_id" is null
        and "legal_holds"."owner_private_replica_id" is not null and "legal_holds"."logical_memory_id" is not null
      )),
	CONSTRAINT "legal_holds_release_lifecycle_check" CHECK ((
        "legal_holds"."state" = 'active'
        and "legal_holds"."release_requested_at" is null
        and "legal_holds"."release_confirmed_at" is null
        and "legal_holds"."released_at" is null
      ) or (
        "legal_holds"."state" = 'release_pending'
        and "legal_holds"."release_requested_at" is not null
        and "legal_holds"."release_confirmed_at" is null
        and "legal_holds"."released_at" is null
      ) or (
        "legal_holds"."state" = 'released'
        and "legal_holds"."release_requested_at" is not null
        and "legal_holds"."release_confirmed_at" is not null
        and "legal_holds"."released_at" is not null
        and ("legal_holds"."single_holder_release_exception"
          or "legal_holds"."release_confirmed_by_user_id" is distinct from "legal_holds"."release_requested_by_user_id")
      ))
);
--> statement-breakpoint
CREATE TABLE "local_edge_collaboration_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"credential_binding_hash" text NOT NULL,
	"team_id" uuid NOT NULL,
	"protocol_version" integer NOT NULL,
	"remote_subscription_id" uuid NOT NULL,
	"remote_cursor" text NOT NULL,
	"last_acknowledged_event_id" uuid,
	"state" "collaboration_stream_state" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_connected_at" timestamp with time zone,
	"last_acknowledged_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "local_edge_collaboration_subscriptions_binding_unique" UNIQUE("upstream_backend_id","credential_binding_hash","team_id","protocol_version"),
	CONSTRAINT "local_edge_collaboration_subscriptions_values_check" CHECK (length(trim("local_edge_collaboration_subscriptions"."upstream_backend_id")) > 0
        and length("local_edge_collaboration_subscriptions"."credential_binding_hash") = 64
        and "local_edge_collaboration_subscriptions"."protocol_version" > 0
        and length("local_edge_collaboration_subscriptions"."remote_cursor") between 16 and 4096
        and "local_edge_collaboration_subscriptions"."version" > 0
        and "local_edge_collaboration_subscriptions"."expires_at" > "local_edge_collaboration_subscriptions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "purge_job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purge_job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"state" "purge_attempt_state" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"resume_artifact_kind" "purge_artifact_kind",
	"resume_cursor" text,
	"error_code" text,
	"error_hash" text,
	CONSTRAINT "purge_job_attempts_number_unique" UNIQUE("purge_job_id","attempt_number"),
	CONSTRAINT "purge_job_attempts_number_check" CHECK ("purge_job_attempts"."attempt_number" > 0),
	CONSTRAINT "purge_job_attempts_lifecycle_check" CHECK (("purge_job_attempts"."state" = 'running' and "purge_job_attempts"."completed_at" is null)
        or ("purge_job_attempts"."state" <> 'running' and "purge_job_attempts"."completed_at" is not null)),
	CONSTRAINT "purge_job_attempts_error_check" CHECK (("purge_job_attempts"."error_code" is null and "purge_job_attempts"."error_hash" is null)
        or ("purge_job_attempts"."error_code" is not null and length("purge_job_attempts"."error_hash") = 64))
);
--> statement-breakpoint
CREATE TABLE "purge_job_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purge_job_id" uuid NOT NULL,
	"purge_attempt_id" uuid,
	"artifact_kind" "purge_artifact_kind" NOT NULL,
	"artifact_locator_hash" text NOT NULL,
	"state" "purge_evidence_state" DEFAULT 'pending' NOT NULL,
	"removed_record_count" bigint NOT NULL,
	"removed_byte_count" bigint NOT NULL,
	"evidence_hash" text,
	"backup_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "purge_job_evidence_artifact_unique" UNIQUE("purge_job_id","artifact_kind","artifact_locator_hash"),
	CONSTRAINT "purge_job_evidence_counts_check" CHECK ("purge_job_evidence"."removed_record_count" >= 0
        and "purge_job_evidence"."removed_byte_count" >= 0
        and length("purge_job_evidence"."artifact_locator_hash") = 64),
	CONSTRAINT "purge_job_evidence_proof_check" CHECK (("purge_job_evidence"."state" in ('pending', 'failed') and "purge_job_evidence"."verified_at" is null)
        or ("purge_job_evidence"."state" in ('cleaned', 'verified', 'not_applicable')
          and length("purge_job_evidence"."evidence_hash") = 64)
        or ("purge_job_evidence"."state" = 'scheduled_expiry'
          and length("purge_job_evidence"."evidence_hash") = 64
          and "purge_job_evidence"."backup_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "purge_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retention_decision_id" uuid NOT NULL,
	"target_kind" "purge_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"share_grant_id" uuid,
	"representation_id" uuid,
	"logical_memory_id" uuid,
	"state" "purge_job_state" DEFAULT 'pending' NOT NULL,
	"target_epoch" bigint DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"resume_artifact_kind" "purge_artifact_kind",
	"resume_cursor" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"terminal_error_code" text,
	"canceled_at" timestamp with time zone,
	"cancellation_reason_code" text,
	"canceled_by_user_id" uuid,
	"canceled_by_mutation_id" uuid,
	CONSTRAINT "purge_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "purge_jobs_resume_check" CHECK ("purge_jobs"."attempt_count" >= 0 and "purge_jobs"."target_epoch" >= 0
        and length(trim("purge_jobs"."idempotency_key")) > 0
        and (("purge_jobs"."resume_artifact_kind" is null and "purge_jobs"."resume_cursor" is null)
          or ("purge_jobs"."resume_artifact_kind" is not null and "purge_jobs"."resume_cursor" is not null))),
	CONSTRAINT "purge_jobs_lifecycle_check" CHECK (("purge_jobs"."state" = 'pending' and "purge_jobs"."started_at" is null
          and "purge_jobs"."verified_at" is null and "purge_jobs"."canceled_at" is null
          and "purge_jobs"."attempt_count" = 0
          and "purge_jobs"."resume_artifact_kind" is null and "purge_jobs"."resume_cursor" is null
          and "purge_jobs"."cancellation_reason_code" is null
          and "purge_jobs"."canceled_by_user_id" is null
          and "purge_jobs"."canceled_by_mutation_id" is null)
        or ("purge_jobs"."state" = 'canceled' and "purge_jobs"."started_at" is null
          and "purge_jobs"."verified_at" is null and "purge_jobs"."canceled_at" is not null
          and "purge_jobs"."attempt_count" = 0
          and "purge_jobs"."resume_artifact_kind" is null and "purge_jobs"."resume_cursor" is null
          and "purge_jobs"."terminal_error_code" is null
          and length(trim("purge_jobs"."cancellation_reason_code")) > 0
          and "purge_jobs"."canceled_by_mutation_id" is not null)
        or ("purge_jobs"."state" in ('blocked', 'running', 'retry_wait', 'failed')
          and "purge_jobs"."started_at" is not null and "purge_jobs"."verified_at" is null
          and "purge_jobs"."canceled_at" is null)
        or ("purge_jobs"."state" = 'verified' and "purge_jobs"."started_at" is not null
          and "purge_jobs"."verified_at" is not null and "purge_jobs"."canceled_at" is null))
);
--> statement-breakpoint
CREATE TABLE "retention_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_version" integer DEFAULT 1 NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"target_kind" "purge_target_kind" NOT NULL,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"share_grant_id" uuid,
	"representation_id" uuid,
	"thread_id" uuid,
	"message_id" uuid,
	"owner_private_replica_id" uuid,
	"logical_memory_id" uuid,
	"trigger" "retention_trigger" NOT NULL,
	"trigger_epoch" bigint DEFAULT 0 NOT NULL,
	"policy_effective_at" timestamp with time zone NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"applicable_legal_hold_ids" uuid[] DEFAULT array[]::uuid[] NOT NULL,
	"eligible" boolean NOT NULL,
	"eligibility_reason_code" text NOT NULL,
	"decision_snapshot_hash" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_decisions_values_check" CHECK ("retention_decisions"."decision_version" > 0
        and "retention_decisions"."trigger_epoch" >= 0
        and "retention_decisions"."policy_version" > 0
        and "retention_decisions"."policy_effective_at" <= "retention_decisions"."triggered_at"
        and "retention_decisions"."retain_until" >= "retention_decisions"."triggered_at"
        and array_position("retention_decisions"."applicable_legal_hold_ids", null) is null
        and length(trim("retention_decisions"."eligibility_reason_code")) > 0
        and length("retention_decisions"."decision_snapshot_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"scope" "retention_policy_scope" NOT NULL,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"share_grant_id" uuid,
	"thread_id" uuid,
	"owner_private_replica_id" uuid,
	"logical_memory_id" uuid,
	"retention_seconds" bigint NOT NULL,
	"deletion_grace_seconds" bigint DEFAULT 0 NOT NULL,
	"backup_retention_seconds" bigint DEFAULT 0 NOT NULL,
	"policy_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_version_unique" UNIQUE("policy_id","version"),
	CONSTRAINT "retention_policies_shortening_identity_unique" UNIQUE("id","policy_id","version","team_id","policy_hash"),
	CONSTRAINT "retention_policies_values_check" CHECK ("retention_policies"."version" > 0
        and "retention_policies"."retention_seconds" >= 0
        and "retention_policies"."deletion_grace_seconds" >= 0
        and "retention_policies"."backup_retention_seconds" >= 0
        and length("retention_policies"."policy_hash") = 64
        and ("retention_policies"."superseded_at" is null or "retention_policies"."superseded_at" > "retention_policies"."effective_at")),
	CONSTRAINT "retention_policies_scope_check" CHECK ((
        "retention_policies"."scope" = 'team'
        and "retention_policies"."team_id" is not null
        and "retention_policies"."team_workspace_id" is null
        and "retention_policies"."share_grant_id" is null
        and "retention_policies"."thread_id" is null
        and "retention_policies"."owner_private_replica_id" is null
        and "retention_policies"."logical_memory_id" is null
      ) or (
        "retention_policies"."scope" = 'workspace'
        and "retention_policies"."team_id" is not null
        and "retention_policies"."team_workspace_id" is not null
        and "retention_policies"."share_grant_id" is null
        and "retention_policies"."thread_id" is null
        and "retention_policies"."owner_private_replica_id" is null
        and "retention_policies"."logical_memory_id" is null
      ) or (
        "retention_policies"."scope" = 'share_grant'
        and "retention_policies"."team_id" is not null
        and "retention_policies"."team_workspace_id" is not null
        and "retention_policies"."share_grant_id" is not null
        and "retention_policies"."thread_id" is null
        and "retention_policies"."owner_private_replica_id" is null
        and "retention_policies"."logical_memory_id" is not null
      ) or (
        "retention_policies"."scope" = 'thread'
        and "retention_policies"."team_id" is not null
        and "retention_policies"."share_grant_id" is null
        and "retention_policies"."thread_id" is not null
        and "retention_policies"."owner_private_replica_id" is null
        and "retention_policies"."logical_memory_id" is null
      ) or (
        "retention_policies"."scope" = 'owner_private_replica'
        and "retention_policies"."team_id" is null
        and "retention_policies"."team_workspace_id" is null
        and "retention_policies"."share_grant_id" is null
        and "retention_policies"."thread_id" is null
        and "retention_policies"."owner_private_replica_id" is not null
        and "retention_policies"."logical_memory_id" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "retention_policy_shortening_affected_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preview_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"retention_decision_id" uuid NOT NULL,
	"target_kind" "purge_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"previous_retain_until" timestamp with time zone NOT NULL,
	"shortened_retain_until" timestamp with time zone NOT NULL,
	"applicable_legal_hold_ids" uuid[] DEFAULT array[]::uuid[] NOT NULL,
	"scope_snapshot_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_shortening_scopes_ordinal_unique" UNIQUE("preview_id","ordinal"),
	CONSTRAINT "retention_policy_shortening_scopes_decision_unique" UNIQUE("preview_id","retention_decision_id"),
	CONSTRAINT "retention_policy_shortening_scopes_identity_unique" UNIQUE("id","preview_id"),
	CONSTRAINT "retention_policy_shortening_scopes_values_check" CHECK ("retention_policy_shortening_affected_scopes"."ordinal" >= 0
        and "retention_policy_shortening_affected_scopes"."shortened_retain_until" < "retention_policy_shortening_affected_scopes"."previous_retain_until"
        and array_position("retention_policy_shortening_affected_scopes"."applicable_legal_hold_ids", null) is null
        and length("retention_policy_shortening_affected_scopes"."scope_snapshot_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "retention_policy_shortening_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preview_id" uuid NOT NULL,
	"affected_scope_id" uuid NOT NULL,
	"previous_retention_decision_id" uuid NOT NULL,
	"migrated_retention_decision_id" uuid NOT NULL,
	"migrated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_shortening_migrations_preview_scope_unique" UNIQUE("preview_id","affected_scope_id"),
	CONSTRAINT "retention_policy_shortening_migrations_previous_unique" UNIQUE("previous_retention_decision_id"),
	CONSTRAINT "retention_policy_shortening_migrations_migrated_unique" UNIQUE("migrated_retention_decision_id"),
	CONSTRAINT "retention_policy_shortening_migrations_decision_check" CHECK ("retention_policy_shortening_migrations"."previous_retention_decision_id" <> "retention_policy_shortening_migrations"."migrated_retention_decision_id")
);
--> statement-breakpoint
CREATE TABLE "retention_policy_shortening_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retention_policy_row_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_hash" text NOT NULL,
	"state" "retention_policy_shortening_state" DEFAULT 'pending' NOT NULL,
	"affected_scope_count" integer NOT NULL,
	"preview_hash" text NOT NULL,
	"previewed_by_user_id" uuid NOT NULL,
	"previewed_at" timestamp with time zone NOT NULL,
	"grace_until" timestamp with time zone NOT NULL,
	"confirmed_by_user_id" uuid,
	"confirmed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_shortening_previews_values_check" CHECK ("retention_policy_shortening_previews"."policy_version" > 0
        and "retention_policy_shortening_previews"."affected_scope_count" >= 0
        and length("retention_policy_shortening_previews"."policy_hash") = 64
        and length("retention_policy_shortening_previews"."preview_hash") = 64
        and "retention_policy_shortening_previews"."grace_until" > "retention_policy_shortening_previews"."previewed_at"),
	CONSTRAINT "retention_policy_shortening_previews_lifecycle_check" CHECK ((
        "retention_policy_shortening_previews"."state" = 'pending'
        and "retention_policy_shortening_previews"."confirmed_by_user_id" is null
        and "retention_policy_shortening_previews"."confirmed_at" is null
        and "retention_policy_shortening_previews"."invalidated_at" is null
        and "retention_policy_shortening_previews"."invalidation_reason_code" is null
      ) or (
        "retention_policy_shortening_previews"."state" = 'confirmed'
        and "retention_policy_shortening_previews"."confirmed_by_user_id" is not null
        and "retention_policy_shortening_previews"."confirmed_at" >= "retention_policy_shortening_previews"."grace_until"
        and "retention_policy_shortening_previews"."invalidated_at" is null
        and "retention_policy_shortening_previews"."invalidation_reason_code" is null
      ) or (
        "retention_policy_shortening_previews"."state" = 'invalidated'
        and "retention_policy_shortening_previews"."confirmed_by_user_id" is null
        and "retention_policy_shortening_previews"."confirmed_at" is null
        and "retention_policy_shortening_previews"."invalidated_at" is not null
        and length(trim("retention_policy_shortening_previews"."invalidation_reason_code")) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "shared_source_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"remote_replica_id" uuid NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_principal_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"artifact_schema_version" integer DEFAULT 1 NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_cursor" bigint NOT NULL,
	"package_sequence" bigint NOT NULL,
	"source_hash" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"artifact_hash" text NOT NULL,
	"redacted_content_hash" text NOT NULL,
	"source_owner_policy_id" uuid NOT NULL,
	"source_owner_policy_version" integer NOT NULL,
	"team_policy_id" uuid NOT NULL,
	"team_policy_version" integer NOT NULL,
	"workspace_policy_id" uuid NOT NULL,
	"workspace_policy_version" integer NOT NULL,
	"representation_policy_revision" integer NOT NULL,
	"representation_policy_hash" text NOT NULL,
	"content_policy_version" integer NOT NULL,
	"content_policy_hash" text NOT NULL,
	"classifier_version" integer NOT NULL,
	"classifier_hash" text NOT NULL,
	"source_deployment_identity_id" uuid NOT NULL,
	"remote_user_identity_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"device_provenance_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "shared_source_artifacts_hash_unique" UNIQUE("artifact_hash"),
	CONSTRAINT "shared_source_artifacts_scope_unique" UNIQUE("id","logical_memory_id","remote_replica_id","team_id","team_workspace_id"),
	CONSTRAINT "shared_source_artifacts_version_check" CHECK ("shared_source_artifacts"."artifact_schema_version" = 1
        and "shared_source_artifacts"."source_revision" >= 0
        and "shared_source_artifacts"."source_cursor" >= 0
        and "shared_source_artifacts"."package_sequence" >= 0
        and "shared_source_artifacts"."source_owner_policy_version" > 0
        and "shared_source_artifacts"."team_policy_version" > 0
        and "shared_source_artifacts"."workspace_policy_version" > 0
        and "shared_source_artifacts"."representation_policy_revision" > 0
        and "shared_source_artifacts"."content_policy_version" > 0
        and "shared_source_artifacts"."classifier_version" > 0),
	CONSTRAINT "shared_source_artifacts_hash_check" CHECK (length("shared_source_artifacts"."source_hash") = 64
        and length("shared_source_artifacts"."manifest_hash") = 64
        and length("shared_source_artifacts"."artifact_hash") = 64
        and length("shared_source_artifacts"."redacted_content_hash") = 64
        and length("shared_source_artifacts"."representation_policy_hash") = 64
        and length("shared_source_artifacts"."content_policy_hash") = 64
        and length("shared_source_artifacts"."classifier_hash") = 64
        and length("shared_source_artifacts"."device_provenance_hash") = 64),
	CONSTRAINT "shared_source_artifacts_revision_binding_check" CHECK ("shared_source_artifacts"."source_revision" = "shared_source_artifacts"."source_cursor")
);
--> statement-breakpoint
CREATE TABLE "shared_source_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"remote_replica_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_principal_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"preview_schema_version" integer DEFAULT 1 NOT NULL,
	"preview_revision" integer DEFAULT 1 NOT NULL,
	"preview_hash" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_hash" text NOT NULL,
	"redacted_content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "shared_source_previews_hash_unique" UNIQUE("preview_hash"),
	CONSTRAINT "shared_source_previews_scope_unique" UNIQUE("id","source_artifact_id","logical_memory_id","remote_replica_id","team_id","team_workspace_id"),
	CONSTRAINT "shared_source_previews_version_check" CHECK ("shared_source_previews"."preview_schema_version" = 1
        and "shared_source_previews"."preview_revision" > 0
        and "shared_source_previews"."source_revision" >= 0),
	CONSTRAINT "shared_source_previews_hash_check" CHECK (length("shared_source_previews"."preview_hash") = 64
        and length("shared_source_previews"."source_hash") = 64
        and length("shared_source_previews"."redacted_content_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "source_owner_representation_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"remote_replica_id" uuid NOT NULL,
	"source_owner_principal_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"source_owner_policy_id" uuid NOT NULL,
	"source_owner_policy_version" integer NOT NULL,
	"team_policy_id" uuid NOT NULL,
	"team_policy_version" integer NOT NULL,
	"workspace_policy_id" uuid NOT NULL,
	"workspace_policy_version" integer NOT NULL,
	"mode" "shared_memory_consent_mode" NOT NULL,
	"state" "shared_memory_consent_state" DEFAULT 'pending' NOT NULL,
	"consent_version" integer DEFAULT 1 NOT NULL,
	"allowed_representations" "shared_memory_representation"[] NOT NULL,
	"selected_representation" "shared_memory_representation" NOT NULL,
	"preview_id" uuid NOT NULL,
	"preview_revision" integer NOT NULL,
	"preview_hash" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"maximum_authorized_source_revision" bigint,
	"source_hash" text NOT NULL,
	"representation_policy_revision" integer NOT NULL,
	"representation_policy_hash" text NOT NULL,
	"content_policy_version" integer NOT NULL,
	"content_policy_hash" text NOT NULL,
	"classifier_version" integer NOT NULL,
	"classifier_hash" text NOT NULL,
	"redacted_content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"state_reason_code" text,
	CONSTRAINT "source_owner_consents_grant_binding_unique" UNIQUE("id","logical_memory_id","remote_replica_id","source_owner_principal_id","team_id","team_workspace_id"),
	CONSTRAINT "source_owner_consents_representation_binding_unique" UNIQUE("id","logical_memory_id","team_id","team_workspace_id"),
	CONSTRAINT "source_owner_consents_version_check" CHECK ("source_owner_representation_consents"."consent_version" > 0),
	CONSTRAINT "source_owner_consents_revision_check" CHECK ("source_owner_representation_consents"."preview_revision" > 0
        and "source_owner_representation_consents"."source_revision" >= 0
        and "source_owner_representation_consents"."representation_policy_revision" > 0
        and "source_owner_representation_consents"."content_policy_version" > 0
        and "source_owner_representation_consents"."classifier_version" > 0
        and "source_owner_representation_consents"."source_owner_policy_version" > 0
        and "source_owner_representation_consents"."team_policy_version" > 0
        and "source_owner_representation_consents"."workspace_policy_version" > 0),
	CONSTRAINT "source_owner_consents_hash_check" CHECK (length("source_owner_representation_consents"."preview_hash") = 64
        and length("source_owner_representation_consents"."source_hash") = 64
        and length("source_owner_representation_consents"."representation_policy_hash") = 64
        and length("source_owner_representation_consents"."content_policy_hash") = 64
        and length("source_owner_representation_consents"."classifier_hash") = 64
        and length("source_owner_representation_consents"."redacted_content_hash") = 64),
	CONSTRAINT "source_owner_consents_allowed_set_check" CHECK (cardinality("source_owner_representation_consents"."allowed_representations") between 1 and 3
        and array_position("source_owner_representation_consents"."allowed_representations", null) is null
        and "source_owner_representation_consents"."selected_representation" = any("source_owner_representation_consents"."allowed_representations")
        and cardinality("source_owner_representation_consents"."allowed_representations") =
          (case when 'memory_events' = any("source_owner_representation_consents"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_leaves' = any("source_owner_representation_consents"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_rollups' = any("source_owner_representation_consents"."allowed_representations") then 1 else 0 end)),
	CONSTRAINT "source_owner_consents_mode_check" CHECK (("source_owner_representation_consents"."mode" = 'snapshot' and "source_owner_representation_consents"."maximum_authorized_source_revision" = "source_owner_representation_consents"."source_revision")
        or ("source_owner_representation_consents"."mode" = 'continuous' and "source_owner_representation_consents"."maximum_authorized_source_revision" is null)),
	CONSTRAINT "source_owner_consents_lifecycle_check" CHECK ((
        "source_owner_representation_consents"."state" = 'pending'
        and "source_owner_representation_consents"."activated_at" is null
        and "source_owner_representation_consents"."paused_at" is null
        and "source_owner_representation_consents"."revoked_at" is null
      ) or (
        "source_owner_representation_consents"."state" = 'active'
        and "source_owner_representation_consents"."activated_at" is not null
        and "source_owner_representation_consents"."paused_at" is null
        and "source_owner_representation_consents"."revoked_at" is null
      ) or (
        "source_owner_representation_consents"."state" = 'paused'
        and "source_owner_representation_consents"."activated_at" is not null
        and "source_owner_representation_consents"."paused_at" is not null
        and "source_owner_representation_consents"."revoked_at" is null
      ) or (
        "source_owner_representation_consents"."state" = 'revoked'
        and "source_owner_representation_consents"."activated_at" is not null
        and "source_owner_representation_consents"."revoked_at" is not null
      ) or (
        "source_owner_representation_consents"."state" = 'expired'
        and "source_owner_representation_consents"."revoked_at" is null
        and "source_owner_representation_consents"."expires_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "source_owner_representation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_owner_principal_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"allowed_representations" "shared_memory_representation"[] NOT NULL,
	"policy_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_owner_representation_policies_version_unique" UNIQUE("policy_id","version"),
	CONSTRAINT "source_owner_representation_policies_scope_unique" UNIQUE("policy_id","version","logical_memory_id","source_owner_principal_id"),
	CONSTRAINT "source_owner_representation_policies_version_check" CHECK ("source_owner_representation_policies"."version" > 0),
	CONSTRAINT "source_owner_representation_policies_allowed_set_check" CHECK (cardinality("source_owner_representation_policies"."allowed_representations") between 1 and 3
        and array_position("source_owner_representation_policies"."allowed_representations", null) is null
        and cardinality("source_owner_representation_policies"."allowed_representations") =
          (case when 'memory_events' = any("source_owner_representation_policies"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_leaves' = any("source_owner_representation_policies"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_rollups' = any("source_owner_representation_policies"."allowed_representations") then 1 else 0 end)),
	CONSTRAINT "source_owner_representation_policies_hash_check" CHECK (length("source_owner_representation_policies"."policy_hash") = 64),
	CONSTRAINT "source_owner_representation_policies_lifecycle_check" CHECK ("source_owner_representation_policies"."superseded_at" is null or "source_owner_representation_policies"."superseded_at" > "source_owner_representation_policies"."effective_at")
);
--> statement-breakpoint
CREATE TABLE "sync_summary_node_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"origin_node_id" uuid NOT NULL,
	"revision_hash" text NOT NULL,
	"local_memory_node_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "sync_summary_node_mappings_revision_unique" UNIQUE("sync_relationship_id","origin_node_id","revision_hash"),
	CONSTRAINT "sync_summary_node_mappings_revision_hash_check" CHECK (length("sync_summary_node_mappings"."revision_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "team_memory_representation_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"representation_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"envelope_version" integer NOT NULL,
	"provider_mode" text NOT NULL,
	"algorithm" text NOT NULL,
	"key_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"tag" text NOT NULL,
	"wrapped_dek" jsonb NOT NULL,
	"aad" jsonb NOT NULL,
	"envelope_created_at" timestamp with time zone NOT NULL,
	"envelope_reencrypted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "team_memory_representation_chunks_index_unique" UNIQUE("representation_id","chunk_index"),
	CONSTRAINT "team_memory_representation_chunks_version_check" CHECK ("team_memory_representation_chunks"."chunk_index" >= 0
        and "team_memory_representation_chunks"."envelope_version" > 0
        and "team_memory_representation_chunks"."key_version" >= 0),
	CONSTRAINT "team_memory_representation_chunks_ciphertext_check" CHECK (length("team_memory_representation_chunks"."algorithm") > 0
        and length("team_memory_representation_chunks"."key_id") > 0
        and length("team_memory_representation_chunks"."ciphertext") > 0
        and length("team_memory_representation_chunks"."ciphertext_hash") = 64
        and length("team_memory_representation_chunks"."nonce") > 0
        and length("team_memory_representation_chunks"."tag") > 0)
);
--> statement-breakpoint
CREATE TABLE "team_memory_representations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"source_preview_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_revision_hash" text NOT NULL,
	"provenance_hash" text NOT NULL,
	"source_owner_policy_id" uuid NOT NULL,
	"source_owner_policy_version" integer NOT NULL,
	"team_policy_id" uuid NOT NULL,
	"team_policy_version" integer NOT NULL,
	"workspace_policy_id" uuid NOT NULL,
	"workspace_policy_version" integer NOT NULL,
	"representation_policy_revision" integer NOT NULL,
	"content_policy_version" integer NOT NULL,
	"classifier_version" integer NOT NULL,
	"record_version" integer DEFAULT 1 NOT NULL,
	"state" "memory_representation_state" DEFAULT 'pending' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"freshness_evaluated_at" timestamp with time zone,
	"available_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	"tombstoned_at" timestamp with time zone,
	"retain_until" timestamp with time zone,
	"purge_completed_at" timestamp with time zone,
	CONSTRAINT "team_memory_representations_revision_unique" UNIQUE("share_grant_id","representation","source_revision","representation_policy_revision","content_policy_version","classifier_version"),
	CONSTRAINT "team_memory_representations_scope_unique" UNIQUE("id","share_grant_id","team_id","team_workspace_id","logical_memory_id"),
	CONSTRAINT "team_memory_representations_exact_scope_unique" UNIQUE("id","share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","source_revision"),
	CONSTRAINT "team_memory_representations_version_check" CHECK ("team_memory_representations"."record_version" > 0
        and "team_memory_representations"."source_revision" >= 0
        and "team_memory_representations"."source_owner_policy_version" > 0
        and "team_memory_representations"."team_policy_version" > 0
        and "team_memory_representations"."workspace_policy_version" > 0
        and "team_memory_representations"."representation_policy_revision" > 0
        and "team_memory_representations"."content_policy_version" > 0
        and "team_memory_representations"."classifier_version" > 0
        and "team_memory_representations"."chunk_count" >= 0),
	CONSTRAINT "team_memory_representations_hash_check" CHECK (length("team_memory_representations"."source_revision_hash") = 64
        and length("team_memory_representations"."provenance_hash") = 64),
	CONSTRAINT "team_memory_representations_lifecycle_check" CHECK ((
        "team_memory_representations"."state" = 'pending'
        and "team_memory_representations"."available_at" is null
        and "team_memory_representations"."stale_at" is null
        and "team_memory_representations"."invalidated_at" is null
        and "team_memory_representations"."tombstoned_at" is null
        and "team_memory_representations"."purge_completed_at" is null
      ) or (
        "team_memory_representations"."state" = 'available'
        and "team_memory_representations"."available_at" is not null
        and "team_memory_representations"."stale_at" is null
        and "team_memory_representations"."invalidated_at" is null
        and "team_memory_representations"."tombstoned_at" is null
        and "team_memory_representations"."purge_completed_at" is null
      ) or (
        "team_memory_representations"."state" = 'stale'
        and "team_memory_representations"."available_at" is not null
        and "team_memory_representations"."stale_at" is not null
        and "team_memory_representations"."invalidated_at" is null
        and "team_memory_representations"."tombstoned_at" is null
        and "team_memory_representations"."purge_completed_at" is null
      ) or (
        "team_memory_representations"."state" = 'invalidated'
        and "team_memory_representations"."invalidated_at" is not null
        and "team_memory_representations"."tombstoned_at" is null
        and "team_memory_representations"."purge_completed_at" is null
      ) or (
        "team_memory_representations"."state" = 'purge_pending'
        and "team_memory_representations"."tombstoned_at" is not null
        and "team_memory_representations"."purge_completed_at" is null
      ) or (
        "team_memory_representations"."state" = 'purged'
        and "team_memory_representations"."tombstoned_at" is not null
        and "team_memory_representations"."purge_completed_at" is not null
      ))
);
--> statement-breakpoint
CREATE TABLE "team_representation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"allowed_representations" "shared_memory_representation"[] NOT NULL,
	"policy_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_representation_policies_version_unique" UNIQUE("policy_id","version"),
	CONSTRAINT "team_representation_policies_scope_unique" UNIQUE("policy_id","version","team_id"),
	CONSTRAINT "team_representation_policies_version_check" CHECK ("team_representation_policies"."version" > 0),
	CONSTRAINT "team_representation_policies_allowed_set_check" CHECK (cardinality("team_representation_policies"."allowed_representations") between 1 and 3
        and array_position("team_representation_policies"."allowed_representations", null) is null
        and cardinality("team_representation_policies"."allowed_representations") =
          (case when 'memory_events' = any("team_representation_policies"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_leaves' = any("team_representation_policies"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_rollups' = any("team_representation_policies"."allowed_representations") then 1 else 0 end)),
	CONSTRAINT "team_representation_policies_hash_check" CHECK (length("team_representation_policies"."policy_hash") = 64),
	CONSTRAINT "team_representation_policies_lifecycle_check" CHECK ("team_representation_policies"."superseded_at" is null or "team_representation_policies"."superseded_at" > "team_representation_policies"."effective_at")
);
--> statement-breakpoint
CREATE TABLE "workspace_representation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"allowed_representations" "shared_memory_representation"[] NOT NULL,
	"policy_hash" text NOT NULL,
	"created_by_user_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_representation_policies_version_unique" UNIQUE("policy_id","version"),
	CONSTRAINT "workspace_representation_policies_scope_unique" UNIQUE("policy_id","version","team_id","team_workspace_id"),
	CONSTRAINT "workspace_representation_policies_version_check" CHECK ("workspace_representation_policies"."version" > 0),
	CONSTRAINT "workspace_representation_policies_allowed_set_check" CHECK (cardinality("workspace_representation_policies"."allowed_representations") between 1 and 3
        and array_position("workspace_representation_policies"."allowed_representations", null) is null
        and cardinality("workspace_representation_policies"."allowed_representations") =
          (case when 'memory_events' = any("workspace_representation_policies"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_leaves' = any("workspace_representation_policies"."allowed_representations") then 1 else 0 end)
          + (case when 'lcm_rollups' = any("workspace_representation_policies"."allowed_representations") then 1 else 0 end)),
	CONSTRAINT "workspace_representation_policies_hash_check" CHECK (length("workspace_representation_policies"."policy_hash") = 64),
	CONSTRAINT "workspace_representation_policies_lifecycle_check" CHECK ("workspace_representation_policies"."superseded_at" is null or "workspace_representation_policies"."superseded_at" > "workspace_representation_policies"."effective_at")
);
--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_owner_key_unique";--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" DROP CONSTRAINT "encrypted_field_backfill_runs_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_scope_owner_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_encryption_scope_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP CONSTRAINT "memory_replicas_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_workspace_team_fk";
--> statement-breakpoint
DROP INDEX "team_session_share_grants_active_unique";--> statement-breakpoint
DROP INDEX "logical_memories_owner_boundary_idx";--> statement-breakpoint
DROP INDEX "memory_replicas_owner_status_idx";--> statement-breakpoint
DROP INDEX "team_session_share_grants_owner_idx";--> statement-breakpoint
DROP INDEX "team_workspaces_team_idx";--> statement-breakpoint
DROP INDEX "teams_active_idx";--> statement-breakpoint
ALTER TABLE "logical_memories" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_replicas" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "state_before_pause" "sync_relationship_state";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "source_summary_revision_hash" text;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "target_summary_revision_hash" text;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "protocol_logical_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "latest_source_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "lifecycle" "memory_replica_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "purge_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "latest_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "lifecycle" "memory_replica_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "encryption_scope" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "representation_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "content_policy_version" integer;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "purge_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_billing_seat_states" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "default_team_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "default_workspace_access" "team_workspace_access" DEFAULT 'write' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "normalized_email" text;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "backend_origin_hash" text;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_invites" ADD COLUMN "lifecycle" "invite_lifecycle" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "logical_grant_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "logical_memory_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "remote_replica_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "consent_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_owner_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_owner_policy_version" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "team_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "team_policy_version" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "workspace_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "workspace_policy_version" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "owner_allowed_representations" "shared_memory_representation"[];--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "active_representation" "shared_memory_representation";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "representation_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "content_policy_version" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "classifier_version" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "source_revision" bigint;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "grant_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "revocation_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "lifecycle" "share_grant_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "creator_authority" text;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "retention_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "retention_policy_version" integer;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "retention_triggered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "active_retention_decision_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "active_purge_job_id" uuid;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "purge_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD COLUMN "can_share_owned_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "description_marker" text;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "lifecycle" "workspace_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "retention_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "retention_policy_version" integer;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD COLUMN "purge_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "created_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "creation_idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "creation_request_hash" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "lifecycle" "team_lifecycle" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "tombstoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "retain_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "purge_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_reference" text;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_id_owner_backend_unique" UNIQUE("id","owner_user_id","upstream_backend_id");--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_protocol_id_unique" UNIQUE("protocol_logical_id");--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_owner_key_unique" UNIQUE("owner_principal_id","logical_key");--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_logical_owner_principal_unique" UNIQUE("id","logical_memory_id","owner_principal_id");--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_logical_id_unique" UNIQUE("logical_grant_id");--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_scope_unique" UNIQUE("id","team_id","team_workspace_id","logical_memory_id");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_id_lifecycle_unique" UNIQUE("id","lifecycle");--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_thread_scope_fk" FOREIGN KEY ("thread_id","scope") REFERENCES "public"."collaboration_threads"("id","scope") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_personal_owner_fk" FOREIGN KEY ("thread_id","personal_owner_user_id") REFERENCES "public"."collaboration_threads"("id","personal_owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_thread_team_fk" FOREIGN KEY ("thread_id","team_id") REFERENCES "public"."collaboration_threads"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_thread_workspace_fk" FOREIGN KEY ("thread_id","team_workspace_id") REFERENCES "public"."collaboration_threads"("id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_messages" ADD CONSTRAINT "collaboration_messages_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_outbox" ADD CONSTRAINT "collaboration_outbox_thread_message_fk" FOREIGN KEY ("thread_id","message_id") REFERENCES "public"."collaboration_messages"("thread_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_outbox" ADD CONSTRAINT "collaboration_outbox_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_thread_scope_fk" FOREIGN KEY ("thread_id","scope","thread_kind") REFERENCES "public"."collaboration_threads"("id","scope","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_personal_owner_fk" FOREIGN KEY ("thread_id","personal_owner_user_id") REFERENCES "public"."collaboration_threads"("id","personal_owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_thread_team_fk" FOREIGN KEY ("thread_id","team_id") REFERENCES "public"."collaboration_threads"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_participants" ADD CONSTRAINT "collaboration_participants_membership_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_memberships"("team_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_read_states" ADD CONSTRAINT "collaboration_read_states_thread_id_collaboration_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."collaboration_threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_read_states" ADD CONSTRAINT "collaboration_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_read_states" ADD CONSTRAINT "collaboration_read_states_same_thread_message_fk" FOREIGN KEY ("thread_id","last_read_message_id","last_read_sequence") REFERENCES "public"."collaboration_messages"("thread_id","id","thread_sequence") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_replay_watermarks" ADD CONSTRAINT "collaboration_replay_watermarks_personal_owner_user_id_users_id_fk" FOREIGN KEY ("personal_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_replay_watermarks" ADD CONSTRAINT "collaboration_replay_watermarks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_companion_bindings" ADD CONSTRAINT "collaboration_shared_memory_companion_bindings_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" ADD CONSTRAINT "collaboration_shared_memory_consents_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" ADD CONSTRAINT "csm_consents_preview_binding_fk" FOREIGN KEY ("enrollment_id","preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision") REFERENCES "public"."collaboration_shared_memory_previews"("enrollment_id","preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_enrollments" ADD CONSTRAINT "collaboration_shared_memory_enrollments_local_owner_user_id_users_id_fk" FOREIGN KEY ("local_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" ADD CONSTRAINT "collaboration_shared_memory_grants_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" ADD CONSTRAINT "csm_grants_companion_binding_fk" FOREIGN KEY ("companion_binding_id","enrollment_id","share_grant_id","logical_memory_id","team_id","team_workspace_id") REFERENCES "public"."collaboration_shared_memory_companion_bindings"("id","enrollment_id","share_grant_id","logical_memory_id","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD CONSTRAINT "collaboration_shared_memory_previews_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD CONSTRAINT "collaboration_shared_memory_previews_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_stream_subscriptions" ADD CONSTRAINT "collaboration_stream_subscriptions_device_credential_id_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_stream_subscriptions" ADD CONSTRAINT "collaboration_stream_subscriptions_personal_owner_user_id_users_id_fk" FOREIGN KEY ("personal_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_stream_subscriptions" ADD CONSTRAINT "collaboration_stream_subscriptions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_stream_subscriptions" ADD CONSTRAINT "collaboration_stream_subscriptions_ack_fk" FOREIGN KEY ("acknowledged_event_id","acknowledged_cursor") REFERENCES "public"."collaboration_outbox"("id","cursor") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_personal_owner_user_id_users_id_fk" FOREIGN KEY ("personal_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_shared_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("shared_logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_share_grant_id_team_session_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_session_share_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_threads" ADD CONSTRAINT "collaboration_threads_share_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","shared_logical_memory_id") REFERENCES "public"."team_session_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_action_grant_execution_receipts" ADD CONSTRAINT "high_risk_action_grant_execution_receipts_action_grant_id_high_risk_device_action_grants_id_fk" FOREIGN KEY ("action_grant_id") REFERENCES "public"."high_risk_device_action_grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_action_grant_execution_receipts" ADD CONSTRAINT "high_risk_action_grant_execution_receipts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_browser_confirmations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_browser_confirmations_decision_user_session_id_user_sessions_id_fk" FOREIGN KEY ("decision_user_session_id") REFERENCES "public"."user_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_browser_confirmations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_browser_confirmations" ADD CONSTRAINT "high_risk_confirmations_device_binding_fk" FOREIGN KEY ("device_credential_id","owner_user_id","upstream_backend_id") REFERENCES "public"."device_credentials"("id","owner_user_id","upstream_backend_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_device_action_grants" ADD CONSTRAINT "high_risk_device_action_grants_confirmation_id_high_risk_browser_confirmations_id_fk" FOREIGN KEY ("confirmation_id") REFERENCES "public"."high_risk_browser_confirmations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_device_action_grants" ADD CONSTRAINT "high_risk_device_action_grants_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_device_action_grants" ADD CONSTRAINT "high_risk_device_action_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "high_risk_device_action_grants" ADD CONSTRAINT "high_risk_action_grants_device_binding_fk" FOREIGN KEY ("device_credential_id","owner_user_id","upstream_backend_id") REFERENCES "public"."device_credentials"("id","owner_user_id","upstream_backend_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_owner_private_replica_id_memory_replicas_id_fk" FOREIGN KEY ("owner_private_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_placed_by_user_id_users_id_fk" FOREIGN KEY ("placed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_release_requested_by_user_id_users_id_fk" FOREIGN KEY ("release_requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_release_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("release_confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_thread_team_fk" FOREIGN KEY ("thread_id","team_id") REFERENCES "public"."collaboration_threads"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_representation_scope_fk" FOREIGN KEY ("representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","source_revision") REFERENCES "public"."team_memory_representations"("id","share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_job_attempts" ADD CONSTRAINT "purge_job_attempts_purge_job_id_purge_jobs_id_fk" FOREIGN KEY ("purge_job_id") REFERENCES "public"."purge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_job_evidence" ADD CONSTRAINT "purge_job_evidence_purge_job_id_purge_jobs_id_fk" FOREIGN KEY ("purge_job_id") REFERENCES "public"."purge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_job_evidence" ADD CONSTRAINT "purge_job_evidence_purge_attempt_id_purge_job_attempts_id_fk" FOREIGN KEY ("purge_attempt_id") REFERENCES "public"."purge_job_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_retention_decision_id_retention_decisions_id_fk" FOREIGN KEY ("retention_decision_id") REFERENCES "public"."retention_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_canceled_by_user_id_users_id_fk" FOREIGN KEY ("canceled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purge_jobs" ADD CONSTRAINT "purge_jobs_representation_scope_fk" FOREIGN KEY ("representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decisions" ADD CONSTRAINT "retention_decisions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decisions" ADD CONSTRAINT "retention_decisions_owner_private_replica_id_memory_replicas_id_fk" FOREIGN KEY ("owner_private_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decisions" ADD CONSTRAINT "retention_decisions_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decisions" ADD CONSTRAINT "retention_decisions_policy_fk" FOREIGN KEY ("policy_id","policy_version") REFERENCES "public"."retention_policies"("policy_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decisions" ADD CONSTRAINT "retention_decisions_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_decisions" ADD CONSTRAINT "retention_decisions_representation_scope_fk" FOREIGN KEY ("representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_owner_private_replica_id_memory_replicas_id_fk" FOREIGN KEY ("owner_private_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_grant_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_session_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_thread_team_fk" FOREIGN KEY ("thread_id","team_id") REFERENCES "public"."collaboration_threads"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_affected_scopes" ADD CONSTRAINT "retention_policy_shortening_affected_scopes_preview_id_retention_policy_shortening_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."retention_policy_shortening_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_affected_scopes" ADD CONSTRAINT "retention_policy_shortening_affected_scopes_retention_decision_id_retention_decisions_id_fk" FOREIGN KEY ("retention_decision_id") REFERENCES "public"."retention_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_migrations" ADD CONSTRAINT "retention_policy_shortening_migrations_preview_id_retention_policy_shortening_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."retention_policy_shortening_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_migrations" ADD CONSTRAINT "retention_policy_shortening_migrations_migrated_retention_decision_id_retention_decisions_id_fk" FOREIGN KEY ("migrated_retention_decision_id") REFERENCES "public"."retention_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_migrations" ADD CONSTRAINT "retention_policy_shortening_migrations_scope_fk" FOREIGN KEY ("affected_scope_id","preview_id") REFERENCES "public"."retention_policy_shortening_affected_scopes"("id","preview_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_migrations" ADD CONSTRAINT "retention_policy_shortening_migrations_previous_decision_fk" FOREIGN KEY ("preview_id","previous_retention_decision_id") REFERENCES "public"."retention_policy_shortening_affected_scopes"("preview_id","retention_decision_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_previews" ADD CONSTRAINT "retention_policy_shortening_previews_previewed_by_user_id_users_id_fk" FOREIGN KEY ("previewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_previews" ADD CONSTRAINT "retention_policy_shortening_previews_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy_shortening_previews" ADD CONSTRAINT "retention_policy_shortening_previews_policy_fk" FOREIGN KEY ("retention_policy_row_id","policy_id","policy_version","team_id","policy_hash") REFERENCES "public"."retention_policies"("id","policy_id","version","team_id","policy_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_remote_replica_id_memory_replicas_id_fk" FOREIGN KEY ("remote_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_source_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("source_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_remote_user_identity_id_sync_external_user_identities_id_fk" FOREIGN KEY ("remote_user_identity_id") REFERENCES "public"."sync_external_user_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_device_credential_id_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_owner_policy_fk" FOREIGN KEY ("source_owner_policy_id","source_owner_policy_version","logical_memory_id","owner_principal_id") REFERENCES "public"."source_owner_representation_policies"("policy_id","version","logical_memory_id","source_owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_team_policy_fk" FOREIGN KEY ("team_policy_id","team_policy_version","team_id") REFERENCES "public"."team_representation_policies"("policy_id","version","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_workspace_policy_fk" FOREIGN KEY ("workspace_policy_id","workspace_policy_version","team_id","team_workspace_id") REFERENCES "public"."workspace_representation_policies"("policy_id","version","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_source_artifact_id_shared_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."shared_source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_remote_replica_id_memory_replicas_id_fk" FOREIGN KEY ("remote_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_representation_consents_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_representation_consents_remote_replica_id_memory_replicas_id_fk" FOREIGN KEY ("remote_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_representation_consents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_representation_consents_preview_id_shared_source_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."shared_source_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_owner_policy_fk" FOREIGN KEY ("source_owner_policy_id","source_owner_policy_version","logical_memory_id","source_owner_principal_id") REFERENCES "public"."source_owner_representation_policies"("policy_id","version","logical_memory_id","source_owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_team_policy_fk" FOREIGN KEY ("team_policy_id","team_policy_version","team_id") REFERENCES "public"."team_representation_policies"("policy_id","version","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_workspace_policy_fk" FOREIGN KEY ("workspace_policy_id","workspace_policy_version","team_id","team_workspace_id") REFERENCES "public"."workspace_representation_policies"("policy_id","version","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" ADD CONSTRAINT "source_owner_representation_policies_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" ADD CONSTRAINT "source_owner_representation_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_summary_node_mappings" ADD CONSTRAINT "sync_summary_node_mappings_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_summary_node_mappings" ADD CONSTRAINT "sync_summary_node_mappings_local_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("local_memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representation_chunks" ADD CONSTRAINT "team_memory_representation_chunks_scope_fk" FOREIGN KEY ("representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_source_preview_id_shared_source_previews_id_fk" FOREIGN KEY ("source_preview_id") REFERENCES "public"."shared_source_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_source_artifact_id_shared_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."shared_source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_grant_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_session_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_consent_scope_fk" FOREIGN KEY ("consent_id","logical_memory_id","team_id","team_workspace_id") REFERENCES "public"."source_owner_representation_consents"("id","logical_memory_id","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_owner_policy_fk" FOREIGN KEY ("source_owner_policy_id","source_owner_policy_version") REFERENCES "public"."source_owner_representation_policies"("policy_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_team_policy_fk" FOREIGN KEY ("team_policy_id","team_policy_version","team_id") REFERENCES "public"."team_representation_policies"("policy_id","version","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_workspace_policy_fk" FOREIGN KEY ("workspace_policy_id","workspace_policy_version","team_id","team_workspace_id") REFERENCES "public"."workspace_representation_policies"("policy_id","version","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_representation_policies" ADD CONSTRAINT "team_representation_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_representation_policies" ADD CONSTRAINT "team_representation_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD CONSTRAINT "workspace_representation_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD CONSTRAINT "workspace_representation_policies_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD CONSTRAINT "workspace_representation_policies_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_messages_idempotency_unique" ON "collaboration_messages" USING btree ("thread_id","sender_principal_id","idempotency_key_hash") WHERE "collaboration_messages"."idempotency_key_hash" is not null;--> statement-breakpoint
CREATE INDEX "collaboration_messages_thread_sequence_idx" ON "collaboration_messages" USING btree ("thread_id","thread_sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collaboration_outbox_replay_idx" ON "collaboration_outbox" USING btree ("cursor","replay_until");--> statement-breakpoint
CREATE INDEX "collaboration_outbox_team_idx" ON "collaboration_outbox" USING btree ("team_id","cursor");--> statement-breakpoint
CREATE INDEX "collaboration_outbox_thread_idx" ON "collaboration_outbox" USING btree ("thread_id","cursor");--> statement-breakpoint
CREATE INDEX "collaboration_participants_user_idx" ON "collaboration_participants" USING btree ("user_id","joined_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collaboration_read_states_user_idx" ON "collaboration_read_states" USING btree ("user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_replay_watermarks_personal_unique" ON "collaboration_replay_watermarks" USING btree ("personal_owner_user_id") WHERE "collaboration_replay_watermarks"."scope" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_replay_watermarks_team_unique" ON "collaboration_replay_watermarks" USING btree ("team_id") WHERE "collaboration_replay_watermarks"."scope" = 'team';--> statement-breakpoint
CREATE UNIQUE INDEX "csm_companion_bindings_active_grant_unique" ON "collaboration_shared_memory_companion_bindings" USING btree ("enrollment_id","share_grant_id") WHERE "collaboration_shared_memory_companion_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "csm_companion_bindings_active_session_unique" ON "collaboration_shared_memory_companion_bindings" USING btree ("enrollment_id","shared_session_id") WHERE "collaboration_shared_memory_companion_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "csm_companion_bindings_active_thread_unique" ON "collaboration_shared_memory_companion_bindings" USING btree ("enrollment_id","companion_thread_id") WHERE "collaboration_shared_memory_companion_bindings"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "csm_consents_current_idx" ON "collaboration_shared_memory_consents" USING btree ("enrollment_id","consent_id","consent_version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "csm_consents_preview_idx" ON "collaboration_shared_memory_consents" USING btree ("enrollment_id","preview_id","preview_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "csm_enrollments_active_owner_backend_unique" ON "collaboration_shared_memory_enrollments" USING btree ("local_owner_user_id","backend_id") WHERE "collaboration_shared_memory_enrollments"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "csm_enrollments_active_remote_identity_unique" ON "collaboration_shared_memory_enrollments" USING btree ("backend_id","upstream_user_id","remote_device_id") WHERE "collaboration_shared_memory_enrollments"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "csm_grants_current_idx" ON "collaboration_shared_memory_grants" USING btree ("enrollment_id","share_grant_id","grant_version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "csm_grants_session_read_idx" ON "collaboration_shared_memory_grants" USING btree ("companion_binding_id","grant_version" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "csm_previews_owner_hash_idx" ON "collaboration_shared_memory_previews" USING btree ("enrollment_id","preview_hash");--> statement-breakpoint
CREATE INDEX "collaboration_stream_subscriptions_principal_idx" ON "collaboration_stream_subscriptions" USING btree ("backend_identity_hash","principal_id_hash","state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collaboration_stream_subscriptions_device_idx" ON "collaboration_stream_subscriptions" USING btree ("device_credential_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_notes_owner_unique" ON "collaboration_threads" USING btree ("personal_owner_user_id") WHERE "collaboration_threads"."kind" = 'notes_to_self';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_participant_key_unique" ON "collaboration_threads" USING btree ("team_id","participant_key") WHERE "collaboration_threads"."kind" in ('dm', 'group_dm');--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_personal_channel_active_unique" ON "collaboration_threads" USING btree ("personal_owner_user_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'personal_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_workspace_channel_active_unique" ON "collaboration_threads" USING btree ("team_workspace_id","normalized_name_hash") WHERE "collaboration_threads"."kind" = 'workspace_channel' and "collaboration_threads"."lifecycle" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_workspace_system_key_unique" ON "collaboration_threads" USING btree ("team_workspace_id","system_key") WHERE "collaboration_threads"."system_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_companion_unique" ON "collaboration_threads" USING btree ("team_workspace_id","shared_logical_memory_id") WHERE "collaboration_threads"."kind" = 'shared_session_discussion';--> statement-breakpoint
CREATE INDEX "collaboration_threads_team_activity_idx" ON "collaboration_threads" USING btree ("team_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collaboration_threads_personal_activity_idx" ON "collaboration_threads" USING btree ("personal_owner_user_id","last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "high_risk_action_grant_execution_receipts_owner_idx" ON "high_risk_action_grant_execution_receipts" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "high_risk_confirmations_active_idx" ON "high_risk_browser_confirmations" USING btree ("owner_user_id","expires_at") WHERE "high_risk_browser_confirmations"."state" in ('pending', 'approved');--> statement-breakpoint
CREATE INDEX "high_risk_action_grants_active_idx" ON "high_risk_device_action_grants" USING btree ("device_credential_id","expires_at") WHERE "high_risk_device_action_grants"."state" = 'active';--> statement-breakpoint
CREATE INDEX "legal_holds_active_team_idx" ON "legal_holds" USING btree ("team_id","scope","placed_at" DESC NULLS LAST) WHERE "legal_holds"."state" <> 'released';--> statement-breakpoint
CREATE INDEX "local_edge_collaboration_subscriptions_active_idx" ON "local_edge_collaboration_subscriptions" USING btree ("upstream_backend_id","state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "purge_job_evidence_state_idx" ON "purge_job_evidence" USING btree ("purge_job_id","state","artifact_kind");--> statement-breakpoint
CREATE INDEX "purge_jobs_resume_idx" ON "purge_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "retention_decisions_target_idx" ON "retention_decisions" USING btree ("target_kind","team_id","retain_until");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_decisions_share_revocation_epoch_unique" ON "retention_decisions" USING btree ("share_grant_id","trigger_epoch") WHERE "retention_decisions"."target_kind" = 'share_grant' and "retention_decisions"."trigger" = 'share_revoked';--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_active_scope_unique" ON "retention_policies" USING btree ("scope",coalesce("team_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("team_workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("share_grant_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("thread_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("owner_private_replica_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "retention_policies"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "retention_policy_shortening_previews_pending_idx" ON "retention_policy_shortening_previews" USING btree ("state","grace_until","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_source_artifacts_current_unique" ON "shared_source_artifacts" USING btree ("logical_memory_id","remote_replica_id","team_id","team_workspace_id","representation","source_revision","artifact_hash");--> statement-breakpoint
CREATE INDEX "shared_source_artifacts_owner_idx" ON "shared_source_artifacts" USING btree ("owner_principal_id","representation","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shared_source_previews_artifact_unique" ON "shared_source_previews" USING btree ("source_artifact_id","preview_hash");--> statement-breakpoint
CREATE INDEX "shared_source_previews_owner_idx" ON "shared_source_previews" USING btree ("owner_principal_id","representation","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "source_owner_consents_owner_state_idx" ON "source_owner_representation_consents" USING btree ("source_owner_principal_id","state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "source_owner_representation_policies_active_unique" ON "source_owner_representation_policies" USING btree ("logical_memory_id","source_owner_principal_id") WHERE "source_owner_representation_policies"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "source_owner_representation_policies_history_idx" ON "source_owner_representation_policies" USING btree ("logical_memory_id","source_owner_principal_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sync_summary_node_mappings_active_origin_unique" ON "sync_summary_node_mappings" USING btree ("sync_relationship_id","origin_node_id") WHERE "sync_summary_node_mappings"."active" = true;--> statement-breakpoint
CREATE INDEX "sync_summary_node_mappings_local_node_idx" ON "sync_summary_node_mappings" USING btree ("local_memory_node_id");--> statement-breakpoint
CREATE INDEX "team_memory_representation_chunks_grant_idx" ON "team_memory_representation_chunks" USING btree ("share_grant_id","representation_id","chunk_index");--> statement-breakpoint
CREATE INDEX "team_memory_representations_grant_state_idx" ON "team_memory_representations" USING btree ("share_grant_id","state","source_revision" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "team_representation_policies_active_unique" ON "team_representation_policies" USING btree ("team_id") WHERE "team_representation_policies"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "team_representation_policies_history_idx" ON "team_representation_policies" USING btree ("team_id","version" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_representation_policies_active_unique" ON "workspace_representation_policies" USING btree ("team_workspace_id") WHERE "workspace_representation_policies"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "workspace_representation_policies_history_idx" ON "workspace_representation_policies" USING btree ("team_workspace_id","version" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_default_workspace_team_fk" FOREIGN KEY ("default_team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_remote_replica_id_memory_replicas_id_fk" FOREIGN KEY ("remote_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_active_retention_decision_id_retention_decisions_id_fk" FOREIGN KEY ("active_retention_decision_id") REFERENCES "public"."retention_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_active_purge_job_id_purge_jobs_id_fk" FOREIGN KEY ("active_purge_job_id") REFERENCES "public"."purge_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_consent_scope_fk" FOREIGN KEY ("consent_id","logical_memory_id","remote_replica_id","owner_principal_id","team_id","team_workspace_id") REFERENCES "public"."source_owner_representation_consents"("id","logical_memory_id","remote_replica_id","source_owner_principal_id","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_owner_policy_fk" FOREIGN KEY ("source_owner_policy_id","source_owner_policy_version","logical_memory_id","owner_principal_id") REFERENCES "public"."source_owner_representation_policies"("policy_id","version","logical_memory_id","source_owner_principal_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_team_policy_fk" FOREIGN KEY ("team_policy_id","team_policy_version","team_id") REFERENCES "public"."team_representation_policies"("policy_id","version","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_workspace_policy_fk" FOREIGN KEY ("workspace_policy_id","workspace_policy_version","team_id","team_workspace_id") REFERENCES "public"."workspace_representation_policies"("policy_id","version","team_id","team_workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_nodes_session_kind_idx" ON "memory_nodes" USING btree ("owner_user_id","session_id","kind","created_at") WHERE "memory_nodes"."session_id" is not null and "memory_nodes"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "team_invites_team_lifecycle_idx" ON "team_invites" USING btree ("team_id","lifecycle","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "team_session_share_grants_destination_unique" ON "team_session_share_grants" USING btree ("logical_memory_id","team_workspace_id") WHERE "team_session_share_grants"."logical_memory_id" is not null;--> statement-breakpoint
CREATE INDEX "team_workspaces_lifecycle_idx" ON "team_workspaces" USING btree ("team_id","lifecycle","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "teams_creator_idempotency_unique" ON "teams" USING btree ("created_by_user_id","creation_idempotency_key_hash") WHERE "teams"."creation_idempotency_key_hash" is not null;--> statement-breakpoint
CREATE INDEX "teams_lifecycle_idx" ON "teams" USING btree ("lifecycle","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "logical_memories_owner_boundary_idx" ON "logical_memories" USING btree ("owner_principal_id","source_boundary","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "memory_replicas_owner_status_idx" ON "memory_replicas" USING btree ("owner_principal_id","freshness_status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_session_share_grants_owner_idx" ON "team_session_share_grants" USING btree ("owner_principal_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_workspaces_team_idx" ON "team_workspaces" USING btree ("team_id","created_at" DESC NULLS LAST) WHERE "team_workspaces"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX "teams_active_idx" ON "teams" USING btree ("created_at" DESC NULLS LAST) WHERE "teams"."lifecycle" = 'active';--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP COLUMN "policy_manifest";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_summary_hashes_check" CHECK (("cross_identity_sync_relationships"."source_summary_revision_hash" is null or length("cross_identity_sync_relationships"."source_summary_revision_hash") = 64)
        and ("cross_identity_sync_relationships"."target_summary_revision_hash" is null or length("cross_identity_sync_relationships"."target_summary_revision_hash") = 64));--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_pause_state_check" CHECK (("cross_identity_sync_relationships"."state" = 'paused'
        and "cross_identity_sync_relationships"."side" = 'source'
        and "cross_identity_sync_relationships"."paused_at" is not null
        and "cross_identity_sync_relationships"."state_before_pause" in ('created', 'uploading', 'uploaded', 'verified', 'processing', 'partially_available', 'ready', 'stale')
        and "cross_identity_sync_relationships"."revoked_at" is null)
        or ("cross_identity_sync_relationships"."state" <> 'paused'
          and "cross_identity_sync_relationships"."paused_at" is null
          and "cross_identity_sync_relationships"."state_before_pause" is null));--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_operation_families_check" CHECK (array_position("device_credentials"."operation_families", null) is null
        and cardinality("device_credentials"."operation_families") > 0
        and array_to_string("device_credentials"."operation_families", ',')
          ~ '^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$');--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD CONSTRAINT "device_enrollment_challenges_operation_families_check" CHECK (array_position("device_enrollment_challenges"."requested_operation_families", null) is null
        and cardinality("device_enrollment_challenges"."requested_operation_families") > 0
        and array_to_string("device_enrollment_challenges"."requested_operation_families", ',')
          ~ '^[A-Za-z0-9_.:-]+(,[A-Za-z0-9_.:-]+)*$');--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" ADD CONSTRAINT "encrypted_field_backfill_runs_source_table_check" CHECK ("encrypted_field_backfill_runs"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'collaboration_messages',
        'collaboration_threads',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'memory_replica_revisions',
        'messages',
        'shared_source_artifacts',
        'shared_source_previews',
        'team_memory_representations',
        'tool_events'
      ));--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_scope_owner_check" CHECK ((
        "encrypted_field_payloads"."encryption_scope" = 'personal'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."owner_user_id" is not null
        and "encrypted_field_payloads"."owner_principal_id" is null
        and "encrypted_field_payloads"."team_id" is null
        and "encrypted_field_payloads"."team_workspace_id" is null
      ) or (
        "encrypted_field_payloads"."encryption_scope" = 'team'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."team_id" is not null
        and "encrypted_field_payloads"."owner_principal_id" is null
      ) or (
        "encrypted_field_payloads"."encryption_scope" = 'owner_private_replica'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."owner_principal_id" is not null
        and "encrypted_field_payloads"."team_id" is null
        and "encrypted_field_payloads"."team_workspace_id" is null
      ));--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_encryption_scope_check" CHECK ("encrypted_field_payloads"."encryption_scope" in ('personal', 'team', 'owner_private_replica'));--> statement-breakpoint
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
        'memory_replica_revisions',
        'messages',
        'shared_source_artifacts',
        'shared_source_previews',
        'team_workspaces',
        'team_memory_representations',
        'tool_events'
      ));--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_owner_version_check" CHECK ("logical_memories"."owner_principal_id" is not null
        and "logical_memories"."version" > 0
        and "logical_memories"."latest_source_revision" >= 0);--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_lifecycle_check" CHECK (("logical_memories"."lifecycle" in ('active', 'stale', 'revoked') and "logical_memories"."purge_completed_at" is null)
        or ("logical_memories"."lifecycle" in ('tombstoned', 'purge_pending') and "logical_memories"."tombstoned_at" is not null and "logical_memories"."purge_completed_at" is null)
        or ("logical_memories"."lifecycle" = 'purged' and "logical_memories"."tombstoned_at" is not null and "logical_memories"."purge_completed_at" is not null));--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_owner_version_check" CHECK ("memory_replicas"."owner_principal_id" is not null
        and "memory_replicas"."version" > 0
        and "memory_replicas"."latest_revision" >= 0);--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_encryption_scope_check" CHECK (("memory_replicas"."replica_role" = 'source' and "memory_replicas"."encryption_scope" = 'personal')
        or ("memory_replicas"."replica_role" = 'target' and "memory_replicas"."encryption_scope" = 'owner_private_replica'));--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_policy_revision_check" CHECK (("memory_replicas"."representation_policy_revision" is null and "memory_replicas"."content_policy_version" is null)
        or ("memory_replicas"."representation_policy_revision" > 0 and "memory_replicas"."content_policy_version" > 0));--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_lifecycle_check" CHECK (("memory_replicas"."lifecycle" in ('active', 'stale', 'revoked') and "memory_replicas"."purge_completed_at" is null)
        or ("memory_replicas"."lifecycle" in ('tombstoned', 'purge_pending') and "memory_replicas"."tombstoned_at" is not null and "memory_replicas"."purge_completed_at" is null)
        or ("memory_replicas"."lifecycle" = 'purged' and "memory_replicas"."tombstoned_at" is not null and "memory_replicas"."purge_completed_at" is not null));--> statement-breakpoint
ALTER TABLE "team_billing_seat_states" ADD CONSTRAINT "team_billing_seat_states_version_check" CHECK ("team_billing_seat_states"."version" > 0);--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_version_check" CHECK ("team_invites"."version" > 0);--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_binding_check" CHECK ("team_invites"."default_team_workspace_id" is not null
        and "team_invites"."normalized_email" is not null
        and length(trim("team_invites"."normalized_email")) > 0
        and "team_invites"."normalized_email" = lower(trim("team_invites"."email"))
        and "team_invites"."backend_origin_hash" is not null
        and length("team_invites"."backend_origin_hash") = 64
        and "team_invites"."default_workspace_access" in ('read', 'write'));--> statement-breakpoint
ALTER TABLE "team_invites" ADD CONSTRAINT "team_invites_lifecycle_shape_check" CHECK ((
        "team_invites"."lifecycle" = 'pending'
        and "team_invites"."accepted_at" is null
        and "team_invites"."revoked_at" is null
      ) or (
        "team_invites"."lifecycle" = 'accepted'
        and "team_invites"."accepted_at" is not null
        and "team_invites"."revoked_at" is null
      ) or (
        "team_invites"."lifecycle" = 'revoked'
        and "team_invites"."accepted_at" is null
        and "team_invites"."revoked_at" is not null
      ) or (
        "team_invites"."lifecycle" = 'expired'
        and "team_invites"."accepted_at" is null
        and "team_invites"."revoked_at" is null
      ));--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_version_check" CHECK ("team_memberships"."version" > 0);--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_identity_check" CHECK ("team_session_share_grants"."logical_memory_id" is not null
        and "team_session_share_grants"."remote_replica_id" is not null
        and "team_session_share_grants"."owner_principal_id" is not null
        and "team_session_share_grants"."consent_id" is not null
        and "team_session_share_grants"."source_owner_policy_id" is not null
        and "team_session_share_grants"."source_owner_policy_version" > 0
        and "team_session_share_grants"."team_policy_id" is not null
        and "team_session_share_grants"."team_policy_version" > 0
        and "team_session_share_grants"."workspace_policy_id" is not null
        and "team_session_share_grants"."workspace_policy_version" > 0
        and "team_session_share_grants"."creator_authority" is not null
        and length(trim("team_session_share_grants"."creator_authority")) > 0);--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_representation_check" CHECK ("team_session_share_grants"."owner_allowed_representations" is not null
        and cardinality("team_session_share_grants"."owner_allowed_representations") > 0
        and "team_session_share_grants"."representation_policy_revision" > 0
        and "team_session_share_grants"."content_policy_version" > 0
        and "team_session_share_grants"."classifier_version" > 0
        and "team_session_share_grants"."source_revision" >= 0
        and (
          ("team_session_share_grants"."lifecycle" = 'active'
            and "team_session_share_grants"."active_representation" is not null
            and "team_session_share_grants"."active_representation" = any("team_session_share_grants"."owner_allowed_representations"))
          or "team_session_share_grants"."lifecycle" <> 'active'
        ));--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_version_check" CHECK ("team_session_share_grants"."grant_version" > 0 and "team_session_share_grants"."revocation_epoch" >= 0);--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_retention_check" CHECK (("team_session_share_grants"."retention_policy_id" is null and "team_session_share_grants"."retention_policy_version" is null)
        or ("team_session_share_grants"."retention_policy_id" is not null and "team_session_share_grants"."retention_policy_version" > 0));--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_active_retention_check" CHECK ((
        "team_session_share_grants"."active_retention_decision_id" is null
        and "team_session_share_grants"."active_purge_job_id" is null
      ) or (
        "team_session_share_grants"."active_retention_decision_id" is not null
        and "team_session_share_grants"."active_purge_job_id" is not null
        and "team_session_share_grants"."retention_policy_id" is not null
        and "team_session_share_grants"."retention_policy_version" > 0
        and "team_session_share_grants"."retention_triggered_at" is not null
        and "team_session_share_grants"."retain_until" is not null
      ));--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_version_check" CHECK ("team_workspace_access_grants"."version" > 0);--> statement-breakpoint
ALTER TABLE "team_workspace_access_grants" ADD CONSTRAINT "team_workspace_access_grants_share_owned_check" CHECK (not "team_workspace_access_grants"."can_share_owned_memory" or "team_workspace_access_grants"."access" = 'write');--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_version_check" CHECK ("team_workspaces"."version" > 0);--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_name_check" CHECK (length(trim("team_workspaces"."name")) > 0
        and char_length("team_workspaces"."name") <= 80
        and "team_workspaces"."name" = normalize("team_workspaces"."name", NFC));--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_description_marker_check" CHECK ("team_workspaces"."description_marker" is null
        or "team_workspaces"."description_marker" = '[koed encrypted team workspace description]');--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_retention_policy_check" CHECK (("team_workspaces"."retention_policy_id" is null and "team_workspaces"."retention_policy_version" is null)
        or ("team_workspaces"."retention_policy_id" is not null and "team_workspaces"."retention_policy_version" > 0));--> statement-breakpoint
ALTER TABLE "team_workspaces" ADD CONSTRAINT "team_workspaces_lifecycle_shape_check" CHECK ((
        "team_workspaces"."lifecycle" = 'active'
        and "team_workspaces"."archived_at" is null
        and "team_workspaces"."purge_completed_at" is null
      ) or (
        "team_workspaces"."lifecycle" = 'archived'
        and "team_workspaces"."archived_at" is not null
        and "team_workspaces"."purge_completed_at" is null
      ) or (
        "team_workspaces"."lifecycle" = 'purge_pending'
        and "team_workspaces"."purge_completed_at" is null
      ) or (
        "team_workspaces"."lifecycle" = 'purged'
        and "team_workspaces"."purge_completed_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_version_check" CHECK ("teams"."version" > 0);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_creation_idempotency_shape_check" CHECK ((
        "teams"."created_by_user_id" is null
        and "teams"."creation_idempotency_key_hash" is null
        and "teams"."creation_request_hash" is null
      ) or (
        "teams"."created_by_user_id" is not null
        and length("teams"."creation_idempotency_key_hash") = 64
        and length("teams"."creation_request_hash") = 64
      ));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_name_check" CHECK (length(trim("teams"."name")) > 0
        and char_length("teams"."name") <= 80
        and "teams"."name" = normalize("teams"."name", NFC));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_no_archive_check" CHECK ("teams"."archived_at" is null);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_lifecycle_shape_check" CHECK ((
        "teams"."lifecycle" = 'active'
        and "teams"."suspended_at" is null
        and "teams"."deletion_requested_at" is null
        and "teams"."tombstoned_at" is null
        and "teams"."purge_completed_at" is null
      ) or (
        "teams"."lifecycle" = 'suspended'
        and "teams"."suspended_at" is not null
        and "teams"."deletion_requested_at" is null
        and "teams"."tombstoned_at" is null
        and "teams"."purge_completed_at" is null
      ) or (
        "teams"."lifecycle" in ('deletion_requested', 'purge_pending')
        and "teams"."deletion_requested_at" is not null
        and "teams"."tombstoned_at" is not null
        and "teams"."purge_completed_at" is null
      ) or (
        "teams"."lifecycle" = 'purged'
        and "teams"."deletion_requested_at" is not null
        and "teams"."tombstoned_at" is not null
        and "teams"."purge_completed_at" is not null
      ));--> statement-breakpoint
CREATE FUNCTION collaboration_validate_participant_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_thread_id uuid;
  thread_row record;
  participant_count integer;
  distinct_participant_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  participant_json text;
  expected_participant_key text;
BEGIN
  IF TG_TABLE_NAME = 'collaboration_threads' THEN
    target_thread_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target_thread_id := OLD.thread_id;
  ELSE
    target_thread_id := NEW.thread_id;
  END IF;

  SELECT id, kind, personal_owner_user_id, team_id, participant_key
    INTO thread_row
    FROM collaboration_threads
   WHERE id = target_thread_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer,
         count(distinct user_id)::integer,
         min(ordinal),
         max(ordinal),
         string_agg(to_json(user_id::text)::text, ',' ORDER BY user_id)
    INTO participant_count,
         distinct_participant_count,
         minimum_ordinal,
         maximum_ordinal,
         participant_json
    FROM collaboration_participants
   WHERE thread_id = target_thread_id;

  IF thread_row.kind = 'notes_to_self' THEN
    IF participant_count <> 1
       OR distinct_participant_count <> 1
       OR minimum_ordinal <> 0
       OR maximum_ordinal <> 0
       OR NOT EXISTS (
         SELECT 1
           FROM collaboration_participants
          WHERE thread_id = target_thread_id
            AND user_id = thread_row.personal_owner_user_id
            AND personal_owner_user_id = thread_row.personal_owner_user_id
       ) THEN
      RAISE EXCEPTION 'Invalid notes-to-self participant set'
        USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check';
    END IF;
    RETURN NULL;
  END IF;

  IF thread_row.kind NOT IN ('dm', 'group_dm') THEN
    IF participant_count <> 0 THEN
      RAISE EXCEPTION 'Thread kind cannot have explicit participants'
        USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check';
    END IF;
    RETURN NULL;
  END IF;

  IF distinct_participant_count <> participant_count
     OR minimum_ordinal <> 0
     OR maximum_ordinal <> participant_count - 1
     OR (thread_row.kind = 'dm' AND participant_count <> 2)
     OR (thread_row.kind = 'group_dm' AND participant_count NOT BETWEEN 3 AND 40) THEN
    RAISE EXCEPTION 'Invalid direct-message participant set'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check';
  END IF;

  expected_participant_key := encode(
    sha256(
      convert_to(
        'koed:collaboration:participants:v1' || chr(10) ||
        '{"teamId":"' || thread_row.team_id::text || '","userIds":[' ||
        participant_json || ']}',
        'UTF8'
      )
    ),
    'hex'
  );

  IF thread_row.participant_key IS DISTINCT FROM expected_participant_key THEN
    RAISE EXCEPTION 'Direct-message participant key does not match its participant set'
      USING ERRCODE = '23514', CONSTRAINT = 'collaboration_participant_set_check';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER collaboration_participants_set_check
AFTER INSERT OR DELETE OR UPDATE ON collaboration_participants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION collaboration_validate_participant_set();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER collaboration_threads_participant_identity_check
AFTER UPDATE ON collaboration_threads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (
  OLD.scope IS DISTINCT FROM NEW.scope
  OR OLD.kind IS DISTINCT FROM NEW.kind
  OR OLD.personal_owner_user_id IS DISTINCT FROM NEW.personal_owner_user_id
  OR OLD.team_id IS DISTINCT FROM NEW.team_id
  OR OLD.participant_key IS DISTINCT FROM NEW.participant_key
)
EXECUTE FUNCTION collaboration_validate_participant_set();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER collaboration_threads_participant_set_check
AFTER INSERT ON collaboration_threads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION collaboration_validate_participant_set();--> statement-breakpoint
CREATE FUNCTION enforce_retention_policy_shortening_preview_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.retention_policy_row_id IS DISTINCT FROM OLD.retention_policy_row_id
    OR NEW.team_id IS DISTINCT FROM OLD.team_id
    OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.policy_hash IS DISTINCT FROM OLD.policy_hash
    OR NEW.affected_scope_count IS DISTINCT FROM OLD.affected_scope_count
    OR NEW.preview_hash IS DISTINCT FROM OLD.preview_hash
    OR NEW.previewed_by_user_id IS DISTINCT FROM OLD.previewed_by_user_id
    OR NEW.previewed_at IS DISTINCT FROM OLD.previewed_at
    OR NEW.grace_until IS DISTINCT FROM OLD.grace_until
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'retention policy shortening preview snapshot is immutable';
  END IF;
  IF OLD.state <> 'pending' OR NEW.state NOT IN ('confirmed', 'invalidated') THEN
    RAISE EXCEPTION 'invalid retention policy shortening preview state transition: % to %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION prevent_retention_policy_shortening_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'retention policy shortening snapshot and migration rows are immutable';
END;
$$;--> statement-breakpoint
CREATE FUNCTION validate_retention_policy_shortening_aggregate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preview_uuid uuid;
  preview_state retention_policy_shortening_state;
  expected_scope_count integer;
  actual_scope_count bigint;
  actual_migration_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'retention_policy_shortening_previews' THEN
    preview_uuid := COALESCE(NEW.id, OLD.id);
  ELSE
    preview_uuid := COALESCE(NEW.preview_id, OLD.preview_id);
  END IF;
  SELECT state, affected_scope_count
    INTO preview_state, expected_scope_count
    FROM retention_policy_shortening_previews
    WHERE id = preview_uuid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO actual_scope_count
    FROM retention_policy_shortening_affected_scopes
    WHERE preview_id = preview_uuid;
  IF actual_scope_count <> expected_scope_count THEN
    RAISE EXCEPTION 'retention policy shortening preview % expected % affected scopes but has %',
      preview_uuid, expected_scope_count, actual_scope_count;
  END IF;
  SELECT count(*) INTO actual_migration_count
    FROM retention_policy_shortening_migrations
    WHERE preview_id = preview_uuid;
  IF preview_state = 'confirmed' AND actual_migration_count <> expected_scope_count THEN
    RAISE EXCEPTION 'confirmed retention policy shortening preview % expected % migrations but has %',
      preview_uuid, expected_scope_count, actual_migration_count;
  END IF;
  IF preview_state <> 'confirmed' AND actual_migration_count <> 0 THEN
    RAISE EXCEPTION 'unconfirmed retention policy shortening preview % cannot have migrations', preview_uuid;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER retention_policy_shortening_preview_transition
BEFORE UPDATE ON retention_policy_shortening_previews
FOR EACH ROW EXECUTE FUNCTION enforce_retention_policy_shortening_preview_transition();--> statement-breakpoint
CREATE TRIGGER retention_policy_shortening_scope_immutable
BEFORE UPDATE OR DELETE ON retention_policy_shortening_affected_scopes
FOR EACH ROW EXECUTE FUNCTION prevent_retention_policy_shortening_child_mutation();--> statement-breakpoint
CREATE TRIGGER retention_policy_shortening_migration_immutable
BEFORE UPDATE OR DELETE ON retention_policy_shortening_migrations
FOR EACH ROW EXECUTE FUNCTION prevent_retention_policy_shortening_child_mutation();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER retention_policy_shortening_preview_aggregate
AFTER INSERT OR UPDATE ON retention_policy_shortening_previews
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_retention_policy_shortening_aggregate();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER retention_policy_shortening_scope_aggregate
AFTER INSERT OR UPDATE OR DELETE ON retention_policy_shortening_affected_scopes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_retention_policy_shortening_aggregate();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER retention_policy_shortening_migration_aggregate
AFTER INSERT OR UPDATE OR DELETE ON retention_policy_shortening_migrations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_retention_policy_shortening_aggregate();
