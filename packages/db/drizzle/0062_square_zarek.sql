CREATE TABLE "chat_move_operations" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"old_project_id" uuid NOT NULL,
	"old_workspace_project_id" uuid NOT NULL,
	"old_project_version" integer NOT NULL,
	"target_project_id" uuid,
	"source_mapping_version" integer NOT NULL,
	"binding_manifest" jsonb NOT NULL,
	"binding_manifest_hash" text NOT NULL,
	"grant_freeze_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'freezing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_move_operations_hash_check" CHECK (length("chat_move_operations"."binding_manifest_hash")=64),
	CONSTRAINT "chat_move_operations_state_check" CHECK ("chat_move_operations"."state" in ('freezing','ready','complete','cancelled','needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "project_policy_session_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"backend_id" text NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"policy_generation" integer NOT NULL,
	"mapping_version" integer NOT NULL,
	"grant_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_policy_session_grants_exact_unique" UNIQUE("backend_id","share_grant_id"),
	CONSTRAINT "project_policy_session_grants_versions_check" CHECK ("project_policy_session_grants"."policy_generation">0 and "project_policy_session_grants"."mapping_version">0 and "project_policy_session_grants"."grant_version">0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_assignment_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_move_operations" ADD CONSTRAINT "chat_move_operations_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policy_session_grants" ADD CONSTRAINT "project_policy_session_grants_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_policy_session_grants" ADD CONSTRAINT "project_policy_session_grants_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_move_operations_source_idx" ON "chat_move_operations" USING btree ("owner_user_id","session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_policy_session_grants_source_idx" ON "project_policy_session_grants" USING btree ("owner_user_id","session_id","project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_move_operations_one_active" ON "chat_move_operations" ("owner_user_id","session_id") WHERE "state" IN ('freezing','ready','needs_attention');
--> statement-breakpoint
CREATE FUNCTION bump_session_project_assignment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.project_override_id, OLD.project_override_personal_project_id, OLD.automatic_personal_project_id)
     IS DISTINCT FROM
     (NEW.project_override_id, NEW.project_override_personal_project_id, NEW.automatic_personal_project_id) THEN
    NEW.project_assignment_version := OLD.project_assignment_version + 1;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sessions_project_assignment_version BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION bump_session_project_assignment_version();
--> statement-breakpoint
CREATE FUNCTION check_project_policy_session_grant_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_session sessions%ROWTYPE;
BEGIN
  SELECT * INTO source_session FROM sessions WHERE id=NEW.session_id AND owner_user_id=NEW.owner_user_id FOR UPDATE;
  IF NOT FOUND OR source_session.project_assignment_version<>NEW.mapping_version
     OR (CASE WHEN source_session.project_override_id IS NOT NULL
              THEN source_session.project_override_personal_project_id
              ELSE source_session.automatic_personal_project_id END) IS DISTINCT FROM NEW.project_id
     OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.owner_user_id=NEW.owner_user_id
         AND p.lifecycle='active' AND p.workspace_project_id IS NOT NULL
         AND p.team_backend_id=NEW.backend_id AND p.team_workspace_id=NEW.team_workspace_id)
     OR EXISTS (SELECT 1 FROM chat_move_operations o WHERE o.session_id=NEW.session_id
         AND o.owner_user_id=NEW.owner_user_id AND o.state IN ('freezing','ready','needs_attention')) THEN
    RAISE EXCEPTION 'Exact Project policy source mapping is unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_policy_grant_binding_before_insert BEFORE INSERT ON project_policy_session_grants
  FOR EACH ROW EXECUTE FUNCTION check_project_policy_session_grant_binding();
--> statement-breakpoint
CREATE FUNCTION reject_project_policy_grant_binding_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' OR (TG_OP='DELETE' AND
      EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND owner_user_id=OLD.owner_user_id) AND
      EXISTS (SELECT 1 FROM projects WHERE id=OLD.project_id AND owner_user_id=OLD.owner_user_id)) THEN
    RAISE EXCEPTION 'Project policy grant provenance is immutable' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE TRIGGER project_policy_grant_binding_immutable BEFORE UPDATE OR DELETE ON project_policy_session_grants
  FOR EACH ROW EXECUTE FUNCTION reject_project_policy_grant_binding_mutation();
