alter table sessions
  add column if not exists source_kind text,
  add column if not exists source_adapter_version text,
  add column if not exists external_thread_id text,
  add column if not exists forked_from_external_thread_id text,
  add column if not exists parent_session_id uuid references sessions(id) on delete set null,
  add column if not exists parent_external_thread_id text,
  add column if not exists agent_nickname text,
  add column if not exists agent_role text,
  add column if not exists agent_path text,
  add column if not exists thread_source text,
  add column if not exists source_metadata jsonb not null default '{}'::jsonb;

alter table turns
  add column if not exists turn_index integer,
  add column if not exists source_kind text,
  add column if not exists source_adapter_version text,
  add column if not exists external_thread_id text,
  add column if not exists source_metadata jsonb not null default '{}'::jsonb;

create unique index if not exists turns_session_turn_index_unique
  on turns(session_id, turn_index)
  where turn_index is not null;

create table if not exists conversation_items (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  session_id uuid references sessions(id) on delete set null,
  turn_id uuid references turns(id) on delete set null,
  source_kind text not null,
  source_adapter_version text not null,
  source_transport text not null,
  external_session_id text,
  external_thread_id text,
  external_turn_id text,
  external_item_id text,
  parent_external_item_id text,
  source_record_type text not null,
  source_event_type text,
  source_path text,
  source_line_number integer,
  source_sequence integer,
  event_time timestamptz,
  observed_at timestamptz not null default now(),
  raw_json jsonb not null,
  raw_text text,
  source_hash text not null,
  idempotency_key text not null,
  projection_status text not null default 'pending',
  projection_version text,
  projected_at timestamptz,
  projection_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (visibility = 'personal' and owner_user_id is not null),
  check (source_line_number is null or source_line_number >= 0),
  check (source_sequence is null or source_sequence >= 0)
);

create unique index if not exists conversation_items_personal_idempotency_key_unique
  on conversation_items(owner_user_id, idempotency_key)
  where visibility = 'personal';

create index if not exists conversation_items_session_observed_idx
  on conversation_items(session_id, observed_at, id);

create index if not exists conversation_items_session_turn_observed_idx
  on conversation_items(session_id, turn_id, observed_at, id);

create index if not exists conversation_items_source_thread_idx
  on conversation_items(source_kind, external_session_id, external_turn_id);

create index if not exists conversation_items_source_item_idx
  on conversation_items(source_kind, external_item_id)
  where external_item_id is not null;

create index if not exists conversation_items_projection_idx
  on conversation_items(projection_status, projected_at, observed_at, id);

create table if not exists memory_event_sources (
  memory_event_id uuid not null references memory_events(id) on delete cascade,
  conversation_item_id uuid not null references conversation_items(id) on delete cascade,
  source_order integer not null default 0,
  source_role text,
  created_at timestamptz not null default now(),
  primary key (memory_event_id, conversation_item_id, source_order)
);

create index if not exists memory_event_sources_conversation_item_idx
  on memory_event_sources(conversation_item_id);

create index if not exists memory_event_sources_memory_event_order_idx
  on memory_event_sources(memory_event_id, source_order);
