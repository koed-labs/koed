CREATE TABLE "project_source_remove_operations" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"backend_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_freeze_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_source_remove_operations_hash_check" CHECK (length("project_source_remove_operations"."source_manifest_hash")=64),
	CONSTRAINT "project_source_remove_operations_state_check" CHECK ("project_source_remove_operations"."state" in ('preparing','freezing','cancel_requested','ready','complete','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "project_source_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"media_type" text NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"failure_reason" text,
	"note_revision_id" uuid,
	"lease_generation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_source_revisions_owner_id_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "project_source_revisions_owner_source_id_unique" UNIQUE("owner_user_id","source_id","id"),
	CONSTRAINT "project_source_revisions_source_number_unique" UNIQUE("source_id","revision"),
	CONSTRAINT "project_source_revisions_source_idempotency_unique" UNIQUE("source_id","idempotency_key_hash"),
	CONSTRAINT "project_source_revisions_hashes_check" CHECK (length("project_source_revisions"."idempotency_key_hash") = 64 and length("project_source_revisions"."content_hash") = 64),
	CONSTRAINT "project_source_revisions_size_check" CHECK ("project_source_revisions"."byte_length" >= 0 and "project_source_revisions"."byte_length" <= 26214400),
	CONSTRAINT "project_source_revisions_state_check" CHECK ("project_source_revisions"."state" in ('uploading','extracting','ready','failed')),
	CONSTRAINT "project_source_revisions_failure_check" CHECK (("project_source_revisions"."state" = 'failed' and "project_source_revisions"."failure_reason" in ('unsupported_type','too_large','no_text_layer','parse_error')) or ("project_source_revisions"."state" <> 'failed' and "project_source_revisions"."failure_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "personal_note_revisions" ADD COLUMN "forgotten_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "pending_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "project_sources" ADD COLUMN "remove_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "project_source_remove_operations" ADD CONSTRAINT "project_source_remove_operations_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_remove_operations" ADD CONSTRAINT "project_source_remove_operations_source_fk" FOREIGN KEY ("owner_user_id","source_id") REFERENCES "public"."project_sources"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_revisions" ADD CONSTRAINT "project_source_revisions_owner_source_fk" FOREIGN KEY ("owner_user_id","source_id") REFERENCES "public"."project_sources"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_source_revisions" ADD CONSTRAINT "project_source_revisions_owner_note_revision_fk" FOREIGN KEY ("note_revision_id","owner_user_id") REFERENCES "public"."personal_note_revisions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_source_remove_operations_source_idx" ON "project_source_remove_operations" USING btree ("owner_user_id","source_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "project_source_revisions_note_revision_unique" ON "project_source_revisions" USING btree ("note_revision_id") WHERE "project_source_revisions"."note_revision_id" is not null;--> statement-breakpoint
CREATE INDEX "project_source_revisions_pending_idx" ON "project_source_revisions" USING btree ("state","updated_at");--> statement-breakpoint
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_pending_revision_fk" FOREIGN KEY ("owner_user_id","id","pending_revision_id") REFERENCES "public"."project_source_revisions"("owner_user_id","source_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
        'project_source_revisions',
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
ALTER TABLE "project_sources" ADD CONSTRAINT "project_sources_remove_batch_check" CHECK ("project_sources"."remove_batch_id" is null or "project_sources"."deleted_at" is null);