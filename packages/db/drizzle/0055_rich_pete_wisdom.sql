CREATE TABLE "peer_online_replicas" (
	"group_id" text NOT NULL,
	"session_key" text NOT NULL,
	"binding_hash" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"local_session_id" uuid NOT NULL,
	"checkpoint_sequence" text NOT NULL,
	"checkpoint_hash" text NOT NULL,
	"item_count" integer NOT NULL,
	CONSTRAINT "peer_online_replicas_group_id_session_key_pk" PRIMARY KEY("group_id","session_key"),
	CONSTRAINT "peer_online_replicas_local_session_id_unique" UNIQUE("local_session_id"),
	CONSTRAINT "peer_online_replicas_item_count_check" CHECK ("peer_online_replicas"."item_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "peer_online_source_items" (
	"group_id" text NOT NULL,
	"session_key" text NOT NULL,
	"source_ordinal" integer NOT NULL,
	"source_digest" text NOT NULL,
	"conversation_item_id" uuid NOT NULL,
	CONSTRAINT "peer_online_source_items_group_id_session_key_source_ordinal_pk" PRIMARY KEY("group_id","session_key","source_ordinal"),
	CONSTRAINT "peer_online_source_items_conversation_item_id_unique" UNIQUE("conversation_item_id"),
	CONSTRAINT "peer_online_source_items_ordinal_check" CHECK ("peer_online_source_items"."source_ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "peer_online_replicas" ADD CONSTRAINT "peer_online_replicas_group_id_session_key_peer_online_sessions_group_id_session_key_fk" FOREIGN KEY ("group_id","session_key") REFERENCES "public"."peer_online_sessions"("group_id","session_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_online_replicas" ADD CONSTRAINT "peer_online_replicas_local_session_id_owner_user_id_sessions_id_owner_user_id_fk" FOREIGN KEY ("local_session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_online_source_items" ADD CONSTRAINT "peer_online_source_items_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peer_online_source_items" ADD CONSTRAINT "peer_online_source_items_group_id_session_key_peer_online_replicas_group_id_session_key_fk" FOREIGN KEY ("group_id","session_key") REFERENCES "public"."peer_online_replicas"("group_id","session_key") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION peer_online_guard_replica_source() RETURNS trigger AS $$
DECLARE replica_session uuid;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    IF EXISTS (SELECT 1 FROM peer_online_replicas WHERE local_session_id=OLD.id) THEN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'peer online replica Sessions are read-only'; END IF;
      IF OLD.personal_deleted_at IS NOT NULL AND (NEW.personal_deleted_at IS DISTINCT FROM OLD.personal_deleted_at OR NEW.personal_deleted_by_user_id IS DISTINCT FROM OLD.personal_deleted_by_user_id OR NEW.personal_deletion_reason IS DISTINCT FROM OLD.personal_deletion_reason) THEN
        RAISE EXCEPTION 'peer online deletion is irreversible';
      END IF;
      IF (to_jsonb(NEW)-ARRAY['metadata','updated_at','repository_override_identity','repository_assignment_version','repository_assignment_revision_id','folder_assignment','project_override_id','project_override_name','project_override_path','project_override_at','project_override_by_user_id','personal_deleted_at','personal_deleted_by_user_id','personal_deletion_reason']::text[])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['metadata','updated_at','repository_override_identity','repository_assignment_version','repository_assignment_revision_id','folder_assignment','project_override_id','project_override_name','project_override_path','project_override_at','project_override_by_user_id','personal_deleted_at','personal_deleted_by_user_id','personal_deletion_reason']::text[])
        OR (NEW.metadata - ARRAY['threadName','threadNameSource','threadNameGeneratedAt','threadNameEditedAt']) IS DISTINCT FROM (OLD.metadata - ARRAY['threadName','threadNameSource','threadNameGeneratedAt','threadNameEditedAt']) THEN
        RAISE EXCEPTION 'peer online replica Sessions are read-only';
      END IF;
    END IF;
    RETURN COALESCE(NEW,OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.session_id IS DISTINCT FROM OLD.session_id AND EXISTS (SELECT 1 FROM peer_online_replicas WHERE local_session_id=NEW.session_id) THEN
    RAISE EXCEPTION 'peer online replica Sessions are read-only';
  END IF;
  replica_session := CASE WHEN TG_OP = 'INSERT' THEN NEW.session_id ELSE OLD.session_id END;
  IF EXISTS (SELECT 1 FROM peer_online_replicas WHERE local_session_id=replica_session) THEN
    IF TG_OP = 'INSERT' THEN
      IF current_setting('koed.peer_online_append_session',true) IS DISTINCT FROM replica_session::text THEN
        RAISE EXCEPTION 'peer online replica Sessions are read-only';
      END IF;
    ELSIF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'peer online source items are read-only';
    ELSIF OLD.personal_deleted_at IS NOT NULL AND (NEW.personal_deleted_at IS DISTINCT FROM OLD.personal_deleted_at OR NEW.personal_deleted_by_user_id IS DISTINCT FROM OLD.personal_deleted_by_user_id OR NEW.personal_deletion_reason IS DISTINCT FROM OLD.personal_deletion_reason) THEN
      RAISE EXCEPTION 'peer online deletion is irreversible';
    ELSIF (to_jsonb(NEW)-ARRAY['projection_status','projection_work_class','projection_version','projection_policy_revision','projected_at','projection_error','memory_excluded_at','memory_exclusion_reason','memory_excluded_by_user_id','personal_deleted_at','personal_deleted_by_user_id','personal_deletion_reason']::text[])
       IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['projection_status','projection_work_class','projection_version','projection_policy_revision','projected_at','projection_error','memory_excluded_at','memory_exclusion_reason','memory_excluded_by_user_id','personal_deleted_at','personal_deleted_by_user_id','personal_deletion_reason']::text[]) THEN
      RAISE EXCEPTION 'peer online source items are read-only';
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_replica_session_read_only BEFORE UPDATE OR DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION peer_online_guard_replica_source();
--> statement-breakpoint
CREATE TRIGGER peer_online_replica_item_read_only BEFORE INSERT OR UPDATE OR DELETE ON conversation_items FOR EACH ROW EXECUTE FUNCTION peer_online_guard_replica_source();
--> statement-breakpoint
CREATE FUNCTION peer_online_reject_replica_publication() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM peer_online_replicas WHERE local_session_id=NEW.source_session_id) THEN
    RAISE EXCEPTION 'peer online replica Sessions cannot become origin writers';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER peer_online_replica_no_pds_publication BEFORE INSERT ON pds_session_closures FOR EACH ROW EXECUTE FUNCTION peer_online_reject_replica_publication();