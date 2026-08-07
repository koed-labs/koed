ALTER TABLE "conversation_source_download_authorizations" ADD COLUMN "initiating_operation_kind" text;--> statement-breakpoint
ALTER TABLE "conversation_source_download_authorizations" ADD COLUMN "initiating_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_source_download_authorizations" ADD CONSTRAINT "conversation_source_download_initiating_operation_check" CHECK ((("conversation_source_download_authorizations"."initiating_operation_kind" is null and "conversation_source_download_authorizations"."initiating_operation_id" is null)
        or ("conversation_source_download_authorizations"."initiating_operation_kind" in ('handoff', 'fork')
          and "conversation_source_download_authorizations"."initiating_operation_id" is not null)));