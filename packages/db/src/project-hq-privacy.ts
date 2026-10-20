import type pg from "pg";

/**
 * Sharing and Personal Device Sync must fail closed while a Managed Conversation
 * Captured Session has not yet been bound to its durable execution. The worker
 * may persist the Session before its runtime binding arrives.
 */
export async function capturedSessionMayLeavePersonalBoundary(
  database: pg.Pool | pg.PoolClient,
  ownerUserId: string,
  sessionId: string
): Promise<boolean> {
  const result = await database.query<{ eligible: boolean }>(
    `with local_sources as (
       select id as session_id from sessions
        where id=$1::uuid and owner_user_id=$2
       union
       select local.local_session_id
         from captured_session_logical_memories protocol
         join local_captured_session_logical_memories local
           on local.logical_memory_id=protocol.logical_memory_id
          and local.owner_user_id=$2
         join logical_memories memory
           on memory.id=protocol.logical_memory_id
          and memory.owner_user_id=$2
        where protocol.source_session_id=$1::uuid
     )
     select bool_and(case
       when exists (
         select 1 from managed_conversation_executions execution
         where execution.owner_user_id=s.owner_user_id
           and execution.is_project_hq
           and execution.logical_session_id=s.logical_session_id
       ) then false
       when exists (
         select 1 from managed_conversation_executions execution
         join managed_conversation_runtime_bindings binding
           on binding.execution_id=execution.id
          and binding.owner_user_id=execution.owner_user_id
         where execution.owner_user_id=s.owner_user_id
           and execution.is_project_hq
           and binding.local_session_id=s.id
       ) then false
       when s.metadata->>'managedConversation'='true' then exists (
         select 1 from managed_conversation_executions execution
         where execution.owner_user_id=s.owner_user_id
           and execution.logical_session_id=s.logical_session_id
           and not execution.is_project_hq
       )
       when s.cwd is not null and exists (
         select 1 from managed_conversation_executions execution
         where execution.owner_user_id=s.owner_user_id
           and execution.is_project_hq
           and execution.hq_private_path=s.cwd
       ) then false
       else true end) as eligible
      from sessions s join local_sources on local_sources.session_id=s.id
      where s.owner_user_id=$2`,
    [sessionId, ownerUserId]
  );
  return result.rows[0]?.eligible === true;
}
