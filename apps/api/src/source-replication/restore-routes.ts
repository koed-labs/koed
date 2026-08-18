import { randomUUID } from "node:crypto";

import {
  fetchBoundedJsonObject,
  parseConversationSourceOriginKeyRegistration,
  parseConversationSourceReplicationSourceDescriptor,
  parseSignedConversationSourceClosureManifest
} from "@koed/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createCollaborationActionGrantLifecycle,
  type ActionGrantRemoteStatus,
  type CollaborationActionGrantLifecycleContext
} from "../local-edge/collaboration-action-grant-lifecycle.js";
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
  sourceDiscoverySchema,
  sourceDownloadAuthorizationSchema
} from "./schemas.js";

const localProfiles = new Set(["developer", "local_personal"]);
const maximumResponseBytes = 24 * 1024 * 1024;
const requestTimeoutMs = 30_000;

const startRestoreSchema = z
  .object({
    upstreamBackendId: z.string().trim().min(1).max(160),
    sourceGenerationId: z.uuid(),
    sourceComponentId:
      sourceDownloadAuthorizationSchema.shape.sourceComponentId,
    firstSegmentIndex: z.number().int().safe().nonnegative().default(0)
  })
  .strict();
const restoreParamsSchema = z.object({ restoreJobId: z.uuid() }).strict();
const completeRestoreApprovalSchema = z
  .object({
    sourceComponentId: sourceDownloadAuthorizationSchema.shape.sourceComponentId
  })
  .strict();
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
  const actionGrantLifecycle =
    context.collaboration?.actionGrantLifecycle ??
    createCollaborationActionGrantLifecycle({
      koedHome: context.config.koedHome
    });

  const reconcileRemoteActionGrant = async (
    lifecycleContext: CollaborationActionGrantLifecycleContext,
    referenceId: string,
    request: {
      authorization: string;
      remote: Parameters<typeof remoteRequest>[3];
    }
  ): Promise<ActionGrantRemoteStatus> => {
    try {
      const payload = await remoteRequest(
        context,
        lifecycleContext.backend,
        request.authorization,
        request.remote
      );
      const status = actionGrantLifecycle.acceptRemote(
        lifecycleContext,
        { id: referenceId },
        payload
      );
      if (!status) {
        throw statusError("Source Action Grant response is invalid", 503);
      }
      return status;
    } catch (error) {
      const statusCode =
        error && typeof error === "object" && "statusCode" in error
          ? Number(error.statusCode)
          : null;
      if (statusCode === 401 || statusCode === 403 || statusCode === 404) {
        actionGrantLifecycle.discard({ id: referenceId }, "authority_lost");
      } else {
        actionGrantLifecycle.markAmbiguous(
          lifecycleContext,
          { id: referenceId },
          actionGrantLifecycle.read(lifecycleContext, { id: referenceId }) ??
            undefined
        );
      }
      throw error;
    }
  };
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
      const lifecycleContext = {
        backend,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        upstreamDeviceCredentialId: enrollment.deviceCredentialId
      } satisfies CollaborationActionGrantLifecycleContext;
      const prepared = actionGrantLifecycle.prepare({
        referenceId: input.requestId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        operationFamily: "source_download",
        action: "conversation_source.discover",
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/conversation-source-replication/sources/discover",
        body,
        idempotencyKey: input.requestId,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      });
      const status = await reconcileRemoteActionGrant(
        lifecycleContext,
        input.requestId,
        {
          authorization,
          remote: {
            method: "POST",
            path: "/v1/high-risk/action-grants",
            body: {
              version: 1,
              clientRequestId: input.requestId,
              grantCommitment: `v1:${prepared.commitmentHash}`,
              intent: {
                action: "conversation_source.discover",
                body
              }
            }
          }
        }
      );
      return reply.status(202).send({
        requestId: input.requestId,
        approvalState: status.state,
        activationUrl: status.activationUrl
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
      const lifecycleContext = {
        backend,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        upstreamDeviceCredentialId: enrollment.deviceCredentialId
      } satisfies CollaborationActionGrantLifecycleContext;
      const status = await reconcileRemoteActionGrant(
        lifecycleContext,
        input.requestId,
        {
          authorization,
          remote: {
            method: "GET",
            path: `/v1/high-risk/action-grants/${encodeURIComponent(input.requestId)}`
          }
        }
      );
      if (status.state !== "approved") {
        return {
          requestId: input.requestId,
          approvalState: status.state,
          activationUrl: status.activationUrl
        };
      }
      const grant = actionGrantLifecycle.resolve({
        referenceId: input.requestId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        operationFamily: "source_download",
        action: "conversation_source.discover",
        teamId: null,
        targetId: null,
        method: "POST",
        path: "/v1/conversation-source-replication/sources/discover",
        body,
        idempotencyKey: input.requestId
      });
      if (!grant) {
        throw statusError("Source discovery grant is unavailable", 409);
      }
      let result: Awaited<ReturnType<typeof remoteRequest>>;
      try {
        result = await remoteRequest(context, backend, authorization, {
          method: "POST",
          path: "/v1/conversation-source-replication/sources/discover",
          body,
          actionGrant: grant
        });
      } catch (error) {
        actionGrantLifecycle.markAmbiguous(
          lifecycleContext,
          { id: input.requestId },
          status
        );
        throw error;
      }
      actionGrantLifecycle.transitionTerminal(
        lifecycleContext,
        status,
        "consumed"
      );
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
        sourceComponentId: input.sourceComponentId,
        targetDeploymentId: job.targetDeploymentId,
        firstSegmentIndex: job.nextSegmentIndex,
        recipientKey: {
          algorithm: selectedRecipient.algorithm,
          keyId: selectedRecipient.keyId,
          keyVersion: selectedRecipient.keyVersion,
          publicJwk: selectedRecipient.publicJwk
        }
      };
      const lifecycleContext = {
        backend,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        upstreamDeviceCredentialId: enrollment.deviceCredentialId
      } satisfies CollaborationActionGrantLifecycleContext;
      const prepared = actionGrantLifecycle.prepare({
        referenceId: job.actionGrantId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        operationFamily: "source_download",
        action: "conversation_source.download",
        teamId: null,
        targetId: input.sourceGenerationId,
        method: "POST",
        path: "/v1/conversation-source-replication/download-authorizations",
        body,
        idempotencyKey: job.actionGrantId,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      });
      const status = await reconcileRemoteActionGrant(
        lifecycleContext,
        job.actionGrantId,
        {
          authorization,
          remote: {
            method: "POST",
            path: "/v1/high-risk/action-grants",
            body: {
              version: 1,
              clientRequestId: job.actionGrantId,
              grantCommitment: `v1:${prepared.commitmentHash}`,
              intent: {
                action: "conversation_source.download",
                ...body
              }
            }
          }
        }
      );
      return reply.status(202).send({
        restore: publicRestore(job),
        activationUrl: status.activationUrl,
        approvalState: status.state
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
      const input = completeRestoreApprovalSchema.parse(request.body);
      const repository = context.requireRepository();
      const job = await repository.getConversationSourceRestoreJob(
        { userId: user.id },
        restoreJobId
      );
      if (!job) throw statusError("Source restore not found", 404);
      if (job.state !== "awaiting_approval") {
        actionGrantLifecycle.discard(
          { id: job.actionGrantId },
          "durable_outcome"
        );
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
      const lifecycleContext = {
        backend,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        upstreamDeviceCredentialId: enrollment.deviceCredentialId
      } satisfies CollaborationActionGrantLifecycleContext;
      let status = actionGrantLifecycle.read(lifecycleContext, {
        id: job.actionGrantId
      });
      if (status?.state !== "approved") {
        status = await reconcileRemoteActionGrant(
          lifecycleContext,
          job.actionGrantId,
          {
            authorization,
            remote: {
              method: "GET",
              path: `/v1/high-risk/action-grants/${encodeURIComponent(job.actionGrantId)}`
            }
          }
        );
      }
      if (status.state !== "approved") {
        return {
          restore: publicRestore(job),
          approvalState: status.state,
          activationUrl: status.activationUrl
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
        sourceComponentId: input.sourceComponentId,
        targetDeploymentId: job.targetDeploymentId,
        firstSegmentIndex: job.nextSegmentIndex,
        recipientKey: {
          algorithm: selectedRecipient.algorithm,
          keyId: selectedRecipient.keyId,
          keyVersion: selectedRecipient.keyVersion,
          publicJwk: selectedRecipient.publicJwk
        }
      };
      const grantInput = {
        referenceId: job.actionGrantId,
        backendId: backend.id,
        deploymentBaseUrl: backend.baseUrl,
        deviceCredentialId: enrollment.deviceCredentialId,
        localOwnerUserId: user.id,
        principalUserId: enrollment.principalUserId,
        operationFamily: "source_download",
        action: "conversation_source.download",
        teamId: null,
        targetId: job.sourceGenerationId,
        method: "POST",
        path: "/v1/conversation-source-replication/download-authorizations",
        body,
        idempotencyKey: job.actionGrantId
      } as const;
      let grant = actionGrantLifecycle.resolve(grantInput);
      if (!grant) {
        status = await reconcileRemoteActionGrant(
          lifecycleContext,
          job.actionGrantId,
          {
            authorization,
            remote: {
              method: "GET",
              path: `/v1/high-risk/action-grants/${encodeURIComponent(job.actionGrantId)}`
            }
          }
        );
        if (status.state !== "approved") {
          return {
            restore: publicRestore(job),
            approvalState: status.state,
            activationUrl: status.activationUrl
          };
        }
        grant = actionGrantLifecycle.resolve(grantInput);
      }
      if (!grant) throw statusError("Source restore grant is unavailable", 409);
      let download: Awaited<ReturnType<typeof remoteRequest>>;
      try {
        download = await remoteRequest(context, backend, authorization, {
          method: "POST",
          path: "/v1/conversation-source-replication/download-authorizations",
          body,
          actionGrant: grant
        });
      } catch (error) {
        actionGrantLifecycle.markAmbiguous(
          lifecycleContext,
          { id: job.actionGrantId },
          status
        );
        throw error;
      }
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
        source.sourceComponentId !== input.sourceComponentId ||
        source.logicalSessionId.length === 0 ||
        (sourceClosure !== null &&
          (sourceClosure.manifest.sourceGenerationId !==
            job.sourceGenerationId ||
            sourceClosure.manifest.sourceComponentId !==
              input.sourceComponentId))
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
      actionGrantLifecycle.transitionTerminal(
        lifecycleContext,
        status,
        "consumed"
      );
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
