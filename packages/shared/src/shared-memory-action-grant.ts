import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "./high-risk-action-grant-hash.js";
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

export const sharedMemoryPreviewActionGrantBinding = (input: {
  referenceId: string;
  logicalMemoryId: string;
  remoteReplicaId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.preview.${input.representation}.max_${input.maximumFidelity}.curated_${input.includeCuratedMemory}`,
    teamId: input.teamId,
    targetId: input.remoteReplicaId,
    method: "POST",
    path: "/v1/shared-memory/previews",
    body: {
      logicalMemoryId: input.logicalMemoryId,
      remoteReplicaId: input.remoteReplicaId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      representation: input.representation,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryCandidatePreviewActionGrantBinding = (input: {
  referenceId: string;
  logicalMemoryId: string;
  candidateHash: string;
  sourceRevision: number;
  itemCount: number;
  byteCount: number;
  excludedItemCount: number;
  manifest: Array<{ sourceId: string; revisionHash: string }>;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  mode: "snapshot" | "continuous";
  expiresAt?: string | null;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.candidate_preview.${input.representation}.max_${input.maximumFidelity}.curated_${input.includeCuratedMemory}`,
    teamId: input.teamId,
    targetId: input.logicalMemoryId,
    method: "POST",
    path: "/v1/shared-memory/candidate-previews",
    body: {
      logicalMemoryId: input.logicalMemoryId,
      candidateHash: input.candidateHash,
      sourceRevision: input.sourceRevision,
      itemCount: input.itemCount,
      byteCount: input.byteCount,
      excludedItemCount: input.excludedItemCount,
      manifest: input.manifest,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      representation: input.representation,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      mode: input.mode,
      expiresAt: input.expiresAt ?? null,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryConsentActionGrantBinding = (input: {
  referenceId: string;
  consentId: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  previewId: string;
  mode: "snapshot" | "continuous";
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  previewRevision: number;
  previewHash: string;
  expiresAt?: string | null;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.consent.${input.logicalMemoryId}.pr${input.previewRevision}`,
    teamId: input.teamId,
    targetId: input.consentId,
    method: "POST",
    path: `/v1/shared-memory/teams/${input.teamId}/workspaces/${input.teamWorkspaceId}/consents`,
    body: {
      consentId: input.consentId,
      logicalMemoryId: input.logicalMemoryId,
      preview: {
        previewId: input.previewId,
        previewHash: input.previewHash
      },
      previewRevision: input.previewRevision,
      mode: input.mode,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      expiresAt: input.expiresAt,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryShareActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  logicalGrantId: string;
  logicalMemoryId: string;
  teamId: string;
  teamWorkspaceId: string;
  consentId: string;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.share.${input.logicalMemoryId}.${input.teamWorkspaceId}`,
    teamId: input.teamId,
    targetId: input.logicalGrantId,
    method: "POST",
    path: "/v1/shared-memory/share-grants",
    body: {
      mutationId: input.mutationId,
      logicalGrantId: input.logicalGrantId,
      logicalMemoryId: input.logicalMemoryId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      consentId: input.consentId,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryPendingShareActionGrantBinding = (input: {
  referenceId: string;
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
  title?: string;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.pending_share.${input.logicalMemoryId}.pr${input.previewRevision}`,
    teamId: input.teamId,
    targetId: input.logicalGrantId,
    method: "POST",
    path: "/v1/shared-memory/pending-shares",
    body: {
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
      ...(input.title ? { title: input.title } : {}),
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryShareBundleActionGrantBinding = (input: {
  referenceId: string;
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
  title?: string;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.share.${input.logicalMemoryId}.${input.teamWorkspaceId}`,
    teamId: input.teamId,
    targetId: input.logicalGrantId,
    method: "POST",
    path: "/v1/shared-memory/share-bundles",
    body: {
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
      ...(input.title ? { title: input.title } : {}),
      authority: authorityBody(input.referenceId)
    }
  });

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

export const sharedMemoryFidelityActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  consentId: string;
  maximumFidelity: SharedMemoryFidelityCeiling;
  includeCuratedMemory: boolean;
  expectedGrantVersion: number;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.change_fidelity.${input.teamWorkspaceId}.${input.maximumFidelity}.curated_${input.includeCuratedMemory}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "PUT",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/fidelity`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      consentId: input.consentId,
      maximumFidelity: input.maximumFidelity,
      includeCuratedMemory: input.includeCuratedMemory,
      expectedGrantVersion: input.expectedGrantVersion,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryFidelityBundleActionGrantBinding = (input: {
  referenceId: string;
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
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.change_fidelity.${input.teamWorkspaceId}.${input.maximumFidelity}.curated_${input.includeCuratedMemory}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "PUT",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/fidelity-bundle`,
    body: {
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
