import type pg from "pg";
import { personalMembershipSourceFromSelectorKey } from "@koed/shared";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";

/** A canonical reference can create pending metadata only. Actual source receipt
 * must establish the owned Session pointer before any native membership view.
 */
export const resolvePersonalMembershipSourceProjection = async (
  client: pg.PoolClient,
  entity: PersonalMembershipEntityRow
) => {
  const source = personalMembershipSourceFromSelectorKey(
    entity.selector_key ?? "null",
    entity.owner_user_id
  );
  await client.query(
    `insert into personal_source_bindings(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id)
     values($1,$2,$3,$4) on conflict(owner_user_id,originating_deployment_id,originating_device_id,source_logical_session_id) do nothing`,
    [
      entity.owner_user_id,
      source.originatingDeploymentId,
      source.originatingDeviceId,
      source.logicalSessionId
    ]
  );
  const bindingResult = await client.query<{
    binding_id: string;
    availability: string;
    local_session_id: string | null;
    local_logical_session_id: string | null;
  }>(
    "select binding_id,availability,local_session_id,local_logical_session_id from personal_source_bindings where owner_user_id=$1 and originating_deployment_id=$2 and originating_device_id=$3 and source_logical_session_id=$4 for update",
    [
      entity.owner_user_id,
      source.originatingDeploymentId,
      source.originatingDeviceId,
      source.logicalSessionId
    ]
  );
  const binding = bindingResult.rows[0]!;
  if (
    entity.source_binding_id &&
    entity.source_binding_id !== binding.binding_id
  )
    throw new TypeError("PdsCryptoMembershipSourceBindingIdentityError");
  if (!entity.source_binding_id)
    await client.query(
      "update personal_membership_entities set source_binding_id=$4,updated_at=now() where owner_user_id=$1 and project_identity=$2 and entity_identity=$3",
      [
        entity.owner_user_id,
        entity.project_identity,
        entity.entity_identity,
        binding.binding_id
      ]
    );
  const body =
    binding.availability === "available" && binding.local_session_id
      ? await client.query<{ logical_session_id: string }>(
          "select logical_session_id from sessions where id=$1 and owner_user_id=$2 and logical_session_id=$3 and visibility='personal' and invalidated_at is null and personal_deleted_at is null for share",
          [
            binding.local_session_id,
            entity.owner_user_id,
            binding.local_logical_session_id
          ]
        )
      : null;
  const logicalSessionId = body?.rows[0]?.logical_session_id;
  return { source, binding, logicalSessionId };
};
