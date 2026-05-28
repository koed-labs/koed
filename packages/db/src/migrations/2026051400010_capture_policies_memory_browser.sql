do $$
begin
  create type capture_policy_target as enum ('global', 'project', 'thread');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type capture_state as enum ('enabled', 'disabled', 'ask');
exception
  when duplicate_object then null;
end $$;

create table if not exists capture_policies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  target_type capture_policy_target not null,
  project_id text,
  project_name text,
  project_path text,
  thread_id text,
  thread_name text,
  capture_state capture_state,
  visibility visibility_scope,
  pause_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (target_type = 'global' and project_id is null and thread_id is null)
    or
    (target_type = 'project' and project_id is not null and thread_id is null)
    or
    (target_type = 'thread' and thread_id is not null)
  )
);

create unique index if not exists capture_policies_unique_target
  on capture_policies(
    owner_user_id,
    target_type,
    coalesce(project_id, ''),
    coalesce(thread_id, '')
  );

create index if not exists capture_policies_owner_updated_idx
  on capture_policies(owner_user_id, updated_at desc);

alter table memory_nodes
  add column if not exists pinned_at timestamptz;

create index if not exists memory_nodes_personal_pinned_idx
  on memory_nodes(owner_user_id, pinned_at desc)
  where visibility = 'personal' and invalidated_at is null and pinned_at is not null;
