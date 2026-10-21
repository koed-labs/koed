CREATE TABLE "collaboration_sharing_rule_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"intent_hash" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"failure_code" text,
	"protected_dto" jsonb,
	"protected_dto_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_rule_delivery_mutation_unique" UNIQUE("enrollment_id","mutation_id"),
	CONSTRAINT "csm_rule_delivery_state_check" CHECK ("collaboration_sharing_rule_deliveries"."state" in ('queued','acknowledged','needs_review') and "collaboration_sharing_rule_deliveries"."attempt_count">=0 and "collaboration_sharing_rule_deliveries"."lease_version">=0),
	CONSTRAINT "csm_rule_delivery_failure_check" CHECK ("collaboration_sharing_rule_deliveries"."failure_code" is null or "collaboration_sharing_rule_deliveries"."failure_code" in ('offline','remote_unavailable','authority_unavailable','conflict','response_invalid')),
	CONSTRAINT "csm_rule_delivery_payload_check" CHECK (length("collaboration_sharing_rule_deliveries"."intent_hash")=64 and (("collaboration_sharing_rule_deliveries"."protected_dto" is not null and "collaboration_sharing_rule_deliveries"."protected_dto_hash" is not null and length("collaboration_sharing_rule_deliveries"."protected_dto_hash")=64) or ("collaboration_sharing_rule_deliveries"."state"='needs_review' and "collaboration_sharing_rule_deliveries"."protected_dto" is null and "collaboration_sharing_rule_deliveries"."protected_dto_hash" is null)))
);
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD CONSTRAINT "collaboration_sharing_rule_deliveries_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "csm_rule_delivery_pending_rule_unique" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","rule_id") WHERE "collaboration_sharing_rule_deliveries"."state"='queued';--> statement-breakpoint
CREATE INDEX "csm_rule_delivery_claim_idx" ON "collaboration_sharing_rule_deliveries" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE INDEX "csm_rule_delivery_owner_grant_idx" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","share_grant_id","created_at" DESC NULLS LAST);