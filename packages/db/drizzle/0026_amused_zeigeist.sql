ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_origin_check";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_status_check";--> statement-breakpoint
-- Alpha cutover: the retired Explorer queue and unfinished worker claims have no
-- supported runtime owner. Purge those rows and their encrypted companions
-- rather than relabelling provenance or failing later during enum conversion.
DELETE FROM "encrypted_field_payloads" AS "payload"
USING "memory_questions" AS "question"
WHERE "payload"."source_table" = 'memory_questions'
  AND "payload"."source_id" = "question"."id"
  AND (
    "question"."origin" <> 'mcp_memory_answer'
    OR "question"."status" = 'pending'
  );--> statement-breakpoint
DELETE FROM "memory_questions"
WHERE "origin" <> 'mcp_memory_answer'
   OR "status" = 'pending';--> statement-breakpoint
DROP INDEX "memory_questions_personal_pending_claim_idx";--> statement-breakpoint
ALTER TABLE "memory_questions" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "memory_questions" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;--> statement-breakpoint
DROP TYPE "public"."memory_question_status";--> statement-breakpoint
CREATE TYPE "public"."memory_question_status" AS ENUM('answered', 'error');--> statement-breakpoint
ALTER TABLE "memory_questions" ALTER COLUMN "status" SET DATA TYPE "public"."memory_question_status" USING "status"::"public"."memory_question_status";--> statement-breakpoint
ALTER TABLE "memory_questions" ALTER COLUMN "origin" SET DEFAULT 'mcp_memory_answer';--> statement-breakpoint
ALTER TABLE "memory_questions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
UPDATE "memory_questions"
SET "idempotency_key" = 'alpha-final-memory-question:' || "id"::text;--> statement-breakpoint
ALTER TABLE "memory_questions" ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_questions_owner_idempotency_key_idx" ON "memory_questions" USING btree ("owner_user_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "memory_questions" DROP COLUMN "local_memory_worker_config";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP COLUMN "processing_started_at";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP COLUMN "processing_lease_until";--> statement-breakpoint
ALTER TABLE "memory_questions" DROP COLUMN "last_error_message";--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_origin_check" CHECK ("memory_questions"."origin" = 'mcp_memory_answer');--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_status_check" CHECK (("memory_questions"."status" = 'answered' and "memory_questions"."answer_markdown" is not null and "memory_questions"."error_message" is null)
        or ("memory_questions"."status" = 'error' and "memory_questions"."error_message" is not null));
