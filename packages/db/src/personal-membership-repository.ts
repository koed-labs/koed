import { retainPersonalMembershipLocalChange } from "./personal-membership-local-change.js";
import { suppressPersonalProjectDefault } from "./personal-project-default-suppression.js";
import { freezePersonalMembershipLocalParents } from "./personal-membership-local-parents.js";
import { assertPersonalMembershipMutationReady } from "./personal-membership-mutation-guard.js";
import {
  personalDirectMembershipReadySql,
  personalGraphExclusionBlocksSql
} from "./personal-membership-selection-sql.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalNamedProjectSchema,
  personalDirectMembershipSchema,
  personalProjectCreateSchema,
  personalProjectUpdateSchema,
  personalProjectVersionSchema,
  personalProjectAddSessionSchema,
  personalSourceReferenceSchema,
  personalOwnerIdSchema,
  type PersonalNamedProject,
  type PersonalDirectMembership
} from "@koed/shared";
import type { ActorContext } from "./types.js";

const uuid = personalOwnerIdSchema;
const unavailable = () =>
  Object.assign(new Error("Personal Project not found"), { statusCode: 404 });
const stale = () =>
  Object.assign(new Error("Project changed. Reload it before saving."), {
    statusCode: 409
  });
type ProjectRow = {
  project_id: string;
  name: string;
  version: number;
  head_revision_id: string;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type InclusionRow = {
  inclusion_id: string;
  project_id: string;
  logical_session_id: string;
  source_reference: unknown;
  version: number;
  head_revision_id: string;
  removed_at: Date | null;
};
export const mapPersonalNamedProject = (
  row: ProjectRow
): PersonalNamedProject =>
  personalNamedProjectSchema.parse({
    projectId: row.project_id,
    name: row.name,
    version: row.version,
    headRevisionId: row.head_revision_id,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  });
const mapInclusion = (row: InclusionRow): PersonalDirectMembership =>
  personalDirectMembershipSchema.parse({
    inclusionId: row.inclusion_id,
    projectId: row.project_id,
    logicalSessionId: row.logical_session_id,
    sourceReference: row.source_reference,
    version: row.version,
    headRevisionId: row.head_revision_id,
    removedAt: row.removed_at?.toISOString() ?? null
  });

export type PersonalMembershipTransaction = {
  ownerUserId: string;
  client: pg.PoolClient;
};
export const personalMembershipTransactionRunner =
  (pool: pg.Pool, transaction?: PersonalMembershipTransaction) =>
  <T>(
    actor: ActorContext,
    run: (client: pg.PoolClient) => Promise<T>,
    options: { notify?: boolean; kind?: string } = {}
  ) =>
    withPersonalMembershipTransaction(pool, actor, run, {
      ...options,
      transaction
    });

export const withPersonalMembershipTransaction = async <T>(
  pool: pg.Pool,
  actor: ActorContext,
  run: (client: pg.PoolClient) => Promise<T>,
  options: {
    notify?: boolean;
    kind?: string;
    transaction?: PersonalMembershipTransaction;
  } = {}
): Promise<T> => {
  if (options.transaction) {
    if (options.transaction.ownerUserId !== actor.userId)
      throw new TypeError("Personal membership transaction owner differs");
    return run(options.transaction.client);
  }
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Commit order for one owner must match the journal cursor order.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      `personal-membership:${actor.userId}`
    ]);
    const owner = await client.query(
      "select id from users where id=$1 and disabled_at is null and deleted_at is null for share",
      [actor.userId]
    );
    if (!owner.rows.length)
      throw Object.assign(new Error("User is unavailable"), {
        statusCode: 403
      });
    const result = await run(client);
    if (options.notify !== false)
      await client.query("select pg_notify('koed_graph_updates',$1)", [
        JSON.stringify({
          ownerUserId: actor.userId,
          visibility: "personal",
          kind: options.kind ?? "personal_membership_changed"
        })
      ]);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};
