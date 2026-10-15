ALTER TABLE "pds_outbox_entries" DROP CONSTRAINT "pds_outbox_state_check";--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "superseded_by_closure_id" uuid;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "superseded_from_state" text;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_entries_superseded_by_closure_id_pds_session_closures_id_fk" FOREIGN KEY ("superseded_by_closure_id") REFERENCES "public"."pds_session_closures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_supersession_check" CHECK (("pds_outbox_entries"."state" = 'superseded' and "pds_outbox_entries"."superseded_by_closure_id" is not null and "pds_outbox_entries"."superseded_from_state" is not null and "pds_outbox_entries"."superseded_from_state" in ('pending','uploading','committed','paused','failed','quarantined') and "pds_outbox_entries"."superseded_at" is not null) or ("pds_outbox_entries"."state" <> 'superseded' and "pds_outbox_entries"."superseded_by_closure_id" is null and "pds_outbox_entries"."superseded_from_state" is null and "pds_outbox_entries"."superseded_at" is null));--> statement-breakpoint
ALTER TABLE "pds_outbox_entries" ADD CONSTRAINT "pds_outbox_state_check" CHECK ("pds_outbox_entries"."state" in ('pending','uploading','committed','acked','paused','failed','quarantined','superseded'));
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
CREATE TRIGGER pds_outbox_supersession_guard BEFORE INSERT OR UPDATE ON pds_outbox_entries
FOR EACH ROW EXECUTE FUNCTION pds_guard_outbox_supersession();
