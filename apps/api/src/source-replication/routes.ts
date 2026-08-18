import { createHash, randomBytes } from "node:crypto";
import {
  assertConversationSourceReplicationJsonlSegment,
  calculateConversationSourceDownloadRequestHash,
  calculateConversationSourceDownloadScopeHash,
  calculateConversationSourceDiscoveryRequestHash,
  calculateConversationSourceDiscoveryScopeHash,
  calculateConversationSourceGenerationRegistrationDigest,
  calculateConversationSourceReplicationContentDigest,
  calculateConversationSourceReplicationManifestDigest,
  calculateConversationSourceReplicationOperationDigest,
  createEncryptedJsonPackage,
  createRecipientPublicKeyEnvelopeEncryptionProvider,
  createRecipientPrivateKeyEnvelopeEncryptionProvider,
  decryptEnvelopeToUtf8,
  decryptEncryptedJsonPackage,
  CONVERSATION_SOURCE_DOWNLOAD_AUTHORIZATION_TTL_MS,
  parseConversationSourceOriginKeyRegistration,
  parseConversationSourceReplicationSourceDescriptor,
  parseConversationSourceReplicationSegmentEnvelope,
  parseSignedConversationSourceClosureManifest,
  calculateConversationSourceClosureDigest,
  calculateConversationSourceClosureOperationContentDigest,
  calculateConversationSourceSetClosureDigest,
  parseSignedConversationSourceSetClosureManifest,
  verifyConversationSourceReplicationManifestForAcceptance,
  type EncryptedJsonPackage,
  type EncryptedPayloadEnvelope,
  type RecipientPublicKeyMaterial
} from "@koed/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  readLocalEdgeUpstreamRegistry,
  resolveLocalEdgeRouteDecision,
  upstreamAdvertisesCapability,
  upstreamBackendById
} from "../local-edge/upstream-routing.js";
import {
  personalSourceReplicationPolicySchema,
  sourceClosurePayloadSchema,
  sourceDiscoverySchema,
  sourceDownloadAuthorizationParamsSchema,
  sourceDownloadAuthorizationSchema,
  sourceDownloadSegmentsQuerySchema,
  sourceGenerationParamsSchema,
  sourceGenerationRegistrationPayloadSchema,
  sourceReplicationIntakeContextSchema,
  sourceReplicationRecipientKeySchema,
  sourceReplicationUploadSchema,
  sourceSegmentPayloadSchema
} from "./schemas.js";
import { resolveSyncRecipientContext } from "../sync/recipient-context.js";
import { resolveConversationSourceDownloadMaterial } from "./download-material.js";

const hostedTargetProfiles = new Set([
  "private_vps",
  "team_self_hosted",
  "koed_managed_cloud"
]);
const localProfiles = new Set(["developer", "local_personal"]);
const intakeProfiles = new Set([...hostedTargetProfiles, ...localProfiles]);

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const sourceReplicationError = (
  message: string,
  statusCode: number
): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode });

const header = (request: FastifyRequest, name: string): string | null => {
  const value = request.headers[name];
  const selected = Array.isArray(value) ? value[0] : value;
  return typeof selected === "string" && selected.trim()
    ? selected.trim()
    : null;
};

const sourceDownloadCapability = (request: FastifyRequest): string => {
  const value = header(request, "x-koed-source-download-capability");
  if (!value || !/^csd_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw sourceReplicationError(
      "Source download authorization is invalid",
      403
    );
  }
  return value;
};

const authenticatedSyncDevice = async (
  request: FastifyRequest,
  context: ApiRouteContext
) => {
  const auth = await context.auth.authenticateDeviceCredential(request);
  if (!auth.credential.operationFamilies.includes("sync")) {
    throw sourceReplicationError(
      "Device credential is not allowed for source replication",
      403
    );
  }
  const deploymentId = auth.credential.metadata.protocolDeploymentId;
  if (
    typeof deploymentId !== "string" ||
    !z.string().uuid().safeParse(deploymentId).success
  ) {
    throw sourceReplicationError(
      "Device credential has no verified deployment identity",
      409
    );
  }
  return {
    ...auth,
    deploymentId,
    deviceId: auth.credential.deviceInstanceId
  };
};

