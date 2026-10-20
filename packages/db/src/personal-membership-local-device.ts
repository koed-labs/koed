import type pg from "pg";
import { personalIdentifierSchema } from "@koed/shared";
import type { PersonalConfigurationLocalDevice } from "./personal-configuration-membership.js";

/** Call only after current owned group/member/key checks on private runtime input.
 * Retained attribution can survive unpairing; it grants no network authority.
 */
export const retainPersonalMembershipLocalDevice = async (
  client: pg.PoolClient,
  ownerUserId: string,
  device: PersonalConfigurationLocalDevice
) => {
  for (const value of [
    device.deviceId,
    device.signingKeyId,
    device.originatingDeploymentId
  ])
    personalIdentifierSchema.parse(value);
  await client.query(
    `insert into personal_membership_local_devices(owner_user_id,device_id,signing_key_id,originating_deployment_id)
     values($1,$2,$3,$4) on conflict(owner_user_id) do update set device_id=excluded.device_id,
      signing_key_id=excluded.signing_key_id,originating_deployment_id=excluded.originating_deployment_id,updated_at=now()`,
    [
      ownerUserId,
      device.deviceId,
      device.signingKeyId,
      device.originatingDeploymentId
    ]
  );
};
