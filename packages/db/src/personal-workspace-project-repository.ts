import type pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { workspaceProjectCopyManifestHash } from "./workspace-project-repository.js";
import { pauseScheduledJobsWithClient } from "./scheduled-job-repository.js";
import {
  workspaceProjectCopyFitsTransport,
  workspaceProjectCopySchema
} from "@koed/shared/workspace-project-contract";

export class PersonalWorkspaceProjectConflictError extends Error {}
export class PersonalWorkspaceProjectUnavailableError extends Error {}
type CopyBackDeck = {
  id: string;
  sourceOwnerTeamMemberId: string;
  sourceDeckId: string | null;
  title: string;
  scope: string;
  madeFrom: string;
  createdByAgentId: string | null;
  cards: Array<{
    id: string;
    sourceCardId: string | null;
    question: string;
    answer: string;
    sourceRef: string | null;
    topicLabel: string | null;
  }>;
};
const copyBackPayload = (
  workItems: unknown,
  decks: CopyBackDeck[] | undefined
) => (decks?.length ? { workItems, decks } : workItems);

const canonicalJson = (value: unknown): string => {
  const encoded = JSON.stringify(
    value,
    (_key: string, item: unknown): unknown =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>).sort(
              ([left], [right]) => left.localeCompare(right)
            )
          )
        : item
  );
  if (encoded === undefined)
    throw new Error("Copy-back payload is unavailable");
  return encoded;
};

export const workspaceProjectCopyBackPayloadHash = (
  workItems: unknown,
  decks: unknown[]
): string =>
  createHash("sha256")
    .update(canonicalJson(decks.length ? { workItems, decks } : workItems))
    .digest("hex");

const deckAgainKeyHash = (sourceKey: string, cardId: string) =>
  createHash("sha256")
    .update(
      `koed:collaboration:personal-note-idempotency:v1\ndeck-again:${sourceKey}:${cardId}`,
      "utf8"
    )
    .digest("hex");
const remapDeckAgainNote = async (
  client: pg.PoolClient,
  ownerUserId: string,
  oldSourceKey: string,
  oldCardId: string,
  nextSourceKey: string,
  nextCardId: string
) => {
  const oldHash = deckAgainKeyHash(oldSourceKey, oldCardId);
  const nextHash = deckAgainKeyHash(nextSourceKey, nextCardId);
  const notes = await client.query<{
    id: string;
    idempotency_key_hash: string;
  }>(
    `select id,idempotency_key_hash from personal_notes
      where owner_user_id=$1 and idempotency_key_hash in ($2,$3)
        and lifecycle='active' for update`,
    [ownerUserId, oldHash, nextHash]
  );
  const source = notes.rows.find((row) => row.idempotency_key_hash === oldHash);
  const destination = notes.rows.find(
    (row) => row.idempotency_key_hash === nextHash
  );
  if (source && destination && source.id !== destination.id)
    throw new PersonalWorkspaceProjectConflictError(
      "Deck learning Note identity changed"
    );
  if (!source || oldHash === nextHash) return;
  await client.query(
    `update personal_notes set idempotency_key_hash=$3,updated_at=now()
       where owner_user_id=$1 and id=$4 and idempotency_key_hash=$2 and lifecycle='active'`,
    [ownerUserId, oldHash, nextHash, source.id]
  );
};

const deckSnapshot = async (
  client: pg.Pool | pg.PoolClient,
  ownerUserId: string,
  projectId: string
) => {
  const decks = await client.query<{
    id: string;
    title: string;
    scope: string;
    made_from: string;
    created_by_agent_id: string | null;
  }>(
    "select id,title,scope,made_from,created_by_agent_id from project_decks where owner_user_id=$1 and project_id=$2 and deleted_at is null order by created_at,id",
    [ownerUserId, projectId]
  );
  return Promise.all(
    decks.rows.map(async (d) => ({
      id: d.id,
      title: d.title,
      scope: d.scope,
      madeFrom: d.made_from,
      createdByAgentId: d.created_by_agent_id,
      cards: (
        await client.query<{
          id: string;
          question: string;
          answer: string;
          source_ref: string | null;
          topic_label: string | null;
        }>(
          "select id,question,answer,source_ref,topic_label from deck_cards where owner_user_id=$1 and deck_id=$2 and deleted_at is null order by created_at,id",
          [ownerUserId, d.id]
        )
      ).rows.map((c) => ({
        id: c.id,
        question: c.question,
        answer: c.answer,
        sourceRef: c.source_ref,
        topicLabel: c.topic_label
      }))
    }))
  );
};

// This runs inside the same transaction that removes the Personal Project's
// Team link. An old runner lease must become unusable before the link vanishes,
// while an established private Conversation may receive a new explicit prompt.
const detachSharedDispatches = async (
  client: pg.PoolClient,
  ownerUserId: string,
  personalProjectId: string,
  workspaceProjectId: string
) => {
  const executions = await client.query<{
    id: string;
    execution_generation: number;
    logical_session_id: string | null;
    provider_thread_id: string | null;
  }>(
    `select execution.id,execution.execution_generation,
            execution.logical_session_id,execution.provider_thread_id
       from managed_conversation_executions execution
      where execution.owner_user_id=$1 and execution.project_id=$2
        and exists (
          select 1 from managed_conversation_commands command
           where command.owner_user_id=execution.owner_user_id
             and command.execution_id=execution.id
             and command.command_kind='start'
             and command.idempotency_key like $3
        )
      order by execution.id for update of execution`,
    [ownerUserId, personalProjectId, `shared-work-item:${workspaceProjectId}:%`]
  );
  for (const execution of executions.rows) {
    const hasSession = Boolean(
      execution.logical_session_id && execution.provider_thread_id
    );
    if (
      Boolean(execution.logical_session_id) !==
      Boolean(execution.provider_thread_id)
    )
      throw new PersonalWorkspaceProjectConflictError(
        "Shared Agent Conversation identity needs reconciliation"
      );
    const generation = execution.execution_generation + 1;
    await client.query(
      `update managed_conversation_executions
      set execution_generation=$3,state_version=state_version+1,
          state=$4,fencing_token_hash=$5,runner_id=null,
          runner_lease_expires_at=null,last_error_code=null,updated_at=now()
      where id=$1 and owner_user_id=$2`,
      [
        execution.id,
        ownerUserId,
        generation,
        hasSession ? "running" : "failed",
        createHash("sha256").update(randomUUID()).digest("hex")
      ]
    );
    await client.query(
      `update managed_conversation_runtime_bindings
      set execution_generation=$3,updated_at=now()
      where execution_id=$1 and owner_user_id=$2`,
      [execution.id, ownerUserId, generation]
    );
    await client.query(
      `update managed_conversation_commands
      set state='canceled',blocked_on_kind=null,blocked_on_id=null,
          lease_token=null,lease_expires_at=null,
          last_error_code='shared_project_detached',updated_at=now()
      where owner_user_id=$1 and execution_id=$2
        and state in ('queued','blocked','dispatching','indeterminate')
        and execution_generation<$3`,
      [ownerUserId, execution.id, generation]
    );
    await client.query(
      `insert into managed_shared_dispatch_detachments
      (owner_user_id,execution_id,personal_project_id,workspace_project_id,
       detached_generation) values ($1,$2,$3,$4,$5)
      on conflict (owner_user_id,execution_id) do nothing`,
      [
        ownerUserId,
        execution.id,
        personalProjectId,
        workspaceProjectId,
        generation
      ]
    );
  }
};

