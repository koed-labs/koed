import { personalProjectDefaultIdentity } from "@koed/shared/personal-project-default";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { type PersonalFolderReference } from "@koed/shared";
import type { ActorContext } from "./types.js";
import {
  personalEffectiveFolderFactSql,
  personalSourceSelectionSql
} from "./personal-selection-sql.js";
import {
  personalProjectCatalogReadySql,
  personalRuleMembershipReadySql
} from "./personal-membership-selection-sql.js";
import { appendPersonalMembershipRevision } from "./personal-membership-repository.js";

/** Retire only proven untouched defaults. Unknown source history, User edits
 * and sharing attachments all preserve the Project for explicit management. */
export const retireCoveredFolderDefault = async (
  client: pg.PoolClient,
  actor: ActorContext,
  folder: PersonalFolderReference
) => {
  const { sourceKey } = personalProjectDefaultIdentity({
    kind: "folder",
    folder
  });
  const candidate = await client.query<{
    project_id: string;
    initial_project_revision_id: string;
  }>(
    `select d.project_id,d.initial_project_revision_id
    from personal_project_defaults d join personal_named_projects p on p.owner_user_id=d.owner_user_id and p.project_id=d.project_id
    join personal_project_rules r on r.owner_user_id=d.owner_user_id and r.project_id=d.project_id and r.inclusion_id=d.seed_rule_id
    where d.owner_user_id=$1 and d.source_key=$2 and d.state='initialized' and p.deleted_at is null
      and p.version=1 and p.head_revision_id=d.initial_project_revision_id and r.version=1 and r.head_revision_id=d.initial_rule_revision_id and r.removed_at is null
      and not exists(select 1 from personal_project_rules extra where extra.owner_user_id=$1 and extra.project_id=d.project_id and extra.inclusion_id<>d.seed_rule_id)
      and not exists(select 1 from personal_project_inclusions i where i.owner_user_id=$1 and i.project_id=d.project_id)
      and not exists(select 1 from personal_project_exclusions e where e.owner_user_id=$1 and e.project_id=d.project_id)
      and not exists(select 1 from team_memory_sharing_rules sharing where sharing.owner_user_id=$1 and sharing.selector_kind='project')
      and not exists(select 1 from collaboration_sharing_rule_deliveries delivery join collaboration_shared_memory_enrollments enrollment on enrollment.id=delivery.enrollment_id where enrollment.local_owner_user_id=$1)
    for update of d,p,r`,
    [actor.userId, sourceKey]
  );
  const current = candidate.rows[0];
  if (!current) return false;
  const source = personalEffectiveFolderFactSql("s");
  const covered = await client.query<{ covered: boolean }>(
    `select count(*)>0 and bool_and(
    pds_session_recall_ready(s.id) and not exists(select 1 from personal_source_bindings b where b.owner_user_id=$1 and b.local_session_id=s.id and (b.availability<>'available' or b.local_logical_session_id is distinct from s.logical_session_id))
    and coalesce(s.repository_override_identity,s.repository_automatic_identity)->>'kind' in ('portable_repository','device_local_repository') and exists(
      select 1 from personal_project_rules r join personal_named_projects p on p.owner_user_id=r.owner_user_id and p.project_id=r.project_id
      where r.owner_user_id=$1 and r.project_id<>$3 and r.removed_at is null and p.deleted_at is null and r.target->>'kind'='repository'
      and repository_scope_matches(coalesce(s.repository_override_identity,s.repository_automatic_identity),r.target_scope)
      and ${personalProjectCatalogReadySql("p")} and ${personalRuleMembershipReadySql("r")}
      and ${personalSourceSelectionSql("s", "jsonb_build_object('ownerUserId',$1::text,'searchDomain','project','namedProjectId',p.project_id::text)")})
    ) covered from sessions s where s.owner_user_id=$1 and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
      and ${source}->>'state'='known' and ${source}->'value'->'reference'=$2::jsonb`,
    [actor.userId, folder, current.project_id]
  );
  if (covered.rows[0]?.covered !== true) return false;
  const revisionId = randomUUID();
  await client.query(
    "update personal_named_projects set deleted_at=now(),version=version+1,head_revision_id=$3,updated_at=now() where owner_user_id=$1 and project_id=$2",
    [actor.userId, current.project_id, revisionId]
  );
  await client.query(
    "update personal_project_defaults set state='retired',revision_id=$3,updated_at=now() where owner_user_id=$1 and source_key=$2",
    [actor.userId, sourceKey, randomUUID()]
  );
  await appendPersonalMembershipRevision(
    client,
    actor,
    current.project_id,
    current.project_id,
    revisionId,
    [current.initial_project_revision_id],
    "delete_project",
    { automaticRetirement: { sourceKey, target: { kind: "folder", folder } } }
  );
  return true;
};
