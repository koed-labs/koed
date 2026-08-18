ALTER TYPE "public"."collaboration_event_family" ADD VALUE 'pending_share_lifecycle' BEFORE 'managed_conversation_changed';--> statement-breakpoint
CREATE TABLE "collaboration_pending_share_source_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"pending_share_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"local_session_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"redacted_failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csm_pending_source_work_mutation_unique" UNIQUE("enrollment_id","mutation_id"),
	CONSTRAINT "csm_pending_source_work_state_check" CHECK ("collaboration_pending_share_source_work"."state" in ('pending','processing','completed','failed')
        and "collaboration_pending_share_source_work"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pending_share_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mutation_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"logical_grant_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"authority_source" text NOT NULL,
	"authority_reference_id" uuid NOT NULL,
	"preview_id" uuid NOT NULL,
	"preview_hash" text NOT NULL,
	"preview_revision" integer NOT NULL,
	"display_title" text,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"allowed_representations" "shared_memory_representation"[] NOT NULL,
	"mode" "shared_memory_consent_mode" NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_hash" text NOT NULL,
	"state" text DEFAULT 'preparing' NOT NULL,
	"stage" text DEFAULT 'accepted' NOT NULL,
	"workspace_access_state" text DEFAULT 'none' NOT NULL,
	"source_update_state" text DEFAULT 'preparing' NOT NULL,
	"operation_version" integer DEFAULT 1 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_control_mutation_id" uuid,
	"last_control_action" text,
	"redacted_failure_code" text,
	"last_progress_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"share_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"grant_id" uuid,
	"replacement_mutation_id" uuid,
	"replacement_request_hash" text,
	"replacement_consent_id" uuid,
	"replacement_authority_source" text,
	"replacement_authority_reference_id" uuid,
	"replacement_preview_id" uuid,
	"replacement_preview_hash" text,
	"replacement_preview_revision" integer,
	"replacement_representation" "shared_memory_representation",
	"replacement_allowed_representations" "shared_memory_representation"[],
	"replacement_mode" "shared_memory_consent_mode",
	"replacement_source_revision" bigint,
	"replacement_source_hash" text,
	"replacement_expires_at" timestamp with time zone,
	"replacement_expected_grant_version" integer,
	CONSTRAINT "pending_share_operations_mutation_unique" UNIQUE("mutation_id"),
	CONSTRAINT "pending_share_operations_consent_unique" UNIQUE("consent_id"),
	CONSTRAINT "pending_share_operations_logical_grant_unique" UNIQUE("logical_grant_id"),
	CONSTRAINT "pending_share_operations_control_mutation_unique" UNIQUE("last_control_mutation_id"),
	CONSTRAINT "pending_share_operations_replacement_mutation_unique" UNIQUE("replacement_mutation_id"),
	CONSTRAINT "pending_share_operations_replacement_consent_unique" UNIQUE("replacement_consent_id"),
	CONSTRAINT "pending_share_operations_state_check" CHECK ("pending_share_operations"."state" in ('preparing','needs_attention','failed','activated','revoked')
        and "pending_share_operations"."stage" in ('accepted','syncing','uploading','processing','activating','complete')
        and "pending_share_operations"."workspace_access_state" in ('none','active','revoked')
        and "pending_share_operations"."source_update_state" in ('preparing','active','paused','failed','stopped')),
	CONSTRAINT "pending_share_operations_values_check" CHECK ("pending_share_operations"."preview_revision" > 0 and "pending_share_operations"."source_revision" >= 0
        and "pending_share_operations"."operation_version" > 0 and "pending_share_operations"."attempt_count" >= 0
        and "pending_share_operations"."authority_source" in ('browser_session','device_action_grant')
        and (("pending_share_operations"."last_control_mutation_id" is null and "pending_share_operations"."last_control_action" is null)
          or ("pending_share_operations"."last_control_mutation_id" is not null and
              "pending_share_operations"."last_control_action" in ('retry','pause','resume','revoke')))
        and length("pending_share_operations"."request_hash") = 64 and length("pending_share_operations"."preview_hash") = 64
        and length("pending_share_operations"."source_hash") = 64),
	CONSTRAINT "pending_share_operations_replacement_values_check" CHECK (("pending_share_operations"."replacement_mutation_id" is null and
             "pending_share_operations"."replacement_request_hash" is null and
             "pending_share_operations"."replacement_consent_id" is null and
             "pending_share_operations"."replacement_authority_source" is null and
             "pending_share_operations"."replacement_authority_reference_id" is null and
             "pending_share_operations"."replacement_preview_id" is null and
             "pending_share_operations"."replacement_preview_hash" is null and
             "pending_share_operations"."replacement_preview_revision" is null and
             "pending_share_operations"."replacement_representation" is null and
             "pending_share_operations"."replacement_allowed_representations" is null and
             "pending_share_operations"."replacement_mode" is null and
             "pending_share_operations"."replacement_source_revision" is null and
             "pending_share_operations"."replacement_source_hash" is null and
             "pending_share_operations"."replacement_expected_grant_version" is null)
        or ("pending_share_operations"."replacement_mutation_id" is not null and
             length("pending_share_operations"."replacement_request_hash") = 64 and
             "pending_share_operations"."replacement_consent_id" is not null and
             "pending_share_operations"."replacement_authority_source" in ('browser_session','device_action_grant') and
             "pending_share_operations"."replacement_authority_reference_id" is not null and
             "pending_share_operations"."replacement_preview_id" is not null and
             length("pending_share_operations"."replacement_preview_hash") = 64 and
             "pending_share_operations"."replacement_preview_revision" > 0 and
             "pending_share_operations"."replacement_representation" is not null and
             cardinality("pending_share_operations"."replacement_allowed_representations") > 0 and
             "pending_share_operations"."replacement_mode" is not null and
             "pending_share_operations"."replacement_source_revision" >= 0 and
             length("pending_share_operations"."replacement_source_hash") = 64 and
             "pending_share_operations"."replacement_expected_grant_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "pending_share_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pending_share_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_share_outbox_operation_unique" UNIQUE("pending_share_id"),
	CONSTRAINT "pending_share_outbox_state_check" CHECK ("pending_share_outbox"."state" in ('pending','processing','completed','failed') and "pending_share_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shared_memory_candidate_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"preview_hash" text NOT NULL,
	"preview_revision" integer DEFAULT 1 NOT NULL,
	"authority_source" text NOT NULL,
	"authority_reference_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"allowed_representations" "shared_memory_representation"[] NOT NULL,
	"mode" "shared_memory_consent_mode" NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_hash" text NOT NULL,
	"redacted_content_hash" text NOT NULL,
	"item_count" integer NOT NULL,
	"excluded_item_count" integer DEFAULT 0 NOT NULL,
	"candidate_manifest" jsonb NOT NULL,
	"candidate_manifest_hash" text NOT NULL,
	"byte_count" integer NOT NULL,
	"representation_policy_revision" integer NOT NULL,
	"representation_policy_hash" text NOT NULL,
	"content_policy_version" integer NOT NULL,
	"content_policy_hash" text NOT NULL,
	"classifier_version" integer NOT NULL,
	"classifier_hash" text NOT NULL,
	"share_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidation_reason" text,
	CONSTRAINT "shared_memory_candidate_previews_hash_unique" UNIQUE("preview_hash"),
	CONSTRAINT "shared_memory_candidate_previews_binding_unique" UNIQUE("id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision"),
	CONSTRAINT "shared_memory_candidate_previews_values_check" CHECK ("shared_memory_candidate_previews"."preview_revision" = 1
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
        and "shared_memory_candidate_previews"."expires_at" > "shared_memory_candidate_previews"."created_at"),
	CONSTRAINT "shared_memory_candidate_previews_hashes_check" CHECK (length("shared_memory_candidate_previews"."preview_hash") = 64
        and length("shared_memory_candidate_previews"."candidate_manifest_hash") = 64
        and length("shared_memory_candidate_previews"."source_hash") = 64
        and length("shared_memory_candidate_previews"."redacted_content_hash") = 64
        and length("shared_memory_candidate_previews"."representation_policy_hash") = 64
        and length("shared_memory_candidate_previews"."content_policy_hash") = 64
        and length("shared_memory_candidate_previews"."classifier_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" DROP CONSTRAINT "source_owner_consents_lifecycle_check";--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ALTER COLUMN "sync_relationship_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "collaboration_shared_memory_previews" ADD COLUMN "expires_at" timestamp with time zone DEFAULT now() + interval '10 minutes' NOT NULL;--> statement-breakpoint
ALTER TABLE "team_session_share_grants" ADD COLUMN "display_title" text;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_enrollment_id_collaboration_shared_memory_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."collaboration_shared_memory_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_pending_share_source_work" ADD CONSTRAINT "collaboration_pending_share_source_work_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_grant_id_team_session_share_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."team_session_share_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_replacement_preview_fk" FOREIGN KEY ("replacement_preview_id","replacement_preview_hash","replacement_preview_revision","logical_memory_id","team_id","team_workspace_id","replacement_source_revision") REFERENCES "public"."shared_memory_candidate_previews"("id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_operations" ADD CONSTRAINT "pending_share_operations_preview_fk" FOREIGN KEY ("preview_id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision") REFERENCES "public"."shared_memory_candidate_previews"("id","preview_hash","preview_revision","logical_memory_id","team_id","team_workspace_id","source_revision") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_share_outbox" ADD CONSTRAINT "pending_share_outbox_pending_share_id_pending_share_operations_id_fk" FOREIGN KEY ("pending_share_id") REFERENCES "public"."pending_share_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_memory_candidate_previews" ADD CONSTRAINT "shared_memory_candidate_previews_workspace_team_fk" FOREIGN KEY ("team_workspace_id","team_id") REFERENCES "public"."team_workspaces"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csm_pending_source_work_claim_idx" ON "collaboration_pending_share_source_work" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE INDEX "pending_share_operations_owner_activity_idx" ON "pending_share_operations" USING btree ("owner_user_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pending_share_operations_work_idx" ON "pending_share_operations" USING btree ("state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "pending_share_outbox_work_idx" ON "pending_share_outbox" USING btree ("state","available_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "shared_memory_candidate_previews_device_authority_unique" ON "shared_memory_candidate_previews" USING btree ("authority_reference_id") WHERE "shared_memory_candidate_previews"."authority_source" = 'device_action_grant';--> statement-breakpoint
CREATE INDEX "shared_memory_candidate_previews_owner_idx" ON "shared_memory_candidate_previews" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "source_owner_representation_consents" ADD CONSTRAINT "source_owner_consents_lifecycle_check" CHECK ((
        "source_owner_representation_consents"."state" = 'pending'
        and "source_owner_representation_consents"."activated_at" is null
        and "source_owner_representation_consents"."paused_at" is null
        and "source_owner_representation_consents"."revoked_at" is null
      ) or (
        "source_owner_representation_consents"."state" = 'active'
        and "source_owner_representation_consents"."activated_at" is not null
        and "source_owner_representation_consents"."paused_at" is null
        and "source_owner_representation_consents"."revoked_at" is null
      ) or (
        "source_owner_representation_consents"."state" = 'paused'
        and "source_owner_representation_consents"."activated_at" is not null
        and "source_owner_representation_consents"."paused_at" is not null
        and "source_owner_representation_consents"."revoked_at" is null
      ) or (
        "source_owner_representation_consents"."state" = 'revoked'
        and "source_owner_representation_consents"."revoked_at" is not null
      ) or (
        "source_owner_representation_consents"."state" = 'expired'
        and "source_owner_representation_consents"."revoked_at" is null
        and "source_owner_representation_consents"."expires_at" is not null
      ));--> statement-breakpoint
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
