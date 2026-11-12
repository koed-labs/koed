ALTER TABLE "workflow_token_usage_source_references" DROP CONSTRAINT "workflow_token_usage_source_references_type_check";
--> statement-breakpoint
ALTER TABLE "workflow_token_usage_source_references" ADD CONSTRAINT "workflow_token_usage_source_references_type_check" CHECK ("workflow_token_usage_source_references"."source_type" in ('question', 'answer_job', 'memory_answer_task', 'lcm_node', 'message', 'tool_event', 'memory_event'));
--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "recall_metadata" jsonb;
