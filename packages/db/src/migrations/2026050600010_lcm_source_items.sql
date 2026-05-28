alter table memory_nodes
  add column if not exists source_items_json jsonb not null default '[]'::jsonb,
  add column if not exists source_event_count integer not null default 0,
  add column if not exists source_token_estimate integer,
  add column if not exists summary_token_estimate integer,
  add column if not exists source_span_start timestamptz,
  add column if not exists source_span_end timestamptz;

create table if not exists memory_node_children (
  parent_memory_node_id uuid not null references memory_nodes(id) on delete cascade,
  child_memory_node_id uuid not null references memory_nodes(id) on delete cascade,
  child_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (parent_memory_node_id, child_order),
  unique (parent_memory_node_id, child_memory_node_id)
);

create index if not exists memory_node_children_child_idx
  on memory_node_children(child_memory_node_id, parent_memory_node_id);

create index if not exists memory_nodes_lcm_scope_depth_idx
  on memory_nodes(visibility, owner_user_id, depth, created_at)
  where invalidated_at is null;
