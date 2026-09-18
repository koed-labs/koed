CREATE TABLE "pds_replica_checkpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"replica_id" uuid NOT NULL,
	"retained_package_id" uuid NOT NULL,
	"checkpoint_ordinal" text NOT NULL,
	"previous_closure_hash" text,
	"source_closure_hash" text NOT NULL,
	"item_count" text NOT NULL,
	"source_manifest_hash" text NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pds_replica_checkpoint_ordinal_unique" UNIQUE("replica_id","checkpoint_ordinal"),
	CONSTRAINT "pds_replica_checkpoint_package_unique" UNIQUE("retained_package_id"),
	CONSTRAINT "pds_replica_checkpoint_shape_check" CHECK ("pds_replica_checkpoints"."checkpoint_ordinal" ~ '^(0|[1-9][0-9]*)$'
        and "pds_replica_checkpoints"."item_count" ~ '^[1-9][0-9]*$'
        and "pds_replica_checkpoints"."source_closure_hash" ~ '^[A-Za-z0-9_-]{43}$'
        and ("pds_replica_checkpoints"."previous_closure_hash" is null or "pds_replica_checkpoints"."previous_closure_hash" ~ '^[A-Za-z0-9_-]{43}$')),
	CONSTRAINT "pds_replica_checkpoint_genesis_check" CHECK (("pds_replica_checkpoints"."checkpoint_ordinal" = '0' and "pds_replica_checkpoints"."previous_closure_hash" is null)
        or ("pds_replica_checkpoints"."checkpoint_ordinal" <> '0' and "pds_replica_checkpoints"."previous_closure_hash" is not null))
);
--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "dispatch_epoch" text;
--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" DROP CONSTRAINT "pds_logical_replica_fingerprint_closure_unique";--> statement-breakpoint
ALTER TABLE "pds_session_closures" DROP CONSTRAINT "pds_session_closure_session_unique";--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" DROP CONSTRAINT "pds_inbox_state_check";--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD COLUMN "materialization_profile" text DEFAULT 'closed_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD COLUMN "checkpoint_ordinal" text;--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD COLUMN "checkpoint_item_count" text;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "source_profile" text DEFAULT 'closed_v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "checkpoint_ordinal" text;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "checkpoint_previous_closure_hash" text;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "checkpoint_item_count" text;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD COLUMN "publication_kind" text DEFAULT 'closed' NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD COLUMN "checkpoint_ordinal" text;--> statement-breakpoint
ALTER TABLE "pds_replica_checkpoints" ADD CONSTRAINT "pds_replica_checkpoints_replica_id_pds_logical_replicas_id_fk" FOREIGN KEY ("replica_id") REFERENCES "public"."pds_logical_replicas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_replica_checkpoints" ADD CONSTRAINT "pds_replica_checkpoints_retained_package_id_pds_retained_packages_id_fk" FOREIGN KEY ("retained_package_id") REFERENCES "public"."pds_retained_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pds_logical_replica_fingerprint_closure_unique" ON "pds_logical_replicas" USING btree ("group_id","source_fingerprint","closure_hash") WHERE "pds_logical_replicas"."materialization_profile" = 'closed_v1';--> statement-breakpoint
CREATE UNIQUE INDEX "pds_logical_replica_checkpoint_fingerprint_unique" ON "pds_logical_replicas" USING btree ("group_id","source_fingerprint") WHERE "pds_logical_replicas"."materialization_profile" = 'cumulative_checkpoint';--> statement-breakpoint
CREATE UNIQUE INDEX "pds_session_closure_session_unique" ON "pds_session_closures" USING btree ("group_id","source_session_id") WHERE "pds_session_closures"."publication_kind" = 'closed';--> statement-breakpoint
CREATE UNIQUE INDEX "pds_session_checkpoint_ordinal_unique" ON "pds_session_closures" USING btree ("group_id","source_session_id","checkpoint_ordinal") WHERE "pds_session_closures"."publication_kind" = 'checkpoint';--> statement-breakpoint
ALTER TABLE "pds_inbox_entries" ADD CONSTRAINT "pds_inbox_state_check" CHECK ("pds_inbox_entries"."state" in ('pending','awaiting_predecessor','downloading','verifying','processing','ready','stale','failed','quarantined','revoked'));--> statement-breakpoint
ALTER TABLE "pds_logical_replicas" ADD CONSTRAINT "pds_logical_replica_profile_check" CHECK (("pds_logical_replicas"."materialization_profile" = 'closed_v1' and "pds_logical_replicas"."checkpoint_ordinal" is null and "pds_logical_replicas"."checkpoint_item_count" is null)
        or ("pds_logical_replicas"."materialization_profile" = 'cumulative_checkpoint' and "pds_logical_replicas"."source_fingerprint" is not null
          and "pds_logical_replicas"."checkpoint_ordinal" is not null and "pds_logical_replicas"."checkpoint_item_count" is not null
          and "pds_logical_replicas"."checkpoint_ordinal" ~ '^(0|[1-9][0-9]*)$'
          and "pds_logical_replicas"."checkpoint_item_count" ~ '^[1-9][0-9]*$'));--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD CONSTRAINT "pds_retained_package_checkpoint_check" CHECK (("pds_retained_packages"."source_profile" = 'closed_v1' and "pds_retained_packages"."checkpoint_ordinal" is null and "pds_retained_packages"."checkpoint_previous_closure_hash" is null and "pds_retained_packages"."checkpoint_item_count" is null)
        or ("pds_retained_packages"."source_profile" = 'cumulative_checkpoint' and "pds_retained_packages"."source_fingerprint" is not null and "pds_retained_packages"."source_closure_hash" is not null
          and "pds_retained_packages"."checkpoint_ordinal" is not null and "pds_retained_packages"."checkpoint_item_count" is not null
          and "pds_retained_packages"."checkpoint_ordinal" ~ '^(0|[1-9][0-9]*)$'
          and ("pds_retained_packages"."checkpoint_previous_closure_hash" is null or "pds_retained_packages"."checkpoint_previous_closure_hash" ~ '^[A-Za-z0-9_-]{43}$')
          and "pds_retained_packages"."checkpoint_item_count" ~ '^[1-9][0-9]*$'
          and (("pds_retained_packages"."checkpoint_ordinal" = '0' and "pds_retained_packages"."checkpoint_previous_closure_hash" is null) or ("pds_retained_packages"."checkpoint_ordinal" <> '0' and "pds_retained_packages"."checkpoint_previous_closure_hash" is not null))));--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD CONSTRAINT "pds_session_publication_kind_check" CHECK (("pds_session_closures"."publication_kind" = 'closed' and "pds_session_closures"."checkpoint_ordinal" is null) or ("pds_session_closures"."publication_kind" = 'checkpoint' and "pds_session_closures"."checkpoint_ordinal" is not null and "pds_session_closures"."checkpoint_ordinal" ~ '^(0|[1-9][0-9]*)$'));
