ALTER TABLE "collaboration_pending_share_source_work" ADD COLUMN "logical_memory_id" uuid;--> statement-breakpoint
UPDATE "collaboration_pending_share_source_work"
   SET "logical_memory_id" = "local_session_id",
       "state" = CASE
         WHEN "state" IN ('pending', 'processing') THEN 'failed'
         ELSE "state"
       END,
       "redacted_failure_code" = CASE
         WHEN "state" IN ('pending', 'processing')
           THEN 'source_binding_migration_review_required'
         ELSE "redacted_failure_code"
       END,
       "locked_at" = CASE
         WHEN "state" IN ('pending', 'processing') THEN NULL
         ELSE "locked_at"
       END,
       "updated_at" = now()
 WHERE "logical_memory_id" IS NULL;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work"
  ALTER COLUMN "logical_memory_id" SET NOT NULL;
