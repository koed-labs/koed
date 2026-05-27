update conversation_items
set projection_status = 'raw_only',
    projection_error = null,
    projected_at = coalesce(projected_at, now())
where projection_status in ('pending', 'error')
  and source_transport = 'app_server'
  and metadata ->> 'workflow' in ('lcm_summary', 'memory_question');
