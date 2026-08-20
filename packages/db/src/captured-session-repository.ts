import { basename } from "node:path";
import pg from "pg";
import type { MemoryActor } from "@koed/core";
import type {
  ActorContext,
  CaptureMethod,
  CapturedSessionRecord,
  CapturedSessionTitleCandidate,
  PersonalProjectReference,
  SourceRuntime,
  Visibility
} from "./types.js";

export interface CapturedSessionRepository {
  createCapturedSession(
    actor: ActorContext,
    input: {
      projectId?: string;
      logicalSessionId?: string;
      externalSessionId?: string;
      forkedFromExternalThreadId?: string;
      sourceRuntime?: SourceRuntime;
      captureMethod?: CaptureMethod;
      model?: string;
      cwd?: string;
      idempotencyKey?: string;
      sourceHash?: string;
      sourceKind?: string;
      sourceAdapterVersion?: string;
      sourceFingerprint?: string;
      capturedProject?: Record<string, unknown>;
      importObservedAt?: string;
      metadata?: Record<string, unknown>;
      detectedProjects?: PersonalProjectReference[];
    }
  ): Promise<CapturedSessionRecord>;
  getCapturedSession(
    actor: ActorContext,
    sessionId: string
  ): Promise<CapturedSessionRecord | null>;
  listCapturedSessionSummaries(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<CapturedSessionSummaryRecord[]>;
  getCapturedSessionSummary(
    actor: ActorContext,
    sessionId: string
  ): Promise<CapturedSessionSummaryRecord | null>;
  getCapturedSessionSummaryByLogicalMemoryId(
    actor: ActorContext,
    logicalMemoryId: string
  ): Promise<CapturedSessionSummaryRecord | null>;
  updateCapturedSessionTitle(
    actor: ActorContext,
    sessionId: string,
    input: { title: string }
  ): Promise<CapturedSessionRecord | null>;
  moveCapturedSessionToProject(
    actor: ActorContext,
    sessionId: string,
    project: PersonalProjectReference
  ): Promise<CapturedSessionRecord | null>;
  resetCapturedSessionProject(
    actor: ActorContext,
    sessionId: string
  ): Promise<CapturedSessionRecord | null>;
  listCapturedSessionsNeedingTitles(
    actor: ActorContext,
    input?: { limit?: number; minUserEvents?: number }
  ): Promise<CapturedSessionTitleCandidate[]>;
  getLatestCapturedSessionForProject(
    actor: ActorContext,
    input: { projectId: string }
  ): Promise<CapturedSessionRecord | null>;
  updateCapturedSessionGeneratedTitle(
    actor: ActorContext,
    sessionId: string,
    input: { title: string; source: "generated" | "lcm" | "provisional" }
  ): Promise<CapturedSessionRecord | null>;
}

export interface CapturedSessionRepositoryOptions {
  transactionClient?: pg.PoolClient;
}

export interface CapturedSessionSummaryRecord {
  sessionId: string;
  logicalMemoryId: string | null;
  title: string;
  projectName: string | null;
  updatedAt: string;
  eventCount: number;
  hasSynchronizedRevision: boolean;
  syncState:
    | "not_started"
    | "paused"
    | "processing"
    | "partially_available"
    | "ready"
    | "stale"
    | "failed"
    | "revoked";
}

type CapturedSessionRow = {
  id: string;
  logical_session_id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  external_session_id: string | null;
  forked_from_external_thread_id: string | null;
  source_runtime: SourceRuntime;
  capture_method: CaptureMethod;
  model: string | null;
  cwd: string | null;
  source_kind: string | null;
  source_adapter_version: string | null;
  source_fingerprint: string | null;
  captured_project: Record<string, unknown>;
  import_observed_at: Date | null;
  metadata: Record<string, unknown> | null;
  captured_project_provenance: Record<string, unknown> | null;
  automatic_project_id: string | null;
  automatic_project_name: string | null;
  automatic_project_path: string | null;
  automatic_project_detected_at: Date | null;
  project_override_id: string | null;
  project_override_name: string | null;
  project_override_path: string | null;
  project_override_at: Date | null;
  created_at: Date;
};

type CapturedSessionTitleCandidateRow = {
  id: string;
  external_session_id: string | null;
  project_name: string | null;
  project_path: string | null;
  current_title: string | null;
  event_count: string | number;
  source_items: Array<{
    id: string;
    actor: MemoryActor;
    content: string;
    capturedAt: string;
  }> | null;
};

type CapturedSessionSummaryRow = {
  session_id: string;
  logical_memory_id: string | null;
  title: string | null;
  project_name: string | null;
  latest_activity_at: Date;
  event_count: string | number;
  has_synchronized_revision: boolean;
  sync_state: CapturedSessionSummaryRecord["syncState"] | null;
};

const mapCapturedSessionSummary = (
  row: CapturedSessionSummaryRow
): CapturedSessionSummaryRecord => ({
  sessionId: row.session_id,
  logicalMemoryId: row.logical_memory_id,
  title: normalizeSessionTitle(row.title) ?? "Captured Session",
  projectName: row.project_name,
  updatedAt: row.latest_activity_at.toISOString(),
  eventCount: Number(row.event_count),
  hasSynchronizedRevision: row.has_synchronized_revision,
  syncState: row.sync_state ?? "not_started"
});

export const getCapturedSessionSummaryWithClient = async (
  client: pg.Pool | pg.PoolClient,
  actor: ActorContext,
  sessionId: string
): Promise<CapturedSessionSummaryRecord | null> => {
  const result = await client.query<CapturedSessionSummaryRow>(
    `
      select
        s.id as session_id,
        lm.id as logical_memory_id,
        nullif(btrim(s.metadata ->> 'threadName'), '') as title,
        coalesce(s.project_override_name, s.automatic_project_name) as project_name,
        greatest(
          s.updated_at,
          coalesce(max(coalesce(me.source_event_time, me.captured_at)), s.updated_at)
        ) as latest_activity_at,
        count(me.id)::text as event_count,
        coalesce(
          relationship.source_cursor > 0
            and relationship.last_synced_at is not null
            and relationship.revoked_at is null
            and relationship.state not in ('failed', 'revoked', 'purge_pending'),
          false
        ) as has_synchronized_revision,
        case
          when relationship.revoked_at is not null
            or relationship.state in ('revoked', 'purge_pending') then 'revoked'
          when relationship.state in ('created', 'uploading', 'uploaded', 'verified')
            then 'processing'
          else relationship.state::text
        end as sync_state
      from sessions s
      left join memory_events me
        on me.session_id = s.id
       and me.owner_user_id = $1
       and me.visibility = 'personal'
       and me.invalidated_at is null
       and me.personal_deleted_at is null
      left join logical_memories lm
        on lm.local_session_id = s.id
       and lm.owner_user_id = $1
       and lm.owner_principal_id = $1
       and lm.source_boundary = 'captured_session'
       and lm.lifecycle in ('active', 'stale')
      left join lateral (
        select relationship.state, relationship.revoked_at,
               relationship.source_cursor, relationship.last_synced_at
        from cross_identity_sync_relationships relationship
        where relationship.logical_memory_id = lm.id
          and relationship.local_user_id = $1
          and relationship.local_replica_id in (
            select replica.id
            from memory_replicas replica
            where replica.logical_memory_id = lm.id
              and replica.local_session_id = s.id
              and replica.owner_user_id = $1
              and replica.owner_principal_id = $1
              and replica.replica_role = 'source'
          )
          and relationship.side = 'source'
        order by relationship.revoked_at nulls first, relationship.updated_at desc
        limit 1
      ) relationship on true
      where s.id = $2
        and s.owner_user_id = $1
        and s.visibility = 'personal'
        and s.invalidated_at is null
        and s.personal_deleted_at is null
        and exists (
          select 1
          from users owner
          where owner.id = $1
            and owner.disabled_at is null
            and owner.deleted_at is null
        )
      group by s.id, lm.id, relationship.state, relationship.revoked_at,
               relationship.source_cursor, relationship.last_synced_at
    `,
    [actor.userId, sessionId]
  );
  return result.rows[0] ? mapCapturedSessionSummary(result.rows[0]) : null;
};

const projectReference = (
  id: string | null,
  name: string | null,
  path: string | null
): PersonalProjectReference | null => (id && name ? { id, name, path } : null);

const mapCapturedSession = (row: CapturedSessionRow): CapturedSessionRecord => {
  const automaticProject = projectReference(
    row.automatic_project_id,
    row.automatic_project_name,
    row.automatic_project_path
  );
  const projectOverride = projectReference(
    row.project_override_id,
    row.project_override_name,
    row.project_override_path
  );
  return {
    id: row.id,
    logicalSessionId: row.logical_session_id,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    externalSessionId: row.external_session_id,
    forkedFromExternalThreadId: row.forked_from_external_thread_id,
    sourceRuntime: row.source_runtime,
    captureMethod: row.capture_method,
    model: row.model,
    cwd: row.cwd,
    sourceKind: row.source_kind,
    sourceAdapterVersion: row.source_adapter_version,
    sourceFingerprint: row.source_fingerprint,
    capturedProject: row.captured_project,
    importObservedAt: row.import_observed_at?.toISOString() ?? null,
    metadata: row.metadata ?? {},
    capturedProjectProvenance: row.captured_project_provenance ?? {},
    automaticProject,
    projectOverride,
    project: projectOverride ?? automaticProject,
    projectAssignmentSource: projectOverride
      ? "user_override"
      : automaticProject
        ? "detected"
        : null,
    projectAssignmentUpdatedAt:
      (
        row.project_override_at ?? row.automatic_project_detected_at
      )?.toISOString() ?? null,
    createdAt: row.created_at.toISOString()
  };
};

const mapCapturedSessionTitleCandidate = (
  row: CapturedSessionTitleCandidateRow
): CapturedSessionTitleCandidate => ({
  id: row.id,
  externalSessionId: row.external_session_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  currentTitle: row.current_title,
  eventCount: Number(row.event_count),
  sourceItems: row.source_items ?? []
});

const normalizeSessionTitle = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/^[\s:;,.!?-]+|[\s:;,.!?-]+$/g, "")
    .trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 120);
};

