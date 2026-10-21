import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { pauseScheduledJobsWithClient } from "./scheduled-job-repository.js";

export type ChatDeleteBackend = {
  backendId: string;
  relationshipIds: string[];
};
export type ChatDeleteSource = {
  kind: "captured_session";
  sessionId: string;
  logicalMemoryId: string | null;
  backends: ChatDeleteBackend[];
};
export type ChatDeleteExecution = {
  id: string;
  executionGeneration: number;
  state: string;
  stateVersion: number;
};
export type ChatDeleteBackendAck = {
  logicalMemoryId: string;
  backendId: string;
  generation: number;
  holdVersion: number;
  sealed: boolean;
  cancelled?: boolean;
};
export type ChatDeleteGrantFreezeAck = {
  logicalMemoryId: string;
  backendId: string;
  shareGrantId: string;
  reviewedGrantVersion: number;
  grantVersion: number;
  state: "reserved" | "review_required" | "frozen" | "resolved";
  actionGrantId: string | null;
  commandRequestId: string;
};
export type ChatDeleteRuntimeAck = {
  executionId: string;
  executionGeneration: number;
  state: "stopped" | "failed" | "fenced";
  stateVersion: number;
};
export type ChatDeleteOperation = {
  chatRemoval: true;
  ownerUserId: string;
  sessionId: string;
  batchId: string;
  state: string;
  sources: ChatDeleteSource[];
  executions: ChatDeleteExecution[];
  backendAcks: ChatDeleteBackendAck[];
  grantFreezeAcks: ChatDeleteGrantFreezeAck[];
  runtimeAcks: ChatDeleteRuntimeAck[];
  sourceManifestHash: string;
  executionSetHash: string;
};
type Row = Record<string, unknown>;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const map = (row: Row): ChatDeleteOperation => ({
  chatRemoval: true,
  ownerUserId: String(row.owner_user_id),
  sessionId: String(row.session_id),
  batchId: String(row.batch_id),
  state: String(row.state),
  sources: row.source_manifest as ChatDeleteSource[],
  executions: row.execution_manifest as ChatDeleteExecution[],
  backendAcks: row.backend_acks as ChatDeleteBackendAck[],
  grantFreezeAcks: (row.grant_freeze_acks as ChatDeleteGrantFreezeAck[]).map(
    (ack) => ({
      ...ack,
      reviewedGrantVersion:
        ack.reviewedGrantVersion ??
        (ack.state === "frozen" ? ack.grantVersion - 1 : ack.grantVersion)
    })
  ),
  runtimeAcks: row.runtime_acks as ChatDeleteRuntimeAck[],
  sourceManifestHash: String(row.source_manifest_hash),
  executionSetHash: String(row.execution_set_hash)
});
export class ChatDeleteConflictError extends Error {}
export class ChatDeleteNotFoundError extends Error {}

const transaction = async <T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const ownerSession = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string
) => {
  const result = await client.query<Row>(
    `select * from sessions where id=$2 and owner_user_id=$1 and visibility='personal'
       and invalidated_at is null
       and not exists (
         select 1 from managed_conversation_executions execution
         left join managed_conversation_runtime_bindings binding
           on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
         where execution.owner_user_id=$1 and execution.is_project_hq
           and (execution.logical_session_id=sessions.logical_session_id
             or binding.local_session_id=sessions.id
             or (execution.hq_private_path is not null and execution.hq_private_path=sessions.cwd))
       ) for update`,
    [ownerUserId, sessionId]
  );
  if (!result.rows[0])
    throw new ChatDeleteNotFoundError("Conversation not found");
  return result.rows[0];
};

