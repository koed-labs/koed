CREATE TABLE "conversation_item_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_item_id" uuid,
	"session_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"visibility" "visibility_scope" DEFAULT 'personal' NOT NULL,
	"canonical_item_key" text,
	"observation_key" text NOT NULL,
	"observation_kind" text DEFAULT 'snapshot' NOT NULL,
	"ingestion_status" text DEFAULT 'persisted' NOT NULL,
	"observation_component" text,
	"source_kind" text NOT NULL,
	"source_adapter_version" text NOT NULL,
	"source_transport" text NOT NULL,
	"external_session_id" text,
	"external_thread_id" text,
	"external_turn_id" text,
	"external_item_id" text,
	"canonical_stable_item_id" text,
	"source_record_type" text NOT NULL,
	"source_event_type" text,
	"source_path" text,
	"source_line_number" integer,
	"source_sequence" integer,
	"event_time" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_json" jsonb NOT NULL,
	"raw_text" text,
	"transport_chunk_index" integer,
	"transport_chunk_count" integer,
	"transport_chunk_text" text,
	"transport_chunk_encoding" text,
	"source_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"source_idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_item_observations_personal_owner_check" CHECK ("conversation_item_observations"."visibility" = 'personal' and "conversation_item_observations"."owner_user_id" is not null),
	CONSTRAINT "conversation_item_observations_kind_check" CHECK ("conversation_item_observations"."observation_kind" in (
        'snapshot',
        'lifecycle_started',
        'lifecycle_completed',
        'control',
        'reconciliation'
      )),
	CONSTRAINT "conversation_item_observations_ingestion_status_check" CHECK ("conversation_item_observations"."ingestion_status" in ('persisted', 'identity_unresolved')),
	CONSTRAINT "conversation_item_observations_parent_link_check" CHECK ((
        "conversation_item_observations"."conversation_item_id" is not null
        and "conversation_item_observations"."canonical_item_key" is not null
        and "conversation_item_observations"."ingestion_status" = 'persisted'
      ) or (
        "conversation_item_observations"."conversation_item_id" is null
        and "conversation_item_observations"."canonical_item_key" is null
        and "conversation_item_observations"."ingestion_status" = 'identity_unresolved'
        and "conversation_item_observations"."session_id" is not null
      )),
	CONSTRAINT "conversation_item_observations_source_line_number_check" CHECK ("conversation_item_observations"."source_line_number" is null or "conversation_item_observations"."source_line_number" >= 0),
	CONSTRAINT "conversation_item_observations_source_sequence_check" CHECK ("conversation_item_observations"."source_sequence" is null or "conversation_item_observations"."source_sequence" >= 0),
	CONSTRAINT "conversation_item_observations_transport_chunk_check" CHECK ((
        "conversation_item_observations"."transport_chunk_index" is null
        and "conversation_item_observations"."transport_chunk_count" is null
        and "conversation_item_observations"."transport_chunk_text" is null
        and "conversation_item_observations"."transport_chunk_encoding" is null
      ) or (
        "conversation_item_observations"."transport_chunk_index" is not null
        and "conversation_item_observations"."transport_chunk_count" is not null
		and "conversation_item_observations"."transport_chunk_index" >= 0
		and "conversation_item_observations"."transport_chunk_count" >= 1
		and "conversation_item_observations"."transport_chunk_count" <= 64
		and "conversation_item_observations"."transport_chunk_index" < "conversation_item_observations"."transport_chunk_count"
		and "conversation_item_observations"."transport_chunk_text" is not null
		and "conversation_item_observations"."metadata" ? 'transportChunkGroupId'
		and octet_length("conversation_item_observations"."transport_chunk_text") <= 262144
	))
);
--> statement-breakpoint
CREATE TABLE "projection_policy_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projection_policy_state_singleton_check" CHECK ("projection_policy_state"."id" = 1),
	CONSTRAINT "projection_policy_state_revision_check" CHECK ("projection_policy_state"."revision" >= 1)
);
--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" DROP CONSTRAINT "encrypted_field_backfill_runs_source_table_check";--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" DROP CONSTRAINT "encrypted_field_payloads_source_table_check";--> statement-breakpoint
DROP INDEX "messages_transcript_item_unique";--> statement-breakpoint
DROP INDEX "sessions_idempotency_key_unique";--> statement-breakpoint
DROP INDEX "sessions_source_hash_unique";--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "canonical_stable_item_id" text;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "canonical_item_key" text;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "canonical_source_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "projection_policy_revision" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "recall_eligible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "projection_policy_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "projection_policy_revision" bigint;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "include_in_embedding" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "include_in_lcm" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "projection_policy_key" text;--> statement-breakpoint
ALTER TABLE "memory_events" ADD COLUMN "projection_policy_revision" bigint;--> statement-breakpoint
UPDATE "conversation_items"
SET "canonical_item_key" = coalesce(
	nullif("metadata" ->> 'canonicalConversationItemKey', ''),
	"idempotency_key"
);--> statement-breakpoint
UPDATE "conversation_items"
SET "metadata" = "metadata" || jsonb_build_object(
	'transportChunkGroupId',
	'legacy-' || encode(digest(concat_ws(
		':',
		"owner_user_id"::text,
		"visibility"::text,
		coalesce("session_id"::text, ''),
		coalesce("logical_source_id", ''),
		coalesce(
			"metadata" ->> 'sourceItemHash',
			"metadata" ->> 'canonicalConversationItemKey',
			"idempotency_key"
		),
		"source_adapter_version",
		"source_transport",
		coalesce("source_path", ''),
		coalesce("source_line_number"::text, ''),
		"transport_chunk_count"::text,
		coalesce("transport_chunk_encoding", '')
	), 'sha256'), 'hex')
)
WHERE "transport_chunk_text" IS NOT NULL
	AND NOT ("metadata" ? 'transportChunkGroupId');--> statement-breakpoint
