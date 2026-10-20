import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { CreateProject, PatchProject, Project } from "@koed/shared";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";
import { createProjectActivityRepository } from "./project-activity-repository.js";

type Row = Record<string, unknown>;
const textValue = (value: unknown): string => {
  if (typeof value !== "string")
    throw new Error("Project database text is invalid");
  return value;
};
const iso = (value: unknown): string | null =>
  value == null ? null : new Date(value as string | Date).toISOString();
const mapProject = (row: Row): Project => ({
  id: String(row.id),
  name: String(row.name),
  key: String(row.key),
  folderPath: row.folder_path == null ? null : textValue(row.folder_path),
  lifecycle: row.lifecycle as Project["lifecycle"],
  deletionPhase: row.deletion_phase as Project["deletionPhase"],
  deleteBatchId:
    row.delete_batch_id == null ? null : textValue(row.delete_batch_id),
  deletedAt: iso(row.deleted_at),
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
  version: Number(row.version)
});

export class ProjectNotFoundError extends Error {}
export class ProjectConflictError extends Error {
  constructor(
    message: string,
    readonly current?: Project
  ) {
    super(message);
  }
}
export class ProjectCapabilityError extends Error {}

const inTransaction = async <T>(
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

const changed = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string
) => {
  await appendCollaborationOutboxEventWithClient(client, {
    family: "project_changed",
    scope: "personal",
    personalOwnerUserId: ownerUserId,
    teamId: null,
    teamWorkspaceId: null,
    threadId: null,
    messageId: null,
    shareGrantId: null,
    logicalMemoryId: null,
    resourceType: "project",
    resourceId: projectId,
    actorPrincipalId: ownerUserId,
    mutationId: randomUUID()
  });
};

const ownerProject = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string,
  lock = false
): Promise<Row> => {
  const result = await client.query<Row>(
    `select * from projects where id=$1 and owner_user_id=$2 ${lock ? "for update" : ""}`,
    [projectId, ownerUserId]
  );
  if (!result.rows[0]) throw new ProjectNotFoundError("Project not found");
  return result.rows[0];
};
const personalOnly = (row: Row) => {
  if (
    row.team_backend_id != null ||
    row.team_workspace_id != null ||
    row.workspace_project_id != null
  )
    throw new ProjectCapabilityError(
      "Linked Project changes require Team authority"
    );
};
const activeOnly = (row: Row) => {
  if (row.lifecycle !== "active" || row.deletion_phase != null)
    throw new ProjectConflictError(
      "Project is unavailable during deletion",
      mapProject(row)
    );
};
const assertFutureProjectCapabilities = async (
  client: pg.PoolClient | pg.Pool
): Promise<void> => {
  const result = await client.query<{
    capability: string;
    state: string;
    relation: string | null;
  }>(
    `select capability,state,
      to_regclass('public.' || capability)::text as relation
      from project_lifecycle_schema_capabilities
     where capability=any($1::text[])`,
    [
      [
        "project_sources",
        "project_source_notes",
        "project_decks",
        "project_scheduled_jobs",
        "project_hq_sections"
      ]
    ]
  );
  if (
    result.rows.length !== 5 ||
    result.rows.some((row) => row.state !== "absent" || row.relation !== null)
  )
    throw new ProjectCapabilityError(
      "Project child capability is enabled without a lifecycle adapter"
    );
};

const shortKey = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 8)
    .toUpperCase() || "PROJECT";
const digest = (name: string, folderPath: string | null): string =>
  createHash("sha256")
    .update(JSON.stringify({ name, folderPath }))
    .digest("hex");
