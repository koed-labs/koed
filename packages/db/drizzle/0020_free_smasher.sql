CREATE TYPE "public"."personal_device_group_state" AS ENUM('active', 'equivocation_freeze', 'quarantine');--> statement-breakpoint
CREATE TYPE "public"."personal_device_member_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "local_personal_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"opaque_identity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_personal_identities_opaque_identity_id_unique" UNIQUE("opaque_identity_id"),
	CONSTRAINT "local_personal_identities_owner_unique" UNIQUE("owner_user_id"),
	CONSTRAINT "local_personal_identities_opaque_id_check" CHECK (length(trim("local_personal_identities"."opaque_identity_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "pds_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"source_fingerprint" text NOT NULL,
	"state" text DEFAULT 'quarantined' NOT NULL,
	"resolution_statement_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "pds_conflict_fingerprint_unique" UNIQUE("group_id","source_fingerprint"),
	CONSTRAINT "pds_conflict_state_check" CHECK ("pds_conflicts"."state" in ('quarantined','resolved'))
);
--> statement-breakpoint
CREATE TABLE "pds_inbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_class" text,
	"retained_package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_inbox_replay_unique" UNIQUE("group_id","package_id"),
	CONSTRAINT "pds_inbox_state_check" CHECK ("pds_inbox_entries"."state" in ('pending','downloading','verifying','processing','ready','stale','failed','quarantined','revoked')),
	CONSTRAINT "pds_inbox_attempt_count_check" CHECK ("pds_inbox_entries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pds_logical_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_fingerprint" text,
	"closure_hash" text NOT NULL,
	"local_session_id" uuid,
	"materialization_state" text DEFAULT 'pending' NOT NULL,
	"conflict_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_logical_replica_fingerprint_closure_unique" UNIQUE("group_id","source_fingerprint","closure_hash"),
	CONSTRAINT "pds_logical_replica_local_session_unique" UNIQUE("local_session_id"),
	CONSTRAINT "pds_logical_replica_state_check" CHECK ("pds_logical_replicas"."materialization_state" in ('pending','downloading','verifying','processing','ready','stale','failed','quarantined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pds_origin_high_water_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"accepted_sequence" text DEFAULT '0' NOT NULL,
	"served_sequence" text DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_origin_high_water_unique" UNIQUE("group_id","origin_deployment_id","origin_device_id"),
	CONSTRAINT "pds_origin_high_water_decimal_check" CHECK ("pds_origin_high_water_marks"."accepted_sequence" ~ '^(0|[1-9][0-9]*)$' and "pds_origin_high_water_marks"."served_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_origin_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"next_sequence" text DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_origin_sequence_unique" UNIQUE("group_id","origin_deployment_id","origin_device_id"),
	CONSTRAINT "pds_origin_sequence_decimal_check" CHECK ("pds_origin_sequences"."next_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_outbox_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closure_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_class" text,
	"transport_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_outbox_closure_unique" UNIQUE("closure_id"),
	CONSTRAINT "pds_outbox_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "pds_outbox_state_check" CHECK ("pds_outbox_entries"."state" in ('pending','uploading','committed','acked','paused','failed','quarantined')),
	CONSTRAINT "pds_outbox_attempt_count_check" CHECK ("pds_outbox_entries"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pds_replica_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"replica_id" uuid NOT NULL,
	"retained_package_id" uuid NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"source_sequence" text NOT NULL,
	"source_closed_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_replica_observation_origin_sequence_unique" UNIQUE("replica_id","origin_deployment_id","origin_device_id","source_sequence"),
	CONSTRAINT "pds_replica_observation_package_unique" UNIQUE("retained_package_id"),
	CONSTRAINT "pds_replica_observation_sequence_check" CHECK ("pds_replica_observations"."source_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_retained_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"origin_deployment_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"source_sequence" text NOT NULL,
	"encrypted_envelope" jsonb NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_retained_package_unique" UNIQUE("group_id","package_id"),
	CONSTRAINT "pds_retained_origin_sequence_unique" UNIQUE("group_id","origin_deployment_id","origin_device_id","source_sequence"),
	CONSTRAINT "pds_retained_package_sequence_check" CHECK ("pds_retained_packages"."source_sequence" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "pds_retained_package_state_check" CHECK ("pds_retained_packages"."state" in ('ready','stale','quarantined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pds_session_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_session_id" uuid NOT NULL,
	"source_sequence" text NOT NULL,
	"terminal_cursor" text NOT NULL,
	"terminal_item_count" text NOT NULL,
	"source_closure_hash" text NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_session_closure_session_unique" UNIQUE("group_id","source_session_id"),
	CONSTRAINT "pds_session_closure_sequence_unique" UNIQUE("group_id","source_sequence"),
	CONSTRAINT "pds_session_closure_package_unique" UNIQUE("group_id","package_id"),
	CONSTRAINT "pds_session_closure_sequence_check" CHECK ("pds_session_closures"."source_sequence" ~ '^(0|[1-9][0-9]*)$' and "pds_session_closures"."terminal_cursor" ~ '^(0|[1-9][0-9]*)$' and "pds_session_closures"."terminal_item_count" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "pds_session_closure_state_check" CHECK ("pds_session_closures"."state" in ('ready','quarantined','revoked'))
);
--> statement-breakpoint
CREATE TABLE "pds_source_item_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"closure_id" uuid,
	"replica_id" uuid,
	"conversation_item_id" uuid NOT NULL,
	"source_ordinal" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_source_item_mapping_item_unique" UNIQUE("conversation_item_id"),
	CONSTRAINT "pds_source_item_mapping_closure_ordinal_unique" UNIQUE("closure_id","source_ordinal"),
	CONSTRAINT "pds_source_item_mapping_replica_ordinal_unique" UNIQUE("replica_id","source_ordinal"),
	CONSTRAINT "pds_source_item_mapping_owner_check" CHECK (("pds_source_item_mappings"."closure_id" is null) <> ("pds_source_item_mappings"."replica_id" is null)),
	CONSTRAINT "pds_source_item_mapping_ordinal_check" CHECK ("pds_source_item_mappings"."source_ordinal" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_transport_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"transport_id" text NOT NULL,
	"direction" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_transport_mapping_transport_unique" UNIQUE("group_id","transport_id"),
	CONSTRAINT "pds_transport_mapping_package_direction_unique" UNIQUE("group_id","package_id","direction"),
	CONSTRAINT "pds_transport_mapping_direction_check" CHECK ("pds_transport_mappings"."direction" in ('outbound','inbound'))
);
--> statement-breakpoint
CREATE TABLE "pds_worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"worker_id" text NOT NULL,
	"capability" text NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_worker_heartbeat_unique" UNIQUE("group_id","worker_id","capability"),
	CONSTRAINT "pds_worker_heartbeat_capability_check" CHECK ("pds_worker_heartbeats"."capability" in ('source_publication','receiver_materialization'))
);
--> statement-breakpoint
CREATE TABLE "personal_device_enrollment_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" text,
	"browser_subject_id" text NOT NULL,
	"browser_deployment_id" text NOT NULL,
	"challenge_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_enrollment_challenges_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "personal_device_enrollment_challenge_hash_check" CHECK (length("personal_device_enrollment_challenges"."challenge_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "personal_device_epoch_acks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"epoch" text NOT NULL,
	"canonical_ack" text NOT NULL,
	"acknowledged_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_epoch_ack_unique" UNIQUE("group_id","member_id","epoch"),
	CONSTRAINT "personal_device_epoch_ack_epoch_check" CHECK ("personal_device_epoch_acks"."epoch" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "personal_device_group_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"transition_kind" text NOT NULL,
	"actor_key_id" text,
	"outcome" text NOT NULL,
	"head_sequence" text,
	"head_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_group_audit_outcome_check" CHECK ("personal_device_group_audit_events"."outcome" in ('accepted', 'rejected', 'conflict', 'frozen'))
);
--> statement-breakpoint
CREATE TABLE "personal_device_group_key_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"bundle_hash" text NOT NULL,
	"epoch" text NOT NULL,
	"transition_kind" text NOT NULL,
	"recipient_snapshot" text[] NOT NULL,
	"canonical_bundle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_group_key_bundle_hash_unique" UNIQUE("group_id","bundle_hash"),
	CONSTRAINT "personal_device_group_key_bundle_epoch_unique" UNIQUE("group_id","epoch"),
	CONSTRAINT "personal_device_group_key_bundle_epoch_check" CHECK ("personal_device_group_key_bundles"."epoch" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "personal_device_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_subject_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"signing_public_key" text NOT NULL,
	"kem_key_id" text NOT NULL,
	"kem_public_key" text NOT NULL,
	"operation_families" text[] NOT NULL,
	"status" "personal_device_member_status" DEFAULT 'active' NOT NULL,
	"admitted_sequence" text NOT NULL,
	"revoked_sequence" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_group_member_device_unique" UNIQUE("group_id","device_id"),
	CONSTRAINT "personal_device_group_member_signing_key_unique" UNIQUE("group_id","signing_key_id"),
	CONSTRAINT "personal_device_group_member_kem_key_unique" UNIQUE("group_id","kem_key_id"),
	CONSTRAINT "personal_device_group_member_signing_public_unique" UNIQUE("group_id","signing_public_key"),
	CONSTRAINT "personal_device_group_member_kem_public_unique" UNIQUE("group_id","kem_public_key"),
	CONSTRAINT "personal_device_group_member_operation_check" CHECK ("personal_device_group_members"."operation_families" = ARRAY['pds_relay']::text[])
);
--> statement-breakpoint
CREATE TABLE "personal_device_group_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"sequence" text NOT NULL,
	"previous_hash" text,
	"statement_hash" text NOT NULL,
	"kind" text NOT NULL,
	"canonical_statement" text NOT NULL,
	"redacted_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_group_statement_sequence_unique" UNIQUE("group_id","sequence"),
	CONSTRAINT "personal_device_group_statement_hash_unique" UNIQUE("group_id","statement_hash"),
	CONSTRAINT "personal_device_group_statement_sequence_check" CHECK ("personal_device_group_statements"."sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "personal_device_group_user_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subject_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_device_group_subject_unique" UNIQUE("group_id","user_id"),
	CONSTRAINT "personal_device_group_subject_not_empty_check" CHECK (length(trim("personal_device_group_user_subjects"."subject_id")) > 0 and length(trim("personal_device_group_user_subjects"."deployment_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_device_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_personal_identity_id" uuid NOT NULL,
	"group_id" text NOT NULL,
	"authority_key_id" text NOT NULL,
	"authority_public_key" text NOT NULL,
	"recovery_signing_key_id" text NOT NULL,
	"recovery_signing_public_key" text NOT NULL,
	"recovery_kem_key_id" text NOT NULL,
	"recovery_kem_public_key" text NOT NULL,
	"recovery_kit_hash" text NOT NULL,
	"current_epoch" text NOT NULL,
	"pending_epoch" text,
	"pending_statement_sequence" text,
	"pending_statement_hash" text,
	"pending_bundle_hash" text,
	"head_sequence" text NOT NULL,
	"head_hash" text NOT NULL,
	"state" "personal_device_group_state" DEFAULT 'active' NOT NULL,
	"state_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_groups_group_id_unique" UNIQUE("group_id"),
	CONSTRAINT "personal_device_groups_identity_unique" UNIQUE("local_personal_identity_id"),
	CONSTRAINT "personal_device_groups_epoch_check" CHECK ("personal_device_groups"."current_epoch" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "personal_device_groups_sequence_check" CHECK ("personal_device_groups"."head_sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "personal_device_membership_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"epoch" text NOT NULL,
	"statement_sequence" text NOT NULL,
	"statement_hash" text NOT NULL,
	"authority_key_id" text NOT NULL,
	"canonical_certificate" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "personal_device_membership_certificate_epoch_unique" UNIQUE("group_id","member_id","epoch"),
	CONSTRAINT "personal_device_membership_certificate_epoch_check" CHECK ("personal_device_membership_certificates"."epoch" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "personal_device_remote_link_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"issuer_deployment_id" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_device_remote_link_nonce_unique" UNIQUE("issuer_deployment_id","nonce_hash")
);
--> statement-breakpoint
CREATE TABLE "personal_sync_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	"future_closed_sessions_only" boolean DEFAULT true NOT NULL,
	"historical_backfill_enabled" boolean DEFAULT false NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_sync_policies_group_unique" UNIQUE("group_id"),
	CONSTRAINT "personal_sync_policies_closed_only_check" CHECK ("personal_sync_policies"."future_closed_sessions_only" and not "personal_sync_policies"."historical_backfill_enabled")
);
--> statement-breakpoint
CREATE TABLE "remote_account_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"local_personal_identity_id" uuid NOT NULL,
	"remote_issuer" text NOT NULL,
	"remote_deployment_id" text NOT NULL,
	"remote_subject_id" text NOT NULL,
	"proof_nonce_hash" text NOT NULL,
	"proof_expires_at" timestamp with time zone NOT NULL,
	"sync_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "remote_account_links_identity_remote_unique" UNIQUE("local_personal_identity_id","remote_deployment_id","remote_subject_id"),
	CONSTRAINT "remote_account_links_issuer_check" CHECK (length(trim("remote_account_links"."remote_issuer")) > 0),
	CONSTRAINT "remote_account_links_no_implicit_sync_check" CHECK (not "remote_account_links"."sync_enabled")
);
--> statement-breakpoint
CREATE TABLE "pds_relay_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transport_id" uuid NOT NULL,
	"chunk_index" text NOT NULL,
	"chunk_hash" text NOT NULL,
	"ciphertext" text NOT NULL,
	"ciphertext_bytes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_chunk_unique" UNIQUE("transport_id","chunk_index"),
	CONSTRAINT "pds_relay_chunk_index_check" CHECK ("pds_relay_chunks"."chunk_index" ~ '^(0|[1-9][0-9]*)$' and "pds_relay_chunks"."ciphertext_bytes" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_relay_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"recipient_device_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"sequence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_cursor_unique" UNIQUE("group_id","recipient_device_id","origin_device_id"),
	CONSTRAINT "pds_relay_cursor_sequence_check" CHECK ("pds_relay_cursors"."sequence" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "pds_relay_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transport_id" uuid NOT NULL,
	"recipient_device_id" text NOT NULL,
	"ack_hash" text,
	"acked_at" timestamp with time zone,
	"waiver_hash" text,
	"waived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_recipient_unique" UNIQUE("transport_id","recipient_device_id")
);
--> statement-breakpoint
CREATE TABLE "pds_relay_request_nonces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"nonce_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_nonce_unique" UNIQUE("group_id","device_id","nonce_digest")
);
--> statement-breakpoint
CREATE TABLE "pds_relay_transports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"transport_id" text NOT NULL,
	"sender_device_id" text NOT NULL,
	"origin_device_id" text NOT NULL,
	"package_id" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"version" text NOT NULL,
	"content_epoch" text NOT NULL,
	"recipient_epoch" text NOT NULL,
	"authority_head" text NOT NULL,
	"payload_nonce" text NOT NULL,
	"payload_ciphertext_hash" text NOT NULL,
	"payload_tag" text NOT NULL,
	"plaintext_byte_count" text NOT NULL,
	"chunk_count" text NOT NULL,
	"ciphertext_bytes" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"relay_accepted_at" timestamp with time zone NOT NULL,
	"request_hash" text NOT NULL,
	"canonical_header" text,
	"canonical_envelopes" text,
	"receipt_metadata" text DEFAULT '{}' NOT NULL,
	"package_digest" text,
	"state" text DEFAULT 'uploading' NOT NULL,
	"committed_at" timestamp with time zone,
	"cleanup_after" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_relay_transport_group_unique" UNIQUE("group_id","transport_id"),
	CONSTRAINT "pds_relay_transport_state_check" CHECK ("pds_relay_transports"."state" in ('uploading','committed','expired','quarantined')),
	CONSTRAINT "pds_relay_transport_count_check" CHECK ("pds_relay_transports"."chunk_count" ~ '^(0|[1-9][0-9]*)$' and "pds_relay_transports"."plaintext_byte_count" ~ '^(0|[1-9][0-9]*)$' and "pds_relay_transports"."ciphertext_bytes" ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
ALTER TABLE "local_personal_identities" ADD CONSTRAINT "local_personal_identities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_conflicts" ADD CONSTRAINT "pds_conflicts_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_entries_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_entries_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_entries_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replicas_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replicas_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replicas_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_origin_high_water_marks" ADD CONSTRAINT "pds_origin_high_water_marks_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_origin_sequences" ADD CONSTRAINT "pds_origin_sequences_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_entries_closure_id_pds_session_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."pds_session_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_replica_observations" ADD CONSTRAINT "pds_replica_observations_replica_id_pds_logical_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."pds_logical_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_replica_observations" ADD CONSTRAINT "pds_replica_observations_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD CONSTRAINT "pds_retained_packages_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD CONSTRAINT "pds_retained_packages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_closures_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_closures_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_closures_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_source_item_mappings" ADD CONSTRAINT "pds_source_item_mappings_closure_id_pds_session_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."pds_session_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_source_item_mappings" ADD CONSTRAINT "pds_source_item_mappings_replica_id_pds_logical_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."pds_logical_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_source_item_mappings" ADD CONSTRAINT "pds_source_item_mappings_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_transport_mappings" ADD CONSTRAINT "pds_transport_mappings_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_worker_heartbeats" ADD CONSTRAINT "pds_worker_heartbeats_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_enrollment_challenges" ADD CONSTRAINT "personal_device_enrollment_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_epoch_acks" ADD CONSTRAINT "personal_device_epoch_acks_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_epoch_acks" ADD CONSTRAINT "personal_device_epoch_acks_member_id_personal_device_group_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."personal_device_group_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_audit_events" ADD CONSTRAINT "personal_device_group_audit_events_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_key_bundles" ADD CONSTRAINT "personal_device_group_key_bundles_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_members" ADD CONSTRAINT "personal_device_group_members_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_members" ADD CONSTRAINT "personal_device_group_members_user_subject_id_personal_device_group_user_subjects_id_fk" FOREIGN KEY ("user_subject_id") REFERENCES "public"."personal_device_group_user_subjects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_statements" ADD CONSTRAINT "personal_device_group_statements_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_user_subjects" ADD CONSTRAINT "personal_device_group_user_subjects_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_group_user_subjects" ADD CONSTRAINT "personal_device_group_user_subjects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_groups" ADD CONSTRAINT "personal_device_groups_local_personal_identity_id_local_personal_identities_id_fk" FOREIGN KEY ("local_personal_identity_id") REFERENCES "public"."local_personal_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_membership_certificates" ADD CONSTRAINT "personal_device_membership_certificates_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_membership_certificates" ADD CONSTRAINT "personal_device_membership_certificates_member_id_personal_device_group_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."personal_device_group_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_device_remote_link_nonces" ADD CONSTRAINT "personal_device_remote_link_nonces_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_sync_policies" ADD CONSTRAINT "personal_sync_policies_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_sync_policies" ADD CONSTRAINT "personal_sync_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_account_links" ADD CONSTRAINT "remote_account_links_local_personal_identity_id_local_personal_identities_id_fk" FOREIGN KEY ("local_personal_identity_id") REFERENCES "public"."local_personal_identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_chunks" ADD CONSTRAINT "pds_relay_chunks_transport_id_pds_relay_transports_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."pds_relay_transports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_cursors" ADD CONSTRAINT "pds_relay_cursors_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_recipients" ADD CONSTRAINT "pds_relay_recipients_transport_id_pds_relay_transports_id_fk" FOREIGN KEY ("transport_id") REFERENCES "public"."pds_relay_transports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_request_nonces" ADD CONSTRAINT "pds_relay_request_nonces_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_relay_transports" ADD CONSTRAINT "pds_relay_transports_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_inbox_claim_idx" ON "pds_inbox_entries" USING btree ("state","retry_at");--> statement-breakpoint
CREATE INDEX "pds_logical_replica_recall_idx" ON "pds_logical_replicas" USING btree ("owner_user_id","materialization_state");--> statement-breakpoint
CREATE INDEX "pds_outbox_claim_idx" ON "pds_outbox_entries" USING btree ("state","retry_at");--> statement-breakpoint
CREATE INDEX "personal_device_enrollment_challenge_active_idx" ON "personal_device_enrollment_challenges" USING btree ("user_id","expires_at") WHERE "personal_device_enrollment_challenges"."used_at" is null;--> statement-breakpoint
CREATE INDEX "personal_device_group_members_active_idx" ON "personal_device_group_members" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "personal_device_membership_certificate_active_idx" ON "personal_device_membership_certificates" USING btree ("group_id","expires_at") WHERE "personal_device_membership_certificates"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "pds_relay_recipient_mailbox_idx" ON "pds_relay_recipients" USING btree ("recipient_device_id","acked_at");--> statement-breakpoint
CREATE INDEX "pds_relay_nonce_expiry_idx" ON "pds_relay_request_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "pds_relay_transport_mailbox_idx" ON "pds_relay_transports" USING btree ("group_id","state","expires_at");