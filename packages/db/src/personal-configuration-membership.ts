import type pg from "pg";
import {
  decodePdsPersonalMembershipEntitySnapshot,
  personalIdentifierSchema,
  PdsConfigurationCompatibilityError,
  type PersonalConfigurationRecord
} from "@koed/shared";
import { bridgePersonalMembershipProject } from "./personal-membership-project-bridge.js";
import {
  translatePersonalMembershipSnapshotOwner,
  retainPersonalMembershipSnapshot
} from "./personal-membership-causal-history.js";
import { personalMembershipNativeProjectId } from "./personal-membership-native-identity.js";
import { projectPersonalMembershipState } from "./personal-membership-projection.js";

/** Supplied only by the receiving private runtime, independently of the remote witness. */
export type PersonalConfigurationLocalDevice = {
  deviceId: string;
  signingKeyId: string;
  originatingDeploymentId: string;
};

/** Outer witness and current receiving-device authority are checked by the caller.
 * Keep encrypted evidence pending if offline native intent cannot yet be frozen.
 */
export const applyVerifiedConfigurationMembership = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    record: PersonalConfigurationRecord;
    recordHash: string;
    localDevice?: PersonalConfigurationLocalDevice;
    allowApplication: boolean;
  }
): Promise<{ bindingId: null; applied: boolean }> => {
  const payload = input.record.revision.payload;
  if (payload.kind !== "project_membership")
    throw new TypeError("PdsCryptoConfigurationPayloadKindError");
  if (!input.allowApplication || !input.localDevice)
    return { bindingId: null, applied: false };
  const localDevice = input.localDevice;
  personalIdentifierSchema.parse(localDevice.deviceId);
  personalIdentifierSchema.parse(localDevice.signingKeyId);
  personalIdentifierSchema.parse(localDevice.originatingDeploymentId);
  const snapshot = translatePersonalMembershipSnapshotOwner(
    decodePdsPersonalMembershipEntitySnapshot(payload.snapshot),
    input.ownerUserId
  );
  await client.query("savepoint personal_membership_application");
  try {
    const mapped = await client.query<{ local_project_id: string | null }>(
      `select local_project_id from personal_membership_entities where owner_user_id=$1
       and project_identity=$2 and entity_kind='project'`,
      [input.ownerUserId, snapshot.project.projectId]
    );
    const projectId =
      mapped.rows[0]?.local_project_id ??
      personalMembershipNativeProjectId(
        input.ownerUserId,
        snapshot.project.projectId
      );
    await bridgePersonalMembershipProject(client, {
      ownerUserId: input.ownerUserId,
      nativeProjectId: projectId,
      localDevice
    });
    const retained = await retainPersonalMembershipSnapshot(client, {
      ownerUserId: input.ownerUserId,
      snapshot,
      witnessDeviceId: input.record.revision.authorDeviceId,
      verifiedRecordHash: input.recordHash
    });
    await projectPersonalMembershipState(client, {
      ownerUserId: input.ownerUserId,
      projectIdentity: snapshot.project.projectId,
      semanticChanged: retained.changed
    });
    await client.query("release savepoint personal_membership_application");
    return { bindingId: null, applied: true };
  } catch (error) {
    await client.query("rollback to savepoint personal_membership_application");
    await client.query("release savepoint personal_membership_application");
    if (
      error instanceof PdsConfigurationCompatibilityError ||
      (error instanceof Error &&
        error.name === "PersonalMembershipBridgeRequiredError")
    )
      return { bindingId: null, applied: false };
    throw error;
  }
};
