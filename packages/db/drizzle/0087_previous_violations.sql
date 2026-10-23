CREATE TABLE "ai_client_usage_accounts" (
	"owner_user_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"account_identity_hash" text,
	"profile_scope_hash" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_client_usage_accounts_owner_user_id_instance_id_pk" PRIMARY KEY("owner_user_id","instance_id"),
	CONSTRAINT "ai_client_usage_accounts_identity_check" CHECK ("ai_client_usage_accounts"."account_identity_hash" is null or "ai_client_usage_accounts"."account_identity_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ai_client_usage_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"account_identity_hash" text NOT NULL,
	"source" text NOT NULL,
	"bucket_id" text NOT NULL,
	"bucket_name" text,
	"window" text NOT NULL,
	"window_duration_mins" integer,
	"used_percent" double precision,
	"status" text NOT NULL,
	"resets_at" timestamp with time zone,
	"plan_type" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_client_usage_snapshots_identity_check" CHECK ("ai_client_usage_snapshots"."account_identity_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_client_usage_snapshots_status_check" CHECK ("ai_client_usage_snapshots"."status" in ('ok', 'near_limit', 'limited', 'unknown')),
	CONSTRAINT "ai_client_usage_snapshots_source_check" CHECK ("ai_client_usage_snapshots"."source" in ('codex_app_server', 'claude_agent_sdk')),
	CONSTRAINT "ai_client_usage_snapshots_percent_check" CHECK ("ai_client_usage_snapshots"."used_percent" is null or "ai_client_usage_snapshots"."used_percent" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "ai_client_usage_accounts" ADD CONSTRAINT "ai_client_usage_accounts_instance_fk" FOREIGN KEY ("owner_user_id","instance_id") REFERENCES "public"."ai_client_instances"("owner_user_id","instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_client_usage_snapshots" ADD CONSTRAINT "ai_client_usage_snapshots_instance_fk" FOREIGN KEY ("owner_user_id","instance_id") REFERENCES "public"."ai_client_instances"("owner_user_id","instance_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_client_usage_snapshots_latest_idx" ON "ai_client_usage_snapshots" USING btree ("owner_user_id","instance_id","account_identity_hash","bucket_id","window","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_client_usage_snapshots_retention_idx" ON "ai_client_usage_snapshots" USING btree ("observed_at");