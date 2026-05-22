create index if not exists memory_events_personal_capture_idx
  on memory_events(owner_user_id, captured_at desc, id desc)
  where visibility = 'personal' and invalidated_at is null;

create index if not exists memory_events_team_capture_idx
  on memory_events(team_id, captured_at desc, id desc)
  where visibility = 'team' and invalidated_at is null;

create index if not exists memory_nodes_personal_updated_idx
  on memory_nodes(owner_user_id, updated_at desc, id desc)
  where visibility = 'personal' and invalidated_at is null;

create index if not exists memory_nodes_team_updated_idx
  on memory_nodes(team_id, updated_at desc, id desc)
  where visibility = 'team' and invalidated_at is null;

create index if not exists memory_node_sources_event_order_idx
  on memory_node_sources(memory_event_id, source_order, memory_node_id)
  where memory_event_id is not null;

create index if not exists memory_events_personal_workspace_expr_idx
  on memory_events(owner_user_id, (payload ->> 'workspaceId'), captured_at desc, id desc)
  where visibility = 'personal' and invalidated_at is null;

create index if not exists memory_events_personal_external_thread_expr_idx
  on memory_events(owner_user_id, (payload #>> '{metadata,externalSessionId}'), captured_at desc, id desc)
  where visibility = 'personal' and invalidated_at is null;

create index if not exists memory_events_team_workspace_expr_idx
  on memory_events(team_id, (payload ->> 'workspaceId'), captured_at desc, id desc)
  where visibility = 'team' and invalidated_at is null;

create index if not exists memory_events_team_external_thread_expr_idx
  on memory_events(team_id, (payload #>> '{metadata,externalSessionId}'), captured_at desc, id desc)
  where visibility = 'team' and invalidated_at is null;
