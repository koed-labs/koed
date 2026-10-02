import type { FastifyInstance, FastifyRequest } from "fastify";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import {
  COLLABORATION_CONTRACT_VERSION,
  collaborationCommandResultSchema,
  type CollaborationActionGrantIntent,
  fetchBoundedJsonObject,
  readDesktopLocalCredentialAuthorization,
  verifyDesktopLocalCredentialAuthorization,
  upstreamAdvertisesCapability
} from "@koed/shared";
import { upstreamApiUrl } from "@koed/shared";
import { pullRequestReviewDraftSchema } from "@koed/shared/pull-requests";
import { highRiskActionGrantIntentSchema } from "../high-risk/action-grant-protocol.js";
import { admitHighRiskActionGrant } from "../high-risk/action-definitions.js";
import { z } from "zod";
import type { ApiRouteContext } from "../server/context.js";
import {
  readLocalEdgeUpstreamRegistry,
  upstreamBackendById,
  assertUpstreamOperationPathAllowed
} from "../local-edge/upstream-routing.js";
import {
  cancelOperationSchema,
  createOperationSchema,
  createReviewSchema,
  freezeDraftSchema,
  operationParamsSchema,
  refreshSchema,
  reviewParamsSchema,
  revisionSchema,
  runnerClaimSchema,
  runnerCompleteSchema,
  runnerFailSchema,
  runnerLeaseSchema,
  sourceControlApprovalIntentSchema,
  sourceControlApprovalStateSchema,
  saveDraftSchema
} from "./schemas.js";

const localProfiles = new Set(["developer", "local_personal"]);
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    before: z.string().max(512).optional()
  })
  .strict();
const reviewListQuerySchema = listQuerySchema.extend({
  repository: z.string().trim().min(1).max(120).optional(),
  number: z.coerce.number().int().positive().optional(),
  agentId: z.uuid().optional()
});

