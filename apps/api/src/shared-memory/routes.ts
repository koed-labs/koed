import type {
  CollaborationRepository,
  SharedMemoryAuthorityContext,
  SharedMemoryGrantRecord,
  SharedMemoryPolicyRecord,
  SharedMemoryReadResult,
  SharedMemoryRepository,
  SharedMemoryRepresentationRecord,
  TeamConversationSourceGrantRecord,
  TeamConversationSourceRepository,
  DeviceCredentialAuthContext,
  HighRiskActionRepository,
  PendingShareRecord
} from "@koed/db";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import {
  sharedMemoryCandidatePreviewActionGrantBinding,
  sharedMemoryPendingShareActionGrantBinding,
  sharedMemoryFidelityBundleActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding,
  pendingShareSchema,
  sharedMemoryGrantScopedSourceId,
  validateSharedMemoryCanonicalSourceItem,
  SharedMemoryConflictError,
  SharedMemorySourceItemRejectedError,
  type SharedMemoryCanonicalSourceItemDto,
  type SharedMemoryActionGrantBinding
} from "@koed/shared";
import {
  SHARED_MEMORY_AUTHORITY,
  SharedMemoryAuthorizationError,
  TeamConversationSourceAuthorizationError,
  TeamConversationSourceConflictError
} from "@koed/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ApiRouteContext } from "../server/context.js";
import { publicCollaborationThread } from "../collaboration/public-thread.js";
import {
  advanceContinuousPersonalNoteRevisionSchema,
  changeSharedMemoryFidelityBundleSchema,
  createPendingShareSchema,
  createSharedMemoryCandidatePreviewSchema,
  createSharedMemoryPreviewSchema,
  controlPendingShareSchema,
  listOwnedSharesQuerySchema,
  ownedShareParamsSchema,
  personalNoteSourceArtifactUploadSchema,
  listWorkspaceSharedMemoryQuerySchema,
  putSharedMemoryPolicySchema,
  putTeamConversationSourceGrantSchema,
  readGrantRepresentationPageQuerySchema,
  readGrantRepresentationQuerySchema,
  revokeShareGrantSchema,
  revokeTeamConversationSourceGrantSchema,
  scopedShareGrantParamsSchema,
  shareGrantParamsSchema,
  sharedMemoryItemDetailParamsSchema,
  sourceOwnerPolicyParamsSchema,
  teamPolicyParamsSchema,
  workspacePolicyParamsSchema
} from "./schemas.js";

const SMALL_BODY_LIMIT_BYTES = 32 * 1_024;
const SOURCE_UPLOAD_BODY_LIMIT_BYTES = 300 * 1_024;

const forbidden = () =>
  Object.assign(new Error("Shared Memory operation is not authorized"), {
    statusCode: 403
  });

const conflict = () =>
  Object.assign(new Error("Shared Memory state conflict"), {
    statusCode: 409
  });

const rejectedSource = () =>
  Object.assign(new Error("Shared Memory source items were rejected"), {
    statusCode: 422
  });

const notFound = () =>
  Object.assign(new Error("Shared Memory item was not found"), {
    statusCode: 404
  });

const isBearerRequest = (request: FastifyRequest): boolean =>
  /^Bearer(?:\s|$)/i.test(request.headers.authorization?.trim() ?? "");

const rejectApiToken = (request: FastifyRequest): void => {
  if (isBearerRequest(request)) throw forbidden();
};

const mapSharedMemoryError = (error: unknown): never => {
  if (
    error instanceof SharedMemoryAuthorizationError ||
    (error instanceof Error && error.name === "SharedMemoryAuthorizationError")
  ) {
    throw forbidden();
  }
  if (
    error instanceof SharedMemoryConflictError ||
    (error instanceof Error && error.name === "SharedMemoryConflictError")
  ) {
    throw conflict();
  }
  if (
    error instanceof SharedMemorySourceItemRejectedError ||
    (error instanceof Error &&
      error.name === "SharedMemorySourceItemRejectedError")
  ) {
    throw rejectedSource();
  }
  if (
    error instanceof TeamConversationSourceAuthorizationError ||
    (error instanceof Error &&
      error.name === "TeamConversationSourceAuthorizationError")
  ) {
    throw forbidden();
  }
  if (
    error instanceof TeamConversationSourceConflictError ||
    (error instanceof Error &&
      error.name === "TeamConversationSourceConflictError")
  ) {
    throw conflict();
  }
  throw error;
};

const executeRepositoryOperation = async <T>(
  work: () => T | Promise<T>
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    return mapSharedMemoryError(error);
  }
};

export interface SharedMemoryRouteContext {
  requireSharedMemoryRepository(): SharedMemoryRepository;
  requireTeamConversationSourceRepository(): TeamConversationSourceRepository;
  requireCollaborationRepository(): CollaborationRepository;
  requireHighRiskRepository(): Pick<
    HighRiskActionRepository,
    "executeActionGrant"
  >;
  authenticateSession: ApiRouteContext["auth"]["authenticateSession"];
  authenticateSessionContext: ApiRouteContext["auth"]["authenticateSessionContext"];
  authenticateDeviceCredential: ApiRouteContext["auth"]["authenticateDeviceCredential"];
  authenticateSessionOrDeviceCredential: ApiRouteContext["auth"]["authenticateSessionOrDeviceCredential"];
  readRateLimit: ApiRouteContext["rateLimit"]["memoryRead"];
  writeRateLimit: ApiRouteContext["rateLimit"]["memoryWrite"];
  reportDiagnostic?(diagnostic: {
    code: "shared_memory_action_grant_binding_failed";
    operation: string;
    publicGrantReference: string;
    failureStage: "action_grant_execution";
    httpStatus: 403;
  }): void;
}

type SharedMemoryPersistedPreviewRecord = Awaited<
  ReturnType<SharedMemoryRepository["createAuthoritativeSourcePreview"]>
>;

