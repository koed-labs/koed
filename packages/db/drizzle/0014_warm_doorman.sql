CREATE TABLE "conversation_projection_processing_outbox" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" NOT NULL,
	"work_class" text NOT NULL,
	"include_in_embedding" boolean NOT NULL,
	"include_in_lcm" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "conversation_projection_processing_outbox_owner_check" CHECK ("conversation_projection_processing_outbox"."visibility" = 'personal' and "conversation_projection_processing_outbox"."owner_user_id" is not null),
	CONSTRAINT "conversation_projection_processing_outbox_work_class_check" CHECK ("conversation_projection_processing_outbox"."work_class" in ('live_capture_projection', 'normal_embedding_lcm', 'historical_import_backfill'))
);
--> statement-breakpoint
ALTER TABLE "local_work_queue" ALTER COLUMN "priority" SET DEFAULT 10;--> statement-breakpoint
UPDATE "local_work_queue" SET "priority" = 10 WHERE "priority" = 0 AND "status" IN ('pending', 'active');--> statement-breakpoint
ALTER TABLE "conversation_projection_processing_outbox" ADD CONSTRAINT "conversation_projection_processing_outbox_event_id_memory_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."memory_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_projection_processing_outbox" ADD CONSTRAINT "conversation_projection_processing_outbox_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_projection_processing_outbox_pending_idx" ON "conversation_projection_processing_outbox" USING btree ("work_class","created_at","event_id") WHERE "conversation_projection_processing_outbox"."dispatched_at" is null;