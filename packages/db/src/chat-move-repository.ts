import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { EnvelopeEncryptionProvider } from "@koed/shared";
import { pauseScheduledJobsWithClient } from "./scheduled-job-repository.js";
import { claimedManagedTextMoveWithClient } from "./managed-text-action-repository.js";

export type ProjectPolicyGrantBinding = {
  id: string;
  ownerUserId: string;
  sessionId: string;
  projectId: string;
  backendId: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  // Older policy binding manifests omit origin; preserve their approved hash.
  origin?: "manual";
  policyGeneration: number | null;
  mappingVersion: number;
  grantVersion: number;
};
export type ChatMoveFreezeAck = {
  bindingId: string;
  commandRequestId: string;
  actionGrantId: string | null;
  reviewedGrantVersion: number;
  state: "reserved" | "review_required" | "dispatched" | "frozen" | "resolved";
};
export type ChatMoveOperation = {
  batchId: string;
  textActionId: string | null;
  ownerUserId: string;
  sessionId: string;
  oldProjectId: string;
  oldWorkspaceProjectId: string;
  oldProjectVersion: number;
  targetProjectId: string | null;
  sourceMappingVersion: number;
  bindings: ProjectPolicyGrantBinding[];
  manifestHash: string;
  acks: ChatMoveFreezeAck[];
  state: "freezing" | "ready" | "complete" | "cancelled" | "needs_attention";
};
export class ChatMoveConflictError extends Error {}

