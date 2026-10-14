ALTER TABLE "team_memory_share_grants" ADD COLUMN "repository_snapshot" jsonb DEFAULT '{"version":1,"classification":"unresolved","fingerprint":null,"label":null,"branchObservation":null}'::jsonb NOT NULL;
--> statement-breakpoint
-- Preserve existing view column positions and append the new routing snapshot.
DO $$
DECLARE grant_columns text;
BEGIN
  SELECT string_agg('grant_row.' || quote_ident(attname), ', ' ORDER BY attnum)
    INTO grant_columns FROM pg_attribute
   WHERE attrelid='team_memory_share_grant_records'::regclass AND attnum>0 AND NOT attisdropped
     AND attname NOT IN ('source_kind','source_session_id','source_note_id','source_memory_event_id','repository_snapshot');
  EXECUTE 'CREATE OR REPLACE VIEW team_memory_share_grant_records AS SELECT ' || grant_columns ||
    ', binding.source_kind,binding.source_session_id,binding.source_note_id,binding.source_memory_event_id,grant_row.repository_snapshot
     FROM team_memory_share_grants grant_row
     JOIN logical_memory_source_revision_bindings binding ON binding.source_revision_id=grant_row.source_revision_id';
END $$;
