import {
  personalProjectDefaultIdentity,
  personalProjectDefaultName
} from "@koed/shared/personal-project-default";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  personalGitContextSchema,
  repositoryIdentitySchema,
  crossIdentitySyncDeterministicUuid,
  personalOwnerIdSchema,
  personalFolderAssignmentSchema,
  type PersonalFolderContext,
  type PersonalProjectRule
} from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  appendPersonalMembershipRevision,
  withPersonalMembershipTransaction
} from "./personal-membership-repository.js";
import { personalSourceSelectionSql } from "./personal-selection-sql.js";
import { retireCoveredFolderDefault } from "./personal-project-default-retirement.js";

/** Owner transaction, membership journal and real catalog are shared with User
 * edits. The decision records initialization provenance, not membership. */
const initialize = async (
  client: pg.PoolClient,
  actor: ActorContext,
  target: PersonalProjectRule["target"],
  folderContext?: PersonalFolderContext
) => {
  const {
    sourceKey,
    sourceScope,
    projectIdentity: projectId
  } = personalProjectDefaultIdentity(target);
  if (
    (
      await client.query(
        "select 1 from personal_project_defaults where owner_user_id=$1 and source_key=$2",
        [actor.userId, sourceKey]
      )
    ).rowCount
  )
    return false;
  const managed = await client.query(
    `select r.project_id from personal_project_rules r join personal_named_projects p
    on p.owner_user_id=r.owner_user_id and p.project_id=r.project_id
    where r.owner_user_id=$1 and r.target_scope=$2 and r.removed_at is null and p.deleted_at is null limit 1`,
    [actor.userId, sourceScope]
  );
  if (managed.rowCount) {
    await client.query(
      `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state) values($1,$2,$3,$4,'managed')`,
      [actor.userId, sourceKey, sourceScope, target]
    );
    return false;
  }
  const removed = await client.query(
    `select 1 from personal_project_rules r join personal_named_projects p on p.owner_user_id=r.owner_user_id and p.project_id=r.project_id
    where r.owner_user_id=$1 and r.target_scope=$2 and (r.removed_at is not null or p.deleted_at is not null) limit 1`,
    [actor.userId, sourceScope]
  );
  if (removed.rowCount) {
    await client.query(
      `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state) values($1,$2,$3,$4,'suppressed')`,
      [actor.userId, sourceKey, sourceScope, target]
    );
    return false;
  }
  const seedRuleId = crossIdentitySyncDeterministicUuid({
    namespace: "koed/personal-project-default-rule/v1",
    ownerUserId: actor.userId,
    sourceKey
  });
  const projectRevisionId = randomUUID(),
    ruleRevisionId = randomUUID();
  const name = personalProjectDefaultName(
    target,
    folderContext?.normalizedPath
  );
  const existing = await client.query(
    "select 1 from personal_named_projects where owner_user_id=$1 and project_id=$2",
    [actor.userId, projectId]
  );
  if (existing.rowCount) {
    // A retained or received Project can never be silently overwritten by a scan.
    await client.query(
      `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state) values($1,$2,$3,$4,'suppressed')`,
      [actor.userId, sourceKey, sourceScope, target]
    );
    return false;
  }
  await client.query(
    `insert into personal_named_projects(owner_user_id,project_id,name,head_revision_id) values($1,$2,$3,$4)`,
    [actor.userId, projectId, name, projectRevisionId]
  );
  await client.query(
    `insert into personal_project_defaults(owner_user_id,source_key,source_scope,target,state,project_id,seed_rule_id,initial_project_revision_id,initial_rule_revision_id)
    values($1,$2,$3,$4,'initialized',$5,$6,$7,$8)`,
    [
      actor.userId,
      sourceKey,
      sourceScope,
      target,
      projectId,
      seedRuleId,
      projectRevisionId,
      ruleRevisionId
    ]
  );
  await appendPersonalMembershipRevision(
    client,
    actor,
    projectId,
    projectId,
    projectRevisionId,
    [],
    "set_project",
    { name, automaticDefault: { sourceKey, target } }
  );
  await client.query(
    `insert into personal_project_rules(inclusion_id,owner_user_id,project_id,target,target_scope,head_revision_id,folder_context) values($1,$2,$3,$4,$5,$6,$7)`,
    [
      seedRuleId,
      actor.userId,
      projectId,
      target,
      sourceScope,
      ruleRevisionId,
      folderContext ?? null
    ]
  );
  await appendPersonalMembershipRevision(
    client,
    actor,
    projectId,
    seedRuleId,
    ruleRevisionId,
    [],
    target.kind === "repository" ? "include_repository" : "include_folder",
    {
      target,
      automaticDefault: { sourceKey, target },
      ...(folderContext ? { folderContext } : {})
    }
  );
  return true;
};

