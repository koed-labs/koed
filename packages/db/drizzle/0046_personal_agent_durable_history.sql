CREATE TABLE "personal_agent_conversation_participants" (
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_conversation_participants_pk" PRIMARY KEY("conversation_id","agent_id"),
	CONSTRAINT "personal_agent_conversation_participants_ordinal_unique" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "personal_agent_conversation_participants_ordinal_check" CHECK ("personal_agent_conversation_participants"."ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD CONSTRAINT "managed_conversation_executions_owner_id_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
CREATE TABLE "personal_agent_conversations" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"active_agent_id" uuid,
	"model_override" text,
	"reasoning_effort_override" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_conversations_owner_id_unique" UNIQUE("conversation_id","owner_user_id"),
	CONSTRAINT "personal_agent_conversations_version_check" CHECK ("personal_agent_conversations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agent_execution_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_id" text NOT NULL,
	"execution_generation" integer,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_job_events_job_sequence_unique" UNIQUE("job_id","sequence"),
	CONSTRAINT "personal_agent_job_events_owner_event_unique" UNIQUE("owner_user_id","job_id","event_id"),
	CONSTRAINT "personal_agent_job_events_sequence_check" CHECK ("personal_agent_execution_job_events"."sequence" > 0),
	CONSTRAINT "personal_agent_job_events_generation_check" CHECK ("personal_agent_execution_job_events"."execution_generation" is null or "personal_agent_execution_job_events"."execution_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "command_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "title" text DEFAULT 'Agent task' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "output_reference" jsonb;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD COLUMN "last_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_agent_conversation_participants" ADD CONSTRAINT "personal_agent_conversation_participants_conversation_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_conversations"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_conversation_participants" ADD CONSTRAINT "personal_agent_conversation_participants_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_conversations" ADD CONSTRAINT "personal_agent_conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_conversations" ADD CONSTRAINT "personal_agent_conversations_owner_execution_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_conversations" ADD CONSTRAINT "personal_agent_conversations_active_agent_fk" FOREIGN KEY ("active_agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_job_events" ADD CONSTRAINT "personal_agent_job_events_owner_job_fk" FOREIGN KEY ("job_id","owner_user_id") REFERENCES "public"."personal_agent_execution_jobs"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_agent_job_events_job_sequence_idx" ON "personal_agent_execution_job_events" USING btree ("owner_user_id","job_id","sequence" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD CONSTRAINT "personal_agent_execution_jobs_owner_conversation_idempotency_unique" UNIQUE("owner_user_id","conversation_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD CONSTRAINT "personal_agent_execution_jobs_version_check" CHECK ("personal_agent_execution_jobs"."version" > 0);
--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD CONSTRAINT "personal_agent_execution_jobs_owner_execution_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";
--> statement-breakpoint
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
        'personal_agent_identity_versions',
        'personal_agent_execution_jobs',
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
