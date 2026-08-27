import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  CollaborationRepository,
  DeviceCredentialAuthContext,
  HighRiskActionRepository,
  PendingShareRecord,
  SharedMemoryConsentRecord,
  SharedMemoryGrantRecord,
  SharedMemoryPolicyRecord,
  SharedMemoryReadResult,
  SharedMemoryRepository,
  SharedMemoryRepresentationRecord,
  TeamConversationSourceGrantRecord,
  TeamConversationSourceRepository,
  UserRecord
} from "@koed/db";
import {
  SHARED_MEMORY_AUTHORITY,
  SharedMemoryAuthorizationError
} from "@koed/db";
import {
  pendingShareSchema,
  sharedMemoryGrantScopedPrincipalId,
  sharedMemoryGrantScopedSourceId,
  sharedMemoryCeilingAuthorizes,
  sharedMemoryRepresentationsForCeiling,
  SharedMemoryConflictError
} from "@koed/shared";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  registerSharedMemoryRoutes,
  type SharedMemoryRouteContext
} from "./routes.js";
import {
  SHARED_MEMORY_WORKSPACE_INDEX_MAX_LIMIT,
  SHARED_MEMORY_WORKSPACE_INDEX_MAX_OFFSET
} from "./schemas.js";

const iso = "2026-07-17T00:00:00.000Z";
const hash = "a".repeat(64);

const jsonBody = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;

type SharedMemoryPersistedPreviewRecord = Awaited<
  ReturnType<SharedMemoryRepository["createAuthoritativeSourcePreview"]>
>;

