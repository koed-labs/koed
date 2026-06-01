alter table memory_events
  add column if not exists source_event_time timestamptz,
  add column if not exists source_sequence bigint;

update memory_events me
set
  source_event_time = source_bounds.source_event_time,
  source_sequence = source_bounds.source_sequence
from (
  select
    mes.memory_event_id,
    min(ci.event_time) filter (where ci.event_time is not null) as source_event_time,
    min(
      ci.source_sequence::bigint * 1000000
      + case
        when me_existing.payload #>> '{metadata,sourceChunkIndex}' ~ '^[0-9]+$'
          then (me_existing.payload #>> '{metadata,sourceChunkIndex}')::bigint
        else 0
      end
    ) filter (where ci.source_sequence is not null) as source_sequence
  from memory_event_sources mes
  join memory_events me_existing on me_existing.id = mes.memory_event_id
  join conversation_items ci on ci.id = mes.conversation_item_id
  group by mes.memory_event_id
) source_bounds
where me.id = source_bounds.memory_event_id
  and (me.source_event_time is null or me.source_sequence is null);

create index if not exists memory_events_personal_source_order_idx
  on memory_events(
    owner_user_id,
    coalesce(source_event_time, captured_at) desc,
    source_sequence desc nulls last,
    id desc
  )
  where visibility = 'personal';
