import type {
  DeviceCredentialAuthContext,
  HighRiskActionGrantBindingRecord,
  MemorySourceRepository,
  UserSessionContext
} from "@koed/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthHelpers, HashSecret } from "../auth/session.js";
import type { RateLimitHandler } from "../infra/rate-limit.js";
import {
  admitHighRiskActionGrant,
  highRiskActionGrantOperationFamilyForIntent
} from "./action-definitions.js";
import { highRiskActionGrantRemoteEnvelopeSchema } from "./action-grant-protocol.js";
import {
  createHighRiskActionGrantSchema,
  decideHighRiskBrowserActivationSchema,
  decideNativeActionReviewSchema,
  highRiskBrowserActivationEnvelopeSchema,
  highRiskActionGrantParamsSchema,
  highRiskBrowserActivationParamsSchema
} from "./schemas.js";

const HIGH_RISK_BODY_LIMIT_BYTES = 8 * 1024;
const HIGH_RISK_ACTION_GRANT_WAIT_MS = 20_000;

type HighRiskRepository = Pick<
  MemorySourceRepository,
  | "createActionGrant"
  | "getActionGrant"
  | "awaitActionGrant"
  | "cancelActionGrant"
  | "getBrowserActivation"
  | "decideBrowserActivation"
  | "decideNativeActionReview"
  | "listTeams"
  | "getTeamInviteAcceptanceReview"
  | "getTeamInviteRevocationReview"
  | "getTeamMembershipActionReview"
  | "getTeamLeaveReview"
  | "getTeamWorkspaceCreationReview"
  | "getTeamWorkspaceLifecycleReview"
  | "getTeamWorkspaceAccessUpdateReview"
  | "getSharedMemoryPreviewAdmission"
  | "getSharedMemoryShareReview"
  | "getSharedMemoryRevokeReview"
  | "getSharedMemoryRepresentationChangeReview"
  | "getTeamConversationSourceGrantReview"
  | "getConversationSourceArtifactByGeneration"
  | "getManagedConversationExecution"
  | "listDeviceCredentials"
  | "getTeamEntitlementGate"
  | "getTeamBillingSeatState"
  | "getTeamMembership"
  | "getLegalHoldApprovalReview"
  | "getTeamInviteCreationReview"
>;

export interface HighRiskRouteContext {
  requireRepository(): HighRiskRepository;
  authenticateSessionContext: AuthHelpers["authenticateSessionContext"];
  authenticateDeviceCredential: AuthHelpers["authenticateDeviceCredential"];
  hashSecret: HashSecret;
  rateLimit: {
    browser: RateLimitHandler;
    deviceRead: RateLimitHandler;
    deviceWrite: RateLimitHandler;
  };
}

const forbidden = (
  message = "High-risk action confirmation is not available"
) => Object.assign(new Error(message), { statusCode: 403 });

const authenticateBrowserSession = async (
  request: FastifyRequest,
  context: HighRiskRouteContext
): Promise<UserSessionContext> => {
  const authorization = request.headers.authorization?.trim() ?? "";
  if (/^Bearer(?:\s|$)/i.test(authorization)) {
    throw forbidden("API Tokens cannot authorize high-risk browser activation");
  }
  if (/^Koed-Device(?:\s|$)/i.test(authorization)) {
    throw forbidden(
      "Device credentials cannot authorize high-risk browser activation"
    );
  }
  return context.authenticateSessionContext(request);
};

const authenticateDeviceCredential = async (
  request: FastifyRequest,
  context: HighRiskRouteContext
): Promise<DeviceCredentialAuthContext> => {
  const authorization = request.headers.authorization?.trim() ?? "";
  if (/^Bearer(?:\s|$)/i.test(authorization)) {
    throw forbidden("API Tokens cannot authorize high-risk actions");
  }
  if (!/^Koed-Device(?:\s|$)/i.test(authorization)) {
    throw forbidden("Device credential required");
  }
  return context.authenticateDeviceCredential(request);
};

const requireFreshAuthentication = (context: UserSessionContext): void => {
  const authenticationAgeMs = Date.now() - context.createdAt.getTime();
  if (!Number.isFinite(authenticationAgeMs) || authenticationAgeMs < 0) {
    throw forbidden("Fresh browser authentication is required");
  }
  if (authenticationAgeMs > 5 * 60 * 1000) {
    throw forbidden("Fresh browser authentication is required");
  }
};

const requireOperationFamily = (
  auth: DeviceCredentialAuthContext,
  operationFamily:
    | "action_grant"
    | "share_grant_management"
    | "sync"
    | "managed_execution"
): void => {
  if (!auth.credential.operationFamilies.includes(operationFamily)) {
    throw forbidden(
      "Device credential is not allowed for this high-risk action"
    );
  }
};

