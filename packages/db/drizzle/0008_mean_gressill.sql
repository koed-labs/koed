CREATE TYPE "public"."deployment_profile" AS ENUM('developer', 'local_personal', 'private_vps', 'team_self_hosted', 'koed_managed_cloud');--> statement-breakpoint
CREATE TYPE "public"."device_credential_verifier_kind" AS ENUM('secret_hash', 'public_key_jwk');--> statement-breakpoint
CREATE TYPE "public"."external_auth_link_status" AS ENUM('linked', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."external_auth_provider" AS ENUM('workos_authkit');--> statement-breakpoint
CREATE TYPE "public"."sync_mode" AS ENUM('live', 'offload');--> statement-breakpoint
CREATE TYPE "public"."sync_package_state" AS ENUM('created', 'uploading', 'uploaded', 'verified', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_queue_entry_state" AS ENUM('pending', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sync_relationship_state" AS ENUM('created', 'uploading', 'uploaded', 'verified', 'processing', 'partially_available', 'ready', 'stale', 'failed', 'revoked', 'purge_pending');--> statement-breakpoint
CREATE TYPE "public"."sync_replica_role" AS ENUM('source', 'target');--> statement-breakpoint
CREATE TYPE "public"."sync_source_boundary" AS ENUM('captured_session');--> statement-breakpoint
CREATE TYPE "public"."team_billing_seat_sync_status" AS ENUM('synced', 'pending_provider_update', 'over_limit', 'error');--> statement-breakpoint
CREATE TYPE "public"."team_entitlement_status" AS ENUM('active', 'grace', 'suspended', 'revoked');--> statement-breakpoint
CREATE TABLE "cross_identity_sync_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_replica_id" uuid NOT NULL,
	"target_replica_id" uuid NOT NULL,
	"source_deployment_identity_id" uuid NOT NULL,
	"target_deployment_identity_id" uuid NOT NULL,
	"source_owner_user_id" uuid NOT NULL,
	"target_user_id" uuid NOT NULL,
	"target_team_id" uuid,
	"source_boundary" "sync_source_boundary" NOT NULL,
	"source_session_id" uuid,
	"sync_mode" "sync_mode" DEFAULT 'live' NOT NULL,
	"state" "sync_relationship_state" DEFAULT 'created' NOT NULL,
	"idempotency_key" text NOT NULL,
	"policy_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cursor_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_package_id" uuid,
	"last_synced_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_message" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	CONSTRAINT "cross_identity_sync_relationships_owner_idempotency_unique" UNIQUE("source_owner_user_id","idempotency_key"),
	CONSTRAINT "cross_identity_sync_relationships_captured_session_source_check" CHECK ("cross_identity_sync_relationships"."source_boundary" <> 'captured_session' or "cross_identity_sync_relationships"."source_session_id" is not null),
	CONSTRAINT "cross_identity_sync_relationships_idempotency_key_not_empty_check" CHECK (length(trim("cross_identity_sync_relationships"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "deployment_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"deployment_key" text NOT NULL,
	"profile" "deployment_profile" NOT NULL,
	"display_name" text,
	"base_url" text,
	"upstream_backend_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "deployment_identities_owner_key_unique" UNIQUE("owner_user_id","deployment_key"),
	CONSTRAINT "deployment_identities_deployment_key_not_empty_check" CHECK (length(trim("deployment_identities"."deployment_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"enrollment_challenge_id" uuid,
	"credential_key_id" text NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"device_instance_id" text NOT NULL,
	"device_label" text,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"verifier_kind" "device_credential_verifier_kind" NOT NULL,
	"verifier_hash" text,
	"public_key_jwk" jsonb,
	"operation_families" text[] DEFAULT array[]::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"revocation_reason" text,
	CONSTRAINT "device_credentials_credential_key_id_unique" UNIQUE("credential_key_id"),
	CONSTRAINT "device_credentials_credential_version_check" CHECK ("device_credentials"."credential_version" > 0),
	CONSTRAINT "device_credentials_credential_key_id_length_check" CHECK (length("device_credentials"."credential_key_id") >= 16),
	CONSTRAINT "device_credentials_verifier_hash_length_check" CHECK ("device_credentials"."verifier_hash" is null or length("device_credentials"."verifier_hash") >= 32),
	CONSTRAINT "device_credentials_verifier_shape_check" CHECK ((
        "device_credentials"."verifier_kind" = 'secret_hash'
        and "device_credentials"."verifier_hash" is not null
        and "device_credentials"."public_key_jwk" is null
      ) or (
        "device_credentials"."verifier_kind" = 'public_key_jwk'
        and "device_credentials"."public_key_jwk" is not null
        and "device_credentials"."verifier_hash" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "device_enrollment_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_hash" text NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"device_instance_id" text,
	"device_label" text,
	"requested_operation_families" text[] DEFAULT array[]::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"bound_by_user_id" uuid,
	"bound_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "device_enrollment_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "device_enrollment_challenges_challenge_hash_length_check" CHECK (length("device_enrollment_challenges"."challenge_hash") >= 32)
);
--> statement-breakpoint
CREATE TABLE "encrypted_field_backfill_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"source_table" text NOT NULL,
	"source_column" text NOT NULL,
	"provider_mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cursor_source_id" uuid,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"encrypted_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"last_error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "encrypted_field_backfill_runs_source_table_check" CHECK ("encrypted_field_backfill_runs"."source_table" in (
        'conversation_items',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      )),
	CONSTRAINT "encrypted_field_backfill_runs_provider_mode_check" CHECK ("encrypted_field_backfill_runs"."provider_mode" in (
        'local_test_key',
        'managed_kms',
        'operator_kms',
        'byok',
        'cmek'
      )),
	CONSTRAINT "encrypted_field_backfill_runs_status_check" CHECK ("encrypted_field_backfill_runs"."status" in ('pending', 'processing', 'completed', 'error')),
	CONSTRAINT "encrypted_field_backfill_runs_counts_check" CHECK ("encrypted_field_backfill_runs"."total_rows" >= 0
        and "encrypted_field_backfill_runs"."processed_rows" >= 0
        and "encrypted_field_backfill_runs"."encrypted_rows" >= 0
        and "encrypted_field_backfill_runs"."failed_rows" >= 0)
);
--> statement-breakpoint
CREATE TABLE "encrypted_field_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"encryption_scope" text DEFAULT 'personal' NOT NULL,
	"source_table" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_column" text NOT NULL,
	"plaintext_content_type" text DEFAULT 'application/json' NOT NULL,
	"plaintext_encoding" text DEFAULT 'utf8' NOT NULL,
	"envelope_version" integer NOT NULL,
	"provider_mode" text NOT NULL,
	"key_id" text NOT NULL,
	"key_version" integer NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"algorithm" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"tag" text NOT NULL,
	"wrapped_dek" jsonb NOT NULL,
	"ciphertext_location" text NOT NULL,
	"aad" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"envelope_created_at" timestamp with time zone NOT NULL,
	"envelope_reencrypted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "encrypted_field_payloads_scope_owner_check" CHECK ((
        "encrypted_field_payloads"."encryption_scope" = 'personal'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."owner_user_id" is not null
        and "encrypted_field_payloads"."team_id" is null
        and "encrypted_field_payloads"."team_workspace_id" is null
      ) or (
        "encrypted_field_payloads"."encryption_scope" = 'team'
        and "encrypted_field_payloads"."visibility" = 'personal'
        and "encrypted_field_payloads"."team_id" is not null
      )),
	CONSTRAINT "encrypted_field_payloads_encryption_scope_check" CHECK ("encrypted_field_payloads"."encryption_scope" in ('personal', 'team')),
	CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("encrypted_field_payloads"."source_table" in (
        'conversation_items',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      )),
	CONSTRAINT "encrypted_field_payloads_provider_mode_check" CHECK ("encrypted_field_payloads"."provider_mode" in (
        'local_test_key',
        'managed_kms',
        'operator_kms',
        'byok',
        'cmek'
      )),
	CONSTRAINT "encrypted_field_payloads_key_version_check" CHECK ("encrypted_field_payloads"."key_version" >= 0),
	CONSTRAINT "encrypted_field_payloads_envelope_version_check" CHECK ("encrypted_field_payloads"."envelope_version" >= 1),
	CONSTRAINT "encrypted_field_payloads_ciphertext_not_empty_check" CHECK (length("encrypted_field_payloads"."ciphertext") > 0 and length("encrypted_field_payloads"."nonce") > 0 and length("encrypted_field_payloads"."tag") > 0)
);
--> statement-breakpoint
CREATE TABLE "external_auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "external_auth_provider" NOT NULL,
	"provider_environment" text DEFAULT 'default' NOT NULL,
	"provider_user_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"status" "external_auth_link_status" DEFAULT 'linked' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "external_auth_identities_provider_user_unique" UNIQUE("provider","provider_environment","provider_user_id"),
	CONSTRAINT "external_auth_identities_provider_user_id_not_empty_check" CHECK (length(trim("external_auth_identities"."provider_user_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "external_auth_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "external_auth_provider" NOT NULL,
	"provider_environment" text DEFAULT 'default' NOT NULL,
	"provider_organization_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text,
	"status" "external_auth_link_status" DEFAULT 'linked' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "external_auth_organizations_provider_org_unique" UNIQUE("provider","provider_environment","provider_organization_id"),
	CONSTRAINT "external_auth_organizations_provider_org_id_not_empty_check" CHECK (length(trim("external_auth_organizations"."provider_organization_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "logical_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_boundary" "sync_source_boundary" NOT NULL,
	"source_session_id" uuid,
	"logical_key" text NOT NULL,
	"lineage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "logical_memories_owner_key_unique" UNIQUE("owner_user_id","logical_key"),
	CONSTRAINT "logical_memories_captured_session_source_check" CHECK ("logical_memories"."source_boundary" <> 'captured_session' or "logical_memories"."source_session_id" is not null),
	CONSTRAINT "logical_memories_logical_key_not_empty_check" CHECK (length(trim("logical_memories"."logical_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"deployment_identity_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"replica_role" "sync_replica_role" NOT NULL,
	"source_boundary" "sync_source_boundary" NOT NULL,
	"source_session_id" uuid,
	"external_replica_id" text,
	"freshness_status" text DEFAULT 'unknown' NOT NULL,
	"cursor_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"stale_after" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "memory_replicas_logical_deployment_role_unique" UNIQUE("logical_memory_id","deployment_identity_id","replica_role"),
	CONSTRAINT "memory_replicas_captured_session_source_check" CHECK ("memory_replicas"."source_boundary" <> 'captured_session' or "memory_replicas"."source_session_id" is not null),
	CONSTRAINT "memory_replicas_freshness_status_check" CHECK ("memory_replicas"."freshness_status" in ('unknown', 'fresh', 'stale', 'revoked', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "sync_inbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"upload_session_id" uuid,
	"state" "sync_queue_entry_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_inbox_entries_idempotency_unique" UNIQUE("sync_relationship_id","idempotency_key"),
	CONSTRAINT "sync_inbox_entries_attempts_check" CHECK ("sync_inbox_entries"."attempt_count" >= 0 and "sync_inbox_entries"."max_attempts" > 0 and "sync_inbox_entries"."attempt_count" <= "sync_inbox_entries"."max_attempts"),
	CONSTRAINT "sync_inbox_entries_idempotency_key_not_empty_check" CHECK (length(trim("sync_inbox_entries"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_outbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"upload_session_id" uuid,
	"state" "sync_queue_entry_state" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_outbox_entries_idempotency_unique" UNIQUE("sync_relationship_id","idempotency_key"),
	CONSTRAINT "sync_outbox_entries_attempts_check" CHECK ("sync_outbox_entries"."attempt_count" >= 0 and "sync_outbox_entries"."max_attempts" > 0 and "sync_outbox_entries"."attempt_count" <= "sync_outbox_entries"."max_attempts"),
	CONSTRAINT "sync_outbox_entries_idempotency_key_not_empty_check" CHECK (length(trim("sync_outbox_entries"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_package_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upload_session_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_checksum" text NOT NULL,
	"byte_count" integer NOT NULL,
	"storage_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_package_chunks_session_index_unique" UNIQUE("upload_session_id","chunk_index"),
	CONSTRAINT "sync_package_chunks_index_check" CHECK ("sync_package_chunks"."chunk_index" >= 0),
	CONSTRAINT "sync_package_chunks_byte_count_check" CHECK ("sync_package_chunks"."byte_count" >= 0),
	CONSTRAINT "sync_package_chunks_checksum_not_empty_check" CHECK (length(trim("sync_package_chunks"."chunk_checksum")) > 0)
);
--> statement-breakpoint
CREATE TABLE "sync_package_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_replica_id" uuid NOT NULL,
	"target_replica_id" uuid NOT NULL,
	"state" "sync_package_state" DEFAULT 'created' NOT NULL,
	"package_format_version" integer DEFAULT 1 NOT NULL,
	"package_manifest" jsonb NOT NULL,
	"package_checksum" text NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"uploaded_bytes" bigint DEFAULT 0 NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"verified_chunk_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_message" text,
	CONSTRAINT "sync_package_upload_sessions_idempotency_unique" UNIQUE("sync_relationship_id","idempotency_key"),
	CONSTRAINT "sync_package_upload_sessions_checksum_not_empty_check" CHECK (length(trim("sync_package_upload_sessions"."package_checksum")) > 0),
	CONSTRAINT "sync_package_upload_sessions_idempotency_key_not_empty_check" CHECK (length(trim("sync_package_upload_sessions"."idempotency_key")) > 0),
	CONSTRAINT "sync_package_upload_sessions_counts_check" CHECK ("sync_package_upload_sessions"."package_format_version" > 0
        and "sync_package_upload_sessions"."total_bytes" >= 0
        and "sync_package_upload_sessions"."uploaded_bytes" >= 0
        and "sync_package_upload_sessions"."uploaded_bytes" <= "sync_package_upload_sessions"."total_bytes"
        and "sync_package_upload_sessions"."chunk_count" >= 0
        and "sync_package_upload_sessions"."verified_chunk_count" >= 0
        and "sync_package_upload_sessions"."verified_chunk_count" <= "sync_package_upload_sessions"."chunk_count")
);
--> statement-breakpoint
CREATE TABLE "team_billing_seat_states" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"seat_limit" integer,
	"billable_seat_count" integer DEFAULT 0 NOT NULL,
	"pending_billing_seat_count" integer DEFAULT 0 NOT NULL,
	"sync_status" "team_billing_seat_sync_status" DEFAULT 'synced' NOT NULL,
	"over_limit_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error_message" text,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_billing_seat_states_counts_check" CHECK ("team_billing_seat_states"."billable_seat_count" >= 0
        and "team_billing_seat_states"."pending_billing_seat_count" >= 0
        and ("team_billing_seat_states"."seat_limit" is null or "team_billing_seat_states"."seat_limit" >= 0))
);
--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "queryable_vector_strategy" text DEFAULT 'trusted_backend_pgvector_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "search_boundary" text DEFAULT 'owner_user_dynamic_grants' NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "canonical_embedding_state" text DEFAULT 'not_stored' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "entitlement_status" "team_entitlement_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "entitlement_reason" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "entitlement_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_replica_id_memory_replicas_id_fk" FOREIGN KEY ("source_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_replica_id_memory_replicas_id_fk" FOREIGN KEY ("target_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("source_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("target_deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_owner_user_id_users_id_fk" FOREIGN KEY ("source_owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_target_team_id_teams_id_fk" FOREIGN KEY ("target_team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD CONSTRAINT "cross_identity_sync_relationships_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_identities" ADD CONSTRAINT "deployment_identities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_enrollment_challenge_id_device_enrollment_challenges_id_fk" FOREIGN KEY ("enrollment_challenge_id") REFERENCES "public"."device_enrollment_challenges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_enrollment_challenges" ADD CONSTRAINT "device_enrollment_challenges_bound_by_user_id_users_id_fk" FOREIGN KEY ("bound_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" ADD CONSTRAINT "encrypted_field_backfill_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_team_workspace_id_team_id_team_workspaces_id_team_id_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_auth_identities" ADD CONSTRAINT "external_auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_auth_organizations" ADD CONSTRAINT "external_auth_organizations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logical_memories" ADD CONSTRAINT "logical_memories_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_replicas" ADD CONSTRAINT "memory_replicas_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD CONSTRAINT "sync_inbox_entries_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_inbox_entries" ADD CONSTRAINT "sync_inbox_entries_upload_session_id_sync_package_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."sync_package_upload_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD CONSTRAINT "sync_outbox_entries_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_outbox_entries" ADD CONSTRAINT "sync_outbox_entries_upload_session_id_sync_package_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."sync_package_upload_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_chunks" ADD CONSTRAINT "sync_package_chunks_upload_session_id_sync_package_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."sync_package_upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_source_replica_id_memory_replicas_id_fk" FOREIGN KEY ("source_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_package_upload_sessions" ADD CONSTRAINT "sync_package_upload_sessions_target_replica_id_memory_replicas_id_fk" FOREIGN KEY ("target_replica_id") REFERENCES "public"."memory_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_billing_seat_states" ADD CONSTRAINT "team_billing_seat_states_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_billing_seat_states" ADD CONSTRAINT "team_billing_seat_states_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cross_identity_sync_relationships_active_replicas_unique" ON "cross_identity_sync_relationships" USING btree ("source_replica_id","target_replica_id","sync_mode") WHERE "cross_identity_sync_relationships"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_source_owner_idx" ON "cross_identity_sync_relationships" USING btree ("source_owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_target_user_idx" ON "cross_identity_sync_relationships" USING btree ("target_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "cross_identity_sync_relationships_state_idx" ON "cross_identity_sync_relationships" USING btree ("state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deployment_identities_owner_profile_idx" ON "deployment_identities" USING btree ("owner_user_id","profile","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "device_credentials_active_lookup_idx" ON "device_credentials" USING btree ("credential_key_id") WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "device_credentials_owner_upstream_idx" ON "device_credentials" USING btree ("owner_user_id","upstream_backend_id","created_at" DESC NULLS LAST) WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_credentials_active_device_unique" ON "device_credentials" USING btree ("owner_user_id","upstream_backend_id","device_instance_id") WHERE "device_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "device_enrollment_challenges_active_idx" ON "device_enrollment_challenges" USING btree ("challenge_hash") WHERE "device_enrollment_challenges"."redeemed_at" is null;--> statement-breakpoint
CREATE INDEX "encrypted_field_backfill_runs_status_idx" ON "encrypted_field_backfill_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_field_payloads_source_unique" ON "encrypted_field_payloads" USING btree ("source_table","source_id","source_column") WHERE "encrypted_field_payloads"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "encrypted_field_payloads_owner_idx" ON "encrypted_field_payloads" USING btree ("owner_user_id","source_table","updated_at" DESC NULLS LAST) WHERE "encrypted_field_payloads"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "encrypted_field_payloads_team_idx" ON "encrypted_field_payloads" USING btree ("team_id","team_workspace_id","source_table") WHERE "encrypted_field_payloads"."encryption_scope" = 'team';--> statement-breakpoint
CREATE INDEX "encrypted_field_payloads_key_idx" ON "encrypted_field_payloads" USING btree ("provider_mode","key_id","key_version");--> statement-breakpoint
CREATE INDEX "external_auth_identities_user_idx" ON "external_auth_identities" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "external_auth_organizations_team_idx" ON "external_auth_organizations" USING btree ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "logical_memories_owner_session_unique" ON "logical_memories" USING btree ("owner_user_id","source_session_id") WHERE "logical_memories"."source_session_id" is not null;--> statement-breakpoint
CREATE INDEX "logical_memories_owner_boundary_idx" ON "logical_memories" USING btree ("owner_user_id","source_boundary","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_replicas_external_replica_unique" ON "memory_replicas" USING btree ("deployment_identity_id","external_replica_id") WHERE "memory_replicas"."external_replica_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_replicas_owner_status_idx" ON "memory_replicas" USING btree ("owner_user_id","freshness_status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_inbox_entries_state_idx" ON "sync_inbox_entries" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "sync_outbox_entries_state_idx" ON "sync_outbox_entries" USING btree ("state","available_at");--> statement-breakpoint
CREATE INDEX "sync_package_upload_sessions_state_idx" ON "sync_package_upload_sessions" USING btree ("state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_billing_seat_states_status_idx" ON "team_billing_seat_states" USING btree ("sync_status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_activation_team_idx" ON "audit_events" USING btree (("metadata" ->> 'teamId'),"created_at" DESC NULLS LAST,"audit_sequence" DESC NULLS LAST) WHERE "audit_events"."action" like 'analytics.activation.%' and "audit_events"."metadata" ? 'teamId';--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_queryable_vector_strategy_check" CHECK ("memory_embeddings"."queryable_vector_strategy" in ('trusted_backend_pgvector_v1'));--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_search_boundary_check" CHECK ("memory_embeddings"."search_boundary" in ('owner_user_dynamic_grants'));--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_canonical_embedding_state_check" CHECK ("memory_embeddings"."canonical_embedding_state" in ('not_stored', 'encrypted_payload'));
