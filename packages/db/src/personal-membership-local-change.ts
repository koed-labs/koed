import { bridgePersonalMembershipExclusion } from "./personal-membership-exclusion-bridge.js";
import { bridgePersonalMembershipRule } from "./personal-membership-rule-bridge.js";
import type pg from "pg";
import { PdsConfigurationCompatibilityError } from "@koed/shared";
import { bridgePersonalMembershipCatalog } from "./personal-membership-catalog-bridge.js";
import { bridgePersonalDirectMembership } from "./personal-membership-direct-bridge.js";

/** Apply real local intent to the causal view in the same User transaction,
 * including while unpaired/offline. Unknown legacy origins retain native audit
 * for repair; source facts and signed membership bodies are never guessed.
 */
export const retainPersonalMembershipLocalChange = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    projectId: string;
    entityId: string;
    operation: string;
  }
) => {
  if (
    ![
      "set_project",
      "delete_project",
      "include_session",
      "include_repository",
      "include_folder",
      "remove_inclusion",
      "exclude",
      "clear_exclusion"
    ].includes(input.operation)
  )
    return;
  const device = await client.query<{
    device_id: string;
    originating_deployment_id: string;
  }>(
    "select device_id,originating_deployment_id from personal_membership_local_devices where owner_user_id=$1",
    [input.ownerUserId]
  );
  const local = device.rows[0];
  if (!local) return;
  await client.query("savepoint personal_local_membership_change");
  try {
    await bridgePersonalMembershipCatalog(client, {
      ownerUserId: input.ownerUserId,
      nativeProjectId: input.projectId,
      localDeviceId: local.device_id
    });
    if (input.entityId !== input.projectId) {
      const nativeKind = await client.query<{
        kind: "direct" | "rule" | "exclusion";
      }>(
        `select 'direct' kind from personal_project_inclusions where owner_user_id=$1 and project_id=$2 and inclusion_id=$3
         union all select 'rule' kind from personal_project_rules where owner_user_id=$1 and project_id=$2 and inclusion_id=$3
         union all select 'exclusion' kind from personal_project_exclusions where owner_user_id=$1 and project_id=$2 and exclusion_id=$3`,
        [input.ownerUserId, input.projectId, input.entityId]
      );
      if (nativeKind.rows.length !== 1)
        throw new TypeError("PersonalMembershipNativeEntityIdentityError");
      if (nativeKind.rows[0]!.kind === "rule")
        await bridgePersonalMembershipRule(client, {
          ownerUserId: input.ownerUserId,
          nativeProjectId: input.projectId,
          nativeRuleId: input.entityId,
          localDeviceId: local.device_id
        });
      else if (nativeKind.rows[0]!.kind === "exclusion")
        await bridgePersonalMembershipExclusion(client, {
          ownerUserId: input.ownerUserId,
          nativeProjectId: input.projectId,
          nativeExclusionId: input.entityId,
          localDeviceId: local.device_id,
          originatingDeploymentId: local.originating_deployment_id
        });
      else
        await bridgePersonalDirectMembership(client, {
          ownerUserId: input.ownerUserId,
          nativeProjectId: input.projectId,
          nativeInclusionId: input.entityId,
          localDeviceId: local.device_id,
          originatingDeploymentId: local.originating_deployment_id
        });
    }
    await client.query("release savepoint personal_local_membership_change");
  } catch (error) {
    await client.query(
      "rollback to savepoint personal_local_membership_change"
    );
    await client.query("release savepoint personal_local_membership_change");
    if (
      !(error instanceof PdsConfigurationCompatibilityError) &&
      !(
        error instanceof Error &&
        error.name === "PersonalMembershipBridgeRequiredError"
      )
    )
      throw error;
  }
};
