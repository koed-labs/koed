import { assertPersonalMembershipMutationReady } from "./personal-membership-mutation-guard.js";
import { findPersonalFolderContext } from "./personal-folder-context-lookup.js";
import { personalDirectMembershipReadySql } from "./personal-membership-selection-sql.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalOwnerIdSchema,
  personalMembershipSelectorKey,
  personalProjectRuleSchema,
  personalProjectRepositoryRuleInputSchema,
  personalProjectFolderRuleInputSchema,
  personalFolderReferenceSchema,
  personalFolderScopeId,
  personalMembershipReasonSchema,
  personalProjectVersionSchema,
  repositoryScopeId,
  type PersonalProjectRule,
  type PersonalNamedProject,
  type PersonalGitContext,
  type PersonalFolderReference,
  type PersonalFolderContext
} from "@koed/shared";
import {
  personalSourceSelectionSql,
  personalProjectRuleMatchesSql,
  resolvePersonalSourceSelection
} from "./personal-selection-sql.js";
import type { ActorContext } from "./types.js";
import {
  withPersonalMembershipTransaction,
  lockPersonalNamedProject,
  mapPersonalNamedProject,
  appendPersonalMembershipRevision
} from "./personal-membership-repository.js";

type RuleRow = {
  inclusion_id: string;
  project_id: string;
  target: unknown;
  folder_context?: unknown;
  version: number;
  head_revision_id: string;
  removed_at: Date | null;
};
const mapRule = (row: RuleRow): PersonalProjectRule =>
  personalProjectRuleSchema.parse({
    inclusionId: row.inclusion_id,
    projectId: row.project_id,
    target: row.target,
    ...(row.folder_context ? { folderContext: row.folder_context } : {}),
    version: row.version,
    headRevisionId: row.head_revision_id,
    removedAt: row.removed_at?.toISOString() ?? null
  });
const advanceProject = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string
): Promise<PersonalNamedProject> => {
  const updated = await client.query<
    Parameters<typeof mapPersonalNamedProject>[0]
  >(
    "update personal_named_projects set version=version+1,updated_at=now() where owner_user_id=$1 and project_id=$2 returning *",
    [actor.userId, projectId]
  );
  return mapPersonalNamedProject(updated.rows[0]!);
};

const assertFolderOwner = (
  actor: ActorContext,
  folder: PersonalFolderReference
) => {
  if (folder.ownerUserId !== actor.userId)
    throw Object.assign(new Error("Folder belongs to another owner"), {
      statusCode: 403
    });
};
export const addPersonalProjectRuleWithClient = async (
  client: pg.PoolClient,
  actor: ActorContext,
  projectId: string,
  expectedVersion: number,
  target: PersonalProjectRule["target"],
  legacyUpgrade?: { reviewId: string; itemId: string }
) => {
  if (target.kind === "folder") assertFolderOwner(actor, target.folder);
  const scope =
    target.kind === "repository"
      ? repositoryScopeId(target.repository)
      : personalFolderScopeId(target.folder);
  const project = await lockPersonalNamedProject(
    client,
    actor,
    projectId,
    expectedVersion
  );
  const current = await client.query<RuleRow>(
    "select * from personal_project_rules where owner_user_id=$1 and project_id=$2 and target_scope=$3 for update",
    [actor.userId, projectId, scope]
  );
  const previous = current.rows[0];
  await assertPersonalMembershipMutationReady(client, {
    ownerUserId: actor.userId,
    projectId,
    entityKind: "rule",
    localEntityId: previous?.inclusion_id,
    selectorKey: personalMembershipSelectorKey(target)
  });
  if (previous && !previous.removed_at)
    return {
      project: mapPersonalNamedProject(project),
      rule: mapRule(previous)
    };
  const folderContext =
    target.kind === "folder"
      ? await findPersonalFolderContext(client, actor, projectId, target.folder)
      : undefined;
  if (target.kind === "folder" && !folderContext)
    throw Object.assign(
      new Error(
        "Folder context is unavailable. Capture from the Folder before including it."
      ),
      { statusCode: 404 }
    );
  const inclusionId = previous?.inclusion_id ?? randomUUID(),
    revisionId = randomUUID();
  const result = await client.query<RuleRow>(
    `insert into personal_project_rules(inclusion_id,owner_user_id,project_id,target,target_scope,head_revision_id,folder_context)
         values($1,$2,$3,$4,$5,$6,$7) on conflict(owner_user_id,project_id,target_scope) do update set
         folder_context=coalesce(personal_project_rules.folder_context,excluded.folder_context),removed_at=null,version=personal_project_rules.version+1,head_revision_id=excluded.head_revision_id,updated_at=now() returning *`,
    [
      inclusionId,
      actor.userId,
      projectId,
      target,
      scope,
      revisionId,
      folderContext ?? null
    ]
  );
  const rule = mapRule(result.rows[0]!);
  await appendPersonalMembershipRevision(
    client,
    actor,
    projectId,
    inclusionId,
    revisionId,
    previous ? [previous.head_revision_id] : [],
    target.kind === "repository" ? "include_repository" : "include_folder",
    {
      target: rule.target,
      ...(legacyUpgrade ? { legacyUpgrade } : {}),
      ...(rule.folderContext ? { folderContext: rule.folderContext } : {})
    }
  );
  return { project: await advanceProject(client, actor, projectId), rule };
};