const credentialOperationFamilyForGrant = (
  operationFamily:
    | "admin"
    | "share_grant_management"
    | "source_download"
    | "managed_execution"
): "action_grant" | "share_grant_management" | "sync" | "managed_execution" =>
  operationFamily === "admin"
    ? "action_grant"
    : operationFamily === "source_download"
      ? "sync"
      : operationFamily === "managed_execution"
        ? "managed_execution"
        : "share_grant_management";

const statusResponse = (grant: HighRiskActionGrantBindingRecord) =>
  highRiskActionGrantRemoteEnvelopeSchema.parse({
    status: {
      version: 1,
      actionGrant: { id: grant.id },
      selector: grant.selector,
      approvalTier: grant.approvalTier,
      review: grant.review,
      state:
        grant.state === "pending" && grant.approvalTier === "native_review"
          ? "review_required"
          : grant.state,
      activationPath:
        grant.state === "pending" && grant.approvalTier === "step_up"
          ? `/high-risk/browser-activations/${grant.selector}`
          : null,
      expiresAt: grant.expiresAt
    }
  });

const browserActivationResponse = (grant: HighRiskActionGrantBindingRecord) =>
  highRiskBrowserActivationEnvelopeSchema.parse({
    ...statusResponse(grant),
    confirmation: {
      action: grant.action,
      operationFamily: grant.operationFamily,
      teamId: grant.teamId,
      targetId: grant.targetId
    }
  });

