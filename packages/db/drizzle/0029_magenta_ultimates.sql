ALTER TYPE "public"."shared_memory_representation" ADD VALUE 'curated_assertions';--> statement-breakpoint
CREATE TABLE "team_memory_semantic_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"representation_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"pseudonymous_source_id" uuid NOT NULL,
	"source_item_index" integer NOT NULL,
	"encrypted_chunk_index" integer NOT NULL,
	"encrypted_chunk_item_index" integer NOT NULL,
	"item_type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"source_revision" bigint NOT NULL,
	"representation_policy_revision" integer NOT NULL,
	"content_policy_version" integer NOT NULL,
	"classifier_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_state" text DEFAULT 'pending' NOT NULL,
	"embedding_model" text,
	"embedding_dimensions" integer,
	"embedding_version" text,
	"embedding_input_hash" text,
	"embedded_at" timestamp with time zone,
	"last_error_class" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_semantic_items_position_unique" UNIQUE("representation_id","source_item_index"),
	CONSTRAINT "team_memory_semantic_items_position_check" CHECK ("team_memory_semantic_items"."source_item_index" >= 0
        and "team_memory_semantic_items"."encrypted_chunk_index" >= 0
        and "team_memory_semantic_items"."encrypted_chunk_item_index" >= 0
        and "team_memory_semantic_items"."source_revision" >= 0),
	CONSTRAINT "team_memory_semantic_items_policy_check" CHECK ("team_memory_semantic_items"."representation_policy_revision" > 0
        and "team_memory_semantic_items"."content_policy_version" > 0
        and "team_memory_semantic_items"."classifier_version" > 0),
	CONSTRAINT "team_memory_semantic_items_hash_check" CHECK (length("team_memory_semantic_items"."content_hash") = 64
        and ("team_memory_semantic_items"."embedding_input_hash" is null or length("team_memory_semantic_items"."embedding_input_hash") = 64)),
	CONSTRAINT "team_memory_semantic_items_embedding_check" CHECK ("team_memory_semantic_items"."embedding_state" in ('pending','processing','embedded','failed')
        and ("team_memory_semantic_items"."embedding_dimensions" is null or "team_memory_semantic_items"."embedding_dimensions" in (384,1024,1536,3072))
        and (
          ("team_memory_semantic_items"."embedding_state" = 'embedded'
            and "team_memory_semantic_items"."embedding_model" is not null
            and "team_memory_semantic_items"."embedding_dimensions" is not null
            and "team_memory_semantic_items"."embedding_version" is not null
            and "team_memory_semantic_items"."embedding_input_hash" is not null
            and "team_memory_semantic_items"."embedded_at" is not null)
          or ("team_memory_semantic_items"."embedding_state" <> 'embedded' and "team_memory_semantic_items"."embedded_at" is null)
        ))
);
--> statement-breakpoint
CREATE TABLE "team_memory_semantic_vectors_1024" (
	"semantic_item_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1024) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memory_semantic_vectors_1536" (
	"semantic_item_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(1536) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memory_semantic_vectors_3072" (
	"semantic_item_id" uuid PRIMARY KEY NOT NULL,
	"embedding" halfvec(3072) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_memory_semantic_vectors_384" (
	"semantic_item_id" uuid PRIMARY KEY NOT NULL,
	"embedding" vector(384) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_embeddings" DROP CONSTRAINT "memory_embeddings_one_source_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_allowed_set_check";--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" DROP CONSTRAINT "source_owner_representation_policies_allowed_set_check";--> statement-breakpoint
ALTER TABLE "team_representation_policies" DROP CONSTRAINT "team_representation_policies_allowed_set_check";--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" DROP CONSTRAINT "workspace_representation_policies_allowed_set_check";--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "curated_memory_assertion_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_nodes" ADD COLUMN "summary_embedding_revision" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "team_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "curated_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_memory_semantic_items" ADD CONSTRAINT "team_memory_semantic_items_representation_scope_fk" FOREIGN KEY ("representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_representations"("id","share_grant_id","team_id","team_workspace_id","logical_memory_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_semantic_vectors_1024" ADD CONSTRAINT "team_memory_semantic_vectors_1024_semantic_item_id_team_memory_semantic_items_id_fk" FOREIGN KEY ("semantic_item_id") REFERENCES "public"."team_memory_semantic_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_semantic_vectors_1536" ADD CONSTRAINT "team_memory_semantic_vectors_1536_semantic_item_id_team_memory_semantic_items_id_fk" FOREIGN KEY ("semantic_item_id") REFERENCES "public"."team_memory_semantic_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_semantic_vectors_3072" ADD CONSTRAINT "team_memory_semantic_vectors_3072_semantic_item_id_team_memory_semantic_items_id_fk" FOREIGN KEY ("semantic_item_id") REFERENCES "public"."team_memory_semantic_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_semantic_vectors_384" ADD CONSTRAINT "team_memory_semantic_vectors_384_semantic_item_id_team_memory_semantic_items_id_fk" FOREIGN KEY ("semantic_item_id") REFERENCES "public"."team_memory_semantic_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_memory_semantic_items_pending_idx" ON "team_memory_semantic_items" USING btree ("embedding_state","updated_at","id");--> statement-breakpoint
CREATE INDEX "team_memory_semantic_items_workspace_idx" ON "team_memory_semantic_items" USING btree ("team_workspace_id","representation_id","source_item_index");--> statement-breakpoint
CREATE INDEX "team_memory_semantic_vectors_1024_hnsw_idx" ON "team_memory_semantic_vectors_1024" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "team_memory_semantic_vectors_1536_hnsw_idx" ON "team_memory_semantic_vectors_1536" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "team_memory_semantic_vectors_3072_hnsw_idx" ON "team_memory_semantic_vectors_3072" USING hnsw ("embedding" halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "team_memory_semantic_vectors_384_hnsw_idx" ON "team_memory_semantic_vectors_384" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_curated_memory_assertion_id_curated_memory_assertions_id_fk" FOREIGN KEY ("curated_memory_assertion_id") REFERENCES "public"."curated_memory_assertions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_team_workspace_id_team_workspaces_id_fk" FOREIGN KEY ("team_workspace_id") REFERENCES "public"."team_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_embeddings_unique_active_curated_chunk" ON "memory_embeddings" USING btree ("curated_memory_assertion_id","embedding_model","embedding_dimensions","embedding_version","source_hash","source_chunk_index") WHERE "memory_embeddings"."invalidated_at" is null and "memory_embeddings"."curated_memory_assertion_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_questions_team_workspace_idx" ON "memory_questions" USING btree ("owner_user_id","team_workspace_id","created_at" DESC NULLS LAST) WHERE "memory_questions"."team_workspace_id" is not null;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_one_source_check" CHECK (num_nonnulls("memory_embeddings"."memory_node_id", "memory_embeddings"."memory_event_id", "memory_embeddings"."message_id", "memory_embeddings"."curated_memory_assertion_id") = 1);--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_allowed_set_check" CHECK (cardinality("source_owner_representation_consents"."allowed_representations") between 1 and 4
        and array_position("source_owner_representation_consents"."allowed_representations", null) is null
        and "source_owner_representation_consents"."selected_representation"::text = any("source_owner_representation_consents"."allowed_representations"::text[])
        and cardinality("source_owner_representation_consents"."allowed_representations") =
          (case when 'memory_events' = any("source_owner_representation_consents"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_leaves' = any("source_owner_representation_consents"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_rollups' = any("source_owner_representation_consents"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'curated_assertions' = any("source_owner_representation_consents"."allowed_representations"::text[]) then 1 else 0 end));--> statement-breakpoint
ALTER TABLE "source_owner_representation_policies" ADD CONSTRAINT "source_owner_representation_policies_allowed_set_check" CHECK (cardinality("source_owner_representation_policies"."allowed_representations") between 1 and 4
        and array_position("source_owner_representation_policies"."allowed_representations", null) is null
        and cardinality("source_owner_representation_policies"."allowed_representations") =
          (case when 'memory_events' = any("source_owner_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_leaves' = any("source_owner_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_rollups' = any("source_owner_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'curated_assertions' = any("source_owner_representation_policies"."allowed_representations"::text[]) then 1 else 0 end));--> statement-breakpoint
ALTER TABLE "team_representation_policies" ADD CONSTRAINT "team_representation_policies_allowed_set_check" CHECK (cardinality("team_representation_policies"."allowed_representations") between 1 and 4
        and array_position("team_representation_policies"."allowed_representations", null) is null
        and cardinality("team_representation_policies"."allowed_representations") =
          (case when 'memory_events' = any("team_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_leaves' = any("team_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_rollups' = any("team_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'curated_assertions' = any("team_representation_policies"."allowed_representations"::text[]) then 1 else 0 end));--> statement-breakpoint
ALTER TABLE "workspace_representation_policies" ADD CONSTRAINT "workspace_representation_policies_allowed_set_check" CHECK (cardinality("workspace_representation_policies"."allowed_representations") between 1 and 4
        and array_position("workspace_representation_policies"."allowed_representations", null) is null
        and cardinality("workspace_representation_policies"."allowed_representations") =
          (case when 'memory_events' = any("workspace_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_leaves' = any("workspace_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'lcm_rollups' = any("workspace_representation_policies"."allowed_representations"::text[]) then 1 else 0 end)
          + (case when 'curated_assertions' = any("workspace_representation_policies"."allowed_representations"::text[]) then 1 else 0 end));