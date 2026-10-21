-- Lifecycle text actions use exact Team execution receipts in the repository.
-- They must never be mistaken for Personal chat/Project deletion batches.
CREATE OR REPLACE FUNCTION managed_text_action_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.review_kind='native' AND OLD.action_name NOT IN ('koed_project_leave','koed_workspace_leave')
     AND NEW.state IN ('applied','declined') AND NOT (
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