const normalizedProjectReference = (
  value: PersonalProjectReference
): PersonalProjectReference | null => {
  const id = value.id.trim();
  const name = value.name.trim();
  const projectPath = value.path?.trim() || null;
  return id && name ? { id, name, path: projectPath } : null;
};

const detectedProjectsForCapture = (input: {
  projectId?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  detectedProjects?: PersonalProjectReference[];
}): PersonalProjectReference[] => {
  const explicitProjects = input.detectedProjects;
  const candidates = explicitProjects
    ? explicitProjects.map(normalizedProjectReference)
    : (() => {
        const metadata = input.metadata ?? {};
        const metadataId =
          typeof metadata.localProjectId === "string"
            ? metadata.localProjectId
            : typeof metadata.projectId === "string"
              ? metadata.projectId
              : null;
        const projectPath =
          typeof metadata.projectPath === "string"
            ? metadata.projectPath
            : (input.cwd ?? null);
        const id =
          metadataId ??
          (input.projectId && input.projectId !== "default"
            ? input.projectId
            : projectPath);
        if (!id) return [];
        const name =
          typeof metadata.projectName === "string" &&
          metadata.projectName.trim()
            ? metadata.projectName
            : basename(projectPath ?? id) || id;
        return [{ id, name, path: projectPath }];
      })();
  return [
    ...new Map(
      candidates
        .filter((project): project is PersonalProjectReference =>
          Boolean(project)
        )
        .map((project) => [project.id, project])
    ).values()
  ];
};

