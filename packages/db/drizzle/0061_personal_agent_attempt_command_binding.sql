ALTER TABLE "personal_agent_execution_attempts"
  ADD COLUMN "command_id" uuid REFERENCES "managed_conversation_commands"("id") ON DELETE CASCADE;--> statement-breakpoint

CREATE UNIQUE INDEX "personal_agent_execution_attempts_command_unique"
  ON "personal_agent_execution_attempts" ("owner_user_id", "command_id")
  WHERE "command_id" IS NOT NULL;

ALTER TABLE "personal_agent_execution_jobs"
  DROP CONSTRAINT "personal_agent_execution_jobs_state_check";--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs"
  ADD CONSTRAINT "personal_agent_execution_jobs_state_check"
  CHECK ("state" IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'));
