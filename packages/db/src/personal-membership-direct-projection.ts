import type pg from "pg";
import { resolvePersonalMembershipSourceProjection } from "./personal-membership-source-projection.js";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import {
  personalMembershipNativeEntityId,
  personalMembershipNativeHeadId,
  personalMembershipBridgeRequired
} from "./personal-membership-native-identity.js";

type InclusionRow = {
  inclusion_id: string;
  logical_session_id: string;
  head_revision_id: string;
  removed_at: Date | null;
  source_reference: unknown;
};
/** A configuration reference cannot create a Session or establish source authority. */
export const projectPersonalDirectMembership = async (
  client: pg.PoolClient,
  entity: PersonalMembershipEntityRow,
  projectId: string
): Promise<boolean> => {
  if (entity.entity_kind !== "direct") return false;
  const { source, logicalSessionId } =
    await resolvePersonalMembershipSourceProjection(client, entity);
  const active =
    entity.state === "available" &&
    entity.current_revision?.operation.kind === "include";
  let inclusionId = personalMembershipNativeEntityId(entity);
  let current: InclusionRow | undefined;
  if (entity.local_entity_id) {
    current = (
      await client.query<InclusionRow>(
        "select inclusion_id,logical_session_id,head_revision_id,removed_at,source_reference from personal_project_inclusions where inclusion_id=$1 and owner_user_id=$2 and project_id=$3 for update",
        [entity.local_entity_id, entity.owner_user_id, projectId]
      )
    ).rows[0];
  } else if (logicalSessionId) {
    const existing = await client.query<InclusionRow>(
      "select inclusion_id,logical_session_id,head_revision_id,removed_at,source_reference from personal_project_inclusions where owner_user_id=$1 and project_id=$2 and logical_session_id=$3 for update",
      [entity.owner_user_id, projectId, logicalSessionId]
    );
    current = existing.rows[0];
    if (current) {
      const proof = await client.query(
        `select 1 from personal_membership_revisions r join personal_membership_changes c on c.revision_id=r.native_change_revision_id
         where r.owner_user_id=$1 and r.project_identity=$2 and r.entity_identity=$3 and c.owner_user_id=$1 and c.project_id=$4 and c.entity_id=$5`,
        [
          entity.owner_user_id,
          entity.project_identity,
          entity.entity_identity,
          projectId,
          current.inclusion_id
        ]
      );
      if (!proof.rowCount) throw personalMembershipBridgeRequired();
      inclusionId = current.inclusion_id;
    }
  }
  if (
    current &&
    logicalSessionId &&
    current.logical_session_id !== logicalSessionId
  )
    throw new TypeError("PdsCryptoMembershipNativeSourceIdentityError");
  // Missing bodies stay in the causal ledger. A removal needs no fabricated view row.
  if (!current && (!logicalSessionId || !active)) return false;
  const head = personalMembershipNativeHeadId(entity);
  let changed = false;
  if (!current) {
    const collision = await client.query(
      "select 1 from personal_project_inclusions where inclusion_id=$1",
      [inclusionId]
    );
    if (collision.rowCount)
      throw new TypeError("PdsCryptoMembershipNativeInclusionIdentityError");
    await client.query(
      `insert into personal_project_inclusions(inclusion_id,owner_user_id,project_id,logical_session_id,source_reference,head_revision_id)
       values($1,$2,$3,$4,$5,$6)`,
      [
        inclusionId,
        entity.owner_user_id,
        projectId,
        logicalSessionId,
        source,
        head
      ]
    );
    changed = true;
  } else if (
    current.head_revision_id !== head ||
    Boolean(current.removed_at) === active
  ) {
    // Keep a retained native source-reference alias. The canonical graph binding
    // supplies portability; projection does not rewrite that historical reference.
    await client.query(
      `update personal_project_inclusions set head_revision_id=$4,removed_at=case when $5::boolean then null else coalesce(removed_at,now()) end,
       version=version+1,updated_at=now() where inclusion_id=$1 and owner_user_id=$2 and project_id=$3`,
      [inclusionId, entity.owner_user_id, projectId, head, active]
    );
    changed = true;
  }
  if (!entity.local_entity_id)
    await client.query(
      "update personal_membership_entities set local_entity_id=$4,updated_at=now() where owner_user_id=$1 and project_identity=$2 and entity_identity=$3",
      [
        entity.owner_user_id,
        entity.project_identity,
        entity.entity_identity,
        inclusionId
      ]
    );
  return changed;
};