const nullableProjectId = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") return value;
  throw new ChatMoveConflictError("Project placement is invalid");
};

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hasAcknowledgedMoveFence = async (
  client: pg.Pool | pg.PoolClient,
  ownerUserId: string,
  sessionId: string,
  projectId: string,
  backendId: string,
  workspaceProjectId: string,
  mappingVersion: number
): Promise<boolean> => {
  const result = await client.query(
    `select fence.id from project_share_move_fences fence
       join projects project on project.id=fence.project_id
         and project.owner_user_id=fence.owner_user_id
         and project.team_backend_id=fence.backend_id
         and project.workspace_project_id=fence.workspace_project_id
         and project.share_policy_link_epoch=fence.link_epoch
       join sessions session on session.id=fence.session_id
         and session.owner_user_id=fence.owner_user_id
         and session.project_assignment_version=fence.mapping_version
         and session.project_share_move_pending_at is not null
         and session.project_share_private_pending_at is null
      where fence.owner_user_id=$1 and fence.session_id=$2
        and fence.project_id=$3 and fence.backend_id=$4
        and fence.workspace_project_id=$5 and fence.mapping_version=$6
        and fence.state='acknowledged' limit 1`,
    [
      ownerUserId,
      sessionId,
      projectId,
      backendId,
      workspaceProjectId,
      mappingVersion
    ]
  );
  return Boolean(result.rows[0]);
};
const mapBinding = (
  row: Record<string, unknown>
): ProjectPolicyGrantBinding => ({
  id: String(row.id),
  ownerUserId: String(row.owner_user_id),
  sessionId: String(row.session_id),
  projectId: String(row.project_id),
  backendId: String(row.backend_id),
  logicalMemoryId: String(row.logical_memory_id),
  teamId: String(row.team_id),
  teamWorkspaceId: String(row.team_workspace_id),
  shareGrantId: String(row.share_grant_id),
  ...(row.origin === "manual" ? { origin: "manual" as const } : {}),
  policyGeneration:
    row.policy_generation == null ? null : Number(row.policy_generation),
  mappingVersion: Number(row.mapping_version),
  grantVersion: Number(row.grant_version)
});
const mapOperation = (row: Record<string, unknown>): ChatMoveOperation => ({
  batchId: String(row.batch_id),
  textActionId: nullableProjectId(row.text_action_id),
  ownerUserId: String(row.owner_user_id),
  sessionId: String(row.session_id),
  oldProjectId: String(row.old_project_id),
  oldWorkspaceProjectId: String(row.old_workspace_project_id),
  oldProjectVersion: Number(row.old_project_version),
  targetProjectId: nullableProjectId(row.target_project_id),
  sourceMappingVersion: Number(row.source_mapping_version),
  bindings: row.binding_manifest as ProjectPolicyGrantBinding[],
  manifestHash: String(row.binding_manifest_hash),
  acks: row.grant_freeze_acks as ChatMoveFreezeAck[],
  state: row.state as ChatMoveOperation["state"]
});
const transaction = async <T>(
  pool: pg.Pool,
  run: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** Local authority journal; the Team backend never receives a Personal Project ID. */
export const createChatMoveRepository = (
  pool: pg.Pool,
  options: { textActionEncryptionProvider?: EnvelopeEncryptionProvider } = {}
) => ({
  async prepare(
    ownerUserId: string,
    sessionId: string,
    expectedProjectId: string | null,
    targetProjectId: string | null,
    textActionId?: string
  ): Promise<ChatMoveOperation | null> {
    return transaction(pool, async (client) => {
      // Project lifecycle also locks the Project before its sessions. Read the
      // current placement, lock that Project, then lock/recheck the Session.
      const provisional = (
        await client.query<{ effective_project_id: string | null }>(
          `select (case when project_override_id is not null then project_override_personal_project_id
          else automatic_personal_project_id end) as effective_project_id
          from sessions where owner_user_id=$1 and id=$2`,
          [ownerUserId, sessionId]
        )
      ).rows[0];
      for (const projectId of [
        provisional?.effective_project_id,
        targetProjectId
      ]
        .filter((id): id is string => Boolean(id))
        .sort())
        await client.query(
          `select id from projects where owner_user_id=$1 and id=$2 for update`,
          [ownerUserId, projectId]
        );
      const source = (
        await client.query<Record<string, unknown>>(
          `select s.*, (case when s.project_override_id is not null then s.project_override_personal_project_id
            else s.automatic_personal_project_id end) as effective_project_id
         from sessions s where s.owner_user_id=$1 and s.id=$2 and s.visibility='personal'
           and s.invalidated_at is null and s.trashed_at is null and s.personal_deleted_at is null
           and s.delete_batch_id is null and s.forget_batch_id is null
           and not exists (select 1 from managed_conversation_executions hq
             left join managed_conversation_runtime_bindings binding on binding.execution_id=hq.id
                and binding.owner_user_id=hq.owner_user_id
             where hq.owner_user_id=s.owner_user_id and hq.is_project_hq
               and (hq.logical_session_id=s.logical_session_id or binding.local_session_id=s.id
                 or (hq.hq_private_path is not null and hq.hq_private_path=s.cwd)))
         for update of s`,
          [ownerUserId, sessionId]
        )
      ).rows[0];
      if (!source)
        throw new ChatMoveConflictError("Conversation is unavailable");
      const currentId = nullableProjectId(source.effective_project_id);
      if (currentId !== expectedProjectId)
        throw new ChatMoveConflictError("Conversation placement changed");
      if (currentId !== (provisional?.effective_project_id ?? null))
        throw new ChatMoveConflictError(
          "Conversation mapping changed while locking Project"
        );
      const existing = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2
           and state in ('freezing','ready','needs_attention') for update`,
          [ownerUserId, sessionId]
        )
      ).rows[0];
      if (existing) {
        const operation = mapOperation(existing);
        if (
          operation.oldProjectId !== currentId ||
          operation.targetProjectId !== targetProjectId ||
          operation.textActionId !== (textActionId ?? null)
        )
          throw new ChatMoveConflictError("A different move is pending");
        return operation;
      }
      if (textActionId) {
        const previous = await client.query(
          `select 1 from chat_move_operations where owner_user_id=$1
            and session_id=$2 and text_action_id=$3 limit 1`,
          [ownerUserId, sessionId, textActionId]
        );
        if (previous.rowCount)
          throw new ChatMoveConflictError(
            "This reviewed move already has a terminal batch"
          );
      }
      const linked =
        currentId &&
        (
          await client.query<Record<string, unknown>>(
            `select id,team_backend_id,team_workspace_id,workspace_project_id,version from projects
          where owner_user_id=$1 and id=$2 and lifecycle='active' and deletion_phase is null for update`,
            [ownerUserId, currentId]
          )
        ).rows[0];
      if (
        !linked ||
        !linked.team_backend_id ||
        !linked.team_workspace_id ||
        typeof linked.workspace_project_id !== "string" ||
        typeof linked.team_backend_id !== "string"
      )
        return null;
      if (targetProjectId) {
        const target = (
          await client.query<Record<string, unknown>>(
            `select * from projects where id=$2 and owner_user_id=$1`,
            [ownerUserId, targetProjectId]
          )
        ).rows[0];
        if (
          !target ||
          target.lifecycle !== "active" ||
          target.deletion_phase ||
          target.team_backend_id ||
          target.team_workspace_id ||
          target.workspace_project_id
        )
          throw new ChatMoveConflictError(
            "Destination is unavailable or requires confirmation"
          );
      }
      if (textActionId) {
        const targetVersion = targetProjectId
          ? ((
              await client.query<{ version: number }>(
                `select version from projects where id=$2 and owner_user_id=$1`,
                [ownerUserId, targetProjectId]
              )
            ).rows[0]?.version ?? null)
          : null;
        if (
          !(await claimedManagedTextMoveWithClient(
            client,
            options.textActionEncryptionProvider,
            {
              ownerUserId,
              actionId: textActionId,
              sessionId,
              sourceProjectId: String(currentId),
              targetProjectId,
              expectedAssignmentVersion: Number(
                source.project_assignment_version
              ),
              sourceProjectVersion: Number(linked.version),
              sourceWorkspaceProjectId: linked.workspace_project_id,
              sourceTeamBackendId: linked.team_backend_id,
              targetProjectVersion: targetVersion
            }
          ))
        )
          throw new ChatMoveConflictError("Reviewed move action changed");
      }
      const pendingIssues =
        // A policy Pending Share can still publish before it has a grant
        // binding. Do not move its owner-local source mapping until the
        // coordinated Team withdrawal has fenced that issue.
        (
          await client.query<{ id: string }>(
            `select id from project_share_local_issues
            where owner_user_id=$1 and session_id=$2 and project_id=$3
              and state in ('reserved','staged')
            limit 1 for update`,
            [ownerUserId, sessionId, currentId]
          )
        ).rows;
      if (pendingIssues.length)
        throw new ChatMoveConflictError(
          "Project summary sharing must be withdrawn before this Conversation moves"
        );
      const grantBindings = (
        await client.query<Record<string, unknown>>(
          `select * from project_policy_session_grants where owner_user_id=$1 and session_id=$2
           and project_id=$3 order by backend_id,share_grant_id for share`,
          [ownerUserId, sessionId, currentId]
        )
      ).rows.map(mapBinding);
      if (
        (!grantBindings.length &&
          !(await hasAcknowledgedMoveFence(
            client,
            ownerUserId,
            sessionId,
            String(currentId),
            String(linked.team_backend_id),
            String(linked.workspace_project_id),
            Number(source.project_assignment_version)
          ))) ||
        grantBindings.some(
          (item) =>
            item.backendId !== linked.team_backend_id ||
            item.teamWorkspaceId !== linked.team_workspace_id
        )
      )
        throw new ChatMoveConflictError(
          "Exact old Project policy grant provenance is unavailable"
        );
      const batchId = randomUUID();
      const manifestHash = hash(grantBindings);
      const row = (
        await client.query<Record<string, unknown>>(
          `insert into chat_move_operations(batch_id,owner_user_id,session_id,old_project_id,
           old_workspace_project_id,old_project_version,target_project_id,source_mapping_version,
           binding_manifest,binding_manifest_hash,text_action_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) returning *`,
          [
            batchId,
            ownerUserId,
            sessionId,
            currentId,
            linked.workspace_project_id,
            Number(linked.version),
            targetProjectId,
            Number(source.project_assignment_version),
            JSON.stringify(grantBindings),
            manifestHash,
            textActionId ?? null
          ]
        )
      ).rows[0]!;
      return mapOperation(row);
    });
  },
  async get(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ): Promise<ChatMoveOperation | null> {
    const row = (
      await pool.query<Record<string, unknown>>(
        `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      )
    ).rows[0];
    return row ? mapOperation(row) : null;
  },
  /** Read an already prepared exact batch; never starts or repeats a freeze. */
  async getByTextAction(
    ownerUserId: string,
    sessionId: string,
    textActionId: string
  ): Promise<ChatMoveOperation | null> {
    const row = (
      await pool.query<Record<string, unknown>>(
        `select * from chat_move_operations where owner_user_id=$1
          and session_id=$2 and text_action_id=$3`,
        [ownerUserId, sessionId, textActionId]
      )
    ).rows[0];
    return row ? mapOperation(row) : null;
  },
  async assertPending(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ): Promise<ChatMoveOperation> {
    const operation = await this.get(ownerUserId, sessionId, batchId);
    if (!operation || operation.state !== "freezing")
      throw new ChatMoveConflictError("Conversation move changed");
    const source = (
      await pool.query<Record<string, unknown>>(
        `select s.*, (case when s.project_override_id is not null then s.project_override_personal_project_id
          else s.automatic_personal_project_id end) as effective_project_id
         from sessions s where s.owner_user_id=$1 and s.id=$2 and s.visibility='personal'
           and s.invalidated_at is null and s.trashed_at is null and s.personal_deleted_at is null
           and s.delete_batch_id is null and s.forget_batch_id is null
           and not exists (select 1 from managed_conversation_executions hq
             left join managed_conversation_runtime_bindings binding on binding.execution_id=hq.id
               and binding.owner_user_id=hq.owner_user_id
             where hq.owner_user_id=s.owner_user_id and hq.is_project_hq
               and (hq.logical_session_id=s.logical_session_id or binding.local_session_id=s.id
                 or (hq.hq_private_path is not null and hq.hq_private_path=s.cwd)))`,
        [ownerUserId, sessionId]
      )
    ).rows[0];
    const oldProject = (
      await pool.query<Record<string, unknown>>(
        `select * from projects where id=$2 and owner_user_id=$1 and lifecycle='active'
          and deletion_phase is null`,
        [ownerUserId, operation.oldProjectId]
      )
    ).rows[0];
    if (
      !source ||
      !oldProject ||
      String(source.effective_project_id) !== operation.oldProjectId ||
      Number(source.project_assignment_version) !==
        operation.sourceMappingVersion ||
      (operation.bindings.length > 0 &&
        (oldProject.team_backend_id !== operation.bindings[0]?.backendId ||
          oldProject.team_workspace_id !==
            operation.bindings[0]?.teamWorkspaceId)) ||
      oldProject.workspace_project_id !== operation.oldWorkspaceProjectId ||
      Number(oldProject.version) !== operation.oldProjectVersion
    )
      throw new ChatMoveConflictError("Conversation move source changed");
    if (operation.targetProjectId) {
      const target = (
        await pool.query<Record<string, unknown>>(
          `select * from projects where id=$2 and owner_user_id=$1`,
          [ownerUserId, operation.targetProjectId]
        )
      ).rows[0];
      if (
        !target ||
        target.lifecycle !== "active" ||
        target.deletion_phase ||
        target.team_backend_id ||
        target.team_workspace_id ||
        target.workspace_project_id
      )
        throw new ChatMoveConflictError(
          "Conversation move destination changed"
        );
    }
    const currentBindings = (
      await pool.query<Record<string, unknown>>(
        `select * from project_policy_session_grants where owner_user_id=$1 and session_id=$2
          and project_id=$3 order by backend_id,share_grant_id`,
        [ownerUserId, sessionId, operation.oldProjectId]
      )
    ).rows.map(mapBinding);
    if (hash(currentBindings) !== operation.manifestHash)
      throw new ChatMoveConflictError("Conversation move grant set changed");
    const pendingIssue = await pool.query(
      `select 1 from project_share_local_issues
        where owner_user_id=$1 and session_id=$2 and project_id=$3
          and state in ('reserved','staged') limit 1`,
      [ownerUserId, sessionId, operation.oldProjectId]
    );
    if (
      pendingIssue.rows[0] ||
      (!currentBindings.length &&
        !(await hasAcknowledgedMoveFence(
          pool,
          ownerUserId,
          sessionId,
          operation.oldProjectId,
          String(oldProject.team_backend_id),
          operation.oldWorkspaceProjectId,
          operation.sourceMappingVersion
        )))
    )
      throw new ChatMoveConflictError(
        "Project policy issue is not safely frozen"
      );
    return operation;
  },
  async reviewReservation(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    actionGrantId: string
  ) {
    const operation = await this.get(ownerUserId, sessionId, batchId);
    if (!operation || operation.state !== "freezing")
      throw new ChatMoveConflictError("Conversation move review changed");
    const ack = operation.acks.find(
      (item) =>
        item.actionGrantId === actionGrantId && item.state === "review_required"
    );
    const binding = operation.bindings.find(
      (item) => item.id === ack?.bindingId
    );
    if (!ack || !binding)
      throw new ChatMoveConflictError(
        "Conversation move review reservation changed"
      );
    const source = (
      await pool.query<Record<string, unknown>>(
        `select s.*, (case when s.project_override_id is not null then s.project_override_personal_project_id
        else s.automatic_personal_project_id end) as effective_project_id
       from sessions s where s.owner_user_id=$1 and s.id=$2 and s.visibility='personal'
         and s.invalidated_at is null and s.trashed_at is null and s.personal_deleted_at is null
         and s.delete_batch_id is null and s.forget_batch_id is null`,
        [ownerUserId, sessionId]
      )
    ).rows[0];
    const project = (
      await pool.query<Record<string, unknown>>(
        `select * from projects where id=$2 and owner_user_id=$1 and lifecycle='active'
        and deletion_phase is null`,
        [ownerUserId, operation.oldProjectId]
      )
    ).rows[0];
    if (
      !source ||
      !project ||
      String(source.effective_project_id) !== operation.oldProjectId ||
      Number(source.project_assignment_version) !==
        operation.sourceMappingVersion ||
      project.team_backend_id !== binding.backendId ||
      project.team_workspace_id !== binding.teamWorkspaceId ||
      project.workspace_project_id !== operation.oldWorkspaceProjectId ||
      Number(project.version) !== operation.oldProjectVersion
    )
      throw new ChatMoveConflictError("Conversation move source changed");
    const currentBindings = (
      await pool.query<Record<string, unknown>>(
        `select * from project_policy_session_grants where owner_user_id=$1 and session_id=$2
        and project_id=$3 order by backend_id,share_grant_id`,
        [ownerUserId, sessionId, operation.oldProjectId]
      )
    ).rows.map(mapBinding);
    if (hash(currentBindings) !== operation.manifestHash)
      throw new ChatMoveConflictError("Conversation move grant set changed");
    return { operation, binding, ack };
  },
  async reserve(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    bindingId: string,
    reviewedGrantVersion: number
  ): Promise<ChatMoveFreezeAck> {
    return transaction(pool, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!row) throw new ChatMoveConflictError("Move operation changed");
      const operation = mapOperation(row);
      if (
        operation.state !== "freezing" ||
        !operation.bindings.some((binding) => binding.id === bindingId)
      )
        throw new ChatMoveConflictError("Grant is outside the move manifest");
      const previous = operation.acks.find(
        (ack) => ack.bindingId === bindingId
      );
      if (
        previous?.reviewedGrantVersion === reviewedGrantVersion ||
        (previous &&
          ["dispatched", "frozen", "resolved"].includes(previous.state))
      )
        return previous;
      const ack: ChatMoveFreezeAck = {
        bindingId,
        commandRequestId: randomUUID(),
        actionGrantId: null,
        reviewedGrantVersion,
        state: "reserved"
      };
      await client.query(
        `update chat_move_operations set grant_freeze_acks=$4::jsonb,updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [
          ownerUserId,
          sessionId,
          batchId,
          JSON.stringify([
            ...operation.acks.filter((item) => item.bindingId !== bindingId),
            ack
          ])
        ]
      );
      return ack;
    });
  },
  async resetReviewReservation(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    bindingId: string,
    actionGrantId: string | null
  ): Promise<void> {
    await transaction(pool, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!row) throw new ChatMoveConflictError("Move operation changed");
      const operation = mapOperation(row);
      const previous = operation.acks.find(
        (item) => item.bindingId === bindingId
      );
      if (
        operation.state !== "freezing" ||
        !previous ||
        !["reserved", "review_required"].includes(previous.state) ||
        previous.actionGrantId !== actionGrantId
      )
        throw new ChatMoveConflictError("Native review reservation changed");
      const replacement: ChatMoveFreezeAck = {
        ...previous,
        commandRequestId: randomUUID(),
        actionGrantId: null,
        state: "reserved"
      };
      await client.query(
        `update chat_move_operations set grant_freeze_acks=$4::jsonb,updated_at=now()
          where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [
          ownerUserId,
          sessionId,
          batchId,
          JSON.stringify(
            operation.acks.map((item) =>
              item.bindingId === bindingId ? replacement : item
            )
          )
        ]
      );
    });
  },
  async cancel(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ): Promise<void> {
    await transaction(pool, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!row) throw new ChatMoveConflictError("Move operation changed");
      const operation = mapOperation(row);
      if (
        operation.state !== "freezing" ||
        operation.acks.some((ack) => ack.state === "dispatched")
      )
        throw new ChatMoveConflictError(
          "An uncertain grant freeze must reconcile before cancellation"
        );
      await client.query(
        `update chat_move_operations set state='cancelled',updated_at=now()
          where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
    });
  },
  async ack(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    ack: ChatMoveFreezeAck
  ): Promise<void> {
    await transaction(pool, async (client) => {
      const row = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!row) throw new ChatMoveConflictError("Move operation changed");
      const operation = mapOperation(row);
      const previous = operation.acks.find(
        (item) => item.bindingId === ack.bindingId
      );
      if (
        operation.state !== "freezing" ||
        !previous ||
        previous.commandRequestId !== ack.commandRequestId ||
        previous.reviewedGrantVersion !== ack.reviewedGrantVersion ||
        (previous.actionGrantId && ack.actionGrantId !== previous.actionGrantId)
      )
        throw new ChatMoveConflictError("Grant review reservation changed");
      const order = {
        reserved: 0,
        review_required: 1,
        dispatched: 2,
        frozen: 3,
        resolved: 3
      };
      if (
        order[ack.state] < order[previous.state] ||
        (previous.state === "dispatched" && ack.state === "dispatched")
      )
        throw new ChatMoveConflictError(
          "Grant freeze dispatch already claimed"
        );
      const acks = operation.acks.map((item) =>
        item.bindingId === ack.bindingId ? ack : item
      );
      await client.query(
        `update chat_move_operations set grant_freeze_acks=$4::jsonb,updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId, JSON.stringify(acks)]
      );
    });
  },
  async complete(
    ownerUserId: string,
    sessionId: string,
    batchId: string
  ): Promise<string | null> {
    return transaction(pool, async (client) => {
      const provisional = (
        await client.query<{ old_project_id: string }>(
          `select old_project_id from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!provisional)
        throw new ChatMoveConflictError("Move operation changed");
      const pendingTarget = (
        await client.query<{ target_project_id: string | null }>(
          `select target_project_id from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      const lockedProjects = new Map<string, Record<string, unknown>>();
      for (const projectId of [
        provisional.old_project_id,
        pendingTarget?.target_project_id
      ]
        .filter((id): id is string => Boolean(id))
        .sort()) {
        const project = (
          await client.query<Record<string, unknown>>(
            `select * from projects where id=$2 and owner_user_id=$1 for update`,
            [ownerUserId, projectId]
          )
        ).rows[0];
        if (project) lockedProjects.set(projectId, project);
      }
      const oldProject = lockedProjects.get(provisional.old_project_id);
      const source = (
        await client.query<Record<string, unknown>>(
          `select s.*, (case when s.project_override_id is not null then s.project_override_personal_project_id
            else s.automatic_personal_project_id end) as effective_project_id
          from sessions s where s.owner_user_id=$1 and s.id=$2 for update of s`,
          [ownerUserId, sessionId]
        )
      ).rows[0];
      const row = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!source || !row)
        throw new ChatMoveConflictError("Move operation changed");
      const operation = mapOperation(row);
      if (
        operation.oldProjectId !== provisional.old_project_id ||
        operation.targetProjectId !== (pendingTarget?.target_project_id ?? null)
      )
        throw new ChatMoveConflictError("Move operation changed");
      if (operation.state === "complete") {
        if (operation.textActionId) {
          const receipt = await client.query(
            `select 1 from managed_conversation_text_action_move_effects
              where owner_user_id=$1 and action_id=$2 and session_id=$3
                and source_project_id=$4 and target_project_id is not distinct from $5::uuid
                and assignment_version=$6 and move_batch_id=$7`,
            [
              ownerUserId,
              operation.textActionId,
              sessionId,
              operation.oldProjectId,
              operation.targetProjectId,
              operation.sourceMappingVersion + 1,
              batchId
            ]
          );
          if (receipt.rowCount !== 1)
            throw new ChatMoveConflictError(
              "Exact move receipt is unavailable"
            );
        }
        return operation.targetProjectId;
      }
      if (
        operation.state !== "freezing" ||
        operation.acks.length !== operation.bindings.length ||
        operation.acks.some(
          (ack) => ack.state !== "frozen" && ack.state !== "resolved"
        )
      )
        throw new ChatMoveConflictError("Exact old grant freeze is pending");
      if (
        String(source.effective_project_id) !== operation.oldProjectId ||
        source.visibility !== "personal" ||
        source.invalidated_at ||
        source.trashed_at ||
        source.personal_deleted_at ||
        source.delete_batch_id ||
        source.forget_batch_id ||
        operation.sourceMappingVersion !==
          Number(source.project_assignment_version)
      )
        throw new ChatMoveConflictError("Conversation mapping changed");
      const hq = await client.query(
        `select 1 from managed_conversation_executions execution
          left join managed_conversation_runtime_bindings binding
            on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
          where execution.owner_user_id=$1 and execution.is_project_hq
            and (execution.logical_session_id=$2 or binding.local_session_id=$3
              or (execution.hq_private_path is not null and execution.hq_private_path=$4)) limit 1`,
        [ownerUserId, source.logical_session_id, sessionId, source.cwd]
      );
      if (hq.rowCount)
        throw new ChatMoveConflictError("HQ Conversation cannot move");
      if (
        !oldProject ||
        oldProject.lifecycle !== "active" ||
        oldProject.deletion_phase ||
        oldProject.workspace_project_id !== operation.oldWorkspaceProjectId ||
        Number(oldProject.version) !== operation.oldProjectVersion ||
        operation.bindings.some(
          (binding) =>
            binding.backendId !== oldProject.team_backend_id ||
            binding.teamWorkspaceId !== oldProject.team_workspace_id
        )
      )
        throw new ChatMoveConflictError("Original shared Project link changed");
      const currentBindings = (
        await client.query<Record<string, unknown>>(
          `select * from project_policy_session_grants where owner_user_id=$1 and session_id=$2
          and project_id=$3 order by backend_id,share_grant_id for share`,
          [ownerUserId, sessionId, operation.oldProjectId]
        )
      ).rows.map(mapBinding);
      if (hash(currentBindings) !== operation.manifestHash)
        throw new ChatMoveConflictError("Policy grant set changed");
      const unsettled = await client.query(
        `select id from project_share_local_issues
          where owner_user_id=$1 and session_id=$2 and project_id=$3
            and state in ('reserved','staged') limit 1 for update`,
        [ownerUserId, sessionId, operation.oldProjectId]
      );
      if (
        unsettled.rows[0] ||
        (!currentBindings.length &&
          !(await hasAcknowledgedMoveFence(
            client,
            ownerUserId,
            sessionId,
            operation.oldProjectId,
            String(oldProject.team_backend_id),
            operation.oldWorkspaceProjectId,
            operation.sourceMappingVersion
          )))
      )
        throw new ChatMoveConflictError(
          "Project policy issue is not safely frozen"
        );
      const target =
        operation.targetProjectId === null
          ? null
          : lockedProjects.get(operation.targetProjectId);
      if (
        operation.targetProjectId &&
        (!target ||
          target.lifecycle !== "active" ||
          target.deletion_phase ||
          target.team_backend_id ||
          target.team_workspace_id ||
          target.workspace_project_id)
      )
        throw new ChatMoveConflictError(
          "Destination changed or requires confirmation"
        );
      if (
        operation.textActionId &&
        !(await claimedManagedTextMoveWithClient(
          client,
          options.textActionEncryptionProvider,
          {
            ownerUserId,
            actionId: operation.textActionId,
            sessionId,
            sourceProjectId: operation.oldProjectId,
            targetProjectId: operation.targetProjectId,
            expectedAssignmentVersion: operation.sourceMappingVersion,
            sourceProjectVersion: operation.oldProjectVersion,
            sourceWorkspaceProjectId: operation.oldWorkspaceProjectId,
            sourceTeamBackendId: String(oldProject.team_backend_id),
            targetProjectVersion: target ? Number(target.version) : null
          }
        ))
      )
        throw new ChatMoveConflictError("Reviewed move action changed");
      await client.query(
        `update sessions set project_override_id=$3::text,project_override_name=$4,
        project_override_path=$5,project_override_personal_project_id=$6,
        project_override_at=now(),project_override_by_user_id=$1,
        project_share_move_pending_at=null,updated_at=now()
        where owner_user_id=$1 and id=$2`,
        [
          ownerUserId,
          sessionId,
          target ? String(target.id) : "lp_chats",
          target ? String(target.name) : "Chats",
          target?.folder_path ?? null,
          target ? String(target.id) : null
        ]
      );
      if (operation.textActionId) {
        const receipt = await client.query(
          `insert into managed_conversation_text_action_move_effects
             (action_id,owner_user_id,session_id,source_project_id,
              target_project_id,assignment_version,move_batch_id)
           select $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,s.project_assignment_version,$7::uuid
             from sessions s where s.id=$3 and s.owner_user_id=$2
               and s.project_assignment_version=$6
               and (case when s.project_override_id is not null
                 then s.project_override_personal_project_id
                 else s.automatic_personal_project_id end) is not distinct from $5::uuid`,
          [
            operation.textActionId,
            ownerUserId,
            sessionId,
            operation.oldProjectId,
            operation.targetProjectId,
            operation.sourceMappingVersion + 1,
            batchId
          ]
        );
        if (receipt.rowCount !== 1)
          throw new ChatMoveConflictError("Exact move receipt changed");
      }
      await pauseScheduledJobsWithClient(client, ownerUserId, {
        conversationSessionId: sessionId,
        reason: "conversation_project_changed"
      });
      await client.query(
        `update chat_move_operations set state='complete',updated_at=now()
        where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
        [ownerUserId, sessionId, batchId]
      );
      return operation.targetProjectId;
    });
  },
  async undo(
    ownerUserId: string,
    sessionId: string,
    batchId: string,
    expectedProjectId: string | null
  ): Promise<string> {
    return transaction(pool, async (client) => {
      const provisional = (
        await client.query<{ old_project_id: string }>(
          `select old_project_id from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!provisional)
        throw new ChatMoveConflictError("Move operation changed");
      const old = (
        await client.query<Record<string, unknown>>(
          `select * from projects where id=$2 and owner_user_id=$1 and lifecycle='active' and deletion_phase is null for update`,
          [ownerUserId, provisional.old_project_id]
        )
      ).rows[0];
      const source = (
        await client.query<Record<string, unknown>>(
          `select s.*, (case when s.project_override_id is not null then s.project_override_personal_project_id
          else s.automatic_personal_project_id end) as effective_project_id
         from sessions s where s.owner_user_id=$1 and s.id=$2 and s.visibility='personal'
           and s.invalidated_at is null and s.trashed_at is null and s.personal_deleted_at is null
           and s.delete_batch_id is null and s.forget_batch_id is null for update of s`,
          [ownerUserId, sessionId]
        )
      ).rows[0];
      const row = (
        await client.query<Record<string, unknown>>(
          `select * from chat_move_operations where owner_user_id=$1 and session_id=$2 and batch_id=$3 for update`,
          [ownerUserId, sessionId, batchId]
        )
      ).rows[0];
      if (!source || !row)
        throw new ChatMoveConflictError("Move operation changed");
      const operation = mapOperation(row);
      if (operation.oldProjectId !== provisional.old_project_id)
        throw new ChatMoveConflictError("Move operation changed");
      if (
        operation.state !== "complete" ||
        operation.targetProjectId !== expectedProjectId ||
        nullableProjectId(source.effective_project_id) !== expectedProjectId ||
        operation.sourceMappingVersion + 1 !==
          Number(source.project_assignment_version)
      )
        throw new ChatMoveConflictError("A later placement prevents Undo");
      if (
        !old ||
        operation.bindings.some(
          (binding) =>
            binding.backendId !== old.team_backend_id ||
            binding.teamWorkspaceId !== old.team_workspace_id ||
            old.workspace_project_id !== operation.oldWorkspaceProjectId ||
            Number(old.version) !== operation.oldProjectVersion
        )
      )
        throw new ChatMoveConflictError(
          "Original shared Project is unavailable"
        );
      const hq = await client.query(
        `select 1 from managed_conversation_executions execution
          left join managed_conversation_runtime_bindings binding
            on binding.execution_id=execution.id and binding.owner_user_id=execution.owner_user_id
          where execution.owner_user_id=$1 and execution.is_project_hq
            and (execution.logical_session_id=$2 or binding.local_session_id=$3
              or (execution.hq_private_path is not null and execution.hq_private_path=$4)) limit 1`,
        [ownerUserId, source.logical_session_id, sessionId, source.cwd]
      );
      if (hq.rowCount)
        throw new ChatMoveConflictError("HQ Conversation cannot move");
      await client.query(
        `update sessions set project_override_id=$3::text,project_override_name=$4,
        project_override_path=$5,project_override_personal_project_id=$3::uuid,
        project_override_at=now(),project_override_by_user_id=$1,updated_at=now()
        where owner_user_id=$1 and id=$2`,
        [
          ownerUserId,
          sessionId,
          operation.oldProjectId,
          old.name,
          old.folder_path
        ]
      );
      return operation.oldProjectId;
    });
  }
});
export type ChatMoveRepository = ReturnType<typeof createChatMoveRepository>;
