ALTER TABLE "memory_questions" ADD COLUMN "recall_scope" jsonb;--> statement-breakpoint
CREATE INDEX "memory_questions_recall_scope_idx" ON "memory_questions" USING gin ("recall_scope");--> statement-breakpoint
CREATE INDEX "memory_questions_recall_scope_pending_idx" ON "memory_questions" USING btree ("owner_user_id","id") WHERE "memory_questions"."recall_scope" is null;