const createFixture = () => {
  const ids = {
    alice: randomUUID(),
    bob: randomUUID(),
    carol: randomUUID(),
    teamA: randomUUID(),
    teamB: randomUUID(),
    workspaceA: randomUUID(),
    workspaceB: randomUUID(),
    logicalMemory: randomUUID(),
    remoteReplica: randomUUID(),
    consent: randomUUID(),
    grant: randomUUID(),
    logicalGrant: randomUUID(),
    representation: randomUUID(),
    preview: randomUUID(),
    lcmPreview: randomUUID(),
    source: randomUUID(),
    sourceArtifact: randomUUID(),
    sourceRevision: randomUUID(),
    sourceSession: randomUUID(),
    sessionAuthority: randomUUID(),
    actionGrantAuthority: randomUUID()
  };

  const user = (id: string, name: string): UserRecord => ({
    id,
    email: `${name.toLowerCase()}@example.test`,
    displayName: name,
    passwordHash: null
  });
  const users = new Map<string, UserRecord>([
    [ids.alice, user(ids.alice, "Alice")],
    [ids.bob, user(ids.bob, "Bob")],
    [ids.carol, user(ids.carol, "Carol")]
  ]);

  const companionScope = {
    scope: "team" as const,
    kind: "shared_session_discussion" as const,
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    logicalMemoryId: ids.logicalMemory,
    shareGrantId: ids.grant
  };
  const capturedSource = {
    kind: "captured_session" as const,
    sessionId: ids.sourceSession,
    logicalMemoryId: ids.logicalMemory
  };
  const capturedSourceCapabilities = [
    "lcm_rollups" as const,
    "lcm_leaves" as const,
    "memory_events" as const,
    "curated_assertions" as const
  ];

  let grantVersion = 1;
  let revoked = false;
  let maximumFidelity: "memory_events" | "lcm_leaves" | "lcm_rollups" =
    "memory_events";
  let includeCuratedMemory = false;
  let repositoryCalls = 0;
  let personalNoteUpload:
    | Parameters<SharedMemoryRepository["persistPersonalNoteSourceArtifact"]>[1]
    | null = null;
  let continuousNoteAdvancement:
    | Parameters<
        SharedMemoryRepository["advanceContinuousPersonalNoteRevision"]
      >[1]
    | null = null;
  let sourceGrantVersion = 0;
  let sourceGrantLifecycle: "active" | "revoked" = "active";
  let lastListInput:
    | {
        teamId: string;
        teamWorkspaceId: string;
        limit: number;
        offset: number;
      }
    | undefined;
  let lastOwnerListInput:
    | { logicalMemoryId: string; limit: number; offset: number }
    | undefined;
  const browserAuthorityReferenceIds: string[] = [];
  const cumulativeMaterializations: string[][] = [];

  const materializedLayers = (
    ceiling: "memory_events" | "lcm_leaves" | "lcm_rollups",
    curated: boolean
  ) => [
    ...sharedMemoryRepresentationsForCeiling(ceiling),
    ...(curated ? (["curated_assertions"] as const) : [])
  ];

  const policyRecord = (
    scope: SharedMemoryPolicyRecord["scope"],
    nextMaximumFidelity: SharedMemoryPolicyRecord["maximumFidelity"],
    nextIncludeCuratedMemory: boolean
  ): SharedMemoryPolicyRecord => ({
    id: randomUUID(),
    policyId: randomUUID(),
    scope,
    logicalMemoryId: scope === "source_owner" ? ids.logicalMemory : null,
    sourceOwnerPrincipalId:
      scope === "source_owner" ? `user:${ids.alice}` : null,
    teamId: scope === "source_owner" ? null : ids.teamA,
    teamWorkspaceId: scope === "workspace" ? ids.workspaceA : null,
    version: 1,
    maximumFidelity: nextMaximumFidelity,
    includeCuratedMemory: nextIncludeCuratedMemory,
    policyHash: hash,
    effectiveAt: iso,
    supersededAt: null
  });

  const grantRecord = (): SharedMemoryGrantRecord => ({
    source: capturedSource,
    sourceRevisionId: ids.sourceRevision,
    sourceCapabilities: capturedSourceCapabilities,
    activationRepresentation: "memory_events",
    mode: "continuous",
    id: ids.grant,
    logicalGrantId: ids.logicalGrant,
    logicalMemoryId: ids.logicalMemory,
    remoteReplicaId: ids.remoteReplica,
    ownerUserId: ids.alice,
    ownerPrincipalId: `user:${ids.alice}`,
    sessionId: randomUUID(),
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    consentId: ids.consent,
    displayTitle: "Shared Memory",
    sourceOwnerPolicyId: randomUUID(),
    sourceOwnerPolicyVersion: 1,
    teamPolicyId: randomUUID(),
    teamPolicyVersion: 1,
    workspacePolicyId: randomUUID(),
    workspacePolicyVersion: 1,
    maximumFidelity,
    includeCuratedMemory,
    fidelityPolicyRevision: 1,
    contentPolicyVersion: 1,
    classifierVersion: 1,
    sourceRevision: 1,
    grantVersion,
    lifecycle: revoked ? "revoked" : "active",
    creatorAuthority: `browser_session:${ids.sessionAuthority}`,
    grantedByUserId: ids.alice,
    createdAt: iso,
    updatedAt: iso,
    revokedAt: revoked ? iso : null,
    companionScope
  });

  const representationRecord = (
    representation: SharedMemoryRepresentationRecord["representation"] = "memory_events"
  ): SharedMemoryRepresentationRecord => ({
    source: capturedSource,
    id: ids.representation,
    shareGrantId: ids.grant,
    consentId: ids.consent,
    sourcePreviewId: ids.preview,
    sourceArtifactId: randomUUID(),
    sanitizedSourcePreviewId: randomUUID(),
    privacyClassifierGenerationId: randomUUID(),
    privacyClassifierHash: hash,
    effectivePrivacyPolicyHash: hash,
    sourceManifestHash: hash,
    sanitizedContentHash: hash,
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    logicalMemoryId: ids.logicalMemory,
    sourceRevisionId: ids.sourceRevision,
    representation,
    sourceRevision: 1,
    sourceRevisionHash: hash,
    provenanceHash: hash,
    sourceOwnerPolicyId: randomUUID(),
    sourceOwnerPolicyVersion: 1,
    teamPolicyId: randomUUID(),
    teamPolicyVersion: 1,
    workspacePolicyId: randomUUID(),
    workspacePolicyVersion: 1,
    fidelityPolicyRevision: 1,
    contentPolicyVersion: 1,
    classifierVersion: 1,
    recordVersion: 1,
    state: "available",
    chunkCount: 1,
    createdAt: iso,
    updatedAt: iso,
    availableAt: iso,
    staleAt: null,
    invalidatedAt: null,
    invalidationReasonCode: null
  });

  const previewRecord = (
    input: {
      logicalMemoryId: string;
      remoteReplicaId: string;
      teamId: string;
      teamWorkspaceId: string;
      representation: SharedMemoryPersistedPreviewRecord["representation"];
      maximumFidelity: SharedMemoryPersistedPreviewRecord["maximumFidelity"];
      includeCuratedMemory: boolean;
    } = {
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.remoteReplica,
      teamId: ids.teamA,
      teamWorkspaceId: ids.workspaceA,
      representation: "memory_events",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false
    }
  ): SharedMemoryPersistedPreviewRecord => ({
    source: capturedSource,
    sourceRevisionId: ids.sourceRevision,
    sourceCapabilities: capturedSourceCapabilities,
    activationRepresentation: input.representation,
    mode: "continuous",
    previewId:
      input.representation === "lcm_leaves" ? ids.lcmPreview : ids.preview,
    previewHash: hash,
    artifactId: randomUUID(),
    artifactHash: hash,
    logicalMemoryId: input.logicalMemoryId,
    remoteReplicaId: input.remoteReplicaId,
    ownerUserId: ids.alice,
    ownerPrincipalId: `user:${ids.alice}`,
    teamId: input.teamId,
    teamWorkspaceId: input.teamWorkspaceId,
    representation: input.representation,
    maximumFidelity: input.maximumFidelity,
    includeCuratedMemory: input.includeCuratedMemory,
    previewRevision: 1,
    binding: binding(),
    manifest: [
      {
        sourceId: ids.source,
        sourceTable:
          input.representation === "memory_events"
            ? "memory_events"
            : input.representation === "curated_assertions"
              ? "curated_memory_assertions"
              : "memory_nodes",
        itemType:
          input.representation === "lcm_leaves"
            ? "lcm_leaf"
            : input.representation === "lcm_rollups"
              ? "lcm_rollup"
              : input.representation === "curated_assertions"
                ? "curated_assertion"
                : "user_message",
        sourceCursor: 1,
        revisionHash: hash,
        occurredAt: iso,
        sourceEventId:
          input.representation === "memory_events" ? ids.source : null,
        sourceNodeId:
          input.representation === "lcm_leaves" ||
          input.representation === "lcm_rollups"
            ? ids.source
            : null
      }
    ],
    manifestHash: hash,
    items: [
      {
        itemType:
          input.representation === "lcm_leaves"
            ? "lcm_leaf"
            : input.representation === "lcm_rollups"
              ? "lcm_rollup"
              : input.representation === "curated_assertions"
                ? "curated_assertion"
                : "user_message",
        schemaVersion: 1,
        sourceId: ids.source,
        sourceLogicalMemoryId: input.logicalMemoryId,
        sourceRevision: 1,
        occurredAt: iso,
        content:
          input.representation === "lcm_leaves"
            ? {
                title: "Local summary",
                summaryText: "Generated by the connected AI Client.",
                lexicalAnchors: ["connected AI Client"],
                sourceIds: [ids.source]
              }
            : input.representation === "lcm_rollups"
              ? {
                  title: "Local rollup",
                  summaryText: "Generated by the connected AI Client.",
                  lexicalAnchors: ["connected AI Client"],
                  sourceIds: [ids.source]
                }
              : input.representation === "curated_assertions"
                ? {
                    assertionText: "Server-loaded curated assertion",
                    topicTitle: "Curated fixture",
                    tags: ["fixture"],
                    sourceCount: 1
                  }
                : { text: "server-loaded source" }
      }
    ],
    sourceContentHash: hash,
    sourceRevision: 1,
    sourceHash: hash,
    syncRelationshipId: randomUUID(),
    deviceProvenanceHash: hash,
    createdAt: iso
  });

  const readResult = (
    representation: SharedMemoryRepresentationRecord["representation"],
    page?: {
      direction: "older" | "newer";
      boundary?: number;
      limit: number;
    }
  ): SharedMemoryReadResult => {
    const itemCount = 1;
    const boundary =
      page?.boundary ?? (page?.direction === "newer" ? 0 : itemCount);
    if (boundary > itemCount) {
      throw new SharedMemoryConflictError("Source page is out of range");
    }
    const itemOffset =
      page?.direction === "newer"
        ? boundary
        : Math.max(0, boundary - (page?.limit ?? itemCount));
    const itemEnd =
      page?.direction === "newer"
        ? Math.min(itemCount, boundary + (page?.limit ?? itemCount))
        : boundary;
    return {
      grant: grantRecord(),
      representation: representationRecord(representation),
      items: [
        {
          itemType:
            representation === "lcm_leaves"
              ? ("lcm_leaf" as const)
              : representation === "lcm_rollups"
                ? ("lcm_rollup" as const)
                : representation === "curated_assertions"
                  ? ("curated_assertion" as const)
                  : ("tool_result" as const),
          schemaVersion: 1 as const,
          sourceId: ids.source,
          sourceLogicalMemoryId: ids.logicalMemory,
          sourceRevision: 1,
          occurredAt: iso,
          content:
            representation === "lcm_leaves" || representation === "lcm_rollups"
              ? {
                  title: "Fixture summary",
                  summaryText: "A complete sanitized summary.",
                  lexicalAnchors: ["complete summary"],
                  sourceIds: [ids.source]
                }
              : representation === "curated_assertions"
                ? {
                    assertionText: "A curated fixture assertion.",
                    topicTitle: "Fixture",
                    tags: ["fixture"],
                    sourceCount: 1
                  }
                : {
                    toolName: "fixture_tool",
                    toolCallId: "call-shared-route-fixture",
                    payload: {
                      authorization: "[SECRET]",
                      note: "Bearer [SECRET]"
                    }
                  }
        }
      ].slice(itemOffset, itemEnd),
      sourcePage: { itemOffset, itemCount },
      freshness: "fresh",
      companionScope
    };
  };

  const consentRecord = (): SharedMemoryConsentRecord => ({
    source: capturedSource,
    sourceRevisionId: ids.sourceRevision,
    sourceCapabilities: capturedSourceCapabilities,
    activationRepresentation: "memory_events",
    id: ids.consent,
    previewId: ids.preview,
    logicalMemoryId: ids.logicalMemory,
    remoteReplicaId: ids.remoteReplica,
    sourceOwnerPrincipalId: `user:${ids.alice}`,
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    sourceOwnerPolicyId: randomUUID(),
    sourceOwnerPolicyVersion: 1,
    teamPolicyId: randomUUID(),
    teamPolicyVersion: 1,
    workspacePolicyId: randomUUID(),
    workspacePolicyVersion: 1,
    mode: "snapshot",
    state: "active",
    consentVersion: 1,
    maximumFidelity,
    includeCuratedMemory,
    previewRevision: 1,
    previewHash: hash,
    sourceRevision: 1,
    maximumAuthorizedSourceRevision: 1,
    sourceHash: hash,
    fidelityPolicyRevision: 1,
    fidelityPolicyHash: hash,
    contentPolicyVersion: 1,
    contentPolicyHash: hash,
    classifierVersion: 1,
    classifierHash: hash,
    sourceContentHash: hash,
    createdAt: iso,
    updatedAt: iso,
    activatedAt: iso,
    revokedAt: null
  });

  const repository: SharedMemoryRepository = {
    async createSharedMemoryCandidatePreview() {
      return null;
    },
    async createPendingShare(actor, input) {
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError();
      }
      return {
        source: input.source,
        sourceCapabilities: input.sourceCapabilities,
        activationRepresentation: input.activationRepresentation,
        id: randomUUID(),
        mutationId: input.mutationId,
        logicalGrantId: input.logicalGrantId,
        consentId: input.consentId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        representation: input.activationRepresentation,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        mode: input.mode,
        sourceRevision: 1,
        state: "preparing",
        stage: "accepted",
        workspaceAccessState: "none",
        sourceUpdateState: "preparing",
        operationVersion: 1,
        attemptCount: 0,
        redactedFailureCode: null,
        lastProgressAt: iso,
        createdAt: iso,
        updatedAt: iso,
        activatedAt: null,
        revokedAt: null,
        grantId: null,
        grantVersion: null
      };
    },
    async createPendingFidelityChange(actor, input) {
      if (
        actor.userId !== ids.alice ||
        input.shareGrantId !== ids.grant ||
        input.expectedGrantVersion !== grantVersion
      ) {
        throw new SharedMemoryAuthorizationError();
      }
      maximumFidelity = input.maximumFidelity;
      includeCuratedMemory = input.includeCuratedMemory;
      return {
        source: input.source,
        sourceCapabilities: input.sourceCapabilities,
        activationRepresentation: input.activationRepresentation,
        id: randomUUID(),
        mutationId: input.mutationId,
        logicalGrantId: ids.logicalGrant,
        consentId: input.consentId,
        logicalMemoryId: input.logicalMemoryId,
        teamId: input.teamId,
        teamWorkspaceId: input.teamWorkspaceId,
        representation: input.maximumFidelity,
        maximumFidelity: input.maximumFidelity,
        includeCuratedMemory: input.includeCuratedMemory,
        mode: input.mode,
        sourceRevision: 1,
        state: "preparing",
        stage: "accepted",
        workspaceAccessState: "active",
        sourceUpdateState: "preparing",
        operationVersion: 1,
        attemptCount: 0,
        redactedFailureCode: null,
        lastProgressAt: iso,
        createdAt: iso,
        updatedAt: iso,
        activatedAt: null,
        revokedAt: null,
        grantId: ids.grant,
        grantVersion
      };
    },
    async processPendingShares() {
      return { claimed: 0, activated: 0, waiting: 0, failed: 0 };
    },
    async getNextPendingShareWorkAt() {
      return null;
    },
    async controlPendingShare() {
      throw new SharedMemoryAuthorizationError();
    },
    async listOwnerShares(_actor, input) {
      return {
        entries: [],
        limit: input.limit,
        hasMore: false,
        snapshotAt: iso,
        next: null
      };
    },
    async getOwnerShare() {
      return null;
    },
    async readOwnerSharePreview() {
      return null;
    },
    async getSharedMemoryCandidatePreviewAdmission() {
      return null;
    },
    async getSharedMemoryPreviewAdmission() {
      return null;
    },
    async getSharedMemoryShareReview() {
      return null;
    },
    async getSharedMemoryPendingShareReview() {
      return null;
    },
    async getSharedMemoryFidelityChangeReview() {
      return null;
    },
    async getSharedMemoryRevokeReview() {
      return null;
    },
    async listPendingSemanticPrivacyTargets() {
      return [];
    },
    async readPendingSemanticPrivacyTarget() {
      return null;
    },
    async claimSemanticPrivacyTarget() {
      return null;
    },
    async renewSemanticPrivacyClaim() {
      return null;
    },
    async releaseSemanticPrivacyClaim() {
      return false;
    },
    async initializeSemanticPrivacyManifest() {
      return [];
    },
    async attachSemanticPrivacyChunkResult() {
      throw new Error("not used by route tests");
    },
    async listSemanticPrivacyManifest() {
      return [];
    },
    async storeSanitizedSemanticPreview() {
      throw new Error("not used by route tests");
    },
    async markSemanticPrivacyTargetFailed() {
      return false;
    },
    async deferSemanticPrivacyTarget() {
      return null;
    },
    async getNextSemanticPrivacyWorkAt() {
      return null;
    },
    async getSemanticPrivacyBacklogDiagnostics() {
      return {
        counts: {
          pending: 0,
          leased: 0,
          deferred: 0,
          ready: 0,
          failed: 0,
          stale: 0,
          invalidated: 0
        },
        bySchedulingClass: { foreground: 0, background: 0 },
        byWorkReason: {
          share_activation: 0,
          source_revision_classification: 0,
          policy_remasking: 0,
          classifier_rematerialization: 0,
          background_repair: 0
        },
        oldestBackgroundWaitMs: null,
        completionEstimate: {
          status: "unavailable",
          reason: "insufficient_measured_throughput"
        }
      };
    },
    async tryAcquireSemanticPrivacyFinalizationLease() {
      return null;
    },
    async invalidateSemanticPreview() {
      return false;
    },
    async invalidateStaleSemanticPreviews() {
      return { invalidated: 0 };
    },
    async reconcileReadySemanticRepresentations() {
      return { materialized: 0, skipped: 0 };
    },
    async rewrapTeamRepresentationChunkBatch() {
      return {
        processedRows: 0,
        rewrappedRows: 0,
        wouldRewrapRows: 0,
        failedRows: 0,
        done: true,
        nextCursorId: null
      };
    },
    async createAuthoritativeSourcePreview(actor, input) {
      repositoryCalls += 1;
      if (
        actor.userId !== ids.alice ||
        input.logicalMemoryId !== ids.logicalMemory ||
        input.remoteReplicaId !== ids.remoteReplica ||
        input.teamId !== ids.teamA ||
        input.teamWorkspaceId !== ids.workspaceA
      ) {
        throw new SharedMemoryAuthorizationError("private preview detail");
      }
      if (input.authority.source === "browser_session") {
        browserAuthorityReferenceIds.push(input.authority.referenceId);
      }
      return previewRecord({
        ...input,
        representation: input.activationRepresentation
      });
    },
    async persistPersonalNoteSourceArtifact(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError();
      }
      personalNoteUpload = input;
      return {
        ...previewRecord({
          logicalMemoryId: input.candidate.logicalMemoryId,
          remoteReplicaId: ids.remoteReplica,
          teamId: ids.teamA,
          teamWorkspaceId: ids.workspaceA,
          representation: "memory_events",
          maximumFidelity: "memory_events",
          includeCuratedMemory: false
        }),
        source: input.candidate.source,
        logicalMemoryId: input.candidate.logicalMemoryId,
        remoteReplicaId: null,
        syncRelationshipId: null,
        sourceRevision: 1
      };
    },
    async advanceContinuousPersonalNoteRevision(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError();
      }
      continuousNoteAdvancement = input;
      const pendingShare: PendingShareRecord = {
        source: input.candidate.source,
        sourceCapabilities: input.candidate.sourceCapabilities,
        activationRepresentation: input.candidate.activationRepresentation,
        id: randomUUID(),
        mutationId: input.mutationId,
        logicalGrantId: ids.logicalGrant,
        consentId: ids.consent,
        logicalMemoryId: input.candidate.logicalMemoryId,
        teamId: ids.teamA,
        teamWorkspaceId: ids.workspaceA,
        representation: "memory_events",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        mode: "continuous",
        sourceRevision: input.candidate.sourceRevision,
        state: "preparing",
        stage: "accepted",
        workspaceAccessState: "active",
        sourceUpdateState: "preparing",
        operationVersion: 2,
        attemptCount: 0,
        redactedFailureCode: null,
        lastProgressAt: iso,
        createdAt: iso,
        updatedAt: iso,
        activatedAt: iso,
        revokedAt: null,
        grantId: ids.grant,
        grantVersion: 1
      };
      return {
        pendingShares: [pendingShare],
        outcomes: [
          {
            shareGrantId: ids.grant,
            status: "accepted",
            pendingShareId: pendingShare.id
          }
        ],
        nextShareGrantId: null
      };
    },
    async putSourceOwnerPolicy(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private owner detail");
      }
      return policyRecord(
        "source_owner",
        input.maximumFidelity,
        input.includeCuratedMemory
      );
    },
    async putTeamPolicy(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private manager detail");
      }
      maximumFidelity = input.maximumFidelity;
      includeCuratedMemory = input.includeCuratedMemory;
      return policyRecord(
        "team",
        input.maximumFidelity,
        input.includeCuratedMemory
      );
    },
    async putWorkspacePolicy(actor, input) {
      repositoryCalls += 1;
      if (
        actor.userId !== ids.alice ||
        input.teamId !== ids.teamA ||
        input.teamWorkspaceId !== ids.workspaceA
      ) {
        throw new SharedMemoryAuthorizationError("private workspace detail");
      }
      maximumFidelity = input.maximumFidelity;
      includeCuratedMemory = input.includeCuratedMemory;
      return policyRecord(
        "workspace",
        input.maximumFidelity,
        input.includeCuratedMemory
      );
    },
    async createSourceOwnerConsent(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private owner detail");
      }
      if (
        input.preview.previewId !== ids.preview ||
        input.preview.previewHash !== hash
      ) {
        throw new SharedMemoryAuthorizationError("private preview detail");
      }
      if (input.authority.source === "browser_session") {
        browserAuthorityReferenceIds.push(input.authority.referenceId);
      }
      maximumFidelity = input.maximumFidelity;
      includeCuratedMemory = input.includeCuratedMemory;
      return consentRecord();
    },
    async createShareGrant(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private owner detail");
      }
      if (input.authority.source === "browser_session") {
        browserAuthorityReferenceIds.push(input.authority.referenceId);
      }
      cumulativeMaterializations.push(
        materializedLayers(maximumFidelity, includeCuratedMemory)
      );
      return grantRecord();
    },
    async selectGrantFidelity(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError(
          "Only the private source owner may select this fidelity"
        );
      }
      if (input.expectedGrantVersion !== grantVersion) {
        throw new SharedMemoryConflictError(
          "Private optimistic state and policy detail"
        );
      }
      maximumFidelity = input.maximumFidelity;
      includeCuratedMemory = input.includeCuratedMemory;
      cumulativeMaterializations.push(
        materializedLayers(maximumFidelity, includeCuratedMemory)
      );
      grantVersion += 1;
      return grantRecord();
    },
    async createShareBundle(actor, input) {
      const consent = await repository.createSourceOwnerConsent(
        actor,
        input.consent
      );
      const grant = await repository.createShareGrant(actor, input.grant);
      return { consent, grant };
    },
    async changeFidelityBundle(actor, input) {
      const consent = await repository.createSourceOwnerConsent(
        actor,
        input.consent
      );
      const grant = await repository.selectGrantFidelity(actor, input.fidelity);
      return { consent, grant };
    },
    async revokeShareGrant(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice || input.shareGrantId !== ids.grant) {
        throw new SharedMemoryAuthorizationError("private grant detail");
      }
      if (input.expectedGrantVersion !== grantVersion) {
        throw new SharedMemoryConflictError("private grant version detail");
      }
      revoked = true;
      grantVersion += 1;
      return grantRecord();
    },
    async materializeGrantRepresentation(actor, input) {
      repositoryCalls += 1;
      if (
        actor.userId !== ids.alice ||
        (input.preview.previewId !== ids.preview &&
          input.preview.previewId !== ids.lcmPreview) ||
        input.preview.previewHash !== hash
      ) {
        throw new SharedMemoryAuthorizationError("private owner detail");
      }
      return {
        ...representationRecord(
          input.preview.previewId === ids.lcmPreview
            ? "lcm_leaves"
            : "memory_events"
        )
      };
    },
    async advanceContinuousGrantRepresentations() {
      return { advanced: 0 };
    },
    async reconcileCuratedGrantRepresentations() {
      return { rematerialized: 0, invalidated: 0 };
    },
    async listPendingSharedMemorySemanticItems() {
      return [];
    },
    async getNextSharedMemorySemanticEmbeddingRetryAt() {
      return null;
    },
    async storeSharedMemorySemanticEmbedding() {
      return false;
    },
    async reusePersonalSharedMemorySemanticEmbedding() {
      return false;
    },
    async markSharedMemorySemanticEmbeddingFailed() {},
    async authorizeSharedMemorySemanticRecall() {},
    async freezeSharedMemorySemanticRecallBoundary(_actor, input) {
      return {
        teamId: ids.teamA,
        teamVersion: 1,
        teamWorkspaceId: input.teamWorkspaceId,
        workspaceVersion: 1,
        membershipVersion: 1,
        workspaceAccessVersion: 1,
        userRowVersion: "42",
        shareGrantIds: [ids.grant]
      };
    },
    async searchAuthorizedSharedMemorySemanticItems() {
      return [];
    },
    async scanAuthorizedSharedMemorySemanticItems() {
      return [];
    },
    async expandAuthorizedSharedMemorySemanticItem() {
      return null;
    },
    async listWorkspaceGrants(actor, input) {
      repositoryCalls += 1;
      lastListInput = input;
      if (actor.userId !== ids.alice && actor.userId !== ids.bob) {
        throw new SharedMemoryAuthorizationError("private workspace detail");
      }
      const entry = {
        shareGrantId: ids.grant,
        title: "Shared Memory",
        logicalMemoryId: ids.logicalMemory,
        ownerUserId: ids.alice,
        ownerDisplayName: "Alice",
        maximumFidelity,
        includeCuratedMemory,
        sourceCapabilities: capturedSourceCapabilities,
        activationRepresentation: maximumFidelity,
        activeRepresentation: maximumFidelity,
        representationState: "available" as const,
        representationSourceRevision: 1,
        representationUpdatedAt: iso,
        freshness: "fresh" as const,
        lifecycle: "active" as const,
        createdAt: iso,
        updatedAt: iso,
        companionScope,
        content: { text: "must-not-leak" },
        remoteReplicaId: ids.remoteReplica,
        creatorAuthority: `browser_session:${ids.sessionAuthority}`,
        ciphertext: "encrypted-content-must-not-leak"
      };
      const all = revoked ? [] : [entry];
      return {
        entries: all.slice(input.offset, input.offset + input.limit),
        limit: input.limit,
        offset: input.offset,
        hasMore: all.length > input.offset + input.limit
      };
    },
    async listOwnerGrants(actor, input) {
      repositoryCalls += 1;
      lastOwnerListInput = input;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private owner detail");
      }
      return {
        entries: [grantRecord()].slice(
          input.offset,
          input.offset + input.limit
        ),
        limit: input.limit,
        offset: input.offset,
        hasMore: input.offset + input.limit < 1
      };
    },
    async readGrantRepresentation(actor, input) {
      repositoryCalls += 1;
      if (
        (actor.userId !== ids.alice && actor.userId !== ids.bob) ||
        input.shareGrantId !== ids.grant ||
        revoked ||
        !sharedMemoryCeilingAuthorizes(
          maximumFidelity,
          input.representation,
          includeCuratedMemory
        )
      ) {
        throw new SharedMemoryAuthorizationError(
          "Private Team, Workspace, and lifecycle detail"
        );
      }
      return readResult(input.representation, input.page);
    }
  };

  const sourceGrantRecord = (input: {
    mutationId: string;
    mode?: "snapshot" | "continuous";
    creatorAuthority?: string;
    reasonCode?: string;
  }): TeamConversationSourceGrantRecord => ({
    id: randomUUID(),
    shareGrantId: ids.grant,
    artifactId: ids.sourceArtifact,
    logicalSourceId: randomUUID(),
    sourceGenerationId: randomUUID(),
    ownerUserId: ids.alice,
    sessionId: ids.sourceSession,
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    mode: input.mode ?? "continuous",
    maximumSegmentIndex: input.mode === "snapshot" ? 4 : null,
    maximumSourceOffset: input.mode === "snapshot" ? 4096 : null,
    version: sourceGrantVersion,
    lifecycle: sourceGrantLifecycle,
    mutationId: input.mutationId,
    grantedByUserId: ids.alice,
    creatorAuthority: input.creatorAuthority ?? "browser_session:test",
    createdAt: iso,
    updatedAt: iso,
    revokedAt: sourceGrantLifecycle === "revoked" ? iso : null,
    revokedByUserId: sourceGrantLifecycle === "revoked" ? ids.alice : null,
    revocationReason:
      sourceGrantLifecycle === "revoked"
        ? (input.reasonCode ?? "owner_revoked")
        : null
  });
  const sourceRepository = {
    async putTeamConversationSourceGrant(
      actor: { userId: string },
      input: Parameters<
        TeamConversationSourceRepository["putTeamConversationSourceGrant"]
      >[1]
    ) {
      repositoryCalls += 1;
      if (
        actor.userId !== ids.alice ||
        input.shareGrantId !== ids.grant ||
        input.teamId !== ids.teamA ||
        input.expectedVersion !== sourceGrantVersion
      ) {
        throw new SharedMemoryAuthorizationError("private source detail");
      }
      sourceGrantVersion += 1;
      sourceGrantLifecycle = "active";
      return sourceGrantRecord(input);
    },
    async revokeTeamConversationSourceGrant(
      actor: { userId: string },
      input: Parameters<
        TeamConversationSourceRepository["revokeTeamConversationSourceGrant"]
      >[1]
    ) {
      repositoryCalls += 1;
      if (
        actor.userId !== ids.alice ||
        input.shareGrantId !== ids.grant ||
        input.teamId !== ids.teamA ||
        input.expectedVersion !== sourceGrantVersion
      ) {
        throw new SharedMemoryAuthorizationError("private source detail");
      }
      sourceGrantVersion += 1;
      sourceGrantLifecycle = "revoked";
      return sourceGrantRecord(input);
    }
  } as TeamConversationSourceRepository;

  return {
    ids,
    users,
    repository,
    sourceRepository,
    get repositoryCalls() {
      return repositoryCalls;
    },
    get lastListInput() {
      return lastListInput;
    },
    get lastOwnerListInput() {
      return lastOwnerListInput;
    },
    get browserAuthorityReferenceIds() {
      return browserAuthorityReferenceIds;
    },
    get personalNoteUpload() {
      return personalNoteUpload;
    },
    get continuousNoteAdvancement() {
      return continuousNoteAdvancement;
    },
    get cumulativeMaterializations() {
      return cumulativeMaterializations;
    },
    restoreMaximumFidelity() {
      maximumFidelity = "memory_events";
    }
  };
};

