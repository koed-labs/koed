ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'project_changed' BEFORE 'access_revoked';--> statement-breakpoint
CREATE TABLE "shared_memory_source_admission" (
	"logical_memory_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"held_batch_id" uuid,
	"held_at" timestamp with time zone,
	"sealed_at" timestamp with time zone,
	"hold_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_memory_source_admission_generation_check" CHECK ("shared_memory_source_admission"."generation" >= 0 and "shared_memory_source_admission"."hold_version" >= 0),
	CONSTRAINT "shared_memory_source_admission_hold_shape_check" CHECK (("shared_memory_source_admission"."held_batch_id" is null and "shared_memory_source_admission"."held_at" is null and "shared_memory_source_admission"."sealed_at" is null)
      or ("shared_memory_source_admission"."held_batch_id" is not null and "shared_memory_source_admission"."held_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD COLUMN "source_admission_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_work_items" ADD COLUMN "delete_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "creation_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "creation_payload_hash" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_phase" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "projects" SET "deletion_phase"='complete' WHERE "lifecycle"='deleted';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "trashed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "delete_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "source_admission_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_source_previews" ADD COLUMN "source_admission_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_source_admission" ADD CONSTRAINT "shared_memory_source_admission_owner_fk" FOREIGN KEY ("logical_memory_id","owner_user_id") REFERENCES "public"."logical_memories"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_creation_idempotency_unique" UNIQUE("owner_user_id","creation_idempotency_key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deletion_generation_nonnegative" CHECK ("projects"."deletion_generation" >= 0);--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_deletion_phase_check" CHECK (("projects"."deletion_phase" is null and "projects"."lifecycle" = 'active')
        or ("projects"."deletion_phase" in ('preparing','freezing','stopping','ready')
          and "projects"."lifecycle" = 'active' and "projects"."delete_batch_id" is not null)
        or ("projects"."deletion_phase" = 'complete' and "projects"."lifecycle" = 'deleted'));
--> statement-breakpoint
-- Every admission path creates and locks the same row, including a source with
-- no previous grant. A missing-row SELECT would allow first-grant races.
CREATE OR REPLACE FUNCTION koed_lock_source_admission(p_logical_memory_id uuid)
RETURNS TABLE(generation bigint, held_batch_id uuid)
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO shared_memory_source_admission (logical_memory_id,owner_user_id)
  SELECT id,owner_user_id FROM logical_memories WHERE id=p_logical_memory_id
  ON CONFLICT (logical_memory_id) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM shared_memory_source_admission
     WHERE logical_memory_id=p_logical_memory_id
  ) THEN
    RAISE EXCEPTION 'Unknown source admission identity' USING ERRCODE='23503';
  END IF;
  RETURN QUERY SELECT a.generation,a.held_batch_id
    FROM shared_memory_source_admission a
   WHERE a.logical_memory_id=p_logical_memory_id FOR SHARE;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_bind_candidate_admission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_generation bigint; v_held uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id
       OR NEW.source_admission_generation IS DISTINCT FROM OLD.source_admission_generation THEN
      RAISE EXCEPTION 'Source admission preview binding is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT generation,held_batch_id INTO v_generation,v_held
    FROM koed_lock_source_admission(NEW.logical_memory_id);
  IF v_held IS NOT NULL THEN
    RAISE EXCEPTION 'Source admission is held' USING ERRCODE='55000';
  END IF;
  NEW.source_admission_generation:=v_generation;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER candidate_preview_source_admission
BEFORE INSERT OR UPDATE ON shared_memory_candidate_previews
FOR EACH ROW EXECUTE FUNCTION koed_bind_candidate_admission();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_bind_source_preview_admission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_generation bigint; v_held uuid;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id
       OR NEW.source_admission_generation IS DISTINCT FROM OLD.source_admission_generation THEN
      RAISE EXCEPTION 'Source admission preview binding is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT generation,held_batch_id INTO v_generation,v_held
    FROM koed_lock_source_admission(NEW.logical_memory_id);
  IF v_held IS NOT NULL THEN
    RAISE EXCEPTION 'Source admission is held' USING ERRCODE='55000';
  END IF;
  NEW.source_admission_generation:=v_generation;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER source_preview_source_admission
BEFORE INSERT OR UPDATE ON shared_source_previews
FOR EACH ROW EXECUTE FUNCTION koed_bind_source_preview_admission();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_guard_pending_share_admission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_generation bigint; v_held uuid; v_preview_generation bigint;
BEGIN
  IF TG_OP='UPDATE' AND NEW.source_admission_generation IS DISTINCT FROM OLD.source_admission_generation THEN
    RAISE EXCEPTION 'Pending Share admission generation is immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='INSERT' OR
     (TG_OP='UPDATE' AND (
       (NEW.state='activated' AND OLD.state IS DISTINCT FROM 'activated')
       OR NEW.replacement_preview_id IS DISTINCT FROM OLD.replacement_preview_id
       OR (NEW.state='preparing' AND OLD.state='activated')
     )) THEN
    SELECT generation,held_batch_id INTO v_generation,v_held
      FROM koed_lock_source_admission(NEW.logical_memory_id);
    SELECT source_admission_generation INTO v_preview_generation
      FROM shared_memory_candidate_previews
      WHERE id=coalesce(NEW.replacement_preview_id,NEW.preview_id)
        AND logical_memory_id=NEW.logical_memory_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pending Share source preview is unavailable' USING ERRCODE='55000';
    END IF;
    IF TG_OP='INSERT' THEN
      NEW.source_admission_generation:=v_preview_generation;
    END IF;
    IF v_held IS NOT NULL OR v_generation IS DISTINCT FROM v_preview_generation
       OR v_preview_generation IS DISTINCT FROM NEW.source_admission_generation THEN
      RAISE EXCEPTION 'Pending Share source admission changed' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pending_share_source_admission
BEFORE INSERT OR UPDATE ON pending_share_operations
FOR EACH ROW EXECUTE FUNCTION koed_guard_pending_share_admission();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_guard_grant_admission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_generation bigint; v_held uuid; v_pending_generation bigint;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.logical_memory_id IS DISTINCT FROM NEW.logical_memory_id
      OR OLD.logical_grant_id IS DISTINCT FROM NEW.logical_grant_id) THEN
    RAISE EXCEPTION 'Share Grant source identity is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.logical_memory_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' OR
     (TG_OP='UPDATE' AND NEW.lifecycle='active' AND (
       OLD.lifecycle IS DISTINCT FROM 'active'
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)
       OR (OLD.frozen_at IS NOT NULL AND NEW.frozen_at IS NULL)
       OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id
       OR OLD.team_id IS DISTINCT FROM NEW.team_id
       OR OLD.team_workspace_id IS DISTINCT FROM NEW.team_workspace_id
       OR OLD.consent_id IS DISTINCT FROM NEW.consent_id
     )) THEN
    SELECT generation,held_batch_id INTO v_generation,v_held
      FROM koed_lock_source_admission(NEW.logical_memory_id);
    SELECT candidate.source_admission_generation INTO v_pending_generation
      FROM pending_share_operations pending
      JOIN shared_memory_candidate_previews candidate
        ON candidate.id=coalesce(pending.replacement_preview_id,pending.preview_id)
       AND candidate.logical_memory_id=pending.logical_memory_id
     WHERE pending.logical_grant_id=NEW.logical_grant_id
       AND pending.logical_memory_id=NEW.logical_memory_id;
    IF v_held IS NOT NULL OR
       (FOUND AND v_pending_generation IS DISTINCT FROM v_generation) OR
       (NOT FOUND AND v_generation<>0) THEN
      RAISE EXCEPTION 'Share Grant source admission changed' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER grant_source_admission
