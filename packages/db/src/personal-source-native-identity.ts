import type pg from "pg";
import {
  crossIdentitySyncDeterministicUuid,
  personalSourceReferenceSchema
} from "@koed/shared";

/** Native UUIDs are storage identifiers. Signed logical source identifiers remain opaque. */
export const personalSourceNativeLogicalId = (input: {
  ownerUserId: string;
  originDeploymentId: string;
  originDeviceId: string;
  logicalSessionId: string;
}) => {
  const source = personalSourceReferenceSchema.parse({
    ownerUserId: input.ownerUserId,
    originatingDeploymentId: input.originDeploymentId,
    originatingDeviceId: input.originDeviceId,
    logicalSessionId: input.logicalSessionId
  });
  return crossIdentitySyncDeterministicUuid({
    namespace: "koed/personal-source-native/v1",
    source
  });
};
export const resolveVerifiedPdsNativeSource = async (
  client: pg.PoolClient,
  input: {
    ownerUserId: string;
    groupDbId: string;
    originDeploymentId: string;
    originDeviceId: string;
    sourceLogicalSessionId: string;
    sourceFingerprint: string;
    externalSessionId: string;
  }
) => {
  const source = personalSourceReferenceSchema.parse({
    ownerUserId: input.ownerUserId,
    originatingDeploymentId: input.originDeploymentId,
    originatingDeviceId: input.originDeviceId,
    logicalSessionId: input.sourceLogicalSessionId
  });
  const bound = await client.query<{
    local_session_id: string | null;
    local_logical_session_id: string | null;
    availability: "pending" | "available";
  }>(
    "select local_session_id,local_logical_session_id,availability from personal_source_bindings where owner_user_id=$1 and originating_deployment_id=$2 and originating_device_id=$3 and source_logical_session_id=$4 for update",
    [
      input.ownerUserId,
      source.originatingDeploymentId,
      source.originatingDeviceId,
      source.logicalSessionId
    ]
  );
  if (
    bound.rows[0] &&
    (bound.rows[0].local_session_id !== null ||
      bound.rows[0].local_logical_session_id !== null ||
      bound.rows[0].availability !== "pending")
  ) {
    const row = bound.rows[0];
    const native = await client.query(
      "select 1 from sessions where owner_user_id=$1 and id=$2 and logical_session_id=$3 and external_session_id=$4 and visibility='personal' and invalidated_at is null and personal_deleted_at is null",
      [
        input.ownerUserId,
        row.local_session_id,
        row.local_logical_session_id,
        input.externalSessionId
      ]
    );
    if (!native.rowCount)
      throw Object.assign(
        new Error("The verified source is unavailable locally."),
        { name: "PdsSourceBindingUnavailableError" }
      );
    return {
      logicalSessionId: row.local_logical_session_id!,
      existingSessionId: row.local_session_id!
    };
  }
  // Existing replicas carry an authenticated origin observation. A provider ID alone cannot bind a source.
  const previous = await client.query<{
    id: string;
    logical_session_id: string;
    source_logical_session_id: string;
    external_session_id: string | null;
    invalidated_at: Date | null;
    personal_deleted_at: Date | null;
  }>(
    `select distinct s.id,s.logical_session_id,coalesce(p.source_logical_session_id,s.logical_session_id::text) as source_logical_session_id,s.external_session_id,s.invalidated_at,s.personal_deleted_at
    from pds_logical_replicas r join sessions s on s.id=r.local_session_id and s.owner_user_id=r.owner_user_id
    join pds_replica_observations o on o.replica_id=r.id join pds_retained_packages p on p.id=o.retained_package_id
    where r.group_id=$1 and r.owner_user_id=$2 and r.source_fingerprint=$3 and o.origin_deployment_id=$4 and o.origin_device_id=$5`,
    [
      input.groupDbId,
      input.ownerUserId,
      input.sourceFingerprint,
      input.originDeploymentId,
      input.originDeviceId
    ]
  );
  const ids = new Set(previous.rows.map((row) => row.id));
  if (
    ids.size > 1 ||
    previous.rows.some(
      (row) =>
        row.source_logical_session_id !== source.logicalSessionId ||
        row.external_session_id !== input.externalSessionId
    )
  )
    throw new TypeError("PdsCryptoSourceNativeIdentityConflictError");
  if (previous.rows[0]) {
    const row = previous.rows[0];
    if (row.invalidated_at || row.personal_deleted_at)
      throw Object.assign(
        new Error("The verified source is unavailable locally."),
        { name: "PdsSourceBindingUnavailableError" }
      );
    return {
      logicalSessionId: row.logical_session_id,
      existingSessionId: row.id
    };
  }
  const logicalSessionId = personalSourceNativeLogicalId({
    ownerUserId: input.ownerUserId,
    originDeploymentId: input.originDeploymentId,
    originDeviceId: input.originDeviceId,
    logicalSessionId: source.logicalSessionId
  });
  const collision = await client.query(
    "select 1 from sessions where owner_user_id=$1 and logical_session_id=$2",
    [input.ownerUserId, logicalSessionId]
  );
  if (collision.rowCount)
    throw new TypeError("PdsCryptoUnverifiedNativeIdentityCollisionError");
  return { logicalSessionId, existingSessionId: null };
};
