CREATE TABLE "personal_agent_native_public_square_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version" integer NOT NULL,
	"original_project_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_public_square_work_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "native_public_square_work_owner_command_unique" UNIQUE("owner_user_id","command_id"),
	CONSTRAINT "native_public_square_work_generation_check" CHECK ("personal_agent_native_public_square_work"."execution_generation" > 0 and "personal_agent_native_public_square_work"."agent_version" > 0
        and ("personal_agent_native_public_square_work"."original_project_id" is null or length(trim("personal_agent_native_public_square_work"."original_project_id")) between 1 and 512))
);
--> statement-breakpoint
CREATE TABLE "personal_agent_team_native_command_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"team_project_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_left_team" boolean DEFAULT false NOT NULL,
	"frozen_status" text,
	"frozen_last_known_status" text,
	"frozen_updated_at" timestamp with time zone,
	"frozen_started_at" timestamp with time zone,
	"frozen_last_seen_at" timestamp with time zone,
	"frozen_completed_at" timestamp with time zone,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_publications_connection_work_unique" UNIQUE("connection_id","work_id"),
	CONSTRAINT "native_publications_state_check" CHECK ("personal_agent_team_native_command_publications"."state" in ('active','frozen','revoked')
        and ("personal_agent_team_native_command_publications"."state" <> 'active' or "personal_agent_team_native_command_publications"."owner_left_team" = false)
        and ("personal_agent_team_native_command_publications"."state" <> 'frozen' or ("personal_agent_team_native_command_publications"."owner_left_team" = true and "personal_agent_team_native_command_publications"."frozen_status" is not null and "personal_agent_team_native_command_publications"."frozen_updated_at" is not null))),
	CONSTRAINT "native_publications_frozen_status_check" CHECK ("personal_agent_team_native_command_publications"."frozen_status" is null or "personal_agent_team_native_command_publications"."frozen_status" in (
        'queued','running','waiting','succeeded','failed','canceled',
        'interrupted','offline','unknown'
      )),
	CONSTRAINT "native_publications_frozen_last_status_check" CHECK ("personal_agent_team_native_command_publications"."frozen_last_known_status" is null or "personal_agent_team_native_command_publications"."frozen_last_known_status" in (
        'queued','running','waiting','succeeded','failed','canceled',
        'interrupted','offline','unknown'
      )),
	CONSTRAINT "native_publications_version_check" CHECK ("personal_agent_team_native_command_publications"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "public_square_project_connections" ADD CONSTRAINT "public_square_project_connections_id_owner_team_project_unique" UNIQUE("id","actor_user_id","team_id","team_project_id");--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
ALTER TABLE "personal_agent_native_public_square_work" ADD CONSTRAINT "personal_agent_native_public_square_work_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_native_public_square_work" ADD CONSTRAINT "native_public_square_work_owner_execution_fk" FOREIGN KEY ("execution_id","owner_user_id") REFERENCES "public"."managed_conversation_executions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_native_public_square_work" ADD CONSTRAINT "native_public_square_work_owner_command_fk" FOREIGN KEY ("command_id","execution_id","owner_user_id") REFERENCES "public"."managed_conversation_commands"("id","execution_id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_native_public_square_work" ADD CONSTRAINT "native_public_square_work_agent_version_fk" FOREIGN KEY ("owner_user_id","agent_id","agent_version") REFERENCES "public"."personal_agent_identity_versions"("owner_user_id","agent_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_team_native_command_publications" ADD CONSTRAINT "personal_agent_team_native_command_publications_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_team_native_command_publications" ADD CONSTRAINT "personal_agent_team_native_command_publications_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_team_native_command_publications" ADD CONSTRAINT "native_publications_team_project_fk" FOREIGN KEY ("team_project_id","team_id") REFERENCES "public"."collaboration_team_shared_projects"("id","team_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_team_native_command_publications" ADD CONSTRAINT "native_publications_owner_work_fk" FOREIGN KEY ("work_id","owner_user_id") REFERENCES "public"."personal_agent_native_public_square_work"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_agent_team_native_command_publications" ADD CONSTRAINT "native_publications_connection_fk" FOREIGN KEY ("connection_id","owner_user_id","team_id","team_project_id") REFERENCES "public"."public_square_project_connections"("id","actor_user_id","team_id","team_project_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_public_square_work_project_idx" ON "personal_agent_native_public_square_work" USING btree ("owner_user_id","original_project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "native_publications_team_page_idx" ON "personal_agent_team_native_command_publications" USING btree ("team_id","published_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "personal_agent_team_native_command_publications"."state" <> 'revoked';--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("encrypted_field_payloads"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'collaboration_messages',
        'collaboration_threads',
        'curated_memory_assertions',
        'curated_memory_proposals',
        'curated_memory_sources',
        'curated_memory_topics',
        'memory_answer_tasks',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'personal_notes',
        'personal_note_revisions',
        'personal_agent_identity_versions',
        'personal_agent_chat_messages',
        'personal_agent_chat_deliveries',
        'personal_agent_execution_jobs',
        'personal_agent_team_job_publications',
        'personal_agent_team_native_command_publications',
        'team_agent_offers',
        'team_agent_requests',
        'managed_conversation_recall_feedback',
        'memory_replica_revisions',
        'messages',
        'privacy_classification_results',
        'privacy_sanitized_source_artifacts',
        'privacy_sanitized_source_chunks',
        'shared_source_artifacts',
        'shared_source_semantic_previews',
        'shared_source_previews',
        'team_workspaces',
        'team_memory_representations',
        'tool_events'
      ));
--> statement-breakpoint
CREATE FUNCTION "native_public_square_command_status"(
  p_execution_id uuid,
  p_command_id uuid,
  p_owner_user_id uuid,
  p_execution_generation integer
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN c.state='completed'
      AND native.status='waiting'
      AND c.execution_generation<>e.execution_generation
      THEN 'unknown'
    WHEN c.state='completed'
      AND native.status='waiting'
      AND c.execution_generation=e.execution_generation
      AND e.runner_last_seen_at IS NOT NULL
      AND (e.runner_lease_expires_at IS NULL OR e.runner_lease_expires_at <= now())
      THEN 'offline'
    WHEN c.state='dispatching'
      AND c.execution_generation=e.execution_generation
      AND e.state IN ('running','reconciling')
      AND e.runner_last_seen_at IS NOT NULL
      AND (c.lease_expires_at IS NULL OR c.lease_expires_at <= now()
        OR e.runner_lease_expires_at IS NULL OR e.runner_lease_expires_at <= now())
      THEN 'offline'
    ELSE native.status
  END
  FROM (SELECT p_execution_id AS id) requested
  LEFT JOIN "managed_conversation_commands" c
    ON c.id=p_command_id AND c.execution_id=p_execution_id
   AND c.owner_user_id=p_owner_user_id
   AND c.execution_generation=p_execution_generation
  LEFT JOIN "managed_conversation_executions" e
    ON e.id=p_execution_id AND e.owner_user_id=p_owner_user_id
  CROSS JOIN LATERAL (
    SELECT team_agent_request_native_execution_status(
      p_execution_id,p_command_id,p_owner_user_id
    ) AS status
  ) native
$$;--> statement-breakpoint
CREATE FUNCTION "native_public_square_command_last_known_status"(
  p_execution_id uuid,
  p_command_id uuid,
  p_owner_user_id uuid,
  p_execution_generation integer
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN "native_public_square_command_status"(
      p_execution_id,p_command_id,p_owner_user_id,p_execution_generation
    ) <> 'offline' THEN NULL
    WHEN EXISTS (
      SELECT 1
        FROM "managed_conversation_commands" c
        JOIN "managed_conversation_runtime_items" ri
          ON ri.execution_id=c.execution_id AND ri.owner_user_id=c.owner_user_id
         AND ri.execution_generation=c.execution_generation
       WHERE c.id=p_command_id AND c.execution_id=p_execution_id
         AND c.owner_user_id=p_owner_user_id
         AND c.execution_generation=p_execution_generation
         AND ri.state='pending'
         AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
         AND ri.provider_turn_id=COALESCE(c.result->>'turnId',c.result->>'providerTurnId')
         AND COALESCE(c.result->>'turnId',c.result->>'providerTurnId') IS NOT NULL
    ) THEN 'waiting'
    ELSE 'running'
  END
$$;--> statement-breakpoint
CREATE FUNCTION "freeze_native_public_square_owner_publications"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='enabled' AND (NEW.status<>'enabled' OR NEW.disabled_at IS NOT NULL) THEN
    UPDATE "personal_agent_team_native_command_publications" p
       SET state='frozen',owner_left_team=true,
           frozen_status="native_public_square_command_status"(
             w.execution_id,w.command_id,w.owner_user_id,w.execution_generation
           ),
           frozen_last_known_status="native_public_square_command_last_known_status"(
             w.execution_id,w.command_id,w.owner_user_id,w.execution_generation
           ),
           frozen_updated_at=now(),
           frozen_started_at=c.dispatching_at,
           frozen_last_seen_at=CASE
             WHEN "native_public_square_command_status"(
               w.execution_id,w.command_id,w.owner_user_id,w.execution_generation
             ) IN ('succeeded','failed','canceled','interrupted')
               THEN CASE WHEN e.runner_last_seen_at IS NULL THEN NULL
                    ELSE LEAST(e.runner_last_seen_at,
                      CASE WHEN c.state IN ('completed','failed','canceled')
                           THEN COALESCE(c.completed_at,c.updated_at)
                           ELSE COALESCE(e.stopped_at,c.updated_at) END) END
             ELSE e.runner_last_seen_at
           END,
           frozen_completed_at=CASE
             WHEN "native_public_square_command_status"(
               w.execution_id,w.command_id,w.owner_user_id,w.execution_generation
             ) IN ('succeeded','failed','canceled','interrupted')
               THEN CASE WHEN c.state IN ('completed','failed','canceled')
                         THEN COALESCE(c.completed_at,c.updated_at)
                         ELSE COALESCE(e.stopped_at,c.updated_at) END
             ELSE NULL
           END,
           version=p.version+1,updated_at=now()
      FROM "personal_agent_native_public_square_work" w
      JOIN "managed_conversation_commands" c
        ON c.id=w.command_id AND c.execution_id=w.execution_id
       AND c.owner_user_id=w.owner_user_id
      JOIN "managed_conversation_executions" e
        ON e.id=w.execution_id AND e.owner_user_id=w.owner_user_id
     WHERE p.work_id=w.id AND p.owner_user_id=NEW.user_id
       AND p.team_id=NEW.team_id AND p.state='active';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "native_public_square_owner_departure_freeze"
AFTER UPDATE OF "status","disabled_at" ON "team_memberships"
FOR EACH ROW
WHEN (OLD.status='enabled' AND (NEW.status<>'enabled' OR NEW.disabled_at IS NOT NULL))
EXECUTE FUNCTION "freeze_native_public_square_owner_publications"();
--> statement-breakpoint
CREATE TRIGGER "native_public_square_publication_invalidation"
AFTER INSERT OR UPDATE ON "personal_agent_team_native_command_publications"
FOR EACH ROW EXECUTE FUNCTION "emit_public_square_publication_invalidation"();
--> statement-breakpoint
CREATE FUNCTION "revoke_native_public_square_on_project_unshare"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.unshared_at IS NULL AND NEW.unshared_at IS NOT NULL THEN
    UPDATE "personal_agent_team_native_command_publications" p
       SET state='revoked',version=p.version+1,updated_at=now()
     WHERE p.team_id=NEW.team_id AND p.team_project_id=NEW.id
       AND p.state<>'revoked';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "team_project_unshare_native_public_square"
AFTER UPDATE OF "unshared_at" ON "collaboration_team_shared_projects"
FOR EACH ROW EXECUTE FUNCTION "revoke_native_public_square_on_project_unshare"();
--> statement-breakpoint
CREATE FUNCTION "append_native_public_square_turn_invalidation"(
  p_execution_id uuid,
  p_owner_user_id uuid,
  p_execution_generation integer,
  p_provider_turn_id text,
  p_was_pending boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE publication record;
BEGIN
  IF p_provider_turn_id IS NULL THEN RETURN; END IF;
  FOR publication IN
    SELECT DISTINCT p.team_id,p.id
      FROM "managed_conversation_commands" c
      JOIN "personal_agent_native_public_square_work" w
        ON w.command_id=c.id AND w.execution_id=c.execution_id
       AND w.owner_user_id=c.owner_user_id
      JOIN "personal_agent_team_native_command_publications" p
        ON p.work_id=w.id AND p.owner_user_id=w.owner_user_id
     WHERE c.execution_id=p_execution_id AND c.owner_user_id=p_owner_user_id
       AND c.execution_generation=p_execution_generation
       AND COALESCE(c.result->>'turnId',c.result->>'providerTurnId')=p_provider_turn_id
       AND p.state='active'
       AND (
         p_was_pending
         OR "native_public_square_command_status"(
           w.execution_id,w.command_id,w.owner_user_id,w.execution_generation
         ) IN ('queued','running','waiting','offline','unknown')
       )
  LOOP
    PERFORM "append_public_square_invalidation"(
      publication.team_id,'public_square_publication',publication.id
    );
  END LOOP;
END $$;--> statement-breakpoint
CREATE FUNCTION "emit_native_public_square_runtime_item_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE'
     AND OLD.execution_id IS NOT DISTINCT FROM NEW.execution_id
     AND OLD.owner_user_id IS NOT DISTINCT FROM NEW.owner_user_id
     AND OLD.execution_generation IS NOT DISTINCT FROM NEW.execution_generation
     AND OLD.provider_turn_id IS NOT DISTINCT FROM NEW.provider_turn_id
     AND OLD.item_kind IS NOT DISTINCT FROM NEW.item_kind
     AND OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM "append_native_public_square_turn_invalidation"(
      OLD.execution_id,OLD.owner_user_id,OLD.execution_generation,
      OLD.provider_turn_id,OLD.state='pending'
    );
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM "append_native_public_square_turn_invalidation"(
      NEW.execution_id,NEW.owner_user_id,NEW.execution_generation,
      NEW.provider_turn_id,false
    );
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER "native_public_square_runtime_item_invalidation"
AFTER INSERT OR UPDATE OR DELETE ON "managed_conversation_runtime_items"
FOR EACH ROW EXECUTE FUNCTION "emit_native_public_square_runtime_item_invalidation"();
--> statement-breakpoint
CREATE FUNCTION "emit_native_public_square_command_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication record;
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state
     OR COALESCE(OLD.result->>'turnId',OLD.result->>'providerTurnId')
          IS DISTINCT FROM COALESCE(NEW.result->>'turnId',NEW.result->>'providerTurnId')
     OR OLD.dispatching_at IS DISTINCT FROM NEW.dispatching_at
     OR OLD.completed_at IS DISTINCT FROM NEW.completed_at THEN
    FOR publication IN
      SELECT DISTINCT p.team_id,p.id
        FROM "personal_agent_native_public_square_work" w
        JOIN "personal_agent_team_native_command_publications" p
          ON p.work_id=w.id AND p.owner_user_id=w.owner_user_id
       WHERE w.execution_id=NEW.execution_id AND w.command_id=NEW.id
         AND w.owner_user_id=NEW.owner_user_id AND p.state='active'
    LOOP
      PERFORM "append_public_square_invalidation"(
        publication.team_id,'public_square_publication',publication.id
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "native_public_square_command_invalidation"
AFTER UPDATE ON "managed_conversation_commands"
FOR EACH ROW EXECUTE FUNCTION "emit_native_public_square_command_invalidation"();
--> statement-breakpoint
CREATE FUNCTION "emit_native_public_square_execution_invalidation"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE publication record;
BEGIN
  IF OLD.state IS DISTINCT FROM NEW.state
     OR OLD.execution_generation IS DISTINCT FROM NEW.execution_generation
     OR OLD.stopped_at IS DISTINCT FROM NEW.stopped_at THEN
    FOR publication IN
      SELECT DISTINCT p.team_id,p.id
        FROM "personal_agent_native_public_square_work" w
        JOIN "managed_conversation_commands" c
          ON c.id=w.command_id AND c.execution_id=w.execution_id
         AND c.owner_user_id=w.owner_user_id
        JOIN "personal_agent_team_native_command_publications" p
          ON p.work_id=w.id AND p.owner_user_id=w.owner_user_id
       WHERE w.execution_id=NEW.id AND w.owner_user_id=NEW.owner_user_id
         AND p.state='active' AND c.state IN ('queued','blocked','dispatching')
    LOOP
      PERFORM "append_public_square_invalidation"(
        publication.team_id,'public_square_publication',publication.id
      );
    END LOOP;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "native_public_square_execution_invalidation"
AFTER UPDATE ON "managed_conversation_executions"
FOR EACH ROW EXECUTE FUNCTION "emit_native_public_square_execution_invalidation"();
