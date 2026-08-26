import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "./high-risk-action-grant-hash.js";
import type { SharedMemorySourceRef } from "./shared-memory-source.js";
import type { SharedMemoryFidelityCeiling } from "./shared-memory-fidelity.js";

export const SHARED_MEMORY_AUTHORITY_ACTION =
  "workspace.memory.share_owned" as const;

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
