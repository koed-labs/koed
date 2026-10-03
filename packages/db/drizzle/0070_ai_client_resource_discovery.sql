CREATE TABLE "ai_client_resource_discovery_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"ai_client_instance_id" text NOT NULL,
	"source_device_credential_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000' NOT NULL,
	"hosted_instance_id" text NOT NULL,
	"provider" text NOT NULL,
	"computer_label" text,
	"target_device_id" text NOT NULL,
	"target_deployment_id" uuid NOT NULL,
	"project_id" text,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"claimed_by_runner_id" text,
	"catalog" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ai_client_resource_discovery_identity_check" CHECK ("ai_client_resource_discovery_operations"."hosted_instance_id" <> ''
        and "ai_client_resource_discovery_operations"."ai_client_instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and "ai_client_resource_discovery_operations"."provider" in ('codex','claude','pi')
        and "ai_client_resource_discovery_operations"."request_digest" ~ '^[0-9a-f]{64}$'
        and "ai_client_resource_discovery_operations"."target_device_id" <> ''),
	CONSTRAINT "ai_client_resource_discovery_state_check" CHECK ("ai_client_resource_discovery_operations"."state" in ('pending','running','completed','failed')
        and "ai_client_resource_discovery_operations"."revision" > 0
        and "ai_client_resource_discovery_operations"."attempt" >= 0
        and (("ai_client_resource_discovery_operations"."state" = 'running') = ("ai_client_resource_discovery_operations"."lease_token" is not null and "ai_client_resource_discovery_operations"."lease_expires_at" is not null and "ai_client_resource_discovery_operations"."claimed_by_runner_id" is not null))
        and (("ai_client_resource_discovery_operations"."state" = 'completed') = ("ai_client_resource_discovery_operations"."catalog" is not null))
        and (("ai_client_resource_discovery_operations"."state" = 'failed') = ("ai_client_resource_discovery_operations"."error_code" is not null)))
);
--> statement-breakpoint
ALTER TABLE "ai_client_resource_discovery_operations" ADD CONSTRAINT "ai_client_resource_discovery_instance_fk" FOREIGN KEY ("owner_user_id","ai_client_instance_id","source_device_credential_id") REFERENCES "public"."ai_client_instances"("owner_user_id","instance_id","source_device_credential_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_client_resource_discovery_request_unique" ON "ai_client_resource_discovery_operations" USING btree ("owner_user_id","request_id");--> statement-breakpoint
CREATE INDEX "ai_client_resource_discovery_runner_claim_idx" ON "ai_client_resource_discovery_operations" USING btree ("owner_user_id","target_deployment_id","target_device_id","state","created_at");--> statement-breakpoint
CREATE INDEX "ai_client_resource_discovery_hosted_scope_idx" ON "ai_client_resource_discovery_operations" USING btree ("owner_user_id","hosted_instance_id","project_id","updated_at" DESC NULLS LAST);