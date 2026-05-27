alter table conversation_items
  add column if not exists logical_source_id text,
  add column if not exists transport_chunk_index integer not null default 0,
  add column if not exists transport_chunk_count integer not null default 1,
  add column if not exists transport_chunk_text text,
  add column if not exists transport_chunk_encoding text;

alter table conversation_items
  drop constraint if exists conversation_items_transport_chunk_index_check;

alter table conversation_items
  add constraint conversation_items_transport_chunk_index_check
  check (transport_chunk_index >= 0);

alter table conversation_items
  drop constraint if exists conversation_items_transport_chunk_count_check;

alter table conversation_items
  add constraint conversation_items_transport_chunk_count_check
  check (
    transport_chunk_count >= 1
    and transport_chunk_index < transport_chunk_count
  );

create index if not exists conversation_items_personal_logical_source_idx
  on conversation_items(owner_user_id, logical_source_id, transport_chunk_index)
  where visibility = 'personal' and logical_source_id is not null;

create index if not exists conversation_items_team_logical_source_idx
  on conversation_items(team_id, logical_source_id, transport_chunk_index)
  where visibility = 'team' and logical_source_id is not null;