export const registerHighRiskRoutes = (
  app: FastifyInstance,
  context: HighRiskRouteContext
): void => {
  app.post(
    "/v1/high-risk/action-grants",
    {
      preHandler: context.rateLimit.deviceWrite,
      bodyLimit: HIGH_RISK_BODY_LIMIT_BYTES
    },
    async (request, reply) => {
      const auth = await authenticateDeviceCredential(request, context);
      const input = createHighRiskActionGrantSchema.parse(request.body);
      const credentialOperationFamily = credentialOperationFamilyForGrant(
        highRiskActionGrantOperationFamilyForIntent(input.intent)
      );
      requireOperationFamily(auth, credentialOperationFamily);
      const repository = context.requireRepository();
      const admission = await admitHighRiskActionGrant({
        repository,
        userId: auth.user.id,
        upstreamBackendId: auth.credential.upstreamBackendId,
        currentDeviceInstanceId: auth.credential.deviceInstanceId,
        clientRequestId: input.clientRequestId,
        hashSecret: context.hashSecret,
        intent: input.intent
      });
      if (!admission) {
        throw forbidden();
      }
      const { operation, policy } = admission;
      if (policy.disposition === "bundled_stage") {
        throw forbidden(
          "This action is authorized only within its reviewed workflow"
        );
      }
      const created = await repository.createActionGrant({
        clientRequestId: input.clientRequestId,
        grantCommitment: input.grantCommitment,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId,
        credentialOperationFamily,
        operationFamily: operation.operationFamily,
        action: operation.action,
        teamId: operation.teamId,
        targetId: operation.targetId,
        scopeHash: operation.scopeHash,
        requestHash: operation.requestHash,
        approvalTier: policy.disposition,
        review: policy.review
      });
      if (!created) {
        throw forbidden();
      }
      return reply.status(201).send(statusResponse(created));
    }
  );

  app.get(
    "/v1/high-risk/action-grants/:clientRequestId/await",
    { preHandler: context.rateLimit.deviceRead },
    async (request) => {
      const auth = await authenticateDeviceCredential(request, context);
      const { clientRequestId } = highRiskActionGrantParamsSchema.parse(
        request.params
      );
      const current = await context.requireRepository().getActionGrant({
        clientRequestId,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId
      });
      if (!current) {
        throw forbidden();
      }
      requireOperationFamily(
        auth,
        credentialOperationFamilyForGrant(
          current.operationFamily as
            | "admin"
            | "share_grant_management"
            | "source_download"
            | "managed_execution"
        )
      );
      const abort = new AbortController();
      const onClose = () => abort.abort();
      request.raw.once("aborted", onClose);
      try {
        const resolved = await context.requireRepository().awaitActionGrant({
          clientRequestId,
          ownerUserId: auth.user.id,
          deviceCredentialId: auth.credential.id,
          upstreamBackendId: auth.credential.upstreamBackendId,
          maxWaitMs: HIGH_RISK_ACTION_GRANT_WAIT_MS,
          signal: abort.signal
        });
        if (!resolved) {
          throw forbidden();
        }
        return statusResponse(resolved);
      } finally {
        request.raw.removeListener("aborted", onClose);
      }
    }
  );

  app.post(
    "/v1/high-risk/action-grants/:clientRequestId/native-decision",
    {
      preHandler: context.rateLimit.deviceWrite,
      bodyLimit: HIGH_RISK_BODY_LIMIT_BYTES
    },
    async (request) => {
      const auth = await authenticateDeviceCredential(request, context);
      const { clientRequestId } = highRiskActionGrantParamsSchema.parse(
        request.params
      );
      decideNativeActionReviewSchema.parse(request.body);
      const repository = context.requireRepository();
      const current = await repository.getActionGrant({
        clientRequestId,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId
      });
      if (!current || current.approvalTier !== "native_review") {
        throw forbidden();
      }
      requireOperationFamily(
        auth,
        credentialOperationFamilyForGrant(
          current.operationFamily as
            | "admin"
            | "share_grant_management"
            | "source_download"
            | "managed_execution"
        )
      );
      const decided = await repository.decideNativeActionReview({
        clientRequestId,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId,
        decision: "approve"
      });
      if (!decided) throw forbidden();
      return statusResponse(decided);
    }
  );

  app.get(
    "/v1/high-risk/action-grants/:clientRequestId",
    { preHandler: context.rateLimit.deviceRead },
    async (request) => {
      const auth = await authenticateDeviceCredential(request, context);
      const { clientRequestId } = highRiskActionGrantParamsSchema.parse(
        request.params
      );
      const grant = await context.requireRepository().getActionGrant({
        clientRequestId,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId
      });
      if (!grant) {
        throw forbidden();
      }
      requireOperationFamily(
        auth,
        credentialOperationFamilyForGrant(
          grant.operationFamily as
            | "admin"
            | "share_grant_management"
            | "source_download"
            | "managed_execution"
        )
      );
      return statusResponse(grant);
    }
  );

  app.delete(
    "/v1/high-risk/action-grants/:clientRequestId",
    { preHandler: context.rateLimit.deviceWrite },
    async (request, reply) => {
      const auth = await authenticateDeviceCredential(request, context);
      const { clientRequestId } = highRiskActionGrantParamsSchema.parse(
        request.params
      );
      const grant = await context.requireRepository().getActionGrant({
        clientRequestId,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId
      });
      if (!grant) {
        throw forbidden();
      }
      requireOperationFamily(
        auth,
        credentialOperationFamilyForGrant(
          grant.operationFamily as
            | "admin"
            | "share_grant_management"
            | "source_download"
            | "managed_execution"
        )
      );
      const cancelled = await context.requireRepository().cancelActionGrant({
        clientRequestId,
        ownerUserId: auth.user.id,
        deviceCredentialId: auth.credential.id,
        upstreamBackendId: auth.credential.upstreamBackendId,
        reasonCode: "device_cancelled"
      });
      if (!cancelled) {
        throw forbidden();
      }
      return reply.status(204).send();
    }
  );

  app.get(
    "/v1/high-risk/browser-activations/:selector",
    { preHandler: context.rateLimit.browser },
    async (request, reply) => {
      const { selector } = highRiskBrowserActivationParamsSchema.parse(
        request.params
      );
      const session = await authenticateBrowserSession(request, context);
      requireFreshAuthentication(session);
      const activation = await context
        .requireRepository()
        .getBrowserActivation({
          selector,
          ownerUserId: session.user.id
        });
      if (!activation) {
        throw forbidden();
      }
      reply.header("cache-control", "no-store");
      return browserActivationResponse(activation);
    }
  );

  app.post(
    "/v1/high-risk/browser-activations/:selector/decision",
    {
      preHandler: context.rateLimit.browser,
      bodyLimit: HIGH_RISK_BODY_LIMIT_BYTES
    },
    async (request, reply) => {
      const session = await authenticateBrowserSession(request, context);
      requireFreshAuthentication(session);
      const { selector } = highRiskBrowserActivationParamsSchema.parse(
        request.params
      );
      const { decision } = decideHighRiskBrowserActivationSchema.parse(
        request.body
      );
      const activation = await context
        .requireRepository()
        .decideBrowserActivation({
          selector,
          ownerUserId: session.user.id,
          userSessionId: session.sessionId,
          freshlyAuthenticatedAt: session.createdAt,
          decision
        });
      if (!activation) {
        throw forbidden();
      }
      reply.header("cache-control", "no-store");
      return browserActivationResponse(activation);
    }
  );
};