export const lockPersonalNamedProject = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string,
  expectedVersion: number
): Promise<ProjectRow> => {
  const result = await client.query<ProjectRow>(
    "select * from personal_named_projects where owner_user_id=$1 and project_id=$2 and deleted_at is null for update",
    [actor.userId, projectId]
  );
  const row = result.rows[0];
  if (!row) throw unavailable();
  if (row.version !== expectedVersion) throw stale();
  await assertPersonalMembershipMutationReady(client, {
    ownerUserId: actor.userId,
    projectId
  });
  return row;
};
export const appendPersonalMembershipRevision = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string,
  entityId: string,
  revisionId: string,
  replaces: string[],
  operation: string,
  value: Record<string, unknown>
) => {
  const portableMembership = await freezePersonalMembershipLocalParents(
    client,
    {
      ownerUserId: actor.userId,
      projectId,
      entityId,
      replaces
    }
  );
  await client.query(
    `insert into personal_membership_changes(owner_user_id,project_id,entity_id,revision_id,replaces,operation,value) values($1,$2,$3,$4,$5,$6,$7)`,
    [
      actor.userId,
      projectId,
      entityId,
      revisionId,
      replaces,
      operation,
      JSON.stringify(
        portableMembership ? { ...value, portableMembership } : value
      )
    ]
  );
  await retainPersonalMembershipLocalChange(client, {
    ownerUserId: actor.userId,
    projectId,
    entityId,
    operation
  });
  await client.query(
    "select pg_notify('koed_pds_local_sync','personal_membership_changed')"
  );
};

