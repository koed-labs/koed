import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import {
  activeCuratedMemoryEvidencePredicate,
  suppressCuratedMemoryWithoutActiveEvidenceWithClient
} from "./curated-memory-policy.js";
import {
  decryptCuratedMemoryPayload,
  persistCuratedMemoryPayload,
  protectedCuratedMemoryPayloadsRequired
} from "./curated-memory-support.js";
import { lockProjectBeforeSession } from "./chat-delete-repository.js";

type AssertionSnapshot = {
  id: string;
  suppressedAt: string;
  updatedAt: string;
  suppressionReason: string | null;
};
type ForgetRow = {
  batch_id: string;
  state: "stopping" | "complete" | "undone";
  forgotten_at: Date | null;
  execution_manifest: Array<{ id: string; executionGeneration: number }>;
  runtime_acks: Array<{
    executionId: string;
    executionGeneration: number;
    state: string;
    stateVersion: number;
  }>;
  event_ids: string[];
  item_ids: string[];
  node_ids: string[];
  assertion_snapshots: AssertionSnapshot[];
  undone_at: Date | null;
};
export class ChatForgetConflictError extends Error {}
export class ChatForgetNotFoundError extends Error {}

const inTransaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** Forget affects Personal recall only; prior Team publication keeps its own lifecycle. */
export const createChatForgetRepository = (
  pool: pg.Pool,
  options: {
    envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  } = {}
) => ({
  async beginForgetChat(
    ownerUserId: string,
    sessionId: string,
    batchId: string = randomUUID()
  ) {
    return inTransaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.personal_deleted_at)
        throw new ChatForgetConflictError("Conversation is already forgotten");
      if (session.delete_batch_id) {
        const deletion = await client.query<{ state: string }>(
          `select state from chat_delete_operations
            where batch_id=$1 and owner_user_id=$2 and session_id=$3 for update`,
          [session.delete_batch_id, ownerUserId, sessionId]
        );
        if (deletion.rows[0]?.state !== "complete")
          throw new ChatForgetConflictError(
            "Conversation deletion is still pending"
          );
      }
      if (session.forget_batch_id) {
        const existing = await client.query<ForgetRow>(
          `select * from chat_forget_operations where batch_id=$1 and owner_user_id=$2 and session_id=$3 for update`,
          [session.forget_batch_id, ownerUserId, sessionId]
        );
        if (existing.rows[0]?.batch_id === batchId) return existing.rows[0];
        throw new ChatForgetConflictError(
          "Conversation Forget is already pending"
        );
      }
      const executions = await client.query<{
        id: string;
        execution_generation: number;
      }>(
        `select id,execution_generation from managed_conversation_executions
          where owner_user_id=$1 and logical_session_id=$2
            and state not in ('stopped','failed','fenced') order by id`,
        [ownerUserId, session.logical_session_id]
      );
      const manifest = executions.rows.map((row) => ({
        id: row.id,
        executionGeneration: row.execution_generation
      }));
      const inserted = await client.query<ForgetRow>(
        `insert into chat_forget_operations(batch_id,session_id,owner_user_id,execution_manifest)
          values($1,$2,$3,$4::jsonb) returning *`,
        [batchId, sessionId, ownerUserId, JSON.stringify(manifest)]
      );
      await client.query(
        `update sessions set forget_batch_id=$3,updated_at=now()
        where owner_user_id=$1 and id=$2 and forget_batch_id is null`,
        [ownerUserId, sessionId, batchId]
      );
      return inserted.rows[0]!;
    });
  },
  async getForgetChatOperation(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    const result = await pool.query<ForgetRow>(
      `select * from chat_forget_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
      [ownerUserId, sessionId, batchId]
    );
    return result.rows[0] ?? null;
  },
  async listPendingForgetChats(ownerUserId: string) {
    const result = await pool.query<ForgetRow & { session_id: string }>(
      `select operation.* from chat_forget_operations operation join sessions session
        on session.id=operation.session_id and session.owner_user_id=operation.owner_user_id
        where operation.owner_user_id=$1 and operation.state='stopping'
          and session.forget_batch_id=operation.batch_id
        order by operation.created_at desc limit 200`,
      [ownerUserId]
    );
    return result.rows;
  },
  async recordForgetRuntimeAck(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    ack: {
      executionId: string;
      executionGeneration: number;
      state: "stopped" | "failed" | "fenced";
      stateVersion: number;
    }
  ) {
    return inTransaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.forget_batch_id !== batchId)
        throw new ChatForgetConflictError("Forget reservation changed");
      const selected = await client.query<ForgetRow>(
        `select * from chat_forget_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
        [ownerUserId, sessionId, batchId]
      );
      const operation = selected.rows[0];
      if (
        !operation ||
        operation.state !== "stopping" ||
        !operation.execution_manifest.some(
          (item) =>
            item.id === ack.executionId &&
            item.executionGeneration === ack.executionGeneration
        )
      )
        throw new ChatForgetConflictError("Forget execution manifest changed");
      const current = await client.query<{
        state: string;
        state_version: number;
        execution_generation: number;
      }>(
        `select state,state_version,execution_generation from managed_conversation_executions
          where owner_user_id=$1 and id=$2`,
        [ownerUserId, ack.executionId]
      );
      if (
        !current.rows[0] ||
        current.rows[0].state !== ack.state ||
        current.rows[0].state_version !== ack.stateVersion ||
        current.rows[0].execution_generation !== ack.executionGeneration
      )
        throw new ChatForgetConflictError("Forget execution stop changed");
      const acks = operation.runtime_acks.filter(
        (item) => item.executionId !== ack.executionId
      );
      acks.push(ack);
      await client.query(
        `update chat_forget_operations set runtime_acks=$4::jsonb
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId, JSON.stringify(acks)]
      );
    });
  },
  async completeForgetChat(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    return inTransaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.personal_deleted_at)
        throw new ChatForgetConflictError("Conversation is already forgotten");
      if (session.forget_batch_id !== batchId)
        throw new ChatForgetConflictError("Forget reservation changed");
      const selected = await client.query<ForgetRow>(
        `select * from chat_forget_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
        [ownerUserId, sessionId, batchId]
      );
      const operation = selected.rows[0];
      if (!operation || operation.state !== "stopping")
        throw new ChatForgetConflictError("Forget operation changed");
      if (operation.runtime_acks.length !== operation.execution_manifest.length)
        throw new ChatForgetConflictError(
          "Execution stop acknowledgments are incomplete"
        );
      const running = await client.query(
        `select 1 from managed_conversation_executions where owner_user_id=$1 and logical_session_id=$2
          and state not in ('stopped','failed','fenced') limit 1`,
        [ownerUserId, session.logical_session_id]
      );
      if (running.rowCount)
        throw new ChatForgetConflictError(
          "Conversation execution is still active"
        );
      for (const ack of operation.runtime_acks) {
        const current = await client.query<{
          state: string;
          state_version: number;
          execution_generation: number;
        }>(
          `select state,state_version,execution_generation from managed_conversation_executions
            where owner_user_id=$1 and id=$2`,
          [ownerUserId, ack.executionId]
        );
        if (
          !current.rows[0] ||
          current.rows[0].state !== ack.state ||
          current.rows[0].state_version !== ack.stateVersion ||
          current.rows[0].execution_generation !== ack.executionGeneration
        )
          throw new ChatForgetConflictError(
            "Execution stop acknowledgment changed"
          );
      }
      const timestamp = new Date();
      const items = await client.query<{ id: string }>(
        `update conversation_items set personal_deleted_at=$3
          where owner_user_id=$1 and session_id=$2 and personal_deleted_at is null
          returning id`,
        [ownerUserId, sessionId, timestamp]
      );
      const events = await client.query<{ id: string }>(
        `update memory_events set personal_deleted_at=$3,updated_at=now()
          where owner_user_id=$1 and session_id=$2 and visibility='personal'
            and personal_deleted_at is null returning id`,
        [ownerUserId, sessionId, timestamp]
      );
      const eventIds = events.rows.map((row) => row.id);
      const nodes = await client.query<{ id: string }>(
        `with recursive direct_nodes as (
           select node.id from memory_nodes node
            where node.owner_user_id=$1 and node.visibility='personal'
              and node.session_id=$2
           union
           select node.id from memory_node_sources source
             join memory_nodes node on node.id=source.memory_node_id
            where node.owner_user_id=$1 and node.visibility='personal'
              and (source.memory_event_id in (
                     select id from memory_events where session_id=$2
                   )
                or source.message_id in (
                     select id from messages where session_id=$2
                   )
                or source.tool_event_id in (
                     select id from tool_events where session_id=$2
                   ))
         ), affected as (
           select id from direct_nodes
           union
           select child.parent_memory_node_id from memory_node_children child
             join affected derived on derived.id=child.child_memory_node_id
             join memory_nodes parent on parent.id=child.parent_memory_node_id
            where parent.owner_user_id=$1 and parent.visibility='personal'
         )
         update memory_nodes node set personal_deleted_at=$3,updated_at=now()
          where node.owner_user_id=$1 and node.visibility='personal'
            and node.personal_deleted_at is null and node.id in (select id from affected)
          returning node.id`,
        [ownerUserId, sessionId, timestamp]
      );
      const nodeIds = nodes.rows.map((row) => row.id);
      const candidateRows = await client.query<{ assertion_id: string }>(
        `select distinct cms.assertion_id
           from curated_memory_sources cms
           join curated_memory_assertions cma on cma.id=cms.assertion_id
          left join conversation_items ci on ci.id=cms.conversation_item_id
          left join memory_events event on event.id=cms.memory_event_id
          where cma.owner_user_id=$1 and cma.visibility='personal'
            and (ci.session_id=$2 or event.session_id=$2
              or cms.lcm_node_id=any($3::uuid[]))`,
        [ownerUserId, sessionId, nodeIds]
      );
      await client.query(
        `update memory_embeddings set personal_deleted_at=$4
          where owner_user_id=$1 and personal_deleted_at is null
            and (memory_event_id=any($2::uuid[]) or memory_node_id=any($3::uuid[])
              or message_id in (
                select id from messages where owner_user_id=$1 and session_id=$5
              ))`,
        [ownerUserId, eventIds, nodeIds, timestamp, sessionId]
      );
      await client.query(
        `update sessions set personal_deleted_at=$3,personal_deleted_by_user_id=$1,
          personal_deletion_reason='chat_forget',updated_at=now()
          where owner_user_id=$1 and id=$2 and personal_deleted_at is null`,
        [ownerUserId, sessionId, timestamp]
      );
      const suppressed =
        await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
          client,
          { userId: ownerUserId },
          options.envelopeEncryptionProvider,
          candidateRows.rows.map((row) => row.assertion_id)
        );
      const snapshots = suppressed.length
        ? await client.query<{
            id: string;
            suppressed_at: string;
            updated_at: string;
            suppression_reason: string | null;
          }>(
            `select id,suppressed_at::text as suppressed_at,
                    updated_at::text as updated_at,suppression_reason
               from curated_memory_assertions
          where owner_user_id=$1 and id=any($2::uuid[])`,
            [ownerUserId, suppressed]
          )
        : { rows: [] };
      const assertionSnapshots: AssertionSnapshot[] = snapshots.rows.map(
        (row) => ({
          id: row.id,
          suppressedAt: row.suppressed_at,
          updatedAt: row.updated_at,
          suppressionReason: row.suppression_reason
        })
      );
      await client.query(
        `update chat_forget_operations set state='complete',forgotten_at=$4,
          event_ids=$5::jsonb,item_ids=$6::jsonb,node_ids=$7::jsonb,assertion_snapshots=$8::jsonb
          where batch_id=$1 and session_id=$2 and owner_user_id=$3`,
        [
          batchId,
          sessionId,
          ownerUserId,
          timestamp,
          JSON.stringify(eventIds),
          JSON.stringify(items.rows.map((row) => row.id)),
          JSON.stringify(nodeIds),
          JSON.stringify(assertionSnapshots)
        ]
      );
      return {
        batchId,
        forgottenAt: timestamp.toISOString(),
        suppressedAssertionIds: suppressed
      };
    });
  },
  async undoForgetChat(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    return inTransaction(pool, async (client) => {
      // Different chats can share one Curated assertion. Serialize their Undo
      // reconciliation before either Session lock so both cannot miss the
      // other's newly undone snapshot.
      await client.query(
        `select pg_advisory_xact_lock(hashtextextended('koed.chat-forget-undo:' || $1::text, 0))`,
        [ownerUserId]
      );
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      const selected = await client.query<ForgetRow>(
        `select * from chat_forget_operations where owner_user_id=$1 and session_id=$2
          and batch_id=$3 for update`,
        [ownerUserId, sessionId, batchId]
      );
      const operation = selected.rows[0];
      if (!operation)
        throw new ChatForgetNotFoundError("Forget operation not found");
      if (operation.undone_at) return { outcome: "restored" as const };
      if (operation.state !== "complete" || !operation.forgotten_at)
        throw new ChatForgetConflictError("Forget operation is not complete");
      if (operation.forgotten_at.getTime() <= Date.now() - 7 * 86_400_000)
        throw new ChatForgetConflictError("Forget Undo window expired");
      if (
        (session.personal_deleted_at
          ? new Date(session.personal_deleted_at as string | Date).getTime()
          : null) !== operation.forgotten_at.getTime()
      )
        throw new ChatForgetConflictError("Conversation forget state changed");
      const timestamp = operation.forgotten_at;
      await client.query(
        `update conversation_items set personal_deleted_at=null
        where owner_user_id=$1 and id=any($2::uuid[]) and personal_deleted_at=$3`,
        [ownerUserId, operation.item_ids, timestamp]
      );
      await client.query(
        `update memory_events set personal_deleted_at=null,updated_at=now()
        where owner_user_id=$1 and id=any($2::uuid[]) and personal_deleted_at=$3`,
        [ownerUserId, operation.event_ids, timestamp]
      );
      await client.query(
        `update memory_nodes set personal_deleted_at=null,updated_at=now()
        where owner_user_id=$1 and id=any($2::uuid[]) and personal_deleted_at=$3`,
        [ownerUserId, operation.node_ids, timestamp]
      );
      await client.query(
        `update memory_embeddings set personal_deleted_at=null
        where owner_user_id=$1 and personal_deleted_at=$4
          and (memory_event_id=any($2::uuid[]) or memory_node_id=any($3::uuid[])
            or message_id in (
              select id from messages where owner_user_id=$1 and session_id=$5
            ))`,
        [
          ownerUserId,
          operation.event_ids,
          operation.node_ids,
          timestamp,
          sessionId
        ]
      );
      await client.query(
        `update sessions set personal_deleted_at=null,personal_deleted_by_user_id=null,
        personal_deletion_reason=null,forget_batch_id=null,updated_at=now()
        where owner_user_id=$1 and id=$2 and personal_deleted_at=$3`,
        [ownerUserId, sessionId, timestamp]
      );
      // An earlier Undo can have deferred its Curated assertion while another
      // forgotten chat still contributed to the same summary. Revisit only
      // exact saved suppression versions after this Session becomes active.
      const snapshots = await client.query<{
        assertion_snapshots: AssertionSnapshot[];
      }>(
        `select assertion_snapshots from chat_forget_operations
         where owner_user_id=$1 and (state='undone' or batch_id=$2)
           and assertion_snapshots <> '[]'::jsonb
         order by created_at,batch_id`,
        [ownerUserId, batchId]
      );
      for (const assertion of snapshots.rows.flatMap(
        (row) => row.assertion_snapshots
      )) {
        const restored = await client.query(
          `update curated_memory_assertions cma
          set status='current',suppressed_at=null,suppressed_by_user_id=null,
              suppression_reason=null,updated_at=now()
          where cma.owner_user_id=$1 and cma.id=$2 and cma.status='suppressed'
            and cma.suppressed_at=$3::timestamptz and cma.updated_at=$4::timestamptz
            and cma.suppression_reason is not distinct from $5::text
            and ${activeCuratedMemoryEvidencePredicate("cma")}
          returning id`,
          [
            ownerUserId,
            assertion.id,
            assertion.suppressedAt,
            assertion.updatedAt,
            assertion.suppressionReason
          ]
        );
        if (restored.rowCount && protectedCuratedMemoryPayloadsRequired()) {
          const payload = await decryptCuratedMemoryPayload(
            client,
            { userId: ownerUserId },
            options.envelopeEncryptionProvider,
            "curated_memory_assertions",
            assertion.id
          );
          if (payload) {
            const restoredPayload = { ...payload };
            delete restoredPayload.suppressionReason;
            await persistCuratedMemoryPayload(
              client,
              { userId: ownerUserId },
              options.envelopeEncryptionProvider,
              {
                sourceTable: "curated_memory_assertions",
                sourceId: assertion.id,
                plaintext: restoredPayload
              }
            );
          }
        }
      }
      await client.query(
        `update chat_forget_operations set state='undone',undone_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
      return { outcome: "restored" as const };
    });
  }
});
export type ChatForgetRepository = ReturnType<
  typeof createChatForgetRepository
>;
