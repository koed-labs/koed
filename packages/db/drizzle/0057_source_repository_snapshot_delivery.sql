ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "source_repository_snapshot_hash" text;
--> statement-breakpoint
CREATE FUNCTION queue_source_repository_assignment() RETURNS trigger AS $$
BEGIN
  IF NEW.repository_assignment_version IS NOT DISTINCT FROM OLD.repository_assignment_version THEN
    RETURN NEW;
  END IF;
  INSERT INTO sync_outbox_entries(sync_relationship_id,idempotency_key,request_hash,payload_manifest)
  SELECT relationship.id,
    'repository-assignment:' || NEW.id::text || ':' || NEW.repository_assignment_version::text,
    encode(digest(relationship.id::text || ':' || NEW.id::text || ':' || NEW.repository_assignment_version::text,'sha256'),'hex'),
    jsonb_build_object('kind','repository_assignment','sessionId',NEW.id,'assignmentVersion',NEW.repository_assignment_version)
  FROM cross_identity_sync_relationships relationship
  JOIN memory_replicas replica ON replica.id=relationship.local_replica_id
  JOIN local_captured_session_logical_memories local_memory
    ON local_memory.logical_memory_id=relationship.logical_memory_id
    AND local_memory.owner_user_id=relationship.local_user_id
  WHERE relationship.side='source' AND relationship.revoked_at IS NULL
    AND relationship.state NOT IN ('revoked','purge_pending')
    AND replica.replica_role='source' AND replica.encryption_scope='personal'
    AND local_memory.local_session_id=NEW.id AND relationship.local_user_id=NEW.owner_user_id
  ON CONFLICT(sync_relationship_id,idempotency_key) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER source_repository_assignment_outbox AFTER UPDATE OF repository_assignment_version ON sessions
FOR EACH ROW EXECUTE FUNCTION queue_source_repository_assignment();
