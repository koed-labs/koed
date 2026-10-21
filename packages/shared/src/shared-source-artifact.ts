import {
  crossIdentitySyncDeterministicUuid,
  crossIdentitySyncDigest
} from "./cross-identity-sync.js";
import type { SharedMemorySourceRef } from "./shared-memory-source.js";
import type { TeamRepositorySnapshot } from "./team-repository-snapshot.js";

export const SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const SHARED_SOURCE_PREVIEW_SCHEMA_VERSION = 1 as const;

export type SharedSourceArtifactRepresentation =
  | "memory_events"
  | "lcm_leaves"
  | "lcm_rollups"
  | "curated_assertions";

export type SharedSourceArtifactItemType =
  | "user_message"
  | "assistant_message"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "lcm_leaf"
  | "lcm_rollup"
  | "curated_assertion";

export interface SharedSourceArtifactBindingV1 {
  sourceRevision: number;
  sourceHash: string;
  representationPolicyRevision: number;
  representationPolicyHash: string;
  contentPolicyVersion: number;
  contentPolicyHash: string;
  classifierVersion: number;
  classifierHash: string;
}

export interface SharedSourceArtifactSyncBindingV1 {
  relationshipId: string;
  localReplicaId: string;
  remoteReplicaId: string;
  localSessionId: string;
  sourceCursor: number;
  packageSequence: number;
  sourceDeploymentIdentityId: string;
  remoteUserIdentityId: string;
  deviceCredentialId: string;
  deviceProvenanceHash: string;
}

export interface SharedSourceArtifactPolicyBindingV1 {
  sourceOwnerPolicyId: string;
  sourceOwnerPolicyVersion: number;
  teamPolicyId: string;
  teamPolicyVersion: number;
  workspacePolicyId: string;
  workspacePolicyVersion: number;
}

export interface SharedSourceArtifactManifestEntryV1 {
  sourceId: string;
  sourceTable:
    | "memory_events"
    | "conversation_items"
    | "memory_nodes"
    | "curated_memory_assertions";
  itemType: SharedSourceArtifactItemType;
  sourceCursor: number;
  revisionHash: string;
  occurredAt: string | null;
  sourceEventId: string | null;
  sourceNodeId: string | null;
}

export interface SharedSourceArtifactItemV1 {
  itemType: SharedSourceArtifactItemType;
  schemaVersion: 1;
  sourceId: string;
  sourceLogicalMemoryId: string;
  sourceRevision: number;
  occurredAt: string | null;
  repositorySnapshot?: TeamRepositorySnapshot;
  content: Record<string, unknown>;
}

export interface SharedSourceArtifactV1 {
  schemaVersion: typeof SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION;
  artifactId: string;
  logicalMemoryId: string;
  source: SharedMemorySourceRef;
  representation: SharedSourceArtifactRepresentation;
  binding: SharedSourceArtifactBindingV1;
  /** Present only for Captured Session sources. Personal Note revisions are standalone. */
  sync?: SharedSourceArtifactSyncBindingV1;
  policies: SharedSourceArtifactPolicyBindingV1;
  selection: {
    maximumFidelity: "memory_events" | "lcm_leaves" | "lcm_rollups";
    includeCuratedMemory: boolean;
    sourceCapabilities: SharedSourceArtifactRepresentation[];
    activationRepresentation: SharedSourceArtifactRepresentation;
    mode: "snapshot" | "continuous";
  };
  manifest: SharedSourceArtifactManifestEntryV1[];
  manifestHash: string;
  items: SharedSourceArtifactItemV1[];
  sourceContentHash: string;
  artifactHash: string;
}

export interface SharedSourcePreviewV1 {
  schemaVersion: typeof SHARED_SOURCE_PREVIEW_SCHEMA_VERSION;
  previewId: string;
  artifactId: string;
  logicalMemoryId: string;
  source: SharedMemorySourceRef;
  representation: SharedSourceArtifactRepresentation;
  binding: SharedSourceArtifactBindingV1;
  items: SharedSourceArtifactItemV1[];
  sourceContentHash: string;
  previewHash: string;
}

export interface SharedSourceArtifactReference {
  artifactId: string;
  artifactHash: string;
}

export interface SharedSourcePreviewReference {
  previewId: string;
  previewHash: string;
}

export const sharedSourceArtifactHash = (
  artifact:
    | Omit<SharedSourceArtifactV1, "artifactHash">
    | SharedSourceArtifactV1
): string => {
  const body = { ...artifact } as Record<string, unknown>;
  delete body.artifactId;
  delete body.artifactHash;
  return crossIdentitySyncDigest(body);
};

export const sharedSourcePreviewHash = (
  preview: Omit<SharedSourcePreviewV1, "previewHash"> | SharedSourcePreviewV1
): string => {
  const body = { ...preview } as Record<string, unknown>;
  delete body.previewId;
  delete body.previewHash;
  // artifactId is a foreign binding, not this preview's self identity.
  return crossIdentitySyncDigest(body);
};

export const sharedSourceArtifactId = (artifactHash: string): string =>
  crossIdentitySyncDeterministicUuid({
    kind: "shared_source_artifact",
    version: SHARED_SOURCE_ARTIFACT_SCHEMA_VERSION,
    artifactHash
  });

export const sharedSourcePreviewId = (previewHash: string): string =>
  crossIdentitySyncDeterministicUuid({
    kind: "shared_source_preview",
    version: SHARED_SOURCE_PREVIEW_SCHEMA_VERSION,
    previewHash
  });

export const sharedMemoryGrantScopedSourceId = (
  shareGrantId: string,
  sourceId: string
): string =>
  crossIdentitySyncDeterministicUuid({
    kind: "shared_memory_team_source",
    shareGrantId,
    sourceId
  });

export const sharedMemoryGrantScopedPrincipalId = (
  shareGrantId: string,
  principalId: string
): string =>
  crossIdentitySyncDeterministicUuid({
    kind: "shared_memory_team_principal",
    shareGrantId,
    principalId
  });
