import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import {
  personalMembershipRuleScopeFromSelectorKey,
  personalMembershipSelectorKey
} from "@koed/shared";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";
import {
  personalMembershipNativeEntityId,
  personalMembershipNativeHeadId,
  personalMembershipBridgeRequired
} from "./personal-membership-native-identity.js";
import { findPersonalFolderContext } from "./personal-folder-context-lookup.js";

type NativeRule = {
  inclusion_id: string;
  target_scope: string;
  target: unknown;
  folder_context: unknown;
  head_revision_id: string;
  removed_at: Date | null;
};
/** A rule is retained intent. Its target cannot create source facts, a Session,
 * a local filesystem association, or eligibility without the common evaluator.
 */
export const projectPersonalMembershipRule = async (
  client: pg.PoolClient,
  entity: PersonalMembershipEntityRow,
  projectId: string
): Promise<boolean> => {
  if (entity.entity_kind !== "rule") return false;
  const scope = personalMembershipRuleScopeFromSelectorKey(
    entity.selector_key!,
    entity.owner_user_id
  );
  const available =
    entity.state === "available" &&
    entity.current_revision?.operation.kind === "include";
  const operation = available ? entity.current_revision!.operation : null;
  const target = operation?.kind === "include" ? operation.selector : null;
  if (
    target &&
    (target.kind === "session" ||
      personalMembershipSelectorKey(target) !== entity.selector_key)
  )
    throw new TypeError("PdsCryptoMembershipRuleSelectorError");
  const found = entity.local_entity_id
    ? await client.query<NativeRule>(
        "select * from personal_project_rules where owner_user_id=$1 and project_id=$2 and inclusion_id=$3 for update",
        [entity.owner_user_id, projectId, entity.local_entity_id]
      )
    : await client.query<NativeRule>(
        "select * from personal_project_rules where owner_user_id=$1 and project_id=$2 and target_scope=$3 for update",
        [entity.owner_user_id, projectId, scope]
      );
  const current = found.rows[0];
  if (current && current.target_scope !== scope)
    throw new TypeError("PdsCryptoMembershipNativeRuleIdentityError");
  if (current && !entity.local_entity_id) {
    const proof = await client.query(
      `select 1 from personal_membership_revisions r join personal_membership_changes c on c.revision_id=r.native_change_revision_id
       where r.owner_user_id=$1 and r.project_identity=$2 and r.entity_identity=$3 and c.owner_user_id=$1
        and c.project_id=$4 and c.entity_id=$5 and c.operation in ('include_repository','include_folder','remove_inclusion')`,
      [
        entity.owner_user_id,
        entity.project_identity,
        entity.entity_identity,
        projectId,
        current.inclusion_id
      ]
    );
    if (!proof.rowCount) throw personalMembershipBridgeRequired();
  }
  if (!current && !target) return false;
  const inclusionId =
      current?.inclusion_id ?? personalMembershipNativeEntityId(entity),
    head = personalMembershipNativeHeadId(entity);
  const folderContext =
    target?.kind === "folder"
      ? (current?.folder_context ??
        (await findPersonalFolderContext(
          client,
          { userId: entity.owner_user_id },
          projectId,
          target.folder
        )) ??
        null)
      : (current?.folder_context ?? null);
  let changed = false;
  if (!current) {
    if (
      (
        await client.query(
          "select 1 from personal_project_rules where inclusion_id=$1",
          [inclusionId]
        )
      ).rowCount
    )
      throw new TypeError("PdsCryptoMembershipNativeRuleIdentityError");
    await client.query(
      `insert into personal_project_rules(inclusion_id,owner_user_id,project_id,target,target_scope,folder_context,head_revision_id)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [
        inclusionId,
        entity.owner_user_id,
        projectId,
        target,
        scope,
        folderContext,
        head
      ]
    );
    changed = true;
  } else if (
    current.head_revision_id !== head ||
    Boolean(current.removed_at) === available ||
    (target && !isDeepStrictEqual(current.target, target)) ||
    !isDeepStrictEqual(current.folder_context, folderContext)
  ) {
    await client.query(
      `update personal_project_rules set target=$4,folder_context=$5,head_revision_id=$6,
       removed_at=case when $7::boolean then null else coalesce(removed_at,now()) end,version=version+1,updated_at=now()
       where owner_user_id=$1 and project_id=$2 and inclusion_id=$3`,
      [
        entity.owner_user_id,
        projectId,
        inclusionId,
        target ?? current.target,
        folderContext,
        head,
        available
      ]
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
