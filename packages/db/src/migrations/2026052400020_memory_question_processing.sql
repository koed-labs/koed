alter table memory_questions
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_lease_until timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_error_message text;

create index if not exists memory_questions_personal_pending_claim_idx
  on memory_questions(owner_user_id, processing_lease_until, created_at, id)
  where visibility = 'personal' and status = 'pending';

drop trigger if exists memory_questions_graph_update_notify on memory_questions;
create trigger memory_questions_graph_update_notify
after insert or update or delete on memory_questions
for each row execute function notify_koed_graph_update();