WITH ranked_canonical_items AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "owner_user_id", "visibility", "canonical_item_key"
			ORDER BY
				"transport_chunk_index" ASC NULLS FIRST,
				"observed_at" ASC,
				"id" ASC
		) AS canonical_rank
	FROM "conversation_items"
)
UPDATE "conversation_items" item
SET
	"canonical_item_key" = 'conversation-item:legacy:' || item."id"::text,
	"metadata" = item."metadata" || jsonb_build_object(
		'canonicalConversationItemKey',
		'conversation-item:legacy:' || item."id"::text
	)
FROM ranked_canonical_items ranked
WHERE item."id" = ranked."id"
	AND ranked."canonical_rank" > 1;--> statement-breakpoint
ALTER TABLE "conversation_items" ALTER COLUMN "canonical_item_key" SET NOT NULL;--> statement-breakpoint
UPDATE "conversation_items"
SET "projection_status" = 'pending'
WHERE "projection_status" NOT IN ('pending', 'held', 'projected', 'error', 'raw_only');--> statement-breakpoint
UPDATE "conversation_items"
SET "canonical_source_priority" = CASE
	WHEN "source_adapter_version" = 'codex-transcript-v1'
		OR "source_transport" = 'transcript' THEN 200
	WHEN "source_adapter_version" = 'codex-app-server-conversation-v1'
		AND "source_transport" = 'app_server'
		AND "source_event_type" IN ('item/completed', 'turn/completed') THEN 300
	WHEN "source_adapter_version" = 'codex-app-server-conversation-v1'
		AND "source_transport" = 'app_server' THEN 100
	WHEN "source_transport" = 'hook' THEN 50
	ELSE 100
