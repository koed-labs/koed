import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "./high-risk-action-grant-hash.js";

export const SHARED_MEMORY_AUTHORITY_ACTION =
  "workspace.memory.share_owned" as const;

export type SharedMemoryRepresentation =
  | "memory_events"
  | "lcm_leaves"
  | "lcm_rollups";

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

const allowedSetScope = (
  allowedRepresentations: readonly SharedMemoryRepresentation[]
): string => [...allowedRepresentations].sort().join(":");

export const sharedMemoryPreviewActionGrantBinding = (input: {
  referenceId: string;
  logicalMemoryId: string;
  remoteReplicaId: string;
  teamId: string;
  teamWorkspaceId: string;
  representation: SharedMemoryRepresentation;
  allowedRepresentations: SharedMemoryRepresentation[];
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.preview.${input.representation}.${allowedSetScope(input.allowedRepresentations)}`,
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
      allowedRepresentations: input.allowedRepresentations,
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
  allowedRepresentations: SharedMemoryRepresentation[];
  selectedRepresentation: SharedMemoryRepresentation;
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
      allowedRepresentations: input.allowedRepresentations,
      selectedRepresentation: input.selectedRepresentation,
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

export const sharedMemoryRepresentationActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  consentId: string;
  representation: SharedMemoryRepresentation;
  expectedGrantVersion: number;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.change_representation.${input.teamWorkspaceId}.${input.representation}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "PUT",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/representation`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      consentId: input.consentId,
      representation: input.representation,
      expectedGrantVersion: input.expectedGrantVersion,
      authority: authorityBody(input.referenceId)
    }
  });
