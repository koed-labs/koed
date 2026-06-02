create table if not exists local_memory_agent_settings (
  owner_user_id uuid not null references users(id) on delete cascade,
  flow_key text not null,
  provider text not null default 'codex',
  model text not null,
  reasoning_effort text not null,
  timeout_ms integer not null,
  max_attempts integer not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  primary key (owner_user_id, flow_key),
  check (flow_key in ('mcp_memory_answer', 'lcm_summary')),
  check (provider = 'codex'),
  check (model <> ''),
  check (reasoning_effort <> ''),
  check (timeout_ms between 1000 and 600000),
  check (max_attempts between 1 and 25)
);

create index if not exists local_memory_agent_settings_owner_idx
  on local_memory_agent_settings(owner_user_id, updated_at desc);