const addRule = (
  pool: pg.Pool,
  actor: ActorContext,
  projectId: string,
  expectedVersion: number,
  target: PersonalProjectRule["target"]
) =>
  withPersonalMembershipTransaction(pool, actor, (client) =>
    addPersonalProjectRuleWithClient(
      client,
      actor,
      projectId,
      expectedVersion,
      target
    )
  );

/** Shared native and synced inclusion explanations, bounded by the caller. */
export const personalProjectMembershipReasonsSql = (
  session: string,
  owner: string,
  project: string
): string => `
        select i.inclusion_id as id,jsonb_build_object('inclusionId',i.inclusion_id,'revisionId',i.head_revision_id,'kind','session') as value
        from personal_project_inclusions i where i.owner_user_id=${owner} and i.project_id=${project} and i.removed_at is null and i.logical_session_id=${session}.logical_session_id and ${personalDirectMembershipReadySql("i", session)}
        union all select r.inclusion_id as id,jsonb_build_object('inclusionId',r.inclusion_id,'revisionId',r.head_revision_id,'kind',r.target->>'kind') as value
        from personal_project_rules r where r.owner_user_id=${owner} and r.project_id=${project} and r.removed_at is null and ${personalProjectRuleMatchesSql(session, "r")}
`;

export const listPersonalProjectMembershipReasonsWithClient = async (
  client: Pick<pg.Pool, "query">,
  actor: ActorContext,
  rawProjectId: string,
  rawSessionIds: string[],
  includeExcluded = false
) => {
  const projectId = personalOwnerIdSchema.parse(rawProjectId),
    sessionIds = personalOwnerIdSchema.array().max(5000).parse(rawSessionIds);
  if (!sessionIds.length) return [];
  const selection = resolvePersonalSourceSelection(actor.userId, {
    personalSelection: {
      version: 1,
      ownerUserId: actor.userId,
      target: {
        kind: "project",
        project: { ownerUserId: actor.userId, projectId }
      },
      callerRepositoryContext: null
    }
  });
  const result = await client.query<{
    session_id: string;
    logical_session_id: string;
    reasons: unknown;
  }>(
    `
      select s.id as session_id,s.logical_session_id,jsonb_agg(reason.value order by reason.id) as reasons
      from sessions s cross join lateral (
        ${personalProjectMembershipReasonsSql("s", "$1", "$2")}
      ) reason where s.owner_user_id=$1 and s.id=any($3::uuid[]) and ${personalSourceSelectionSql("s", "$4", { inspection: true, ignoreProjectExclusions: includeExcluded })}
      group by s.id,s.logical_session_id`,
    [actor.userId, projectId, sessionIds, selection]
  );
  return result.rows.map((row) => ({
    sessionId: row.session_id,
    logicalSessionId: row.logical_session_id,
    reasons: personalMembershipReasonSchema.array().parse(row.reasons)
  }));
};

