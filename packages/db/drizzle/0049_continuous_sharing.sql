CREATE TABLE "collaboration_sharing_rule_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"rule_id" uuid,
	"source_logical_memory_id" uuid,
	"team_workspace_id" uuid,
	"operation_kind" text DEFAULT 'conversation_create' NOT NULL,
	"share_grant_id" uuid,
	"logical_grant_id" uuid,
	"intent_hash" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"failure_code" text,
	"protected_dto" jsonb,
	"protected_dto_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_rule_delivery_progress_scope_unique" UNIQUE("id","enrollment_id","rule_id"),
	CONSTRAINT "csm_rule_delivery_mutation_unique" UNIQUE("enrollment_id","mutation_id"),
	CONSTRAINT "csm_rule_delivery_destination_check" CHECK (("collaboration_sharing_rule_deliveries"."operation_kind"='control' and "collaboration_sharing_rule_deliveries"."share_grant_id" is not null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind"='conversation_create' and "collaboration_sharing_rule_deliveries"."share_grant_id" is null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is not null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind" in ('repository_create','repository_control','detail','content_policy','publisher_takeover') and "collaboration_sharing_rule_deliveries"."share_grant_id" is null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind" in ('workspace_exclude','workspace_restore') and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null)),
	CONSTRAINT "csm_owner_delivery_target_check" CHECK ((
      "collaboration_sharing_rule_deliveries"."operation_kind" in ('workspace_exclude','workspace_restore') and "collaboration_sharing_rule_deliveries"."rule_id" is null
        and "collaboration_sharing_rule_deliveries"."source_logical_memory_id" is not null and "collaboration_sharing_rule_deliveries"."team_workspace_id" is not null
    ) or (
      "collaboration_sharing_rule_deliveries"."operation_kind" not in ('workspace_exclude','workspace_restore') and "collaboration_sharing_rule_deliveries"."rule_id" is not null
        and "collaboration_sharing_rule_deliveries"."source_logical_memory_id" is null and "collaboration_sharing_rule_deliveries"."team_workspace_id" is null
    )),
	CONSTRAINT "csm_rule_delivery_state_check" CHECK ("collaboration_sharing_rule_deliveries"."state" in ('queued','acknowledged','needs_review') and "collaboration_sharing_rule_deliveries"."attempt_count">=0 and "collaboration_sharing_rule_deliveries"."lease_version">=0),
	CONSTRAINT "csm_rule_delivery_failure_check" CHECK ("collaboration_sharing_rule_deliveries"."failure_code" is null or "collaboration_sharing_rule_deliveries"."failure_code" in ('offline','remote_unavailable','source_unavailable','authority_unavailable','conflict','response_invalid')),
	CONSTRAINT "csm_rule_delivery_payload_check" CHECK (length("collaboration_sharing_rule_deliveries"."intent_hash")=64 and (("collaboration_sharing_rule_deliveries"."protected_dto" is not null and "collaboration_sharing_rule_deliveries"."protected_dto_hash" is not null and length("collaboration_sharing_rule_deliveries"."protected_dto_hash")=64) or ("collaboration_sharing_rule_deliveries"."state"='needs_review' and "collaboration_sharing_rule_deliveries"."protected_dto" is null and "collaboration_sharing_rule_deliveries"."protected_dto_hash" is null)))
);
--> statement-breakpoint
CREATE TABLE "collaboration_sharing_selection_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"progress_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"protected_dto" jsonb NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_selection_pages_generation_unique" UNIQUE("progress_id","generation","page_number"),
	CONSTRAINT "csm_selection_pages_payload_check" CHECK ("collaboration_sharing_selection_pages"."page_number">=0 and "collaboration_sharing_selection_pages"."protected_dto_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "collaboration_sharing_selection_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"creation_delivery_id" uuid NOT NULL,
	"delivery_epoch" integer DEFAULT 0 NOT NULL,
	"current_generation" uuid,
	"proposal_generation" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"source_work_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"protected_dto" jsonb,
	"protected_dto_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_selection_progress_rule_unique" UNIQUE("enrollment_id","rule_id"),
	CONSTRAINT "csm_selection_progress_state_check" CHECK ("collaboration_sharing_selection_progress"."state" in ('active','stopped','revoked','needs_attention') and "collaboration_sharing_selection_progress"."lease_version">=0 and "collaboration_sharing_selection_progress"."attempt_count">=0 and "collaboration_sharing_selection_progress"."delivery_epoch">=0),
	CONSTRAINT "csm_selection_progress_payload_check" CHECK (("collaboration_sharing_selection_progress"."protected_dto" is not null and "collaboration_sharing_selection_progress"."protected_dto_hash" is not null and "collaboration_sharing_selection_progress"."protected_dto_hash" ~ '^[a-f0-9]{64}$') or ("collaboration_sharing_selection_progress"."state"='revoked' and "collaboration_sharing_selection_progress"."protected_dto" is null and "collaboration_sharing_selection_progress"."protected_dto_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "collaboration_sharing_selection_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"progress_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"current_generation" uuid,
	"current_goal_hash" text,
	"proposed_generation" uuid,
	"proposed_goal_hash" text,
	"done_goal_hash" text,
	"done_delivery_epoch" integer,
	"attempt_mutation_id" uuid,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"protected_dto" jsonb NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_selection_sources_key_unique" UNIQUE("progress_id","source_key"),
	CONSTRAINT "csm_selection_sources_payload_check" CHECK ("collaboration_sharing_selection_sources"."source_key" ~ '^[a-f0-9]{64}$' and "collaboration_sharing_selection_sources"."protected_dto_hash" ~ '^[a-f0-9]{64}$' and "collaboration_sharing_selection_sources"."lease_version">=0 and "collaboration_sharing_selection_sources"."attempt_count">=0
    and (("collaboration_sharing_selection_sources"."current_generation" is null and "collaboration_sharing_selection_sources"."current_goal_hash" is null) or ("collaboration_sharing_selection_sources"."current_generation" is not null and "collaboration_sharing_selection_sources"."current_goal_hash" is not null and "collaboration_sharing_selection_sources"."current_goal_hash" ~ '^[a-f0-9]{64}$'))
    and (("collaboration_sharing_selection_sources"."proposed_generation" is null and "collaboration_sharing_selection_sources"."proposed_goal_hash" is null) or ("collaboration_sharing_selection_sources"."proposed_generation" is not null and "collaboration_sharing_selection_sources"."proposed_goal_hash" is not null and "collaboration_sharing_selection_sources"."proposed_goal_hash" ~ '^[a-f0-9]{64}$'))
    and ("collaboration_sharing_selection_sources"."done_goal_hash" is null or "collaboration_sharing_selection_sources"."done_goal_hash" ~ '^[a-f0-9]{64}$') and ("collaboration_sharing_selection_sources"."done_delivery_epoch" is null or "collaboration_sharing_selection_sources"."done_delivery_epoch">=0))
);
--> statement-breakpoint
CREATE TABLE "pending_sharing_rule_admissions" (
	"pending_share_id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"admission_kind" text DEFAULT 'conversation_create' NOT NULL,
	"portable_source_hash" text,
	"snapshot_conversion" jsonb,
	"membership_id" uuid,
	"expected_authority_version" integer,
	"expected_membership_version" integer,
	"publisher_fence" bigint,
	"membership_request_hash" text,
	"existing_source_readmission" jsonb,
	"publisher_credential_id" uuid NOT NULL,
	"expected_grant_version" integer,
	"effective_privacy_policy_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_existing_source_readmission_check" CHECK ("pending_sharing_rule_admissions"."existing_source_readmission" is null or ("pending_sharing_rule_admissions"."admission_kind"='repository_member' and jsonb_typeof("pending_sharing_rule_admissions"."existing_source_readmission")='object')),
	CONSTRAINT "pending_rule_portable_source_check" CHECK ("pending_sharing_rule_admissions"."portable_source_hash" is null or ("pending_sharing_rule_admissions"."admission_kind"='conversation_create' and "pending_sharing_rule_admissions"."portable_source_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "pending_snapshot_conversion_check" CHECK ("pending_sharing_rule_admissions"."snapshot_conversion" is null or ("pending_sharing_rule_admissions"."admission_kind"='conversation_create' and jsonb_typeof("pending_sharing_rule_admissions"."snapshot_conversion")='object')),
	CONSTRAINT "pending_sharing_rule_admission_check" CHECK (
      ("pending_sharing_rule_admissions"."admission_kind"='conversation_create' and "pending_sharing_rule_admissions"."membership_id" is null and "pending_sharing_rule_admissions"."expected_authority_version" is null and "pending_sharing_rule_admissions"."expected_membership_version" is null and "pending_sharing_rule_admissions"."publisher_fence" is null and "pending_sharing_rule_admissions"."membership_request_hash" is null)
      or ("pending_sharing_rule_admissions"."admission_kind"='repository_member' and "pending_sharing_rule_admissions"."membership_id" is not null and "pending_sharing_rule_admissions"."expected_authority_version" is not null and "pending_sharing_rule_admissions"."expected_authority_version">0 and "pending_sharing_rule_admissions"."expected_membership_version" is not null and "pending_sharing_rule_admissions"."expected_membership_version">0 and "pending_sharing_rule_admissions"."publisher_fence" is not null and "pending_sharing_rule_admissions"."publisher_fence">0 and "pending_sharing_rule_admissions"."membership_request_hash" is not null and "pending_sharing_rule_admissions"."membership_request_hash" ~ '^[a-f0-9]{64}$')
    ),
	CONSTRAINT "pending_conversation_rule_version_check" CHECK ("pending_sharing_rule_admissions"."expected_grant_version" is null or "pending_sharing_rule_admissions"."expected_grant_version">0),
	CONSTRAINT "pending_conversation_rule_privacy_check" CHECK ("pending_sharing_rule_admissions"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_memory_reason_preparations" (
	"reason_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"retained_representation_id" uuid,
	"source_revision" bigint NOT NULL,
	"rule_version" integer NOT NULL,
	"consent_version" integer NOT NULL,
	"grant_version" integer NOT NULL,
	"publisher_credential_id" uuid NOT NULL,
	"publisher_fence" bigint NOT NULL,
	"effective_privacy_policy_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_reason_preparations_reason_id_preview_id_pk" PRIMARY KEY("reason_id","preview_id"),
	CONSTRAINT "team_memory_reason_preparations_versions_check" CHECK ("team_memory_reason_preparations"."source_revision">=0 and "team_memory_reason_preparations"."rule_version">0 and "team_memory_reason_preparations"."consent_version">0 and "team_memory_reason_preparations"."grant_version">0 and "team_memory_reason_preparations"."publisher_fence">0),
	CONSTRAINT "team_memory_reason_preparations_privacy_hash_check" CHECK ("team_memory_reason_preparations"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_memory_reason_publications" (
	"reason_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"representation_id" uuid NOT NULL,
	"rule_version" integer,
	"publisher_fence" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_reason_publications_reason_id_representation_id_pk" PRIMARY KEY("reason_id","representation_id"),
	CONSTRAINT "team_memory_reason_publications_fence_check" CHECK (("team_memory_reason_publications"."rule_version" is null and "team_memory_reason_publications"."publisher_fence" is null) or ("team_memory_reason_publications"."rule_version" is not null and "team_memory_reason_publications"."publisher_fence" is not null and "team_memory_reason_publications"."rule_version">0 and "team_memory_reason_publications"."publisher_fence">0))
);
--> statement-breakpoint
CREATE TABLE "team_memory_share_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"kind" text DEFAULT 'direct' NOT NULL,
	"rule_id" uuid,
	"membership_id" uuid,
	"repository_snapshot" jsonb NOT NULL,
	"repository_snapshot_source_revision" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_share_reasons_scope_unique" UNIQUE("id","share_grant_id"),
	CONSTRAINT "team_memory_share_reasons_kind_check" CHECK (("team_memory_share_reasons"."kind"='direct' and "team_memory_share_reasons"."rule_id" is null and "team_memory_share_reasons"."membership_id" is null)
        or ("team_memory_share_reasons"."kind"='rule' and "team_memory_share_reasons"."rule_id" is not null and "team_memory_share_reasons"."membership_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "team_memory_sharing_rule_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"portable_source_hash" text,
	"state" text DEFAULT 'present' NOT NULL,
	"membership_version" integer DEFAULT 1 NOT NULL,
	"selection_snapshot_version" uuid,
	"source_context_hash" text,
	"git_context_version" integer,
	"folder_context_version" integer,
	"last_mutation_id" uuid NOT NULL,
	"reconciliation_requested_at" timestamp with time zone DEFAULT now(),
	"next_reconciliation_at" timestamp with time zone DEFAULT now(),
	"reconciliation_attempt_count" integer DEFAULT 0 NOT NULL,
	"reconciliation_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_rule_members_source_unique" UNIQUE("rule_id","logical_memory_id"),
	CONSTRAINT "team_memory_rule_members_rule_unique" UNIQUE("id","rule_id"),
	CONSTRAINT "team_memory_rule_members_portable_source_check" CHECK ("team_memory_sharing_rule_members"."portable_source_hash" is null or "team_memory_sharing_rule_members"."portable_source_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "team_memory_rule_members_state_check" CHECK ("team_memory_sharing_rule_members"."state" in ('present','removed','revoked','unresolved')),
	CONSTRAINT "team_memory_rule_members_version_check" CHECK ("team_memory_sharing_rule_members"."membership_version">0
      and ("team_memory_sharing_rule_members"."git_context_version" is null or "team_memory_sharing_rule_members"."git_context_version">0)
      and ("team_memory_sharing_rule_members"."folder_context_version" is null or "team_memory_sharing_rule_members"."folder_context_version">0)
      and ("team_memory_sharing_rule_members"."source_context_hash" is null or "team_memory_sharing_rule_members"."source_context_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "team_memory_rule_members_reconciliation_check" CHECK ("team_memory_sharing_rule_members"."reconciliation_attempt_count">=0
      and ("team_memory_sharing_rule_members"."reconciliation_failure_code" is null or "team_memory_sharing_rule_members"."reconciliation_failure_code" in ('source_not_ready','authority_unavailable','preparation_failed'))
      and ("team_memory_sharing_rule_members"."state"='present' or ("team_memory_sharing_rule_members"."reconciliation_requested_at" is null and "team_memory_sharing_rule_members"."next_reconciliation_at" is null
        and "team_memory_sharing_rule_members"."reconciliation_attempt_count"=0 and "team_memory_sharing_rule_members"."reconciliation_failure_code" is null)))
);
--> statement-breakpoint
CREATE TABLE "team_memory_sharing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid,
	"selector_kind" text DEFAULT 'captured_session' NOT NULL,
	"selector_binding_hash" text,
	"selector_payload" jsonb,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"maximum_fidelity" "shared_memory_representation" NOT NULL,
	"include_curated_memory" boolean DEFAULT false NOT NULL,
	"content_privacy_labels" jsonb DEFAULT '{"account_number":false,"private_address":false,"private_email":false,"private_person":false,"private_phone":false,"private_url":false,"private_date":false,"secret":false}'::jsonb NOT NULL,
	"content_policy_version" integer DEFAULT 0 NOT NULL,
	"approved_global_privacy_policy_hash" text,
	"approved_effective_privacy_labels" jsonb,
	"effective_privacy_policy_hash" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"authority_version" integer DEFAULT 1 NOT NULL,
	"publisher_credential_id" uuid NOT NULL,
	"publisher_fence" bigint DEFAULT 1 NOT NULL,
	"creation_mutation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stopped_at" timestamp with time zone,
	CONSTRAINT "team_memory_sharing_rules_creation_mutation_id_unique" UNIQUE("creation_mutation_id"),
	CONSTRAINT "team_memory_sharing_rules_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "team_memory_sharing_rules_selector_check" CHECK (
      ("team_memory_sharing_rules"."selector_kind"='captured_session' and "team_memory_sharing_rules"."logical_memory_id" is not null
        and "team_memory_sharing_rules"."selector_binding_hash" is null and "team_memory_sharing_rules"."selector_payload" is null)
      or ("team_memory_sharing_rules"."selector_kind" in ('repository','folder','project') and "team_memory_sharing_rules"."logical_memory_id" is null
        and "team_memory_sharing_rules"."selector_binding_hash" is not null and "team_memory_sharing_rules"."selector_binding_hash" ~ '^[a-f0-9]{64}$' and "team_memory_sharing_rules"."selector_payload" is not null)
    ),
	CONSTRAINT "team_memory_sharing_rules_authority_check" CHECK ("team_memory_sharing_rules"."authority_version">0 and "team_memory_sharing_rules"."publisher_fence">0),
	CONSTRAINT "team_memory_sharing_rules_fidelity_check" CHECK ("team_memory_sharing_rules"."maximum_fidelity" in ('memory_events','lcm_leaves','lcm_rollups')),
	CONSTRAINT "team_memory_sharing_rules_privacy_hash_check" CHECK ("team_memory_sharing_rules"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "team_memory_sharing_rules_content_labels_check" CHECK (jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels")='object' and "team_memory_sharing_rules"."content_privacy_labels" ?& ARRAY['account_number','private_address','private_email','private_person','private_phone','private_url','private_date','secret']::text[]
    and ("team_memory_sharing_rules"."content_privacy_labels"-ARRAY['account_number','private_address','private_email','private_person','private_phone','private_url','private_date','secret']::text[])='{}'::jsonb and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'account_number')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'private_address')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'private_email')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'private_person')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'private_phone')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'private_url')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'private_date')='boolean' and jsonb_typeof("team_memory_sharing_rules"."content_privacy_labels"->'secret')='boolean'),
	CONSTRAINT "team_memory_sharing_rules_approved_labels_check" CHECK ("team_memory_sharing_rules"."approved_effective_privacy_labels" is null or (jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels")='object' and "team_memory_sharing_rules"."approved_effective_privacy_labels" ?& ARRAY['account_number','private_address','private_email','private_person','private_phone','private_url','private_date','secret']::text[]
    and ("team_memory_sharing_rules"."approved_effective_privacy_labels"-ARRAY['account_number','private_address','private_email','private_person','private_phone','private_url','private_date','secret']::text[])='{}'::jsonb and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'account_number')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'private_address')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'private_email')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'private_person')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'private_phone')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'private_url')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'private_date')='boolean' and jsonb_typeof("team_memory_sharing_rules"."approved_effective_privacy_labels"->'secret')='boolean')),
	CONSTRAINT "team_memory_sharing_rules_content_policy_check" CHECK (("team_memory_sharing_rules"."content_policy_version"=0 and "team_memory_sharing_rules"."content_privacy_labels"='{"account_number":false,"private_address":false,"private_email":false,"private_person":false,"private_phone":false,"private_url":false,"private_date":false,"secret":false}'::jsonb
        and "team_memory_sharing_rules"."approved_global_privacy_policy_hash" is null and "team_memory_sharing_rules"."approved_effective_privacy_labels" is null)
      or ("team_memory_sharing_rules"."content_policy_version">0 and "team_memory_sharing_rules"."approved_global_privacy_policy_hash" is not null
        and "team_memory_sharing_rules"."approved_global_privacy_policy_hash" ~ '^[a-f0-9]{64}$' and "team_memory_sharing_rules"."approved_effective_privacy_labels" is not null)),
	CONSTRAINT "team_memory_sharing_rules_lifecycle_check" CHECK (("team_memory_sharing_rules"."state" in ('active','paused') and "team_memory_sharing_rules"."stopped_at" is null) or ("team_memory_sharing_rules"."state"='stopped' and "team_memory_sharing_rules"."stopped_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "team_memory_workspace_exclusion_mutations" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"exclusion_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_version" integer NOT NULL,
	"result_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_workspace_exclusion_mutation_version_unique" UNIQUE("exclusion_id","result_version"),
	CONSTRAINT "team_memory_workspace_exclusion_mutation_operation_check" CHECK ("team_memory_workspace_exclusion_mutations"."operation" in ('exclude','restore')),
	CONSTRAINT "team_memory_workspace_exclusion_mutation_binding_check" CHECK ("team_memory_workspace_exclusion_mutations"."result_version">0 and "team_memory_workspace_exclusion_mutations"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_memory_workspace_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'excluded' NOT NULL,
	"excluded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_workspace_exclusion_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "team_memory_workspace_exclusion_scope_unique" UNIQUE("owner_user_id","logical_memory_id","team_workspace_id"),
	CONSTRAINT "team_memory_workspace_exclusion_state_check" CHECK ("team_memory_workspace_exclusions"."state" in ('excluded','restored') and ("team_memory_workspace_exclusions"."state"='excluded')=("team_memory_workspace_exclusions"."restored_at" is null)),
	CONSTRAINT "team_memory_workspace_exclusion_version_check" CHECK ("team_memory_workspace_exclusions"."version">0)
);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_logical_grant_unique";
--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_revision_unique";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_values_check";
--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_values_check";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "reviewed_grant_version" integer;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "display_title" text;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_consent_unique" UNIQUE("id","share_grant_id","consent_id");
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_revision_unique" UNIQUE("share_grant_id","consent_id","representation","source_revision","fidelity_policy_revision","content_policy_version","classifier_version","sanitized_source_preview_id");
--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_reviewed_grant_version_check" CHECK ("pending_share_operations"."reviewed_grant_version" is null or "pending_share_operations"."reviewed_grant_version">0);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_values_check" CHECK ("pending_share_operations"."preview_revision" > 0 and "pending_share_operations"."source_revision" >= 0
        and "pending_share_operations"."operation_version" > 0 and "pending_share_operations"."attempt_count" >= 0
        and "pending_share_operations"."authority_source" in ('browser_session','device_action_grant','sharing_rule')
        and (("pending_share_operations"."last_control_mutation_id" is null and "pending_share_operations"."last_control_action" is null)
          or ("pending_share_operations"."last_control_mutation_id" is not null and
              "pending_share_operations"."last_control_action" in ('retry','pause','resume','revoke','stop_direct')))
        and length("pending_share_operations"."request_hash") = 64 and length("pending_share_operations"."preview_hash") = 64
        and length("pending_share_operations"."source_hash") = 64);
--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_values_check" CHECK ("shared_memory_candidate_previews"."preview_revision" = 1
        and "shared_memory_candidate_previews"."authority_source" in ('browser_session','device_action_grant','continuous_consent','sharing_rule')
        and "shared_memory_candidate_previews"."source_revision" >= 0
        and "shared_memory_candidate_previews"."item_count" between 1 and 100
        and "shared_memory_candidate_previews"."excluded_item_count" >= 0
        and jsonb_typeof("shared_memory_candidate_previews"."candidate_manifest") = 'array'
        and jsonb_array_length("shared_memory_candidate_previews"."candidate_manifest") = "shared_memory_candidate_previews"."item_count"
        and "shared_memory_candidate_previews"."byte_count" between 1 and 262144
        and "shared_memory_candidate_previews"."representation_policy_revision" > 0
        and "shared_memory_candidate_previews"."content_policy_version" > 0
        and "shared_memory_candidate_previews"."classifier_version" > 0
        and "shared_memory_candidate_previews"."expires_at" > "shared_memory_candidate_previews"."created_at");
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_title_marker_check" CHECK ("team_memory_representations"."display_title" is null or "team_memory_representations"."display_title"='[koed encrypted Shared Memory title]');
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD CONSTRAINT "collaboration_sharing_rule_deliveries_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_pages" ADD CONSTRAINT "collaboration_sharing_selection_pages_progress_id_collaboration_sharing_selection_progress_id_fk" FOREIGN KEY ("progress_id") REFERENCES "public"."collaboration_sharing_selection_progress"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_progress" ADD CONSTRAINT "collaboration_sharing_selection_progress_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_progress" ADD CONSTRAINT "csm_selection_progress_creation_fk" FOREIGN KEY ("creation_delivery_id","enrollment_id","rule_id") REFERENCES "public"."collaboration_sharing_rule_deliveries"("id","enrollment_id","rule_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_sources" ADD CONSTRAINT "collaboration_sharing_selection_sources_progress_id_collaboration_sharing_selection_progress_id_fk" FOREIGN KEY ("progress_id") REFERENCES "public"."collaboration_sharing_selection_progress"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_admissions_pending_share_id_pending_share_operations_id_fk" FOREIGN KEY ("pending_share_id") REFERENCES "public"."pending_share_operations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_admissions_publisher_credential_id_device_credentials_id_fk" FOREIGN KEY ("publisher_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_member_fk" FOREIGN KEY ("membership_id","rule_id") REFERENCES "public"."team_memory_sharing_rule_members"("id","rule_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_consent_id_source_owner_representation_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."source_owner_representation_consents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_preview_id_shared_source_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."shared_source_previews"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_publisher_credential_id_device_credentials_id_fk" FOREIGN KEY ("publisher_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_reason_fk" FOREIGN KEY ("reason_id","share_grant_id") REFERENCES "public"."team_memory_share_reasons"("id","share_grant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_preparations" ADD CONSTRAINT "team_memory_reason_preparations_retained_fk" FOREIGN KEY ("retained_representation_id","share_grant_id","consent_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","consent_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_publications" ADD CONSTRAINT "team_memory_reason_publications_reason_fk" FOREIGN KEY ("reason_id","share_grant_id") REFERENCES "public"."team_memory_share_reasons"("id","share_grant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_reason_publications" ADD CONSTRAINT "team_memory_reason_publications_representation_fk" FOREIGN KEY ("representation_id","share_grant_id","consent_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","consent_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_consent_id_source_owner_representation_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."source_owner_representation_consents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_rule_id_team_memory_sharing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."team_memory_sharing_rules"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_membership_fk" FOREIGN KEY ("membership_id","rule_id") REFERENCES "public"."team_memory_sharing_rule_members"("id","rule_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rule_members" ADD CONSTRAINT "team_memory_rule_members_rule_owner_fk" FOREIGN KEY ("rule_id","owner_user_id") REFERENCES "public"."team_memory_sharing_rules"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rule_members" ADD CONSTRAINT "team_memory_rule_members_source_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_source_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_publisher_owner_fk" FOREIGN KEY ("publisher_credential_id","owner_user_id") REFERENCES "public"."device_credentials"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_workspace_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_workspace_exclusion_mutations" ADD CONSTRAINT "team_memory_workspace_exclusion_mutation_owner_fk" FOREIGN KEY ("exclusion_id","owner_user_id") REFERENCES "public"."team_memory_workspace_exclusions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_workspace_exclusions" ADD CONSTRAINT "team_memory_workspace_exclusion_owned_source_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_workspace_exclusions" ADD CONSTRAINT "team_memory_workspace_exclusion_destination_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "csm_rule_delivery_pending_rule_unique" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","rule_id") WHERE "collaboration_sharing_rule_deliveries"."state"='queued' and "collaboration_sharing_rule_deliveries"."share_grant_id" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "csm_rule_delivery_pending_creation_unique" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","rule_id") WHERE "collaboration_sharing_rule_deliveries"."state"='queued' and "collaboration_sharing_rule_deliveries"."share_grant_id" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "csm_owner_delivery_pending_exclusion_unique" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","source_logical_memory_id","team_workspace_id") WHERE "collaboration_sharing_rule_deliveries"."state"='queued' and "collaboration_sharing_rule_deliveries"."operation_kind" in ('workspace_exclude','workspace_restore');
--> statement-breakpoint
CREATE INDEX "csm_rule_delivery_claim_idx" ON "collaboration_sharing_rule_deliveries" USING btree ("state","available_at","id");
--> statement-breakpoint
CREATE INDEX "csm_rule_delivery_owner_grant_idx" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","share_grant_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "csm_selection_progress_work_idx" ON "collaboration_sharing_selection_progress" USING btree ("state","available_at","id");
--> statement-breakpoint
CREATE INDEX "csm_selection_sources_work_idx" ON "collaboration_sharing_selection_sources" USING btree ("available_at","id");
--> statement-breakpoint
CREATE INDEX "csm_selection_sources_generation_idx" ON "collaboration_sharing_selection_sources" USING btree ("progress_id","proposed_generation","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_sharing_rule_creation_unique" ON "pending_sharing_rule_admissions" USING btree ("rule_id") WHERE "pending_sharing_rule_admissions"."admission_kind"='conversation_create';
--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_reasons_direct_unique" ON "team_memory_share_reasons" USING btree ("share_grant_id") WHERE "team_memory_share_reasons"."kind" = 'direct';
--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_reasons_rule_unique" ON "team_memory_share_reasons" USING btree ("share_grant_id","rule_id") WHERE "team_memory_share_reasons"."kind"='rule';
--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_rule_members_portable_source_unique" ON "team_memory_sharing_rule_members" USING btree ("rule_id","portable_source_hash") WHERE "team_memory_sharing_rule_members"."portable_source_hash" is not null;
--> statement-breakpoint
CREATE INDEX "team_memory_rule_members_reconciliation_idx" ON "team_memory_sharing_rule_members" USING btree ("next_reconciliation_at","id") WHERE "team_memory_sharing_rule_members"."state"='present' and "team_memory_sharing_rule_members"."next_reconciliation_at" is not null;
--> statement-breakpoint
CREATE INDEX "team_memory_rule_members_active_idx" ON "team_memory_sharing_rule_members" USING btree ("rule_id","id") WHERE "team_memory_sharing_rule_members"."state"='present';
--> statement-breakpoint
CREATE INDEX "team_memory_sharing_rules_owner_idx" ON "team_memory_sharing_rules" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "pending_share_operations_logical_grant_idx" ON "pending_share_operations" USING btree ("logical_grant_id");
--> statement-breakpoint
CREATE FUNCTION bind_direct_share_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- The primary grant may have first been created for a rule. Updating its
  -- source metadata must never invent a second, direct sharing authority.
  IF NEW.consent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM team_memory_share_reasons reason
     WHERE reason.share_grant_id=NEW.id AND reason.consent_id=NEW.consent_id
       AND reason.kind='rule'
  ) THEN
    INSERT INTO team_memory_share_reasons
      (share_grant_id,consent_id,repository_snapshot,repository_snapshot_source_revision)
    VALUES (NEW.id,NEW.consent_id,NEW.repository_snapshot,NEW.repository_snapshot_source_revision)
    ON CONFLICT (share_grant_id) WHERE kind='direct' DO UPDATE
      SET consent_id=EXCLUDED.consent_id,
          repository_snapshot=EXCLUDED.repository_snapshot,
          repository_snapshot_source_revision=EXCLUDED.repository_snapshot_source_revision,
          updated_at=now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER bind_direct_share_reason
  AFTER INSERT OR UPDATE OF consent_id,repository_snapshot,repository_snapshot_source_revision
  ON team_memory_share_grants FOR EACH ROW EXECUTE FUNCTION bind_direct_share_reason();
--> statement-breakpoint
CREATE FUNCTION bind_direct_reason_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO team_memory_reason_publications
    (reason_id,share_grant_id,consent_id,representation_id)
  SELECT reason.id,NEW.share_grant_id,NEW.consent_id,NEW.id
    FROM team_memory_share_reasons reason
   WHERE reason.share_grant_id=NEW.share_grant_id
     AND reason.consent_id=NEW.consent_id AND reason.kind='direct'
  ON CONFLICT (reason_id,representation_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bind_direct_reason_publication
  AFTER INSERT ON team_memory_representations
  FOR EACH ROW EXECUTE FUNCTION bind_direct_reason_publication();
--> statement-breakpoint
-- Preserve existing direct grants and exact consent-bound publications.
INSERT INTO team_memory_share_reasons
  (share_grant_id,consent_id,repository_snapshot,repository_snapshot_source_revision,created_at,updated_at)
SELECT id,consent_id,repository_snapshot,repository_snapshot_source_revision,created_at,updated_at
  FROM team_memory_share_grants WHERE consent_id IS NOT NULL;
--> statement-breakpoint
INSERT INTO team_memory_reason_publications
  (reason_id,share_grant_id,consent_id,representation_id)
SELECT reason.id,representation.share_grant_id,representation.consent_id,representation.id
  FROM team_memory_representations representation
  JOIN team_memory_share_reasons reason
    ON reason.share_grant_id=representation.share_grant_id
   AND reason.consent_id=representation.consent_id AND reason.kind='direct';
--> statement-breakpoint
DO $$
DECLARE grant_columns text;
BEGIN
  SELECT string_agg(format('grant_row.%I',attname),',' ORDER BY attnum)
    INTO grant_columns FROM pg_attribute
   WHERE attrelid='team_memory_share_grants'::regclass AND attnum>0 AND NOT attisdropped
     AND attname NOT IN (
       'consent_id','source_revision_id','remote_replica_id',
       'source_owner_policy_id','source_owner_policy_version',
       'team_policy_id','team_policy_version','workspace_policy_id','workspace_policy_version',
       'source_capabilities','activation_representation','mode','maximum_fidelity','include_curated_memory',
       'fidelity_policy_revision','content_policy_version','classifier_version','source_revision',
       'repository_snapshot','repository_snapshot_source_revision'
     );
  EXECUTE 'CREATE VIEW team_memory_reason_grant_records AS
    SELECT reason_grant.*,binding.source_kind,binding.source_session_id,
           binding.source_note_id,binding.source_memory_event_id
    FROM (SELECT ' || grant_columns || ',
      reason.id as sharing_reason_id,reason.kind as sharing_reason_kind,reason.rule_id as sharing_rule_id,
      consent.id as consent_id,consent.remote_replica_id,
      consent.source_owner_policy_id,consent.source_owner_policy_version,
      consent.team_policy_id,consent.team_policy_version,
      consent.workspace_policy_id,consent.workspace_policy_version,
      consent.source_capabilities,consent.activation_representation,consent.mode,
      consent.maximum_fidelity,consent.include_curated_memory,
      consent.fidelity_policy_revision,consent.content_policy_version,consent.classifier_version,
      reason.repository_snapshot,reason.repository_snapshot_source_revision,
      coalesce((select representation.source_revision_id
        from team_memory_reason_publications publication
        join team_memory_representations representation on representation.id=publication.representation_id
        where publication.reason_id=reason.id and publication.consent_id=reason.consent_id
          and representation.state in (''available'',''stale'') and representation.invalidated_at is null
        order by representation.source_revision desc,representation.id desc limit 1),consent.source_revision_id) as source_revision_id,
      coalesce((select max(representation.source_revision)
        from team_memory_reason_publications publication
        join team_memory_representations representation on representation.id=publication.representation_id
        where publication.reason_id=reason.id and publication.consent_id=reason.consent_id
          and representation.state in (''available'',''stale'') and representation.invalidated_at is null),consent.source_revision) as source_revision
    FROM team_memory_share_grants grant_row
    JOIN team_memory_share_reasons reason on reason.share_grant_id=grant_row.id
    JOIN source_owner_representation_consents consent on consent.id=reason.consent_id
      and consent.logical_memory_id=grant_row.logical_memory_id
      and consent.source_owner_principal_id=grant_row.owner_principal_id
      and consent.team_id=grant_row.team_id and consent.team_workspace_id=grant_row.team_workspace_id
    ) reason_grant
    JOIN logical_memory_source_revision_bindings binding on binding.source_revision_id=reason_grant.source_revision_id';
END $$;
--> statement-breakpoint
DO $$
DECLARE representation_columns text;
BEGIN
  SELECT string_agg(CASE WHEN attname IN ('source_kind','source_session_id','source_note_id','source_memory_event_id')
    THEN format('binding.%I',attname) ELSE format('representation.%I',attname) END,',' ORDER BY attnum)
    INTO representation_columns FROM pg_attribute
   WHERE attrelid='team_memory_representation_records'::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE 'CREATE OR REPLACE VIEW team_memory_representation_records AS SELECT ' || representation_columns ||
    ',representation.display_title FROM team_memory_representations representation
     JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id=representation.source_revision_id';
END $$;
--> statement-breakpoint
DO $$
DECLARE retained_columns text;
BEGIN
  SELECT string_agg(format('g.%I',attname),',' ORDER BY attnum)
    INTO retained_columns FROM pg_attribute
   WHERE attrelid='team_memory_reason_grant_records'::regclass AND attnum>0 AND NOT attisdropped
     AND attname NOT IN (
       'source_revision_id','source_revision',
       'source_owner_policy_id','source_owner_policy_version',
       'team_policy_id','team_policy_version','workspace_policy_id','workspace_policy_version',
       'fidelity_policy_revision','content_policy_version','classifier_version',
       'source_kind','source_session_id','source_note_id','source_memory_event_id'
     );
  EXECUTE 'CREATE VIEW team_memory_publication_grant_records AS
    SELECT ' || retained_columns || ',
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_revision_id ELSE g.source_revision_id END AS source_revision_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_revision ELSE g.source_revision END AS source_revision,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_owner_policy_id ELSE g.source_owner_policy_id END AS source_owner_policy_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_owner_policy_version ELSE g.source_owner_policy_version END AS source_owner_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.team_policy_id ELSE g.team_policy_id END AS team_policy_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.team_policy_version ELSE g.team_policy_version END AS team_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.workspace_policy_id ELSE g.workspace_policy_id END AS workspace_policy_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.workspace_policy_version ELSE g.workspace_policy_version END AS workspace_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.fidelity_policy_revision ELSE g.fidelity_policy_revision END AS fidelity_policy_revision,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.content_policy_version ELSE g.content_policy_version END AS content_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.classifier_version ELSE g.classifier_version END AS classifier_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_kind ELSE g.source_kind END AS source_kind,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_session_id ELSE g.source_session_id END AS source_session_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_note_id ELSE g.source_note_id END AS source_note_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_memory_event_id ELSE g.source_memory_event_id END AS source_memory_event_id,
      r.id AS publication_representation_id
    FROM team_memory_reason_grant_records g
    JOIN team_memory_reason_publications publication
      ON publication.reason_id=g.sharing_reason_id AND publication.share_grant_id=g.id
      AND publication.consent_id=g.consent_id
    JOIN team_memory_representations r
      ON r.id=publication.representation_id AND r.share_grant_id=g.id
      AND r.consent_id=g.consent_id AND r.logical_memory_id=g.logical_memory_id
      AND r.team_id=g.team_id AND r.team_workspace_id=g.team_workspace_id
    JOIN logical_memory_source_revision_bindings source_binding
      ON source_binding.source_revision_id=r.source_revision_id
      AND source_binding.logical_memory_id=g.logical_memory_id
      AND source_binding.owner_principal_id=g.owner_principal_id
      AND source_binding.source_kind=g.source_kind';
END $$;
--> statement-breakpoint
-- Only a title already stored as an encrypted marker survives the main-data cutover.
UPDATE team_memory_representations representation
SET display_title='[koed encrypted Shared Memory title]'
FROM team_memory_share_grants grant_row
WHERE representation.share_grant_id=grant_row.id
  AND representation.consent_id=grant_row.consent_id
  AND representation.source_revision=grant_row.display_title_source_revision
  AND representation.state IN ('available','stale')
  AND representation.invalidated_at IS NULL
  AND grant_row.display_title='[koed encrypted Shared Memory title]';
