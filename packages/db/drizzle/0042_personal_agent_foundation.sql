CREATE TABLE "personal_agent_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"attribution_kind" text DEFAULT 'agent' NOT NULL,
	"agent_id" uuid,
	"agent_version" integer,
	"provider" text,
	"model" text,
	"ai_client_instance_id" text,
	"reasoning_effort" text,
	"permission_mode" text,
	"managed_execution_id" uuid,
	"managed_execution_generation" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"outcome" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_execution_attempts_job_number_unique" UNIQUE("job_id","attempt_number"),
	CONSTRAINT "personal_agent_execution_attempts_attribution_check" CHECK (("personal_agent_execution_attempts"."attribution_kind" = 'agent'
          and "personal_agent_execution_attempts"."agent_id" is not null
          and "personal_agent_execution_attempts"."agent_version" is not null
          and "personal_agent_execution_attempts"."provider" is not null
          and "personal_agent_execution_attempts"."model" is not null
          and "personal_agent_execution_attempts"."ai_client_instance_id" is not null
          and "personal_agent_execution_attempts"."permission_mode" is not null)
        or ("personal_agent_execution_attempts"."attribution_kind" = 'legacy'
          and "personal_agent_execution_attempts"."agent_id" is null
          and "personal_agent_execution_attempts"."agent_version" is null)),
	CONSTRAINT "personal_agent_execution_attempts_runtime_check" CHECK (("personal_agent_execution_attempts"."provider" is null or "personal_agent_execution_attempts"."provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$')
        and ("personal_agent_execution_attempts"."ai_client_instance_id" is null or "personal_agent_execution_attempts"."ai_client_instance_id" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$')
        and ("personal_agent_execution_attempts"."model" is null or length(trim("personal_agent_execution_attempts"."model")) between 1 and 512)
        and ("personal_agent_execution_attempts"."reasoning_effort" is null or length(trim("personal_agent_execution_attempts"."reasoning_effort")) between 1 and 64)
        and ("personal_agent_execution_attempts"."permission_mode" is null or "personal_agent_execution_attempts"."permission_mode" in ('supervised', 'auto_edit', 'auto', 'full_access'))),
	CONSTRAINT "personal_agent_execution_attempts_managed_generation_check" CHECK (("personal_agent_execution_attempts"."managed_execution_id" is null and "personal_agent_execution_attempts"."managed_execution_generation" is null)
        or ("personal_agent_execution_attempts"."managed_execution_id" is not null and "personal_agent_execution_attempts"."managed_execution_generation" > 0)),
	CONSTRAINT "personal_agent_execution_attempts_status_check" CHECK (("personal_agent_execution_attempts"."status" = 'running' and "personal_agent_execution_attempts"."outcome" is null and "personal_agent_execution_attempts"."completed_at" is null)
        or ("personal_agent_execution_attempts"."status" in ('succeeded', 'failed', 'canceled', 'interrupted')
          and "personal_agent_execution_attempts"."outcome" = "personal_agent_execution_attempts"."status"
          and "personal_agent_execution_attempts"."completed_at" is not null)),
	CONSTRAINT "personal_agent_execution_attempts_number_check" CHECK ("personal_agent_execution_attempts"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agent_execution_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"attribution_kind" text DEFAULT 'agent' NOT NULL,
	"agent_id" uuid,
	"agent_version" integer,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempts_started" integer DEFAULT 0 NOT NULL,
	"attempts_succeeded" integer DEFAULT 0 NOT NULL,
	"attempts_failed" integer DEFAULT 0 NOT NULL,
	"attempts_canceled" integer DEFAULT 0 NOT NULL,
	"attempts_interrupted" integer DEFAULT 0 NOT NULL,
	"last_attempt_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_execution_jobs_owner_id_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "personal_agent_execution_jobs_attribution_check" CHECK (("personal_agent_execution_jobs"."attribution_kind" = 'agent'
          and "personal_agent_execution_jobs"."agent_id" is not null
          and "personal_agent_execution_jobs"."agent_version" is not null)
        or ("personal_agent_execution_jobs"."attribution_kind" = 'legacy'
          and "personal_agent_execution_jobs"."agent_id" is null
          and "personal_agent_execution_jobs"."agent_version" is null)),
	CONSTRAINT "personal_agent_execution_jobs_state_check" CHECK ("personal_agent_execution_jobs"."state" in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "personal_agent_execution_jobs_counter_check" CHECK ("personal_agent_execution_jobs"."attempts_started" >= 0
        and "personal_agent_execution_jobs"."attempts_succeeded" >= 0
        and "personal_agent_execution_jobs"."attempts_failed" >= 0
        and "personal_agent_execution_jobs"."attempts_canceled" >= 0
        and "personal_agent_execution_jobs"."attempts_interrupted" >= 0
        and "personal_agent_execution_jobs"."attempts_succeeded" + "personal_agent_execution_jobs"."attempts_failed"
          + "personal_agent_execution_jobs"."attempts_canceled" + "personal_agent_execution_jobs"."attempts_interrupted"
          <= "personal_agent_execution_jobs"."attempts_started")
);
--> statement-breakpoint
CREATE TABLE "personal_agent_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"avatar_reference" text,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"default_provider" text NOT NULL,
	"default_model" text NOT NULL,
	"default_reasoning_effort" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "personal_agent_identities_owner_id_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "personal_agent_identities_text_check" CHECK (length(trim("personal_agent_identities"."name")) between 1 and 128
        and length("personal_agent_identities"."role") <= 512
        and ("personal_agent_identities"."avatar_reference" is null or length("personal_agent_identities"."avatar_reference") <= 4096)
        and "personal_agent_identities"."default_provider" ~ '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$'
        and length(trim("personal_agent_identities"."default_model")) between 1 and 512
        and ("personal_agent_identities"."default_reasoning_effort" is null or length(trim("personal_agent_identities"."default_reasoning_effort")) between 1 and 64)),
	CONSTRAINT "personal_agent_identities_lifecycle_check" CHECK (("personal_agent_identities"."lifecycle" = 'active' and "personal_agent_identities"."retired_at" is null)
        or ("personal_agent_identities"."lifecycle" = 'retired' and "personal_agent_identities"."retired_at" is not null)),
	CONSTRAINT "personal_agent_identities_version_check" CHECK ("personal_agent_identities"."current_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "personal_agent_identity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"avatar_reference" text,
	"soul_instructions" text NOT NULL,
	"instruction_source" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_agent_identity_versions_agent_version_unique" UNIQUE("agent_id","version"),
	CONSTRAINT "personal_agent_identity_versions_owner_agent_version_unique" UNIQUE("owner_user_id","agent_id","version"),
	CONSTRAINT "personal_agent_identity_versions_text_check" CHECK (length(trim("personal_agent_identity_versions"."name")) between 1 and 128
        and length("personal_agent_identity_versions"."role") <= 512
        and ("personal_agent_identity_versions"."avatar_reference" is null or length("personal_agent_identity_versions"."avatar_reference") <= 4096)
        and "personal_agent_identity_versions"."soul_instructions" = '[koed encrypted personal agent soul]'
        and "personal_agent_identity_versions"."instruction_source" in ('generated', 'custom')),
	CONSTRAINT "personal_agent_identity_versions_number_check" CHECK ("personal_agent_identity_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "personal_agent_execution_attempts" ADD CONSTRAINT "personal_agent_execution_attempts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_attempts" ADD CONSTRAINT "personal_agent_execution_attempts_owner_job_fk" FOREIGN KEY ("job_id","owner_user_id") REFERENCES "public"."personal_agent_execution_jobs"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_attempts" ADD CONSTRAINT "personal_agent_execution_attempts_agent_version_fk" FOREIGN KEY ("owner_user_id","agent_id","agent_version") REFERENCES "public"."personal_agent_identity_versions"("owner_user_id","agent_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD CONSTRAINT "personal_agent_execution_jobs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD CONSTRAINT "personal_agent_execution_jobs_owner_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_execution_jobs" ADD CONSTRAINT "personal_agent_execution_jobs_agent_version_fk" FOREIGN KEY ("owner_user_id","agent_id","agent_version") REFERENCES "public"."personal_agent_identity_versions"("owner_user_id","agent_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_identities" ADD CONSTRAINT "personal_agent_identities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_identity_versions" ADD CONSTRAINT "personal_agent_identity_versions_owner_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "public"."personal_agent_identities"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_agent_execution_attempts_owner_job_idx" ON "personal_agent_execution_attempts" USING btree ("owner_user_id","job_id","attempt_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personal_agent_execution_attempts_owner_status_idx" ON "personal_agent_execution_attempts" USING btree ("owner_user_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personal_agent_execution_jobs_owner_state_idx" ON "personal_agent_execution_jobs" USING btree ("owner_user_id","state","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personal_agent_execution_jobs_owner_conversation_idx" ON "personal_agent_execution_jobs" USING btree ("owner_user_id","conversation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personal_agent_identities_owner_lifecycle_idx" ON "personal_agent_identities" USING btree ("owner_user_id","lifecycle","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "personal_agent_identity_versions_owner_agent_idx" ON "personal_agent_identity_versions" USING btree ("owner_user_id","agent_id","version" DESC NULLS LAST);