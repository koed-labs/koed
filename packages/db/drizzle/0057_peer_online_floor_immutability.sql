UPDATE peer_online_sessions
SET checkpoint_sequence = NULL, checkpoint_hash = NULL
WHERE deletion_hash IS NOT NULL OR deletion IS NOT NULL;
--> statement-breakpoint
DELETE FROM peer_online_checkpoints c
USING peer_online_sessions s
WHERE s.group_id = c.group_id AND s.session_key = c.session_key
  AND (s.deletion_hash IS NOT NULL OR s.deletion IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION peer_online_session_floor_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.deletion_hash IS NOT NULL OR OLD.deletion IS NOT NULL THEN
      RAISE EXCEPTION 'peer online deletion floor is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND
     (NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.session_key IS DISTINCT FROM OLD.session_key) THEN
    RAISE EXCEPTION 'peer online deletion floor is immutable' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.deletion_hash IS NOT NULL OR OLD.deletion IS NOT NULL) THEN
    RAISE EXCEPTION 'peer online deletion floor is immutable' USING ERRCODE = '23514';
  END IF;

  IF (NEW.deletion_hash IS NULL) <> (NEW.deletion IS NULL) THEN
    RAISE EXCEPTION 'peer online deletion floor requires hash and record' USING ERRCODE = '23514';
  END IF;

  IF NEW.deletion_hash IS NOT NULL THEN
    DELETE FROM peer_online_checkpoints
    WHERE group_id = NEW.group_id AND session_key = NEW.session_key;
    NEW.checkpoint_sequence := NULL;
    NEW.checkpoint_hash := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_session_floor_guard
BEFORE INSERT OR UPDATE OR DELETE ON peer_online_sessions
FOR EACH ROW EXECUTE FUNCTION peer_online_session_floor_guard();
--> statement-breakpoint
CREATE FUNCTION peer_online_checkpoint_floor_guard() RETURNS trigger AS $$
DECLARE parent_deletion_hash text;
DECLARE parent_deletion text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'peer online checkpoint is immutable' USING ERRCODE = '23514';
  END IF;

  SELECT deletion_hash, deletion INTO parent_deletion_hash, parent_deletion
  FROM peer_online_sessions
  WHERE group_id = NEW.group_id AND session_key = NEW.session_key
  FOR UPDATE;

  IF parent_deletion_hash IS NOT NULL OR parent_deletion IS NOT NULL THEN
    RAISE EXCEPTION 'peer online checkpoint blocked by deletion floor' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_checkpoint_floor_guard
BEFORE INSERT OR UPDATE ON peer_online_checkpoints
FOR EACH ROW EXECUTE FUNCTION peer_online_checkpoint_floor_guard();
--> statement-breakpoint
CREATE FUNCTION peer_online_session_floor_truncate_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'peer online deletion floor is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_session_floor_truncate_guard
BEFORE TRUNCATE ON peer_online_sessions
FOR EACH STATEMENT EXECUTE FUNCTION peer_online_session_floor_truncate_guard();
--> statement-breakpoint
CREATE FUNCTION peer_online_checkpoint_truncate_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'peer online checkpoint history is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_checkpoint_truncate_guard
BEFORE TRUNCATE ON peer_online_checkpoints
FOR EACH STATEMENT EXECUTE FUNCTION peer_online_checkpoint_truncate_guard();
