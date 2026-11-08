CREATE TABLE "peer_online_deletion_recipients" (
	"group_id" text NOT NULL,
	"session_key" text NOT NULL,
	"recipient_device_id" text NOT NULL,
	"added_reason" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"ack" text,
	"ack_hash" text,
	"acked_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "peer_online_deletion_recipients_group_id_session_key_recipient_device_id_pk" PRIMARY KEY("group_id","session_key","recipient_device_id"),
	CONSTRAINT "peer_online_deletion_recipients_added_reason_check" CHECK ("peer_online_deletion_recipients"."added_reason" in ('member_at_request', 'admitted_later')),
	CONSTRAINT "peer_online_deletion_recipients_state_check" CHECK (("peer_online_deletion_recipients"."state" = 'acked' and "peer_online_deletion_recipients"."ack" is not null and "peer_online_deletion_recipients"."ack_hash" is not null and "peer_online_deletion_recipients"."acked_at" is not null) or ("peer_online_deletion_recipients"."state" in ('pending', 'revoked_unconfirmed') and "peer_online_deletion_recipients"."ack" is null and "peer_online_deletion_recipients"."ack_hash" is null and "peer_online_deletion_recipients"."acked_at" is null)),
	CONSTRAINT "peer_online_deletion_recipients_attempts_check" CHECK ("peer_online_deletion_recipients"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "peer_online_deletion_outbox" ADD COLUMN "local_device_id" text;--> statement-breakpoint
ALTER TABLE "peer_online_deletion_recipients" ADD CONSTRAINT "peer_online_deletion_recipients_group_id_session_key_peer_online_deletion_outbox_group_id_session_key_fk" FOREIGN KEY ("group_id","session_key") REFERENCES "public"."peer_online_deletion_outbox"("group_id","session_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION peer_online_deletion_recipient_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'peer online deletion recipients are retained for the life of the group' USING ERRCODE = '23514';
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id
     OR NEW.session_key IS DISTINCT FROM OLD.session_key
     OR NEW.recipient_device_id IS DISTINCT FROM OLD.recipient_device_id
     OR NEW.added_reason IS DISTINCT FROM OLD.added_reason
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'peer online deletion recipient identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'acked' THEN
    RAISE EXCEPTION 'peer online deletion acknowledgement is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_deletion_recipient_guard
BEFORE UPDATE OR DELETE ON peer_online_deletion_recipients
FOR EACH ROW EXECUTE FUNCTION peer_online_deletion_recipient_guard();
--> statement-breakpoint
CREATE FUNCTION peer_online_deletion_recipient_truncate_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'peer online deletion recipients are retained for the life of the group' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_deletion_recipient_no_truncate
BEFORE TRUNCATE ON peer_online_deletion_recipients
FOR EACH STATEMENT EXECUTE FUNCTION peer_online_deletion_recipient_truncate_guard();
