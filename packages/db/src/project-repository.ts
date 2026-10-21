import pg from "pg";
import { randomUUID } from "node:crypto";
import { appendCollaborationOutboxEventWithClient } from "./collaboration-repository.js";

export interface VerifiedLocalProjectContext {
  sourceKind: "codex" | "claude-code" | "pi";
  ownerUserId: string;
  deviceId: string;
  localProjectId: string;
  displayName: string;
  commonDirHash: string | null;
  gitDirHash: string | null;
  folderHash: string;
  /** True only after local Git membership and retained checkout history agree. */
  verifiedNewLinkedCheckout: boolean;
  hasRemoteCandidate: boolean;
  hasMovedCheckoutCandidate: boolean;
  /** Local evidence changed after an earlier confirmation; await a fresh choice. */
  requiresConfirmation?: boolean;
  /** An exact, locally persisted User choice. */
  confirmedProjectId?: string;
  confirmedSeparate?: boolean;
  /** Monotone, KOED_HOME-persisted User confirmation for this exact context. */
  confirmationVersion?: number;
  sessionId: string;
  artifactId: string;
  minimumProviderCursorOffset: number;
  externalSessionId: string;
  /** Snapshot from the trusted local edge before capture began. */
  captureSharePolicy?: {
    projectId: string;
    workspaceProjectId: string;
    policyVersion: number;
    linkEpoch: string;
    deviceCredentialId: string;
    associationVersion: number;
    preparedAt: string;
  };
}

export interface ProjectAssociationResult {
  state: "resolved" | "unresolved" | "session_missing";
  projectId: string | null;
  sessionAssigned: boolean;
  reason?: string;
}

export interface ProjectRepository {
  associateVerifiedCapturedSession(
    input: VerifiedLocalProjectContext
  ): Promise<ProjectAssociationResult>;
  backfillLegacyProjectOverrides(
    ownerUserId: string,
    limit?: number
  ): Promise<{ mapped: number; ambiguous: number }>;
}

type ContextRow = {
  project_id: string | null;
  git_dir_hash: string | null;
  folder_hash: string | null;
  association_state: "resolved" | "unresolved";
  association_version: number;
  lifecycle: "active" | "deleted" | null;
  deletion_phase: string | null;
  last_confirmation_version: number;
};

const shortKey = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 8)
    .toUpperCase() || "PROJECT";

