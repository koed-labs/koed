CREATE FUNCTION team_agent_request_native_execution_status_values(
  p_command_state text,
  p_command_generation integer,
  p_command_lease_expires_at timestamptz,
  p_command_result jsonb,
  p_execution_state text,
  p_execution_generation integer,
  p_runner_lease_expires_at timestamptz,
  p_has_pending_runtime_item boolean
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_command_state='indeterminate' THEN 'unknown'
    WHEN p_command_state='completed' THEN CASE
      WHEN p_has_pending_runtime_item THEN 'waiting' ELSE 'succeeded' END
    WHEN p_command_state='failed' THEN 'failed'
    WHEN p_command_state='canceled' THEN 'canceled'
    WHEN p_command_generation<>p_execution_generation THEN 'unknown'
    WHEN p_execution_state='fenced' THEN 'unknown'
    WHEN p_command_state='dispatching' THEN CASE
      WHEN p_command_lease_expires_at IS NULL OR p_command_lease_expires_at<=now()
        OR p_runner_lease_expires_at IS NULL OR p_runner_lease_expires_at<=now()
        THEN 'unknown'
      WHEN p_has_pending_runtime_item THEN 'waiting'
      ELSE 'running' END
    WHEN p_execution_state='failed' THEN 'failed'
    WHEN p_execution_state IN ('stopped','stopping') THEN 'interrupted'
    WHEN p_command_state IN ('queued','blocked') THEN 'queued'
    ELSE 'unknown'
  END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION team_agent_request_native_execution_status(
  p_execution_id uuid,
  p_command_id uuid,
  p_owner_user_id uuid
) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN c.id IS NULL OR e.id IS NULL THEN 'unknown'
    ELSE team_agent_request_native_execution_status_values(
      c.state,c.execution_generation,c.lease_expires_at,c.result,
      e.state,e.execution_generation,e.runner_lease_expires_at,
      EXISTS (
        SELECT 1 FROM managed_conversation_runtime_items ri
         WHERE ri.execution_id=p_execution_id
           AND ri.owner_user_id=p_owner_user_id
           AND ri.execution_generation=c.execution_generation
           AND ri.provider_turn_id=COALESCE(c.result->>'turnId',c.result->>'providerTurnId')
           AND COALESCE(c.result->>'turnId',c.result->>'providerTurnId') IS NOT NULL
           AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
           AND ri.state='pending'
      )
    )
  END
  FROM (SELECT p_execution_id AS id) requested
  LEFT JOIN managed_conversation_commands c
    ON c.id=p_command_id AND c.execution_id=p_execution_id AND c.owner_user_id=p_owner_user_id
  LEFT JOIN managed_conversation_executions e
    ON e.id=p_execution_id AND e.owner_user_id=p_owner_user_id
$$;--> statement-breakpoint

CREATE INDEX team_agent_requests_native_execution_status_idx
  ON team_agent_requests(managed_execution_id,owner_user_id)
  WHERE status='accepted' AND native_status_frozen IS NULL
    AND managed_execution_id IS NOT NULL;--> statement-breakpoint

CREATE FUNCTION publish_team_agent_request_native_status_invalidation(
  p_request_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE request_row record;
DECLARE event_cursor bigint;
BEGIN
  SELECT id,team_id,channel_id,request_message_id
    INTO request_row
    FROM team_agent_requests
   WHERE id=p_request_id AND status='accepted' AND native_status_frozen IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO collaboration_outbox (
    protocol_version,family,scope,personal_owner_user_id,team_id,
    team_workspace_id,thread_id,message_id,share_grant_id,logical_memory_id,
    resource_type,resource_id,actor_principal_id,mutation_id,replay_until
  ) VALUES (
    6,'team_agent_request_changed','team',NULL,request_row.team_id,
    NULL,request_row.channel_id,request_row.request_message_id,NULL,NULL,
    'team_agent_request',request_row.id,NULL,gen_random_uuid(),now()+interval '30 days'
  ) RETURNING cursor INTO event_cursor;
  PERFORM pg_notify('koed_collaboration_realtime',json_build_object(
    'scope','team','personalOwnerUserId',NULL,'teamId',request_row.team_id,
    'cursor',event_cursor,'family','team_agent_request_changed'
  )::text);
END $$;--> statement-breakpoint

CREATE FUNCTION invalidate_team_agent_request_native_status_from_command()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row record;
DECLARE old_has_pending boolean;
DECLARE old_status text;
DECLARE new_status text;
BEGIN
  FOR request_row IN
    SELECT r.id AS request_id,e.state AS execution_state,
           e.execution_generation AS execution_generation,
           e.runner_lease_expires_at AS runner_lease_expires_at
      FROM team_agent_requests r
      JOIN managed_conversation_executions e
        ON e.id=r.managed_execution_id AND e.owner_user_id=r.owner_user_id
     WHERE r.managed_command_id=OLD.id
       AND r.managed_execution_id=OLD.execution_id
       AND r.owner_user_id=OLD.owner_user_id
       AND r.status='accepted' AND r.native_status_frozen IS NULL
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM managed_conversation_runtime_items ri
       WHERE ri.execution_id=OLD.execution_id AND ri.owner_user_id=OLD.owner_user_id
         AND ri.execution_generation=OLD.execution_generation
         AND ri.provider_turn_id=COALESCE(OLD.result->>'turnId',OLD.result->>'providerTurnId')
         AND COALESCE(OLD.result->>'turnId',OLD.result->>'providerTurnId') IS NOT NULL
         AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
         AND ri.state='pending'
    ) INTO old_has_pending;
    old_status := team_agent_request_native_execution_status_values(
      OLD.state,OLD.execution_generation,OLD.lease_expires_at,OLD.result,
      request_row.execution_state,request_row.execution_generation,
      request_row.runner_lease_expires_at,old_has_pending
    );
    new_status := team_agent_request_native_execution_status(
      NEW.execution_id,NEW.id,NEW.owner_user_id
    );
    IF old_status IS DISTINCT FROM new_status
       OR (OLD.state='dispatching' AND NEW.state='indeterminate') THEN
      PERFORM publish_team_agent_request_native_status_invalidation(request_row.request_id);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER team_agent_request_native_command_status_invalidation
AFTER UPDATE OF state,execution_generation,lease_expires_at,result
ON managed_conversation_commands
FOR EACH ROW EXECUTE FUNCTION invalidate_team_agent_request_native_status_from_command();--> statement-breakpoint

CREATE FUNCTION invalidate_team_agent_request_native_status_from_execution()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_row record;
DECLARE has_pending boolean;
DECLARE old_status text;
DECLARE new_status text;
BEGIN
  FOR request_row IN
    SELECT r.id AS request_id,c.id AS command_id,c.state AS command_state,
           c.execution_generation AS command_generation,
           c.lease_expires_at AS command_lease_expires_at,c.result AS command_result
      FROM team_agent_requests r
      JOIN managed_conversation_commands c
        ON c.id=r.managed_command_id AND c.execution_id=r.managed_execution_id
       AND c.owner_user_id=r.owner_user_id
     WHERE r.managed_execution_id=NEW.id AND r.owner_user_id=NEW.owner_user_id
       AND r.status='accepted' AND r.native_status_frozen IS NULL
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM managed_conversation_runtime_items ri
       WHERE ri.execution_id=NEW.id AND ri.owner_user_id=NEW.owner_user_id
         AND ri.execution_generation=request_row.command_generation
         AND ri.provider_turn_id=COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId')
         AND COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId') IS NOT NULL
         AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
         AND ri.state='pending'
    ) INTO has_pending;
    old_status := team_agent_request_native_execution_status_values(
      request_row.command_state,request_row.command_generation,
      request_row.command_lease_expires_at,request_row.command_result,
      OLD.state,OLD.execution_generation,OLD.runner_lease_expires_at,has_pending
    );
    new_status := team_agent_request_native_execution_status_values(
      request_row.command_state,request_row.command_generation,
      request_row.command_lease_expires_at,request_row.command_result,
      NEW.state,NEW.execution_generation,NEW.runner_lease_expires_at,has_pending
    );
    IF old_status IS DISTINCT FROM new_status
       OR (request_row.command_state IN ('queued','blocked','dispatching')
           AND (OLD.state IS DISTINCT FROM NEW.state
                OR OLD.execution_generation IS DISTINCT FROM NEW.execution_generation)) THEN
      PERFORM publish_team_agent_request_native_status_invalidation(request_row.request_id);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER team_agent_request_native_execution_status_invalidation
