ALTER TABLE "collaboration_pending_share_source_work" ALTER COLUMN "local_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "source_kind" "shared_memory_source_kind" DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_note_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "local_memory_event_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_note_id_collaboration_messages_id_fk" FOREIGN KEY ("local_note_id") REFERENCES "public"."collaboration_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_memory_event_id_memory_events_id_fk" FOREIGN KEY ("local_memory_event_id") REFERENCES "public"."memory_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "csm_pending_source_work_source_check" CHECK (("collaboration_pending_share_source_work"."source_kind" = 'captured_session'
          and "collaboration_pending_share_source_work"."local_session_id" is not null
          and "collaboration_pending_share_source_work"."local_note_id" is null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is null)
        or ("collaboration_pending_share_source_work"."source_kind" = 'personal_note'
          and "collaboration_pending_share_source_work"."local_session_id" is null
          and "collaboration_pending_share_source_work"."local_note_id" is not null
          and "collaboration_pending_share_source_work"."local_memory_event_id" is not null));