const authenticateSessionOnly = async (
  request: FastifyRequest,
  context: SharedMemoryRouteContext
) => {
  rejectApiToken(request);
  return context.authenticateSession(request);
};

const authenticateSourceOwner = async (
  request: FastifyRequest,
  context: SharedMemoryRouteContext
) =>
  context.authenticateSessionOrDeviceCredential(
    request,
    "share_grant_management",
    { apiTokenError: "API Tokens cannot authorize Shared Memory operations" }
  );

const authenticateSourceOwnerAuthority = async (
  request: FastifyRequest,
  context: SharedMemoryRouteContext,
  authority:
    | { action: typeof SHARED_MEMORY_AUTHORITY; source: "browser_session" }
    | {
        action: typeof SHARED_MEMORY_AUTHORITY;
        source: "device_action_grant";
        referenceId: string;
      }
) => {
  rejectApiToken(request);
  if (authority.source === "browser_session") {
    const session = await context.authenticateSessionContext(request);
    return {
      kind: "browser" as const,
      actor: session.user,
      sessionCreatedAt: session.createdAt,
      authority: {
        ...authority,
        referenceId: session.sessionId
      } satisfies SharedMemoryAuthorityContext
    };
  }
  const device = await context.authenticateDeviceCredential(request);
  if (!device.credential.operationFamilies.includes("share_grant_management")) {
    throw forbidden();
  }
  const actionGrant = actionGrantHeader(request);
  if (!actionGrant) throw forbidden();
  return {
    kind: "device" as const,
    actor: device.user,
    auth: device,
    actionGrant,
    authority
  };
};

const actionGrantHeader = (request: FastifyRequest): string | null => {
  const value = request.headers["x-koed-action-grant"];
  const token = Array.isArray(value) ? value[0] : value;
  return token?.trim() || null;
};

type AuthenticatedSourceOwner =
  | {
      kind: "browser";
      actor: { id: string };
      sessionCreatedAt: Date;
      authority: SharedMemoryAuthorityContext;
    }
  | {
      kind: "device";
      actor: { id: string };
      auth: DeviceCredentialAuthContext;
      actionGrant: string;
      authority: SharedMemoryAuthorityContext;
    };

const reportActionGrantBindingFailure = (
  context: SharedMemoryRouteContext,
  authenticated: Extract<AuthenticatedSourceOwner, { kind: "device" }>,
  binding: SharedMemoryActionGrantBinding
): void => {
  try {
    context.reportDiagnostic?.({
      code: "shared_memory_action_grant_binding_failed",
      operation: binding.action,
      publicGrantReference: authenticated.authority.referenceId,
      failureStage: "action_grant_execution",
      httpStatus: 403
    });
  } catch {
    // Diagnostics must never alter the fail-closed authorization result.
  }
};

const runHighRiskSharedMemoryWrite = async <TBody>(
  context: SharedMemoryRouteContext,
  authenticated: AuthenticatedSourceOwner,
  binding: SharedMemoryActionGrantBinding,
  execute: (
    repository: SharedMemoryRepository
  ) => Promise<{ statusCode: number; body: TBody } | null>
): Promise<{ statusCode: number; body: TBody }> => {
  if (authenticated.kind === "browser") {
    const result = await execute(context.requireSharedMemoryRepository());
    if (!result) throw forbidden();
    return result;
  }
  if (authenticated.authority.source !== "device_action_grant") {
    throw forbidden();
  }
  const result = await context.requireHighRiskRepository().executeActionGrant({
    actionGrant: authenticated.actionGrant,
    ownerUserId: authenticated.actor.id,
    deviceCredentialId: authenticated.auth.credential.id,
    upstreamBackendId: authenticated.auth.credential.upstreamBackendId,
    teamId: binding.teamId,
    operationFamily: binding.operationFamily,
    action: binding.action,
    targetId: binding.targetId,
    scopeHash: binding.scopeHash,
    requestHash: binding.requestHash,
    execute: async ({ sharedMemory }) => execute(sharedMemory)
  });
  if (!result) {
    reportActionGrantBindingFailure(context, authenticated, binding);
    throw forbidden();
  }
  return result;
};

const runHighRiskTeamConversationSourceWrite = async <TBody>(
  context: SharedMemoryRouteContext,
  authenticated: AuthenticatedSourceOwner,
  binding: SharedMemoryActionGrantBinding,
  execute: (
    repository: TeamConversationSourceRepository
  ) => Promise<{ statusCode: number; body: TBody } | null>
): Promise<{ statusCode: number; body: TBody }> => {
  if (authenticated.kind === "browser") {
    const result = await execute(
      context.requireTeamConversationSourceRepository()
    );
    if (!result) throw forbidden();
    return result;
  }
  if (authenticated.authority.source !== "device_action_grant") {
    throw forbidden();
  }
  const result = await context.requireHighRiskRepository().executeActionGrant({
    actionGrant: authenticated.actionGrant,
    ownerUserId: authenticated.actor.id,
    deviceCredentialId: authenticated.auth.credential.id,
    upstreamBackendId: authenticated.auth.credential.upstreamBackendId,
    teamId: binding.teamId,
    operationFamily: binding.operationFamily,
    action: binding.action,
    targetId: binding.targetId,
    scopeHash: binding.scopeHash,
    requestHash: binding.requestHash,
    execute: async ({ teamConversationSource }) =>
      execute(teamConversationSource)
  });
  if (!result) {
    reportActionGrantBindingFailure(context, authenticated, binding);
    throw forbidden();
  }
  return result;
};

const requireFreshBrowserAuthority = (
  authenticated: AuthenticatedSourceOwner
): void => {
  if (authenticated.kind !== "browser") return;
  const ageMs = Date.now() - authenticated.sessionCreatedAt.getTime();
  if (
    !Number.isFinite(ageMs) ||
    ageMs < 0 ||
    ageMs > defaultFreshAuthenticationMaxAgeMs
  ) {
    throw forbidden();
  }
};

