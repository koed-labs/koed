import type {
  ConversationSharingRuleControlIntent,
  RepositorySharingRuleCreationIntent,
  RepositorySharingRuleControlIntent
} from "./team-sharing-review-contract.js";
import {
  highRiskActionGrantCanonicalHash,
  HIGH_RISK_ACTION_GRANT_HASH_DOMAINS
} from "./high-risk-action-grant-hash.js";
import type { SharedMemorySourceRef } from "./shared-memory-source.js";
import type { SharedMemoryFidelityCeiling } from "./shared-memory-fidelity.js";
import type { TeamRepositorySnapshotReview } from "./team-repository-snapshot.js";
import type { SharingRuleContentPolicyIntent } from "./sharing-rule-content-policy-contract.js";
import type { SharingRuleDetailIntent } from "./sharing-rule-detail-contract.js";

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

export const sharedMemoryConversationRuleCreationActionGrantBinding = (
  input: Parameters<typeof sharedMemoryPendingShareActionGrantBinding>[0] & {
    ruleId: string;
    expectedGrantVersion: number | null;
    effectivePrivacyPolicyHash: string;
  }
): SharedMemoryActionGrantBinding => {
  const pending = sharedMemoryPendingShareActionGrantBinding(input);
  return withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.conversation_rule_create.${input.teamWorkspaceId}`,
    teamId: input.teamId,
    targetId: input.ruleId,
    method: "POST",
    path: "/v1/shared-memory/conversation-rules",
    body: {
      ...pending.body,
      ruleId: input.ruleId,
      expectedGrantVersion: input.expectedGrantVersion,
      effectivePrivacyPolicyHash: input.effectivePrivacyPolicyHash
    }
  });
};

export const sharedMemoryRepositoryRuleCreationActionGrantBinding = (
  input: RepositorySharingRuleCreationIntent & { referenceId: string }
): SharedMemoryActionGrantBinding => {
  const { referenceId, ...intent } = input;
  return withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.repository_rule_create.${intent.teamWorkspaceId}`,
    teamId: intent.teamId,
    targetId: intent.ruleId,
    method: "POST",
    path: "/v1/shared-memory/repository-rules",
    body: { ...intent, authority: authorityBody(referenceId) }
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

export const sharedMemoryRepositorySnapshotActionGrantBinding = (input: {
  referenceId: string;
  mutationId: string;
  teamId: string;
  teamWorkspaceId: string;
  shareGrantId: string;
  expected: TeamRepositorySnapshotReview;
}): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.repository_snapshot_update.${input.teamWorkspaceId}`,
    teamId: input.teamId,
    targetId: input.shareGrantId,
    method: "POST",
    path: `/v1/shared-memory/share-grants/${input.shareGrantId}/repository-snapshot`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      expected: input.expected,
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

export const sharedMemoryRuleControlActionGrantBinding = (
  input: ConversationSharingRuleControlIntent & { referenceId: string }
): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.rule_control.${input.teamWorkspaceId}.${input.controlAction}`,
    teamId: input.teamId,
    targetId: input.ruleId,
    method: "POST",
    path: `/v1/shared-memory/sharing-rules/${input.ruleId}/control`,
    body: {
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      shareGrantId: input.shareGrantId,
      reasonId: input.reasonId,
      expectedAuthorityVersion: input.expectedAuthorityVersion,
      expectedGrantVersion: input.expectedGrantVersion,
      controlAction: input.controlAction,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryRuleDetailActionGrantBinding = (
  input: SharingRuleDetailIntent & { referenceId: string }
): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.rule_detail.${input.review.teamWorkspaceId}`,
    teamId: input.review.teamId,
    targetId: input.review.ruleId,
    method: "POST",
    path: `/v1/shared-memory/sharing-rules/${input.review.ruleId}/detail`,
    body: {
      mutationId: input.mutationId,
      review: input.review,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryRuleContentPolicyActionGrantBinding = (
  input: SharingRuleContentPolicyIntent & { referenceId: string }
): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.rule_content_policy.${input.review.teamWorkspaceId}`,
    teamId: input.review.teamId,
    targetId: input.review.ruleId,
    method: "POST",
    path: `/v1/shared-memory/sharing-rules/${input.review.ruleId}/content-policy`,
    body: {
      mutationId: input.mutationId,
      review: input.review,
      authority: authorityBody(input.referenceId)
    }
  });

export const sharedMemoryRepositoryRuleControlActionGrantBinding = (
  input: RepositorySharingRuleControlIntent & { referenceId: string }
): SharedMemoryActionGrantBinding =>
  withHashes({
    operationFamily: "share_grant_management",
    action: `shared_memory.repository_rule_control.${input.teamWorkspaceId}.${input.controlAction}`,
    teamId: input.teamId,
    targetId: input.ruleId,
    method: "POST",
    path: `/v1/shared-memory/repository-rules/${input.ruleId}/control`,
    body: {
      selectorKind: "selection",
      mutationId: input.mutationId,
      teamId: input.teamId,
      teamWorkspaceId: input.teamWorkspaceId,
      expectedAuthorityVersion: input.expectedAuthorityVersion,
      publisherFence: input.publisherFence,
      controlAction: input.controlAction,
      authority: authorityBody(input.referenceId)
    }
  });
