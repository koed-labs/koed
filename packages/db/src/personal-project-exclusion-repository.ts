import { assertPersonalMembershipMutationReady } from "./personal-membership-mutation-guard.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalOwnerIdSchema,
  personalProjectAddSessionSchema,
  personalProjectAddBackSchema,
  personalProjectExclusionSchema,
  personalMembershipExclusionSyncSchema,
  personalProjectMembershipExplanationSchema
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  appendPersonalMembershipRevision,
  ensurePersonalDirectInclusionWithClient,
  lockPersonalMembershipSource,
  lockPersonalNamedProject,
  mapPersonalNamedProject,
  resolvePersonalMembershipSourceReference,
  withPersonalMembershipTransaction
} from "./personal-membership-repository.js";
import { listPersonalProjectMembershipReasonsWithClient } from "./personal-project-rule-repository.js";

type ExclusionRow = {
  exclusion_id: string;
  project_id: string;
  logical_session_id: string;
  source_reference: unknown;
  version: number;
  head_revision_id: string;
  cleared_at: Date | null;
};
const mapExclusion = (row: ExclusionRow) =>
  personalProjectExclusionSchema.parse({
    exclusionId: row.exclusion_id,
    projectId: row.project_id,
    logicalSessionId: row.logical_session_id,
    sourceReference: row.source_reference,
    version: row.version,
    headRevisionId: row.head_revision_id,
    clearedAt: row.cleared_at?.toISOString() ?? null
  });
const readExclusion = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string,
  logicalSessionId: string
) => {
  const result = await client.query<ExclusionRow>(
    "select * from personal_project_exclusions where owner_user_id=$1 and project_id=$2 and logical_session_id=$3 for update",
    [actor.userId, projectId, logicalSessionId]
  );
  return result.rows[0];
};
const explain = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string,
  sessionId: string,
  logicalSessionId: string
) => {
  const reasons = await listPersonalProjectMembershipReasonsWithClient(
    client,
    actor,
    projectId,
    [sessionId],
    true
  );
  const row = await readExclusion(client, actor, projectId, logicalSessionId);
  const exclusion = row ? mapExclusion(row) : null;
  const graph = await client.query<{
    entity_identity: string;
    state: "pending" | "available" | "conflict";
    heads: string[];
    operation: string | null;
  }>(
    `select e.entity_identity,e.state,e.heads,e.current_revision->'operation'->>'kind' operation
     from personal_membership_entities e join personal_source_bindings b on b.binding_id=e.source_binding_id and b.owner_user_id=e.owner_user_id
     where e.owner_user_id=$1 and e.local_project_id=$2 and e.entity_kind='exclusion'
      and b.local_session_id=$3 and b.local_logical_session_id=$4`,
    [actor.userId, projectId, sessionId, logicalSessionId]
  );
  if (graph.rows.length > 1)
    throw new TypeError("PersonalMembershipExclusionIdentityError");
  const node = graph.rows[0];
  const syncExclusion = node
    ? personalMembershipExclusionSyncSchema.parse({
        entityId: node.entity_identity,
        state: node.state,
        heads: node.heads,
        blocked:
          node.state !== "available" || node.operation !== "clear_exclusion"
      })
    : undefined;
  return personalProjectMembershipExplanationSchema.parse({
    sessionId,
    logicalSessionId,
    reasons: reasons[0]?.reasons ?? [],
    exclusion,
    ...(syncExclusion ? { syncExclusion } : {}),
    included:
      !!reasons[0]?.reasons.length &&
      (!exclusion || exclusion.clearedAt !== null) &&
      !syncExclusion?.blocked
  });
};
const advance = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string
) => {
  const result = await client.query<
    Parameters<typeof mapPersonalNamedProject>[0]
  >(
    "update personal_named_projects set version=version+1,updated_at=now() where owner_user_id=$1 and project_id=$2 returning *",
    [actor.userId, projectId]
  );
  return mapPersonalNamedProject(result.rows[0]!);
};

