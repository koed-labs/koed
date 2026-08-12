import type {
  CollaborationRepository,
  SharedMemoryAuthorityContext,
  SharedMemoryConsentRecord,
  SharedMemoryGrantRecord,
  SharedMemoryPolicyRecord,
  SharedMemoryReadResult,
  SharedMemoryRedactedSourceItemDto,
  SharedMemoryRepository,
  SharedMemoryRepresentationRecord,
  TeamConversationSourceGrantRecord,
  TeamConversationSourceRepository,
  DeviceCredentialAuthContext,
  HighRiskActionRepository
} from "@koed/db";
import { defaultFreshAuthenticationMaxAgeMs } from "@koed/db";
import {
  sharedMemoryConsentActionGrantBinding,
  sharedMemoryPreviewActionGrantBinding,
  sharedMemoryRepresentationBundleActionGrantBinding,
  sharedMemoryRepresentationActionGrantBinding,
  sharedMemoryRevokeActionGrantBinding,
  sharedMemoryShareActionGrantBinding,
  sharedMemoryShareBundleActionGrantBinding,
  sharedMemoryTranscriptAccessActionGrantBinding,
  sharedMemoryTranscriptRevokeActionGrantBinding,
  type SharedMemoryActionGrantBinding
} from "@koed/shared";
import {
  redactEligibleSharedMemorySourceItem,
  SHARED_MEMORY_AUTHORITY,
  SharedMemoryAuthorizationError,
  SharedMemoryConflictError,
  SharedMemorySourceItemRejectedError,
  TeamConversationSourceAuthorizationError,
  TeamConversationSourceConflictError
} from "@koed/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ApiRouteContext } from "../server/context.js";
import { changeRepresentationBundle, createShareBundle } from "./bundles.js";
import {
  createShareGrantSchema,
  createSharedMemoryShareBundleSchema,
  changeSharedMemoryRepresentationBundleSchema,
  createSharedMemoryPreviewSchema,
  createSourceOwnerConsentSchema,
  listWorkspaceSharedMemoryQuerySchema,
  materializeGrantRepresentationSchema,
  putSharedMemoryPolicySchema,
  putTeamConversationSourceGrantSchema,
  readGrantRepresentationPageQuerySchema,
  readGrantRepresentationQuerySchema,
  representationParamsSchema,
  revokeShareGrantSchema,
  revokeTeamConversationSourceGrantSchema,
  scopedShareGrantParamsSchema,
  selectGrantRepresentationSchema,
  shareGrantParamsSchema,
  sharedMemoryItemDetailParamsSchema,
  sourceOwnerPolicyParamsSchema,
  teamPolicyParamsSchema,
  workspacePolicyParamsSchema
} from "./schemas.js";

const SMALL_BODY_LIMIT_BYTES = 32 * 1_024;

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
  if (!result) throw forbidden();
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
  if (!result) throw forbidden();
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

const secretOutputKeys = new Set([
  "actiongrant",
  "apikey",
  "authorization",
  "confirmationchallenge",
  "cookie",
  "credential",
  "devicecredential",
  "devicesecret",
  "invitecode",
  "invitesecret",
  "invitetoken",
  "password",
  "privatekey",
  "rawdevicesecret",
  "rawinvitesecret",
  "refreshtoken",
  "secret",
  "session",
  "token"
]);

const encryptionEnvelopeKeys = new Set([
  "ciphertext",
  "encryptedenvelope",
  "encryptedpayload",
  "encryptionenvelope",
  "keyenvelope",
  "nonce",
  "wrappedkey"
]);

const normalizedOutputKey = (key: string): string =>
  key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

const sanitizeStructuredOutput = (
  value: unknown,
  state: { depth: number; keys: { count: number } } = {
    depth: 0,
    keys: { count: 0 }
  }
): unknown => {
  if (state.depth > 16 || state.keys.count > 2_000) {
    throw new SharedMemorySourceItemRejectedError("invalid_item_schema");
  }
  if (Array.isArray(value)) {
    state.keys.count += value.length;
    return value.map((item) =>
      sanitizeStructuredOutput(item, {
        depth: state.depth + 1,
        keys: state.keys
      })
    );
  }
  if (typeof value !== "object" || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    state.keys.count += 1;
    const normalizedKey = normalizedOutputKey(key);
    if (encryptionEnvelopeKeys.has(normalizedKey)) {
      throw new SharedMemorySourceItemRejectedError(
        "unsupported_protocol_item"
      );
    }
    output[key] = secretOutputKeys.has(normalizedKey)
      ? "[REDACTED]"
      : sanitizeStructuredOutput(item, {
          depth: state.depth + 1,
          keys: state.keys
        });
  }
  return output;
};

