import { bridgePersonalMembershipExclusion } from "./personal-membership-exclusion-bridge.js";
import { bridgePersonalMembershipRule } from "./personal-membership-rule-bridge.js";
import type pg from "pg";
import type { PersonalConfigurationLocalDevice } from "./personal-configuration-membership.js";
import { bridgePersonalMembershipCatalog } from "./personal-membership-catalog-bridge.js";
import { bridgePersonalDirectMembership } from "./personal-membership-direct-bridge.js";

/** Projection rebuilds a complete view; retain all offline native edits first. */
export const bridgePersonalMembershipProject = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    nativeProjectId: string;
    localDevice: PersonalConfigurationLocalDevice;
  }
) => {
  await bridgePersonalMembershipCatalog(client, {
    ownerUserId: input.ownerUserId,
    nativeProjectId: input.nativeProjectId,
    localDeviceId: input.localDevice.deviceId
  });
  const native = await client.query<{ inclusion_id: string }>(
    `select i.inclusion_id from personal_project_inclusions i where i.owner_user_id=$1 and i.project_id=$2
     and exists(select 1 from personal_membership_changes c where c.owner_user_id=i.owner_user_id
       and c.project_id=i.project_id and c.entity_id=i.inclusion_id and c.operation in ('include_session','remove_inclusion')
       and not exists(select 1 from personal_membership_revisions r where r.native_change_revision_id=c.revision_id))
     order by i.inclusion_id`,
    [input.ownerUserId, input.nativeProjectId]
  );
  for (const inclusion of native.rows)
    await bridgePersonalDirectMembership(client, {
      ownerUserId: input.ownerUserId,
      nativeProjectId: input.nativeProjectId,
      nativeInclusionId: inclusion.inclusion_id,
      localDeviceId: input.localDevice.deviceId,
      originatingDeploymentId: input.localDevice.originatingDeploymentId
    });
  const rules = await client.query<{ inclusion_id: string }>(
    `select i.inclusion_id from personal_project_rules i where i.owner_user_id=$1 and i.project_id=$2
     and exists(select 1 from personal_membership_changes c where c.owner_user_id=i.owner_user_id and c.project_id=i.project_id
       and c.entity_id=i.inclusion_id and c.operation in ('include_repository','include_folder','remove_inclusion')
       and not exists(select 1 from personal_membership_revisions r where r.native_change_revision_id=c.revision_id))
     order by i.inclusion_id`,
    [input.ownerUserId, input.nativeProjectId]
  );
  for (const rule of rules.rows)
    await bridgePersonalMembershipRule(client, {
      ownerUserId: input.ownerUserId,
      nativeProjectId: input.nativeProjectId,
      nativeRuleId: rule.inclusion_id,
      localDeviceId: input.localDevice.deviceId
    });
  const exclusions = await client.query<{ exclusion_id: string }>(
    `select i.exclusion_id from personal_project_exclusions i where i.owner_user_id=$1 and i.project_id=$2
     and exists(select 1 from personal_membership_changes c where c.owner_user_id=i.owner_user_id and c.project_id=i.project_id
       and c.entity_id=i.exclusion_id and c.operation in ('exclude','clear_exclusion')
       and not exists(select 1 from personal_membership_revisions r where r.native_change_revision_id=c.revision_id))
     order by i.exclusion_id`,
    [input.ownerUserId, input.nativeProjectId]
  );
  for (const exclusion of exclusions.rows)
    await bridgePersonalMembershipExclusion(client, {
      ownerUserId: input.ownerUserId,
      nativeProjectId: input.nativeProjectId,
      nativeExclusionId: exclusion.exclusion_id,
      localDeviceId: input.localDevice.deviceId,
      originatingDeploymentId: input.localDevice.originatingDeploymentId
    });
};
