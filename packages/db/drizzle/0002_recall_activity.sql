ALTER TABLE "workflow_token_usage_source_references" DROP CONSTRAINT "workflow_token_usage_source_references_type_check";
--> statement-breakpoint
-- The replaced constraint already held for every existing row and this list only
-- widens it. NOT VALID skips a full-table scan under this migration's exclusive
-- lock; new and updated rows are still checked.
ALTER TABLE "workflow_token_usage_source_references" ADD CONSTRAINT "workflow_token_usage_source_references_type_check" CHECK ("workflow_token_usage_source_references"."source_type" in ('question', 'answer_job', 'memory_answer_task', 'lcm_node', 'message', 'tool_event', 'memory_event')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "recall_metadata" jsonb;
--> statement-breakpoint
CREATE INDEX "workflow_token_usage_recall_owner_observed_idx" ON "workflow_token_usage" USING btree ("owner_user_id","observed_at") WHERE "workflow_token_usage"."workflow_type" = 'mcp_memory_answer';
--> statement-breakpoint
CREATE TABLE "memory_answer_task_usage_receipts" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"question_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_answer_task_usage_receipts" ADD CONSTRAINT "memory_answer_usage_receipt_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "memory_answer_task_usage_receipts" ADD CONSTRAINT "memory_answer_usage_receipt_question_fk" FOREIGN KEY ("question_id") REFERENCES "public"."memory_questions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "memory_answer_usage_receipt_owner_idx" ON "memory_answer_task_usage_receipts" USING btree ("owner_user_id");
--> statement-breakpoint
INSERT INTO memory_answer_task_usage_receipts(task_id, owner_user_id, question_id)
SELECT id, owner_user_id, question_id FROM memory_answer_tasks
WHERE visibility='personal' AND team_authorization IS NULL AND team_workspace_id IS NULL
  AND attempt_count > 0;
--> statement-breakpoint
CREATE INDEX "memory_answer_usage_receipt_question_idx" ON "memory_answer_task_usage_receipts" USING btree ("question_id") WHERE "memory_answer_task_usage_receipts"."question_id" is not null;
