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
  highRiskActionDefinitions,
  highRiskActionGrantOperationFamilyForIntent,
  highRiskActionGrantRemoteEnvelopeSchema,
  resolveHighRiskActionGrantOperation
} from "./action-grant-protocol.js";
import {
  createHighRiskActionGrantSchema,
  decideHighRiskBrowserActivationSchema,
  decideNativeActionReviewSchema,
  highRiskBrowserActivationEnvelopeSchema,
  highRiskActionGrantParamsSchema,
  highRiskBrowserActivationParamsSchema
} from "./schemas.js";
import {
  resolveActionApprovalPolicy,
  type ActionApprovalPolicyContext
} from "./approval-policy.js";

const HIGH_RISK_BODY_LIMIT_BYTES = 8 * 1024;
const HIGH_RISK_ACTION_GRANT_WAIT_MS = 20_000;
const MANAGED_TARGET_ESTABLISHMENT_MS = 24 * 60 * 60 * 1_000;

type HighRiskRepository = Pick<
  MemorySourceRepository,
  | "createActionGrant"
  | "getActionGrant"
  | "awaitActionGrant"
  | "cancelActionGrant"
  | "getBrowserActivation"
  | "decideBrowserActivation"
  | "decideNativeActionReview"
  | "lookupLegalHoldTeamId"
  | "getTeamWorkspaceAccess"
  | "listTeams"
  | "listTeamWorkspaces"
  | "listTeamManagementMembers"
  | "getPendingTeamInviteReviewByTokenHash"
  | "getManagedConversationExecution"
  | "listDeviceCredentials"
  | "getTeamEntitlementGate"
  | "getTeamBillingSeatState"
  | "getCapturedSessionSummaryByLogicalMemoryId"
  | "listOwnerGrants"
  | "readGrantRepresentation"
  | "listTeamInvites"
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
      approvalTier: grant.approvalTier,
      review: grant.review,
      state:
        grant.state === "pending" && grant.approvalTier === "native_review"
          ? "review_required"
          : grant.state,
      activationPath:
        grant.state === "pending" && grant.approvalTier === "step_up"
          ? `/v1/high-risk/browser-activations/${grant.selector}`
          : null,
      expiresAt: grant.expiresAt
    }
  });