export const createPersonalWorkspaceProjectRepository = (pool: pg.Pool) => ({
  async beginShare(
    ownerUserId: string,
    projectId: string,
    input: {
      teamBackendId: string;
      shareAttemptKey: string;
      targetTeamId: string;
      targetWorkspaceId: string;
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level serializable");
      const project = (
        await client.query<{
          version: number;
          workspace_project_id: string | null;
        }>(
          `
        select version,workspace_project_id from projects
         where id=$1 and owner_user_id=$2 and lifecycle='active'
           and deletion_phase is null for update`,
          [projectId, ownerUserId]
        )
      ).rows[0];
      if (!project || project.workspace_project_id)
        throw new PersonalWorkspaceProjectUnavailableError(
          "Personal Project unavailable for first share"
        );
      const existing = (
        await client.query<{
          team_backend_id: string;
          share_attempt_key: string;
          target_team_id: string | null;
          target_workspace_id: string | null;
          snapshot: unknown;
          manifest_hash: string;
          state: string;
        }>(
          `
        select * from personal_workspace_project_share_attempts
         where personal_project_id=$1 for update`,
          [projectId]
        )
      ).rows[0];
      if (existing && existing.state !== "canceled") {
        if (
          existing.state !== "pending" ||
          existing.team_backend_id !== input.teamBackendId ||
          existing.share_attempt_key !== input.shareAttemptKey ||
          existing.target_team_id !== input.targetTeamId ||
          existing.target_workspace_id !== input.targetWorkspaceId
        )
          throw new PersonalWorkspaceProjectConflictError(
            "A different first-share attempt exists"
          );
        await client.query("commit");
        return {
          snapshot: existing.snapshot,
          manifestHash: existing.manifest_hash
        };
      }
      if (existing && existing.share_attempt_key === input.shareAttemptKey)
        throw new PersonalWorkspaceProjectConflictError(
          "Canceled first-share attempts cannot be resumed"
        );
      const snapshot = await this.shareSnapshot(ownerUserId, projectId);
      if (
        !workspaceProjectCopySchema.safeParse({
          ...snapshot,
          expectedVersion: 1
        }).success ||
        !workspaceProjectCopyFitsTransport({ ...snapshot, expectedVersion: 1 })
      )
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project exceeds the supported first-share copy limits"
        );
      if (snapshot.personalProjectVersion !== project.version)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project changed during first share"
        );
      const manifestHash = workspaceProjectCopyManifestHash(snapshot);
      await client.query(
        existing
          ? `update personal_workspace_project_share_attempts set
          team_backend_id=$3,share_attempt_key=$4,target_team_id=$5,
          target_workspace_id=$6,manifest_hash=$7,snapshot=$8::jsonb,
          state='pending',updated_at=now()
          where personal_project_id=$1 and owner_user_id=$2`
          : `insert into personal_workspace_project_share_attempts
        (personal_project_id,owner_user_id,team_backend_id,share_attempt_key,
         target_team_id,target_workspace_id,manifest_hash,snapshot)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          projectId,
          ownerUserId,
          input.teamBackendId,
          input.shareAttemptKey,
          input.targetTeamId,
          input.targetWorkspaceId,
          manifestHash,
          JSON.stringify(snapshot)
        ]
      );
      await client.query("commit");
      return { snapshot, manifestHash };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async pendingShare(ownerUserId: string, projectId: string) {
    const result = await pool.query<{
      team_backend_id: string;
      share_attempt_key: string;
      target_team_id: string | null;
      target_workspace_id: string | null;
      state: string;
    }>(
      `select attempt.team_backend_id,attempt.share_attempt_key,
              attempt.target_team_id,attempt.target_workspace_id,attempt.state
         from personal_workspace_project_share_attempts attempt
         join projects project on project.id=attempt.personal_project_id
          and project.owner_user_id=attempt.owner_user_id
        where attempt.owner_user_id=$1 and attempt.personal_project_id=$2
          and project.lifecycle='active' and project.deletion_phase is null`,
      [ownerUserId, projectId]
    );
    const row = result.rows[0];
    return row && row.state === "pending"
      ? {
          teamBackendId: row.team_backend_id,
          shareAttemptKey: row.share_attempt_key,
          targetTeamId: row.target_team_id,
          targetWorkspaceId: row.target_workspace_id,
          state: "pending" as const
        }
      : null;
  },
  async shareAttempt(ownerUserId: string, projectId: string) {
    const row = (
      await pool.query<{
        team_backend_id: string;
        share_attempt_key: string;
        target_team_id: string | null;
        target_workspace_id: string | null;
        manifest_hash: string;
        snapshot: unknown;
        state: string;
      }>(
        `select attempt.team_backend_id,attempt.share_attempt_key,
        attempt.target_team_id,attempt.target_workspace_id,
        attempt.manifest_hash,attempt.snapshot,attempt.state
      from personal_workspace_project_share_attempts attempt
      join projects project on project.id=attempt.personal_project_id
        and project.owner_user_id=attempt.owner_user_id
      where attempt.owner_user_id=$1 and attempt.personal_project_id=$2
        and project.lifecycle='active' and project.deletion_phase is null`,
        [ownerUserId, projectId]
      )
    ).rows[0];
    const snapshot = row?.snapshot as
      | { personalProjectVersion?: unknown }
      | undefined;
    if (
      row &&
      (!snapshot ||
        !Number.isInteger(snapshot.personalProjectVersion) ||
        Number(snapshot.personalProjectVersion) < 1)
    )
      throw new PersonalWorkspaceProjectConflictError(
        "First-share snapshot changed"
      );
    return row
      ? {
          teamBackendId: row.team_backend_id,
          shareAttemptKey: row.share_attempt_key,
          targetTeamId: row.target_team_id,
          targetWorkspaceId: row.target_workspace_id,
          manifestHash: row.manifest_hash,
          personalProjectVersion: Number(snapshot!.personalProjectVersion),
          state: row.state
        }
      : null;
  },
  async cancelShare(
    ownerUserId: string,
    projectId: string,
    input: {
      teamBackendId: string;
      shareAttemptKey: string;
      targetTeamId: string;
      targetWorkspaceId: string;
      expectedManifestHash?: string;
      expectedPersonalProjectVersion?: number;
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level serializable");
      const project = await client.query<{
        workspace_project_id: string | null;
        version: number;
      }>(
        `select workspace_project_id,version from projects where id=$1 and owner_user_id=$2
          and lifecycle='active' and deletion_phase is null for update`,
        [projectId, ownerUserId]
      );
      if (!project.rows[0] || project.rows[0].workspace_project_id)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project share changed"
        );
      const attempt = await client.query<{
        state: string;
        manifest_hash: string;
        snapshot: unknown;
      }>(
        `select state,manifest_hash,snapshot from personal_workspace_project_share_attempts
          where personal_project_id=$1 and owner_user_id=$2
            and team_backend_id=$3 and share_attempt_key=$4
            and target_team_id=$5 and target_workspace_id=$6 for update`,
        [
          projectId,
          ownerUserId,
          input.teamBackendId,
          input.shareAttemptKey,
          input.targetTeamId,
          input.targetWorkspaceId
        ]
      );
      if (
        !attempt.rows[0] ||
        !["pending", "canceled"].includes(attempt.rows[0].state)
      )
        throw new PersonalWorkspaceProjectConflictError(
          "First-share attempt changed"
        );
      if (
        input.expectedManifestHash !== undefined &&
        (attempt.rows[0].manifest_hash !== input.expectedManifestHash ||
          project.rows[0].version !== input.expectedPersonalProjectVersion ||
          (attempt.rows[0].snapshot as { personalProjectVersion?: unknown })
            ?.personalProjectVersion !== input.expectedPersonalProjectVersion)
      )
        throw new PersonalWorkspaceProjectConflictError(
          "First-share snapshot changed during recovery"
        );
      if (attempt.rows[0].state === "pending")
        await client.query(
          `update personal_workspace_project_share_attempts
          set state='canceled',updated_at=now()
          where personal_project_id=$1 and owner_user_id=$2`,
          [projectId, ownerUserId]
        );
      await client.query("commit");
      return {
        canceled: true as const,
        shareAttemptKey: input.shareAttemptKey
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },
  async getLink(ownerUserId: string, projectId: string) {
    const result = await pool.query<{
      owner_user_id: string;
      team_backend_id: string | null;
      workspace_project_id: string | null;
    }>(
      `select owner_user_id,team_backend_id,workspace_project_id
      from projects where id=$1 and owner_user_id=$2 and lifecycle='active'`,
      [projectId, ownerUserId]
    );
    const row = result.rows[0];
    return row?.team_backend_id && row.workspace_project_id
      ? {
          ownerUserId: row.owner_user_id,
          teamBackendId: row.team_backend_id,
          workspaceProjectId: row.workspace_project_id
        }
      : null;
  },
  async getLinkedPersonalProject(
    ownerUserId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) {
    const row = (
      await pool.query<{ id: string }>(
        `select id from projects
      where owner_user_id=$1 and team_backend_id=$2 and workspace_project_id=$3
        and lifecycle='active'`,
        [ownerUserId, teamBackendId, workspaceProjectId]
      )
    ).rows[0];
    return row?.id ?? null;
  },
  async stageOwnedCopyBack(
    ownerUserId: string,
    input: {
      personalProjectId: string;
      teamBackendId: string;
      teamId: string;
      workspaceProjectId: string;
      ownerTeamMemberId: string;
      reviewedTeamVersion: number;
      reviewedMemberVersion: number;
      reviewedProjectVersion: number;
      ownedSetHash: string;
      leaveOperationId?: string;
      workItems: Array<{
        id: string;
        sourceOwnerTeamMemberId: string;
        sourceWorkItemId: string | null;
        kind: "todo" | "ticket";
        key: string | null;
        title: string;
        goal: string;
        status: "todo" | "doing" | "review" | "blocked" | "done";
        dueOn: string | null;
        doneAt: string | null;
      }>;
      decks?: CopyBackDeck[];
    }
  ) {
    const payloadHash = workspaceProjectCopyBackPayloadHash(
      input.workItems,
      input.decks ?? []
    );
    const conflict = input.leaveOperationId
      ? `on conflict (owner_user_id,team_backend_id,leave_operation_id,workspace_project_id)
           where leave_operation_id is not null
         do update set updated_at=now()
           where personal_workspace_project_copyback_stages.state='ready'
             and personal_workspace_project_copyback_stages.personal_project_id=excluded.personal_project_id
             and personal_workspace_project_copyback_stages.team_id=excluded.team_id
             and personal_workspace_project_copyback_stages.owner_team_member_id=excluded.owner_team_member_id
             and personal_workspace_project_copyback_stages.reviewed_team_version=excluded.reviewed_team_version
             and personal_workspace_project_copyback_stages.reviewed_member_version=excluded.reviewed_member_version
             and personal_workspace_project_copyback_stages.reviewed_project_version=excluded.reviewed_project_version
             and personal_workspace_project_copyback_stages.payload_hash=excluded.payload_hash
             and personal_workspace_project_copyback_stages.owned_set_hash=excluded.owned_set_hash`
      : `on conflict (owner_user_id,team_backend_id,workspace_project_id,reviewed_project_version)
           where leave_operation_id is null
         do update set updated_at=now()
           where personal_workspace_project_copyback_stages.state='staged'
             and personal_workspace_project_copyback_stages.personal_project_id=excluded.personal_project_id
             and personal_workspace_project_copyback_stages.team_id=excluded.team_id
             and personal_workspace_project_copyback_stages.owner_team_member_id=excluded.owner_team_member_id
             and personal_workspace_project_copyback_stages.reviewed_team_version=excluded.reviewed_team_version
             and personal_workspace_project_copyback_stages.reviewed_member_version=excluded.reviewed_member_version
             and personal_workspace_project_copyback_stages.payload_hash=excluded.payload_hash
             and personal_workspace_project_copyback_stages.owned_set_hash=excluded.owned_set_hash`;
    const row = (
      await pool.query<{ id: string; payload_hash: string }>(
        `
      insert into personal_workspace_project_copyback_stages
        (id,owner_user_id,personal_project_id,team_backend_id,team_id,
         workspace_project_id,owner_team_member_id,reviewed_team_version,
         reviewed_member_version,reviewed_project_version,owned_set_hash,
         payload_hash,work_items,decks,leave_operation_id,state)
      select $1,$2,project.id,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,
             case when $15::uuid is null then 'staged' else 'ready' end
        from projects project
       where project.id=$3 and project.owner_user_id=$2
         and project.team_backend_id=$4 and project.workspace_project_id=$6
         and project.lifecycle='active'
      ${conflict}
      returning id,payload_hash`,
        [
          randomUUID(),
          ownerUserId,
          input.personalProjectId,
          input.teamBackendId,
          input.teamId,
          input.workspaceProjectId,
          input.ownerTeamMemberId,
          input.reviewedTeamVersion,
          input.reviewedMemberVersion,
          input.reviewedProjectVersion,
          input.ownedSetHash,
          payloadHash,
          JSON.stringify(input.workItems),
          JSON.stringify(input.decks ?? []),
          input.leaveOperationId ?? null
        ]
      )
    ).rows[0];
    if (!row || row.payload_hash !== payloadHash)
      throw new PersonalWorkspaceProjectConflictError(
        "Copy-back stage changed"
      );
    return { stageId: row.id, payloadHash };
  },
  async getStagedCopyBack(ownerUserId: string, stageId: string) {
    const row = (
      await pool.query<{
        id: string;
        personal_project_id: string;
        team_backend_id: string;
        team_id: string;
        workspace_project_id: string;
        owner_team_member_id: string;
        reviewed_team_version: number;
        reviewed_member_version: number;
        reviewed_project_version: number;
        owned_set_hash: string;
        payload_hash: string;
        leave_operation_id: string | null;
        work_items: unknown;
        decks: unknown;
        state: string;
      }>(
        `select * from personal_workspace_project_copyback_stages
      where id=$1 and owner_user_id=$2`,
        [stageId, ownerUserId]
      )
    ).rows[0];
    return row
      ? {
          id: row.id,
          personalProjectId: row.personal_project_id,
          teamBackendId: row.team_backend_id,
          teamId: row.team_id,
          workspaceProjectId: row.workspace_project_id,
          ownerTeamMemberId: row.owner_team_member_id,
          reviewedTeamVersion: row.reviewed_team_version,
          reviewedMemberVersion: row.reviewed_member_version,
          reviewedProjectVersion: row.reviewed_project_version,
          ownedSetHash: row.owned_set_hash,
          payloadHash: row.payload_hash,
          leaveOperationId: row.leave_operation_id,
          workItems: row.work_items,
          decks: row.decks,
          state: row.state
        }
      : null;
  },
  async listTeamLeaveStageOperations(
    ownerUserId: string,
    teamBackendId: string,
    teamId: string,
    afterOperationId: string | null
  ) {
    const rows = await pool.query<{ leave_operation_id: string }>(
      `select distinct leave_operation_id
         from personal_workspace_project_copyback_stages
        where owner_user_id=$1 and team_backend_id=$2 and team_id=$3
          and leave_operation_id is not null
          and state in ('ready','applied')
          and ($4::uuid is null or leave_operation_id>$4::uuid)
        order by leave_operation_id limit 20`,
      [ownerUserId, teamBackendId, teamId, afterOperationId]
    );
    return rows.rows.map((row) => row.leave_operation_id);
  },
  async listTeamLeaveStageIds(
    ownerUserId: string,
    teamBackendId: string,
    teamId: string,
    operationId: string
  ) {
    const rows = await pool.query<{ id: string }>(
      `select id from personal_workspace_project_copyback_stages
        where owner_user_id=$1 and team_backend_id=$2 and team_id=$3
          and leave_operation_id=$4 and state in ('ready','applied')
        order by workspace_project_id limit 101`,
      [ownerUserId, teamBackendId, teamId, operationId]
    );
    if (rows.rows.length > 100)
      throw new PersonalWorkspaceProjectConflictError(
        "Team leave stage set is too large"
      );
    return rows.rows.map((row) => row.id);
  },
  async getStagedCopyBackForProject(
    ownerUserId: string,
    teamBackendId: string,
    workspaceProjectId: string
  ) {
    const row = (
      await pool.query<{ id: string }>(
        `
      select id from personal_workspace_project_copyback_stages
       where owner_user_id=$1 and team_backend_id=$2 and workspace_project_id=$3
         and (state='staged' or (state='ready' and leave_operation_id is not null))
       order by created_at desc limit 1`,
        [ownerUserId, teamBackendId, workspaceProjectId]
      )
    ).rows[0];
    return row ? this.getStagedCopyBack(ownerUserId, row.id) : null;
  },
  async bindPrincipal(
    ownerUserId: string,
    input: {
      teamBackendId: string;
      teamPrincipalUserId: string;
      localCredentialKeyId: string;
      teamCredentialKeyId: string;
    }
  ) {
    const bound = await pool.query<{ team_principal_user_id: string }>(
      `
      insert into personal_workspace_project_principal_bindings
        (local_user_id,team_backend_id,team_principal_user_id,
         local_credential_key_id,team_credential_key_id)
      values ($1,$2,$3,$4,$5)
      on conflict (local_user_id,team_backend_id) do update
        set local_credential_key_id=excluded.local_credential_key_id,
            team_credential_key_id=excluded.team_credential_key_id,
            updated_at=now()
        where personal_workspace_project_principal_bindings.team_principal_user_id=
              excluded.team_principal_user_id
      returning team_principal_user_id`,
      [
        ownerUserId,
        input.teamBackendId,
        input.teamPrincipalUserId,
        input.localCredentialKeyId,
        input.teamCredentialKeyId
      ]
    );
    if (bound.rows[0]?.team_principal_user_id !== input.teamPrincipalUserId)
      throw new PersonalWorkspaceProjectConflictError(
        "Enrolled Team principal changed"
      );
    return { teamPrincipalUserId: input.teamPrincipalUserId };
  },
  async principalBinding(ownerUserId: string, teamBackendId: string) {
    const row = (
      await pool.query<{ team_principal_user_id: string }>(
        `
      select team_principal_user_id
        from personal_workspace_project_principal_bindings
       where local_user_id=$1 and team_backend_id=$2`,
        [ownerUserId, teamBackendId]
      )
    ).rows[0];
    return row?.team_principal_user_id ?? null;
  },
  async shareSnapshot(ownerUserId: string, projectId: string) {
    const project = await pool.query<{ id: string; version: number }>(
      "select id,version from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null",
      [projectId, ownerUserId]
    );
    if (!project.rows[0])
      throw new PersonalWorkspaceProjectUnavailableError(
        "Personal Project unavailable"
      );
    const items = await pool.query<{
      id: string;
      kind: "todo" | "ticket";
      key: string | null;
      title: string;
      goal: string;
      status: "todo" | "doing" | "review" | "blocked" | "done";
      due_on: string | null;
      done_at: Date | null;
    }>(
      `
      select id,kind,key,title,goal,status,due_on,done_at
        from project_work_items
       where owner_user_id=$1 and project_id=$2 and deleted_at is null
       order by created_at,id`,
      [ownerUserId, projectId]
    );
    const sources = await pool.query<{
      id: string;
      name: string;
      kind: string;
      status: string;
      current_revision_id: string | null;
      verified_revision_id: string | null;
      personal_note_id: string | null;
    }>(
      `
      select source.id,source.name,source.kind,source.status,
             source.current_revision_id,
             revision.id as verified_revision_id,
             revision.note_id as personal_note_id
        from project_sources source
        left join personal_note_revisions revision
          on revision.id=source.current_revision_id
         and revision.owner_user_id=source.owner_user_id
         and revision.forgotten_at is null
       where source.owner_user_id=$1 and source.project_id=$2
         and source.deleted_at is null
       order by source.created_at,source.id`,
      [ownerUserId, projectId]
    );
    for (const source of sources.rows) {
      if (source.current_revision_id && !source.verified_revision_id)
        throw new PersonalWorkspaceProjectUnavailableError(
          "Project Source Note revision is unavailable"
        );
      if (
        source.kind === "doc" &&
        source.status === "ready" &&
        !source.verified_revision_id
      )
        throw new PersonalWorkspaceProjectUnavailableError(
          "Ready document has no real Personal Note revision"
        );
    }
    return {
      personalProjectVersion: project.rows[0].version,
      workItems: items.rows.map((item) => ({
        id: item.id,
        kind: item.kind,
        key: item.key,
        title: item.title,
        goal: item.goal,
        status: item.status,
        dueOn: item.due_on,
        doneAt: item.done_at?.toISOString() ?? null
      })),
      sources: sources.rows.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        status: source.status,
        personalNoteId: source.personal_note_id,
        personalNoteRevisionId: source.verified_revision_id
      })),
      decks: await deckSnapshot(pool, ownerUserId, projectId)
    };
  },

  async linkJoinedMember(
    ownerUserId: string,
    projectId: string,
    input: {
      expectedPersonalProjectVersion: number;
      teamBackendId: string;
      teamId: string;
      workspaceId: string;
      workspaceProjectId: string;
      teamPrincipalUserId: string;
      localCredentialKeyId: string;
      teamCredentialKeyId: string;
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level serializable");
      const current = (
        await client.query<{
          version: number;
          team_backend_id: string | null;
          team_workspace_id: string | null;
          workspace_project_id: string | null;
          project_share_policy_version: number | null;
        }>(
          `select version,team_backend_id,team_workspace_id,workspace_project_id,
                  project_share_policy_version
             from projects
            where id=$1 and owner_user_id=$2 and lifecycle='active'
              and deletion_phase is null for update`,
          [projectId, ownerUserId]
        )
      ).rows[0];
      if (!current)
        throw new PersonalWorkspaceProjectUnavailableError(
          "Personal Project unavailable"
        );
      const binding = (
        await client.query<{ team_principal_user_id: string }>(
          `select team_principal_user_id
             from personal_workspace_project_principal_bindings
            where local_user_id=$1 and team_backend_id=$2 for update`,
          [ownerUserId, input.teamBackendId]
        )
      ).rows[0];
      if (
        binding &&
        binding.team_principal_user_id !== input.teamPrincipalUserId
      )
        throw new PersonalWorkspaceProjectConflictError(
          "Enrolled Team principal changed"
        );
      if (current.workspace_project_id !== null) {
        if (
          current.workspace_project_id !== input.workspaceProjectId ||
          current.team_backend_id !== input.teamBackendId ||
          current.team_workspace_id !== input.workspaceId ||
          !binding
        )
          throw new PersonalWorkspaceProjectConflictError(
            "Personal Project link changed"
          );
        await client.query(
          `update personal_workspace_project_principal_bindings
              set local_credential_key_id=$4,team_credential_key_id=$5,
                  updated_at=now()
            where local_user_id=$1 and team_backend_id=$2
              and team_principal_user_id=$3`,
          [
            ownerUserId,
            input.teamBackendId,
            input.teamPrincipalUserId,
            input.localCredentialKeyId,
            input.teamCredentialKeyId
          ]
        );
        await client.query("commit");
        return { projectId, version: current.version, linked: true as const };
      }
      if (current.version !== input.expectedPersonalProjectVersion)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project version changed"
        );
      if (
        current.team_backend_id !== null ||
        current.team_workspace_id !== null ||
        current.project_share_policy_version !== null
      )
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project already has a Team link or policy"
        );
      const occupied = (
        await client.query<{ occupied: boolean }>(
          `select (
            exists(select 1 from personal_workspace_project_share_attempts
                   where personal_project_id=$1)
            or exists(select 1 from project_work_items where project_id=$1)
            or exists(select 1 from project_sources where project_id=$1)
            or exists(select 1 from project_decks where project_id=$1)
            or exists(select 1 from scheduled_jobs where project_id=$1)
            or exists(select 1 from project_local_contexts where project_id=$1)
            or exists(select 1 from project_policy_session_grants where project_id=$1)
            or exists(select 1 from project_share_policy_attempts where project_id=$1)
            or exists(select 1 from project_share_policy_signing_keys where project_id=$1)
            or exists(select 1 from curated_memory_assertions where project_id=$1)
            or exists(select 1 from curated_memory_classification_operations
                      where target_project_id=$1)
            or exists(select 1 from sessions
                      where automatic_personal_project_id=$1
                         or project_override_personal_project_id=$1)
            or exists(select 1 from managed_conversation_executions
                      where project_id=$1::text)
          ) as occupied`,
          [projectId]
        )
      ).rows[0]?.occupied;
      if (occupied)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project contains private content or a pending share"
        );
      if (binding) {
        await client.query(
          `update personal_workspace_project_principal_bindings
              set local_credential_key_id=$4,team_credential_key_id=$5,
                  updated_at=now()
            where local_user_id=$1 and team_backend_id=$2
              and team_principal_user_id=$3`,
          [
            ownerUserId,
            input.teamBackendId,
            input.teamPrincipalUserId,
            input.localCredentialKeyId,
            input.teamCredentialKeyId
          ]
        );
      } else {
        const bound = await client.query<{ team_principal_user_id: string }>(
          `insert into personal_workspace_project_principal_bindings
             (local_user_id,team_backend_id,team_principal_user_id,
              local_credential_key_id,team_credential_key_id)
           values ($1,$2,$3,$4,$5)
           on conflict (local_user_id,team_backend_id) do update
             set local_credential_key_id=excluded.local_credential_key_id,
                 team_credential_key_id=excluded.team_credential_key_id,
                 updated_at=now()
             where personal_workspace_project_principal_bindings.team_principal_user_id=
                   excluded.team_principal_user_id
           returning team_principal_user_id`,
          [
            ownerUserId,
            input.teamBackendId,
            input.teamPrincipalUserId,
            input.localCredentialKeyId,
            input.teamCredentialKeyId
          ]
        );
        if (bound.rows[0]?.team_principal_user_id !== input.teamPrincipalUserId)
          throw new PersonalWorkspaceProjectConflictError(
            "Enrolled Team principal changed"
          );
      }
      const updated = await client.query<{ version: number }>(
        `update projects
            set team_backend_id=$3,team_workspace_id=$4,workspace_project_id=$5,
                share_policy_link_epoch=gen_random_uuid(),version=version+1,
                updated_at=now()
          where id=$1 and owner_user_id=$2 returning version`,
        [
          projectId,
          ownerUserId,
          input.teamBackendId,
          input.workspaceId,
          input.workspaceProjectId
        ]
      );
      await client.query("commit");
      return {
        projectId,
        version: updated.rows[0]!.version,
        linked: true as const
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async markMoved(
    ownerUserId: string,
    projectId: string,
    input: {
      expectedPersonalProjectVersion: number;
      expectedManifestHash: string;
      teamBackendId: string;
      teamId: string;
      workspaceId: string;
      workspaceProjectId: string;
      deckCopyMap?: Array<{
        sourceDeckId: string;
        deckId: string;
        sourceCardId: string;
        cardId: string;
      }>;
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level serializable");
      const selected = await client.query<{
        version: number;
        team_backend_id: string | null;
        team_workspace_id: string | null;
        workspace_project_id: string | null;
      }>(
        `
        select version,team_backend_id,team_workspace_id,workspace_project_id
          from projects
         where id=$1 and owner_user_id=$2 and lifecycle='active'
         for update`,
        [projectId, ownerUserId]
      );
      const current = selected.rows[0];
      if (!current)
        throw new PersonalWorkspaceProjectUnavailableError(
          "Personal Project unavailable"
        );
      if (
        current.workspace_project_id === input.workspaceProjectId &&
        current.team_workspace_id === input.workspaceId &&
        current.team_backend_id === input.teamBackendId
      ) {
        await client.query("commit");
        return { projectId, version: current.version, moved: true as const };
      }
      if (
        current.version !== input.expectedPersonalProjectVersion ||
        current.workspace_project_id !== null
      )
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project link changed"
        );
      const pending = (
        await client.query<{
          manifest_hash: string;
          state: string;
          target_team_id: string | null;
          target_workspace_id: string | null;
        }>(
          `
        select manifest_hash,state,target_team_id,target_workspace_id
          from personal_workspace_project_share_attempts
         where personal_project_id=$1 and owner_user_id=$2 for update`,
          [projectId, ownerUserId]
        )
      ).rows[0];
      if (
        !pending ||
        pending.state !== "pending" ||
        pending.manifest_hash !== input.expectedManifestHash ||
        pending.target_team_id !== input.teamId ||
        pending.target_workspace_id !== input.workspaceId
      )
        throw new PersonalWorkspaceProjectConflictError(
          "First-share attempt changed"
        );
      const items = await client.query<{
        id: string;
        kind: string;
        key: string | null;
        title: string;
        goal: string;
        status: string;
        due_on: string | null;
        done_at: Date | null;
      }>(
        `select id,kind,key,title,goal,status,due_on,done_at from project_work_items
        where owner_user_id=$1 and project_id=$2 and deleted_at is null
        order by created_at,id for share`,
        [ownerUserId, projectId]
      );
      const sources = await client.query<{
        id: string;
        name: string;
        kind: string;
        status: string;
        current_revision_id: string | null;
        verified_revision_id: string | null;
        personal_note_id: string | null;
      }>(
        `select source.id,source.name,source.kind,source.status,
          source.current_revision_id,revision.id as verified_revision_id,
          revision.note_id as personal_note_id
        from project_sources source
        left join personal_note_revisions revision
          on revision.id=source.current_revision_id
         and revision.owner_user_id=source.owner_user_id
         and revision.forgotten_at is null
        where source.owner_user_id=$1 and source.project_id=$2
          and source.deleted_at is null
        order by source.created_at,source.id for share of source`,
        [ownerUserId, projectId]
      );
      if (
        sources.rows.some(
          (source) =>
            (source.current_revision_id && !source.verified_revision_id) ||
            (source.kind === "doc" &&
              source.status === "ready" &&
              !source.verified_revision_id)
        )
      )
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Note revision changed"
        );
      const currentDecks = await deckSnapshot(client, ownerUserId, projectId);
      const currentManifestHash = workspaceProjectCopyManifestHash({
        personalProjectVersion: current.version,
        workItems: items.rows.map((item) => ({
          id: item.id,
          kind: item.kind,
          key: item.key,
          title: item.title,
          goal: item.goal,
          status: item.status,
          dueOn: item.due_on,
          doneAt: item.done_at?.toISOString() ?? null
        })),
        sources: sources.rows.map((source) => ({
          id: source.id,
          name: source.name,
          kind: source.kind,
          status: source.status,
          personalNoteId: source.personal_note_id,
          personalNoteRevisionId: source.verified_revision_id
        })),
        decks: currentDecks
      });
      if (currentManifestHash !== input.expectedManifestHash)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project changed after Team copy"
        );
      const expectedCards = currentDecks.flatMap((d) =>
        d.cards.map((c) => `${d.id}:${c.id}`)
      );
      const copyMap = input.deckCopyMap ?? [];
      const mapKeys = copyMap.map((m) => `${m.sourceDeckId}:${m.sourceCardId}`);
      if (
        copyMap.length !== expectedCards.length ||
        new Set(mapKeys).size !== mapKeys.length ||
        expectedCards.some((key) => !mapKeys.includes(key)) ||
        new Set(copyMap.map((m) => m.cardId)).size !== copyMap.length
      )
        throw new PersonalWorkspaceProjectConflictError(
          "Team Deck copy map changed"
        );
      for (const mapped of copyMap) {
        await client.query(
          `update deck_card_progress
        set team_backend_id=$3,workspace_project_id=$4,deck_id=$5,card_id=$6,updated_at=now()
        where owner_user_id=$1 and personal_project_id=$2 and deck_id=$7 and card_id=$8`,
          [
            ownerUserId,
            projectId,
            input.teamBackendId,
            input.workspaceProjectId,
            mapped.deckId,
            mapped.cardId,
            mapped.sourceDeckId,
            mapped.sourceCardId
          ]
        );
        await remapDeckAgainNote(
          client,
          ownerUserId,
          `${projectId}:personal`,
          mapped.sourceCardId,
          `${projectId}:${input.teamBackendId}:${input.workspaceProjectId}`,
          mapped.cardId
        );
      }
      const updated = await client.query<{ version: number }>(
        `
        update projects
           set team_backend_id=$3,team_workspace_id=$4,workspace_project_id=$5,
               share_policy_link_epoch=gen_random_uuid(),
               project_share_policy_version=null,
               project_share_policy_device_credential_id=null,
               project_share_policy_enabled_at=null,
               version=version+1,updated_at=now()
         where id=$1 and owner_user_id=$2 returning version`,
        [
          projectId,
          ownerUserId,
          input.teamBackendId,
          input.workspaceId,
          input.workspaceProjectId
        ]
      );
      await client.query(
        `update personal_workspace_project_share_attempts
         set state='confirmed',updated_at=now() where personal_project_id=$1`,
        [projectId]
      );
      await client.query("commit");
      return {
        projectId,
        version: updated.rows[0]!.version,
        moved: true as const
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async copyBackOwnedProject(
    ownerUserId: string,
    projectId: string,
    input: {
      stageId?: string;
      workspaceProjectId: string;
      ownerTeamMemberId: string;
      workItems: Array<{
        id: string;
        sourceOwnerTeamMemberId: string;
        sourceWorkItemId: string | null;
        kind: "todo" | "ticket";
        key: string | null;
        title: string;
        goal: string;
        status: "todo" | "doing" | "review" | "blocked" | "done";
        dueOn: string | null;
        doneAt: string | null;
      }>;
      decks?: CopyBackDeck[];
    }
  ) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (input.stageId) {
        const stage = await client.query<{
          state: string;
          payload_hash: string;
        }>(
          `
          select state,payload_hash from personal_workspace_project_copyback_stages
           where id=$1 and owner_user_id=$2 and personal_project_id=$3
             and workspace_project_id=$4 for update`,
          [input.stageId, ownerUserId, projectId, input.workspaceProjectId]
        );
        if (stage.rows[0]?.state === "applied") {
          await client.query("commit");
          return {
            projectId,
            copied: input.workItems.length,
            alreadyApplied: true
          };
        }
        const activeStage = stage.rows[0];
        if (
          !activeStage ||
          !["staged", "ready"].includes(activeStage.state) ||
          activeStage.payload_hash !==
            createHash("sha256")
              .update(
                canonicalJson(copyBackPayload(input.workItems, input.decks))
              )
              .digest("hex")
        )
          throw new PersonalWorkspaceProjectConflictError(
            "Copy-back stage changed"
          );
      }
      const project = await client.query<{
        workspace_project_id: string | null;
        team_backend_id: string | null;
      }>(
        `
        select workspace_project_id,team_backend_id from projects
         where id=$1 and owner_user_id=$2 and lifecycle='active'
         for update`,
        [projectId, ownerUserId]
      );
      if (project.rows[0]?.workspace_project_id !== input.workspaceProjectId)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project Workspace link changed before copy-back"
        );
      for (const item of input.workItems) {
        const sourceIsOwner =
          item.sourceOwnerTeamMemberId === input.ownerTeamMemberId;
        const sourceId = sourceIsOwner ? item.sourceWorkItemId : null;
        let existing: { id: string } | undefined;
        if (sourceId) {
          const found = await client.query<{ id: string }>(
            `
            select id from project_work_items
             where id=$1 and owner_user_id=$2 and project_id=$3 for update`,
            [sourceId, ownerUserId, projectId]
          );
          existing = found.rows[0];
        }
        if (!existing) {
          const found = await client.query<{ id: string }>(
            `
            select id from project_work_items
             where owner_user_id=$1 and project_id=$2
               and origin='team_copy_back' and idempotency_key=$3 for update`,
            [ownerUserId, projectId, item.id]
          );
          existing = found.rows[0];
        }
        if (existing) {
          await client.query(
            `
            update project_work_items
               set key=$4,title=$5,goal=$6,status=$7,due_on=$8,done_at=$9,
                   version=version+1,updated_at=now()
             where id=$1 and owner_user_id=$2 and project_id=$3
               and (key,title,goal,status,due_on,done_at)
                   is distinct from ($4,$5,$6,$7,$8::date,$9::timestamptz)`,
            [
              existing.id,
              ownerUserId,
              projectId,
              item.key,
              item.title,
              item.goal,
              item.status,
              item.dueOn,
              item.doneAt
            ]
          );
        } else {
          const payloadHash = createHash("sha256")
            .update(JSON.stringify(item))
            .digest("hex");
          await client.query(
            `
            insert into project_work_items
              (id,owner_user_id,project_id,kind,key,title,goal,origin,
               origin_ref,idempotency_key,creation_payload_hash,status,due_on,done_at,created_by)
            values ($1,$2,$3,$4,$5,$6,$7,'team_copy_back',$8,$8,$9,$10,$11,$12,$2)
            on conflict do nothing`,
            [
              randomUUID(),
              ownerUserId,
              projectId,
              item.kind,
              item.key,
              item.title,
              item.goal,
              item.id,
              payloadHash,
              item.status,
              item.dueOn,
              item.doneAt
            ]
          );
        }
      }
      // This Project had no Personal Deck writes while linked. Hide the old
      // first-share set before replaying the reviewed active Team snapshot;
      // Team-deleted Decks and Cards must not reappear when the link clears.
      await client.query(
        `update deck_cards set deleted_at=now(),version=version+1,updated_at=now()
         where owner_user_id=$1 and deleted_at is null and deck_id in
           (select id from project_decks where owner_user_id=$1 and project_id=$2)`,
        [ownerUserId, projectId]
      );
      await client.query(
        `update project_decks set deleted_at=now(),version=version+1,updated_at=now()
         where owner_user_id=$1 and project_id=$2 and deleted_at is null`,
        [ownerUserId, projectId]
      );
      for (const deck of input.decks ?? []) {
        const ownSource =
          deck.sourceOwnerTeamMemberId === input.ownerTeamMemberId;
        const existing =
          ownSource && deck.sourceDeckId
            ? (
                await client.query<{ id: string }>(
                  "select id from project_decks where id=$1 and owner_user_id=$2 and project_id=$3 for update",
                  [deck.sourceDeckId, ownerUserId, projectId]
                )
              ).rows[0]
            : null;
        const localDeckId = existing?.id ?? randomUUID();
        if (existing)
          await client.query(
            `update project_decks set title=$4,scope=$5,made_from=$6,deleted_at=null,version=version+1,updated_at=now() where id=$1 and owner_user_id=$2 and project_id=$3`,
            [
              localDeckId,
              ownerUserId,
              projectId,
              deck.title,
              deck.scope,
              deck.madeFrom
            ]
          );
        else
          await client.query(
            `insert into project_decks(id,owner_user_id,project_id,title,scope,made_from,idempotency_key,creation_payload_hash) values($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              localDeckId,
              ownerUserId,
              projectId,
              deck.title,
              deck.scope,
              deck.madeFrom,
              deck.id,
              createHash("sha256").update(canonicalJson(deck)).digest("hex")
            ]
          );
        for (const card of deck.cards) {
          const ownCard =
            ownSource && card.sourceCardId
              ? (
                  await client.query<{ id: string }>(
                    "select id from deck_cards where id=$1 and owner_user_id=$2 and deck_id=$3 for update",
                    [card.sourceCardId, ownerUserId, localDeckId]
                  )
                ).rows[0]
              : null;
          const localCardId = ownCard?.id ?? randomUUID();
          if (ownCard)
            await client.query(
              `update deck_cards set question=$4,answer=$5,source_ref=$6,topic_label=$7,deleted_at=null,version=version+1,updated_at=now() where id=$1 and owner_user_id=$2 and deck_id=$3`,
              [
                localCardId,
                ownerUserId,
                localDeckId,
                card.question,
                card.answer,
                card.sourceRef,
                card.topicLabel
              ]
            );
          else
            await client.query(
              `insert into deck_cards(id,owner_user_id,deck_id,question,answer,source_ref,topic_label) values($1,$2,$3,$4,$5,$6,$7)`,
              [
                localCardId,
                ownerUserId,
                localDeckId,
                card.question,
                card.answer,
                card.sourceRef,
                card.topicLabel
              ]
            );
          await client.query(
            `update deck_card_progress set deck_id=$5,card_id=$6,team_backend_id=null,workspace_project_id=null,updated_at=now() where owner_user_id=$1 and personal_project_id=$2 and deck_id=$3 and card_id=$4`,
            [ownerUserId, projectId, deck.id, card.id, localDeckId, localCardId]
          );
          await remapDeckAgainNote(
            client,
            ownerUserId,
            `${projectId}:${project.rows[0].team_backend_id}:${project.rows[0].workspace_project_id}`,
            card.id,
            `${projectId}:personal`,
            localCardId
          );
        }
      }
      if (input.stageId) {
        if (!project.rows[0].team_backend_id)
          throw new PersonalWorkspaceProjectConflictError(
            "Personal Project Team backend changed"
          );
        await client.query(
          `insert into personal_workspace_project_reconciliations
          (owner_user_id,personal_project_id,team_backend_id,workspace_project_id,reason)
          values ($1,$2,$3,$4,'copy_back') on conflict do nothing`,
          [
            ownerUserId,
            projectId,
            project.rows[0].team_backend_id,
            input.workspaceProjectId
          ]
        );
        await pauseScheduledJobsWithClient(client, ownerUserId, {
          projectId,
          reason: "shared_project_copy_back"
        });
        await detachSharedDispatches(
          client,
          ownerUserId,
          projectId,
          input.workspaceProjectId
        );
        await client.query(
          `update sessions session
           set project_override_personal_project_id=null,
               automatic_personal_project_id=null,
               project_assignment_version=project_assignment_version+1,
               updated_at=now()
         where session.owner_user_id=$1
           and (session.project_override_personal_project_id=$2
             or session.automatic_personal_project_id=$2)
           and not exists (select 1 from managed_conversation_executions execution
             where execution.logical_session_id=session.logical_session_id
               and execution.owner_user_id=$1 and execution.is_project_hq)`,
          [ownerUserId, projectId]
        );
        await client.query(
          `update projects
           set team_backend_id=null,team_workspace_id=null,
               workspace_project_id=null,share_policy_link_epoch=gen_random_uuid(),
               project_share_policy_version=null,
               project_share_policy_device_credential_id=null,
               project_share_policy_enabled_at=null,
               version=version+1,updated_at=now()
           where id=$1 and owner_user_id=$2`,
          [projectId, ownerUserId]
        );
        await client.query(
          `update personal_workspace_project_copyback_stages
           set state='applied',applied_at=now(),updated_at=now() where id=$1`,
          [input.stageId]
        );
      }
      await client.query("commit");
      return { projectId, copied: input.workItems.length };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  },

  async reconcileInvalidation(
    ownerUserId: string,
    projectId: string,
    workspaceProjectId: string
  ) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const project = await client.query<{
        workspace_project_id: string | null;
        team_backend_id: string | null;
      }>(
        `
        select workspace_project_id,team_backend_id from projects
         where id=$1 and owner_user_id=$2 for update`,
        [projectId, ownerUserId]
      );
      if (!project.rows[0])
        throw new PersonalWorkspaceProjectUnavailableError(
          "Personal Project unavailable"
        );
      if (project.rows[0].workspace_project_id !== workspaceProjectId) {
        await client.query("commit");
        return { projectId, detached: 0, cleared: false };
      }
      if (!project.rows[0].team_backend_id)
        throw new PersonalWorkspaceProjectConflictError(
          "Personal Project Team backend changed"
        );
      await client.query(
        `insert into personal_workspace_project_reconciliations
        (owner_user_id,personal_project_id,team_backend_id,workspace_project_id,reason)
        values ($1,$2,$3,$4,'invalidation') on conflict do nothing`,
        [
          ownerUserId,
          projectId,
          project.rows[0].team_backend_id,
          workspaceProjectId
        ]
      );
      await pauseScheduledJobsWithClient(client, ownerUserId, {
        projectId,
        reason: "shared_project_invalidation"
      });
      await detachSharedDispatches(
        client,
        ownerUserId,
        projectId,
        workspaceProjectId
      );
      const detached = await client.query(
        `
        update sessions session
           set project_override_personal_project_id=null,
               automatic_personal_project_id=null,
               project_assignment_version=project_assignment_version+1,
               updated_at=now()
         where session.owner_user_id=$1
           and (session.project_override_personal_project_id=$2
             or session.automatic_personal_project_id=$2)
           and not exists (
             select 1 from managed_conversation_executions execution
              where execution.logical_session_id=session.logical_session_id
                and execution.owner_user_id=$1 and execution.is_project_hq
           )`,
        [ownerUserId, projectId]
      );
      await client.query(
        `
        update projects
           set team_backend_id=null,team_workspace_id=null,
               workspace_project_id=null,share_policy_link_epoch=gen_random_uuid(),
               project_share_policy_version=null,
               project_share_policy_device_credential_id=null,
               project_share_policy_enabled_at=null,
               version=version+1,updated_at=now()
         where id=$1 and owner_user_id=$2`,
        [projectId, ownerUserId]
      );
      await client.query("commit");
      return { projectId, detached: detached.rowCount ?? 0, cleared: true };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
});

export type PersonalWorkspaceProjectRepository = ReturnType<
  typeof createPersonalWorkspaceProjectRepository
>;
