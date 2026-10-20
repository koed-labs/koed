import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "./high-risk-action-grant-hash.js";
import type { SharedMemorySourceRef } from "./shared-memory-source.js";
import type { SharedMemoryFidelityCeiling } from "./shared-memory-fidelity.js";

export const SHARED_MEMORY_AUTHORITY_ACTION =
  "workspace.memory.share_owned" as const;

// Internal only: a future Workspace Project operation must consume its own
// exact approved outer action before using this stage. It is deliberately
// absent from the client action-grant registry and has no public route.
export const PROJECT_LIFECYCLE_FREEZE_PARENT_ACTIONS = [
  "workspace_project.delete",
  "workspace_project.member_remove",
  "workspace_project.leave",
  "project_source.team_metadata.delete",
  "team.leave",
  "team.member.disable",
  "team.workspace.access_update"
] as const;

export type ProjectLifecycleFreezeParentAction =
  (typeof PROJECT_LIFECYCLE_FREEZE_PARENT_ACTIONS)[number];

export interface ProjectLifecycleFreezeStageBinding {
  action: "project.lifecycle.freeze_grant";
  outerAction: ProjectLifecycleFreezeParentAction;
  outerActionGrantId: string;
  outerMutationId: string;
  outerTargetId: string;
  teamId: string;
  teamWorkspaceId: string;
  targetUserId: string;
  shareGrantId: string;
  expectedGrantVersion: number;
  effect: "delete" | "remove" | "leave" | "disable";
}

export const projectLifecycleFreezeStageBindingHash = (
  input: ProjectLifecycleFreezeStageBinding
): string => {
  const effects: Record<
    ProjectLifecycleFreezeParentAction,
    ProjectLifecycleFreezeStageBinding["effect"]
  > = {
    "workspace_project.delete": "delete",
    "workspace_project.member_remove": "remove",
    "workspace_project.leave": "leave",
    "project_source.team_metadata.delete": "delete",
    "team.leave": "leave",
    "team.member.disable": "disable",
    "team.workspace.access_update": "disable"
  };
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (
    input.action !== "project.lifecycle.freeze_grant" ||
    !Object.prototype.hasOwnProperty.call(effects, input.outerAction) ||
    effects[input.outerAction] !== input.effect ||
    !Number.isSafeInteger(input.expectedGrantVersion) ||
    input.expectedGrantVersion < 1 ||
    [
      input.outerActionGrantId,
      input.outerMutationId,
      input.outerTargetId,
      input.teamId,
      input.teamWorkspaceId,
      input.targetUserId,
      input.shareGrantId
    ].some((value) => !uuid.test(value))
  ) {
    throw new TypeError("Project lifecycle freeze stage binding is incomplete");
  }
  return highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.sharedMemoryScope,
    input
  );
};

export type SharedMemoryRepresentation =
  | SharedMemoryFidelityCeiling
  | "curated_assertions";

export interface SharedMemoryActionGrantBinding {
  operationFamily: "share_grant_management";
  action: string;
  teamId: string;
  targetId: string;
  method: "POST" | "PUT";
  path: string;
  body: Record<string, unknown>;
  scopeHash: string;
  requestHash: string;
}

export const sourceAdmissionActionGrantBinding = (input: {
  referenceId: string;
  source: SharedMemorySourceRef;
  sourceDeploymentProtocolId: string;
  sourceOwnerPrincipalId: string;
  logicalMemoryId: string;
  batchId: string;
  expectedGeneration: number;
  expectedHoldVersion: number;
  operation: "prepare" | "seal" | "cancel";
}): Omit<SharedMemoryActionGrantBinding, "teamId"> & { teamId: null } => {
  const action = `shared_memory.source_admission.${input.operation}`;
  const path = `/v1/shared-memory/sources/${input.logicalMemoryId}/admission`;
  const body = {
    source: input.source,
    sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
    sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
    operation: input.operation,
    batchId: input.batchId,
    expectedGeneration: input.expectedGeneration,
    expectedHoldVersion: input.expectedHoldVersion,
    authority: authorityBody(input.referenceId)
  };
  return {
    operationFamily: "share_grant_management",
    action,
    teamId: null,
    targetId: input.logicalMemoryId,
    method: "POST",
    path,
    body,
    scopeHash: sharedMemoryGrantManagementScopeHash({
      action,
      teamId: null,
      targetId: input.logicalMemoryId
    }),
    requestHash: sharedMemoryGrantManagementRequestHash({
      method: "POST",
      path,
      body
    })
  };
};

