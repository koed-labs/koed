-- Consolidated pre-release Project recall schema and profile transition.
ALTER TYPE "public"."sync_package_state" ADD VALUE 'superseded';--> statement-breakpoint
CREATE TABLE "pds_project_association_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"association_row_id" uuid NOT NULL,
	"originating_device_id" text NOT NULL,
	"checkout_id" text NOT NULL,
	"local_project_id" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_association_checkout_unique" UNIQUE("owner_user_id","originating_device_id","checkout_id")
);
--> statement-breakpoint
CREATE TABLE "pds_project_associations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"association_id" text NOT NULL,
	"selection_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_association_group_unique" UNIQUE("group_id","association_id"),
	CONSTRAINT "pds_project_selection_group_unique" UNIQUE("group_id","selection_id")
);
--> statement-breakpoint
CREATE TABLE "pds_project_selection_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_row_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"transport_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_epoch" text,
	CONSTRAINT "pds_project_selection_outbox_revision_row_id_unique" UNIQUE("revision_row_id"),
	CONSTRAINT "pds_project_selection_outbox_state_check" CHECK ("pds_project_selection_outbox"."state" in ('pending','committed','acked') and "pds_project_selection_outbox"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pds_project_selection_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"association_row_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"revision_id" text NOT NULL,
	"signed_record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_project_selection_revision_group_unique" UNIQUE("group_id","revision_id")
);
--> statement-breakpoint
CREATE TABLE "personal_project_routes" (
	"owner_user_id" uuid NOT NULL,
	"source_project_id" text NOT NULL,
	"target_project_id" text NOT NULL,
	"target_name" text NOT NULL,
	"target_path" text,
	"target_identity" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_project_routes_owner_user_id_source_project_id_pk" PRIMARY KEY("owner_user_id","source_project_id"),
	CONSTRAINT "personal_project_routes_distinct_check" CHECK ("personal_project_routes"."source_project_id" <> "personal_project_routes"."target_project_id" and "personal_project_routes"."source_project_id" <> 'unassigned')
);
--> statement-breakpoint
CREATE TABLE "repository_assignment_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_revision" integer NOT NULL,
	"options" jsonb NOT NULL,
	"sessions" jsonb NOT NULL,
	"status" text DEFAULT 'reviewed' NOT NULL,
	"selected_session_ids" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "repository_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"originating_device_id" text NOT NULL,
	"checkout_id" text NOT NULL,
	"revision" integer NOT NULL,
	"originating_revision" integer,
	"kind" text NOT NULL,
	"previous_identity" jsonb,
	"target_identity" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "session_repository_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"observation_hash" text NOT NULL,
	"identity" jsonb NOT NULL,
	"captured_cwd" text,
	"is_conflict" boolean NOT NULL,
	"assignment_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_profile_transition_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_relationship_id" uuid NOT NULL,
	"protocol_package_id" uuid NOT NULL,
	"source_sequence" bigint NOT NULL,
	"request_digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_profile_transition_package_unique" UNIQUE("sync_relationship_id","protocol_package_id"),
	CONSTRAINT "sync_profile_transition_sequence_unique" UNIQUE("sync_relationship_id","source_sequence"),
	CONSTRAINT "sync_profile_transition_sequence_check" CHECK ("sync_profile_transition_receipts"."source_sequence">0),
	CONSTRAINT "sync_profile_transition_digest_check" CHECK ("sync_profile_transition_receipts"."request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_repository_snapshot_mutations" (
	"mutation_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"share_grant_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result_grant_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" DROP CONSTRAINT "pds_outbox_state_check";--> statement-breakpoint
DROP INDEX "pds_session_closure_session_unique";--> statement-breakpoint
ALTER TABLE "cross_identity_sync_relationships" ADD COLUMN "source_repository_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD COLUMN "source_profile_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "superseded_by_closure_id" uuid;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "superseded_from_state" text;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "source_profile_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD COLUMN "source_profile_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_assignment_state" text DEFAULT 'historical_unresolved' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_assignment_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_automatic_identity" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "repository_override_identity" jsonb;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "repository_snapshot" jsonb DEFAULT '{"version":1,"classification":"unresolved","fingerprint":null,"label":null,"branchObservation":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "team_memory_share_grants" ADD COLUMN "repository_snapshot_source_revision" bigint;--> statement-breakpoint
ALTER TABLE "pds_project_association_acceptances" ADD CONSTRAINT "pds_project_association_acceptances_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_association_acceptances" ADD CONSTRAINT "pds_project_association_acceptances_association_row_id_pds_project_associations_id_fk" FOREIGN KEY ("association_row_id") REFERENCES "public"."pds_project_associations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_associations" ADD CONSTRAINT "pds_project_associations_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_selection_outbox" ADD CONSTRAINT "pds_project_selection_outbox_revision_row_id_pds_project_selection_revisions_id_fk" FOREIGN KEY ("revision_row_id") REFERENCES "public"."pds_project_selection_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_selection_revisions" ADD CONSTRAINT "pds_project_selection_revisions_association_row_id_pds_project_associations_id_fk" FOREIGN KEY ("association_row_id") REFERENCES "public"."pds_project_associations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_project_selection_revisions" ADD CONSTRAINT "pds_project_selection_revisions_group_id_personal_device_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."personal_device_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_project_routes" ADD CONSTRAINT "personal_project_routes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_assignment_reviews" ADD CONSTRAINT "repository_assignment_reviews_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_assignment_reviews" ADD CONSTRAINT "repository_assignment_reviews_event_id_repository_change_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."repository_change_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_change_events" ADD CONSTRAINT "repository_change_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_repository_observations" ADD CONSTRAINT "session_repository_observations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_repository_observations" ADD CONSTRAINT "session_repository_observations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_profile_transition_receipts" ADD CONSTRAINT "sync_profile_transition_receipts_sync_relationship_id_cross_identity_sync_relationships_id_fk" FOREIGN KEY ("sync_relationship_id") REFERENCES "public"."cross_identity_sync_relationships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_repository_snapshot_mutations" ADD CONSTRAINT "team_repository_snapshot_mutations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_repository_snapshot_mutations" ADD CONSTRAINT "team_repository_snapshot_mutations_share_grant_id_team_memory_share_grants_id_fk" FOREIGN KEY ("share_grant_id") REFERENCES "public"."team_memory_share_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pds_project_selection_outbox_due_idx" ON "pds_project_selection_outbox" USING btree ("state","retry_at");--> statement-breakpoint
CREATE INDEX "pds_project_selection_association_idx" ON "pds_project_selection_revisions" USING btree ("association_row_id");--> statement-breakpoint
CREATE INDEX "repository_review_owner_event_idx" ON "repository_assignment_reviews" USING btree ("owner_user_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_change_revision_idx" ON "repository_change_events" USING btree ("owner_user_id","originating_device_id","checkout_id","revision");--> statement-breakpoint
CREATE INDEX "repository_change_owner_status_idx" ON "repository_change_events" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "session_repository_observations_dedupe_idx" ON "session_repository_observations" USING btree ("session_id","observation_hash");--> statement-breakpoint
CREATE INDEX "session_repository_observations_owner_idx" ON "session_repository_observations" USING btree ("owner_user_id","session_id");--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_entries_superseded_by_closure_id_pds_session_closures_id_fk" FOREIGN KEY ("superseded_by_closure_id") REFERENCES "public"."pds_session_closures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_owner_repository_identity_idx" ON "sessions" USING btree ("owner_user_id",(coalesce("repository_override_identity", "repository_automatic_identity") ->> 'key'));--> statement-breakpoint
CREATE UNIQUE INDEX "pds_session_closure_session_unique" ON "pds_session_closures" USING btree ("group_id","source_session_id","source_profile_epoch") WHERE "pds_session_closures"."publication_kind" = 'closed';--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_supersession_check" CHECK (("pds_outbox_entries"."state" = 'superseded' and "pds_outbox_entries"."superseded_by_closure_id" is not null and "pds_outbox_entries"."superseded_from_state" is not null and "pds_outbox_entries"."superseded_from_state" in ('pending','uploading','committed','paused','failed','quarantined') and "pds_outbox_entries"."superseded_at" is not null) or ("pds_outbox_entries"."state" <> 'superseded' and "pds_outbox_entries"."superseded_by_closure_id" is null and "pds_outbox_entries"."superseded_from_state" is null and "pds_outbox_entries"."superseded_at" is null));--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_state_check" CHECK ("pds_outbox_entries"."state" in ('pending','uploading','committed','acked','paused','failed','quarantined','superseded'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repository_assignment_shape_check" CHECK ("sessions"."repository_assignment_state" in ('recorded', 'historical_unresolved') and "sessions"."repository_assignment_version" > 0 and ("sessions"."repository_assignment_state" <> 'historical_unresolved' or "sessions"."repository_automatic_identity" is null));
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION repository_scope_matches(identity jsonb, scope text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE target jsonb;
BEGIN
  IF identity IS NULL OR scope IS NULL OR left(scope, 11) <> 'repository:' THEN
    RETURN false;
  END IF;
  BEGIN
    target := substring(scope FROM 12)::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  RETURN coalesce(
    identity ->> 'kind' IN ('portable_repository', 'device_local_repository', 'non_git_project', 'local_project')
    AND identity ->> 'kind' = target ->> 'kind'
    AND identity ->> 'key' IS NOT NULL
    AND identity ->> 'key' = target ->> 'key'
    AND (identity ->> 'kind' = 'portable_repository'
      OR identity ->> 'originatingDeviceId' = target ->> 'device'), false);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION repository_scope_id(identity jsonb)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN identity ->> 'kind' IN ('portable_repository', 'device_local_repository', 'non_git_project', 'local_project')
    AND identity ->> 'key' IS NOT NULL THEN
      'repository:{"kind":' || to_json(identity ->> 'kind')::text || ',"key":' || to_json(identity ->> 'key')::text || ',"device":' || CASE WHEN identity ->> 'kind' = 'portable_repository' THEN 'null' ELSE to_json(identity ->> 'originatingDeviceId')::text END || '}'
    ELSE null END;
$$;
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
      mutable_columns := ARRAY['metadata','updated_at','repository_override_identity','repository_assignment_version',
        'project_override_id','project_override_name','project_override_path','project_override_at','project_override_by_user_id'];
      trusted_assignment := current_setting('koed.pds_replica_append_id',true) IS NOT DISTINCT FROM replica_id;
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
CREATE OR REPLACE FUNCTION pds_guard_checkpoint_replica() RETURNS trigger AS $$
DECLARE expected_id text;
BEGIN
  expected_id := current_setting('koed.pds_replica_append_id', true);
  IF TG_OP = 'INSERT' THEN
    IF NEW.materialization_profile = 'cumulative_checkpoint'
      AND (expected_id IS DISTINCT FROM NEW.id::text OR (NEW.checkpoint_ordinal <> '0' AND NOT (NEW.source_profile_epoch=1 AND current_setting('koed.pds_profile_baseline_ordinal',true) IS NOT DISTINCT FROM NEW.checkpoint_ordinal))) THEN
      RAISE EXCEPTION 'PDS checkpoint replicas must start through the trusted receiver';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.materialization_profile = 'cumulative_checkpoint' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.materialization_profile IS DISTINCT FROM OLD.materialization_profile
      OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
      OR NEW.local_session_id IS DISTINCT FROM OLD.local_session_id THEN
      RAISE EXCEPTION 'PDS checkpoint replica identity is immutable';
    END IF;
    IF NEW.source_profile_epoch IS DISTINCT FROM OLD.source_profile_epoch
      OR NEW.closure_hash IS DISTINCT FROM OLD.closure_hash
      OR NEW.checkpoint_ordinal IS DISTINCT FROM OLD.checkpoint_ordinal
      OR NEW.checkpoint_item_count IS DISTINCT FROM OLD.checkpoint_item_count THEN
      IF expected_id IS DISTINCT FROM OLD.id::text
        OR NOT (
          (NEW.source_profile_epoch=OLD.source_profile_epoch
            AND NEW.checkpoint_ordinal::numeric=OLD.checkpoint_ordinal::numeric+1
            AND NEW.checkpoint_item_count::numeric>OLD.checkpoint_item_count::numeric)
          OR (OLD.source_profile_epoch=0 AND NEW.source_profile_epoch=1
            AND current_setting('koed.pds_profile_baseline_ordinal',true) IS NOT DISTINCT FROM NEW.checkpoint_ordinal
            AND NEW.checkpoint_ordinal::numeric>OLD.checkpoint_ordinal::numeric
            AND NEW.checkpoint_item_count::numeric>=OLD.checkpoint_item_count::numeric)
        ) THEN
        RAISE EXCEPTION 'PDS checkpoint head advances only through a contiguous append';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION pds_guard_outbox_supersession() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state='superseded' THEN
      RAISE EXCEPTION 'PDS outbox supersession requires an existing publication';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state='superseded' AND
    (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
    RAISE EXCEPTION 'PDS superseded publication history is immutable';
  END IF;
  IF NEW.state='superseded' AND OLD.state<>'superseded' THEN
    IF OLD.state='acked' OR NEW.superseded_from_state IS DISTINCT FROM OLD.state
      OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
      OR NOT EXISTS (
        SELECT 1 FROM pds_session_closures old_source
        JOIN pds_session_closures replacement
          ON replacement.group_id=old_source.group_id
          AND replacement.source_session_id=old_source.source_session_id
        WHERE old_source.id=OLD.closure_id AND old_source.source_profile_epoch=0
          AND replacement.id=NEW.superseded_by_closure_id AND replacement.source_profile_epoch=1
          AND replacement.source_sequence::numeric>old_source.source_sequence::numeric
          AND replacement.terminal_item_count::numeric>=old_source.terminal_item_count::numeric
      ) THEN
      RAISE EXCEPTION 'PDS outbox supersession requires its durable current-profile replacement';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION sync_guard_profile_transition_receipt() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sync profile transition receipts are immutable';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER source_repository_assignment_outbox AFTER UPDATE OF repository_assignment_version ON sessions
FOR EACH ROW EXECUTE FUNCTION queue_source_repository_assignment();
--> statement-breakpoint
CREATE TRIGGER pds_outbox_supersession_guard BEFORE INSERT OR UPDATE ON pds_outbox_entries
FOR EACH ROW EXECUTE FUNCTION pds_guard_outbox_supersession();
--> statement-breakpoint
CREATE TRIGGER sync_profile_transition_receipt_guard BEFORE UPDATE ON sync_profile_transition_receipts
FOR EACH ROW EXECUTE FUNCTION sync_guard_profile_transition_receipt();
--> statement-breakpoint
-- The migration journal makes this release transition run once. Block Session
-- writes until every existing Personal Session has crossed the same boundary.
LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SELECT set_config('koed.repository_assignment_cutover', '1', true);
--> statement-breakpoint
UPDATE sessions
SET repository_assignment_state = 'historical_unresolved',
    repository_automatic_identity = NULL,
    repository_override_identity = NULL,
    repository_assignment_version = repository_assignment_version + 1
WHERE visibility = 'personal';
--> statement-breakpoint
SELECT set_config('koed.repository_assignment_cutover', '', true);
