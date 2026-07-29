import type {
  DeviceCredentialAuthContext,
  HighRiskActionGrantBindingRecord,
  MemorySourceRepository,
  UserSessionContext
} from "@koed/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AuthHelpers } from "../auth/session.js";
import type { RateLimitHandler } from "../infra/rate-limit.js";
import {
  highRiskActionGrantOperationFamilyForIntent,
  highRiskActionGrantRemoteEnvelopeSchema,
  resolveHighRiskActionGrantOperation
} from "./action-grant-protocol.js";
import {
  createHighRiskActionGrantSchema,
  decideHighRiskBrowserActivationSchema,
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
  | "lookupLegalHoldTeamId"
  | "getTeamWorkspaceAccess"
>;

export interface HighRiskRouteContext {
  requireRepository(): HighRiskRepository;
  authenticateSessionContext: AuthHelpers["authenticateSessionContext"];
  authenticateDeviceCredential: AuthHelpers["authenticateDeviceCredential"];
  rateLimit: {
    browser: RateLimitHandler;
    deviceRead: RateLimitHandler;
    deviceWrite: RateLimitHandler;
  };
  explorerPublicUrl?: string;
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

const resolveWorkspaceTeamIdForUser = async (
  repository: HighRiskRepository,
  userId: string,
  teamWorkspaceId: string
): Promise<string | null> => {
  const access = await repository.getTeamWorkspaceAccess(
    { userId },
    teamWorkspaceId
  );
  return access?.teamId ?? null;
};

const statusResponse = (grant: HighRiskActionGrantBindingRecord) =>
  highRiskActionGrantRemoteEnvelopeSchema.parse({
    status: {
      version: 1,
      actionGrant: { id: grant.id },
      selector: grant.selector,
      state: grant.state,
      activationPath:
        grant.state === "pending"
          ? `/v1/high-risk/browser-activations/${grant.selector}`
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

const acceptsHtml = (request: FastifyRequest): boolean =>
  request.headers.accept
    ?.split(",")
    .some((value) => value.trim().split(";", 1)[0] === "text/html") ?? false;

const explorerActivationUrl = (
  explorerPublicUrl: string,
  selector: string
): string =>
  `${explorerPublicUrl.replace(/\/+$/, "")}/high-risk/browser-activations/${encodeURIComponent(selector)}`;

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
      const operation = await resolveHighRiskActionGrantOperation({
        clientRequestId: input.clientRequestId,
        intent: input.intent,
        resolveWorkspaceTeamId: async (teamWorkspaceId) =>
          resolveWorkspaceTeamIdForUser(
            repository,
            auth.user.id,
            teamWorkspaceId
          ),
        resolveLegalHoldTeamId: async (holdId) =>
          repository.lookupLegalHoldTeamId(holdId)
      });
      if (!operation) {
        throw forbidden();
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
        requestHash: operation.requestHash
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
      if (context.explorerPublicUrl && acceptsHtml(request)) {
        return reply.redirect(
          explorerActivationUrl(context.explorerPublicUrl, selector)
        );
      }
      const session = await authenticateBrowserSession(request, context);
      const activation = await context
        .requireRepository()
        .getBrowserActivation({
          selector,
          ownerUserId: session.user.id
        });
      if (!activation) {
        throw forbidden();
      }
      return browserActivationResponse(activation);
    }
  );

  app.post(
    "/v1/high-risk/browser-activations/:selector/decision",
    {
      preHandler: context.rateLimit.browser,
      bodyLimit: HIGH_RISK_BODY_LIMIT_BYTES
    },
    async (request) => {
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
      return browserActivationResponse(activation);
    }
  );
};
