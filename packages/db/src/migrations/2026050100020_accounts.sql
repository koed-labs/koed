alter table users
  add column if not exists password_hash text;

create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (length(session_hash) >= 32)
);

create index if not exists user_sessions_active_user_idx
  on user_sessions(user_id, expires_at desc)
  where revoked_at is null;
