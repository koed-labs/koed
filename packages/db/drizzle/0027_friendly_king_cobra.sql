CREATE TABLE "embedding_capacity_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_key" text NOT NULL,
	"profile_key" text NOT NULL,
	"profile_version" text NOT NULL,
	"capacity_contract_revision" text NOT NULL,
	"state" text NOT NULL,
	"calibration_mode" text NOT NULL,
	"model_key" text NOT NULL,
	"model_artifact_hash" text NOT NULL,
	"embedding_dimensions" integer NOT NULL,
	"tokenizer" text NOT NULL,
	"input_transform" text NOT NULL,
	"pooling" text NOT NULL,
	"normalization" text NOT NULL,
	"runtime_kind" text NOT NULL,
	"runtime_version" text,
	"backend_class" text NOT NULL,
	"hardware_fingerprint" text NOT NULL,
	"settings_fingerprint" text NOT NULL,
	"runtime_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_measurements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tested_concurrency" integer NOT NULL,
	"sample_count" integer NOT NULL,
	"measured_token_count" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"measured_tokens_per_second" double precision NOT NULL,
	"p50_latency_ms" double precision NOT NULL,
	"p95_latency_ms" double precision NOT NULL,
	"failure_code" text,
	"calibrated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_capacity_profiles_state_check" CHECK ("embedding_capacity_profiles"."state" in ('usable','failed')),
	CONSTRAINT "embedding_capacity_profiles_mode_check" CHECK ("embedding_capacity_profiles"."calibration_mode" in ('quick','refined')),
	CONSTRAINT "embedding_capacity_profiles_backend_check" CHECK ("embedding_capacity_profiles"."backend_class" in ('cpu','metal','cuda','unknown')),
	CONSTRAINT "embedding_capacity_profiles_values_check" CHECK ("embedding_capacity_profiles"."embedding_dimensions" > 0
        and "embedding_capacity_profiles"."tested_concurrency" > 0
        and "embedding_capacity_profiles"."sample_count" > 0
        and "embedding_capacity_profiles"."measured_token_count" >= 0
        and "embedding_capacity_profiles"."duration_ms" >= 0
        and "embedding_capacity_profiles"."measured_tokens_per_second" >= 0
        and "embedding_capacity_profiles"."p50_latency_ms" >= 0
        and "embedding_capacity_profiles"."p95_latency_ms" >= 0),
	CONSTRAINT "embedding_capacity_profiles_fingerprints_check" CHECK ("embedding_capacity_profiles"."profile_key" ~ '^[0-9a-f]{64}$'
        and "embedding_capacity_profiles"."hardware_fingerprint" ~ '^[0-9a-f]{64}$'
        and "embedding_capacity_profiles"."settings_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "embedding_telemetry_minute_buckets" (
	"bucket_start" timestamp with time zone NOT NULL,
	"queue_name" text NOT NULL,
	"source_class" text NOT NULL,
	"outcome" text NOT NULL,
	"event_count" bigint DEFAULT 0 NOT NULL,
	"chunk_count" bigint DEFAULT 0 NOT NULL,
	"measured_token_count" bigint DEFAULT 0 NOT NULL,
	"queue_wait_ms_total" bigint DEFAULT 0 NOT NULL,
	"queue_wait_sample_count" bigint DEFAULT 0 NOT NULL,
	"execution_ms_total" bigint DEFAULT 0 NOT NULL,
	"execution_sample_count" bigint DEFAULT 0 NOT NULL,
	"end_to_end_ms_total" bigint DEFAULT 0 NOT NULL,
	"end_to_end_sample_count" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_telemetry_minute_buckets_bucket_start_queue_name_source_class_outcome_pk" PRIMARY KEY("bucket_start","queue_name","source_class","outcome"),
	CONSTRAINT "embedding_telemetry_minute_buckets_queue_check" CHECK ("embedding_telemetry_minute_buckets"."queue_name" in ('projection','memory-embed','lcm-embed','lcm-compact','direct')),
	CONSTRAINT "embedding_telemetry_minute_buckets_source_check" CHECK ("embedding_telemetry_minute_buckets"."source_class" in ('memory_event','memory_node','message','lcm_compaction')),
	CONSTRAINT "embedding_telemetry_minute_buckets_outcome_check" CHECK ("embedding_telemetry_minute_buckets"."outcome" in ('created','completed','skipped','retry','failed')),
	CONSTRAINT "embedding_telemetry_minute_buckets_values_check" CHECK ("embedding_telemetry_minute_buckets"."event_count" >= 0
        and "embedding_telemetry_minute_buckets"."chunk_count" >= 0
        and "embedding_telemetry_minute_buckets"."measured_token_count" >= 0
        and "embedding_telemetry_minute_buckets"."queue_wait_ms_total" >= 0
        and "embedding_telemetry_minute_buckets"."queue_wait_sample_count" >= 0
        and "embedding_telemetry_minute_buckets"."execution_ms_total" >= 0
        and "embedding_telemetry_minute_buckets"."execution_sample_count" >= 0
        and "embedding_telemetry_minute_buckets"."end_to_end_ms_total" >= 0
        and "embedding_telemetry_minute_buckets"."end_to_end_sample_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "historical_import_sources" DROP CONSTRAINT "historical_import_sources_counters_check";--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "embedding_eligible_estimated_token_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "embedded_measured_token_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "pending_embedding_estimated_token_count" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "oldest_embedded_source_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "newest_embedded_source_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN "input_token_count" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_capacity_profiles_active_key_unique" ON "embedding_capacity_profiles" USING btree ("profile_key") WHERE "embedding_capacity_profiles"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "embedding_capacity_profiles_active_model_idx" ON "embedding_capacity_profiles" USING btree ("pool_key","model_key","calibrated_at" DESC NULLS LAST) WHERE "embedding_capacity_profiles"."invalidated_at" is null and "embedding_capacity_profiles"."state" = 'usable';--> statement-breakpoint
CREATE INDEX "embedding_telemetry_minute_buckets_recent_idx" ON "embedding_telemetry_minute_buckets" USING btree ("bucket_start" DESC NULLS LAST,"queue_name","source_class","outcome");--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD CONSTRAINT "historical_import_sources_counters_check" CHECK ("historical_import_sources"."discovered_record_count" >= 0 and "historical_import_sources"."imported_record_count" >= 0 and "historical_import_sources"."skipped_record_count" >= 0 and "historical_import_sources"."malformed_record_count" >= 0 and "historical_import_sources"."raw_ingested_record_count" >= 0 and "historical_import_sources"."projected_record_count" >= 0 and "historical_import_sources"."embedding_eligible_event_count" >= 0 and "historical_import_sources"."embedded_event_count" between 0 and "historical_import_sources"."embedding_eligible_event_count" and "historical_import_sources"."embedding_eligible_estimated_token_count" >= 0 and "historical_import_sources"."embedded_measured_token_count" >= 0 and "historical_import_sources"."pending_embedding_estimated_token_count" between 0 and "historical_import_sources"."embedding_eligible_estimated_token_count" and "historical_import_sources"."lcm_eligible_event_count" >= 0 and "historical_import_sources"."lcm_completed_event_count" between 0 and "historical_import_sources"."lcm_eligible_event_count" and "historical_import_sources"."retry_count" between 0 and 1000);--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_input_token_count_check" CHECK ("memory_embeddings"."input_token_count" is null or "memory_embeddings"."input_token_count" >= 0);