const authenticateReader = async (
  request: FastifyRequest,
  context: SharedMemoryRouteContext
) => {
  rejectApiToken(request);
  return context.authenticateSessionOrDeviceCredential(
    request,
    "team_workspace_read",
    { apiTokenError: "API Tokens cannot read Team-shared Memory" }
  );
};

const policyDto = (policy: SharedMemoryPolicyRecord) => ({
  id: policy.id,
  policyId: policy.policyId,
  scope: policy.scope,
  logicalMemoryId: policy.logicalMemoryId,
  teamId: policy.teamId,
  teamWorkspaceId: policy.teamWorkspaceId,
  version: policy.version,
  maximumFidelity: policy.maximumFidelity,
  includeCuratedMemory: policy.includeCuratedMemory,
  policyHash: policy.policyHash,
  effectiveAt: policy.effectiveAt,
  supersededAt: policy.supersededAt
});

const requiredSource = (
  source: SharedMemoryPersistedPreviewRecord["source"]
) => {
  if (!source) throw conflict();
  return source;
};

const persistedPreviewDto = (preview: SharedMemoryPersistedPreviewRecord) => ({
  source: requiredSource(preview.source),
  sourceCapabilities: preview.sourceCapabilities,
  activationRepresentation: preview.activationRepresentation,
  mode: preview.mode,
  previewId: preview.previewId,
  previewHash: preview.previewHash,
  previewRevision: preview.previewRevision,
  logicalMemoryId: preview.logicalMemoryId,
  teamId: preview.teamId,
  teamWorkspaceId: preview.teamWorkspaceId,
  representation: preview.representation,
  maximumFidelity: preview.maximumFidelity,
  includeCuratedMemory: preview.includeCuratedMemory,
  binding: {
    sourceRevision: preview.binding.sourceRevision,
    sourceHash: preview.binding.sourceHash,
    fidelityPolicyRevision: preview.binding.fidelityPolicyRevision,
    fidelityPolicyHash: preview.binding.fidelityPolicyHash,
    contentPolicyVersion: preview.binding.contentPolicyVersion,
    contentPolicyHash: preview.binding.contentPolicyHash,
    classifierVersion: preview.binding.classifierVersion,
    classifierHash: preview.binding.classifierHash
  },
  items: preview.items,
  sourceContentHash: preview.sourceContentHash,
  sourceRevision: preview.sourceRevision,
  sourceHash: preview.sourceHash,
  createdAt: preview.createdAt
});

const ownerGrantDto = (grant: SharedMemoryGrantRecord) => ({
  source: requiredSource(grant.source),
  sourceCapabilities: grant.sourceCapabilities,
  activationRepresentation: grant.activationRepresentation,
  id: grant.id,
  logicalGrantId: grant.logicalGrantId,
  logicalMemoryId: grant.logicalMemoryId,
  ownerUserId: grant.ownerUserId,
  teamId: grant.teamId,
  teamWorkspaceId: grant.teamWorkspaceId,
  consentId: grant.consentId,
  sourceOwnerPolicyId: grant.sourceOwnerPolicyId,
  sourceOwnerPolicyVersion: grant.sourceOwnerPolicyVersion,
  teamPolicyId: grant.teamPolicyId,
  teamPolicyVersion: grant.teamPolicyVersion,
  workspacePolicyId: grant.workspacePolicyId,
  workspacePolicyVersion: grant.workspacePolicyVersion,
  mode: grant.mode,
  maximumFidelity: grant.maximumFidelity,
  includeCuratedMemory: grant.includeCuratedMemory,
  fidelityPolicyRevision: grant.fidelityPolicyRevision,
  contentPolicyVersion: grant.contentPolicyVersion,
  classifierVersion: grant.classifierVersion,
  sourceRevision: grant.sourceRevision,
  grantVersion: grant.grantVersion,
  lifecycle: grant.lifecycle,
  grantedByUserId: grant.grantedByUserId,
  createdAt: grant.createdAt,
  updatedAt: grant.updatedAt,
  revokedAt: grant.revokedAt,
  companionScope: grant.companionScope
});

const ownedShareGrantDto = (grant: SharedMemoryGrantRecord) => {
  const { companionScope: _companionScope, ...ownerSafeGrant } =
    ownerGrantDto(grant);
  void _companionScope;
  return ownerSafeGrant;
};

const teamLogicalMemoryId = (grant: { id: string; logicalMemoryId: string }) =>
  sharedMemoryGrantScopedSourceId(grant.id, grant.logicalMemoryId);

const teamCompanionScopeDto = (
  grant: { id: string; logicalMemoryId: string },
  scope: SharedMemoryGrantRecord["companionScope"]
) => ({
  ...scope,
  logicalMemoryId: teamLogicalMemoryId(grant)
});

const teamGrantDto = (grant: SharedMemoryGrantRecord) => ({
  sourceCapabilities: grant.sourceCapabilities,
  activationRepresentation: grant.activationRepresentation,
  id: grant.id,
  logicalMemoryId: teamLogicalMemoryId(grant),
  teamId: grant.teamId,
  teamWorkspaceId: grant.teamWorkspaceId,
  mode: grant.mode,
  maximumFidelity: grant.maximumFidelity,
  includeCuratedMemory: grant.includeCuratedMemory,
  sourceRevision: grant.sourceRevision,
  grantVersion: grant.grantVersion,
  lifecycle: grant.lifecycle,
  createdAt: grant.createdAt,
  updatedAt: grant.updatedAt,
  revokedAt: grant.revokedAt,
  companionScope: teamCompanionScopeDto(grant, grant.companionScope)
});

