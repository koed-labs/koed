import type pg from "pg";

export const invalidateDerivedMemoryForMemoryEvents = async (
  pool: pg.Pool | pg.PoolClient,
  memoryEventIds: string[],
  reason = "source_event_deleted"
): Promise<void> => {
  const uniqueEventIds = [...new Set(memoryEventIds.filter(Boolean))];
  if (uniqueEventIds.length === 0) return;

  await pool.query(
    `
      update memory_embeddings
      set invalidated_at = now(), invalidation_reason = $2
      where memory_event_id = any($1::uuid[])
        and invalidated_at is null
    `,
    [uniqueEventIds, reason]
  );

  const affectedNodes = await pool.query<{ id: string }>(
    `
      with recursive affected_nodes as (
        select distinct mns.memory_node_id as id
        from memory_node_sources mns
        where mns.memory_event_id = any($1::uuid[])

        union

        select mnc.parent_memory_node_id as id
        from memory_node_children mnc
        join affected_nodes affected
          on affected.id = mnc.child_memory_node_id
      )
      update memory_nodes mn
      set
        invalidated_at = coalesce(mn.invalidated_at, now()),
        invalidation_reason = coalesce(mn.invalidation_reason, $2),
        updated_at = now()
      where mn.id in (select id from affected_nodes)
        and mn.invalidated_at is null
        and mn.personal_deleted_at is null
      returning mn.id
    `,
    [uniqueEventIds, reason]
  );

  const nodeIds = affectedNodes.rows.map((row) => row.id);
  if (nodeIds.length === 0) return;
  await pool.query(
    `
      update memory_embeddings
      set invalidated_at = now(), invalidation_reason = $2
      where memory_node_id = any($1::uuid[])
        and invalidated_at is null
    `,
    [nodeIds, reason]
  );
};