END;--> statement-breakpoint
UPDATE "memory_events"
SET
	"include_in_embedding" = CASE
		WHEN lower(coalesce("payload" #>> '{metadata,includeInEmbedding}', 'true')) = 'false' THEN false
		ELSE true
	END,
	"include_in_lcm" = CASE
		WHEN lower(coalesce("payload" #>> '{metadata,includeInLcm}', 'true')) = 'false' THEN false
		ELSE true
	END;--> statement-breakpoint
INSERT INTO "projection_policy_state" ("id", "revision") VALUES (1, 1);--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_id_owner_visibility_unique" UNIQUE("id","owner_user_id","visibility");--> statement-breakpoint
ALTER TABLE "conversation_item_observations" ADD CONSTRAINT "conversation_item_observations_conversation_item_id_conversation_items_id_fk" FOREIGN KEY ("conversation_item_id") REFERENCES "public"."conversation_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_item_observations" ADD CONSTRAINT "conversation_item_observations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_item_observations" ADD CONSTRAINT "conversation_item_observations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_item_observations" ADD CONSTRAINT "conversation_item_observations_parent_identity_fk" FOREIGN KEY ("conversation_item_id","owner_user_id","visibility") REFERENCES "public"."conversation_items"("id","owner_user_id","visibility") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_item_observations_personal_key_unique" ON "conversation_item_observations" USING btree ("owner_user_id","observation_key") WHERE "conversation_item_observations"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "conversation_item_observations_item_idx" ON "conversation_item_observations" USING btree ("conversation_item_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "conversation_item_observations_session_idx" ON "conversation_item_observations" USING btree ("session_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "conversation_item_observations_source_idx" ON "conversation_item_observations" USING btree ("owner_user_id","source_transport","external_thread_id","external_turn_id","external_item_id");--> statement-breakpoint
CREATE INDEX "conversation_item_observations_canonical_identity_idx" ON "conversation_item_observations" USING btree ("owner_user_id","external_thread_id","external_turn_id","canonical_stable_item_id") WHERE "conversation_item_observations"."canonical_stable_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_items_personal_canonical_item_key_unique" ON "conversation_items" USING btree ("owner_user_id","canonical_item_key") WHERE "conversation_items"."visibility" = 'personal';--> statement-breakpoint
CREATE INDEX "conversation_items_canonical_provider_identity_idx" ON "conversation_items" USING btree ("owner_user_id","source_kind","external_thread_id","external_turn_id","canonical_stable_item_id") WHERE "conversation_items"."canonical_stable_item_id" is not null;--> statement-breakpoint
CREATE INDEX "memory_events_personal_lcm_dispatch_idx" ON "memory_events" USING btree ("owner_user_id","id") WHERE "memory_events"."visibility" = 'personal' and "memory_events"."include_in_lcm" = true and "memory_events"."invalidated_at" is null and "memory_events"."personal_deleted_at" is null;--> statement-breakpoint
DROP INDEX "local_work_queue_job_key_unique";--> statement-breakpoint
WITH ranked_queue_keys AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "queue_name", "job_key"
		ORDER BY "created_at" DESC, "id" DESC
	) AS duplicate_rank
	FROM "local_work_queue"
	WHERE "job_key" IS NOT NULL
)
UPDATE "local_work_queue" q
SET "job_key" = NULL
FROM ranked_queue_keys ranked
WHERE q."id" = ranked."id"
	AND ranked.duplicate_rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "local_work_queue_job_key_unique" ON "local_work_queue" USING btree ("queue_name","job_key") WHERE "local_work_queue"."job_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_session_transcript_item_unique" ON "messages" USING btree ("session_id","transcript_item_id") WHERE "messages"."transcript_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_idempotency_key_unique" ON "sessions" USING btree ("owner_user_id","visibility","idempotency_key") WHERE "sessions"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_source_hash_unique" ON "sessions" USING btree ("owner_user_id","visibility","source_hash") WHERE "sessions"."source_hash" is not null;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_canonical_source_priority_check" CHECK ("conversation_items"."canonical_source_priority" >= 0);--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_transport_chunk_limits_check" CHECK (
	"conversation_items"."transport_chunk_text" is null or (
		"conversation_items"."transport_chunk_count" <= 64
		and octet_length("conversation_items"."transport_chunk_text") <= 262144
	)
) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_transport_chunk_payload_check" CHECK (
	"conversation_items"."transport_chunk_text" is null or (
		"conversation_items"."logical_source_id" is not null
		and "conversation_items"."metadata" ? 'transportChunkGroupId'
	)
) NOT VALID;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD CONSTRAINT "conversation_items_projection_status_check" CHECK ("conversation_items"."projection_status" in ('pending', 'held', 'projected', 'error', 'raw_only'));--> statement-breakpoint
ALTER TABLE "encrypted_field_backfill_runs" ADD CONSTRAINT "encrypted_field_backfill_runs_source_table_check" CHECK ("encrypted_field_backfill_runs"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      ));--> statement-breakpoint
ALTER TABLE "encrypted_field_payloads" ADD CONSTRAINT "encrypted_field_payloads_source_table_check" CHECK ("encrypted_field_payloads"."source_table" in (
        'conversation_items',
        'conversation_item_observations',
        'memory_embeddings',
        'memory_events',
        'memory_nodes',
        'memory_questions',
        'messages',
        'tool_events'
      ));--> statement-breakpoint
CREATE FUNCTION koed_enforce_conversation_observation_parent_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_key text;
	parent_session_id uuid;