export const registerPullRequestRoutes = (
  app: FastifyInstance,
  context: ApiRouteContext
): void => {
  const remoteAuthority = () => {
    if (!localProfiles.has(context.config.deploymentProfile)) return null;
    const registry = readLocalEdgeUpstreamRegistry(
      context.localEdge.upstreamBackendsPath
    );
    const backend = registry.activeBackendId
      ? upstreamBackendById(registry, registry.activeBackendId)
      : null;
    if (!backend) return null;
    if (
      backend.routePolicy.managedExecution !== "enabled" ||
      !context.localEdge.remoteOperationsAllowed()
    )
      throw Object.assign(new Error("Pull request authority is unavailable"), {
        statusCode: 503
      });
    const capabilities = backend.capabilities;
    if (
      capabilities?.state !== "validated" ||
      (capabilities.expiresAt &&
        Date.parse(capabilities.expiresAt) <= Date.now()) ||
      !upstreamAdvertisesCapability(backend, "memory.managedConversations")
    )
      throw Object.assign(
        new Error("Pull request upstream capability is unavailable"),
        { statusCode: 503 }
      );
    const authorization =
      context.localEdge.resolveUpstreamAuthorization(backend);
    if (!authorization)
      throw Object.assign(new Error("Pull request upstream is not enrolled"), {
        statusCode: 503
      });
    return { backend, authorization };
  };
  const proxy = async (
    request: FastifyRequest,
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    actionGrant?: string
  ) => {
    const authority = remoteAuthority();
    if (!authority) return null;
    // Route paths are fixed by this module; upstream routing applies the same
    // operation allowlist as Managed Conversations.
    assertUpstreamOperationPathAllowed("managed_execution", method, path);
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamApiUrl(authority.backend.baseUrl, path),
      {
        method,
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization,
          ...(actionGrant ? { "x-koed-action-grant": actionGrant } : {}),
          ...(method !== "GET" ? { "content-type": "application/json" } : {})
        },
        ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {})
      },
      { timeoutMs: 60_000, maxBytes: 4 * 1024 * 1024, readErrorBody: true }
    );
    if (!response.ok)
      throw Object.assign(
        new Error(
          typeof payload.error === "string"
            ? payload.error
            : "Pull request upstream failed"
        ),
        {
          statusCode: response.status >= 500 ? 502 : response.status
        }
      );
    return payload;
  };
  const authenticate = async (
    request: FastifyRequest,
    write = false,
    externalWrite = false
  ) => {
    const authorization = request.headers.authorization?.trim() ?? "";
    if (
      localProfiles.has(context.config.deploymentProfile) &&
      authorization.startsWith("Koed-Desktop ")
    ) {
      if (
        !loopback.has(
          request.socket?.remoteAddress ??
            request.raw.socket?.remoteAddress ??
            ""
        )
      )
        throw Object.assign(
          new Error("Desktop source-control access requires loopback"),
          { statusCode: 403 }
        );
      const stored = readDesktopLocalCredentialAuthorization(
        context.config.koedHome
      );
      const verified = stored
        ? verifyDesktopLocalCredentialAuthorization(
            context.config.koedHome,
            authorization,
            {
              ownerUserId: stored.ownerUserId,
              operationFamily: "managed_source_control"
            }
          )
        : null;
      if (!verified)
        throw Object.assign(new Error("Invalid Desktop local credential"), {
          statusCode: 401
        });
      if (
        externalWrite &&
        request.headers["x-koed-desktop-source-control-approval"] !== "1"
      )
        throw Object.assign(
          new Error("Exact pull request approval is required"),
          { statusCode: 403 }
        );
      return { id: verified.ownerUserId };
    }
    if (externalWrite && /^Koed-Device(?:\s|$)/i.test(authorization)) {
      const auth = await context.auth.authenticateDeviceCredential(request);
      if (!auth.credential.operationFamilies.includes("managed_execution"))
        throw Object.assign(
          new Error("Scoped managed execution credential required"),
          { statusCode: 403 }
        );
      return auth.user;
    }
    if (write) {
      if (/^(?:Bearer|Koed-Device)(?:\s|$)/i.test(authorization))
        throw Object.assign(
          new Error("Pull request changes require browser or Desktop approval"),
          { statusCode: 403 }
        );
      const session = await context.auth.authenticateSessionContext(request);
      const ageMs = Date.now() - session.createdAt.getTime();
      if (
        externalWrite &&
        (!Number.isFinite(ageMs) ||
          ageMs < 0 ||
          ageMs > defaultFreshAuthenticationMaxAgeMs)
      )
        throw Object.assign(
          new Error("Fresh browser authentication is required"),
          { statusCode: 403 }
        );
      return session.user;
    }
    return context.auth.authenticateSessionOrDeviceCredential(
      request,
      "managed_execution",
      {
        apiTokenError:
          "Session or scoped device credential required for pull request access"
      }
    );
  };
  const runner = async (request: FastifyRequest) => {
    const auth = await context.auth.authenticateDeviceCredential(request);
    if (!auth.credential.operationFamilies.includes("managed_execution"))
      throw Object.assign(
        new Error("Device credential is not allowed for runner operations"),
        { statusCode: 403 }
      );
    const deploymentId = auth.credential.metadata.protocolDeploymentId;
    if (
      typeof deploymentId !== "string" ||
      !z.uuid().safeParse(deploymentId).success
    )
      throw Object.assign(
        new Error("Runner deployment identity is unavailable"),
        { statusCode: 409 }
      );
    return {
      userId: auth.user.id,
      deviceId: auth.credential.deviceInstanceId,
      deploymentId
    };
  };
  const repo = () => context.requireRepository();

  const grantControlContext = async (ownerUserId: string) => {
    const authority = remoteAuthority();
    const control = context.collaboration.actionGrantControl;
    if (!authority || !control)
      throw Object.assign(
        new Error("Hosted approval authority is unavailable"),
        { statusCode: 503 }
      );
    const { response, payload } = await fetchBoundedJsonObject(
      context.localEdge.fetch,
      upstreamApiUrl(
        authority.backend.baseUrl,
        "/v1/local-edge/device-credentials/status"
      ),
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: authority.authorization
        }
      },
      { timeoutMs: 30_000, maxBytes: 64 * 1024, readErrorBody: true }
    );
    if (!response.ok)
      throw Object.assign(new Error("Hosted device identity is unavailable"), {
        statusCode: 503
      });
    const status = z
      .object({
        ok: z.literal(true),
        user: z.object({ id: z.uuid() }).passthrough(),
        credential: z
          .object({ id: z.uuid(), operationFamilies: z.array(z.string()) })
          .passthrough()
      })
      .parse(payload);
    const enrollment = context.localEdge.resolveUpstreamEnrollmentBinding(
      authority.backend.id
    );
    if (
      !enrollment ||
      enrollment.backendId !== authority.backend.id ||
      enrollment.principalUserId !== status.user.id ||
      enrollment.deviceCredentialId !== status.credential.id ||
      !status.credential.operationFamilies.includes("managed_execution")
    )
      throw Object.assign(
        new Error("Hosted device identity does not match this owner"),
        { statusCode: 403 }
      );
    return {
      control,
      context: {
        backend: authority.backend,
        localOwnerUserId: ownerUserId,
        principalUserId: status.user.id,
        upstreamDeviceCredentialId: status.credential.id,
        upstreamDeviceAuthorization: authority.authorization,
        operationFamilies: new Set(
          status.credential.operationFamilies as Array<
            "action_grant" | "share_grant_management" | "managed_execution"
          >
        )
      }
    };
  };
  const collaborationApprovalIntent = (
    input: z.infer<typeof sourceControlApprovalIntentSchema>
  ): CollaborationActionGrantIntent =>
    input.kind === "publish_review"
      ? {
          intent: "collaboration.publish_pull_request_review",
          commandRequestId: input.commandRequestId,
          requestId: input.requestId,
          reviewId: input.reviewId,
          frozenReviewId: input.frozenReviewId,
          confirmationDigest: input.confirmationDigest,
          expectedReviewRevision: input.expectedReviewRevision,
          targetDeviceId: input.targetDeviceId,
          targetDeploymentId: input.targetDeploymentId
        }
      : {
          intent: "collaboration.push_pull_request",
          commandRequestId: input.commandRequestId,
          requestId: input.requestId,
          reviewId: input.reviewId,
          proposalId: input.proposalId,
          confirmationDigest: input.confirmationDigest,
          expectedReviewRevision: input.expectedReviewRevision,
          targetDeviceId: input.targetDeviceId,
          targetDeploymentId: input.targetDeploymentId
        };
  const operationApprovalIntent = (
    payload: unknown,
    commandRequestId: string,
    requestId: string,
    target: { deviceId: string; deploymentId: string }
  ) => {
    if (!payload || typeof payload !== "object")
      throw Object.assign(new Error("External write payload is invalid"), {
        statusCode: 400
      });
    const value = payload as Record<string, unknown>;
    if (value.kind === "publish_review")
      return sourceControlApprovalIntentSchema.parse({
        kind: "publish_review",
        commandRequestId,
        requestId,
        reviewId: value.reviewId,
        frozenReviewId: value.frozenReviewId,
        confirmationDigest: value.confirmationDigest,
        expectedReviewRevision: value.expectedReviewRevision,
        targetDeviceId: target.deviceId,
        targetDeploymentId: target.deploymentId
      });
    if (value.kind === "push")
      return sourceControlApprovalIntentSchema.parse({
        kind: "push",
        commandRequestId,
        requestId,
        reviewId: value.reviewId,
        proposalId: value.pushProposalId,
        confirmationDigest: value.confirmationDigest,
        expectedReviewRevision: value.expectedReviewRevision,
        targetDeviceId: target.deviceId,
        targetDeploymentId: target.deploymentId
      });
    throw Object.assign(new Error("External write payload is invalid"), {
      statusCode: 400
    });
  };

  app.get(
    "/v1/pull-requests",
    { preHandler: context.rateLimit.memoryRead },
    async (request) => {
      const user = await authenticate(request);
      const query = reviewListQuerySchema.parse(request.query);
      const path = `/v1/pull-requests?${new URLSearchParams(
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)])
      ).toString()}`;
      const remote = await proxy(request, "GET", path);
      return (
        remote ??
        repo().listPullRequestReviews(
          { userId: user.id },
          {
            limit: query.limit,
            before: query.before,
            repositoryId: query.repository,
            pullRequestNumber: query.number,
            agentId: query.agentId
          }
        )
      );
    }
  );
  app.get("/v1/pull-requests/runners", async (request) => {
    const user = await authenticate(request);
    const remote = await proxy(request, "GET", "/v1/pull-requests/runners");
    if (remote) return remote;
    if (localProfiles.has(context.config.deploymentProfile)) {
      const identity = context.deploymentIdentity.inspect();
      if (
        identity.health !== "healthy" ||
        !identity.deploymentId ||
        !identity.deviceInstanceId
      )
        throw Object.assign(new Error("Verified local runner is unavailable"), {
          statusCode: 503
        });
      return {
        runners: [
          {
            deviceId: identity.deviceInstanceId,
            deploymentId: identity.deploymentId,
            label: "This device"
          }
        ]
      };
    }
    const credentials = await repo().listDeviceCredentials({ userId: user.id });
    return {
      runners: credentials.flatMap((credential) => {
        const deploymentId = credential.metadata.protocolDeploymentId;
        if (
          !credential.operationFamilies.includes("managed_execution") ||
          (credential.expiresAt !== null &&
            Date.parse(credential.expiresAt) <= Date.now()) ||
          typeof deploymentId !== "string" ||
          !z.uuid().safeParse(deploymentId).success
        )
          return [];
        return [
          {
            deviceId: credential.deviceInstanceId,
            deploymentId,
            label: credential.deviceLabel ?? "Authorized device"
          }
        ];
      })
    };
  });
  app.post("/v1/pull-requests/action-grants", async (request) => {
    const user = await authenticate(request, true);
    if (!localProfiles.has(context.config.deploymentProfile))
      throw Object.assign(
        new Error("Native pull request approval is local only"),
        { statusCode: 404 }
      );
    const input = sourceControlApprovalIntentSchema.parse(request.body);
    const resolved = await grantControlContext(user.id);
    const intent = collaborationApprovalIntent(input);
    const result = await resolved.control.dispatch(
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: input.commandRequestId,
        command: "collaboration.request_action_grant",
        input: { intent }
      },
      resolved.context
    );
    if (!result)
      throw Object.assign(
        new Error("Pull request approval could not be requested"),
        { statusCode: 403 }
      );
    return { result: collaborationCommandResultSchema.parse(result) };
  });
  app.post("/v1/pull-requests/action-grants/:grantId", async (request) => {
    const user = await authenticate(request, true);
    if (!localProfiles.has(context.config.deploymentProfile))
      throw Object.assign(
        new Error("Native pull request approval is local only"),
        { statusCode: 404 }
      );
    const grantId = z
      .uuid()
      .parse((request.params as { grantId: string }).grantId);
    const input = sourceControlApprovalStateSchema.parse(request.body);
    if (grantId !== input.actionGrantId)
      throw Object.assign(new Error("Approval reference does not match"), {
        statusCode: 409
      });
    const resolved = await grantControlContext(user.id);
    const command =
      input.command === "await"
        ? "collaboration.await_action_grant"
        : input.command === "confirm"
          ? "collaboration.confirm_action_grant"
          : "collaboration.cancel_action_grant";
    const commandInput =
      input.command === "confirm"
        ? {
            actionGrant: { id: grantId },
            decision: input.decision ?? "approve"
          }
        : { actionGrant: { id: grantId } };
    const result = await resolved.control.dispatch(
      {
        contractVersion: COLLABORATION_CONTRACT_VERSION,
        requestId: input.requestId,
        command,
        input: commandInput
      },
      resolved.context
    );
    if (!result)
      throw Object.assign(
        new Error("Pull request approval could not be updated"),
        { statusCode: 403 }
      );
    return { result: collaborationCommandResultSchema.parse(result) };
  });
  app.post(
    "/v1/pull-requests",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const user = await authenticate(request, true);
      const input = createReviewSchema.parse(request.body);
      const remote = await proxy(request, "POST", "/v1/pull-requests", input);
      if (remote) return remote;
      return {
        review: await repo().createPullRequestReview({ userId: user.id }, input)
      };
    }
  );
  app.get("/v1/pull-requests/operations/:operationId", async (request) => {
    const user = await authenticate(request);
    const { operationId } = operationParamsSchema.parse(request.params);
    const path = `/v1/pull-requests/operations/${operationId}`;
    const remote = await proxy(request, "GET", path);
    return (
      remote ?? {
        operation: await repo().getPullRequestOperation(
          { userId: user.id },
          { operationId }
        )
      }
    );
  });
  app.get("/v1/pull-requests/operations", async (request) => {
    const user = await authenticate(request);
    const query = listQuerySchema.parse(request.query);
    const path = `/v1/pull-requests/operations?${new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString()}`;
    const remote = await proxy(request, "GET", path);
    return (
      remote ?? repo().listPullRequestOperations({ userId: user.id }, query)
    );
  });
  app.post(
    "/v1/pull-requests/operations",
    { preHandler: context.rateLimit.memoryWrite },
    async (request) => {
      const body = createOperationSchema.parse(request.body);
      const externalWrite =
        body.payload.kind === "publish_review" || body.payload.kind === "push";
      const user = await authenticate(request, true, externalWrite);
      let target = body.target;
      const remoteMode =
        localProfiles.has(context.config.deploymentProfile) &&
        Boolean(remoteAuthority());
      if (localProfiles.has(context.config.deploymentProfile) && !remoteMode) {
        const identity = context.deploymentIdentity.inspect();
        if (!identity.deploymentId || !identity.deviceInstanceId)
          throw Object.assign(new Error("Verified local runner is required"), {
            statusCode: 503
          });
        if (
          target &&
          (target.deviceId !== identity.deviceInstanceId ||
            target.deploymentId !== identity.deploymentId)
        )
          throw Object.assign(
            new Error(
              "Selected runner does not match the verified local device"
            ),
            { statusCode: 403 }
          );
        target = {
          deviceId: identity.deviceInstanceId,
          deploymentId: identity.deploymentId
        };
      } else if (
        localProfiles.has(context.config.deploymentProfile) &&
        remoteMode
      ) {
        if (!target)
          throw Object.assign(new Error("Select an authorized runner"), {
            statusCode: 400
          });
        const runners = await proxy(
          request,
          "GET",
          "/v1/pull-requests/runners"
        );
        const available = z
          .object({
            runners: z.array(
              z
                .object({ deviceId: z.uuid(), deploymentId: z.uuid() })
                .passthrough()
            )
          })
          .parse(runners).runners;
        if (
          !available.some(
            (item) =>
              item.deviceId === target!.deviceId &&
              item.deploymentId === target!.deploymentId
          )
        )
          throw Object.assign(
            new Error("Selected runner is not authorized for this owner"),
            { statusCode: 403 }
          );
      } else {
        if (!target)
          throw Object.assign(new Error("Select an authorized runner"), {
            statusCode: 400
          });
        const credentials = await repo().listDeviceCredentials({
          userId: user.id
        });
        const authorized = credentials.some(
          (credential) =>
            credential.deviceInstanceId === target!.deviceId &&
            credential.metadata.protocolDeploymentId === target!.deploymentId &&
            credential.operationFamilies.includes("managed_execution") &&
            (credential.expiresAt === null ||
              Date.parse(credential.expiresAt) > Date.now())
        );
        if (!authorized)
          throw Object.assign(
            new Error(
              "Selected runner is not authorized for managed execution"
            ),
            { statusCode: 403 }
          );
      }
      const routedBody = {
        requestId: body.requestId,
        payload: body.payload,
        target
      };
      let actionGrant: string | undefined;
      if (
        externalWrite &&
        localProfiles.has(context.config.deploymentProfile) &&
        remoteAuthority()
      ) {
        if (!body.actionGrantId || !body.commandRequestId)
          throw Object.assign(
            new Error(
              "A matching approved pull request Action Grant is required"
            ),
            { statusCode: 403 }
          );
        const intentInput = operationApprovalIntent(
          body.payload,
          body.commandRequestId,
          body.requestId,
          target
        );
        const resolved = await grantControlContext(user.id);
        const secret = await resolved.control.resolveSecret({
          reference: { id: body.actionGrantId },
          intent: collaborationApprovalIntent(intentInput),
          context: resolved.context
        });
        if (!secret || !/^hrg_[A-Za-z0-9_-]{20,124}$/.test(secret))
          throw Object.assign(
            new Error("Action Grant is invalid, expired, or does not match"),
            { statusCode: 403 }
          );
        actionGrant = secret;
      }
      const remote = await proxy(
        request,
        "POST",
        "/v1/pull-requests/operations",
        routedBody,
        actionGrant
      );
      if (remote) return remote;
      const reviewId =
        "reviewId" in body.payload ? body.payload.reviewId : null;
      if (
        externalWrite &&
        !localProfiles.has(context.config.deploymentProfile) &&
        /^Koed-Device(?:\s|$)/i.test(
          request.headers.authorization?.trim() ?? ""
        )
      ) {
        const device = await context.auth.authenticateDeviceCredential(request);
        if (!body.commandRequestId)
          throw Object.assign(
            new Error("Grant command reference is required"),
            { statusCode: 403 }
          );
        const intentInput = operationApprovalIntent(
          body.payload,
          body.commandRequestId,
          body.requestId,
          target
        );
        const intent = highRiskActionGrantIntentSchema.parse(
          intentInput.kind === "publish_review"
            ? {
                action: "source_control.pull_request_publish",
                requestId: intentInput.requestId,
                reviewId: intentInput.reviewId,
                frozenReviewId: intentInput.frozenReviewId,
                confirmationDigest: intentInput.confirmationDigest,
                expectedReviewRevision: intentInput.expectedReviewRevision,
                targetDeviceId: intentInput.targetDeviceId,
                targetDeploymentId: intentInput.targetDeploymentId
              }
            : {
                action: "source_control.pull_request_push",
                requestId: intentInput.requestId,
                reviewId: intentInput.reviewId,
                proposalId: intentInput.proposalId,
                confirmationDigest: intentInput.confirmationDigest,
                expectedReviewRevision: intentInput.expectedReviewRevision,
                targetDeviceId: intentInput.targetDeviceId,
                targetDeploymentId: intentInput.targetDeploymentId
              }
        );
        const admission = await admitHighRiskActionGrant({
          repository: repo(),
          userId: user.id,
          currentDeviceInstanceId: device.credential.deviceInstanceId,
          clientRequestId: intentInput.commandRequestId,
          hashSecret: context.auth.hashSecret,
          intent
        });
        if (
          !admission ||
          !device.credential.operationFamilies.includes("managed_execution")
        )
          throw Object.assign(
            new Error("Pull request Action Grant is required"),
            { statusCode: 403 }
          );
        const actionGrant = (
          request.headers["x-koed-action-grant"] as string | undefined
        )?.trim();
        if (!actionGrant)
          throw Object.assign(new Error("Approved Action Grant required"), {
            statusCode: 403
          });
        const result = await repo().executeActionGrant({
          actionGrant,
          ownerUserId: user.id,
          deviceCredentialId: device.credential.id,
          upstreamBackendId: device.credential.upstreamBackendId,
          teamId: null,
          operationFamily: admission.operation.operationFamily,
          action: admission.operation.action,
          targetId: admission.operation.targetId,
          scopeHash: admission.operation.scopeHash,
          requestHash: admission.operation.requestHash,
          execute: async () => {
            const operation = await repo().enqueuePullRequestOperation(
              { userId: user.id },
              {
                requestId: body.requestId,
                targetDeviceId: target.deviceId,
                targetDeploymentId: target.deploymentId,
                payload: body.payload,
                reviewId
              }
            );
            return { statusCode: 202, body: { operation } };
          }
        });
        if (!result)
          throw Object.assign(
            new Error(
              "Action Grant does not authorize this exact pull request write"
            ),
            { statusCode: 403 }
          );
        return result.body;
      }
      return {
        operation: await repo().enqueuePullRequestOperation(
          { userId: user.id },
          {
            requestId: body.requestId,
            targetDeviceId: target.deviceId,
            targetDeploymentId: target.deploymentId,
            payload: body.payload,
            reviewId
          }
        )
      };
    }
  );
  app.post(
    "/v1/pull-requests/operations/:operationId/cancel",
    async (request) => {
      const user = await authenticate(request, true);
      const { operationId } = operationParamsSchema.parse(request.params);
      const body = cancelOperationSchema.parse(request.body);
      const remote = await proxy(
        request,
        "POST",
        `/v1/pull-requests/operations/${operationId}/cancel`,
        body
      );
      return (
        remote ?? {
          operation: await repo().cancelPullRequestOperation(
            { userId: user.id },
            { operationId, ...body }
          )
        }
      );
    }
  );

  app.get(
    "/v1/pull-requests/:reviewId/freezes/:frozenReviewId",
    async (request) => {
      const user = await authenticate(request);
      const { reviewId } = reviewParamsSchema.parse(request.params);
      const frozenReviewId = z
        .uuid()
        .parse((request.params as { frozenReviewId: string }).frozenReviewId);
      const path = `/v1/pull-requests/${reviewId}/freezes/${frozenReviewId}`;
      const remote = await proxy(request, "GET", path);
      return (
        remote ?? {
          frozenReview: await repo().getFrozenPullRequestReview(
            { userId: user.id },
            { reviewId, frozenReviewId }
          )
        }
      );
    }
  );

  const reviewPath = (request: FastifyRequest) => {
    const { reviewId } = reviewParamsSchema.parse(request.params);
    return reviewId;
  };
  app.get("/v1/pull-requests/:reviewId", async (request) => {
    const user = await authenticate(request);
    const id = reviewPath(request);
    const remote = await proxy(request, "GET", `/v1/pull-requests/${id}`);
    return (
      remote ?? {
        review: await repo().getPullRequestReview(
          { userId: user.id },
          { reviewId: id }
        )
      }
    );
  });
  app.get("/v1/pull-requests/:reviewId/draft", async (request) => {
    const user = await authenticate(request);
    const id = reviewPath(request);
    const remote = await proxy(request, "GET", `/v1/pull-requests/${id}/draft`);
    return (
      remote ?? {
        draft: await repo().getPullRequestReviewDraft(
          { userId: user.id },
          { reviewId: id }
        )
      }
    );
  });
  app.get("/v1/pull-requests/:reviewId/draft/frozen", async (request) => {
    const user = await authenticate(request);
    const id = reviewPath(request);
    const path = `/v1/pull-requests/${id}/draft/frozen`;
    const remote = await proxy(request, "GET", path);
    return (
      remote ?? {
        frozenReview: await repo().getLatestFrozenPullRequestReview(
          { userId: user.id },
          { reviewId: id }
        )
      }
    );
  });
  app.put("/v1/pull-requests/:reviewId/draft", async (request) => {
    const user = await authenticate(request, true);
    const id = reviewPath(request);
    const body = saveDraftSchema.parse(request.body);
    const remote = await proxy(
      request,
      "PUT",
      `/v1/pull-requests/${id}/draft`,
      body
    );
    return (
      remote ?? {
        draft: await repo().savePullRequestReviewDraft(
          { userId: user.id },
          { reviewId: id, ...body }
        )
      }
    );
  });
  app.post("/v1/pull-requests/:reviewId/draft/freeze", async (request) => {
    const user = await authenticate(request, true);
    const id = reviewPath(request);
    const body = freezeDraftSchema.parse(request.body);
    const remote = await proxy(
      request,
      "POST",
      `/v1/pull-requests/${id}/draft/freeze`,
      body
    );
    return (
      remote ?? {
        frozenReview: await repo().freezePullRequestReviewDraft(
          { userId: user.id },
          { reviewId: id, ...body }
        )
      }
    );
  });
  app.post("/v1/pull-requests/:reviewId/enable-fixes", async (request) => {
    const user = await authenticate(request, true);
    const id = reviewPath(request);
    const body = revisionSchema.parse(request.body);
    const remote = await proxy(
      request,
      "POST",
      `/v1/pull-requests/${id}/enable-fixes`,
      body
    );
    return (
      remote ?? {
        review: await repo().enablePullRequestFixes(
          { userId: user.id },
          { reviewId: id, ...body }
        )
      }
    );
  });
  app.post("/v1/pull-requests/:reviewId/refresh", async (request) => {
    const user = await authenticate(request, true);
    const id = reviewPath(request);
    const body = refreshSchema.parse(request.body);
    const remote = await proxy(
      request,
      "POST",
      `/v1/pull-requests/${id}/refresh`,
      body
    );
    return (
      remote ?? {
        review: await repo().acceptPullRequestHeadRefresh(
          { userId: user.id },
          { reviewId: id, ...body }
        )
      }
    );
  });

  // Runner routes are device scoped and carry no public GitHub transport input.
  app.post("/v1/pull-requests/runner/operations/claim", async (request) => {
    const auth = await runner(request);
    const input = runnerClaimSchema.parse(request.body);
    const claims = await repo().claimPullRequestOperations({
      ownerUserId: auth.userId,
      runnerDeploymentId: auth.deploymentId,
      runnerDeviceId: auth.deviceId,
      ...input
    });
    return {
      operations: claims.map((claim) => ({
        ...claim.operation,
        leaseToken: claim.leaseToken
      }))
    };
  });
  app.get(
    "/v1/pull-requests/runner/operations/:operationId",
    async (request) => {
      const auth = await runner(request);
      const { operationId } = operationParamsSchema.parse(request.params);
      const operation = await repo().getPullRequestOperation(
        { userId: auth.userId },
        { operationId }
      );
      if (
        operation &&
        (operation.targetDeviceId !== auth.deviceId ||
          operation.targetDeploymentId !== auth.deploymentId)
      )
        throw Object.assign(new Error("Operation runner scope mismatch"), {
          statusCode: 403
        });
      return { operation };
    }
  );
  app.post(
    "/v1/pull-requests/runner/operations/:operationId/heartbeat",
    async (request) => {
      const auth = await runner(request);
      const { operationId } = operationParamsSchema.parse(request.params);
      const body = runnerLeaseSchema.parse(request.body);
      const operation = await repo().heartbeatPullRequestOperation({
        operationId,
        ownerUserId: auth.userId,
        runnerDeploymentId: auth.deploymentId,
        runnerDeviceId: auth.deviceId,
        runnerId: body.runnerId,
        leaseToken: body.leaseToken,
        leaseMs: 300_000
      });
      return { operation };
    }
  );
  app.post(
    "/v1/pull-requests/runner/operations/:operationId/complete",
    async (request) => {
      const auth = await runner(request);
      const { operationId } = operationParamsSchema.parse(request.params);
      const body = runnerCompleteSchema.parse(request.body);
      const operation = await repo().completePullRequestOperation({
        operationId,
        ownerUserId: auth.userId,
        runnerDeploymentId: auth.deploymentId,
        runnerDeviceId: auth.deviceId,
        runnerId: body.runnerId,
        leaseToken: body.leaseToken,
        result: body.result
      });
      return { operation };
    }
  );
  app.post(
    "/v1/pull-requests/runner/operations/:operationId/fail",
    async (request) => {
      const auth = await runner(request);
      const { operationId } = operationParamsSchema.parse(request.params);
      const body = runnerFailSchema.parse(request.body);
      const operation = await repo().failPullRequestOperation({
        operationId,
        ownerUserId: auth.userId,
        runnerDeploymentId: auth.deploymentId,
        runnerDeviceId: auth.deviceId,
        runnerId: body.runnerId,
        leaseToken: body.leaseToken,
        state: body.state,
        errorCode: body.errorCode
      });
      return { operation };
    }
  );
  app.get("/v1/pull-requests/runner/reviews/:reviewId", async (request) => {
    const auth = await runner(request);
    const { reviewId } = reviewParamsSchema.parse(request.params);
    const review = await repo().getPullRequestReview(
      { userId: auth.userId },
      { reviewId }
    );
    if (
      review &&
      (review.targetDeviceId !== auth.deviceId ||
        review.targetDeploymentId !== auth.deploymentId)
    )
      throw Object.assign(new Error("Review runner scope mismatch"), {
        statusCode: 403
      });
    return { review };
  });
  app.get(
    "/v1/pull-requests/runner/executions/:executionId/review",
    async (request) => {
      const auth = await runner(request);
      const executionId = z
        .uuid()
        .parse((request.params as { executionId: string }).executionId);
      return {
        review: await repo().getPullRequestReviewForExecution(
          { userId: auth.userId },
          {
            executionId,
            ownerUserId: auth.userId,
            runnerDeploymentId: auth.deploymentId,
            runnerDeviceId: auth.deviceId
          }
        )
      };
    }
  );
  app.get(
    "/v1/pull-requests/runner/reviews/:reviewId/freezes/:frozenReviewId",
    async (request) => {
      const auth = await runner(request);
      const { reviewId } = reviewParamsSchema.parse(request.params);
      const frozenReviewId = z
        .uuid()
        .parse((request.params as { frozenReviewId: string }).frozenReviewId);
      const review = await repo().getPullRequestReview(
        { userId: auth.userId },
        { reviewId }
      );
      if (
        !review ||
        review.targetDeviceId !== auth.deviceId ||
        review.targetDeploymentId !== auth.deploymentId
      )
        throw Object.assign(new Error("Review runner scope mismatch"), {
          statusCode: 403
        });
      return {
        frozenReview: await repo().getFrozenPullRequestReview(
          { userId: auth.userId },
          { reviewId, frozenReviewId }
        )
      };
    }
  );
  app.post(
    "/v1/pull-requests/runner/reviews/:reviewId/complete",
    async (request) => {
      const auth = await runner(request);
      const { reviewId } = reviewParamsSchema.parse(request.params);
      const input = z
        .object({
          executionId: z.uuid(),
          executionGeneration: z.number().int().positive(),
          commandId: z.uuid(),
          leaseToken: z.uuid(),
          agentJobId: z.uuid(),
          baseSha: z.string(),
          headSha: z.string(),
          body: z.string().optional(),
          findings: pullRequestReviewDraftSchema.shape.findings.optional()
        })
        .strict()
        .parse(request.body);
      const draft = await repo().markPullRequestReviewCompleted({
        ownerUserId: auth.userId,
        runnerDeploymentId: auth.deploymentId,
        runnerDeviceId: auth.deviceId,
        reviewId,
        ...input,
        result: {
          event: "COMMENT",
          body: input.body ?? "",
          findings: input.findings ?? []
        }
      });
      return { draft };
    }
  );
};
