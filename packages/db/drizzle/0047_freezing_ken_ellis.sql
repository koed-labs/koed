CREATE TYPE "public"."personal_project_lifecycle" AS ENUM('active', 'deleted');--> statement-breakpoint
CREATE TABLE "project_local_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid,
	"device_id" uuid NOT NULL,
	"local_project_id" text NOT NULL,
	"common_dir_hash" text,
	"git_dir_hash" text,
	"folder_hash" text,
	"association_state" text DEFAULT 'resolved' NOT NULL,
	"last_confirmation_version" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_local_contexts_owner_device_local_unique" UNIQUE("owner_user_id","device_id","local_project_id"),
	CONSTRAINT "project_local_contexts_association_shape_check" CHECK (("project_local_contexts"."association_state" = 'resolved' and "project_local_contexts"."project_id" is not null) or ("project_local_contexts"."association_state" = 'unresolved' and "project_local_contexts"."project_id" is null))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"folder_path" text,
	"key" text NOT NULL,
	"lifecycle" "personal_project_lifecycle" DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"delete_batch_id" uuid,
	"team_backend_id" text,
	"team_workspace_id" uuid,
	"workspace_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "projects_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "projects_owner_key_unique" UNIQUE("owner_user_id","key"),
	CONSTRAINT "projects_name_not_blank" CHECK (length(trim("projects"."name")) > 0),
	CONSTRAINT "projects_key_not_blank" CHECK (length(trim("projects"."key")) > 0),
	CONSTRAINT "projects_version_positive" CHECK ("projects"."version" > 0),
	CONSTRAINT "projects_deleted_shape_check" CHECK (("projects"."lifecycle" = 'active' and "projects"."deleted_at" is null) or ("projects"."lifecycle" = 'deleted' and "projects"."deleted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "automatic_personal_project_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_override_personal_project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_local_contexts" ADD CONSTRAINT "project_local_contexts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_local_contexts" ADD CONSTRAINT "project_local_contexts_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_local_contexts_owner_group_idx" ON "project_local_contexts" USING btree ("owner_user_id","device_id","common_dir_hash");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_automatic_personal_project_fk" FOREIGN KEY ("owner_user_id","automatic_personal_project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_override_personal_project_fk" FOREIGN KEY ("owner_user_id","project_override_personal_project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE no action ON UPDATE no action;