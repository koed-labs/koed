ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_values_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" DROP CONSTRAINT "shared_memory_candidate_previews_hashes_check";--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "excluded_item_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "candidate_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD COLUMN "candidate_manifest_hash" text DEFAULT repeat('0',64) NOT NULL;--> statement-breakpoint
UPDATE "shared_memory_candidate_previews" candidate
SET "candidate_manifest" = coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'sourceId',(md5(candidate.id::text || ':' || ordinal::text)::uuid)::text,
          'revisionHash',repeat('0',64)
        ) order by ordinal
      )
      from generate_series(1,candidate.item_count) ordinal
    ),'[]'::jsonb),
    "invalidated_at" = coalesce("invalidated_at",now()),
    "invalidation_reason" = coalesce(
      "invalidation_reason",
      'candidate_manifest_migration_required'
    );--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ALTER COLUMN "candidate_manifest" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ALTER COLUMN "candidate_manifest_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_values_check" CHECK ("shared_memory_candidate_previews"."preview_revision" = 1
        and "shared_memory_candidate_previews"."authority_source" in ('browser_session','device_action_grant')
        and "shared_memory_candidate_previews"."source_revision" >= 0
        and "shared_memory_candidate_previews"."item_count" between 1 and 100
        and "shared_memory_candidate_previews"."excluded_item_count" >= 0
        and jsonb_typeof("shared_memory_candidate_previews"."candidate_manifest") = 'array'
        and jsonb_array_length("shared_memory_candidate_previews"."candidate_manifest") = "shared_memory_candidate_previews"."item_count"
        and "shared_memory_candidate_previews"."byte_count" between 1 and 262144
        and "shared_memory_candidate_previews"."representation_policy_revision" > 0
        and "shared_memory_candidate_previews"."content_policy_version" > 0
        and "shared_memory_candidate_previews"."classifier_version" > 0
        and "shared_memory_candidate_previews"."expires_at" > "shared_memory_candidate_previews"."created_at");--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_hashes_check" CHECK (length("shared_memory_candidate_previews"."preview_hash") = 64
        and length("shared_memory_candidate_previews"."candidate_manifest_hash") = 64
        and length("shared_memory_candidate_previews"."source_hash") = 64
        and length("shared_memory_candidate_previews"."redacted_content_hash") = 64
        and length("shared_memory_candidate_previews"."representation_policy_hash") = 64
        and length("shared_memory_candidate_previews"."content_policy_hash") = 64
        and length("shared_memory_candidate_previews"."classifier_hash") = 64);--> statement-breakpoint
CREATE FUNCTION invalidate_curated_representations_for_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH invalidated AS (
    UPDATE team_memory_representations representation
       SET state='invalidated',
           invalidated_at=coalesce(representation.invalidated_at,now()),
           invalidation_reason_code=coalesce(
             representation.invalidation_reason_code,
             'curated_evidence_ineligible'
           ),
           record_version=representation.record_version+1,
           updated_at=now()
      FROM team_session_share_grants share_grant,
           logical_memories memory
     WHERE share_grant.id=representation.share_grant_id
       AND memory.id=share_grant.logical_memory_id
       AND memory.local_session_id=NEW.session_id
       AND representation.representation='curated_assertions'
       AND representation.state IN ('pending','available','stale')
     RETURNING representation.id
  )
  DELETE FROM team_memory_semantic_items semantic_item
   USING invalidated
   WHERE semantic_item.representation_id=invalidated.id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER invalidate_curated_representations_on_conversation_item
AFTER UPDATE OF memory_excluded_at,personal_deleted_at ON conversation_items
FOR EACH ROW
WHEN (
  OLD.memory_excluded_at IS DISTINCT FROM NEW.memory_excluded_at
  OR OLD.personal_deleted_at IS DISTINCT FROM NEW.personal_deleted_at
)
EXECUTE FUNCTION invalidate_curated_representations_for_session();--> statement-breakpoint
CREATE TRIGGER invalidate_curated_representations_on_memory_event
AFTER UPDATE OF invalidated_at,personal_deleted_at ON memory_events
FOR EACH ROW
WHEN (
  OLD.invalidated_at IS DISTINCT FROM NEW.invalidated_at
  OR OLD.personal_deleted_at IS DISTINCT FROM NEW.personal_deleted_at
)
EXECUTE FUNCTION invalidate_curated_representations_for_session();--> statement-breakpoint
CREATE TRIGGER invalidate_curated_representations_on_memory_node
AFTER UPDATE OF invalidated_at,personal_deleted_at ON memory_nodes
FOR EACH ROW
WHEN (
  OLD.invalidated_at IS DISTINCT FROM NEW.invalidated_at
  OR OLD.personal_deleted_at IS DISTINCT FROM NEW.personal_deleted_at
)
EXECUTE FUNCTION invalidate_curated_representations_for_session();--> statement-breakpoint
CREATE FUNCTION invalidate_curated_representations_for_assertion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  WITH affected_sessions AS (
    SELECT item.session_id
      FROM curated_memory_sources source
      JOIN conversation_items item ON item.id=source.conversation_item_id
     WHERE source.assertion_id=NEW.id
    UNION
    SELECT event.session_id
      FROM curated_memory_sources source
      JOIN memory_events event ON event.id=source.memory_event_id
     WHERE source.assertion_id=NEW.id
    UNION
    SELECT node.session_id
      FROM curated_memory_sources source
      JOIN memory_nodes node ON node.id=source.lcm_node_id
     WHERE source.assertion_id=NEW.id
  ), invalidated AS (
    UPDATE team_memory_representations representation
       SET state='invalidated',
           invalidated_at=coalesce(representation.invalidated_at,now()),
           invalidation_reason_code=coalesce(
             representation.invalidation_reason_code,
             'curated_assertion_changed'
           ),
           record_version=representation.record_version+1,
           updated_at=now()
      FROM team_session_share_grants share_grant,
           logical_memories memory
     WHERE share_grant.id=representation.share_grant_id
       AND memory.id=share_grant.logical_memory_id
       AND memory.local_session_id IN (
         SELECT session_id FROM affected_sessions WHERE session_id IS NOT NULL
       )
       AND representation.representation='curated_assertions'
       AND representation.state IN ('pending','available','stale')
     RETURNING representation.id
  )
  DELETE FROM team_memory_semantic_items semantic_item
   USING invalidated
   WHERE semantic_item.representation_id=invalidated.id;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER invalidate_curated_representations_on_assertion
AFTER UPDATE OF assertion_text,normalized_assertion,status,sensitivity,confidence,
  tags,metadata,expires_at,observed_at,supersedes_assertion_id,
  superseded_by_assertion_id,conflict_with_assertion_id,suppressed_at ON curated_memory_assertions
FOR EACH ROW
EXECUTE FUNCTION invalidate_curated_representations_for_assertion();
