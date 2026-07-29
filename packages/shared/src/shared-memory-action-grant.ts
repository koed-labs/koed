import { createHash } from "node:crypto";

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

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeJson(item)])
    );
  }
  return value;
};

const hashCanonical = (domain: string, value: unknown): string =>
  createHash("sha256")
    .update(`${domain}\n${JSON.stringify(canonicalizeJson(value))}`)
    .digest("hex");

export const sharedMemoryGrantManagementScopeHash = (input: {
  action: string;
  teamId: string | null;
  targetId: string | null;
}): string =>
  hashCanonical("koed:high-risk:shared-memory-scope:v1", {
    operationFamily: "share_grant_management",
    action: input.action,
    teamId: input.teamId,
    targetId: input.targetId
  });

export const sharedMemoryGrantManagementRequestHash = (input: {
  method: string;
  path: string;
  body: unknown;
}): string => hashCanonical("koed:high-risk:shared-memory-request:v1", input);

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
