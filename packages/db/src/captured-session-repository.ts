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
      workspaceId?: string;
      externalSessionId?: string;
      sourceRuntime?: SourceRuntime;
      captureMethod?: CaptureMethod;
      model?: string;
      cwd?: string;
      codexTranscriptPath?: string;
      idempotencyKey?: string;
      sourceHash?: string;
      metadata?: Record<string, unknown>;
      detectedProjects?: PersonalProjectReference[];
    }
  ): Promise<CapturedSessionRecord>;
  getCapturedSession(
    actor: ActorContext,
    sessionId: string
  ): Promise<CapturedSessionRecord | null>;
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
    input: { workspaceId: string }
  ): Promise<CapturedSessionRecord | null>;
  updateCapturedSessionGeneratedTitle(
    actor: ActorContext,
    sessionId: string,
    input: { title: string; source: "generated" | "lcm" | "provisional" }
  ): Promise<CapturedSessionRecord | null>;
}

type CapturedSessionRow = {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  external_session_id: string | null;
  workspace_id: string | null;
  source_runtime: SourceRuntime;
  capture_method: CaptureMethod;
  model: string | null;
  cwd: string | null;
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
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    externalSessionId: row.external_session_id,
    workspaceId:
      row.workspace_id ??
      (typeof row.metadata?.workspaceId === "string"
        ? row.metadata.workspaceId
        : null),
    sourceRuntime: row.source_runtime,
    captureMethod: row.capture_method,
    model: row.model,
    cwd: row.cwd,
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const normalizeSessionMetadata = (input: {
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> => {
  const metadata = { ...(input.metadata ?? {}) };
  if (input.workspaceId && typeof metadata.workspaceId !== "string") {
    metadata.workspaceId = input.workspaceId;
  }
  return metadata;
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
  workspaceId?: string;
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
          (input.workspaceId && input.workspaceId !== "default"
            ? input.workspaceId
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
  workspaceId?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  detectedProjects?: PersonalProjectReference[];
}): boolean =>
  input.detectedProjects !== undefined ||
  input.workspaceId !== undefined ||
  input.cwd !== undefined ||
  ["localProjectId", "projectId", "projectPath", "projectName"].some((key) =>
    Object.hasOwn(input.metadata ?? {}, key)
  );

const capturedSessionColumns = `
  id, owner_user_id, visibility, external_session_id, workspace_id,
  source_runtime, capture_method, model, cwd, metadata,
  captured_project_provenance,
  automatic_project_id, automatic_project_name, automatic_project_path,
  automatic_project_detected_at,
  project_override_id, project_override_name, project_override_path,
  project_override_at, created_at
`;

const resolveWorkspaceForeignKey = async (
  pool: pg.Pool,
  actor: ActorContext,
  workspaceId: string | undefined
): Promise<string | null> => {
  if (!workspaceId || !UUID_PATTERN.test(workspaceId)) {
    return null;
  }
  const result = await pool.query<{ id: string }>(
    `
      select id
      from workspaces
      where id = $1
        and owner_user_id = $2
        and visibility = 'personal'
        and archived_at is null
      limit 1
    `,
    [workspaceId, actor.userId]
  );
  return result.rows[0]?.id ?? null;
};

export const createCapturedSessionRepository = (
  pool: pg.Pool
): CapturedSessionRepository => ({
  async createCapturedSession(actor, input) {
    const metadata = normalizeSessionMetadata(input);
    const workspaceForeignKey = await resolveWorkspaceForeignKey(
      pool,
      actor,
      input.workspaceId
    );
    const detectedProjects = detectedProjectsForCapture(input);
    const automaticProject =
      detectedProjects.length === 1 ? detectedProjects[0]! : null;
    const detectedProjectInputProvided = hasDetectedProjectInput(input);
    const capturedProjectProvenance = {
      schemaVersion: 1,
      capturedCwd: input.cwd ?? null,
      capturedWorkspaceId: input.workspaceId ?? null,
      candidates: detectedProjects,
      outcome:
        detectedProjects.length === 1
          ? "unambiguous"
          : detectedProjects.length > 1
            ? "ambiguous"
            : "no_signal"
    };
    const result = await pool.query<CapturedSessionRow>(
      `
        insert into sessions (
          owner_user_id,
          workspace_id,
          visibility,
          external_session_id,
          source_runtime,
          capture_method,
          codex_transcript_path,
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
          automatic_project_detected_at
        )
        values (
          $1, $2, 'personal', $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          (
            select id
            from sessions parent
            where parent.owner_user_id = $1
              and parent.visibility = 'personal'
              and (
                parent.external_thread_id = $16
                or parent.external_session_id = $16
                or parent.id::text = $16
              )
            order by parent.created_at desc
            limit 1
          ),
          $17, $18, $19, $20, $21,
          $22, $23, $24, $25,
          case when $23::text is null then null else now() end
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
          source_metadata = sessions.source_metadata || excluded.source_metadata,
          automatic_project_id = case
            when $26::boolean then excluded.automatic_project_id
            else sessions.automatic_project_id
          end,
          automatic_project_name = case
            when $26::boolean then excluded.automatic_project_name
            else sessions.automatic_project_name
          end,
          automatic_project_path = case
            when $26::boolean then excluded.automatic_project_path
            else sessions.automatic_project_path
          end,
          automatic_project_detected_at = case
            when $26::boolean then excluded.automatic_project_detected_at
            else sessions.automatic_project_detected_at
          end
        where sessions.owner_user_id = excluded.owner_user_id
          and sessions.visibility = excluded.visibility
          and sessions.invalidated_at is null
          and sessions.personal_deleted_at is null
        returning ${capturedSessionColumns}
      `,
      [
        actor.userId,
        workspaceForeignKey,
        input.externalSessionId ?? null,
        input.sourceRuntime ?? "codex",
        input.captureMethod ?? "mcp",
        input.codexTranscriptPath ?? null,
        input.idempotencyKey ?? null,
        input.sourceHash ?? null,
        input.model ?? null,
        input.cwd ?? null,
        metadata,
        "codex",
        input.sourceRuntime === "codex-cli"
          ? "codex-cli-hook-v1"
          : "codex-app-server-v1",
        input.externalSessionId ?? null,
        typeof metadata.forked_from_id === "string"
          ? metadata.forked_from_id
          : null,
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
        detectedProjectInputProvided
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
    return mapCapturedSession(row);
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
            workspace_id::text = $2
            or cwd = $2
            or metadata ->> 'workspaceId' = $2
            or metadata ->> 'projectPath' = $2
          )
        order by created_at desc, id desc
        limit 1
      `,
      [actor.userId, input.workspaceId]
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
