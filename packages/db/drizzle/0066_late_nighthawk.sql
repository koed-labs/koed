CREATE TABLE "workspace_project_activity" (
	"workspace_project_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"actor_team_member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_activity_workspace_project_id_sequence_pk" PRIMARY KEY("workspace_project_id","sequence"),
	CONSTRAINT "workspace_project_activity_event_unique" UNIQUE("workspace_project_id","kind","ref")
);
--> statement-breakpoint
CREATE TABLE "workspace_project_members" (
	"workspace_project_id" uuid NOT NULL,
	"team_member_id" uuid NOT NULL,
	"access" text DEFAULT 'write' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_members_workspace_project_id_team_member_id_pk" PRIMARY KEY("workspace_project_id","team_member_id"),
	CONSTRAINT "workspace_project_members_access_check" CHECK ("workspace_project_members"."access" in ('read','write','disabled')),
	CONSTRAINT "workspace_project_members_version_positive" CHECK ("workspace_project_members"."version" > 0),
	CONSTRAINT "workspace_project_members_disabled_shape" CHECK (("workspace_project_members"."access" = 'disabled') = ("workspace_project_members"."disabled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "workspace_project_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"uploader_team_member_id" uuid NOT NULL,
	"source_project_source_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"personal_note_revision_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_sources_personal_source_unique" UNIQUE("workspace_project_id","uploader_team_member_id","source_project_source_id"),
	CONSTRAINT "workspace_project_sources_version_positive" CHECK ("workspace_project_sources"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_project_work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"source_owner_team_member_id" uuid NOT NULL,
	"source_work_item_id" uuid,
	"kind" text NOT NULL,
	"key" text,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"due_on" date,
	"assignee_display_name" text,
	"step_label" text,
	"pr_url" text,
	"pr_state" text,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_work_items_source_unique" UNIQUE("workspace_project_id","source_owner_team_member_id","source_work_item_id"),
	CONSTRAINT "workspace_project_work_items_kind_check" CHECK ("workspace_project_work_items"."kind" in ('todo','ticket')),
	CONSTRAINT "workspace_project_work_items_status_check" CHECK ("workspace_project_work_items"."status" in ('todo','doing','review','blocked','done')),
	CONSTRAINT "workspace_project_work_items_version_positive" CHECK ("workspace_project_work_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_team_member_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"share_attempt_key" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"copied_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_projects_workspace_unique" UNIQUE("workspace_id"),
	CONSTRAINT "workspace_projects_share_attempt_unique" UNIQUE("team_id","owner_team_member_id","share_attempt_key"),
	CONSTRAINT "workspace_projects_version_positive" CHECK ("workspace_projects"."version" > 0),
	CONSTRAINT "workspace_projects_lifecycle_check" CHECK ("workspace_projects"."lifecycle" in ('active','deleted')),
	CONSTRAINT "workspace_projects_deleted_shape" CHECK (("workspace_projects"."lifecycle" = 'active' and "workspace_projects"."deleted_at" is null) or ("workspace_projects"."lifecycle" = 'deleted' and "workspace_projects"."deleted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "workspace_project_activity" ADD CONSTRAINT "workspace_project_activity_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_activity" ADD CONSTRAINT "workspace_project_activity_actor_team_member_id_team_memberships_id_fk" FOREIGN KEY ("actor_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_members" ADD CONSTRAINT "workspace_project_members_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_members" ADD CONSTRAINT "workspace_project_members_team_member_id_team_memberships_id_fk" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_sources" ADD CONSTRAINT "workspace_project_sources_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_sources" ADD CONSTRAINT "workspace_project_sources_uploader_team_member_id_team_memberships_id_fk" FOREIGN KEY ("uploader_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD CONSTRAINT "workspace_project_work_items_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD CONSTRAINT "workspace_project_work_items_source_owner_team_member_id_team_memberships_id_fk" FOREIGN KEY ("source_owner_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_projects" ADD CONSTRAINT "workspace_projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_projects" ADD CONSTRAINT "workspace_projects_workspace_id_team_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."team_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_projects" ADD CONSTRAINT "workspace_projects_owner_team_member_id_team_memberships_id_fk" FOREIGN KEY ("owner_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_projects" ADD CONSTRAINT "workspace_projects_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_memberships" ADD CONSTRAINT "team_memberships_team_id_unique" UNIQUE("team_id","id");--> statement-breakpoint
ALTER TABLE "workspace_projects" ADD CONSTRAINT "workspace_projects_owner_team_fk" FOREIGN KEY ("team_id","owner_team_member_id") REFERENCES "public"."team_memberships"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_project_work_items_recent_idx" ON "workspace_project_work_items" USING btree ("workspace_project_id","created_at");--> statement-breakpoint
--> statement-breakpoint
UPDATE project_lifecycle_schema_capabilities
   SET state='enabled', enabled_at=now()
 WHERE capability='workspace_projects' AND state='absent';

--> statement-breakpoint
ALTER TABLE "workspace_projects" ADD COLUMN "copy_manifest_hash" text;

--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD CONSTRAINT "workspace_project_work_items_create_idempotency_unique" UNIQUE("workspace_project_id","source_owner_team_member_id","idempotency_key");
--> statement-breakpoint
CREATE TABLE "personal_workspace_project_copyback_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"personal_project_id" uuid NOT NULL,
	"team_backend_id" text NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"owner_team_member_id" uuid NOT NULL,
	"reviewed_team_version" integer NOT NULL,
	"reviewed_member_version" integer NOT NULL,
	"reviewed_project_version" integer NOT NULL,
	"owned_set_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"work_items" jsonb NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_workspace_project_copyback_stage_unique" UNIQUE("owner_user_id","team_backend_id","workspace_project_id","reviewed_project_version"),
	CONSTRAINT "personal_workspace_project_copyback_state_check" CHECK ("personal_workspace_project_copyback_stages"."state" in ('staged','applied'))
);
--> statement-breakpoint
CREATE TABLE "personal_workspace_project_principal_bindings" (
	"local_user_id" uuid NOT NULL,
	"team_backend_id" text NOT NULL,
	"team_principal_user_id" uuid NOT NULL,
	"local_credential_key_id" text NOT NULL,
	"team_credential_key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_workspace_project_principal_bindings_local_user_id_team_backend_id_pk" PRIMARY KEY("local_user_id","team_backend_id"),
	CONSTRAINT "personal_workspace_project_principal_remote_unique" UNIQUE("team_backend_id","team_principal_user_id")
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_project_copyback_stages" ADD CONSTRAINT "personal_workspace_project_copyback_stages_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_copyback_stages" ADD CONSTRAINT "personal_workspace_project_copyback_stages_personal_project_id_projects_id_fk" FOREIGN KEY ("personal_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_principal_bindings" ADD CONSTRAINT "personal_workspace_project_principal_bindings_local_user_id_users_id_fk" FOREIGN KEY ("local_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
--> statement-breakpoint
CREATE TABLE "personal_workspace_project_share_attempts" (
	"personal_project_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"team_backend_id" text NOT NULL,
	"share_attempt_key" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_workspace_project_share_attempt_state_check" CHECK ("personal_workspace_project_share_attempts"."state" in ('pending','confirmed'))
);
--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" ADD CONSTRAINT "personal_workspace_project_share_attempts_personal_project_id_projects_id_fk" FOREIGN KEY ("personal_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_share_attempts" ADD CONSTRAINT "personal_workspace_project_share_attempts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_personal_project_share_not_pending()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_project_id uuid;
BEGIN
  target_project_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  PERFORM 1 FROM projects WHERE id=target_project_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM personal_workspace_project_share_attempts
              WHERE personal_project_id=target_project_id AND state='pending') THEN
    RAISE EXCEPTION 'Personal Project first share is pending' USING ERRCODE='40001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_work_items_share_fence
BEFORE INSERT OR UPDATE OR DELETE ON project_work_items
FOR EACH ROW EXECUTE FUNCTION assert_personal_project_share_not_pending();
--> statement-breakpoint
CREATE TRIGGER project_sources_share_fence
BEFORE INSERT OR UPDATE OR DELETE ON project_sources
FOR EACH ROW EXECUTE FUNCTION assert_personal_project_share_not_pending();
--> statement-breakpoint
CREATE TABLE "workspace_project_share_grant_bindings" (
	"workspace_project_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"source_owner_team_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_share_grant_bindings_workspace_project_id_share_grant_id_pk" PRIMARY KEY("workspace_project_id","share_grant_id"),
	CONSTRAINT "workspace_project_share_grant_single_project" UNIQUE("share_grant_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_project_share_grant_bindings" ADD CONSTRAINT "workspace_project_share_grant_bindings_workspace_project_id_workspace_projects_id_fk" FOREIGN KEY ("workspace_project_id") REFERENCES "public"."workspace_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_grant_bindings" ADD CONSTRAINT "workspace_project_share_grant_bindings_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_grant_bindings" ADD CONSTRAINT "workspace_project_share_grant_bindings_source_owner_team_member_id_team_memberships_id_fk" FOREIGN KEY ("source_owner_team_member_id") REFERENCES "public"."team_memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_personal_project_share_core_not_changed()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM personal_workspace_project_share_attempts
              WHERE personal_project_id=OLD.id AND state='pending')
     AND (NEW.name,NEW.key,NEW.folder_path,NEW.lifecycle,NEW.deletion_phase,
          NEW.deleted_at,NEW.delete_batch_id)
         IS DISTINCT FROM
         (OLD.name,OLD.key,OLD.folder_path,OLD.lifecycle,OLD.deletion_phase,
          OLD.deleted_at,OLD.delete_batch_id) THEN
    RAISE EXCEPTION 'Personal Project first share is pending' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER projects_share_core_fence
BEFORE UPDATE ON projects FOR EACH ROW
EXECUTE FUNCTION assert_personal_project_share_core_not_changed();
--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD COLUMN "dispatch_key" text;
--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD COLUMN "dispatch_owner_team_member_id" uuid;
--> statement-breakpoint
ALTER TABLE "workspace_project_work_items" ADD COLUMN "done_at" timestamp with time zone;
CREATE TABLE "managed_shared_dispatch_detachments" (
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"personal_project_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"detached_generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_shared_dispatch_detachments_pk" PRIMARY KEY("owner_user_id","execution_id"),
	CONSTRAINT "managed_shared_dispatch_detachments_generation_check" CHECK ("managed_shared_dispatch_detachments"."detached_generation" > 0)
);
--> statement-breakpoint
ALTER TABLE "managed_shared_dispatch_detachments" ADD CONSTRAINT "managed_shared_dispatch_detachments_execution_fk" FOREIGN KEY ("owner_user_id","execution_id") REFERENCES "public"."managed_conversation_executions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_shared_dispatch_detachments_project_idx" ON "managed_shared_dispatch_detachments" USING btree ("owner_user_id","personal_project_id","workspace_project_id");
--> statement-breakpoint
CREATE TABLE "personal_workspace_project_reconciliations" (
	"owner_user_id" uuid NOT NULL,
	"personal_project_id" uuid NOT NULL,
	"team_backend_id" text NOT NULL,
	"workspace_project_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_workspace_project_reconciliations_owner_user_id_team_backend_id_workspace_project_id_pk" PRIMARY KEY("owner_user_id","team_backend_id","workspace_project_id"),
	CONSTRAINT "personal_workspace_project_reconciliation_reason_check" CHECK ("personal_workspace_project_reconciliations"."reason" in ('copy_back','invalidation'))
);
--> statement-breakpoint
ALTER TABLE "workspace_project_share_grant_bindings" ADD COLUMN "workspace_project_source_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_reconciliations" ADD CONSTRAINT "personal_workspace_project_reconciliations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_workspace_project_reconciliations" ADD CONSTRAINT "personal_workspace_project_reconciliations_personal_project_id_projects_id_fk" FOREIGN KEY ("personal_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_share_grant_bindings" ADD CONSTRAINT "workspace_project_share_grant_bindings_workspace_project_source_id_workspace_project_sources_id_fk" FOREIGN KEY ("workspace_project_source_id") REFERENCES "public"."workspace_project_sources"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspace_project_sources" ADD COLUMN "personal_note_id" uuid;