const buildTestServer = async (
  fixture: ReturnType<typeof createFixture>,
  options: {
    sessionCreatedAt?: Date;
    reportDiagnostic?: SharedMemoryRouteContext["reportDiagnostic"];
  } = {}
) => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const candidate =
      typeof error === "object" && error !== null && "statusCode" in error
        ? error.statusCode
        : undefined;
    const statusCode =
      error instanceof z.ZodError
        ? 400
        : typeof candidate === "number"
          ? candidate
          : 500;
    reply.status(statusCode).send({
      error:
        error instanceof z.ZodError
          ? "Invalid request payload"
          : error instanceof Error
            ? error.message
            : String(error)
    });
  });

  const sessionUser = async (request: FastifyRequest): Promise<UserRecord> => {
    const user = fixture.users.get(request.cookies.cm_session ?? "");
    if (!user) {
      throw Object.assign(new Error("Session cookie required"), {
        statusCode: 401
      });
    }
    return user;
  };

  const deviceContext = async (
    request: FastifyRequest
  ): Promise<DeviceCredentialAuthContext> => {
    const authorization = request.headers.authorization;
    const match = /^Koed-Device (reader|share|owner-share):secret$/.exec(
      authorization ?? ""
    );
    if (!match) {
      throw Object.assign(new Error("Device credential required"), {
        statusCode: 401
      });
    }
    const credentialKeyId = match[1]!;
    const operationFamilies =
      credentialKeyId === "reader"
        ? ["team_workspace_read", "team_chat_read"]
        : ["share_grant_management"];
    const ownerUserId =
      credentialKeyId === "owner-share" ? fixture.ids.alice : fixture.ids.bob;
    return {
      user: fixture.users.get(ownerUserId)!,
      credential: {
        id: randomUUID(),
        ownerUserId,
        enrollmentChallengeId: null,
        credentialKeyId,
        upstreamBackendId: randomUUID(),
        deviceInstanceId: randomUUID(),
        lineageId: randomUUID(),
        deviceLabel: null,
        credentialVersion: 1,
        verifierKind: "secret_hash",
        operationFamilies,
        metadata: {},
        createdAt: iso,
        updatedAt: iso,
        lastUsedAt: null,
        lastValidatedAt: iso,
        expiresAt: null,
        revokedAt: null,
        revokedByUserId: null,
        revocationReason: null
      }
    };
  };

  const authenticateSessionOrDeviceCredential: SharedMemoryRouteContext["authenticateSessionOrDeviceCredential"] =
    async (request, operationFamily, options = {}) => {
      if (/^Bearer(?:\s|$)/i.test(request.headers.authorization ?? "")) {
        throw Object.assign(
          new Error(options.apiTokenError ?? "Scoped credential required"),
          { statusCode: 403 }
        );
      }
      if (/^Koed-Device(?:\s|$)/i.test(request.headers.authorization ?? "")) {
        const context = await deviceContext(request);
        if (!context.credential.operationFamilies.includes(operationFamily)) {
          throw Object.assign(new Error("Device scope denied"), {
            statusCode: 403
          });
        }
        return context.user;
      }
      return sessionUser(request);
    };

  const noRateLimit = async () => {};
  const highRiskRepository = {
    async executeActionGrant(
      input: Parameters<HighRiskActionRepository["executeActionGrant"]>[0]
    ) {
      if (input.actionGrant !== "hrg_test_shared_memory_secret") return null;
      const receipt = await input.execute({
        sharedMemory: fixture.repository,
        teamConversationSource: fixture.sourceRepository
      } as never);
      return receipt ? { ...receipt, replayed: false } : null;
    }
  } as unknown as Pick<HighRiskActionRepository, "executeActionGrant">;
  const companionThreadId = randomUUID();
  const collaborationRepository = {
    async getAuthorizedSnapshot() {
      return {
        scope: "team",
        personalOwnerUserId: null,
        teamId: fixture.ids.teamA,
        highWaterCursor: 1,
        threads: [
          {
            id: companionThreadId,
            logicalId: randomUUID(),
            scope: "team",
            kind: "shared_session_discussion",
            personalOwnerUserId: null,
            teamId: fixture.ids.teamA,
            teamWorkspaceId: fixture.ids.workspaceA,
            sharedLogicalMemoryId: fixture.ids.logicalMemory,
            shareGrantId: fixture.ids.grant,
            systemKey: null,
            name: "Shared discussion",
            topic: null,
            createdByUserId: fixture.ids.alice,
            version: 1,
            lifecycle: "active",
            latestSequence: 1,
            lastReadMessageId: null,
            lastReadSequence: 0,
            unreadCount: 1,
            participants: [],
            createdAt: iso,
            updatedAt: iso,
            lastActivityAt: iso,
            archivedAt: null
          }
        ]
      };
    },
    async listMessages() {
      return {
        messages: [
          {
            id: randomUUID(),
            threadId: companionThreadId,
            threadSequence: 1,
            scope: "team",
            personalOwnerUserId: null,
            teamId: fixture.ids.teamA,
            teamWorkspaceId: fixture.ids.workspaceA,
            senderKind: "user",
            senderPrincipalId: `user:${fixture.ids.alice}`,
            senderUserId: fixture.ids.alice,
            senderDisplayName: "Alice",
            bodyText: "Review the shared source.",
            metadata: {},
            provenance: { kind: "user_authored", id: randomUUID() },
            createdAt: iso,
            updatedAt: iso
          }
        ],
        hasMore: false,
        nextBeforeSequence: null,
        nextAfterSequence: null
      };
    }
  } as unknown as CollaborationRepository;
  registerSharedMemoryRoutes(app, {
    requireSharedMemoryRepository: () => fixture.repository,
    requireTeamConversationSourceRepository: () => fixture.sourceRepository,
    requireCollaborationRepository: () => collaborationRepository,
    requireHighRiskRepository: () => highRiskRepository,
    authenticateSession: sessionUser,
    authenticateSessionContext: async (request) => ({
      sessionId: fixture.ids.sessionAuthority,
      createdAt: options.sessionCreatedAt ?? new Date(),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      user: await sessionUser(request)
    }),
    authenticateDeviceCredential: deviceContext,
    authenticateSessionOrDeviceCredential,
    readRateLimit: noRateLimit,
    writeRateLimit: noRateLimit,
    reportDiagnostic: options.reportDiagnostic
  });
  return app;
};

