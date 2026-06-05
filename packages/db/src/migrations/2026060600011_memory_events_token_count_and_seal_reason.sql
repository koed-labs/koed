alter table memory_events
  add column if not exists token_count integer,
  add column if not exists seal_reason text;