const pendingShareDto = (pendingShare: PendingShareRecord) =>
  pendingShareSchema.parse({
    source: requiredSource(pendingShare.source),
    sourceCapabilities: pendingShare.sourceCapabilities,
    id: pendingShare.id,
    mutationId: pendingShare.mutationId,
    logicalGrantId: pendingShare.logicalGrantId,
    consentId: pendingShare.consentId,
    logicalMemoryId: pendingShare.logicalMemoryId,
    teamId: pendingShare.teamId,
    workspaceId: pendingShare.teamWorkspaceId,
    activationRepresentation: pendingShare.activationRepresentation,
    maximumFidelity: pendingShare.maximumFidelity,
    includeCuratedMemory: pendingShare.includeCuratedMemory,
    mode: pendingShare.mode,
    sourceRevision: pendingShare.sourceRevision,
    state: pendingShare.state,
    stage: pendingShare.stage,
    workspaceAccessState: pendingShare.workspaceAccessState,
    sourceUpdateState: pendingShare.sourceUpdateState,
    operationVersion: pendingShare.operationVersion,
    attemptCount: pendingShare.attemptCount,
    redactedFailureCode: pendingShare.redactedFailureCode,
    lastProgressAt: pendingShare.lastProgressAt,
    createdAt: pendingShare.createdAt,
    updatedAt: pendingShare.updatedAt,
    activatedAt: pendingShare.activatedAt,
    revokedAt: pendingShare.revokedAt,
    grantId: pendingShare.grantId,
    grantVersion: pendingShare.grantVersion ?? null
  });

const transcriptAccessDto = (grant: TeamConversationSourceGrantRecord) => ({
  id: grant.id,
  shareGrantId: grant.shareGrantId,
  sessionId: grant.sessionId,
  teamId: grant.teamId,
  teamWorkspaceId: grant.teamWorkspaceId,
  mode: grant.mode,
  maximumSegmentIndex: grant.maximumSegmentIndex,
  maximumSourceOffset: grant.maximumSourceOffset,
  version: grant.version,
  lifecycle: grant.lifecycle,
  createdAt: grant.createdAt,
  updatedAt: grant.updatedAt,
  revokedAt: grant.revokedAt
});

const teamRepresentationDto = (
  representation: SharedMemoryRepresentationRecord
) => ({
  id: representation.id,
  shareGrantId: representation.shareGrantId,
  teamId: representation.teamId,
  teamWorkspaceId: representation.teamWorkspaceId,
  logicalMemoryId: sharedMemoryGrantScopedSourceId(
    representation.shareGrantId,
    representation.logicalMemoryId
  ),
  representation: representation.representation,
  sourceRevision: representation.sourceRevision,
  recordVersion: representation.recordVersion,
  state: representation.state,
  chunkCount: representation.chunkCount,
  createdAt: representation.createdAt,
  updatedAt: representation.updatedAt,
  availableAt: representation.availableAt,
  staleAt: representation.staleAt,
  invalidatedAt: representation.invalidatedAt,
  invalidationReasonCode: representation.invalidationReasonCode
});

type WorkspaceIndexEntry = Awaited<
  ReturnType<SharedMemoryRepository["listWorkspaceGrants"]>
>["entries"][number];

type OwnedShareEntry = NonNullable<
  Awaited<ReturnType<SharedMemoryRepository["getOwnerShare"]>>
>;

const ownedShareDto = (entry: OwnedShareEntry) =>
  entry.kind === "grant"
    ? {
        kind: "grant" as const,
        grant: ownedShareGrantDto(entry.grant),
        sourceAccess: entry.sourceAccess,
        summary: entry.summary
      }
    : {
        kind: "pending" as const,
        pendingShare: pendingShareDto(entry.pendingShare),
        sourceAccess: entry.sourceAccess,
        summary: entry.summary
      };

const workspaceIndexEntryDto = (entry: WorkspaceIndexEntry) => ({
  id: entry.shareGrantId,
  logicalMemoryId: sharedMemoryGrantScopedSourceId(
    entry.shareGrantId,
    entry.logicalMemoryId
  ),
  ownerDisplayName: entry.ownerDisplayName,
  maximumFidelity: entry.maximumFidelity,
  includeCuratedMemory: entry.includeCuratedMemory,
  title: entry.title,
  activeRepresentation: entry.activeRepresentation,
  representationState: entry.representationState,
  representationSourceRevision: entry.representationSourceRevision,
  representationUpdatedAt: entry.representationUpdatedAt,
  freshness: entry.freshness,
  lifecycle: entry.lifecycle,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  companionScope: {
    ...entry.companionScope,
    logicalMemoryId: sharedMemoryGrantScopedSourceId(
      entry.shareGrantId,
      entry.logicalMemoryId
    )
  }
});

const validatedReadItems = (
  result: SharedMemoryReadResult
): SharedMemoryCanonicalSourceItemDto[] =>
  result.items.map((item) => {
    const validated = validateSharedMemoryCanonicalSourceItem({
      representation: result.representation.representation,
      logicalMemoryId: result.grant.logicalMemoryId,
      sourceRevision: result.representation.sourceRevision,
      item
    });
    return validated;
  });

const teamSourceItemDto = (
  grantId: string,
  logicalMemoryId: string,
  item: SharedMemoryCanonicalSourceItemDto
): SharedMemoryCanonicalSourceItemDto => {
  const expansionItems = item.content.expansionItems;
  const sourceIds = item.content.sourceIds;
  return {
    ...item,
    sourceId: sharedMemoryGrantScopedSourceId(grantId, item.sourceId),
    sourceLogicalMemoryId: logicalMemoryId,
    content: {
      ...item.content,
      ...(Array.isArray(sourceIds)
        ? {
            sourceIds: sourceIds.map((sourceId) =>
              sharedMemoryGrantScopedSourceId(grantId, String(sourceId))
            )
          }
        : {}),
      ...(Array.isArray(expansionItems)
        ? {
            expansionItems: (
              expansionItems as SharedMemoryCanonicalSourceItemDto[]
            ).map((child) => teamSourceItemDto(grantId, logicalMemoryId, child))
          }
        : {})
    }
  };
};