const sessionHeaders = (userId: string) => ({
  cookie: `cm_session=${userId}`
});

const authority = () => ({
  action: SHARED_MEMORY_AUTHORITY,
  source: "browser_session" as const
});

const capturedIntent = (
  fixture: ReturnType<typeof createFixture>,
  activationRepresentation:
    | "memory_events"
    | "lcm_leaves"
    | "lcm_rollups"
    | "curated_assertions" = "memory_events",
  mode: "snapshot" | "continuous" = "continuous"
) => ({
  source: {
    kind: "captured_session" as const,
    sessionId: fixture.ids.sourceSession,
    logicalMemoryId: fixture.ids.logicalMemory
  },
  sourceCapabilities: [
    "lcm_rollups" as const,
    "lcm_leaves" as const,
    "memory_events" as const,
    "curated_assertions" as const
  ],
  activationRepresentation,
  mode
});

const sourceItem = (ids: ReturnType<typeof createFixture>["ids"]) => ({
  itemType: "user_message" as const,
  schemaVersion: 1 as const,
  sourceId: ids.source,
  sourceLogicalMemoryId: ids.logicalMemory,
  sourceRevision: 1,
  occurredAt: iso,
  content: { text: "shareable source" }
});

const binding = () => ({
  sourceRevision: 1,
  sourceHash: hash,
  fidelityPolicyRevision: 1,
  fidelityPolicyHash: hash,
  contentPolicyVersion: 1,
  contentPolicyHash: hash,
  classifierVersion: 1,
  classifierHash: hash
});

