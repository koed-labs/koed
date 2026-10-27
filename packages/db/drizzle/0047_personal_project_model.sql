-- Consolidated unreleased Personal Project model.
-- Preserve statement order for backfills and custom database guards.

-- Personal Project membership.
CREATE TABLE "personal_membership_changes" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"replaces" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"operation" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_membership_changes_revision_id_unique" UNIQUE("revision_id"),
	CONSTRAINT "personal_membership_changes_operation_check" CHECK ("personal_membership_changes"."operation" in ('set_project','delete_project','include_session','remove_inclusion'))
);
--> statement-breakpoint
CREATE TABLE "personal_named_projects" (
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"head_revision_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_named_projects_owner_user_id_project_id_pk" PRIMARY KEY("owner_user_id","project_id"),
	CONSTRAINT "personal_named_projects_name_check" CHECK (length(trim("personal_named_projects"."name")) between 1 and 160),
	CONSTRAINT "personal_named_projects_version_check" CHECK ("personal_named_projects"."version">0)
);
--> statement-breakpoint
CREATE TABLE "personal_project_inclusions" (
	"inclusion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"source_reference" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"head_revision_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_inclusions_source_unique" UNIQUE("owner_user_id","project_id","logical_session_id"),
	CONSTRAINT "personal_project_inclusions_version_check" CHECK ("personal_project_inclusions"."version">0)
);
--> statement-breakpoint
ALTER TABLE "personal_membership_changes" ADD CONSTRAINT "personal_membership_changes_owner_user_id_project_id_personal_named_projects_owner_user_id_project_id_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."personal_named_projects"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_named_projects" ADD CONSTRAINT "personal_named_projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_project_inclusions" ADD CONSTRAINT "personal_project_inclusions_owner_user_id_project_id_personal_named_projects_owner_user_id_project_id_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."personal_named_projects"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_membership_changes_owner_sequence_idx" ON "personal_membership_changes" USING btree ("owner_user_id","sequence");--> statement-breakpoint
CREATE INDEX "personal_named_projects_owner_active_idx" ON "personal_named_projects" USING btree ("owner_user_id","deleted_at");--> statement-breakpoint
CREATE INDEX "personal_project_inclusions_source_idx" ON "personal_project_inclusions" USING btree ("owner_user_id","logical_session_id");--> statement-breakpoint
CREATE FUNCTION personal_membership_change_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Personal membership revisions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_membership_change_immutable_update
BEFORE UPDATE ON personal_membership_changes
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint

-- Project-scoped questions.
ALTER TABLE "memory_questions" DROP CONSTRAINT "memory_questions_ask_identity_check";--> statement-breakpoint
ALTER TABLE "memory_questions" ADD CONSTRAINT "memory_questions_ask_identity_check" CHECK (("memory_questions"."origin" = 'mcp_memory_answer' and "memory_questions"."ask_thread_id" is null and "memory_questions"."ask_turn_index" is null)
        or ("memory_questions"."origin" = 'desktop_ask' and "memory_questions"."ask_thread_id" is not null and "memory_questions"."ask_turn_index" >= 0 and "memory_questions"."team_workspace_id" is null and "memory_questions"."search_domain" in ('global','project')));
--> statement-breakpoint

-- Recorded Folder context.
CREATE TABLE "session_folder_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"observation_hash" text NOT NULL,
	"observation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "folder_assignment" jsonb DEFAULT '{"revision":1,"original":{"state":"unresolved","reason":"historical_unresolved"},"correction":{"state":"original"}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "session_folder_observations" ADD CONSTRAINT "session_folder_observations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_folder_observations" ADD CONSTRAINT "session_folder_observations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_folder_observations_dedupe_idx" ON "session_folder_observations" USING btree ("session_id","observation_hash");--> statement-breakpoint
CREATE INDEX "session_folder_observations_owner_idx" ON "session_folder_observations" USING btree ("owner_user_id","session_id");
--> statement-breakpoint

-- Git Anchor inclusion rules.
CREATE TABLE "personal_project_rules" (
	"inclusion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"target" jsonb NOT NULL,
	"target_scope" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"head_revision_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_rules_target_unique" UNIQUE("owner_user_id","project_id","target_scope"),
	CONSTRAINT "personal_project_rules_version_check" CHECK ("personal_project_rules"."version">0),
	CONSTRAINT "personal_project_rules_target_check" CHECK (coalesce("personal_project_rules"."target"->>'kind'='repository' and "personal_project_rules"."target"->'repository'->>'kind' in ('portable_repository','device_local_repository') and repository_scope_id("personal_project_rules"."target"->'repository') is not null and "personal_project_rules"."target_scope"=repository_scope_id("personal_project_rules"."target"->'repository'),false))
);
--> statement-breakpoint
ALTER TABLE "personal_membership_changes" DROP CONSTRAINT "personal_membership_changes_operation_check";--> statement-breakpoint
ALTER TABLE "personal_project_rules" ADD CONSTRAINT "personal_project_rules_owner_user_id_project_id_personal_named_projects_owner_user_id_project_id_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."personal_named_projects"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_project_rules_owner_active_idx" ON "personal_project_rules" USING btree ("owner_user_id","project_id","removed_at");--> statement-breakpoint
ALTER TABLE "personal_membership_changes" ADD CONSTRAINT "personal_membership_changes_operation_check" CHECK ("personal_membership_changes"."operation" in ('set_project','delete_project','include_session','include_repository','remove_inclusion'));
--> statement-breakpoint

-- Exact Folder inclusion rules.
ALTER TABLE "personal_membership_changes" DROP CONSTRAINT "personal_membership_changes_operation_check";--> statement-breakpoint
ALTER TABLE "personal_project_rules" DROP CONSTRAINT "personal_project_rules_target_check";--> statement-breakpoint
ALTER TABLE "personal_project_rules" ADD COLUMN "folder_context" jsonb;--> statement-breakpoint
ALTER TABLE "personal_membership_changes" ADD CONSTRAINT "personal_membership_changes_operation_check" CHECK ("personal_membership_changes"."operation" in ('set_project','delete_project','include_session','include_repository','include_folder','remove_inclusion'));--> statement-breakpoint
ALTER TABLE "personal_project_rules" ADD CONSTRAINT "personal_project_rules_target_check" CHECK (coalesce((
        "personal_project_rules"."target"->>'kind'='repository' and "personal_project_rules"."target"->'repository'->>'kind' in ('portable_repository','device_local_repository')
        and repository_scope_id("personal_project_rules"."target"->'repository') is not null and "personal_project_rules"."target_scope"=repository_scope_id("personal_project_rules"."target"->'repository') and "personal_project_rules"."folder_context" is null
      ) or (
        "personal_project_rules"."target"->>'kind'='folder' and "personal_project_rules"."target"->'folder'->>'ownerUserId'="personal_project_rules"."owner_user_id"::text
        and "personal_project_rules"."target_scope"=('folder:' || ("personal_project_rules"."target"->'folder'->>'ownerUserId') || ':' || ("personal_project_rules"."target"->'folder'->>'originatingDeploymentId')
          || ':' || ("personal_project_rules"."target"->'folder'->>'originatingDeviceId') || ':' || ("personal_project_rules"."target"->'folder'->>'originatingProfileId')
          || ':' || ("personal_project_rules"."target"->'folder'->>'directoryIncarnationId') || ':' || ("personal_project_rules"."target"->'folder'->>'folderId'))
        and ("personal_project_rules"."folder_context" is null or "personal_project_rules"."folder_context"->'reference'="personal_project_rules"."target"->'folder')
      ),false));
--> statement-breakpoint