export const lockPersonalMembershipSource = async (
  client: pg.PoolClient,
  actor: ActorContext,
  sessionId: string
): Promise<string> => {
  const sessions = await client.query<{ logical_session_id: string }>(
    `select logical_session_id from sessions where id=$2 and owner_user_id=$1 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for share`,
    [actor.userId, sessionId]
  );
  const source = sessions.rows[0];
  if (!source)
    throw Object.assign(new Error("Conversation not found or not available"), {
      statusCode: 404
    });
  return source.logical_session_id;
};
export const resolvePersonalMembershipSourceReference = async (
  client: pg.PoolClient,
  actor: ActorContext,
  sessionId: string,
  logicalSessionId: string,
  retained: unknown
) => {
  // A verified Personal source binding retains the signed opaque logical identity.
  // Native source-journal provenance remains the fallback for local captures.
  const bindings = await client.query<{
    originating_deployment_id: string;
    originating_device_id: string;
    source_logical_session_id: string;
  }>(
    `select originating_deployment_id,originating_device_id,source_logical_session_id
     from personal_source_bindings where owner_user_id=$1 and local_session_id=$2
     and local_logical_session_id=$3 and availability='available'`,
    [actor.userId, sessionId, logicalSessionId]
  );
  if (bindings.rows.length > 1)
    throw Object.assign(new Error("Conversation origin is ambiguous"), {
      statusCode: 409
    });
  const origins = await client.query<{
    origin_deployment_id: string;
    origin_device_id: string;
  }>(
    `select distinct origin_deployment_id,origin_device_id from conversation_source_artifacts where session_id=$2 and owner_user_id=$1 and lifecycle in ('active','finalizing','finalized') and origin_key_status='active'`,
    [actor.userId, sessionId]
  );
  const origin = origins.rows.length === 1 ? origins.rows[0] : null;
  const binding = bindings.rows[0];
  const reference = binding
    ? personalSourceReferenceSchema.safeParse({
        ownerUserId: actor.userId,
        originatingDeploymentId: binding.originating_deployment_id,
        originatingDeviceId: binding.originating_device_id,
        logicalSessionId: binding.source_logical_session_id
      })
    : origin
      ? personalSourceReferenceSchema.safeParse({
          ownerUserId: actor.userId,
          originatingDeploymentId: origin.origin_deployment_id,
          originatingDeviceId: origin.origin_device_id,
          logicalSessionId: logicalSessionId
        })
      : null;
  const discoveredReference = reference?.success ? reference.data : null;
  const retainedReference = retained
    ? personalSourceReferenceSchema.parse(retained)
    : null;
  if (
    retainedReference &&
    discoveredReference &&
    JSON.stringify(retainedReference) !== JSON.stringify(discoveredReference)
  ) {
    // A first portable freeze may have proved the PDS alias through the exact
    // owned body and native audit. Preserve the historical native reference.
    const alias = await client.query(
      `select 1 from personal_membership_entities e
       join lateral (
         select owner_user_id,project_id,inclusion_id entity_id,logical_session_id,source_reference from personal_project_inclusions where e.entity_kind='direct'
         union all select owner_user_id,project_id,exclusion_id entity_id,logical_session_id,source_reference from personal_project_exclusions where e.entity_kind='exclusion'
       ) i on i.owner_user_id=e.owner_user_id and i.project_id=e.local_project_id and i.entity_id=e.local_entity_id
       join personal_source_bindings b on b.owner_user_id=e.owner_user_id and b.binding_id=e.source_binding_id
       join personal_membership_revisions r on r.owner_user_id=e.owner_user_id and r.project_identity=e.project_identity and r.entity_identity=e.entity_identity
       join personal_membership_changes c on c.revision_id=r.native_change_revision_id and c.owner_user_id=i.owner_user_id and c.project_id=i.project_id and c.entity_id=i.entity_id
       where e.owner_user_id=$1 and e.entity_kind in ('direct','exclusion') and i.logical_session_id=$2 and i.source_reference=$3::jsonb
         and b.local_session_id=$4 and b.local_logical_session_id=i.logical_session_id and b.availability='available'
         and b.originating_deployment_id=$5 and b.originating_device_id=$6 and b.source_logical_session_id=$7
         and c.operation in ('include_session','exclude') and c.value->>'logicalSessionId'=i.logical_session_id::text limit 1`,
      [
        actor.userId,
        logicalSessionId,
        retainedReference,
        sessionId,
        discoveredReference.originatingDeploymentId,
        discoveredReference.originatingDeviceId,
        discoveredReference.logicalSessionId
      ]
    );
    if (!alias.rowCount)
      throw Object.assign(
        new Error(
          "Conversation origin changed. Its inclusion was not replaced."
        ),
        { statusCode: 409 }
      );
  }
  if (retainedReference && retainedReference.ownerUserId !== actor.userId)
    throw Object.assign(
      new Error("Conversation origin belongs to another owner"),
      { statusCode: 409 }
    );
  return retainedReference ?? discoveredReference;
};
export const ensurePersonalDirectInclusionWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string,
  sessionId: string,
  logicalSessionId: string,
  legacyUpgrade?: { reviewId: string; itemId: string }
) => {
  const current = await client.query<InclusionRow>(
    `select * from personal_project_inclusions where owner_user_id=$1 and project_id=$2 and logical_session_id=$3 for update`,
    [actor.userId, projectId, logicalSessionId]
  );
  const previous = current.rows[0];
  await assertPersonalMembershipMutationReady(client, {
    ownerUserId: actor.userId,
    projectId,
    entityKind: "direct",
    localEntityId: previous?.inclusion_id,
    logicalSessionId
  });
  if (previous && !previous.removed_at)
    return { membership: mapInclusion(previous), changed: false };
  const sourceReference = await resolvePersonalMembershipSourceReference(
    client,
    actor,
    sessionId,
    logicalSessionId,
    previous?.source_reference
  );
  const revisionId = randomUUID(),
    inclusionId = previous?.inclusion_id ?? randomUUID();
  const included = await client.query<InclusionRow>(
    `insert into personal_project_inclusions(inclusion_id,owner_user_id,project_id,logical_session_id,source_reference,head_revision_id) values($1,$2,$3,$4,$5,$6) on conflict(owner_user_id,project_id,logical_session_id) do update set removed_at=null,version=personal_project_inclusions.version+1,source_reference=excluded.source_reference,head_revision_id=excluded.head_revision_id,updated_at=now() returning *`,
    [
      inclusionId,
      actor.userId,
      projectId,
      logicalSessionId,
      sourceReference ? JSON.stringify(sourceReference) : null,
      revisionId
    ]
  );
  await appendPersonalMembershipRevision(
    client,
    actor,
    projectId,
    inclusionId,
    revisionId,
    previous ? [previous.head_revision_id] : [],
    "include_session",
    {
      logicalSessionId: logicalSessionId,
      sourceReference,
      ...(legacyUpgrade ? { legacyUpgrade, sourceProofRequired: true } : {})
    }
  );
  return { membership: mapInclusion(included.rows[0]!), changed: true };
};

