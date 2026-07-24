ALTER TABLE "historical_import_sources" DROP CONSTRAINT "historical_import_sources_fingerprint_check";--> statement-breakpoint
ALTER TABLE "historical_import_sources" DROP CONSTRAINT "historical_import_sources_counters_check";--> statement-breakpoint
DROP INDEX "historical_import_sources_identity_unique";--> statement-breakpoint
ALTER TABLE "conversation_projection_processing_outbox" ADD COLUMN "source_event_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "registration_frontier_offset" bigint;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "registration_prefix_hash" text;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "historical_imported_ranges" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "live_cursor_offset" bigint;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "live_cursor_line" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "live_cursor_hash" text;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "raw_ingested_record_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "projected_record_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "embedding_eligible_event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "embedded_event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "lcm_eligible_event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD COLUMN "lcm_completed_event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "conversation_projection_processing_outbox" outbox SET "source_event_time" = event."source_event_time" FROM "memory_events" event WHERE event."id" = outbox."event_id";--> statement-breakpoint
UPDATE "historical_import_sources" SET
  "registration_frontier_offset" = coalesce("source_size_bytes", "checkpoint_offset"),
  "registration_prefix_hash" = coalesce("checkpoint_hash", "source_fingerprint"),
  "live_cursor_offset" = coalesce("source_size_bytes", "checkpoint_offset"),
  "live_cursor_line" = "checkpoint_line",
  "live_cursor_hash" = coalesce("checkpoint_hash", "source_fingerprint"),
  "raw_ingested_record_count" = "imported_record_count";--> statement-breakpoint
ALTER TABLE "historical_import_sources" ALTER COLUMN "registration_frontier_offset" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ALTER COLUMN "registration_frontier_offset" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ALTER COLUMN "registration_prefix_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ALTER COLUMN "live_cursor_offset" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "historical_import_sources" ALTER COLUMN "live_cursor_offset" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_import_sources_identity_unique" ON "historical_import_sources" USING btree ("owner_user_id","ai_client","source_kind","source_session_id");--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD CONSTRAINT "historical_import_sources_fingerprint_check" CHECK ("historical_import_sources"."source_fingerprint" ~ '^[0-9a-f]{64}$' and "historical_import_sources"."registration_prefix_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "historical_import_sources" ADD CONSTRAINT "historical_import_sources_counters_check" CHECK ("historical_import_sources"."registration_frontier_offset" >= 0 and "historical_import_sources"."checkpoint_offset" >= 0 and "historical_import_sources"."checkpoint_offset" <= "historical_import_sources"."registration_frontier_offset" and "historical_import_sources"."live_cursor_offset" >= "historical_import_sources"."registration_frontier_offset" and "historical_import_sources"."checkpoint_line" >= 0 and "historical_import_sources"."live_cursor_line" >= 0 and ("historical_import_sources"."checkpoint_hash" is null or "historical_import_sources"."checkpoint_hash" ~ '^[0-9a-f]{64}$') and ("historical_import_sources"."live_cursor_hash" is null or "historical_import_sources"."live_cursor_hash" ~ '^[0-9a-f]{64}$') and ("historical_import_sources"."source_size_bytes" is null or "historical_import_sources"."source_size_bytes" >= greatest("historical_import_sources"."registration_frontier_offset", "historical_import_sources"."live_cursor_offset")) and "historical_import_sources"."discovered_record_count" >= 0 and "historical_import_sources"."imported_record_count" >= 0 and "historical_import_sources"."skipped_record_count" >= 0 and "historical_import_sources"."malformed_record_count" >= 0 and "historical_import_sources"."raw_ingested_record_count" >= 0 and "historical_import_sources"."projected_record_count" >= 0 and "historical_import_sources"."embedding_eligible_event_count" >= 0 and "historical_import_sources"."embedded_event_count" between 0 and "historical_import_sources"."embedding_eligible_event_count" and "historical_import_sources"."lcm_eligible_event_count" >= 0 and "historical_import_sources"."lcm_completed_event_count" between 0 and "historical_import_sources"."lcm_eligible_event_count" and "historical_import_sources"."retry_count" between 0 and 1000);
