ALTER TABLE "pending_conversation_sharing_rules" RENAME TO "pending_sharing_rule_admissions";--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" DROP CONSTRAINT "pending_conversation_sharing_rules_rule_id_unique";--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" DROP CONSTRAINT "pending_conversation_rule_version_check";--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" DROP CONSTRAINT "pending_conversation_rule_privacy_check";--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_values_check";--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" DROP CONSTRAINT "pending_conversation_sharing_rules_pending_share_id_pending_share_operations_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" DROP CONSTRAINT "pending_conversation_sharing_rules_publisher_credential_id_device_credentials_id_fk";
--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD COLUMN "admission_kind" text DEFAULT 'conversation_create' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD COLUMN "membership_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD COLUMN "expected_authority_version" integer;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD COLUMN "expected_membership_version" integer;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD COLUMN "publisher_fence" bigint;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD COLUMN "membership_request_hash" text;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_admissions_pending_share_id_pending_share_operations_id_fk" FOREIGN KEY ("pending_share_id") REFERENCES "public"."pending_share_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_admissions_publisher_credential_id_device_credentials_id_fk" FOREIGN KEY ("publisher_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_member_fk" FOREIGN KEY ("membership_id","rule_id") REFERENCES "public"."team_memory_sharing_rule_members"("id","rule_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_sharing_rule_creation_unique" ON "pending_sharing_rule_admissions" USING btree ("rule_id") WHERE "pending_sharing_rule_admissions"."admission_kind"='conversation_create';--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_sharing_rule_admission_check" CHECK (
      ("pending_sharing_rule_admissions"."admission_kind"='conversation_create' and "pending_sharing_rule_admissions"."membership_id" is null and "pending_sharing_rule_admissions"."expected_authority_version" is null and "pending_sharing_rule_admissions"."expected_membership_version" is null and "pending_sharing_rule_admissions"."publisher_fence" is null and "pending_sharing_rule_admissions"."membership_request_hash" is null)
      or ("pending_sharing_rule_admissions"."admission_kind"='repository_member' and "pending_sharing_rule_admissions"."membership_id" is not null and "pending_sharing_rule_admissions"."expected_authority_version" is not null and "pending_sharing_rule_admissions"."expected_authority_version">0 and "pending_sharing_rule_admissions"."expected_membership_version" is not null and "pending_sharing_rule_admissions"."expected_membership_version">0 and "pending_sharing_rule_admissions"."publisher_fence" is not null and "pending_sharing_rule_admissions"."publisher_fence">0 and "pending_sharing_rule_admissions"."membership_request_hash" is not null and "pending_sharing_rule_admissions"."membership_request_hash" ~ '^[a-f0-9]{64}$')
    );--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_conversation_rule_version_check" CHECK ("pending_sharing_rule_admissions"."expected_grant_version" is null or "pending_sharing_rule_admissions"."expected_grant_version">0);--> statement-breakpoint
ALTER TABLE "pending_sharing_rule_admissions" ADD CONSTRAINT "pending_conversation_rule_privacy_check" CHECK ("pending_sharing_rule_admissions"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_values_check" CHECK ("pending_share_operations"."preview_revision" > 0 and "pending_share_operations"."source_revision" >= 0
        and "pending_share_operations"."operation_version" > 0 and "pending_share_operations"."attempt_count" >= 0
        and "pending_share_operations"."authority_source" in ('browser_session','device_action_grant','sharing_rule')
        and (("pending_share_operations"."last_control_mutation_id" is null and "pending_share_operations"."last_control_action" is null)
          or ("pending_share_operations"."last_control_mutation_id" is not null and
              "pending_share_operations"."last_control_action" in ('retry','pause','resume','revoke')))
        and length("pending_share_operations"."request_hash") = 64 and length("pending_share_operations"."preview_hash") = 64
        and length("pending_share_operations"."source_hash") = 64);