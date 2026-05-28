do $$
begin
  create type memory_question_status as enum ('pending', 'answered', 'error');
exception
  when duplicate_object then null;
end $$;

do $$
begin
  create type memory_search_domain as enum ('global', 'project', 'session');
exception
  when duplicate_object then null;
end $$;

create table if not exists memory_questions (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  visibility visibility_scope not null default 'personal',
  retrieval_scope text not null default 'personal',
  search_domain memory_search_domain not null,
  workspace_id text,
  project_name text,
  project_path text,
  session_id uuid references sessions(id) on delete cascade,
  thread_id text,
  thread_name text,
  query text not null,
  answer_markdown text,
  error_message text,
  evidence jsonb,
  citations jsonb,
  retrieval jsonb,
  local_memory_worker jsonb,
  response jsonb,
  status memory_question_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  answered_at timestamptz,
  check (visibility = 'personal' and owner_user_id is not null),
  check (retrieval_scope in ('personal')),
  check (
    (search_domain = 'global')
    or (search_domain = 'project' and workspace_id is not null)
    or (search_domain = 'session' and session_id is not null)
  ),
  check (
    (status = 'answered' and answer_markdown is not null and error_message is null)
    or (status = 'error' and error_message is not null)
    or status = 'pending'
  )
);

create index if not exists memory_questions_personal_created_idx
  on memory_questions(owner_user_id, created_at desc, id desc)
  where visibility = 'personal';

create index if not exists memory_questions_personal_scope_idx
  on memory_questions(owner_user_id, search_domain, workspace_id, session_id, created_at desc, id desc)
  where visibility = 'personal';
