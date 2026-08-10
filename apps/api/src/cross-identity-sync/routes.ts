import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest
} from "@koed/shared";
import type { DeviceCredentialAuthContext } from "@koed/db";
import { crossIdentitySyncTargetProfiles } from "./deployment-role.js";
import type { ApiRouteContext } from "../server/context.js";
import {
  applyRemoteSyncRevocationSchema,
  createSourceSyncRelationshipSchema,
  createTargetSyncRelationshipSchema,
  createUploadSessionSchema,
  relationshipParamsSchema,
  revokeSyncRelationshipSchema,
  targetSyncContextRequestSchema,
  syncHeartbeatSchema,
  uploadChunkParamsSchema,
  uploadChunkSchema,
  uploadSessionParamsSchema
} from "./schemas.js";
import {
  assertSourceSyncDeploymentProfile,
  prepareSourceSyncRelationship
} from "./source-relationship-service.js";
import { resolveSyncRecipientContext } from "../sync/recipient-context.js";

const assertSyncDeviceCredential = async (
  request: FastifyRequest,
  context: ApiRouteContext
): Promise<DeviceCredentialAuthContext> => {
  const auth = await context.auth.authenticateDeviceCredential(request);
  if (!auth.credential.operationFamilies.includes("sync")) {
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

const verifiedLocalDeploymentId = (context: ApiRouteContext): string => {
  const identity = context.deploymentIdentity.inspect();
  if (
    identity.health !== "healthy" ||
    !identity.remoteOperationsAllowed ||
    !identity.deploymentId
  ) {
    throw Object.assign(
      new Error("Local deployment identity is not verified"),
      { statusCode: 424 }
    );
  }
  return identity.deploymentId;
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
  const targetProfiles = crossIdentitySyncTargetProfiles({
    teamCollaborationEnabled: context.config.teamCollaborationEnabled,
    developerTeamBackendEnabled: context.config.developerTeamBackendEnabled
  });
  const assertTargetDeployment = () => {
    if (!targetProfiles.has(context.config.deploymentProfile)) {
      throw Object.assign(new Error("Sync intake is unavailable"), {
        statusCode: 404
      });
    }
  };
  const resolveTargetContext = () =>
    resolveSyncRecipientContext(context, targetProfiles);

  app.post(
    "/v1/cross-identity-sync/intake/context",
    { preHandler: memoryRead },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      targetSyncContextRequestSchema.parse(request.body);
      const target = await resolveTargetContext();
      return {
        target_deployment_id: target.localDeployment.protocolDeploymentId,
        target_deployment_profile: target.localDeployment.profile,
        target_user_id: auth.user.id,
        recipient_key: target.publicRecipient
      };
    }
  );

  app.post(
    "/v1/cross-identity-sync/relationships",
    { preHandler: memoryWrite },
    async (request) => {
      assertSourceSyncDeploymentProfile(context.config.deploymentProfile);
      const user = await context.auth.authenticateSession(request);
      const input = createSourceSyncRelationshipSchema.parse(request.body);
      const activated = await prepareSourceSyncRelationship(
        {
          deploymentProfile: context.config.deploymentProfile,
          resolveVerifiedLocalDeploymentId: () =>
            verifiedLocalDeploymentId(context),
          upstreamBackendsPath: context.localEdge.upstreamBackendsPath,
          fetch: context.localEdge.fetch,
          resolveUpstreamAuthorization:
            context.localEdge.resolveUpstreamAuthorization,
          requireRepository: repo
        },
        {
          localUserId: user.id,
          sessionId: input.session_id,
          upstreamBackendId: input.upstream_backend_id,
          idempotencyKey: input.idempotency_key,
          consentedAt: input.consent.consented_at
        }
      );
      return { relationship: publicRelationship(activated) };
    }
  );

  app.post(
    "/v1/cross-identity-sync/intake/relationships",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const input = createTargetSyncRelationshipSchema.parse(request.body);
      const target = await resolveTargetContext();
      const expectedCreationRequestHash = crossIdentitySyncDigest({
        relationshipId: input.relationship_id,
        logicalMemoryId: input.logical_memory_id,
        sourceDeploymentId: input.source_deployment_id,
        sourceUserId: input.source_user_id,
        sourceReplicaId: input.source_replica_id,
        originSessionId: input.origin_session_id,
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
      const localDeployment = target.localDeployment;
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
      return {
        relationship: publicRelationship(created.relationship),
        target_deployment_id: localDeployment.protocolDeploymentId,
        target_deployment_profile: localDeployment.profile,
        target_user_id: auth.user.id,
        target_replica_id: created.localReplica.id,
        recipient_key: target.publicRecipient
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
    "/v1/cross-identity-sync/intake/relationships/:relationshipId/heartbeat",
    { preHandler: memoryWrite },
    async (request) => {
      assertTargetDeployment();
      const auth = await assertSyncDeviceCredential(request, context);
      const { relationshipId } = relationshipParamsSchema.parse(request.params);
      const input = syncHeartbeatSchema.parse(request.body);
      const accepted = await repo().acceptTargetSyncHeartbeat(
        {
          userId: auth.user.id,
          deviceCredentialId: auth.credential.id
        },
        {
          relationshipId,
          sourceCursor: input.source_cursor,
          targetProcessingCursor: input.target_processing_cursor,
          packageSequence: input.package_sequence,
          staleAfterSeconds: context.config.crossIdentitySyncStaleAfterSeconds
        }
      );
      if (!accepted) {
        throw Object.assign(new Error("Active sync relationship not found"), {
          statusCode: 404
        });
      }
      return { accepted: true };
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