const readDto = (
  result: SharedMemoryReadResult,
  items: SharedMemoryCanonicalSourceItemDto[]
) => {
  const logicalMemoryId = teamLogicalMemoryId(result.grant);
  return {
    grant: teamGrantDto(result.grant),
    representation: teamRepresentationDto(result.representation),
    items: items.map((item) =>
      teamSourceItemDto(result.grant.id, logicalMemoryId, item)
    ),
    sourcePage: result.sourcePage,
    freshness: result.freshness,
    companionScope: teamCompanionScopeDto(result.grant, result.companionScope)
  };
};

const readScopedGrant = async (
  context: SharedMemoryRouteContext,
  actor: { id: string },
  scope: { teamId: string; teamWorkspaceId: string; shareGrantId: string },
  representation:
    | "memory_events"
    | "lcm_leaves"
    | "lcm_rollups"
    | "curated_assertions",
  page?: {
    direction: "older" | "newer";
    boundary?: number;
    limit: number;
  }
) => {
  const result = await executeRepositoryOperation(() =>
    context
      .requireSharedMemoryRepository()
      .readGrantRepresentation(
        { userId: actor.id },
        { shareGrantId: scope.shareGrantId, representation, page }
      )
  );
  if (
    !result ||
    result.grant.teamId !== scope.teamId ||
    result.grant.teamWorkspaceId !== scope.teamWorkspaceId ||
    result.companionScope.teamId !== scope.teamId ||
    result.companionScope.teamWorkspaceId !== scope.teamWorkspaceId ||
    result.representation.representation !== representation
  ) {
    throw forbidden();
  }
  const items = await executeRepositoryOperation(() =>
    validatedReadItems(result)
  );
  return { result, items };
};

