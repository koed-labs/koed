DROP SCHEMA IF EXISTS "public" CASCADE;--> statement-breakpoint
CREATE SCHEMA "public";--> statement-breakpoint
GRANT ALL ON SCHEMA "public" TO "public";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "vector";--> statement-breakpoint
CREATE TYPE "public"."capture_method" AS ENUM('hook', 'mcp', 'web', 'api');--> statement-breakpoint
CREATE TYPE "public"."capture_policy_target" AS ENUM('global', 'project', 'thread');--> statement-breakpoint
CREATE TYPE "public"."capture_state" AS ENUM('enabled', 'disabled', 'ask');--> statement-breakpoint
CREATE TYPE "public"."memory_event_type" AS ENUM('captured', 'invalidated', 'summarized', 'embedded');--> statement-breakpoint
CREATE TYPE "public"."memory_question_status" AS ENUM('pending', 'answered', 'error');--> statement-breakpoint
CREATE TYPE "public"."memory_search_domain" AS ENUM('global', 'project', 'session');--> statement-breakpoint
CREATE TYPE "public"."source_runtime" AS ENUM('codex', 'codex-cli');--> statement-breakpoint
CREATE TYPE "public"."visibility_scope" AS ENUM('personal');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" text[] DEFAULT array[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_tokens_token_hash_length_check" CHECK (length("api_tokens"."token_hash") >= 32)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"owner_user_id" uuid,
	"visibility" "visibility_scope",
	"action" text NOT NULL,
	"target_table" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"target_type" "capture_policy_target" NOT NULL,
	"project_id" text,
	"project_name" text,
	"project_path" text,
	"thread_id" text,
	"thread_name" text,
	"capture_state" "capture_state",
	"visibility" "visibility_scope",
	"pause_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_policies_target_check" CHECK (("capture_policies"."target_type" = 'global' and "capture_policies"."project_id" is null and "capture_policies"."thread_id" is null)
        or ("capture_policies"."target_type" = 'project' and "capture_policies"."project_id" is not null and "capture_policies"."thread_id" is null)
        or ("capture_policies"."target_type" = 'thread' and "capture_policies"."thread_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "conversation_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"session_id" uuid,
	"turn_id" uuid,
	"source_kind" text NOT NULL,
	"source_adapter_version" text NOT NULL,
	"source_transport" text NOT NULL,
	"external_session_id" text,
	"external_thread_id" text,
	"external_turn_id" text,
	"external_item_id" text,
	"parent_external_item_id" text,
	"source_record_type" text NOT NULL,
	"source_event_type" text,
	"source_path" text,
	"source_line_number" integer,
	"source_sequence" integer,
	"event_time" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_json" jsonb NOT NULL,
	"raw_text" text,
	"source_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"projection_status" text DEFAULT 'pending' NOT NULL,
	"projection_version" text,
	"projected_at" timestamp with time zone,
	"projection_error" text,
	"memory_excluded_at" timestamp with time zone,
	"memory_exclusion_reason" text,
	"memory_excluded_by_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"logical_source_id" text,
	"transport_chunk_index" integer DEFAULT 0 NOT NULL,
	"transport_chunk_count" integer DEFAULT 1 NOT NULL,
	"transport_chunk_text" text,
	"transport_chunk_encoding" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_items_personal_owner_check" CHECK ("conversation_items"."visibility" = 'personal' and "conversation_items"."owner_user_id" is not null),
	CONSTRAINT "conversation_items_source_line_number_check" CHECK ("conversation_items"."source_line_number" is null or "conversation_items"."source_line_number" >= 0),
	CONSTRAINT "conversation_items_source_sequence_check" CHECK ("conversation_items"."source_sequence" is null or "conversation_items"."source_sequence" >= 0),
	CONSTRAINT "conversation_items_transport_chunk_index_check" CHECK ("conversation_items"."transport_chunk_index" >= 0),
	CONSTRAINT "conversation_items_transport_chunk_count_check" CHECK ("conversation_items"."transport_chunk_count" >= 1 and "conversation_items"."transport_chunk_index" < "conversation_items"."transport_chunk_count")
);
--> statement-breakpoint
CREATE TABLE "local_memory_agent_settings" (
	"owner_user_id" uuid NOT NULL,
	"flow_key" text NOT NULL,
	"provider" text DEFAULT 'codex' NOT NULL,
	"model" text NOT NULL,
	"reasoning_effort" text NOT NULL,
	"timeout_ms" integer NOT NULL,
	"max_attempts" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_memory_agent_settings_owner_user_id_flow_key_pk" PRIMARY KEY("owner_user_id","flow_key"),
	CONSTRAINT "local_memory_agent_settings_flow_key_check" CHECK ("local_memory_agent_settings"."flow_key" in ('mcp_memory_answer', 'lcm_summary')),
	CONSTRAINT "local_memory_agent_settings_provider_check" CHECK ("local_memory_agent_settings"."provider" = 'codex'),
	CONSTRAINT "local_memory_agent_settings_model_check" CHECK ("local_memory_agent_settings"."model" <> ''),
	CONSTRAINT "local_memory_agent_settings_reasoning_effort_check" CHECK ("local_memory_agent_settings"."reasoning_effort" <> ''),
	CONSTRAINT "local_memory_agent_settings_timeout_ms_check" CHECK ("local_memory_agent_settings"."timeout_ms" between 1000 and 600000),
	CONSTRAINT "local_memory_agent_settings_max_attempts_check" CHECK ("local_memory_agent_settings"."max_attempts" between 1 and 25)
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memory_node_id" uuid,
	"memory_event_id" uuid,
	"message_id" uuid,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"embedding_version" text NOT NULL,
	"source_hash" text NOT NULL,
	"source_chunk_index" integer DEFAULT 0 NOT NULL,
	"source_chunk_count" integer DEFAULT 1 NOT NULL,
	"source_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "memory_embeddings_embedding_dimensions_check" CHECK ("memory_embeddings"."embedding_dimensions" in (384, 1024, 1536, 3072)),
	CONSTRAINT "memory_embeddings_one_source_check" CHECK (num_nonnulls("memory_embeddings"."memory_node_id", "memory_embeddings"."memory_event_id", "memory_embeddings"."message_id") = 1),
	CONSTRAINT "memory_embeddings_source_chunk_index_check" CHECK ("memory_embeddings"."source_chunk_index" >= 0),
	CONSTRAINT "memory_embeddings_source_chunk_count_check" CHECK ("memory_embeddings"."source_chunk_count" >= 1 and "memory_embeddings"."source_chunk_index" < "memory_embeddings"."source_chunk_count"),
	CONSTRAINT "memory_embeddings_personal_owner_check" CHECK ("memory_embeddings"."visibility" = 'personal' and "memory_embeddings"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings_1024" (
	"memory_embedding_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1024) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings_1536" (
	"memory_embedding_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings_3072" (
	"memory_embedding_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(3072) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings_384" (
	"memory_embedding_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(384) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_event_sources" (
	"memory_event_id" uuid NOT NULL,
	"conversation_item_id" uuid NOT NULL,
	"source_order" integer DEFAULT 0 NOT NULL,
	"source_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_event_sources_memory_event_id_conversation_item_id_source_order_pk" PRIMARY KEY("memory_event_id","conversation_item_id","source_order")
);
--> statement-breakpoint
CREATE TABLE "memory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" NOT NULL,
	"event_type" "memory_event_type" NOT NULL,
	"source_runtime" "source_runtime",
	"capture_method" "capture_method" NOT NULL,
	"codex_transcript_path" text,
	"session_id" uuid,
	"turn_id" uuid,
	"message_id" uuid,
	"tool_event_id" uuid,
	"idempotency_key" text,
	"source_hash" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_count" integer,
	"seal_reason" text,
	"source_event_time" timestamp with time zone,
	"source_sequence" bigint,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "memory_events_personal_owner_check" CHECK ("memory_events"."visibility" = 'personal' and "memory_events"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "memory_node_children" (
	"parent_memory_node_id" uuid NOT NULL,
	"child_memory_node_id" uuid NOT NULL,
	"child_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_node_children_parent_memory_node_id_child_order_pk" PRIMARY KEY("parent_memory_node_id","child_order"),
	CONSTRAINT "memory_node_children_parent_child_unique" UNIQUE("parent_memory_node_id","child_memory_node_id")
);
--> statement-breakpoint
CREATE TABLE "memory_node_sources" (
	"memory_node_id" uuid NOT NULL,
	"memory_event_id" uuid,
	"message_id" uuid,
	"tool_event_id" uuid,
	"source_order" integer DEFAULT 0 NOT NULL,
	"source_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_node_sources_memory_node_id_source_order_pk" PRIMARY KEY("memory_node_id","source_order"),
	CONSTRAINT "memory_node_sources_one_source_check" CHECK ("memory_node_sources"."memory_event_id" is not null or "memory_node_sources"."message_id" is not null or "memory_node_sources"."tool_event_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "memory_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"created_by_user_id" uuid,
	"visibility" "visibility_scope" NOT NULL,
	"kind" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"title" text,
	"summary_text" text NOT NULL,
	"body_text" text,
	"source_runtime" "source_runtime",
	"capture_method" "capture_method" NOT NULL,
	"codex_transcript_path" text,
	"idempotency_key" text,
	"source_hash" text,
	"summary_model" text,
	"summary_prompt_version" text,
	"lcm_algorithm_version" text,
	"source_items_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_count" integer DEFAULT 0 NOT NULL,
	"source_token_estimate" integer,
	"summary_token_estimate" integer,
	"source_span_start" timestamp with time zone,
	"source_span_end" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"summary_corrected_at" timestamp with time zone,
	"summary_corrected_by_user_id" uuid,
	"summary_structured_json" jsonb,
	"summary_structured_schema_version" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "memory_nodes_kind_check" CHECK ("memory_nodes"."kind" in ('leaf', 'rollup')),
	CONSTRAINT "memory_nodes_depth_check" CHECK ("memory_nodes"."depth" >= 0),
	CONSTRAINT "memory_nodes_personal_owner_check" CHECK ("memory_nodes"."visibility" = 'personal' and "memory_nodes"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "memory_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"retrieval_scope" text DEFAULT 'personal' NOT NULL,
	"search_domain" "memory_search_domain" NOT NULL,
	"workspace_id" text,
	"project_name" text,
	"project_path" text,
	"session_id" uuid,
	"thread_id" text,
	"thread_name" text,
	"query" text NOT NULL,
	"answer_markdown" text,
	"error_message" text,
	"evidence" jsonb,
	"citations" jsonb,
	"retrieval" jsonb,
	"local_memory_worker" jsonb,
	"local_memory_worker_config" jsonb,
	"response" jsonb,
	"status" "memory_question_status" DEFAULT 'pending' NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processing_lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "memory_questions_personal_owner_check" CHECK ("memory_questions"."visibility" = 'personal' and "memory_questions"."owner_user_id" is not null),
	CONSTRAINT "memory_questions_retrieval_scope_check" CHECK ("memory_questions"."retrieval_scope" in ('personal')),
	CONSTRAINT "memory_questions_search_domain_check" CHECK (("memory_questions"."search_domain" = 'global')
        or ("memory_questions"."search_domain" = 'project' and "memory_questions"."workspace_id" is not null)
        or ("memory_questions"."search_domain" = 'session' and "memory_questions"."session_id" is not null)),
	CONSTRAINT "memory_questions_status_check" CHECK (("memory_questions"."status" = 'answered' and "memory_questions"."answer_markdown" is not null and "memory_questions"."error_message" is null)
        or ("memory_questions"."status" = 'error' and "memory_questions"."error_message" is not null)
        or "memory_questions"."status" = 'pending')
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb,
	"source_runtime" "source_runtime" NOT NULL,
	"capture_method" "capture_method" NOT NULL,
	"codex_transcript_path" text,
	"transcript_item_id" text,
	"idempotency_key" text,
	"source_hash" text,
	"token_count" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user', 'assistant', 'system', 'tool')),
	CONSTRAINT "messages_personal_owner_check" CHECK ("messages"."visibility" = 'personal' and "messages"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "semantic_memory_rebuild_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"memory_event_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"scheduled_after" timestamp with time zone NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processing_lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_message" text,
	"replacement_memory_event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "semantic_memory_rebuild_jobs_personal_owner_check" CHECK ("semantic_memory_rebuild_jobs"."visibility" = 'personal' and "semantic_memory_rebuild_jobs"."owner_user_id" is not null),
	CONSTRAINT "semantic_memory_rebuild_jobs_attempt_count_check" CHECK ("semantic_memory_rebuild_jobs"."attempt_count" >= 0),
	CONSTRAINT "semantic_memory_rebuild_jobs_status_check" CHECK ("semantic_memory_rebuild_jobs"."status" in ('pending', 'processing', 'completed', 'error'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"workspace_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"external_session_id" text,
	"source_runtime" "source_runtime" NOT NULL,
	"capture_method" "capture_method" NOT NULL,
	"codex_transcript_path" text,
	"idempotency_key" text,
	"source_hash" text,
	"model" text,
	"cwd" text,
	"source_kind" text,
	"source_adapter_version" text,
	"external_thread_id" text,
	"forked_from_external_thread_id" text,
	"parent_session_id" uuid,
	"parent_external_thread_id" text,
	"agent_nickname" text,
	"agent_role" text,
	"agent_path" text,
	"thread_source" text,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "sessions_personal_owner_check" CHECK ("sessions"."visibility" = 'personal' and "sessions"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "tool_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"turn_id" uuid,
	"message_id" uuid,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"tool_name" text NOT NULL,
	"tool_input" jsonb,
	"tool_response" jsonb,
	"status" text,
	"source_runtime" "source_runtime" NOT NULL,
	"capture_method" "capture_method" NOT NULL,
	"codex_transcript_path" text,
	"transcript_item_id" text,
	"idempotency_key" text,
	"source_hash" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "tool_events_personal_owner_check" CHECK ("tool_events"."visibility" = 'personal' and "tool_events"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"external_turn_id" text,
	"turn_index" integer,
	"source_runtime" "source_runtime" NOT NULL,
	"capture_method" "capture_method" NOT NULL,
	"source_kind" text,
	"source_adapter_version" text,
	"external_thread_id" text,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"codex_transcript_path" text,
	"idempotency_key" text,
	"source_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "turns_personal_owner_check" CHECK ("turns"."visibility" = 'personal' and "turns"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_sessions_session_hash_unique" UNIQUE("session_hash"),
	CONSTRAINT "user_sessions_session_hash_length_check" CHECK (length("user_sessions"."session_hash") >= 32)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workflow_token_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"workflow_type" text NOT NULL,
	"workflow_id" text,
	"session_id" uuid,
	"turn_id" uuid,
	"conversation_item_id" uuid,
	"source_runtime" "source_runtime",
	"source_kind" text,
	"source_adapter_version" text,
	"model" text,
	"model_context_window" integer,
	"input_tokens" integer,
	"cached_input_tokens" integer,
	"output_tokens" integer,
	"reasoning_output_tokens" integer,
	"total_tokens" integer,
	"usage_scope" text DEFAULT 'last' NOT NULL,
	"usage_source" text DEFAULT 'app_server' NOT NULL,
	"usage_accuracy" text DEFAULT 'provider_reported' NOT NULL,
	"usage_kind" text DEFAULT 'turn_delta' NOT NULL,
	"connector_client" text,
	"tokenizer_package" text,
	"tokenizer_encoding" text,
	"tokenizer_model" text,
	"tokenizer_exact_model_match" boolean,
	"tokenizer_heuristic_fallback" boolean,
	"tokenizer_version" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"source_hash" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_token_usage_personal_owner_check" CHECK ("workflow_token_usage"."visibility" = 'personal' and "workflow_token_usage"."owner_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "workflow_token_usage_source_references" (
	"workflow_token_usage_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_token_usage_source_references_workflow_token_usage_id_source_type_source_id_pk" PRIMARY KEY("workflow_token_usage_id","source_type","source_id"),
	CONSTRAINT "workflow_token_usage_source_references_type_check" CHECK ("workflow_token_usage_source_references"."source_type" in ('question', 'answer_job', 'lcm_node', 'message', 'tool_event', 'memory_event'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid,
	"visibility" "visibility_scope" NOT NULL,
	"name" text NOT NULL,
	"root_path" text,
	"source_runtime" "source_runtime",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "workspaces_personal_owner_check" CHECK ("workspaces"."visibility" = 'personal' and "workspaces"."owner_user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_policies" ADD CONSTRAINT "capture_policies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_memory_excluded_by_user_id_users_id_fk" FOREIGN KEY ("memory_excluded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD CONSTRAINT "local_memory_agent_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings_1024" ADD CONSTRAINT "memory_embeddings_1024_memory_embedding_id_memory_embeddings_id_fk" FOREIGN KEY ("memory_embedding_id") REFERENCES "public"."memory_embeddings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings_1536" ADD CONSTRAINT "memory_embeddings_1536_memory_embedding_id_memory_embeddings_id_fk" FOREIGN KEY ("memory_embedding_id") REFERENCES "public"."memory_embeddings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings_3072" ADD CONSTRAINT "memory_embeddings_3072_memory_embedding_id_memory_embeddings_id_fk" FOREIGN KEY ("memory_embedding_id") REFERENCES "public"."memory_embeddings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings_384" ADD CONSTRAINT "memory_embeddings_384_memory_embedding_id_memory_embeddings_id_fk" FOREIGN KEY ("memory_embedding_id") REFERENCES "public"."memory_embeddings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_event_sources" ADD CONSTRAINT "memory_event_sources_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_event_sources" ADD CONSTRAINT "memory_event_sources_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_events" ADD CONSTRAINT "memory_events_tool_event_id_tool_events_id_fk" FOREIGN KEY ("tool_event_id") REFERENCES "public"."tool_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_children" ADD CONSTRAINT "memory_node_children_parent_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("parent_memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_children" ADD CONSTRAINT "memory_node_children_child_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("child_memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_sources" ADD CONSTRAINT "memory_node_sources_memory_node_id_memory_nodes_id_fk" FOREIGN KEY ("memory_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_sources" ADD CONSTRAINT "memory_node_sources_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_sources" ADD CONSTRAINT "memory_node_sources_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_node_sources" ADD CONSTRAINT "memory_node_sources_tool_event_id_tool_events_id_fk" FOREIGN KEY ("tool_event_id") REFERENCES "public"."tool_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD CONSTRAINT "memory_nodes_summary_corrected_by_user_id_users_id_fk" FOREIGN KEY ("summary_corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_rebuild_jobs" ADD CONSTRAINT "semantic_memory_rebuild_jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_rebuild_jobs" ADD CONSTRAINT "semantic_memory_rebuild_jobs_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_parent_session_id_sessions_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_events" ADD CONSTRAINT "tool_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_token_usage" ADD CONSTRAINT "workflow_token_usage_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_token_usage" ADD CONSTRAINT "workflow_token_usage_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_token_usage" ADD CONSTRAINT "workflow_token_usage_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_token_usage" ADD CONSTRAINT "workflow_token_usage_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_token_usage_source_references" ADD CONSTRAINT "workflow_token_usage_source_refs_usage_fk" FOREIGN KEY ("workflow_token_usage_id") REFERENCES "public"."workflow_token_usage"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_owner_idx" ON "audit_events" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "capture_policies_unique_target" ON "capture_policies" USING btree ("owner_user_id","target_type",coalesce("project_id", ''),coalesce("thread_id", ''));--> statement-breakpoint
CREATE INDEX "capture_policies_owner_updated_idx" ON "capture_policies" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_items_personal_idempotency_key_unique" ON "conversation_items" USING btree ("owner_user_id","idempotency_key") WHERE "conversation_items"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "conversation_items_session_observed_idx" ON "conversation_items" USING btree ("session_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "conversation_items_session_turn_observed_idx" ON "conversation_items" USING btree ("session_id","turn_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "conversation_items_source_thread_idx" ON "conversation_items" USING btree ("source_kind","external_session_id","external_turn_id");--> statement-breakpoint
CREATE INDEX "conversation_items_source_item_idx" ON "conversation_items" USING btree ("source_kind","external_item_id") WHERE "conversation_items"."external_item_id" is not null;--> statement-breakpoint
CREATE INDEX "conversation_items_projection_idx" ON "conversation_items" USING btree ("projection_status","projected_at","observed_at","id");--> statement-breakpoint
CREATE INDEX "conversation_items_memory_excluded_idx" ON "conversation_items" USING btree ("owner_user_id","memory_excluded_at") WHERE "conversation_items"."memory_excluded_at" is not null;--> statement-breakpoint
CREATE INDEX "conversation_items_personal_logical_source_idx" ON "conversation_items" USING btree ("owner_user_id","logical_source_id","transport_chunk_index") WHERE "conversation_items"."visibility" = 'personal' and "conversation_items"."logical_source_id" is not null;--> statement-breakpoint
CREATE INDEX "local_memory_agent_settings_owner_idx" ON "local_memory_agent_settings" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "memory_embeddings_unique_active_node_chunk" ON "memory_embeddings" USING btree ("memory_node_id","embedding_model","embedding_dimensions","embedding_version","source_hash","source_chunk_index") WHERE "memory_embeddings"."invalidated_at" is null and "memory_embeddings"."memory_node_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_embeddings_unique_active_event_chunk" ON "memory_embeddings" USING btree ("memory_event_id","embedding_model","embedding_dimensions","embedding_version","source_hash","source_chunk_index") WHERE "memory_embeddings"."invalidated_at" is null and "memory_embeddings"."memory_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_embeddings_unique_active_message_chunk" ON "memory_embeddings" USING btree ("message_id","embedding_model","embedding_dimensions","embedding_version","source_hash","source_chunk_index") WHERE "memory_embeddings"."invalidated_at" is null and "memory_embeddings"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_embeddings_personal_visible_idx" ON "memory_embeddings" USING btree ("owner_user_id","embedding_dimensions","created_at" DESC NULLS LAST) WHERE "memory_embeddings"."visibility" = 'personal' and "memory_embeddings"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_embeddings_1024_hnsw_idx" ON "memory_embeddings_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_embeddings_1536_hnsw_idx" ON "memory_embeddings_1536" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_embeddings_384_hnsw_idx" ON "memory_embeddings_384" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "memory_event_sources_conversation_item_idx" ON "memory_event_sources" USING btree ("conversation_item_id");--> statement-breakpoint
CREATE INDEX "memory_event_sources_memory_event_order_idx" ON "memory_event_sources" USING btree ("memory_event_id","source_order");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_idempotency_key_unique" ON "memory_events" USING btree ("idempotency_key") WHERE "memory_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_events_source_hash_unique" ON "memory_events" USING btree ("source_hash") WHERE "memory_events"."source_hash" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_personal_graph_idx" ON "memory_events" USING btree ("owner_user_id","created_at" DESC NULLS LAST) WHERE "memory_events"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "memory_events_personal_capture_idx" ON "memory_events" USING btree ("owner_user_id","captured_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_events"."visibility" = 'personal' and "memory_events"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_events_personal_workspace_expr_idx" ON "memory_events" USING btree ("owner_user_id",("payload" ->> 'workspaceId'),"captured_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_events"."visibility" = 'personal' and "memory_events"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_events_personal_external_thread_expr_idx" ON "memory_events" USING btree ("owner_user_id",("payload" #>> '{metadata,externalSessionId}'),"captured_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_events"."visibility" = 'personal' and "memory_events"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_events_personal_source_order_idx" ON "memory_events" USING btree ("owner_user_id",coalesce("source_event_time", "captured_at") desc,"source_sequence" desc nulls last,"id" DESC NULLS LAST) WHERE "memory_events"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "memory_node_children_child_idx" ON "memory_node_children" USING btree ("child_memory_node_id","parent_memory_node_id");--> statement-breakpoint
CREATE INDEX "memory_node_sources_event_order_idx" ON "memory_node_sources" USING btree ("memory_event_id","source_order","memory_node_id") WHERE "memory_node_sources"."memory_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_nodes_idempotency_key_unique" ON "memory_nodes" USING btree ("idempotency_key") WHERE "memory_nodes"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_nodes_source_hash_unique" ON "memory_nodes" USING btree ("source_hash") WHERE "memory_nodes"."source_hash" is not null;--> statement-breakpoint
CREATE INDEX "memory_nodes_personal_visible_idx" ON "memory_nodes" USING btree ("owner_user_id","created_at" DESC NULLS LAST) WHERE "memory_nodes"."visibility" = 'personal' and "memory_nodes"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_nodes_lcm_scope_depth_idx" ON "memory_nodes" USING btree ("visibility","owner_user_id","depth","created_at") WHERE "memory_nodes"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_nodes_personal_pinned_idx" ON "memory_nodes" USING btree ("owner_user_id","pinned_at" DESC NULLS LAST) WHERE "memory_nodes"."visibility" = 'personal' and "memory_nodes"."invalidated_at" is null and "memory_nodes"."pinned_at" is not null;--> statement-breakpoint
CREATE INDEX "memory_nodes_personal_updated_idx" ON "memory_nodes" USING btree ("owner_user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_nodes"."visibility" = 'personal' and "memory_nodes"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "memory_questions_personal_created_idx" ON "memory_questions" USING btree ("owner_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_questions"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "memory_questions_personal_scope_idx" ON "memory_questions" USING btree ("owner_user_id","search_domain","workspace_id","session_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_questions"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "memory_questions_personal_pending_claim_idx" ON "memory_questions" USING btree ("owner_user_id","processing_lease_until","created_at","id") WHERE "memory_questions"."visibility" = 'personal' and "memory_questions"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_transcript_item_unique" ON "messages" USING btree ("session_id","transcript_item_id") WHERE "messages"."transcript_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key_unique" ON "messages" USING btree ("idempotency_key") WHERE "messages"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_source_hash_unique" ON "messages" USING btree ("source_hash") WHERE "messages"."source_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "semantic_memory_rebuild_jobs_active_unique" ON "semantic_memory_rebuild_jobs" USING btree ("memory_event_id") WHERE "semantic_memory_rebuild_jobs"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "semantic_memory_rebuild_jobs_due_idx" ON "semantic_memory_rebuild_jobs" USING btree ("status","scheduled_after","id") WHERE "semantic_memory_rebuild_jobs"."status" in ('pending', 'error');--> statement-breakpoint
CREATE INDEX "semantic_memory_rebuild_jobs_actor_due_idx" ON "semantic_memory_rebuild_jobs" USING btree ("owner_user_id","status","scheduled_after","id") WHERE "semantic_memory_rebuild_jobs"."visibility" = 'personal' and "semantic_memory_rebuild_jobs"."status" in ('pending', 'error');--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_idempotency_key_unique" ON "sessions" USING btree ("idempotency_key") WHERE "sessions"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_source_hash_unique" ON "sessions" USING btree ("source_hash") WHERE "sessions"."source_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_events_transcript_item_unique" ON "tool_events" USING btree ("session_id","transcript_item_id") WHERE "tool_events"."transcript_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_events_idempotency_key_unique" ON "tool_events" USING btree ("idempotency_key") WHERE "tool_events"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_events_source_hash_unique" ON "tool_events" USING btree ("source_hash") WHERE "tool_events"."source_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_session_external_turn_unique" ON "turns" USING btree ("session_id","external_turn_id") WHERE "turns"."external_turn_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_session_turn_index_unique" ON "turns" USING btree ("session_id","turn_index") WHERE "turns"."turn_index" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_idempotency_key_unique" ON "turns" USING btree ("idempotency_key") WHERE "turns"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_source_hash_unique" ON "turns" USING btree ("source_hash") WHERE "turns"."source_hash" is not null;--> statement-breakpoint
CREATE INDEX "user_sessions_active_user_idx" ON "user_sessions" USING btree ("user_id","expires_at" DESC NULLS LAST) WHERE "user_sessions"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_token_usage_personal_idempotency_key_unique" ON "workflow_token_usage" USING btree ("owner_user_id","idempotency_key") WHERE "workflow_token_usage"."visibility" = 'personal' and "workflow_token_usage"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "workflow_token_usage_workflow_idx" ON "workflow_token_usage" USING btree ("workflow_type","workflow_id","observed_at");--> statement-breakpoint
CREATE INDEX "workflow_token_usage_conversation_item_idx" ON "workflow_token_usage" USING btree ("conversation_item_id") WHERE "workflow_token_usage"."conversation_item_id" is not null;--> statement-breakpoint
CREATE INDEX "workflow_token_usage_session_turn_idx" ON "workflow_token_usage" USING btree ("session_id","turn_id","observed_at");--> statement-breakpoint
CREATE INDEX "workflow_token_usage_attribution_idx" ON "workflow_token_usage" USING btree ("usage_source","usage_accuracy","usage_kind","observed_at");--> statement-breakpoint
CREATE INDEX "workflow_token_usage_connector_idx" ON "workflow_token_usage" USING btree ("connector_client","observed_at") WHERE "workflow_token_usage"."connector_client" is not null;--> statement-breakpoint
CREATE INDEX "workflow_token_usage_source_references_lookup_idx" ON "workflow_token_usage_source_references" USING btree ("source_type","source_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_koed_graph_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payload jsonb;
  row_id uuid;
  owner_id uuid;
  visibility_value text;
  project_id_value text;
  thread_id_value text;
  row_session_id uuid;
BEGIN
  IF tg_table_name = 'memory_node_sources' THEN
    row_id := CASE
      WHEN tg_op = 'DELETE' THEN old.memory_node_id
      ELSE new.memory_node_id
    END;

    SELECT mn.owner_user_id, mn.visibility::text
    INTO owner_id, visibility_value
    FROM memory_nodes mn
    WHERE mn.id = row_id;
  ELSIF tg_table_name = 'memory_embeddings' THEN
    row_id := CASE
      WHEN tg_op = 'DELETE' THEN old.memory_node_id
      ELSE new.memory_node_id
    END;
    owner_id := CASE
      WHEN tg_op = 'DELETE' THEN old.owner_user_id
      ELSE new.owner_user_id
    END;
    visibility_value := CASE
      WHEN tg_op = 'DELETE' THEN old.visibility::text
      ELSE new.visibility::text
    END;

    IF owner_id IS NULL AND row_id IS NOT NULL THEN
      SELECT mn.owner_user_id, mn.visibility::text
      INTO owner_id, visibility_value
      FROM memory_nodes mn
      WHERE mn.id = row_id;
    END IF;
  ELSIF tg_op = 'DELETE' THEN
    row_id := old.id;
    owner_id := old.owner_user_id;
    visibility_value := old.visibility::text;

    IF tg_table_name IN ('memory_events', 'messages', 'tool_events') THEN
      row_session_id := old.session_id;
    END IF;

    IF tg_table_name = 'memory_events' THEN
      project_id_value := old.payload ->> 'workspaceId';
      thread_id_value := old.payload #>> '{metadata,externalSessionId}';
    END IF;
  ELSE
    row_id := new.id;
    owner_id := new.owner_user_id;
    visibility_value := new.visibility::text;

    IF tg_table_name IN ('memory_events', 'messages', 'tool_events') THEN
      row_session_id := new.session_id;
    END IF;

    IF tg_table_name = 'memory_events' THEN
      project_id_value := new.payload ->> 'workspaceId';
      thread_id_value := new.payload #>> '{metadata,externalSessionId}';
    END IF;
  END IF;

  IF tg_table_name IN ('memory_events', 'messages', 'tool_events')
    AND (project_id_value IS NULL OR thread_id_value IS NULL)
  THEN
    SELECT
      coalesce(project_id_value, s.metadata ->> 'workspaceId', s.workspace_id::text, s.cwd),
      coalesce(thread_id_value, s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text)
    INTO project_id_value, thread_id_value
    FROM sessions s
    WHERE s.id = row_session_id;
  END IF;

  payload := jsonb_build_object(
    'table', tg_table_name,
    'operation', tg_op,
    'id', row_id,
    'ownerUserId', owner_id,
    'visibility', visibility_value,
    'changedAt', now()
  );

  IF tg_table_name IN ('memory_events', 'messages', 'tool_events') THEN
    payload := payload || jsonb_build_object(
      'projectId', project_id_value,
      'threadId', thread_id_value
    );
  END IF;

  PERFORM pg_notify('koed_graph_updates', payload::text);

  IF tg_op = 'DELETE' THEN
    RETURN old;
  END IF;
  RETURN new;
END;
$$;--> statement-breakpoint
CREATE TRIGGER memory_events_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER memory_nodes_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON memory_nodes
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER memory_node_sources_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON memory_node_sources
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER memory_embeddings_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON memory_embeddings
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER sessions_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER memory_questions_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON memory_questions
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER messages_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();--> statement-breakpoint
CREATE TRIGGER tool_events_graph_update_notify
AFTER INSERT OR UPDATE OR DELETE ON tool_events
FOR EACH ROW EXECUTE FUNCTION notify_koed_graph_update();
