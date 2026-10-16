ALTER TABLE "remote_mcp_oauth_grants" ALTER COLUMN "client_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "provider_issuer" text;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "provider_environment" text;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "provider_registration_id" text;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "provider_user_id" text;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "provider_organization_id" text;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "team_boundary_id" uuid;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD COLUMN "authorization_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD CONSTRAINT "remote_mcp_external_registration_unique" UNIQUE("provider_issuer","provider_environment","provider_registration_id","resource");--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD CONSTRAINT "remote_mcp_grant_binding_check" CHECK ((
      "remote_mcp_oauth_grants"."client_id" is not null and "remote_mcp_oauth_grants"."provider_issuer" is null and
      "remote_mcp_oauth_grants"."provider_environment" is null and "remote_mcp_oauth_grants"."provider_registration_id" is null and
      "remote_mcp_oauth_grants"."provider_user_id" is null and "remote_mcp_oauth_grants"."provider_organization_id" is null and
      "remote_mcp_oauth_grants"."team_boundary_id" is null
    ) or (
      "remote_mcp_oauth_grants"."client_id" is null and "remote_mcp_oauth_grants"."provider_issuer" is not null and
      "remote_mcp_oauth_grants"."provider_environment" is not null and "remote_mcp_oauth_grants"."provider_registration_id" is not null and
      "remote_mcp_oauth_grants"."provider_user_id" is not null and "remote_mcp_oauth_grants"."provider_organization_id" is not null
    ));--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD CONSTRAINT "remote_mcp_grant_version_check" CHECK ("remote_mcp_oauth_grants"."authorization_version" > 0);