--> statement-breakpoint
-- Keep V1 permanent closure behavior while allowing immutable checkpoint prefixes.
CREATE OR REPLACE FUNCTION pds_reject_closed_source_mutation() RETURNS trigger AS $$
DECLARE
  replica_id text;
  append_start text;
  append_end text;
  is_replica_session boolean;
BEGIN
  IF TG_TABLE_NAME = 'pds_session_closures' THEN
    IF NEW.group_id IS DISTINCT FROM OLD.group_id
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
    IF EXISTS (SELECT 1 FROM pds_logical_replicas r WHERE r.local_session_id = OLD.id) THEN
      IF TG_OP = 'DELETE' OR (
        to_jsonb(NEW) - ARRAY['metadata', 'updated_at']::text[]
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY['metadata', 'updated_at']::text[]
      ) OR (
        NEW.metadata - ARRAY[
          'threadName', 'threadNameSource', 'threadNameGeneratedAt', 'threadNameEditedAt'
        ]::text[]
      ) IS DISTINCT FROM (
        OLD.metadata - ARRAY[
          'threadName', 'threadNameSource', 'threadNameGeneratedAt', 'threadNameEditedAt'
        ]::text[]
      ) THEN
        RAISE EXCEPTION 'PDS replica Sessions are read-only';
      END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
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
CREATE OR REPLACE FUNCTION pds_guard_checkpoint_replica() RETURNS trigger AS $$
DECLARE expected_id text;
BEGIN
  expected_id := current_setting('koed.pds_replica_append_id', true);
  IF TG_OP = 'INSERT' THEN
    IF NEW.materialization_profile = 'cumulative_checkpoint'
      AND (expected_id IS DISTINCT FROM NEW.id::text OR NEW.checkpoint_ordinal <> '0') THEN
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
    IF NEW.closure_hash IS DISTINCT FROM OLD.closure_hash
      OR NEW.checkpoint_ordinal IS DISTINCT FROM OLD.checkpoint_ordinal
      OR NEW.checkpoint_item_count IS DISTINCT FROM OLD.checkpoint_item_count THEN
      IF expected_id IS DISTINCT FROM OLD.id::text
        OR NEW.checkpoint_ordinal::numeric <> OLD.checkpoint_ordinal::numeric + 1
        OR NEW.checkpoint_item_count::numeric <= OLD.checkpoint_item_count::numeric THEN
        RAISE EXCEPTION 'PDS checkpoint head advances only through a contiguous append';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pds_checkpoint_replica_guard
  BEFORE INSERT OR UPDATE ON pds_logical_replicas
  FOR EACH ROW EXECUTE FUNCTION pds_guard_checkpoint_replica();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pds_guard_checkpoint_records() RETURNS trigger AS $$