-- Project exclusions.
CREATE TABLE "personal_project_exclusions" (
	"exclusion_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"source_reference" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"head_revision_id" uuid NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_exclusions_source_unique" UNIQUE("owner_user_id","project_id","logical_session_id"),
	CONSTRAINT "personal_project_exclusions_version_check" CHECK ("personal_project_exclusions"."version">0),
	CONSTRAINT "personal_project_exclusions_source_owner_check" CHECK ("personal_project_exclusions"."source_reference" is null or coalesce("personal_project_exclusions"."source_reference"->>'ownerUserId'="personal_project_exclusions"."owner_user_id"::text,false))
);
--> statement-breakpoint
ALTER TABLE "personal_membership_changes" DROP CONSTRAINT "personal_membership_changes_operation_check";--> statement-breakpoint
ALTER TABLE "personal_project_exclusions" ADD CONSTRAINT "personal_project_exclusions_owner_user_id_project_id_personal_named_projects_owner_user_id_project_id_fk" FOREIGN KEY ("owner_user_id","project_id") REFERENCES "public"."personal_named_projects"("owner_user_id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_project_exclusions_active_idx" ON "personal_project_exclusions" USING btree ("owner_user_id","project_id","logical_session_id","cleared_at");--> statement-breakpoint
ALTER TABLE "personal_membership_changes" ADD CONSTRAINT "personal_membership_changes_operation_check" CHECK ("personal_membership_changes"."operation" in ('set_project','delete_project','include_session','include_repository','include_folder','remove_inclusion','exclude','clear_exclusion'));
--> statement-breakpoint

-- Source context corrections.
CREATE TABLE "personal_source_context_changes" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"revision_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"version" integer NOT NULL,
	"previous" jsonb NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_source_context_changes_revision_id_unique" UNIQUE("revision_id"),
	CONSTRAINT "personal_source_context_changes_version_unique" UNIQUE("owner_user_id","logical_session_id","axis","version"),
	CONSTRAINT "personal_source_context_changes_axis_check" CHECK ("personal_source_context_changes"."axis" in ('git','folder')),
	CONSTRAINT "personal_source_context_changes_version_check" CHECK ("personal_source_context_changes"."version">0)
);
--> statement-breakpoint
CREATE TABLE "personal_source_context_reviews" (
	"review_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"expected_version" integer NOT NULL,
	"revision_id" uuid NOT NULL,
	"patch" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_source_context_reviews_axis_check" CHECK ("personal_source_context_reviews"."axis" in ('git','folder')),
	CONSTRAINT "personal_source_context_reviews_version_check" CHECK ("personal_source_context_reviews"."expected_version">0)
);
--> statement-breakpoint
ALTER TABLE "personal_source_context_changes" ADD CONSTRAINT "personal_source_context_changes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_context_reviews" ADD CONSTRAINT "personal_source_context_reviews_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_source_context_changes_owner_idx" ON "personal_source_context_changes" USING btree ("owner_user_id","logical_session_id","axis","sequence");--> statement-breakpoint
CREATE INDEX "personal_source_context_reviews_owner_idx" ON "personal_source_context_reviews" USING btree ("owner_user_id","session_id","created_at");
--> statement-breakpoint

-- Git correction revision heads.
ALTER TABLE "sessions" ADD COLUMN "repository_assignment_revision_id" uuid;
--> statement-breakpoint
UPDATE sessions s SET repository_assignment_revision_id=c.revision_id
FROM personal_source_context_changes c
WHERE c.owner_user_id=s.owner_user_id AND c.logical_session_id=s.logical_session_id
  AND c.axis='git' AND c.version=s.repository_assignment_version;
--> statement-breakpoint

-- Configuration capabilities.
CREATE TABLE "pds_configuration_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"canonical_advertisement" text NOT NULL,
	"canonical_request_proof" text NOT NULL,
	"advertised_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_configuration_capability_device_unique" UNIQUE("group_id","device_id")
);
--> statement-breakpoint
ALTER TABLE "pds_configuration_capabilities" ADD CONSTRAINT "pds_configuration_capabilities_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_configuration_capability_expiry_idx" ON "pds_configuration_capabilities" USING btree ("group_id","expires_at");
--> statement-breakpoint