export const sharedMemoryGrantManagementScopeHash = (input: {
  action: string;
  teamId: string | null;
  targetId: string | null;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.sharedMemoryScope,
    {
      operationFamily: "share_grant_management",
      action: input.action,
      teamId: input.teamId,
      targetId: input.targetId
    }
  );

export const sharedMemoryGrantManagementRequestHash = (input: {
  method: string;
  path: string;
  body: unknown;
}): string =>
  highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.sharedMemoryRequest,
    input
  );

const authorityBody = (referenceId: string) => ({
  action: SHARED_MEMORY_AUTHORITY_ACTION,
  source: "device_action_grant" as const,
  referenceId
});

const withHashes = (
  input: Omit<SharedMemoryActionGrantBinding, "scopeHash" | "requestHash">
): SharedMemoryActionGrantBinding => ({
  ...input,
  scopeHash: sharedMemoryGrantManagementScopeHash(input),
  requestHash: sharedMemoryGrantManagementRequestHash(input)
});

const shareIntentScope = <T extends { referenceId: string }>(
  input: T
): string => {
  const scope = { ...input };
  Reflect.deleteProperty(scope, "referenceId");
  Reflect.deleteProperty(scope, "authority");
  return highRiskActionGrantCanonicalHash(
    HIGH_RISK_ACTION_GRANT_HASH_DOMAINS.sharedMemoryScope,
    scope
  );
};

export const sharedMemoryPreviewActionGrantBinding = (input: {
  referenceId: string;
  source: SharedMemorySourceRef;
  sourceCapabilities: readonly SharedMemoryRepresentation[];
  logicalMemoryId: string;
  remoteReplicaId: string;
  teamId: string;
  teamWorkspaceId: string;
  activationRepresentation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  mode: "snapshot" | "continuous";
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.preview.${shareIntentScope(input)}`,
    teamId: input.teamId,
    targetId: input.remoteReplicaId,
    method: "POST",
    path: "/v1/shared-memory/previews",
    body: {
      source: input.source,
      sourceCapabilities: input.sourceCapabilities,
      logicalMemoryId: input.logicalMemoryId,
      remoteReplicaId: input.remoteReplicaId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      activationRepresentation: input.activationRepresentation,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      mode: input.mode,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryCandidatePreviewActionGrantBinding = (input: {
  referenceId: string;
  source: SharedMemorySourceRef;
  sourceDeploymentProtocolId: string;
  sourceOwnerPrincipalId: string;
  sourceCapabilities: readonly SharedMemoryRepresentation[];
  logicalMemoryId: string;
  candidateHash: string;
  sourceRevision: number;
  itemCount: number;
  byteCount: number;
  excludedItemCount: number;
  manifest: Array<{ sourceId: string; revisionHash: string }>;
  teamId: string;
  teamWorkspaceId: string;
  activationRepresentation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  mode: "snapshot" | "continuous";
  expiresAt?: string | null;
}): SharedMemoryActionGrantBinding => {
  const normalizedInput = { ...input, expiresAt: input.expiresAt ?? null };
  return withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.candidate_preview.${shareIntentScope(normalizedInput)}`,
    teamId: input.teamId,
    targetId: input.logicalMemoryId,
    method: "POST",
    path: "/v1/shared-memory/candidate-previews",
    body: {
      source: input.source,
      sourceDeploymentProtocolId: input.sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: input.sourceOwnerPrincipalId,
      sourceCapabilities: input.sourceCapabilities,
      logicalMemoryId: input.logicalMemoryId,
      candidateHash: input.candidateHash,
      sourceRevision: input.sourceRevision,
      itemCount: input.itemCount,
      byteCount: input.byteCount,
      excludedItemCount: input.excludedItemCount,
      manifest: input.manifest,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      activationRepresentation: input.activationRepresentation,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      mode: input.mode,
      expiresAt: input.expiresAt ?? null,
      authority: authorityBody(input.referenceId)
    }
  });
};

