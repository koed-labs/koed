ALTER TABLE "collaboration_sharing_rule_deliveries" ADD CONSTRAINT "csm_rule_delivery_progress_scope_unique" UNIQUE("id","enrollment_id","rule_id");
--> statement-breakpoint
CREATE TABLE "collaboration_sharing_selection_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"progress_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"protected_dto" jsonb NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_selection_pages_generation_unique" UNIQUE("progress_id","generation","page_number"),
	CONSTRAINT "csm_selection_pages_payload_check" CHECK ("collaboration_sharing_selection_pages"."page_number">=0 and "collaboration_sharing_selection_pages"."protected_dto_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "collaboration_sharing_selection_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"creation_delivery_id" uuid NOT NULL,
	"delivery_epoch" integer DEFAULT 0 NOT NULL,
	"current_generation" uuid,
	"proposal_generation" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"source_work_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"protected_dto" jsonb,
	"protected_dto_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_selection_progress_rule_unique" UNIQUE("enrollment_id","rule_id"),
	CONSTRAINT "csm_selection_progress_state_check" CHECK ("collaboration_sharing_selection_progress"."state" in ('active','stopped','revoked','needs_attention') and "collaboration_sharing_selection_progress"."lease_version">=0 and "collaboration_sharing_selection_progress"."attempt_count">=0 and "collaboration_sharing_selection_progress"."delivery_epoch">=0),
	CONSTRAINT "csm_selection_progress_payload_check" CHECK (("collaboration_sharing_selection_progress"."protected_dto" is not null and "collaboration_sharing_selection_progress"."protected_dto_hash" is not null and "collaboration_sharing_selection_progress"."protected_dto_hash" ~ '^[a-f0-9]{64}$') or ("collaboration_sharing_selection_progress"."state"='revoked' and "collaboration_sharing_selection_progress"."protected_dto" is null and "collaboration_sharing_selection_progress"."protected_dto_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "collaboration_sharing_selection_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"progress_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"current_generation" uuid,
	"current_goal_hash" text,
	"proposed_generation" uuid,
	"proposed_goal_hash" text,
	"done_goal_hash" text,
	"done_delivery_epoch" integer,
	"attempt_mutation_id" uuid,
	"lease_version" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"protected_dto" jsonb NOT NULL,
	"protected_dto_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_selection_sources_key_unique" UNIQUE("progress_id","source_key"),
	CONSTRAINT "csm_selection_sources_payload_check" CHECK ("collaboration_sharing_selection_sources"."source_key" ~ '^[a-f0-9]{64}$' and "collaboration_sharing_selection_sources"."protected_dto_hash" ~ '^[a-f0-9]{64}$' and "collaboration_sharing_selection_sources"."lease_version">=0 and "collaboration_sharing_selection_sources"."attempt_count">=0
    and (("collaboration_sharing_selection_sources"."current_generation" is null and "collaboration_sharing_selection_sources"."current_goal_hash" is null) or ("collaboration_sharing_selection_sources"."current_generation" is not null and "collaboration_sharing_selection_sources"."current_goal_hash" is not null and "collaboration_sharing_selection_sources"."current_goal_hash" ~ '^[a-f0-9]{64}$'))
    and (("collaboration_sharing_selection_sources"."proposed_generation" is null and "collaboration_sharing_selection_sources"."proposed_goal_hash" is null) or ("collaboration_sharing_selection_sources"."proposed_generation" is not null and "collaboration_sharing_selection_sources"."proposed_goal_hash" is not null and "collaboration_sharing_selection_sources"."proposed_goal_hash" ~ '^[a-f0-9]{64}$'))
    and ("collaboration_sharing_selection_sources"."done_goal_hash" is null or "collaboration_sharing_selection_sources"."done_goal_hash" ~ '^[a-f0-9]{64}$') and ("collaboration_sharing_selection_sources"."done_delivery_epoch" is null or "collaboration_sharing_selection_sources"."done_delivery_epoch">=0))
);
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" DROP CONSTRAINT "csm_rule_delivery_destination_check";--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_pages" ADD CONSTRAINT "collaboration_sharing_selection_pages_progress_id_collaboration_sharing_selection_progress_id_fk" FOREIGN KEY ("progress_id") REFERENCES "public"."collaboration_sharing_selection_progress"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_progress" ADD CONSTRAINT "collaboration_sharing_selection_progress_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_progress" ADD CONSTRAINT "csm_selection_progress_creation_fk" FOREIGN KEY ("creation_delivery_id","enrollment_id","rule_id") REFERENCES "public"."collaboration_sharing_rule_deliveries"("id","enrollment_id","rule_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_sharing_selection_sources" ADD CONSTRAINT "collaboration_sharing_selection_sources_progress_id_collaboration_sharing_selection_progress_id_fk" FOREIGN KEY ("progress_id") REFERENCES "public"."collaboration_sharing_selection_progress"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csm_selection_progress_work_idx" ON "collaboration_sharing_selection_progress" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE INDEX "csm_selection_sources_work_idx" ON "collaboration_sharing_selection_sources" USING btree ("available_at","id");--> statement-breakpoint
CREATE INDEX "csm_selection_sources_generation_idx" ON "collaboration_sharing_selection_sources" USING btree ("progress_id","proposed_generation","id");--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD CONSTRAINT "csm_rule_delivery_destination_check" CHECK (("collaboration_sharing_rule_deliveries"."operation_kind"='control' and "collaboration_sharing_rule_deliveries"."share_grant_id" is not null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind"='conversation_create' and "collaboration_sharing_rule_deliveries"."share_grant_id" is null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is not null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind" in ('repository_create','repository_control') and "collaboration_sharing_rule_deliveries"."share_grant_id" is null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null));