export const createPersonalProjectDefaultRepository = (pool: pg.Pool) => ({
  async personalProjectDefaultStatus(actor: ActorContext) {
    const result = await pool.query<{ pending: boolean }>(
      "select pending from personal_project_default_reconciliation where owner_user_id=$1",
      [personalOwnerIdSchema.parse(actor.userId)]
    );
    return { reconciliationPending: result.rows[0]?.pending ?? false };
  },
  async reconcilePersonalProjectDefaults(actor: ActorContext, limit = 100) {
    personalOwnerIdSchema.parse(actor.userId);
    limit = Math.min(Math.max(Math.floor(limit), 1), 100);
    return withPersonalMembershipTransaction(
      pool,
      actor,
      async (client) => {
        const work = await client.query<{
          generation: string;
          scan_generation: string | null;
          after_session_id: string | null;
        }>(
          "select generation::text,scan_generation::text,after_session_id from personal_project_default_reconciliation where owner_user_id=$1 and pending=true and retry_at<=now() for update",
          [actor.userId]
        );
        const checkpoint = work.rows[0];
        if (!checkpoint) return { processed: 0, created: 0, pending: false };
        const rows = await client.query<{
          id: string;
          repository: unknown;
          folder_assignment: unknown;
          repository_assignment_state: string;
        }>(
          `select s.id,coalesce(s.repository_override_identity,s.repository_automatic_identity) repository,s.folder_assignment,s.repository_assignment_state
        from sessions s where s.owner_user_id=$1 and ($2::uuid is null or s.id>$2::uuid) and s.visibility='personal'
        and s.invalidated_at is null and s.personal_deleted_at is null order by s.id limit $3`,
          [actor.userId, checkpoint.after_session_id, limit + 1]
        );
        let created = 0;
        for (const row of rows.rows.slice(0, limit)) {
          // Pending replicas and conflicting source bindings remain browse-only.
          const available = await client.query(
            `select 1 from sessions s where s.id=$2 and ${personalSourceSelectionSql("s", "$3")}
          and pds_session_recall_ready(s.id) and not exists(select 1 from personal_source_bindings b where b.owner_user_id=$1 and b.local_session_id=s.id
            and (b.availability<>'available' or b.local_logical_session_id is distinct from s.logical_session_id))`,
            [
              actor.userId,
              row.id,
              JSON.stringify({
                ownerUserId: actor.userId,
                searchDomain: "global"
              })
            ]
          );
          if (!available.rowCount) continue;
          const parsed = repositoryIdentitySchema.safeParse(row.repository);
          const git = parsed.success
            ? personalGitContextSchema.safeParse(parsed.data)
            : null;
          const assignment = personalFolderAssignmentSchema.safeParse(
            row.folder_assignment
          );
          const fact = assignment.success
            ? assignment.data.correction.state === "corrected"
              ? assignment.data.correction.value
              : assignment.data.original
            : null;
          const folder =
            fact?.state === "known" &&
            fact.value.reference.ownerUserId === actor.userId
              ? fact.value
              : undefined;
          if (
            git?.success &&
            (await initialize(client, actor, {
              kind: "repository",
              repository: git.data
            }))
          )
            created++;
          if (folder && git?.success)
            await retireCoveredFolderDefault(client, actor, folder.reference);
          if (
            folder &&
            row.repository_assignment_state === "recorded" &&
            parsed.success &&
            parsed.data.kind === "non_git_project" &&
            parsed.data.reason === "non_git" &&
            (await initialize(
              client,
              actor,
              { kind: "folder", folder: folder.reference },
              folder
            ))
          )
            created++;
        }
        const more = rows.rows.length > limit;
        const scanGeneration =
          checkpoint.scan_generation ?? checkpoint.generation;
        const pending = more || scanGeneration !== checkpoint.generation;
        await client.query(
          `update personal_project_default_reconciliation set after_session_id=$2,scan_generation=$3,pending=$4,updated_at=now() where owner_user_id=$1`,
          [
            actor.userId,
            more ? rows.rows[limit - 1]!.id : null,
            more ? scanGeneration : null,
            pending
          ]
        );
        return {
          processed: Math.min(rows.rows.length, limit),
          created,
          pending
        };
      },
      { notify: true }
    );
  },
  async nextPersonalProjectDefaultOwner() {
    const result = await pool.query<{
      owner_user_id: string;
    }>(`select r.owner_user_id from personal_project_default_reconciliation r join users u on u.id=r.owner_user_id
      where r.pending=true and r.retry_at<=now() and u.disabled_at is null and u.deleted_at is null order by r.updated_at,r.owner_user_id limit 1`);
    return result.rows[0]?.owner_user_id ?? null;
  },
  async deferPersonalProjectDefaults(actor: ActorContext) {
    await pool.query(
      "update personal_project_default_reconciliation set retry_at=now()+interval '30 seconds',updated_at=now() where owner_user_id=$1",
      [actor.userId]
    );
  },
  async nextPersonalProjectDefaultRetryAt() {
    const result = await pool.query<{ retry_at: Date | null }>(
      "select min(retry_at) retry_at from personal_project_default_reconciliation where pending=true"
    );
    return result.rows[0]?.retry_at?.toISOString() ?? null;
  }
});
export type PersonalProjectDefaultRepository = ReturnType<
  typeof createPersonalProjectDefaultRepository
>;