export const createPersonalProjectRuleRepository = (pool: pg.Pool) => ({
  async addPersonalProjectRepositoryRule(
    actor: ActorContext,
    rawProjectId: string,
    raw: {
      expectedVersion: number;
      repository: PersonalGitContext;
    }
  ): Promise<{ project: PersonalNamedProject; rule: PersonalProjectRule }> {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalProjectRepositoryRuleInputSchema.parse(raw);
    return addRule(pool, actor, projectId, input.expectedVersion, {
      kind: "repository",
      repository: input.repository
    });
  },
  async addPersonalProjectFolderRule(
    actor: ActorContext,
    rawProjectId: string,
    raw: { expectedVersion: number; folder: PersonalFolderReference }
  ): Promise<{ project: PersonalNamedProject; rule: PersonalProjectRule }> {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      input = personalProjectFolderRuleInputSchema.parse(raw);
    return addRule(pool, actor, projectId, input.expectedVersion, {
      kind: "folder",
      folder: input.folder
    });
  },
  async getPersonalProjectFolderRuleContext(
    actor: ActorContext,
    rawProjectId: string,
    rawFolder: PersonalFolderReference
  ): Promise<PersonalFolderContext | null> {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      folder = personalFolderReferenceSchema.parse(rawFolder);
    assertFolderOwner(actor, folder);
    const project = await pool.query(
      `select p.project_id from personal_named_projects p join users u on u.id=p.owner_user_id and u.disabled_at is null and u.deleted_at is null
      where p.owner_user_id=$1 and p.project_id=$2 and p.deleted_at is null`,
      [actor.userId, projectId]
    );
    if (!project.rows.length)
      throw Object.assign(new Error("Personal Project not found"), {
        statusCode: 404
      });
    return (
      (await findPersonalFolderContext(pool, actor, projectId, folder)) ?? null
    );
  },
  async listPersonalProjectMembershipReasons(
    actor: ActorContext,
    projectId: string,
    sessionIds: string[]
  ) {
    return listPersonalProjectMembershipReasonsWithClient(
      pool,
      actor,
      projectId,
      sessionIds
    );
  },
  async removePersonalProjectRule(
    actor: ActorContext,
    rawProjectId: string,
    rawInclusionId: string,
    raw: { expectedVersion: number }
  ): Promise<{ project: PersonalNamedProject; rule: PersonalProjectRule }> {
    const projectId = personalOwnerIdSchema.parse(rawProjectId),
      inclusionId = personalOwnerIdSchema.parse(rawInclusionId),
      input = personalProjectVersionSchema.parse(raw);
    return withPersonalMembershipTransaction(pool, actor, async (client) => {
      const project = await lockPersonalNamedProject(
        client,
        actor,
        projectId,
        input.expectedVersion
      );
      const current = await client.query<RuleRow>(
        "select * from personal_project_rules where owner_user_id=$1 and project_id=$2 and inclusion_id=$3 for update",
        [actor.userId, projectId, inclusionId]
      );
      const previous = current.rows[0];
      if (!previous)
        throw Object.assign(new Error("Project inclusion rule not found"), {
          statusCode: 404
        });
      await assertPersonalMembershipMutationReady(client, {
        ownerUserId: actor.userId,
        projectId,
        entityKind: "rule",
        localEntityId: previous.inclusion_id
      });
      if (previous.removed_at)
        return {
          project: mapPersonalNamedProject(project),
          rule: mapRule(previous)
        };
      const revisionId = randomUUID();
      const result = await client.query<RuleRow>(
        "update personal_project_rules set removed_at=now(),version=version+1,head_revision_id=$4,updated_at=now() where owner_user_id=$1 and project_id=$2 and inclusion_id=$3 returning *",
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
      return {
        project: await advanceProject(client, actor, projectId),
        rule: mapRule(result.rows[0]!)
      };
    });
  },
  async listPersonalProjectRules(
    actor: ActorContext,
    rawProjectId: string
  ): Promise<PersonalProjectRule[]> {
    const projectId = personalOwnerIdSchema.parse(rawProjectId);
    const result = await pool.query<RuleRow>(
      `select r.* from personal_project_rules r
      join personal_named_projects p on p.owner_user_id=r.owner_user_id and p.project_id=r.project_id and p.deleted_at is null
      join users u on u.id=p.owner_user_id and u.disabled_at is null and u.deleted_at is null
      where r.owner_user_id=$1 and r.project_id=$2 and r.removed_at is null order by r.created_at,r.inclusion_id`,
      [actor.userId, projectId]
    );
    return result.rows.map(mapRule);
  }
});
export type PersonalProjectRuleRepository = ReturnType<
  typeof createPersonalProjectRuleRepository
>;