AFTER UPDATE OF state,execution_generation,runner_lease_expires_at
ON managed_conversation_executions
FOR EACH ROW EXECUTE FUNCTION invalidate_team_agent_request_native_status_from_execution();--> statement-breakpoint

CREATE FUNCTION invalidate_team_agent_request_native_status_for_runtime_change(
  p_execution_id uuid,
  p_owner_user_id uuid,
  p_changed_item_ids uuid[],
  p_before_items jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE request_row record;
DECLARE old_has_pending boolean;
DECLARE new_has_pending boolean;
DECLARE old_status text;
DECLARE new_status text;
BEGIN
  FOR request_row IN
    SELECT r.id AS request_id,c.execution_id,c.owner_user_id,
           c.state AS command_state,c.execution_generation AS command_generation,
           c.lease_expires_at AS command_lease_expires_at,c.result AS command_result,
           e.state AS execution_state,e.execution_generation,e.runner_lease_expires_at
      FROM team_agent_requests r
      JOIN managed_conversation_commands c
        ON c.id=r.managed_command_id AND c.execution_id=r.managed_execution_id
       AND c.owner_user_id=r.owner_user_id
      JOIN managed_conversation_executions e
        ON e.id=r.managed_execution_id AND e.owner_user_id=r.owner_user_id
     WHERE r.managed_execution_id=p_execution_id AND r.owner_user_id=p_owner_user_id
       AND r.status='accepted' AND r.native_status_frozen IS NULL
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM managed_conversation_runtime_items ri
       WHERE NOT (ri.id=ANY(COALESCE(p_changed_item_ids,ARRAY[]::uuid[])))
         AND ri.execution_id=request_row.execution_id
         AND ri.owner_user_id=request_row.owner_user_id
         AND ri.execution_generation=request_row.command_generation
         AND ri.provider_turn_id=COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId')
         AND COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId') IS NOT NULL
         AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
         AND ri.state='pending'
    ) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(COALESCE(p_before_items,'[]'::jsonb)) AS before_row(item)
       WHERE (item->>'execution_id')::uuid=request_row.execution_id
         AND (item->>'owner_user_id')::uuid=request_row.owner_user_id
         AND (item->>'execution_generation')::integer=request_row.command_generation
         AND item->>'provider_turn_id'=COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId')
         AND COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId') IS NOT NULL
         AND item->>'item_kind' IN ('command_approval','file_approval','permissions_approval','user_input')
         AND item->>'state'='pending'
    ) INTO old_has_pending;

    SELECT EXISTS (
      SELECT 1 FROM managed_conversation_runtime_items ri
       WHERE ri.execution_id=request_row.execution_id
         AND ri.owner_user_id=request_row.owner_user_id
         AND ri.execution_generation=request_row.command_generation
         AND ri.provider_turn_id=COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId')
         AND COALESCE(request_row.command_result->>'turnId',request_row.command_result->>'providerTurnId') IS NOT NULL
         AND ri.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
         AND ri.state='pending'
    ) INTO new_has_pending;

    old_status := team_agent_request_native_execution_status_values(
      request_row.command_state,request_row.command_generation,
      request_row.command_lease_expires_at,request_row.command_result,
      request_row.execution_state,request_row.execution_generation,
      request_row.runner_lease_expires_at,old_has_pending
    );
    new_status := team_agent_request_native_execution_status_values(
      request_row.command_state,request_row.command_generation,
      request_row.command_lease_expires_at,request_row.command_result,
      request_row.execution_state,request_row.execution_generation,
      request_row.runner_lease_expires_at,new_has_pending
    );
    IF old_status IS DISTINCT FROM new_status THEN
      PERFORM publish_team_agent_request_native_status_invalidation(request_row.request_id);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