export const registerSharedMemoryRoutes = (
  app: FastifyInstance,
  context: SharedMemoryRouteContext
): void => {
  app.put(
    "/v1/shared-memory/source-owner-policies/:logicalMemoryId",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const actor = await authenticateSourceOwner(request, context);
      const params = sourceOwnerPolicyParamsSchema.parse(request.params);
      const input = putSharedMemoryPolicySchema.parse(request.body);
      const policy = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .putSourceOwnerPolicy(
            { userId: actor.id },
            { ...input, logicalMemoryId: params.logicalMemoryId }
          )
      );
      return { policy: policyDto(policy) };
    }
  );

  app.put(
    "/v1/shared-memory/teams/:teamId/policy",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const actor = await authenticateSessionOnly(request, context);
      const params = teamPolicyParamsSchema.parse(request.params);
      const input = putSharedMemoryPolicySchema.parse(request.body);
      const policy = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .putTeamPolicy(
            { userId: actor.id },
            { ...input, teamId: params.teamId }
          )
      );
      return { policy: policyDto(policy) };
    }
  );

  app.put(
    "/v1/shared-memory/teams/:teamId/workspaces/:teamWorkspaceId/policy",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const actor = await authenticateSessionOnly(request, context);
      const params = workspacePolicyParamsSchema.parse(request.params);
      const input = putSharedMemoryPolicySchema.parse(request.body);
      const policy = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .putWorkspacePolicy({ userId: actor.id }, { ...input, ...params })
      );
      return { policy: policyDto(policy) };
    }
  );

  app.post(
    "/v1/shared-memory/candidate-previews",
    {
      preHandler: context.writeRateLimit,
      bodyLimit: SMALL_BODY_LIMIT_BYTES
    },
    async (request) => {
      rejectApiToken(request);
      const input = createSharedMemoryCandidatePreviewSchema.parse(
        request.body
      );
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryCandidatePreviewActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        ...input
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const admission =
              await repository.createSharedMemoryCandidatePreview(
                { userId: authenticated.actor.id },
                {
                  ...input,
                  ...(authenticated.kind === "device"
                    ? {
                        deviceCredentialId: authenticated.auth.credential.id
                      }
                    : {}),
                  authority: authenticated.authority
                }
              );
            if (!admission) return null;
            return {
              statusCode: 200,
              body: { admission }
            };
          }
        )
      );
      return result.body;
    }
  );

  app.post(
    "/v1/shared-memory/previews",
    {
      preHandler: context.writeRateLimit,
      bodyLimit: SMALL_BODY_LIMIT_BYTES
    },
    async (request) => {
      rejectApiToken(request);
      const input = createSharedMemoryPreviewSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryPreviewActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        source: input.source,
        sourceCapabilities: input.sourceCapabilities,
        logicalMemoryId: input.logicalMemoryId,
        remoteReplicaId: input.remoteReplicaId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        activationRepresentation: input.activationRepresentation,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        mode: input.mode
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const preview = await repository.createAuthoritativeSourcePreview(
              { userId: authenticated.actor.id },
              {
                logicalMemoryId: input.logicalMemoryId,
                remoteReplicaId: input.remoteReplicaId,
                teamId: input.teamId,
                teamWorkspaceId: input.teamWorkspaceId,
                sourceCapabilities: input.sourceCapabilities,
                activationRepresentation: input.activationRepresentation,
                mode: input.mode,
                maximumFidelity: input.maximumFidelity,
                includeCuratedMemory: input.includeCuratedMemory,
                authority: authenticated.authority
              }
            );
            if (
              preview.logicalMemoryId !== input.logicalMemoryId ||
              preview.remoteReplicaId !== input.remoteReplicaId ||
              preview.teamId !== input.teamId ||
              preview.teamWorkspaceId !== input.teamWorkspaceId ||
              preview.representation !== input.activationRepresentation ||
              preview.maximumFidelity !== input.maximumFidelity ||
              preview.includeCuratedMemory !== input.includeCuratedMemory
            ) {
              return null;
            }
            return {
              statusCode: 200,
              body: { preview: persistedPreviewDto(preview) }
            };
          }
        )
      );
      return result.body;
    }
  );

  app.post(
    "/v1/shared-memory/pending-shares",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      rejectApiToken(request);
      const input = createPendingShareSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryPendingShareActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        source: input.source,
        sourceCapabilities: input.sourceCapabilities,
        activationRepresentation: input.activationRepresentation,
        mutationId: input.mutationId,
        logicalGrantId: input.logicalGrantId,
        consentId: input.consentId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        previewId: input.preview.previewId,
        previewRevision: input.previewRevision,
        previewHash: input.preview.previewHash,
        mode: input.mode,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        expiresAt: input.expiresAt
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => ({
            statusCode: 202,
            body: {
              pendingShare: pendingShareDto(
                await repository.createPendingShare(
                  { userId: authenticated.actor.id },
                  {
                    mutationId: input.mutationId,
                    logicalGrantId: input.logicalGrantId,
                    consentId: input.consentId,
                    logicalMemoryId: input.logicalMemoryId,
                    source: input.source,
                    sourceCapabilities: input.sourceCapabilities,
                    activationRepresentation: input.activationRepresentation,
                    teamId: input.teamId,
                    teamWorkspaceId: input.teamWorkspaceId,
                    preview: input.preview,
                    previewRevision: input.previewRevision,
                    mode: input.mode,
                    maximumFidelity: input.maximumFidelity,
                    includeCuratedMemory: input.includeCuratedMemory,
                    expiresAt: input.expiresAt,
                    authority: authenticated.authority
                  }
                )
              )
            }
          })
        )
      );
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.put(
    "/v1/shared-memory/pending-shares/:pendingShareId/personal-note-source",
    {
      preHandler: context.writeRateLimit,
      bodyLimit: SOURCE_UPLOAD_BODY_LIMIT_BYTES
    },
    async (request) => {
      rejectApiToken(request);
      const params = z
        .object({ pendingShareId: z.uuid() })
        .strict()
        .parse(request.params);
      const input = personalNoteSourceArtifactUploadSchema.parse({
        ...(request.body as Record<string, unknown>),
        pendingShareId: params.pendingShareId
      });
      const authenticated = await context.authenticateDeviceCredential(request);
      if (
        !authenticated.credential.operationFamilies.includes(
          "share_grant_management"
        )
      ) {
        throw forbidden();
      }
      const preview = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .persistPersonalNoteSourceArtifact(
            { userId: authenticated.user.id },
            {
              ...input,
              deviceCredentialId: authenticated.credential.id
            }
          )
      );
      return { preview: persistedPreviewDto(preview) };
    }
  );

  app.post(
    "/v1/shared-memory/personal-note-revisions/advance",
    {
      preHandler: context.writeRateLimit,
      bodyLimit: SOURCE_UPLOAD_BODY_LIMIT_BYTES
    },
    async (request) => {
      rejectApiToken(request);
      const input = advanceContinuousPersonalNoteRevisionSchema.parse(
        request.body
      );
      const authenticated = await context.authenticateDeviceCredential(request);
      if (
        !authenticated.credential.operationFamilies.includes(
          "share_grant_management"
        )
      ) {
        throw forbidden();
      }
      const advancement = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .advanceContinuousPersonalNoteRevision(
            { userId: authenticated.user.id },
            {
              ...input,
              deviceCredentialId: authenticated.credential.id
            }
          )
      );
      return {
        pendingShares: advancement.pendingShares.map(pendingShareDto),
        outcomes: advancement.outcomes,
        nextShareGrantId: advancement.nextShareGrantId
      };
    }
  );

  app.put(
    "/v1/shared-memory/share-grants/:shareGrantId/fidelity-bundle",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      rejectApiToken(request);
      const params = shareGrantParamsSchema.parse(request.params);
      const input = changeSharedMemoryFidelityBundleSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryFidelityBundleActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        source: input.source,
        sourceCapabilities: input.sourceCapabilities,
        activationRepresentation: input.activationRepresentation,
        mutationId: input.mutationId,
        consentId: input.consentId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        shareGrantId: params.shareGrantId,
        previewId: input.preview.previewId,
        previewRevision: input.previewRevision,
        previewHash: input.preview.previewHash,
        mode: input.mode,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        expectedGrantVersion: input.expectedGrantVersion,
        expiresAt: input.expiresAt
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const pendingShare = await repository.createPendingFidelityChange(
              { userId: authenticated.actor.id },
              {
                source: input.source,
                sourceCapabilities: input.sourceCapabilities,
                activationRepresentation: input.activationRepresentation,
                mutationId: input.mutationId,
                shareGrantId: params.shareGrantId,
                consentId: input.consentId,
                logicalMemoryId: input.logicalMemoryId,
                teamId: input.teamId,
                teamWorkspaceId: input.teamWorkspaceId,
                expectedGrantVersion: input.expectedGrantVersion,
                preview: input.preview,
                previewRevision: input.previewRevision,
                maximumFidelity: input.maximumFidelity,
                includeCuratedMemory: input.includeCuratedMemory,
                mode: input.mode,
                expiresAt: input.expiresAt,
                authority: authenticated.authority
              }
            );
            return {
              statusCode: 202,
              body: {
                pendingShare: pendingShareDto(pendingShare)
              }
            };
          }
        )
      );
      return result.body;
    }
  );

  app.post(
    "/v1/shared-memory/share-grants/:shareGrantId/transcript-access/revoke",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      rejectApiToken(request);
      const params = shareGrantParamsSchema.parse(request.params);
      const input = revokeTeamConversationSourceGrantSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryTranscriptRevokeActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        mutationId: input.mutationId,
        teamId: input.teamId,
        shareGrantId: params.shareGrantId,
        expectedVersion: input.expectedVersion,
        reasonCode: input.reasonCode
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskTeamConversationSourceWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const grant = await repository.revokeTeamConversationSourceGrant(
              { userId: authenticated.actor.id },
              {
                mutationId: input.mutationId,
                shareGrantId: params.shareGrantId,
                teamId: input.teamId,
                expectedVersion: input.expectedVersion,
                reasonCode: input.reasonCode
              }
            );
            if (grant.lifecycle !== "revoked") {
              return null;
            }
            return {
              statusCode: 200,
              body: { transcriptAccess: transcriptAccessDto(grant) }
            };
          }
        )
      );
      return result.body;
    }
  );

  app.put(
    "/v1/shared-memory/share-grants/:shareGrantId/transcript-access",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      rejectApiToken(request);
      const params = shareGrantParamsSchema.parse(request.params);
      const input = putTeamConversationSourceGrantSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      requireFreshBrowserAuthority(authenticated);
      const binding = sharedMemoryTranscriptAccessActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        mutationId: input.mutationId,
        teamId: input.teamId,
        shareGrantId: params.shareGrantId,
        expectedVersion: input.expectedVersion,
        mode: input.mode
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskTeamConversationSourceWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const grant = await repository.putTeamConversationSourceGrant(
              { userId: authenticated.actor.id },
              {
                mutationId: input.mutationId,
                shareGrantId: params.shareGrantId,
                teamId: input.teamId,
                expectedVersion: input.expectedVersion,
                mode: input.mode,
                creatorAuthority: `${authenticated.authority.source}:${authenticated.authority.referenceId}`
              }
            );
            return {
              statusCode: input.expectedVersion === 0 ? 201 : 200,
              body: { transcriptAccess: transcriptAccessDto(grant) }
            };
          }
        )
      );
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.post(
    "/v1/shared-memory/share-grants/:shareGrantId/revoke",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      rejectApiToken(request);
      const params = shareGrantParamsSchema.parse(request.params);
      const input = revokeShareGrantSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryRevokeActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        mutationId: input.mutationId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        shareGrantId: params.shareGrantId,
        expectedGrantVersion: input.expectedGrantVersion,
        reasonCode: input.reasonCode
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const grant = await repository.revokeShareGrant(
              { userId: authenticated.actor.id },
              {
                mutationId: input.mutationId,
                shareGrantId: params.shareGrantId,
                expectedGrantVersion: input.expectedGrantVersion,
                reasonCode: input.reasonCode,
                authority: authenticated.authority
              }
            );
            if (
              grant.teamId !== input.teamId ||
              grant.teamWorkspaceId !== input.teamWorkspaceId ||
              grant.lifecycle !== "revoked"
            ) {
              return null;
            }
            return {
              statusCode: 200,
              body: { grant: ownedShareGrantDto(grant) }
            };
          }
        )
      );
      return result.body;
    }
  );

  app.get(
    "/v1/shared-memory/owned-shares",
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateSourceOwner(request, context);
      const query = listOwnedSharesQuerySchema.parse(request.query);
      const page = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .listOwnerShares({ userId: actor.id }, query)
      );
      return {
        shares: page.entries.map(ownedShareDto),
        pagination: {
          limit: page.limit,
          hasMore: page.hasMore,
          next: page.next,
          snapshotAt: page.snapshotAt
        }
      };
    }
  );

  app.get(
    "/v1/shared-memory/owned-shares/:kind/:id",
    { preHandler: context.readRateLimit },
    async (request, reply) => {
      const actor = await authenticateSourceOwner(request, context);
      const params = ownedShareParamsSchema.parse(request.params);
      const repository = context.requireSharedMemoryRepository();
      const share = await executeRepositoryOperation(() =>
        repository.getOwnerShare({ userId: actor.id }, params)
      );
      if (!share) return reply.status(404).send({ error: "not_found" });
      const preview = await executeRepositoryOperation(() =>
        repository.readOwnerSharePreview({ userId: actor.id }, params)
      );
      return {
        share: ownedShareDto(share),
        preview: preview ? persistedPreviewDto(preview) : null
      };
    }
  );

  app.post(
    "/v1/shared-memory/pending-shares/:pendingShareId/control",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      const actor = await authenticateSourceOwner(request, context);
      const params = shareGrantParamsSchema
        .transform(({ shareGrantId }) => ({ pendingShareId: shareGrantId }))
        .parse({
          shareGrantId: (request.params as { pendingShareId?: unknown })
            .pendingShareId
        });
      const input = controlPendingShareSchema.parse(request.body);
      const pendingShare = await executeRepositoryOperation(() =>
        context
          .requireSharedMemoryRepository()
          .controlPendingShare({ userId: actor.id }, { ...params, ...input })
      );
      return { pendingShare: pendingShareDto(pendingShare) };
    }
  );

  app.get(
    "/v1/shared-memory/logical-memories/:logicalMemoryId/share-grants",
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateSourceOwner(request, context);
      const params = sourceOwnerPolicyParamsSchema.parse(request.params);
      const query = listWorkspaceSharedMemoryQuerySchema.parse(request.query);
      const page = await executeRepositoryOperation(() =>
        context.requireSharedMemoryRepository().listOwnerGrants(
          { userId: actor.id },
          {
            logicalMemoryId: params.logicalMemoryId,
            limit: query.limit,
            offset: query.offset
          }
        )
      );
      if (
        page.limit !== query.limit ||
        page.offset !== query.offset ||
        page.entries.some(
          (grant) =>
            grant.logicalMemoryId !== params.logicalMemoryId ||
            grant.ownerUserId !== actor.id ||
            grant.companionScope.logicalMemoryId !== grant.logicalMemoryId ||
            grant.companionScope.shareGrantId !== grant.id ||
            grant.companionScope.teamId !== grant.teamId ||
            grant.companionScope.teamWorkspaceId !== grant.teamWorkspaceId
        )
      ) {
        throw forbidden();
      }
      return {
        shareGrants: page.entries.map(ownedShareGrantDto),
        pagination: {
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
          nextOffset: page.hasMore ? page.offset + page.entries.length : null
        }
      };
    }
  );

  const scopedGrantPath =
    "/v1/shared-memory/teams/:teamId/workspaces/:teamWorkspaceId/share-grants/:shareGrantId";

  app.get(
    "/v1/shared-memory/teams/:teamId/workspaces/:teamWorkspaceId/share-grants",
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateReader(request, context);
      const params = workspacePolicyParamsSchema.parse(request.params);
      const query = listWorkspaceSharedMemoryQuerySchema.parse(request.query);
      const page = await executeRepositoryOperation(() =>
        context.requireSharedMemoryRepository().listWorkspaceGrants(
          { userId: actor.id },
          {
            ...params,
            limit: query.limit,
            offset: query.offset
          }
        )
      );
      if (
        page.limit !== query.limit ||
        page.offset !== query.offset ||
        page.entries.some(
          (entry) =>
            entry.lifecycle !== "active" ||
            entry.companionScope.teamId !== params.teamId ||
            entry.companionScope.teamWorkspaceId !== params.teamWorkspaceId ||
            entry.companionScope.logicalMemoryId !== entry.logicalMemoryId ||
            entry.companionScope.shareGrantId !== entry.shareGrantId
        )
      ) {
        throw forbidden();
      }
      return {
        shareGrants: page.entries.map(workspaceIndexEntryDto),
        pagination: {
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
          nextOffset: page.hasMore ? page.offset + page.entries.length : null
        }
      };
    }
  );

  app.get(
    scopedGrantPath,
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateReader(request, context);
      const params = scopedShareGrantParamsSchema.parse(request.params);
      const query = readGrantRepresentationQuerySchema.parse(request.query);
      const { result, items } = await readScopedGrant(
        context,
        actor,
        params,
        query.representation
      );
      return { sharedMemory: readDto(result, items) };
    }
  );

  app.get(
    `${scopedGrantPath}/initial-view`,
    { preHandler: context.readRateLimit },
    async (request) => {
      const workspaceActor = await authenticateReader(request, context);
      const chatActor = await context.authenticateSessionOrDeviceCredential(
        request,
        "team_chat_read",
        {
          apiTokenError: "API Tokens cannot authorize Shared Memory operations"
        }
      );
      if (workspaceActor.id !== chatActor.id) throw forbidden();
      const params = scopedShareGrantParamsSchema.parse(request.params);
      const query = readGrantRepresentationPageQuerySchema.parse(request.query);
      const { result, items } = await readScopedGrant(
        context,
        workspaceActor,
        params,
        query.representation,
        query
      );
      const repository = context.requireCollaborationRepository();
      const snapshot = await repository.getAuthorizedSnapshot(
        { userId: workspaceActor.id },
        {
          scope: "team",
          teamId: params.teamId,
          includeArchived: false
        }
      );
      const resolvedThread = snapshot?.threads.find(
        (candidate) =>
          candidate.teamWorkspaceId === params.teamWorkspaceId &&
          candidate.kind === "shared_session_discussion" &&
          candidate.sharedLogicalMemoryId === result.grant.logicalMemoryId &&
          candidate.shareGrantId === params.shareGrantId
      );
      if (
        !resolvedThread ||
        resolvedThread.teamId !== result.grant.companionScope.teamId ||
        resolvedThread.teamWorkspaceId !==
          result.grant.companionScope.teamWorkspaceId
      ) {
        throw forbidden();
      }
      const messages = await repository.listMessages(
        { userId: workspaceActor.id },
        {
          threadId: resolvedThread.id,
          beforeSequence: resolvedThread.latestSequence + 1,
          limit: 100
        }
      );
      if (
        !messages ||
        messages.messages.some(
          (message) =>
            message.threadId !== resolvedThread.id ||
            message.scope !== "team" ||
            message.teamId !== params.teamId ||
            message.teamWorkspaceId !== params.teamWorkspaceId
        )
      ) {
        throw forbidden();
      }
      return {
        sharedMemory: readDto(result, items),
        companion: {
          thread: publicCollaborationThread(resolvedThread),
          messages
        }
      };
    }
  );

  app.get(
    `${scopedGrantPath}/page`,
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateReader(request, context);
      const params = scopedShareGrantParamsSchema.parse(request.params);
      const query = readGrantRepresentationPageQuerySchema.parse(request.query);
      const { result, items } = await readScopedGrant(
        context,
        actor,
        params,
        query.representation,
        query
      );
      return {
        sharedMemory: readDto(result, items)
      };
    }
  );

  app.get(
    `${scopedGrantPath}/items`,
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateReader(request, context);
      const params = scopedShareGrantParamsSchema.parse(request.params);
      const query = readGrantRepresentationQuerySchema.parse(request.query);
      const { result, items } = await readScopedGrant(
        context,
        actor,
        params,
        query.representation
      );
      return {
        grant: teamGrantDto(result.grant),
        representation: teamRepresentationDto(result.representation),
        freshness: result.freshness,
        companionScope: teamCompanionScopeDto(
          result.grant,
          result.companionScope
        ),
        items: items.map((item) => ({
          itemType: item.itemType,
          schemaVersion: item.schemaVersion,
          sourceId: sharedMemoryGrantScopedSourceId(
            result.grant.id,
            item.sourceId
          ),
          sourceRevision: item.sourceRevision,
          occurredAt: item.occurredAt
        }))
      };
    }
  );

  app.get(
    `${scopedGrantPath}/items/:sourceId`,
    { preHandler: context.readRateLimit },
    async (request) => {
      const actor = await authenticateReader(request, context);
      const params = sharedMemoryItemDetailParamsSchema.parse(request.params);
      const query = readGrantRepresentationQuerySchema.parse(request.query);
      const { result, items } = await readScopedGrant(
        context,
        actor,
        params,
        query.representation
      );
      const item = items.find(
        (candidate) =>
          sharedMemoryGrantScopedSourceId(
            result.grant.id,
            candidate.sourceId
          ) === params.sourceId
      );
      if (!item) throw notFound();
      return {
        grant: teamGrantDto(result.grant),
        representation: teamRepresentationDto(result.representation),
        freshness: result.freshness,
        companionScope: teamCompanionScopeDto(
          result.grant,
          result.companionScope
        ),
        item: teamSourceItemDto(
          result.grant.id,
          teamLogicalMemoryId(result.grant),
          item
        )
      };
    }
  );
};
