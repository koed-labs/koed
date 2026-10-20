import type pg from "pg";
import {
  createProjectSourceSchema,
  type CreateProjectSource,
  type ProjectSource
} from "@koed/shared";
import {
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectCapabilityError
} from "./project-api-repository.js";
import { appendProjectActivityWithClient } from "./project-activity-repository.js";

type Row = Record<string, unknown>;
const iso = (value: unknown) =>
  value == null ? null : new Date(value as Date).toISOString();
const nullableText = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value !== "string")
    throw new TypeError("Expected Project Source text");
  return value;
};
const map = (row: Row): ProjectSource => ({
  id: String(row.id),
  projectId: String(row.project_id),
  kind: row.kind as ProjectSource["kind"],
  name: String(row.name),
  uri: nullableText(row.uri),
  currentRevisionId: nullableText(row.current_revision_id),
  status: row.status as ProjectSource["status"],
  failureReason: row.failure_reason as ProjectSource["failureReason"],
  addedBy: String(row.added_by),
  uses: Number(row.uses),
  deletedAt: iso(row.deleted_at),
  createdAt: iso(row.created_at)!
});

export const createProjectSourceRepository = (pool: pg.Pool) => {
  const project = async (
    client: pg.PoolClient | pg.Pool,
    ownerUserId: string,
    projectId: string,
    lock = false
  ) => {
    const found = await client.query<Row>(
      `select * from projects where owner_user_id=$1 and id=$2 ${lock ? "for update" : ""}`,
      [ownerUserId, projectId]
    );
    if (!found.rows[0]) throw new ProjectNotFoundError("Project not found");
    if (
      found.rows[0].lifecycle !== "active" ||
      found.rows[0].deletion_phase != null
    )
      throw new ProjectConflictError("Project is unavailable during deletion");
    if (
      found.rows[0].team_backend_id != null ||
      found.rows[0].workspace_project_id != null ||
      found.rows[0].team_workspace_id != null
    )
      throw new ProjectCapabilityError(
        "Linked Project sources require Team authority"
      );
  };
  const transaction = async <T>(
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
  return {
    async list(ownerUserId: string, projectId: string) {
      await project(pool, ownerUserId, projectId);
      const result = await pool.query<Row>(
        `select * from project_sources where owner_user_id=$1 and project_id=$2 and deleted_at is null order by created_at desc,id desc`,
        [ownerUserId, projectId]
      );
      return result.rows.map(map);
    },
    async create(
      ownerUserId: string,
      projectId: string,
      input: CreateProjectSource
    ) {
      const validated = createProjectSourceSchema.parse(input);
      return transaction(async (client) => {
        await project(client, ownerUserId, projectId, true);
        // HQ-209 owns binary storage, extraction, and Personal Note revisions.
        if (validated.kind === "doc")
          throw new ProjectCapabilityError(
            "Document ingestion is not available yet"
          );
        const created = await client.query<Row>(
          `insert into project_sources(owner_user_id,project_id,kind,name,uri,status,failure_reason,added_by)
           values($1,$2,$3,$4,$5,$6,$7,$1) returning *`,
          [
            ownerUserId,
            projectId,
            validated.kind,
            validated.name,
            validated.uri ?? null,
            "ready",
            null
          ]
        );
        await appendProjectActivityWithClient(client, {
          ownerUserId,
          projectId,
          actorUserId: ownerUserId,
          kind: "source_added",
          ref: String(created.rows[0]!.id)
        });
        return map(created.rows[0]!);
      });
    },
    async remove(ownerUserId: string, projectId: string, sourceId: string) {
      return transaction(async (client) => {
        await project(client, ownerUserId, projectId, true);
        const found = await client.query<Row>(
          `select * from project_sources where owner_user_id=$1 and project_id=$2 and id=$3 for update`,
          [ownerUserId, projectId, sourceId]
        );
        if (!found.rows[0] || found.rows[0].deleted_at)
          throw new ProjectNotFoundError("Project Source not found");
        if (found.rows[0].current_revision_id)
          throw new ProjectCapabilityError(
            "Note-backed Project Source trash requires grant freeze"
          );
        const changed = await client.query<Row>(
          `update project_sources set deleted_at=now(),updated_at=now() where owner_user_id=$1 and project_id=$2 and id=$3 returning *`,
          [ownerUserId, projectId, sourceId]
        );
        return map(changed.rows[0]!);
      });
    },
    async retry(ownerUserId: string, projectId: string, sourceId: string) {
      // A failed document remains failed until HQ-209 can create a real revision.
      await project(pool, ownerUserId, projectId);
      const found = await pool.query<Row>(
        `select * from project_sources where owner_user_id=$1 and project_id=$2 and id=$3 and deleted_at is null`,
        [ownerUserId, projectId, sourceId]
      );
      if (!found.rows[0])
        throw new ProjectNotFoundError("Project Source not found");
      if (found.rows[0].status !== "failed")
        throw new ProjectConflictError("Project Source is not failed");
      throw new ProjectCapabilityError("Source retry is not available yet");
    },
    // Trusted runtime producer only. A renderer/API client cannot call this.
    async recordTrustedUse(input: {
      ownerUserId: string;
      projectId: string;
      sourceId: string;
      capturedSessionId: string;
      turnId: string;
      provenance: "citation" | "tool_read";
    }) {
      return transaction(async (client) => {
        await project(client, input.ownerUserId, input.projectId, true);
        const source = await client.query<Row>(
          `select id from project_sources where owner_user_id=$1 and project_id=$2 and id=$3 and deleted_at is null for update`,
          [input.ownerUserId, input.projectId, input.sourceId]
        );
        if (!source.rows[0])
          throw new ProjectNotFoundError("Project Source not found");
        const session = await client.query(
          `select 1 from sessions where owner_user_id=$1 and id=$2 and visibility='personal'
             and personal_deleted_at is null and trashed_at is null and invalidated_at is null
             and (case when project_override_id is not null then project_override_personal_project_id
                       else automatic_personal_project_id end)=$3`,
          [input.ownerUserId, input.capturedSessionId, input.projectId]
        );
        if (!session.rows[0])
          throw new ProjectCapabilityError(
            "Trusted turn does not belong to the Project"
          );
        const inserted = await client.query(
          `insert into project_source_turn_uses(owner_user_id,source_id,captured_session_id,turn_id,provenance)
           values($1,$2,$3,$4,$5) on conflict do nothing returning source_id`,
          [
            input.ownerUserId,
            input.sourceId,
            input.capturedSessionId,
            input.turnId,
            input.provenance
          ]
        );
        if (inserted.rows[0])
          await client.query(
            `update project_sources set uses=uses+1,updated_at=now() where owner_user_id=$1 and id=$2`,
            [input.ownerUserId, input.sourceId]
          );
        return Boolean(inserted.rows[0]);
      });
    }
  };
};
export type ProjectSourceRepository = ReturnType<
  typeof createProjectSourceRepository
>;
