CREATE TABLE personal_project_defaults (
  owner_user_id uuid NOT NULL CONSTRAINT personal_project_defaults_owner_user_id_users_id_fk REFERENCES users(id),
  source_key text NOT NULL,
  source_scope text NOT NULL,
  target jsonb NOT NULL,
  state text NOT NULL CONSTRAINT personal_project_defaults_state_check CHECK(state IN ('initialized','managed','suppressed','retired')),
  project_id uuid,
  seed_rule_id uuid,
  initial_project_revision_id uuid,
  initial_rule_revision_id uuid,
  revision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_project_defaults_pkey PRIMARY KEY(owner_user_id,source_key),
  UNIQUE(owner_user_id,source_scope),
  CONSTRAINT personal_project_defaults_project_owner_fk FOREIGN KEY(owner_user_id,project_id) REFERENCES personal_named_projects(owner_user_id,project_id),
  CONSTRAINT personal_project_defaults_target_check CHECK(jsonb_typeof(target)='object'),
  CONSTRAINT personal_project_defaults_initialization_check CHECK(state<>'initialized' OR (project_id IS NOT NULL AND seed_rule_id IS NOT NULL AND initial_project_revision_id IS NOT NULL AND initial_rule_revision_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE personal_project_default_reconciliation (
  owner_user_id uuid PRIMARY KEY CONSTRAINT personal_project_default_reconciliation_owner_user_id_users_id_fk REFERENCES users(id),
  generation bigint NOT NULL DEFAULT 1,
  scan_generation bigint,
  after_session_id uuid,
  pending boolean NOT NULL DEFAULT true,
  retry_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION schedule_personal_project_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL THEN
    INSERT INTO personal_project_default_reconciliation(owner_user_id) VALUES(NEW.owner_user_id)
    ON CONFLICT(owner_user_id) DO UPDATE SET generation=personal_project_default_reconciliation.generation+1,pending=true,retry_at=now(),updated_at=now();
    PERFORM pg_notify('koed_project_defaults','source_changed');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER personal_project_defaults_capture AFTER INSERT OR UPDATE OF repository_automatic_identity,repository_override_identity,folder_assignment ON sessions FOR EACH ROW EXECUTE FUNCTION schedule_personal_project_defaults();
--> statement-breakpoint
CREATE TRIGGER personal_project_defaults_binding AFTER INSERT OR UPDATE OF availability ON personal_source_bindings FOR EACH ROW EXECUTE FUNCTION schedule_personal_project_defaults();
--> statement-breakpoint
CREATE TRIGGER personal_project_defaults_replica AFTER INSERT OR UPDATE OF materialization_state ON pds_logical_replicas FOR EACH ROW EXECUTE FUNCTION schedule_personal_project_defaults();
--> statement-breakpoint
INSERT INTO personal_project_default_reconciliation(owner_user_id) SELECT DISTINCT s.owner_user_id FROM sessions s JOIN users u ON u.id=s.owner_user_id WHERE u.disabled_at IS NULL AND u.deleted_at IS NULL;
