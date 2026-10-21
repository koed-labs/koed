-- Reads retain each publication's approved policy bindings while a versioned
-- consent targets a newer rule detail. Current consent/rule caps still gate
-- disclosure; publication records and their provenance remain immutable.
-- Use the base representation row and one exact source binding. Joining the
-- representation-record view here would expand that binding a second time in
-- every authorization query and cause expensive UNION branch planning.
DO $$
DECLARE retained_columns text;
BEGIN
  SELECT string_agg(format('g.%I',attname),',' ORDER BY attnum)
    INTO retained_columns FROM pg_attribute
   WHERE attrelid='team_memory_reason_grant_records'::regclass AND attnum>0 AND NOT attisdropped
     AND attname NOT IN (
       'source_revision_id','source_revision',
       'source_owner_policy_id','source_owner_policy_version',
       'team_policy_id','team_policy_version','workspace_policy_id','workspace_policy_version',
       'fidelity_policy_revision','content_policy_version','classifier_version',
       'source_kind','source_session_id','source_note_id','source_memory_event_id'
     );
  EXECUTE 'CREATE VIEW team_memory_publication_grant_records AS
    SELECT ' || retained_columns || ',
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_revision_id ELSE g.source_revision_id END AS source_revision_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_revision ELSE g.source_revision END AS source_revision,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_owner_policy_id ELSE g.source_owner_policy_id END AS source_owner_policy_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.source_owner_policy_version ELSE g.source_owner_policy_version END AS source_owner_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.team_policy_id ELSE g.team_policy_id END AS team_policy_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.team_policy_version ELSE g.team_policy_version END AS team_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.workspace_policy_id ELSE g.workspace_policy_id END AS workspace_policy_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.workspace_policy_version ELSE g.workspace_policy_version END AS workspace_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.fidelity_policy_revision ELSE g.fidelity_policy_revision END AS fidelity_policy_revision,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.content_policy_version ELSE g.content_policy_version END AS content_policy_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN r.classifier_version ELSE g.classifier_version END AS classifier_version,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_kind ELSE g.source_kind END AS source_kind,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_session_id ELSE g.source_session_id END AS source_session_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_note_id ELSE g.source_note_id END AS source_note_id,
      CASE WHEN g.sharing_reason_kind=''rule'' THEN source_binding.source_memory_event_id ELSE g.source_memory_event_id END AS source_memory_event_id,
      r.id AS publication_representation_id
    FROM team_memory_reason_grant_records g
    JOIN team_memory_reason_publications publication
      ON publication.reason_id=g.sharing_reason_id AND publication.share_grant_id=g.id
      AND publication.consent_id=g.consent_id
    JOIN team_memory_representations r
      ON r.id=publication.representation_id AND r.share_grant_id=g.id
      AND r.consent_id=g.consent_id AND r.logical_memory_id=g.logical_memory_id
      AND r.team_id=g.team_id AND r.team_workspace_id=g.team_workspace_id
    JOIN logical_memory_source_revision_bindings source_binding
      ON source_binding.source_revision_id=r.source_revision_id
      AND source_binding.logical_memory_id=g.logical_memory_id
      AND source_binding.owner_principal_id=g.owner_principal_id
      AND source_binding.source_kind=g.source_kind';
END $$;
