CREATE TABLE "team_memory_sharing_rule_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"state" text DEFAULT 'present' NOT NULL,
	"membership_version" integer DEFAULT 1 NOT NULL,
	"selection_snapshot_version" uuid,
	"source_context_hash" text,
	"git_context_version" integer,
	"folder_context_version" integer,
	"last_mutation_id" uuid NOT NULL,
	"reconciliation_requested_at" timestamp with time zone DEFAULT now(),
	"next_reconciliation_at" timestamp with time zone DEFAULT now(),
	"reconciliation_attempt_count" integer DEFAULT 0 NOT NULL,
	"reconciliation_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_rule_members_source_unique" UNIQUE("rule_id","logical_memory_id"),
	CONSTRAINT "team_memory_rule_members_rule_unique" UNIQUE("id","rule_id"),
	CONSTRAINT "team_memory_rule_members_state_check" CHECK ("team_memory_sharing_rule_members"."state" in ('present','removed','revoked','unresolved')),
	CONSTRAINT "team_memory_rule_members_version_check" CHECK ("team_memory_sharing_rule_members"."membership_version">0
      and ("team_memory_sharing_rule_members"."git_context_version" is null or "team_memory_sharing_rule_members"."git_context_version">0)
      and ("team_memory_sharing_rule_members"."folder_context_version" is null or "team_memory_sharing_rule_members"."folder_context_version">0)
      and ("team_memory_sharing_rule_members"."source_context_hash" is null or "team_memory_sharing_rule_members"."source_context_hash" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "team_memory_rule_members_reconciliation_check" CHECK ("team_memory_sharing_rule_members"."reconciliation_attempt_count">=0
      and ("team_memory_sharing_rule_members"."reconciliation_failure_code" is null or "team_memory_sharing_rule_members"."reconciliation_failure_code" in ('source_not_ready','authority_unavailable','preparation_failed'))
      and ("team_memory_sharing_rule_members"."state"='present' or ("team_memory_sharing_rule_members"."reconciliation_requested_at" is null and "team_memory_sharing_rule_members"."next_reconciliation_at" is null
        and "team_memory_sharing_rule_members"."reconciliation_attempt_count"=0 and "team_memory_sharing_rule_members"."reconciliation_failure_code" is null)))
);
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" DROP CONSTRAINT "team_memory_sharing_rules_scope_unique";--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" DROP CONSTRAINT "team_memory_share_reasons_kind_check";--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" DROP CONSTRAINT "team_memory_sharing_rules_reconciliation_check";--> statement-breakpoint
DROP INDEX "team_memory_sharing_rules_reconciliation_idx";--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ALTER COLUMN "logical_memory_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "selector_kind" text DEFAULT 'captured_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "selector_binding_hash" text;--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD COLUMN "selector_payload" jsonb;--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_owner_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rule_members" ADD CONSTRAINT "team_memory_rule_members_rule_owner_fk" FOREIGN KEY ("rule_id","owner_user_id") REFERENCES "public"."team_memory_sharing_rules"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rule_members" ADD CONSTRAINT "team_memory_rule_members_source_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_memory_rule_members_reconciliation_idx" ON "team_memory_sharing_rule_members" USING btree ("next_reconciliation_at","id") WHERE "team_memory_sharing_rule_members"."state"='present' and "team_memory_sharing_rule_members"."next_reconciliation_at" is not null;--> statement-breakpoint
CREATE INDEX "team_memory_rule_members_active_idx" ON "team_memory_sharing_rule_members" USING btree ("rule_id","id") WHERE "team_memory_sharing_rule_members"."state"='present';--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_membership_fk" FOREIGN KEY ("membership_id","rule_id") REFERENCES "public"."team_memory_sharing_rule_members"("id","rule_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Existing Conversation rules retain their exact source, consent and durable
-- source-work deadline. This changes storage, not publication authority.
INSERT INTO team_memory_sharing_rule_members
  (rule_id,owner_user_id,logical_memory_id,state,last_mutation_id,
   reconciliation_requested_at,next_reconciliation_at,
   reconciliation_attempt_count,reconciliation_failure_code)
SELECT id,owner_user_id,logical_memory_id,
       CASE WHEN state='stopped' THEN 'revoked' ELSE 'present' END,creation_mutation_id,
       reconciliation_requested_at,next_reconciliation_at,
       reconciliation_attempt_count,reconciliation_failure_code
  FROM team_memory_sharing_rules;
--> statement-breakpoint
UPDATE team_memory_share_reasons reason
   SET membership_id=member.id
  FROM team_memory_sharing_rule_members member,team_memory_share_grants grant_row
 WHERE reason.kind='rule' AND reason.rule_id=member.rule_id
   AND reason.share_grant_id=grant_row.id
   AND member.logical_memory_id=grant_row.logical_memory_id
   AND member.owner_user_id=grant_row.owner_user_id;
--> statement-breakpoint
ALTER TABLE "team_memory_share_reasons" ADD CONSTRAINT "team_memory_share_reasons_kind_check" CHECK (("team_memory_share_reasons"."kind"='direct' and "team_memory_share_reasons"."rule_id" is null and "team_memory_share_reasons"."membership_id" is null)
        or ("team_memory_share_reasons"."kind"='rule' and "team_memory_share_reasons"."rule_id" is not null and "team_memory_share_reasons"."membership_id" is not null));--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" ADD CONSTRAINT "team_memory_sharing_rules_selector_check" CHECK (
      ("team_memory_sharing_rules"."selector_kind"='captured_session' and "team_memory_sharing_rules"."logical_memory_id" is not null
        and "team_memory_sharing_rules"."selector_binding_hash" is null and "team_memory_sharing_rules"."selector_payload" is null)
      or ("team_memory_sharing_rules"."selector_kind"='repository' and "team_memory_sharing_rules"."logical_memory_id" is null
        and "team_memory_sharing_rules"."selector_binding_hash" is not null and "team_memory_sharing_rules"."selector_binding_hash" ~ '^[a-f0-9]{64}$' and "team_memory_sharing_rules"."selector_payload" is not null)
    );
--> statement-breakpoint
ALTER TABLE "team_memory_sharing_rules" DROP COLUMN "reconciliation_requested_at";--> statement-breakpoint

ALTER TABLE "team_memory_sharing_rules" DROP COLUMN "next_reconciliation_at";--> statement-breakpoint

ALTER TABLE "team_memory_sharing_rules" DROP COLUMN "reconciliation_attempt_count";--> statement-breakpoint

ALTER TABLE "team_memory_sharing_rules" DROP COLUMN "reconciliation_failure_code";--> statement-breakpoint

