import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest,
  CAPTURED_SESSION_SYNC_HTTP_TIMEOUT_MS,
  CAPTURED_SESSION_SYNC_MAX_CONTROL_RESPONSE_BYTES,
  fetchBoundedJsonObject,
  generateRecipientKeyMaterial,
  toRecipientPublicKeyMaterial,
  type RecipientPublicKeyMaterial
} from "@koed/shared";
import type { DeviceCredentialAuthContext } from "@koed/db";
import {
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  upstreamBackendById
} from "../local-edge/upstream-routing.js";
import type { ApiRouteContext } from "../server/context.js";
import {
  applyRemoteSyncRevocationSchema,
  createSourceSyncRelationshipSchema,
  createTargetSyncRelationshipSchema,
  createUploadSessionSchema,
  relationshipParamsSchema,
  revokeSyncRelationshipSchema,
  targetSyncRelationshipResponseSchema,
  uploadChunkParamsSchema,
  uploadChunkSchema,
  uploadSessionParamsSchema
} from "./schemas.js";

const assertSyncDeviceCredential = async (
  request: FastifyRequest,
  context: ApiRouteContext
): Promise<DeviceCredentialAuthContext> => {
  const auth = await context.auth.authenticateDeviceCredential(request);
  if (
    !auth.credential.operationFamilies.includes("sync") &&
    !auth.credential.operationFamilies.includes("*")
  ) {
    throw Object.assign(
      new Error("Device credential is not allowed for sync"),
      { statusCode: 403 }
    );
  }
  return auth;
};

const authenticateSyncActor = async (
  request: FastifyRequest,
  context: ApiRouteContext,
  apiTokenError: string
): Promise<{
  user: { id: string };
  deviceCredentialId: string | null;
}> => {
  const scheme = request.headers.authorization
    ?.trim()
    .split(/\s+/, 1)[0]
    ?.toLowerCase();
  if (scheme === "bearer") {
    throw Object.assign(new Error(apiTokenError), { statusCode: 403 });
  }
  if (scheme === "koed-device") {
    const auth = await assertSyncDeviceCredential(request, context);
    return { user: auth.user, deviceCredentialId: auth.credential.id };
  }
  return {
    user: await context.auth.authenticateSession(request),
    deviceCredentialId: null
  };
};

const checkedJson = (response: Response, payload: Record<string, unknown>) => {
  if (!response.ok) {
    throw Object.assign(new Error("Remote sync operation failed"), {
      statusCode: response.status >= 500 ? 424 : response.status,
      remoteStatus: response.status
    });
  }
  return payload;
};

const publicRelationship = (relationship: {
  id: string;
  logicalMemoryId: string;
  side: string;
  state: string;
  sourceCursor: number;
  targetProcessingCursor: number;
  packageSequence: number;
  lastSyncedAt: string | null;
  staleAfter: string | null;
  revokedAt: string | null;
}) => ({
  id: relationship.id,
  logicalMemoryId: relationship.logicalMemoryId,
  side: relationship.side,
  state: relationship.state === "created" ? "pending" : relationship.state,
  sourceCursor: relationship.sourceCursor,
  targetProcessingCursor: relationship.targetProcessingCursor,
  packageSequence: relationship.packageSequence,
  lastSyncedAt: relationship.lastSyncedAt,
  staleAfter: relationship.staleAfter,
  revokedAt: relationship.revokedAt
});

export const registerCrossIdentitySyncRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const repo = context.requireRepository;
  const { memoryRead, memoryWrite } = context.rateLimit;
  const targetProfiles = new Set([
    "private_vps",
    "team_self_hosted",
    "koed_managed_cloud"
  ]);
  const assertTargetDeployment = () => {
    if (!targetProfiles.has(context.config.deploymentProfile)) {
      throw Object.assign(new Error("Sync intake is unavailable"), {
        statusCode: 404
      });
    }
  };

  app.post(
    "/v1/cross-identity-sync/relationships",
    { preHandler: memoryWrite },
    async (request) => {
      if (
        !["developer", "local_personal"].includes(
          context.config.deploymentProfile
        )
      ) {
        throw Object.assign(new Error("Sync source is unavailable"), {
          statusCode: 404
        });
      }
      const user = await context.auth.authenticateSession(request);
      const input = createSourceSyncRelationshipSchema.parse(request.body);
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const backend = upstreamBackendById(registry, input.upstream_backend_id);
      const authorization = backend
        ? context.localEdge.resolveUpstreamAuthorization(backend)
        : null;
      const decision = resolveLocalEdgeRouteDecision({
        operationFamily: "sync",
        upstreamBackend: backend,
        upstreamBackendId: input.upstream_backend_id,
        upstreamCredentialAvailable: Boolean(authorization)
      });
      if (
        decision.action !== "queued_sync_handoff" ||
        !backend ||
        !authorization
      ) {
        throw Object.assign(new Error(decision.reason), { statusCode: 424 });
      }

      const repository = repo();
      const localDeployment = await repository.ensureLocalSyncDeployment({
        profile: context.config.deploymentProfile
      });
      const protocolIdentity = {
        protocol: "koed.captured-session-sync/v1",
        sourceDeploymentId: localDeployment.protocolDeploymentId,
        sourceUserId: user.id,
        originSessionId: input.session_id,
        upstreamBackendId: backend.id,
        idempotencyKey: input.idempotency_key
      };
      const relationshipId = crossIdentitySyncDeterministicUuid({
        ...protocolIdentity,
        identity: "relationship"
      });
      const logicalMemoryId = crossIdentitySyncDeterministicUuid({
        ...protocolIdentity,
        identity: "logical-memory"
      });
      const sourceReplicaId = crossIdentitySyncDeterministicUuid({
        ...protocolIdentity,
        identity: "source-replica"
      });
      const session = await repository.getCapturedSessionSyncSource(
        { userId: user.id },
        input.session_id
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
      };
      const consentManifest = {
        ...input.consent,
        selectedSessionId: input.session_id
      };
      const requestBinding = {
        relationshipId,
        logicalMemoryId,
        sourceDeploymentId: localDeployment.protocolDeploymentId,
        sourceUserId: user.id,
        sourceReplicaId,
        originSessionId: input.session_id,
        idempotencyKey: input.idempotency_key,
        policyDigest: crossIdentitySyncDigest(policyManifest),
        consentDigest: crossIdentitySyncDigest(consentManifest)
      };
      const creationRequestHash = crossIdentitySyncDigest(requestBinding);
      const { response, payload } = await fetchBoundedJsonObject(
        context.localEdge.fetch,
        new URL(
          "/v1/cross-identity-sync/intake/relationships",
          `${backend.baseUrl}/`
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
            source_user_id: user.id,
            origin_session_id: input.session_id,
            idempotency_key: input.idempotency_key,
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
        remote.target_deployment_id === localDeployment.protocolDeploymentId ||
        remote.recipient_key.keyId !== remote.recipient_key.publicJwk.kid
      ) {
        throw Object.assign(
          new Error("Remote sync identity binding is invalid"),
          {
            statusCode: 424
          }
        );
      }
      const remoteDeployment = await repository.upsertRemoteSyncDeployment({
        protocolDeploymentId: String(remote.target_deployment_id),
        profile: remote.target_deployment_profile,
        baseUrl: backend.baseUrl,
        upstreamBackendId: backend.id,
        metadata: {
          credentialReference:
            (backend.credential as { reference?: string } | undefined)
              ?.reference ?? null
        }
      });
      const remoteUser = await repository.upsertExternalSyncUserIdentity({
        deploymentIdentityId: remoteDeployment.id,
        externalSubjectId: remote.target_user_id
      });
      await repository.linkExternalSyncUser(
        { userId: user.id },
        {
          externalUserIdentityId: remoteUser.id,
          proofKind: "device_enrollment",
          proofReference: backend.id
        }
      );
      const created = await repository.createSourceSyncRelationship(
        { userId: user.id },
        {
          relationshipId,
          logicalMemoryId,
          localReplicaId: sourceReplicaId,
          sessionId: input.session_id,
          localDeploymentIdentityId: localDeployment.id,
          remoteDeploymentIdentityId: remoteDeployment.id,
          remoteUserIdentityId: remoteUser.id,
          remoteReplicaId: remote.target_replica_id,
          idempotencyKey: input.idempotency_key,
          creationRequestHash,
          policyManifest: {
            ...policyManifest,
            recipientKey: remote.recipient_key as RecipientPublicKeyMaterial
          },
          consentManifest
        }
      );
      if (!created) {
        throw Object.assign(new Error("Captured Session not found"), {
          statusCode: 404
        });
      }
      return { relationship: publicRelationship(created.relationship) };
    }
  );

  app.post(
    "/v1/cross-identity-sync/intake/relationships",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const input = createTargetSyncRelationshipSchema.parse(request.body);
      const rootProvider = context.encryption.envelopeEncryptionProvider;
      if (
        !rootProvider?.status ||
        (await rootProvider.status()).status !== "available"
      ) {
        throw Object.assign(
          new Error("Envelope encryption provider is required for sync"),
          { statusCode: 503 }
        );
      }
      const expectedCreationRequestHash = crossIdentitySyncDigest({
        relationshipId: input.relationship_id,
        logicalMemoryId: input.logical_memory_id,
        sourceDeploymentId: input.source_deployment_id,
        sourceUserId: input.source_user_id,
        sourceReplicaId: input.source_replica_id,
        originSessionId: input.origin_session_id,
        idempotencyKey: input.idempotency_key,
        policyDigest: crossIdentitySyncDigest(input.policy_manifest),
        consentDigest: crossIdentitySyncDigest(input.consent_manifest)
      });
      if (input.creation_request_hash !== expectedCreationRequestHash) {
        throw Object.assign(new Error("Sync relationship binding is invalid"), {
          statusCode: 400
        });
      }
      if (input.session.originSessionId !== input.origin_session_id) {
        throw Object.assign(new Error("Sync session binding is invalid"), {
          statusCode: 400
        });
      }
      const repository = repo();
      const localDeployment = await repository.ensureLocalSyncDeployment({
        profile: context.config.deploymentProfile
      });
      const remoteDeployment = await repository.upsertRemoteSyncDeployment({
        protocolDeploymentId: input.source_deployment_id,
        profile: "local_personal"
      });
      const remoteUser = await repository.upsertExternalSyncUserIdentity({
        deploymentIdentityId: remoteDeployment.id,
        externalSubjectId: input.source_user_id
      });
      await repository.linkExternalSyncUser(
        { userId: auth.user.id },
        {
          externalUserIdentityId: remoteUser.id,
          proofKind: "device_credential_lineage",
          proofReference: auth.credential.lineageId
        }
      );
      const localReplicaId = crossIdentitySyncDeterministicUuid({
        protocol: "koed.captured-session-sync/v1",
        relationshipId: input.relationship_id,
        targetDeploymentId: localDeployment.protocolDeploymentId,
        targetUserId: auth.user.id,
        identity: "target-replica"
      });
      const created = await repository.createTargetSyncRelationship(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        {
          relationshipId: input.relationship_id,
          logicalMemoryId: input.logical_memory_id,
          originSessionId: input.origin_session_id,
          localDeploymentIdentityId: localDeployment.id,
          remoteDeploymentIdentityId: remoteDeployment.id,
          remoteUserIdentityId: remoteUser.id,
          remoteReplicaId: input.source_replica_id,
          localReplicaId,
          idempotencyKey: input.idempotency_key,
          creationRequestHash: input.creation_request_hash,
          policyManifest: input.policy_manifest,
          consentManifest: input.consent_manifest,
          session: input.session
        }
      );
      if (!created) {
        throw Object.assign(new Error("Sync relationship was not created"), {
          statusCode: 409
        });
      }
      let recipient = await repository.getActiveSyncRecipientKey(
        localDeployment.id
      );
      if (!recipient) {
        recipient = await repository.ensureSyncRecipientKey({
          deploymentIdentityId: localDeployment.id,
          material: await generateRecipientKeyMaterial(rootProvider, {
            keyId: `sync-recipient:${localDeployment.protocolDeploymentId}`,
            keyVersion: 1,
            scope: {
              deploymentId: localDeployment.protocolDeploymentId,
              objectClass: "sync_recipient_key"
            },
            provenance: {
              rowFamily: "sync_recipient_key",
              sourceId: localDeployment.id
            }
          })
        });
      }
      return {
        relationship: publicRelationship(created.relationship),
        target_deployment_id: localDeployment.protocolDeploymentId,
        target_deployment_profile: localDeployment.profile,
        target_user_id: auth.user.id,
        target_replica_id: created.localReplica.id,
        recipient_key: toRecipientPublicKeyMaterial(recipient)
      };
    }
  );

  app.get(
    "/v1/cross-identity-sync/relationships/:relationshipId",
    { preHandler: memoryRead },
    async (request) => {
      const auth = await authenticateSyncActor(
        request,
        context,
        "API Tokens cannot inspect Team sync"
      );
      const { relationshipId } = relationshipParamsSchema.parse(request.params);
      const relationship = await repo().getCrossIdentitySyncRelationship(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.deviceCredentialId
        },
        relationshipId
      );
      if (!relationship) {
        throw Object.assign(new Error("Sync relationship not found"), {
          statusCode: 404
        });
      }
      return { relationship: publicRelationship(relationship) };
    }
  );

  app.post(
    "/v1/cross-identity-sync/relationships/:relationshipId/retry",
    { preHandler: memoryWrite },
    async (request) => {
      const auth = await authenticateSyncActor(
        request,
        context,
        "API Tokens cannot retry Team sync"
      );
      const { relationshipId } = relationshipParamsSchema.parse(request.params);
      const relationship = await repo().retryCrossIdentitySyncRelationship(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.deviceCredentialId
        },
        relationshipId
      );
      if (!relationship) {
        throw Object.assign(new Error("Failed sync relationship not found"), {
          statusCode: 404
        });
      }
      return { relationship: publicRelationship(relationship) };
    }
  );

  app.post(
    "/v1/cross-identity-sync/relationships/:relationshipId/revoke",
    { preHandler: memoryWrite },
    async (request) => {
      const auth = await authenticateSyncActor(
        request,
        context,
        "API Tokens cannot revoke Team sync"
      );
      const { relationshipId } = relationshipParamsSchema.parse(request.params);
      const input = revokeSyncRelationshipSchema.parse(request.body ?? {});
      const relationship = await repo().revokeCrossIdentitySyncRelationship(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.deviceCredentialId
        },
        { syncRelationshipId: relationshipId, reason: input.reason }
      );
      if (!relationship) {
        throw Object.assign(new Error("Sync relationship not found"), {
          statusCode: 404
        });
      }
      return { relationship: publicRelationship(relationship) };
    }
  );

  app.post(
    "/v1/cross-identity-sync/intake/relationships/:relationshipId/revoke",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const { relationshipId } = relationshipParamsSchema.parse(request.params);
      const input = applyRemoteSyncRevocationSchema.parse(request.body);
      const relationship = await repo().applyRemoteSyncRevocation(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        {
          syncRelationshipId: relationshipId,
          revocationId: input.revocation_id,
          revocationSequence: input.revocation_sequence
        }
      );
      if (!relationship) {
        throw Object.assign(new Error("Sync relationship not found"), {
          statusCode: 404
        });
      }
      return { relationship: publicRelationship(relationship) };
    }
  );

  app.post(
    "/v1/cross-identity-sync/relationships/:relationshipId/upload-sessions",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const { relationshipId } = relationshipParamsSchema.parse(request.params);
      const input = createUploadSessionSchema.parse(request.body);
      const upload = await repo().createSyncPackageUploadSession(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        {
          syncRelationshipId: relationshipId,
          protocolPackageId: input.protocol_package_id,
          idempotencyKey: input.idempotency_key,
          requestHash: input.request_hash,
          packageManifest: input.package_manifest,
          packageChecksum: input.package_checksum,
          totalBytes: input.total_bytes,
          expectedChunkCount: input.expected_chunk_count,
          sourceSequence: input.source_sequence,
          fromCursor: input.from_cursor,
          toCursor: input.to_cursor,
          relationshipSide: "target"
        }
      );
      if (!upload) {
        throw Object.assign(new Error("Sync relationship not found"), {
          statusCode: 404
        });
      }
      return { upload };
    }
  );

  app.put(
    "/v1/cross-identity-sync/upload-sessions/:uploadSessionId/chunks/:chunkIndex",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const params = uploadChunkParamsSchema.parse(request.params);
      const input = uploadChunkSchema.parse(request.body);
      const chunk = await repo().recordSyncPackageChunk(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        {
          uploadSessionId: params.uploadSessionId,
          chunkIndex: params.chunkIndex,
          chunkChecksum: input.checksum_sha256,
          byteCount: input.byte_count,
          encryptedPayload: input.encrypted_package as never,
          relationshipSide: "target"
        }
      );
      if (!chunk) {
        throw Object.assign(new Error("Upload session not found"), {
          statusCode: 404
        });
      }
      return { chunkIndex: chunk.chunkIndex, accepted: true };
    }
  );

  app.get(
    "/v1/cross-identity-sync/upload-sessions/:uploadSessionId",
    { preHandler: memoryRead },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const { uploadSessionId } = uploadSessionParamsSchema.parse(
        request.params
      );
      const status = await repo().getSyncPackageUploadSession(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        uploadSessionId,
        "target"
      );
      if (!status) {
        throw Object.assign(new Error("Upload session not found"), {
          statusCode: 404
        });
      }
      return {
        upload: status.upload,
        acceptedChunkIndexes: status.chunks.map((chunk) => chunk.chunkIndex)
      };
    }
  );

  app.post(
    "/v1/cross-identity-sync/upload-sessions/:uploadSessionId/complete",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const { uploadSessionId } = uploadSessionParamsSchema.parse(
        request.params
      );
      const upload = await repo().verifySyncPackageUpload(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        uploadSessionId,
        "target"
      );
      if (!upload) {
        throw Object.assign(new Error("Upload session not found"), {
          statusCode: 404
        });
      }
      return { upload };
    }
  );
};