export const lockProjectBeforeSession = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string
) => {
  const association = await client.query<{ project_id: string | null }>(
    `select case when project_override_id is not null then project_override_personal_project_id
                 else automatic_personal_project_id end as project_id
       from sessions where id=$2 and owner_user_id=$1`,
    [ownerUserId, sessionId]
  );
  const projectId = association.rows[0]?.project_id ?? null;
  if (projectId) {
    const project = await client.query<{
      lifecycle: string;
      deletion_phase: string | null;
    }>(
      `select lifecycle,deletion_phase from projects where id=$2 and owner_user_id=$1 for update`,
      [ownerUserId, projectId]
    );
    if (
      !project.rows[0] ||
      project.rows[0].lifecycle !== "active" ||
      project.rows[0].deletion_phase !== null
    )
      throw new ChatDeleteConflictError("Project lifecycle changed");
  }
  const session = await ownerSession(client, ownerUserId, sessionId);
  const currentProjectId =
    session.project_override_id !== null
      ? session.project_override_personal_project_id
      : session.automatic_personal_project_id;
  if ((currentProjectId ?? null) !== projectId)
    throw new ChatDeleteConflictError("Conversation Project changed");
  return session;
};

const sourceManifest = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string,
  configuredBackendIds: string[]
): Promise<{ sources: ChatDeleteSource[]; sourceManifestHash: string }> => {
  const result = await client.query<{
    logical_memory_id: string | null;
    relationship_id: string | null;
    backend_id: string | null;
  }>(
    `select local_memory.logical_memory_id,relationship.id as relationship_id,
            remote_deployment.upstream_backend_id as backend_id
       from sessions session
       left join local_captured_session_logical_memories local_memory
         on local_memory.local_session_id=session.id
        and local_memory.owner_user_id=session.owner_user_id
       left join cross_identity_sync_relationships relationship
         on relationship.logical_memory_id=local_memory.logical_memory_id
        and relationship.local_user_id=$1 and relationship.side='source'
       left join deployment_identities remote_deployment
         on remote_deployment.id=relationship.remote_deployment_identity_id
      where session.owner_user_id=$1 and session.id=$2
      order by relationship.id`,
    [ownerUserId, sessionId]
  );
  if (!result.rows[0])
    throw new ChatDeleteNotFoundError("Conversation not found");
  const logicalMemoryIds = [
    ...new Set(result.rows.map((row) => row.logical_memory_id))
  ];
  if (logicalMemoryIds.length !== 1)
    throw new ChatDeleteConflictError("Captured source identity is ambiguous");
  const logicalMemoryId = logicalMemoryIds[0] ?? null;
  const backends = new Map<string, ChatDeleteBackend>();
  for (const row of result.rows) {
    if (row.relationship_id && !row.backend_id)
      throw new ChatDeleteConflictError(
        "A source backend has no verified identity"
      );
    if (row.backend_id) {
      const backend = backends.get(row.backend_id) ?? {
        backendId: row.backend_id,
        relationshipIds: []
      };
      if (row.relationship_id)
        backend.relationshipIds.push(row.relationship_id);
      backends.set(row.backend_id, backend);
    }
  }
  const historical = await client.query<{ backend_id: string }>(
    `select distinct backend_id from (
       select backend_id from collaboration_shared_memory_enrollments
        where local_owner_user_id=$1
       union all
       select backend_id from project_share_local_issues
        where owner_user_id=$1 and session_id=$2
          and state in ('reserved','staged','activated')
       union all
       select backend_id from project_share_explicit_offers
        where owner_user_id=$1 and session_id=$2
          and state in ('prepared','pending','accepted','activated')
     ) backend_history order by backend_id`,
    [ownerUserId, sessionId]
  );
  // Enrollment and a reserved policy issue survive a missing local
  // relationship. Both prove that this source could publish to a Team backend.
  // Mere backend configuration does not make an unshared chat online-only.
  const enrolledBackendIds = new Set(
    historical.rows.map((row) => row.backend_id)
  );
  if (logicalMemoryId)
    for (const backendId of [
      ...historical.rows.map((row) => row.backend_id),
      ...configuredBackendIds.filter((id) => enrolledBackendIds.has(id))
    ])
      if (!backends.has(backendId))
        backends.set(backendId, { backendId, relationshipIds: [] });
  const sources: ChatDeleteSource[] = [
    {
      kind: "captured_session",
      sessionId,
      logicalMemoryId,
      backends: logicalMemoryId
        ? [...backends.values()].sort((a, b) =>
            a.backendId.localeCompare(b.backendId)
          )
        : []
    }
  ];
  return { sources, sourceManifestHash: hash(sources) };
};

