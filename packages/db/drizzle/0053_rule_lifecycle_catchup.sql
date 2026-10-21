ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "reconciliation_requested_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "next_reconciliation_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "reconciliation_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "reconciliation_failure_code" text;--> statement-breakpoint
CREATE INDEX "team_memory_sharing_rules_reconciliation_idx" ON "team_memory_sharing_rules" USING btree ("next_reconciliation_at","id") WHERE "team_memory_sharing_rules"."state"='active' and "team_memory_sharing_rules"."next_reconciliation_at" is not null;--> statement-breakpoint
-- Paused and stopped rules retain their state without scheduling new work.
UPDATE "team_memory_sharing_rules"
SET "reconciliation_requested_at"=NULL,"next_reconciliation_at"=NULL
WHERE "state"<>'active';--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_reconciliation_check" CHECK ("team_memory_sharing_rules"."reconciliation_attempt_count">=0
      and ("team_memory_sharing_rules"."reconciliation_failure_code" is null or "team_memory_sharing_rules"."reconciliation_failure_code" in ('source_not_ready','authority_unavailable','preparation_failed'))
      and (( "team_memory_sharing_rules"."state"<>'active' and "team_memory_sharing_rules"."reconciliation_requested_at" is null and "team_memory_sharing_rules"."next_reconciliation_at" is null and "team_memory_sharing_rules"."reconciliation_attempt_count"=0 and "team_memory_sharing_rules"."reconciliation_failure_code" is null)
        or ("team_memory_sharing_rules"."state"='active' and (
          "team_memory_sharing_rules"."next_reconciliation_at" is not null and ("team_memory_sharing_rules"."reconciliation_requested_at" is not null or ("team_memory_sharing_rules"."reconciliation_attempt_count"=0 and "team_memory_sharing_rules"."reconciliation_failure_code" is null))))));