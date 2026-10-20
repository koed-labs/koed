import type pg from "pg";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import {
  personalMembershipNativeProjectId,
  personalMembershipNativeHeadId,
  personalMembershipBridgeRequired
} from "./personal-membership-native-identity.js";

/** A pending catalog row is a view placeholder. It never becomes a local set_project revision. */
export const projectPersonalMembershipCatalog = async (
  client: pg.PoolClient,
  ownerUserId: string,
  projectIdentity: string
) => {
  await client.query(
    `insert into personal_membership_entities(owner_user_id,project_identity,entity_identity,entity_kind)
     values($1,$2,$2,'project') on conflict(owner_user_id,project_identity,entity_identity) do nothing`,
    [ownerUserId, projectIdentity]
  );
  const rootResult = await client.query<PersonalMembershipEntityRow>(
    "select * from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_identity=$2 for update",
    [ownerUserId, projectIdentity]
  );
  const root = rootResult.rows[0]!;
  if (root.entity_kind !== "project")
    throw new TypeError("PdsCryptoMembershipCatalogIdentityError");
  const projectId =
    root.local_project_id ??
    personalMembershipNativeProjectId(ownerUserId, projectIdentity);
  const existing = await client.query<{
    name: string;
    head_revision_id: string;
    deleted_at: Date | null;
  }>(
    "select name,head_revision_id,deleted_at from personal_named_projects where owner_user_id=$1 and project_id=$2 for update",
    [ownerUserId, projectId]
  );
  const current = existing.rows[0];
  if (current && !root.local_project_id) {
    const bridge = await client.query(
      `select 1 from personal_membership_revisions r join personal_membership_changes c on c.revision_id=r.native_change_revision_id
       where r.owner_user_id=$1 and r.project_identity=$2 and r.entity_identity=$2 and c.owner_user_id=$1 and c.project_id=$3 and c.entity_id=$3`,
      [ownerUserId, projectIdentity, projectId]
    );
    if (!bridge.rowCount) throw personalMembershipBridgeRequired();
  }
  const operation =
    root.state === "available" ? root.current_revision?.operation : null;
  const deleted = operation?.kind === "delete_project";
  const name =
    operation?.kind === "set_project"
      ? operation.name
      : deleted
        ? (current?.name ?? "Deleted Project")
        : root.state === "conflict"
          ? "Project needs review"
          : "Project waiting for sync";
  const head = personalMembershipNativeHeadId(root);
  let changed = false;
  if (!current) {
    await client.query(
      `insert into personal_named_projects(owner_user_id,project_id,name,head_revision_id,deleted_at)
       values($1,$2,$3,$4,case when $5::boolean then now() else null end)`,
      [ownerUserId, projectId, name, head, deleted]
    );
    changed = true;
  } else if (
    current.name !== name ||
    current.head_revision_id !== head ||
    Boolean(current.deleted_at) !== deleted
  ) {
    await client.query(
      `update personal_named_projects set name=$3,head_revision_id=$4,deleted_at=case when $5::boolean then coalesce(deleted_at,now()) else null end,
       version=version+1,updated_at=now() where owner_user_id=$1 and project_id=$2`,
      [ownerUserId, projectId, name, head, deleted]
    );
    changed = true;
  }
  const mismatch = await client.query(
    "select 1 from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and local_project_id is not null and local_project_id<>$3 limit 1",
    [ownerUserId, projectIdentity, projectId]
  );
  if (mismatch.rowCount)
    throw new TypeError("PdsCryptoMembershipNativeProjectIdentityError");
  await client.query(
    "update personal_membership_entities set local_project_id=$3,updated_at=now() where owner_user_id=$1 and project_identity=$2 and local_project_id is null",
    [ownerUserId, projectIdentity, projectId]
  );
  return {
    projectId,
    root: { ...root, local_project_id: projectId },
    changed,
    created: !current
  };
};
