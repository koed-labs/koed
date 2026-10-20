import type pg from "pg";

/**
 * Fence new Team source work locally while ordinary chat removal is pending or
 * complete. This does not govern Personal recall or Personal Device Sync.
 * In-flight publication is serialized by the Team source-admission/freeze
 * protocol before deletion can report completion.
 */
export async function chatAllowsTeamPublication(
  client: pg.PoolClient,
  ownerUserId: string,
  logicalMemoryId: string,
  sourceSessionId: string | null = null
): Promise<boolean> {
  const result = await client.query<{ blocked: boolean }>(
    `select exists (
       select 1 from sessions session
        where session.owner_user_id=$1
          and (session.id=$3::uuid or exists (
            select 1 from local_captured_session_logical_memories local_memory
             where local_memory.owner_user_id=$1
               and local_memory.local_session_id=session.id
               and local_memory.logical_memory_id=$2
          ))
          and (session.trashed_at is not null or session.delete_batch_id is not null)
     ) as blocked`,
    [ownerUserId, logicalMemoryId, sourceSessionId]
  );
  return result.rows[0]?.blocked === false;
}
