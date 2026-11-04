CREATE TABLE "pds_session_invariant_locks" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
LOCK TABLE conversation_source_artifacts, pds_logical_replicas IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE conflicts bigint;
BEGIN
  SELECT count(*) INTO conflicts
  FROM conversation_source_artifacts a
  JOIN pds_logical_replicas r ON r.local_session_id = a.session_id
  WHERE a.replica_role = 'origin_local';
  IF conflicts > 0 THEN
    RAISE EXCEPTION 'Cannot install PDS source authority guard: % conflicting artifact(s)', conflicts
      USING HINT = 'Inspect origin_local conversation_source_artifacts attached to pds_logical_replicas; resolve ownership deliberately before retrying.';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION koed_lock_pds_source_authority(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sessions WHERE id = target FOR KEY SHARE;
  INSERT INTO pds_session_invariant_locks AS l (session_id, revision) VALUES (target, 0)
  ON CONFLICT (session_id) DO UPDATE SET revision = l.revision + 1;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION koed_guard_pds_source_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.replica_role = 'origin_local' THEN
    PERFORM koed_lock_pds_source_authority(NEW.session_id);
    IF EXISTS (SELECT 1 FROM pds_logical_replicas WHERE local_session_id = NEW.session_id) THEN
      RAISE EXCEPTION 'Conversation source replica is read-only' USING ERRCODE = '23514', CONSTRAINT = 'pds_replica_source_authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION koed_guard_pds_replica_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.local_session_id IS NOT DISTINCT FROM OLD.local_session_id THEN
    RETURN NEW;
  END IF;
  IF NEW.local_session_id IS NOT NULL THEN
    PERFORM koed_lock_pds_source_authority(NEW.local_session_id);
    IF EXISTS (SELECT 1 FROM conversation_source_artifacts WHERE session_id = NEW.local_session_id AND replica_role = 'origin_local') THEN
      RAISE EXCEPTION 'Conversation source replica is read-only' USING ERRCODE = '23514', CONSTRAINT = 'pds_replica_source_authority';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pds_source_artifact_authority_guard BEFORE INSERT OR UPDATE OF session_id, replica_role ON conversation_source_artifacts FOR EACH ROW EXECUTE FUNCTION koed_guard_pds_source_artifact();
--> statement-breakpoint
CREATE TRIGGER pds_replica_source_authority_guard BEFORE INSERT OR UPDATE OF local_session_id ON pds_logical_replicas FOR EACH ROW EXECUTE FUNCTION koed_guard_pds_replica_source();
--> statement-breakpoint
CREATE FUNCTION koed_preserve_pds_replica_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.local_session_id IS NOT NULL AND (TG_OP = 'DELETE' OR NEW.local_session_id IS DISTINCT FROM OLD.local_session_id) THEN
    RAISE EXCEPTION 'Cannot remove or unlink an attached replica; explicit teardown is required'
      USING ERRCODE = '23514', CONSTRAINT = 'pds_replica_attachment_preserved';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pds_replica_attachment_guard BEFORE DELETE OR UPDATE OF local_session_id ON pds_logical_replicas FOR EACH ROW EXECUTE FUNCTION koed_preserve_pds_replica_attachment();