const policyDto = (policy: SharedMemoryPolicyRecord) => ({
  id: policy.id,
  policyId: policy.policyId,
  scope: policy.scope,
  logicalMemoryId: policy.logicalMemoryId,
  teamId: policy.teamId,
  teamWorkspaceId: policy.teamWorkspaceId,
  version: policy.version,
  allowedRepresentations: policy.allowedRepresentations,
  policyHash: policy.policyHash,
  effectiveAt: policy.effectiveAt,
  supersededAt: policy.supersededAt
});

const persistedPreviewDto = (preview: SharedMemoryPersistedPreviewRecord) => ({
  previewId: preview.previewId,
  previewHash: preview.previewHash,
  previewRevision: preview.previewRevision,
  logicalMemoryId: preview.logicalMemoryId,
  teamId: preview.teamId,
  teamWorkspaceId: preview.teamWorkspaceId,
  representation: preview.representation,
  binding: preview.binding,
  items: preview.items,
  redactedContentHash: preview.redactedContentHash,
  sourceRevision: preview.sourceRevision,
  sourceHash: preview.sourceHash,
  createdAt: preview.createdAt
});

const consentDto = (consent: SharedMemoryConsentRecord) => ({
  id: consent.id,
  logicalMemoryId: consent.logicalMemoryId,
  teamId: consent.teamId,
  teamWorkspaceId: consent.teamWorkspaceId,
  sourceOwnerPolicyId: consent.sourceOwnerPolicyId,
  sourceOwnerPolicyVersion: consent.sourceOwnerPolicyVersion,
  teamPolicyId: consent.teamPolicyId,
  teamPolicyVersion: consent.teamPolicyVersion,
  workspacePolicyId: consent.workspacePolicyId,
  workspacePolicyVersion: consent.workspacePolicyVersion,
  mode: consent.mode,
  state: consent.state,
  consentVersion: consent.consentVersion,
  allowedRepresentations: consent.allowedRepresentations,
  selectedRepresentation: consent.selectedRepresentation,
  previewRevision: consent.previewRevision,
  previewHash: consent.previewHash,
  sourceRevision: consent.sourceRevision,
  maximumAuthorizedSourceRevision: consent.maximumAuthorizedSourceRevision,
  sourceHash: consent.sourceHash,
  representationPolicyRevision: consent.representationPolicyRevision,
  representationPolicyHash: consent.representationPolicyHash,
  contentPolicyVersion: consent.contentPolicyVersion,
  contentPolicyHash: consent.contentPolicyHash,
  classifierVersion: consent.classifierVersion,
  classifierHash: consent.classifierHash,
  redactedContentHash: consent.redactedContentHash,
  createdAt: consent.createdAt,
  updatedAt: consent.updatedAt,
  activatedAt: consent.activatedAt,
  revokedAt: consent.revokedAt
});

