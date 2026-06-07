alter table conversation_items
  add column if not exists memory_excluded_at timestamptz,
  add column if not exists memory_exclusion_reason text,
  add column if not exists memory_excluded_by_user_id uuid references users(id) on delete set null;

create index if not exists conversation_items_memory_exclusion_idx
  on conversation_items(owner_user_id, memory_excluded_at)
  where visibility = 'personal';

create table if not exists semantic_memory_rebuild_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  memory_event_id uuid not null references memory_events(id) on delete cascade,
  status text not null default 'pending',
  scheduled_after timestamptz not null,
  processing_started_at timestamptz,
  processing_lease_until timestamptz,
  attempt_count integer not null default 0,
  last_error_message text,
  replacement_memory_event_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (visibility = 'personal' and owner_user_id is not null),
  check (attempt_count >= 0),
  check (status in ('pending', 'processing', 'completed', 'error'))
);

create unique index if not exists semantic_memory_rebuild_jobs_active_unique
  on semantic_memory_rebuild_jobs(memory_event_id)
  where status in ('pending', 'processing');

create index if not exists semantic_memory_rebuild_jobs_due_idx
  on semantic_memory_rebuild_jobs(status, scheduled_after, id)
  where status in ('pending', 'error');

create index if not exists semantic_memory_rebuild_jobs_actor_due_idx
  on semantic_memory_rebuild_jobs(owner_user_id, status, scheduled_after, id)
  where visibility = 'personal' and status in ('pending', 'error');
