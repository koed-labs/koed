CREATE TABLE "team_memory_workspace_exclusion_mutations" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"exclusion_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_version" integer NOT NULL,
	"result_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_workspace_exclusion_mutation_version_unique" UNIQUE("exclusion_id","result_version"),
	CONSTRAINT "team_memory_workspace_exclusion_mutation_operation_check" CHECK ("team_memory_workspace_exclusion_mutations"."operation" in ('exclude','restore')),
	CONSTRAINT "team_memory_workspace_exclusion_mutation_binding_check" CHECK ("team_memory_workspace_exclusion_mutations"."result_version">0 and "team_memory_workspace_exclusion_mutations"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_memory_workspace_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'excluded' NOT NULL,
	"excluded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_workspace_exclusion_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "team_memory_workspace_exclusion_scope_unique" UNIQUE("owner_user_id","logical_memory_id","team_workspace_id"),
	CONSTRAINT "team_memory_workspace_exclusion_state_check" CHECK ("team_memory_workspace_exclusions"."state" in ('excluded','restored') and ("team_memory_workspace_exclusions"."state"='excluded')=("team_memory_workspace_exclusions"."restored_at" is null)),
	CONSTRAINT "team_memory_workspace_exclusion_version_check" CHECK ("team_memory_workspace_exclusions"."version">0)
);
--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" DROP CONSTRAINT "csm_rule_delivery_destination_check";--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ALTER COLUMN "rule_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD COLUMN "source_logical_memory_id" uuid;--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD COLUMN "team_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "team_memory_workspace_exclusion_mutations" ADD CONSTRAINT "team_memory_workspace_exclusion_mutation_owner_fk" FOREIGN KEY ("exclusion_id","owner_user_id") REFERENCES "public"."team_memory_workspace_exclusions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_workspace_exclusions" ADD CONSTRAINT "team_memory_workspace_exclusion_owned_source_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memory_workspace_exclusions" ADD CONSTRAINT "team_memory_workspace_exclusion_destination_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "csm_owner_delivery_pending_exclusion_unique" ON "collaboration_sharing_rule_deliveries" USING btree ("enrollment_id","source_logical_memory_id","team_workspace_id") WHERE "collaboration_sharing_rule_deliveries"."state"='queued' and "collaboration_sharing_rule_deliveries"."operation_kind" in ('workspace_exclude','workspace_restore');--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD CONSTRAINT "csm_owner_delivery_target_check" CHECK ((
      "collaboration_sharing_rule_deliveries"."operation_kind" in ('workspace_exclude','workspace_restore') and "collaboration_sharing_rule_deliveries"."rule_id" is null
        and "collaboration_sharing_rule_deliveries"."source_logical_memory_id" is not null and "collaboration_sharing_rule_deliveries"."team_workspace_id" is not null
    ) or (
      "collaboration_sharing_rule_deliveries"."operation_kind" not in ('workspace_exclude','workspace_restore') and "collaboration_sharing_rule_deliveries"."rule_id" is not null
        and "collaboration_sharing_rule_deliveries"."source_logical_memory_id" is null and "collaboration_sharing_rule_deliveries"."team_workspace_id" is null
    ));--> statement-breakpoint
ALTER TABLE "collaboration_sharing_rule_deliveries" ADD CONSTRAINT "csm_rule_delivery_destination_check" CHECK (("collaboration_sharing_rule_deliveries"."operation_kind"='control' and "collaboration_sharing_rule_deliveries"."share_grant_id" is not null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind"='conversation_create' and "collaboration_sharing_rule_deliveries"."share_grant_id" is null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is not null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind" in ('repository_create','repository_control','detail','content_policy') and "collaboration_sharing_rule_deliveries"."share_grant_id" is null and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null)
        or ("collaboration_sharing_rule_deliveries"."operation_kind" in ('workspace_exclude','workspace_restore') and "collaboration_sharing_rule_deliveries"."logical_grant_id" is null));