export const createPersonalMembershipRepository = (
  pool: pg.Pool,
  transaction?: PersonalMembershipTransaction
) => {
  const transact = personalMembershipTransactionRunner(pool, transaction);
  return {
    async createNamedPersonalProject(
      actor: ActorContext,
      raw: { name: string }
    ): Promise<PersonalNamedProject> {
      const input = personalProjectCreateSchema.parse(raw);
      return transact(actor, async (client) => {
        const projectId = randomUUID(),
          revisionId = randomUUID();
        const result = await client.query<ProjectRow>(
          `insert into personal_named_projects(owner_user_id,project_id,name,head_revision_id) values($1,$2,$3,$4) returning *`,
          [actor.userId, projectId, input.name, revisionId]
        );
        await appendPersonalMembershipRevision(
          client,
          actor,
          projectId,
          projectId,
          revisionId,
          [],
          "set_project",
          { name: input.name }
        );
        return mapPersonalNamedProject(result.rows[0]!);
      });
    },
    async listNamedPersonalProjects(
      actor: ActorContext
    ): Promise<PersonalNamedProject[]> {
      const result = await pool.query<ProjectRow>(
        `select p.* from personal_named_projects p join users u on u.id=p.owner_user_id and u.disabled_at is null and u.deleted_at is null where p.owner_user_id=$1 and p.deleted_at is null order by p.created_at,p.project_id`,
        [actor.userId]
      );
      return result.rows.map(mapPersonalNamedProject);
    },
    async updateNamedPersonalProject(
      actor: ActorContext,
      rawProjectId: string,
      raw: { name: string; expectedVersion: number }
    ): Promise<PersonalNamedProject> {
      const projectId = uuid.parse(rawProjectId),
        input = personalProjectUpdateSchema.parse(raw);
      return transact(actor, async (client) => {
        const previous = await lockPersonalNamedProject(
          client,
          actor,
          projectId,
          input.expectedVersion
        );
        if (previous.name === input.name)
          return mapPersonalNamedProject(previous);
        const revisionId = randomUUID();
        const result = await client.query<ProjectRow>(
          `update personal_named_projects set name=$3,version=version+1,head_revision_id=$4,updated_at=now() where owner_user_id=$1 and project_id=$2 returning *`,
          [actor.userId, projectId, input.name, revisionId]
        );
        await appendPersonalMembershipRevision(
          client,
          actor,
          projectId,
          projectId,
          revisionId,
          [previous.head_revision_id],
          "set_project",
          { name: input.name }
        );
        return mapPersonalNamedProject(result.rows[0]!);
      });
    },
    async deleteNamedPersonalProject(
      actor: ActorContext,
      rawProjectId: string,
      raw: { expectedVersion: number }
    ): Promise<PersonalNamedProject> {
      const projectId = uuid.parse(rawProjectId),
        input = personalProjectVersionSchema.parse(raw);
      return transact(actor, async (client) => {
        const previous = await lockPersonalNamedProject(
            client,
            actor,
            projectId,
            input.expectedVersion
          ),
          revisionId = randomUUID();
        const result = await client.query<ProjectRow>(
          `update personal_named_projects set deleted_at=now(),version=version+1,head_revision_id=$3,updated_at=now() where owner_user_id=$1 and project_id=$2 returning *`,
          [actor.userId, projectId, revisionId]
        );
        await appendPersonalMembershipRevision(
          client,
          actor,
          projectId,
          projectId,
          revisionId,
          [previous.head_revision_id],
          "delete_project",
          {}
        );
        const sources = await client.query<{ target: unknown }>(
          "select target from personal_project_rules where owner_user_id=$1 and project_id=$2",
          [actor.userId, projectId]
        );
        for (const source of sources.rows)
          await suppressPersonalProjectDefault(
            client,
            actor.userId,
            source.target
          );
        return mapPersonalNamedProject(result.rows[0]!);
      });
    },
    async addPersonalProjectSession(
      actor: ActorContext,
      rawProjectId: string,
      raw: { sessionId: string; expectedVersion: number }
    ): Promise<{
      project: PersonalNamedProject;
      membership: PersonalDirectMembership;
    }> {
      const projectId = uuid.parse(rawProjectId),
        input = personalProjectAddSessionSchema.parse(raw);
      return transact(actor, async (client) => {
        const project = await lockPersonalNamedProject(
          client,
          actor,
          projectId,
          input.expectedVersion
        );
        const logicalSessionId = await lockPersonalMembershipSource(
          client,
          actor,
          input.sessionId
        );
        await assertPersonalMembershipMutationReady(client, {
          ownerUserId: actor.userId,
          projectId,
          entityKind: "exclusion",
          logicalSessionId
        });
        const excluded = await client.query(
          `select 1 from sessions exclusion_candidate where exclusion_candidate.owner_user_id=$1 and exclusion_candidate.id=$4
         and (exists(select 1 from personal_project_exclusions where owner_user_id=$1 and project_id=$2 and logical_session_id=$3 and cleared_at is null)
          or ${personalGraphExclusionBlocksSql("exclusion_candidate", "$1", "$2")})`,
          [actor.userId, projectId, logicalSessionId, input.sessionId]
        );
        if (excluded.rows.length)
          throw Object.assign(
            new Error(
              "Conversation is excluded. Review its membership and use Add back."
            ),
            { statusCode: 409, code: "project_session_excluded" }
          );
        const ensured = await ensurePersonalDirectInclusionWithClient(
          client,
          actor,
          projectId,
          input.sessionId,
          logicalSessionId
        );
        if (!ensured.changed)
          return {
            project: mapPersonalNamedProject(project),
            membership: ensured.membership
          };
        const updated = await client.query<ProjectRow>(
          `update personal_named_projects set version=version+1,updated_at=now() where owner_user_id=$1 and project_id=$2 returning *`,
          [actor.userId, projectId]
        );
        return {
          project: mapPersonalNamedProject(updated.rows[0]!),
          membership: ensured.membership
        };
      });
    },
    async removePersonalProjectInclusion(
      actor: ActorContext,
      rawProjectId: string,
      rawInclusionId: string,
      raw: { expectedVersion: number }
    ): Promise<{
      project: PersonalNamedProject;
      membership: PersonalDirectMembership;
    }> {
      const projectId = uuid.parse(rawProjectId),
        inclusionId = uuid.parse(rawInclusionId),
        input = personalProjectVersionSchema.parse(raw);
      return transact(actor, async (client) => {
        const project = await lockPersonalNamedProject(
          client,
          actor,
          projectId,
          input.expectedVersion
        );
        const found = await client.query<InclusionRow>(
          `select * from personal_project_inclusions where inclusion_id=$3 and owner_user_id=$1 and project_id=$2 for update`,
          [actor.userId, projectId, inclusionId]
        );
        const previous = found.rows[0];
        if (!previous)
          throw Object.assign(new Error("Project inclusion not found"), {
            statusCode: 404
          });
        await assertPersonalMembershipMutationReady(client, {
          ownerUserId: actor.userId,
          projectId,
          entityKind: "direct",
          localEntityId: previous.inclusion_id,
          logicalSessionId: previous.logical_session_id
        });
        if (previous.removed_at)
          return {
            project: mapPersonalNamedProject(project),
            membership: mapInclusion(previous)
          };
        const revisionId = randomUUID();
        const removed = await client.query<InclusionRow>(
          `update personal_project_inclusions set removed_at=now(),version=version+1,head_revision_id=$4,updated_at=now() where inclusion_id=$3 and owner_user_id=$1 and project_id=$2 returning *`,
          [actor.userId, projectId, inclusionId, revisionId]
        );
        await appendPersonalMembershipRevision(
          client,
          actor,
          projectId,
          inclusionId,
          revisionId,
          [previous.head_revision_id],
          "remove_inclusion",
          {}
        );
        const updated = await client.query<ProjectRow>(
          `update personal_named_projects set version=version+1,updated_at=now() where owner_user_id=$1 and project_id=$2 returning *`,
          [actor.userId, projectId]
        );
        return {
          project: mapPersonalNamedProject(updated.rows[0]!),
          membership: mapInclusion(removed.rows[0]!)
        };
      });
    },
    async listPersonalProjectMemberships(
      actor: ActorContext,
      rawProjectId: string
    ): Promise<PersonalDirectMembership[]> {
      const projectId = uuid.parse(rawProjectId);
      const result = await pool.query<InclusionRow>(
        `select i.* from personal_project_inclusions i join personal_named_projects p on p.owner_user_id=i.owner_user_id and p.project_id=i.project_id and p.deleted_at is null join users u on u.id=p.owner_user_id and u.disabled_at is null and u.deleted_at is null where i.owner_user_id=$1 and i.project_id=$2 and i.removed_at is null and ${personalDirectMembershipReadySql("i")} order by i.created_at,i.inclusion_id`,
        [actor.userId, projectId]
      );
      return result.rows.map(mapInclusion);
    }
  };
};
export type PersonalMembershipRepository = ReturnType<
  typeof createPersonalMembershipRepository
>;