BEGIN
	IF NEW."conversation_item_id" IS NULL THEN
		IF NEW."canonical_item_key" IS NOT NULL OR NEW."ingestion_status" <> 'identity_unresolved' THEN
			RAISE EXCEPTION 'unlinked conversation observation claims canonical identity'
				USING ERRCODE = '23514';
		END IF;
		IF NOT EXISTS (
			SELECT 1 FROM "sessions" s
			WHERE s."id" = NEW."session_id"
				AND s."owner_user_id" = NEW."owner_user_id"
				AND s."visibility" = NEW."visibility"
		) THEN
			RAISE EXCEPTION 'unlinked conversation observation session identity mismatch'
				USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;
	SELECT ci."canonical_item_key", ci."session_id"
	INTO parent_key, parent_session_id
	FROM "conversation_items" ci
	WHERE ci."id" = NEW."conversation_item_id"
		AND ci."owner_user_id" = NEW."owner_user_id"
		AND ci."visibility" = NEW."visibility";
	IF parent_key IS NULL OR parent_key <> NEW."canonical_item_key" THEN
		RAISE EXCEPTION 'conversation observation parent identity mismatch'
			USING ERRCODE = '23514';
	END IF;
	IF NEW."session_id" IS DISTINCT FROM parent_session_id THEN
		RAISE EXCEPTION 'conversation observation session identity mismatch'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER conversation_item_observations_parent_identity_trigger
BEFORE INSERT OR UPDATE ON "conversation_item_observations"
FOR EACH ROW
EXECUTE FUNCTION koed_enforce_conversation_observation_parent_identity();--> statement-breakpoint
CREATE FUNCTION koed_enforce_conversation_observation_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	redaction_source_id text := current_setting('koed.observation_redaction_source_id', true);
	redaction_source_column text := current_setting('koed.observation_redaction_source_column', true);
BEGIN
	IF NEW IS NOT DISTINCT FROM OLD THEN
		RETURN NEW;
	END IF;
	IF redaction_source_id IS DISTINCT FROM OLD."id"::text
		OR redaction_source_column NOT IN ('raw_json', 'raw_text', 'transport_chunk_text', 'source_path', 'metadata') THEN
		RAISE EXCEPTION 'conversation observations are immutable'
			USING ERRCODE = '55000';
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM "encrypted_field_payloads" efp
		WHERE efp."source_table" = 'conversation_item_observations'
			AND efp."source_id" = OLD."id"
			AND efp."source_column" = redaction_source_column
			AND efp."invalidated_at" IS NULL
	) THEN
		RAISE EXCEPTION 'conversation observation redaction requires an active encrypted companion'
			USING ERRCODE = '55000';
	END IF;
	IF redaction_source_column = 'raw_json' THEN
		IF NEW."raw_json" IS NOT DISTINCT FROM OLD."raw_json"
			OR NEW."raw_json" IS DISTINCT FROM jsonb_build_object(
				'contentEncrypted', true,
				'encryptedSourceTable', 'conversation_item_observations',
				'encryptedSourceColumn', 'raw_json'
			)
			OR (to_jsonb(NEW) - 'raw_json') IS DISTINCT FROM (to_jsonb(OLD) - 'raw_json') THEN
			RAISE EXCEPTION 'conversation observation redaction changed an unexpected column'
				USING ERRCODE = '55000';
		END IF;
	ELSIF redaction_source_column = 'raw_text' THEN
		IF NEW."raw_text" IS NOT DISTINCT FROM OLD."raw_text"
			OR NEW."raw_text" IS DISTINCT FROM '[koed encrypted conversation item]'
			OR (to_jsonb(NEW) - 'raw_text') IS DISTINCT FROM (to_jsonb(OLD) - 'raw_text') THEN
			RAISE EXCEPTION 'conversation observation redaction changed an unexpected column'
				USING ERRCODE = '55000';
		END IF;
	ELSIF redaction_source_column = 'transport_chunk_text' THEN
		IF NEW."transport_chunk_text" IS NOT DISTINCT FROM OLD."transport_chunk_text"
			OR NEW."transport_chunk_text" IS DISTINCT FROM '[koed encrypted conversation item]'
			OR (to_jsonb(NEW) - 'transport_chunk_text') IS DISTINCT FROM (to_jsonb(OLD) - 'transport_chunk_text') THEN
			RAISE EXCEPTION 'conversation observation redaction changed an unexpected column'
				USING ERRCODE = '55000';
		END IF;
	ELSIF redaction_source_column = 'source_path' THEN
		IF NEW."source_path" IS NOT DISTINCT FROM OLD."source_path"
			OR NEW."source_path" IS DISTINCT FROM '[koed encrypted conversation item]'
			OR (to_jsonb(NEW) - 'source_path') IS DISTINCT FROM (to_jsonb(OLD) - 'source_path') THEN
			RAISE EXCEPTION 'conversation observation redaction changed an unexpected column'
				USING ERRCODE = '55000';
		END IF;
	ELSE
		IF NEW."metadata" IS NOT DISTINCT FROM OLD."metadata"
			OR NEW."metadata" IS DISTINCT FROM jsonb_build_object(
				'contentEncrypted', true,
				'encryptedSourceTable', 'conversation_item_observations',
				'encryptedSourceColumn', 'metadata'
			)
			OR (to_jsonb(NEW) - 'metadata') IS DISTINCT FROM (to_jsonb(OLD) - 'metadata') THEN
			RAISE EXCEPTION 'conversation observation redaction changed an unexpected column'
				USING ERRCODE = '55000';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER conversation_item_observations_immutable_trigger
