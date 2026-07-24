import type {
  CrossIdentitySyncRelationshipRecord,
  CrossIdentitySyncRepository,
  DeploymentProfile
} from "@koed/db";
import {
  CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
  CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES,
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  fetchBoundedJsonObject,
  upstreamApiUrl,
  type RecipientPublicKeyMaterial
} from "@koed/shared";

import {
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  upstreamAdvertisesCapability,
  upstreamBackendById,
  type LocalEdgeUpstreamBackend,
  type LocalEdgeUpstreamRegistry
} from "../local-edge/upstream-routing.js";
import {
  retrySyncRelationshipResponseSchema,
  targetSyncContextResponseSchema,
  targetSyncRelationshipResponseSchema
} from "./schemas.js";

export type SourceSyncRelationshipRepository = Pick<
  CrossIdentitySyncRepository,
  | "getCapturedSessionSyncSource"
  | "ensureLocalSyncDeployment"
  | "upsertRemoteSyncDeployment"
  | "upsertExternalSyncUserIdentity"
  | "linkExternalSyncUser"
  | "createSourceSyncRelationship"
  | "activateSourceSyncRelationship"
  | "retryCrossIdentitySyncRelationship"
  | "getSourceSyncRelationshipForSession"
  | "pauseCrossIdentitySyncRelationship"
  | "resumeCrossIdentitySyncRelationship"
  | "revokeCrossIdentitySyncRelationship"
>;

export interface SourceSyncRelationshipServiceOptions {
  deploymentProfile: DeploymentProfile;
  resolveVerifiedLocalDeploymentId: () => string;
  upstreamBackendsPath: string;
  fetch: typeof fetch;
  resolveUpstreamAuthorization: (
    backend: LocalEdgeUpstreamBackend
  ) => string | null;
  requireRepository: () => SourceSyncRelationshipRepository;
  readUpstreamRegistry?: (path: string) => LocalEdgeUpstreamRegistry;
}

export interface PrepareSourceSyncRelationshipInput {
  localUserId: string;
  sessionId: string;
  upstreamBackendId: string;
  idempotencyKey: string;
  consentedAt: string;
}

const persistedConsentManifest = (
  relationship: CrossIdentitySyncRelationshipRecord,
  sessionId: string
) => {
  const manifest = relationship.consentManifest;
  if (
    typeof manifest.consented_at !== "string" ||
    manifest.policy_version !== 1 ||
    manifest.source_boundary !== "captured_session" ||
    manifest.selectedSessionId !== sessionId
  ) {
    throw Object.assign(new Error("Sync consent binding is invalid"), {
      statusCode: 409
    });
  }
  return {
    consented_at: manifest.consented_at,
    policy_version: 1,
    source_boundary: "captured_session",
    selectedSessionId: sessionId
  } as const;
};

export const assertSourceSyncDeploymentProfile = (
  deploymentProfile: DeploymentProfile
): void => {
  if (!["developer", "local_personal"].includes(deploymentProfile)) {
    throw Object.assign(new Error("Sync source is unavailable"), {
      statusCode: 404
    });
  }
};

const checkedJson = (
  response: Response,
  payload: Record<string, unknown>
): Record<string, unknown> => {
  if (!response.ok) {
    throw Object.assign(new Error("Remote sync operation failed"), {
      statusCode: response.status >= 500 ? 424 : response.status,
      remoteStatus: response.status
    });
  }
  return payload;
};

