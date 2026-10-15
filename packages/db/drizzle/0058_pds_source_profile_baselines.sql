ALTER TABLE "pds_logical_replicas" ADD COLUMN "source_profile_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_retained_packages" ADD COLUMN "source_profile_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pds_session_closures" ADD COLUMN "source_profile_epoch" integer DEFAULT 0 NOT NULL;
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
