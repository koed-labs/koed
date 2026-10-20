import type pg from "pg";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import {
  personalMembershipNativeHeadId,
  personalMembershipBridgeRequired
} from "./personal-membership-native-identity.js";

/** Freeze real causal parents while the User's command still holds the owner lock.
 * A native UUID view of an opaque remote head must never become a portable parent.
 */
export const freezePersonalMembershipLocalParents = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    entityId: string;
    replaces: string[];
  }
) => {
  const found = await client.query<PersonalMembershipEntityRow>(
    `select * from personal_membership_entities where owner_user_id=$1 and local_project_id=$2
     and ((entity_kind='project' and $2=$3) or (entity_kind<>'project' and local_entity_id=$3)) for update`,
    [input.ownerUserId, input.projectId, input.entityId]
  );
  if (!found.rowCount) return null;
  if (found.rowCount !== 1) throw personalMembershipBridgeRequired();
  const entity = found.rows[0]!;
  if (entity.state !== "available") throw personalMembershipBridgeRequired();
  let replaces = input.replaces;
  if (
    replaces.length === 1 &&
    replaces[0] === personalMembershipNativeHeadId(entity)
  ) {
    replaces = entity.heads;
  } else {
    // A second offline edit may follow a native revision not yet frozen by sync.
    // Its journal identity is already the future portable revision identity.
    const local = await client.query(
      `select revision_id from personal_membership_changes where owner_user_id=$1 and project_id=$2
       and entity_id=$3 and revision_id=any($4::uuid[])`,
      [input.ownerUserId, input.projectId, input.entityId, replaces]
    );
    if (!replaces.length || local.rowCount !== replaces.length)
      throw personalMembershipBridgeRequired();
  }
  return {
    projectIdentity: entity.project_identity,
    entityIdentity: entity.entity_identity,
    replaces: [...replaces].sort()
  };
};