DECLARE expected_id text;
BEGIN
  expected_id := current_setting('koed.pds_replica_append_id', true);
  IF TG_TABLE_NAME = 'pds_replica_checkpoints' THEN
    IF TG_OP = 'INSERT' THEN
      IF expected_id IS DISTINCT FROM NEW.replica_id::text THEN
        RAISE EXCEPTION 'PDS checkpoint ledger writes require the trusted receiver';
      END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'PDS checkpoint ledger is immutable';
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.replica_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM pds_logical_replicas r
      WHERE r.id = NEW.replica_id AND r.materialization_profile = 'cumulative_checkpoint'
    ) AND expected_id IS DISTINCT FROM NEW.replica_id::text THEN
      RAISE EXCEPTION 'PDS replica item mappings require the trusted receiver';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.replica_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM pds_logical_replicas r
    WHERE r.id = OLD.replica_id AND r.materialization_profile = 'cumulative_checkpoint'
  ) THEN
    RAISE EXCEPTION 'PDS replica item mappings are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pds_replica_checkpoint_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON pds_replica_checkpoints
  FOR EACH ROW EXECUTE FUNCTION pds_guard_checkpoint_records();
--> statement-breakpoint
CREATE TRIGGER pds_replica_item_mapping_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON pds_source_item_mappings
  FOR EACH ROW EXECUTE FUNCTION pds_guard_checkpoint_records();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pds_guard_retained_checkpoint_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.package_id IS DISTINCT FROM OLD.package_id
    OR NEW.source_manifest_hash IS DISTINCT FROM OLD.source_manifest_hash
    OR NEW.source_profile IS DISTINCT FROM OLD.source_profile
    OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
    OR NEW.source_closure_hash IS DISTINCT FROM OLD.source_closure_hash
    OR NEW.checkpoint_ordinal IS DISTINCT FROM OLD.checkpoint_ordinal
    OR NEW.checkpoint_previous_closure_hash IS DISTINCT FROM OLD.checkpoint_previous_closure_hash
    OR NEW.checkpoint_item_count IS DISTINCT FROM OLD.checkpoint_item_count
    OR NEW.origin_deployment_id IS DISTINCT FROM OLD.origin_deployment_id
    OR NEW.origin_device_id IS DISTINCT FROM OLD.origin_device_id
    OR NEW.source_sequence IS DISTINCT FROM OLD.source_sequence
    OR NEW.logical_memory_id IS DISTINCT FROM OLD.logical_memory_id
    OR NEW.deletion_floor_token IS DISTINCT FROM OLD.deletion_floor_token
    OR NEW.encrypted_envelope IS DISTINCT FROM OLD.encrypted_envelope THEN
    RAISE EXCEPTION 'PDS retained package identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER pds_retained_checkpoint_identity_immutable
  BEFORE UPDATE ON pds_retained_packages
  FOR EACH ROW EXECUTE FUNCTION pds_guard_retained_checkpoint_identity();