const hasDetectedProjectInput = (input: {
  projectId?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  detectedProjects?: PersonalProjectReference[];
}): boolean =>
  input.detectedProjects !== undefined ||
  input.projectId !== undefined ||
  input.cwd !== undefined ||
  ["localProjectId", "projectId", "projectPath", "projectName"].some((key) =>
    Object.hasOwn(input.metadata ?? {}, key)
  );

const hasExplicitDetectedProjectIdentity = (input: {
  projectId?: string;
  metadata?: Record<string, unknown>;
  detectedProjects?: PersonalProjectReference[];
}): boolean =>
  input.detectedProjects !== undefined ||
  input.projectId !== undefined ||
  ["localProjectId", "projectId"].some((key) =>
    Object.hasOwn(input.metadata ?? {}, key)
  );

const capturedSessionColumns = `
  id, logical_session_id, owner_user_id, visibility, external_session_id,
  forked_from_external_thread_id,
  source_runtime, capture_method, model, cwd,
  source_kind, source_adapter_version, source_fingerprint,
  captured_project, import_observed_at, metadata,
  captured_project_provenance,
  automatic_project_id, automatic_project_name, automatic_project_path,
  automatic_project_detected_at,
  project_override_id, project_override_name, project_override_path,
  project_override_at, created_at
`;

