ALTER TABLE "pull_request_review_drafts"
  ADD COLUMN "source_execution_id" uuid,
  ADD COLUMN "source_command_id" uuid,
  ADD COLUMN "source_agent_version" integer,
  ADD COLUMN "source_provider" text,
  ADD COLUMN "source_ai_client_instance_id" text,
  ADD COLUMN "source_model" text,
  ADD COLUMN "source_provider_cli_version" text,
  ADD COLUMN "source_review_revision" integer,
  ADD COLUMN "source_lease_token_digest" text,
  ADD COLUMN "source_result_digest" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_review_drafts_native_command_unique"
  ON "pull_request_review_drafts" USING btree ("review_id","source_command_id")
  WHERE "pull_request_review_drafts"."source_command_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "pull_request_review_drafts_native_execution_idx"
  ON "pull_request_review_drafts" USING btree ("owner_user_id","source_execution_id","source_command_id");
--> statement-breakpoint
ALTER TABLE "pull_request_review_drafts"
  ADD CONSTRAINT "pull_request_review_drafts_native_provenance_check" CHECK (
    ("pull_request_review_drafts"."source_command_id" IS NULL
      AND "pull_request_review_drafts"."source_execution_id" IS NULL
      AND "pull_request_review_drafts"."source_agent_version" IS NULL
      AND "pull_request_review_drafts"."source_provider" IS NULL
      AND "pull_request_review_drafts"."source_ai_client_instance_id" IS NULL
      AND "pull_request_review_drafts"."source_model" IS NULL
      AND "pull_request_review_drafts"."source_provider_cli_version" IS NULL
      AND "pull_request_review_drafts"."source_review_revision" IS NULL
      AND "pull_request_review_drafts"."source_lease_token_digest" IS NULL
      AND "pull_request_review_drafts"."source_result_digest" IS NULL)
    OR ("pull_request_review_drafts"."source_command_id" IS NOT NULL
      AND "pull_request_review_drafts"."source_execution_id" IS NOT NULL
      AND "pull_request_review_drafts"."source_agent_version" IS NOT NULL
      AND "pull_request_review_drafts"."source_agent_version" > 0
      AND "pull_request_review_drafts"."source_provider" IS NOT NULL
      AND "pull_request_review_drafts"."source_provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
      AND "pull_request_review_drafts"."source_ai_client_instance_id" IS NOT NULL
      AND "pull_request_review_drafts"."source_ai_client_instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
      AND "pull_request_review_drafts"."source_model" IS NOT NULL
      AND length(trim("pull_request_review_drafts"."source_model")) BETWEEN 1 AND 512
      AND "pull_request_review_drafts"."source_review_revision" IS NOT NULL
      AND "pull_request_review_drafts"."source_review_revision" > 0
      AND "pull_request_review_drafts"."source_lease_token_digest" IS NOT NULL
      AND "pull_request_review_drafts"."source_lease_token_digest" ~ '^[0-9a-f]{64}$'
      AND "pull_request_review_drafts"."source_result_digest" IS NOT NULL
      AND "pull_request_review_drafts"."source_result_digest" ~ '^[0-9a-f]{64}$')
  );
--> statement-breakpoint
ALTER TABLE "pull_request_operations"
  ADD COLUMN "inbox_account_id" text,
  ADD COLUMN "inbox_connection_generation" integer,
  ADD COLUMN "is_global_inbox" boolean;
--> statement-breakpoint
ALTER TABLE "pull_request_operations"
  ADD CONSTRAINT "pull_request_operations_inbox_scope_check" CHECK (
    ("pull_request_operations"."kind" = 'inbox' AND (
      ("pull_request_operations"."inbox_account_id" IS NULL
        AND "pull_request_operations"."inbox_connection_generation" IS NULL
        AND "pull_request_operations"."is_global_inbox" IS NULL)
      OR ("pull_request_operations"."inbox_account_id" IS NOT NULL
        AND "pull_request_operations"."inbox_connection_generation" IS NOT NULL
        AND "pull_request_operations"."inbox_connection_generation" > 0
        AND "pull_request_operations"."is_global_inbox" IS NOT NULL)
    )) OR ("pull_request_operations"."kind" <> 'inbox'
      AND "pull_request_operations"."inbox_account_id" IS NULL
      AND "pull_request_operations"."inbox_connection_generation" IS NULL
      AND "pull_request_operations"."is_global_inbox" IS NULL)
  );
--> statement-breakpoint
CREATE INDEX "pull_request_operations_global_inbox_completed_idx"
  ON "pull_request_operations" USING btree (
    "owner_user_id","target_device_id","target_deployment_id",
    "inbox_account_id","inbox_connection_generation","updated_at" DESC,"id" DESC
  ) WHERE "pull_request_operations"."kind" = 'inbox'
    AND "pull_request_operations"."is_global_inbox" = true
    AND "pull_request_operations"."state" = 'completed';
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_operations_global_inbox_active_unique"
  ON "pull_request_operations" USING btree (
    "owner_user_id","target_device_id","target_deployment_id",
    "inbox_account_id","inbox_connection_generation"
  ) WHERE "pull_request_operations"."kind" = 'inbox'
    AND "pull_request_operations"."is_global_inbox" = true
    AND "pull_request_operations"."state" IN ('pending','claimed');