const executionManifest = async (
  client: pg.PoolClient,
  ownerUserId: string,
  logicalSessionId: string
) => {
  const result = await client.query<{
    id: string;
    execution_generation: number;
    state: string;
    state_version: number;
  }>(
    `select id,execution_generation,state,state_version
       from managed_conversation_executions
      where owner_user_id=$1 and logical_session_id=$2
        and state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
      order by id`,
    [ownerUserId, logicalSessionId]
  );
  const executions = result.rows.map((row) => ({
    id: row.id,
    executionGeneration: row.execution_generation,
    state: row.state,
    stateVersion: row.state_version
  }));
  return { executions, executionSetHash: hash(executions) };
};

const operationForUpdate = async (
  client: pg.PoolClient,
  ownerUserId: string,
  sessionId: string,
  batchId: string
) => {
  const result = await client.query<Row>(
    `select * from chat_delete_operations
      where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
    [ownerUserId, sessionId, batchId]
  );
  if (!result.rows[0])
    throw new ChatDeleteConflictError(
      "Conversation deletion operation changed"
    );
  return map(result.rows[0]);
};

export const createChatDeleteRepository = (
  pool: pg.Pool,
  options: { configuredBackendIds?: () => string[] } = {}
) => ({
  async beginChatDelete(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.personal_deleted_at)
        throw new ChatDeleteConflictError(
          "Forgotten Conversation cannot start deletion"
        );
      if (session.forget_batch_id)
        throw new ChatDeleteConflictError(
          "Conversation Forget is already in progress"
        );
      const existing = await client.query<Row>(
        `select * from chat_delete_operations
          where owner_user_id=$1 and session_id=$2 and state not in ('cancelled','restored')
          order by created_at desc limit 1 for update`,
        [ownerUserId, sessionId]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].batch_id !== batchId)
          throw new ChatDeleteConflictError(
            "Conversation deletion is already in progress"
          );
        return map(existing.rows[0]);
      }
      if (session.trashed_at || session.delete_batch_id)
        throw new ChatDeleteConflictError(
          "Conversation is already deleting or deleted"
        );
      const source = await sourceManifest(
        client,
        ownerUserId,
        sessionId,
        options.configuredBackendIds?.() ?? []
      );
      const execution = await executionManifest(
        client,
        ownerUserId,
        String(session.logical_session_id)
      );
      const reused = await client.query(
        `select 1 from chat_delete_operations where batch_id=$1`,
        [batchId]
      );
      if (reused.rowCount)
        throw new ChatDeleteConflictError("Deletion batch was already used");
      const inserted = await client.query<Row>(
        `insert into chat_delete_operations
           (batch_id,session_id,owner_user_id,source_manifest,source_manifest_hash,
            execution_manifest,execution_set_hash)
         values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7) returning *`,
        [
          batchId,
          sessionId,
          ownerUserId,
          JSON.stringify(source.sources),
          source.sourceManifestHash,
          JSON.stringify(execution.executions),
          execution.executionSetHash
        ]
      );
      await client.query(
        `update sessions set delete_batch_id=$3,updated_at=now()
          where owner_user_id=$1 and id=$2 and delete_batch_id is null`,
        [ownerUserId, sessionId, batchId]
      );
      return map(inserted.rows[0]!);
    });
  },
  async getChatDeleteOperation(
    ownerUserId: string,
    sessionId: string,
    batchId?: string
  ) {
    const result = await pool.query<Row>(
      `select * from chat_delete_operations where owner_user_id=$1 and session_id=$2
        and ($3::uuid is null or batch_id=$3) order by created_at desc limit 1`,
      [ownerUserId, sessionId, batchId ?? null]
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  },
  async listPendingChatDeletes(ownerUserId: string) {
    const result = await pool.query<Row>(
      `select operation.* from chat_delete_operations operation
       join sessions session on session.id=operation.session_id
         and session.owner_user_id=operation.owner_user_id
       where operation.owner_user_id=$1 and operation.state in ('preparing','freezing','stopping','ready','needs_attention')
         and session.delete_batch_id=operation.batch_id
       order by operation.created_at desc limit 200`,
      [ownerUserId]
    );
    return result.rows.map(map);
  },
  async recordChatBackendAck(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    ack: ChatDeleteBackendAck
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (!["preparing", "freezing", "stopping"].includes(operation.state))
        throw new ChatDeleteConflictError(
          "Conversation deletion operation changed"
        );
      if (
        !operation.sources.some(
          (source) =>
            source.logicalMemoryId === ack.logicalMemoryId &&
            source.backends.some(
              (backend) => backend.backendId === ack.backendId
            )
        )
      )
        throw new ChatDeleteConflictError("Backend is outside source manifest");
      const acks = operation.backendAcks.filter(
        (item) =>
          item.logicalMemoryId !== ack.logicalMemoryId ||
          item.backendId !== ack.backendId
      );
      acks.push(ack);
      await client.query(
        `update chat_delete_operations set backend_acks=$4::jsonb,state='freezing',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId, JSON.stringify(acks)]
      );
    });
  },
  async reserveChatGrantFreezeReview(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    grant: Pick<
      ChatDeleteGrantFreezeAck,
      "logicalMemoryId" | "backendId" | "shareGrantId" | "reviewedGrantVersion"
    >
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (!["preparing", "freezing", "stopping"].includes(operation.state))
        throw new ChatDeleteConflictError(
          "Conversation deletion operation changed"
        );
      if (
        !operation.sources.some(
          (source) =>
            source.logicalMemoryId === grant.logicalMemoryId &&
            source.backends.some(
              (backend) => backend.backendId === grant.backendId
            )
        )
      )
        throw new ChatDeleteConflictError("Grant is outside source manifest");
      const prior = operation.grantFreezeAcks.find(
        (ack) =>
          ack.backendId === grant.backendId &&
          ack.shareGrantId === grant.shareGrantId
      );
      if (prior) {
        if (
          prior.logicalMemoryId !== grant.logicalMemoryId ||
          prior.reviewedGrantVersion > grant.reviewedGrantVersion
        )
          throw new ChatDeleteConflictError("Grant review identity changed");
        if (prior.reviewedGrantVersion === grant.reviewedGrantVersion)
          return prior;
      }
      const reserved: ChatDeleteGrantFreezeAck = {
        ...grant,
        grantVersion: grant.reviewedGrantVersion,
        state: "reserved",
        actionGrantId: null,
        commandRequestId: randomUUID()
      };
      const acks = operation.grantFreezeAcks.filter(
        (ack) =>
          ack.backendId !== grant.backendId ||
          ack.shareGrantId !== grant.shareGrantId
      );
      acks.push(reserved);
      await client.query(
        `update chat_delete_operations set grant_freeze_acks=$4::jsonb,state='freezing',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId, JSON.stringify(acks)]
      );
      return reserved;
    });
  },
  async recordChatGrantFreezeAck(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    ack: ChatDeleteGrantFreezeAck
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (!["preparing", "freezing", "stopping"].includes(operation.state))
        throw new ChatDeleteConflictError(
          "Conversation deletion operation changed"
        );
      const current = operation.grantFreezeAcks.find(
        (item) =>
          item.shareGrantId === ack.shareGrantId &&
          item.backendId === ack.backendId
      );
      if (
        !current ||
        current.logicalMemoryId !== ack.logicalMemoryId ||
        current.reviewedGrantVersion !== ack.reviewedGrantVersion ||
        current.commandRequestId !== ack.commandRequestId ||
        (current.actionGrantId &&
          ack.actionGrantId &&
          current.actionGrantId !== ack.actionGrantId) ||
        (["review_required", "frozen"].includes(ack.state) &&
          !ack.actionGrantId) ||
        (ack.state === "frozen" &&
          ack.grantVersion <= ack.reviewedGrantVersion) ||
        (ack.state !== "frozen" &&
          ack.grantVersion !== ack.reviewedGrantVersion)
      )
        throw new ChatDeleteConflictError("Grant review reservation changed");
      const rank = { reserved: 0, review_required: 1, frozen: 2, resolved: 2 };
      if (rank[ack.state] < rank[current.state]) return current;
      const acks = operation.grantFreezeAcks.filter(
        (item) =>
          item.shareGrantId !== ack.shareGrantId ||
          item.backendId !== ack.backendId
      );
      acks.push({
        ...ack,
        actionGrantId: current.actionGrantId ?? ack.actionGrantId
      });
      await client.query(
        `update chat_delete_operations set grant_freeze_acks=$4::jsonb,state='freezing',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId, JSON.stringify(acks)]
      );
      return ack;
    });
  },
  async recordChatRuntimeAck(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    ack: ChatDeleteRuntimeAck
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (!["preparing", "freezing", "stopping"].includes(operation.state))
        throw new ChatDeleteConflictError(
          "Conversation deletion operation changed"
        );
      if (
        !operation.executions.some(
          (execution) =>
            execution.id === ack.executionId &&
            execution.executionGeneration === ack.executionGeneration
        )
      )
        throw new ChatDeleteConflictError(
          "Execution is outside deletion manifest"
        );
      const current = await client.query<{
        state: string;
        state_version: number;
        execution_generation: number;
      }>(
        `select state,state_version,execution_generation from managed_conversation_executions
          where id=$1 and owner_user_id=$2`,
        [ack.executionId, ownerUserId]
      );
      const row = current.rows[0];
      if (
        !row ||
        row.state !== ack.state ||
        row.state_version !== ack.stateVersion ||
        row.execution_generation !== ack.executionGeneration ||
        !["stopped", "failed", "fenced"].includes(row.state)
      )
        throw new ChatDeleteConflictError(
          "Execution stop acknowledgment changed"
        );
      const acks = operation.runtimeAcks.filter(
        (item) => item.executionId !== ack.executionId
      );
      acks.push(ack);
      await client.query(
        `update chat_delete_operations set runtime_acks=$4::jsonb,state='stopping',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId, JSON.stringify(acks)]
      );
    });
  },
  async markChatDeleteReady(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (!["preparing", "freezing", "stopping"].includes(operation.state))
        throw new ChatDeleteConflictError(
          "Conversation deletion operation changed"
        );
      if (
        operation.sources.some((source) =>
          source.backends.some(
            (backend) =>
              !operation.backendAcks.some(
                (ack) =>
                  ack.logicalMemoryId === source.logicalMemoryId &&
                  ack.backendId === backend.backendId &&
                  ack.sealed
              )
          )
        )
      )
        throw new ChatDeleteConflictError(
          "Source freeze acknowledgments are incomplete"
        );
      if (
        operation.grantFreezeAcks.some(
          (ack) => !["frozen", "resolved"].includes(ack.state)
        )
      )
        throw new ChatDeleteConflictError(
          "Grant freeze reviews are incomplete"
        );
      if (operation.runtimeAcks.length !== operation.executions.length)
        throw new ChatDeleteConflictError(
          "Execution stop acknowledgments are incomplete"
        );
      const source = await sourceManifest(
        client,
        ownerUserId,
        sessionId,
        options.configuredBackendIds?.() ?? []
      );
      if (source.sourceManifestHash !== operation.sourceManifestHash)
        throw new ChatDeleteConflictError("Conversation source set changed");
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      const active = await executionManifest(
        client,
        ownerUserId,
        String(session.logical_session_id)
      );
      if (active.executions.length)
        throw new ChatDeleteConflictError(
          "Conversation execution is still active"
        );
      await client.query(
        `update chat_delete_operations set state='ready',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
    });
  },
  async completeChatDelete(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (operation.state === "complete") return operation;
      if (operation.state !== "ready")
        throw new ChatDeleteConflictError("Conversation deletion is not ready");
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      const source = await sourceManifest(
        client,
        ownerUserId,
        sessionId,
        options.configuredBackendIds?.() ?? []
      );
      if (source.sourceManifestHash !== operation.sourceManifestHash)
        throw new ChatDeleteConflictError("Conversation source set changed");
      const execution = await executionManifest(
        client,
        ownerUserId,
        String(session.logical_session_id)
      );
      if (execution.executions.length)
        throw new ChatDeleteConflictError(
          "Conversation execution is still active"
        );
      if (
        operation.sources.some((item) =>
          item.backends.some(
            (backend) =>
              !operation.backendAcks.some(
                (ack) =>
                  ack.logicalMemoryId === item.logicalMemoryId &&
                  ack.backendId === backend.backendId &&
                  ack.sealed
              )
          )
        )
      )
        throw new ChatDeleteConflictError(
          "Source freeze acknowledgments are incomplete"
        );
      if (
        operation.grantFreezeAcks.some(
          (ack) => !["frozen", "resolved"].includes(ack.state)
        ) ||
        operation.runtimeAcks.length !== operation.executions.length
      )
        throw new ChatDeleteConflictError(
          "Deletion acknowledgments are incomplete"
        );
      await client.query(
        `update sessions set trashed_at=now(),updated_at=now()
        where id=$2 and owner_user_id=$1 and trashed_at is null`,
        [ownerUserId, sessionId]
      );
      await pauseScheduledJobsWithClient(client, ownerUserId, {
        conversationSessionId: sessionId,
        reason: "conversation_deleted"
      });
      await client.query(
        `update chat_delete_operations set state='complete',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
      return { ...operation, state: "complete" };
    });
  },
  async cancelChatDelete(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (operation.state === "complete")
        throw new ChatDeleteConflictError(
          "Completed deletion cannot be cancelled"
        );
      if (session.delete_batch_id !== batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion reservation changed"
        );
      if (
        operation.sources.some((source) =>
          source.backends.some(
            (backend) =>
              !operation.backendAcks.some(
                (ack) =>
                  ack.logicalMemoryId === source.logicalMemoryId &&
                  ack.backendId === backend.backendId &&
                  ack.cancelled
              )
          )
        )
      )
        throw new ChatDeleteConflictError("Remote source release is pending");
      await client.query(
        `update sessions set delete_batch_id=null,updated_at=now()
        where owner_user_id=$1 and id=$2 and delete_batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
      await client.query(
        `update chat_delete_operations set state='cancelled',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
    });
  },
  async restoreChat(
    ownerUserId: string,
    sessionId: string,
    expectedBatchId?: string
  ) {
    return transaction(pool, async (client) => {
      const session = await lockProjectBeforeSession(
        client,
        ownerUserId,
        sessionId
      );
      if (session.personal_deleted_at)
        throw new ChatDeleteConflictError(
          "Forgotten Conversation cannot be restored"
        );
      if (!session.trashed_at)
        throw new ChatDeleteNotFoundError("Deleted Conversation not found");
      if (
        new Date(session.trashed_at as string | Date).getTime() <=
        Date.now() - 30 * 86_400_000
      )
        throw new ChatDeleteConflictError(
          "Conversation restore window expired"
        );
      const batchId = session.delete_batch_id;
      if (typeof batchId !== "string" || !batchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion batch is unavailable"
        );
      if (expectedBatchId && batchId !== expectedBatchId)
        throw new ChatDeleteConflictError(
          "Conversation deletion batch changed"
        );
      const operation = await operationForUpdate(
        client,
        ownerUserId,
        sessionId,
        batchId
      );
      if (operation.state !== "complete")
        throw new ChatDeleteConflictError(
          "Conversation deletion is incomplete"
        );
      await client.query(
        `update sessions set trashed_at=null,delete_batch_id=null,updated_at=now()
        where owner_user_id=$1 and id=$2 and delete_batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
      await client.query(
        `update chat_delete_operations set state='restored',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
      return { ...operation, state: "restored" };
    });
  }
});

export type ChatDeleteRepository = ReturnType<
  typeof createChatDeleteRepository
>;