const fidelityBody = (fixture: ReturnType<typeof createFixture>) => ({
  ...capturedIntent(fixture, "memory_events", "continuous"),
  mutationId: randomUUID(),
  logicalMemoryId: fixture.ids.logicalMemory,
  teamId: fixture.ids.teamA,
  teamWorkspaceId: fixture.ids.workspaceA,
  consentId: fixture.ids.consent,
  maximumFidelity: "memory_events" as const,
  includeCuratedMemory: false,
  expectedGrantVersion: 1,
  preview: { previewId: fixture.ids.preview, previewHash: hash },
  previewRevision: 1,
  expiresAt: null,
  authority: authority()
});

const scopedGrantUrl = (fixture: ReturnType<typeof createFixture>) =>
  `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/share-grants/${fixture.ids.grant}`;

const workspaceGrantIndexUrl = (fixture: ReturnType<typeof createFixture>) =>
  `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/share-grants`;

const ownerGrantIndexUrl = (fixture: ReturnType<typeof createFixture>) =>
  `/v1/shared-memory/logical-memories/${fixture.ids.logicalMemory}/share-grants`;

describe("Shared Memory HTTP routes", () => {
  it("requires device-bound provenance for candidate admission", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const candidate = {
      ...capturedIntent(fixture),
      logicalMemoryId: fixture.ids.logicalMemory,
      candidateHash: hash,
      sourceRevision: 1,
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: fixture.ids.source, revisionHash: hash }],
      byteCount: 128,
      teamId: fixture.ids.teamA,
      teamWorkspaceId: fixture.ids.workspaceA,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
      expiresAt: null
    };
    const browser = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/candidate-previews",
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        ...candidate,
        sourceDeploymentProtocolId: randomUUID(),
        sourceOwnerPrincipalId: fixture.ids.alice,
        authority: authority()
      }
    });
    const missingProvenance = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/candidate-previews",
      headers: {
        authorization: "Koed-Device owner-share:secret",
        "x-koed-action-grant": "hrg_test_shared_memory_secret"
      },
      payload: {
        ...candidate,
        authority: {
          action: SHARED_MEMORY_AUTHORITY,
          source: "device_action_grant",
          referenceId: fixture.ids.actionGrantAuthority
        }
      }
    });

    expect([browser.statusCode, missingProvenance.statusCode]).toEqual([
      400, 400
    ]);
    await app.close();
  });

  it("reports Action Grant binding failures with safe reference-only diagnostics", async () => {
    const fixture = createFixture();
    const diagnostics: Array<
      Parameters<NonNullable<SharedMemoryRouteContext["reportDiagnostic"]>>[0]
    > = [];
    const app = await buildTestServer(fixture, {
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/transcript-access/revoke`,
      headers: {
        authorization: "Koed-Device owner-share:secret",
        "x-koed-action-grant": "hrg_changed_secret"
      },
      payload: {
        mutationId: randomUUID(),
        teamId: fixture.ids.teamA,
        expectedVersion: 1,
        reasonCode: "owner_revoked",
        authority: {
          action: SHARED_MEMORY_AUTHORITY,
          source: "device_action_grant",
          referenceId: fixture.ids.actionGrantAuthority
        }
      }
    });

    expect(response.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(response)).toEqual({
      error: "Shared Memory operation is not authorized"
    });
    expect(diagnostics).toEqual([
      {
        code: "shared_memory_action_grant_binding_failed",
        operation: "shared_memory.transcript_access.revoke",
        publicGrantReference: fixture.ids.actionGrantAuthority,
        failureStage: "action_grant_execution",
        httpStatus: 403
      }
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("hrg_changed_secret");
    await app.close();
  });

  it("grants and revokes independent Team Conversation source access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const put = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/transcript-access`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        mutationId: randomUUID(),
        teamId: fixture.ids.teamA,
        expectedVersion: 0,
        mode: "continuous",
        authority: authority()
      }
    });
    const revoke = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/transcript-access/revoke`,
      headers: {
        authorization: "Koed-Device owner-share:secret",
        "x-koed-action-grant": "hrg_test_shared_memory_secret"
      },
      payload: {
        mutationId: randomUUID(),
        teamId: fixture.ids.teamA,
        expectedVersion: 1,
        reasonCode: "owner_revoked",
        authority: {
          action: SHARED_MEMORY_AUTHORITY,
          source: "device_action_grant",
          referenceId: fixture.ids.actionGrantAuthority
        }
      }
    });

    expect(put.statusCode).toBe(201);
    expect(
      jsonBody<{ transcriptAccess: Record<string, unknown> }>(put)
    ).toMatchObject({
      transcriptAccess: {
        shareGrantId: fixture.ids.grant,
        teamId: fixture.ids.teamA,
        mode: "continuous",
        version: 1,
        lifecycle: "active"
      }
    });
    expect(revoke.statusCode).toBe(200);
    expect(
      jsonBody<{ transcriptAccess: Record<string, unknown> }>(revoke)
    ).toMatchObject({
      transcriptAccess: {
        version: 2,
        lifecycle: "revoked"
      }
    });
    expect(put.body).not.toContain(fixture.ids.sourceArtifact);
    expect(revoke.body).not.toContain("creatorAuthority");
    await app.close();
  });

  it("denies API Tokens and unrelated Users from source grant management", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const payload = {
      mutationId: randomUUID(),
      teamId: fixture.ids.teamA,
      expectedVersion: 0,
      mode: "continuous",
      authority: authority()
    };
    const bearer = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/transcript-access`,
      headers: { authorization: "Bearer personal-api-token" },
      payload
    });
    const unrelated = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/transcript-access`,
      headers: sessionHeaders(fixture.ids.carol),
      payload: { ...payload, mutationId: randomUUID() }
    });

    expect([bearer.statusCode, unrelated.statusCode]).toEqual([403, 403]);
    expect(fixture.repositoryCalls).toBe(1);
    await app.close();
  });

  it("accepts one bounded Personal Note source only from the approved owner device", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const pendingShareId = randomUUID();
    const noteId = randomUUID();
    const memoryEventId = randomUUID();
    const logicalMemoryId = randomUUID();
    const source = {
      kind: "personal_note" as const,
      noteId,
      noteRevision: 1,
      memoryEventId,
      logicalMemoryId
    };
    const candidate = {
      source,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      mode: "snapshot" as const,
      expiresAt: null,
      logicalMemoryId,
      sourceRevision: 1,
      candidateHash: "c".repeat(64),
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: memoryEventId, revisionHash: "d".repeat(64) }],
      byteCount: 128,
      items: [
        {
          id: memoryEventId,
          representation: "memory_events" as const,
          sequence: 1,
          occurredAt: iso,
          sourceItems: [
            {
              id: memoryEventId,
              sourceKind: "user_message" as const,
              occurredAt: iso,
              body: "Ship on Tuesday.",
              actorName: null,
              toolName: null,
              toolCallId: null
            }
          ]
        }
      ]
    };
    const payload = {
      sourceDeploymentProtocolId: randomUUID(),
      sourceOwnerPrincipalId: randomUUID(),
      candidate
    };
    const accepted = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/pending-shares/${pendingShareId}/personal-note-source`,
      headers: { authorization: "Koed-Device owner-share:secret" },
      payload
    });
    const browser = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/pending-shares/${pendingShareId}/personal-note-source`,
      headers: sessionHeaders(fixture.ids.alice),
      payload
    });
    const reader = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/pending-shares/${pendingShareId}/personal-note-source`,
      headers: { authorization: "Koed-Device reader:secret" },
      payload
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect([browser.statusCode, reader.statusCode]).toEqual([401, 403]);
    expect(fixture.personalNoteUpload).toMatchObject({
      pendingShareId,
      sourceDeploymentProtocolId: payload.sourceDeploymentProtocolId,
      sourceOwnerPrincipalId: payload.sourceOwnerPrincipalId,
      candidate: { source, itemCount: 1, sourceRevision: 1 }
    });
    await app.close();
  });

  it("advances a continuous Personal Note only through its scoped owner device", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const noteId = randomUUID();
    const memoryEventId = randomUUID();
    const logicalMemoryId = randomUUID();
    const mutationId = randomUUID();
    const candidate = {
      source: {
        kind: "personal_note" as const,
        noteId,
        noteRevision: 2,
        memoryEventId,
        logicalMemoryId
      },
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      mode: "continuous" as const,
      expiresAt: null,
      logicalMemoryId,
      sourceRevision: 2,
      candidateHash: "c".repeat(64),
      itemCount: 1,
      excludedItemCount: 0,
      manifest: [{ sourceId: memoryEventId, revisionHash: "d".repeat(64) }],
      byteCount: 128,
      items: [
        {
          id: memoryEventId,
          representation: "memory_events" as const,
          sequence: 2,
          occurredAt: iso,
          sourceItems: [
            {
              id: memoryEventId,
              sourceKind: "user_message" as const,
              occurredAt: iso,
              body: "Updated Personal Note.",
              actorName: null,
              toolName: null,
              toolCallId: null
            }
          ]
        }
      ]
    };
    const payload = {
      mutationId,
      sourceDeploymentProtocolId: randomUUID(),
      sourceOwnerPrincipalId: fixture.ids.alice,
      candidate
    };
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/personal-note-revisions/advance",
      headers: { authorization: "Koed-Device owner-share:secret" },
      payload
    });
    const apiToken = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/personal-note-revisions/advance",
      headers: { authorization: "Bearer personal-api-token" },
      payload
    });
    const reader = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/personal-note-revisions/advance",
      headers: { authorization: "Koed-Device reader:secret" },
      payload
    });
    const unrelatedOwner = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/personal-note-revisions/advance",
      headers: { authorization: "Koed-Device share:secret" },
      payload
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/personal-note-revisions/advance",
      headers: { authorization: "Koed-Device owner-share:secret" },
      payload: {
        mutationId: randomUUID(),
        sourceDeploymentProtocolId: payload.sourceDeploymentProtocolId,
        sourceOwnerPrincipalId: payload.sourceOwnerPrincipalId,
        candidate: { ...candidate, mode: "snapshot" }
      }
    });

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      jsonBody<{ pendingShares: unknown[] }>(accepted).pendingShares
    ).toHaveLength(1);
    expect(jsonBody<{ outcomes: unknown[] }>(accepted).outcomes).toHaveLength(
      1
    );
    expect([
      apiToken.statusCode,
      reader.statusCode,
      unrelatedOwner.statusCode
    ]).toEqual([403, 403, 403]);
    expect(malformed.statusCode).toBe(400);
    expect(fixture.continuousNoteAdvancement).toMatchObject({
      mutationId,
      candidate: {
        source: candidate.source,
        sourceRevision: 2,
        mode: "continuous"
      }
    });
    expect(fixture.continuousNoteAdvancement?.deviceCredentialId).toEqual(
      expect.any(String)
    );
    expect(fixture.repositoryCalls).toBe(2);
    await app.close();
  });

  it("requires fresh browser authentication to grant source access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture, {
      sessionCreatedAt: new Date(Date.now() - 60 * 60 * 1000)
    });
    const response = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/transcript-access`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        mutationId: randomUUID(),
        teamId: fixture.ids.teamA,
        expectedVersion: 0,
        mode: "continuous",
        authority: authority()
      }
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.repositoryCalls).toBe(0);
    await app.close();
  });

  it("denies API Tokens from owner mutations, previews, and Team reads", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const bearer = { authorization: "Bearer personal-api-token" };

    const selection = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/fidelity-bundle`,
      headers: bearer,
      payload: fidelityBody(fixture)
    });
    const preview = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers: bearer,
      payload: {
        ...capturedIntent(fixture),
        logicalMemoryId: fixture.ids.logicalMemory,
        remoteReplicaId: fixture.ids.remoteReplica,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: authority()
      }
    });
    const read = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}?representation=memory_events`,
      headers: bearer
    });
    const index = await app.inject({
      method: "GET",
      url: workspaceGrantIndexUrl(fixture),
      headers: bearer
    });
    const ownerIndex = await app.inject({
      method: "GET",
      url: ownerGrantIndexUrl(fixture),
      headers: bearer
    });

    expect([
      selection.statusCode,
      preview.statusCode,
      read.statusCode,
      index.statusCode,
      ownerIndex.statusCode
    ]).toEqual([403, 403, 403, 403, 403]);
    expect(fixture.repositoryCalls).toBe(0);
    await app.close();
  });

  it("lists every current grant state only for the source owner", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const owner = await app.inject({
      method: "GET",
      url: `${ownerGrantIndexUrl(fixture)}?limit=25&offset=0`,
      headers: sessionHeaders(fixture.ids.alice)
    });
    const ownerDevice = await app.inject({
      method: "GET",
      url: ownerGrantIndexUrl(fixture),
      headers: { authorization: "Koed-Device owner-share:secret" }
    });
    const teammate = await app.inject({
      method: "GET",
      url: ownerGrantIndexUrl(fixture),
      headers: sessionHeaders(fixture.ids.bob)
    });

    expect([
      owner.statusCode,
      ownerDevice.statusCode,
      teammate.statusCode
    ]).toEqual([200, 200, 403]);
    expect(
      jsonBody<{ shareGrants: SharedMemoryGrantRecord[] }>(owner)
    ).toMatchObject({
      shareGrants: [
        {
          id: fixture.ids.grant,
          logicalMemoryId: fixture.ids.logicalMemory,
          ownerUserId: fixture.ids.alice,
          grantVersion: 1
        }
      ]
    });
    expect(owner.body).not.toContain("remoteReplicaId");
    expect(owner.body).not.toContain("creatorAuthority");
    expect(fixture.lastOwnerListInput).toEqual({
      logicalMemoryId: fixture.ids.logicalMemory,
      limit: 50,
      offset: 0
    });
    await app.close();
  });

  it("creates a persisted authoritative preview and returns a safe DTO", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const response = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        ...capturedIntent(fixture),
        logicalMemoryId: fixture.ids.logicalMemory,
        remoteReplicaId: fixture.ids.remoteReplica,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: authority()
      }
    });

    expect(response.statusCode).toBe(200);
    const body = jsonBody<{ preview: Record<string, unknown> }>(response);
    expect(body.preview).toMatchObject({
      previewId: fixture.ids.preview,
      previewHash: hash,
      previewRevision: 1,
      logicalMemoryId: fixture.ids.logicalMemory,
      teamId: fixture.ids.teamA,
      teamWorkspaceId: fixture.ids.workspaceA,
      representation: "memory_events",
      sourceContentHash: hash,
      sourceRevision: 1,
      sourceHash: hash
    });
    expect(response.body).toContain("server-loaded source");
    expect(response.body).not.toContain("remoteReplicaId");
    expect(response.body).not.toContain("ownerPrincipalId");
    expect(response.body).not.toContain("deviceProvenanceHash");
    expect(response.body).not.toContain(fixture.ids.remoteReplica);
    expect(fixture.browserAuthorityReferenceIds).toEqual([
      fixture.ids.sessionAuthority
    ]);
    await app.close();
  });

  it("authorizes hierarchical previews cumulatively and Curated Memory separately", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);
    const base = {
      ...capturedIntent(fixture),
      logicalMemoryId: fixture.ids.logicalMemory,
      remoteReplicaId: fixture.ids.remoteReplica,
      teamId: fixture.ids.teamA,
      teamWorkspaceId: fixture.ids.workspaceA,
      authority: authority()
    };
    const cumulative = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers,
      payload: {
        ...base,
        activationRepresentation: "lcm_rollups",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false
      }
    });
    const curatedDenied = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers,
      payload: {
        ...base,
        activationRepresentation: "curated_assertions",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false
      }
    });
    const curatedAllowed = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers,
      payload: {
        ...base,
        activationRepresentation: "curated_assertions",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: true
      }
    });

    expect([
      cumulative.statusCode,
      curatedDenied.statusCode,
      curatedAllowed.statusCode
    ]).toEqual([200, 400, 200]);
    expect(fixture.repositoryCalls).toBe(2);
    await app.close();
  });

  it("removes standalone consent and direct Share Grant activation endpoints", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const preview = { previewId: fixture.ids.preview, previewHash: hash };

    const consent = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        ...capturedIntent(fixture, "memory_events", "snapshot"),
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview,
        previewRevision: 1,
        mode: "snapshot",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: authority()
      }
    });
    const grant = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/share-grants",
      headers: {
        authorization: "Koed-Device owner-share:secret",
        "x-koed-action-grant": "hrg_test_shared_memory_secret"
      },
      payload: {
        ...capturedIntent(fixture, "memory_events", "continuous"),
        mutationId: randomUUID(),
        logicalGrantId: fixture.ids.logicalGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        consentId: fixture.ids.consent,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: {
          action: SHARED_MEMORY_AUTHORITY,
          source: "device_action_grant",
          referenceId: fixture.ids.actionGrantAuthority
        }
      }
    });
    const browserReferenceId = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/share-grants",
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        ...capturedIntent(fixture, "memory_events", "snapshot"),
        mutationId: randomUUID(),
        logicalGrantId: randomUUID(),
        logicalMemoryId: fixture.ids.logicalMemory,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        consentId: fixture.ids.consent,
        authority: {
          ...authority(),
          referenceId: randomUUID()
        }
      }
    });

    expect([
      consent.statusCode,
      grant.statusCode,
      browserReferenceId.statusCode
    ]).toEqual([404, 404, 404]);
    expect(fixture.browserAuthorityReferenceIds).toEqual([]);
    expect(consent.body).not.toContain("remoteReplicaId");
    expect(consent.body).not.toContain("previewId");
    expect(consent.body).not.toContain(fixture.ids.remoteReplica);
    expect(grant.body).not.toContain("creatorAuthority");
    await app.close();
  });

  it("creates a share and queues a cumulative fidelity change", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);
    const preview = { previewId: fixture.ids.preview, previewHash: hash };
    const share = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/pending-shares",
      headers,
      payload: {
        ...capturedIntent(fixture, "memory_events", "snapshot"),
        mutationId: randomUUID(),
        logicalGrantId: fixture.ids.logicalGrant,
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        preview,
        previewRevision: 1,
        mode: "snapshot",
        maximumFidelity: "memory_events",
        includeCuratedMemory: true,
        authority: authority()
      }
    });
    const change = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/fidelity-bundle`,
      headers,
      payload: {
        ...capturedIntent(fixture, "lcm_leaves", "continuous"),
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        preview,
        previewRevision: 1,
        mode: "continuous",
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false,
        expectedGrantVersion: 1,
        authority: authority()
      }
    });
    expect([share.statusCode, change.statusCode]).toEqual([202, 200]);
    expect(fixture.cumulativeMaterializations).toEqual([]);
    expect(change.json()).toMatchObject({
      pendingShare: {
        activationRepresentation: "lcm_leaves",
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false,
        state: "preparing",
        stage: "accepted"
      }
    });
    for (const [response, expectedGrantVersion] of [
      [share, null],
      [change, 1]
    ] as const) {
      const pendingShare = response.json().pendingShare;
      expect(pendingShareSchema.safeParse(pendingShare).success).toBe(true);
      expect(pendingShare.grantVersion).toBe(expectedGrantVersion);
      expect(pendingShare).not.toHaveProperty("teamWorkspaceId");
      expect(pendingShare).not.toHaveProperty("representation");
      expect(response.body).not.toContain("allowedRepresentations");
      expect(response.body).not.toContain("selectedRepresentation");
      expect(response.body).not.toContain("activeRepresentation");
    }
    await app.close();
  });

  it("rejects inline preview source payload smuggling before repository access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);
    const base = {
      ...capturedIntent(fixture),
      logicalMemoryId: fixture.ids.logicalMemory,
      remoteReplicaId: fixture.ids.remoteReplica,
      teamId: fixture.ids.teamA,
      teamWorkspaceId: fixture.ids.workspaceA,
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      authority: authority()
    };
    const inlineItems = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers,
      payload: {
        ...base,
        binding: binding(),
        items: [sourceItem(fixture.ids)]
      }
    });
    const inlineClassification = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers,
      payload: {
        ...base,
        classification: { hiddenReasoning: true },
        content: { text: "smuggled source text" }
      }
    });

    expect([inlineItems.statusCode, inlineClassification.statusCode]).toEqual([
      400, 400
    ]);
    for (const response of [inlineItems, inlineClassification]) {
      expect(jsonBody<{ error: string }>(response).error).toBe(
        "Invalid request payload"
      );
      expect(response.body).not.toContain("smuggled source text");
    }
    expect(fixture.repositoryCalls).toBe(0);
    await app.close();
  });

  it("rejects inline consent/materialization payloads and malformed references", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);
    const consentInlinePreview = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers,
      payload: {
        ...capturedIntent(fixture, "memory_events", "snapshot"),
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview: {
          previewId: fixture.ids.preview,
          previewHash: hash,
          binding: binding(),
          items: [sourceItem(fixture.ids)]
        },
        previewRevision: 1,
        mode: "snapshot",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: authority()
      }
    });
    const materializeInlineItems = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representations/memory_events`,
      headers,
      payload: {
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: fixture.ids.preview, previewHash: hash },
        binding: binding(),
        items: [sourceItem(fixture.ids)]
      }
    });
    const malformedReference = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representations/memory_events`,
      headers,
      payload: {
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: fixture.ids.preview, previewHash: "not-a-hash" }
      }
    });
    const legacyPolicyAliases = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/source-owner-policies/${fixture.ids.logicalMemory}`,
      headers,
      payload: {
        mutationId: randomUUID(),
        expectedCurrentVersion: 0,
        allowedRepresentations: [
          "memory_events",
          "lcm_leaves",
          "lcm_rollups",
          "memory_events"
        ]
      }
    });

    expect([
      consentInlinePreview.statusCode,
      materializeInlineItems.statusCode,
      malformedReference.statusCode,
      legacyPolicyAliases.statusCode
    ]).toEqual([404, 404, 404, 400]);
    await app.close();
  });

  it("maps owner authorization and stale replacement authority without repository detail", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const url = `/v1/shared-memory/share-grants/${fixture.ids.grant}/fidelity-bundle`;

    const denied = await app.inject({
      method: "PUT",
      url,
      headers: sessionHeaders(fixture.ids.bob),
      payload: fidelityBody(fixture)
    });
    const conflicted = await app.inject({
      method: "PUT",
      url,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { ...fidelityBody(fixture), expectedGrantVersion: 999 }
    });

    expect(denied.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(denied).error).toBe(
      "Shared Memory operation is not authorized"
    );
    expect(denied.body).not.toContain("private source owner");
    expect(conflicted.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(conflicted).error).toBe(
      "Shared Memory operation is not authorized"
    );
    expect(conflicted.body).not.toContain("policy detail");
    await app.close();
  });

  it("requires exact device scopes while repository reads re-evaluate access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const url = `${scopedGrantUrl(fixture)}?representation=memory_events`;

    const allowed = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Koed-Device reader:secret" }
    });
    const wrongScope = await app.inject({
      method: "GET",
      url,
      headers: { authorization: "Koed-Device share:secret" }
    });

    expect(allowed.statusCode).toBe(200);
    expect(wrongScope.statusCode).toBe(403);
    await app.close();
  });

  it("requires and preserves the concrete layer requested for a read", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.bob);
    const baseUrl = scopedGrantUrl(fixture);
    const omitted = await app.inject({ method: "GET", url: baseUrl, headers });
    const rollups = await app.inject({
      method: "GET",
      url: `${baseUrl}?representation=lcm_rollups`,
      headers
    });
    const curated = await app.inject({
      method: "GET",
      url: `${baseUrl}?representation=curated_assertions`,
      headers
    });

    expect(omitted.statusCode).toBe(400);
    expect(rollups.statusCode).toBe(200);
    expect(
      jsonBody<{
        sharedMemory: { representation: { representation: string } };
      }>(rollups).sharedMemory.representation.representation
    ).toBe("lcm_rollups");
    expect(curated.statusCode).toBe(403);
    await app.close();
  });

  it("returns the initial Shared Memory source and companion discussion under one authorization boundary", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const response = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}/initial-view?representation=memory_events`,
      headers: { authorization: "Koed-Device reader:secret" }
    });

    expect(response.statusCode).toBe(200);
    const teamLogicalMemoryId = sharedMemoryGrantScopedSourceId(
      fixture.ids.grant,
      fixture.ids.logicalMemory
    );
    const teamCreatorId = sharedMemoryGrantScopedPrincipalId(
      fixture.ids.grant,
      fixture.ids.alice
    );
    const body = jsonBody<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      sharedMemory: {
        grant: {
          id: fixture.ids.grant,
          teamId: fixture.ids.teamA,
          teamWorkspaceId: fixture.ids.workspaceA
        },
        representation: { sourceRevision: 1 },
        companionScope: {
          shareGrantId: fixture.ids.grant,
          logicalMemoryId: teamLogicalMemoryId
        },
        sourcePage: { itemOffset: 0, itemCount: 1 }
      },
      companion: {
        thread: {
          kind: "shared_session_discussion",
          shareGrantId: fixture.ids.grant,
          sharedLogicalMemoryId: teamLogicalMemoryId,
          createdByUserId: teamCreatorId
        },
        messages: {
          messages: [{ bodyText: "Review the shared source." }]
        }
      }
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(fixture.ids.logicalMemory);
    expect(serialized).not.toContain(fixture.ids.logicalGrant);
    expect(serialized).not.toContain(fixture.ids.consent);
    expect(serialized).not.toContain(fixture.ids.source);
    expect(serialized).not.toContain('"sourceRevisionHash"');
    expect(serialized).not.toContain('"fidelityPolicyRevision"');
    expect(serialized).not.toContain('"contentPolicyVersion"');
    expect(serialized).not.toContain('"classifierVersion"');
    await app.close();
  });

  it("returns bounded Shared Memory pages and rejects out-of-range boundaries", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const page = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}/page?representation=memory_events&direction=older&limit=1`,
      headers: { authorization: "Koed-Device reader:secret" }
    });
    const outOfRange = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}/page?representation=memory_events&direction=older&boundary=2&limit=1`,
      headers: { authorization: "Koed-Device reader:secret" }
    });

    expect(page.statusCode).toBe(200);
    expect(jsonBody<Record<string, unknown>>(page)).toMatchObject({
      sharedMemory: {
        sourcePage: { itemOffset: 0, itemCount: 1 },
        items: [
          {
            sourceId: sharedMemoryGrantScopedSourceId(
              fixture.ids.grant,
              fixture.ids.source
            )
          }
        ]
      }
    });
    expect(outOfRange.statusCode).toBe(409);
    await app.close();
  });

  it("keeps removed consent and materialization endpoints unavailable", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);

    const wrongPreview = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers,
      payload: {
        ...capturedIntent(fixture, "memory_events", "snapshot"),
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview: { previewId: randomUUID(), previewHash: "b".repeat(64) },
        previewRevision: 1,
        mode: "snapshot",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: authority()
      }
    });
    const wrongPath = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamB}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers,
      payload: {
        ...capturedIntent(fixture, "memory_events", "snapshot"),
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview: { previewId: fixture.ids.preview, previewHash: hash },
        previewRevision: 1,
        mode: "snapshot",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        authority: authority()
      }
    });
    const wrongMaterializationPreview = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representations/memory_events`,
      headers,
      payload: {
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: randomUUID(), previewHash: "b".repeat(64) }
      }
    });
    const wrongRepresentationBinding = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representations/lcm_rollups`,
      headers,
      payload: {
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: fixture.ids.preview, previewHash: hash }
      }
    });

    expect([
      wrongPreview.statusCode,
      wrongPath.statusCode,
      wrongMaterializationPreview.statusCode,
      wrongRepresentationBinding.statusCode
    ]).toEqual([404, 404, 404, 404]);
    for (const response of [wrongPreview, wrongPath]) {
      expect(jsonBody<{ error: string }>(response).error).toBe("Not Found");
    }
    for (const response of [
      wrongMaterializationPreview,
      wrongRepresentationBinding
    ]) {
      expect(jsonBody<{ error: string }>(response).error).toBe("Not Found");
    }
    await app.close();
  });

  it("fails closed across Team and Workspace paths even when a repository mock returns data", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.bob);
    const wrongTeam = `${scopedGrantUrl(fixture).replace(
      fixture.ids.teamA,
      fixture.ids.teamB
    )}?representation=memory_events`;
    const wrongWorkspace = `${scopedGrantUrl(fixture).replace(
      fixture.ids.workspaceA,
      fixture.ids.workspaceB
    )}?representation=memory_events`;
    const wrongTeamIndex = workspaceGrantIndexUrl(fixture).replace(
      fixture.ids.teamA,
      fixture.ids.teamB
    );
    const wrongWorkspaceIndex = workspaceGrantIndexUrl(fixture).replace(
      fixture.ids.workspaceA,
      fixture.ids.workspaceB
    );

    expect(
      (await app.inject({ method: "GET", url: wrongTeam, headers })).statusCode
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: wrongWorkspace, headers }))
        .statusCode
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: wrongTeamIndex, headers }))
        .statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: wrongWorkspaceIndex,
          headers
        })
      ).statusCode
    ).toBe(403);
    await app.close();
  });

  it("returns a bounded metadata-only Workspace index", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const response = await app.inject({
      method: "GET",
      url: `${workspaceGrantIndexUrl(fixture)}?limit=1&offset=0`,
      headers: sessionHeaders(fixture.ids.bob)
    });

    expect(response.statusCode).toBe(200);
    expect(fixture.lastListInput).toEqual({
      teamId: fixture.ids.teamA,
      teamWorkspaceId: fixture.ids.workspaceA,
      limit: 1,
      offset: 0
    });
    const body = jsonBody<{
      shareGrants: Array<Record<string, unknown>>;
      pagination: {
        limit: number;
        offset: number;
        hasMore: boolean;
        nextOffset: number | null;
      };
    }>(response);
    expect(body.shareGrants).toHaveLength(1);
    const teamLogicalMemoryId = sharedMemoryGrantScopedSourceId(
      fixture.ids.grant,
      fixture.ids.logicalMemory
    );
    expect(body.shareGrants[0]).toEqual({
      id: fixture.ids.grant,
      title: "Shared Memory",
      logicalMemoryId: teamLogicalMemoryId,
      ownerDisplayName: "Alice",
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      activeRepresentation: "memory_events",
      representationState: "available",
      representationSourceRevision: 1,
      representationUpdatedAt: iso,
      freshness: "fresh",
      lifecycle: "active",
      createdAt: iso,
      updatedAt: iso,
      companionScope: {
        scope: "team",
        kind: "shared_session_discussion",
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        logicalMemoryId: teamLogicalMemoryId,
        shareGrantId: fixture.ids.grant
      }
    });
    expect(body.pagination).toEqual({
      limit: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null
    });
    for (const prohibited of [
      "must-not-leak",
      "encrypted-content-must-not-leak",
      "remoteReplicaId",
      "creatorAuthority",
      fixture.ids.alice,
      "ciphertext",
      fixture.ids.remoteReplica
    ]) {
      expect(response.body).not.toContain(prohibited);
    }
    expect(body.shareGrants[0]).not.toHaveProperty("content");
    await app.close();
  });

  it("rejects out-of-bounds Workspace index pagination before repository access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const baseUrl = workspaceGrantIndexUrl(fixture);
    const headers = sessionHeaders(fixture.ids.bob);
    const invalidQueries = [
      "limit=0",
      `limit=${SHARED_MEMORY_WORKSPACE_INDEX_MAX_LIMIT + 1}`,
      "offset=-1",
      `offset=${SHARED_MEMORY_WORKSPACE_INDEX_MAX_OFFSET + 1}`,
      "limit=1.5",
      "unknown=1"
    ];

    for (const query of invalidQueries) {
      const response = await app.inject({
        method: "GET",
        url: `${baseUrl}?${query}`,
        headers
      });
      expect(response.statusCode).toBe(400);
    }
    expect(fixture.repositoryCalls).toBe(0);
    await app.close();
  });

  it("returns the repository-authorized sanitized read without exposing source bindings", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.bob);
    const url = scopedGrantUrl(fixture);

    const read = await app.inject({
      method: "GET",
      url: `${url}?representation=memory_events`,
      headers
    });
    const index = await app.inject({
      method: "GET",
      url: `${url}/items?representation=memory_events`,
      headers
    });
    const detail = await app.inject({
      method: "GET",
      url: `${url}/items/${sharedMemoryGrantScopedSourceId(
        fixture.ids.grant,
        fixture.ids.source
      )}?representation=memory_events`,
      headers
    });

    expect([read.statusCode, index.statusCode, detail.statusCode]).toEqual([
      200, 200, 200
    ]);
    for (const response of [read, index, detail]) {
      expect(response.body).toContain("shared_session_discussion");
      expect(response.body).not.toContain("raw-device-secret");
      expect(response.body).not.toContain("secret-value-with-enough-length");
      expect(response.body).not.toContain("remoteReplicaId");
      expect(response.body).not.toContain("ownerPrincipalId");
      expect(response.body).not.toContain("creatorAuthority");
      expect(response.body).not.toContain("provenanceHash");
      expect(response.body).not.toContain('"source":');
      expect(response.body).not.toContain('"sessionId":');
      expect(response.body).not.toContain('"noteId":');
      expect(response.body).not.toContain(fixture.ids.remoteReplica);
      expect(response.body).not.toContain(fixture.ids.logicalMemory);
      expect(response.body).not.toContain(fixture.ids.source);
    }
    expect(read.body).toContain("[SECRET]");
    expect(
      jsonBody<{ items: Array<{ content?: unknown }> }>(index).items[0]
    ).not.toHaveProperty("content");
    await app.close();
  });

  it("keeps cumulative lower-fidelity layers readable without substituting unavailable layers", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const readHeaders = sessionHeaders(fixture.ids.bob);
    const ownerHeaders = sessionHeaders(fixture.ids.alice);
    const eventUrl = `${scopedGrantUrl(fixture)}?representation=memory_events`;
    const leafUrl = `${scopedGrantUrl(fixture)}?representation=lcm_leaves`;
    const indexUrl = workspaceGrantIndexUrl(fixture);

    expect(
      (
        await app.inject({
          method: "GET",
          url: eventUrl,
          headers: readHeaders
        })
      ).statusCode
    ).toBe(200);
    expect(
      jsonBody<{ shareGrants: unknown[] }>(
        await app.inject({ method: "GET", url: indexUrl, headers: readHeaders })
      ).shareGrants
    ).toHaveLength(1);
    const downgrade = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/teams/${fixture.ids.teamA}/policy`,
      headers: ownerHeaders,
      payload: {
        mutationId: randomUUID(),
        expectedCurrentVersion: 1,
        maximumFidelity: "lcm_leaves",
        includeCuratedMemory: false
      }
    });
    expect(downgrade.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: eventUrl,
          headers: readHeaders
        })
      ).statusCode
    ).toBe(403);
    expect(
      (await app.inject({ method: "GET", url: leafUrl, headers: readHeaders }))
        .statusCode
    ).toBe(200);
    expect(
      jsonBody<{ shareGrants: unknown[] }>(
        await app.inject({ method: "GET", url: indexUrl, headers: readHeaders })
      ).shareGrants
    ).toHaveLength(1);

    fixture.restoreMaximumFidelity();
    const revoke = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/revoke`,
      headers: ownerHeaders,
      payload: {
        mutationId: randomUUID(),
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        expectedGrantVersion: 1,
        reasonCode: "owner_revoked",
        authority: authority()
      }
    });
    expect(revoke.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: leafUrl, headers: readHeaders }))
        .statusCode
    ).toBe(403);
    const revokedIndex = await app.inject({
      method: "GET",
      url: indexUrl,
      headers: readHeaders
    });
    expect(revokedIndex.statusCode).toBe(200);
    expect(
      jsonBody<{ shareGrants: unknown[] }>(revokedIndex).shareGrants
    ).toEqual([]);
    await app.close();
  });

  it("does not expose direct representation materialization", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representations/lcm_leaves`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: fixture.ids.lcmPreview, previewHash: hash }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(fixture.repositoryCalls).toBe(0);
    await app.close();
  });

  it("does not expose direct materialization while privacy work is pending", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representations/memory_events`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        mutationId: randomUUID(),
        consentId: fixture.ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: fixture.ids.preview, previewHash: hash }
      }
    });

    expect(response.statusCode).toBe(404);
    expect(fixture.repositoryCalls).toBe(0);
    await app.close();
  });
});