CREATE FUNCTION invalidate_team_agent_request_native_status_from_runtime_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
  FOR changed IN
    SELECT execution_id,owner_user_id,array_agg(id) AS item_ids
      FROM inserted_runtime_items
     WHERE state='pending'
       AND item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
       AND provider_turn_id IS NOT NULL
     GROUP BY execution_id,owner_user_id
  LOOP
    PERFORM invalidate_team_agent_request_native_status_for_runtime_change(
      changed.execution_id,changed.owner_user_id,changed.item_ids,'[]'::jsonb
    );
  END LOOP;
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER team_agent_request_native_runtime_item_insert_invalidation
AFTER INSERT ON managed_conversation_runtime_items
REFERENCING NEW TABLE AS inserted_runtime_items
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_team_agent_request_native_status_from_runtime_insert();--> statement-breakpoint

CREATE FUNCTION invalidate_team_agent_request_native_status_from_runtime_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
  FOR changed IN
    SELECT deleted.execution_id,deleted.owner_user_id,
           array_agg(deleted.id) AS item_ids,
           jsonb_agg(to_jsonb(deleted)) AS before_items
      FROM deleted_runtime_items deleted
     WHERE deleted.state='pending'
       AND deleted.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
       AND deleted.provider_turn_id IS NOT NULL
     GROUP BY deleted.execution_id,deleted.owner_user_id
  LOOP
    PERFORM invalidate_team_agent_request_native_status_for_runtime_change(
      changed.execution_id,changed.owner_user_id,changed.item_ids,changed.before_items
    );
  END LOOP;
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER team_agent_request_native_runtime_item_delete_invalidation
AFTER DELETE ON managed_conversation_runtime_items
REFERENCING OLD TABLE AS deleted_runtime_items
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_team_agent_request_native_status_from_runtime_delete();--> statement-breakpoint

