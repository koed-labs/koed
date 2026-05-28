alter table memory_nodes
  add column if not exists summary_corrected_at timestamptz,
  add column if not exists summary_corrected_by_user_id uuid references users(id) on delete set null;

alter table memory_events
  add column if not exists updated_at timestamptz not null default now();

create index if not exists memory_events_personal_graph_idx
  on memory_events(owner_user_id, created_at desc)
  where visibility = 'personal';
