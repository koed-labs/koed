DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "shared_source_semantic_previews" LIMIT 1) THEN
		RAISE EXCEPTION 'Koed pre-release privacy manifest schema requires a disposable database reset before migration 0036';
	END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "shared_source_semantic_preview_classification_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"semantic_preview_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"first_field_index" integer NOT NULL,
	"field_count" integer NOT NULL,
	"input_identity_hash" text NOT NULL,
	"ordered_input_hash" text NOT NULL,
	"classification_result_id" uuid,
	"classification_payload_binding_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "shared_source_semantic_preview_classification_chunks_target_index_unique" UNIQUE("semantic_preview_id","chunk_index"),
	CONSTRAINT "shared_source_semantic_preview_classification_chunks_range_check" CHECK ("shared_source_semantic_preview_classification_chunks"."chunk_index" >= 0
        and "shared_source_semantic_preview_classification_chunks"."first_field_index" >= 0
        and "shared_source_semantic_preview_classification_chunks"."field_count" between 1 and 16),
	CONSTRAINT "shared_source_semantic_preview_classification_chunks_hash_check" CHECK ("shared_source_semantic_preview_classification_chunks"."input_identity_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_preview_classification_chunks"."ordered_input_hash" ~ '^[0-9a-f]{64}$'
        and ("shared_source_semantic_preview_classification_chunks"."classification_payload_binding_hash" is null
          or "shared_source_semantic_preview_classification_chunks"."classification_payload_binding_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "shared_source_semantic_preview_classification_chunks_lifecycle_check" CHECK (("shared_source_semantic_preview_classification_chunks"."status" = 'pending'
          and "shared_source_semantic_preview_classification_chunks"."classification_result_id" is null
          and "shared_source_semantic_preview_classification_chunks"."classification_payload_binding_hash" is null
          and "shared_source_semantic_preview_classification_chunks"."ready_at" is null)
        or ("shared_source_semantic_preview_classification_chunks"."status" = 'ready'
          and "shared_source_semantic_preview_classification_chunks"."classification_result_id" is not null
          and "shared_source_semantic_preview_classification_chunks"."classification_payload_binding_hash" is not null
          and "shared_source_semantic_preview_classification_chunks"."ready_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "shared_source_semantic_privacy_work_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"semantic_preview_id" uuid NOT NULL,
	"work_identity" text NOT NULL,
	"claimant_id" text NOT NULL,
	"claim_generation" integer NOT NULL,
	"claim_token" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "shared_source_semantic_privacy_work_claims_target_unique" UNIQUE("semantic_preview_id"),
	CONSTRAINT "shared_source_semantic_privacy_work_claims_hash_check" CHECK ("shared_source_semantic_privacy_work_claims"."work_identity" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "shared_source_semantic_privacy_work_claims_generation_check" CHECK ("shared_source_semantic_privacy_work_claims"."claim_generation" > 0 and length(trim("shared_source_semantic_privacy_work_claims"."claimant_id")) between 1 and 200),
	CONSTRAINT "shared_source_semantic_privacy_work_claims_lifecycle_check" CHECK (("shared_source_semantic_privacy_work_claims"."state" = 'active'
          and "shared_source_semantic_privacy_work_claims"."released_at" is null and "shared_source_semantic_privacy_work_claims"."completed_at" is null)
        or ("shared_source_semantic_privacy_work_claims"."state" = 'released'
          and "shared_source_semantic_privacy_work_claims"."released_at" is not null and "shared_source_semantic_privacy_work_claims"."completed_at" is null)
        or ("shared_source_semantic_privacy_work_claims"."state" = 'completed'
          and "shared_source_semantic_privacy_work_claims"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" DROP CONSTRAINT "shared_source_semantic_previews_hash_check";--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" DROP CONSTRAINT "shared_source_semantic_previews_lifecycle_check";--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" DROP CONSTRAINT "shared_source_semantic_previews_classification_result_id_privacy_classification_results_id_fk";
--> statement-breakpoint
DROP INDEX "shared_source_semantic_previews_pending_idx";--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "expected_manifest_hash" text;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "expected_chunk_count" integer;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "completed_chunk_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "result_manifest_hash" text;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "classification_field_count" integer;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "classification_byte_count" bigint;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "scheduling_class" text DEFAULT 'foreground' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "work_reason" text DEFAULT 'share_activation' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "eligible_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "enqueued_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD COLUMN "continuation_chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_preview_classification_chunks" ADD CONSTRAINT "shared_source_semantic_preview_classification_chunks_semantic_preview_id_shared_source_semantic_previews_id_fk" FOREIGN KEY ("semantic_preview_id") REFERENCES "public"."shared_source_semantic_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_preview_classification_chunks" ADD CONSTRAINT "shared_source_semantic_preview_classification_chunks_classification_result_id_privacy_classification_results_id_fk" FOREIGN KEY ("classification_result_id") REFERENCES "public"."privacy_classification_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_source_semantic_privacy_work_claims" ADD CONSTRAINT "shared_source_semantic_privacy_work_claims_semantic_preview_id_shared_source_semantic_previews_id_fk" FOREIGN KEY ("semantic_preview_id") REFERENCES "public"."shared_source_semantic_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_source_semantic_preview_classification_chunks_pending_idx" ON "shared_source_semantic_preview_classification_chunks" USING btree ("semantic_preview_id","status","chunk_index");--> statement-breakpoint
CREATE INDEX "shared_source_semantic_preview_classification_chunks_result_idx" ON "shared_source_semantic_preview_classification_chunks" USING btree ("classification_result_id");--> statement-breakpoint
CREATE INDEX "shared_source_semantic_privacy_work_claims_active_idx" ON "shared_source_semantic_privacy_work_claims" USING btree ("state","expires_at") WHERE "shared_source_semantic_privacy_work_claims"."state" = 'active';--> statement-breakpoint
CREATE INDEX "shared_source_semantic_previews_pending_idx" ON "shared_source_semantic_previews" USING btree ("status","scheduling_class","eligible_at","next_attempt_at","id");--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" DROP COLUMN "classification_result_id";--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" DROP COLUMN "classification_payload_binding_hash";--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_work_check" CHECK ("shared_source_semantic_previews"."scheduling_class" in ('foreground','background')
        and "shared_source_semantic_previews"."work_reason" in ('share_activation','source_revision_classification','policy_remasking','classifier_rematerialization','background_repair')
        and "shared_source_semantic_previews"."continuation_chunk_index" >= 0
        and "shared_source_semantic_previews"."completed_chunk_count" >= 0
        and ("shared_source_semantic_previews"."expected_chunk_count" is null or "shared_source_semantic_previews"."expected_chunk_count" > 0)
        and ("shared_source_semantic_previews"."classification_field_count" is null or "shared_source_semantic_previews"."classification_field_count" > 0)
        and ("shared_source_semantic_previews"."classification_byte_count" is null or "shared_source_semantic_previews"."classification_byte_count" >= 0)
        and ("shared_source_semantic_previews"."expected_chunk_count" is null or "shared_source_semantic_previews"."completed_chunk_count" <= "shared_source_semantic_previews"."expected_chunk_count"));--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_hash_check" CHECK ("shared_source_semantic_previews"."source_preview_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."source_artifact_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."source_manifest_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."source_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."classifier_hash" ~ '^[0-9a-f]{64}$'
        and "shared_source_semantic_previews"."effective_privacy_policy_hash" ~ '^[0-9a-f]{64}$'
        and ("shared_source_semantic_previews"."expected_manifest_hash" is null
          or "shared_source_semantic_previews"."expected_manifest_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."result_manifest_hash" is null
          or "shared_source_semantic_previews"."result_manifest_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."source_item_identity_hash" is null
          or "shared_source_semantic_previews"."source_item_identity_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."sanitized_content_hash" is null
          or "shared_source_semantic_previews"."sanitized_content_hash" ~ '^[0-9a-f]{64}$')
        and ("shared_source_semantic_previews"."payload_binding_hash" is null
          or "shared_source_semantic_previews"."payload_binding_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "shared_source_semantic_previews" ADD CONSTRAINT "shared_source_semantic_previews_lifecycle_check" CHECK ((
          "shared_source_semantic_previews"."status" = 'pending'
          and "shared_source_semantic_previews"."result_manifest_hash" is null
          and "shared_source_semantic_previews"."sanitized_content_hash" is null
          and "shared_source_semantic_previews"."payload_binding_hash" is null
          and "shared_source_semantic_previews"."failure_code" is null
          and "shared_source_semantic_previews"."ready_at" is null
          and "shared_source_semantic_previews"."failed_at" is null
          and "shared_source_semantic_previews"."stale_at" is null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and "shared_source_semantic_previews"."invalidation_reason_code" is null
        ) or (
          "shared_source_semantic_previews"."status" = 'ready'
          and "shared_source_semantic_previews"."expected_manifest_hash" is not null
          and "shared_source_semantic_previews"."expected_chunk_count" is not null
          and "shared_source_semantic_previews"."completed_chunk_count" = "shared_source_semantic_previews"."expected_chunk_count"
          and "shared_source_semantic_previews"."result_manifest_hash" is not null
          and "shared_source_semantic_previews"."classification_field_count" is not null
          and "shared_source_semantic_previews"."classification_byte_count" is not null
          and "shared_source_semantic_previews"."source_item_identity_hash" is not null
          and "shared_source_semantic_previews"."source_item_count" is not null
          and "shared_source_semantic_previews"."sanitized_content_hash" is not null
          and "shared_source_semantic_previews"."payload_binding_hash" is not null
          and "shared_source_semantic_previews"."failure_code" is null
          and "shared_source_semantic_previews"."ready_at" is not null
          and "shared_source_semantic_previews"."failed_at" is null
          and "shared_source_semantic_previews"."stale_at" is null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and "shared_source_semantic_previews"."invalidation_reason_code" is null
        ) or (
          "shared_source_semantic_previews"."status" = 'failed'
          and "shared_source_semantic_previews"."result_manifest_hash" is null
          and "shared_source_semantic_previews"."source_item_identity_hash" is not null
          and "shared_source_semantic_previews"."source_item_count" is not null
          and "shared_source_semantic_previews"."sanitized_content_hash" is null
          and "shared_source_semantic_previews"."payload_binding_hash" is null
          and length(trim("shared_source_semantic_previews"."failure_code")) > 0
          and "shared_source_semantic_previews"."ready_at" is null
          and "shared_source_semantic_previews"."failed_at" is not null
          and "shared_source_semantic_previews"."stale_at" is null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and "shared_source_semantic_previews"."invalidation_reason_code" is null
        ) or (
          "shared_source_semantic_previews"."status" = 'stale'
          and "shared_source_semantic_previews"."expected_manifest_hash" is not null
          and "shared_source_semantic_previews"."result_manifest_hash" is not null
          and "shared_source_semantic_previews"."source_item_identity_hash" is not null
          and "shared_source_semantic_previews"."source_item_count" is not null
          and "shared_source_semantic_previews"."sanitized_content_hash" is not null
          and "shared_source_semantic_previews"."payload_binding_hash" is not null
          and "shared_source_semantic_previews"."failure_code" is null
          and "shared_source_semantic_previews"."ready_at" is not null
          and "shared_source_semantic_previews"."failed_at" is null
          and "shared_source_semantic_previews"."stale_at" is not null
          and "shared_source_semantic_previews"."invalidated_at" is null
          and length(trim("shared_source_semantic_previews"."invalidation_reason_code")) > 0
        ) or (
          "shared_source_semantic_previews"."status" = 'invalidated'
          and "shared_source_semantic_previews"."invalidated_at" is not null
          and length(trim("shared_source_semantic_previews"."invalidation_reason_code")) > 0
        ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "koed_assert_workflow_source_revision_binding"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_source_revision bigint;
  workflow_row_exists boolean;
BEGIN
  EXECUTE format(
    'select exists(select 1 from %I where id=$1)',
    TG_TABLE_NAME
  ) INTO workflow_row_exists USING NEW.id;
  IF NOT workflow_row_exists THEN
    RETURN NULL;
  END IF;

  SELECT binding.source_revision INTO bound_source_revision
    FROM logical_memory_source_revision_bindings binding
   WHERE binding.source_revision_id = NEW.source_revision_id
     AND binding.logical_memory_id = NEW.logical_memory_id;
  IF NOT FOUND OR bound_source_revision IS DISTINCT FROM NEW.source_revision THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'workflow_source_revision_binding_check',
      MESSAGE = 'Workflow source revision must match its immutable source binding';
  END IF;

  IF TG_TABLE_NAME = 'pending_share_operations' THEN
    IF NEW.replacement_source_revision_id IS NOT NULL THEN
      SELECT binding.source_revision INTO bound_source_revision
        FROM logical_memory_source_revision_bindings binding
       WHERE binding.source_revision_id = NEW.replacement_source_revision_id
         AND binding.logical_memory_id = NEW.logical_memory_id;
      IF NOT FOUND OR bound_source_revision IS DISTINCT FROM NEW.replacement_source_revision THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'workflow_replacement_source_revision_binding_check',
          MESSAGE = 'Replacement source revision must match its immutable source binding';
      END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
