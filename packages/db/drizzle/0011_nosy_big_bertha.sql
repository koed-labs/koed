CREATE TYPE "public"."sync_change_operation" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TYPE "public"."sync_deployment_locality" AS ENUM('local', 'remote');--> statement-breakpoint
CREATE TYPE "public"."sync_relationship_side" AS ENUM('source', 'target');--> statement-breakpoint
ALTER TYPE "public"."sync_relationship_state" ADD VALUE 'paused' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "sync_event_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"origin_event_id" uuid NOT NULL,
	"revision_hash" text NOT NULL,
	"local_memory_event_id" uuid,
	"source_cursor" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "sync_event_mappings_revision_unique" UNIQUE("sync_relationship_id","origin_event_id","revision_hash")
);
--> statement-breakpoint
CREATE TABLE "sync_external_user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_identity_id" uuid NOT NULL,
	"external_subject_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sync_external_user_identity_subject_unique" UNIQUE("deployment_identity_id","external_subject_id"),
	CONSTRAINT "sync_external_user_identity_id_deployment_unique" UNIQUE("id","deployment_identity_id"),
	CONSTRAINT "sync_external_user_identity_subject_not_empty_check" CHECK (length(trim("sync_external_user_identities"."external_subject_id")) > 0),
	CONSTRAINT "sync_external_user_identity_status_check" CHECK ("sync_external_user_identities"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "sync_principal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_user_id" uuid NOT NULL,
	"external_user_identity_id" uuid NOT NULL,
	"proof_kind" text NOT NULL,
	"proof_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sync_principal_links_external_unique" UNIQUE("external_user_identity_id"),
	CONSTRAINT "sync_principal_links_local_external_unique" UNIQUE("local_user_id","external_user_identity_id"),
	CONSTRAINT "sync_principal_links_proof_unique" UNIQUE("proof_kind","proof_reference"),
	CONSTRAINT "sync_principal_links_proof_not_empty_check" CHECK (length(trim("sync_principal_links"."proof_kind")) > 0 and length(trim("sync_principal_links"."proof_reference")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_recipient_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_identity_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"algorithm" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"encrypted_private_key" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "sync_recipient_keys_key_version_unique" UNIQUE("deployment_identity_id","key_id","key_version"),
	CONSTRAINT "sync_recipient_keys_version_check" CHECK ("sync_recipient_keys"."key_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_semantic_changes" (
	"cursor" bigserial PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"memory_event_id" uuid,
	"origin_event_id" uuid NOT NULL,
	"operation" "sync_change_operation" NOT NULL,
	"revision_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_semantic_changes_revision_hash_check" CHECK (length("sync_semantic_changes"."revision_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "sync_service_heartbeats" (
	"service_name" text PRIMARY KEY NOT NULL,
	"instance_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The pre-release sync scaffold did not transport data. Reset only those
-- scaffold tables before replacing their incompatible identity model.
TRUNCATE TABLE
  "sync_inbox_entries",
  "sync_outbox_entries",
  "sync_package_chunks",
  "sync_package_upload_sessions",
  "cross_identity_sync_relationships",
  "memory_replicas",
  "logical_memories",
  "deployment_identities"
CASCADE;
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_owner_idempotency_unique";--> statement-breakpoint
ALTER TABLE "deployment_identities" DROP CONSTRAINT "deployment_identities_owner_key_unique";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_captured_session_source_check";--> statement-breakpoint
ALTER TABLE "deployment_identities" DROP CONSTRAINT "deployment_identities_deployment_key_not_empty_check";--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_captured_session_source_check";--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP CONSTRAINT "memory_replicas_captured_session_source_check";--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP CONSTRAINT "sync_package_upload_sessions_counts_check";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_source_replica_id_memory_replicas_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_target_replica_id_memory_replicas_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_source_deployment_identity_id_deployment_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_target_deployment_identity_id_deployment_identities_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_source_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_target_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_target_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP CONSTRAINT "cross_identity_sync_relationships_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "deployment_identities" DROP CONSTRAINT "deployment_identities_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "logical_memories" DROP CONSTRAINT "logical_memories_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP CONSTRAINT "memory_replicas_source_session_id_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP CONSTRAINT "sync_package_upload_sessions_logical_memory_id_logical_memories_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP CONSTRAINT "sync_package_upload_sessions_source_replica_id_memory_replicas_id_fk";
--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP CONSTRAINT "sync_package_upload_sessions_target_replica_id_memory_replicas_id_fk";
--> statement-breakpoint
DROP INDEX "cross_identity_sync_relationships_active_replicas_unique";--> statement-breakpoint
DROP INDEX "cross_identity_sync_relationships_source_owner_idx";--> statement-breakpoint
DROP INDEX "cross_identity_sync_relationships_target_user_idx";--> statement-breakpoint
DROP INDEX "deployment_identities_owner_profile_idx";--> statement-breakpoint
DROP INDEX "logical_memories_owner_session_unique";--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ALTER COLUMN "max_attempts" SET DEFAULT 8;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ALTER COLUMN "max_attempts" SET DEFAULT 8;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "side" "sync_relationship_side" NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "local_replica_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "local_user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "device_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "remote_deployment_identity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "remote_user_identity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "remote_replica_id" uuid;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "creation_request_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "source_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "target_processing_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "package_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "stale_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "last_error_class" text;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "revocation_id" uuid;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "revocation_sequence" bigint;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "revocation_origin" "sync_relationship_side";--> statement-breakpoint
ALTER TABLE "deployment_identities" ADD COLUMN "protocol_deployment_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_identities" ADD COLUMN "locality" "sync_deployment_locality" NOT NULL;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "lineage_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD COLUMN "rotation_lineage_id" uuid;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD COLUMN "rotation_owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD COLUMN "rotation_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "origin_deployment_identity_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "origin_source_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD COLUMN "local_session_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD COLUMN "local_session_id" uuid;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD COLUMN "request_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD COLUMN "request_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_package_chunks" ADD COLUMN "encrypted_payload" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD COLUMN "protocol_package_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD COLUMN "request_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD COLUMN "source_sequence" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD COLUMN "from_cursor" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD COLUMN "to_cursor" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD COLUMN "expected_chunk_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_event_mappings" ADD CONSTRAINT "sync_event_mappings_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_event_mappings" ADD CONSTRAINT "sync_event_mappings_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_external_user_identities" ADD CONSTRAINT "sync_external_user_identities_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_principal_links" ADD CONSTRAINT "sync_principal_links_local_user_id_users_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_principal_links" ADD CONSTRAINT "sync_principal_links_external_user_identity_id_sync_external_user_identities_id_fk" FOREIGN KEY ("external_user_identity_id") REFERENCES "public"."sync_external_user_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_recipient_keys" ADD CONSTRAINT "sync_recipient_keys_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_semantic_changes" ADD CONSTRAINT "sync_semantic_changes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_semantic_changes" ADD CONSTRAINT "sync_semantic_changes_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_event_mappings_active_origin_unique" ON "sync_event_mappings" USING btree ("sync_relationship_id","origin_event_id") WHERE "sync_event_mappings"."active" = true;--> statement-breakpoint
CREATE INDEX "sync_event_mappings_cursor_idx" ON "sync_event_mappings" USING btree ("sync_relationship_id","source_cursor");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_recipient_keys_active_unique" ON "sync_recipient_keys" USING btree ("deployment_identity_id") WHERE "sync_recipient_keys"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "sync_semantic_changes_session_cursor_idx" ON "sync_semantic_changes" USING btree ("session_id","cursor");--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_local_user_id_users_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_device_credential_id_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_remote_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("remote_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_identity_consistency_unique" UNIQUE("id","logical_memory_id","owner_user_id");--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_id_relationship_unique" UNIQUE("id","sync_relationship_id");--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_local_replica_fk" FOREIGN KEY ("local_replica_id","logical_memory_id","local_user_id") REFERENCES "public"."memory_replicas"("id","logical_memory_id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_remote_user_fk" FOREIGN KEY ("remote_user_identity_id","remote_deployment_identity_id") REFERENCES "public"."sync_external_user_identities"("id","deployment_identity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD CONSTRAINT "device_enrollment_challenges_rotation_owner_user_id_users_id_fk" FOREIGN KEY ("rotation_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD CONSTRAINT "device_enrollment_challenges_rotation_credential_id_device_credentials_id_fk" FOREIGN KEY ("rotation_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_origin_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("origin_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD CONSTRAINT "sync_inbox_upload_relationship_fk" FOREIGN KEY ("upload_session_id","sync_relationship_id") REFERENCES "public"."sync_package_upload_sessions"("id","sync_relationship_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD CONSTRAINT "sync_outbox_upload_relationship_fk" FOREIGN KEY ("upload_session_id","sync_relationship_id") REFERENCES "public"."sync_package_upload_sessions"("id","sync_relationship_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cross_identity_sync_relationships_active_replica_unique" ON "cross_identity_sync_relationships" USING btree ("local_replica_id","remote_deployment_identity_id","sync_mode") WHERE "cross_identity_sync_relationships"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_local_user_idx" ON "cross_identity_sync_relationships" USING btree ("local_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_device_credential_idx" ON "cross_identity_sync_relationships" USING btree ("device_credential_id","updated_at" DESC NULLS LAST) WHERE "cross_identity_sync_relationships"."device_credential_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_identities_one_local_unique" ON "deployment_identities" USING btree ("locality") WHERE "deployment_identities"."locality" = 'local';--> statement-breakpoint
CREATE INDEX "deployment_identities_profile_idx" ON "deployment_identities" USING btree ("profile","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "device_credentials_active_lineage_idx" ON "device_credentials" USING btree ("owner_user_id","upstream_backend_id","lineage_id") WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "logical_memories_owner_session_unique" ON "logical_memories" USING btree ("owner_user_id","local_session_id") WHERE "logical_memories"."local_session_id" is not null;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "source_replica_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "target_replica_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "source_deployment_identity_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "target_deployment_identity_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "source_owner_user_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "target_user_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "target_team_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "source_session_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "cursor_manifest";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" DROP COLUMN "last_error_message";--> statement-breakpoint
ALTER TABLE "deployment_identities" DROP COLUMN "owner_user_id";--> statement-breakpoint
ALTER TABLE "deployment_identities" DROP COLUMN "deployment_key";--> statement-breakpoint
ALTER TABLE "logical_memories" DROP COLUMN "source_session_id";--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP COLUMN "source_session_id";--> statement-breakpoint
ALTER TABLE "memory_replicas" DROP COLUMN "cursor_manifest";--> statement-breakpoint
ALTER TABLE "sync_package_chunks" DROP COLUMN "storage_ref";--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP COLUMN "logical_memory_id";--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP COLUMN "source_replica_id";--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" DROP COLUMN "target_replica_id";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_local_idempotency_unique" UNIQUE("local_user_id","remote_deployment_identity_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "deployment_identities" ADD CONSTRAINT "deployment_identities_protocol_id_unique" UNIQUE("protocol_deployment_id");--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_origin_unique" UNIQUE("origin_deployment_identity_id","source_boundary","origin_source_id");--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_protocol_package_unique" UNIQUE("protocol_package_id");--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_relationship_sequence_unique" UNIQUE("sync_relationship_id","source_sequence");--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_request_hash_check" CHECK (length("cross_identity_sync_relationships"."creation_request_hash") = 64);--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_cursor_check" CHECK ("cross_identity_sync_relationships"."source_cursor" >= 0 and "cross_identity_sync_relationships"."target_processing_cursor" >= 0 and "cross_identity_sync_relationships"."package_sequence" >= 0);--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_credential_side_check" CHECK (("cross_identity_sync_relationships"."side" = 'source' and "cross_identity_sync_relationships"."device_credential_id" is null) or ("cross_identity_sync_relationships"."side" = 'target' and "cross_identity_sync_relationships"."device_credential_id" is not null));--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_captured_session_source_check" CHECK ("cross_identity_sync_relationships"."source_boundary" = 'captured_session');--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_captured_session_source_check" CHECK ("logical_memories"."source_boundary" <> 'captured_session' or length(trim("logical_memories"."origin_source_id")) > 0);--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_captured_session_source_check" CHECK ("memory_replicas"."source_boundary" <> 'captured_session' or "memory_replicas"."local_session_id" is not null);--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_counts_check" CHECK ("sync_package_upload_sessions"."package_format_version" > 0
        and "sync_package_upload_sessions"."total_bytes" >= 0
        and "sync_package_upload_sessions"."uploaded_bytes" >= 0
        and "sync_package_upload_sessions"."uploaded_bytes" <= "sync_package_upload_sessions"."total_bytes"
        and "sync_package_upload_sessions"."source_sequence" > 0
        and "sync_package_upload_sessions"."from_cursor" >= 0
        and "sync_package_upload_sessions"."to_cursor" >= "sync_package_upload_sessions"."from_cursor"
        and "sync_package_upload_sessions"."expected_chunk_count" > 0
        and "sync_package_upload_sessions"."chunk_count" >= 0
        and "sync_package_upload_sessions"."chunk_count" <= "sync_package_upload_sessions"."expected_chunk_count"
        and "sync_package_upload_sessions"."verified_chunk_count" >= 0
        and "sync_package_upload_sessions"."verified_chunk_count" <= "sync_package_upload_sessions"."chunk_count");
--> statement-breakpoint
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
  WHERE relationship.side = 'source'
    AND relationship.revoked_at IS NULL
    AND relationship.state NOT IN ('paused', 'revoked', 'purge_pending')
    AND replica.local_session_id = source_row.session_id
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
$$;
--> statement-breakpoint
CREATE TRIGGER memory_events_sync_insert_trigger
AFTER INSERT ON memory_events
FOR EACH ROW EXECUTE FUNCTION record_sync_semantic_change();
--> statement-breakpoint
CREATE TRIGGER memory_events_sync_update_trigger
AFTER UPDATE OF payload, token_count, seal_reason, source_event_time,
  source_sequence, personal_deleted_at, invalidated_at
ON memory_events
FOR EACH ROW
WHEN (
  OLD.payload IS DISTINCT FROM NEW.payload
  OR OLD.token_count IS DISTINCT FROM NEW.token_count
  OR OLD.seal_reason IS DISTINCT FROM NEW.seal_reason
  OR OLD.source_event_time IS DISTINCT FROM NEW.source_event_time
  OR OLD.source_sequence IS DISTINCT FROM NEW.source_sequence
  OR OLD.personal_deleted_at IS DISTINCT FROM NEW.personal_deleted_at
  OR OLD.invalidated_at IS DISTINCT FROM NEW.invalidated_at
)
EXECUTE FUNCTION record_sync_semantic_change();
--> statement-breakpoint
CREATE TRIGGER memory_events_sync_delete_trigger
AFTER DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION record_sync_semantic_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_session_recall_ready(candidate_session_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM memory_replicas replica
    JOIN cross_identity_sync_relationships relationship
      ON relationship.local_replica_id = replica.id
    WHERE replica.local_session_id = candidate_session_id
      AND replica.replica_role = 'target'
      AND (
        relationship.side <> 'target'
        OR relationship.state NOT IN ('ready', 'revoked')
        OR replica.freshness_status <> 'fresh'
      )
  );
$$;