const activeExecutionSet = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string
) => {
  // An unresolved local context deliberately has no Project ID. It cannot
  // prove that an active execution belongs to this Project or another one.
  const ambiguous = await client.query(
    `select 1 from managed_conversation_executions execution
    join project_local_contexts context
      on context.owner_user_id=execution.owner_user_id
     and context.device_id=execution.runner_device_id
     and context.local_project_id=execution.project_id
   where execution.owner_user_id=$1 and context.association_state='unresolved'
     and execution.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
   limit 1`,
    [ownerUserId]
  );
  if (ambiguous.rows.length > 0)
    throw new ProjectCapabilityError(
      "An active execution has unresolved Project identity"
    );
  const result = await client.query<{
    id: string;
    execution_generation: number;
    state: string;
    state_version: number;
  }>(
    `select execution.id,execution.execution_generation,execution.state,execution.state_version
       from managed_conversation_executions execution
       join project_local_contexts context
         on context.owner_user_id=execution.owner_user_id
        and context.device_id=execution.runner_device_id
        and context.local_project_id=execution.project_id
      where execution.owner_user_id=$1 and context.project_id=$2
        and context.association_state='resolved'
        and execution.state in ('starting','running','reconciling','quiesce_requested','quiesced','stopping')
      order by execution.id`,
    [ownerUserId, projectId]
  );
  const activeExecutions = result.rows.map((row) => ({
    id: row.id,
    executionGeneration: row.execution_generation,
    state: row.state,
    stateVersion: row.state_version
  }));
  return {
    activeExecutions,
    executionSetHash: createHash("sha256")
      .update(JSON.stringify(activeExecutions))
      .digest("hex")
  };
};
type DeleteSource = {
  sessionId: string;
  logicalMemoryId: string | null;
  backends: Array<{ backendId: string; relationshipIds: string[] }>;
};
type DeleteExecution = {
  id: string;
  executionGeneration: number;
  state: string;
  stateVersion: number;
};
type RuntimeAck = {
  executionId: string;
  executionGeneration: number;
  state: "stopped" | "failed" | "fenced";
  stateVersion: number;
};
type BackendAck = {
  logicalMemoryId: string;
  backendId: string;
  generation: number;
  holdVersion: number;
  sealed: boolean;
  cancelled?: boolean;
};
type GrantFreezeAck = {
  logicalMemoryId: string;
  backendId: string;
  shareGrantId: string;
  reviewedGrantVersion: number;
  grantVersion: number;
  state: "reserved" | "review_required" | "frozen" | "resolved";
  actionGrantId: string | null;
  commandRequestId: string;
};
type ProjectDeleteOperation = {
  batchId: string;
  projectId: string;
  ownerUserId: string;
  sources: DeleteSource[];
  executions: DeleteExecution[];
  backendAcks: BackendAck[];
  grantFreezeAcks: GrantFreezeAck[];
  runtimeAcks: RuntimeAck[];
  state: string;
  sourceManifestHash: string;
  executionSetHash: string;
};
const mapDeleteOperation = (row: Row): ProjectDeleteOperation => ({
  batchId: String(row.batch_id),
  projectId: String(row.project_id),
  ownerUserId: String(row.owner_user_id),
  sources: row.source_manifest as DeleteSource[],
  executions: row.execution_manifest as DeleteExecution[],
  backendAcks: row.backend_acks as BackendAck[],
  grantFreezeAcks: (row.grant_freeze_acks as GrantFreezeAck[]).map((ack) => ({
    ...ack,
    reviewedGrantVersion:
      ack.reviewedGrantVersion ??
      (ack.state === "frozen" ? ack.grantVersion - 1 : ack.grantVersion)
  })),
  runtimeAcks: row.runtime_acks as RuntimeAck[],
  state: String(row.state),
  sourceManifestHash: String(row.source_manifest_hash),
  executionSetHash: String(row.execution_set_hash)
});
const sourceManifest = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectId: string,
  configuredBackendIds: string[]
): Promise<{
  sources: DeleteSource[];
  hash: string;
}> => {
  const rows = await client.query<{
    session_id: string;
    logical_memory_id: string | null;
    relationship_id: string | null;
    backend_id: string | null;
  }>(
    `select session.id as session_id,local_memory.logical_memory_id,
            relationship.id as relationship_id,
            remote_deployment.upstream_backend_id as backend_id
       from sessions session
       left join local_captured_session_logical_memories local_memory
         on local_memory.local_session_id=session.id
        and local_memory.owner_user_id=session.owner_user_id
       left join cross_identity_sync_relationships relationship
         on relationship.logical_memory_id=local_memory.logical_memory_id
        and relationship.local_user_id=session.owner_user_id
        and relationship.side='source'
       left join deployment_identities remote_deployment
         on remote_deployment.id=relationship.remote_deployment_identity_id
      -- Source grant retention is independent of active Personal Memory and
      -- Conversation visibility. Prior trash remains outside this batch at
      -- the later child update, but its retained grant still needs a freeze.
      where session.owner_user_id=$1
        and (case when session.project_override_id is not null
                  then session.project_override_personal_project_id
                  else session.automatic_personal_project_id end)=$2
      order by session.id,local_memory.logical_memory_id,relationship.id`,
    [ownerUserId, projectId]
  );
  const grouped = new Map<string, DeleteSource>();
  for (const row of rows.rows) {
    if (row.relationship_id && !row.backend_id)
      throw new ProjectCapabilityError(
        "A Project source backend has no verified identity"
      );
    let source = grouped.get(row.session_id);
    if (!source) {
      source = {
        sessionId: row.session_id,
        logicalMemoryId: row.logical_memory_id,
        backends: []
      };
      grouped.set(row.session_id, source);
    }
    if (row.relationship_id && row.backend_id) {
      let backend = source.backends.find(
        (item) => item.backendId === row.backend_id
      );
      if (!backend) {
        backend = { backendId: row.backend_id, relationshipIds: [] };
        source.backends.push(backend);
      }
      backend.relationshipIds.push(row.relationship_id);
    }
  }
  // Enrollment is retained on revocation and is required before local-edge
  // sharing. It is the durable backend history for explicit no-Sync grants,
  // including backends removed from the current registry.
  const historical = await client.query<{ backend_id: string }>(
    `select distinct backend_id from collaboration_shared_memory_enrollments
      where local_owner_user_id=$1 order by backend_id`,
    [ownerUserId]
  );
  const relevantBackendIds = [
    ...new Set([
      ...configuredBackendIds,
      ...historical.rows.map((row) => row.backend_id)
    ])
  ];
  const sources = [...grouped.values()].map((source) => ({
    ...source,
    backends: source.logicalMemoryId
      ? [
          ...new Map(
            [
              ...relevantBackendIds.map((backendId) => ({
                backendId,
                relationshipIds: []
              })),
              ...source.backends
            ].map((item) => [item.backendId, item] as const)
          ).values()
        ].sort((a, b) => a.backendId.localeCompare(b.backendId))
      : []
  }));
  const hash = createHash("sha256")
    .update(JSON.stringify(sources))
    .digest("hex");
  return { sources, hash };
};