const targetDecryption = async (
  context: ApiRouteContext,
  userId: string,
  encryptedPackage: EncryptedJsonPackage
) => {
  if (!intakeProfiles.has(context.config.deploymentProfile)) {
    throw sourceReplicationError(
      "Source replication intake is unavailable",
      404
    );
  }
  const root = context.encryption.envelopeEncryptionProvider;
  if (!root) {
    throw sourceReplicationError(
      "Envelope encryption is required for source replication",
      503
    );
  }
  const identity = context.deploymentIdentity.inspect();
  if (identity.health !== "healthy" || !identity.deploymentId) {
    throw sourceReplicationError(
      "Target deployment identity is unavailable",
      503
    );
  }
  if (
    encryptedPackage.envelope.scope.deploymentId !== identity.deploymentId ||
    encryptedPackage.envelope.scope.tenantId !== userId ||
    encryptedPackage.envelope.aad.targetDeploymentId !== identity.deploymentId
  ) {
    throw sourceReplicationError(
      "Source replication target binding is invalid",
      403
    );
  }
  const repository = context.requireRepository();
  const deployment = await repository.ensureLocalSyncDeployment({
    profile: context.config.deploymentProfile,
    protocolDeploymentId: identity.deploymentId
  });
  const recipient = await repository.getSyncRecipientKey(
    deployment.id,
    encryptedPackage.envelope.keyId,
    encryptedPackage.envelope.keyVersion
  );
  if (!recipient) {
    throw sourceReplicationError(
      "Source replication recipient key is unavailable",
      409
    );
  }
  const provider = await createRecipientPrivateKeyEnvelopeEncryptionProvider(
    root,
    recipient
  );
  return {
    identity,
    root,
    payload: await decryptEncryptedJsonPackage<unknown>(
      provider,
      encryptedPackage
    )
  };
};

export const registerConversationSourceReplicationRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/conversation-source-replication/intake/context",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const auth = await authenticatedSyncDevice(request, context);
      sourceReplicationIntakeContextSchema.parse(request.body);
      const target = await resolveSyncRecipientContext(context, intakeProfiles);
      return {
        target_deployment_id: target.localDeployment.protocolDeploymentId,
        target_deployment_profile: target.localDeployment.profile,
        target_user_id: auth.user.id,
        recipient_key: target.publicRecipient
      };
    }
  );

  app.get(
    "/v1/personal-source-replication/policy",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw sourceReplicationError(
          "Personal source replication policy is local-only",
          404
        );
      }
      const user = await context.auth.authenticateSession(request);
      return {
        policy: await context
          .requireRepository()
          .getPersonalSourceReplicationPolicy({ userId: user.id })
      };
    }
  );

  app.put(
    "/v1/personal-source-replication/policy",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw sourceReplicationError(
          "Personal source replication policy is local-only",
          404
        );
      }
      const user = await context.auth.authenticateSession(request);
      const input = personalSourceReplicationPolicySchema.parse(request.body);
      let enabledMode: "hosted_personal" | "peer_personal" = "hosted_personal";
      if (input.enabled) {
        const registry = readLocalEdgeUpstreamRegistry(
          context.localEdge.upstreamBackendsPath
        );
        const target = upstreamBackendById(registry, input.targetUpstreamId);
        const authorization = target
          ? context.localEdge.resolveUpstreamAuthorization(target)
          : null;
        const decision = resolveLocalEdgeRouteDecision({
          operationFamily: "sync",
          upstreamBackend: target,
          upstreamBackendId: input.targetUpstreamId,
          upstreamCredentialAvailable: Boolean(authorization),
          identityRemoteOperationsAllowed:
            context.localEdge.remoteOperationsAllowed()
        });
        if (
          !target ||
          decision.action !== "queued_sync_handoff" ||
          !upstreamAdvertisesCapability(
            target,
            "memory.conversationSourceReplication"
          )
        ) {
          throw sourceReplicationError(
            "Selected source replication backend is not enrolled for sync",
            409
          );
        }
        enabledMode = localProfiles.has(target.profile ?? "")
          ? "peer_personal"
          : "hosted_personal";
      }
      return {
        policy: await context
          .requireRepository()
          .upsertPersonalSourceReplicationPolicy(
            { userId: user.id },
            input.enabled
              ? {
                  enabled: true,
                  targetUpstreamId: input.targetUpstreamId,
                  mode: enabledMode,
                  effectiveFrom: new Date().toISOString()
                }
              : { enabled: false, mode: "hosted_personal" }
          )
      };
    }
  );

  app.post(
    "/v1/conversation-source-replication/sources/discover",
    { preHandler: context.rateLimit.memoryRead },
    async (request, reply) => {
      if (!intakeProfiles.has(context.config.deploymentProfile)) {
        throw sourceReplicationError("Source discovery is unavailable", 404);
      }
      const auth = await authenticatedSyncDevice(request, context);
      const actionGrant = header(request, "x-koed-action-grant");
      if (!actionGrant) {
        throw sourceReplicationError(
          "Exact source discovery grant is required",
          403
        );
      }
      const input = sourceDiscoverySchema.parse(request.body);
      const repository = context.requireRepository();
      const replicaRoles = localProfiles.has(context.config.deploymentProfile)
        ? (["origin_local", "peer_personal"] as const)
        : (["hosted_personal"] as const);
      const result = await repository.executeActionGrant({
        actionGrant,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId,
        teamId: null,
        operationFamily: "source_download",
        action: "conversation_source.discover",
        targetId: null,
        scopeHash: calculateConversationSourceDiscoveryScopeHash(),
        requestHash: calculateConversationSourceDiscoveryRequestHash(input),
        execute: async ({ sourceJournal }) => {
          const page =
            await sourceJournal.listConversationSourceArtifactsForServing(
              { userId: auth.user.id },
              {
                replicaRoles: [...replicaRoles],
                cursor: input.cursor ?? undefined,
                limit: input.limit
              }
            );
          return {
            statusCode: 200,
            body: {
              sources: page.artifacts.map((artifact) => ({
                sourceGenerationId: artifact.sourceGenerationId,
                redactedSourceLabel: artifact.redactedSourceLabel,
                sourceRuntime: artifact.sourceRuntime,
                sourceComponentId: artifact.sourceComponentId,
                sourceCreatedAt: artifact.sourceCreatedAt,
                sourceModifiedAt: artifact.sourceModifiedAt,
                currentSourceLength: artifact.currentSourceLength,
                segmentCount: artifact.currentJournalSequence + 1
              })),
              nextCursor: page.nextCursor
            }
          };
        }
      });
      if (!result) {
        throw sourceReplicationError(
          "Source discovery authorization is invalid",
          403
        );
      }
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.post(
    "/v1/conversation-source-replication/download-authorizations",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      if (!intakeProfiles.has(context.config.deploymentProfile)) {
        throw sourceReplicationError("Source download is unavailable", 404);
      }
      const auth = await authenticatedSyncDevice(request, context);
      const actionGrant = header(request, "x-koed-action-grant");
      if (!actionGrant) {
        throw sourceReplicationError(
          "Exact source download grant is required",
          403
        );
      }
      const input = sourceDownloadAuthorizationSchema.parse(request.body);
      createRecipientPublicKeyEnvelopeEncryptionProvider(
        input.recipientKey as RecipientPublicKeyMaterial
      );
      const repository = context.requireRepository();
      const allowedReplicaRoles = localProfiles.has(
        context.config.deploymentProfile
      )
        ? new Set(["origin_local", "peer_personal"])
        : new Set(["hosted_personal"]);
      const { artifact, registration, source, sourceClosure } =
        await resolveConversationSourceDownloadMaterial({
          repository,
          ownerUserId: auth.user.id,
          sourceGenerationId: input.sourceGenerationId,
          sourceComponentId: input.sourceComponentId,
          allowedReplicaRoles
        });
      const capability = `csd_${randomBytes(32).toString("base64url")}`;
      const result = await repository.executeActionGrant({
        actionGrant,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId,
        teamId: null,
        operationFamily: "source_download",
        action: "conversation_source.download",
        targetId: artifact.id,
        scopeHash: calculateConversationSourceDownloadScopeHash(input),
        requestHash: calculateConversationSourceDownloadRequestHash(input),
        execute: async ({ sourceJournal }) => {
          const authorization =
            await sourceJournal.createConversationSourceDownloadAuthorization(
              { userId: auth.user.id },
              {
                deviceCredentialId: auth.credential.id,
                artifactId: artifact.id,
                recipientKey: {
                  targetDeploymentId: input.targetDeploymentId,
                  key: input.recipientKey
                },
                capabilityHash: sha256(capability),
                firstSegmentIndex: input.firstSegmentIndex,
                expiresAt: new Date(
                  Date.now() + CONVERSATION_SOURCE_DOWNLOAD_AUTHORIZATION_TTL_MS
                ).toISOString()
              }
            );
          return {
            statusCode: 201,
            body: {
              authorizationId: authorization.id,
              capability,
              sourceGenerationId: input.sourceGenerationId,
              sourceComponentId: input.sourceComponentId,
              firstSegmentIndex: authorization.firstSegmentIndex,
              lastSegmentIndex: authorization.lastSegmentIndex,
              expiresAt: authorization.expiresAt,
              registration,
              source,
              sourceClosure
            }
          };
        }
      });
      if (!result) {
        throw sourceReplicationError(
          "Source download authorization is invalid",
          403
        );
      }
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.get(
    "/v1/conversation-source-replication/download-authorizations/:authorizationId/segments",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!intakeProfiles.has(context.config.deploymentProfile)) {
        throw sourceReplicationError("Source download is unavailable", 404);
      }
      const auth = await authenticatedSyncDevice(request, context);
      const { authorizationId } = sourceDownloadAuthorizationParamsSchema.parse(
        request.params
      );
      const query = sourceDownloadSegmentsQuerySchema.parse(request.query);
      const capability = sourceDownloadCapability(request);
      const repository = context.requireRepository();
      const authorization =
        await repository.getConversationSourceDownloadAuthorization(
          { userId: auth.user.id },
          {
            authorizationId,
            deviceCredentialId: auth.credential.id,
            capabilityHash: sha256(capability)
          }
        );
      if (!authorization) {
        throw sourceReplicationError(
          "Source download authorization is invalid",
          403
        );
      }
      if (
        query.afterSegmentIndex < authorization.firstSegmentIndex - 1 ||
        query.afterSegmentIndex > authorization.lastSegmentIndex
      ) {
        throw sourceReplicationError(
          "Source download cursor is outside its grant",
          409
        );
      }
      const binding = authorization.recipientKey;
      const targetDeploymentId = binding.targetDeploymentId;
      const recipientKey = binding.key;
      if (
        typeof targetDeploymentId !== "string" ||
        !recipientKey ||
        typeof recipientKey !== "object" ||
        Array.isArray(recipientKey)
      ) {
        throw sourceReplicationError(
          "Source download recipient binding is invalid",
          409
        );
      }
      const parsedRecipient =
        sourceReplicationRecipientKeySchema.parse(recipientKey);
      const recipientProvider =
        createRecipientPublicKeyEnvelopeEncryptionProvider(parsedRecipient);
      const root = context.encryption.envelopeEncryptionProvider;
      if (!root) {
        throw sourceReplicationError(
          "Envelope encryption is required for source download",
          503
        );
      }
      const segments = await repository.listConversationSourceSegmentsByIndex(
        { userId: auth.user.id },
        {
          artifactId: authorization.artifactId,
          afterSegmentIndex: query.afterSegmentIndex,
          throughSegmentIndex: authorization.lastSegmentIndex,
          limit: query.limit
        }
      );
      const packages = [];
      for (const segment of segments) {
        if (!segment.encryptionEnvelope) {
          throw sourceReplicationError(
            "Source segment encryption envelope is unavailable",
            409
          );
        }
        const sourcePayload = JSON.parse(
          await decryptEnvelopeToUtf8(
            root,
            segment.encryptionEnvelope as unknown as EncryptedPayloadEnvelope
          )
        ) as unknown;
        const verifiedPayload =
          parseConversationSourceReplicationSegmentEnvelope(sourcePayload);
        packages.push({
          segmentIndex: segment.segmentIndex,
          encryptedPackage: await createEncryptedJsonPackage(
            recipientProvider,
            {
              objectClass: "sync_package",
              payload: {
                protocol: verifiedPayload.signedManifest.manifest.protocol,
                operation: "download_segment",
                segment: verifiedPayload
              },
              scope: {
                deploymentId: targetDeploymentId,
                tenantId: auth.user.id
              },
              provenance: {
                rowFamily: "conversation_source_download",
                sourceId: authorization.id
              },
              ciphertextLocation:
                "conversation_source_replication.download_payload",
              aad: {
                authorizationId: authorization.id,
                segmentIndex: segment.segmentIndex,
                targetDeploymentId
              },
              metadata: {
                operationKind: "download_segment",
                protocol: verifiedPayload.signedManifest.manifest.protocol
              }
            }
          )
        });
      }
      await repository.touchConversationSourceDownloadAuthorization(
        { userId: auth.user.id },
        authorization.id
      );
      const nextSegmentIndex =
        segments.at(-1)?.segmentIndex ?? query.afterSegmentIndex;
      return {
        authorizationId,
        packages,
        nextSegmentIndex,
        complete: nextSegmentIndex >= authorization.lastSegmentIndex
      };
    }
  );

  app.post(
    "/v1/conversation-source-replication/generations",
    {
      preHandler: context.rateLimit.memoryWrite,
      bodyLimit: 24 * 1024 * 1024
    },
    async (request) => {
      const auth = await authenticatedSyncDevice(request, context);
      const input = sourceReplicationUploadSchema.parse(request.body);
      if (
        input.encryptedPackage.envelope.aad.operationKind !==
        "register_generation"
      ) {
        throw sourceReplicationError(
          "Source replication operation kind is invalid",
          400
        );
      }
      const decrypted = await targetDecryption(
        context,
        auth.user.id,
        input.encryptedPackage
      );
      const payload = sourceGenerationRegistrationPayloadSchema.parse(
        decrypted.payload
      );
      const registration = parseConversationSourceOriginKeyRegistration(
        payload.registration
      );
      const source = parseConversationSourceReplicationSourceDescriptor(
        payload.source
      );
      if (registration.lifecycle !== "active") {
        throw sourceReplicationError(
          "A new source generation requires an active origin key",
          409
        );
      }
      const expectedDigest =
        calculateConversationSourceReplicationOperationDigest({
          operationId: input.operationId,
          operationKind: "register_generation",
          logicalSourceId: registration.logicalSourceId,
          sourceGenerationId: registration.sourceGenerationId,
          contentDigest:
            calculateConversationSourceGenerationRegistrationDigest(
              registration,
              source
            ),
          targetDeploymentId: decrypted.identity.deploymentId!
        });
      if (input.requestDigest !== expectedDigest) {
        throw sourceReplicationError(
          "Source replication request digest is invalid",
          409
        );
      }
      const repository = context.requireRepository();
      const targetExternalSessionId = registration.logicalSourceId;
      const session = await repository.createCapturedSession(
        { userId: auth.user.id },
        {
          logicalSessionId: source.logicalSessionId,
          externalSessionId: targetExternalSessionId,
          sourceRuntime: source.sourceRuntime,
          captureMethod: "transcript",
          sourceKind: source.sourceKind,
          sourceAdapterVersion: source.sourceAdapterVersion,
          sourceFingerprint: source.sourceFingerprint,
          idempotencyKey: `hosted-source:${registration.logicalSourceId}:${registration.sourceGenerationId}`,
          sourceHash: `hosted-source:${registration.sourceGenerationId}`,
          ...(source.project ? { projectId: source.project.id } : {}),
          metadata: {
            sourceReplication: {
              protocol: registration.protocol,
              logicalSourceId: registration.logicalSourceId,
              sourceGenerationId: registration.sourceGenerationId
            }
          }
        }
      );
      const artifact =
        await repository.registerConversationSourceReplicaGeneration(
          { userId: auth.user.id },
          {
            sessionId: session.id,
            logicalSourceId: registration.logicalSourceId,
            sourceGenerationId: registration.sourceGenerationId,
            replicaRole: localProfiles.has(context.config.deploymentProfile)
              ? "peer_personal"
              : "hosted_personal",
            sourceKind: source.sourceKind,
            sourceComponentId: source.sourceComponentId,
            sourceComponentRole: source.sourceComponentRole,
            parentSourceComponentId: source.parentSourceComponentId,
            contentFraming: source.contentFraming,
            sourceRuntime: source.sourceRuntime,
            externalSessionId: targetExternalSessionId,
            sourceFingerprint: source.sourceFingerprint,
            artifactFormat: source.artifactFormat,
            artifactFormatVersion: source.artifactFormatVersion,
            sourceAdapterVersion: source.sourceAdapterVersion,
            journalStartOffset: source.journalStartOffset,
            journalStartLine: source.journalStartLine,
            liveStartOffset: source.liveStartOffset,
            liveStartLine: source.liveStartLine,
            currentSourceLength: Math.max(
              source.journalStartOffset,
              source.liveStartOffset
            ),
            sourceCreatedAt: registration.sourceCreatedAt,
            storageProvider: "envelope_db",
            storagePrefix: `${registration.logicalSourceId}/${registration.sourceGenerationId}/${source.sourceComponentId}`,
            originDeploymentId: source.originDeploymentId,
            originDeviceId: source.originDeviceId,
            originKeyId: registration.originKeyId,
            originPublicKey: registration.publicKey,
            ...(registration.priorGenerationClosure
              ? {
                  priorGenerationClosure:
                    registration.priorGenerationClosure as unknown as Record<
                      string,
                      unknown
                    >
                }
              : {}),
            redactedSourceLabel: source.redactedSourceLabel
          }
        );
      await repository.releaseManagedConversationCommandsForSourceGeneration({
        ownerUserId: auth.user.id,
        sourceGenerationId: registration.sourceGenerationId,
        targetDeploymentId: auth.deploymentId,
        targetDeviceId: auth.deviceId,
        readiness: "registered"
      });
      return {
        logicalSourceId: artifact.logicalSourceId,
        sourceGenerationId: artifact.sourceGenerationId,
        acceptedSegmentIndex: artifact.currentJournalSequence
      };
    }
  );

  app.post(
    "/v1/conversation-source-replication/generations/:sourceGenerationId/segments",
    {
      preHandler: context.rateLimit.memoryWrite,
      bodyLimit: 24 * 1024 * 1024
    },
    async (request) => {
      const auth = await authenticatedSyncDevice(request, context);
      const { sourceGenerationId } = sourceGenerationParamsSchema.parse(
        request.params
      );
      const input = sourceReplicationUploadSchema.parse(request.body);
      if (
        input.encryptedPackage.envelope.aad.operationKind !== "append_segment"
      ) {
        throw sourceReplicationError(
          "Source replication operation kind is invalid",
          400
        );
      }
      const decrypted = await targetDecryption(
        context,
        auth.user.id,
        input.encryptedPackage
      );
      const payload = sourceSegmentPayloadSchema.parse(decrypted.payload);
      const segment = parseConversationSourceReplicationSegmentEnvelope(
        payload.segment
      );
      const { manifest } = segment.signedManifest;
      if (manifest.sourceGenerationId !== sourceGenerationId) {
        throw sourceReplicationError(
          "Source generation route binding is invalid",
          409
        );
      }
      const expectedRequestDigest =
        calculateConversationSourceReplicationOperationDigest({
          operationId: input.operationId,
          operationKind: "append_segment",
          logicalSourceId: manifest.logicalSourceId,
          sourceGenerationId: manifest.sourceGenerationId,
          contentDigest: calculateConversationSourceReplicationContentDigest(
            segment.signedManifest
          ),
          targetDeploymentId: decrypted.identity.deploymentId!
        });
      if (input.requestDigest !== expectedRequestDigest) {
        throw sourceReplicationError(
          "Source replication request digest is invalid",
          409
        );
      }
      const repository = context.requireRepository();
      const artifact = await repository.getConversationSourceArtifactByIdentity(
        { userId: auth.user.id },
        {
          logicalSourceId: manifest.logicalSourceId,
          sourceGenerationId,
          sourceComponentId: manifest.sourceComponentId
        }
      );
      const expectedReplicaRole = localProfiles.has(
        context.config.deploymentProfile
      )
        ? "peer_personal"
        : "hosted_personal";
      if (!artifact || artifact.replicaRole !== expectedReplicaRole) {
        throw sourceReplicationError(
          "Source replica generation is not registered",
          404
        );
      }
      if (
        !verifyConversationSourceReplicationManifestForAcceptance(
          segment.signedManifest,
          {
            protocol: manifest.protocol,
            logicalSourceId: artifact.logicalSourceId,
            sourceGenerationId: artifact.sourceGenerationId,
            originKeyId: artifact.originKeyId,
            publicKey: artifact.originPublicKey,
            lifecycle: artifact.originKeyStatus,
            sourceCreatedAt: artifact.sourceCreatedAt,
            priorGenerationClosure:
              artifact.priorGenerationClosure as typeof manifest.priorGenerationClosure
          }
        )
      ) {
        throw sourceReplicationError(
          "Source replication origin signature is invalid",
          409
        );
      }
      const bytes = Buffer.from(segment.plaintextBytes, "base64url");
      try {
        assertConversationSourceReplicationJsonlSegment(
          bytes,
          manifest.endItemCursor - manifest.startItemCursor
        );
      } catch {
        throw sourceReplicationError(
          "Conversation source segment JSONL is invalid",
          400
        );
      }
      const contentDigest = calculateConversationSourceReplicationContentDigest(
        segment.signedManifest
      );
      const atRestEnvelope = await decrypted.root.encrypt({
        plaintext: JSON.stringify(segment),
        scope: {
          tenantId: auth.user.id,
          objectClass: "conversation_source_segment"
        },
        provenance: {
          rowFamily: "conversation_source_segments",
          sourceId: `${artifact.id}:${manifest.segmentIndex}`
        },
        ciphertextLocation: "conversation_source_segments.encryption_envelope",
        aad: {
          ownerUserId: auth.user.id,
          logicalSourceId: manifest.logicalSourceId,
          sourceGenerationId,
          segmentIndex: manifest.segmentIndex,
          contentDigest
        }
      });
      const acceptance =
        await repository.acceptConversationSourceReplicaSegment(
          { userId: auth.user.id },
          {
            artifactId: artifact.id,
            segmentIndex: manifest.segmentIndex,
            sourceStartOffset: manifest.startByteCursor,
            sourceEndOffset: manifest.endByteCursor,
            sourceStartLine: manifest.startItemCursor,
            sourceEndLine: manifest.endItemCursor,
            plaintextDigest: manifest.plaintextDigest,
            ciphertextDigest: sha256(
              Buffer.from(atRestEnvelope.ciphertext, "base64")
            ),
            plaintextSize: bytes.byteLength,
            storedSize: Buffer.byteLength(
              JSON.stringify(atRestEnvelope),
              "utf8"
            ),
            storageKey: `${manifest.logicalSourceId}/${sourceGenerationId}/${manifest.segmentIndex}`,
            storageProvider: "envelope_db",
            encryptionEnvelope: atRestEnvelope as unknown as Record<
              string,
              unknown
            >,
            signedManifest: { ...manifest },
            originSignature: segment.signedManifest.signature,
            manifestDigest:
              calculateConversationSourceReplicationManifestDigest(manifest),
            previousContentDigest: manifest.previousContentDigest,
            contentDigest,
            currentSourceLength: manifest.endByteCursor
          }
        );
      return acceptance;
    }
  );

  app.post(
    "/v1/conversation-source-replication/generations/:sourceGenerationId/closure",
    {
      preHandler: context.rateLimit.memoryWrite,
      bodyLimit: 1024 * 1024
    },
    async (request) => {
      const auth = await authenticatedSyncDevice(request, context);
      const { sourceGenerationId } = sourceGenerationParamsSchema.parse(
        request.params
      );
      const input = sourceReplicationUploadSchema.parse(request.body);
      if (
        input.encryptedPackage.envelope.aad.operationKind !== "close_generation"
      ) {
        throw sourceReplicationError(
          "Source replication operation kind is invalid",
          400
        );
      }
      const decrypted = await targetDecryption(
        context,
        auth.user.id,
        input.encryptedPackage
      );
      const payload = sourceClosurePayloadSchema.parse(decrypted.payload);
      const closure = parseSignedConversationSourceClosureManifest(
        payload.closure
      );
      const sourceSetClosure = payload.sourceSetClosure
        ? parseSignedConversationSourceSetClosureManifest(
            payload.sourceSetClosure
          )
        : null;
      if (closure.manifest.sourceGenerationId !== sourceGenerationId) {
        throw sourceReplicationError(
          "Source generation route binding is invalid",
          409
        );
      }
      const closureDigest = calculateConversationSourceClosureDigest(closure);
      const sourceSetClosureDigest = sourceSetClosure
        ? calculateConversationSourceSetClosureDigest(sourceSetClosure)
        : null;
      if (
        (closure.manifest.sourceComponentId === "main") !==
        (sourceSetClosure !== null)
      ) {
        throw sourceReplicationError(
          "Source-set closure binding is invalid",
          409
        );
      }
      const expectedRequestDigest =
        calculateConversationSourceReplicationOperationDigest({
          operationId: input.operationId,
          operationKind: "close_generation",
          logicalSourceId: closure.manifest.logicalSourceId,
          sourceGenerationId,
          contentDigest:
            calculateConversationSourceClosureOperationContentDigest(
              closureDigest,
              sourceSetClosureDigest
            ),
          targetDeploymentId: decrypted.identity.deploymentId!
        });
      if (input.requestDigest !== expectedRequestDigest) {
        throw sourceReplicationError(
          "Source replication request digest is invalid",
          409
        );
      }
      const repository = context.requireRepository();
      const artifact = await repository.getConversationSourceArtifactByIdentity(
        { userId: auth.user.id },
        {
          logicalSourceId: closure.manifest.logicalSourceId,
          sourceGenerationId,
          sourceComponentId: closure.manifest.sourceComponentId
        }
      );
      const expectedReplicaRole = localProfiles.has(
        context.config.deploymentProfile
      )
        ? "peer_personal"
        : "hosted_personal";
      if (!artifact || artifact.replicaRole !== expectedReplicaRole) {
        throw sourceReplicationError(
          "Source replica generation is not registered",
          404
        );
      }
      const finalized = await repository.finalizeConversationSourceArtifact(
        { userId: auth.user.id },
        { artifactId: artifact.id, signedClosure: closure }
      );
      if (sourceSetClosure) {
        await repository.finalizeConversationSourceSet(
          { userId: auth.user.id },
          { sourceGenerationId, signedClosure: sourceSetClosure }
        );
        await repository.releaseManagedConversationCommandsForSourceGeneration({
          ownerUserId: auth.user.id,
          sourceGenerationId,
          targetDeploymentId: auth.deploymentId,
          targetDeviceId: auth.deviceId,
          readiness: "finalized"
        });
      }
      return {
        status: finalized.replayed ? "replayed" : "accepted",
        closureHash: finalized.artifact.closureHash
      };
    }
  );
};
