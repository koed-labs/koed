ALTER TYPE "collaboration_event_family" ADD VALUE IF NOT EXISTS 'team_agent_request_changed';--> statement-breakpoint

CREATE TABLE "team_agent_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE RESTRICT,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "description_marker" text NOT NULL DEFAULT '[koed encrypted Team Agent offer description]',
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_agent_offers_owner_agent_fk" FOREIGN KEY ("agent_id", "owner_user_id") REFERENCES "personal_agent_identities"("id", "owner_user_id") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_offers_description_marker_check" CHECK ("description_marker" = '[koed encrypted Team Agent offer description]'),
  CONSTRAINT "team_agent_offers_version_check" CHECK ("version" > 0),
  CONSTRAINT "team_agent_offers_id_team_unique" UNIQUE ("id", "team_id"),
  CONSTRAINT "team_agent_offers_team_owner_agent_unique" UNIQUE ("team_id", "owner_user_id", "agent_id")
);--> statement-breakpoint
CREATE INDEX "team_agent_offers_team_enabled_idx" ON "team_agent_offers" ("team_id", "updated_at" DESC);--> statement-breakpoint

CREATE TABLE "team_agent_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE RESTRICT,
  "team_project_id" uuid NOT NULL,
  "channel_id" uuid NOT NULL,
  "request_message_id" uuid NOT NULL,
  "requester_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "agent_version" integer NOT NULL,
  "agent_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'awaiting_owner',
  "job_id" uuid,
  "outcome_message_id" uuid,
  "idempotency_key_hash" text NOT NULL,
  "request_hash" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_agent_requests_team_project_fk" FOREIGN KEY ("team_project_id", "team_id") REFERENCES "collaboration_team_shared_projects"("id", "team_id") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_requests_owner_agent_version_fk" FOREIGN KEY ("agent_id", "owner_user_id", "agent_version") REFERENCES "personal_agent_identity_versions"("agent_id", "owner_user_id", "version") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_requests_channel_team_fk" FOREIGN KEY ("channel_id", "team_id") REFERENCES "collaboration_threads"("id", "team_id") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_requests_request_message_fk" FOREIGN KEY ("channel_id", "request_message_id") REFERENCES "collaboration_messages"("thread_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_requests_owner_job_fk" FOREIGN KEY ("job_id", "owner_user_id") REFERENCES "personal_agent_execution_jobs"("id", "owner_user_id") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_requests_outcome_message_fk" FOREIGN KEY ("channel_id", "outcome_message_id") REFERENCES "collaboration_messages"("thread_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "team_agent_requests_members_distinct_check" CHECK ("requester_user_id" <> "owner_user_id" AND "agent_version" > 0 AND length(trim("agent_name")) BETWEEN 1 AND 128),
  CONSTRAINT "team_agent_requests_status_check" CHECK ("status" IN ('awaiting_owner','accepted','declined','withdrawn','unavailable')),
  CONSTRAINT "team_agent_requests_status_shape_check" CHECK (("status" = 'accepted' AND "job_id" IS NOT NULL) OR ("status" <> 'accepted' AND "job_id" IS NULL)),
  CONSTRAINT "team_agent_requests_outcome_check" CHECK ("outcome_message_id" IS NULL OR "status" = 'accepted'),
  CONSTRAINT "team_agent_requests_hash_version_check" CHECK ("version" > 0 AND "idempotency_key_hash" ~ '^[0-9a-f]{64}$' AND "request_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "team_agent_requests_id_team_unique" UNIQUE ("id", "team_id"),
  CONSTRAINT "team_agent_requests_job_unique" UNIQUE ("job_id"),
  CONSTRAINT "team_agent_requests_request_message_unique" UNIQUE ("channel_id", "request_message_id"),
  CONSTRAINT "team_agent_requests_request_owner_unique" UNIQUE ("id", "owner_user_id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "team_agent_requests_idempotency_unique" ON "team_agent_requests" ("team_id", "requester_user_id", "idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "team_agent_requests_team_project_status_idx" ON "team_agent_requests" ("team_id", "team_project_id", "status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "team_agent_requests_owner_status_idx" ON "team_agent_requests" ("owner_user_id", "team_id", "status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "team_agent_requests_requester_idx" ON "team_agent_requests" ("requester_user_id", "team_id", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("source_table" IN (
  'conversation_items','conversation_item_observations','collaboration_messages','collaboration_threads',
  'curated_memory_assertions','curated_memory_proposals','curated_memory_sources','curated_memory_topics',
  'memory_answer_tasks','memory_embeddings','memory_events','memory_nodes','memory_questions','personal_notes',
  'personal_note_revisions','personal_agent_identity_versions','personal_agent_execution_jobs',
  'personal_agent_team_job_publications','memory_replica_revisions','messages','privacy_classification_results',
  'privacy_sanitized_source_artifacts','privacy_sanitized_source_chunks','shared_source_artifacts',
  'shared_source_semantic_previews','shared_source_previews','team_workspaces','team_memory_representations',
  'team_agent_offers','team_agent_requests','tool_events'
));--> statement-breakpoint

CREATE FUNCTION "publish_team_agent_request_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_cursor bigint;
DECLARE family_value collaboration_event_family := 'team_agent_request_changed';
DECLARE resource_type_value text;
DECLARE resource_id_value uuid;
DECLARE team_id_value uuid;
DECLARE thread_id_value uuid;
DECLARE message_id_value uuid;
BEGIN
  IF TG_TABLE_NAME = 'team_agent_requests' THEN
    resource_type_value := 'team_agent_request';
    resource_id_value := NEW.id;
    team_id_value := NEW.team_id;
    thread_id_value := NEW.channel_id;
    message_id_value := NEW.request_message_id;
  ELSE
    resource_type_value := 'team_agent_offer';
    resource_id_value := NEW.id;
    team_id_value := NEW.team_id;
    thread_id_value := NULL;
    message_id_value := NULL;
  END IF;
  INSERT INTO "collaboration_outbox" (
    protocol_version, family, scope, personal_owner_user_id, team_id,
    team_workspace_id, thread_id, message_id, share_grant_id, logical_memory_id,
    resource_type, resource_id, actor_principal_id, mutation_id, replay_until
  ) VALUES (
    6, family_value, 'team', NULL, team_id_value, NULL, thread_id_value,
    message_id_value, NULL, NULL, resource_type_value, resource_id_value,
    NULL, gen_random_uuid(), now() + interval '30 days'
  ) RETURNING cursor INTO event_cursor;
  PERFORM pg_notify('koed_collaboration_realtime', json_build_object(
    'scope','team','personalOwnerUserId',NULL,'teamId',team_id_value,
    'cursor',event_cursor,'family','team_agent_request_changed'
  )::text);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_agent_requests_invalidation" AFTER INSERT OR UPDATE OF status, job_id, outcome_message_id, version ON "team_agent_requests" FOR EACH ROW EXECUTE FUNCTION "publish_team_agent_request_invalidation"();--> statement-breakpoint
CREATE TRIGGER "team_agent_offers_invalidation" AFTER INSERT OR UPDATE OF enabled, version ON "team_agent_offers" FOR EACH ROW EXECUTE FUNCTION "publish_team_agent_request_invalidation"();--> statement-breakpoint
CREATE FUNCTION "refresh_team_agent_offers_from_identity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "team_agent_offers"
     SET enabled = CASE WHEN NEW.lifecycle = 'retired' THEN false ELSE enabled END,
         version = version + 1,
         updated_at = now()
   WHERE owner_user_id = NEW.owner_user_id
     AND agent_id = NEW.id
     AND (NEW.lifecycle = 'retired' OR OLD.name IS DISTINCT FROM NEW.name OR OLD.current_version IS DISTINCT FROM NEW.current_version);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_agent_offers_identity_refresh" AFTER UPDATE OF lifecycle, name, current_version ON "personal_agent_identities" FOR EACH ROW EXECUTE FUNCTION "refresh_team_agent_offers_from_identity"();--> statement-breakpoint

CREATE FUNCTION "invalidate_active_team_agent_requests_for_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "team_agent_requests" r
     SET version = r.version + 1, updated_at = now()
    FROM "personal_agent_team_job_publications" p
   WHERE r.job_id = NEW.id
     AND r.owner_user_id = NEW.owner_user_id
     AND p.job_id = NEW.id
     AND p.owner_user_id = NEW.owner_user_id
     AND p.team_id = r.team_id
     AND p.team_project_id = r.team_project_id
     AND p.state = 'active';
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_agent_request_job_invalidation" AFTER UPDATE OF state, updated_at ON "personal_agent_execution_jobs" FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.updated_at IS DISTINCT FROM NEW.updated_at) EXECUTE FUNCTION "invalidate_active_team_agent_requests_for_job"();--> statement-breakpoint

CREATE FUNCTION "close_pending_team_agent_requests"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_json jsonb := to_jsonb(NEW);
BEGIN
  UPDATE "team_agent_requests"
     SET status = 'unavailable', version = version + 1, updated_at = now()
   WHERE status = 'awaiting_owner'
     AND team_id = (row_json->>'team_id')::uuid
     AND ((TG_TABLE_NAME = 'team_memberships' AND (requester_user_id = (row_json->>'user_id')::uuid OR owner_user_id = (row_json->>'user_id')::uuid))
       OR (TG_TABLE_NAME = 'collaboration_team_shared_projects' AND team_project_id = (row_json->>'id')::uuid)
       OR (TG_TABLE_NAME = 'team_agent_offers' AND owner_user_id = (row_json->>'owner_user_id')::uuid AND agent_id = (row_json->>'agent_id')::uuid));
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_agent_requests_membership_closed" AFTER UPDATE OF status, disabled_at ON "team_memberships" FOR EACH ROW WHEN (OLD.status = 'enabled' AND (NEW.status <> 'enabled' OR NEW.disabled_at IS NOT NULL)) EXECUTE FUNCTION "close_pending_team_agent_requests"();--> statement-breakpoint
CREATE TRIGGER "team_agent_requests_project_unshared" AFTER UPDATE OF unshared_at ON "collaboration_team_shared_projects" FOR EACH ROW WHEN (OLD.unshared_at IS NULL AND NEW.unshared_at IS NOT NULL) EXECUTE FUNCTION "close_pending_team_agent_requests"();--> statement-breakpoint
CREATE TRIGGER "team_agent_requests_offer_disabled" AFTER UPDATE OF enabled ON "team_agent_offers" FOR EACH ROW WHEN (OLD.enabled AND NOT NEW.enabled) EXECUTE FUNCTION "close_pending_team_agent_requests"();--> statement-breakpoint
