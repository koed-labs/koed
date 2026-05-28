create extension if not exists vector;

alter table memory_embeddings
  alter column memory_node_id drop not null;

alter table memory_embeddings
  add column if not exists memory_event_id uuid references memory_events(id) on delete cascade,
  add column if not exists message_id uuid references messages(id) on delete cascade;

alter table memory_embeddings
  drop constraint if exists memory_embeddings_embedding_dimensions_check;

alter table memory_embeddings
  add constraint memory_embeddings_embedding_dimensions_check
  check (embedding_dimensions in (384, 1536, 3072));

alter table memory_embeddings
  drop constraint if exists memory_embeddings_one_source_check;

alter table memory_embeddings
  add constraint memory_embeddings_one_source_check
  check (num_nonnulls(memory_node_id, memory_event_id, message_id) = 1);

create table if not exists memory_embeddings_384 (
  memory_embedding_id uuid primary key references memory_embeddings(id) on delete cascade,
  embedding vector(384) not null
);

create index if not exists memory_embeddings_384_hnsw_idx
  on memory_embeddings_384 using hnsw (embedding vector_cosine_ops);

create unique index if not exists memory_embeddings_unique_active_node_source
  on memory_embeddings(memory_node_id, embedding_model, embedding_dimensions, embedding_version, source_hash)
  where invalidated_at is null and memory_node_id is not null;

create unique index if not exists memory_embeddings_unique_active_event_source
  on memory_embeddings(memory_event_id, embedding_model, embedding_dimensions, embedding_version, source_hash)
  where invalidated_at is null and memory_event_id is not null;

create unique index if not exists memory_embeddings_unique_active_message_source
  on memory_embeddings(message_id, embedding_model, embedding_dimensions, embedding_version, source_hash)
  where invalidated_at is null and message_id is not null;

create index if not exists memory_embeddings_personal_visible_idx
  on memory_embeddings(owner_user_id, embedding_dimensions, created_at desc)
  where visibility = 'personal' and invalidated_at is null;