BEFORE INSERT OR UPDATE ON team_memory_share_grants
FOR EACH ROW EXECUTE FUNCTION koed_guard_grant_admission();
--> statement-breakpoint
CREATE TABLE "project_delete_operations" (
	"batch_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"source_manifest" jsonb NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"execution_manifest" jsonb NOT NULL,
	"execution_set_hash" text NOT NULL,
	"backend_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_freeze_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runtime_acks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_delete_operations_project_batch_unique" UNIQUE("project_id","batch_id"),
	CONSTRAINT "project_delete_operations_state_check" CHECK ("project_delete_operations"."state" in ('preparing','freezing','stopping','ready','complete','cancelled','needs_attention','restore_releasing','restored')),
	CONSTRAINT "project_delete_operations_manifest_hash_check" CHECK (length("project_delete_operations"."source_manifest_hash")=64 and length("project_delete_operations"."execution_set_hash")=64)
);
--> statement-breakpoint
ALTER TABLE "project_delete_operations" ADD CONSTRAINT "project_delete_operations_project_fk" FOREIGN KEY ("project_id","owner_user_id") REFERENCES "public"."projects"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_delete_operations_owner_idx" ON "project_delete_operations" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "project_lifecycle_schema_capabilities" DROP CONSTRAINT "project_lifecycle_schema_capabilities_state_check";
--> statement-breakpoint
ALTER TABLE "project_lifecycle_schema_capabilities" ADD CONSTRAINT "project_lifecycle_schema_capabilities_state_check" CHECK (("project_lifecycle_schema_capabilities"."capability" in ('workspace_projects','project_sources','project_source_notes','project_decks','project_scheduled_jobs','project_hq_sections')
        and (("project_lifecycle_schema_capabilities"."state" = 'absent' and "project_lifecycle_schema_capabilities"."enabled_at" is null)
          or ("project_lifecycle_schema_capabilities"."state" = 'enabled' and "project_lifecycle_schema_capabilities"."enabled_at" is not null))));
