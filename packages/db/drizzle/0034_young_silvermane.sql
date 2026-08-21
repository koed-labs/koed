DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM collaboration_shared_memory_consents LIMIT 1)
     OR EXISTS (SELECT 1 FROM collaboration_shared_memory_grants LIMIT 1)
     OR EXISTS (SELECT 1 FROM collaboration_shared_memory_previews LIMIT 1)
     OR EXISTS (SELECT 1 FROM pending_share_operations LIMIT 1)
     OR EXISTS (SELECT 1 FROM shared_memory_candidate_previews LIMIT 1)
     OR EXISTS (SELECT 1 FROM shared_source_artifacts LIMIT 1)
     OR EXISTS (SELECT 1 FROM shared_source_previews LIMIT 1)
     OR EXISTS (SELECT 1 FROM source_owner_representation_consents LIMIT 1)
     OR EXISTS (SELECT 1 FROM source_owner_representation_policies LIMIT 1)
     OR EXISTS (SELECT 1 FROM team_memory_representations LIMIT 1)
     OR EXISTS (SELECT 1 FROM team_representation_policies LIMIT 1)
     OR EXISTS (SELECT 1 FROM team_session_share_grants LIMIT 1)
     OR EXISTS (SELECT 1 FROM workspace_representation_policies LIMIT 1)
  THEN
    RAISE EXCEPTION 'Migration 0034 requires a disposable-alpha Team sharing reset before selective PII protection can be enabled';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "lcm_summary_work_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"memory_node_id" uuid NOT NULL,
	"work_identity" text NOT NULL,
	"input_revision_hash" text NOT NULL,
	"compatibility_contract_hash" text NOT NULL,
	"claimant_id" text NOT NULL,
	"pds_claimant_device_id" text,
	"pds_claim_generation" text,
	"claim_generation" bigint DEFAULT 1 NOT NULL,
	"claim_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lcm_summary_work_claim_identity_unique" UNIQUE("owner_user_id","work_identity"),
	CONSTRAINT "lcm_summary_work_claim_hash_check" CHECK ("lcm_summary_work_claims"."work_identity" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$'
        and "lcm_summary_work_claims"."input_revision_hash" ~ '^[0-9a-f]{64}$'
        and "lcm_summary_work_claims"."compatibility_contract_hash" ~ '^([0-9a-f]{64}|[A-Za-z0-9_-]{43})$'),
	CONSTRAINT "lcm_summary_work_claim_claimant_check" CHECK (length(trim("lcm_summary_work_claims"."claimant_id")) between 1 and 200),
	CONSTRAINT "lcm_summary_work_claim_pds_fence_check" CHECK (("lcm_summary_work_claims"."pds_claimant_device_id" is null and "lcm_summary_work_claims"."pds_claim_generation" is null)
        or (length(trim("lcm_summary_work_claims"."pds_claimant_device_id")) between 1 and 200
          and "lcm_summary_work_claims"."pds_claim_generation" ~ '^(0|[1-9][0-9]*)$')),
	CONSTRAINT "lcm_summary_work_claim_generation_check" CHECK ("lcm_summary_work_claims"."claim_generation" > 0),
	CONSTRAINT "lcm_summary_work_claim_state_check" CHECK ("lcm_summary_work_claims"."state" in ('active','completed','released')),
	CONSTRAINT "lcm_summary_work_claim_completion_check" CHECK (("lcm_summary_work_claims"."state" = 'completed' and "lcm_summary_work_claims"."completed_at" is not null)
        or ("lcm_summary_work_claims"."state" <> 'completed' and "lcm_summary_work_claims"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "pds_lcm_work_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"memory_node_id" uuid NOT NULL,
	"work_identity" text NOT NULL,
	"work_class" text NOT NULL,
	"compatibility_contract_hash" text NOT NULL,
	"compatibility_contract_json" jsonb NOT NULL,
	"input_revision_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_lcm_work_intent_identity_unique" UNIQUE("group_id","work_identity"),
	CONSTRAINT "pds_lcm_work_intent_node_contract_unique" UNIQUE("memory_node_id","compatibility_contract_hash","input_revision_hash"),
	CONSTRAINT "pds_lcm_work_intent_class_check" CHECK ("pds_lcm_work_intents"."work_class" in ('lcm_leaf','lcm_rollup')),
	CONSTRAINT "pds_lcm_work_intent_state_check" CHECK ("pds_lcm_work_intents"."state" in ('pending','claimed','completed','superseded'))
);
--> statement-breakpoint
CREATE TABLE "privacy_classification_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"classifier_generation_id" uuid NOT NULL,
	"classifier_hash" text NOT NULL,
	"owner_content_fingerprint" text NOT NULL,
	"input_byte_length" integer NOT NULL,
	"payload_binding_hash" text,
	"span_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	CONSTRAINT "privacy_classification_results_hashes_check" CHECK ("privacy_classification_results"."classifier_hash" ~ '^[0-9a-f]{64}$'
        and "privacy_classification_results"."owner_content_fingerprint" ~ '^[0-9a-f]{64}$'
        and ("privacy_classification_results"."payload_binding_hash" is null or "privacy_classification_results"."payload_binding_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "privacy_classification_results_counts_check" CHECK ("privacy_classification_results"."input_byte_length" >= 0
        and ("privacy_classification_results"."span_count" is null or "privacy_classification_results"."span_count" >= 0)),
	CONSTRAINT "privacy_classification_results_status_check" CHECK ("privacy_classification_results"."status" in ('pending','ready','failed','invalidated')),
	CONSTRAINT "privacy_classification_results_lifecycle_check" CHECK ((
          "privacy_classification_results"."status" = 'pending'
          and "privacy_classification_results"."payload_binding_hash" is null
          and "privacy_classification_results"."span_count" is null
          and "privacy_classification_results"."failure_code" is null
          and "privacy_classification_results"."ready_at" is null
          and "privacy_classification_results"."invalidated_at" is null
          and "privacy_classification_results"."invalidation_reason_code" is null
        ) or (
          "privacy_classification_results"."status" = 'ready'
          and "privacy_classification_results"."payload_binding_hash" is not null
          and "privacy_classification_results"."span_count" is not null
          and "privacy_classification_results"."failure_code" is null
          and "privacy_classification_results"."ready_at" is not null
          and "privacy_classification_results"."invalidated_at" is null
          and "privacy_classification_results"."invalidation_reason_code" is null
        ) or (
          "privacy_classification_results"."status" = 'failed'
          and "privacy_classification_results"."payload_binding_hash" is null
          and "privacy_classification_results"."span_count" is null
          and length(trim("privacy_classification_results"."failure_code")) > 0
          and "privacy_classification_results"."ready_at" is null
          and "privacy_classification_results"."invalidated_at" is not null
          and "privacy_classification_results"."invalidation_reason_code" is not null
        ) or (
          "privacy_classification_results"."status" = 'invalidated'
          and "privacy_classification_results"."invalidated_at" is not null
          and length(trim("privacy_classification_results"."invalidation_reason_code")) > 0
        ))
);
--> statement-breakpoint
CREATE TABLE "privacy_classifier_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"classifier_hash" text NOT NULL,
	"model_key" text NOT NULL,
	"model_revision" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"tokenizer_sha256" text NOT NULL,
	"decoder_sha256" text NOT NULL,
	"calibration_sha256" text NOT NULL,
	"deterministic_detector_version" text NOT NULL,
	"input_contract_version" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason_code" text,
	CONSTRAINT "privacy_classifier_generations_version_unique" UNIQUE("version"),
	CONSTRAINT "privacy_classifier_generations_hash_unique" UNIQUE("classifier_hash"),
	CONSTRAINT "privacy_classifier_generations_id_hash_unique" UNIQUE("id","classifier_hash"),
	CONSTRAINT "privacy_classifier_generations_version_check" CHECK ("privacy_classifier_generations"."version" > 0),
	CONSTRAINT "privacy_classifier_generations_hashes_check" CHECK ("privacy_classifier_generations"."classifier_hash" ~ '^[0-9a-f]{64}$'
        and "privacy_classifier_generations"."artifact_sha256" ~ '^[0-9a-f]{64}$'
        and "privacy_classifier_generations"."tokenizer_sha256" ~ '^[0-9a-f]{64}$'
        and "privacy_classifier_generations"."decoder_sha256" ~ '^[0-9a-f]{64}$'
        and "privacy_classifier_generations"."calibration_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "privacy_classifier_generations_components_check" CHECK (length(trim("privacy_classifier_generations"."model_key")) > 0
        and length(trim("privacy_classifier_generations"."model_revision")) > 0
        and length(trim("privacy_classifier_generations"."deterministic_detector_version")) > 0
        and length(trim("privacy_classifier_generations"."input_contract_version")) > 0),
	CONSTRAINT "privacy_classifier_generations_status_check" CHECK ("privacy_classifier_generations"."status" in ('staged','active','retired','revoked')),
	CONSTRAINT "privacy_classifier_generations_lifecycle_check" CHECK ((
          "privacy_classifier_generations"."status" = 'staged'
          and "privacy_classifier_generations"."activated_at" is null
          and "privacy_classifier_generations"."retired_at" is null
          and "privacy_classifier_generations"."revoked_at" is null
          and "privacy_classifier_generations"."revocation_reason_code" is null
        ) or (
          "privacy_classifier_generations"."status" = 'active'
          and "privacy_classifier_generations"."activated_at" is not null
          and "privacy_classifier_generations"."retired_at" is null
          and "privacy_classifier_generations"."revoked_at" is null
          and "privacy_classifier_generations"."revocation_reason_code" is null
        ) or (
          "privacy_classifier_generations"."status" = 'retired'
          and "privacy_classifier_generations"."activated_at" is not null
          and "privacy_classifier_generations"."retired_at" is not null
          and "privacy_classifier_generations"."revoked_at" is null
          and "privacy_classifier_generations"."revocation_reason_code" is null
        ) or (
          "privacy_classifier_generations"."status" = 'revoked'
          and "privacy_classifier_generations"."revoked_at" is not null
          and length(trim("privacy_classifier_generations"."revocation_reason_code")) > 0
        ))
);
--> statement-breakpoint
CREATE TABLE "privacy_content_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"scope" text NOT NULL,
	"deployment_identity_id" uuid NOT NULL,
	"source_owner_user_id" uuid,
	"team_id" uuid,
	"team_workspace_id" uuid,
	"labels" jsonb NOT NULL,
	"replacement_contract_version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason_code" text,
	CONSTRAINT "privacy_content_policies_id_version_unique" UNIQUE("policy_id","version"),
	CONSTRAINT "privacy_content_policies_id_version_hash_unique" UNIQUE("policy_id","version","policy_hash"),
	CONSTRAINT "privacy_content_policies_scope_check" CHECK ((
          "privacy_content_policies"."scope" = 'deployment'
          and "privacy_content_policies"."source_owner_user_id" is null
          and "privacy_content_policies"."team_id" is null
          and "privacy_content_policies"."team_workspace_id" is null
        ) or (
          "privacy_content_policies"."scope" = 'source_owner'
          and "privacy_content_policies"."source_owner_user_id" is not null
          and "privacy_content_policies"."team_id" is null
          and "privacy_content_policies"."team_workspace_id" is null
        ) or (
          "privacy_content_policies"."scope" = 'team'
          and "privacy_content_policies"."source_owner_user_id" is null
          and "privacy_content_policies"."team_id" is not null
          and "privacy_content_policies"."team_workspace_id" is null
        ) or (
          "privacy_content_policies"."scope" = 'workspace'
          and "privacy_content_policies"."source_owner_user_id" is null
          and "privacy_content_policies"."team_id" is not null
          and "privacy_content_policies"."team_workspace_id" is not null
        )),
	CONSTRAINT "privacy_content_policies_labels_check" CHECK (jsonb_typeof("privacy_content_policies"."labels") = 'object'
        and "privacy_content_policies"."labels" ?& array[
          'account_number','private_address','private_email','private_person',
          'private_phone','private_url','private_date','secret'
        ]
        and "privacy_content_policies"."labels" - array[
          'account_number','private_address','private_email','private_person',
          'private_phone','private_url','private_date','secret'
        ] = '{}'::jsonb
        and jsonb_typeof("privacy_content_policies"."labels"->'account_number') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'private_address') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'private_email') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'private_person') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'private_phone') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'private_url') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'private_date') = 'boolean'
        and jsonb_typeof("privacy_content_policies"."labels"->'secret') = 'boolean'),
	CONSTRAINT "privacy_content_policies_hash_check" CHECK ("privacy_content_policies"."policy_hash" ~ '^[0-9a-f]{64}$' and "privacy_content_policies"."version" > 0),
	CONSTRAINT "privacy_content_policies_status_check" CHECK ("privacy_content_policies"."status" in ('active','superseded','revoked')),
	CONSTRAINT "privacy_content_policies_lifecycle_check" CHECK ((
          "privacy_content_policies"."status" = 'active'
          and "privacy_content_policies"."superseded_at" is null
          and "privacy_content_policies"."revoked_at" is null
          and "privacy_content_policies"."revocation_reason_code" is null
        ) or (
          "privacy_content_policies"."status" = 'superseded'
          and "privacy_content_policies"."superseded_at" is not null
          and "privacy_content_policies"."revoked_at" is null
          and "privacy_content_policies"."revocation_reason_code" is null
        ) or (
          "privacy_content_policies"."status" = 'revoked'
          and "privacy_content_policies"."revoked_at" is not null
          and length(trim("privacy_content_policies"."revocation_reason_code")) > 0
        ))
);
--> statement-breakpoint
CREATE TABLE "privacy_sanitized_source_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"classifier_generation_id" uuid NOT NULL,
	"classifier_hash" text NOT NULL,
	"effective_policy_hash" text NOT NULL,
	"source_frontier_hash" text NOT NULL,
	"source_frontier_cursor" bigint NOT NULL,
	"source_segment_count" integer NOT NULL,
	"source_closure_hash" text,
	"owner_manifest_fingerprint" text NOT NULL,
	"metadata_binding_hash" text,
	"artifact_binding_hash" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"sanitized_byte_count" bigint DEFAULT 0 NOT NULL,
	"format" text NOT NULL,
	"format_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	CONSTRAINT "privacy_sanitized_source_artifacts_hashes_check" CHECK ("privacy_sanitized_source_artifacts"."classifier_hash" ~ '^[0-9a-f]{64}$'
        and "privacy_sanitized_source_artifacts"."effective_policy_hash" ~ '^[0-9a-f]{64}$'
        and "privacy_sanitized_source_artifacts"."source_frontier_hash" ~ '^[0-9a-f]{64}$'
        and ("privacy_sanitized_source_artifacts"."source_closure_hash" is null or "privacy_sanitized_source_artifacts"."source_closure_hash" ~ '^[0-9a-f]{64}$')
        and "privacy_sanitized_source_artifacts"."owner_manifest_fingerprint" ~ '^[0-9a-f]{64}$'
        and ("privacy_sanitized_source_artifacts"."metadata_binding_hash" is null or "privacy_sanitized_source_artifacts"."metadata_binding_hash" ~ '^[0-9a-f]{64}$')
        and ("privacy_sanitized_source_artifacts"."artifact_binding_hash" is null or "privacy_sanitized_source_artifacts"."artifact_binding_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "privacy_sanitized_source_artifacts_counts_check" CHECK ("privacy_sanitized_source_artifacts"."chunk_count" >= 0
        and "privacy_sanitized_source_artifacts"."sanitized_byte_count" >= 0
        and "privacy_sanitized_source_artifacts"."source_frontier_cursor" >= 0
        and "privacy_sanitized_source_artifacts"."source_segment_count" >= 0
        and "privacy_sanitized_source_artifacts"."format_version" > 0
        and length(trim("privacy_sanitized_source_artifacts"."format")) > 0),
	CONSTRAINT "privacy_sanitized_source_artifacts_status_check" CHECK ("privacy_sanitized_source_artifacts"."status" in ('pending','ready','failed','invalidated')),
	CONSTRAINT "privacy_sanitized_source_artifacts_lifecycle_check" CHECK ((
          "privacy_sanitized_source_artifacts"."status" = 'pending'
          and "privacy_sanitized_source_artifacts"."metadata_binding_hash" is null
          and "privacy_sanitized_source_artifacts"."artifact_binding_hash" is null
          and "privacy_sanitized_source_artifacts"."failure_code" is null
          and "privacy_sanitized_source_artifacts"."ready_at" is null
          and "privacy_sanitized_source_artifacts"."invalidated_at" is null
        ) or (
          "privacy_sanitized_source_artifacts"."status" = 'ready'
          and "privacy_sanitized_source_artifacts"."metadata_binding_hash" is not null
          and "privacy_sanitized_source_artifacts"."artifact_binding_hash" is not null
          and "privacy_sanitized_source_artifacts"."failure_code" is null
          and "privacy_sanitized_source_artifacts"."ready_at" is not null
          and "privacy_sanitized_source_artifacts"."invalidated_at" is null
        ) or (
          "privacy_sanitized_source_artifacts"."status" = 'failed'
          and length(trim("privacy_sanitized_source_artifacts"."failure_code")) > 0
          and "privacy_sanitized_source_artifacts"."invalidated_at" is not null
          and length(trim("privacy_sanitized_source_artifacts"."invalidation_reason_code")) > 0
        ) or (
          "privacy_sanitized_source_artifacts"."status" = 'invalidated'
          and "privacy_sanitized_source_artifacts"."invalidated_at" is not null
          and length(trim("privacy_sanitized_source_artifacts"."invalidation_reason_code")) > 0
        ))
);
--> statement-breakpoint
CREATE TABLE "privacy_sanitized_source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"classification_result_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"source_start_byte" bigint NOT NULL,
	"source_end_byte" bigint NOT NULL,
	"sanitized_byte_length" integer NOT NULL,
	"owner_chunk_fingerprint" text NOT NULL,
	"payload_binding_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	CONSTRAINT "privacy_sanitized_source_chunks_artifact_index_unique" UNIQUE("artifact_id","chunk_index"),
	CONSTRAINT "privacy_sanitized_source_chunks_artifact_fingerprint_unique" UNIQUE("artifact_id","owner_chunk_fingerprint"),
	CONSTRAINT "privacy_sanitized_source_chunks_offsets_check" CHECK ("privacy_sanitized_source_chunks"."chunk_index" >= 0
        and "privacy_sanitized_source_chunks"."source_start_byte" >= 0
        and "privacy_sanitized_source_chunks"."source_end_byte" > "privacy_sanitized_source_chunks"."source_start_byte"
        and "privacy_sanitized_source_chunks"."sanitized_byte_length" >= 0),
	CONSTRAINT "privacy_sanitized_source_chunks_hashes_check" CHECK ("privacy_sanitized_source_chunks"."owner_chunk_fingerprint" ~ '^[0-9a-f]{64}$'
        and "privacy_sanitized_source_chunks"."payload_binding_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "privacy_sanitized_source_chunks_lifecycle_check" CHECK (("privacy_sanitized_source_chunks"."invalidated_at" is null and "privacy_sanitized_source_chunks"."invalidation_reason_code" is null)
        or ("privacy_sanitized_source_chunks"."invalidated_at" is not null and length(trim("privacy_sanitized_source_chunks"."invalidation_reason_code")) > 0))
);
--> statement-breakpoint
CREATE TABLE "shared_source_semantic_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_preview_id" uuid NOT NULL,
	"source_artifact_id" uuid NOT NULL,
	"source_preview_revision" integer NOT NULL,
	"source_preview_hash" text NOT NULL,
	"source_artifact_hash" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_hash" text NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"classification_result_id" uuid,
	"classification_payload_binding_hash" text,
	"classifier_generation_id" uuid NOT NULL,
	"classifier_version" integer NOT NULL,
	"classifier_hash" text NOT NULL,
	"effective_privacy_policy_hash" text NOT NULL,
	"source_item_identity_hash" text,
	"source_item_count" integer,
	"sanitized_content_hash" text,
	"payload_binding_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"last_error_class" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason_code" text,
	CONSTRAINT "shared_source_semantic_previews_scope_unique" UNIQUE("id","source_preview_id","source_artifact_id","logical_memory_id","team_id","team_workspace_id","representation","source_revision"),
	CONSTRAINT "shared_source_semantic_previews_revision_check" CHECK ("shared_source_semantic_previews"."source_preview_revision" > 0
        and "shared_source_semantic_previews"."source_revision" >= 0
        and "shared_source_semantic_previews"."classifier_version" > 0),
	CONSTRAINT "shared_source_semantic_previews_hash_check" CHECK ("shared_source_semantic_previews"."source_preview_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."source_artifact_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."source_manifest_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."source_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."classifier_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."effective_privacy_policy_hash" ~ '^[0-9a-f]{64}$'
        and ("shared_source_semantic_previews"."classification_payload_binding_hash" is null
          or "shared_source_semantic_previews"."classification_payload_binding_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."source_item_identity_hash" is null
          or "shared_source_semantic_previews"."source_item_identity_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."sanitized_content_hash" is null
          or "shared_source_semantic_previews"."sanitized_content_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."payload_binding_hash" is null
          or "shared_source_semantic_previews"."payload_binding_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "shared_source_semantic_previews_status_check" CHECK ("shared_source_semantic_previews"."status" in ('pending','ready','failed','stale','invalidated')),
	CONSTRAINT "shared_source_semantic_previews_item_count_check" CHECK ("shared_source_semantic_previews"."source_item_count" is null or "shared_source_semantic_previews"."source_item_count" between 1 and 2048),
	CONSTRAINT "shared_source_semantic_previews_retry_check" CHECK ("shared_source_semantic_previews"."attempt_count" >= 0
        and (("shared_source_semantic_previews"."attempt_count" = 0 and "shared_source_semantic_previews"."next_attempt_at" is null
              and "shared_source_semantic_previews"."last_error_class" is null)
          or ("shared_source_semantic_previews"."attempt_count" > 0 and "shared_source_semantic_previews"."status" = 'pending'
              and "shared_source_semantic_previews"."next_attempt_at" is not null
              and length(trim("shared_source_semantic_previews"."last_error_class")) > 0))),
	CONSTRAINT "shared_source_semantic_previews_lifecycle_check" CHECK ((
          "shared_source_semantic_previews"."status" = 'pending'
          and "shared_source_semantic_previews"."classification_result_id" is null
          and "shared_source_semantic_previews"."classification_payload_binding_hash" is null
          and "shared_source_semantic_previews"."source_item_identity_hash" is null
          and "shared_source_semantic_previews"."source_item_count" is null
          and "shared_source_semantic_previews"."sanitized_content_hash" is null
          and "shared_source_semantic_previews"."payload_binding_hash" is null
          and "shared_source_semantic_previews"."failure_code" is null
          and "shared_source_semantic_previews"."ready_at" is null
          and "shared_source_semantic_previews"."failed_at" is null
          and "shared_source_semantic_previews"."stale_at" is null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and "shared_source_semantic_previews"."invalidation_reason_code" is null
        ) or (
          "shared_source_semantic_previews"."status" = 'ready'
          and "shared_source_semantic_previews"."classification_result_id" is not null
          and "shared_source_semantic_previews"."classification_payload_binding_hash" is not null
          and "shared_source_semantic_previews"."source_item_identity_hash" is not null
          and "shared_source_semantic_previews"."source_item_count" is not null
          and "shared_source_semantic_previews"."sanitized_content_hash" is not null
          and "shared_source_semantic_previews"."payload_binding_hash" is not null
          and "shared_source_semantic_previews"."failure_code" is null
          and "shared_source_semantic_previews"."ready_at" is not null
          and "shared_source_semantic_previews"."failed_at" is null
          and "shared_source_semantic_previews"."stale_at" is null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and "shared_source_semantic_previews"."invalidation_reason_code" is null
        ) or (
          "shared_source_semantic_previews"."status" = 'failed'
          and "shared_source_semantic_previews"."classification_result_id" is null
          and "shared_source_semantic_previews"."classification_payload_binding_hash" is null
          and "shared_source_semantic_previews"."source_item_identity_hash" is not null
          and "shared_source_semantic_previews"."source_item_count" is not null
          and "shared_source_semantic_previews"."sanitized_content_hash" is null
          and "shared_source_semantic_previews"."payload_binding_hash" is null
          and length(trim("shared_source_semantic_previews"."failure_code")) > 0
          and "shared_source_semantic_previews"."ready_at" is null
          and "shared_source_semantic_previews"."failed_at" is not null
          and "shared_source_semantic_previews"."stale_at" is null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and "shared_source_semantic_previews"."invalidation_reason_code" is null
        ) or (
          "shared_source_semantic_previews"."status" = 'stale'
          and "shared_source_semantic_previews"."classification_result_id" is not null
          and "shared_source_semantic_previews"."classification_payload_binding_hash" is not null
          and "shared_source_semantic_previews"."source_item_identity_hash" is not null
          and "shared_source_semantic_previews"."source_item_count" is not null
          and "shared_source_semantic_previews"."sanitized_content_hash" is not null
          and "shared_source_semantic_previews"."payload_binding_hash" is not null
          and "shared_source_semantic_previews"."failure_code" is null
          and "shared_source_semantic_previews"."ready_at" is not null
          and "shared_source_semantic_previews"."failed_at" is null
          and "shared_source_semantic_previews"."stale_at" is not null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and length(trim("shared_source_semantic_previews"."invalidation_reason_code")) > 0
        ) or (
          "shared_source_semantic_previews"."status" = 'invalidated'
          and "shared_source_semantic_previews"."invalidated_at" is not null
          and length(trim("shared_source_semantic_previews"."invalidation_reason_code")) > 0
        ))
);
--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" DROP CONSTRAINT "csm_consents_preview_binding_fk";--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" DROP CONSTRAINT "csm_previews_consent_binding_unique";--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_revision_unique";--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" DROP CONSTRAINT "csm_previews_hashes_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" DROP CONSTRAINT "encrypted_field_backfill_runs_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_state_check";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_replacement_values_check";--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" DROP CONSTRAINT "shared_source_artifacts_hash_check";--> statement-breakpoint
ALTER TABLE "shared_source_previews" DROP CONSTRAINT "shared_source_previews_hash_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_allowed_set_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_revision_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_hash_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" DROP CONSTRAINT "source_owner_representation_policies_allowed_set_check";--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_version_check";--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_hash_check";--> statement-breakpoint
ALTER TABLE "team_memory_semantic_items" DROP CONSTRAINT "team_memory_semantic_items_embedding_check";--> statement-breakpoint
ALTER TABLE "team_representation_policies" DROP CONSTRAINT "team_representation_policies_allowed_set_check";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP CONSTRAINT "team_session_share_grants_representation_check";--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" DROP CONSTRAINT "workspace_representation_policies_allowed_set_check";--> statement-breakpoint
ALTER TABLE "collaboration_outbox" ALTER COLUMN "family" SET DATA TYPE text;--> statement-breakpoint
UPDATE "collaboration_outbox"
   SET "family" = 'fidelity_changed'
 WHERE "family" = 'representation_changed';--> statement-breakpoint
DROP TYPE "public"."collaboration_event_family";--> statement-breakpoint
CREATE TYPE "public"."collaboration_event_family" AS ENUM('team_lifecycle', 'team_membership_access', 'team_presence_changed', 'workspace_lifecycle_access', 'thread_lifecycle', 'message_created', 'receipt_state_updated', 'share_grant_lifecycle', 'fidelity_changed', 'memory_event_available', 'lcm_leaf_available', 'lcm_rollup_available', 'shared_session_discussion_activity', 'personal_memory_changed', 'pending_share_lifecycle', 'managed_conversation_changed', 'access_revoked');--> statement-breakpoint
ALTER TABLE "collaboration_outbox" ALTER COLUMN "family" SET DATA TYPE "public"."collaboration_event_family" USING "family"::"public"."collaboration_event_family";--> statement-breakpoint
DROP INDEX "team_memory_semantic_items_pending_idx";--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" ADD COLUMN "include_curated_memory" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" ADD COLUMN "include_curated_memory" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD COLUMN "include_curated_memory" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD COLUMN "source_content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "embedding_source_content_hash" text;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "embedding_input_hash" text;--> statement-breakpoint
UPDATE "memory_embeddings"
SET "embedding_source_content_hash" = rtrim(translate(encode(digest("source_hash", 'sha256'), 'base64'), '+/', '-_'), '='),
    "embedding_input_hash" = rtrim(translate(encode(digest(coalesce("source_text", ''), 'sha256'), 'base64'), '+/', '-_'), '=');--> statement-breakpoint
ALTER TABLE "memory_embeddings" ALTER COLUMN "embedding_source_content_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ALTER COLUMN "embedding_input_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "include_curated_memory" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "replacement_maximum_fidelity" "shared_memory_representation";--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "replacement_include_curated_memory" boolean;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "include_curated_memory" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "source_content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" ADD COLUMN "include_curated_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "include_curated_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "fidelity_policy_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "fidelity_policy_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD COLUMN "source_content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" ADD COLUMN "include_curated_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "sanitized_source_preview_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "privacy_classifier_generation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "privacy_classifier_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "effective_privacy_policy_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_manifest_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "sanitized_content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "fidelity_policy_revision" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_semantic_items" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_representation_policies" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "team_representation_policies" ADD COLUMN "include_curated_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "maximum_fidelity" "shared_memory_representation";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "include_curated_memory" boolean;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "fidelity_policy_revision" integer;--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD COLUMN "maximum_fidelity" "shared_memory_representation" NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD COLUMN "include_curated_memory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lcm_summary_work_claims" ADD CONSTRAINT "lcm_summary_work_claims_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lcm_summary_work_claims" ADD CONSTRAINT "lcm_summary_work_claims_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_lcm_work_intents" ADD CONSTRAINT "pds_lcm_work_intents_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_lcm_work_intents" ADD CONSTRAINT "pds_lcm_work_intents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_lcm_work_intents" ADD CONSTRAINT "pds_lcm_work_intents_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_classification_results" ADD CONSTRAINT "privacy_classification_results_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_classification_results" ADD CONSTRAINT "privacy_classification_results_classifier_generation_id_classifier_hash_privacy_classifier_generations_id_classifier_hash_fk" FOREIGN KEY ("classifier_generation_id","classifier_hash") REFERENCES "public"."privacy_classifier_generations"("id","classifier_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_content_policies" ADD CONSTRAINT "privacy_content_policies_deployment_identity_id_deployment_identities_id_fk" FOREIGN KEY ("deployment_identity_id") REFERENCES "public"."deployment_identities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_content_policies" ADD CONSTRAINT "privacy_content_policies_source_owner_user_id_users_id_fk" FOREIGN KEY ("source_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_content_policies" ADD CONSTRAINT "privacy_content_policies_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_content_policies" ADD CONSTRAINT "privacy_content_policies_team_workspace_id_team_id_team_workspaces_id_team_id_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" ADD CONSTRAINT "privacy_sanitized_source_artifacts_share_grant_id_team_session_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_session_share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" ADD CONSTRAINT "privacy_sanitized_source_artifacts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" ADD CONSTRAINT "privacy_sanitized_source_artifacts_source_artifact_id_owner_user_id_conversation_source_artifacts_id_owner_user_id_fk" FOREIGN KEY ("source_artifact_id","owner_user_id") REFERENCES "public"."conversation_source_artifacts"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" ADD CONSTRAINT "privacy_sanitized_source_artifacts_team_workspace_id_team_id_team_workspaces_id_team_id_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_artifacts" ADD CONSTRAINT "privacy_sanitized_source_artifacts_classifier_generation_id_classifier_hash_privacy_classifier_generations_id_classifier_hash_fk" FOREIGN KEY ("classifier_generation_id","classifier_hash") REFERENCES "public"."privacy_classifier_generations"("id","classifier_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_chunks" ADD CONSTRAINT "privacy_sanitized_source_chunks_artifact_id_privacy_sanitized_source_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."privacy_sanitized_source_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_sanitized_source_chunks" ADD CONSTRAINT "privacy_sanitized_source_chunks_classification_result_id_privacy_classification_results_id_fk" FOREIGN KEY ("classification_result_id") REFERENCES "public"."privacy_classification_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_source_preview_id_shared_source_previews_id_fk" FOREIGN KEY ("source_preview_id") REFERENCES "public"."shared_source_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_source_artifact_id_shared_source_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."shared_source_artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_logical_memory_id_logical_memories_id_fk" FOREIGN KEY ("logical_memory_id") REFERENCES "public"."logical_memories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_classification_result_id_privacy_classification_results_id_fk" FOREIGN KEY ("classification_result_id") REFERENCES "public"."privacy_classification_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_classifier_fk" FOREIGN KEY ("classifier_generation_id","classifier_hash") REFERENCES "public"."privacy_classifier_generations"("id","classifier_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lcm_summary_work_claim_active_idx" ON "lcm_summary_work_claims" USING btree ("owner_user_id","state","expires_at") WHERE "lcm_summary_work_claims"."state" = 'active';--> statement-breakpoint
CREATE INDEX "lcm_summary_work_claim_node_idx" ON "lcm_summary_work_claims" USING btree ("memory_node_id","claim_generation");--> statement-breakpoint
CREATE INDEX "pds_lcm_work_intent_pending_idx" ON "pds_lcm_work_intents" USING btree ("group_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_classification_results_cache_unique" ON "privacy_classification_results" USING btree ("owner_user_id","classifier_generation_id","owner_content_fingerprint") WHERE "privacy_classification_results"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "privacy_classification_results_owner_status_idx" ON "privacy_classification_results" USING btree ("owner_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_classifier_generations_one_active_unique" ON "privacy_classifier_generations" USING btree ("status") WHERE "privacy_classifier_generations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_content_policies_subject_version_unique" ON "privacy_content_policies" USING btree ("deployment_identity_id","scope",coalesce("source_owner_user_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("team_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("team_workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),"version");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_content_policies_subject_active_unique" ON "privacy_content_policies" USING btree ("deployment_identity_id","scope",coalesce("source_owner_user_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("team_id", '00000000-0000-0000-0000-000000000000'::uuid),coalesce("team_workspace_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "privacy_content_policies"."status" = 'active';--> statement-breakpoint
CREATE INDEX "privacy_content_policies_resolution_idx" ON "privacy_content_policies" USING btree ("deployment_identity_id","source_owner_user_id","team_id","team_workspace_id","effective_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_sanitized_source_artifacts_active_unique" ON "privacy_sanitized_source_artifacts" USING btree ("share_grant_id","source_artifact_id","team_id","team_workspace_id","classifier_generation_id","effective_policy_hash","source_frontier_hash") WHERE "privacy_sanitized_source_artifacts"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "privacy_sanitized_source_artifacts_team_status_idx" ON "privacy_sanitized_source_artifacts" USING btree ("team_id","team_workspace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "privacy_sanitized_source_artifacts_grant_status_idx" ON "privacy_sanitized_source_artifacts" USING btree ("share_grant_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "shared_source_semantic_previews_derivation_unique" ON "shared_source_semantic_previews" USING btree ("source_preview_id","classifier_generation_id","effective_privacy_policy_hash");--> statement-breakpoint
CREATE INDEX "shared_source_semantic_previews_pending_idx" ON "shared_source_semantic_previews" USING btree ("status","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "shared_source_semantic_previews_source_idx" ON "shared_source_semantic_previews" USING btree ("source_preview_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shared_source_semantic_previews_scope_idx" ON "shared_source_semantic_previews" USING btree ("team_id","team_workspace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_sanitized_source_preview_id_shared_source_semantic_previews_id_fk" FOREIGN KEY ("sanitized_source_preview_id") REFERENCES "public"."shared_source_semantic_previews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_privacy_classifier_fk" FOREIGN KEY ("privacy_classifier_generation_id","privacy_classifier_hash") REFERENCES "public"."privacy_classifier_generations"("id","classifier_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_sanitized_preview_scope_fk" FOREIGN KEY ("sanitized_source_preview_id","source_preview_id","source_artifact_id","logical_memory_id","team_id","team_workspace_id","representation","source_revision") REFERENCES "public"."shared_source_semantic_previews"("id","source_preview_id","source_artifact_id","logical_memory_id","team_id","team_workspace_id","representation","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_memory_semantic_items_pending_idx" ON "team_memory_semantic_items" USING btree ("embedding_state","next_attempt_at","id");--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" DROP COLUMN "active_representation";--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" DROP COLUMN "redacted_content_hash";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP COLUMN "allowed_representations";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP COLUMN "replacement_allowed_representations";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP COLUMN "allowed_representations";--> statement-breakpoint
ALTER TABLE "shared_source_artifacts" DROP COLUMN "redacted_content_hash";--> statement-breakpoint
ALTER TABLE "shared_source_previews" DROP COLUMN "redacted_content_hash";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP COLUMN "allowed_representations";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP COLUMN "selected_representation";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP COLUMN "representation_policy_revision";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP COLUMN "representation_policy_hash";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP COLUMN "redacted_content_hash";--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" DROP COLUMN "allowed_representations";--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP COLUMN "representation_policy_revision";--> statement-breakpoint
ALTER TABLE "team_representation_policies" DROP COLUMN "allowed_representations";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP COLUMN "owner_allowed_representations";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP COLUMN "active_representation";--> statement-breakpoint
ALTER TABLE "team_session_share_grants" DROP COLUMN "representation_policy_revision";--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" DROP COLUMN "allowed_representations";--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD CONSTRAINT "csm_previews_consent_binding_unique" UNIQUE("enrollment_id","preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","maximum_fidelity","include_curated_memory","source_revision");--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" ADD CONSTRAINT "csm_consents_preview_binding_fk" FOREIGN KEY ("enrollment_id","preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","maximum_fidelity","include_curated_memory","source_revision") REFERENCES "public"."collaboration_shared_memory_previews"("enrollment_id","preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","maximum_fidelity","include_curated_memory","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_revision_unique" UNIQUE("share_grant_id","representation","source_revision","fidelity_policy_revision","content_policy_version","classifier_version","sanitized_source_preview_id");--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_consents" ADD CONSTRAINT "csm_consents_fidelity_check" CHECK ("collaboration_shared_memory_consents"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_grants" ADD CONSTRAINT "csm_grants_fidelity_check" CHECK ("collaboration_shared_memory_grants"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD CONSTRAINT "csm_previews_fidelity_check" CHECK ("collaboration_shared_memory_previews"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD CONSTRAINT "csm_previews_hashes_check" CHECK (length("collaboration_shared_memory_previews"."preview_hash") = 64
        and length("collaboration_shared_memory_previews"."source_hash") = 64
        and length("collaboration_shared_memory_previews"."source_content_hash") = 64
        and length("collaboration_shared_memory_previews"."protected_dto_hash") = 64);--> statement-breakpoint
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
        'shared_source_semantic_previews',
        'shared_source_previews',
        'team_memory_representations',
        'tool_events'
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
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_state_check" CHECK ("pending_share_operations"."state" in ('preparing','needs_attention','failed','activated','revoked')
        and "pending_share_operations"."stage" in ('accepted','syncing','uploading','processing','activating','privacy_filtering','complete')
        and "pending_share_operations"."workspace_access_state" in ('none','active','revoked')
        and "pending_share_operations"."source_update_state" in ('preparing','active','paused','failed','stopped'));--> statement-breakpoint
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
             "pending_share_operations"."replacement_authority_source" in ('browser_session','device_action_grant') and
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
ALTER TABLE "shared_source_artifacts" ADD CONSTRAINT "shared_source_artifacts_hash_check" CHECK (length("shared_source_artifacts"."source_hash") = 64
        and length("shared_source_artifacts"."manifest_hash") = 64
        and length("shared_source_artifacts"."artifact_hash") = 64
        and length("shared_source_artifacts"."source_content_hash") = 64
        and length("shared_source_artifacts"."representation_policy_hash") = 64
        and length("shared_source_artifacts"."content_policy_hash") = 64
        and length("shared_source_artifacts"."classifier_hash") = 64
        and length("shared_source_artifacts"."device_provenance_hash") = 64);--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD CONSTRAINT "shared_source_previews_hash_check" CHECK (length("shared_source_previews"."preview_hash") = 64
        and length("shared_source_previews"."source_hash") = 64
        and length("shared_source_previews"."source_content_hash") = 64);--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_fidelity_check" CHECK ("source_owner_representation_consents"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_revision_check" CHECK ("source_owner_representation_consents"."preview_revision" > 0
        and "source_owner_representation_consents"."source_revision" >= 0
        and "source_owner_representation_consents"."fidelity_policy_revision" > 0
        and "source_owner_representation_consents"."content_policy_version" > 0
        and "source_owner_representation_consents"."classifier_version" > 0
        and "source_owner_representation_consents"."source_owner_policy_version" > 0
        and "source_owner_representation_consents"."team_policy_version" > 0
        and "source_owner_representation_consents"."workspace_policy_version" > 0);--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_hash_check" CHECK (length("source_owner_representation_consents"."preview_hash") = 64
        and length("source_owner_representation_consents"."source_hash") = 64
        and length("source_owner_representation_consents"."fidelity_policy_hash") = 64
        and length("source_owner_representation_consents"."content_policy_hash") = 64
        and length("source_owner_representation_consents"."classifier_hash") = 64
        and length("source_owner_representation_consents"."source_content_hash") = 64);--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" ADD CONSTRAINT "source_owner_representation_policies_fidelity_check" CHECK ("source_owner_representation_policies"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_version_check" CHECK ("team_memory_representations"."record_version" > 0
        and "team_memory_representations"."source_revision" >= 0
        and "team_memory_representations"."source_owner_policy_version" > 0
        and "team_memory_representations"."team_policy_version" > 0
        and "team_memory_representations"."workspace_policy_version" > 0
        and "team_memory_representations"."fidelity_policy_revision" > 0
        and "team_memory_representations"."content_policy_version" > 0
        and "team_memory_representations"."classifier_version" > 0
        and "team_memory_representations"."chunk_count" >= 0);--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_hash_check" CHECK (length("team_memory_representations"."source_revision_hash") = 64
        and length("team_memory_representations"."provenance_hash") = 64
        and "team_memory_representations"."privacy_classifier_hash" ~ '^[0-9a-f]{64}$'
        and "team_memory_representations"."effective_privacy_policy_hash" ~ '^[0-9a-f]{64}$'
        and "team_memory_representations"."source_manifest_hash" ~ '^[0-9a-f]{64}$'
        and "team_memory_representations"."sanitized_content_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "team_memory_semantic_items" ADD CONSTRAINT "team_memory_semantic_items_embedding_check" CHECK ("team_memory_semantic_items"."embedding_state" in ('pending','processing','embedded','failed')
        and "team_memory_semantic_items"."attempt_count" >= 0
        and ("team_memory_semantic_items"."embedding_dimensions" is null or "team_memory_semantic_items"."embedding_dimensions" in (384,1024,1536,3072))
        and (
          ("team_memory_semantic_items"."embedding_state" = 'embedded'
            and "team_memory_semantic_items"."embedding_model" is not null
            and "team_memory_semantic_items"."embedding_dimensions" is not null
            and "team_memory_semantic_items"."embedding_version" is not null
            and "team_memory_semantic_items"."embedding_input_hash" is not null
            and "team_memory_semantic_items"."embedded_at" is not null)
          or ("team_memory_semantic_items"."embedding_state" <> 'embedded' and "team_memory_semantic_items"."embedded_at" is null)
        )
        and (("team_memory_semantic_items"."embedding_state" = 'failed' and "team_memory_semantic_items"."next_attempt_at" is not null
              and length(trim("team_memory_semantic_items"."last_error_class")) > 0)
          or ("team_memory_semantic_items"."embedding_state" <> 'failed' and "team_memory_semantic_items"."next_attempt_at" is null)));--> statement-breakpoint
ALTER TABLE "team_representation_policies" ADD CONSTRAINT "team_representation_policies_fidelity_check" CHECK ("team_representation_policies"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD CONSTRAINT "team_session_share_grants_fidelity_check" CHECK ("team_session_share_grants"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups')
        and "team_session_share_grants"."include_curated_memory" is not null
        and "team_session_share_grants"."fidelity_policy_revision" > 0
        and "team_session_share_grants"."content_policy_version" > 0
        and "team_session_share_grants"."classifier_version" > 0
        and "team_session_share_grants"."source_revision" >= 0);--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD CONSTRAINT "workspace_representation_policies_fidelity_check" CHECK ("workspace_representation_policies"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups'));
