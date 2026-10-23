ALTER TABLE "pending_share_operations" ADD COLUMN "reviewed_grant_version" integer;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_reviewed_grant_version_check" CHECK ("pending_share_operations"."reviewed_grant_version" is null or "pending_share_operations"."reviewed_grant_version">0);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_values_check";
--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_values_check" CHECK ("pending_share_operations"."preview_revision" > 0 and "pending_share_operations"."source_revision" >= 0
        and "pending_share_operations"."operation_version" > 0 and "pending_share_operations"."attempt_count" >= 0
        and "pending_share_operations"."authority_source" in ('browser_session','device_action_grant','sharing_rule')
        and (("pending_share_operations"."last_control_mutation_id" is null and "pending_share_operations"."last_control_action" is null)
          or ("pending_share_operations"."last_control_mutation_id" is not null and
              "pending_share_operations"."last_control_action" in ('retry','pause','resume','revoke','stop_direct')))
        and length("pending_share_operations"."request_hash") = 64 and length("pending_share_operations"."preview_hash") = 64
        and length("pending_share_operations"."source_hash") = 64);
