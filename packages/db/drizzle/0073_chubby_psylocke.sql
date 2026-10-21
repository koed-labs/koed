CREATE TABLE "managed_conversation_text_action_create_effects" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_action_dispatch_authorities" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"work_item_version" integer NOT NULL,
	"team_backend_id" text,
	"workspace_project_id" uuid,
	"team_project_version" integer,
	"team_member_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_text_action_dispatch_authorities_version_check" CHECK ("managed_conversation_text_action_dispatch_authorities"."work_item_version">0 and (("managed_conversation_text_action_dispatch_authorities"."team_backend_id" is null and "managed_conversation_text_action_dispatch_authorities"."workspace_project_id" is null and "managed_conversation_text_action_dispatch_authorities"."team_project_version" is null and "managed_conversation_text_action_dispatch_authorities"."team_member_version" is null) or ("managed_conversation_text_action_dispatch_authorities"."team_backend_id" is not null and "managed_conversation_text_action_dispatch_authorities"."workspace_project_id" is not null and "managed_conversation_text_action_dispatch_authorities"."team_project_version">0 and "managed_conversation_text_action_dispatch_authorities"."team_member_version">0)))
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_action_dispatch_effects" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"work_item_version" integer NOT NULL,
	"execution_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_text_action_dispatch_effects_version_check" CHECK ("managed_conversation_text_action_dispatch_effects"."work_item_version">0)
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_action_move_authorities" (
	"action_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_project_id" uuid,
	"target_project_id" uuid,
	"expected_assignment_version" integer NOT NULL,
	"target_project_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_text_action_move_authorities_pk" PRIMARY KEY("action_id","session_id"),
	CONSTRAINT "managed_text_action_move_authorities_version_check" CHECK ("managed_conversation_text_action_move_authorities"."expected_assignment_version">0 and ("managed_conversation_text_action_move_authorities"."target_project_version" is null or "managed_conversation_text_action_move_authorities"."target_project_version">0))
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_action_move_effects" (
	"action_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"source_project_id" uuid,
	"target_project_id" uuid,
	"assignment_version" integer NOT NULL,
	"move_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_text_action_move_effects_pk" PRIMARY KEY("action_id","session_id"),
	CONSTRAINT "managed_text_action_move_effects_version_check" CHECK ("managed_conversation_text_action_move_effects"."assignment_version">0)
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_action_team_nonces" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"encrypted_nonce" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"logical_session_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"provider_turn_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"action_name" text NOT NULL,
	"native_target_id" uuid,
	"native_execution_set_hash" text,
	"arguments_digest" text NOT NULL,
	"encrypted_arguments" jsonb NOT NULL,
	"encrypted_snapshot" jsonb NOT NULL,
	"state" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"review_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "managed_text_actions_owner_id_unique" UNIQUE("owner_user_id","id"),
	CONSTRAINT "managed_text_actions_tool_call_unique" UNIQUE("owner_user_id","execution_id","command_id","provider_turn_id","tool_call_id"),
	CONSTRAINT "managed_text_actions_shape_check" CHECK ("managed_conversation_text_actions"."execution_generation">0 and "managed_conversation_text_actions"."revision">0 and "managed_conversation_text_actions"."arguments_digest" ~ '^[0-9a-f]{64}$' and length("managed_conversation_text_actions"."provider_turn_id") between 1 and 512 and length("managed_conversation_text_actions"."tool_call_id") between 1 and 512 and "managed_conversation_text_actions"."state" in ('unavailable','awaiting_review','ready','claimed','applied','declined') and "managed_conversation_text_actions"."review_kind" in ('none','ask_first','native') and (("managed_conversation_text_actions"."review_kind"='native' and "managed_conversation_text_actions"."native_target_id" is not null) or ("managed_conversation_text_actions"."review_kind"<>'native' and "managed_conversation_text_actions"."native_target_id" is null and "managed_conversation_text_actions"."native_execution_set_hash" is null)) and ("managed_conversation_text_actions"."native_execution_set_hash" is null or "managed_conversation_text_actions"."native_execution_set_hash" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "managed_conversation_text_human_origins" (
	"owner_user_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"execution_generation" integer NOT NULL,
	"request_digest" text NOT NULL,
	"source_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_text_human_origins_pk" PRIMARY KEY("owner_user_id","command_id"),
	CONSTRAINT "managed_text_human_origins_shape_check" CHECK ("managed_conversation_text_human_origins"."execution_generation">0 and "managed_conversation_text_human_origins"."request_digest" ~ '^[0-9a-f]{64}$' and "managed_conversation_text_human_origins"."source_kind" in ('hq_first_message','human_prompt'))
);
--> statement-breakpoint
CREATE TABLE "workspace_project_text_action_create_effects" (
	"workspace_project_id" uuid NOT NULL,
	"source_owner_team_member_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"effect_nonce_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_project_text_action_create_effects_pk" PRIMARY KEY("workspace_project_id","source_owner_team_member_id","action_id"),
	CONSTRAINT "workspace_project_text_action_nonce_unique" UNIQUE("source_owner_team_member_id","effect_nonce_hash"),
	CONSTRAINT "workspace_project_text_action_item_unique" UNIQUE("work_item_id"),
	CONSTRAINT "workspace_project_text_action_create_effects_hash_check" CHECK ("workspace_project_text_action_create_effects"."effect_nonce_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "chat_move_operations" ADD COLUMN "text_action_id" uuid;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_create_effects" ADD CONSTRAINT "managed_text_action_create_effects_action_fk" FOREIGN KEY ("owner_user_id","action_id") REFERENCES "public"."managed_conversation_text_actions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_dispatch_authorities" ADD CONSTRAINT "managed_text_action_dispatch_authorities_action_fk" FOREIGN KEY ("owner_user_id","action_id") REFERENCES "public"."managed_conversation_text_actions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_dispatch_effects" ADD CONSTRAINT "managed_text_action_dispatch_effects_action_fk" FOREIGN KEY ("owner_user_id","action_id") REFERENCES "public"."managed_conversation_text_actions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_dispatch_effects" ADD CONSTRAINT "managed_text_action_dispatch_effects_command_fk" FOREIGN KEY ("owner_user_id","execution_id","command_id") REFERENCES "public"."managed_conversation_commands"("owner_user_id","execution_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_move_authorities" ADD CONSTRAINT "managed_text_action_move_authorities_action_fk" FOREIGN KEY ("owner_user_id","action_id") REFERENCES "public"."managed_conversation_text_actions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_move_authorities" ADD CONSTRAINT "managed_text_action_move_authorities_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_move_effects" ADD CONSTRAINT "managed_text_action_move_effects_action_fk" FOREIGN KEY ("owner_user_id","action_id") REFERENCES "public"."managed_conversation_text_actions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_move_effects" ADD CONSTRAINT "managed_text_action_move_effects_session_fk" FOREIGN KEY ("session_id","owner_user_id") REFERENCES "public"."sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_move_effects" ADD CONSTRAINT "managed_text_action_move_effects_batch_fk" FOREIGN KEY ("move_batch_id") REFERENCES "public"."chat_move_operations"("batch_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_action_team_nonces" ADD CONSTRAINT "managed_text_action_team_nonce_action_fk" FOREIGN KEY ("owner_user_id","action_id") REFERENCES "public"."managed_conversation_text_actions"("owner_user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_actions" ADD CONSTRAINT "managed_text_actions_command_fk" FOREIGN KEY ("owner_user_id","execution_id","command_id") REFERENCES "public"."managed_conversation_commands"("owner_user_id","execution_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_actions" ADD CONSTRAINT "managed_text_actions_session_fk" FOREIGN KEY ("owner_user_id","logical_session_id") REFERENCES "public"."sessions"("owner_user_id","logical_session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_conversation_text_human_origins" ADD CONSTRAINT "managed_text_human_origins_command_fk" FOREIGN KEY ("owner_user_id","execution_id","command_id") REFERENCES "public"."managed_conversation_commands"("owner_user_id","execution_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_project_text_action_create_effects" ADD CONSTRAINT "workspace_project_text_action_create_effects_item_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."workspace_project_work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_text_actions_owner_state_idx" ON "managed_conversation_text_actions" USING btree ("owner_user_id","execution_id","state");--> statement-breakpoint
ALTER TABLE "chat_move_operations" ADD CONSTRAINT "chat_move_operations_text_action_session_unique" UNIQUE("owner_user_id","text_action_id","session_id");
--> statement-breakpoint
CREATE FUNCTION managed_text_human_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command_row managed_conversation_commands%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM managed_conversation_commands WHERE id=OLD.command_id AND owner_user_id=OLD.owner_user_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Human origin receipt is immutable';
  END IF;
  SELECT * INTO command_row FROM managed_conversation_commands WHERE id=NEW.command_id AND owner_user_id=NEW.owner_user_id AND execution_id=NEW.execution_id;
  IF NOT FOUND OR command_row.execution_generation<>NEW.execution_generation OR command_row.request_digest<>NEW.request_digest
     OR NOT ((command_row.command_kind='start' AND NEW.source_kind='hq_first_message')
       OR (command_row.command_kind='prompt' AND NEW.source_kind='human_prompt' AND command_row.client_user_message_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Human origin must match an exact User command';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER managed_text_human_origin_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON managed_conversation_text_human_origins FOR EACH ROW EXECUTE FUNCTION managed_text_human_origin_guard();
--> statement-breakpoint
CREATE FUNCTION managed_text_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM managed_conversation_commands WHERE id=OLD.command_id AND owner_user_id=OLD.owner_user_id)
       OR NOT EXISTS (SELECT 1 FROM sessions WHERE owner_user_id=OLD.owner_user_id AND logical_session_id=OLD.logical_session_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Text action cannot be deleted directly';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM managed_conversation_text_human_origins origin WHERE origin.owner_user_id=NEW.owner_user_id AND origin.command_id=NEW.command_id AND origin.execution_id=NEW.execution_id AND origin.execution_generation=NEW.execution_generation)
       OR NOT EXISTS (SELECT 1 FROM managed_conversation_commands command WHERE command.id=NEW.command_id AND command.owner_user_id=NEW.owner_user_id AND command.execution_id=NEW.execution_id AND command.execution_generation=NEW.execution_generation AND command.command_kind IN ('start','prompt')) THEN
      RAISE EXCEPTION 'Text action requires exact human origin';
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW)-ARRAY['state','revision','decided_at','updated_at'] <> to_jsonb(OLD)-ARRAY['state','revision','decided_at','updated_at'] THEN
    RAISE EXCEPTION 'Text action authority is immutable';
  END IF;
  IF OLD.state IN ('applied','declined') OR NEW.revision<>OLD.revision+1 OR
     NOT ((OLD.state='awaiting_review' AND (NEW.state IN ('ready','declined','claimed') OR
          (NEW.state='applied' AND OLD.review_kind='native' AND
            (EXISTS (SELECT 1 FROM chat_delete_operations operation WHERE operation.batch_id=OLD.id AND operation.owner_user_id=OLD.owner_user_id AND operation.session_id=OLD.native_target_id AND operation.state IN ('complete','restored'))
             OR EXISTS (SELECT 1 FROM project_delete_operations operation WHERE operation.batch_id=OLD.id AND operation.owner_user_id=OLD.owner_user_id AND operation.project_id=OLD.native_target_id AND operation.execution_set_hash=OLD.native_execution_set_hash AND operation.state IN ('complete','restored'))))))
       OR (OLD.state='ready' AND NEW.state='claimed')
       OR (OLD.state='claimed' AND NEW.state IN ('applied','declined'))) THEN
    RAISE EXCEPTION 'Text action state transition is invalid';
  END IF;
  IF OLD.review_kind='native' AND NEW.state IN ('applied','declined') AND NOT (
    EXISTS (SELECT 1 FROM chat_delete_operations operation WHERE operation.batch_id=OLD.id
      AND operation.owner_user_id=OLD.owner_user_id AND operation.session_id=OLD.native_target_id
      AND operation.state=ANY(CASE WHEN NEW.state='applied' THEN ARRAY['complete','restored'] ELSE ARRAY['cancelled'] END))
    OR EXISTS (SELECT 1 FROM project_delete_operations operation WHERE operation.batch_id=OLD.id
      AND operation.owner_user_id=OLD.owner_user_id AND operation.project_id=OLD.native_target_id
      AND operation.execution_set_hash=OLD.native_execution_set_hash
      AND operation.state=ANY(CASE WHEN NEW.state='applied' THEN ARRAY['complete','restored'] ELSE ARRAY['cancelled'] END))
  ) THEN RAISE EXCEPTION 'Native text action requires exact terminal batch'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER managed_text_action_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON managed_conversation_text_actions FOR EACH ROW EXECUTE FUNCTION managed_text_action_guard();
--> statement-breakpoint
CREATE FUNCTION managed_text_action_child_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Text action receipt is immutable'; END IF;
  IF TG_TABLE_NAME='workspace_project_text_action_create_effects' THEN
    IF EXISTS (SELECT 1 FROM workspace_project_work_items WHERE id=OLD.work_item_id) THEN RAISE EXCEPTION 'Team text effect cannot be deleted directly'; END IF;
  ELSE
    IF TG_TABLE_NAME IN ('managed_conversation_text_action_move_authorities','managed_conversation_text_action_move_effects') THEN
      IF NOT EXISTS (SELECT 1 FROM sessions WHERE id=OLD.session_id AND owner_user_id=OLD.owner_user_id) THEN RETURN OLD; END IF;
    END IF;
    IF TG_TABLE_NAME='managed_conversation_text_action_move_effects' THEN
      IF OLD.move_batch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chat_move_operations WHERE batch_id=OLD.move_batch_id) THEN RETURN OLD; END IF;
    END IF;
    IF TG_TABLE_NAME='managed_conversation_text_action_dispatch_effects' THEN
      IF NOT EXISTS (SELECT 1 FROM managed_conversation_commands WHERE owner_user_id=OLD.owner_user_id AND execution_id=OLD.execution_id AND id=OLD.command_id) THEN RETURN OLD; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM managed_conversation_text_actions WHERE id=OLD.action_id AND owner_user_id=OLD.owner_user_id) THEN
    RAISE EXCEPTION 'Text action receipt cannot be deleted directly';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER managed_text_action_team_nonces_immutable BEFORE UPDATE OR DELETE ON managed_conversation_text_action_team_nonces FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE TRIGGER managed_text_action_move_authorities_immutable BEFORE UPDATE OR DELETE ON managed_conversation_text_action_move_authorities FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE TRIGGER managed_text_action_dispatch_authorities_immutable BEFORE UPDATE OR DELETE ON managed_conversation_text_action_dispatch_authorities FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE TRIGGER managed_text_action_create_effects_immutable BEFORE UPDATE OR DELETE ON managed_conversation_text_action_create_effects FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE TRIGGER managed_text_action_dispatch_effects_immutable BEFORE UPDATE OR DELETE ON managed_conversation_text_action_dispatch_effects FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE TRIGGER managed_text_action_move_effects_immutable BEFORE UPDATE OR DELETE ON managed_conversation_text_action_move_effects FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE TRIGGER workspace_project_text_action_create_effects_immutable BEFORE UPDATE OR DELETE ON workspace_project_text_action_create_effects FOR EACH ROW EXECUTE FUNCTION managed_text_action_child_immutable();
--> statement-breakpoint
CREATE FUNCTION managed_text_native_terminal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_state text;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN RETURN NEW; END IF;
  next_state := CASE WHEN NEW.state IN ('complete','restored') THEN 'applied' WHEN NEW.state='cancelled' THEN 'declined' ELSE NULL END;
  IF next_state IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='chat_delete_operations' THEN
    UPDATE managed_conversation_text_actions action SET state=next_state,revision=revision+1,updated_at=now(),decided_at=CASE WHEN next_state='declined' THEN now() ELSE decided_at END
      WHERE action.id=NEW.batch_id AND action.owner_user_id=NEW.owner_user_id AND action.action_name='koed_chat_delete' AND action.review_kind='native' AND action.native_target_id=NEW.session_id AND action.state IN ('awaiting_review','claimed');
  ELSE
    UPDATE managed_conversation_text_actions action SET state=next_state,revision=revision+1,updated_at=now(),decided_at=CASE WHEN next_state='declined' THEN now() ELSE decided_at END
      WHERE action.id=NEW.batch_id AND action.owner_user_id=NEW.owner_user_id AND action.action_name='koed_project_delete' AND action.review_kind='native' AND action.native_target_id=NEW.project_id AND action.native_execution_set_hash=NEW.execution_set_hash AND action.state IN ('awaiting_review','claimed');
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER managed_text_chat_native_terminal AFTER UPDATE OF state ON chat_delete_operations FOR EACH ROW EXECUTE FUNCTION managed_text_native_terminal_receipt();
--> statement-breakpoint
CREATE TRIGGER managed_text_project_native_terminal AFTER UPDATE OF state ON project_delete_operations FOR EACH ROW EXECUTE FUNCTION managed_text_native_terminal_receipt();
