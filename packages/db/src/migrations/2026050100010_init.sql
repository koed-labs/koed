create extension if not exists vector;
create extension if not exists pgcrypto;

do $$
begin
  create type visibility_scope as enum ('personal');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type source_runtime as enum ('codex', 'codex-cli');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type capture_method as enum ('hook', 'mcp', 'web', 'api');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type memory_event_type as enum ('captured', 'invalidated', 'summarized', 'embedded');
exception
  when duplicate_object then null;
end $$;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz
);

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null,
  name text not null,
  root_path text,
  source_runtime source_runtime,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (visibility = 'personal' and owner_user_id is not null)
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete set null,
  visibility visibility_scope not null default 'personal',
  external_session_id text,
  source_runtime source_runtime not null,
  capture_method capture_method not null,
  codex_transcript_path text,
  idempotency_key text,
  source_hash text,
  model text,
  cwd text,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists sessions_idempotency_key_unique
  on sessions(idempotency_key)
  where idempotency_key is not null;

create unique index if not exists sessions_source_hash_unique
  on sessions(source_hash)
  where source_hash is not null;

create table if not exists turns (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  external_turn_id text,
  source_runtime source_runtime not null,
  capture_method capture_method not null,
  codex_transcript_path text,
  idempotency_key text,
  source_hash text,
  captured_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists turns_session_external_turn_unique
  on turns(session_id, external_turn_id)
  where external_turn_id is not null;

create unique index if not exists turns_idempotency_key_unique
  on turns(idempotency_key)
  where idempotency_key is not null;

create unique index if not exists turns_source_hash_unique
  on turns(source_hash)
  where source_hash is not null;

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  turn_id uuid references turns(id) on delete cascade,
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  content text not null,
  content_json jsonb,
  source_runtime source_runtime not null,
  capture_method capture_method not null,
  codex_transcript_path text,
  transcript_item_id text,
  idempotency_key text,
  source_hash text,
  token_count integer,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists messages_transcript_item_unique
  on messages(session_id, transcript_item_id)
  where transcript_item_id is not null;

create unique index if not exists messages_idempotency_key_unique
  on messages(idempotency_key)
  where idempotency_key is not null;

create unique index if not exists messages_source_hash_unique
  on messages(source_hash)
  where source_hash is not null;

create table if not exists tool_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  turn_id uuid references turns(id) on delete cascade,
  message_id uuid references messages(id) on delete set null,
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  tool_name text not null,
  tool_input jsonb,
  tool_response jsonb,
  status text,
  source_runtime source_runtime not null,
  capture_method capture_method not null,
  codex_transcript_path text,
  transcript_item_id text,
  idempotency_key text,
  source_hash text,
  captured_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists tool_events_transcript_item_unique
  on tool_events(session_id, transcript_item_id)
  where transcript_item_id is not null;

create unique index if not exists tool_events_idempotency_key_unique
  on tool_events(idempotency_key)
  where idempotency_key is not null;

create unique index if not exists tool_events_source_hash_unique
  on tool_events(source_hash)
  where source_hash is not null;

create table if not exists memory_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null,
  event_type memory_event_type not null,
  source_runtime source_runtime,
  capture_method capture_method not null,
  codex_transcript_path text,
  session_id uuid references sessions(id) on delete set null,
  turn_id uuid references turns(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  tool_event_id uuid references tool_events(id) on delete set null,
  idempotency_key text,
  source_hash text,
  payload jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists memory_events_idempotency_key_unique
  on memory_events(idempotency_key)
  where idempotency_key is not null;

create unique index if not exists memory_events_source_hash_unique
  on memory_events(source_hash)
  where source_hash is not null;

create table if not exists memory_nodes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  created_by_user_id uuid references users(id) on delete set null,
  visibility visibility_scope not null,
  kind text not null check (kind in ('leaf', 'rollup')),
  depth integer not null default 0 check (depth >= 0),
  title text,
  summary_text text not null,
  body_text text,
  source_runtime source_runtime,
  capture_method capture_method not null,
  codex_transcript_path text,
  idempotency_key text,
  source_hash text,
  summary_model text,
  summary_prompt_version text,
  lcm_algorithm_version text,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists memory_nodes_idempotency_key_unique
  on memory_nodes(idempotency_key)
  where idempotency_key is not null;

create unique index if not exists memory_nodes_source_hash_unique
  on memory_nodes(source_hash)
  where source_hash is not null;

create index if not exists memory_nodes_personal_visible_idx
  on memory_nodes(owner_user_id, created_at desc)
  where visibility = 'personal' and invalidated_at is null;

create table if not exists memory_node_sources (
  memory_node_id uuid not null references memory_nodes(id) on delete cascade,
  memory_event_id uuid references memory_events(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  tool_event_id uuid references tool_events(id) on delete set null,
  source_order integer not null default 0,
  source_hash text,
  created_at timestamptz not null default now(),
  primary key (memory_node_id, source_order),
  check (
    memory_event_id is not null
    or message_id is not null
    or tool_event_id is not null
  )
);

create table if not exists memory_embeddings (
  id uuid primary key default gen_random_uuid(),
  memory_node_id uuid not null references memory_nodes(id) on delete cascade,
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope not null,
  embedding_model text not null,
  embedding_dimensions integer not null check (embedding_dimensions in (1536, 3072)),
  embedding_version text not null,
  source_hash text not null,
  created_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalidation_reason text,
  check (visibility = 'personal' and owner_user_id is not null)
);

create unique index if not exists memory_embeddings_unique_active_source
  on memory_embeddings(memory_node_id, embedding_model, embedding_dimensions, embedding_version, source_hash)
  where invalidated_at is null;

create table if not exists memory_embeddings_1536 (
  memory_embedding_id uuid primary key references memory_embeddings(id) on delete cascade,
  embedding vector(1536) not null
);

create index if not exists memory_embeddings_1536_hnsw_idx
  on memory_embeddings_1536 using hnsw (embedding vector_cosine_ops);

create table if not exists memory_embeddings_3072 (
  memory_embedding_id uuid primary key references memory_embeddings(id) on delete cascade,
  embedding vector(3072) not null
);

create table if not exists api_tokens (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  check (length(token_hash) >= 32)
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  owner_user_id uuid references users(id) on delete cascade,
  visibility visibility_scope,
  action text not null,
  target_table text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_actor_idx on audit_events(actor_user_id, created_at desc);
create index if not exists audit_events_owner_idx on audit_events(owner_user_id, created_at desc);
