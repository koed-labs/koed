-- Assignment edits are owner state; source records and origin provenance remain immutable.
CREATE OR REPLACE FUNCTION pds_reject_closed_source_mutation() RETURNS trigger AS $$
DECLARE
  replica_id text;
  append_start text;
  append_end text;
  is_replica_session boolean;
  mutable_columns text[];
  old_metadata jsonb;
  new_metadata jsonb;
  trusted_assignment boolean;
BEGIN
  IF TG_TABLE_NAME = 'pds_session_closures' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
      OR NEW.source_sequence IS DISTINCT FROM OLD.source_sequence
      OR NEW.publication_kind IS DISTINCT FROM OLD.publication_kind
      OR NEW.checkpoint_ordinal IS DISTINCT FROM OLD.checkpoint_ordinal
      OR NEW.terminal_cursor IS DISTINCT FROM OLD.terminal_cursor
      OR NEW.terminal_item_count IS DISTINCT FROM OLD.terminal_item_count
      OR NEW.source_closure_hash IS DISTINCT FROM OLD.source_closure_hash
      OR NEW.package_id IS DISTINCT FROM OLD.package_id
      OR NEW.source_manifest_hash IS DISTINCT FROM OLD.source_manifest_hash
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'PDS Session closure publication is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'sessions' AND TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT r.id::text INTO replica_id FROM pds_logical_replicas r WHERE r.local_session_id = OLD.id;
    IF replica_id IS NOT NULL THEN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PDS replica Sessions are read-only'; END IF;
      mutable_columns := ARRAY['metadata','updated_at','repository_override_identity','repository_assignment_version',
        'project_override_id','project_override_name','project_override_path','project_override_at','project_override_by_user_id'];
      trusted_assignment := current_setting('koed.pds_replica_append_id',true) IS NOT DISTINCT FROM replica_id;
      old_metadata := OLD.metadata - ARRAY['threadName','threadNameSource','threadNameGeneratedAt','threadNameEditedAt'];
      new_metadata := NEW.metadata - ARRAY['threadName','threadNameSource','threadNameGeneratedAt','threadNameEditedAt'];
      IF current_setting('koed.repository_assignment_cutover',true) = '1'
        AND NEW.repository_assignment_state='historical_unresolved'
        AND NEW.repository_automatic_identity IS NULL AND NEW.repository_override_identity IS NULL
        AND NEW.repository_assignment_version=OLD.repository_assignment_version+1 THEN
        mutable_columns := mutable_columns || ARRAY['repository_assignment_state','repository_automatic_identity'];
      END IF;
      IF trusted_assignment THEN
        mutable_columns := mutable_columns || ARRAY['repository_assignment_state','repository_automatic_identity'];
        old_metadata := old_metadata #- '{pds,repositoryAssignment}';
        new_metadata := new_metadata #- '{pds,repositoryAssignment}';
      END IF;
      IF (to_jsonb(NEW)-mutable_columns) IS DISTINCT FROM (to_jsonb(OLD)-mutable_columns)
        OR new_metadata IS DISTINCT FROM old_metadata THEN
        RAISE EXCEPTION 'PDS replica Sessions are read-only';
      END IF;
    END IF;
    RETURN COALESCE(NEW,OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('pds-session:' || NEW.session_id::text));
    SELECT EXISTS (
      SELECT 1 FROM pds_logical_replicas r WHERE r.local_session_id = NEW.session_id
    ) INTO is_replica_session;
    IF is_replica_session THEN
      SELECT r.id::text INTO replica_id
      FROM pds_logical_replicas r WHERE r.local_session_id = NEW.session_id;
      append_start := current_setting('koed.pds_replica_append_start', true);
      append_end := current_setting('koed.pds_replica_append_end', true);
      IF current_setting('koed.pds_replica_append_id', true) IS DISTINCT FROM replica_id
        OR NEW.source_transport <> 'pds_relay'
        OR NEW.source_sequence IS NULL
        OR append_start IS NULL OR append_end IS NULL
        OR NEW.source_sequence::numeric < append_start::numeric
        OR NEW.source_sequence::numeric > append_end::numeric THEN
        RAISE EXCEPTION 'PDS replica Sessions accept only trusted checkpoint appends';
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pds_session_closures c
      WHERE c.source_session_id = NEW.session_id
        AND c.publication_kind = 'closed' AND c.state = 'ready'
    ) THEN
      RAISE EXCEPTION 'PDS closed source Session cannot accept later items';
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT EXISTS (
      SELECT 1 FROM pds_logical_replicas r WHERE r.local_session_id = OLD.session_id
    ) INTO is_replica_session;
    IF is_replica_session OR EXISTS (
      SELECT 1 FROM pds_source_item_mappings m WHERE m.conversation_item_id = OLD.id
    ) THEN
      IF TG_OP = 'DELETE' OR (
        to_jsonb(NEW) - ARRAY[
          'projection_status', 'projection_work_class', 'projection_version',
          'projection_policy_revision', 'projected_at', 'projection_error',
          'memory_excluded_at', 'memory_exclusion_reason', 'memory_excluded_by_user_id',
          'personal_deleted_at', 'personal_deleted_by_user_id', 'personal_deletion_reason'
        ]::text[]
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'projection_status', 'projection_work_class', 'projection_version',
          'projection_policy_revision', 'projected_at', 'projection_error',
          'memory_excluded_at', 'memory_exclusion_reason', 'memory_excluded_by_user_id',
          'personal_deleted_at', 'personal_deleted_by_user_id', 'personal_deletion_reason'
        ]::text[]
      ) THEN
        RAISE EXCEPTION 'PDS source items are read-only';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
