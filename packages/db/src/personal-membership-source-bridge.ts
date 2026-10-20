import type pg from "pg";
import {
  personalMembershipSourceFromSelectorKey,
  personalSourceReferenceSchema
} from "@koed/shared";
import { personalMembershipBridgeRequired } from "./personal-membership-native-identity.js";
import { preparePersonalSourceContextSnapshot } from "./personal-source-context-export.js";
import type { PersonalSourceBindingRow } from "./personal-source-binding-state.js";

/** Exact proven native logical identity, not a provider ID or path, supplies a
 * source reference for the first portable freeze. Purged sources retain proof.
 */
export const resolveNativePersonalMembershipSource = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    logicalSessionId: string;
    localDeviceId: string;
    originatingDeploymentId: string;
    pinnedSelectorKey?: string;
    requireExistingSourceProof?: boolean;
  }
) => {
  const logicalId = input.logicalSessionId;
  let bindings = await client.query<PersonalSourceBindingRow>(
    `select * from personal_source_bindings where owner_user_id=$1 and local_logical_session_id=$2
     order by binding_id for update`,
    [input.ownerUserId, logicalId]
  );
  if (!bindings.rowCount) {
    // Imported historical organization is not evidence of a local capture origin.
    if (input.requireExistingSourceProof)
      throw personalMembershipBridgeRequired();
    const session = await client.query<{ id: string }>(
      `select s.id from sessions s where s.owner_user_id=$1 and s.logical_session_id=$2
       and s.visibility='personal' and s.invalidated_at is null and s.personal_deleted_at is null
       and not exists(select 1 from pds_logical_replicas r where r.local_session_id=s.id) for share`,
      [input.ownerUserId, logicalId]
    );
    if (!session.rows[0]) throw personalMembershipBridgeRequired();
    await preparePersonalSourceContextSnapshot(client, {
      ownerUserId: input.ownerUserId,
      localSessionId: session.rows[0].id,
      originatingDeploymentId: input.originatingDeploymentId,
      originatingDeviceId: input.localDeviceId
    });
    bindings = await client.query<PersonalSourceBindingRow>(
      "select * from personal_source_bindings where owner_user_id=$1 and local_logical_session_id=$2 for update",
      [input.ownerUserId, logicalId]
    );
  }
  const pinnedSource = input.pinnedSelectorKey
    ? personalMembershipSourceFromSelectorKey(
        input.pinnedSelectorKey,
        input.ownerUserId
      )
    : null;
  const candidates = pinnedSource
    ? bindings.rows.filter(
        (binding) =>
          binding.originating_deployment_id ===
            pinnedSource.originatingDeploymentId &&
          binding.originating_device_id === pinnedSource.originatingDeviceId &&
          binding.source_logical_session_id === pinnedSource.logicalSessionId
      )
    : bindings.rows;
  if (candidates.length !== 1) throw personalMembershipBridgeRequired();
  const binding = candidates[0]!;
  const source = personalSourceReferenceSchema.parse({
    ownerUserId: input.ownerUserId,
    originatingDeploymentId: binding.originating_deployment_id,
    originatingDeviceId: binding.originating_device_id,
    logicalSessionId: binding.source_logical_session_id
  });
  return { binding, source };
};