BEFORE UPDATE ON "conversation_item_observations"
FOR EACH ROW
EXECUTE FUNCTION koed_enforce_conversation_observation_immutability();--> statement-breakpoint
CREATE FUNCTION koed_enforce_memory_embedding_source_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW."message_id" IS NOT NULL AND EXISTS (
		SELECT 1
		FROM "messages" m
		WHERE m."id" = NEW."message_id"
			AND m."recall_eligible" = false
	) THEN
		RAISE EXCEPTION 'display-only messages cannot be embedded for recall'
			USING ERRCODE = '23514';
	END IF;
	IF NEW."memory_event_id" IS NOT NULL AND EXISTS (
		SELECT 1
		FROM "memory_events" me
		WHERE me."id" = NEW."memory_event_id"
			AND me."include_in_embedding" = false
	) THEN
		RAISE EXCEPTION 'embedding-ineligible Memory Events cannot be embedded'
			USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER memory_embeddings_source_eligibility_trigger
BEFORE INSERT OR UPDATE OF "message_id", "memory_event_id" ON "memory_embeddings"
FOR EACH ROW
EXECUTE FUNCTION koed_enforce_memory_embedding_source_eligibility();--> statement-breakpoint
CREATE FUNCTION koed_bump_projection_policy_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(
		hashtextextended('conversation-projection-policy', 0)
	);
	UPDATE "projection_policy_state"
	SET "revision" = "revision" + 1,
		"updated_at" = now()
	WHERE "id" = 1;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER projection_policy_rules_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON "projection_policy_rules"
FOR EACH STATEMENT
EXECUTE FUNCTION koed_bump_projection_policy_revision();--> statement-breakpoint
INSERT INTO "projection_policy_rules" (
	"transcript_type", "description", "project_to_ui", "create_message",
	"create_tool_event", "create_memory_event", "include_in_embedding",
	"include_in_lcm"
)
VALUES
	('managed_context_user', 'Managed-thread context retained as raw provenance by default.', false, false, false, false, false, false),
	('plan', 'Plan state retained as raw provenance by default.', false, false, false, false, false, false),
	('filechange', 'File-change details retained as raw provenance by default.', false, false, false, false, false, false),
	('websearch', 'Web-search details retained as raw provenance by default.', false, false, false, false, false, false),
	('imageview', 'Image-view details retained as raw provenance by default.', false, false, false, false, false, false),
	('imagegeneration', 'Image-generation details retained as raw provenance by default.', false, false, false, false, false, false),
	('contextcompaction', 'Context-compaction details retained as raw provenance by default.', false, false, false, false, false, false),
	('subagentactivity', 'Subagent lifecycle details retained as raw provenance by default.', false, false, false, false, false, false),
	('turn_aborted', 'Aborted-turn control retained as raw provenance by default.', false, false, false, false, false, false),
	('workflow:lcm_summary', 'LCM Summary Service workflow output retained outside conversation memory.', false, false, false, false, false, false),
	('workflow:memory_question', 'Memory Answer workflow output retained outside conversation memory.', false, false, false, false, false, false)
ON CONFLICT DO NOTHING;
