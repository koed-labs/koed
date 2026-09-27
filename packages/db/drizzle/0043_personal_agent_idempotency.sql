ALTER TABLE "personal_agent_identities" ADD COLUMN "creation_request_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD COLUMN "retirement_request_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD COLUMN "request_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD CONSTRAINT "personal_agent_identities_owner_creation_request_unique" UNIQUE("owner_user_id","creation_request_id");--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD CONSTRAINT "personal_agent_identities_owner_retirement_request_unique" UNIQUE("owner_user_id","retirement_request_id");--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_owner_request_unique" UNIQUE("owner_user_id","request_id");