export const createCapturedSessionRepository = (
  pool: pg.Pool,
  options: CapturedSessionRepositoryOptions = {}
): CapturedSessionRepository => ({
  async createCapturedSession(actor, input) {
    const ownsTransaction = !options.transactionClient;
    const client = options.transactionClient ?? (await pool.connect());
    try {
      if (ownsTransaction) {
        await client.query("begin");
      }
      if (input.externalSessionId) {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`captured-session:${actor.userId}:${input.externalSessionId}`]
        );
      }
      const metadata = { ...(input.metadata ?? {}) };
      const forkedFromExternalThreadId =
        input.forkedFromExternalThreadId ??
        (typeof metadata.forked_from_id === "string"
          ? metadata.forked_from_id
          : null);
      const detectedProjects = detectedProjectsForCapture(input);
      const automaticProject =
        detectedProjects.length === 1 ? detectedProjects[0]! : null;
      const detectedProjectInputProvided = hasDetectedProjectInput(input);
      const explicitProjectIdentityProvided =
        hasExplicitDetectedProjectIdentity(input);
      const capturedProjectProvenance = {
        schemaVersion: 1,
        capturedCwd: input.cwd ?? null,
        capturedProjectId: input.projectId ?? null,
        candidates: detectedProjects,
        outcome:
          detectedProjects.length === 1
            ? "unambiguous"
            : detectedProjects.length > 1
              ? "ambiguous"
              : "no_signal"
      };
      if (input.externalSessionId) {
        const converged = await client.query<CapturedSessionRow>(
          `
            update sessions
            set
              updated_at = now(),
              model = coalesce(model, $3),
              cwd = coalesce(cwd, $4),
              metadata =
                metadata || $5::jsonb ||
                case
                  when metadata ->> 'threadNameSource' = 'manual'
                  then jsonb_strip_nulls(jsonb_build_object(
                    'threadName', metadata ->> 'threadName',
                    'threadNameSource', metadata ->> 'threadNameSource',
                    'threadNameEditedAt', metadata ->> 'threadNameEditedAt'
                  ))
                  else '{}'::jsonb
                end,
              source_metadata = source_metadata || $5::jsonb,
              source_fingerprint = coalesce(source_fingerprint, $6),
              forked_from_external_thread_id =
                coalesce(forked_from_external_thread_id, $14),
              captured_project = case
                when captured_project = '{}'::jsonb then $7::jsonb
                else captured_project
              end,
              import_observed_at = coalesce(import_observed_at, $8),
              automatic_project_id = case
                when $13::boolean then $10
                when $9::boolean and automatic_project_id is null then $10
                else automatic_project_id
              end,
              automatic_project_name = case
                when $13::boolean then $11
                when $9::boolean and automatic_project_id is null then $11
                else automatic_project_name
              end,
              automatic_project_path = case
                when $13::boolean then $12
                when $9::boolean and automatic_project_id is null then $12
                else automatic_project_path
              end,
              automatic_project_detected_at = case
                when $13::boolean and $10::text is not null then now()
                when $13::boolean then null
                when $9::boolean and automatic_project_id is null and $10::text is not null then now()
                else automatic_project_detected_at
              end
            where id = (
              select id
              from sessions
              where owner_user_id = $1
                and visibility = 'personal'
              and external_session_id = $2
              and invalidated_at is null
              and personal_deleted_at is null
              order by created_at asc, id asc
              limit 1
            )
            returning ${capturedSessionColumns}
          `,
          [
            actor.userId,
            input.externalSessionId,
            input.model ?? null,
            input.cwd ?? null,
            metadata,
            input.sourceFingerprint ?? null,
            input.capturedProject ?? {},
            input.importObservedAt ?? null,
            detectedProjectInputProvided,
            automaticProject?.id ?? null,
            automaticProject?.name ?? null,
            automaticProject?.path ?? null,
            explicitProjectIdentityProvided,
            forkedFromExternalThreadId
          ]
        );
        const convergedRow = converged.rows[0];
        if (convergedRow) {
          if (
            input.logicalSessionId &&
            convergedRow.logical_session_id !== input.logicalSessionId
          ) {
            throw Object.assign(
              new Error("Captured Session logical identity conflicts"),
              { statusCode: 409 }
            );
          }
          if (
            forkedFromExternalThreadId &&
            convergedRow.forked_from_external_thread_id !==
              forkedFromExternalThreadId
          ) {
            throw Object.assign(
              new Error("Captured Session fork lineage conflicts"),
              { statusCode: 409 }
            );
          }
          if (ownsTransaction) {
            await client.query("commit");
          }
          return mapCapturedSession(convergedRow);
        }
      }
      const result = await client.query<CapturedSessionRow>(
        `
        insert into sessions (
          owner_user_id,
          visibility,
          external_session_id,
          source_runtime,
          capture_method,
          idempotency_key,
          source_hash,
          model,
          cwd,
          metadata,
          source_kind,
          source_adapter_version,
          external_thread_id,
          forked_from_external_thread_id,
          parent_external_thread_id,
          parent_session_id,
          agent_nickname,
          agent_role,
          agent_path,
          thread_source,
          source_metadata,
          captured_project_provenance,
          automatic_project_id,
          automatic_project_name,
          automatic_project_path,
          automatic_project_detected_at,
          source_fingerprint,
          captured_project,
          import_observed_at,
          logical_session_id
        )
        values (
          $1, 'personal', $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14,
          (
            select id
            from sessions parent
            where parent.owner_user_id = $1
              and parent.visibility = 'personal'
              and (
                parent.external_thread_id = $14
                or parent.external_session_id = $14
                or parent.id::text = $14
              )
            order by parent.created_at desc
            limit 1
          ),
          $15, $16, $17, $18, $19,
          $20, $21, $22, $23,
          case when $21::text is null then null else now() end,
          $24, $25, $26, coalesce($29::uuid, gen_random_uuid())
        )
        on conflict (owner_user_id, visibility, idempotency_key)
        where idempotency_key is not null
        do update set
          updated_at = now(),
          metadata =
            sessions.metadata ||
            excluded.metadata ||
            case
              when sessions.metadata ->> 'threadNameSource' = 'manual'
              then jsonb_strip_nulls(jsonb_build_object(
                'threadName', sessions.metadata ->> 'threadName',
                'threadNameSource', sessions.metadata ->> 'threadNameSource',
                'threadNameEditedAt', sessions.metadata ->> 'threadNameEditedAt'
              ))
              else '{}'::jsonb
            end,
          parent_session_id = coalesce(sessions.parent_session_id, excluded.parent_session_id),
          forked_from_external_thread_id = coalesce(
            sessions.forked_from_external_thread_id,
            excluded.forked_from_external_thread_id
          ),
          source_metadata = sessions.source_metadata || excluded.source_metadata,
          source_fingerprint = coalesce(sessions.source_fingerprint, excluded.source_fingerprint),
          captured_project = case
            when sessions.captured_project = '{}'::jsonb then excluded.captured_project
            else sessions.captured_project
          end,
          import_observed_at = coalesce(sessions.import_observed_at, excluded.import_observed_at),
          automatic_project_id = case
            when $28::boolean then excluded.automatic_project_id
            when $27::boolean and sessions.automatic_project_id is null
              then excluded.automatic_project_id
            else sessions.automatic_project_id
          end,
          automatic_project_name = case
            when $28::boolean then excluded.automatic_project_name
            when $27::boolean and sessions.automatic_project_id is null
              then excluded.automatic_project_name
            else sessions.automatic_project_name
          end,
          automatic_project_path = case
            when $28::boolean then excluded.automatic_project_path
            when $27::boolean and sessions.automatic_project_id is null
              then excluded.automatic_project_path
            else sessions.automatic_project_path
          end,
          automatic_project_detected_at = case
            when $28::boolean then excluded.automatic_project_detected_at
            when $27::boolean and sessions.automatic_project_id is null
              then excluded.automatic_project_detected_at
            else sessions.automatic_project_detected_at
          end
        where sessions.owner_user_id = excluded.owner_user_id
          and sessions.visibility = excluded.visibility
          and (
            $29::uuid is null
            or sessions.logical_session_id = $29::uuid
          )
          and sessions.invalidated_at is null
          and sessions.personal_deleted_at is null
          and (
            $13::text is null
            or sessions.forked_from_external_thread_id is null
            or sessions.forked_from_external_thread_id = $13
          )
        returning ${capturedSessionColumns}
      `,
        [
          actor.userId,
          input.externalSessionId ?? null,
          input.sourceRuntime ?? "codex",
          input.captureMethod ?? "mcp",
          input.idempotencyKey ?? null,
          input.sourceHash ?? null,
          input.model ?? null,
          input.cwd ?? null,
          metadata,
          input.sourceKind ?? "codex",
          input.sourceAdapterVersion ??
            (input.sourceRuntime === "codex-cli"
              ? "codex-cli-hook-v1"
              : input.sourceRuntime === "claude-code"
                ? "claude-code-transcript-v1"
                : input.sourceRuntime === "pi"
                  ? "pi-session-v1"
                  : "codex-app-server-v1"),
          input.externalSessionId ?? null,
          forkedFromExternalThreadId,
          typeof metadata.parentThreadId === "string"
            ? metadata.parentThreadId
            : typeof metadata.parentExternalSessionId === "string"
              ? metadata.parentExternalSessionId
              : null,
          typeof metadata.agent_nickname === "string"
            ? metadata.agent_nickname
            : typeof metadata.agentNickname === "string"
              ? metadata.agentNickname
              : null,
          typeof metadata.agent_role === "string"
            ? metadata.agent_role
            : typeof metadata.agentType === "string"
              ? metadata.agentType
              : null,
          typeof metadata.agent_path === "string" ? metadata.agent_path : null,
          typeof metadata.thread_source === "string"
            ? metadata.thread_source
            : typeof metadata.threadKind === "string"
              ? metadata.threadKind
              : null,
          metadata,
          capturedProjectProvenance,
          automaticProject?.id ?? null,
          automaticProject?.name ?? null,
          automaticProject?.path ?? null,
          input.sourceFingerprint ?? null,
          input.capturedProject ?? {},
          input.importObservedAt ?? null,
          detectedProjectInputProvided,
          explicitProjectIdentityProvided,
          input.logicalSessionId ?? null
        ]
      );

      const row = result.rows[0];
      if (!row) {
        throw Object.assign(
          new Error(
            "Duplicate Captured Session conflicts with data outside caller visibility"
          ),
          { statusCode: 409 }
        );
      }
      if (ownsTransaction) {
        await client.query("commit");
      }
      return mapCapturedSession(row);
    } catch (error) {
      if (ownsTransaction) {
        await client.query("rollback").catch(() => undefined);
      }
      throw error;
    } finally {
      if (ownsTransaction) {
        client.release();
      }
    }
  },

  async updateCapturedSessionTitle(actor, sessionId, input) {
    const title = normalizeSessionTitle(input.title);
    if (!title) {
      return null;
    }
    const result = await pool.query<CapturedSessionRow>(
      `
        update sessions
        set
          metadata = metadata || jsonb_build_object(
            'threadName', $3::text,
            'threadNameSource', 'manual',
            'threadNameEditedAt', now()
          ),
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
        returning ${capturedSessionColumns}
      `,
      [actor.userId, sessionId, title]
    );
    return result.rows[0] ? mapCapturedSession(result.rows[0]) : null;
  },

  async moveCapturedSessionToProject(actor, sessionId, input) {
    const project = normalizedProjectReference(input);
    if (!project) return null;
    const result = await pool.query<CapturedSessionRow>(
      `
        update sessions
        set
          project_override_id = $3,
          project_override_name = $4,
          project_override_path = $5,
          project_override_at = now(),
          project_override_by_user_id = $1,
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
          and personal_deleted_at is null
        returning ${capturedSessionColumns}
      `,
      [actor.userId, sessionId, project.id, project.name, project.path]
    );
    return result.rows[0] ? mapCapturedSession(result.rows[0]) : null;
  },

  async resetCapturedSessionProject(actor, sessionId) {
    const result = await pool.query<CapturedSessionRow>(
      `
        update sessions
        set
          project_override_id = null,
          project_override_name = null,
          project_override_path = null,
          project_override_at = null,
          project_override_by_user_id = null,
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
          and personal_deleted_at is null
        returning ${capturedSessionColumns}
      `,
      [actor.userId, sessionId]
    );
    return result.rows[0] ? mapCapturedSession(result.rows[0]) : null;
  },

  async getCapturedSession(actor, sessionId) {
    const result = await pool.query<CapturedSessionRow>(
      `
        select ${capturedSessionColumns}
        from sessions
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
      `,
      [actor.userId, sessionId]
    );
    return result.rows[0] ? mapCapturedSession(result.rows[0]) : null;
  },

  async listCapturedSessionSummaries(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    const result = await pool.query<CapturedSessionSummaryRow>(
      `
        select
          s.id as session_id,
          lm.id as logical_memory_id,
          nullif(btrim(s.metadata ->> 'threadName'), '') as title,
          coalesce(s.project_override_name, s.automatic_project_name) as project_name,
          greatest(
            s.updated_at,
            coalesce(max(coalesce(me.source_event_time, me.captured_at)), s.updated_at)
          ) as latest_activity_at,
          count(me.id)::text as event_count,
          coalesce(
            relationship.source_cursor > 0
              and relationship.last_synced_at is not null
              and relationship.revoked_at is null
              and relationship.state not in ('failed', 'revoked', 'purge_pending'),
            false
          ) as has_synchronized_revision,
          case
            when relationship.revoked_at is not null
              or relationship.state in ('revoked', 'purge_pending') then 'revoked'
            when relationship.state in ('created', 'uploading', 'uploaded', 'verified')
              then 'processing'
            else relationship.state::text
          end as sync_state
        from sessions s
        left join memory_events me
          on me.session_id = s.id
         and me.owner_user_id = $1
         and me.visibility = 'personal'
         and me.invalidated_at is null
         and me.personal_deleted_at is null
        left join logical_memories lm
          on lm.local_session_id = s.id
         and lm.owner_user_id = $1
         and lm.owner_principal_id = $1
         and lm.source_boundary = 'captured_session'
         and lm.lifecycle in ('active', 'stale')
        left join lateral (
          select relationship.state, relationship.revoked_at,
                 relationship.source_cursor, relationship.last_synced_at
          from cross_identity_sync_relationships relationship
          where relationship.logical_memory_id = lm.id
            and relationship.local_user_id = $1
            and relationship.local_replica_id in (
              select replica.id
              from memory_replicas replica
              where replica.logical_memory_id = lm.id
                and replica.local_session_id = s.id
                and replica.owner_user_id = $1
                and replica.owner_principal_id = $1
                and replica.replica_role = 'source'
            )
            and relationship.side = 'source'
          order by relationship.revoked_at nulls first, relationship.updated_at desc
          limit 1
        ) relationship on true
        where s.owner_user_id = $1
          and s.visibility = 'personal'
          and s.invalidated_at is null
          and s.personal_deleted_at is null
        group by s.id, lm.id, relationship.state, relationship.revoked_at,
                 relationship.source_cursor, relationship.last_synced_at
        order by latest_activity_at desc, s.id desc
        limit $2
      `,
      [actor.userId, limit]
    );
    return result.rows.map(mapCapturedSessionSummary);
  },

  async getCapturedSessionSummary(actor, sessionId) {
    return getCapturedSessionSummaryWithClient(pool, actor, sessionId);
  },

  async getCapturedSessionSummaryByLogicalMemoryId(actor, logicalMemoryId) {
    const result = await pool.query<{ local_session_id: string }>(
      `select logical.local_session_id
         from logical_memories logical
         join sessions session
           on session.id = logical.local_session_id
          and session.owner_user_id = logical.owner_user_id
          and session.visibility = 'personal'
          and session.invalidated_at is null
          and session.personal_deleted_at is null
        where logical.id = $2
          and logical.owner_user_id = $1
          and logical.owner_principal_id = $1
          and logical.source_boundary = 'captured_session'
          and logical.lifecycle in ('active', 'stale')
        limit 1`,
      [actor.userId, logicalMemoryId]
    );
    return result.rows[0]
      ? getCapturedSessionSummaryWithClient(
          pool,
          actor,
          result.rows[0].local_session_id
        )
      : null;
  },

  async listCapturedSessionsNeedingTitles(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 25);
    const minUserEvents = Math.min(Math.max(input.minUserEvents ?? 3, 1), 50);
    const result = await pool.query<CapturedSessionTitleCandidateRow>(
      `
        with eligible_sessions as (
          select
            s.id,
            s.external_session_id,
            coalesce(s.project_override_name, s.automatic_project_name, 'Unassigned') as project_name,
            coalesce(s.project_override_path, s.automatic_project_path) as project_path,
            s.metadata ->> 'threadName' as current_title,
            count(me.id) filter (where me.payload ->> 'actor' in ('user', 'agent'))::text as event_count,
            max(coalesce(me.source_event_time, me.captured_at)) as latest_event_at
          from sessions s
          join memory_events me on me.session_id = s.id
          where s.invalidated_at is null
            and s.visibility = 'personal'
            and s.owner_user_id = $1
            and me.invalidated_at is null
            and me.visibility = 'personal'
            and me.owner_user_id = $1
            and coalesce(s.metadata ->> 'threadNameSource', '') <> 'manual'
            and (
              s.metadata ->> 'threadName' is null
              or btrim(s.metadata ->> 'threadName') = ''
              or s.metadata ->> 'threadName' = coalesce(s.external_session_id, '')
              or s.metadata ->> 'threadName' = s.id::text
              or s.metadata ->> 'threadNameSource' = 'provisional'
          )
          group by s.id
          having count(me.id) filter (where me.payload ->> 'actor' in ('user', 'agent')) >= $2
          order by max(coalesce(me.source_event_time, me.captured_at)) desc, s.id desc
          limit $3
        )
        select
          es.*,
          coalesce(source_items.source_items, '[]'::jsonb) as source_items
        from eligible_sessions es
        left join lateral (
          select jsonb_agg(
            jsonb_build_object(
              'id', item.id,
              'actor', item.payload ->> 'actor',
              'content', item.payload ->> 'content',
              'capturedAt', item.captured_at
            )
            order by item.captured_at asc, item.id asc
          ) as source_items
          from (
            select me.id, me.payload, me.captured_at
            from memory_events me
            where me.session_id = es.id
              and me.invalidated_at is null
              and me.visibility = 'personal'
              and me.owner_user_id = $1
              and me.payload ->> 'actor' in ('user', 'assistant', 'agent', 'subagent')
              and coalesce(me.payload ->> 'content', '') <> ''
            order by me.captured_at asc, me.id asc
            limit 8
          ) item
        ) source_items on true
        order by es.latest_event_at desc, es.id desc
      `,
      [actor.userId, minUserEvents, limit]
    );
    return result.rows.map(mapCapturedSessionTitleCandidate);
  },

  async getLatestCapturedSessionForProject(actor, input) {
    const result = await pool.query<CapturedSessionRow>(
      `
        select ${capturedSessionColumns}
        from sessions
        where owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
          and personal_deleted_at is null
          and (
            cwd = $2
            or metadata ->> 'projectId' = $2
            or metadata ->> 'projectPath' = $2
            or automatic_project_id = $2
            or project_override_id = $2
          )
        order by created_at desc, id desc
        limit 1
      `,
      [actor.userId, input.projectId]
    );
    const row = result.rows[0];
    return row ? mapCapturedSession(row) : null;
  },

  async updateCapturedSessionGeneratedTitle(actor, sessionId, input) {
    const title = normalizeSessionTitle(input.title);
    if (!title) {
      return null;
    }
    const result = await pool.query<CapturedSessionRow>(
      `
        update sessions
        set
          metadata = metadata || jsonb_build_object(
            'threadName', $3::text,
            'threadNameSource', $4::text,
            'threadNameGeneratedAt', now()
          ),
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and invalidated_at is null
          and coalesce(metadata ->> 'threadNameSource', '') <> 'manual'
          and (
            metadata ->> 'threadName' is null
            or btrim(metadata ->> 'threadName') = ''
            or metadata ->> 'threadName' = coalesce(external_session_id, '')
            or metadata ->> 'threadName' = id::text
            or metadata ->> 'threadNameSource' in ('generated', 'lcm', 'provisional')
          )
        returning ${capturedSessionColumns}
      `,
      [actor.userId, sessionId, title, input.source]
    );
    return result.rows[0] ? mapCapturedSession(result.rows[0]) : null;
  }
});
