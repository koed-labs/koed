CREATE TABLE "peer_online_restore_quarantines" (
  "group_id" text PRIMARY KEY REFERENCES "peer_online_membership_groups"("group_id"),
  "genesis_hash" text NOT NULL,
  "reason" text NOT NULL,
  "declared_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE FUNCTION "reject_peer_online_restore_quarantine_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'peer online restore quarantine is immutable';
END;
$$;

CREATE TRIGGER "peer_online_restore_quarantine_no_update_delete"
BEFORE UPDATE OR DELETE ON "peer_online_restore_quarantines"
FOR EACH ROW
EXECUTE FUNCTION "reject_peer_online_restore_quarantine_mutation"();

CREATE TRIGGER "peer_online_restore_quarantine_no_truncate"
BEFORE TRUNCATE ON "peer_online_restore_quarantines"
FOR EACH STATEMENT
EXECUTE FUNCTION "reject_peer_online_restore_quarantine_mutation"();
