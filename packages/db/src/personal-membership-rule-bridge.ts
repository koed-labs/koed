import type pg from "pg";
import {
  personalInclusionSelectorSchema,
  personalMembershipEntitySnapshotSchema,
  personalMembershipInclusionIdentity,
  personalMembershipSelectorKey,
  personalMembershipRuleScopeFromSelectorKey,
  type PersonalMembershipRevision
} from "@koed/shared";
import {
  retainLocalPersonalMembershipSnapshot,
  type PersonalMembershipEntityRow
} from "./personal-membership-causal-history.js";
import { personalMembershipBridgeRequired } from "./personal-membership-native-identity.js";
import { projectPersonalMembershipRule } from "./personal-membership-rule-projection.js";

type NativeRuleChange = {
  revision_id: string;
  replaces: string[];
  operation: "include_repository" | "include_folder" | "remove_inclusion";
  value: {
    target?: unknown;
    portableMembership?: {
      projectIdentity: string;
      entityIdentity: string;
      replaces: string[];
    };
  };
};
/** Preserve real native rule intent before a received history can rebuild its view.
 * Canonical scope, complete ancestry, and immutable audit prove the bridge; no
 * source body or local directory lookup can substitute for that proof.
 */
export const bridgePersonalMembershipRule = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    nativeProjectId: string;
    nativeRuleId: string;
    localDeviceId: string;
  }
) => {
  const native = await client.query<{
    target: unknown;
    target_scope: string;
    head_revision_id: string;
  }>(
    "select target,target_scope,head_revision_id from personal_project_rules where owner_user_id=$1 and project_id=$2 and inclusion_id=$3 for update",
    [input.ownerUserId, input.nativeProjectId, input.nativeRuleId]
  );
  if (!native.rows[0]) return null;
  const root = await client.query<{ project_identity: string }>(
    "select project_identity from personal_membership_entities where owner_user_id=$1 and local_project_id=$2 and entity_kind='project'",
    [input.ownerUserId, input.nativeProjectId]
  );
  const projectIdentity = root.rows[0]?.project_identity;
  if (!projectIdentity) throw personalMembershipBridgeRequired();
  const selector = personalInclusionSelectorSchema.parse(native.rows[0].target);
  if (selector.kind === "session")
    throw new TypeError("PersonalMembershipNativeRuleSelectorError");
  const selectorKey = personalMembershipSelectorKey(selector),
    entityId = personalMembershipInclusionIdentity(projectIdentity, selector);
  if (
    personalMembershipRuleScopeFromSelectorKey(
      selectorKey,
      input.ownerUserId
    ) !== native.rows[0].target_scope
  )
    throw new TypeError("PersonalMembershipNativeRuleSelectorError");
  const existing = await client.query<PersonalMembershipEntityRow>(
    "select * from personal_membership_entities where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 for update",
    [input.ownerUserId, projectIdentity, entityId]
  );
  const entity = existing.rows[0];
  if (
    entity &&
    (entity.entity_kind !== "rule" ||
      entity.selector_key !== selectorKey ||
      (entity.local_entity_id && entity.local_entity_id !== input.nativeRuleId))
  )
    throw personalMembershipBridgeRequired();
  const changes = await client.query<NativeRuleChange>(
    `select c.revision_id,c.replaces,c.operation,c.value from personal_membership_changes c
     where c.owner_user_id=$1 and c.project_id=$2 and c.entity_id=$3
      and c.operation in ('include_repository','include_folder','remove_inclusion')
      and not exists(select 1 from personal_membership_revisions r where r.native_change_revision_id=c.revision_id)
     order by c.sequence`,
    [input.ownerUserId, input.nativeProjectId, input.nativeRuleId]
  );
  if (!changes.rowCount) {
    if (!entity) throw personalMembershipBridgeRequired();
    return null;
  }
  if (native.rows[0].head_revision_id !== changes.rows.at(-1)!.revision_id)
    throw personalMembershipBridgeRequired();
  const retained = await client.query<{ revision: PersonalMembershipRevision }>(
    "select revision from personal_membership_revisions where owner_user_id=$1 and project_identity=$2 and entity_identity=$3 order by revision_id",
    [input.ownerUserId, projectIdentity, entityId]
  );
  const revisions = retained.rows.map((row) => row.revision),
    known = new Set(revisions.map((value) => value.revisionId)),
    nativeChanges = new Map<string, string>();
  for (const change of changes.rows) {
    const frozen = change.value.portableMembership;
    if (
      known.has(change.revision_id) ||
      (frozen &&
        (frozen.projectIdentity !== projectIdentity ||
          frozen.entityIdentity !== entityId))
    )
      throw personalMembershipBridgeRequired();
    const target =
      change.operation === "remove_inclusion"
        ? null
        : personalInclusionSelectorSchema.parse(change.value.target);
    if (
      target &&
      (target.kind === "session" ||
        personalMembershipSelectorKey(target) !== selectorKey ||
        (change.operation === "include_repository") !==
          (target.kind === "repository"))
    )
      throw new TypeError("PersonalMembershipNativeRuleSelectorError");
    revisions.push({
      version: 1,
      project: { ownerUserId: input.ownerUserId, projectId: projectIdentity },
      entityId,
      revisionId: change.revision_id,
      authorDeviceId: input.localDeviceId,
      replaces: [...(frozen?.replaces ?? change.replaces)].sort(),
      operation: target
        ? { kind: "include", selector: target }
        : { kind: "remove_inclusion" }
    });
    known.add(change.revision_id);
    nativeChanges.set(change.revision_id, change.revision_id);
  }
  const snapshot = personalMembershipEntitySnapshotSchema.parse({
    version: 1,
    project: { ownerUserId: input.ownerUserId, projectId: projectIdentity },
    entityId,
    entityKind: "rule",
    revisions
  });
  const result = await retainLocalPersonalMembershipSnapshot(client, {
    ...input,
    snapshot,
    nativeEntityId: input.nativeRuleId,
    nativeChanges
  });
  await client.query(
    `update personal_membership_entities set local_project_id=$4,local_entity_id=$5,updated_at=now()
     where owner_user_id=$1 and project_identity=$2 and entity_identity=$3`,
    [
      input.ownerUserId,
      projectIdentity,
      entityId,
      input.nativeProjectId,
      input.nativeRuleId
    ]
  );
  await projectPersonalMembershipRule(
    client,
    {
      ...result.entity,
      local_project_id: input.nativeProjectId,
      local_entity_id: input.nativeRuleId
    },
    input.nativeProjectId
  );
  return result;
};
