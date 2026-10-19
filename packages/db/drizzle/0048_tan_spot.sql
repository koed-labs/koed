CREATE TABLE "conversation_source_publication_fences" (
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"logical_source_id" uuid NOT NULL,
	"publication_version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_source_publication_fences_pk" PRIMARY KEY("owner_user_id","session_id","logical_source_id"),
	CONSTRAINT "conversation_source_publication_fences_version_check" CHECK ("conversation_source_publication_fences"."publication_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_lifecycle_schema_capabilities" (
	"capability" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"enabled_at" timestamp with time zone,
	CONSTRAINT "project_lifecycle_schema_capabilities_state_check" CHECK (("project_lifecycle_schema_capabilities"."capability" = 'workspace_projects'
        and (("project_lifecycle_schema_capabilities"."state" = 'absent' and "project_lifecycle_schema_capabilities"."enabled_at" is null)
          or ("project_lifecycle_schema_capabilities"."state" = 'enabled' and "project_lifecycle_schema_capabilities"."enabled_at" is not null))))
);
--> statement-breakpoint
CREATE TABLE "shared_memory_publication_fences" (
	"logical_memory_id" uuid NOT NULL,
	"publication_version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_memory_publication_fences_pk" PRIMARY KEY("logical_memory_id"),
	CONSTRAINT "shared_memory_publication_fences_version_check" CHECK ("shared_memory_publication_fences"."publication_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "team_memory_grant_freeze_item_aliases" (
	"share_grant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"frozen_representation_id" uuid NOT NULL,
	"source_semantic_item_id" uuid NOT NULL,
	"frozen_semantic_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_grant_freeze_item_aliases_pk" PRIMARY KEY("share_grant_id","representation","source_semantic_item_id"),
	CONSTRAINT "team_memory_grant_freeze_item_aliases_frozen_item_unique" UNIQUE("frozen_semantic_item_id"),
	CONSTRAINT "team_memory_grant_freeze_item_aliases_id_check" CHECK ("team_memory_grant_freeze_item_aliases"."source_semantic_item_id" <> "team_memory_grant_freeze_item_aliases"."frozen_semantic_item_id")
);
--> statement-breakpoint
CREATE TABLE "team_memory_grant_freeze_representations" (
	"share_grant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"representation" "shared_memory_representation" NOT NULL,
	"source_revision" bigint NOT NULL,
	"source_representation_id" uuid NOT NULL,
	"frozen_representation_id" uuid NOT NULL,
	"source_binding_snapshot" jsonb NOT NULL,
	"manifest_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_grant_freeze_representations_pk" PRIMARY KEY("share_grant_id","representation"),
	CONSTRAINT "team_memory_grant_freeze_representations_snapshot_unique" UNIQUE("frozen_representation_id"),
	CONSTRAINT "team_memory_grant_freeze_representations_scope_unique" UNIQUE("share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","frozen_representation_id"),
	CONSTRAINT "team_memory_grant_freeze_representations_binding_check" CHECK (jsonb_typeof("team_memory_grant_freeze_representations"."source_binding_snapshot") = 'object'
        and "team_memory_grant_freeze_representations"."source_revision" >= 0
        and "team_memory_grant_freeze_representations"."manifest_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_memory_grant_freeze_source_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"source_table" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_column" text NOT NULL,
	"plaintext_content_type" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rewrapped_at" timestamp with time zone,
	CONSTRAINT "team_memory_grant_freeze_source_payloads_identity_unique" UNIQUE("share_grant_id","source_table","source_id","source_column"),
	CONSTRAINT "team_memory_grant_freeze_source_payloads_identity_check" CHECK (coalesce(("team_memory_grant_freeze_source_payloads"."source_table" in ('privacy_sanitized_source_artifacts','privacy_sanitized_source_chunks')
        and length(trim("team_memory_grant_freeze_source_payloads"."source_column")) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope") = 'object'
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'version') = 'number'
        and "team_memory_grant_freeze_source_payloads"."envelope"->>'version' = '1'
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'providerMode') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'providerMode')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'keyId') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'keyId')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'keyVersion') = 'number'
        and "team_memory_grant_freeze_source_payloads"."envelope"->'keyVersion' >= '0'::jsonb
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'algorithm') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'algorithm')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'ciphertext') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'ciphertext')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'nonce') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'nonce')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'tag') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'tag')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'scope') = 'object'
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'provenance') = 'object'
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'wrappedDek') = 'object'
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'aad') = 'object'
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'ciphertextLocation') = 'string'
        and length(trim("team_memory_grant_freeze_source_payloads"."envelope"->>'ciphertextLocation')) > 0
        and jsonb_typeof("team_memory_grant_freeze_source_payloads"."envelope"->'createdAt') = 'string'), false))
);
--> statement-breakpoint
CREATE TABLE "team_memory_grant_freeze_sources" (
	"share_grant_id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"source_snapshot" jsonb NOT NULL,
	"source_payload_count" integer DEFAULT 0 NOT NULL,
	"source_manifest_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suppressed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "team_memory_grant_freeze_sources_snapshot_check" CHECK (coalesce((jsonb_typeof("team_memory_grant_freeze_sources"."source_snapshot") = 'object'
        and "team_memory_grant_freeze_sources"."source_payload_count" >= 0
        and (("team_memory_grant_freeze_sources"."purged_at" is null
              and "team_memory_grant_freeze_sources"."source_snapshot"->>'schemaVersion' = '1'
              and jsonb_typeof("team_memory_grant_freeze_sources"."source_snapshot"->'capability') = 'object'
              and "team_memory_grant_freeze_sources"."source_snapshot" ? 'published'
              and "team_memory_grant_freeze_sources"."source_manifest_hash" is not null
              and "team_memory_grant_freeze_sources"."source_manifest_hash" ~ '^[0-9a-f]{64}$')
          or ("team_memory_grant_freeze_sources"."purged_at" is not null
              and "team_memory_grant_freeze_sources"."source_snapshot" = '{}'::jsonb
              and "team_memory_grant_freeze_sources"."source_payload_count" = 0
              and "team_memory_grant_freeze_sources"."source_manifest_hash" is null))), false))
);
--> statement-breakpoint
ALTER TABLE "team_memory_representations" DROP CONSTRAINT "team_memory_representations_revision_unique";
--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" DROP CONSTRAINT "team_conversation_source_grants_lifecycle_check";
--> statement-breakpoint
DROP INDEX "team_memory_share_grants_destination_unique";
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ALTER COLUMN "source_preview_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ALTER COLUMN "source_artifact_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ALTER COLUMN "sanitized_source_preview_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "frozen_snapshot" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD COLUMN "source_representation_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "frozen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "freeze_mutation_id" uuid;
--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "freeze_manifest_hash" text;
--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "freeze_representation_count" integer;
--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "freeze_source_access_expected" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversation_source_publication_fences" ADD CONSTRAINT "conversation_source_publication_fences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_source_publication_fences" ADD CONSTRAINT "conversation_source_publication_fences_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_item_aliases" ADD CONSTRAINT "team_memory_grant_freeze_item_aliases_representation_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","frozen_representation_id") REFERENCES "public"."team_memory_grant_freeze_representations"("share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","frozen_representation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_semantic_items" ADD CONSTRAINT "team_memory_semantic_items_exact_scope_unique" UNIQUE("id","representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id");
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_item_aliases" ADD CONSTRAINT "team_memory_grant_freeze_item_aliases_item_fk" FOREIGN KEY ("frozen_semantic_item_id","frozen_representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_semantic_items"("id","representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_representations" ADD CONSTRAINT "team_memory_grant_freeze_representations_grant_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id","logical_memory_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_representations" ADD CONSTRAINT "team_memory_grant_freeze_representations_snapshot_fk" FOREIGN KEY ("frozen_representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","source_revision") REFERENCES "public"."team_memory_representations"("id","share_grant_id","team_id","team_workspace_id","logical_memory_id","representation","source_revision") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_source_payloads" ADD CONSTRAINT "team_memory_grant_freeze_source_payloads_header_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_grant_freeze_sources"("share_grant_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_source_payloads" ADD CONSTRAINT "team_memory_grant_freeze_source_payloads_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_sources" ADD CONSTRAINT "team_memory_grant_freeze_sources_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "team_memory_grant_freeze_sources" ADD CONSTRAINT "team_memory_grant_freeze_sources_scope_fk" FOREIGN KEY ("share_grant_id","team_id","team_workspace_id") REFERENCES "public"."team_memory_share_grants"("id","team_id","team_workspace_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "team_memory_grant_freeze_source_payloads_rewrap_idx" ON "team_memory_grant_freeze_source_payloads" USING btree ("team_id","share_grant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "team_memory_share_grants_destination_unique" ON "team_memory_share_grants" USING btree ("logical_memory_id","team_workspace_id") WHERE "team_memory_share_grants"."logical_memory_id" is not null and "team_memory_share_grants"."frozen_at" is null;
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_revision_unique" UNIQUE("share_grant_id","representation","source_revision","fidelity_policy_revision","content_policy_version","classifier_version","frozen_snapshot","sanitized_source_preview_id");
--> statement-breakpoint
ALTER TABLE "team_conversation_source_grants" ADD CONSTRAINT "team_conversation_source_grants_lifecycle_check" CHECK (("team_conversation_source_grants"."lifecycle" = 'active'
          and "team_conversation_source_grants"."revoked_at" is null
          and "team_conversation_source_grants"."revoked_by_user_id" is null
          and "team_conversation_source_grants"."revocation_reason" is null)
        or ("team_conversation_source_grants"."lifecycle" = 'frozen_empty'
          and "team_conversation_source_grants"."revoked_at" is null
          and "team_conversation_source_grants"."revoked_by_user_id" is null
          and "team_conversation_source_grants"."revocation_reason" is null)
        or ("team_conversation_source_grants"."lifecycle" = 'revoked'
          and "team_conversation_source_grants"."revoked_at" is not null
          and "team_conversation_source_grants"."revoked_by_user_id" is not null
          and length(trim("team_conversation_source_grants"."revocation_reason")) between 1 and 120));
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_frozen_snapshot_check" CHECK (("team_memory_representations"."frozen_snapshot" = false and "team_memory_representations"."source_representation_id" is null)
        or ("team_memory_representations"."frozen_snapshot" = true
          and "team_memory_representations"."source_representation_id" is not null
          and "team_memory_representations"."source_preview_id" is null
          and "team_memory_representations"."source_artifact_id" is null
          and "team_memory_representations"."sanitized_source_preview_id" is null));
--> statement-breakpoint
ALTER TABLE "team_memory_representations" ADD CONSTRAINT "team_memory_representations_source_reference_check" CHECK (("team_memory_representations"."frozen_snapshot" = true)
        or ("team_memory_representations"."source_preview_id" is not null
          and "team_memory_representations"."source_artifact_id" is not null
          and "team_memory_representations"."sanitized_source_preview_id" is not null));
--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD CONSTRAINT "team_memory_share_grants_freeze_check" CHECK (coalesce((("team_memory_share_grants"."frozen_at" is null
          and "team_memory_share_grants"."freeze_mutation_id" is null
          and "team_memory_share_grants"."freeze_manifest_hash" is null
          and "team_memory_share_grants"."freeze_representation_count" is null
          and "team_memory_share_grants"."freeze_source_access_expected" = false)
        or ("team_memory_share_grants"."frozen_at" is not null
          and "team_memory_share_grants"."freeze_mutation_id" is not null
          and "team_memory_share_grants"."purge_completed_at" is null
          and "team_memory_share_grants"."freeze_manifest_hash" is not null
          and "team_memory_share_grants"."freeze_manifest_hash" ~ '^[0-9a-f]{64}$'
          and "team_memory_share_grants"."freeze_representation_count" is not null
          and "team_memory_share_grants"."freeze_representation_count" >= 0)
        or ("team_memory_share_grants"."frozen_at" is not null
          and "team_memory_share_grants"."freeze_mutation_id" is not null
          and "team_memory_share_grants"."purge_completed_at" is not null
          and "team_memory_share_grants"."lifecycle" = 'purged'
          and "team_memory_share_grants"."freeze_manifest_hash" is null
          and "team_memory_share_grants"."freeze_representation_count" is null)), false));
--> statement-breakpoint
INSERT INTO project_lifecycle_schema_capabilities (capability,state,enabled_at) VALUES ('workspace_projects','absent',null);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_project_lifecycle_schema_capability_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Workspace Project schema capability cannot be deleted'
      USING ERRCODE='55000';
  END IF;
  IF NEW.capability IS DISTINCT FROM OLD.capability OR
     (OLD.state='enabled' AND NEW.state<>'enabled') OR
     (OLD.enabled_at IS NOT NULL AND NEW.enabled_at IS DISTINCT FROM OLD.enabled_at) THEN
    RAISE EXCEPTION 'Workspace Project schema capability cannot be downgraded'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_lifecycle_schema_capability_guard
BEFORE UPDATE OR DELETE ON project_lifecycle_schema_capabilities
FOR EACH ROW EXECUTE FUNCTION koed_project_lifecycle_schema_capability_guard();
--> statement-breakpoint
INSERT INTO conversation_source_publication_fences (
  owner_user_id, session_id, logical_source_id, publication_version, updated_at
)
SELECT DISTINCT owner_user_id, session_id, logical_source_id, 0, now()
  FROM conversation_source_artifacts
ON CONFLICT (owner_user_id, session_id, logical_source_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO shared_memory_publication_fences (
  logical_memory_id, publication_version, updated_at
)
SELECT DISTINCT logical_memory_id, 0, now()
  FROM team_memory_representations
ON CONFLICT (logical_memory_id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_lock_conversation_source_publication_fence(
  p_owner_user_id uuid,
  p_session_id uuid,
  p_logical_source_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO conversation_source_publication_fences (
    owner_user_id, session_id, logical_source_id, publication_version, updated_at
  ) VALUES (p_owner_user_id, p_session_id, p_logical_source_id, 1, clock_timestamp())
  ON CONFLICT (owner_user_id, session_id, logical_source_id)
  DO UPDATE SET
    publication_version = conversation_source_publication_fences.publication_version + 1,
    updated_at = clock_timestamp();
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_conversation_source_grant_freeze_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_grant team_memory_share_grants%ROWTYPE;
BEGIN
  SELECT * INTO v_grant FROM team_memory_share_grants
   WHERE id = CASE WHEN TG_OP='DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END
   FOR SHARE;
  IF TG_OP='DELETE' THEN
    IF NOT FOUND OR (v_grant.lifecycle='purged' AND v_grant.purge_completed_at IS NOT NULL) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Conversation Source capability cannot be removed before grant purge'
      USING ERRCODE='55000';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation Source Share Grant is missing' USING ERRCODE='23503';
  END IF;
  IF v_grant.frozen_at IS NOT NULL THEN
    IF TG_OP='INSERT' THEN
      RAISE EXCEPTION 'Frozen Conversation Source capability cannot be added'
        USING ERRCODE='55000';
    END IF;
    IF NEW.mode IS DISTINCT FROM OLD.mode OR
       NEW.artifact_id IS DISTINCT FROM OLD.artifact_id OR
       NEW.source_generation_id IS DISTINCT FROM OLD.source_generation_id OR
       NEW.maximum_segment_index IS DISTINCT FROM OLD.maximum_segment_index OR
       NEW.maximum_source_offset IS DISTINCT FROM OLD.maximum_source_offset OR
       NEW.lifecycle IS DISTINCT FROM OLD.lifecycle AND NEW.lifecycle <> 'revoked' THEN
      RAISE EXCEPTION 'Frozen Conversation Source frontier cannot advance'
        USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER team_conversation_source_grant_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_conversation_source_grants
FOR EACH ROW EXECUTE FUNCTION koed_team_conversation_source_grant_freeze_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_lock_shared_memory_publication_fence(
  p_logical_memory_id uuid
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO shared_memory_publication_fences (
    logical_memory_id, publication_version, updated_at
  ) VALUES (p_logical_memory_id, 1, clock_timestamp())
  ON CONFLICT (logical_memory_id)
  DO UPDATE SET
    publication_version = shared_memory_publication_fences.publication_version + 1,
    updated_at = clock_timestamp();
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_conversation_source_artifact_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
    NEW.session_id IS DISTINCT FROM OLD.session_id OR
    NEW.logical_source_id IS DISTINCT FROM OLD.logical_source_id OR
    NEW.source_generation_id IS DISTINCT FROM OLD.source_generation_id OR
    NEW.source_component_id IS DISTINCT FROM OLD.source_component_id
  ) THEN
    RAISE EXCEPTION 'Conversation Source identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM koed_lock_conversation_source_publication_fence(
      OLD.owner_user_id, OLD.session_id, OLD.logical_source_id
    );
    RETURN OLD;
  END IF;

  PERFORM koed_lock_conversation_source_publication_fence(
    NEW.owner_user_id, NEW.session_id, NEW.logical_source_id
  );

  IF TG_OP = 'UPDATE' AND OLD.finalized_at IS NOT NULL THEN
    IF (to_jsonb(NEW) - ARRAY[
      'updated_at','lifecycle','origin_key_status','replica_role',
      'source_set_closure_hash','source_set_closure_manifest',
      'source_set_closure_signature','source_set_finalized_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'updated_at','lifecycle','origin_key_status','replica_role',
      'source_set_closure_hash','source_set_closure_manifest',
      'source_set_closure_signature','source_set_finalized_at'
    ]) THEN
      RAISE EXCEPTION 'Finalized Conversation Source content is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.source_set_closure_hash IS NOT NULL AND (
      NEW.source_set_closure_hash IS DISTINCT FROM OLD.source_set_closure_hash OR
      NEW.source_set_closure_manifest IS DISTINCT FROM OLD.source_set_closure_manifest OR
      NEW.source_set_closure_signature IS DISTINCT FROM OLD.source_set_closure_signature OR
      NEW.source_set_finalized_at IS DISTINCT FROM OLD.source_set_finalized_at
    ) THEN
      RAISE EXCEPTION 'Finalized Conversation Source-set closure is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.source_set_closure_hash IS NULL AND (
      NEW.source_set_closure_manifest IS NOT NULL OR
      NEW.source_set_closure_signature IS NOT NULL OR
      NEW.source_set_finalized_at IS NOT NULL
    ) AND NEW.source_set_closure_hash IS NULL THEN
      RAISE EXCEPTION 'Conversation Source-set closure must be published atomically'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_conversation_source_segment_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_owner_user_id uuid;
  v_session_id uuid;
  v_logical_source_id uuid;
  v_lifecycle text;
  v_artifact_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id THEN
    RAISE EXCEPTION 'Conversation Source segment parent is immutable'
      USING ERRCODE = '55000';
  END IF;
  v_artifact_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.artifact_id ELSE NEW.artifact_id END;
  SELECT source.owner_user_id, source.session_id, source.logical_source_id,
         source.lifecycle
    INTO v_owner_user_id, v_session_id, v_logical_source_id, v_lifecycle
    FROM conversation_source_artifacts source
   WHERE source.id = v_artifact_id;
  IF v_owner_user_id IS NOT NULL THEN
    PERFORM koed_lock_conversation_source_publication_fence(
      v_owner_user_id, v_session_id, v_logical_source_id
    );
  END IF;
  IF TG_OP = 'INSERT' AND v_lifecycle IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Conversation Source segments may be appended only while active'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Sealed Conversation Source segments are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_lifecycle IS NOT NULL THEN
      RAISE EXCEPTION 'Conversation Source segments can be removed only with their artifact'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_suppress_frozen_source(p_grant_id uuid, p_artifact_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE team_memory_grant_freeze_sources header
     SET suppressed_at=clock_timestamp()
   WHERE header.share_grant_id=p_grant_id
     AND header.suppressed_at IS NULL
     AND header.purged_at IS NULL
     AND header.source_snapshot #>> '{published,sanitizedArtifactRow,id}' = p_artifact_id::text;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_sanitized_source_artifact_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_artifact_id uuid;
  v_share_grant_id uuid;
  v_owner_user_id uuid;
  v_session_id uuid;
  v_logical_source_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.share_grant_id IS DISTINCT FROM OLD.share_grant_id OR
    NEW.source_artifact_id IS DISTINCT FROM OLD.source_artifact_id OR
    NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR
    NEW.team_id IS DISTINCT FROM OLD.team_id OR
    NEW.team_workspace_id IS DISTINCT FROM OLD.team_workspace_id
  ) THEN
    RAISE EXCEPTION 'Sanitized Conversation Source identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  v_artifact_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.source_artifact_id ELSE NEW.source_artifact_id END;
  v_share_grant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END;
  SELECT source.owner_user_id, source.session_id, source.logical_source_id
    INTO v_owner_user_id, v_session_id, v_logical_source_id
    FROM conversation_source_artifacts source
   WHERE source.id = v_artifact_id;
  IF v_owner_user_id IS NOT NULL THEN
    PERFORM koed_lock_conversation_source_publication_fence(
      v_owner_user_id, v_session_id, v_logical_source_id
    );
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM team_memory_share_grants grant_row
     WHERE grant_row.id = v_share_grant_id
       AND grant_row.frozen_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Frozen Share Grant cannot publish sanitized source'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'ready' AND (
      NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'invalidated'
    ) THEN
      RAISE EXCEPTION 'Published sanitized source may only be invalidated'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'ready' AND (
      to_jsonb(NEW) - ARRAY['status','invalidated_at','invalidation_reason_code']
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY['status','invalidated_at','invalidation_reason_code']
    ) THEN
      RAISE EXCEPTION 'Published sanitized source content is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status = 'invalidated' THEN
      RAISE EXCEPTION 'Invalidated sanitized source is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = 'ready' AND EXISTS (
    SELECT 1 FROM team_memory_share_grants grant_row
     WHERE grant_row.id = v_share_grant_id
       AND grant_row.frozen_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Frozen Share Grant cannot publish sanitized source'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'ready' AND NEW.status = 'invalidated'
     AND NEW.invalidation_reason_code IS DISTINCT FROM 'superseded_materialization' THEN
    PERFORM koed_suppress_frozen_source(v_share_grant_id, OLD.id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_sanitized_source_chunk_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_artifact_id uuid;
  v_share_grant_id uuid;
  v_status text;
  v_owner_user_id uuid;
  v_session_id uuid;
  v_logical_source_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.artifact_id IS DISTINCT FROM OLD.artifact_id THEN
    RAISE EXCEPTION 'Sanitized Conversation Source chunk parent is immutable'
      USING ERRCODE = '55000';
  END IF;
  v_artifact_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.artifact_id ELSE NEW.artifact_id END;
  SELECT sanitized.share_grant_id, sanitized.status,
         source.owner_user_id, source.session_id, source.logical_source_id
    INTO v_share_grant_id, v_status, v_owner_user_id, v_session_id, v_logical_source_id
    FROM privacy_sanitized_source_artifacts sanitized
    JOIN conversation_source_artifacts source
      ON source.id = sanitized.source_artifact_id
   WHERE sanitized.id = v_artifact_id;
  IF v_owner_user_id IS NOT NULL THEN
    PERFORM koed_lock_conversation_source_publication_fence(
      v_owner_user_id, v_session_id, v_logical_source_id
    );
  END IF;
  IF TG_OP = 'INSERT' AND (
    v_status IS DISTINCT FROM 'pending' OR EXISTS (
      SELECT 1 FROM team_memory_share_grants grant_row
       WHERE grant_row.id = v_share_grant_id AND grant_row.frozen_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Sanitized chunks may be added only before publication'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM encrypted_field_payloads payload
     WHERE payload.source_table='privacy_sanitized_source_chunks'
       AND payload.source_id=NEW.id
       AND payload.source_column='sanitized_text'
       AND payload.owner_user_id=v_owner_user_id
       AND payload.team_id=(SELECT team_id FROM privacy_sanitized_source_artifacts
                             WHERE id=NEW.artifact_id)
       AND payload.team_workspace_id=(SELECT team_workspace_id
                              FROM privacy_sanitized_source_artifacts
                             WHERE id=NEW.artifact_id)
       AND payload.aad->>'artifactId'=NEW.artifact_id::text
       AND payload.aad->>'chunkIndex'=NEW.chunk_index::text
       AND payload.aad->>'classificationResultId'=NEW.classification_result_id::text
       AND payload.aad->>'payloadBindingHash'=NEW.payload_binding_hash
       AND payload.invalidated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Sanitized chunk ciphertext does not match indexed identity'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - ARRAY['invalidated_at','invalidation_reason_code'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['invalidated_at','invalidation_reason_code']) OR
    OLD.invalidated_at IS NOT NULL OR NEW.invalidated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Published sanitized source chunks are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL
     AND NEW.invalidation_reason_code IS DISTINCT FROM 'superseded_materialization' THEN
    PERFORM koed_suppress_frozen_source(v_share_grant_id, v_artifact_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_encrypted_sanitized_source_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_source_table text;
  v_source_id uuid;
  v_share_grant_id uuid;
  v_status text;
  v_owner_user_id uuid;
  v_team_id uuid;
  v_team_workspace_id uuid;
  v_session_id uuid;
  v_logical_source_id uuid;
BEGIN
  v_source_table := CASE WHEN TG_OP = 'DELETE' THEN OLD.source_table ELSE NEW.source_table END;
  v_source_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.source_id ELSE NEW.source_id END;
  IF v_source_table = 'privacy_sanitized_source_artifacts' THEN
    SELECT sanitized.share_grant_id, sanitized.status,
           sanitized.team_id,sanitized.team_workspace_id,
           source.owner_user_id, source.session_id, source.logical_source_id
      INTO v_share_grant_id, v_status, v_team_id,v_team_workspace_id,
           v_owner_user_id, v_session_id, v_logical_source_id
      FROM privacy_sanitized_source_artifacts sanitized
      JOIN conversation_source_artifacts source ON source.id=sanitized.source_artifact_id
     WHERE sanitized.id=v_source_id;
  ELSIF v_source_table = 'privacy_sanitized_source_chunks' THEN
    SELECT sanitized.share_grant_id, sanitized.status,
           sanitized.team_id,sanitized.team_workspace_id,
           source.owner_user_id, source.session_id, source.logical_source_id
      INTO v_share_grant_id, v_status, v_team_id,v_team_workspace_id,
           v_owner_user_id, v_session_id, v_logical_source_id
      FROM privacy_sanitized_source_chunks chunk
      JOIN privacy_sanitized_source_artifacts sanitized ON sanitized.id=chunk.artifact_id
      JOIN conversation_source_artifacts source ON source.id=sanitized.source_artifact_id
     WHERE chunk.id=v_source_id;
    -- The existing publisher encrypts a chunk before inserting its indexed
    -- chunk row. Its Team envelope binds the exact pending artifact in AAD.
    IF TG_OP = 'INSERT' AND v_share_grant_id IS NULL
       AND (NEW.aad->>'artifactId') ~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      SELECT sanitized.share_grant_id,sanitized.status,
             sanitized.team_id,sanitized.team_workspace_id,
             source.owner_user_id,source.session_id,source.logical_source_id
        INTO v_share_grant_id,v_status,v_team_id,v_team_workspace_id,
             v_owner_user_id,v_session_id,v_logical_source_id
        FROM privacy_sanitized_source_artifacts sanitized
        JOIN conversation_source_artifacts source ON source.id=sanitized.source_artifact_id
       WHERE sanitized.id=(NEW.aad->>'artifactId')::uuid;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF v_owner_user_id IS NOT NULL THEN
    PERFORM koed_lock_conversation_source_publication_fence(
      v_owner_user_id, v_session_id, v_logical_source_id
    );
  END IF;
  IF TG_OP = 'INSERT' AND (
    NEW.owner_user_id IS DISTINCT FROM v_owner_user_id OR
    NEW.team_id IS DISTINCT FROM v_team_id OR
    NEW.team_workspace_id IS DISTINCT FROM v_team_workspace_id OR
    NEW.encryption_scope <> 'team' OR
    NEW.aad->>'ownerUserId' IS DISTINCT FROM v_owner_user_id::text OR
    NEW.aad->>'teamId' IS DISTINCT FROM v_team_id::text OR
    NEW.aad->>'teamWorkspaceId' IS DISTINCT FROM v_team_workspace_id::text OR
    NEW.aad->>'sourceTable' IS DISTINCT FROM NEW.source_table OR
    NEW.aad->>'sourceId' IS DISTINCT FROM NEW.source_id::text OR
    NEW.aad->>'sourceColumn' IS DISTINCT FROM NEW.source_column OR
    NEW.provenance->>'sourceTable' IS DISTINCT FROM NEW.source_table OR
    NEW.provenance->>'sourceId' IS DISTINCT FROM NEW.source_id::text OR
    NEW.provenance->>'sourceColumn' IS DISTINCT FROM NEW.source_column OR
    v_status IS DISTINCT FROM 'pending' OR EXISTS (
      SELECT 1 FROM team_memory_share_grants grant_row
       WHERE grant_row.id=v_share_grant_id AND grant_row.frozen_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Sanitized source payloads may be added only before publication'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    (to_jsonb(NEW) - ARRAY[
      'key_version','wrapped_dek','envelope_reencrypted_at','updated_at',
      'invalidated_at','invalidation_reason'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'key_version','wrapped_dek','envelope_reencrypted_at','updated_at',
      'invalidated_at','invalidation_reason'
    ])
  ) THEN
    RAISE EXCEPTION 'Sanitized source envelopes are immutable except key rewrap'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.invalidated_at IS NULL AND NEW.invalidated_at IS NOT NULL
     AND NEW.invalidation_reason IS DISTINCT FROM 'superseded_materialization' THEN
    IF v_source_table = 'privacy_sanitized_source_artifacts' THEN
      PERFORM koed_suppress_frozen_source(v_share_grant_id, v_source_id);
    ELSE
      PERFORM koed_suppress_frozen_source(
        v_share_grant_id,
        (SELECT artifact_id FROM privacy_sanitized_source_chunks WHERE id=v_source_id)
      );
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_grant_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.logical_memory_id IS NOT NULL THEN
      PERFORM koed_lock_shared_memory_publication_fence(OLD.logical_memory_id);
    END IF;
    IF OLD.frozen_at IS NOT NULL AND OLD.purge_completed_at IS NULL THEN
      RAISE EXCEPTION 'Frozen Share Grant cannot be deleted before retention purge'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.logical_memory_id IS NOT NULL THEN
    PERFORM koed_lock_shared_memory_publication_fence(NEW.logical_memory_id);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id THEN
      RAISE EXCEPTION 'Share Grant memory identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.frozen_at IS NOT NULL THEN
      IF NEW.frozen_at IS DISTINCT FROM OLD.frozen_at OR
         NEW.freeze_mutation_id IS DISTINCT FROM OLD.freeze_mutation_id THEN
        RAISE EXCEPTION 'Frozen Share Grant marker is irreversible'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.purge_completed_at IS NULL AND (
        NEW.freeze_manifest_hash IS DISTINCT FROM OLD.freeze_manifest_hash OR
        NEW.freeze_representation_count IS DISTINCT FROM OLD.freeze_representation_count OR
        NEW.freeze_source_access_expected IS DISTINCT FROM OLD.freeze_source_access_expected
      ) AND NOT (
        NEW.purge_completed_at IS NOT NULL AND NEW.lifecycle='purged' AND
        NEW.freeze_manifest_hash IS NULL AND NEW.freeze_representation_count IS NULL
      ) THEN
        RAISE EXCEPTION 'Frozen Share Grant manifest is immutable until retention purge'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.purge_completed_at IS NOT NULL AND (
        NEW.freeze_manifest_hash IS NOT NULL OR
        NEW.freeze_representation_count IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'Purged Share Grant manifest cannot be restored'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_representation_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_frozen_at timestamptz;
  v_lifecycle text;
  v_purge_completed_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM koed_lock_shared_memory_publication_fence(OLD.logical_memory_id);
    SELECT grant_row.frozen_at, grant_row.lifecycle, grant_row.purge_completed_at
      INTO v_frozen_at, v_lifecycle, v_purge_completed_at
      FROM team_memory_share_grants grant_row WHERE grant_row.id=OLD.share_grant_id;
    IF NOT FOUND THEN RETURN OLD; END IF;
    IF OLD.frozen_snapshot AND NOT (
      v_lifecycle='purged' AND v_purge_completed_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Frozen Shared Memory representation cannot be deleted before purge'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  PERFORM koed_lock_shared_memory_publication_fence(NEW.logical_memory_id);
  SELECT grant_row.frozen_at, grant_row.lifecycle, grant_row.purge_completed_at
    INTO v_frozen_at, v_lifecycle, v_purge_completed_at
    FROM team_memory_share_grants grant_row WHERE grant_row.id=NEW.share_grant_id;

  IF TG_OP = 'INSERT' THEN
    IF NEW.frozen_snapshot AND v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Frozen Share Grant closure is already sealed'
        USING ERRCODE = '55000';
    END IF;
    IF NOT NEW.frozen_snapshot AND v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Frozen Share Grant cannot publish a representation'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.frozen_snapshot THEN
    IF (to_jsonb(NEW) - ARRAY[
      'updated_at','retain_until','tombstoned_at','purge_completed_at',
      'state','chunk_count','record_version','invalidated_at',
      'invalidation_reason_code','stale_at','freshness_evaluated_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'updated_at','retain_until','tombstoned_at','purge_completed_at',
      'state','chunk_count','record_version','invalidated_at',
      'invalidation_reason_code','stale_at','freshness_evaluated_at'
    ]) THEN
      RAISE EXCEPTION 'Frozen Shared Memory representation identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
       AND NEW.state NOT IN ('stale','invalidated','purge_pending','purged') THEN
      RAISE EXCEPTION 'Frozen Shared Memory representation cannot advance'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.record_version IS DISTINCT FROM OLD.record_version
       AND NEW.record_version <> OLD.record_version + 1 THEN
      RAISE EXCEPTION 'Frozen Shared Memory lifecycle version must advance once'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.purge_completed_at IS DISTINCT FROM OLD.purge_completed_at
       AND (NEW.purge_completed_at IS NULL OR NEW.state <> 'purged'
         OR NEW.chunk_count <> 0 OR NEW.tombstoned_at IS NULL
         OR v_lifecycle NOT IN ('purge_pending','purged')) THEN
      RAISE EXCEPTION 'Frozen Shared Memory content can be cleared only by retention purge'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.chunk_count IS DISTINCT FROM OLD.chunk_count
       AND (NEW.state <> 'purged' OR NEW.purge_completed_at IS NULL
         OR NEW.chunk_count <> 0 OR v_lifecycle NOT IN ('purge_pending','purged')) THEN
      RAISE EXCEPTION 'Frozen Shared Memory chunk count is immutable before purge'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF v_frozen_at IS NOT NULL THEN
    IF (to_jsonb(NEW) - ARRAY[
      'updated_at','state','stale_at','invalidated_at',
      'invalidation_reason_code','freshness_evaluated_at','tombstoned_at',
      'record_version','retain_until','chunk_count','purge_completed_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'updated_at','state','stale_at','invalidated_at',
      'invalidation_reason_code','freshness_evaluated_at','tombstoned_at',
      'record_version','retain_until','chunk_count','purge_completed_at'
    ]) OR NEW.state NOT IN ('stale','invalidated','purge_pending','purged')
       OR (NEW.record_version IS DISTINCT FROM OLD.record_version
           AND NEW.record_version <> OLD.record_version + 1)
       OR ((NEW.chunk_count IS DISTINCT FROM OLD.chunk_count OR
            NEW.purge_completed_at IS DISTINCT FROM OLD.purge_completed_at)
           AND NOT (v_lifecycle IN ('purge_pending','purged')
             AND NEW.state='purged' AND NEW.chunk_count=0
             AND NEW.tombstoned_at IS NOT NULL
             AND NEW.purge_completed_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'Frozen Share Grant cannot publish a representation revision'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_representation_chunk_freeze_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_representation_id uuid;
  v_logical_memory_id uuid;
  v_share_grant_id uuid;
  v_is_frozen_snapshot boolean;
  v_frozen_at timestamptz;
  v_lifecycle text;
BEGIN
  v_representation_id := CASE WHEN TG_OP='DELETE' THEN OLD.representation_id ELSE NEW.representation_id END;
  v_logical_memory_id := CASE WHEN TG_OP='DELETE' THEN OLD.logical_memory_id ELSE NEW.logical_memory_id END;
  v_share_grant_id := CASE WHEN TG_OP='DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END;
  PERFORM koed_lock_shared_memory_publication_fence(v_logical_memory_id);
  SELECT rep.frozen_snapshot, grant_row.frozen_at, grant_row.lifecycle
    INTO v_is_frozen_snapshot, v_frozen_at, v_lifecycle
    FROM team_memory_representations rep
    JOIN team_memory_share_grants grant_row ON grant_row.id=rep.share_grant_id
   WHERE rep.id=v_representation_id AND rep.share_grant_id=v_share_grant_id;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF (v_is_frozen_snapshot OR v_frozen_at IS NOT NULL) AND v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Frozen Share Grant cannot add representation chunks'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (v_is_frozen_snapshot OR v_frozen_at IS NOT NULL) AND
       (to_jsonb(NEW) - ARRAY[
      'key_version','wrapped_dek','envelope_reencrypted_at','verified_at','purged_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'key_version','wrapped_dek','envelope_reencrypted_at','verified_at','purged_at'
    ]) THEN
      RAISE EXCEPTION 'Shared Memory ciphertext and AAD are immutable except key rewrap'
        USING ERRCODE = '55000';
    END IF;
    IF NEW.purged_at IS DISTINCT FROM OLD.purged_at AND
       (NEW.purged_at IS NULL OR v_lifecycle NOT IN ('purge_pending','purged')) THEN
      RAISE EXCEPTION 'Shared Memory chunks can be marked purged only by retention'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF v_is_frozen_snapshot AND v_lifecycle NOT IN ('revoked','purge_pending','purged') THEN
    RAISE EXCEPTION 'Frozen Shared Memory chunks cannot be deleted before revocation or purge'
      USING ERRCODE = '55000';
  END IF;
  IF v_frozen_at IS NOT NULL AND v_lifecycle NOT IN ('revoked','purge_pending','purged') THEN
    RAISE EXCEPTION 'Frozen Share Grant chunks cannot be deleted before revocation or purge'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_semantic_item_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_representation_id uuid;
  v_share_grant_id uuid;
  v_logical_memory_id uuid;
  v_is_frozen_snapshot boolean;
  v_frozen_at timestamptz;
  v_lifecycle text;
BEGIN
  v_representation_id := CASE WHEN TG_OP='DELETE' THEN OLD.representation_id ELSE NEW.representation_id END;
  v_share_grant_id := CASE WHEN TG_OP='DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END;
  v_logical_memory_id := CASE WHEN TG_OP='DELETE' THEN OLD.logical_memory_id ELSE NEW.logical_memory_id END;
  PERFORM koed_lock_shared_memory_publication_fence(v_logical_memory_id);
  SELECT rep.frozen_snapshot, grant_row.frozen_at, grant_row.lifecycle
    INTO v_is_frozen_snapshot, v_frozen_at, v_lifecycle
    FROM team_memory_representations rep
    JOIN team_memory_share_grants grant_row ON grant_row.id=rep.share_grant_id
   WHERE rep.id=v_representation_id AND rep.share_grant_id=v_share_grant_id;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    IF v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Frozen Share Grant cannot add semantic items'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY[
      'embedding_state','embedding_model','embedding_dimensions',
      'embedding_version','embedding_input_hash','embedded_at',
      'last_error_class','attempt_count','next_attempt_at','updated_at'
    ]) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'embedding_state','embedding_model','embedding_dimensions',
      'embedding_version','embedding_input_hash','embedded_at',
      'last_error_class','attempt_count','next_attempt_at','updated_at'
    ]) THEN
      RAISE EXCEPTION 'Shared Memory semantic source identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF v_is_frozen_snapshot AND (
      NEW.embedding_state IS DISTINCT FROM OLD.embedding_state OR
      NEW.embedding_model IS DISTINCT FROM OLD.embedding_model OR
      NEW.embedding_dimensions IS DISTINCT FROM OLD.embedding_dimensions OR
      NEW.embedding_version IS DISTINCT FROM OLD.embedding_version OR
      NEW.embedding_input_hash IS DISTINCT FROM OLD.embedding_input_hash OR
      NEW.embedded_at IS DISTINCT FROM OLD.embedded_at OR
      NEW.last_error_class IS DISTINCT FROM OLD.last_error_class OR
      NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR
      NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    ) THEN
      RAISE EXCEPTION 'Frozen Shared Memory semantic item embedding state is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF v_is_frozen_snapshot AND v_lifecycle NOT IN ('revoked','purge_pending','purged') THEN
    RAISE EXCEPTION 'Frozen Shared Memory semantic items cannot be deleted before revocation or purge'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_semantic_vector_publication_fence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_item_id uuid;
  v_representation_id uuid;
  v_logical_memory_id uuid;
  v_is_frozen_snapshot boolean;
  v_frozen_at timestamptz;
  v_lifecycle text;
BEGIN
  v_item_id := CASE WHEN TG_OP='DELETE' THEN OLD.semantic_item_id ELSE NEW.semantic_item_id END;
  SELECT item.logical_memory_id, item.representation_id,
         representation.frozen_snapshot, grant_row.frozen_at, grant_row.lifecycle
    INTO v_logical_memory_id, v_representation_id, v_is_frozen_snapshot,
         v_frozen_at, v_lifecycle
    FROM team_memory_semantic_items item
    JOIN team_memory_representations representation
      ON representation.id=item.representation_id
    JOIN team_memory_share_grants grant_row
      ON grant_row.id=item.share_grant_id
   WHERE item.id=v_item_id;
  IF v_logical_memory_id IS NOT NULL THEN
    PERFORM koed_lock_shared_memory_publication_fence(v_logical_memory_id);
  END IF;
  IF v_is_frozen_snapshot AND v_frozen_at IS NOT NULL THEN
    IF TG_OP IN ('INSERT','UPDATE') THEN
      RAISE EXCEPTION 'Frozen Shared Memory vectors cannot be changed after grant freeze'
        USING ERRCODE = '55000';
    END IF;
    IF v_lifecycle NOT IN ('revoked','purge_pending','purged') THEN
      RAISE EXCEPTION 'Frozen Shared Memory vectors can be deleted only by revocation or retention'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_grant_freeze_source_header_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_frozen_at timestamptz;
  v_lifecycle text;
  v_tombstoned_at timestamptz;
BEGIN
  SELECT frozen_at, lifecycle, tombstoned_at
    INTO v_frozen_at, v_lifecycle, v_tombstoned_at
    FROM team_memory_share_grants
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END;
  IF TG_OP = 'DELETE' AND NOT FOUND THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Conversation Source closure cannot be added after grant freeze'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_lifecycle NOT IN ('purge_pending','purged') OR v_tombstoned_at IS NULL THEN
      RAISE EXCEPTION 'Conversation Source closure can be deleted only by retention purge'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.share_grant_id IS DISTINCT FROM NEW.share_grant_id OR
     OLD.team_id IS DISTINCT FROM NEW.team_id OR
     OLD.team_workspace_id IS DISTINCT FROM NEW.team_workspace_id OR
     OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Conversation Source closure identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purged Conversation Source closure cannot be restored or changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.purged_at IS DISTINCT FROM OLD.purged_at AND NOT (
    NEW.purged_at IS NOT NULL AND v_lifecycle IN ('purge_pending','purged')
      AND v_tombstoned_at IS NOT NULL
      AND NEW.source_snapshot = '{}'::jsonb
      AND NEW.source_payload_count = 0
      AND NEW.source_manifest_hash IS NULL
  ) THEN
    RAISE EXCEPTION 'Conversation Source closure can be cleared only by retention purge'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.purged_at IS NULL AND (
    NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot OR
    NEW.source_payload_count IS DISTINCT FROM OLD.source_payload_count OR
    NEW.source_manifest_hash IS DISTINCT FROM OLD.source_manifest_hash
  ) THEN
    RAISE EXCEPTION 'Conversation Source closure is immutable after publication'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.suppressed_at IS DISTINCT FROM OLD.suppressed_at AND NOT (
    OLD.suppressed_at IS NULL AND NEW.suppressed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Conversation Source suppression is monotonic'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_grant_freeze_source_payload_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_frozen_at timestamptz;
  v_lifecycle text;
  v_tombstoned_at timestamptz;
BEGIN
  SELECT grant_row.frozen_at, grant_row.lifecycle, grant_row.tombstoned_at
    INTO v_frozen_at, v_lifecycle, v_tombstoned_at
    FROM team_memory_share_grants grant_row
   WHERE grant_row.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END;
  IF TG_OP = 'DELETE' AND NOT FOUND THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Conversation Source closure payload cannot be added after grant freeze'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF v_lifecycle NOT IN ('purge_pending','purged') OR v_tombstoned_at IS NULL THEN
      RAISE EXCEPTION 'Conversation Source closure payload can be deleted only by retention purge'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.share_grant_id IS DISTINCT FROM NEW.share_grant_id OR
     OLD.team_id IS DISTINCT FROM NEW.team_id OR
     OLD.team_workspace_id IS DISTINCT FROM NEW.team_workspace_id OR
     OLD.source_table IS DISTINCT FROM NEW.source_table OR
     OLD.source_id IS DISTINCT FROM NEW.source_id OR
     OLD.source_column IS DISTINCT FROM NEW.source_column OR
     OLD.plaintext_content_type IS DISTINCT FROM NEW.plaintext_content_type OR
     OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'Conversation Source closure payload identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.envelope IS DISTINCT FROM NEW.envelope OR OLD.rewrapped_at IS DISTINCT FROM NEW.rewrapped_at THEN
    IF v_frozen_at IS NULL OR v_lifecycle IN ('purge_pending','purged') OR
       (NEW.envelope - ARRAY['keyVersion','wrappedDek','reencryptedAt']) IS DISTINCT FROM
       (OLD.envelope - ARRAY['keyVersion','wrappedDek','reencryptedAt']) OR
       (NEW.envelope->'keyVersion') IS NULL OR
       jsonb_typeof(NEW.envelope->'keyVersion') <> 'number' OR
       jsonb_typeof(NEW.envelope->'wrappedDek') <> 'object' OR
       NOT (NEW.envelope ? 'reencryptedAt') OR
       jsonb_typeof(NEW.envelope->'reencryptedAt') NOT IN ('string','null') THEN
      RAISE EXCEPTION 'Conversation Source closure permits only Team-key wrapper rewrap'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_team_memory_grant_freeze_association_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_grant_id uuid;
  v_frozen_at timestamptz;
  v_lifecycle text;
  v_tombstoned_at timestamptz;
BEGIN
  v_grant_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.share_grant_id ELSE NEW.share_grant_id END;
  SELECT frozen_at, lifecycle, tombstoned_at
    INTO v_frozen_at, v_lifecycle, v_tombstoned_at
    FROM team_memory_share_grants WHERE id = v_grant_id;
  IF TG_OP = 'DELETE' AND NOT FOUND THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_frozen_at IS NOT NULL THEN
      RAISE EXCEPTION 'Frozen Share Grant closure associations are immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Frozen Share Grant closure associations cannot be updated'
      USING ERRCODE = '55000';
  END IF;
  IF v_frozen_at IS NOT NULL AND
     (v_lifecycle NOT IN ('purge_pending','purged') OR v_tombstoned_at IS NULL) THEN
    RAISE EXCEPTION 'Frozen Share Grant closure associations can be deleted only by retention purge'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_validate_team_memory_grant_freeze_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_grant_id uuid;
  v_grant team_memory_share_grants%ROWTYPE;
  v_representation_count integer;
  v_source_payload_count integer;
  v_alias_count integer;
  v_semantic_item_count integer;
  v_chunk_count integer;
  v_actual_manifest_hash text;
  v_source_header team_memory_grant_freeze_sources%ROWTYPE;
  v_pair record;
BEGIN
  IF TG_TABLE_NAME = 'team_memory_share_grants' THEN
    IF TG_OP = 'DELETE' THEN
      v_grant_id := OLD.id;
    ELSE
      v_grant_id := NEW.id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      v_grant_id := OLD.share_grant_id;
    ELSE
      v_grant_id := NEW.share_grant_id;
    END IF;
  END IF;
  SELECT * INTO v_grant FROM team_memory_share_grants WHERE id = v_grant_id;
  IF NOT FOUND OR v_grant.frozen_at IS NULL OR v_grant.lifecycle IN ('purge_pending','purged') THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer INTO v_representation_count
    FROM team_memory_grant_freeze_representations
   WHERE share_grant_id = v_grant_id;
  IF v_representation_count <> v_grant.freeze_representation_count THEN
    RAISE EXCEPTION 'Frozen Share Grant representation count does not match its closure'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_source_header FROM team_memory_grant_freeze_sources
   WHERE share_grant_id = v_grant_id;
  IF FOUND IS DISTINCT FROM v_grant.freeze_source_access_expected THEN
    RAISE EXCEPTION 'Frozen Conversation Source header presence does not match its grant'
      USING ERRCODE = '23514';
  END IF;
  IF FOUND THEN
    SELECT count(*)::integer INTO v_source_payload_count
      FROM team_memory_grant_freeze_source_payloads
     WHERE share_grant_id = v_grant_id;
    IF v_source_header.purged_at IS NOT NULL OR
       v_source_header.source_payload_count <> v_source_payload_count THEN
      RAISE EXCEPTION 'Frozen Conversation Source payload count does not match its closure'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  FOR v_pair IN
    SELECT frozen_representation_id, representation
      FROM team_memory_grant_freeze_representations
     WHERE share_grant_id = v_grant_id
  LOOP
    SELECT count(*)::integer INTO v_chunk_count
      FROM team_memory_representation_chunks
     WHERE representation_id = v_pair.frozen_representation_id
       AND purged_at IS NULL;
    IF v_chunk_count <> (
      SELECT chunk_count FROM team_memory_representations
       WHERE id = v_pair.frozen_representation_id
         AND frozen_snapshot = true
    ) THEN
      RAISE EXCEPTION 'Frozen representation chunk count does not match its closure'
        USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::integer INTO v_alias_count
      FROM team_memory_grant_freeze_item_aliases
     WHERE share_grant_id = v_grant_id AND representation = v_pair.representation;
    SELECT count(*)::integer INTO v_semantic_item_count
      FROM team_memory_semantic_items
     WHERE representation_id = v_pair.frozen_representation_id;
    IF v_alias_count <> v_semantic_item_count THEN
      RAISE EXCEPTION 'Frozen semantic item aliases do not match the closure'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  SELECT encode(digest(
           coalesce(string_agg(name || ':' || entry_hash, E'\n' ORDER BY name), ''),
           'sha256'), 'hex')
    INTO v_actual_manifest_hash
    FROM (
      SELECT 'representation:' || representation::text AS name,
             manifest_hash AS entry_hash
        FROM team_memory_grant_freeze_representations
       WHERE share_grant_id = v_grant_id
      UNION ALL
      SELECT 'conversation_source_access' AS name,
             source_manifest_hash AS entry_hash
        FROM team_memory_grant_freeze_sources
       WHERE share_grant_id = v_grant_id AND purged_at IS NULL
    ) entries;
  IF v_actual_manifest_hash IS DISTINCT FROM v_grant.freeze_manifest_hash THEN
    RAISE EXCEPTION 'Frozen Share Grant manifest does not match its closure'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_source_artifact_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON conversation_source_artifacts
FOR EACH ROW EXECUTE FUNCTION koed_conversation_source_artifact_publication_fence();
--> statement-breakpoint
CREATE TRIGGER conversation_source_segment_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON conversation_source_segments
FOR EACH ROW EXECUTE FUNCTION koed_conversation_source_segment_publication_fence();
--> statement-breakpoint
CREATE TRIGGER sanitized_source_artifact_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON privacy_sanitized_source_artifacts
FOR EACH ROW EXECUTE FUNCTION koed_sanitized_source_artifact_publication_fence();
--> statement-breakpoint
CREATE TRIGGER sanitized_source_chunk_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON privacy_sanitized_source_chunks
FOR EACH ROW EXECUTE FUNCTION koed_sanitized_source_chunk_publication_fence();
--> statement-breakpoint
CREATE TRIGGER encrypted_sanitized_source_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON encrypted_field_payloads
FOR EACH ROW EXECUTE FUNCTION koed_encrypted_sanitized_source_publication_fence();
--> statement-breakpoint
CREATE TRIGGER team_memory_share_grant_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_share_grants
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_grant_freeze_guard();
--> statement-breakpoint
CREATE TRIGGER team_memory_representation_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_representations
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_representation_freeze_guard();
--> statement-breakpoint
CREATE TRIGGER team_memory_representation_chunk_freeze_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_representation_chunks
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_representation_chunk_freeze_guard();
--> statement-breakpoint
CREATE TRIGGER team_memory_semantic_item_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_semantic_items
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_semantic_item_publication_fence();
--> statement-breakpoint
CREATE TRIGGER team_memory_semantic_vectors_384_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_semantic_vectors_384
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_semantic_vector_publication_fence();
--> statement-breakpoint
CREATE TRIGGER team_memory_semantic_vectors_1024_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_semantic_vectors_1024
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_semantic_vector_publication_fence();
--> statement-breakpoint
CREATE TRIGGER team_memory_semantic_vectors_1536_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_semantic_vectors_1536
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_semantic_vector_publication_fence();
--> statement-breakpoint
CREATE TRIGGER team_memory_semantic_vectors_3072_publication_fence
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_semantic_vectors_3072
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_semantic_vector_publication_fence();
--> statement-breakpoint
CREATE TRIGGER team_memory_grant_freeze_source_header_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_sources
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_grant_freeze_source_header_guard();
--> statement-breakpoint
CREATE TRIGGER team_memory_grant_freeze_source_payload_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_source_payloads
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_grant_freeze_source_payload_guard();
--> statement-breakpoint
CREATE TRIGGER team_memory_grant_freeze_representation_association_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_representations
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_grant_freeze_association_guard();
--> statement-breakpoint
CREATE TRIGGER team_memory_grant_freeze_item_alias_guard
BEFORE INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_item_aliases
FOR EACH ROW EXECUTE FUNCTION koed_team_memory_grant_freeze_association_guard();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_memory_share_grant_freeze_closure_check
AFTER INSERT OR UPDATE OR DELETE ON team_memory_share_grants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_validate_team_memory_grant_freeze_closure();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_memory_grant_freeze_representation_closure_check
AFTER INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_representations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_validate_team_memory_grant_freeze_closure();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_memory_grant_freeze_source_closure_check
AFTER INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_sources
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_validate_team_memory_grant_freeze_closure();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_memory_grant_freeze_payload_closure_check
AFTER INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_source_payloads
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_validate_team_memory_grant_freeze_closure();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER team_memory_grant_freeze_alias_closure_check
AFTER INSERT OR UPDATE OR DELETE ON team_memory_grant_freeze_item_aliases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION koed_validate_team_memory_grant_freeze_closure();
--> statement-breakpoint
DO $$
DECLARE
  existing_projection text;
BEGIN
  SELECT string_agg(
    CASE attname
      WHEN 'source_kind' THEN 'binding.source_kind'
      WHEN 'source_session_id' THEN 'binding.source_session_id'
      WHEN 'source_note_id' THEN 'binding.source_note_id'
      WHEN 'source_memory_event_id' THEN 'binding.source_memory_event_id'
      ELSE format('grant_row.%I', attname)
    END,
    ', ' ORDER BY attnum
  ) INTO existing_projection
  FROM pg_attribute
  WHERE attrelid = 'team_memory_share_grant_records'::regclass
    AND attnum > 0 AND NOT attisdropped;

  EXECUTE format(
    'CREATE OR REPLACE VIEW team_memory_share_grant_records AS '
    || 'SELECT %s, grant_row.frozen_at, grant_row.freeze_mutation_id, '
    || 'grant_row.freeze_manifest_hash, grant_row.freeze_representation_count, '
    || 'grant_row.freeze_source_access_expected '
    || 'FROM team_memory_share_grants grant_row '
    || 'JOIN logical_memory_source_revision_bindings binding '
    || 'ON binding.source_revision_id = grant_row.source_revision_id',
    existing_projection
  );
END;
$$;
--> statement-breakpoint
CREATE TABLE "team_memory_curated_item_eligibility" (
	"semantic_item_id" uuid PRIMARY KEY NOT NULL,
	"representation_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"team_workspace_id" uuid NOT NULL,
	"logical_memory_id" uuid NOT NULL,
	"pseudonymous_source_id" uuid NOT NULL,
	"pinned_revision_hash" text,
	"blocked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_memory_curated_item_eligibility_hash_check" CHECK ("team_memory_curated_item_eligibility"."pinned_revision_hash" is null or length("team_memory_curated_item_eligibility"."pinned_revision_hash") = 64),
	CONSTRAINT "team_memory_curated_item_eligibility_unknown_blocked_check" CHECK ("team_memory_curated_item_eligibility"."pinned_revision_hash" is not null or "team_memory_curated_item_eligibility"."blocked_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "team_memory_curated_item_eligibility" ADD CONSTRAINT "team_memory_curated_item_eligibility_item_scope_fk" FOREIGN KEY ("semantic_item_id","representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") REFERENCES "public"."team_memory_semantic_items"("id","representation_id","share_grant_id","team_id","team_workspace_id","logical_memory_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "team_memory_curated_item_eligibility_grant_source_idx" ON "team_memory_curated_item_eligibility" USING btree ("share_grant_id","pseudonymous_source_id");
--> statement-breakpoint
--> statement-breakpoint
CREATE OR REPLACE FUNCTION koed_grant_scoped_curated_source_id(
  p_share_grant_id uuid,
  p_assertion_id uuid
) RETURNS uuid LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  bytes bytea;
  hex text;
BEGIN
  bytes := digest(
    '{"kind":"shared_memory_team_source","shareGrantId":"'
      || p_share_grant_id::text || '","sourceId":"'
      || p_assertion_id::text || '"}',
    'sha256'
  );
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 80);
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);
  hex := encode(bytes, 'hex');
  RETURN (substring(hex from 1 for 8) || '-' ||
          substring(hex from 9 for 4) || '-' ||
          substring(hex from 13 for 4) || '-' ||
          substring(hex from 17 for 4) || '-' ||
          substring(hex from 21 for 12))::uuid;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_curated_representations_for_assertion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT grant_row.id AS grant_id,grant_row.logical_memory_id
      FROM team_memory_share_grants grant_row
      JOIN local_captured_session_logical_memories local_source
        ON local_source.logical_memory_id=grant_row.logical_memory_id
      JOIN curated_memory_sources source ON source.assertion_id=NEW.id
      LEFT JOIN conversation_items item ON item.id=source.conversation_item_id
      LEFT JOIN memory_events event ON event.id=source.memory_event_id
      LEFT JOIN memory_nodes node ON node.id=source.lcm_node_id
     WHERE grant_row.owner_user_id=NEW.owner_user_id
       AND grant_row.include_curated_memory=true
       AND local_source.local_session_id IN
         (item.session_id,event.session_id,node.session_id)
     ORDER BY grant_row.id
  LOOP
    PERFORM 1 FROM team_memory_share_grants WHERE id=affected.grant_id FOR UPDATE;
    PERFORM koed_lock_shared_memory_publication_fence(affected.logical_memory_id);
    INSERT INTO team_memory_curated_item_eligibility (
      semantic_item_id,representation_id,share_grant_id,team_id,
      team_workspace_id,logical_memory_id,pseudonymous_source_id,
      pinned_revision_hash,blocked_at
    )
    SELECT semantic_item.id,semantic_item.representation_id,
           semantic_item.share_grant_id,semantic_item.team_id,
           semantic_item.team_workspace_id,semantic_item.logical_memory_id,
           semantic_item.pseudonymous_source_id,null,now()
      FROM team_memory_semantic_items semantic_item
      JOIN team_memory_representations representation
        ON representation.id=semantic_item.representation_id
     WHERE semantic_item.share_grant_id=affected.grant_id
       AND representation.representation='curated_assertions'
       AND representation.frozen_snapshot=true
       AND semantic_item.pseudonymous_source_id=
         koed_grant_scoped_curated_source_id(affected.grant_id,NEW.id)
    ON CONFLICT (semantic_item_id) DO UPDATE
      SET blocked_at=now(),updated_at=now();
  END LOOP;
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
      FROM team_memory_share_grants share_grant,
           local_captured_session_logical_memories local_source
     WHERE share_grant.id=representation.share_grant_id
       AND local_source.logical_memory_id=share_grant.logical_memory_id
       AND local_source.local_session_id IN (
         SELECT session_id FROM affected_sessions WHERE session_id IS NOT NULL
       )
       AND representation.representation='curated_assertions'
       AND representation.frozen_snapshot=false
       AND representation.state IN ('pending','available','stale')
     RETURNING representation.id
  )
  DELETE FROM team_memory_semantic_items semantic_item
   USING invalidated
   WHERE semantic_item.representation_id=invalidated.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_curated_representations_for_session()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected record;
BEGIN
  FOR affected IN
    SELECT DISTINCT grant_row.id AS grant_id,grant_row.logical_memory_id
      FROM team_memory_share_grants grant_row
      JOIN local_captured_session_logical_memories local_source
        ON local_source.logical_memory_id=grant_row.logical_memory_id
     WHERE local_source.local_session_id=NEW.session_id
       AND grant_row.include_curated_memory=true
     ORDER BY grant_row.id
  LOOP
    PERFORM 1 FROM team_memory_share_grants WHERE id=affected.grant_id FOR UPDATE;
    PERFORM koed_lock_shared_memory_publication_fence(affected.logical_memory_id);
    INSERT INTO team_memory_curated_item_eligibility (
      semantic_item_id,representation_id,share_grant_id,team_id,
      team_workspace_id,logical_memory_id,pseudonymous_source_id,
      pinned_revision_hash,blocked_at
    )
    SELECT semantic_item.id,semantic_item.representation_id,
           semantic_item.share_grant_id,semantic_item.team_id,
           semantic_item.team_workspace_id,semantic_item.logical_memory_id,
           semantic_item.pseudonymous_source_id,null,now()
      FROM team_memory_semantic_items semantic_item
      JOIN team_memory_representations representation
        ON representation.id=semantic_item.representation_id
     WHERE semantic_item.share_grant_id=affected.grant_id
       AND representation.representation='curated_assertions'
       AND representation.frozen_snapshot=true
    ON CONFLICT (semantic_item_id) DO UPDATE
      SET blocked_at=now(),updated_at=now();
  END LOOP;
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
      FROM team_memory_share_grants share_grant,
           local_captured_session_logical_memories local_source
     WHERE share_grant.id=representation.share_grant_id
       AND local_source.logical_memory_id=share_grant.logical_memory_id
       AND local_source.local_session_id=NEW.session_id
       AND representation.representation='curated_assertions'
       AND representation.frozen_snapshot=false
       AND representation.state IN ('pending','available','stale')
     RETURNING representation.id
  )
  DELETE FROM team_memory_semantic_items semantic_item
   USING invalidated
   WHERE semantic_item.representation_id=invalidated.id;
  RETURN NEW;
END;
$$;
