import { randomUUID } from "node:crypto";

import {
  fetchBoundedJsonObject,
  parseConversationSourceOriginKeyRegistration,
  parseConversationSourceReplicationSourceDescriptor,
  parseSignedConversationSourceClosureManifest,
  readCollaborationActionGrantCustodyCommitmentHash,
  resolveCollaborationActionGrantSecret,
  storeCollaborationActionGrantCustody,
  updateCollaborationActionGrantCustodyStatus
} from "@koed/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { highRiskActionGrantRemoteEnvelopeSchema } from "../high-risk/action-grant-protocol.js";
import {
  readLocalEdgeUpstreamRegistry,
  safeUpstreamProxyUrl,
  upstreamAdvertisesCapability,
  upstreamBackendById
} from "../local-edge/upstream-routing.js";
import type { ApiRouteContext } from "../server/context.js";
import { resolveSyncRecipientContext } from "../sync/recipient-context.js";
import {
  sourceDiscoveryResultItemSchema,
  sourceDiscoverySchema
} from "./schemas.js";

const localProfiles = new Set(["developer", "local_personal"]);
const maximumResponseBytes = 24 * 1024 * 1024;
const requestTimeoutMs = 30_000;

const startRestoreSchema = z
  .object({
    upstreamBackendId: z.string().trim().min(1).max(160),
    sourceGenerationId: z.uuid(),
    firstSegmentIndex: z.number().int().safe().nonnegative().default(0)
  })
  .strict();
const restoreParamsSchema = z.object({ restoreJobId: z.uuid() }).strict();
const discoveryControlSchema = sourceDiscoverySchema
  .extend({
    upstreamBackendId: z.string().trim().min(1).max(160),
    requestId: z.uuid()
  })
  .strict();

const statusError = (
  message: string,
  statusCode: number
): Error & { statusCode: number } =>
  Object.assign(new Error(message), { statusCode });

const remoteRequest = async (
  context: ApiRouteContext,
  backend: Parameters<typeof safeUpstreamProxyUrl>[0],
  authorization: string,
  input: {
    method: "POST" | "GET" | "DELETE";
    path: string;
    body?: Record<string, unknown>;
    actionGrant?: string;
  }
) => {
  const { response, payload } = await fetchBoundedJsonObject(
    context.localEdge.fetch,
    safeUpstreamProxyUrl(backend, input.path),
    {
      method: input.method,
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization,
        ...(input.body ? { "content-type": "application/json" } : {}),
        ...(input.actionGrant
          ? { "x-koed-action-grant": input.actionGrant }
          : {})
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {})
    },
    {
      timeoutMs: requestTimeoutMs,
      maxBytes: maximumResponseBytes,
      readErrorBody: true
    }
  );
  if (!response.ok) {
    throw statusError(
      response.status === 401 || response.status === 403
        ? "Source restore authorization was rejected"
        : response.status === 409
          ? "Source restore state conflicted"
          : "Source restore backend is unavailable",
      response.status >= 400 && response.status < 600 ? response.status : 503
    );
  }
  return payload;
};

const publicRestore = (job: {
  id: string;
  upstreamBackendId: string;
  sourceGenerationId: string;
  state: string;
  nextSegmentIndex: number;
  lastSegmentIndex: number | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}) => ({
  id: job.id,
  upstreamBackendId: job.upstreamBackendId,
  sourceGenerationId: job.sourceGenerationId,
  state: job.state,
  nextSegmentIndex: job.nextSegmentIndex,
  lastSegmentIndex: job.lastSegmentIndex,
  lastErrorCode: job.lastErrorCode,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  completedAt: job.completedAt
});

export const registerConversationSourceRestoreRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  app.post(
    "/v1/personal-source-replication/discovery",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw statusError("Source discovery control is local-only", 404);
      }
      const user = await context.auth.authenticate(request);
      const input = discoveryControlSchema.parse(request.body);
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const backend = upstreamBackendById(registry, input.upstreamBackendId);
      const authorization = backend
        ? context.localEdge.resolveUpstreamAuthorization(backend)
        : null;
      const enrollment = backend
        ? context.localEdge.resolveUpstreamEnrollmentBinding(backend.id)
        : null;
      if (
        !backend ||
        backend.routePolicy.sync !== "enabled" ||
        !upstreamAdvertisesCapability(
          backend,
          "memory.conversationSourceReplication"
        ) ||
        !authorization ||
        !enrollment
      ) {
        throw statusError(
          "Source replication backend is not enrolled for discovery",
          409
        );
      }
      const body = { cursor: input.cursor, limit: input.limit };
      const custodyAccess = {
        referenceId: input.requestId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId
      };
      let commitmentHash = readCollaborationActionGrantCustodyCommitmentHash(
        context.config.koedHome,
        custodyAccess
      );
      if (!commitmentHash) {
        commitmentHash = storeCollaborationActionGrantCustody(
          context.config.koedHome,
          {
            ...custodyAccess,
            operationFamily: "source_download",
            action: "conversation_source.discover",
            teamId: null,
            targetId: null,
            method: "POST",
            path: "/v1/conversation-source-replication/sources/discover",
            body,
            idempotencyKey: input.requestId,
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
          }
        ).commitmentHash;
      }
      const remote = highRiskActionGrantRemoteEnvelopeSchema.parse(
        await remoteRequest(context, backend, authorization, {
          method: "POST",
          path: "/v1/high-risk/action-grants",
          body: {
            version: 1,
            clientRequestId: input.requestId,
            grantCommitment: `v1:${commitmentHash}`,
            intent: {
              action: "conversation_source.discover",
              body
            }
          }
        })
      );
      if (remote.status.actionGrant.id !== input.requestId) {
        throw statusError("Source discovery grant identity is invalid", 503);
      }
      const activationUrl = remote.status.activationPath
        ? safeUpstreamProxyUrl(backend, remote.status.activationPath).toString()
        : null;
      updateCollaborationActionGrantCustodyStatus(
        context.config.koedHome,
        remote.status.state === "approved"
          ? {
              ...custodyAccess,
              state: "approved",
              expiresAt: remote.status.expiresAt
            }
          : {
              ...custodyAccess,
              state: "pending",
              activationUrl,
              expiresAt: remote.status.expiresAt
            }
      );
      return reply.status(202).send({
        requestId: input.requestId,
        approvalState: remote.status.state,
        activationUrl
      });
    }
  );

  app.post(
    "/v1/personal-source-replication/discovery/complete",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw statusError("Source discovery control is local-only", 404);
      }
      const user = await context.auth.authenticate(request);
      const input = discoveryControlSchema.parse(request.body);
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const backend = upstreamBackendById(registry, input.upstreamBackendId);
      const authorization = backend
        ? context.localEdge.resolveUpstreamAuthorization(backend)
        : null;
      const enrollment = backend
        ? context.localEdge.resolveUpstreamEnrollmentBinding(backend.id)
        : null;
      if (!backend || !authorization || !enrollment) {
        throw statusError("Source discovery backend is unavailable", 409);
      }
      const body = { cursor: input.cursor, limit: input.limit };
      const custodyAccess = {
        referenceId: input.requestId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId
      };
      const status = highRiskActionGrantRemoteEnvelopeSchema.parse(
        await remoteRequest(context, backend, authorization, {
          method: "GET",
          path: `/v1/high-risk/action-grants/${encodeURIComponent(input.requestId)}`
        })
      ).status;
      if (status.state !== "approved") {
        return {
          requestId: input.requestId,
          approvalState: status.state,
          activationUrl: status.activationPath
            ? safeUpstreamProxyUrl(backend, status.activationPath).toString()
            : null
        };
      }
      updateCollaborationActionGrantCustodyStatus(context.config.koedHome, {
        ...custodyAccess,
        state: "approved",
        expiresAt: status.expiresAt
      });
      const grant = resolveCollaborationActionGrantSecret(
        context.config.koedHome,
        {
          ...custodyAccess,
          operationFamily: "source_download",
          action: "conversation_source.discover",
          teamId: null,
          targetId: null,
          method: "POST",
          path: "/v1/conversation-source-replication/sources/discover",
          body,
          idempotencyKey: input.requestId
        }
      );
      if (!grant) {
        throw statusError("Source discovery grant is unavailable", 409);
      }
      const result = await remoteRequest(context, backend, authorization, {
        method: "POST",
        path: "/v1/conversation-source-replication/sources/discover",
        body,
        actionGrant: grant
      });
      updateCollaborationActionGrantCustodyStatus(context.config.koedHome, {
        ...custodyAccess,
        state: "consumed"
      });
      return {
        requestId: input.requestId,
        approvalState: "consumed",
        sources: z
          .array(z.unknown())
          .max(input.limit)
          .parse(result.sources)
          .map((source) => sourceDiscoveryResultItemSchema.parse(source)),
        nextCursor: sourceDiscoverySchema.shape.cursor.parse(
          result.nextCursor ?? null
        )
      };
    }
  );

  app.post(
    "/v1/personal-source-replication/restores",
    { preHandler: context.rateLimit.memoryWrite },
    async (request, reply) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw statusError("Source restore control is local-only", 404);
      }
      const user = await context.auth.authenticate(request);
      const input = startRestoreSchema.parse(request.body);
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const backend = upstreamBackendById(registry, input.upstreamBackendId);
      const authorization = backend
        ? context.localEdge.resolveUpstreamAuthorization(backend)
        : null;
      const enrollment = backend
        ? context.localEdge.resolveUpstreamEnrollmentBinding(backend.id)
        : null;
      if (
        !backend ||
        backend.routePolicy.sync !== "enabled" ||
        !upstreamAdvertisesCapability(
          backend,
          "memory.conversationSourceReplication"
        ) ||
        !authorization ||
        !enrollment
      ) {
        throw statusError(
          "Source replication backend is not enrolled for restore",
          409
        );
      }
      const recipient = await resolveSyncRecipientContext(
        context,
        localProfiles
      );
      const referenceId = randomUUID();
      const repository = context.requireRepository();
      const job = await repository.createConversationSourceRestoreJob(
        { userId: user.id },
        {
          upstreamBackendId: backend.id,
          sourceGenerationId: input.sourceGenerationId,
          targetDeploymentId: recipient.localDeployment.protocolDeploymentId,
          recipientKeyId: recipient.publicRecipient.keyId,
          recipientKeyVersion: recipient.publicRecipient.keyVersion,
          actionGrantId: referenceId,
          firstSegmentIndex: input.firstSegmentIndex
        }
      );
      if (job.state !== "awaiting_approval") {
        return reply.status(200).send({
          restore: publicRestore(job),
          activationUrl: null,
          approvalState: "consumed"
        });
      }
      const selectedRecipient =
        job.recipientKeyId === recipient.publicRecipient.keyId &&
        job.recipientKeyVersion === recipient.publicRecipient.keyVersion
          ? recipient.publicRecipient
          : await repository.getSyncRecipientKey(
              recipient.localDeployment.id,
              job.recipientKeyId,
              job.recipientKeyVersion
            );
      if (!selectedRecipient) {
        throw statusError("Source restore recipient key is unavailable", 409);
      }
      const body = {
        sourceGenerationId: job.sourceGenerationId,
        targetDeploymentId: job.targetDeploymentId,
        firstSegmentIndex: job.nextSegmentIndex,
        recipientKey: {
          algorithm: selectedRecipient.algorithm,
          keyId: selectedRecipient.keyId,
          keyVersion: selectedRecipient.keyVersion,
          publicJwk: selectedRecipient.publicJwk
        }
      };
      const custodyAccess = {
        referenceId: job.actionGrantId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId
      };
      let commitmentHash = readCollaborationActionGrantCustodyCommitmentHash(
        context.config.koedHome,
        custodyAccess
      );
      if (!commitmentHash) {
        commitmentHash = storeCollaborationActionGrantCustody(
          context.config.koedHome,
          {
            ...custodyAccess,
            operationFamily: "source_download",
            action: "conversation_source.download",
            teamId: null,
            targetId: input.sourceGenerationId,
            method: "POST",
            path: "/v1/conversation-source-replication/download-authorizations",
            body,
            idempotencyKey: job.actionGrantId,
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
          }
        ).commitmentHash;
      }
      const remote = highRiskActionGrantRemoteEnvelopeSchema.parse(
        await remoteRequest(context, backend, authorization, {
          method: "POST",
          path: "/v1/high-risk/action-grants",
          body: {
            version: 1,
            clientRequestId: job.actionGrantId,
            grantCommitment: `v1:${commitmentHash}`,
            intent: {
              action: "conversation_source.download",
              ...body
            }
          }
        })
      );
      if (remote.status.actionGrant.id !== job.actionGrantId) {
        throw statusError("Source restore grant identity is invalid", 503);
      }
      const activationUrl = remote.status.activationPath
        ? safeUpstreamProxyUrl(backend, remote.status.activationPath).toString()
        : null;
      updateCollaborationActionGrantCustodyStatus(
        context.config.koedHome,
        remote.status.state === "approved"
          ? {
              ...custodyAccess,
              state: "approved",
              expiresAt: remote.status.expiresAt
            }
          : {
              ...custodyAccess,
              state: "pending",
              activationUrl,
              expiresAt: remote.status.expiresAt
            }
      );
      return reply.status(202).send({
        restore: publicRestore(job),
        activationUrl,
        approvalState: remote.status.state
      });
    }
  );

  app.post(
    "/v1/personal-source-replication/restores/:restoreJobId/complete-approval",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw statusError("Source restore control is local-only", 404);
      }
      const user = await context.auth.authenticate(request);
      const { restoreJobId } = restoreParamsSchema.parse(request.params);
      const repository = context.requireRepository();
      const job = await repository.getConversationSourceRestoreJob(
        { userId: user.id },
        restoreJobId
      );
      if (!job) throw statusError("Source restore not found", 404);
      if (job.state !== "awaiting_approval") {
        return { restore: publicRestore(job), approvalState: "consumed" };
      }
      const registry = readLocalEdgeUpstreamRegistry(
        context.localEdge.upstreamBackendsPath
      );
      const backend = upstreamBackendById(registry, job.upstreamBackendId);
      const authorization = backend
        ? context.localEdge.resolveUpstreamAuthorization(backend)
        : null;
      const enrollment = backend
        ? context.localEdge.resolveUpstreamEnrollmentBinding(backend.id)
        : null;
      if (!backend || !authorization || !enrollment) {
        throw statusError("Source restore backend is unavailable", 409);
      }
      const status = highRiskActionGrantRemoteEnvelopeSchema.parse(
        await remoteRequest(context, backend, authorization, {
          method: "GET",
          path: `/v1/high-risk/action-grants/${encodeURIComponent(job.actionGrantId)}`
        })
      ).status;
      if (status.state !== "approved") {
        return {
          restore: publicRestore(job),
          approvalState: status.state,
          activationUrl: status.activationPath
            ? safeUpstreamProxyUrl(backend, status.activationPath).toString()
            : null
        };
      }
      const recipient = await resolveSyncRecipientContext(
        context,
        localProfiles
      );
      if (
        recipient.localDeployment.protocolDeploymentId !==
        job.targetDeploymentId
      ) {
        throw statusError("Source restore recipient identity changed", 409);
      }
      const selectedRecipient = await repository.getSyncRecipientKey(
        recipient.localDeployment.id,
        job.recipientKeyId,
        job.recipientKeyVersion
      );
      if (!selectedRecipient) {
        throw statusError("Source restore recipient key is unavailable", 409);
      }
      const body = {
        sourceGenerationId: job.sourceGenerationId,
        targetDeploymentId: job.targetDeploymentId,
        firstSegmentIndex: job.nextSegmentIndex,
        recipientKey: {
          algorithm: selectedRecipient.algorithm,
          keyId: selectedRecipient.keyId,
          keyVersion: selectedRecipient.keyVersion,
          publicJwk: selectedRecipient.publicJwk
        }
      };
      const custodyAccess = {
        referenceId: job.actionGrantId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId
      };
      updateCollaborationActionGrantCustodyStatus(context.config.koedHome, {
        ...custodyAccess,
        state: "approved",
        expiresAt: status.expiresAt
      });
      const grant = resolveCollaborationActionGrantSecret(
        context.config.koedHome,
        {
          ...custodyAccess,
          operationFamily: "source_download",
          action: "conversation_source.download",
          teamId: null,
          targetId: job.sourceGenerationId,
          method: "POST",
          path: "/v1/conversation-source-replication/download-authorizations",
          body,
          idempotencyKey: job.actionGrantId
        }
      );
      if (!grant) throw statusError("Source restore grant is unavailable", 409);
      const download = await remoteRequest(context, backend, authorization, {
        method: "POST",
        path: "/v1/conversation-source-replication/download-authorizations",
        body,
        actionGrant: grant
      });
      const authorizationId = z.uuid().parse(download.authorizationId);
      const capability = z
        .string()
        .regex(/^csd_[A-Za-z0-9_-]{43}$/)
        .parse(download.capability);
      const firstSegmentIndex = z
        .number()
        .int()
        .safe()
        .nonnegative()
        .parse(download.firstSegmentIndex);
      const lastSegmentIndex = z
        .number()
        .int()
        .safe()
        .nonnegative()
        .parse(download.lastSegmentIndex);
      const registration = parseConversationSourceOriginKeyRegistration(
        download.registration
      );
      const source = parseConversationSourceReplicationSourceDescriptor(
        download.source
      );
      const sourceClosure =
        download.sourceClosure === null
          ? null
          : parseSignedConversationSourceClosureManifest(
              download.sourceClosure
            );
      if (
        registration.sourceGenerationId !== job.sourceGenerationId ||
        source.logicalSessionId.length === 0 ||
        (sourceClosure !== null &&
          sourceClosure.manifest.sourceGenerationId !== job.sourceGenerationId)
      ) {
        throw statusError("Source restore metadata binding is invalid", 409);
      }
      const active = await repository.activateConversationSourceRestoreJob(
        { userId: user.id },
        {
          restoreJobId: job.id,
          actionGrantId: job.actionGrantId,
          remoteAuthorizationId: authorizationId,
          capability,
          registration: registration as unknown as Record<string, unknown>,
          sourceDescriptor: source as unknown as Record<string, unknown>,
          ...(sourceClosure
            ? {
                sourceClosure: sourceClosure as unknown as Record<
                  string,
                  unknown
                >
              }
            : {}),
          firstSegmentIndex,
          lastSegmentIndex
        }
      );
      updateCollaborationActionGrantCustodyStatus(context.config.koedHome, {
        ...custodyAccess,
        state: "consumed"
      });
      return { restore: publicRestore(active), approvalState: "consumed" };
    }
  );

  app.get(
    "/v1/personal-source-replication/restores/:restoreJobId",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      if (!localProfiles.has(context.config.deploymentProfile)) {
        throw statusError("Source restore control is local-only", 404);
      }
      const user = await context.auth.authenticate(request);
      const { restoreJobId } = restoreParamsSchema.parse(request.params);
      const job = await context
        .requireRepository()
        .getConversationSourceRestoreJob({ userId: user.id }, restoreJobId);
      if (!job) throw statusError("Source restore not found", 404);
      return { restore: publicRestore(job) };
    }
  );
};