-- Verified source context.
CREATE TABLE "personal_source_bindings" (
	"binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"originating_deployment_id" text NOT NULL,
	"originating_device_id" text NOT NULL,
	"source_logical_session_id" text NOT NULL,
	"originating_owner_user_id" uuid,
	"local_session_id" uuid,
	"local_logical_session_id" uuid,
	"context_version" integer DEFAULT 0 NOT NULL,
	"availability" text DEFAULT 'pending' NOT NULL,
	"retained_package_id" uuid,
	"git_original" jsonb,
	"folder_original" jsonb,
	"git_state" text DEFAULT 'pending' NOT NULL,
	"folder_state" text DEFAULT 'pending' NOT NULL,
	"git_frontier" text[] DEFAULT '{}'::text[] NOT NULL,
	"folder_frontier" text[] DEFAULT '{}'::text[] NOT NULL,
	"git_assignment" jsonb,
	"folder_assignment" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_source_bindings_native_unique" UNIQUE("owner_user_id","local_session_id"),
	CONSTRAINT "personal_source_bindings_identity_unique" UNIQUE("owner_user_id","originating_deployment_id","originating_device_id","source_logical_session_id"),
	CONSTRAINT "personal_source_bindings_context_version_check" CHECK ("personal_source_bindings"."context_version" in (0,1)),
	CONSTRAINT "personal_source_bindings_availability_check" CHECK ("personal_source_bindings"."availability" in ('pending','available')),
	CONSTRAINT "personal_source_bindings_context_state_check" CHECK ("personal_source_bindings"."git_state" in ('pending','available','conflict') and "personal_source_bindings"."folder_state" in ('pending','available','conflict')),
	CONSTRAINT "personal_source_bindings_identity_bounds_check" CHECK (length("personal_source_bindings"."originating_deployment_id") between 1 and 128 and length("personal_source_bindings"."originating_device_id") between 1 and 128 and length("personal_source_bindings"."source_logical_session_id") between 1 and 512)
);
--> statement-breakpoint
CREATE TABLE "personal_source_context_revisions" (
	"binding_id" uuid NOT NULL,
	"axis" text NOT NULL,
	"revision_id" text NOT NULL,
	"replaces" text[] NOT NULL,
	"assignment" jsonb NOT NULL,
	"witness_device_id" text,
	"verified_record_hash" text,
	"retained_package_id" uuid,
	"local_change_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_source_context_revisions_binding_id_axis_revision_id_pk" PRIMARY KEY("binding_id","axis","revision_id"),
	CONSTRAINT "personal_source_context_revisions_axis_check" CHECK ("personal_source_context_revisions"."axis" in ('git','folder')),
	CONSTRAINT "personal_source_context_revisions_identity_bounds_check" CHECK (length("personal_source_context_revisions"."revision_id") between 1 and 128 and ("personal_source_context_revisions"."witness_device_id" is null or length("personal_source_context_revisions"."witness_device_id") between 1 and 128) and cardinality("personal_source_context_revisions"."replaces")<=1024)
);
--> statement-breakpoint
ALTER TABLE "personal_source_bindings" ADD CONSTRAINT "personal_source_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_bindings" ADD CONSTRAINT "personal_source_bindings_local_session_id_sessions_id_fk" FOREIGN KEY ("local_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_bindings" ADD CONSTRAINT "personal_source_bindings_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_bindings" ADD CONSTRAINT "personal_source_bindings_local_session_id_owner_user_id_sessions_id_owner_user_id_fk" FOREIGN KEY ("local_session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_context_revisions" ADD CONSTRAINT "personal_source_context_revisions_binding_id_personal_source_bindings_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."personal_source_bindings"("binding_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_context_revisions" ADD CONSTRAINT "personal_source_context_revisions_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_source_context_revisions" ADD CONSTRAINT "personal_source_context_revisions_local_change_revision_id_personal_source_context_changes_revision_id_fk" FOREIGN KEY ("local_change_revision_id") REFERENCES "public"."personal_source_context_changes"("revision_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_source_bindings_session_idx" ON "personal_source_bindings" USING btree ("owner_user_id","local_session_id");--> statement-breakpoint
CREATE INDEX "personal_source_context_revisions_local_change_idx" ON "personal_source_context_revisions" USING btree ("local_change_revision_id");
--> statement-breakpoint

-- Signed source bindings and immutable guards.
ALTER TABLE "pds_retained_packages" ADD COLUMN "source_logical_session_id" text;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "source_context_hash" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_personal_source_context_update() RETURNS trigger AS $$
DECLARE
  binding personal_source_bindings%ROWTYPE;
  review personal_source_context_reviews%ROWTYPE;
  is_replica boolean;
  git_changed boolean;
  folder_changed boolean;
  projection boolean := false;
BEGIN
  git_changed := NEW.repository_automatic_identity IS DISTINCT FROM OLD.repository_automatic_identity
    OR NEW.repository_override_identity IS DISTINCT FROM OLD.repository_override_identity
    OR NEW.repository_assignment_state IS DISTINCT FROM OLD.repository_assignment_state
    OR NEW.repository_assignment_version IS DISTINCT FROM OLD.repository_assignment_version
    OR NEW.repository_assignment_revision_id IS DISTINCT FROM OLD.repository_assignment_revision_id;
  folder_changed := NEW.folder_assignment IS DISTINCT FROM OLD.folder_assignment;
  IF NOT git_changed AND NOT folder_changed THEN RETURN NEW; END IF;
  SELECT * INTO binding FROM personal_source_bindings WHERE owner_user_id=OLD.owner_user_id AND local_session_id=OLD.id AND context_version=1;
  SELECT EXISTS(SELECT 1 FROM pds_logical_replicas WHERE local_session_id=OLD.id) INTO is_replica;
  IF binding.binding_id IS NULL AND NOT is_replica THEN RETURN NEW; END IF;
  -- Retained legacy assignments keep their existing compatibility path. New metadata requires a reviewed operation.
  IF binding.binding_id IS NULL AND NOT folder_changed
    AND NEW.repository_assignment_revision_id IS NOT DISTINCT FROM OLD.repository_assignment_revision_id THEN RETURN NEW; END IF;
  projection := binding.binding_id IS NOT NULL
    AND binding.binding_id::text IS NOT DISTINCT FROM current_setting('koed.personal_source_context_binding_id',true);
  IF projection THEN
    IF git_changed AND (NEW.repository_automatic_identity IS DISTINCT FROM
      CASE WHEN binding.git_original->>'state'='known' THEN binding.git_original->'value' ELSE NULL END
      OR NEW.repository_assignment_state IS DISTINCT FROM CASE
        WHEN binding.git_original->>'state'='known' THEN 'recorded'
        WHEN binding.git_original->>'reason'='historical_unresolved' THEN 'historical_unresolved' ELSE 'recorded' END) THEN
      RAISE EXCEPTION 'Verified source context does not match its original Git fact';
    END IF;
    IF folder_changed AND NEW.folder_assignment->'original' IS DISTINCT FROM binding.folder_original THEN
      RAISE EXCEPTION 'Verified source context does not match its original Folder fact';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO review FROM personal_source_context_reviews
    WHERE review_id::text=current_setting('koed.personal_source_context_review_id',true)
      AND owner_user_id=OLD.owner_user_id AND session_id=OLD.id AND logical_session_id=OLD.logical_session_id
      AND applied_at IS NULL;
  IF review.review_id IS NOT NULL
    AND NEW.repository_automatic_identity IS NOT DISTINCT FROM OLD.repository_automatic_identity
    AND NEW.repository_assignment_state IS NOT DISTINCT FROM OLD.repository_assignment_state
    AND NEW.folder_assignment->'original' IS NOT DISTINCT FROM OLD.folder_assignment->'original' THEN
    IF review.axis='git' AND NOT folder_changed AND review.expected_version=OLD.repository_assignment_version
      AND NEW.repository_assignment_version=OLD.repository_assignment_version+1
      AND NEW.repository_assignment_revision_id=review.revision_id
      AND NEW.repository_override_identity IS NOT DISTINCT FROM NULLIF(review.patch->'repository_override_identity','null'::jsonb) THEN RETURN NEW; END IF;
    IF review.axis='folder' AND NOT git_changed AND review.expected_version=(OLD.folder_assignment->>'revision')::bigint
      AND NEW.folder_assignment IS NOT DISTINCT FROM review.patch->'folder_assignment' THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Source context requires a verified projection or reviewed correction';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER sessions_guard_personal_source_context
BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION guard_personal_source_context_update();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION pds_reject_closed_source_mutation() RETURNS trigger AS $$
DECLARE
  replica_id text;
  append_start text;
  append_end text;
  is_replica_session boolean;
  mutable_columns text[];
  old_metadata jsonb;
  new_metadata jsonb;
  trusted_assignment boolean;
BEGIN
  IF TG_TABLE_NAME = 'pds_session_closures' THEN
    IF NEW.source_profile_epoch IS DISTINCT FROM OLD.source_profile_epoch
      OR NEW.group_id IS DISTINCT FROM OLD.group_id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.source_session_id IS DISTINCT FROM OLD.source_session_id
      OR NEW.source_sequence IS DISTINCT FROM OLD.source_sequence
      OR NEW.publication_kind IS DISTINCT FROM OLD.publication_kind
      OR NEW.checkpoint_ordinal IS DISTINCT FROM OLD.checkpoint_ordinal
      OR NEW.terminal_cursor IS DISTINCT FROM OLD.terminal_cursor
      OR NEW.terminal_item_count IS DISTINCT FROM OLD.terminal_item_count
      OR NEW.source_closure_hash IS DISTINCT FROM OLD.source_closure_hash
      OR NEW.package_id IS DISTINCT FROM OLD.package_id
      OR NEW.source_manifest_hash IS DISTINCT FROM OLD.source_manifest_hash
      OR NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'PDS Session closure publication is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'sessions' AND TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT r.id::text INTO replica_id FROM pds_logical_replicas r WHERE r.local_session_id = OLD.id;
    IF replica_id IS NOT NULL THEN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PDS replica Sessions are read-only'; END IF;
      mutable_columns := ARRAY['metadata','updated_at','repository_override_identity','repository_assignment_version','repository_assignment_revision_id','folder_assignment',
        'project_override_id','project_override_name','project_override_path','project_override_at','project_override_by_user_id'];
      trusted_assignment := current_setting('koed.pds_replica_append_id',true) IS NOT DISTINCT FROM replica_id;
      trusted_assignment := trusted_assignment OR EXISTS (
        SELECT 1 FROM personal_source_bindings b WHERE b.owner_user_id=OLD.owner_user_id AND b.local_session_id=OLD.id
          AND b.context_version=1 AND b.binding_id::text=current_setting('koed.personal_source_context_binding_id',true)
      );
      old_metadata := OLD.metadata - ARRAY['threadName','threadNameSource','threadNameGeneratedAt','threadNameEditedAt'];
      new_metadata := NEW.metadata - ARRAY['threadName','threadNameSource','threadNameGeneratedAt','threadNameEditedAt'];
      IF current_setting('koed.repository_assignment_cutover',true) = '1'
        AND NEW.repository_assignment_state='historical_unresolved'
        AND NEW.repository_automatic_identity IS NULL AND NEW.repository_override_identity IS NULL
        AND NEW.repository_assignment_version=OLD.repository_assignment_version+1 THEN
        mutable_columns := mutable_columns || ARRAY['repository_assignment_state','repository_automatic_identity'];
      END IF;
      IF trusted_assignment THEN
        mutable_columns := mutable_columns || ARRAY['repository_assignment_state','repository_automatic_identity'];
        old_metadata := old_metadata #- '{pds,repositoryAssignment}';
        new_metadata := new_metadata #- '{pds,repositoryAssignment}';
      END IF;
      IF (to_jsonb(NEW)-mutable_columns) IS DISTINCT FROM (to_jsonb(OLD)-mutable_columns)
        OR new_metadata IS DISTINCT FROM old_metadata THEN
        RAISE EXCEPTION 'PDS replica Sessions are read-only';
      END IF;
    END IF;
    RETURN COALESCE(NEW,OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('pds-session:' || NEW.session_id::text));
    SELECT EXISTS (
      SELECT 1 FROM pds_logical_replicas r WHERE r.local_session_id = NEW.session_id
    ) INTO is_replica_session;
    IF is_replica_session THEN
      SELECT r.id::text INTO replica_id
      FROM pds_logical_replicas r WHERE r.local_session_id = NEW.session_id;
      append_start := current_setting('koed.pds_replica_append_start', true);
      append_end := current_setting('koed.pds_replica_append_end', true);
      IF current_setting('koed.pds_replica_append_id', true) IS DISTINCT FROM replica_id
        OR NEW.source_transport <> 'pds_relay'
        OR NEW.source_sequence IS NULL
        OR append_start IS NULL OR append_end IS NULL
        OR NEW.source_sequence::numeric < append_start::numeric
        OR NEW.source_sequence::numeric > append_end::numeric THEN
        RAISE EXCEPTION 'PDS replica Sessions accept only trusted checkpoint appends';
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pds_session_closures c
      WHERE c.source_session_id = NEW.session_id
        AND c.publication_kind = 'closed' AND c.state = 'ready'
    ) THEN
      RAISE EXCEPTION 'PDS closed source Session cannot accept later items';
    END IF;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT EXISTS (
      SELECT 1 FROM pds_logical_replicas r WHERE r.local_session_id = OLD.session_id
    ) INTO is_replica_session;
    IF is_replica_session OR EXISTS (
      SELECT 1 FROM pds_source_item_mappings m WHERE m.conversation_item_id = OLD.id
    ) THEN
      IF TG_OP = 'DELETE' OR (
        to_jsonb(NEW) - ARRAY[
          'projection_status', 'projection_work_class', 'projection_version',
          'projection_policy_revision', 'projected_at', 'projection_error',
          'memory_excluded_at', 'memory_exclusion_reason', 'memory_excluded_by_user_id',
          'personal_deleted_at', 'personal_deleted_by_user_id', 'personal_deletion_reason'
        ]::text[]
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'projection_status', 'projection_work_class', 'projection_version',
          'projection_policy_revision', 'projected_at', 'projection_error',
          'memory_excluded_at', 'memory_exclusion_reason', 'memory_excluded_by_user_id',
          'personal_deleted_at', 'personal_deleted_by_user_id', 'personal_deletion_reason'
        ]::text[]
      ) THEN
        RAISE EXCEPTION 'PDS source items are read-only';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_personal_source_context_revision() RETURNS trigger AS $$