export const prepareSourceSyncRelationship = async (
  options: SourceSyncRelationshipServiceOptions,
  input: PrepareSourceSyncRelationshipInput
): Promise<CrossIdentitySyncRelationshipRecord> => {
  assertSourceSyncDeploymentProfile(options.deploymentProfile);
  const localDeploymentId = options.resolveVerifiedLocalDeploymentId();

  const registry = (
    options.readUpstreamRegistry ?? readLocalEdgeUpstreamRegistry
  )(options.upstreamBackendsPath);
  const backend = upstreamBackendById(registry, input.upstreamBackendId);
  const authorization = backend
    ? options.resolveUpstreamAuthorization(backend)
    : null;
  const decision = resolveLocalEdgeRouteDecision({
    operationFamily: "sync",
    upstreamBackend: backend,
    upstreamBackendId: input.upstreamBackendId,
    upstreamCredentialAvailable: Boolean(authorization),
    identityRemoteOperationsAllowed: true
  });
  if (
    decision.action !== "queued_sync_handoff" ||
    !backend ||
    !authorization ||
    !upstreamAdvertisesCapability(backend, "memory.crossIdentitySync")
  ) {
    throw Object.assign(new Error(decision.reason), { statusCode: 424 });
  }

  const repository = options.requireRepository();
  const localDeployment = await repository.ensureLocalSyncDeployment({
    profile: options.deploymentProfile,
    protocolDeploymentId: localDeploymentId
  });
  const protocolIdentity = {
    protocol: "koed.captured-session-sync/v1",
    sourceDeploymentId: localDeployment.protocolDeploymentId,
    sourceUserId: input.localUserId,
    originSessionId: input.sessionId
  };
  const logicalMemoryId = crossIdentitySyncDeterministicUuid({
    protocol: protocolIdentity.protocol,
    sourceDeploymentId: protocolIdentity.sourceDeploymentId,
    sourceUserId: protocolIdentity.sourceUserId,
    originSessionId: protocolIdentity.originSessionId,
    identity: "logical-memory"
  });
  const sourceReplicaId = crossIdentitySyncDeterministicUuid({
    protocol: protocolIdentity.protocol,
    sourceDeploymentId: protocolIdentity.sourceDeploymentId,
    sourceUserId: protocolIdentity.sourceUserId,
    originSessionId: protocolIdentity.originSessionId,
    identity: "source-replica"
  });
  const session = await repository.getCapturedSessionSyncSource(
    { userId: input.localUserId },
    input.sessionId
  );
  if (!session) {
    throw Object.assign(new Error("Captured Session not found"), {
      statusCode: 404
    });
  }

  const policyManifest = {
    version: 1,
    sourceBoundary: "captured_session",
    transcriptIncluded: false,
    sourceVectorsAccepted: false
  } as const;
  const requestedConsentManifest = {
    consented_at: input.consentedAt,
    policy_version: 1,
    source_boundary: "captured_session",
    selectedSessionId: input.sessionId
  } as const;
  const contextResult = await fetchBoundedJsonObject(
    options.fetch,
    upstreamApiUrl(backend.baseUrl, "/v1/cross-identity-sync/intake/context"),
    {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    },
    {
      timeoutMs: CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
      maxBytes: CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES
    }
  );
  const remoteContext = targetSyncContextResponseSchema.parse(
    checkedJson(contextResult.response, contextResult.payload)
  );
  const relationshipId = crossIdentitySyncDeterministicUuid({
    protocol: protocolIdentity.protocol,
    sourceDeploymentId: protocolIdentity.sourceDeploymentId,
    sourceUserId: protocolIdentity.sourceUserId,
    originSessionId: protocolIdentity.originSessionId,
    targetDeploymentId: remoteContext.target_deployment_id,
    targetUserId: remoteContext.target_user_id,
    identity: "relationship"
  });
  const targetReplicaId = crossIdentitySyncDeterministicUuid({
    protocol: protocolIdentity.protocol,
    relationshipId,
    targetDeploymentId: remoteContext.target_deployment_id,
    targetUserId: remoteContext.target_user_id,
    identity: "target-replica"
  });
  if (
    remoteContext.target_deployment_id ===
      localDeployment.protocolDeploymentId ||
    remoteContext.recipient_key.keyId !==
      remoteContext.recipient_key.publicJwk.kid
  ) {
    throw Object.assign(new Error("Remote sync identity binding is invalid"), {
      statusCode: 424
    });
  }
  const credentialReference = (
    backend.credential as { reference?: string } | undefined
  )?.reference;
  if (!credentialReference) {
    throw Object.assign(
      new Error("Remote sync credential lineage is unavailable"),
      { statusCode: 424 }
    );
  }
  const remoteDeployment = await repository.upsertRemoteSyncDeployment({
    protocolDeploymentId: remoteContext.target_deployment_id,
    profile: remoteContext.target_deployment_profile,
    baseUrl: backend.baseUrl,
    upstreamBackendId: backend.id,
    metadata: { credentialReference }
  });
  const remoteUser = await repository.upsertExternalSyncUserIdentity({
    deploymentIdentityId: remoteDeployment.id,
    externalSubjectId: remoteContext.target_user_id
  });
  const existing = await repository.getSourceSyncRelationshipForSession(
    { userId: input.localUserId },
    input.sessionId
  );
  if (existing?.revokedAt) {
    throw Object.assign(new Error("Sync relationship is revoked"), {
      statusCode: 410
    });
  }
  if (
    existing &&
    (existing.id !== relationshipId ||
      existing.logicalMemoryId !== logicalMemoryId ||
      existing.side !== "source" ||
      existing.localReplicaId !== sourceReplicaId ||
      existing.localUserId !== input.localUserId ||
      existing.remoteDeploymentIdentityId !== remoteDeployment.id ||
      existing.remoteUserIdentityId !== remoteUser.id ||
      existing.remoteReplicaId !== targetReplicaId ||
      existing.sourceBoundary !== "captured_session")
  ) {
    throw Object.assign(new Error("Sync relationship binding is invalid"), {
      statusCode: 409
    });
  }
  const consentManifest = existing
    ? persistedConsentManifest(existing, input.sessionId)
    : requestedConsentManifest;
  const idempotencyKey = existing?.idempotencyKey ?? input.idempotencyKey;
  const requestBinding = {
    logicalMemoryId,
    sourceDeploymentId: localDeployment.protocolDeploymentId,
    sourceUserId: input.localUserId,
    sourceReplicaId,
    originSessionId: input.sessionId,
    policyDigest: crossIdentitySyncDigest(policyManifest),
    consentDigest: crossIdentitySyncDigest(consentManifest)
  };
  const creationRequestHash = crossIdentitySyncDigest({
    relationshipId,
    ...requestBinding
  });
  if (existing && existing.creationRequestHash !== creationRequestHash) {
    throw Object.assign(new Error("Sync relationship binding is invalid"), {
      statusCode: 409
    });
  }
  await repository.linkExternalSyncUser(
    { userId: input.localUserId },
    {
      externalUserIdentityId: remoteUser.id,
      proofKind: "device_enrollment",
      proofReference: crossIdentitySyncDigest({
        upstreamBackendId: backend.id,
        credentialReference
      })
    }
  );
  const created = await repository.createSourceSyncRelationship(
    { userId: input.localUserId },
    {
      relationshipId,
      logicalMemoryId,
      localReplicaId: sourceReplicaId,
      sessionId: input.sessionId,
      localDeploymentIdentityId: localDeployment.id,
      remoteDeploymentIdentityId: remoteDeployment.id,
      remoteUserIdentityId: remoteUser.id,
      remoteReplicaId: targetReplicaId,
      idempotencyKey,
      creationRequestHash,
      policyManifest: {
        ...policyManifest,
        recipientKey: remoteContext.recipient_key as RecipientPublicKeyMaterial
      },
      consentManifest
    }
  );
  if (!created) {
    throw Object.assign(new Error("Captured Session not found"), {
      statusCode: 404
    });
  }

  const { response, payload } = await fetchBoundedJsonObject(
    options.fetch,
    upstreamApiUrl(
      backend.baseUrl,
      "/v1/cross-identity-sync/intake/relationships"
    ),
    {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        relationship_id: relationshipId,
        logical_memory_id: logicalMemoryId,
        source_replica_id: sourceReplicaId,
        source_deployment_id: localDeployment.protocolDeploymentId,
        source_user_id: input.localUserId,
        origin_session_id: input.sessionId,
        idempotency_key: idempotencyKey,
        creation_request_hash: creationRequestHash,
        policy_manifest: policyManifest,
        consent_manifest: consentManifest,
        session
      })
    },
    {
      timeoutMs: CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
      maxBytes: CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES
    }
  );
  const remote = targetSyncRelationshipResponseSchema.parse(
    checkedJson(response, payload)
  );
  if (
    remote.relationship.id !== relationshipId ||
    remote.target_deployment_id !== remoteContext.target_deployment_id ||
    remote.target_user_id !== remoteContext.target_user_id ||
    remote.target_replica_id !== targetReplicaId ||
    crossIdentitySyncDigest(remote.recipient_key) !==
      crossIdentitySyncDigest(remoteContext.recipient_key)
  ) {
    throw Object.assign(new Error("Remote sync identity binding is invalid"), {
      statusCode: 424
    });
  }
  if (remote.relationship.state === "failed") {
    const retryResult = await fetchBoundedJsonObject(
      options.fetch,
      upstreamApiUrl(
        backend.baseUrl,
        `/v1/cross-identity-sync/relationships/${relationshipId}/retry`
      ),
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization
        }
      },
      {
        timeoutMs: CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
        maxBytes: CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES
      }
    );
    const retried = retrySyncRelationshipResponseSchema.parse(
      checkedJson(retryResult.response, retryResult.payload)
    );
    if (
      retried.relationship.id !== relationshipId ||
      retried.relationship.state !== "processing"
    ) {
      throw Object.assign(new Error("Remote sync retry state is invalid"), {
        statusCode: 424
      });
    }
  }
  let activated = await repository.activateSourceSyncRelationship({
    relationshipId,
    localUserId: input.localUserId
  });
  if (!activated && created.relationship.state === "failed") {
    const retried = await repository.retryCrossIdentitySyncRelationship(
      { userId: input.localUserId },
      relationshipId
    );
    if (retried) {
      activated = await repository.activateSourceSyncRelationship({
        relationshipId,
        localUserId: input.localUserId
      });
    }
  }
  if (!activated) {
    throw Object.assign(new Error("Sync relationship activation failed"), {
      statusCode: 409
    });
  }
  return activated;
};
