import {
  personalModelSchemaInstalled,
  assertPersonalLegacyWriteSupported
} from "./personal-model-boundary.js";
import type pg from "pg";
import { repositoryIdentitySchema, repositoryScopeId } from "@koed/shared";
import type { PersonalProjectReference } from "./types.js";

type ProjectTarget = PersonalProjectReference & {
  repositoryIdentity: import("@koed/shared").RepositoryIdentity;
};

export const lockProjectRouting = (
  client: pg.PoolClient,
  ownerUserId: string,
  shared: boolean
) =>
  client.query(
    `select ${shared ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock"}(hashtextextended($1,0))`,
    [`project-routing:${ownerUserId}`]
  );

export const resolveProjectRouting = async (
  client: Pick<pg.Pool, "query">,
  ownerUserId: string,
  sourceProjectId: string
): Promise<ProjectTarget | null> => {
  if (await personalModelSchemaInstalled(client)) return null;
  const result = await client.query<{
    target_project_id: string;
    target_name: string;
    target_path: string | null;
    target_identity: unknown;
  }>(
    "select target_project_id,target_name,target_path,target_identity from personal_project_routes where owner_user_id=$1 and source_project_id=$2",
    [ownerUserId, sourceProjectId]
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.target_project_id,
        name: row.target_name,
        path: row.target_path,
        repositoryIdentity: repositoryIdentitySchema.parse(row.target_identity)
      }
    : null;
};

export const moveProjectConversations = async (
  pool: pg.Pool,
  ownerUserId: string,
  input: { sourceProjectId: string; project: PersonalProjectReference }
): Promise<{ movedCount: number; projectId: string }> => {
  await assertPersonalLegacyWriteSupported(pool);
  const identity = repositoryIdentitySchema.parse(
    input.project.repositoryIdentity
  );
  const name = input.project.name.trim();
  if (!name || name.length > 160)
    throw Object.assign(
      new Error("Enter a Project name of 1 to 160 characters"),
      { statusCode: 400 }
    );
  if (
    identity.kind === "unresolved" ||
    repositoryScopeId(identity) === input.sourceProjectId
  )
    throw Object.assign(
      new Error("Choose a different resolved destination Project"),
      { statusCode: 400 }
    );
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockProjectRouting(client, ownerUserId, false);
    const target = (await resolveProjectRouting(
      client,
      ownerUserId,
      repositoryScopeId(identity)
    )) ?? {
      ...input.project,
      name,
      id: repositoryScopeId(identity),
      repositoryIdentity: identity
    };
    if (target.id === input.sourceProjectId)
      throw Object.assign(
        new Error("This move would create a Project routing cycle"),
        { statusCode: 409 }
      );
    const result = await client.query(
      `
      with selected as (
        select id from sessions where owner_user_id=$1 and visibility='personal'
          and invalidated_at is null and personal_deleted_at is null
          and (repository_scope_id(coalesce(repository_override_identity,repository_automatic_identity))=$2
            or ($2='unassigned' and repository_scope_id(coalesce(repository_override_identity,repository_automatic_identity)) is null))
        order by id for update
      )
      update sessions s set repository_override_identity=$6::jsonb,
        repository_assignment_version=repository_assignment_version+1,repository_assignment_revision_id=null,
        project_override_id=$3, project_override_name=$4, project_override_path=$5,
        project_override_at=now(), project_override_by_user_id=$1, updated_at=now()
      from selected where s.id=selected.id returning s.id
    `,
      [
        ownerUserId,
        input.sourceProjectId,
        target.id,
        target.name,
        target.path,
        target.repositoryIdentity
      ]
    );
    const movedCount = result.rowCount ?? 0;
    if (movedCount && input.sourceProjectId !== "unassigned") {
      // Flatten inbound routes when a destination is moved again. All lookups
      // remain one hop, and selecting an ancestor cannot introduce a cycle.
      await client.query(
        `update personal_project_routes set target_project_id=$3,target_name=$4,target_path=$5,target_identity=$6,updated_at=now() where owner_user_id=$1 and target_project_id=$2`,
        [
          ownerUserId,
          input.sourceProjectId,
          target.id,
          target.name,
          target.path,
          target.repositoryIdentity
        ]
      );
      await client.query(
        `insert into personal_project_routes(owner_user_id,source_project_id,target_project_id,target_name,target_path,target_identity) values($1,$2,$3,$4,$5,$6) on conflict(owner_user_id,source_project_id) do update set target_project_id=excluded.target_project_id,target_name=excluded.target_name,target_path=excluded.target_path,target_identity=excluded.target_identity,updated_at=now()`,
        [
          ownerUserId,
          input.sourceProjectId,
          target.id,
          target.name,
          target.path,
          target.repositoryIdentity
        ]
      );
    }
    await client.query("commit");
    return { movedCount, projectId: target.id };
  } catch (cause) {
    await client.query("rollback").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
};

export const createProjectRoutingRepository = (pool: pg.Pool) => ({
  resolveProjectRouting: (actor: { userId: string }, sourceProjectId: string) =>
    resolveProjectRouting(pool, actor.userId, sourceProjectId)
});
export type ProjectRoutingRepository = ReturnType<
  typeof createProjectRoutingRepository
>;