export const createProjectApiRepository = (
  pool: pg.Pool,
  options: { configuredBackendIds?: () => string[] } = {}
) => ({
  async list(
    ownerUserId: string,
    input: { limit: number; cursor?: string; includeDeleted: boolean }
  ) {
    let after: { createdAt: string; id: string } | null = null;
    if (input.cursor) {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString("utf8")
        );
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("createdAt" in parsed) ||
          !("id" in parsed) ||
          typeof parsed.createdAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/.test(
            parsed.createdAt
          ) ||
          typeof parsed.id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            parsed.id
          )
        )
          throw new Error();
        after = { createdAt: parsed.createdAt, id: parsed.id };
      } catch {
        throw new ProjectConflictError("Invalid Project cursor");
      }
    }
    const result = await pool.query<Row>(
      `select *,created_at::text as cursor_created_at from projects where owner_user_id=$1 and ($2::boolean or lifecycle='active')
       and ($3::timestamptz is null or (created_at,id)<($3::timestamptz,$4::uuid))
       order by created_at desc,id desc limit $5`,
      [
        ownerUserId,
        input.includeDeleted,
        after?.createdAt ?? null,
        after?.id ?? null,
        input.limit + 1
      ]
    );
    const page = result.rows.slice(0, input.limit).map(mapProject);
    const last = result.rows[input.limit - 1];
    return {
      projects: page,
      nextCursor:
        result.rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                createdAt: String(last.cursor_created_at),
                id: String(last.id)
              })
            ).toString("base64url")
          : null
    };
  },
  async get(ownerUserId: string, projectId: string) {
    const result = await pool.query<Row>(
      "select * from projects where id=$1 and owner_user_id=$2",
      [projectId, ownerUserId]
    );
    if (!result.rows[0]) throw new ProjectNotFoundError("Project not found");
    return mapProject(result.rows[0]);
  },
  async getForRealtime(ownerUserId: string, projectId: string) {
    const result = await pool.query<Row>(
      "select * from projects where id=$1 and owner_user_id=$2",
      [projectId, ownerUserId]
    );
    return result.rows[0] ? mapProject(result.rows[0]) : null;
  },
  async create(ownerUserId: string, input: CreateProject) {
    return inTransaction(pool, async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`personal-project-owner-key:${ownerUserId}`]
      );
      const hash = digest(input.name, input.folderPath ?? null);
      const existing = await client.query<Row>(
        "select * from projects where owner_user_id=$1 and creation_idempotency_key=$2",
        [ownerUserId, input.idempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].creation_payload_hash !== hash)
          throw new ProjectConflictError(
            "Project idempotency key was reused",
            mapProject(existing.rows[0])
          );
        return mapProject(existing.rows[0]);
      }
      const base = shortKey(input.name);
      const keys = await client.query<{ key: string }>(
        "select key from projects where owner_user_id=$1 and (key=$2 or key like $3)",
        [ownerUserId, base, `${base}-%`]
      );
      const used = new Set(keys.rows.map((row) => row.key));
      let key = base;
      for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
      const created = await client.query<Row>(
        `insert into projects (owner_user_id,name,folder_path,key,creation_idempotency_key,creation_payload_hash)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [
          ownerUserId,
          input.name,
          input.folderPath ?? null,
          key,
          input.idempotencyKey,
          hash
        ]
      );
      await changed(client, ownerUserId, String(created.rows[0]!.id));
      return mapProject(created.rows[0]!);
    });
  },
  async patch(ownerUserId: string, projectId: string, input: PatchProject) {
    return inTransaction(pool, async (client) => {
      const current = await ownerProject(client, ownerUserId, projectId, true);
      personalOnly(current);
      activeOnly(current);
      if (Number(current.version) !== input.version)
        throw new ProjectConflictError(
          "Project version changed",
          mapProject(current)
        );
      const changedRow = await client.query<Row>(
        `update projects set name=$3,folder_path=$4,updated_at=now(),version=version+1
         where id=$1 and owner_user_id=$2 returning *`,
        [
          projectId,
          ownerUserId,
          input.name ?? current.name,
          input.folderPath === undefined
            ? current.folder_path
            : input.folderPath
        ]
      );
      await changed(client, ownerUserId, projectId);
      return mapProject(changedRow.rows[0]!);
    });
  },
  async hq(ownerUserId: string, projectId: string) {
    await assertFutureProjectCapabilities(pool);
    const project = await this.get(ownerUserId, projectId);
    if (project.lifecycle !== "active")
      throw new ProjectNotFoundError("Project not found");
    const result = await pool.query<{
      conversations: string;
      work_items: string;
    }>(
      `select
        (select count(*)::text from sessions s where s.owner_user_id=$1 and s.visibility='personal'
          and s.invalidated_at is null and s.personal_deleted_at is null and s.trashed_at is null
          and (case when s.project_override_id is not null then s.project_override_personal_project_id
               else s.automatic_personal_project_id end)=$2) as conversations,
        (select count(*)::text from project_work_items wi where wi.owner_user_id=$1 and wi.project_id=$2 and wi.deleted_at is null) as work_items`,
      [ownerUserId, projectId]
    );
    return {
      project,
      activity: {
        lastSevenDays: await createProjectActivityRepository(pool).summary(
          ownerUserId,
          projectId
        )
      },
      sections: {
        conversations: {
          availability: "available" as const,
          count: Number(result.rows[0]!.conversations)
        },
        workItems: {
          availability: "available" as const,
          count: Number(result.rows[0]!.work_items)
        },
        sources: { availability: "not_implemented" as const },
        decks: { availability: "not_implemented" as const },
        scheduledJobs: { availability: "not_implemented" as const }
      }
    };
  },
  async deletePreview(ownerUserId: string, projectId: string) {
    return inTransaction(pool, async (client) => {
      const current = await ownerProject(client, ownerUserId, projectId, true);
      personalOnly(current);
      activeOnly(current);
      return {
        project: mapProject(current),
        ...(await activeExecutionSet(client, ownerUserId, projectId))
      };
    });
  },
  async beginDelete(
    ownerUserId: string,
    projectId: string,
    input: { version: number; batchId: string; executionSetHash: string }
  ) {
    return inTransaction(pool, async (client) => {
      await assertFutureProjectCapabilities(client);
      const current = await ownerProject(client, ownerUserId, projectId, true);
      personalOnly(current);
      if (
        current.delete_batch_id === input.batchId &&
        current.deletion_phase != null
      )
        return mapProject(current);
      activeOnly(current);
      const reused = await client.query(
        `select 1 from project_delete_operations where batch_id=$1`,
        [input.batchId]
      );
      if (reused.rows[0])
        throw new ProjectConflictError(
          "Project delete batch was already used",
          mapProject(current)
        );
      if (Number(current.version) !== input.version)
        throw new ProjectConflictError(
          "Project version changed",
          mapProject(current)
        );
      const executions = await activeExecutionSet(
        client,
        ownerUserId,
        projectId
      );
      if (executions.executionSetHash !== input.executionSetHash)
        throw new ProjectConflictError(
          "Active Project executions changed",
          mapProject(current)
        );
      const manifest = await sourceManifest(
        client,
        ownerUserId,
        projectId,
        options.configuredBackendIds?.() ?? []
      );
      const result = await client.query<Row>(
        `update projects set delete_batch_id=$3,deletion_phase='preparing',deletion_generation=deletion_generation+1,
          version=version+1,updated_at=now() where id=$1 and owner_user_id=$2 returning *`,
        [projectId, ownerUserId, input.batchId]
      );
      await client.query(
        `insert into project_delete_operations
           (batch_id,project_id,owner_user_id,source_manifest,source_manifest_hash,
            execution_manifest,execution_set_hash,state)
         values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,'preparing')`,
        [
          input.batchId,
          projectId,
          ownerUserId,
          JSON.stringify(manifest.sources),
          manifest.hash,
          JSON.stringify(executions.activeExecutions),
          executions.executionSetHash
        ]
      );
      await changed(client, ownerUserId, projectId);
      return mapProject(result.rows[0]!);
    });
  },
  async cancelDelete(ownerUserId: string, projectId: string, batchId: string) {
    return inTransaction(pool, async (client) => {
      const current = await ownerProject(client, ownerUserId, projectId, true);
      personalOnly(current);
      if (
        current.lifecycle !== "active" ||
        current.delete_batch_id !== batchId ||
        current.deletion_phase == null
      )
        throw new ProjectConflictError(
          "Project deletion changed",
          mapProject(current)
        );
      const result = await client.query<Row>(
        `update projects set delete_batch_id=null,deletion_phase=null,version=version+1,updated_at=now()
        where id=$1 and owner_user_id=$2 returning *`,
        [projectId, ownerUserId]
      );
      await client.query(
        `update project_delete_operations set state='cancelled',updated_at=now()
          where batch_id=$1 and project_id=$2 and owner_user_id=$3`,
        [batchId, projectId, ownerUserId]
      );
      await changed(client, ownerUserId, projectId);
      return mapProject(result.rows[0]!);
    });
  },
  async getDeleteOperation(ownerUserId: string, projectId: string) {
    const result = await pool.query<Row>(
      `select operation.* from project_delete_operations operation
        join projects project on project.id=operation.project_id
         and project.owner_user_id=operation.owner_user_id
       where operation.owner_user_id=$1 and operation.project_id=$2
         and project.delete_batch_id=operation.batch_id
       order by operation.created_at desc limit 1`,
      [ownerUserId, projectId]
    );
    return result.rows[0] ? mapDeleteOperation(result.rows[0]) : null;
  },
  async getDeleteOperationByBatch(
    ownerUserId: string,
    projectId: string,
    batchId: string
  ) {
    const result = await pool.query<Row>(
      `select * from project_delete_operations
      where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
      [ownerUserId, projectId, batchId]
    );
    return result.rows[0] ? mapDeleteOperation(result.rows[0]) : null;
  },
  async listPendingReleaseOperations(ownerUserId: string, projectId: string) {
    const result = await pool.query<Row>(
      `select * from project_delete_operations
      where owner_user_id=$1 and project_id=$2
        and state in ('restore_releasing','cancelled')
      order by created_at`,
      [ownerUserId, projectId]
    );
    return result.rows
      .map(mapDeleteOperation)
      .filter(
        (operation) =>
          operation.state === "restore_releasing" ||
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
      );
  },
  async finishRestoreRelease(
    ownerUserId: string,
    projectId: string,
    batchId: string
  ) {
    return inTransaction(pool, async (client) => {
      const selected = await client.query<Row>(
        `select * from project_delete_operations
        where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, batchId]
      );
      if (
        !selected.rows[0] ||
        !["restore_releasing", "restored", "cancelled"].includes(
          String(selected.rows[0].state)
        )
      )
        throw new ProjectConflictError("Project restore release changed");
      const operation = mapDeleteOperation(selected.rows[0]);
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
        throw new ProjectConflictError(
          "Project source release acknowledgments are incomplete"
        );
      await client.query(
        `update project_delete_operations
         set state=case when state='cancelled' then 'cancelled' else 'restored' end,
             updated_at=now()
        where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
        [ownerUserId, projectId, batchId]
      );
    });
  },
  async recordBackendAck(
    ownerUserId: string,
    projectId: string,
    batchId: string,
    ack: BackendAck
  ) {
    return inTransaction(pool, async (client) => {
      const selected = await client.query<Row>(
        `select * from project_delete_operations
        where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, batchId]
      );
      if (
        !selected.rows[0] ||
        ![
          "preparing",
          "freezing",
          "stopping",
          "cancelled",
          "restore_releasing"
        ].includes(String(selected.rows[0].state))
      )
        throw new ProjectConflictError("Project deletion operation changed");
      const operation = mapDeleteOperation(selected.rows[0]);
      if (
        !operation.sources.some(
          (source) =>
            source.logicalMemoryId === ack.logicalMemoryId &&
            source.backends.some(
              (backend) => backend.backendId === ack.backendId
            )
        )
      )
        throw new ProjectConflictError(
          "Backend is outside Project source manifest"
        );
      const acks = operation.backendAcks.filter(
        (item) =>
          item.logicalMemoryId !== ack.logicalMemoryId ||
          item.backendId !== ack.backendId
      );
      acks.push(ack);
      await client.query(
        `update project_delete_operations set backend_acks=$4::jsonb,
        state=case when state in ('cancelled','restore_releasing') then state else 'freezing' end,
        updated_at=now() where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
        [ownerUserId, projectId, batchId, JSON.stringify(acks)]
      );
    });
  },
  async reserveGrantFreezeReview(
    ownerUserId: string,
    projectId: string,
    batchId: string,
    grant: Pick<
      GrantFreezeAck,
      "logicalMemoryId" | "backendId" | "shareGrantId" | "reviewedGrantVersion"
    >
  ): Promise<GrantFreezeAck> {
    return inTransaction(pool, async (client) => {
      const selected = await client.query<Row>(
        `select * from project_delete_operations
         where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, batchId]
      );
      if (
        !selected.rows[0] ||
        !["preparing", "freezing", "stopping"].includes(
          String(selected.rows[0].state)
        )
      )
        throw new ProjectConflictError("Project deletion operation changed");
      const operation = mapDeleteOperation(selected.rows[0]);
      if (
        !operation.sources.some(
          (source) =>
            source.logicalMemoryId === grant.logicalMemoryId &&
            source.backends.some(
              (backend) => backend.backendId === grant.backendId
            )
        )
      )
        throw new ProjectConflictError(
          "Grant is outside Project source manifest"
        );
      const existing = operation.grantFreezeAcks.find(
        (ack) =>
          ack.backendId === grant.backendId &&
          ack.shareGrantId === grant.shareGrantId
      );
      if (existing) {
        if (existing.logicalMemoryId !== grant.logicalMemoryId)
          throw new ProjectConflictError("Grant source identity changed");
        if (existing.reviewedGrantVersion > grant.reviewedGrantVersion)
          throw new ProjectConflictError("Grant review version changed");
        if (existing.reviewedGrantVersion === grant.reviewedGrantVersion)
          return existing;
      }
      const reserved: GrantFreezeAck = {
        ...grant,
        grantVersion: grant.reviewedGrantVersion,
        state: "reserved",
        actionGrantId: null,
        commandRequestId: randomUUID()
      };
      const acks = operation.grantFreezeAcks.filter(
        (ack) =>
          ack.shareGrantId !== grant.shareGrantId ||
          ack.backendId !== grant.backendId
      );
      acks.push(reserved);
      await client.query(
        `update project_delete_operations
         set grant_freeze_acks=$4::jsonb,state='freezing',updated_at=now()
         where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
        [ownerUserId, projectId, batchId, JSON.stringify(acks)]
      );
      return reserved;
    });
  },
  async recordGrantFreezeAck(
    ownerUserId: string,
    projectId: string,
    batchId: string,
    ack: GrantFreezeAck
  ) {
    return inTransaction(pool, async (client) => {
      const selected = await client.query<Row>(
        `select * from project_delete_operations
        where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, batchId]
      );
      if (
        !selected.rows[0] ||
        !["preparing", "freezing", "stopping"].includes(
          String(selected.rows[0].state)
        )
      )
        throw new ProjectConflictError("Project deletion operation changed");
      const operation = mapDeleteOperation(selected.rows[0]);
      if (
        !operation.sources.some(
          (source) =>
            source.logicalMemoryId === ack.logicalMemoryId &&
            source.backends.some(
              (backend) => backend.backendId === ack.backendId
            )
        )
      )
        throw new ProjectConflictError(
          "Grant is outside Project source manifest"
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
        (current.actionGrantId !== null &&
          ack.actionGrantId !== null &&
          current.actionGrantId !== ack.actionGrantId) ||
        ((ack.state === "review_required" || ack.state === "frozen") &&
          ack.actionGrantId === null) ||
        (ack.state === "frozen" &&
          ack.grantVersion <= ack.reviewedGrantVersion) ||
        (ack.state !== "frozen" &&
          ack.grantVersion !== ack.reviewedGrantVersion)
      )
        throw new ProjectConflictError("Grant review reservation changed");
      const rank = { reserved: 0, review_required: 1, frozen: 2, resolved: 2 };
      if (rank[ack.state] < rank[current.state]) return current;
      if (
        rank[ack.state] === rank[current.state] &&
        current.state !== ack.state
      )
        throw new ProjectConflictError("Grant review terminal state changed");
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
        `update project_delete_operations set grant_freeze_acks=$4::jsonb,
        state='freezing',updated_at=now() where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
        [ownerUserId, projectId, batchId, JSON.stringify(acks)]
      );
      return ack;
    });
  },
  async recordRuntimeAck(
    ownerUserId: string,
    projectId: string,
    batchId: string,
    ack: RuntimeAck
  ) {
    return inTransaction(pool, async (client) => {
      const selected = await client.query<Row>(
        `select * from project_delete_operations
          where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, batchId]
      );
      const row = selected.rows[0];
      if (
        !row ||
        !["preparing", "freezing", "stopping"].includes(String(row.state))
      )
        throw new ProjectConflictError("Project deletion operation changed");
      const operation = mapDeleteOperation(row);
      if (
        !operation.executions.some(
          (execution) =>
            execution.id === ack.executionId &&
            execution.executionGeneration === ack.executionGeneration
        )
      )
        throw new ProjectConflictError(
          "Execution is outside confirmed Project deletion"
        );
      const current = await client.query<{
        state: string;
        state_version: number;
        execution_generation: number;
      }>(
        `select state,state_version,execution_generation
          from managed_conversation_executions
         where id=$1 and owner_user_id=$2`,
        [ack.executionId, ownerUserId]
      );
      const execution = current.rows[0];
      if (
        !execution ||
        execution.state !== ack.state ||
        execution.state_version !== ack.stateVersion ||
        execution.execution_generation !== ack.executionGeneration ||
        !["stopped", "failed", "fenced"].includes(execution.state)
      )
        throw new ProjectConflictError(
          "Execution terminal acknowledgment changed"
        );
      const acks = operation.runtimeAcks.filter(
        (item) => item.executionId !== ack.executionId
      );
      acks.push(ack);
      await client.query(
        `update project_delete_operations
            set runtime_acks=$4::jsonb,state='stopping',updated_at=now()
          where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
        [ownerUserId, projectId, batchId, JSON.stringify(acks)]
      );
    });
  },
  async markDeleteReady(
    ownerUserId: string,
    projectId: string,
    batchId: string
  ) {
    return inTransaction(pool, async (client) => {
      const selected = await client.query<Row>(
        `select * from project_delete_operations
          where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, batchId]
      );
      const row = selected.rows[0];
      if (!row)
        throw new ProjectConflictError(
          "Project deletion operation is unavailable"
        );
      const operation = mapDeleteOperation(row);
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
        throw new ProjectConflictError(
          "Remote source acknowledgments are incomplete"
        );
      if (
        operation.grantFreezeAcks.some(
          (ack) => ack.state !== "frozen" && ack.state !== "resolved"
        )
      )
        throw new ProjectConflictError(
          "Share Grant freeze reviews are incomplete"
        );
      if (operation.runtimeAcks.length !== operation.executions.length)
        throw new ProjectConflictError(
          "Execution stop acknowledgments are incomplete"
        );
      const currentSources = await sourceManifest(
        client,
        ownerUserId,
        projectId,
        options.configuredBackendIds?.() ?? []
      );
      if (currentSources.hash !== operation.sourceManifestHash)
        throw new ProjectConflictError(
          "Project source set changed during deletion"
        );
      const project = await ownerProject(client, ownerUserId, projectId, true);
      if (
        project.lifecycle !== "active" ||
        project.delete_batch_id !== batchId ||
        project.deletion_phase == null
      )
        throw new ProjectConflictError(
          "Project deletion changed",
          mapProject(project)
        );
      await client.query(
        `update project_delete_operations set state='ready',updated_at=now()
          where batch_id=$1`,
        [batchId]
      );
      await client.query(
        `update projects set deletion_phase='ready',version=version+1,updated_at=now()
          where id=$1 and owner_user_id=$2`,
        [projectId, ownerUserId]
      );
      await changed(client, ownerUserId, projectId);
    });
  },
  async completeDelete(
    ownerUserId: string,
    projectId: string,
    batchId: string
  ) {
    return inTransaction(pool, async (client) => {
      const operation = await client.query<Row>(
        `select * from project_delete_operations where batch_id=$1 and project_id=$2 and owner_user_id=$3 for update`,
        [batchId, projectId, ownerUserId]
      );
      if (!operation.rows[0] || operation.rows[0].state !== "ready")
        throw new ProjectConflictError("Project deletion is not ready");
      const confirmed = mapDeleteOperation(operation.rows[0]);
      if (
        confirmed.sources.some((source) =>
          source.backends.some(
            (backend) =>
              !confirmed.backendAcks.some(
                (ack) =>
                  ack.logicalMemoryId === source.logicalMemoryId &&
                  ack.backendId === backend.backendId &&
                  ack.sealed
              )
          )
        ) ||
        confirmed.grantFreezeAcks.some(
          (ack) => ack.state !== "frozen" && ack.state !== "resolved"
        ) ||
        confirmed.executions.length !== confirmed.runtimeAcks.length
      )
        throw new ProjectConflictError(
          "Project deletion acknowledgments are incomplete"
        );
      for (const ack of confirmed.runtimeAcks) {
        const currentExecution = await client.query<{
          state: string;
          execution_generation: number;
        }>(
          `select state,execution_generation from managed_conversation_executions
            where id=$1 and owner_user_id=$2`,
          [ack.executionId, ownerUserId]
        );
        if (
          !currentExecution.rows[0] ||
          currentExecution.rows[0].execution_generation !==
            ack.executionGeneration ||
          !["stopped", "failed", "fenced"].includes(
            currentExecution.rows[0].state
          )
        )
          throw new ProjectConflictError("Project execution is not terminal");
      }
      const currentSources = await sourceManifest(
        client,
        ownerUserId,
        projectId,
        options.configuredBackendIds?.() ?? []
      );
      if (currentSources.hash !== operation.rows[0].source_manifest_hash)
        throw new ProjectConflictError(
          "Project source set changed during deletion"
        );
      const preliminary = await ownerProject(client, ownerUserId, projectId);
      personalOnly(preliminary);
      if (
        preliminary.lifecycle === "deleted" &&
        preliminary.delete_batch_id === batchId
      )
        return mapProject(preliminary);
      if (
        preliminary.lifecycle !== "active" ||
        preliminary.delete_batch_id !== batchId ||
        preliminary.deletion_phase !== "ready"
      )
        throw new ProjectConflictError(
          "Project deletion is not ready",
          mapProject(preliminary)
        );
      await client.query(
        `update sessions set trashed_at=now(),delete_batch_id=$3,updated_at=now()
        where owner_user_id=$1 and (case when project_override_id is not null then project_override_personal_project_id
             else automatic_personal_project_id end)=$2
          and trashed_at is null and personal_deleted_at is null and invalidated_at is null`,
        [ownerUserId, projectId, batchId]
      );
      await client.query(
        `update project_work_items set deleted_at=now(),delete_batch_id=$3,updated_at=now()
        where owner_user_id=$1 and project_id=$2 and deleted_at is null`,
        [ownerUserId, projectId, batchId]
      );
      const current = await ownerProject(client, ownerUserId, projectId, true);
      if (
        current.lifecycle !== "active" ||
        current.delete_batch_id !== batchId ||
        current.deletion_phase !== "ready"
      )
        throw new ProjectConflictError(
          "Project deletion changed",
          mapProject(current)
        );
      const result = await client.query<Row>(
        `update projects set lifecycle='deleted',deleted_at=now(),deletion_phase='complete',
        version=version+1,updated_at=now() where id=$1 and owner_user_id=$2 returning *`,
        [projectId, ownerUserId]
      );
      await client.query(
        `update project_delete_operations set state='complete',updated_at=now()
          where batch_id=$1 and project_id=$2 and owner_user_id=$3`,
        [batchId, projectId, ownerUserId]
      );
      await changed(client, ownerUserId, projectId);
      return mapProject(result.rows[0]!);
    });
  },
  async restore(
    ownerUserId: string,
    projectId: string,
    input: { version: number; batchId: string }
  ) {
    return inTransaction(pool, async (client) => {
      const current = await ownerProject(client, ownerUserId, projectId, true);
      personalOnly(current);
      if (
        current.lifecycle !== "deleted" ||
        current.delete_batch_id !== input.batchId ||
        Number(current.version) !== input.version
      )
        throw new ProjectConflictError(
          "Project restore batch or version changed",
          mapProject(current)
        );
      if (
        new Date(String(current.deleted_at)).getTime() <
        Date.now() - 30 * 24 * 60 * 60 * 1000
      )
        throw new ProjectConflictError(
          "Project restore window expired",
          mapProject(current)
        );
      const operation = await client.query<Row>(
        `select * from project_delete_operations
        where owner_user_id=$1 and project_id=$2 and batch_id=$3 for update`,
        [ownerUserId, projectId, input.batchId]
      );
      if (!operation.rows[0] || operation.rows[0].state !== "complete")
        throw new ProjectConflictError(
          "Project restore requires its completed delete batch",
          mapProject(current)
        );
      await client.query(
        `update sessions set trashed_at=null,delete_batch_id=null,updated_at=now()
        where owner_user_id=$1 and delete_batch_id=$2
          and id in (
            select (item->>'sessionId')::uuid
              from project_delete_operations operation,
                   jsonb_array_elements(operation.source_manifest) item
             where operation.batch_id=$2 and operation.project_id=$3
               and operation.owner_user_id=$1
          )`,
        [ownerUserId, input.batchId, projectId]
      );
      await client.query(
        `update project_work_items set deleted_at=null,delete_batch_id=null,updated_at=now()
        where owner_user_id=$1 and project_id=$2 and delete_batch_id=$3`,
        [ownerUserId, projectId, input.batchId]
      );
      const result = await client.query<Row>(
        `update projects set lifecycle='active',deleted_at=null,delete_batch_id=null,
        deletion_phase=null,version=version+1,updated_at=now() where id=$1 and owner_user_id=$2 returning *`,
        [projectId, ownerUserId]
      );
      await client.query(
        `update project_delete_operations set state='restore_releasing',updated_at=now()
        where owner_user_id=$1 and project_id=$2 and batch_id=$3`,
        [ownerUserId, projectId, input.batchId]
      );
      await changed(client, ownerUserId, projectId);
      return mapProject(result.rows[0]!);
    });
  }
});

export type ProjectApiRepository = ReturnType<
  typeof createProjectApiRepository
>;
