-- Legacy Curated copies predate assertion scope. Withdraw their semantic
-- routes in this backend's migration transaction before making the new
-- unscoped default authoritative. Existing share grants are untouched.
DO $$
DECLARE source_row record;
BEGIN
  FOR source_row IN
    SELECT DISTINCT logical_memory_id FROM team_memory_representations
    WHERE representation::text='curated_assertions' AND logical_memory_id IS NOT NULL
    ORDER BY logical_memory_id
  LOOP
    PERFORM koed_lock_shared_memory_publication_fence(source_row.logical_memory_id);
  END LOOP;
END $$;--> statement-breakpoint
INSERT INTO team_memory_curated_item_eligibility (
  semantic_item_id,representation_id,share_grant_id,team_id,
  team_workspace_id,logical_memory_id,pseudonymous_source_id,
  pinned_revision_hash,blocked_at
)
SELECT item.id,item.representation_id,item.share_grant_id,item.team_id,
       item.team_workspace_id,item.logical_memory_id,item.pseudonymous_source_id,
       null,now()
FROM team_memory_semantic_items item
JOIN team_memory_representations representation
  ON representation.id=item.representation_id
WHERE representation.representation::text='curated_assertions'
ON CONFLICT (semantic_item_id) DO UPDATE
  SET blocked_at=now(),updated_at=now();--> statement-breakpoint
-- A Curated withdrawal may narrow one item inside an otherwise retained frozen
-- snapshot. Permit vector deletion only after that exact item is blocked.
CREATE OR REPLACE FUNCTION koed_team_memory_semantic_vector_publication_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_item_id uuid;
  v_logical_memory_id uuid;
  v_is_frozen_snapshot boolean;
  v_frozen_at timestamptz;
  v_lifecycle text;
  v_embedding_state text;
  v_curated_blocked boolean;
BEGIN
  v_item_id := CASE WHEN TG_OP='DELETE' THEN OLD.semantic_item_id ELSE NEW.semantic_item_id END;
  SELECT item.logical_memory_id INTO v_logical_memory_id
    FROM team_memory_semantic_items item WHERE item.id=v_item_id;
  IF v_logical_memory_id IS NOT NULL THEN
    PERFORM koed_lock_shared_memory_publication_fence(v_logical_memory_id);
  END IF;
  SELECT representation.frozen_snapshot,grant_row.frozen_at,
         grant_row.lifecycle,item.embedding_state,
         (representation.representation::text='curated_assertions'
           AND EXISTS (
             SELECT 1 FROM team_memory_curated_item_eligibility eligibility
              WHERE eligibility.semantic_item_id=item.id
                AND eligibility.blocked_at IS NOT NULL))
    INTO v_is_frozen_snapshot,v_frozen_at,v_lifecycle,v_embedding_state,
         v_curated_blocked
    FROM team_memory_semantic_items item
    JOIN team_memory_representations representation
      ON representation.id=item.representation_id
    JOIN team_memory_share_grants grant_row ON grant_row.id=item.share_grant_id
   WHERE item.id=v_item_id;
  IF v_is_frozen_snapshot AND v_frozen_at IS NOT NULL THEN
    IF TG_OP IN ('INSERT','UPDATE') THEN
      IF TG_OP='UPDATE' OR v_lifecycle <> 'active' OR
         v_embedding_state <> 'processing' THEN
        RAISE EXCEPTION 'Frozen Shared Memory vectors require an active embedding lease'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;
    IF v_lifecycle NOT IN ('revoked','purge_pending','purged') AND
       (v_lifecycle <> 'active' OR v_embedding_state <> 'processing') AND
       NOT coalesce(v_curated_blocked,false) THEN
      RAISE EXCEPTION 'Frozen Shared Memory vectors can be deleted only by revocation or retention'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DELETE FROM team_memory_semantic_vectors_384 vector_row
USING team_memory_semantic_items item,team_memory_representations representation
WHERE vector_row.semantic_item_id=item.id
  AND item.representation_id=representation.id
  AND representation.representation::text='curated_assertions';--> statement-breakpoint
DELETE FROM team_memory_semantic_vectors_1024 vector_row
USING team_memory_semantic_items item,team_memory_representations representation
WHERE vector_row.semantic_item_id=item.id
  AND item.representation_id=representation.id
  AND representation.representation::text='curated_assertions';--> statement-breakpoint
DELETE FROM team_memory_semantic_vectors_1536 vector_row
USING team_memory_semantic_items item,team_memory_representations representation
WHERE vector_row.semantic_item_id=item.id
  AND item.representation_id=representation.id
  AND representation.representation::text='curated_assertions';--> statement-breakpoint
DELETE FROM team_memory_semantic_vectors_3072 vector_row
USING team_memory_semantic_items item,team_memory_representations representation
WHERE vector_row.semantic_item_id=item.id
  AND item.representation_id=representation.id
  AND representation.representation::text='curated_assertions';--> statement-breakpoint
UPDATE team_memory_representations
   SET state='invalidated',invalidated_at=coalesce(invalidated_at,now()),
       invalidation_reason_code='curated_scope_backfill',
       record_version=record_version+1,updated_at=now()
 WHERE representation::text='curated_assertions'
   AND state IN ('pending','available','stale');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_author_kind" AS ENUM('user', 'agent');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_kind" AS ENUM('decision', 'fact', 'learning', 'preference');--> statement-breakpoint
CREATE TYPE "public"."curated_memory_scope" AS ENUM('me', 'project', 'unscoped');--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD COLUMN "scope" "curated_memory_scope" DEFAULT 'unscoped' NOT NULL;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD COLUMN "kind" "curated_memory_kind";--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD COLUMN "author_kind" "curated_memory_author_kind";--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD COLUMN "author_ref" text;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_owner_project_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."projects"("owner_user_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_project_scope_check" CHECK (("curated_memory_assertions"."scope" = 'project') = ("curated_memory_assertions"."project_id" is not null));--> statement-breakpoint
ALTER TABLE "curated_memory_assertions" ADD CONSTRAINT "curated_memory_assertions_author_shape_check" CHECK (("curated_memory_assertions"."author_kind" is null) = ("curated_memory_assertions"."author_ref" is null)
        and ("curated_memory_assertions"."author_ref" is null or length(trim("curated_memory_assertions"."author_ref")) > 0));
