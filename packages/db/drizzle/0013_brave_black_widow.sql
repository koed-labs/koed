DROP INDEX "conversation_items_projection_idx";--> statement-breakpoint
DROP INDEX "local_work_queue_claim_idx";--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "projection_work_class" text DEFAULT 'live_capture_projection' NOT NULL;--> statement-breakpoint
ALTER TABLE "local_work_queue" ADD COLUMN "priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_items_projection_idx" ON "conversation_items" USING btree ("projection_status","projection_work_class","projected_at","observed_at","id");--> statement-breakpoint
CREATE INDEX "local_work_queue_claim_idx" ON "local_work_queue" USING btree ("queue_name","priority","available_at","id") WHERE "local_work_queue"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_projection_work_class_check" CHECK ("conversation_items"."projection_work_class" in ('live_capture_projection', 'historical_import_backfill'));--> statement-breakpoint
ALTER TABLE "local_work_queue" ADD CONSTRAINT "local_work_queue_priority_check" CHECK ("local_work_queue"."priority" >= 0);