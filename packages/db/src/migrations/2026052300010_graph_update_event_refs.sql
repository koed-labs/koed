create or replace function notify_koed_graph_update()
returns trigger
language plpgsql
as $$
declare
  payload jsonb;
  row_id uuid;
  owner_id uuid;
  team_id_value uuid;
  visibility_value text;
  project_id_value text;
  thread_id_value text;
begin
  if tg_table_name = 'memory_node_sources' then
    row_id := case
      when tg_op = 'DELETE' then old.memory_node_id
      else new.memory_node_id
    end;

    select
      mn.owner_user_id,
      mn.team_id,
      mn.visibility::text
    into owner_id, team_id_value, visibility_value
    from memory_nodes mn
    where mn.id = row_id;
  elsif tg_table_name = 'memory_embeddings' then
    row_id := case
      when tg_op = 'DELETE' then old.memory_node_id
      else new.memory_node_id
    end;
    owner_id := case
      when tg_op = 'DELETE' then old.owner_user_id
      else new.owner_user_id
    end;
    team_id_value := case
      when tg_op = 'DELETE' then old.team_id
      else new.team_id
    end;
    visibility_value := case
      when tg_op = 'DELETE' then old.visibility::text
      else new.visibility::text
    end;

    if owner_id is null and team_id_value is null and row_id is not null then
      select
        mn.owner_user_id,
        mn.team_id,
        mn.visibility::text
      into owner_id, team_id_value, visibility_value
      from memory_nodes mn
      where mn.id = row_id;
    end if;
  elsif tg_op = 'DELETE' then
    row_id := old.id;
    owner_id := old.owner_user_id;
    team_id_value := old.team_id;
    visibility_value := old.visibility::text;
    if tg_table_name = 'memory_events' then
      project_id_value := old.payload ->> 'workspaceId';
      thread_id_value := old.payload #>> '{metadata,externalSessionId}';
    end if;
  else
    row_id := new.id;
    owner_id := new.owner_user_id;
    team_id_value := new.team_id;
    visibility_value := new.visibility::text;
    if tg_table_name = 'memory_events' then
      project_id_value := new.payload ->> 'workspaceId';
      thread_id_value := new.payload #>> '{metadata,externalSessionId}';
    end if;
  end if;

  if tg_table_name = 'memory_events' and (project_id_value is null or thread_id_value is null) then
    select
      coalesce(project_id_value, s.workspace_id::text, s.cwd),
      coalesce(thread_id_value, s.external_session_id, s.id::text)
    into project_id_value, thread_id_value
    from sessions s
    where s.id = case when tg_op = 'DELETE' then old.session_id else new.session_id end;
  end if;

  payload := jsonb_build_object(
    'table', tg_table_name,
    'operation', tg_op,
    'id', row_id,
    'ownerUserId', owner_id,
    'teamId', team_id_value,
    'visibility', visibility_value,
    'changedAt', now()
  );

  if tg_table_name = 'memory_events' then
    payload := payload || jsonb_build_object(
      'projectId', project_id_value,
      'threadId', thread_id_value
    );
  end if;

  perform pg_notify('koed_graph_updates', payload::text);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
