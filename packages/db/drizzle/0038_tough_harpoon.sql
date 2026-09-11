CREATE TABLE "memory_answer_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"origin" text NOT NULL,
	"invocation_key" text,
	"request_snapshot" jsonb NOT NULL,
	"result_snapshot" jsonb,
	"question_id" uuid,
	"status" text DEFAULT 'accepted' NOT NULL,
	"status_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"fence_generation" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"last_progress_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_answer_tasks_personal_owner_check" CHECK ("memory_answer_tasks"."visibility" = 'personal' and "memory_answer_tasks"."owner_user_id" is not null),
	CONSTRAINT "memory_answer_tasks_origin_check" CHECK ("memory_answer_tasks"."origin" in ('mcp', 'pi_extension')),
	CONSTRAINT "memory_answer_tasks_status_check" CHECK ("memory_answer_tasks"."status" in ('accepted', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "memory_answer_tasks_attempts_check" CHECK ("memory_answer_tasks"."attempt_count" >= 0 and "memory_answer_tasks"."max_attempts" >= 1 and "memory_answer_tasks"."attempt_count" <= "memory_answer_tasks"."max_attempts"),
	CONSTRAINT "memory_answer_tasks_fence_version_check" CHECK ("memory_answer_tasks"."fence_generation" >= 0 and "memory_answer_tasks"."version" >= 1),
	CONSTRAINT "memory_answer_tasks_lease_check" CHECK (("memory_answer_tasks"."status" in ('running', 'cancel_requested') and "memory_answer_tasks"."lease_owner" is not null and "memory_answer_tasks"."lease_until" is not null)
        or ("memory_answer_tasks"."status" not in ('running', 'cancel_requested') and "memory_answer_tasks"."lease_owner" is null and "memory_answer_tasks"."lease_until" is null)),
	CONSTRAINT "memory_answer_tasks_terminal_check" CHECK (("memory_answer_tasks"."status" = 'completed' and "memory_answer_tasks"."result_snapshot" is not null and "memory_answer_tasks"."question_id" is not null and "memory_answer_tasks"."completed_at" is not null and "memory_answer_tasks"."failed_at" is null and "memory_answer_tasks"."cancelled_at" is null)
        or ("memory_answer_tasks"."status" = 'failed' and "memory_answer_tasks"."result_snapshot" is null and "memory_answer_tasks"."question_id" is null and "memory_answer_tasks"."completed_at" is null and "memory_answer_tasks"."failed_at" is not null and "memory_answer_tasks"."cancelled_at" is null)
        or ("memory_answer_tasks"."status" = 'cancelled' and "memory_answer_tasks"."result_snapshot" is null and "memory_answer_tasks"."question_id" is null and "memory_answer_tasks"."completed_at" is null and "memory_answer_tasks"."failed_at" is null and "memory_answer_tasks"."cancelled_at" is not null)
        or ("memory_answer_tasks"."status" not in ('completed', 'failed', 'cancelled') and "memory_answer_tasks"."result_snapshot" is null and "memory_answer_tasks"."question_id" is null and "memory_answer_tasks"."completed_at" is null and "memory_answer_tasks"."failed_at" is null and "memory_answer_tasks"."cancelled_at" is null))
);
--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" DROP CONSTRAINT "local_memory_agent_settings_timeout_ms_check";--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD CONSTRAINT "local_memory_agent_settings_timeout_ms_check" CHECK ("local_memory_agent_settings"."timeout_ms" between 1000 and 1800000);--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" DROP CONSTRAINT "encrypted_field_backfill_runs_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "memory_answer_tasks" ADD CONSTRAINT "memory_answer_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_answer_tasks" ADD CONSTRAINT "memory_answer_tasks_question_id_memory_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."memory_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_answer_tasks_owner_invocation_unique" ON "memory_answer_tasks" USING btree ("owner_user_id","origin","invocation_key") WHERE "memory_answer_tasks"."invocation_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_answer_tasks_question_unique" ON "memory_answer_tasks" USING btree ("question_id") WHERE "memory_answer_tasks"."question_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_answer_tasks_claim_idx" ON "memory_answer_tasks" USING btree ("status","available_at","lease_until","id") WHERE "memory_answer_tasks"."status" in ('accepted', 'running', 'cancel_requested');--> statement-breakpoint
CREATE INDEX "memory_answer_tasks_owner_lookup_idx" ON "memory_answer_tasks" USING btree ("owner_user_id","id");--> statement-breakpoint
CREATE INDEX "memory_answer_tasks_expiry_idx" ON "memory_answer_tasks" USING btree ("expires_at") WHERE "memory_answer_tasks"."status" in ('completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" ADD CONSTRAINT "encrypted_field_backfill_runs_source_table_check" CHECK ("encrypted_field_backfill_runs"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'collaboration_messages',
        'collaboration_threads',
        'memory_answer_tasks',
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
        'memory_answer_tasks',
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
      ));