CREATE FUNCTION invalidate_team_agent_request_native_status_from_runtime_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed record;
BEGIN
  FOR changed IN
    SELECT execution_id,owner_user_id,array_agg(DISTINCT item_id) AS item_ids,
           jsonb_agg(before_item) FILTER (WHERE before_item IS NOT NULL) AS before_items
      FROM (
        SELECT old_item.execution_id,old_item.owner_user_id,
               old_item.id AS item_id,to_jsonb(old_item) AS before_item
          FROM old_runtime_items old_item
          JOIN new_runtime_items new_item USING (id)
         WHERE (old_item.state='pending'
                AND old_item.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
                AND old_item.provider_turn_id IS NOT NULL)
            OR (new_item.state='pending'
                AND new_item.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
                AND new_item.provider_turn_id IS NOT NULL)
        UNION ALL
        SELECT new_item.execution_id,new_item.owner_user_id,
               new_item.id AS item_id,NULL::jsonb AS before_item
          FROM new_runtime_items new_item
          JOIN old_runtime_items old_item USING (id)
         WHERE (old_item.state='pending'
                AND old_item.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
                AND old_item.provider_turn_id IS NOT NULL)
            OR (new_item.state='pending'
                AND new_item.item_kind IN ('command_approval','file_approval','permissions_approval','user_input')
                AND new_item.provider_turn_id IS NOT NULL)
      ) changed_items
     GROUP BY execution_id,owner_user_id
  LOOP
    PERFORM invalidate_team_agent_request_native_status_for_runtime_change(
      changed.execution_id,changed.owner_user_id,changed.item_ids,
      COALESCE(changed.before_items,'[]'::jsonb)
    );
  END LOOP;
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER team_agent_request_native_runtime_item_update_invalidation
AFTER UPDATE ON managed_conversation_runtime_items
REFERENCING OLD TABLE AS old_runtime_items NEW TABLE AS new_runtime_items
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_team_agent_request_native_status_from_runtime_update();
