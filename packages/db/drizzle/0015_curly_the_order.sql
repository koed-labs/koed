CREATE TYPE "public"."historical_import_state" AS ENUM('discovered', 'eligible', 'queued', 'importing', 'paused', 'skipped', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "historical_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"state" "historical_import_state" DEFAULT 'discovered' NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"completed_source_count" integer DEFAULT 0 NOT NULL,
	"failed_source_count" integer DEFAULT 0 NOT NULL,
	"skipped_source_count" integer DEFAULT 0 NOT NULL,
	"discovered_record_count" integer DEFAULT 0 NOT NULL,
	"imported_record_count" integer DEFAULT 0 NOT NULL,
	"skipped_record_count" integer DEFAULT 0 NOT NULL,
	"scanned_byte_count" bigint DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"next_retry_at" timestamp with time zone,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligible_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"import_started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_runs_counters_check" CHECK ("historical_import_runs"."source_count" >= 0 and "historical_import_runs"."completed_source_count" >= 0 and "historical_import_runs"."failed_source_count" >= 0 and "historical_import_runs"."skipped_source_count" >= 0 and "historical_import_runs"."discovered_record_count" >= 0 and "historical_import_runs"."imported_record_count" >= 0 and "historical_import_runs"."skipped_record_count" >= 0 and "historical_import_runs"."scanned_byte_count" >= 0 and "historical_import_runs"."retry_count" between 0 and 1000)
);
--> statement-breakpoint
CREATE TABLE "historical_import_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"state" "historical_import_state" DEFAULT 'discovered' NOT NULL,
	"ai_client" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_session_id" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"local_source_path" text NOT NULL,
	"redacted_source_label" text NOT NULL,
	"checkpoint_offset" bigint DEFAULT 0 NOT NULL,
	"checkpoint_line" integer DEFAULT 0 NOT NULL,
	"source_size_bytes" bigint,
	"source_modified_at" timestamp with time zone,
	"source_event_from" timestamp with time zone,
	"source_event_to" timestamp with time zone,
	"discovered_record_count" integer DEFAULT 0 NOT NULL,
	"imported_record_count" integer DEFAULT 0 NOT NULL,
	"skipped_record_count" integer DEFAULT 0 NOT NULL,
	"malformed_record_count" integer DEFAULT 0 NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"next_retry_at" timestamp with time zone,
	"detected_project" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eligible_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"import_started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_import_sources_fingerprint_check" CHECK ("historical_import_sources"."source_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "historical_import_sources_counters_check" CHECK ("historical_import_sources"."checkpoint_offset" >= 0 and "historical_import_sources"."checkpoint_line" >= 0 and ("historical_import_sources"."source_size_bytes" is null or "historical_import_sources"."source_size_bytes" >= 0) and "historical_import_sources"."discovered_record_count" >= 0 and "historical_import_sources"."imported_record_count" >= 0 and "historical_import_sources"."skipped_record_count" >= 0 and "historical_import_sources"."malformed_record_count" >= 0 and "historical_import_sources"."retry_count" between 0 and 1000),
	CONSTRAINT "historical_import_sources_event_range_check" CHECK ("historical_import_sources"."source_event_from" is null or "historical_import_sources"."source_event_to" is null or "historical_import_sources"."source_event_from" <= "historical_import_sources"."source_event_to")
);
--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "import_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "captured_project" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "source_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "captured_project" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "import_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "historical_import_runs" ADD CONSTRAINT "historical_import_runs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD CONSTRAINT "historical_import_sources_run_id_historical_import_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."historical_import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD CONSTRAINT "historical_import_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "historical_import_runs_owner_updated_idx" ON "historical_import_runs" USING btree ("owner_user_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_sources_identity_unique" ON "historical_import_sources" USING btree ("owner_user_id","ai_client","source_kind","source_session_id","source_fingerprint");--> statement-breakpoint
CREATE INDEX "historical_import_sources_run_state_idx" ON "historical_import_sources" USING btree ("run_id","state","updated_at");