/** Exclusion is organization metadata; it never deletes or edits source context. */
export const createPersonalProjectExclusionRepository = (pool: pg.Pool) => ({
  async explainPersonalProjectSession(
    actor: ActorContext,
    rawProjectId: string,
    raw: { sessionId: string; expectedVersion: number }
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalProjectAddSessionSchema.parse(raw);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      async (client) => {
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
        return {
          project: mapPersonalNamedProject(project),
          explanation: await explain(
            client,
            actor,
            projectId,
            input.sessionId,
            logicalSessionId
          )
        };
      },
      { notify: false }
    );
  },
  async excludePersonalProjectSession(
    actor: ActorContext,
    rawProjectId: string,
    raw: { sessionId: string; expectedVersion: number }
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalProjectAddSessionSchema.parse(raw);
    return withPersonalMembershipTransaction(pool, actor, async (client) => {
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
      const previous = await readExclusion(
        client,
        actor,
        projectId,
        logicalSessionId
      );
      await assertPersonalMembershipMutationReady(client, {
        ownerUserId: actor.userId,
        projectId,
        entityKind: "exclusion",
        localEntityId: previous?.exclusion_id,
        logicalSessionId
      });
      if (previous && !previous.cleared_at)
        return {
          project: mapPersonalNamedProject(project),
          explanation: await explain(
            client,
            actor,
            projectId,
            input.sessionId,
            logicalSessionId
          )
        };
      const sourceReference = await resolvePersonalMembershipSourceReference(
        client,
        actor,
        input.sessionId,
        logicalSessionId,
        previous?.source_reference
      );
      const exclusionId = previous?.exclusion_id ?? randomUUID(),
        revisionId = randomUUID();
      await client.query(
        `insert into personal_project_exclusions(exclusion_id,owner_user_id,project_id,logical_session_id,source_reference,head_revision_id) values($1,$2,$3,$4,$5,$6)
        on conflict(owner_user_id,project_id,logical_session_id) do update set cleared_at=null,version=personal_project_exclusions.version+1,source_reference=excluded.source_reference,head_revision_id=excluded.head_revision_id,updated_at=now()`,
        [
          exclusionId,
          actor.userId,
          projectId,
          logicalSessionId,
          sourceReference,
          revisionId
        ]
      );
      await appendPersonalMembershipRevision(
        client,
        actor,
        projectId,
        exclusionId,
        revisionId,
        previous ? [previous.head_revision_id] : [],
        "exclude",
        { logicalSessionId, sourceReference }
      );
      return {
        project: await advance(client, actor, projectId),
        explanation: await explain(
          client,
          actor,
          projectId,
          input.sessionId,
          logicalSessionId
        )
      };
    });
  },
  async restorePersonalProjectSession(
    actor: ActorContext,
    rawProjectId: string,
    raw: {
      sessionId: string;
      expectedVersion: number;
      exclusionId: string;
      expectedExclusionRevisionId: string;
    }
  ) {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalProjectAddBackSchema.parse(raw);
    return withPersonalMembershipTransaction(pool, actor, async (client) => {
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
      const previous = await readExclusion(
        client,
        actor,
        projectId,
        logicalSessionId
      );
      await assertPersonalMembershipMutationReady(client, {
        ownerUserId: actor.userId,
        projectId,
        entityKind: "exclusion",
        localEntityId: previous?.exclusion_id,
        logicalSessionId
      });
      if (
        !previous ||
        previous.exclusion_id !== input.exclusionId ||
        previous.head_revision_id !== input.expectedExclusionRevisionId
      )
        throw Object.assign(
          new Error("Exclusion changed. Review membership before adding back."),
          { statusCode: 409 }
        );
      // Validate retained provenance even if the direct inclusion is already active.
      const sourceReference = await resolvePersonalMembershipSourceReference(
        client,
        actor,
        input.sessionId,
        logicalSessionId,
        previous.source_reference
      );
      if (!previous.cleared_at) {
        const revisionId = randomUUID();
        await client.query(
          "update personal_project_exclusions set cleared_at=now(),version=version+1,head_revision_id=$4,source_reference=$5,updated_at=now() where owner_user_id=$1 and project_id=$2 and exclusion_id=$3",
          [
            actor.userId,
            projectId,
            input.exclusionId,
            revisionId,
            sourceReference
          ]
        );
        await appendPersonalMembershipRevision(
          client,
          actor,
          projectId,
          input.exclusionId,
          revisionId,
          [previous.head_revision_id],
          "clear_exclusion",
          { logicalSessionId, sourceReference }
        );
      }
      const direct = await ensurePersonalDirectInclusionWithClient(
        client,
        actor,
        projectId,
        input.sessionId,
        logicalSessionId
      );
      return {
        project:
          !previous.cleared_at || direct.changed
            ? await advance(client, actor, projectId)
            : mapPersonalNamedProject(project),
        membership: direct.membership,
        explanation: await explain(
          client,
          actor,
          projectId,
          input.sessionId,
          logicalSessionId
        )
      };
    });
  }
});
export type PersonalProjectExclusionRepository = ReturnType<
  typeof createPersonalProjectExclusionRepository
>;
