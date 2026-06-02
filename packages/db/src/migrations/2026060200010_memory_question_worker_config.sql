alter table memory_questions
  add column if not exists local_memory_worker_config jsonb;
