CREATE TABLE "personal_agent_chat_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"recipient_kind" text NOT NULL,
	"agent_id" uuid,
	"agent_version" integer,
	"agent_name" text,
	"ordinal" integer NOT NULL,
	"launch_snapshot" jsonb NOT NULL,
	"execution_id" uuid,
	"command_id" uuid,
	"job_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"context_transfer" jsonb,
	"diff_available" boolean DEFAULT false NOT NULL,
	"claim_owner" text,
	"claim_token" text,
	"claim_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_deliveries_turn_ordinal_unique" UNIQUE("turn_id","ordinal"),
	CONSTRAINT "personal_agent_chat_deliveries_recipient_check" CHECK (("personal_agent_chat_deliveries"."recipient_kind" = 'generic' and "personal_agent_chat_deliveries"."agent_id" is null and "personal_agent_chat_deliveries"."agent_version" is null) or ("personal_agent_chat_deliveries"."recipient_kind" = 'agent' and "personal_agent_chat_deliveries"."agent_id" is not null and "personal_agent_chat_deliveries"."agent_version" > 0)),
	CONSTRAINT "personal_agent_chat_deliveries_status_check" CHECK ("personal_agent_chat_deliveries"."status" in ('queued', 'starting', 'running', 'completed', 'failed', 'uncertain', 'blocked', 'canceled', 'skipped')),
	CONSTRAINT "personal_agent_chat_deliveries_ordinal_check" CHECK ("personal_agent_chat_deliveries"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agent_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"author_agent_id" uuid,
	"author_agent_version" integer,
	"author_name" text,
	"provider" text,
	"ai_client_instance_id" text,
	"execution_id" uuid,
	"job_id" uuid,
	"truncated" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_messages_root_sequence_unique" UNIQUE("conversation_id","sequence"),
	CONSTRAINT "personal_agent_chat_messages_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "personal_agent_chat_messages_kind_check" CHECK ("personal_agent_chat_messages"."kind" in ('user', 'agent_reply')),
	CONSTRAINT "personal_agent_chat_messages_state_check" CHECK ("personal_agent_chat_messages"."state" in ('pending', 'completed', 'failed', 'uncertain', 'canceled')),
	CONSTRAINT "personal_agent_chat_messages_author_check" CHECK (("personal_agent_chat_messages"."kind" = 'user' and "personal_agent_chat_messages"."author_agent_id" is null and "personal_agent_chat_messages"."author_agent_version" is null) or ("personal_agent_chat_messages"."kind" = 'agent_reply' and (("personal_agent_chat_messages"."author_agent_id" is null and "personal_agent_chat_messages"."author_agent_version" is null) or ("personal_agent_chat_messages"."author_agent_id" is not null and "personal_agent_chat_messages"."author_agent_version" > 0))))
);
--> statement-breakpoint
CREATE TABLE "personal_agent_chat_participants" (
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"launch_snapshot" jsonb NOT NULL,
	"execution_id" uuid,
	"last_context_cursor" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_participants_pk" PRIMARY KEY("conversation_id","agent_id"),
	CONSTRAINT "personal_agent_chat_participants_ordinal_unique" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "personal_agent_chat_participants_counters_check" CHECK ("personal_agent_chat_participants"."agent_version" > 0 and "personal_agent_chat_participants"."ordinal" >= 0 and "personal_agent_chat_participants"."last_context_cursor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agent_chat_roots" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" text,
	"context_kind" text NOT NULL,
	"target_device_id" text NOT NULL,
	"title" text,
	"source_execution_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"next_sequence" integer DEFAULT 1 NOT NULL,
	"next_turn_ordinal" integer DEFAULT 1 NOT NULL,
	"active_delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_roots_owner_id_unique" UNIQUE("conversation_id","owner_user_id"),
	CONSTRAINT "personal_agent_chat_roots_context_check" CHECK (("personal_agent_chat_roots"."context_kind" = 'project' and "personal_agent_chat_roots"."project_id" is not null)
        or ("personal_agent_chat_roots"."context_kind" = 'independent' and "personal_agent_chat_roots"."project_id" is null)),
	CONSTRAINT "personal_agent_chat_roots_status_check" CHECK ("personal_agent_chat_roots"."status" in ('idle', 'queued', 'running', 'blocked', 'uncertain', 'failed', 'canceled')),
	CONSTRAINT "personal_agent_chat_roots_counters_check" CHECK ("personal_agent_chat_roots"."next_sequence" > 0 and "personal_agent_chat_roots"."next_turn_ordinal" > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agent_chat_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"user_message_id" uuid,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_chat_turns_owner_request_unique" UNIQUE("owner_user_id","request_id"),
	CONSTRAINT "personal_agent_chat_turns_root_ordinal_unique" UNIQUE("conversation_id","ordinal"),
	CONSTRAINT "personal_agent_chat_turns_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "personal_agent_chat_turns_digest_check" CHECK ("personal_agent_chat_turns"."request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "personal_agent_chat_turns_status_check" CHECK ("personal_agent_chat_turns"."status" in ('queued', 'running', 'completed', 'failed', 'uncertain', 'canceled', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "personal_agent_conversations" DROP CONSTRAINT "personal_agent_conversations_owner_execution_fk";
--> statement-breakpoint
ALTER TABLE "personal_agent_chat_deliveries" ADD CONSTRAINT "personal_agent_chat_deliveries_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_deliveries" ADD CONSTRAINT "personal_agent_chat_deliveries_turn_fk" FOREIGN KEY ("turn_id","owner_user_id") REFERENCES "public"."personal_agent_chat_turns"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_deliveries" ADD CONSTRAINT "personal_agent_chat_deliveries_message_fk" FOREIGN KEY ("message_id","owner_user_id") REFERENCES "public"."personal_agent_chat_messages"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_deliveries" ADD CONSTRAINT "personal_agent_chat_deliveries_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_messages" ADD CONSTRAINT "personal_agent_chat_messages_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_messages" ADD CONSTRAINT "personal_agent_chat_messages_turn_fk" FOREIGN KEY ("turn_id","owner_user_id") REFERENCES "public"."personal_agent_chat_turns"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_participants" ADD CONSTRAINT "personal_agent_chat_participants_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_participants" ADD CONSTRAINT "personal_agent_chat_participants_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_roots" ADD CONSTRAINT "personal_agent_chat_roots_conversation_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_conversations"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_roots" ADD CONSTRAINT "personal_agent_chat_roots_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_chat_turns" ADD CONSTRAINT "personal_agent_chat_turns_root_fk" FOREIGN KEY ("conversation_id","owner_user_id") REFERENCES "public"."personal_agent_chat_roots"("conversation_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_agent_chat_deliveries_queue_idx" ON "personal_agent_chat_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "personal_agent_chat_deliveries_root_idx" ON "personal_agent_chat_deliveries" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "personal_agent_chat_messages_root_created_idx" ON "personal_agent_chat_messages" USING btree ("conversation_id","sequence" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personal_agent_chat_roots_owner_updated_idx" ON "personal_agent_chat_roots" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
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
        'personal_agent_chat_messages',
        'personal_agent_chat_deliveries',
        'personal_agent_execution_jobs',
        'personal_agent_team_job_publications',
        'team_agent_offers',
        'team_agent_requests',
        'managed_conversation_recall_feedback',
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