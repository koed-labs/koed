CREATE TABLE "team_leave_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"device_credential_id" uuid NOT NULL,
	"device_credential_version" integer NOT NULL,
	"upstream_backend_id" text NOT NULL,
	"backend_origin_hash" text NOT NULL,
	"action_grant_id" uuid NOT NULL,
	"continuation_commitment" text NOT NULL,
	"expected_team_version" integer NOT NULL,
	"expected_membership_version" integer NOT NULL,
	"owned_projects" jsonb NOT NULL,
	"owned_set_hash" text NOT NULL,
	"copy_manifest_hash" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"completed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"canceled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_leave_operations_action_grant_unique" UNIQUE("action_grant_id"),
	CONSTRAINT "team_leave_operations_continuation_unique" UNIQUE("continuation_commitment"),
	CONSTRAINT "team_leave_operations_versions_check" CHECK ("team_leave_operations"."expected_team_version" > 0 and "team_leave_operations"."expected_membership_version" > 0 and "team_leave_operations"."device_credential_version" > 0),
	CONSTRAINT "team_leave_operations_hash_check" CHECK ("team_leave_operations"."owned_set_hash" ~ '^[0-9a-f]{64}$'
        and "team_leave_operations"."copy_manifest_hash" ~ '^[0-9a-f]{64}$'
        and "team_leave_operations"."continuation_commitment" ~ '^[0-9a-f]{64}$'
        and "team_leave_operations"."backend_origin_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "team_leave_operations_state_check" CHECK (("team_leave_operations"."state" = 'prepared' and "team_leave_operations"."completed_at" is null and "team_leave_operations"."canceled_at" is null and "team_leave_operations"."canceled_reason" is null)
        or ("team_leave_operations"."state" = 'finished' and "team_leave_operations"."completed_at" is not null and "team_leave_operations"."canceled_at" is null and "team_leave_operations"."canceled_reason" is null)
        or ("team_leave_operations"."state" = 'canceled' and "team_leave_operations"."completed_at" is null and "team_leave_operations"."canceled_at" is not null and "team_leave_operations"."canceled_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_project_copyback_stages" DROP CONSTRAINT "personal_workspace_project_copyback_state_check";--> statement-breakpoint
ALTER TABLE "personal_workspace_project_copyback_stages" ADD COLUMN "leave_operation_id" uuid;--> statement-breakpoint
ALTER TABLE "team_leave_operations" ADD CONSTRAINT "team_leave_operations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_leave_operations" ADD CONSTRAINT "team_leave_operations_membership_id_team_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_leave_operations" ADD CONSTRAINT "team_leave_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_leave_operations" ADD CONSTRAINT "team_leave_operations_device_credential_id_device_credentials_id_fk" FOREIGN KEY ("device_credential_id") REFERENCES "public"."device_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_leave_operations" ADD CONSTRAINT "team_leave_operations_action_grant_id_high_risk_device_action_grants_id_fk" FOREIGN KEY ("action_grant_id") REFERENCES "public"."high_risk_device_action_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_leave_operations_one_prepared_team" ON "team_leave_operations" USING btree ("team_id") WHERE "team_leave_operations"."state" = 'prepared';--> statement-breakpoint
ALTER TABLE "personal_workspace_project_copyback_stages" ADD CONSTRAINT "personal_workspace_project_copyback_state_check" CHECK ("personal_workspace_project_copyback_stages"."state" in ('staged','ready','applied','abandoned'));