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