BEGIN
  IF NEW.binding_id IS DISTINCT FROM OLD.binding_id OR NEW.axis IS DISTINCT FROM OLD.axis
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id OR NEW.replaces IS DISTINCT FROM OLD.replaces
    OR NEW.assignment IS DISTINCT FROM OLD.assignment THEN
    RAISE EXCEPTION 'Personal source context revisions are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_source_context_revisions_immutable
BEFORE UPDATE ON personal_source_context_revisions FOR EACH ROW EXECUTE FUNCTION guard_personal_source_context_revision();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_personal_source_binding() RETURNS trigger AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.originating_deployment_id IS DISTINCT FROM OLD.originating_deployment_id
    OR NEW.originating_device_id IS DISTINCT FROM OLD.originating_device_id
    OR NEW.source_logical_session_id IS DISTINCT FROM OLD.source_logical_session_id
    OR (OLD.local_logical_session_id IS NOT NULL AND NEW.local_logical_session_id IS DISTINCT FROM OLD.local_logical_session_id)
    OR (OLD.local_session_id IS NOT NULL AND NEW.local_session_id IS NOT NULL AND NEW.local_session_id IS DISTINCT FROM OLD.local_session_id)
    OR (OLD.context_version=1 AND (NEW.context_version<>1 OR NEW.git_original IS DISTINCT FROM OLD.git_original
      OR NEW.folder_original IS DISTINCT FROM OLD.folder_original OR NEW.originating_owner_user_id IS DISTINCT FROM OLD.originating_owner_user_id)) THEN
    RAISE EXCEPTION 'Verified Personal source identity and original facts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_source_bindings_immutable_identity
BEFORE UPDATE ON personal_source_bindings FOR EACH ROW EXECUTE FUNCTION guard_personal_source_binding();
--> statement-breakpoint

