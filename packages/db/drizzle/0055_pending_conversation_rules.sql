CREATE TABLE "pending_conversation_sharing_rules" (
	"pending_share_id" uuid PRIMARY KEY NOT NULL,
	"rule_id" uuid NOT NULL,
	"publisher_credential_id" uuid NOT NULL,
	"expected_grant_version" integer,
	"effective_privacy_policy_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_conversation_sharing_rules_rule_id_unique" UNIQUE("rule_id"),
	CONSTRAINT "pending_conversation_rule_version_check" CHECK ("pending_conversation_sharing_rules"."expected_grant_version" is null or "pending_conversation_sharing_rules"."expected_grant_version">0),
	CONSTRAINT "pending_conversation_rule_privacy_check" CHECK ("pending_conversation_sharing_rules"."effective_privacy_policy_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" DROP CONSTRAINT "pending_share_operations_logical_grant_unique";--> statement-breakpoint
ALTER TABLE "pending_conversation_sharing_rules" ADD CONSTRAINT "pending_conversation_sharing_rules_pending_share_id_pending_share_operations_id_fk" FOREIGN KEY ("pending_share_id") REFERENCES "public"."pending_share_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_conversation_sharing_rules" ADD CONSTRAINT "pending_conversation_sharing_rules_publisher_credential_id_device_credentials_id_fk" FOREIGN KEY ("publisher_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_share_operations_logical_grant_idx" ON "pending_share_operations" USING btree ("logical_grant_id");