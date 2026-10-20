ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'work_item_changed' BEFORE 'access_revoked';--> statement-breakpoint
CREATE TABLE "project_work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"origin" text NOT NULL,
	"origin_ref" text,
	"idempotency_key" text,
	"creation_payload_hash" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"blocked_reason" text,
	"assignee_agent_id" uuid,
	"execution_id" uuid,
	"dispatch_key" text,
	"pr_provider" text,
	"pr_number" integer,
	"pr_url" text,
	"pr_state" text,
	"due_on" date,
	"done_at" timestamp with time zone,
	"done_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_work_items_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "project_work_items_kind_check" CHECK ("project_work_items"."kind" in ('todo','ticket')),
	CONSTRAINT "project_work_items_status_check" CHECK ("project_work_items"."status" in ('todo','doing','review','blocked','done')),
	CONSTRAINT "project_work_items_version_check" CHECK ("project_work_items"."version" > 0),
	CONSTRAINT "project_work_items_title_check" CHECK (length(trim("project_work_items"."title")) > 0),
	CONSTRAINT "project_work_items_goal_check" CHECK (length(trim("project_work_items"."goal")) > 0),
	CONSTRAINT "project_work_items_ticket_key_check" CHECK ("project_work_items"."kind" = 'ticket' or "project_work_items"."key" is null)
);
--> statement-breakpoint
ALTER TABLE "project_work_items" ADD CONSTRAINT "project_work_items_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_work_items_origin_idempotency_unique" ON "project_work_items" USING btree ("owner_user_id","project_id","origin","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_work_items_dispatch_unique" ON "project_work_items" USING btree ("owner_user_id","project_id","dispatch_key");--> statement-breakpoint
CREATE INDEX "project_work_items_project_idx" ON "project_work_items" USING btree ("owner_user_id","project_id","status","created_at");