CREATE TABLE "project_share_explicit_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"team_principal_user_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"link_epoch" uuid NOT NULL,
	"reason" text NOT NULL,
	"mapping_revision" integer NOT NULL,
	"source_revision" bigint NOT NULL,
	"candidate_hash" text NOT NULL,
	"mutation_id" uuid NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"remote_pending_share_id" uuid,
	"remote_share_grant_id" uuid,
	"remote_grant_version" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_explicit_offers_mutation_id_unique" UNIQUE("mutation_id"),
	CONSTRAINT "project_share_explicit_offer_reason_check" CHECK ("project_share_explicit_offers"."reason" in ('moved_in','share_again')),
	CONSTRAINT "project_share_explicit_offer_state_check" CHECK ("project_share_explicit_offers"."state" in ('prepared','pending','accepted','activated','blocked')),
	CONSTRAINT "project_share_explicit_offer_revision_check" CHECK ("project_share_explicit_offers"."mapping_revision">0 and "project_share_explicit_offers"."source_revision">0
          and length("project_share_explicit_offers"."candidate_hash")=64 and "project_share_explicit_offers"."expires_at">"project_share_explicit_offers"."created_at")
);
--> statement-breakpoint
CREATE TABLE "project_share_local_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"link_epoch" uuid NOT NULL,
	"mapping_revision" integer NOT NULL,
	"source_revision" bigint NOT NULL,
	"remote_pending_share_id" uuid,
	"remote_share_grant_id" uuid,
	"remote_grant_version" integer,
	"remote_grant_lifecycle" text,
	"state" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_local_issues_session_project_unique" UNIQUE("owner_user_id","session_id","project_id","backend_id","workspace_project_id","policy_version","link_epoch"),
	CONSTRAINT "project_share_local_issues_positive_check" CHECK ("project_share_local_issues"."policy_version">0 and "project_share_local_issues"."mapping_revision">0 and "project_share_local_issues"."source_revision">0),
	CONSTRAINT "project_share_local_issues_state_check" CHECK ("project_share_local_issues"."state" in ('reserved','staged','activated','frozen'))
);
--> statement-breakpoint
CREATE TABLE "project_share_move_fences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"link_epoch" uuid NOT NULL,
	"mapping_version" integer NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_move_fences_exact_unique" UNIQUE("owner_user_id","session_id","project_id","backend_id","workspace_project_id","link_epoch","mapping_version"),
	CONSTRAINT "project_share_move_fences_state_check" CHECK ("project_share_move_fences"."state" in ('preparing','acknowledged') and "project_share_move_fences"."mapping_version">0)
);
--> statement-breakpoint
CREATE TABLE "project_share_policy_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"action" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"action_grant_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"sealed_binding" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_policy_attempt_request_unique" UNIQUE("owner_user_id","client_request_id"),
	CONSTRAINT "project_policy_attempt_action_check" CHECK ("project_share_policy_attempts"."action" in ('enable','revoke')),
	CONSTRAINT "project_policy_attempt_payload_hash_check" CHECK ("project_share_policy_attempts"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "project_policy_attempt_state_check" CHECK ("project_share_policy_attempts"."state" in ('pending','executed','terminal'))
);
--> statement-breakpoint
CREATE TABLE "project_share_policy_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"link_epoch" uuid NOT NULL,
	"public_key" text NOT NULL,
	"sealed_private_key" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_policy_signing_key_version_unique" UNIQUE("owner_user_id","project_id","backend_id","workspace_project_id","device_credential_id","policy_version","link_epoch"),
	CONSTRAINT "project_policy_signing_key_version_positive" CHECK ("project_share_policy_signing_keys"."policy_version">0)
);
--> statement-breakpoint
CREATE TABLE "project_share_private_conversations" (
	"owner_user_id" uuid NOT NULL,
	"source_runtime" "source_runtime" NOT NULL,
	"source_kind" text NOT NULL,
	"source_adapter_version" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_share_private_conversations_owner_user_id_source_runtime_source_kind_source_adapter_version_external_conversation_id_pk" PRIMARY KEY("owner_user_id","source_runtime","source_kind","source_adapter_version","external_conversation_id"),
	CONSTRAINT "project_share_private_conversation_identity_check" CHECK (length(trim("project_share_private_conversations"."source_kind"))>0
        and length(trim("project_share_private_conversations"."source_adapter_version"))>0
        and length(trim("project_share_private_conversations"."external_conversation_id"))>0)
);
--> statement-breakpoint
CREATE TABLE "workspace_project_explicit_share_fences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"source_owner_team_member_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_explicit_share_fences_mutation_id_unique" UNIQUE("mutation_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_project_share_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"source_owner_team_member_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"personal_project_binding_hash" text NOT NULL,
	"signing_public_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"initial_manifest_hash" text NOT NULL,
	"initial_manifest" jsonb NOT NULL,
	"approved_session_ids" jsonb NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_share_policy_member_unique" UNIQUE("workspace_project_id","source_owner_team_member_id"),
	CONSTRAINT "workspace_project_share_policy_status_check" CHECK ("workspace_project_share_policies"."status" in ('active','revoked')),
	CONSTRAINT "workspace_project_share_policy_version_check" CHECK ("workspace_project_share_policies"."version" > 0),
	CONSTRAINT "workspace_project_share_policy_manifest_hash_check" CHECK ("workspace_project_share_policies"."initial_manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_project_share_policy_project_binding_hash_check" CHECK ("workspace_project_share_policies"."personal_project_binding_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_project_share_policy_manifest_bound_check" CHECK (jsonb_typeof("workspace_project_share_policies"."initial_manifest") = 'array' and jsonb_array_length("workspace_project_share_policies"."initial_manifest") <= 100),
	CONSTRAINT "workspace_project_share_policy_approved_bound_check" CHECK (jsonb_typeof("workspace_project_share_policies"."approved_session_ids")='array' and jsonb_array_length("workspace_project_share_policies"."approved_session_ids")<=100),
	CONSTRAINT "workspace_project_share_policy_revoked_shape_check" CHECK (("workspace_project_share_policies"."status" = 'active' and "workspace_project_share_policies"."revoked_at" is null) or ("workspace_project_share_policies"."status" = 'revoked' and "workspace_project_share_policies"."revoked_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "workspace_project_share_policy_exclusions" (
	"workspace_project_id" uuid NOT NULL,
	"source_owner_team_member_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_share_policy_exclusions_workspace_project_id_source_owner_team_member_id_session_id_pk" PRIMARY KEY("workspace_project_id","source_owner_team_member_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_project_share_policy_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"session_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"source_revision" bigint NOT NULL,
	"mapping_revision" integer NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"proof_nonce" uuid,
	"pending_share_id" uuid,
	"provenance" text NOT NULL,
	"private_blocked_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_share_policy_issue_session_unique" UNIQUE("policy_id","session_id"),
	CONSTRAINT "workspace_project_share_policy_issue_pending_unique" UNIQUE("pending_share_id"),
	CONSTRAINT "workspace_project_share_policy_issue_nonce_unique" UNIQUE("proof_nonce"),
	CONSTRAINT "workspace_project_share_policy_issue_positive_check" CHECK ("workspace_project_share_policy_issues"."policy_version">0 and "workspace_project_share_policy_issues"."source_revision">0 and "workspace_project_share_policy_issues"."mapping_revision">0),
	CONSTRAINT "workspace_project_share_policy_issue_provenance_check" CHECK ("workspace_project_share_policy_issues"."provenance" in ('initial','future')),
	CONSTRAINT "workspace_project_share_policy_issue_hash_check" CHECK ("workspace_project_share_policy_issues"."source_manifest_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "workspace_project_share_policy_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"expected_policy_version" integer NOT NULL,
	"personal_project_binding_hash" text NOT NULL,
	"signing_public_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"eligible_session_ids" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_share_policy_manifest_version_check" CHECK ("workspace_project_share_policy_manifests"."expected_policy_version" >= 0),
	CONSTRAINT "workspace_project_share_policy_manifest_hash_check" CHECK ("workspace_project_share_policy_manifests"."manifest_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_project_share_policy_manifest_project_hash_check" CHECK ("workspace_project_share_policy_manifests"."personal_project_binding_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_project_share_policy_manifest_bound_check" CHECK (jsonb_typeof("workspace_project_share_policy_manifests"."manifest") = 'array' and jsonb_array_length("workspace_project_share_policy_manifests"."manifest") <= 100),
	CONSTRAINT "workspace_project_share_manifest_eligible_bound_check" CHECK (jsonb_typeof("workspace_project_share_policy_manifests"."eligible_session_ids")='array' and jsonb_array_length("workspace_project_share_policy_manifests"."eligible_session_ids")<=100)
);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_values_check";--> statement-breakpoint
ALTER TABLE "project_policy_session_grants" DROP CONSTRAINT "project_policy_session_grants_versions_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_values_check";--> statement-breakpoint
DROP INDEX "collaboration_threads_companion_unique";--> statement-breakpoint
DROP INDEX "team_memory_share_grants_destination_unique";--> statement-breakpoint
ALTER TABLE "project_policy_session_grants" ALTER COLUMN "policy_generation" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "share_policy_capture_version" integer;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "share_policy_capture_workspace_project_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "share_policy_capture_device_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "share_policy_capture_link_epoch" uuid;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "share_policy_capture_prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "workspace_project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_local_contexts" ADD COLUMN "association_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_policy_session_grants" ADD COLUMN "origin" text DEFAULT 'policy' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "share_policy_link_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "project_share_policy_version" integer;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "project_share_policy_device_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "project_share_policy_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_capture_policy_version" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_capture_device_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_capture_link_epoch" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_capture_context_version" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_capture_prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_capture_workspace_project_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_private_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_private_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_share_move_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_share_explicit_offers" ADD CONSTRAINT "project_share_explicit_offer_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_explicit_offers" ADD CONSTRAINT "project_share_explicit_offer_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_local_issues" ADD CONSTRAINT "project_share_local_issues_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_local_issues" ADD CONSTRAINT "project_share_local_issues_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_move_fences" ADD CONSTRAINT "project_share_move_fences_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_move_fences" ADD CONSTRAINT "project_share_move_fences_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_policy_attempts" ADD CONSTRAINT "project_policy_attempt_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_policy_signing_keys" ADD CONSTRAINT "project_policy_signing_key_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_share_private_conversations" ADD CONSTRAINT "project_share_private_conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_explicit_share_fences" ADD CONSTRAINT "workspace_project_explicit_share_fences_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policies" ADD CONSTRAINT "workspace_project_share_policies_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policies" ADD CONSTRAINT "workspace_project_share_policies_source_owner_team_member_id_team_memberships_id_fk" FOREIGN KEY ("source_owner_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policies" ADD CONSTRAINT "workspace_project_share_policies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policies" ADD CONSTRAINT "workspace_project_share_policies_device_credential_id_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policies" ADD CONSTRAINT "workspace_project_share_policy_member_fk" FOREIGN KEY ("workspace_project_id","source_owner_team_member_id") REFERENCES "public"."workspace_project_members"("workspace_project_id","team_member_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_exclusions" ADD CONSTRAINT "project_policy_exclusion_project_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_exclusions" ADD CONSTRAINT "project_policy_exclusion_member_fk" FOREIGN KEY ("source_owner_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_issues" ADD CONSTRAINT "workspace_project_share_policy_issues_policy_id_workspace_project_share_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."workspace_project_share_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_issues" ADD CONSTRAINT "workspace_project_share_policy_issues_pending_share_id_pending_share_operations_id_fk" FOREIGN KEY ("pending_share_id") REFERENCES "public"."pending_share_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_manifests" ADD CONSTRAINT "workspace_project_share_policy_manifests_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_manifests" ADD CONSTRAINT "workspace_project_share_policy_manifests_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_policy_manifests" ADD CONSTRAINT "workspace_project_share_policy_manifests_device_credential_id_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_project_explicit_fences_session_idx" ON "workspace_project_explicit_share_fences" USING btree ("workspace_project_id","source_owner_team_member_id","session_id");--> statement-breakpoint
CREATE INDEX "workspace_project_share_policy_owner_idx" ON "workspace_project_share_policies" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "workspace_project_share_policy_manifest_owner_idx" ON "workspace_project_share_policy_manifests" USING btree ("owner_user_id","workspace_project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collaboration_threads_companion_unique" ON "collaboration_threads" USING btree ("team_workspace_id","shared_logical_memory_id","share_grant_id") WHERE "collaboration_threads"."kind" = 'shared_session_discussion';--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_grants_destination_unique" ON "team_memory_share_grants" USING btree ("logical_memory_id","team_workspace_id") WHERE "team_memory_share_grants"."logical_memory_id" is not null and "team_memory_share_grants"."frozen_at" is null
          and "team_memory_share_grants"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_values_check" CHECK ("pending_share_operations"."preview_revision" > 0 and "pending_share_operations"."source_revision" >= 0
        and "pending_share_operations"."operation_version" > 0 and "pending_share_operations"."attempt_count" >= 0
        and "pending_share_operations"."authority_source" in ('browser_session','device_action_grant','project_share_policy')
        and (("pending_share_operations"."last_control_mutation_id" is null and "pending_share_operations"."last_control_action" is null)
          or ("pending_share_operations"."last_control_mutation_id" is not null and
              "pending_share_operations"."last_control_action" in ('retry','pause','resume','revoke')))
        and length("pending_share_operations"."request_hash") = 64 and length("pending_share_operations"."preview_hash") = 64
        and length("pending_share_operations"."source_hash") = 64);--> statement-breakpoint
ALTER TABLE "project_local_contexts" ADD CONSTRAINT "project_local_contexts_association_version_check" CHECK ("project_local_contexts"."association_version" > 0);--> statement-breakpoint
ALTER TABLE "project_policy_session_grants" ADD CONSTRAINT "project_policy_session_grants_versions_check" CHECK ((("project_policy_session_grants"."origin"='policy' and "project_policy_session_grants"."policy_generation" is not null and "project_policy_session_grants"."policy_generation">0)
        or ("project_policy_session_grants"."origin"='manual' and "project_policy_session_grants"."policy_generation" is null))
        and "project_policy_session_grants"."mapping_version">0 and "project_policy_session_grants"."grant_version">0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_share_policy_state_check" CHECK (("projects"."project_share_policy_version" is null and "projects"."project_share_policy_enabled_at" is null
          and "projects"."project_share_policy_device_credential_id" is null)
        or ("projects"."project_share_policy_version" > 0 and "projects"."project_share_policy_enabled_at" is not null
          and "projects"."project_share_policy_device_credential_id" is not null
          and "projects"."workspace_project_id" is not null and "projects"."team_backend_id" is not null));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_share_capture_shape_check" CHECK (("sessions"."project_share_capture_policy_version" is null and "sessions"."project_share_capture_workspace_project_id" is null
          and "sessions"."project_share_capture_device_credential_id" is null
          and "sessions"."project_share_capture_link_epoch" is null
          and "sessions"."project_share_capture_context_version" is null
          and "sessions"."project_share_capture_prepared_at" is null)
        or ("sessions"."project_share_capture_policy_version" > 0 and "sessions"."project_share_capture_workspace_project_id" is not null
          and "sessions"."project_share_capture_device_credential_id" is not null
          and "sessions"."project_share_capture_link_epoch" is not null
          and "sessions"."project_share_capture_context_version" > 0
          and "sessions"."project_share_capture_prepared_at" is not null));--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_values_check" CHECK ("shared_memory_candidate_previews"."preview_revision" = 1
        and "shared_memory_candidate_previews"."authority_source" in ('browser_session','device_action_grant','continuous_consent','project_share_policy')
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