--> statement-breakpoint
INSERT INTO project_lifecycle_schema_capabilities (capability,state,enabled_at)
VALUES ('project_sources','absent',null),
       ('project_source_notes','absent',null),
       ('project_decks','absent',null),
       ('project_scheduled_jobs','absent',null),
       ('project_hq_sections','absent',null);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_guard_project_session_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_project uuid; new_project uuid; unavailable integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.automatic_personal_project_id IS NOT DISTINCT FROM OLD.automatic_personal_project_id
       AND NEW.project_override_id IS NOT DISTINCT FROM OLD.project_override_id
       AND NEW.project_override_personal_project_id IS NOT DISTINCT FROM OLD.project_override_personal_project_id THEN
      RETURN NEW;
    END IF;
    old_project:=CASE WHEN OLD.project_override_id IS NOT NULL
      THEN OLD.project_override_personal_project_id ELSE OLD.automatic_personal_project_id END;
  END IF;
  new_project:=CASE WHEN NEW.project_override_id IS NOT NULL
    THEN NEW.project_override_personal_project_id ELSE NEW.automatic_personal_project_id END;
  SELECT count(*) INTO unavailable
    FROM (SELECT lifecycle,deletion_phase FROM projects
           WHERE owner_user_id=NEW.owner_user_id
             AND id=ANY(array_remove(ARRAY[old_project,new_project],NULL))
           ORDER BY id FOR SHARE) locked
   WHERE lifecycle<>'active' OR deletion_phase IS NOT NULL;
  IF unavailable>0 THEN
    RAISE EXCEPTION 'Project assignment is unavailable during deletion' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER session_project_assignment_lifecycle
BEFORE INSERT OR UPDATE OF automatic_personal_project_id,project_override_id,project_override_personal_project_id ON sessions
FOR EACH ROW EXECUTE FUNCTION koed_guard_project_session_assignment();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_guard_project_local_context_assignment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unavailable integer;
DECLARE old_project uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    old_project:=OLD.project_id;
  END IF;
  SELECT count(*) INTO unavailable
    FROM (SELECT id,lifecycle,deletion_phase FROM projects
           WHERE owner_user_id=NEW.owner_user_id
             AND id=ANY(array_remove(ARRAY[old_project,NEW.project_id],NULL))
           ORDER BY id FOR SHARE) locked
   WHERE (id=NEW.project_id AND (lifecycle<>'active' OR deletion_phase IS NOT NULL))
      OR (id=old_project AND lifecycle='active' AND deletion_phase IS NOT NULL);
  IF unavailable>0 THEN
    RAISE EXCEPTION 'Local Project context is unavailable during deletion' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER local_context_project_assignment_lifecycle
BEFORE INSERT OR UPDATE OF project_id ON project_local_contexts
FOR EACH ROW EXECUTE FUNCTION koed_guard_project_local_context_assignment();
