ALTER TABLE personal_configuration_records DROP CONSTRAINT personal_configuration_record_kind_check;
--> statement-breakpoint
ALTER TABLE personal_configuration_records ADD CONSTRAINT personal_configuration_record_kind_check CHECK(payload_kind IN ('source_context','project_membership','project_default'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_personal_membership_entity() RETURNS trigger AS $$
DECLARE
  retained_head_count integer;
  user_head_count integer;
  automatic_source_count integer;
  selected_revision_id text;
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.project_identity IS DISTINCT FROM OLD.project_identity
    OR NEW.entity_identity IS DISTINCT FROM OLD.entity_identity
    OR NEW.entity_kind IS DISTINCT FROM OLD.entity_kind
    OR NEW.selector_key IS DISTINCT FROM OLD.selector_key
    OR (OLD.local_project_id IS NOT NULL AND NEW.local_project_id IS NOT NULL AND NEW.local_project_id IS DISTINCT FROM OLD.local_project_id)
    OR (OLD.local_entity_id IS NOT NULL AND NEW.local_entity_id IS NOT NULL AND NEW.local_entity_id IS DISTINCT FROM OLD.local_entity_id)
    OR (OLD.source_binding_id IS NOT NULL AND NEW.source_binding_id IS NOT NULL AND NEW.source_binding_id IS DISTINCT FROM OLD.source_binding_id)
  ) THEN RAISE EXCEPTION 'Portable membership identity and selector are immutable'; END IF;
  IF (NEW.state='available' AND (cardinality(NEW.heads)<1 OR NEW.current_revision IS NULL))
    OR (NEW.state<>'available' AND NEW.current_revision IS NOT NULL)
    OR (NEW.state='conflict' AND cardinality(NEW.heads)<2) THEN
    RAISE EXCEPTION 'Membership state does not match its causal frontier';
  END IF;
  IF NEW.state='available' AND NOT EXISTS (
    SELECT 1 FROM personal_membership_revisions r WHERE r.owner_user_id=NEW.owner_user_id
      AND r.project_identity=NEW.project_identity AND r.entity_identity=NEW.entity_identity
      AND r.revision_id=ANY(NEW.heads) AND r.revision=NEW.current_revision
  ) THEN RAISE EXCEPTION 'Membership view requires its retained causal revision'; END IF;
  IF NEW.state='available' AND cardinality(NEW.heads)>1 THEN
    SELECT count(*),count(*) FILTER(WHERE NOT (r.revision ? 'automaticDefault') AND NOT (r.revision ? 'automaticRetirement')),
      count(DISTINCT coalesce(r.revision->'automaticDefault'->>'sourceKey',r.revision->'automaticRetirement'->>'sourceKey'))
      INTO retained_head_count,user_head_count,automatic_source_count
      FROM personal_membership_revisions r WHERE r.owner_user_id=NEW.owner_user_id
      AND r.project_identity=NEW.project_identity AND r.entity_identity=NEW.entity_identity AND r.revision_id=ANY(NEW.heads);
    IF retained_head_count<>cardinality(NEW.heads) OR user_head_count>1 OR automatic_source_count<>1 THEN
      RAISE EXCEPTION 'Available membership cannot hide concurrent User intent';
    END IF;
    SELECT r.revision_id INTO selected_revision_id FROM personal_membership_revisions r
      WHERE r.owner_user_id=NEW.owner_user_id AND r.project_identity=NEW.project_identity AND r.entity_identity=NEW.entity_identity AND r.revision_id=ANY(NEW.heads)
      ORDER BY CASE WHEN NOT (r.revision ? 'automaticDefault') AND NOT (r.revision ? 'automaticRetirement') THEN 0
        WHEN r.revision ? 'automaticRetirement' THEN 1 ELSE 2 END, r.revision_id COLLATE "C" LIMIT 1;
    IF NEW.current_revision->>'revisionId' IS DISTINCT FROM selected_revision_id THEN
      RAISE EXCEPTION 'Membership automatic frontier must use its deterministic retained revision';
    END IF;
  END IF;
  IF NEW.local_project_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM personal_named_projects p WHERE p.owner_user_id=NEW.owner_user_id AND p.project_id=NEW.local_project_id
  ) THEN RAISE EXCEPTION 'Native membership Project belongs to another owner or is unavailable'; END IF;
  IF NEW.source_binding_id IS NOT NULL AND (NEW.entity_kind NOT IN ('direct','exclusion') OR NOT EXISTS (
    SELECT 1 FROM personal_source_bindings b WHERE b.binding_id=NEW.source_binding_id AND b.owner_user_id=NEW.owner_user_id
      AND b.originating_deployment_id=NEW.selector_key::jsonb->'source'->>'originatingDeploymentId'
      AND b.originating_device_id=NEW.selector_key::jsonb->'source'->>'originatingDeviceId'
      AND b.source_logical_session_id=NEW.selector_key::jsonb->'source'->>'logicalSessionId'
  )) THEN RAISE EXCEPTION 'Membership source binding does not match its owned canonical source'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
