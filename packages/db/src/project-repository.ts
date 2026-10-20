import pg from "pg";

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
        automatic_personal_project_id: string | null;
        project_override_personal_project_id: string | null;
        project_override_id: string | null;
      }>(
        `select id, automatic_personal_project_id, project_override_personal_project_id, project_override_id
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
        `select c.project_id,c.git_dir_hash,c.folder_hash,c.association_state,c.last_confirmation_version,p.lifecycle,p.deletion_phase
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
              `select c.project_id,c.git_dir_hash,c.folder_hash,c.association_state,p.lifecycle,p.deletion_phase
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
        }
        await client.query(
          `insert into project_local_contexts
             (owner_user_id,project_id,device_id,local_project_id,common_dir_hash,git_dir_hash,folder_hash,association_state,last_confirmation_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$10)
           on conflict (owner_user_id,device_id,local_project_id) do update
             set project_id=excluded.project_id,association_state=excluded.association_state,
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
        !found.project_override_id
      );
      if (
        assignableId &&
        !found.automatic_personal_project_id &&
        !found.project_override_personal_project_id &&
        !found.project_override_id
      ) {
        const updated = await client.query(
          `update sessions set automatic_personal_project_id=$4,updated_at=now()
            where id=$1 and owner_user_id=$2 and external_session_id=$3
              and automatic_personal_project_id is null
              and project_override_personal_project_id is null
              and project_override_id is null`,
          [found.id, input.ownerUserId, input.externalSessionId, assignableId]
        );
        assigned = Boolean(updated.rowCount);
      }
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
