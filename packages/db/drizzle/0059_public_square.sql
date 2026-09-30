ALTER TYPE "collaboration_event_family" ADD VALUE IF NOT EXISTS 'public_square_changed';--> statement-breakpoint
ALTER TABLE "managed_conversation_executions" ADD COLUMN "runner_last_seen_at" timestamptz;--> statement-breakpoint
ALTER TABLE "collaboration_team_shared_projects" ADD COLUMN "unshared_at" timestamptz;--> statement-breakpoint
CREATE TABLE "public_square_project_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE RESTRICT,
  "team_project_id" uuid NOT NULL,
  "local_project_id" text,
  "version" integer NOT NULL DEFAULT 0,
  "connected_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "public_square_project_connections_team_project_fk" FOREIGN KEY ("team_project_id", "team_id") REFERENCES "collaboration_team_shared_projects"("id", "team_id") ON DELETE RESTRICT,
  CONSTRAINT "public_square_project_connections_version_check" CHECK ("version" >= 0),
  CONSTRAINT "public_square_project_connections_local_id_check" CHECK ("local_project_id" IS NULL OR (length(trim("local_project_id")) BETWEEN 1 AND 256 AND "local_project_id" ~ '^[A-Za-z0-9._:-]+$' AND lower(trim("local_project_id")) <> 'unassigned')),
  CONSTRAINT "public_square_project_connections_active_check" CHECK (("local_project_id" IS NULL) = ("connected_at" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "public_square_project_connections_owner_project_unique" ON "public_square_project_connections" ("actor_user_id", "team_project_id");--> statement-breakpoint
CREATE INDEX "public_square_project_connections_project_active_idx" ON "public_square_project_connections" ("team_project_id", "actor_user_id") WHERE "local_project_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "personal_agent_team_job_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE RESTRICT,
  "team_project_id" uuid NOT NULL,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "job_id" uuid NOT NULL REFERENCES "personal_agent_execution_jobs"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "public_square_project_connections"("id") ON DELETE RESTRICT,
  "state" text NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "owner_left_team" boolean NOT NULL DEFAULT false,
  "frozen_status" text,
  "frozen_updated_at" timestamptz,
  "frozen_last_seen_at" timestamptz,
  "frozen_completed_at" timestamptz,
  "last_known_status" text,
  "last_seen_at" timestamptz,
  "completed_at" timestamptz,
  "published_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "personal_agent_team_job_publications_team_project_fk" FOREIGN KEY ("team_project_id", "team_id") REFERENCES "collaboration_team_shared_projects"("id", "team_id") ON DELETE RESTRICT,
  CONSTRAINT "personal_agent_team_job_publications_state_check" CHECK ("state" IN ('active','frozen','revoked')),
  CONSTRAINT "personal_agent_team_job_publications_status_check" CHECK ("last_known_status" IS NULL OR "last_known_status" IN ('queued','running','waiting','succeeded','failed','canceled','interrupted')),
  CONSTRAINT "personal_agent_team_job_publications_frozen_status_check" CHECK ("frozen_status" IS NULL OR "frozen_status" IN ('queued','running','waiting','succeeded','failed','canceled','interrupted')),
  CONSTRAINT "personal_agent_team_job_publications_version_check" CHECK ("version" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "personal_agent_team_job_publications_connection_job_unique" ON "personal_agent_team_job_publications" ("connection_id", "job_id");--> statement-breakpoint
CREATE INDEX "personal_agent_team_job_publications_team_page_idx" ON "personal_agent_team_job_publications" ("team_id", "published_at" DESC, "id" DESC) WHERE "state" <> 'revoked';--> statement-breakpoint
CREATE INDEX "personal_agent_team_job_publications_owner_active_idx" ON "personal_agent_team_job_publications" ("owner_user_id", "team_id") WHERE "state" = 'active';--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("source_table" IN (
  'conversation_items','conversation_item_observations','collaboration_messages','collaboration_threads',
  'curated_memory_assertions','curated_memory_proposals','curated_memory_sources','curated_memory_topics',
  'memory_answer_tasks','memory_embeddings','memory_events','memory_nodes','memory_questions','personal_notes',
  'personal_note_revisions','personal_agent_identity_versions','personal_agent_execution_jobs',
  'personal_agent_team_job_publications','memory_replica_revisions','messages','privacy_classification_results',
  'privacy_sanitized_source_artifacts','privacy_sanitized_source_chunks','shared_source_artifacts',
  'shared_source_semantic_previews','shared_source_previews','team_workspaces',
  'team_memory_representations','tool_events'
));
--> statement-breakpoint
CREATE FUNCTION "publish_active_personal_agent_job"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link record;
BEGIN
  IF NEW.state NOT IN ('queued','running') THEN RETURN NEW; END IF;
  FOR link IN
    SELECT c.id,c.team_id,c.team_project_id,e.runner_last_seen_at
    FROM "public_square_project_connections" c
    JOIN "managed_conversation_executions" e ON e.id=NEW.conversation_id AND e.owner_user_id=NEW.owner_user_id AND e.state<>'failed'
    JOIN "collaboration_team_shared_projects" p ON p.id=c.team_project_id AND p.team_id=c.team_id AND p.unshared_at IS NULL
    WHERE c.actor_user_id=NEW.owner_user_id AND c.local_project_id=NEW.project_id AND c.local_project_id IS NOT NULL
  LOOP
    PERFORM 1 FROM "team_memberships" m WHERE m.team_id=link.team_id AND m.user_id=NEW.owner_user_id AND m.status='enabled' AND m.disabled_at IS NULL FOR SHARE;
    IF FOUND THEN
      INSERT INTO "personal_agent_team_job_publications" (team_id,team_project_id,owner_user_id,job_id,connection_id,last_known_status,last_seen_at)
      VALUES (link.team_id,link.team_project_id,NEW.owner_user_id,NEW.id,link.id,NEW.state,link.runner_last_seen_at)
      ON CONFLICT(connection_id,job_id) DO NOTHING;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "personal_agent_job_public_square_insert" AFTER INSERT ON "personal_agent_execution_jobs" FOR EACH ROW EXECUTE FUNCTION "publish_active_personal_agent_job"();--> statement-breakpoint
CREATE FUNCTION "freeze_public_square_owner_publications"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='enabled' AND NEW.status<>'enabled' THEN
    UPDATE "personal_agent_team_job_publications" p SET state='frozen',owner_left_team=true,
      frozen_status=CASE WHEN j.state IN ('queued','running') AND e.state='failed' THEN 'failed' WHEN j.state IN ('queued','running') AND EXISTS(SELECT 1 FROM "managed_conversation_runtime_items" r WHERE r.execution_id=j.conversation_id AND r.owner_user_id=j.owner_user_id AND r.state='pending') THEN 'waiting' ELSE j.state END,frozen_updated_at=j.updated_at,frozen_last_seen_at=e.runner_last_seen_at,
      frozen_completed_at=CASE WHEN j.state IN ('succeeded','failed','canceled') OR (j.state IN ('queued','running') AND e.state='failed') THEN j.updated_at ELSE NULL END,
      version=p.version+1,updated_at=now()
    FROM "personal_agent_execution_jobs" j
    JOIN "managed_conversation_executions" e ON e.id=j.conversation_id AND e.owner_user_id=j.owner_user_id
    WHERE p.job_id=j.id AND p.owner_user_id=NEW.user_id AND p.team_id=NEW.team_id AND p.state='active';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_membership_freeze_public_square" AFTER UPDATE OF "status" ON "team_memberships" FOR EACH ROW EXECUTE FUNCTION "freeze_public_square_owner_publications"();--> statement-breakpoint
CREATE FUNCTION "revoke_public_square_on_project_unshare"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unshared_at IS NULL AND NEW.unshared_at IS NOT NULL THEN
    UPDATE "personal_agent_team_job_publications" SET state='revoked',version=version+1,updated_at=now()
    WHERE team_project_id=NEW.id AND team_id=NEW.team_id AND state<>'revoked';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_project_unshare_public_square" AFTER UPDATE OF "unshared_at" ON "collaboration_team_shared_projects" FOR EACH ROW EXECUTE FUNCTION "revoke_public_square_on_project_unshare"();--> statement-breakpoint
CREATE FUNCTION "append_public_square_invalidation"(p_team_id uuid,p_resource_type text,p_resource_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE event_cursor bigint;
BEGIN
  INSERT INTO "collaboration_outbox" (protocol_version,family,scope,team_id,resource_type,resource_id,mutation_id,replay_until)
  VALUES (5,'public_square_changed','team',p_team_id,p_resource_type,p_resource_id,gen_random_uuid(),now()+interval '30 days')
  RETURNING cursor INTO event_cursor;
  PERFORM pg_notify('koed_collaboration_realtime',json_build_object('scope','team','personalOwnerUserId',null,'teamId',p_team_id,'cursor',event_cursor,'family','public_square_changed')::text);
END $$;--> statement-breakpoint
CREATE FUNCTION "emit_public_square_publication_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "append_public_square_invalidation"(NEW.team_id,'public_square_publication',NEW.id);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "public_square_publication_invalidation" AFTER INSERT OR UPDATE ON "personal_agent_team_job_publications" FOR EACH ROW EXECUTE FUNCTION "emit_public_square_publication_invalidation"();--> statement-breakpoint
CREATE FUNCTION "emit_public_square_project_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unshared_at IS DISTINCT FROM NEW.unshared_at THEN
    PERFORM "append_public_square_invalidation"(NEW.team_id,'public_square_project',NEW.id);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "public_square_project_invalidation" AFTER UPDATE OF "unshared_at" ON "collaboration_team_shared_projects" FOR EACH ROW EXECUTE FUNCTION "emit_public_square_project_invalidation"();--> statement-breakpoint
CREATE FUNCTION "emit_public_square_connection_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "append_public_square_invalidation"(NEW.team_id,'public_square_project',NEW.team_project_id);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "public_square_connection_invalidation" AFTER INSERT OR UPDATE ON "public_square_project_connections" FOR EACH ROW EXECUTE FUNCTION "emit_public_square_connection_invalidation"();--> statement-breakpoint
CREATE FUNCTION "refresh_public_square_job_status"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state THEN
    UPDATE "personal_agent_team_job_publications" SET last_known_status=NEW.state,
      completed_at=CASE WHEN NEW.state IN ('succeeded','failed','canceled') THEN NEW.updated_at ELSE NULL END,
      updated_at=now()
    WHERE job_id=NEW.id AND owner_user_id=NEW.owner_user_id AND state='active';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "personal_agent_job_public_square_status" AFTER UPDATE OF "state" ON "personal_agent_execution_jobs" FOR EACH ROW EXECUTE FUNCTION "refresh_public_square_job_status"();--> statement-breakpoint
CREATE FUNCTION "refresh_public_square_last_seen"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.runner_last_seen_at IS DISTINCT FROM OLD.runner_last_seen_at THEN
    UPDATE "personal_agent_team_job_publications" p SET last_seen_at=NEW.runner_last_seen_at,updated_at=now()
    WHERE p.owner_user_id=NEW.owner_user_id AND p.state='active'
      AND p.last_seen_at IS DISTINCT FROM NEW.runner_last_seen_at
      AND p.job_id IN (SELECT id FROM "personal_agent_execution_jobs" WHERE conversation_id=NEW.id AND owner_user_id=NEW.owner_user_id);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "managed_execution_public_square_last_seen" AFTER UPDATE OF "runner_last_seen_at" ON "managed_conversation_executions" FOR EACH ROW EXECUTE FUNCTION "refresh_public_square_last_seen"();--> statement-breakpoint
CREATE FUNCTION "refresh_public_square_waiting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "personal_agent_team_job_publications" p SET updated_at=now()
  WHERE p.state='active' AND p.job_id IN (SELECT j.id FROM "personal_agent_execution_jobs" j WHERE j.conversation_id=NEW.execution_id AND j.owner_user_id=NEW.owner_user_id);
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "runtime_item_public_square_waiting" AFTER INSERT OR UPDATE OF "state" ON "managed_conversation_runtime_items" FOR EACH ROW EXECUTE FUNCTION "refresh_public_square_waiting"();
