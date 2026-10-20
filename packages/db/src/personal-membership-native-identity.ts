import {
  crossIdentitySyncDeterministicUuid,
  personalOwnerIdSchema,
  personalIdentifierSchema
} from "@koed/shared";
import type { PersonalMembershipEntityRow } from "./personal-membership-causal-history.js";

export const personalMembershipNativeProjectId = (
  ownerUserId: string,
  projectIdentity: string
): string => {
  const native = personalOwnerIdSchema.safeParse(projectIdentity);
  if (native.success) return native.data;
  return crossIdentitySyncDeterministicUuid({
    namespace: "koed/personal-membership-project/v1",
    ownerUserId: personalOwnerIdSchema.parse(ownerUserId),
    projectIdentity: personalIdentifierSchema.parse(projectIdentity)
  });
};
export const personalMembershipNativeEntityId = (
  entity: PersonalMembershipEntityRow
): string =>
  entity.local_entity_id ??
  crossIdentitySyncDeterministicUuid({
    namespace: "koed/personal-membership-entity/v1",
    ownerUserId: entity.owner_user_id,
    projectIdentity: entity.project_identity,
    entityIdentity: entity.entity_identity,
    kind: entity.entity_kind
  });
/** Native head columns remain UUID view identifiers. The full causal frontier is retained separately. */
export const personalMembershipNativeHeadId = (
  entity: PersonalMembershipEntityRow
): string => {
  if (entity.state === "available" && entity.heads.length === 1) {
    const native = personalOwnerIdSchema.safeParse(entity.heads[0]);
    if (native.success) return native.data;
  }
  return crossIdentitySyncDeterministicUuid({
    namespace: "koed/personal-membership-view/v1",
    ownerUserId: entity.owner_user_id,
    projectIdentity: entity.project_identity,
    entityIdentity: entity.entity_identity,
    state: entity.state,
    heads: [...entity.heads].sort()
  });
};
export const personalMembershipBridgeRequired = () =>
  Object.assign(
    new Error(
      "Local Project history must be retained before synchronization can update its view."
    ),
    {
      name: "PersonalMembershipBridgeRequiredError",
      statusCode: 409,
      code: "membership_bridge_required",
      retryable: true
    }
  );
