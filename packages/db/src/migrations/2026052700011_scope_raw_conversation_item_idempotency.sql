drop index if exists conversation_items_idempotency_key_unique;

create unique index if not exists conversation_items_personal_idempotency_key_unique
  on conversation_items(owner_user_id, idempotency_key)
  where visibility = 'personal';