export const createProjectRepository = (pool: pg.Pool): ProjectRepository => ({
  async associateVerifiedCapturedSession(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const session = await client.query<{
        id: string;
        logical_session_id: string;
        cwd: string | null;
        automatic_personal_project_id: string | null;
        project_override_personal_project_id: string | null;
        project_override_id: string | null;
        project_override_at: Date | null;
        created_at: Date;
      }>(
        `select id,logical_session_id,cwd, automatic_personal_project_id, project_override_personal_project_id, project_override_id, project_override_at, created_at
           from sessions
          where id=$1 and owner_user_id=$2 and external_session_id=$3
            and visibility='personal' and invalidated_at is null
            and exists (
              select 1 from conversation_source_artifacts a
               where a.session_id=sessions.id and a.owner_user_id=$2
                 and a.external_session_id=$3 and a.source_kind=$6
                 and a.id=$4 and a.provider_cursor_offset >= $5
            )
          order by created_at asc, id asc limit 1
          for update`,
        [
          input.sessionId,
          input.ownerUserId,
          input.externalSessionId,
          input.artifactId,
          input.minimumProviderCursorOffset,
          input.sourceKind
        ]
      );
      const found = session.rows[0];
      if (!found) {
        await client.query("commit");
        return {
          state: "session_missing",
          projectId: null,
          sessionAssigned: false
        };
      }
      // A Project HQ execution is server-owned and has a stable private path.
      // Resolve it before ordinary local-path association can create a second
      // Personal Project for the managed runtime's isolated directory.
      const privateExecution = await client.query<{
        project_id: string;
      }>(
        `select execution.project_id
           from managed_conversation_executions execution
           left join managed_conversation_runtime_bindings binding
             on binding.execution_id=execution.id
            and binding.owner_user_id=execution.owner_user_id
          where execution.owner_user_id=$1 and execution.runner_device_id=$2
            and execution.is_project_hq
            and (execution.logical_session_id=$4
              or binding.local_session_id=$3
              or (execution.hq_private_path=$5 and not exists (
                select 1 from managed_conversation_executions ordinary
                where ordinary.owner_user_id=$1
                  and ordinary.logical_session_id=$4
                  and not ordinary.is_project_hq
              )))
          order by case when execution.logical_session_id=$4
            then 0 when binding.local_session_id=$3 then 1 else 2 end
          limit 1 for share of execution`,
        [
          input.ownerUserId,
          input.deviceId,
          found.id,
          found.logical_session_id,
          found.cwd
        ]
      );
      if (privateExecution.rows[0]) {
        const hq = privateExecution.rows[0];
        const project = await client.query(
          `select id from projects where id::text=$1 and owner_user_id=$2
             and lifecycle='active' and deletion_phase is null for share`,
          [hq.project_id, input.ownerUserId]
        );
        const active = Boolean(project.rows[0]);
        const assigned =
          active &&
          !found.project_override_id &&
          !found.project_override_personal_project_id &&
          (!found.automatic_personal_project_id ||
            found.automatic_personal_project_id === hq.project_id)
            ? await client.query(
                `update sessions set automatic_personal_project_id=$3,updated_at=now()
                where id=$1 and owner_user_id=$2
                  and project_override_personal_project_id is null
                  and project_override_id is null`,
                [found.id, input.ownerUserId, hq.project_id]
              )
            : null;
        await client.query("commit");
        return {
          state: active ? "resolved" : "unresolved",
          projectId: active ? hq.project_id : null,
          sessionAssigned: Boolean(assigned?.rowCount),
          ...(active ? {} : { reason: "project_unavailable" })
        };
      }
      const groupLock = `personal-project:${input.ownerUserId}:${input.deviceId}:${input.commonDirHash ?? input.localProjectId}`;
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [groupLock]
      );
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [
          `personal-project-local:${input.ownerUserId}:${input.deviceId}:${input.localProjectId}`
        ]
      );
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`personal-project-owner-key:${input.ownerUserId}`]
      );
      const exact = await client.query<ContextRow>(
        `select c.project_id,c.git_dir_hash,c.folder_hash,c.association_state,c.association_version,c.last_confirmation_version,p.lifecycle,p.deletion_phase
           from project_local_contexts c
           left join projects p on p.id=c.project_id and p.owner_user_id=c.owner_user_id
          where c.owner_user_id=$1 and c.device_id=$2 and c.local_project_id=$3
          for update of c`,
        [input.ownerUserId, input.deviceId, input.localProjectId]
      );
      if (input.requiresConfirmation) {
        await client.query("commit");
        return {
          state: "unresolved",
          projectId: null,
          sessionAssigned: false,
          reason: "local_identity_changed"
        };
      }
      let projectId = exact.rows[0]?.project_id ?? null;
      let createdProjectId: string | null = null;
      let reason: string | undefined;
      const exactActive = Boolean(
        projectId &&
        exact.rows[0]?.lifecycle === "active" &&
        exact.rows[0]?.deletion_phase === null
      );
      const requestedConfirmation = Boolean(
        input.confirmedProjectId || input.confirmedSeparate
      );
      if (
        requestedConfirmation &&
        (!Number.isSafeInteger(input.confirmationVersion) ||
          (input.confirmationVersion ?? 0) < 1)
      ) {
        throw new Error(
          "Project confirmation requires a durable context version"
        );
      }
      const confirmationCurrent =
        requestedConfirmation &&
        !exactActive &&
        (input.confirmationVersion ?? 0) >
          (exact.rows[0]?.last_confirmation_version ?? 0);
      const confirmedProjectId = confirmationCurrent
        ? input.confirmedProjectId
        : undefined;
      const confirmedSeparate = confirmationCurrent
        ? input.confirmedSeparate
        : undefined;
      if (exact.rows[0] && confirmedProjectId) {
        const chosen = await client.query<{ id: string }>(
          `select id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null`,
          [confirmedProjectId, input.ownerUserId]
        );
        projectId = chosen.rows[0]?.id ?? null;
        if (projectId) {
          await client.query(
            `update project_local_contexts set project_id=$4,association_state='resolved',
               association_version=association_version+1,
               last_confirmation_version=$5,last_seen_at=now()
              where owner_user_id=$1 and device_id=$2 and local_project_id=$3`,
            [
              input.ownerUserId,
              input.deviceId,
              input.localProjectId,
              projectId,
              input.confirmationVersion
            ]
          );
        } else reason = "confirmed_project_unavailable";
      } else if (!exact.rows[0] || confirmedSeparate) {
        const candidates = input.commonDirHash
          ? await client.query<ContextRow>(
              `select c.project_id,c.git_dir_hash,c.folder_hash,c.association_state,c.association_version,p.lifecycle,p.deletion_phase
                 from project_local_contexts c
                 left join projects p on p.id=c.project_id and p.owner_user_id=c.owner_user_id
                where c.owner_user_id=$1 and c.device_id=$2 and c.common_dir_hash=$3
                for update of c`,
              [input.ownerUserId, input.deviceId, input.commonDirHash]
            )
          : { rows: [] as ContextRow[] };
        const uniqueProjects = [
          ...new Set(
            candidates.rows
              .map((row) => row.project_id)
              .filter((id): id is string => Boolean(id))
          )
        ];
        const movedCheckout = candidates.rows.some(
          (row) =>
            row.git_dir_hash &&
            row.git_dir_hash === input.gitDirHash &&
            row.folder_hash !== input.folderHash
        );
        if (confirmedProjectId) {
          const chosen = await client.query<{ id: string }>(
            `select id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null`,
            [confirmedProjectId, input.ownerUserId]
          );
          projectId = chosen.rows[0]?.id ?? null;
          if (!projectId) reason = "confirmed_project_unavailable";
        } else if (
          !confirmedSeparate &&
          input.verifiedNewLinkedCheckout &&
          !movedCheckout &&
          uniqueProjects.length === 1 &&
          candidates.rows.every(
            (row) =>
              row.association_state === "resolved" &&
              row.lifecycle === "active" &&
              row.deletion_phase === null
          )
        ) {
          projectId = uniqueProjects[0]!;
        } else if (
          !confirmedSeparate &&
          (movedCheckout ||
            input.hasMovedCheckoutCandidate ||
            candidates.rows.length > 0 ||
            input.hasRemoteCandidate)
        ) {
          reason =
            movedCheckout || input.hasMovedCheckoutCandidate
              ? "moved_checkout"
              : "ambiguous_candidate";
        } else {
          const base = shortKey(input.displayName);
          let candidate = base;
          let suffix = 1;
          while (
            (
              await client.query(
                `select 1 from projects where owner_user_id=$1 and key=$2`,
                [input.ownerUserId, candidate]
              )
            ).rowCount
          ) {
            suffix += 1;
            candidate = `${base}${suffix}`;
          }
          const created = await client.query<{ id: string }>(
            `insert into projects (owner_user_id,name,key) values ($1,$2,$3) returning id`,
            [input.ownerUserId, input.displayName, candidate]
          );
          projectId = created.rows[0]!.id;
          createdProjectId = projectId;
        }
        await client.query(
          `insert into project_local_contexts
             (owner_user_id,project_id,device_id,local_project_id,common_dir_hash,git_dir_hash,folder_hash,association_state,last_confirmation_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$10)
           on conflict (owner_user_id,device_id,local_project_id) do update
             set project_id=excluded.project_id,association_state=excluded.association_state,
                 association_version=case
                   when project_local_contexts.project_id is distinct from excluded.project_id
                     or project_local_contexts.association_state is distinct from excluded.association_state
                   then project_local_contexts.association_version+1
                   else project_local_contexts.association_version end,
                 last_confirmation_version=greatest(project_local_contexts.last_confirmation_version,excluded.last_confirmation_version),last_seen_at=now()
           where project_local_contexts.association_state='unresolved'
              or $9::boolean
              or exists (select 1 from projects prior
                          where prior.id=project_local_contexts.project_id
                            and prior.owner_user_id=project_local_contexts.owner_user_id
                            and prior.lifecycle='deleted')`,
          [
            input.ownerUserId,
            projectId,
            input.deviceId,
            input.localProjectId,
            input.commonDirHash,
            input.gitDirHash,
            input.folderHash,
            projectId ? "resolved" : "unresolved",
            Boolean(confirmedSeparate),
            confirmedProjectId || confirmedSeparate
              ? input.confirmationVersion
              : 0
          ]
        );
      }
      // Hold the lifecycle row through the Session update. A concurrent soft
      // delete either waits for this transaction or commits before this read.
      const active = projectId
        ? await client.query<{ id: string }>(
            `select id from projects where id=$1 and owner_user_id=$2 and lifecycle='active' and deletion_phase is null
               for share`,
            [projectId, input.ownerUserId]
          )
        : { rows: [] as { id: string }[] };
      const assignableId = active.rows[0]?.id ?? null;
      let assigned = Boolean(
        assignableId &&
        found.automatic_personal_project_id === assignableId &&
        !found.project_override_personal_project_id &&
        !found.project_override_id &&
        !found.project_override_at
      );
      let firstAssigned = false;
      if (
        assignableId &&
        !found.automatic_personal_project_id &&
        !found.project_override_personal_project_id &&
        !found.project_override_id &&
        !found.project_override_at
      ) {
        const updated = await client.query(
          `update sessions set automatic_personal_project_id=$4,updated_at=now()
            where id=$1 and owner_user_id=$2 and external_session_id=$3
              and automatic_personal_project_id is null
              and project_override_personal_project_id is null
              and project_override_id is null
              and project_override_at is null`,
          [found.id, input.ownerUserId, input.externalSessionId, assignableId]
        );
        assigned = Boolean(updated.rowCount);
        firstAssigned = assigned;
      }
      const capturePolicy = input.captureSharePolicy;
      if (
        assigned &&
        exactActive &&
        capturePolicy &&
        exact.rows[0]?.project_id === capturePolicy.projectId &&
        exact.rows[0]?.association_version ===
          capturePolicy.associationVersion &&
        assignableId === capturePolicy.projectId &&
        Number.isSafeInteger(capturePolicy.policyVersion) &&
        capturePolicy.policyVersion > 0 &&
        typeof capturePolicy.linkEpoch === "string" &&
        typeof capturePolicy.deviceCredentialId === "string" &&
        !Number.isNaN(Date.parse(capturePolicy.preparedAt)) &&
        found.created_at.getTime() >= Date.parse(capturePolicy.preparedAt) &&
        !found.project_override_personal_project_id &&
        !found.project_override_id
      ) {
        await client.query(
          `update sessions s
             set project_share_capture_policy_version=p.project_share_policy_version,
                 project_share_capture_workspace_project_id=p.workspace_project_id,
                 project_share_capture_device_credential_id=p.project_share_policy_device_credential_id,
                 project_share_capture_link_epoch=p.share_policy_link_epoch,
                 project_share_capture_context_version=$7,
                 project_share_capture_prepared_at=$6::timestamptz,
                 updated_at=now()
            from projects p
           where s.id=$1 and s.owner_user_id=$2
             and p.id=$3 and p.owner_user_id=$2
             and p.lifecycle='active' and p.deletion_phase is null
             and p.project_share_policy_version=$4
             and p.project_share_policy_device_credential_id=$8
             and p.share_policy_link_epoch=$9
             and p.workspace_project_id=$5
             and p.project_share_policy_enabled_at <= $6::timestamptz
             and s.created_at >= $6::timestamptz
             and s.automatic_personal_project_id=p.id
             and s.project_override_personal_project_id is null
             and s.project_override_id is null
             and s.project_override_at is null
             and s.project_share_private_at is null
             and s.source_kind is not null
             and s.source_adapter_version is not null
             and coalesce(s.external_thread_id,s.external_session_id) is not null
             and not exists (
               select 1 from project_share_private_conversations private
                where private.owner_user_id=s.owner_user_id
                  and private.source_runtime=s.source_runtime
                  and private.source_kind=s.source_kind
                  and private.source_adapter_version=s.source_adapter_version
                  and private.external_conversation_id=coalesce(s.external_thread_id,s.external_session_id)
             )
             and s.project_share_capture_policy_version is null
             and s.personal_deleted_at is null and s.invalidated_at is null
             and s.trashed_at is null`,
          [
            found.id,
            input.ownerUserId,
            capturePolicy.projectId,
            capturePolicy.policyVersion,
            capturePolicy.workspaceProjectId,
            capturePolicy.preparedAt,
            capturePolicy.associationVersion,
            capturePolicy.deviceCredentialId,
            capturePolicy.linkEpoch
          ]
        );
      }
      if (projectId && (createdProjectId === projectId || firstAssigned))
        await appendCollaborationOutboxEventWithClient(client, {
          family: "project_changed",
          scope: "personal",
          personalOwnerUserId: input.ownerUserId,
          teamId: null,
          teamWorkspaceId: null,
          threadId: null,
          messageId: null,
          shareGrantId: null,
          logicalMemoryId: null,
          resourceType: "project",
          resourceId: projectId,
          actorPrincipalId: input.ownerUserId,
          mutationId: randomUUID()
        });
      await client.query("commit");
      return {
        state: projectId ? "resolved" : "unresolved",
        projectId,
        sessionAssigned: assigned,
        ...(reason ? { reason } : {})
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
  async backfillLegacyProjectOverrides(ownerUserId, limit = 100) {
    const ambiguous = await pool.query<{ count: string }>(
      `select count(*)::text as count from sessions s
        where s.owner_user_id=$1 and s.project_override_id is not null
          and s.project_override_by_user_id=$1 and s.project_override_at is not null
          and s.project_override_personal_project_id is null
          and (select count(distinct c.project_id) from project_local_contexts c
                 where c.owner_user_id=$1 and c.local_project_id=s.project_override_id
                   and c.project_id is not null) > 1`,
      [ownerUserId]
    );
    const mapped = await pool.query(
      `with matches as (
         select s.id, min(c.project_id::text)::uuid as project_id
           from sessions s
           join project_local_contexts c on c.owner_user_id=s.owner_user_id
             and c.local_project_id=s.project_override_id
             and c.association_state='resolved'
          where s.owner_user_id=$1 and s.project_override_id is not null
            and s.project_override_by_user_id=$1 and s.project_override_at is not null
            and s.project_override_personal_project_id is null
          group by s.id having count(distinct c.project_id)=1
          limit $2
       )
       update sessions s set project_override_personal_project_id=m.project_id,updated_at=now()
         from matches m where s.id=m.id and s.owner_user_id=$1
           and s.project_override_personal_project_id is null`,
      [ownerUserId, limit]
    );
    return {
      mapped: mapped.rowCount ?? 0,
      ambiguous: Number(ambiguous.rows[0]?.count ?? 0)
    };
  }
});