const grantDto = (grant: SharedMemoryGrantRecord) => ({
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
  ownerAllowedRepresentations: grant.ownerAllowedRepresentations,
  activeRepresentation: grant.activeRepresentation,
  representationPolicyRevision: grant.representationPolicyRevision,
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

const representationDto = (
  representation: SharedMemoryRepresentationRecord
) => ({
  id: representation.id,
  shareGrantId: representation.shareGrantId,
  consentId: representation.consentId,
  teamId: representation.teamId,
  teamWorkspaceId: representation.teamWorkspaceId,
  logicalMemoryId: representation.logicalMemoryId,
  representation: representation.representation,
  sourceRevision: representation.sourceRevision,
  sourceRevisionHash: representation.sourceRevisionHash,
  provenanceHash: representation.provenanceHash,
  sourceOwnerPolicyId: representation.sourceOwnerPolicyId,
  sourceOwnerPolicyVersion: representation.sourceOwnerPolicyVersion,
  teamPolicyId: representation.teamPolicyId,
  teamPolicyVersion: representation.teamPolicyVersion,
  workspacePolicyId: representation.workspacePolicyId,
  workspacePolicyVersion: representation.workspacePolicyVersion,
  representationPolicyRevision: representation.representationPolicyRevision,
  contentPolicyVersion: representation.contentPolicyVersion,
  classifierVersion: representation.classifierVersion,
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

type OwnerGrantEntry = Awaited<
  ReturnType<SharedMemoryRepository["listOwnerGrants"]>
>["entries"][number];

const ownerGrantDto = (grant: OwnerGrantEntry) => grantDto(grant);

const workspaceIndexEntryDto = (entry: WorkspaceIndexEntry) => ({
  id: entry.shareGrantId,
  logicalMemoryId: entry.logicalMemoryId,
  ownerUserId: entry.ownerUserId,
  activeRepresentation: entry.activeRepresentation,
  representationState: entry.representationState,
  representationSourceRevision: entry.representationSourceRevision,
  representationUpdatedAt: entry.representationUpdatedAt,
  freshness: entry.freshness,
  lifecycle: entry.lifecycle,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  companionScope: entry.companionScope
});

const validatedReadItems = (
  result: SharedMemoryReadResult
): SharedMemoryRedactedSourceItemDto[] =>
  result.items.map((item) => {
    const validated = redactEligibleSharedMemorySourceItem({
      representation: result.representation.representation,
      logicalMemoryId: result.grant.logicalMemoryId,
      sourceRevision: result.representation.sourceRevision,
      item
    });
    return {
      ...validated,
      content: sanitizeStructuredOutput(validated.content) as Record<
        string,
        unknown
      >
    };
  });

const readDto = (
  result: SharedMemoryReadResult,
  items: SharedMemoryRedactedSourceItemDto[]
) => ({
  grant: grantDto(result.grant),
  representation: representationDto(result.representation),
  items,
  sourcePage: result.sourcePage,
  freshness: result.freshness,
  companionScope: result.companionScope
});

const readScopedGrant = async (
  context: SharedMemoryRouteContext,
  actor: { id: string },
  scope: { teamId: string; teamWorkspaceId: string; shareGrantId: string },
  representation?:
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
    (representation !== undefined &&
      result.representation.representation !== representation)
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
        logicalMemoryId: input.logicalMemoryId,
        remoteReplicaId: input.remoteReplicaId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        representation: input.representation,
        allowedRepresentations: input.allowedRepresentations
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
                representation: input.representation,
                allowedRepresentations: input.allowedRepresentations,
                authority: authenticated.authority
              }
            );
            if (
              preview.logicalMemoryId !== input.logicalMemoryId ||
              preview.remoteReplicaId !== input.remoteReplicaId ||
              preview.teamId !== input.teamId ||
              preview.teamWorkspaceId !== input.teamWorkspaceId ||
              preview.representation !== input.representation
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
    "/v1/shared-memory/teams/:teamId/workspaces/:teamWorkspaceId/consents",
    {
      preHandler: context.writeRateLimit,
      bodyLimit: SMALL_BODY_LIMIT_BYTES
    },
    async (request, reply) => {
      rejectApiToken(request);
      const params = workspacePolicyParamsSchema.parse(request.params);
      const input = createSourceOwnerConsentSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryConsentActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        consentId: input.consentId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: params.teamId,
        teamWorkspaceId: params.teamWorkspaceId,
        previewId: input.preview.previewId,
        mode: input.mode,
        allowedRepresentations: input.allowedRepresentations,
        selectedRepresentation: input.selectedRepresentation,
        previewRevision: input.previewRevision,
        previewHash: input.preview.previewHash,
        expiresAt: input.expiresAt
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const consent = await repository.createSourceOwnerConsent(
              { userId: authenticated.actor.id },
              {
                consentId: input.consentId,
                preview: input.preview,
                mode: input.mode,
                allowedRepresentations: input.allowedRepresentations,
                selectedRepresentation: input.selectedRepresentation,
                expiresAt: input.expiresAt,
                authority: authenticated.authority
              }
            );
            if (
              consent.logicalMemoryId !== input.logicalMemoryId ||
              consent.teamId !== params.teamId ||
              consent.teamWorkspaceId !== params.teamWorkspaceId ||
              consent.previewId !== input.preview.previewId ||
              consent.previewRevision !== input.previewRevision ||
              consent.previewHash !== input.preview.previewHash
            ) {
              return null;
            }
            return {
              statusCode: 201,
              body: { consent: consentDto(consent) }
            };
          }
        )
      );
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.post(
    "/v1/shared-memory/share-bundles",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      rejectApiToken(request);
      const input = createSharedMemoryShareBundleSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryShareBundleActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
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
        allowedRepresentations: input.allowedRepresentations,
        selectedRepresentation: input.selectedRepresentation,
        expiresAt: input.expiresAt
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const bundle = await createShareBundle(
              repository,
              { userId: authenticated.actor.id },
              {
                consent: {
                  consentId: input.consentId,
                  preview: input.preview,
                  mode: input.mode,
                  allowedRepresentations: input.allowedRepresentations,
                  selectedRepresentation: input.selectedRepresentation,
                  expiresAt: input.expiresAt,
                  authority: authenticated.authority
                },
                grant: {
                  mutationId: input.mutationId,
                  logicalGrantId: input.logicalGrantId,
                  consentId: input.consentId,
                  authority: authenticated.authority
                },
                expected: {
                  consentId: input.consentId,
                  logicalMemoryId: input.logicalMemoryId,
                  teamId: input.teamId,
                  teamWorkspaceId: input.teamWorkspaceId,
                  previewId: input.preview.previewId,
                  previewRevision: input.previewRevision,
                  previewHash: input.preview.previewHash
                }
              }
            );
            if (!bundle) return null;
            return {
              statusCode: 201,
              body: {
                consent: consentDto(bundle.consent),
                grant: grantDto(bundle.grant)
              }
            };
          }
        )
      );
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.post(
    "/v1/shared-memory/share-grants",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request, reply) => {
      rejectApiToken(request);
      const input = createShareGrantSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryShareActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        mutationId: input.mutationId,
        logicalGrantId: input.logicalGrantId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        consentId: input.consentId
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const grant = await repository.createShareGrant(
              { userId: authenticated.actor.id },
              {
                mutationId: input.mutationId,
                logicalGrantId: input.logicalGrantId,
                consentId: input.consentId,
                authority: authenticated.authority
              }
            );
            if (
              grant.logicalMemoryId !== input.logicalMemoryId ||
              grant.teamId !== input.teamId ||
              grant.teamWorkspaceId !== input.teamWorkspaceId
            ) {
              return null;
            }
            return {
              statusCode: 201,
              body: { grant: grantDto(grant) }
            };
          }
        )
      );
      return reply.status(result.statusCode).send(result.body);
    }
  );

  app.put(
    "/v1/shared-memory/share-grants/:shareGrantId/representation-bundle",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      rejectApiToken(request);
      const params = shareGrantParamsSchema.parse(request.params);
      const input = changeSharedMemoryRepresentationBundleSchema.parse(
        request.body
      );
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryRepresentationBundleActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
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
        allowedRepresentations: input.allowedRepresentations,
        representation: input.representation,
        expectedGrantVersion: input.expectedGrantVersion,
        expiresAt: input.expiresAt
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const bundle = await changeRepresentationBundle(
              repository,
              { userId: authenticated.actor.id },
              {
                consent: {
                  consentId: input.consentId,
                  preview: input.preview,
                  mode: input.mode,
                  allowedRepresentations: input.allowedRepresentations,
                  selectedRepresentation: input.representation,
                  expiresAt: input.expiresAt,
                  authority: authenticated.authority
                },
                representation: {
                  mutationId: input.mutationId,
                  shareGrantId: params.shareGrantId,
                  consentId: input.consentId,
                  representation: input.representation,
                  expectedGrantVersion: input.expectedGrantVersion,
                  authority: authenticated.authority
                },
                expected: {
                  consentId: input.consentId,
                  logicalMemoryId: input.logicalMemoryId,
                  teamId: input.teamId,
                  teamWorkspaceId: input.teamWorkspaceId,
                  previewId: input.preview.previewId,
                  previewRevision: input.previewRevision,
                  previewHash: input.preview.previewHash,
                  representation: input.representation
                }
              }
            );
            if (!bundle) return null;
            return {
              statusCode: 200,
              body: {
                consent: consentDto(bundle.consent),
                grant: grantDto(bundle.grant)
              }
            };
          }
        )
      );
      return result.body;
    }
  );

  app.put(
    "/v1/shared-memory/share-grants/:shareGrantId/representation",
    { preHandler: context.writeRateLimit, bodyLimit: SMALL_BODY_LIMIT_BYTES },
    async (request) => {
      rejectApiToken(request);
      const params = shareGrantParamsSchema.parse(request.params);
      const input = selectGrantRepresentationSchema.parse(request.body);
      const authenticated = await authenticateSourceOwnerAuthority(
        request,
        context,
        input.authority
      );
      const binding = sharedMemoryRepresentationActionGrantBinding({
        referenceId: authenticated.authority.referenceId,
        mutationId: input.mutationId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        shareGrantId: params.shareGrantId,
        consentId: input.consentId,
        representation: input.representation,
        expectedGrantVersion: input.expectedGrantVersion
      });
      const result = await executeRepositoryOperation(() =>
        runHighRiskSharedMemoryWrite(
          context,
          authenticated,
          binding,
          async (repository) => {
            const grant = await repository.selectGrantRepresentation(
              { userId: authenticated.actor.id },
              {
                mutationId: input.mutationId,
                shareGrantId: params.shareGrantId,
                consentId: input.consentId,
                representation: input.representation,
                expectedGrantVersion: input.expectedGrantVersion,
                authority: authenticated.authority
              }
            );
            if (
              grant.teamId !== input.teamId ||
              grant.teamWorkspaceId !== input.teamWorkspaceId ||
              grant.activeRepresentation !== input.representation
            ) {
              return null;
            }
            return { statusCode: 200, body: { grant: grantDto(grant) } };
          }
        )
      );
      return result.body;
    }
  );

  app.put(
    "/v1/shared-memory/share-grants/:shareGrantId/representations/:representation",
    {
      preHandler: context.writeRateLimit,
      bodyLimit: SMALL_BODY_LIMIT_BYTES
    },
    async (request) => {
      const actor = await authenticateSourceOwner(request, context);
      const params = representationParamsSchema.parse(request.params);
      const input = materializeGrantRepresentationSchema.parse(request.body);
      const representation = await executeRepositoryOperation(() =>
        context.requireSharedMemoryRepository().materializeGrantRepresentation(
          { userId: actor.id },
          {
            mutationId: input.mutationId,
            shareGrantId: params.shareGrantId,
            consentId: input.consentId,
            expectedGrantVersion: input.expectedGrantVersion,
            expectedRepresentationVersion: input.expectedRepresentationVersion,
            preview: input.preview
          }
        )
      );
      if (
        representation.shareGrantId !== params.shareGrantId ||
        representation.representation !== params.representation
      ) {
        throw forbidden();
      }
      return { representation: representationDto(representation) };
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
            return { statusCode: 200, body: { grant: grantDto(grant) } };
          }
        )
      );
      return result.body;
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
        shareGrants: page.entries.map(ownerGrantDto),
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
            (entry.representationState !== "available" &&
              entry.representationState !== "stale") ||
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
          thread: resolvedThread,
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
        grant: grantDto(result.grant),
        representation: representationDto(result.representation),
        freshness: result.freshness,
        companionScope: result.companionScope,
        items: items.map((item) => ({
          itemType: item.itemType,
          schemaVersion: item.schemaVersion,
          sourceId: item.sourceId,
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
        (candidate) => candidate.sourceId === params.sourceId
      );
      if (!item) throw notFound();
      return {
        grant: grantDto(result.grant),
        representation: representationDto(result.representation),
        freshness: result.freshness,
        companionScope: result.companionScope,
        item
      };
    }
  );
};
