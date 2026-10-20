import { projectPersonalMembershipExclusion } from "./personal-membership-exclusion-projection.js";
import { projectPersonalMembershipRule } from "./personal-membership-rule-projection.js";
import type pg from "pg";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import { projectPersonalMembershipCatalog } from "./personal-membership-project-projection.js";
import { projectPersonalDirectMembership } from "./personal-membership-direct-projection.js";

/** Current views are rebuilt from causal truth in the caller's owner-locked transaction. */
export const projectPersonalMembershipState = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    projectIdentity: string;
    semanticChanged?: boolean;
    localMutation?: boolean;
  }
) => {
  const catalog = await projectPersonalMembershipCatalog(
    client,
    input.ownerUserId,
    input.projectIdentity
  );
  const entities = await client.query<PersonalMembershipEntityRow>(
    "select * from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_kind<>'project' order by entity_identity for update",
    [input.ownerUserId, input.projectIdentity]
  );
  let changed = catalog.changed;
  for (const entity of entities.rows) {
    const projectEntity =
      entity.entity_kind === "direct"
        ? projectPersonalDirectMembership
        : entity.entity_kind === "rule"
          ? projectPersonalMembershipRule
          : projectPersonalMembershipExclusion;
    changed =
      (await projectEntity(client, entity, catalog.projectId)) || changed;
  }
  if (
    !catalog.changed &&
    !input.localMutation &&
    (changed || input.semanticChanged)
  )
    await client.query(
      "update personal_named_projects set version=version+1,updated_at=now() where owner_user_id=$1 and project_id=$2",
      [input.ownerUserId, catalog.projectId]
    );
  if (changed || input.semanticChanged)
    await client.query("select pg_notify('koed_graph_updates',$1)", [
      JSON.stringify({
        ownerUserId: input.ownerUserId,
        visibility: "personal",
        kind: "personal_membership_changed"
      })
    ]);
  return {
    projectId: catalog.projectId,
    changed: changed || Boolean(input.semanticChanged)
  };
};