-- Configuration journal.
CREATE TABLE "personal_configuration_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_row_id" uuid NOT NULL,
	"dispatch_epoch" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"transport_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_configuration_outbox_record_unique" UNIQUE("record_row_id"),
	CONSTRAINT "personal_configuration_outbox_state_check" CHECK ("personal_configuration_outbox"."state" in ('pending','committed','acked','superseded')),
	CONSTRAINT "personal_configuration_outbox_epoch_check" CHECK ("personal_configuration_outbox"."dispatch_epoch" ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "personal_configuration_outbox_attempt_check" CHECK ("personal_configuration_outbox"."attempt_count">=0)
);
--> statement-breakpoint
CREATE TABLE "personal_configuration_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"author_device_id" text NOT NULL,
	"author_signing_key_id" text NOT NULL,
	"record_id" text NOT NULL,
	"record_hash" text NOT NULL,
	"payload_kind" text NOT NULL,
	"direction" text NOT NULL,
	"application_state" text DEFAULT 'pending' NOT NULL,
	"source_binding_id" uuid,
	"encrypted_envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_configuration_record_identity_unique" UNIQUE("group_id","author_device_id","record_id"),
	CONSTRAINT "personal_configuration_record_direction_check" CHECK ("personal_configuration_records"."direction" in ('local','inbound')),
	CONSTRAINT "personal_configuration_record_application_check" CHECK ("personal_configuration_records"."application_state" in ('pending','applied')),
	CONSTRAINT "personal_configuration_record_kind_check" CHECK ("personal_configuration_records"."payload_kind" in ('source_context','project_membership','project_default')),
	CONSTRAINT "personal_configuration_record_bounds_check" CHECK (length("personal_configuration_records"."record_id")=43 and length("personal_configuration_records"."record_hash")=43 and length("personal_configuration_records"."author_device_id") between 1 and 128 and length("personal_configuration_records"."author_signing_key_id") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "personal_configuration_outbox" ADD CONSTRAINT "personal_configuration_outbox_record_row_id_personal_configuration_records_id_fk" FOREIGN KEY ("record_row_id") REFERENCES "public"."personal_configuration_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_configuration_records" ADD CONSTRAINT "personal_configuration_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_configuration_records" ADD CONSTRAINT "personal_configuration_records_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_configuration_records" ADD CONSTRAINT "personal_configuration_records_source_binding_id_personal_source_bindings_binding_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."personal_source_bindings"("binding_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_configuration_outbox_delivery_idx" ON "personal_configuration_outbox" USING btree ("state","retry_at");--> statement-breakpoint
CREATE INDEX "personal_configuration_record_pending_idx" ON "personal_configuration_records" USING btree ("owner_user_id","group_id","application_state");
--> statement-breakpoint
CREATE FUNCTION guard_personal_configuration_record() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.group_id IS DISTINCT FROM OLD.group_id OR NEW.author_device_id IS DISTINCT FROM OLD.author_device_id
    OR NEW.author_signing_key_id IS DISTINCT FROM OLD.author_signing_key_id OR NEW.record_id IS DISTINCT FROM OLD.record_id
    OR NEW.record_hash IS DISTINCT FROM OLD.record_hash OR NEW.payload_kind IS DISTINCT FROM OLD.payload_kind
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR (OLD.source_binding_id IS NOT NULL AND NEW.source_binding_id IS NOT NULL AND NEW.source_binding_id IS DISTINCT FROM OLD.source_binding_id)
    OR (OLD.application_state='applied' AND NEW.application_state<>'applied') THEN
    RAISE EXCEPTION 'Personal configuration identity and accepted state are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_configuration_records_immutable_identity
BEFORE UPDATE ON personal_configuration_records FOR EACH ROW EXECUTE FUNCTION guard_personal_configuration_record();
--> statement-breakpoint

-- Configuration retry state.
ALTER TABLE "personal_configuration_records" ADD COLUMN "retry_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_configuration_records" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Membership causal history.
CREATE TABLE "personal_membership_entities" (
	"owner_user_id" uuid NOT NULL,
	"project_identity" text NOT NULL,
	"entity_identity" text NOT NULL,
	"entity_kind" text NOT NULL,
	"local_project_id" uuid,
	"local_entity_id" uuid,
	"source_binding_id" uuid,
	"selector_key" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"heads" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_revision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_membership_entities_pkey" PRIMARY KEY("owner_user_id","project_identity","entity_identity"),
	CONSTRAINT "personal_membership_entities_kind_check" CHECK ("personal_membership_entities"."entity_kind" in ('project','direct','rule','exclusion')),
	CONSTRAINT "personal_membership_entities_state_check" CHECK ("personal_membership_entities"."state" in ('pending','available','conflict')),
	CONSTRAINT "personal_membership_entities_identity_check" CHECK (length("personal_membership_entities"."project_identity") between 1 and 128 and length("personal_membership_entities"."entity_identity") between 1 and 128 and cardinality("personal_membership_entities"."heads")<=1024),
	CONSTRAINT "personal_membership_entities_root_check" CHECK ("personal_membership_entities"."entity_kind"<>'project' or "personal_membership_entities"."entity_identity"="personal_membership_entities"."project_identity")
);
--> statement-breakpoint
CREATE TABLE "personal_membership_resolution_reviews" (
	"review_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_identity" text NOT NULL,
	"entity_identity" text NOT NULL,
	"expected_heads" text[] NOT NULL,
	"expected_project_state" jsonb NOT NULL,
	"revision_id" text NOT NULL,
	"operation" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_membership_resolution_reviews_bounds_check" CHECK (cardinality("personal_membership_resolution_reviews"."expected_heads") between 1 and 1024 and length("personal_membership_resolution_reviews"."revision_id") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "personal_membership_revisions" (
	"owner_user_id" uuid NOT NULL,
	"project_identity" text NOT NULL,
	"entity_identity" text NOT NULL,
	"revision_id" text NOT NULL,
	"replaces" text[] NOT NULL,
	"revision" jsonb NOT NULL,
	"witness_device_id" text NOT NULL,
	"verified_record_hash" text,
	"native_change_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_membership_revisions_pkey" PRIMARY KEY("owner_user_id","project_identity","entity_identity","revision_id"),
	CONSTRAINT "personal_membership_revisions_owner_revision_unique" UNIQUE("owner_user_id","revision_id"),
	CONSTRAINT "personal_membership_revisions_native_change_unique" UNIQUE("native_change_revision_id"),
	CONSTRAINT "personal_membership_revisions_bounds_check" CHECK (length("personal_membership_revisions"."revision_id") between 1 and 128 and length("personal_membership_revisions"."witness_device_id") between 1 and 128 and cardinality("personal_membership_revisions"."replaces")<=1024)
);
--> statement-breakpoint
ALTER TABLE "personal_membership_entities" ADD CONSTRAINT "personal_membership_entities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_membership_entities" ADD CONSTRAINT "personal_membership_entities_source_binding_id_personal_source_bindings_binding_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."personal_source_bindings"("binding_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_membership_resolution_reviews" ADD CONSTRAINT "personal_membership_reviews_entity_fk" FOREIGN KEY ("owner_user_id","project_identity","entity_identity") REFERENCES "public"."personal_membership_entities"("owner_user_id","project_identity","entity_identity") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_membership_revisions" ADD CONSTRAINT "personal_membership_revisions_native_change_revision_id_personal_membership_changes_revision_id_fk" FOREIGN KEY ("native_change_revision_id") REFERENCES "public"."personal_membership_changes"("revision_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_membership_revisions" ADD CONSTRAINT "personal_membership_revisions_entity_fk" FOREIGN KEY ("owner_user_id","project_identity","entity_identity") REFERENCES "public"."personal_membership_entities"("owner_user_id","project_identity","entity_identity") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_membership_entities_native_idx" ON "personal_membership_entities" USING btree ("owner_user_id","local_project_id","local_entity_id");--> statement-breakpoint
CREATE INDEX "personal_membership_entities_source_idx" ON "personal_membership_entities" USING btree ("owner_user_id","source_binding_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_membership_entities_native_catalog_unique" ON "personal_membership_entities" USING btree ("owner_user_id","local_project_id") WHERE "personal_membership_entities"."entity_kind"='project';--> statement-breakpoint
CREATE INDEX "personal_membership_resolution_reviews_owner_idx" ON "personal_membership_resolution_reviews" USING btree ("owner_user_id","project_identity","entity_identity");
--> statement-breakpoint
CREATE FUNCTION guard_personal_membership_entity() RETURNS trigger AS $$
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
--> statement-breakpoint
CREATE TRIGGER personal_membership_entities_identity_guard
BEFORE INSERT OR UPDATE ON personal_membership_entities FOR EACH ROW EXECUTE FUNCTION guard_personal_membership_entity();
--> statement-breakpoint
CREATE FUNCTION guard_personal_membership_revision() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND (
    NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.project_identity IS DISTINCT FROM OLD.project_identity
    OR NEW.entity_identity IS DISTINCT FROM OLD.entity_identity OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
    OR NEW.replaces IS DISTINCT FROM OLD.replaces OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.witness_device_id IS DISTINCT FROM OLD.witness_device_id OR NEW.verified_record_hash IS DISTINCT FROM OLD.verified_record_hash
    OR (OLD.native_change_revision_id IS NOT NULL AND NEW.native_change_revision_id IS NOT NULL AND NEW.native_change_revision_id IS DISTINCT FROM OLD.native_change_revision_id)
  ) THEN RAISE EXCEPTION 'Membership causal revisions and their witness proof are immutable'; END IF;
  IF NEW.revision->>'revisionId' IS DISTINCT FROM NEW.revision_id
    OR NEW.revision->>'entityId' IS DISTINCT FROM NEW.entity_identity
    OR NEW.revision->'project'->>'projectId' IS DISTINCT FROM NEW.project_identity
    OR NEW.revision->'project'->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id::text
    OR NEW.revision->'replaces' IS DISTINCT FROM to_jsonb(NEW.replaces)
    OR NEW.revision_id=ANY(NEW.replaces) THEN
    RAISE EXCEPTION 'Membership causal columns do not match their revision';
  END IF;
  IF NEW.native_change_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM personal_membership_changes c WHERE c.revision_id=NEW.native_change_revision_id AND c.owner_user_id=NEW.owner_user_id
  ) THEN RAISE EXCEPTION 'Native membership audit belongs to another owner'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_membership_revisions_identity_guard
BEFORE INSERT OR UPDATE ON personal_membership_revisions FOR EACH ROW EXECUTE FUNCTION guard_personal_membership_revision();

--> statement-breakpoint
CREATE FUNCTION guard_personal_membership_resolution_review() RETURNS trigger AS $$
BEGIN
  IF NEW.review_id IS DISTINCT FROM OLD.review_id OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.project_identity IS DISTINCT FROM OLD.project_identity OR NEW.entity_identity IS DISTINCT FROM OLD.entity_identity
    OR NEW.expected_heads IS DISTINCT FROM OLD.expected_heads OR NEW.expected_project_state IS DISTINCT FROM OLD.expected_project_state
    OR NEW.revision_id IS DISTINCT FROM OLD.revision_id OR NEW.operation IS DISTINCT FROM OLD.operation
    OR NEW.preview IS DISTINCT FROM OLD.preview
    OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
    RAISE EXCEPTION 'Reviewed membership resolution is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_membership_resolution_reviews_immutable
BEFORE UPDATE ON personal_membership_resolution_reviews FOR EACH ROW EXECUTE FUNCTION guard_personal_membership_resolution_review();
--> statement-breakpoint

-- Membership configuration delivery.
--> statement-breakpoint

-- Membership local devices.
CREATE TABLE "personal_membership_local_devices" (
	"owner_user_id" uuid PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"originating_deployment_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_membership_local_devices_identity_check" CHECK (length("personal_membership_local_devices"."device_id") between 1 and 128 and length("personal_membership_local_devices"."signing_key_id") between 1 and 128 and length("personal_membership_local_devices"."originating_deployment_id") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "personal_membership_local_devices" ADD CONSTRAINT "personal_membership_local_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

-- Membership review proofs.
ALTER TABLE "personal_membership_revisions" ADD COLUMN "local_review_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_membership_revisions" ADD CONSTRAINT "personal_membership_revisions_review_fk" FOREIGN KEY ("local_review_id") REFERENCES "public"."personal_membership_resolution_reviews"("review_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_membership_revisions" ADD CONSTRAINT "personal_membership_revisions_local_review_unique" UNIQUE("local_review_id");
--> statement-breakpoint
CREATE FUNCTION guard_personal_membership_review_proof() RETURNS trigger AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.local_review_id IS NOT NULL AND NEW.local_review_id IS NOT NULL
    AND NEW.local_review_id IS DISTINCT FROM OLD.local_review_id THEN
    RAISE EXCEPTION 'Membership review proof is immutable';
  END IF;
  IF NEW.local_review_id IS NOT NULL AND (
    NEW.verified_record_hash IS NOT NULL OR NEW.native_change_revision_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM personal_membership_resolution_reviews r WHERE r.review_id=NEW.local_review_id
        AND r.owner_user_id=NEW.owner_user_id AND r.project_identity=NEW.project_identity AND r.entity_identity=NEW.entity_identity
        AND r.revision_id=NEW.revision_id AND r.expected_heads=NEW.replaces AND r.operation=NEW.revision->'operation'
        AND r.preview->'after'=NEW.revision AND r.applied_at IS NOT NULL
    )
  ) THEN RAISE EXCEPTION 'Membership revision requires its exact applied User review'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER personal_membership_revisions_review_proof_guard
BEFORE INSERT OR UPDATE ON personal_membership_revisions FOR EACH ROW EXECUTE FUNCTION guard_personal_membership_review_proof();
--> statement-breakpoint

-- Capture Targets.
CREATE TABLE "personal_capture_target_bindings" (
	"binding_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"original_target_id" text NOT NULL,
	"original_target_name" text,
	"original_target_path" text,
	"mode" text DEFAULT 'preserved' NOT NULL,
	"target_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"legacy_detached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_capture_target_source_unique" UNIQUE("owner_user_id","session_id"),
	CONSTRAINT "personal_capture_target_owned_id_unique" UNIQUE("owner_user_id","binding_id"),
	CONSTRAINT "personal_capture_target_version_check" CHECK ("personal_capture_target_bindings"."version">0),
	CONSTRAINT "personal_capture_target_mode_check" CHECK (("personal_capture_target_bindings"."mode"='preserved' and "personal_capture_target_bindings"."target_id" is not null and "personal_capture_target_bindings"."target_id"="personal_capture_target_bindings"."original_target_id")
    or ("personal_capture_target_bindings"."mode"='target' and "personal_capture_target_bindings"."target_id" is not null)
    or ("personal_capture_target_bindings"."mode" in ('source','global') and "personal_capture_target_bindings"."target_id" is null))
);
--> statement-breakpoint
CREATE TABLE "personal_capture_target_changes" (
	"change_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_capture_target_operation_check" CHECK ("personal_capture_target_changes"."operation" in ('preserve','repair','detach_legacy'))
);
--> statement-breakpoint
CREATE TABLE "personal_capture_target_reviews" (
	"review_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"expected_state" jsonb NOT NULL,
	"choice" jsonb NOT NULL,
	"preview" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "personal_capture_target_bindings" ADD CONSTRAINT "personal_capture_target_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_capture_target_bindings" ADD CONSTRAINT "personal_capture_target_bindings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_capture_target_changes" ADD CONSTRAINT "personal_capture_target_change_owner_fk" FOREIGN KEY ("owner_user_id","binding_id") REFERENCES "public"."personal_capture_target_bindings"("owner_user_id","binding_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_capture_target_reviews" ADD CONSTRAINT "personal_capture_target_review_owner_fk" FOREIGN KEY ("owner_user_id","binding_id") REFERENCES "public"."personal_capture_target_bindings"("owner_user_id","binding_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_capture_target_change_binding_idx" ON "personal_capture_target_changes" USING btree ("owner_user_id","binding_id");--> statement-breakpoint
CREATE INDEX "personal_capture_target_review_binding_idx" ON "personal_capture_target_reviews" USING btree ("owner_user_id","binding_id");--> statement-breakpoint
-- Preserve an actual owned Session's exact legacy target, never a guessed UUID.
CREATE FUNCTION personal_capture_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id
    AND s.owner_user_id=NEW.owner_user_id AND s.logical_session_id=NEW.logical_session_id
    AND s.visibility='personal') THEN
    RAISE EXCEPTION 'Capture Target source identity does not match its owner';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.mode<>'preserved' OR NEW.legacy_detached_at IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id
      AND s.project_override_id=NEW.original_target_id
      AND s.project_override_name IS NOT DISTINCT FROM NEW.original_target_name
      AND s.project_override_path IS NOT DISTINCT FROM NEW.original_target_path
      AND s.invalidated_at IS NULL AND s.personal_deleted_at IS NULL) THEN
      RAISE EXCEPTION 'Capture Target must preserve the exact current legacy target';
    END IF;
  ELSE
    IF ROW(NEW.binding_id,NEW.owner_user_id,NEW.session_id,NEW.logical_session_id,
      NEW.original_target_id,NEW.original_target_name,NEW.original_target_path,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.binding_id,OLD.owner_user_id,OLD.session_id,OLD.logical_session_id,
      OLD.original_target_id,OLD.original_target_name,OLD.original_target_path,OLD.created_at)
      OR NEW.version<>OLD.version+1
      OR (OLD.legacy_detached_at IS NOT NULL AND NEW.legacy_detached_at IS DISTINCT FROM OLD.legacy_detached_at) THEN
      RAISE EXCEPTION 'Capture Target identity is immutable and updates require the next version';
    END IF;
    IF OLD.legacy_detached_at IS NULL AND NEW.legacy_detached_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND s.project_override_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Capture Target detachment requires the legacy role to be cleared atomically';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_capture_target_guard BEFORE INSERT OR UPDATE ON personal_capture_target_bindings
FOR EACH ROW EXECUTE FUNCTION personal_capture_target_guard();
--> statement-breakpoint
CREATE FUNCTION personal_capture_target_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO personal_capture_target_changes(owner_user_id,binding_id,operation,"before","after")
  VALUES(NEW.owner_user_id,NEW.binding_id,
    CASE WHEN TG_OP='INSERT' THEN 'preserve'
      WHEN OLD.legacy_detached_at IS NULL AND NEW.legacy_detached_at IS NOT NULL THEN 'detach_legacy'
      ELSE 'repair' END,
    CASE WHEN TG_OP='INSERT' THEN NULL ELSE to_jsonb(OLD) END,to_jsonb(NEW));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_capture_target_audit AFTER INSERT OR UPDATE ON personal_capture_target_bindings
FOR EACH ROW EXECUTE FUNCTION personal_capture_target_audit();
--> statement-breakpoint
CREATE TRIGGER personal_capture_target_change_immutable BEFORE UPDATE ON personal_capture_target_changes
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint
CREATE FUNCTION personal_capture_target_review_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.review_id,NEW.owner_user_id,NEW.binding_id,NEW.expected_state,NEW.choice,NEW.preview,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.review_id,OLD.owner_user_id,OLD.binding_id,OLD.expected_state,OLD.choice,OLD.preview,OLD.created_at)
    OR OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL THEN
    RAISE EXCEPTION 'Capture Target review is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_capture_target_review_guard BEFORE UPDATE ON personal_capture_target_reviews
FOR EACH ROW EXECUTE FUNCTION personal_capture_target_review_guard();
--> statement-breakpoint

-- Bounded selection consumers.
CREATE TABLE "personal_selection_changes" (
	"change_id" bigserial PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"transaction_id" text DEFAULT pg_current_xact_id()::text NOT NULL,
	"kind" text NOT NULL,
	"local_session_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "personal_selection_changes_kind_check" CHECK ("personal_selection_changes"."kind" in ('source','membership','source_context','availability'))
);
--> statement-breakpoint
CREATE TABLE "personal_selection_cursors" (
	"cursor_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"selection" jsonb NOT NULL,
	"snapshot_version" uuid NOT NULL,
	"from_snapshot" text NOT NULL,
	"to_snapshot" text,
	"after_source" jsonb,
	"after_change_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "personal_selection_cursors_kind_check" CHECK ("personal_selection_cursors"."kind" in ('enumeration','checkpoint','changes')),
	CONSTRAINT "personal_selection_cursors_window_check" CHECK (("personal_selection_cursors"."kind"='changes' and "personal_selection_cursors"."to_snapshot" is not null) or ("personal_selection_cursors"."kind"<>'changes' and "personal_selection_cursors"."to_snapshot" is null))
);
--> statement-breakpoint
ALTER TABLE "personal_selection_changes" ADD CONSTRAINT "personal_selection_changes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_selection_cursors" ADD CONSTRAINT "personal_selection_cursors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_selection_changes_owner_id_idx" ON "personal_selection_changes" USING btree ("owner_user_id","change_id");--> statement-breakpoint
CREATE INDEX "personal_selection_cursors_owner_expiry_idx" ON "personal_selection_cursors" USING btree ("owner_user_id","expires_at");--> statement-breakpoint
-- There is no per-owner sequence lock on source writes. A consumer must use
-- the top-level transaction's visibility set as well as its within-page ID.
CREATE FUNCTION personal_selection_observe() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_value jsonb;
  candidates jsonb[];
  owner_id uuid;
  session_id uuid;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  candidates := CASE WHEN TG_OP='INSERT' THEN ARRAY[to_jsonb(NEW)]
    WHEN TG_OP='DELETE' THEN ARRAY[to_jsonb(OLD)] ELSE ARRAY[to_jsonb(OLD),to_jsonb(NEW)] END;
  FOREACH row_value IN ARRAY candidates LOOP
    owner_id := NULL;
    session_id := NULL;
    IF TG_ARGV[1]='owner' THEN
      owner_id := (row_value->>'owner_user_id')::uuid;
      IF TG_ARGV[2]='self' THEN session_id := (row_value->>'id')::uuid;
      ELSIF TG_ARGV[2]<>'' THEN session_id := (row_value->>TG_ARGV[2])::uuid;
      END IF;
    ELSIF TG_ARGV[1]='binding' THEN
      SELECT b.owner_user_id,b.local_session_id INTO owner_id,session_id
      FROM personal_source_bindings b WHERE b.binding_id=(row_value->>'binding_id')::uuid;
    ELSIF TG_ARGV[1]='pds_replica' THEN
      SELECT r.owner_user_id,r.local_session_id INTO owner_id,session_id
      FROM pds_logical_replicas r WHERE r.id=(row_value->>'replica_id')::uuid;
    ELSIF TG_ARGV[1]='logical_memory' THEN
      INSERT INTO personal_selection_changes(owner_user_id,kind,local_session_id)
      SELECT DISTINCT l.owner_user_id,TG_ARGV[0],l.local_session_id
      FROM local_captured_session_logical_memories l JOIN users u ON u.id=l.owner_user_id
      WHERE l.logical_memory_id=(row_value->>'logical_memory_id')::uuid;
      CONTINUE;
    END IF;
    -- Owner deletion cascades need no orphan event. Source deletion events
    -- retain their identifier without a Session FK or private source body.
    IF owner_id IS NOT NULL AND EXISTS(SELECT 1 FROM users WHERE id=owner_id) THEN
      INSERT INTO personal_selection_changes(owner_user_id,kind,local_session_id)
      VALUES(owner_id,TG_ARGV[0],session_id);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_selection_change_immutable BEFORE UPDATE ON personal_selection_changes
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint
CREATE TRIGGER personal_selection_cursor_immutable BEFORE UPDATE ON personal_selection_cursors
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','self');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON memory_events
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON tool_events
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON conversation_items
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON conversation_item_observations
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_named_projects
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_project_inclusions
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_project_rules
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_project_exclusions
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_membership_entities
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_membership_revisions
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_membership_resolution_reviews
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('membership','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_source_bindings
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source_context','owner','local_session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_source_context_reviews
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source_context','owner','session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_source_context_changes
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source_context','owner','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON personal_source_context_revisions
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source_context','binding','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON local_captured_session_logical_memories
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','owner','local_session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON pds_logical_replicas
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','owner','local_session_id');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON memory_replicas
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','logical_memory','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON pds_retained_packages
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','owner','');


--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON pds_replica_checkpoints
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','pds_replica','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON pds_replica_observations
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','pds_replica','');

--> statement-breakpoint
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON cross_identity_sync_relationships
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('availability','logical_memory','');
--> statement-breakpoint

-- Personal model and legacy-write guards.
CREATE TABLE "personal_capture_target_routes" (
	"owner_user_id" uuid NOT NULL,
	"source_scope" text NOT NULL,
	"target_id" text NOT NULL,
	"target_name" text,
	"target_path" text,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_capture_target_routes_pk" PRIMARY KEY("owner_user_id","source_scope")
);
--> statement-breakpoint
CREATE TABLE "personal_legacy_source_assignments" (
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_legacy_source_assignments_pk" PRIMARY KEY("owner_user_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "personal_capture_target_bindings" ADD COLUMN "origin" text DEFAULT 'legacy_session' NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_capture_target_bindings" ADD COLUMN "route_source_scope" text;--> statement-breakpoint
ALTER TABLE "personal_capture_target_routes" ADD CONSTRAINT "personal_capture_target_routes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_legacy_source_assignments" ADD CONSTRAINT "personal_legacy_source_assignments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_legacy_source_assignments" ADD CONSTRAINT "personal_legacy_source_assignments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_capture_target_bindings" ADD CONSTRAINT "personal_capture_target_origin_check" CHECK (("personal_capture_target_bindings"."origin"='legacy_session' and "personal_capture_target_bindings"."route_source_scope" is null) or ("personal_capture_target_bindings"."origin"='legacy_route' and "personal_capture_target_bindings"."route_source_scope" is not null));--> statement-breakpoint
-- Routing is no longer source attribution. Retain its exact Capture Target
-- keys before native capture stops writing named source overrides.
INSERT INTO personal_capture_target_routes(owner_user_id,source_scope,target_id,target_name,target_path,evidence)
SELECT owner_user_id,source_project_id,target_project_id,target_name,target_path,to_jsonb(r)
FROM personal_project_routes r;
--> statement-breakpoint
DROP TABLE personal_project_routes;
--> statement-breakpoint
CREATE TRIGGER personal_capture_target_route_immutable BEFORE UPDATE ON personal_capture_target_routes
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint
CREATE TRIGGER personal_legacy_source_assignment_immutable BEFORE UPDATE ON personal_legacy_source_assignments
FOR EACH ROW EXECUTE FUNCTION personal_membership_change_immutable();
--> statement-breakpoint
CREATE FUNCTION personal_legacy_source_evidence(s sessions) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('sessionId',s.id,'ownerUserId',s.owner_user_id,'logicalSessionId',s.logical_session_id,
    'assignmentVersion',s.repository_assignment_version,'assignmentRevisionId',s.repository_assignment_revision_id,
    'automaticIdentity',s.repository_automatic_identity,'overrideIdentity',s.repository_override_identity,
    'overrideId',s.project_override_id,'overrideName',s.project_override_name,'overridePath',s.project_override_path,
    'overrideAt',s.project_override_at,'overrideByUserId',s.project_override_by_user_id,
    'invalidatedAt',s.invalidated_at,'deletedAt',s.personal_deleted_at);
$$;
--> statement-breakpoint
CREATE FUNCTION personal_legacy_source_archive_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND s.owner_user_id=NEW.owner_user_id
    AND NEW.evidence=personal_legacy_source_evidence(s)) THEN
    RAISE EXCEPTION 'Legacy source evidence must match the actual owned Session';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_legacy_source_archive_guard BEFORE INSERT ON personal_legacy_source_assignments
FOR EACH ROW EXECUTE FUNCTION personal_legacy_source_archive_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION personal_capture_target_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id
    AND s.owner_user_id=NEW.owner_user_id AND s.logical_session_id=NEW.logical_session_id
    AND s.visibility='personal') THEN
    RAISE EXCEPTION 'Capture Target source identity does not match its owner';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.mode<>'preserved' THEN
      RAISE EXCEPTION 'Capture Target must preserve an exact target before repair';
    END IF;
    IF NEW.origin='legacy_session' THEN
      IF NEW.legacy_detached_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id
        AND s.project_override_id=NEW.original_target_id
        AND s.project_override_name IS NOT DISTINCT FROM NEW.original_target_name
        AND s.project_override_path IS NOT DISTINCT FROM NEW.original_target_path
        AND s.invalidated_at IS NULL AND s.personal_deleted_at IS NULL) THEN
        RAISE EXCEPTION 'Capture Target must preserve the exact current legacy target';
      END IF;
    ELSIF NEW.origin='legacy_route' THEN
      IF NEW.legacy_detached_at IS NULL OR NOT EXISTS(
        SELECT 1 FROM sessions s JOIN personal_capture_target_routes r ON r.owner_user_id=s.owner_user_id
          AND r.source_scope=repository_scope_id(s.repository_automatic_identity)
        WHERE s.id=NEW.session_id AND s.owner_user_id=NEW.owner_user_id
          AND s.visibility='personal' AND s.invalidated_at IS NULL AND s.personal_deleted_at IS NULL
          AND s.repository_assignment_state='recorded' AND s.repository_override_identity IS NULL AND s.project_override_id IS NULL
          AND r.source_scope=NEW.route_source_scope AND r.target_id=NEW.original_target_id
          AND r.target_name IS NOT DISTINCT FROM NEW.original_target_name AND r.target_path IS NOT DISTINCT FROM NEW.original_target_path
      ) THEN
        RAISE EXCEPTION 'Capture Target route must match the exact recorded source';
      END IF;
    ELSE RAISE EXCEPTION 'Unsupported Capture Target origin';
    END IF;
  ELSE
    IF ROW(NEW.binding_id,NEW.owner_user_id,NEW.session_id,NEW.logical_session_id,NEW.origin,NEW.route_source_scope,
      NEW.original_target_id,NEW.original_target_name,NEW.original_target_path,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.binding_id,OLD.owner_user_id,OLD.session_id,OLD.logical_session_id,OLD.origin,OLD.route_source_scope,
      OLD.original_target_id,OLD.original_target_name,OLD.original_target_path,OLD.created_at)
      OR NEW.version<>OLD.version+1
      OR (OLD.legacy_detached_at IS NOT NULL AND NEW.legacy_detached_at IS DISTINCT FROM OLD.legacy_detached_at) THEN
      RAISE EXCEPTION 'Capture Target identity is immutable and updates require the next version';
    END IF;
    IF OLD.legacy_detached_at IS NULL AND NEW.legacy_detached_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.session_id AND s.project_override_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Capture Target detachment requires the legacy role to be cleared atomically';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION personal_legacy_source_write_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.project_override_id,NEW.project_override_name,NEW.project_override_path,NEW.project_override_at,NEW.project_override_by_user_id)
    IS NOT DISTINCT FROM ROW(OLD.project_override_id,OLD.project_override_name,OLD.project_override_path,OLD.project_override_at,OLD.project_override_by_user_id) THEN RETURN NEW; END IF;
  IF NEW.project_override_id IS NULL AND NEW.project_override_name IS NULL AND NEW.project_override_path IS NULL
    AND NEW.project_override_at IS NULL AND NEW.project_override_by_user_id IS NULL THEN
    IF TG_OP='INSERT' THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM personal_legacy_source_assignments a WHERE a.owner_user_id=OLD.owner_user_id
      AND a.session_id=OLD.id AND a.evidence=personal_legacy_source_evidence(OLD)) AND (
      OLD.invalidated_at IS NOT NULL OR OLD.personal_deleted_at IS NOT NULL OR EXISTS(
        SELECT 1 FROM personal_capture_target_bindings b WHERE b.owner_user_id=OLD.owner_user_id AND b.session_id=OLD.id
        AND b.logical_session_id=OLD.logical_session_id AND b.legacy_detached_at IS NULL
        AND (b.mode<>'preserved' OR b.original_target_id=OLD.project_override_id)
      )) THEN RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Legacy Project source writes are retired; use inclusion or source-context controls';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER personal_legacy_source_write_guard BEFORE INSERT OR UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION personal_legacy_source_write_guard();
--> statement-breakpoint
CREATE FUNCTION personal_legacy_capture_detachment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM sessions s WHERE s.id=NEW.id AND s.owner_user_id=NEW.owner_user_id
    AND s.visibility='personal' AND s.invalidated_at IS NULL AND s.personal_deleted_at IS NULL
    AND s.project_override_id IS NULL AND NOT EXISTS(
      SELECT 1 FROM personal_capture_target_bindings b WHERE b.owner_user_id=s.owner_user_id AND b.session_id=s.id
      AND b.logical_session_id=s.logical_session_id AND b.legacy_detached_at IS NOT NULL
    )) THEN RAISE EXCEPTION 'Legacy source detachment must preserve its Capture Target in the same transaction'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER personal_legacy_capture_detachment_guard AFTER UPDATE ON sessions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.project_override_id IS NOT NULL AND NEW.project_override_id IS NULL)
