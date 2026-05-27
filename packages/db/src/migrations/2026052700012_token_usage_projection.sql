create table if not exists workflow_token_usage (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references users(id) on delete cascade,
  team_id uuid references teams(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  workflow_type text not null,
  workflow_id text,
  session_id uuid references sessions(id) on delete set null,
  turn_id uuid references turns(id) on delete set null,
  conversation_item_id uuid references conversation_items(id) on delete set null,
  source_runtime source_runtime,
  source_kind text,
  source_adapter_version text,
  model text,
  model_context_window integer,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  reasoning_output_tokens integer,
  total_tokens integer,
  usage_scope text not null default 'last',
  metadata jsonb not null default '{}'::jsonb,
  idempotency_key text,
  source_hash text,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (
    (visibility = 'personal' and owner_user_id is not null and team_id is null)
    or
    (visibility = 'team' and team_id is not null)
  )
);

create unique index if not exists workflow_token_usage_personal_idempotency_key_unique
  on workflow_token_usage(owner_user_id, idempotency_key)
  where visibility = 'personal' and idempotency_key is not null;

create unique index if not exists workflow_token_usage_team_idempotency_key_unique
  on workflow_token_usage(team_id, idempotency_key)
  where visibility = 'team' and idempotency_key is not null;

create index if not exists workflow_token_usage_workflow_idx
  on workflow_token_usage(workflow_type, workflow_id, observed_at);

create index if not exists workflow_token_usage_conversation_item_idx
  on workflow_token_usage(conversation_item_id)
  where conversation_item_id is not null;

create index if not exists workflow_token_usage_session_turn_idx
  on workflow_token_usage(session_id, turn_id, observed_at);
