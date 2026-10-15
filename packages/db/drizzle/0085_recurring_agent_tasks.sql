CREATE TABLE "recurring_agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"title" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"target_device_id" text NOT NULL,
	"target_deployment_id" uuid NOT NULL,
	"encrypted_definition" jsonb NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_error_code" text,
	"creation_request_id" uuid NOT NULL,
	"creation_request_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_agent_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE cascade,
	CONSTRAINT "recurring_agent_tasks_owner_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "personal_agent_identities"("id","owner_user_id") ON DELETE cascade,
	CONSTRAINT "recurring_agent_tasks_owner_id_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "recurring_agent_tasks_owner_create_request_unique" UNIQUE("owner_user_id","creation_request_id"),
	CONSTRAINT "recurring_agent_tasks_title_check" CHECK (length(trim("title")) between 1 and 120),
	CONSTRAINT "recurring_agent_tasks_status_check" CHECK ("status" in ('paused','active','needs_review','archived')),
	CONSTRAINT "recurring_agent_tasks_revision_check" CHECK ("revision" > 0 and "creation_request_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "recurring_agent_tasks_active_due_check" CHECK (("status" = 'active' and "next_run_at" is not null) or ("status" <> 'active' and "next_run_at" is null))
);
--> statement-breakpoint
CREATE INDEX "recurring_agent_tasks_owner_agent_updated_idx" ON "recurring_agent_tasks" USING btree ("owner_user_id","agent_id","updated_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "recurring_agent_tasks_due_idx" ON "recurring_agent_tasks" USING btree ("target_device_id","next_run_at","id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE TABLE "recurring_agent_task_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"task_revision" integer NOT NULL,
	"trigger" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"conversation_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"target_device_id" text NOT NULL,
	"target_deployment_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" integer NOT NULL,
	"encrypted_launch" jsonb NOT NULL,
	"message_id" uuid,
	"delivery_id" uuid,
	"execution_id" uuid,
	"command_id" uuid,
	"error_code" text,
	"write_dispatched" boolean DEFAULT false NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"claimed_by_runner_id" text,
	"reconciliation_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "recurring_agent_task_occurrences_task_fk" FOREIGN KEY ("task_id","owner_user_id") REFERENCES "recurring_agent_tasks"("id","owner_user_id") ON DELETE cascade,
	CONSTRAINT "recurring_agent_task_occurrences_agent_fk" FOREIGN KEY ("agent_id","owner_user_id") REFERENCES "personal_agent_identities"("id","owner_user_id") ON DELETE restrict,
	CONSTRAINT "recurring_agent_task_occurrences_owner_conversation_unique" UNIQUE("owner_user_id","conversation_id"),
	CONSTRAINT "recurring_agent_task_occurrences_owner_request_unique" UNIQUE("owner_user_id","request_id"),
	CONSTRAINT "recurring_agent_task_occurrences_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "recurring_agent_task_occurrences_trigger_check" CHECK ("trigger" in ('scheduled','manual')),
	CONSTRAINT "recurring_agent_task_occurrences_status_check" CHECK ("status" in ('reserved','dispatched','completed','needs_review','canceled')),
	CONSTRAINT "recurring_agent_task_occurrences_version_check" CHECK ("task_revision" > 0 and "agent_version" > 0),
	CONSTRAINT "recurring_agent_task_occurrences_identity_check" CHECK ("id" = "conversation_id" and "id" = "request_id"),
	CONSTRAINT "recurring_agent_task_occurrences_lease_check" CHECK (("lease_token" is null and "lease_expires_at" is null and "claimed_by_runner_id" is null) or ("lease_token" is not null and "lease_expires_at" is not null and "claimed_by_runner_id" is not null)),
	CONSTRAINT "recurring_agent_task_occurrences_write_state_check" CHECK ("status" <> 'reserved' or "write_dispatched" = true or "message_id" is null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_agent_task_occurrences_scheduled_slot_unique" ON "recurring_agent_task_occurrences" USING btree ("task_id","task_revision","scheduled_at") WHERE "trigger" = 'scheduled';
--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_agent_task_occurrences_one_active_per_task_unique" ON "recurring_agent_task_occurrences" USING btree ("task_id") WHERE "status" in ('reserved','dispatched');
--> statement-breakpoint
CREATE INDEX "recurring_agent_task_occurrences_claim_idx" ON "recurring_agent_task_occurrences" USING btree ("target_deployment_id","target_device_id","created_at") WHERE "status" = 'reserved';
--> statement-breakpoint
CREATE INDEX "recurring_agent_task_occurrences_reconcile_idx" ON "recurring_agent_task_occurrences" USING btree ("target_deployment_id","target_device_id","updated_at") WHERE "status" = 'dispatched';
