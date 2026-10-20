import {
  personalDirectMembershipReadySql,
  personalGraphExclusionBlocksSql,
  personalProjectCatalogReadySql
} from "./personal-membership-selection-sql.js";
import type pg from "pg";
import { personalSourceCorrectionPreviewSchema } from "@koed/shared";
import type { ActorContext } from "./types.js";
import { personalProjectRuleMatchesSql } from "./personal-selection-sql.js";

const reasonsSql = (
  source: string
) => `coalesce((select jsonb_agg(reason.value order by reason.id) from (
  select i.inclusion_id as id,jsonb_build_object('inclusionId',i.inclusion_id,'revisionId',i.head_revision_id,'kind','session') as value
  from personal_project_inclusions i where i.owner_user_id=p.owner_user_id and i.project_id=p.project_id and i.logical_session_id=${source}.logical_session_id and i.removed_at is null and ${personalDirectMembershipReadySql("i", source)} and ${personalProjectCatalogReadySql("p")}
  union all select r.inclusion_id as id,jsonb_build_object('inclusionId',r.inclusion_id,'revisionId',r.head_revision_id,'kind',r.target->>'kind') as value
  from personal_project_rules r where r.owner_user_id=p.owner_user_id and r.project_id=p.project_id and r.removed_at is null and ${personalProjectCatalogReadySql("p")} and ${personalProjectRuleMatchesSql(source, "r")}
) reason),'[]'::jsonb)`;
/** Counterfactual metadata only. The proposed Session record is never stored during preview. */
export const readPersonalCorrectionEffects = async (
  client: pg.PoolClient,
  actor: ActorContext,
  sessionId: string,
  patch: Record<string, unknown>
) => {
  const result = await client.query<{
    project_id: string;
    name: string;
    version: number;
    before_reasons: unknown[];
    after_reasons: unknown[];
    excluded: boolean;
  }>(
    `select p.project_id,p.name,p.version,${reasonsSql("s")} as before_reasons,${reasonsSql("candidate")} as after_reasons,
    (exists(select 1 from personal_project_exclusions e where e.owner_user_id=p.owner_user_id and e.project_id=p.project_id and e.logical_session_id=s.logical_session_id and e.cleared_at is null)
      or ${personalGraphExclusionBlocksSql("s", "p.owner_user_id", "p.project_id")}) as excluded
    from personal_named_projects p join sessions s on s.owner_user_id=p.owner_user_id and s.id=$2
    cross join lateral jsonb_populate_record(null::sessions,to_jsonb(s)||$3::jsonb) candidate
    where p.owner_user_id=$1 and p.deleted_at is null order by p.project_id limit 5001`,
    [actor.userId, sessionId, patch]
  );
  if (result.rows.length > 5000)
    throw Object.assign(
      new Error("Too many Projects to review this correction."),
      { statusCode: 413 }
    );
  return personalSourceCorrectionPreviewSchema.shape.projects.parse(
    result.rows.map((row) => ({
      projectId: row.project_id,
      name: row.name,
      version: row.version,
      beforeReasons: row.before_reasons,
      afterReasons: row.after_reasons,
      beforeIncluded: row.before_reasons.length > 0 && !row.excluded,
      afterIncluded: row.after_reasons.length > 0 && !row.excluded
    }))
  );
};
