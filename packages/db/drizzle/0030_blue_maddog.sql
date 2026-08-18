ALTER TYPE "public"."source_runtime" ADD VALUE 'claude-code';--> statement-breakpoint
CREATE TABLE "ai_client_capability_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"installation_identity_hash" text NOT NULL,
	"client_version" text,
	"authentication_state" text NOT NULL,
	"health_state" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_client_capability_snapshots_identity_check" CHECK ("ai_client_capability_snapshots"."installation_identity_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_client_capability_snapshots_state_check" CHECK ("ai_client_capability_snapshots"."authentication_state" in ('authenticated', 'unauthenticated', 'unknown')
        and "ai_client_capability_snapshots"."health_state" in ('healthy', 'unavailable', 'incompatible', 'error')),
	CONSTRAINT "ai_client_capability_snapshots_expiry_check" CHECK ("ai_client_capability_snapshots"."expires_at" > "ai_client_capability_snapshots"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "ai_client_instances" (
	"owner_user_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"driver_id" text NOT NULL,
	"display_name" text NOT NULL,
	"config_identity_hash" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_client_instances_owner_user_id_instance_id_pk" PRIMARY KEY("owner_user_id","instance_id"),
	CONSTRAINT "ai_client_instances_identity_check" CHECK ("ai_client_instances"."instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and "ai_client_instances"."driver_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'),
	CONSTRAINT "ai_client_instances_config_identity_check" CHECK ("ai_client_instances"."config_identity_hash" is null
        or "ai_client_instances"."config_identity_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "conversation_source_artifacts"
		WHERE "lifecycle" = 'finalized'
	) OR EXISTS (
		SELECT 1
		FROM "team_conversation_source_grants"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P0001',
			MESSAGE = 'Koed alpha data reset required before enabling multi-component Conversation Sources',
			HINT = 'Reset this pre-release Koed database and rerun setup; existing finalized sources and Team source grants cannot be upgraded without a signed source-set closure.';
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" DROP CONSTRAINT "local_memory_agent_settings_flow_key_check";--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" DROP CONSTRAINT "local_memory_agent_settings_provider_check";--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" DROP CONSTRAINT "managed_conversation_executions_provider_check";--> statement-breakpoint
DROP INDEX "conversation_source_artifacts_generation_unique";--> statement-breakpoint
DROP INDEX "conversation_source_artifacts_provider_identity_unique";--> statement-breakpoint
DROP INDEX "team_conversation_source_grants_logical_source_active_idx";--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "source_component_id" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "source_component_role" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "parent_source_component_id" text;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "content_framing" text DEFAULT 'jsonl' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "source_set_closure_hash" text;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "source_set_closure_manifest" jsonb;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "source_set_closure_signature" text;--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD COLUMN "source_set_finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD COLUMN "ai_client_instance_id" text DEFAULT 'codex.default' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD COLUMN "source_generation_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_client_capability_snapshots" ADD CONSTRAINT "ai_client_capability_snapshots_instance_fk" FOREIGN KEY ("owner_user_id","instance_id") REFERENCES "public"."ai_client_instances"("owner_user_id","instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_client_instances" ADD CONSTRAINT "ai_client_instances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_client_capability_snapshots_current_idx" ON "ai_client_capability_snapshots" USING btree ("owner_user_id","instance_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_client_instances_owner_driver_idx" ON "ai_client_instances" USING btree ("owner_user_id","driver_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD CONSTRAINT "conversation_source_artifacts_generation_component_unique" UNIQUE("owner_user_id","logical_source_id","source_generation_id","source_component_id");--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD CONSTRAINT "conversation_source_artifacts_generation_lookup_unique" UNIQUE("owner_user_id","source_generation_id","source_component_id");--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD CONSTRAINT "conversation_source_artifacts_parent_component_fk" FOREIGN KEY ("owner_user_id","logical_source_id","source_generation_id","parent_source_component_id") REFERENCES "public"."conversation_source_artifacts"("owner_user_id","logical_source_id","source_generation_id","source_component_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_source_artifacts_provider_identity_unique" ON "conversation_source_artifacts" USING btree ("owner_user_id","source_kind","external_session_id","source_generation_id","source_component_id");--> statement-breakpoint
CREATE INDEX "team_conversation_source_grants_logical_source_active_idx" ON "team_conversation_source_grants" USING btree ("logical_source_id","source_generation_id","updated_at" DESC NULLS LAST) WHERE "team_conversation_source_grants"."lifecycle" = 'active';--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD CONSTRAINT "conversation_source_artifacts_component_check" CHECK ("conversation_source_artifacts"."source_component_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and "conversation_source_artifacts"."source_component_role" in ('primary', 'auxiliary')
        and "conversation_source_artifacts"."content_framing" in ('jsonl', 'immutable_blob')
        and (
          ("conversation_source_artifacts"."source_component_role" = 'primary' and "conversation_source_artifacts"."parent_source_component_id" is null)
          or ("conversation_source_artifacts"."source_component_role" = 'auxiliary'
              and "conversation_source_artifacts"."parent_source_component_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
              and "conversation_source_artifacts"."parent_source_component_id" <> "conversation_source_artifacts"."source_component_id")
        ));--> statement-breakpoint
ALTER TABLE "conversation_source_artifacts" ADD CONSTRAINT "conversation_source_artifacts_source_set_closure_check" CHECK (("conversation_source_artifacts"."source_set_closure_hash" is null
          and "conversation_source_artifacts"."source_set_closure_manifest" is null
          and "conversation_source_artifacts"."source_set_closure_signature" is null
          and "conversation_source_artifacts"."source_set_finalized_at" is null)
        or ("conversation_source_artifacts"."source_component_id" = 'main'
          and "conversation_source_artifacts"."source_component_role" = 'primary'
          and "conversation_source_artifacts"."source_set_closure_hash" ~ '^[0-9a-f]{64}$'
          and jsonb_typeof("conversation_source_artifacts"."source_set_closure_manifest") = 'object'
          and "conversation_source_artifacts"."source_set_closure_manifest" <> '{}'::jsonb
          and "conversation_source_artifacts"."source_set_closure_signature" ~ '^[A-Za-z0-9_-]{86}$'
          and "conversation_source_artifacts"."source_set_finalized_at" is not null));--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD CONSTRAINT "local_memory_agent_settings_flow_key_check" CHECK ("local_memory_agent_settings"."flow_key" in ('mcp_memory_answer', 'manual_memory_answer', 'lcm_summary', 'curated_memory_review', 'session_title'));--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD CONSTRAINT "local_memory_agent_settings_provider_check" CHECK ("local_memory_agent_settings"."provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and "local_memory_agent_settings"."ai_client_instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$');--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_provider_check" CHECK ("managed_conversation_executions"."provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$');
--> statement-breakpoint
INSERT INTO "projection_policy_rules" (
	"source_kind",
	"source_adapter_version",
	"transcript_type",
	"description",
	"project_to_ui",
	"create_message",
	"create_tool_event",
	"create_memory_event",
	"include_in_embedding",
	"include_in_lcm"
) VALUES
	('claude-code', 'claude-code-transcript-v1', 'user_message', 'User-authored Claude transcript message.', true, true, false, true, true, true),
	('claude-code', 'claude-code-transcript-v1', 'agent_message', 'Agent-authored Claude transcript message.', true, true, false, true, true, true),
	('claude-code', 'claude-code-transcript-v1', 'subagent_message', 'Subagent-authored Claude transcript message.', true, true, false, true, true, true),
	('claude-code', 'claude-code-transcript-v1', 'tool_call', 'Claude transcript tool call.', true, true, true, true, true, true),
	('claude-code', 'claude-code-transcript-v1', 'tool_result', 'Claude transcript tool result.', true, true, true, true, true, true),
	('claude-code', 'claude-code-transcript-v1', 'agent_reasoning', 'Full Claude reasoning is retained as raw provenance only.', false, false, false, false, false, false),
	('claude-code', 'claude-code-transcript-v1', 'system_message', 'Claude system context is retained as raw provenance only.', false, false, false, false, false, false),
	('claude-code', 'claude-code-transcript-v1', 'unknown', 'Unknown Claude transcript items are retained as raw provenance only.', false, false, false, false, false, false)
ON CONFLICT DO NOTHING;
