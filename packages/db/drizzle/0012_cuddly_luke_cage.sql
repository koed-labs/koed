CREATE TYPE "public"."curated_memory_assertion_status" AS ENUM('current', 'superseded', 'conflicting', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_proposal_operation" AS ENUM('store', 'merge', 'supersede', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_proposal_status" AS ENUM('pending', 'stored', 'merged', 'superseded', 'conflicted', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_sensitivity" AS ENUM('normal', 'sensitive', 'review_required');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_source_role" AS ENUM('primary_evidence', 'supporting_evidence', 'superseding_evidence', 'conflicting_evidence', 'derived_bundle', 'derived_summary');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_source_type" AS ENUM('conversation_item', 'memory_event', 'lcm_summary');--> statement-breakpoint
CREATE TABLE "curated_memory_assertions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"topic_id" uuid,
	"assertion_text" text NOT NULL,
	"normalized_assertion" text NOT NULL,
	"status" "curated_memory_assertion_status" DEFAULT 'current' NOT NULL,
	"sensitivity" "curated_memory_sensitivity" DEFAULT 'normal' NOT NULL,
	"confidence" integer DEFAULT 80 NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_assertion_id" uuid,
	"superseded_by_assertion_id" uuid,
	"conflict_with_assertion_id" uuid,
	"created_by_model" text,
	"created_by_prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suppressed_at" timestamp with time zone,
	"suppressed_by_user_id" uuid,
	"suppression_reason" text,
	"last_reconciled_at" timestamp with time zone,
	"reconciliation_status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "curated_memory_assertions_personal_owner_check" CHECK ("curated_memory_assertions"."visibility" = 'personal' and "curated_memory_assertions"."owner_user_id" is not null),
	CONSTRAINT "curated_memory_assertions_text_not_empty_check" CHECK (length(trim("curated_memory_assertions"."assertion_text")) > 0 and length(trim("curated_memory_assertions"."normalized_assertion")) > 0),
	CONSTRAINT "curated_memory_assertions_confidence_check" CHECK ("curated_memory_assertions"."confidence" >= 0 and "curated_memory_assertions"."confidence" <= 100)
);
--> statement-breakpoint
CREATE TABLE "curated_memory_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"proposed_claim" text NOT NULL,
	"proposed_topic" text,
	"rationale" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"sensitivity_hint" "curated_memory_sensitivity",
	"expires_at_hint" timestamp with time zone,
	"evidence_conversation_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"evidence_memory_event_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"operation" "curated_memory_proposal_operation" DEFAULT 'store' NOT NULL,
	"target_assertion_id" uuid,
	"status" "curated_memory_proposal_status" DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"assertion_id" uuid,
	"worker_result" jsonb,
	"processing_started_at" timestamp with time zone,
	"processing_lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_message" text,
	"created_by_model" text,
	"created_by_prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "curated_memory_proposals_personal_owner_check" CHECK ("curated_memory_proposals"."visibility" = 'personal' and "curated_memory_proposals"."owner_user_id" is not null),
	CONSTRAINT "curated_memory_proposals_claim_not_empty_check" CHECK (length(trim("curated_memory_proposals"."proposed_claim")) > 0),
	CONSTRAINT "curated_memory_proposals_has_evidence_check" CHECK (cardinality("curated_memory_proposals"."evidence_conversation_item_ids") > 0 or cardinality("curated_memory_proposals"."evidence_memory_event_ids") > 0),
	CONSTRAINT "curated_memory_proposals_attempt_count_check" CHECK ("curated_memory_proposals"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "curated_memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assertion_id" uuid NOT NULL,
	"source_type" "curated_memory_source_type" NOT NULL,
	"source_role" "curated_memory_source_role" NOT NULL,
	"conversation_item_id" uuid,
	"memory_event_id" uuid,
	"lcm_node_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curated_memory_sources_one_source_check" CHECK (("curated_memory_sources"."source_type" = 'conversation_item' and "curated_memory_sources"."conversation_item_id" is not null and "curated_memory_sources"."memory_event_id" is null and "curated_memory_sources"."lcm_node_id" is null)
        or ("curated_memory_sources"."source_type" = 'memory_event' and "curated_memory_sources"."memory_event_id" is not null and "curated_memory_sources"."conversation_item_id" is null and "curated_memory_sources"."lcm_node_id" is null)
        or ("curated_memory_sources"."source_type" = 'lcm_summary' and "curated_memory_sources"."lcm_node_id" is not null and "curated_memory_sources"."conversation_item_id" is null and "curated_memory_sources"."memory_event_id" is null))
);
--> statement-breakpoint
CREATE TABLE "curated_memory_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"title" text NOT NULL,
	"normalized_title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curated_memory_topics_personal_owner_check" CHECK ("curated_memory_topics"."visibility" = 'personal' and "curated_memory_topics"."owner_user_id" is not null),
	CONSTRAINT "curated_memory_topics_title_not_empty_check" CHECK (length(trim("curated_memory_topics"."title")) > 0 and length(trim("curated_memory_topics"."normalized_title")) > 0)
);
--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" DROP CONSTRAINT "local_memory_agent_settings_flow_key_check";--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_topic_id_curated_memory_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."curated_memory_topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_supersedes_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("supersedes_assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_superseded_by_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("superseded_by_assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_conflict_with_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("conflict_with_assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_suppressed_by_user_id_users_id_fk" FOREIGN KEY ("suppressed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_proposals" ADD CONSTRAINT "curated_memory_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_proposals" ADD CONSTRAINT "curated_memory_proposals_target_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("target_assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_proposals" ADD CONSTRAINT "curated_memory_proposals_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_sources" ADD CONSTRAINT "curated_memory_sources_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_sources" ADD CONSTRAINT "curated_memory_sources_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_sources" ADD CONSTRAINT "curated_memory_sources_memory_event_id_memory_events_id_fk" FOREIGN KEY ("memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_sources" ADD CONSTRAINT "curated_memory_sources_lcm_node_id_memory_nodes_id_fk" FOREIGN KEY ("lcm_node_id") REFERENCES "public"."memory_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_topics" ADD CONSTRAINT "curated_memory_topics_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "curated_memory_assertions_owner_current_unique" ON "curated_memory_assertions" USING btree ("owner_user_id","normalized_assertion") WHERE "curated_memory_assertions"."visibility" = 'personal'
          and "curated_memory_assertions"."status" = 'current'
          and "curated_memory_assertions"."suppressed_at" is null
          and "curated_memory_assertions"."expires_at" is null;--> statement-breakpoint
CREATE INDEX "curated_memory_assertions_owner_topic_idx" ON "curated_memory_assertions" USING btree ("owner_user_id","topic_id","updated_at" DESC NULLS LAST) WHERE "curated_memory_assertions"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "curated_memory_assertions_owner_status_idx" ON "curated_memory_assertions" USING btree ("owner_user_id","status","updated_at" DESC NULLS LAST) WHERE "curated_memory_assertions"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "curated_memory_assertions_reconcile_idx" ON "curated_memory_assertions" USING btree ("reconciliation_status","last_reconciled_at","id") WHERE "curated_memory_assertions"."status" = 'current' and "curated_memory_assertions"."suppressed_at" is null;--> statement-breakpoint
CREATE INDEX "curated_memory_proposals_owner_status_idx" ON "curated_memory_proposals" USING btree ("owner_user_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "curated_memory_proposals_pending_idx" ON "curated_memory_proposals" USING btree ("created_at","id") WHERE "curated_memory_proposals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "curated_memory_sources_unique" ON "curated_memory_sources" USING btree ("assertion_id","source_type","source_role",coalesce("conversation_item_id"::text, ''),coalesce("memory_event_id"::text, ''),coalesce("lcm_node_id"::text, ''));--> statement-breakpoint
CREATE INDEX "curated_memory_sources_conversation_item_idx" ON "curated_memory_sources" USING btree ("conversation_item_id","assertion_id");--> statement-breakpoint
CREATE INDEX "curated_memory_sources_memory_event_idx" ON "curated_memory_sources" USING btree ("memory_event_id","assertion_id");--> statement-breakpoint
CREATE INDEX "curated_memory_sources_lcm_node_idx" ON "curated_memory_sources" USING btree ("lcm_node_id","assertion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "curated_memory_topics_owner_normalized_unique" ON "curated_memory_topics" USING btree ("owner_user_id","normalized_title");--> statement-breakpoint
CREATE INDEX "curated_memory_topics_owner_updated_idx" ON "curated_memory_topics" USING btree ("owner_user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "curated_memory_topics"."visibility" = 'personal';--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("encrypted_field_payloads"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'curated_memory_assertions',
        'curated_memory_proposals',
        'curated_memory_sources',
        'curated_memory_topics',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      ));--> statement-breakpoint
ALTER TABLE "local_memory_agent_settings" ADD CONSTRAINT "local_memory_agent_settings_flow_key_check" CHECK ("local_memory_agent_settings"."flow_key" in ('mcp_memory_answer', 'lcm_summary', 'curated_memory_review'));