ALTER TYPE "public"."memory_question_status" ADD VALUE 'pending' BEFORE 'answered';--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_origin_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_status_check";--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "ask_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "ask_turn_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_questions_owner_ask_turn_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","ask_turn_index") WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
CREATE INDEX "memory_questions_owner_ask_recent_idx" ON "memory_questions" USING btree ("owner_user_id","ask_thread_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "memory_questions"."origin" = 'desktop_ask';--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_ask_identity_check" CHECK (("memory_questions"."origin" = 'mcp_memory_answer' and "memory_questions"."ask_thread_id" is null and "memory_questions"."ask_turn_index" is null)
        or ("memory_questions"."origin" = 'desktop_ask' and "memory_questions"."ask_thread_id" is not null and "memory_questions"."ask_turn_index" >= 0 and "memory_questions"."team_workspace_id" is null and "memory_questions"."search_domain" = 'global'));--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_origin_check" CHECK ("memory_questions"."origin" in ('mcp_memory_answer', 'desktop_ask'));--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_status_check" CHECK (("memory_questions"."status" = 'pending' and "memory_questions"."answer_markdown" is null and "memory_questions"."error_message" is null and "memory_questions"."answered_at" is null)
        or ("memory_questions"."status" = 'answered' and "memory_questions"."answer_markdown" is not null and "memory_questions"."error_message" is null and "memory_questions"."answered_at" is not null)
        or ("memory_questions"."status" = 'error' and "memory_questions"."answer_markdown" is null and "memory_questions"."error_message" is not null and "memory_questions"."answered_at" is not null));