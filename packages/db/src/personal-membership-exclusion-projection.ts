import type pg from "pg";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import { resolvePersonalMembershipSourceProjection } from "./personal-membership-source-projection.js";
import {
  personalMembershipNativeEntityId,
  personalMembershipNativeHeadId,
  personalMembershipBridgeRequired
} from "./personal-membership-native-identity.js";

type ExclusionRow = {
  exclusion_id: string;
  logical_session_id: string;
  head_revision_id: string;
  cleared_at: Date | null;
};
/** Unresolved exclusion intent is conservative. A missing source stays in the
 * causal ledger; it cannot create a Session or a predicted native source row.
 */
export const projectPersonalMembershipExclusion = async (
  client: pg.PoolClient,
  entity: PersonalMembershipEntityRow,
  projectId: string
): Promise<boolean> => {
  if (entity.entity_kind !== "exclusion") return false;
  const { source, logicalSessionId } =
    await resolvePersonalMembershipSourceProjection(client, entity);
  const blocked =
    entity.state !== "available" ||
    entity.current_revision?.operation.kind !== "clear_exclusion";
  let current: ExclusionRow | undefined;
  if (entity.local_entity_id)
    current = (
      await client.query<ExclusionRow>(
        "select * from personal_project_exclusions where owner_user_id=$1 and project_id=$2 and exclusion_id=$3 for update",
        [entity.owner_user_id, projectId, entity.local_entity_id]
      )
    ).rows[0];
  else if (logicalSessionId)
    current = (
      await client.query<ExclusionRow>(
        "select * from personal_project_exclusions where owner_user_id=$1 and project_id=$2 and logical_session_id=$3 for update",
        [entity.owner_user_id, projectId, logicalSessionId]
      )
    ).rows[0];
  if (current && !entity.local_entity_id) {
    const proof = await client.query(
      `select 1 from personal_membership_revisions r join personal_membership_changes c on c.revision_id=r.native_change_revision_id
       where r.owner_user_id=$1 and r.project_identity=$2 and r.entity_identity=$3 and c.owner_user_id=$1
        and c.project_id=$4 and c.entity_id=$5 and c.operation in ('exclude','clear_exclusion')`,
      [
        entity.owner_user_id,
        entity.project_identity,
        entity.entity_identity,
        projectId,
        current.exclusion_id
      ]
    );
    if (!proof.rowCount) throw personalMembershipBridgeRequired();
  }
  if (
    current &&
    logicalSessionId &&
    current.logical_session_id !== logicalSessionId
  )
    throw new TypeError("PdsCryptoMembershipNativeSourceIdentityError");
  if (!current && (!logicalSessionId || !blocked)) return false;
  const exclusionId =
      current?.exclusion_id ?? personalMembershipNativeEntityId(entity),
    head = personalMembershipNativeHeadId(entity);
  let changed = false;
  if (!current) {
    if (
      (
        await client.query(
          "select 1 from personal_project_exclusions where exclusion_id=$1",
          [exclusionId]
        )
      ).rowCount
    )
      throw new TypeError("PdsCryptoMembershipNativeExclusionIdentityError");
    await client.query(
      `insert into personal_project_exclusions(exclusion_id,owner_user_id,project_id,logical_session_id,source_reference,head_revision_id)
       values($1,$2,$3,$4,$5,$6)`,
      [
        exclusionId,
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
    Boolean(current.cleared_at) === blocked
  ) {
    await client.query(
      `update personal_project_exclusions set head_revision_id=$4,
       cleared_at=case when $5::boolean then null else coalesce(cleared_at,now()) end,version=version+1,updated_at=now()
       where owner_user_id=$1 and project_id=$2 and exclusion_id=$3`,
      [entity.owner_user_id, projectId, exclusionId, head, blocked]
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
        exclusionId
      ]
    );
  return changed;
};
