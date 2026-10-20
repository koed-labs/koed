import { resolveNativePersonalMembershipSource } from "./personal-membership-source-bridge.js";
import type pg from "pg";
import {
  personalMembershipEntitySnapshotSchema,
  personalMembershipInclusionIdentity,
  personalMembershipSelectorKey,
  type PersonalMembershipRevision
} from "@koed/shared";
import {
  retainLocalPersonalMembershipSnapshot,
  type PersonalMembershipEntityRow
} from "./personal-membership-causal-history.js";
import { personalMembershipBridgeRequired } from "./personal-membership-native-identity.js";
import { projectPersonalDirectMembership } from "./personal-membership-direct-projection.js";

type NativeDirectChange = {
  revision_id: string;
  replaces: string[];
  operation: "include_session" | "remove_inclusion";
  value: {
    sourceProofRequired?: boolean;
    portableMembership?: {
      projectIdentity: string;
      entityIdentity: string;
      replaces: string[];
    };
  };
};

/** First portable freeze requires exact owned source proof. Unknown legacy origins
 * remain a repair prerequisite; names, paths and provider IDs cannot supply it.
 * Caller owns the owner lock and has bridged the catalog in this transaction.
 */
export const bridgePersonalDirectMembership = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    nativeProjectId: string;
    nativeInclusionId: string;
    localDeviceId: string;
    originatingDeploymentId: string;
  }
) => {
  const native = await client.query<{
    logical_session_id: string;
    head_revision_id: string;
  }>(
    `select logical_session_id,head_revision_id from personal_project_inclusions
     where owner_user_id=$1 and project_id=$2 and inclusion_id=$3 for update`,
    [input.ownerUserId, input.nativeProjectId, input.nativeInclusionId]
  );
  if (!native.rowCount) return null;
  const roots = await client.query<{ project_identity: string }>(
    "select project_identity from personal_membership_entities where owner_user_id=$1 and local_project_id=$2 and entity_kind='project'",
    [input.ownerUserId, input.nativeProjectId]
  );
  const projectIdentity = roots.rows[0]?.project_identity;
  if (!projectIdentity) throw personalMembershipBridgeRequired();
  const entities = await client.query<PersonalMembershipEntityRow>(
    `select * from personal_membership_entities where owner_user_id=$1 and local_project_id=$2
     and local_entity_id=$3 and entity_kind='direct' for update`,
    [input.ownerUserId, input.nativeProjectId, input.nativeInclusionId]
  );
  if (entities.rowCount! > 1) throw personalMembershipBridgeRequired();
  const previous = entities.rows[0];
  const changes = await client.query<NativeDirectChange>(
    `select c.revision_id,c.replaces,c.operation,c.value from personal_membership_changes c
     where c.owner_user_id=$1 and c.project_id=$2 and c.entity_id=$3
      and c.operation in ('include_session','remove_inclusion') and not exists (
        select 1 from personal_membership_revisions r where r.native_change_revision_id=c.revision_id)
     order by c.sequence`,
    [input.ownerUserId, input.nativeProjectId, input.nativeInclusionId]
  );
  if (!changes.rowCount) {
    if (!previous) throw personalMembershipBridgeRequired();
    return null;
  }
  if (native.rows[0]!.head_revision_id !== changes.rows.at(-1)!.revision_id)
    throw personalMembershipBridgeRequired();
  const { binding, source } = await resolveNativePersonalMembershipSource(
    client,
    {
      ...input,
      logicalSessionId: native.rows[0]!.logical_session_id,
      pinnedSelectorKey: previous?.selector_key ?? undefined,
      requireExistingSourceProof: changes.rows.some(
        (change) => change.value.sourceProofRequired === true
      )
    }
  );
  const selector = { kind: "session" as const, source },
    entityId = personalMembershipInclusionIdentity(projectIdentity, selector);
  if (
    previous &&
    (previous.entity_identity !== entityId ||
      previous.selector_key !== personalMembershipSelectorKey(selector))
  )
    throw personalMembershipBridgeRequired();
  const retained = await client.query<{ revision: PersonalMembershipRevision }>(
    `select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2
     and entity_identity=$3 order by revision_id`,
    [input.ownerUserId, projectIdentity, entityId]
  );
  const revisions = retained.rows.map((row) => row.revision),
    knownIds = new Set(revisions.map((revision) => revision.revisionId)),
    nativeChanges = new Map<string, string>();
  for (const change of changes.rows) {
    const frozen = change.value.portableMembership;
    if (
      knownIds.has(change.revision_id) ||
      (frozen &&
        (frozen.projectIdentity !== projectIdentity ||
          frozen.entityIdentity !== entityId))
    )
      throw personalMembershipBridgeRequired();
    revisions.push({
      version: 1,
      project: { ownerUserId: input.ownerUserId, projectId: projectIdentity },
      entityId,
      revisionId: change.revision_id,
      authorDeviceId: input.localDeviceId,
      replaces: [...(frozen?.replaces ?? change.replaces)].sort(),
      operation:
        change.operation === "include_session"
          ? { kind: "include", selector }
          : { kind: "remove_inclusion" }
    });
    nativeChanges.set(change.revision_id, change.revision_id);
    knownIds.add(change.revision_id);
  }
  const snapshot = personalMembershipEntitySnapshotSchema.parse({
    version: 1,
    project: { ownerUserId: input.ownerUserId, projectId: projectIdentity },
    entityId,
    entityKind: "direct",
    revisions
  });
  const result = await retainLocalPersonalMembershipSnapshot(client, {
    ...input,
    snapshot,
    nativeEntityId: input.nativeInclusionId,
    sourceBindingId: binding.binding_id,
    nativeChanges
  });
  await client.query(
    `update personal_membership_entities set local_project_id=$4,local_entity_id=$5,source_binding_id=$6,updated_at=now()
     where owner_user_id=$1 and project_identity=$2 and entity_identity=$3`,
    [
      input.ownerUserId,
      projectIdentity,
      entityId,
      input.nativeProjectId,
      input.nativeInclusionId,
      binding.binding_id
    ]
  );
  await projectPersonalDirectMembership(
    client,
    {
      ...result.entity,
      local_project_id: input.nativeProjectId,
      local_entity_id: input.nativeInclusionId,
      source_binding_id: binding.binding_id
    },
    input.nativeProjectId
  );
  return result;
};