EXECUTE FUNCTION personal_legacy_capture_detachment_guard();
--> statement-breakpoint

--> statement-breakpoint
-- A completed or edited LCM Summary can change shareable evidence after the
-- captured source's last turn. Observe the node itself; title generation is
-- conditional and cannot serve as a reliable source-change notification.
CREATE TRIGGER personal_selection_observe AFTER INSERT OR UPDATE OR DELETE ON memory_nodes
FOR EACH ROW EXECUTE FUNCTION personal_selection_observe('source','owner','session_id');

--> statement-breakpoint
CREATE TABLE personal_project_defaults (
  owner_user_id uuid NOT NULL CONSTRAINT personal_project_defaults_owner_user_id_users_id_fk REFERENCES users(id),
  source_key text NOT NULL,
  source_scope text NOT NULL,
  target jsonb NOT NULL,
  state text NOT NULL CONSTRAINT personal_project_defaults_state_check CHECK(state IN ('initialized','managed','suppressed','retired')),
  project_id uuid,
  seed_rule_id uuid,
  initial_project_revision_id uuid,
  initial_rule_revision_id uuid,
  revision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_project_defaults_pkey PRIMARY KEY(owner_user_id,source_key),
  UNIQUE(owner_user_id,source_scope),
  CONSTRAINT personal_project_defaults_project_owner_fk FOREIGN KEY(owner_user_id,project_id) REFERENCES personal_named_projects(owner_user_id,project_id),
  CONSTRAINT personal_project_defaults_target_check CHECK(jsonb_typeof(target)='object'),
  CONSTRAINT personal_project_defaults_initialization_check CHECK(state<>'initialized' OR (project_id IS NOT NULL AND seed_rule_id IS NOT NULL AND initial_project_revision_id IS NOT NULL AND initial_rule_revision_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE personal_project_default_reconciliation (
  owner_user_id uuid PRIMARY KEY CONSTRAINT personal_project_default_reconciliation_owner_user_id_users_id_fk REFERENCES users(id),
  generation bigint NOT NULL DEFAULT 1,
  scan_generation bigint,
  after_session_id uuid,
  pending boolean NOT NULL DEFAULT true,
  retry_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION schedule_personal_project_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL THEN
    INSERT INTO personal_project_default_reconciliation(owner_user_id) VALUES(NEW.owner_user_id)
    ON CONFLICT(owner_user_id) DO UPDATE SET generation=personal_project_default_reconciliation.generation+1,pending=true,retry_at=now(),updated_at=now();
    PERFORM pg_notify('koed_project_defaults','source_changed');
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER personal_project_defaults_capture AFTER INSERT OR UPDATE OF repository_automatic_identity,repository_override_identity,folder_assignment ON sessions FOR EACH ROW EXECUTE FUNCTION schedule_personal_project_defaults();
--> statement-breakpoint
CREATE TRIGGER personal_project_defaults_binding AFTER INSERT OR UPDATE OF availability ON personal_source_bindings FOR EACH ROW EXECUTE FUNCTION schedule_personal_project_defaults();
--> statement-breakpoint
CREATE TRIGGER personal_project_defaults_replica AFTER INSERT OR UPDATE OF materialization_state ON pds_logical_replicas FOR EACH ROW EXECUTE FUNCTION schedule_personal_project_defaults();
--> statement-breakpoint
INSERT INTO personal_project_default_reconciliation(owner_user_id) SELECT DISTINCT s.owner_user_id FROM sessions s JOIN users u ON u.id=s.owner_user_id WHERE u.disabled_at IS NULL AND u.deleted_at IS NULL;