const approvalPolicyContext = async (
  repository: HighRiskRepository,
  userId: string,
  upstreamBackendId: string,
  currentDeviceInstanceId: string,
  hashSecret: HashSecret,
  operation: Awaited<ReturnType<typeof resolveHighRiskActionGrantOperation>>,
  intent: Parameters<typeof resolveActionApprovalPolicy>[0]
): Promise<ActionApprovalPolicyContext> => {
  if (!operation) return {};
  const actor = { userId };
  const contextKinds = new Set(
    highRiskActionDefinitions[intent.action].context
  );
  const inviteReview =
    contextKinds.has("invitation_acceptance") &&
    intent.action === "team.invite.accept"
      ? await repository.getPendingTeamInviteReviewByTokenHash(
          hashSecret(intent.body.inviteToken)
        )
      : null;
  const teamId = operation.teamId ?? inviteReview?.invite.teamId ?? null;
  const teams =
    teamId && contextKinds.has("team") ? await repository.listTeams(actor) : [];
  const team = teamId
    ? teams.find((candidate) => candidate.id === teamId)
    : undefined;
  const workspaces =
    teamId && contextKinds.has("workspace")
      ? ((await repository.listTeamWorkspaces(actor, {
          teamId,
          includeArchived: true,
          limit: 100
        })) ?? [])
      : [];
  const workspaceId =
    "teamWorkspaceId" in intent && typeof intent.teamWorkspaceId === "string"
      ? intent.teamWorkspaceId
      : intent.action === "team.invite.create"
        ? intent.body.defaultTeamWorkspaceId
        : intent.action === "team.invite.accept"
          ? (inviteReview?.invite.defaultTeamWorkspaceId ?? null)
          : null;
  const workspace = workspaceId
    ? workspaces.find((candidate) => candidate.id === workspaceId)
    : undefined;
  const members =
    teamId && contextKinds.has("members")
      ? ((await repository.listTeamManagementMembers(actor, teamId)) ?? [])
      : [];
  const targetUserId =
    "userId" in intent && typeof intent.userId === "string"
      ? intent.userId
      : intent.action === "team.workspace.access_update"
        ? intent.body.userId
        : null;
  const member = targetUserId
    ? members.find((candidate) => candidate.userId === targetUserId)
    : undefined;
  const revokedInvitation =
    contextKinds.has("revoked_invitation") &&
    intent.action === "team.invite.revoke" &&
    teamId
      ? (
          await repository.listTeamInvites(actor, {
            teamId,
            includeRevoked: false,
            limit: 100
          })
        )?.invites.find((invite) => invite.id === intent.inviteId)
      : null;
  const currentWorkspaceAccess =
    intent.action === "team.workspace.access_update" && workspaceId && member
      ? (member.workspaceAccess.find(
          (access) => access.teamWorkspaceId === workspaceId
        )?.access ?? "disabled")
      : undefined;
  const managedContext =
    contextKinds.has("managed_conversation") &&
    (intent.action === "managed_conversation.handoff" ||
      intent.action === "managed_conversation.fork")
      ? await (async () => {
          const [execution, credentials] = await Promise.all([
            repository.getManagedConversationExecution(
              actor,
              intent.executionId
            ),
            repository.listDeviceCredentials(actor, { upstreamBackendId })
          ]);
          const active = credentials.filter(
            (credential) =>
              credential.revokedAt === null &&
              (credential.expiresAt === null ||
                Date.parse(credential.expiresAt) > Date.now()) &&
              credential.operationFamilies.includes("sync") &&
              credential.operationFamilies.includes("managed_execution")
          );
          const targets = active.filter(
            (credential) =>
              credential.deviceInstanceId === intent.body.targetDeviceId
          );
          const source = execution
            ? active.find(
                (credential) =>
                  credential.deviceInstanceId === execution.runnerDeviceId
              )
            : undefined;
          const deploymentIds = new Set(
            targets.map(
              (credential) => credential.metadata.protocolDeploymentId
            )
          );
          const hasOneValidDeployment =
            deploymentIds.size === 1 &&
            typeof [...deploymentIds][0] === "string";
          const target =
            targets.length > 0 && hasOneValidDeployment
              ? targets.reduce((oldest, candidate) =>
                  Date.parse(candidate.createdAt) < Date.parse(oldest.createdAt)
                    ? candidate
                    : oldest
                )
              : undefined;
          return {
            targetDeviceTrusted:
              Boolean(
                execution &&
                execution.state === "running" &&
                execution.runnerDeviceId === currentDeviceInstanceId &&
                target
              ) &&
              execution!.runnerDeviceId !== intent.body.targetDeviceId &&
              Date.parse(target!.createdAt) <=
                Date.now() - MANAGED_TARGET_ESTABLISHMENT_MS,
            currentDevice: source?.deviceLabel ?? execution?.runnerDeviceId,
            targetDevice: target?.deviceLabel ?? intent.body.targetDeviceId
          };
        })()
      : null;
  const entitlement =
    contextKinds.has("entitlement") &&
    intent.action === "team.entitlement.update" &&
    teamId
      ? await repository.getTeamEntitlementGate(actor, teamId)
      : null;
  const billingSeats =
    contextKinds.has("billing_seats") &&
    intent.action === "team.billing_seats.update" &&
    teamId
      ? await repository.getTeamBillingSeatState(actor, teamId)
      : null;
  const representationGrant =
    contextKinds.has("representation_grant") &&
    intent.action === "shared_memory.change_representation"
      ? (
          await repository.listOwnerGrants(actor, {
            logicalMemoryId: intent.logicalMemoryId,
            limit: 100,
            offset: 0
          })
        ).entries.find((grant) => grant.id === intent.shareGrantId)
      : null;
  const revokedGrant =
    contextKinds.has("revoked_grant") &&
    intent.action === "shared_memory.revoke"
      ? await repository.readGrantRepresentation(actor, {
          shareGrantId: intent.shareGrantId
        })
      : null;
  const sharedMemoryLogicalId =
    intent.action === "shared_memory.share" ||
    intent.action === "shared_memory.change_representation"
      ? intent.logicalMemoryId
      : intent.action === "shared_memory.revoke"
        ? (revokedGrant?.grant.logicalMemoryId ?? null)
        : null;
  const sharedMemorySource =
    contextKinds.has("shared_memory_source") && sharedMemoryLogicalId
      ? await repository.getCapturedSessionSummaryByLogicalMemoryId(
          actor,
          sharedMemoryLogicalId
        )
      : null;
  return {
    ...(intent.action === "team.member.role_update"
      ? { currentMemberRole: member?.role ?? null }
      : {}),
    ...(intent.action === "team.workspace.access_update"
      ? { currentWorkspaceAccess: currentWorkspaceAccess ?? null }
      : {}),
    ...(intent.action === "conversation_source.discover"
      ? { enrolledSyncRelationship: true }
      : {}),
    ...(managedContext
      ? { targetDeviceTrusted: managedContext.targetDeviceTrusted }
      : {}),
    ...(intent.action === "team.entitlement.update"
      ? { currentEntitlement: entitlement?.status ?? null }
      : {}),
    ...(intent.action === "team.billing_seats.update"
      ? {
          currentSeatLimit: billingSeats?.seatLimit ?? null,
          currentBillableSeats: billingSeats?.billableSeatCount ?? null
        }
      : {}),
    ...(intent.action === "team.retention.delete_request"
      ? { currentTeamLifecycle: team?.lifecycle ?? null }
      : {}),
    ...(intent.action === "shared_memory.change_representation"
      ? {
          currentRepresentation:
            representationGrant?.activeRepresentation ?? null
        }
      : {}),
    ...(intent.action === "shared_memory.revoke"
      ? {
          currentRepresentation:
            revokedGrant?.grant.activeRepresentation ?? null,
          exactLogicalMemoryId: revokedGrant?.grant.logicalMemoryId ?? null
        }
      : {}),
    display: {
      ...(teamId
        ? { team: inviteReview?.team.name ?? team?.name ?? teamId }
        : {}),
      ...(workspaceId
        ? {
            workspace:
              inviteReview?.defaultWorkspace.name ??
              workspace?.name ??
              workspaceId
          }
        : {}),
      ...(targetUserId
        ? {
            member: member?.displayName?.trim() || member?.email || targetUserId
          }
        : {}),
      ...(inviteReview
        ? {
            invitation: `${inviteReview.invite.role} · ${inviteReview.invite.defaultWorkspaceAccess}`
          }
        : {}),
      ...(revokedInvitation ? { invitation: revokedInvitation.email } : {}),
      ...(managedContext
        ? {
            currentDevice: managedContext.currentDevice,
            targetDevice: managedContext.targetDevice
          }
        : {}),
      ...(intent.action === "shared_memory.change_representation"
        ? { source: sharedMemorySource?.title ?? "Captured Session" }
        : {}),
      ...(intent.action === "shared_memory.share"
        ? { source: sharedMemorySource?.title ?? "Captured Session" }
        : {}),
      ...(revokedGrant
        ? { source: sharedMemorySource?.title ?? "Captured Session" }
        : {})
    }
  };
};

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
      const definition = highRiskActionDefinitions[input.intent.action];
      const operation = await definition.resolveOperation({
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
      const policy = definition.resolvePolicy(
        input.intent,
        await approvalPolicyContext(
          repository,
          auth.user.id,
          auth.credential.upstreamBackendId,
          auth.credential.deviceInstanceId,
          context.hashSecret,
          operation,
          input.intent
        )
      );
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
