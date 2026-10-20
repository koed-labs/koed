import type pg from "pg";
import {
  personalIdentifierSchema,
  personalOwnerIdSchema,
  personalMembershipEntitySnapshotSchema,
  type PersonalMembershipRevision
} from "@koed/shared";
import {
  retainLocalPersonalMembershipSnapshot,
  type PersonalMembershipEntityRow
} from "./personal-membership-causal-history.js";
import { personalMembershipBridgeRequired } from "./personal-membership-native-identity.js";
import { projectPersonalMembershipCatalog } from "./personal-membership-project-projection.js";

type NativeCatalogChange = {
  revision_id: string;
  replaces: string[];
  operation: "set_project" | "delete_project";
  value: {
    name?: string;
    portableMembership?: {
      projectIdentity: string;
      entityIdentity: string;
      replaces: string[];
    };
  };
};

/** Retain local catalog intent before an incoming union can change the native view.
 * This is a private runtime boundary: device identity comes from secure local configuration.
 * Caller owns the Personal membership lock and transaction. No transport is performed here.
 */
export const bridgePersonalMembershipCatalog = async (
  client: pg.PoolClient,
  input: { ownerUserId: string; nativeProjectId: string; localDeviceId: string }
) => {
  const ownerUserId = personalOwnerIdSchema.parse(input.ownerUserId),
    nativeProjectId = personalOwnerIdSchema.parse(input.nativeProjectId),
    localDeviceId = personalIdentifierSchema.parse(input.localDeviceId);
  const native = await client.query<{ head_revision_id: string }>(
    "select head_revision_id from personal_named_projects where owner_user_id=$1 and project_id=$2 for update",
    [ownerUserId, nativeProjectId]
  );
  if (!native.rowCount) return null;
  const roots = await client.query<PersonalMembershipEntityRow>(
    `select * from personal_membership_entities where owner_user_id=$1 and local_project_id=$2
     and entity_kind='project' for update`,
    [ownerUserId, nativeProjectId]
  );
  const projectIdentity = roots.rows[0]?.project_identity ?? nativeProjectId;
  const changes = await client.query<NativeCatalogChange>(
    `select c.revision_id,c.replaces,c.operation,c.value from personal_membership_changes c
     where c.owner_user_id=$1 and c.project_id=$2 and c.entity_id=$2
     and c.operation in ('set_project','delete_project') and not exists (
       select 1 from personal_membership_revisions r where r.native_change_revision_id=c.revision_id
     ) order by c.sequence`,
    [ownerUserId, nativeProjectId]
  );
  if (!changes.rowCount) {
    if (!roots.rowCount) throw personalMembershipBridgeRequired();
    return null;
  }
  // Project rows without matching native audit cannot be adopted by a remote snapshot.
  if (native.rows[0]!.head_revision_id !== changes.rows.at(-1)!.revision_id)
    throw personalMembershipBridgeRequired();
  const retained = await client.query<{ revision: PersonalMembershipRevision }>(
    `select revision from personal_membership_revisions where owner_user_id=$1
     and project_identity=$2 and entity_identity=$2 order by revision_id`,
    [ownerUserId, projectIdentity]
  );
  const revisions = retained.rows.map((row) => row.revision),
    knownIds = new Set(revisions.map((revision) => revision.revisionId)),
    nativeChanges = new Map<string, string>();
  for (const change of changes.rows) {
    if (knownIds.has(change.revision_id))
      throw personalMembershipBridgeRequired();
    const frozen = change.value.portableMembership;
    if (
      frozen &&
      (frozen.projectIdentity !== projectIdentity ||
        frozen.entityIdentity !== projectIdentity)
    )
      throw personalMembershipBridgeRequired();
    revisions.push({
      version: 1,
      project: { ownerUserId, projectId: projectIdentity },
      entityId: projectIdentity,
      revisionId: change.revision_id,
      authorDeviceId: localDeviceId,
      replaces: [...(frozen?.replaces ?? change.replaces)].sort(),
      operation:
        change.operation === "set_project"
          ? { kind: "set_project", name: change.value.name! }
          : { kind: "delete_project" }
    });
    nativeChanges.set(change.revision_id, change.revision_id);
    knownIds.add(change.revision_id);
  }
  const snapshot = personalMembershipEntitySnapshotSchema.parse({
    version: 1,
    project: { ownerUserId, projectId: projectIdentity },
    entityId: projectIdentity,
    entityKind: "project",
    revisions
  });
  const result = await retainLocalPersonalMembershipSnapshot(client, {
    ownerUserId,
    nativeProjectId,
    snapshot,
    localDeviceId,
    nativeChanges
  });
  await projectPersonalMembershipCatalog(client, ownerUserId, projectIdentity);
  return result;
};
