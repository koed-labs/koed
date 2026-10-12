CREATE TABLE "remote_mcp_oauth_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_mcp_oauth_credentials" (
	"secret_hash" text PRIMARY KEY NOT NULL,
	"grant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_mcp_oauth_credentials_kind_check" CHECK ("remote_mcp_oauth_credentials"."kind" in ('code', 'access', 'refresh'))
);
--> statement-breakpoint
CREATE TABLE "remote_mcp_oauth_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remote_mcp_oauth_requests" (
	"secret_hash" text PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_credentials" ADD CONSTRAINT "remote_mcp_oauth_credentials_grant_id_remote_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."remote_mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD CONSTRAINT "remote_mcp_oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_grants" ADD CONSTRAINT "remote_mcp_oauth_grants_client_id_remote_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."remote_mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_mcp_oauth_requests" ADD CONSTRAINT "remote_mcp_oauth_requests_client_id_remote_mcp_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."remote_mcp_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_mcp_oauth_credentials_grant_idx" ON "remote_mcp_oauth_credentials" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "remote_mcp_oauth_grants_user_idx" ON "remote_mcp_oauth_grants" USING btree ("user_id");