export const sharedMemoryPendingShareActionGrantBinding = (input: {
  referenceId: string;
  source: SharedMemorySourceRef;
  sourceCapabilities: readonly SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  mutationId: string;
  logicalGrantId: string;
  consentId: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  previewId: string;
  previewRevision: number;
  previewHash: string;
  mode: "snapshot" | "continuous";
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  expiresAt?: string | null;
}): SharedMemoryActionGrantBinding => {
  const normalizedInput = { ...input, expiresAt: input.expiresAt ?? null };
  return withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.pending_share.${shareIntentScope(normalizedInput)}`,
    teamId: input.teamId,
    targetId: input.logicalGrantId,
    method: "POST",
    path: "/v1/shared-memory/pending-shares",
    body: {
      source: input.source,
      sourceCapabilities: input.sourceCapabilities,
      activationRepresentation: input.activationRepresentation,
      mutationId: input.mutationId,
      logicalGrantId: input.logicalGrantId,
      consentId: input.consentId,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      preview: {
        previewId: input.previewId,
        previewHash: input.previewHash
      },
      previewRevision: input.previewRevision,
      mode: input.mode,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      expiresAt: input.expiresAt ?? null,
      authority: authorityBody(input.referenceId)
    }
  });
};

export const sharedMemoryRevokeActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  expectedGrantVersion: number;
  reasonCode: string;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.revoke.${input.teamWorkspaceId}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "POST",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/revoke`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      expectedGrantVersion: input.expectedGrantVersion,
      reasonCode: input.reasonCode,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryFreezeActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  expectedGrantVersion: number;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: "shared_memory.grant.freeze",
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "POST",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/freeze`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      expectedGrantVersion: input.expectedGrantVersion,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryTranscriptAccessActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  shareGrantId: string;
  expectedVersion: number;
  mode: "snapshot" | "continuous";
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.transcript_access.${input.mode}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "PUT",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/transcript-access`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      expectedVersion: input.expectedVersion,
      mode: input.mode,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryTranscriptRevokeActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  shareGrantId: string;
  expectedVersion: number;
  reasonCode: string;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: "shared_memory.transcript_access.revoke",
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "POST",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/transcript-access/revoke`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      expectedVersion: input.expectedVersion,
      reasonCode: input.reasonCode,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryFidelityBundleActionGrantBinding = (input: {
  referenceId: string;
  source: SharedMemorySourceRef;
  sourceCapabilities: readonly SharedMemoryRepresentation[];
  activationRepresentation: SharedMemoryRepresentation;
  mutationId: string;
  consentId: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  previewId: string;
  previewRevision: number;
  previewHash: string;
  mode: "snapshot" | "continuous";
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  expectedGrantVersion: number;
  expiresAt?: string | null;
}): SharedMemoryActionGrantBinding => {
  const normalizedInput = { ...input, expiresAt: input.expiresAt ?? null };
  return withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.change_fidelity.${shareIntentScope(normalizedInput)}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "PUT",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/fidelity-bundle`,
    body: {
      source: input.source,
      sourceCapabilities: input.sourceCapabilities,
      activationRepresentation: input.activationRepresentation,
      mutationId: input.mutationId,
      consentId: input.consentId,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      preview: {
        previewId: input.previewId,
        previewHash: input.previewHash
      },
      previewRevision: input.previewRevision,
      mode: input.mode,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      expectedGrantVersion: input.expectedGrantVersion,
      expiresAt: input.expiresAt ?? null,
      authority: authorityBody(input.referenceId)
    }
  });
};
