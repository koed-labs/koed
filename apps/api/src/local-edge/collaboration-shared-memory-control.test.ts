import { randomUUID } from "node:crypto";

import {
  COLLABORATION_CONTRACT_VERSION,
  crossIdentitySyncDigest
} from "@koed/shared";
import { describe, expect, it, vi } from "vitest";

import {
  createCollaborationSharedMemoryControl,
  type CollaborationPersistedSharedMemoryConsent,
  type CollaborationPersistedSharedMemoryGrant,
  type CollaborationPersistedSharedMemoryPreview,
  type CollaborationSharedMemoryAuthorityStore,
  type CollaborationSharedMemoryControlOptions
} from "./collaboration-shared-memory-control.js";

const iso = "2026-07-17T12:00:00.000Z";
const hash = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);

const uuidFor = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

type PreviewItem = CollaborationPersistedSharedMemoryPreview["items"][number];

const ids = {
  localOwner: uuidFor(1),
  upstreamUser: uuidFor(2),
  logicalMemory: uuidFor(3),
  remoteReplica: uuidFor(4),
  team: uuidFor(5),
  workspace: uuidFor(6),
  preview: uuidFor(7),
  consent: uuidFor(8),
  logicalGrant: uuidFor(9),
  grant: uuidFor(10),
  companion: uuidFor(11),
  actionGrant: uuidFor(12),
  source: uuidFor(100),
  remoteDevice: uuidFor(101),
  syncRelationship: uuidFor(102),
  localSession: uuidFor(103),
  note: uuidFor(104),
  noteEventV1: uuidFor(105),
  noteEventV2: uuidFor(106)
};

const capturedSource = {
  kind: "captured_session" as const,
  sessionId: ids.localSession,
  logicalMemoryId: ids.logicalMemory
};

const noteSourceV1 = {
  kind: "personal_note" as const,
  noteId: ids.note,
  noteRevision: 1,
  memoryEventId: ids.noteEventV1,
  logicalMemoryId: ids.logicalMemory
};

const noteSourceV2 = {
  ...noteSourceV1,
  noteRevision: 2,
  memoryEventId: ids.noteEventV2
};

const noteCandidateV2 = {
  source: noteSourceV2,
  sourceCapabilities: ["memory_events" as const],
  activationRepresentation: "memory_events" as const,
  mode: "continuous" as const,
  expiresAt: null,
  logicalMemoryId: ids.logicalMemory,
  sourceRevision: 2,
  candidateHash: hashC,
  itemCount: 1,
  excludedItemCount: 0,
  manifest: [{ sourceId: ids.noteEventV2, revisionHash: hashB }],
  byteCount: 128,
  items: [
    {
      id: ids.noteEventV2,
      representation: "memory_events" as const,
      sequence: 2,
      occurredAt: iso,
      sourceItems: [
        {
          id: ids.noteEventV2,
          sourceKind: "user_message" as const,
          occurredAt: iso,
          body: "Personal Note revision two",
          actorName: null,
          toolName: null,
          toolCallId: null
        }
      ]
    }
  ]
};

const binding = () => ({
  sourceRevision: 4,
  sourceHash: hash,
  fidelityPolicyRevision: 3,
  fidelityPolicyHash: hash,
  contentPolicyVersion: 2,
  contentPolicyHash: hash,
  classifierVersion: 5,
  classifierHash: hash
});

const sourceItem = (index = 0): PreviewItem => ({
  itemType: "user_message" as const,
  schemaVersion: 1 as const,
  sourceId: uuidFor(100 + index),
  sourceLogicalMemoryId: ids.logicalMemory,
  sourceRevision: 4,
  occurredAt: iso,
  content: { text: `authoritative item ${index}` }
});

type TestRepresentation =
  | "memory_events"
  | "lcm_leaves"
  | "lcm_rollups"
  | "curated_assertions";

const sourceItemForRepresentation = (
  representation: TestRepresentation
): PreviewItem => {
  if (representation === "memory_events") return sourceItem();
  if (representation === "curated_assertions") {
    return {
      ...sourceItem(),
      itemType: "curated_assertion",
      content: {
        assertionText: "The authorized Curated Memory assertion.",
        topicTitle: null,
        tags: ["authorized"],
        sourceCount: 1
      }
    };
  }
  return {
    ...sourceItem(),
    itemType: representation === "lcm_leaves" ? "lcm_leaf" : "lcm_rollup",
    content: {
      summaryText: `The authorized ${representation} summary.`,
      lexicalAnchors: ["authorized"],
      sourceIds: [ids.source]
    }
  };
};

const previewResponse = (items: PreviewItem[] = [sourceItem()]) => ({
  source: capturedSource,
  sourceCapabilities: [
    "lcm_rollups",
    "lcm_leaves",
    "memory_events"
  ] as CollaborationPersistedSharedMemoryPreview["sourceCapabilities"],
  activationRepresentation: "memory_events" as const,
  mode: "continuous" as const,
  previewId: ids.preview,
  previewHash: hash,
  previewRevision: 1,
  logicalMemoryId: ids.logicalMemory,
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  representation: "memory_events" as const,
  maximumFidelity: "memory_events" as const,
  includeCuratedMemory: false,
  binding: binding(),
  items,
  sourceContentHash: hashB,
  sourceRevision: 4,
  sourceHash: hash,
  createdAt: iso
});

const grantResponse = (
  input: {
    lifecycle?: "active" | "unavailable" | "revoked";
    grantVersion?: number;
    maximumFidelity?: "memory_events" | "lcm_leaves" | "lcm_rollups";
    includeCuratedMemory?: boolean;
    consentId?: string;
    sourceRevision?: number;
    updatedAt?: string;
  } = {}
) => ({
  source: capturedSource,
  sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"] as const,
  activationRepresentation: "memory_events" as const,
  mode: "continuous" as const,
  id: ids.grant,
  logicalGrantId: ids.logicalGrant,
  logicalMemoryId: ids.logicalMemory,
  ownerUserId: ids.upstreamUser,
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  consentId: input.consentId ?? ids.consent,
  maximumFidelity: input.maximumFidelity ?? "memory_events",
  includeCuratedMemory: input.includeCuratedMemory ?? false,
  fidelityPolicyRevision: 3,
  sourceRevision: input.sourceRevision ?? 4,
  grantVersion: input.grantVersion ?? 1,
  lifecycle: input.lifecycle ?? "active",
  createdAt: iso,
  updatedAt: input.updatedAt ?? iso,
  revokedAt: input.lifecycle === "revoked" ? iso : null,
  companionScope: {
    scope: "team" as const,
    kind: "shared_session_discussion" as const,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    logicalMemoryId: ids.logicalMemory,
    shareGrantId: ids.grant
  }
});

const teamGrantResponse = (input: Parameters<typeof grantResponse>[0] = {}) => {
  const {
    source: _source,
    logicalGrantId: _logicalGrantId,
    ownerUserId: _ownerUserId,
    consentId: _consentId,
    fidelityPolicyRevision: _fidelityPolicyRevision,
    ...grant
  } = grantResponse(input);
  void _source;
  void _logicalGrantId;
  void _ownerUserId;
  void _consentId;
  void _fidelityPolicyRevision;
  return grant;
};

const remoteReadResponse = (
  input: {
    representation?: TestRepresentation;
    maximumFidelity?: "memory_events" | "lcm_leaves" | "lcm_rollups";
    includeCuratedMemory?: boolean;
    items?: PreviewItem[];
  } = {}
) => ({
  grant: teamGrantResponse({
    maximumFidelity: input.maximumFidelity,
    includeCuratedMemory: input.includeCuratedMemory
  }),
  representation: {
    id: uuidFor(91),
    shareGrantId: ids.grant,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    logicalMemoryId: ids.logicalMemory,
    representation: input.representation ?? "memory_events",
    sourceRevision: 4,
    recordVersion: 1,
    state: "available" as const,
    chunkCount: 1,
    createdAt: iso,
    updatedAt: iso,
    availableAt: iso,
    staleAt: null,
    invalidatedAt: null,
    invalidationReasonCode: null
  },
  items:
    input.items ??
    (input.representation
      ? [sourceItemForRepresentation(input.representation)]
      : [sourceItem(0), sourceItem(1), sourceItem(2)]),
  sourcePage: {
    itemOffset: 0,
    itemCount:
      input.items?.length ?? (input.representation === undefined ? 3 : 1)
  },
  freshness: "fresh" as const,
  companionScope: grantResponse().companionScope
});

type RemoteReadResponse = ReturnType<typeof remoteReadResponse>;

const collaborationConsent = (): CollaborationPersistedSharedMemoryConsent => ({
  backendId: "team-backend",
  localOwnerUserId: ids.localOwner,
  upstreamUserId: ids.upstreamUser,
  previewId: ids.preview,
  consent: {
    source: capturedSource,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    id: ids.consent,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    workspaceId: ids.workspace,
    mode: "continuous",
    state: "active",
    version: 1,
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    previewRevision: 1,
    previewHash: hash,
    sourceRevision: 4,
    createdAt: iso,
    updatedAt: iso,
    activatedAt: iso,
    revokedAt: null
  }
});

const collaborationGrant = (
  input: {
    lifecycle?: "active" | "unavailable" | "revoked";
    grantVersion?: number;
    maximumFidelity?: "memory_events" | "lcm_leaves" | "lcm_rollups";
    includeCuratedMemory?: boolean;
    consentId?: string;
    sourceRevision?: number;
    updatedAt?: string;
  } = {}
): CollaborationPersistedSharedMemoryGrant => ({
  backendId: "team-backend",
  localOwnerUserId: ids.localOwner,
  upstreamUserId: ids.upstreamUser,
  grant: {
    source: capturedSource,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    mode: "continuous",
    id: ids.grant,
    logicalGrantId: ids.logicalGrant,
    logicalMemoryId: ids.logicalMemory,
    ownerUserId: ids.upstreamUser,
    teamId: ids.team,
    workspaceId: ids.workspace,
    consentId: input.consentId ?? ids.consent,
    maximumFidelity: input.maximumFidelity ?? "memory_events",
    includeCuratedMemory: input.includeCuratedMemory ?? false,
    fidelityPolicyRevision: 3,
    sourceRevision: input.sourceRevision ?? 4,
    grantVersion: input.grantVersion ?? 1,
    lifecycle: input.lifecycle ?? "active",
    createdAt: iso,
    updatedAt: input.updatedAt ?? iso,
    revokedAt: input.lifecycle === "revoked" ? iso : null,
    companionThreadId: ids.companion
  }
});

const commandBase = (command: string) => ({
  contractVersion: COLLABORATION_CONTRACT_VERSION,
  requestId: randomUUID(),
  command
});

const previewCommand = () => ({
  ...commandBase("collaboration.preview_shared_memory"),
  input: {
    source: capturedSource,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    mode: "continuous",
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    workspaceId: ids.workspace,
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    actionGrant: { id: ids.actionGrant }
  }
});

const shareCommand = () => ({
  ...commandBase("collaboration.share_memory"),
  input: {
    source: capturedSource,
    sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
    activationRepresentation: "memory_events",
    mutationId: randomUUID(),
    logicalGrantId: ids.logicalGrant,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    workspaceId: ids.workspace,
    consentId: ids.consent,
    mode: "continuous",
    maximumFidelity: "memory_events",
    includeCuratedMemory: false,
    previewRevision: 1,
    previewHash: hash,
    expiresAt: null,
    actionGrant: { id: ids.actionGrant }
  }
});

const context = () => ({
  upstreamBackendId: "team-backend",
  localOwnerUserId: ids.localOwner,
  desktopCredentialKeyId: "koed_desktop_test"
});

interface RecordedRequest {
  method: string;
  pathname: string;
  search: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });

const createFixture = (
  overrides: {
    upstreamAuthorization?: string | null;
    lecAuthorization?: string;
    lecFamilies?: string[];
    enrollmentBound?: boolean;
    bindEnrollment?: boolean;
    previewTarget?: boolean;
    actionGrantSecret?: string | null;
    persistPreview?: boolean;
    persistGrant?: boolean;
    persistPendingSourceWork?: boolean;
    previewItems?: PreviewItem[];
    prepareLocalLcmRepresentation?: NonNullable<
      CollaborationSharedMemoryControlOptions["prepareLocalLcmRepresentation"]
    >;
    requestPendingShareSourceWork?: NonNullable<
      CollaborationSharedMemoryControlOptions["requestPendingShareSourceWork"]
    >;
    requestContinuousNoteAdvancementWork?: NonNullable<
      CollaborationSharedMemoryControlOptions["requestContinuousNoteAdvancementWork"]
    >;
    loadPersonalNoteCandidatePreview?: NonNullable<
      CollaborationSharedMemoryControlOptions["loadPersonalNoteCandidatePreview"]
    >;
    loadLocalCandidatePreview?: NonNullable<
      CollaborationSharedMemoryControlOptions["loadLocalCandidatePreview"]
    >;
    resolveCandidateSourceIdentity?: NonNullable<
      CollaborationSharedMemoryControlOptions["resolveCandidateSourceIdentity"]
    >;
    reportDiagnostic?: NonNullable<
      CollaborationSharedMemoryControlOptions["reportDiagnostic"]
    >;
    readLocalEdgeClientCredential?: NonNullable<
      CollaborationSharedMemoryControlOptions["readLocalEdgeClientCredential"]
    >;
    resolveUpstreamAuthorization?: NonNullable<
      CollaborationSharedMemoryControlOptions["resolveUpstreamAuthorization"]
    >;
    readUpstreamRegistry?: NonNullable<
      CollaborationSharedMemoryControlOptions["readUpstreamRegistry"]
    >;
    remoteRead?: RemoteReadResponse;
    remoteOwnerGrants?: ReturnType<typeof grantResponse>[];
    remoteOwnedShares?: Record<string, unknown>[];
    remotePendingShareControl?: Record<string, unknown>;
    deniedDiscussionLogicalMemoryIds?: string[];
    mutateResponse?: (
      request: RecordedRequest,
      response: Record<string, unknown>
    ) => Record<string, unknown>;
  } = {}
) => {
  const requests: RecordedRequest[] = [];
  const enrollmentBindings: unknown[] = [];
  const grantPersistenceModes: Array<
    "mutation" | "revocation" | "authoritative_snapshot" | undefined
  > = [];
  const pendingSourceWork: Array<{
    pendingShareId: string;
    mutationId: string;
    mode: "snapshot" | "continuous";
    source: NonNullable<
      CollaborationPersistedSharedMemoryGrant["grant"]["source"]
    >;
    sourceRevision: number;
  }> = [];
  const previews = new Map<string, CollaborationPersistedSharedMemoryPreview>();
  const consents = new Map<string, CollaborationPersistedSharedMemoryConsent>();
  const grants = new Map<string, CollaborationPersistedSharedMemoryGrant>();
  const previewItems = overrides.previewItems ?? [sourceItem()];
  const resolvePreviewTargets = vi.fn(
    async (_identity: unknown, inputs: Array<Record<string, unknown>>) =>
      inputs.map(() => ({
        remoteReplicaId: ids.remoteReplica,
        syncRelationshipId: ids.syncRelationship,
        localSessionId: ids.localSession
      }))
  );
  const readAuthoritativeGrants = vi.fn(
    async (_identity: unknown, shareGrantIds: string[]) =>
      shareGrantIds.map((shareGrantId) => grants.get(shareGrantId) ?? null)
  );
  const requeueLatestContinuousPersonalNoteAdvancementWork = vi.fn(
    async () => true
  );
  const initialPreview: CollaborationPersistedSharedMemoryPreview = {
    ...previewResponse(previewItems),
    backendId: "team-backend",
    localOwnerUserId: ids.localOwner,
    upstreamUserId: ids.upstreamUser
  };
  previews.set(initialPreview.previewHash, initialPreview);
  consents.set(ids.consent, collaborationConsent());
  grants.set(ids.grant, collaborationGrant());

  const store: CollaborationSharedMemoryAuthorityStore = {
    async isEnrollmentBound() {
      return overrides.enrollmentBound ?? true;
    },
    async resolvePreviewTarget() {
      return overrides.previewTarget === false
        ? null
        : {
            remoteReplicaId: ids.remoteReplica,
            syncRelationshipId: ids.syncRelationship,
            localSessionId: ids.localSession
          };
    },
    resolvePreviewTargets,
    async persistAuthoritativePreview(input) {
      if (overrides.persistPreview === false) return null;
      const persisted: CollaborationPersistedSharedMemoryPreview = {
        ...input.preview,
        ...input.identity,
        previewRevision: 1
      };
      previews.set(persisted.previewHash, persisted);
      return persisted;
    },
    async persistAuthoritativeCandidatePreview(input) {
      const persisted: CollaborationPersistedSharedMemoryPreview = {
        ...input.preview,
        ...input.identity,
        previewRevision: 1
      };
      previews.set(persisted.previewHash, persisted);
      return persisted;
    },
    async readAuthoritativePreview(input) {
      return previews.get(input.previewHash) ?? null;
    },
    async persistAuthoritativeConsent(input) {
      const remote = input.consent;
      const persisted: CollaborationPersistedSharedMemoryConsent = {
        ...input.identity,
        previewId: input.previewId,
        consent: {
          source: remote.source,
          sourceCapabilities: remote.sourceCapabilities,
          activationRepresentation: remote.activationRepresentation,
          id: remote.id,
          logicalMemoryId: remote.logicalMemoryId,
          teamId: remote.teamId,
          workspaceId: remote.teamWorkspaceId,
          mode: remote.mode,
          state: remote.state,
          version: remote.consentVersion,
          maximumFidelity: remote.maximumFidelity,
          includeCuratedMemory: remote.includeCuratedMemory,
          previewRevision: remote.previewRevision,
          previewHash: remote.previewHash,
          sourceRevision: remote.sourceRevision,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
          activatedAt: remote.activatedAt,
          revokedAt: remote.revokedAt
        }
      };
      consents.set(remote.id, persisted);
      return persisted;
    },
    async readAuthoritativeConsent(input) {
      return consents.get(input.consentId) ?? null;
    },
    async persistAuthoritativeGrant(input) {
      grantPersistenceModes.push(input.mode);
      if (overrides.persistGrant === false) return null;
      const remote = input.grant;
      const persisted = collaborationGrant({
        lifecycle:
          remote.lifecycle === "unavailable"
            ? "unavailable"
            : remote.lifecycle === "revoked"
              ? "revoked"
              : "active",
        grantVersion: remote.grantVersion,
        maximumFidelity: remote.maximumFidelity,
        includeCuratedMemory: remote.includeCuratedMemory,
        consentId: remote.consentId,
        sourceRevision: remote.sourceRevision,
        updatedAt: remote.updatedAt
      });
      persisted.grant.companionThreadId = input.companion.companionThreadId;
      grants.set(remote.id, persisted);
      return persisted;
    },
    async readAuthoritativeGrant(input) {
      return grants.get(input.shareGrantId) ?? null;
    },
    readAuthoritativeGrants,
    async listAuthoritativeGrants(input) {
      return [...grants.values()].filter(
        (grant) => grant.grant.logicalMemoryId === input.logicalMemoryId
      );
    },
    async persistPendingShareSourceWork(input) {
      pendingSourceWork.push({
        pendingShareId: input.pendingShareId,
        mutationId: input.mutationId,
        mode: input.mode,
        source: input.source,
        sourceRevision: input.sourceRevision
      });
      return overrides.persistPendingSourceWork ?? true;
    },
    async claimPendingShareSourceWork() {
      return [];
    },
    async finishPendingShareSourceWork() {
      return true;
    },
    async claimContinuousPersonalNoteAdvancementWork() {
      return [];
    },
    async finishContinuousPersonalNoteAdvancementWork() {
      return true;
    },
    requeueLatestContinuousPersonalNoteAdvancementWork
  };

  const defaultRead = remoteReadResponse();

  const fetcher = vi.fn(
    async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      const recorded: RecordedRequest = {
        method: init?.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
        authorization: new Headers(init?.headers).get("authorization"),
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : null
      };
      requests.push(recorded);
      let response: Record<string, unknown>;
      if (url.pathname.endsWith("/v1/local-edge/device-credentials/status")) {
        response = {
          ok: true,
          auth: "device_credential",
          user: { id: ids.upstreamUser },
          credential: {
            id: ids.remoteDevice,
            ownerUserId: ids.upstreamUser,
            operationFamilies: ["team_workspace_read", "share_grant_management"]
          }
        };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith(
          "/v1/shared-memory/personal-note-revisions/advance"
        )
      ) {
        response = {
          pendingShares: [
            {
              source: recorded.body?.candidate
                ? (recorded.body.candidate as Record<string, unknown>).source
                : undefined,
              sourceCapabilities: ["memory_events"],
              activationRepresentation: "memory_events",
              id: uuidFor(720),
              mutationId: recorded.body?.mutationId,
              logicalGrantId: ids.logicalGrant,
              consentId: ids.consent,
              logicalMemoryId: ids.logicalMemory,
              teamId: ids.team,
              workspaceId: ids.workspace,
              maximumFidelity: "memory_events",
              includeCuratedMemory: false,
              mode: "continuous",
              sourceRevision: 2,
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
            }
          ],
          outcomes: [
            {
              shareGrantId: ids.grant,
              status: "accepted",
              pendingShareId: uuidFor(720)
            }
          ],
          nextShareGrantId: null
        };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/v1/shared-memory/candidate-previews")
      ) {
        response = {
          admission: {
            source: recorded.body?.source,
            sourceCapabilities: recorded.body?.sourceCapabilities,
            activationRepresentation: recorded.body?.activationRepresentation,
            previewId: ids.preview,
            previewHash: hashB,
            previewRevision: 1,
            logicalMemoryId: ids.logicalMemory,
            teamId: ids.team,
            teamWorkspaceId: ids.workspace,
            representation: recorded.body?.activationRepresentation,
            maximumFidelity: recorded.body?.maximumFidelity,
            includeCuratedMemory: recorded.body?.includeCuratedMemory,
            sourceRevision: 4,
            sourceHash: hash,
            redactedContentHash: hash,
            representationPolicyRevision: 1,
            representationPolicyHash: hashB,
            contentPolicyVersion: 1,
            contentPolicyHash: hashB,
            classifierVersion: 1,
            classifierHash: hashB,
            mode: "continuous",
            expiresAt: null,
            previewExpiresAt: "2099-01-01T00:10:00.000Z",
            itemCount: recorded.body?.itemCount,
            excludedItemCount: recorded.body?.excludedItemCount,
            manifest: recorded.body?.manifest,
            manifestHash: crossIdentitySyncDigest(recorded.body?.manifest),
            byteCount: recorded.body?.byteCount,
            createdAt: iso
          }
        };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/v1/shared-memory/previews")
      ) {
        response = { preview: previewResponse(previewItems) };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/v1/shared-memory/pending-shares")
      ) {
        response = {
          pendingShare: {
            source: recorded.body?.source,
            sourceCapabilities: recorded.body?.sourceCapabilities,
            activationRepresentation: recorded.body?.activationRepresentation,
            id: uuidFor(700),
            mutationId: recorded.body?.mutationId,
            logicalGrantId: recorded.body?.logicalGrantId,
            consentId: recorded.body?.consentId,
            logicalMemoryId: recorded.body?.logicalMemoryId,
            teamId: recorded.body?.teamId,
            workspaceId: recorded.body?.teamWorkspaceId,
            maximumFidelity: recorded.body?.maximumFidelity,
            includeCuratedMemory: recorded.body?.includeCuratedMemory,
            mode: recorded.body?.mode,
            sourceRevision: 4,
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
          }
        };
      } else if (
        recorded.method === "PUT" &&
        url.pathname.endsWith("/fidelity-bundle")
      ) {
        const requestedSource = recorded.body?.source as
          | Record<string, unknown>
          | undefined;
        response = {
          pendingShare: {
            source: recorded.body?.source,
            sourceCapabilities: recorded.body?.sourceCapabilities,
            activationRepresentation: recorded.body?.activationRepresentation,
            id: uuidFor(701),
            mutationId: recorded.body?.mutationId,
            logicalGrantId: ids.logicalGrant,
            consentId: recorded.body?.consentId,
            logicalMemoryId: recorded.body?.logicalMemoryId,
            teamId: recorded.body?.teamId,
            workspaceId: recorded.body?.teamWorkspaceId,
            maximumFidelity: recorded.body?.maximumFidelity,
            includeCuratedMemory: recorded.body?.includeCuratedMemory,
            mode: recorded.body?.mode,
            sourceRevision:
              requestedSource?.kind === "personal_note"
                ? requestedSource.noteRevision
                : 4,
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
          }
        };
      } else if (
        recorded.method === "POST" &&
        url.pathname.includes("/v1/shared-memory/pending-shares/") &&
        url.pathname.endsWith("/control")
      ) {
        response =
          overrides.remotePendingShareControl ??
          ({
            pendingShare: {
              source: capturedSource,
              sourceCapabilities: [
                "lcm_rollups",
                "lcm_leaves",
                "memory_events"
              ],
              activationRepresentation: "memory_events",
              id: url.pathname.split("/").at(-2),
              mutationId: recorded.body?.mutationId,
              logicalGrantId: ids.logicalGrant,
              consentId: ids.consent,
              logicalMemoryId: ids.logicalMemory,
              teamId: ids.team,
              workspaceId: ids.workspace,
              maximumFidelity: "memory_events",
              includeCuratedMemory: false,
              mode: "continuous",
              sourceRevision: 4,
              state:
                recorded.body?.action === "revoke" ? "revoked" : "preparing",
              stage:
                recorded.body?.action === "revoke" ? "complete" : "accepted",
              workspaceAccessState:
                recorded.body?.action === "revoke" ? "revoked" : "active",
              sourceUpdateState:
                recorded.body?.action === "revoke" ? "stopped" : "preparing",
              operationVersion: 2,
              attemptCount: 1,
              redactedFailureCode: null,
              lastProgressAt: iso,
              createdAt: iso,
              updatedAt: iso,
              activatedAt: null,
              revokedAt: recorded.body?.action === "revoke" ? iso : null,
              grantId: null,
              grantVersion: null
            }
          } as Record<string, unknown>);
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/v1/shared-memory/share-grants")
      ) {
        response = { grant: grantResponse() };
      } else if (
        recorded.method === "PATCH" &&
        url.pathname.includes("/v1/shared-memory/owned-shares/") &&
        url.pathname.endsWith("/title")
      ) {
        const id = url.pathname.split("/").at(-2);
        const share = (overrides.remoteOwnedShares ?? []).find((item) => {
          const record =
            item.kind === "pending"
              ? (item.pendingShare as Record<string, unknown>)
              : (item.grant as Record<string, unknown>);
          return record.id === id;
        });
        if (share) {
          share.summary = {
            ...(share.summary as Record<string, unknown>),
            sourceTitle: recorded.body?.title
          };
        }
        response = { share };
      } else if (
        recorded.method === "GET" &&
        url.pathname.endsWith("/v1/shared-memory/owned-shares")
      ) {
        response = {
          shares: overrides.remoteOwnedShares ?? [],
          pagination: {
            limit: Number(url.searchParams.get("limit") ?? 100),
            hasMore: false,
            next: null,
            snapshotAt: iso
          }
        };
      } else if (
        recorded.method === "GET" &&
        url.pathname.includes("/v1/shared-memory/owned-shares/")
      ) {
        const id = url.pathname.split("/").at(-1);
        const share = (overrides.remoteOwnedShares ?? []).find((item) => {
          const record =
            item.kind === "pending"
              ? (item.pendingShare as Record<string, unknown>)
              : (item.grant as Record<string, unknown>);
          return record.id === id;
        });
        response = {
          share,
          preview:
            (share?.summary as Record<string, unknown> | undefined)
              ?.authorizedPreview == null
              ? null
              : previewResponse(previewItems)
        };
      } else if (
        recorded.method === "GET" &&
        url.pathname.includes("/v1/shared-memory/logical-memories/") &&
        url.pathname.endsWith("/share-grants")
      ) {
        const shareGrants = overrides.remoteOwnerGrants ?? [grantResponse()];
        response = {
          shareGrants,
          pagination: {
            limit: 100,
            offset: 0,
            hasMore: false,
            nextOffset: null
          }
        };
      } else if (
        recorded.method === "PUT" &&
        url.pathname.includes("/representations/")
      ) {
        const representation = url.pathname.endsWith("/lcm_leaves")
          ? "lcm_leaves"
          : "memory_events";
        response = {
          representation: {
            ...defaultRead.representation,
            consentId:
              typeof recorded.body?.consentId === "string"
                ? recorded.body.consentId
                : ids.consent,
            representation
          }
        };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/discussion")
      ) {
        if (
          overrides.deniedDiscussionLogicalMemoryIds?.some((logicalMemoryId) =>
            url.pathname.includes(`/${logicalMemoryId}/discussion`)
          )
        ) {
          return json({ error: "forbidden" }, 403);
        }
        response = {
          thread: {
            id: ids.companion,
            kind: "shared_session_discussion",
            teamId: ids.team,
            teamWorkspaceId: ids.workspace,
            sharedLogicalMemoryId: ids.logicalMemory,
            shareGrantId: ids.grant
          }
        };
      } else if (url.pathname.endsWith("/revoke")) {
        response = {
          grant: grantResponse({ lifecycle: "revoked", grantVersion: 2 })
        };
      } else if (url.pathname.endsWith("/fidelity")) {
        response = {
          grant: grantResponse({
            maximumFidelity: "lcm_leaves",
            consentId: uuidFor(500),
            grantVersion: 2
          })
        };
      } else if (recorded.method === "GET") {
        const remote = overrides.remoteRead ?? defaultRead;
        const direction = url.searchParams.get("direction");
        const limit = Number(
          url.searchParams.get("limit") ?? remote.items.length
        );
        const requestedBoundary = url.searchParams.get("boundary");
        const boundary =
          requestedBoundary === null
            ? direction === "older"
              ? remote.items.length
              : 0
            : Number(requestedBoundary);
        const itemOffset =
          direction === "older" ? Math.max(0, boundary - limit) : boundary;
        const end =
          direction === "older"
            ? boundary
            : Math.min(remote.items.length, boundary + limit);
        response = {
          sharedMemory: {
            ...remote,
            items: remote.items.slice(itemOffset, end),
            sourcePage: { itemOffset, itemCount: remote.items.length }
          },
          ...(url.pathname.endsWith("/initial-view")
            ? { companion: { thread: null, messages: null } }
            : {})
        };
      } else {
        return json({ error: "not found" }, 404);
      }
      return json(overrides.mutateResponse?.(recorded, response) ?? response);
    }
  );

  const options: CollaborationSharedMemoryControlOptions = {
    koedHome: "/tmp/koed-control-test",
    upstreamBackendsPath: "/tmp/upstreams.json",
    fetch: fetcher as typeof fetch,
    resolveUpstreamAuthorization:
      overrides.resolveUpstreamAuthorization ??
      (() =>
        overrides.upstreamAuthorization === undefined
          ? "Koed-Device upstream-key:upstream-secret"
          : overrides.upstreamAuthorization),
    authorityStore: store,
    prepareLocalLcmRepresentation:
      overrides.prepareLocalLcmRepresentation ?? (async () => "ready"),
    loadLocalCandidatePreview: overrides.loadLocalCandidatePreview,
    loadPersonalNoteCandidatePreview:
      overrides.loadPersonalNoteCandidatePreview,
    resolveCandidateSourceIdentity:
      overrides.resolveCandidateSourceIdentity ??
      (() => ({
        sourceDeploymentProtocolId: uuidFor(107),
        sourceOwnerPrincipalId: ids.localOwner
      })),
    reportDiagnostic: overrides.reportDiagnostic,
    requestPendingShareSourceWork: overrides.requestPendingShareSourceWork,
    requestContinuousNoteAdvancementWork:
      overrides.requestContinuousNoteAdvancementWork,
    ensureEnrollmentBinding: overrides.bindEnrollment
      ? async (input) => {
          enrollmentBindings.push(input);
          return true;
        }
      : undefined,
    readDesktopCredential: () => ({
      version: 1,
      authorization: "Koed-Desktop local-key:local-secret",
      credentialKeyId: "koed_desktop_test",
      ownerUserId: ids.localOwner,
      operationFamilies: [
        "personal_collaboration_read",
        "personal_collaboration_write"
      ]
    }),
    readLocalEdgeClientCredential:
      overrides.readLocalEdgeClientCredential ??
      (() => ({
        authorization:
          overrides.lecAuthorization ?? "Koed-Device lec-key:lec-secret",
        backendId: "team-backend",
        credentialKeyId: "lec-key",
        operationFamilies: overrides.lecFamilies ?? [
          "team_workspace_read",
          "share_grant_management"
        ]
      })),
    readUpstreamRegistry:
      overrides.readUpstreamRegistry ??
      (() => ({
        schemaVersion: 2,
        activeBackendId: "team-backend",
        backends: [
          {
            id: "team-backend",
            baseUrl: "https://team.example.test",
            routePolicy: {
              teamWorkspaceRead: "enabled",
              shareGrantManagement: "enabled"
            },
            capabilities: {
              state: "validated",
              expiresAt: "2099-01-01T00:00:00.000Z",
              schemaVersion: 6,
              payload: {
                capabilitySchemaVersion: 6,
                protocols: {
                  sharedMemorySourceAdmission: { version: 1 }
                },
                capabilities: {
                  "memory.collaboration": { availability: "partial" }
                }
              }
            }
          }
        ]
      })),
    actionGrantLifecycle: {
      resolve: () =>
        overrides.actionGrantSecret === undefined
          ? "hrg_00000000000000000000000000000000"
          : overrides.actionGrantSecret
    }
  };

  return {
    control: createCollaborationSharedMemoryControl(options),
    requests,
    previews,
    consents,
    grants,
    store,
    enrollmentBindings,
    grantPersistenceModes,
    pendingSourceWork,
    requeueLatestContinuousPersonalNoteAdvancementWork,
    resolvePreviewTargets,
    readAuthoritativeGrants
  };
};

const expectFailure = (
  result: Awaited<
    ReturnType<ReturnType<typeof createFixture>["control"]["dispatch"]>
  >,
  code: string
) => {
  expect(result).toMatchObject({ ok: false, error: { code } });
};

const loadInitialSource = async (
  fixture: ReturnType<typeof createFixture>,
  representation: TestRepresentation = "memory_events",
  limit = 2
) => {
  const loaded = await fixture.control.loadInitialSharedSession(
    {
      requestId: randomUUID(),
      teamId: ids.team,
      workspaceId: ids.workspace,
      sharedSessionId: ids.grant,
      representation,
      limit
    },
    context()
  );
  if (!loaded) throw new Error("initial source load was not handled");
  return loaded.sourceResult;
};

describe("collaboration Shared Memory control", () => {
  it("queues an exact continuous Personal Note revision through the scoped device path", async () => {
    const wake = vi.fn();
    const fixture = createFixture({
      requestPendingShareSourceWork: wake,
      loadPersonalNoteCandidatePreview: async () => noteCandidateV2
    });

    await expect(
      fixture.control.advanceContinuousPersonalNoteRevision({
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        noteId: ids.note,
        noteRevision: 2
      })
    ).resolves.toEqual({ queued: 1 });

    const request = fixture.requests.find((entry) =>
      entry.pathname.endsWith(
        "/v1/shared-memory/personal-note-revisions/advance"
      )
    );
    expect(request).toMatchObject({
      method: "POST",
      authorization: "Koed-Device upstream-key:upstream-secret",
      body: { candidate: noteCandidateV2 }
    });
    expect(fixture.pendingSourceWork).toEqual([
      {
        pendingShareId: uuidFor(720),
        mutationId: expect.any(String),
        mode: "continuous",
        source: noteSourceV2,
        sourceRevision: 2
      }
    ]);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("pages continuous Personal Note destinations without dropping later shares", async () => {
    const wake = vi.fn();
    const cursor = uuidFor(721);
    const secondPendingShareId = uuidFor(722);
    const secondShareGrantId = uuidFor(723);
    const fixture = createFixture({
      requestPendingShareSourceWork: wake,
      loadPersonalNoteCandidatePreview: async () => noteCandidateV2,
      mutateResponse: (request, response) => {
        if (
          !request.pathname.endsWith(
            "/v1/shared-memory/personal-note-revisions/advance"
          )
        ) {
          return response;
        }
        if (!request.body?.afterShareGrantId) {
          return { ...response, nextShareGrantId: cursor };
        }
        const firstPendingShare = (
          response.pendingShares as Array<Record<string, unknown>>
        )[0]!;
        return {
          pendingShares: [
            {
              ...firstPendingShare,
              id: secondPendingShareId,
              grantId: secondShareGrantId
            }
          ],
          outcomes: [
            {
              shareGrantId: secondShareGrantId,
              status: "accepted",
              pendingShareId: secondPendingShareId
            }
          ],
          nextShareGrantId: null
        };
      }
    });

    await expect(
      fixture.control.advanceContinuousPersonalNoteRevision({
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        noteId: ids.note,
        noteRevision: 2
      })
    ).resolves.toEqual({ queued: 2 });

    const requests = fixture.requests.filter((entry) =>
      entry.pathname.endsWith(
        "/v1/shared-memory/personal-note-revisions/advance"
      )
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).not.toHaveProperty("afterShareGrantId");
    expect(requests[1]?.body).toMatchObject({ afterShareGrantId: cursor });
    expect(fixture.pendingSourceWork).toHaveLength(2);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("treats a rejected continuous Note destination as a terminal non-queued outcome", async () => {
    const wake = vi.fn();
    const fixture = createFixture({
      requestPendingShareSourceWork: wake,
      loadPersonalNoteCandidatePreview: async () => noteCandidateV2,
      mutateResponse: (request, response) =>
        request.pathname.endsWith(
          "/v1/shared-memory/personal-note-revisions/advance"
        )
          ? {
              pendingShares: [],
              outcomes: [
                {
                  shareGrantId: ids.grant,
                  status: "rejected",
                  reasonCode: "destination_unavailable"
                }
              ],
              nextShareGrantId: null
            }
          : response
    });

    await expect(
      fixture.control.advanceContinuousPersonalNoteRevision({
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        noteId: ids.note,
        noteRevision: 2
      })
    ).resolves.toEqual({ queued: 0 });

    expect(fixture.pendingSourceWork).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
  });

  it("rejects mismatched accepted continuous Note outcomes", async () => {
    const fixture = createFixture({
      loadPersonalNoteCandidatePreview: async () => noteCandidateV2,
      mutateResponse: (request, response) =>
        request.pathname.endsWith(
          "/v1/shared-memory/personal-note-revisions/advance"
        )
          ? {
              ...response,
              outcomes: [
                {
                  shareGrantId: ids.grant,
                  status: "accepted",
                  pendingShareId: randomUUID()
                }
              ]
            }
          : response
    });

    await expect(
      fixture.control.advanceContinuousPersonalNoteRevision({
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        noteId: ids.note,
        noteRevision: 2
      })
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(fixture.pendingSourceWork).toEqual([]);
  });

  it("rejects an accepted continuous Note outcome bound to the wrong grant", async () => {
    const fixture = createFixture({
      loadPersonalNoteCandidatePreview: async () => noteCandidateV2,
      mutateResponse: (request, response) =>
        request.pathname.endsWith(
          "/v1/shared-memory/personal-note-revisions/advance"
        )
          ? {
              ...response,
              outcomes: [
                {
                  shareGrantId: randomUUID(),
                  status: "accepted",
                  pendingShareId: uuidFor(720)
                }
              ]
            }
          : response
    });

    await expect(
      fixture.control.advanceContinuousPersonalNoteRevision({
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        noteId: ids.note,
        noteRevision: 2
      })
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(fixture.pendingSourceWork).toEqual([]);
  });

  it("advances continuous Personal Note work through its claimed non-active backend", async () => {
    const fixture = createFixture({
      loadPersonalNoteCandidatePreview: async () => noteCandidateV2,
      resolveUpstreamAuthorization: (backend) =>
        `Koed-Device ${backend.id}-key:${backend.id}-secret`,
      readLocalEdgeClientCredential: (_koedHome, backendId) => ({
        authorization: `Koed-Device ${backendId}-key:${backendId}-secret`,
        backendId,
        credentialKeyId: `${backendId}-key`,
        operationFamilies: ["share_grant_management"]
      }),
      readUpstreamRegistry: () => ({
        schemaVersion: 2,
        activeBackendId: "active-backend",
        backends: ["active-backend", "claimed-backend"].map((id) => ({
          id,
          baseUrl: `https://${id}.example.test`,
          routePolicy: {
            teamWorkspaceRead: "enabled",
            shareGrantManagement: "enabled"
          },
          capabilities: {
            state: "validated",
            expiresAt: "2099-01-01T00:00:00.000Z",
            schemaVersion: 6,
            payload: {
              capabilitySchemaVersion: 6,
              protocols: {
                sharedMemorySourceAdmission: { version: 1 }
              },
              capabilities: {
                "memory.collaboration": { availability: "partial" }
              }
            }
          }
        }))
      })
    });

    await expect(
      fixture.control.advanceContinuousPersonalNoteRevision({
        backendId: "claimed-backend",
        localOwnerUserId: ids.localOwner,
        noteId: ids.note,
        noteRevision: 2
      })
    ).resolves.toEqual({ queued: 1 });

    expect(
      fixture.requests.find((request) =>
        request.pathname.endsWith(
          "/v1/shared-memory/personal-note-revisions/advance"
        )
      )
    ).toMatchObject({
      authorization: "Koed-Device claimed-backend-key:claimed-backend-secret"
    });
  });

  it("requeues the latest continuous Personal Note revision when its Share resumes", async () => {
    const wake = vi.fn();
    const pendingShareId = uuidFor(721);
    const fixture = createFixture({
      requestContinuousNoteAdvancementWork: wake,
      remotePendingShareControl: {
        pendingShare: {
          source: noteSourceV2,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          id: pendingShareId,
          mutationId: uuidFor(722),
          logicalGrantId: ids.logicalGrant,
          consentId: ids.consent,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "continuous",
          sourceRevision: 2,
          state: "preparing",
          stage: "accepted",
          workspaceAccessState: "active",
          sourceUpdateState: "preparing",
          operationVersion: 4,
          attemptCount: 1,
          redactedFailureCode: null,
          lastProgressAt: iso,
          createdAt: iso,
          updatedAt: iso,
          activatedAt: iso,
          revokedAt: null,
          grantId: ids.grant,
          grantVersion: 1
        }
      }
    });

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.control_pending_share"),
        input: {
          pendingShareId,
          mutationId: uuidFor(723),
          expectedOperationVersion: 3,
          action: "resume"
        }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: { pendingShare: { source: noteSourceV2, mode: "continuous" } }
    });
    expect(
      fixture.requeueLatestContinuousPersonalNoteAdvancementWork
    ).toHaveBeenCalledWith({
      identity: {
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        upstreamUserId: ids.upstreamUser
      },
      noteId: ids.note
    });
    expect(wake).toHaveBeenCalledOnce();
  });

  it("re-enqueues the effective Personal Note revision when retrying source preparation", async () => {
    const pendingShareId = uuidFor(710);
    const sourceMutationId = uuidFor(711);
    const wake = vi.fn();
    const fixture = createFixture({
      requestPendingShareSourceWork: wake,
      remotePendingShareControl: {
        pendingShare: {
          source: noteSourceV2,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          id: pendingShareId,
          mutationId: sourceMutationId,
          logicalGrantId: ids.logicalGrant,
          consentId: ids.consent,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "snapshot",
          sourceRevision: 2,
          state: "preparing",
          stage: "accepted",
          workspaceAccessState: "active",
          sourceUpdateState: "preparing",
          operationVersion: 4,
          attemptCount: 2,
          redactedFailureCode: null,
          lastProgressAt: iso,
          createdAt: iso,
          updatedAt: iso,
          activatedAt: null,
          revokedAt: null,
          grantId: ids.grant,
          grantVersion: 1
        }
      }
    });

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.control_pending_share"),
        input: {
          pendingShareId,
          mutationId: uuidFor(712),
          expectedOperationVersion: 3,
          action: "retry"
        }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: { pendingShare: { source: noteSourceV2, operationVersion: 4 } }
    });
    expect(fixture.pendingSourceWork).toEqual([
      {
        pendingShareId,
        mutationId: sourceMutationId,
        mode: "snapshot",
        source: noteSourceV2,
        sourceRevision: 2
      }
    ]);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("does not enqueue source preparation for non-retry pending Share controls", async () => {
    const pendingShareId = uuidFor(713);
    const fixture = createFixture();

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.control_pending_share"),
        input: {
          pendingShareId,
          mutationId: uuidFor(714),
          expectedOperationVersion: 1,
          action: "revoke"
        }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: { pendingShare: { state: "revoked" } }
    });
    expect(fixture.pendingSourceWork).toEqual([]);
  });

  it("fails closed when a retry does not return a preparable source update", async () => {
    const pendingShareId = uuidFor(715);
    const fixture = createFixture({
      remotePendingShareControl: {
        pendingShare: {
          source: noteSourceV2,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          id: pendingShareId,
          mutationId: uuidFor(716),
          logicalGrantId: ids.logicalGrant,
          consentId: ids.consent,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          mode: "snapshot",
          sourceRevision: 2,
          state: "needs_attention",
          stage: "processing",
          workspaceAccessState: "active",
          sourceUpdateState: "failed",
          operationVersion: 4,
          attemptCount: 2,
          redactedFailureCode: "source_upload_failed",
          lastProgressAt: iso,
          createdAt: iso,
          updatedAt: iso,
          activatedAt: null,
          revokedAt: null,
          grantId: ids.grant,
          grantVersion: 1
        }
      }
    });

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.control_pending_share"),
        input: {
          pendingShareId,
          mutationId: uuidFor(717),
          expectedOperationVersion: 3,
          action: "retry"
        }
      },
      context()
    );

    expectFailure(result, "conflict");
    expect(fixture.pendingSourceWork).toEqual([]);
  });

  it("resolves a consent preview only for its exact persisted source", async () => {
    const fixture = createFixture();
    const input = {
      source: capturedSource,
      sourceCapabilities: [
        "lcm_rollups" as const,
        "lcm_leaves" as const,
        "memory_events" as const
      ],
      activationRepresentation: "memory_events" as const,
      mode: "continuous" as const,
      maximumFidelity: "memory_events" as const,
      includeCuratedMemory: false,
      logicalMemoryId: ids.logicalMemory,
      teamId: ids.team,
      workspaceId: ids.workspace,
      previewRevision: 1,
      previewHash: hash
    };

    await expect(
      fixture.control.resolveConsentPreview(input, context())
    ).resolves.toEqual({ previewId: ids.preview });
    await expect(
      fixture.control.resolveConsentPreview(
        {
          ...input,
          source: { ...capturedSource, sessionId: uuidFor(999) }
        },
        context()
      )
    ).resolves.toBeNull();
  });

  it("returns a bounded local candidate without resolving remote authority", async () => {
    const loadLocalCandidatePreview = vi.fn(async () => ({
      source: capturedSource,
      sourceCapabilities: ["memory_events" as const],
      activationRepresentation: "memory_events" as const,
      mode: "continuous" as const,
      expiresAt: null,
      logicalMemoryId: ids.logicalMemory,
      sourceRevision: 4,
      candidateHash: hash,
      itemCount: 0,
      excludedItemCount: 1,
      manifest: [],
      byteCount: 0,
      items: []
    }));
    const fixture = createFixture({
      upstreamAuthorization: null,
      loadLocalCandidatePreview
    });
    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.preview_shared_memory_candidate"),
        input: {
          source: capturedSource,
          activationRepresentation: "memory_events",
          mode: "continuous"
        }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: { candidate: { candidateHash: hash, excludedItemCount: 1 } }
    });
    expect(fixture.requests).toHaveLength(0);
    expect(loadLocalCandidatePreview).toHaveBeenCalledWith({
      localOwnerUserId: ids.localOwner,
      sessionId: ids.localSession,
      representation: "memory_events",
      mode: "continuous"
    });
  });

  it("binds a local candidate to an authoritative destination without a sync target", async () => {
    const localCandidate = {
      source: capturedSource,
      sourceCapabilities: [
        "lcm_rollups" as const,
        "lcm_leaves" as const,
        "memory_events" as const
      ],
      activationRepresentation: "memory_events" as const,
      mode: "continuous" as const,
      expiresAt: null,
      logicalMemoryId: ids.logicalMemory,
      sourceRevision: 4,
      candidateHash: hash,
      itemCount: 1,
      excludedItemCount: 1,
      manifest: [{ sourceId: ids.source, revisionHash: hashB }],
      byteCount: 128,
      items: [
        {
          id: ids.source,
          representation: "memory_events" as const,
          sequence: 1,
          occurredAt: iso,
          sourceItems: [
            {
              id: ids.source,
              sourceKind: "agent_message" as const,
              occurredAt: iso,
              body: "safe semantic candidate",
              actorName: null,
              toolName: null,
              toolCallId: null
            },
            {
              id: uuidFor(154),
              sourceKind: "tool_call" as const,
              occurredAt: iso,
              body: '{"cmd":"pnpm test"}',
              actorName: null,
              toolName: "exec_command",
              toolCallId: "call-preview"
            }
          ]
        }
      ]
    };
    const fixture = createFixture({
      previewTarget: false,
      loadLocalCandidatePreview: async () => localCandidate
    });
    const command = {
      ...previewCommand(),
      input: {
        ...previewCommand().input,
        candidate: {
          source: capturedSource,
          sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
          activationRepresentation: "memory_events",
          candidateHash: hash,
          sourceRevision: 4,
          itemCount: 1,
          excludedItemCount: 1,
          manifest: [{ sourceId: ids.source, revisionHash: hashB }],
          byteCount: 128,
          mode: "continuous" as const,
          expiresAt: null
        }
      }
    };

    const result = await fixture.control.dispatch(command, context());

    expect(result).toMatchObject({
      ok: true,
      data: {
        preview: {
          logicalMemoryId: ids.logicalMemory,
          previewHash: hashB,
          items: [
            { sourceItems: [{ body: "safe semantic candidate" }] },
            {
              sourceItems: [
                {
                  body: '{"cmd":"pnpm test"}',
                  sourceKind: "tool_call",
                  toolName: "exec_command",
                  toolCallId: "call-preview",
                  toolDisplay: expect.objectContaining({ kind: "command" })
                }
              ]
            }
          ]
        }
      }
    });
    expect(fixture.requests.map((request) => request.pathname)).toEqual([
      expect.stringMatching(/device-credentials\/status$/),
      "/v1/shared-memory/candidate-previews"
    ]);
  });

  it("rejects candidate execution when the backend lacks the source-admission protocol", async () => {
    const base = previewCommand();
    const fixture = createFixture({
      readUpstreamRegistry: () => ({
        schemaVersion: 2,
        activeBackendId: "team-backend",
        backends: [
          {
            id: "team-backend",
            baseUrl: "https://team.example.test",
            routePolicy: {
              teamWorkspaceRead: "enabled",
              shareGrantManagement: "enabled"
            },
            capabilities: {
              state: "validated",
              expiresAt: "2099-01-01T00:00:00.000Z",
              schemaVersion: 6,
              payload: {
                capabilitySchemaVersion: 6,
                capabilities: {
                  "memory.collaboration": { availability: "partial" }
                }
              }
            }
          }
        ]
      })
    });

    const result = await fixture.control.dispatch(
      {
        ...base,
        input: {
          ...base.input,
          candidate: {
            source: capturedSource,
            sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
            activationRepresentation: "memory_events",
            candidateHash: hash,
            sourceRevision: 4,
            itemCount: 1,
            excludedItemCount: 0,
            manifest: [{ sourceId: ids.source, revisionHash: hashB }],
            byteCount: 128,
            mode: "continuous",
            expiresAt: null
          }
        }
      },
      context()
    );

    expectFailure(result, "protocol_mismatch");
    expect(fixture.requests).toHaveLength(0);
  });

  it("reconciles authoritative remote owner grants before listing them", async () => {
    const fixture = createFixture();
    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shared_memory_grants"),
        input: { logicalMemoryId: ids.logicalMemory }
      },
      context()
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        grants: [
          {
            id: ids.grant,
            logicalMemoryId: ids.logicalMemory,
            lifecycle: "active"
          }
        ]
      }
    });
    expect(fixture.requests.map((request) => request.pathname)).toEqual([
      expect.stringMatching(/device-credentials\/status$/),
      `/v1/shared-memory/logical-memories/${ids.logicalMemory}/share-grants`
    ]);
  });

  it("reconciles a newer unavailable grant snapshot without weakening optimistic writes", async () => {
    const fixture = createFixture({
      remoteOwnerGrants: [
        grantResponse({ lifecycle: "unavailable", grantVersion: 2 })
      ]
    });
    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shared_memory_grants"),
        input: { logicalMemoryId: ids.logicalMemory }
      },
      context()
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        grants: [
          {
            id: ids.grant,
            grantVersion: 2,
            lifecycle: "unavailable"
          }
        ]
      }
    });
    expect(fixture.grants.get(ids.grant)).toMatchObject({
      grant: { grantVersion: 2, lifecycle: "unavailable" }
    });
  });

  it("reconciles monotonic source freshness within the same grant version", async () => {
    const fixture = createFixture({
      remoteOwnerGrants: [
        grantResponse({
          sourceRevision: 11,
          updatedAt: "2026-07-17T12:11:00.000Z"
        })
      ]
    });
    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shared_memory_grants"),
        input: { logicalMemoryId: ids.logicalMemory }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        grants: [
          {
            id: ids.grant,
            grantVersion: 1,
            sourceRevision: 11,
            lifecycle: "active"
          }
        ]
      }
    });
    expect(fixture.grantPersistenceModes).toEqual(["authoritative_snapshot"]);
  });

  it("keeps Pending Shares visible when an older grant is no longer accessible", async () => {
    const inaccessibleLogicalMemoryId = uuidFor(810);
    const inaccessibleGrantId = uuidFor(811);
    const pendingShareId = uuidFor(812);
    const inaccessibleGrant = {
      ...grantResponse(),
      source: {
        ...capturedSource,
        logicalMemoryId: inaccessibleLogicalMemoryId
      },
      id: inaccessibleGrantId,
      logicalGrantId: uuidFor(813),
      logicalMemoryId: inaccessibleLogicalMemoryId,
      consentId: uuidFor(814),
      companionScope: {
        ...grantResponse().companionScope,
        logicalMemoryId: inaccessibleLogicalMemoryId,
        shareGrantId: inaccessibleGrantId
      }
    };
    const pending = {
      kind: "pending",
      pendingShare: {
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "memory_events",
        id: pendingShareId,
        mutationId: uuidFor(815),
        logicalGrantId: uuidFor(816),
        consentId: uuidFor(817),
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        mode: "continuous",
        sourceRevision: 4,
        state: "preparing",
        stage: "processing",
        workspaceAccessState: "none",
        sourceUpdateState: "preparing",
        operationVersion: 2,
        attemptCount: 1,
        redactedFailureCode: null,
        lastProgressAt: iso,
        createdAt: iso,
        updatedAt: iso,
        activatedAt: null,
        revokedAt: null,
        grantId: null,
        grantVersion: null
      },
      sourceAccess: null,
      summary: {
        source: capturedSource,
        sourceSessionId: uuidFor(818),
        sourceTitle: "Pending owner share",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        workspaceContentAccess: "available",
        companionThreadId: ids.companion,
        mode: "continuous",
        authorizedPreview: {
          previewId: ids.preview,
          previewHash: hash,
          previewRevision: 1,
          sourceRevision: 4
        },
        lastReadyRevision: null,
        lastSuccessfulUpdateAt: null
      }
    };
    const fixture = createFixture({
      remoteOwnedShares: [
        pending,
        {
          kind: "grant",
          grant: inaccessibleGrant,
          sourceAccess: null,
          summary: {
            ...pending.summary,
            sourceTitle: "Inaccessible historical grant",
            workspaceContentAccess: "unavailable",
            companionThreadId: null,
            authorizedPreview: null
          }
        }
      ],
      deniedDiscussionLogicalMemoryIds: [inaccessibleLogicalMemoryId]
    });

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shares"),
        input: { cursor: null, limit: 100, history: false }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        shares: [
          {
            kind: "pending",
            pendingShare: { id: pendingShareId, state: "preparing" },
            summary: { sourceSessionId: ids.localSession }
          },
          {
            kind: "grant",
            grant: { id: inaccessibleGrant.id },
            summary: {
              sourceTitle: "Inaccessible historical grant",
              workspaceContentAccess: "unavailable",
              companionThreadId: null
            }
          }
        ],
        nextCursor: null
      }
    });
    expect(
      fixture.requests.some(
        (request) =>
          request.method === "POST" &&
          request.pathname.includes(
            `/${inaccessibleLogicalMemoryId}/discussion`
          )
      )
    ).toBe(false);
  });

  it("lists 100 owned shares with one remote read and bounded authority-store batches", async () => {
    const remoteOwnedShares = Array.from({ length: 100 }, (_, index) => {
      const shareGrantId = uuidFor(1_000 + index);
      const logicalMemoryId = uuidFor(1_200 + index);
      const remoteGrant = {
        ...grantResponse(),
        source: { ...capturedSource, logicalMemoryId },
        id: shareGrantId,
        logicalGrantId: uuidFor(1_400 + index),
        logicalMemoryId,
        companionScope: {
          ...grantResponse().companionScope,
          logicalMemoryId,
          shareGrantId
        }
      };
      return {
        kind: "grant" as const,
        grant: remoteGrant,
        sourceAccess: null,
        summary: {
          source: { ...capturedSource, logicalMemoryId },
          sourceSessionId: ids.localSession,
          companionThreadId: ids.companion,
          sourceTitle: `Shared source ${index + 1}`,
          teamName: "Atlas Research",
          workspaceName: "Launch Plans",
          workspaceContentAccess: "available",
          mode: "continuous" as const,
          authorizedPreview: null,
          lastReadyRevision: 4,
          lastSuccessfulUpdateAt: iso
        }
      };
    });
    const fixture = createFixture({ remoteOwnedShares });
    for (const entry of remoteOwnedShares) {
      fixture.grants.set(entry.grant.id, {
        ...collaborationGrant(),
        grant: {
          ...collaborationGrant().grant,
          source: {
            ...capturedSource,
            logicalMemoryId: entry.grant.logicalMemoryId
          },
          id: entry.grant.id,
          logicalGrantId: entry.grant.logicalGrantId,
          logicalMemoryId: entry.grant.logicalMemoryId
        }
      });
    }

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shares"),
        input: { cursor: null, limit: 100, history: false }
      },
      context()
    );

    expect(result).toMatchObject({ ok: true });
    if (!result?.ok || result.command !== "collaboration.list_owned_shares") {
      throw new Error("Expected a batched owned-share page");
    }
    expect(result.data.shares).toHaveLength(100);
    expect(fixture.resolvePreviewTargets).toHaveBeenCalledTimes(1);
    expect(fixture.readAuthoritativeGrants).toHaveBeenCalledTimes(1);
    expect(fixture.requests.map((request) => request.pathname)).toEqual([
      expect.stringMatching(/device-credentials\/status$/),
      "/v1/shared-memory/owned-shares"
    ]);
  });

  it("reports authority projection failures without logging protected share data", async () => {
    const diagnostics = vi.fn();
    const fixture = createFixture({ reportDiagnostic: diagnostics });
    fixture.readAuthoritativeGrants.mockRejectedValueOnce(
      new Error(`projection failed for ${hash} and hrg_secret`)
    );

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shares"),
        input: { cursor: null, limit: 100, history: false }
      },
      context()
    );

    expectFailure(result, "internal_error");
    expect(diagnostics).toHaveBeenCalledWith({
      code: "shared_memory_authority_projection_failed",
      operation: "collaboration.list_owned_shares",
      publicGrantReference: null,
      failureStage: "authority_store_projection",
      httpStatus: 500
    });
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(hash);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("hrg_secret");
  });

  it("binds owned-share cursors to immutable pagination context", async () => {
    const fixture = createFixture({
      mutateResponse: (request, response) =>
        request.pathname.endsWith("/v1/shared-memory/owned-shares")
          ? {
              ...response,
              pagination: {
                limit: 10,
                hasMore: true,
                next: {
                  createdAt: iso,
                  recordKind: "pending",
                  id: uuidFor(899)
                },
                snapshotAt: iso
              }
            }
          : response
    });
    const first = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.list_owned_shares"),
        input: { cursor: null, limit: 10, history: false }
      },
      context()
    );
    expect(first).toMatchObject({ ok: true });
    if (!first?.ok || first.command !== "collaboration.list_owned_shares") {
      throw new Error("Expected an owned-share page");
    }
    const cursor = first.data.nextCursor;
    expect(cursor).toMatch(/^csms1\./);
    const tampered = `${cursor!.slice(0, -1)}${cursor!.endsWith("A") ? "B" : "A"}`;

    await expect(
      fixture.control.dispatch(
        {
          ...commandBase("collaboration.list_owned_shares"),
          input: { cursor: tampered, limit: 10, history: false }
        },
        context()
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "history_expired" }
    });
    await expect(
      fixture.control.dispatch(
        {
          ...commandBase("collaboration.list_owned_shares"),
          input: { cursor, limit: 10, history: true }
        },
        context()
      )
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "history_expired" }
    });
  });

  it("returns the retained owner-authorized preview with owned Share detail", async () => {
    const ownedGrant = {
      kind: "grant",
      grant: grantResponse(),
      sourceAccess: null,
      summary: {
        source: capturedSource,
        sourceSessionId: uuidFor(48),
        companionThreadId: ids.companion,
        sourceTitle: "Owner preview",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        workspaceContentAccess: "available",
        mode: "continuous",
        authorizedPreview: {
          previewId: ids.preview,
          previewHash: hash,
          previewRevision: 1,
          sourceRevision: 4
        },
        lastReadyRevision: 4,
        lastSuccessfulUpdateAt: iso
      }
    };
    const fixture = createFixture({ remoteOwnedShares: [ownedGrant] });
    fixture.previews.clear();

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.get_owned_share"),
        input: { kind: "grant", id: ids.grant }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        share: {
          kind: "grant",
          preview: {
            previewHash: hash,
            sourceRevision: 4,
            itemCount: 1
          }
        }
      }
    });
    expect(fixture.previews.get(hash)).toMatchObject({
      previewId: ids.preview,
      sourceRevision: 4
    });
  });

  it("returns the backend-authoritative preview for an activated Pending Share", async () => {
    const pendingShareId = uuidFor(46);
    const ownedPending = {
      kind: "pending",
      pendingShare: {
        source: capturedSource,
        sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
        activationRepresentation: "memory_events",
        id: pendingShareId,
        mutationId: uuidFor(47),
        logicalGrantId: ids.logicalGrant,
        consentId: ids.consent,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        maximumFidelity: "memory_events",
        includeCuratedMemory: false,
        mode: "continuous",
        sourceRevision: 4,
        state: "activated",
        stage: "complete",
        workspaceAccessState: "active",
        sourceUpdateState: "active",
        operationVersion: 3,
        attemptCount: 1,
        redactedFailureCode: null,
        lastProgressAt: iso,
        createdAt: iso,
        updatedAt: iso,
        activatedAt: iso,
        revokedAt: null,
        grantId: ids.grant,
        grantVersion: 1
      },
      sourceAccess: null,
      summary: {
        source: capturedSource,
        sourceSessionId: ids.localSession,
        sourceTitle: "Activated owner preview",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        workspaceContentAccess: "available",
        mode: "continuous",
        authorizedPreview: {
          previewId: ids.preview,
          previewHash: hash,
          previewRevision: 1,
          sourceRevision: 4
        },
        lastReadyRevision: 4,
        lastSuccessfulUpdateAt: iso
      }
    };
    const fixture = createFixture({ remoteOwnedShares: [ownedPending] });
    fixture.previews.clear();

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.get_owned_share"),
        input: { kind: "pending", id: pendingShareId }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        share: {
          kind: "pending",
          summary: { sourceSessionId: ids.localSession },
          preview: {
            previewHash: hash,
            sourceRevision: 4,
            itemCount: 1
          }
        }
      }
    });
    expect(fixture.previews.get(hash)).toMatchObject({
      previewId: ids.preview,
      sourceRevision: 4
    });
  });

  it("creates an authoritative preview without accepting renderer content or secrets", async () => {
    const fixture = createFixture();
    const result = await fixture.control.dispatch(previewCommand(), context());

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.preview_shared_memory",
      data: {
        preview: {
          previewHash: hash,
          previewRevision: 1,
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          itemCount: 1
        }
      }
    });
    const request = fixture.requests.find((item) =>
      item.pathname.endsWith("/v1/shared-memory/previews")
    );
    expect(request?.body).toEqual({
      source: capturedSource,
      sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
      activationRepresentation: "memory_events",
      mode: "continuous",
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.remoteReplica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      maximumFidelity: "memory_events",
      includeCuratedMemory: false,
      authority: {
        action: "workspace.memory.share_owned",
        source: "device_action_grant",
        referenceId: ids.actionGrant
      }
    });
    expect(JSON.stringify(result)).not.toContain("upstream-secret");
    expect(JSON.stringify(result)).not.toContain("lec-secret");
    expect(JSON.stringify(result)).not.toContain(ids.remoteReplica);
    const persisted = fixture.previews.get(hash) as unknown as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("authorization");
    expect(persisted).not.toHaveProperty("upstreamAuthorization");
    expect(persisted).not.toHaveProperty("desktopCredential");
    expect(persisted).not.toHaveProperty("backend");
  });

  it("projects safe tool activity without inferring approval display from ordinary text", async () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch";
    const fixture = createFixture({
      previewItems: [
        {
          itemType: "tool_call" as const,
          schemaVersion: 1 as const,
          sourceId: uuidFor(150),
          sourceLogicalMemoryId: ids.logicalMemory,
          sourceRevision: 4,
          occurredAt: iso,
          content: {
            toolName: "apply_patch",
            toolCallId: "call-shared-patch",
            payload: { input: patch }
          }
        },
        {
          itemType: "assistant_message" as const,
          schemaVersion: 1 as const,
          sourceId: uuidFor(152),
          sourceLogicalMemoryId: ids.logicalMemory,
          sourceRevision: 4,
          occurredAt: iso,
          content: {
            text: JSON.stringify({
              outcome: "allow",
              rationale: "This is ordinary assistant JSON.",
              risk_level: "low",
              user_authorization: "medium"
            })
          }
        }
      ]
    });

    const result = await fixture.control.dispatch(previewCommand(), context());
    if (
      !result?.ok ||
      result.command !== "collaboration.preview_shared_memory"
    ) {
      throw new Error("preview failed");
    }

    expect(result.data.preview.items[0]).toMatchObject({
      sourceItems: [
        {
          sourceKind: "tool_call",
          toolDisplay: {
            kind: "file_change",
            label: "Changed files",
            callId: "call-shared-patch",
            patchSource: patch
          }
        }
      ]
    });
    const ordinaryAssistantItem = result.data.preview.items[1];
    if (ordinaryAssistantItem?.representation !== "memory_events") {
      throw new Error("expected a Memory Events preview item");
    }
    expect(
      ordinaryAssistantItem.sourceItems[0]?.approvalDecisionDisplay
    ).toBeUndefined();
  });

  it("rejects a malformed remote semantic preview containing Approval Activity", async () => {
    const fixture = createFixture({
      previewItems: [
        {
          itemType: "assistant_message" as const,
          schemaVersion: 1 as const,
          sourceId: uuidFor(151),
          sourceLogicalMemoryId: ids.logicalMemory,
          sourceRevision: 4,
          occurredAt: iso,
          content: {
            approvalReview: true,
            text: "synthetic approval payload"
          }
        }
      ]
    });

    expectFailure(
      await fixture.control.dispatch(previewCommand(), context()),
      "internal_error"
    );
  });

  it("keeps an LCM preview local and retryable until the exact summary snapshot is synced", async () => {
    const prepareLocalLcmRepresentation = vi.fn(async () => "pending" as const);
    const fixture = createFixture({ prepareLocalLcmRepresentation });
    const command = {
      ...previewCommand(),
      input: {
        ...previewCommand().input,
        activationRepresentation: "lcm_leaves" as const,
        maximumFidelity: "lcm_leaves" as const
      }
    };

    expectFailure(
      await fixture.control.dispatch(command, context()),
      "representation_pending"
    );
    expect(prepareLocalLcmRepresentation).toHaveBeenCalledWith({
      localOwnerUserId: ids.localOwner,
      localSessionId: ids.localSession,
      syncRelationshipId: ids.syncRelationship,
      representation: "lcm_leaves"
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.pathname).toMatch(
      /device-credentials\/status$/
    );
  });

  it("paginates only a durably persisted preview with a signed owner-bound cursor", async () => {
    const items = Array.from({ length: 101 }, (_, index) => sourceItem(index));
    const fixture = createFixture({ previewItems: items });
    const first = await fixture.control.dispatch(previewCommand(), context());
    expect(first).toMatchObject({ ok: true });
    if (!first?.ok || first.command !== "collaboration.preview_shared_memory") {
      throw new Error("preview failed");
    }
    expect(first.data.preview.items).toHaveLength(100);
    expect(first.data.preview.nextCursor).not.toBeNull();

    const second = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.load_shared_memory_preview_page"),
        input: {
          previewHash: hash,
          cursor: first.data.preview.nextCursor,
          limit: 10
        }
      },
      context()
    );
    expect(second).toMatchObject({
      ok: true,
      data: { preview: { itemCount: 101, nextCursor: null } }
    });
    if (
      !second?.ok ||
      second.command !== "collaboration.load_shared_memory_preview_page"
    ) {
      throw new Error("preview page failed");
    }
    expect(second.data.preview.items).toHaveLength(1);
    expect(second.data.preview.items[0]?.sequence).toBe(101);
  });

  it("shares, revokes, and changes fidelity through persisted scoped authority", async () => {
    const shareFixture = createFixture();
    const shared = await shareFixture.control.dispatch(
      shareCommand(),
      context()
    );
    expect(shared).toMatchObject({
      ok: true,
      data: {
        pendingShare: {
          id: uuidFor(700),
          source: capturedSource,
          state: "preparing"
        }
      }
    });
    expect(
      shareFixture.requests.some((request) =>
        request.pathname.endsWith("/representations/memory_events")
      )
    ).toBe(false);

    const revoked = await shareFixture.control.dispatch(
      {
        ...commandBase("collaboration.revoke_shared_memory"),
        input: {
          mutationId: randomUUID(),
          teamId: ids.team,
          workspaceId: ids.workspace,
          shareGrantId: ids.grant,
          expectedGrantVersion: 1,
          reasonCode: "owner.revoked",
          actionGrant: { id: ids.actionGrant }
        }
      },
      context()
    );
    expect(revoked).toMatchObject({
      ok: true,
      data: { grant: { lifecycle: "revoked", grantVersion: 2 } }
    });
    if (
      !revoked?.ok ||
      revoked.command !== "collaboration.revoke_shared_memory"
    ) {
      throw new Error("revocation failed");
    }
    expect(revoked.data.grant).not.toHaveProperty("companionThreadId");
    expect(shareFixture.grantPersistenceModes).toEqual(["revocation"]);

    const changeFixture = createFixture();
    const replacementConsentId = uuidFor(500);
    const replacementPreviewId = uuidFor(501);
    changeFixture.previews.set(hashC, {
      ...previewResponse(),
      previewId: replacementPreviewId,
      previewHash: hashC,
      activationRepresentation: "lcm_leaves",
      backendId: "team-backend",
      localOwnerUserId: ids.localOwner,
      upstreamUserId: ids.upstreamUser,
      maximumFidelity: "lcm_leaves"
    });
    changeFixture.consents.set(replacementConsentId, {
      ...collaborationConsent(),
      previewId: replacementPreviewId,
      consent: {
        ...collaborationConsent().consent,
        id: replacementConsentId,
        activationRepresentation: "lcm_leaves",
        maximumFidelity: "lcm_leaves",
        previewHash: hashC
      }
    });
    const changed = await changeFixture.control.dispatch(
      {
        ...commandBase("collaboration.change_shared_memory_fidelity"),
        input: {
          source: capturedSource,
          sourceCapabilities: ["lcm_rollups", "lcm_leaves", "memory_events"],
          activationRepresentation: "lcm_leaves",
          mutationId: randomUUID(),
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          shareGrantId: ids.grant,
          consentId: replacementConsentId,
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          expectedGrantVersion: 1,
          mode: "continuous",
          previewRevision: 1,
          previewHash: hashC,
          expiresAt: null,
          actionGrant: { id: ids.actionGrant }
        }
      },
      context()
    );
    expect(changed).toMatchObject({
      ok: true,
      data: {
        pendingShare: {
          activationRepresentation: "lcm_leaves",
          maximumFidelity: "lcm_leaves",
          includeCuratedMemory: false,
          workspaceAccessState: "active",
          state: "preparing",
          grantId: ids.grant,
          grantVersion: 1
        }
      }
    });
    const replacementRequest = changeFixture.requests.find((request) =>
      request.pathname.endsWith("/fidelity-bundle")
    );
    expect(replacementRequest).toMatchObject({
      method: "PUT",
      body: {
        consentId: replacementConsentId,
        expectedGrantVersion: 1,
        preview: {
          previewId: replacementPreviewId,
          previewHash: hashC
        }
      }
    });
    expect(changeFixture.pendingSourceWork.at(-1)).toMatchObject({
      pendingShareId: uuidFor(701),
      source: capturedSource,
      sourceRevision: 4
    });
  });

  it("advances a Personal Note grant only to its exact newer source revision", async () => {
    const fixture = createFixture();
    fixture.grants.set(ids.grant, {
      ...collaborationGrant({ sourceRevision: 1 }),
      grant: {
        ...collaborationGrant({ sourceRevision: 1 }).grant,
        source: noteSourceV1,
        sourceCapabilities: ["memory_events"],
        activationRepresentation: "memory_events",
        maximumFidelity: "memory_events",
        sourceRevision: 1
      }
    });
    fixture.previews.set(hashC, {
      ...previewResponse([
        {
          ...sourceItem(),
          sourceId: ids.noteEventV2,
          sourceRevision: 2,
          content: { text: "privacy-filtered Personal Note revision two" }
        }
      ]),
      source: noteSourceV2,
      sourceCapabilities: ["memory_events"],
      activationRepresentation: "memory_events",
      mode: "snapshot",
      previewHash: hashC,
      maximumFidelity: "memory_events",
      sourceRevision: 2,
      binding: { ...binding(), sourceRevision: 2 },
      backendId: "team-backend",
      localOwnerUserId: ids.localOwner,
      upstreamUserId: ids.upstreamUser
    });

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.change_shared_memory_fidelity"),
        input: {
          source: noteSourceV2,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          mutationId: randomUUID(),
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          shareGrantId: ids.grant,
          consentId: uuidFor(500),
          maximumFidelity: "memory_events",
          includeCuratedMemory: false,
          expectedGrantVersion: 1,
          mode: "snapshot",
          previewRevision: 1,
          previewHash: hashC,
          expiresAt: null,
          actionGrant: { id: ids.actionGrant }
        }
      },
      context()
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        pendingShare: {
          source: noteSourceV2,
          sourceRevision: 2,
          grantId: ids.grant,
          grantVersion: 1,
          state: "preparing"
        }
      }
    });
    expect(
      fixture.requests.filter((request) =>
        request.pathname.endsWith("/fidelity-bundle")
      )
    ).toHaveLength(1);
    expect(fixture.pendingSourceWork.at(-1)).toEqual(
      expect.objectContaining({
        pendingShareId: uuidFor(701),
        source: noteSourceV2
      })
    );
    expect(fixture.pendingSourceWork.at(-1)).not.toHaveProperty(
      "localSessionId"
    );
  });

  it.each([
    ["the current revision", noteSourceV1, ids.logicalMemory],
    [
      "a different note",
      { ...noteSourceV2, noteId: uuidFor(107) },
      ids.logicalMemory
    ],
    [
      "a different logical memory",
      { ...noteSourceV2, logicalMemoryId: uuidFor(108) },
      uuidFor(108)
    ],
    ["a Captured Session substitution", capturedSource, ids.logicalMemory]
  ])(
    "rejects %s before replacing a Personal Note grant",
    async (_, source, logicalMemoryId) => {
      const fixture = createFixture();
      fixture.grants.set(ids.grant, {
        ...collaborationGrant({ sourceRevision: 1 }),
        grant: {
          ...collaborationGrant({ sourceRevision: 1 }).grant,
          source: noteSourceV1,
          sourceCapabilities: ["memory_events"],
          activationRepresentation: "memory_events",
          maximumFidelity: "memory_events",
          sourceRevision: 1
        }
      });

      const result = await fixture.control.dispatch(
        {
          ...commandBase("collaboration.change_shared_memory_fidelity"),
          input: {
            source,
            sourceCapabilities: ["memory_events"],
            activationRepresentation: "memory_events",
            mutationId: randomUUID(),
            logicalMemoryId,
            teamId: ids.team,
            workspaceId: ids.workspace,
            shareGrantId: ids.grant,
            consentId: uuidFor(500),
            maximumFidelity: "memory_events",
            includeCuratedMemory: false,
            expectedGrantVersion: 1,
            mode: source.kind === "personal_note" ? "snapshot" : "continuous",
            previewRevision: 1,
            previewHash: hash,
            expiresAt: null,
            actionGrant: { id: ids.actionGrant }
          }
        },
        context()
      );

      expectFailure(result, "conflict");
      expect(
        fixture.requests.some((request) =>
          request.pathname.endsWith("/fidelity-bundle")
        )
      ).toBe(false);
      expect(fixture.pendingSourceWork).toHaveLength(0);
    }
  );

  it("durably records local source preparation before accepting a Pending Share", async () => {
    const requestPendingShareSourceWork = vi.fn();
    const fixture = createFixture({ requestPendingShareSourceWork });
    const mutationId = randomUUID();
    const result = await fixture.control.dispatch(
      {
        ...shareCommand(),
        input: {
          ...shareCommand().input,
          mutationId
        }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        pendingShare: {
          id: uuidFor(700),
          mutationId,
          state: "preparing",
          workspaceAccessState: "none"
        }
      }
    });
    expect(fixture.pendingSourceWork).toEqual([
      {
        pendingShareId: uuidFor(700),
        mutationId,
        mode: "continuous",
        source: capturedSource,
        sourceRevision: 4
      }
    ]);
    expect(requestPendingShareSourceWork).toHaveBeenCalledTimes(1);
  });

  it("fails closed when Pending Share source work cannot be persisted", async () => {
    const requestPendingShareSourceWork = vi.fn();
    const fixture = createFixture({
      persistPendingSourceWork: false,
      requestPendingShareSourceWork
    });
    const result = await fixture.control.dispatch(shareCommand(), context());

    expectFailure(result, "not_available");
    expect(requestPendingShareSourceWork).not.toHaveBeenCalled();
  });

  it("keeps acceptance pending while semantic privacy materialization continues asynchronously", async () => {
    const fixture = createFixture({
      mutateResponse(request, response) {
        if (
          request.method === "PUT" &&
          request.pathname.includes("/representations/")
        ) {
          return {
            processing: true,
            shareGrantId: ids.grant,
            representation: "memory_events"
          };
        }
        return response;
      }
    });

    const result = await fixture.control.dispatch(shareCommand(), context());

    expect(result).toMatchObject({
      ok: true,
      data: {
        pendingShare: {
          state: "preparing",
          stage: "accepted",
          workspaceAccessState: "none",
          grantId: null,
          grantVersion: null
        }
      }
    });
  });

  it("loads bounded source pages through an authorized remote grant read", async () => {
    const fixture = createFixture();
    const first = await loadInitialSource(fixture);
    expect(first).toMatchObject({
      ok: true,
      data: {
        page: {
          sharedSessionId: ids.grant,
          representation: "memory_events",
          hasOlder: true,
          hasNewer: false
        }
      }
    });
    if (
      !first?.ok ||
      first.command !== "collaboration.load_shared_source_page"
    ) {
      throw new Error("source page failed");
    }
    expect(first.data.page.items.map((item) => item.sequence)).toEqual([2, 3]);
    expect(fixture.requests.at(-1)).toMatchObject({
      method: "GET",
      authorization: "Koed-Device upstream-key:upstream-secret"
    });
    expect(fixture.requests.at(-1)?.pathname).toContain(
      `/teams/${ids.team}/workspaces/${ids.workspace}/share-grants/${ids.grant}`
    );
    expect(fixture.requests.at(-1)?.pathname.endsWith("/initial-view")).toBe(
      true
    );
    expect(fixture.requests.at(-1)?.search).toContain("direction=older");
    expect(fixture.requests.at(-1)?.search).toContain("limit=2");

    const older = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.load_shared_source_page"),
        input: {
          sharedSession: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            sharedSessionId: ids.grant
          },
          direction: "older",
          cursor: first.data.page.olderCursor,
          limit: 2
        }
      },
      context()
    );
    expect(older).toMatchObject({
      ok: true,
      data: { page: { hasOlder: false, hasNewer: true } }
    });
    expect(fixture.requests.at(-1)?.pathname.endsWith("/page")).toBe(true);
  });

  it("authorizes cumulative Memory layers and gates Curated Memory independently", async () => {
    const allowed = [
      ["memory_events", "memory_events"],
      ["memory_events", "lcm_leaves"],
      ["memory_events", "lcm_rollups"],
      ["lcm_leaves", "lcm_leaves"],
      ["lcm_leaves", "lcm_rollups"],
      ["lcm_rollups", "lcm_rollups"]
    ] as const;
    for (const [maximumFidelity, representation] of allowed) {
      const fixture = createFixture({
        remoteRead: remoteReadResponse({ maximumFidelity, representation })
      });
      await expect(
        loadInitialSource(fixture, representation, 10)
      ).resolves.toMatchObject({
        ok: true,
        data: { page: { representation } }
      });
    }

    const denied = [
      ["lcm_leaves", "memory_events"],
      ["lcm_rollups", "lcm_leaves"],
      ["lcm_rollups", "memory_events"]
    ] as const;
    for (const [maximumFidelity, representation] of denied) {
      const fixture = createFixture({
        remoteRead: remoteReadResponse({ maximumFidelity, representation })
      });
      expectFailure(
        await loadInitialSource(fixture, representation, 10),
        "permission_denied"
      );
    }

    const curatedDenied = createFixture({
      remoteRead: remoteReadResponse({
        representation: "curated_assertions",
        maximumFidelity: "memory_events",
        includeCuratedMemory: false
      })
    });
    expectFailure(
      await loadInitialSource(curatedDenied, "curated_assertions", 10),
      "permission_denied"
    );

    const curatedAllowed = createFixture({
      remoteRead: remoteReadResponse({
        representation: "curated_assertions",
        maximumFidelity: "lcm_rollups",
        includeCuratedMemory: true
      })
    });
    await expect(
      loadInitialSource(curatedAllowed, "curated_assertions", 10)
    ).resolves.toMatchObject({
      ok: true,
      data: { page: { representation: "curated_assertions" } }
    });
  });

  it("rejects caller content, classification, and renderer-held authorization before any request", async () => {
    const fixture = createFixture();
    const forged = {
      ...previewCommand(),
      input: {
        ...previewCommand().input,
        content: { text: "caller supplied" },
        classification: { hiddenReasoning: false }
      }
    };
    expectFailure(
      await fixture.control.dispatch(forged, context()),
      "invalid_input"
    );
    expectFailure(
      await fixture.control.dispatch(previewCommand(), {
        ...context(),
        authorization: "Koed-Device renderer:secret"
      } as never),
      "invalid_input"
    );
    expect(fixture.requests).toHaveLength(0);
  });

  it("never accepts a Personal API Token as upstream authority", async () => {
    const fixture = createFixture({
      upstreamAuthorization: "Bearer personal-api-token"
    });
    expectFailure(
      await fixture.control.dispatch(previewCommand(), context()),
      "temporarily_unavailable"
    );
    expect(fixture.requests).toHaveLength(0);

    const personalLec = createFixture({
      lecAuthorization: "Bearer personal-api-token"
    });
    expectFailure(
      await personalLec.control.dispatch(previewCommand(), context()),
      "permission_denied"
    );
    expect(personalLec.requests).toHaveLength(0);
  });

  it("requires exact LEC scope, enrollment binding, preview target, and action grant", async () => {
    const missingScope = createFixture({
      lecFamilies: ["team_workspace_read"]
    });
    expectFailure(
      await missingScope.control.dispatch(previewCommand(), context()),
      "permission_denied"
    );
    expect(missingScope.requests).toHaveLength(0);

    const wrongEnrollment = createFixture({ enrollmentBound: false });
    expectFailure(
      await wrongEnrollment.control.dispatch(previewCommand(), context()),
      "access_revoked"
    );
    expect(wrongEnrollment.requests).toHaveLength(1);

    const missingTarget = createFixture({ previewTarget: false });
    expectFailure(
      await missingTarget.control.dispatch(previewCommand(), context()),
      "permission_denied"
    );
    expect(missingTarget.requests).toHaveLength(1);

    const missingAction = createFixture({ actionGrantSecret: null });
    expectFailure(
      await missingAction.control.dispatch(shareCommand(), context()),
      "permission_denied"
    );
    expect(missingAction.requests).toHaveLength(1);
  });

  it("binds a fresh local enrollment only from the verified remote device identity", async () => {
    const fixture = createFixture({
      enrollmentBound: false,
      bindEnrollment: true
    });

    await expect(
      fixture.control.dispatch(previewCommand(), context())
    ).resolves.toMatchObject({ ok: true });
    expect(fixture.enrollmentBindings).toEqual([
      {
        backendId: "team-backend",
        localOwnerUserId: ids.localOwner,
        upstreamUserId: ids.upstreamUser,
        remoteDeviceId: ids.remoteDevice
      }
    ]);
  });

  it("fails closed when preview persistence is unavailable", async () => {
    const previewGap = createFixture({ persistPreview: false });
    expectFailure(
      await previewGap.control.dispatch(previewCommand(), context()),
      "not_available"
    );
  });

  it("rejects preview drift and never falls back to caller references", async () => {
    const fixture = createFixture();
    await fixture.control.dispatch(previewCommand(), context());
    expectFailure(
      await fixture.control.dispatch(
        {
          ...shareCommand(),
          input: { ...shareCommand().input, previewRevision: 2 }
        },
        context()
      ),
      "conflict"
    );
    expect(
      fixture.requests.filter((item) =>
        item.pathname.endsWith("/pending-shares")
      )
    ).toHaveLength(0);
  });

  it("rejects tampered preview cursors and cross-owner replay", async () => {
    const items = Array.from({ length: 101 }, (_, index) => sourceItem(index));
    const fixture = createFixture({ previewItems: items });
    const first = await fixture.control.dispatch(previewCommand(), context());
    if (!first?.ok || first.command !== "collaboration.preview_shared_memory") {
      throw new Error("preview failed");
    }
    const cursor = first.data.preview.nextCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    expectFailure(
      await fixture.control.dispatch(
        {
          ...commandBase("collaboration.load_shared_memory_preview_page"),
          input: { previewHash: hash, cursor: tampered, limit: 10 }
        },
        context()
      ),
      "history_expired"
    );
    expectFailure(
      await fixture.control.dispatch(
        {
          ...commandBase("collaboration.load_shared_memory_preview_page"),
          input: { previewHash: hash, cursor, limit: 10 }
        },
        { ...context(), localOwnerUserId: uuidFor(999) }
      ),
      "access_revoked"
    );
  });

  it("rejects a tampered source cursor before another protected source read", async () => {
    const fixture = createFixture();
    const first = await loadInitialSource(fixture);
    if (
      !first?.ok ||
      first.command !== "collaboration.load_shared_source_page"
    ) {
      throw new Error("source page failed");
    }
    const cursor = first.data.page.olderCursor!;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    const protectedReadsBefore = fixture.requests.filter(
      (request) =>
        request.method === "GET" &&
        request.pathname.includes("/v1/shared-memory/teams/")
    ).length;

    expectFailure(
      await fixture.control.dispatch(
        {
          ...commandBase("collaboration.load_shared_source_page"),
          input: {
            sharedSession: {
              teamId: ids.team,
              workspaceId: ids.workspace,
              sharedSessionId: ids.grant
            },
            direction: "older",
            cursor: tampered,
            limit: 2
          }
        },
        context()
      ),
      "history_expired"
    );
    expect(
      fixture.requests.filter(
        (request) =>
          request.method === "GET" &&
          request.pathname.includes("/v1/shared-memory/teams/")
      )
    ).toHaveLength(protectedReadsBefore);
  });

  it("rejects cross-Workspace and representation-substituted source results", async () => {
    const validRead = remoteReadResponse();
    const wrongWorkspace = createFixture({
      remoteRead: {
        ...validRead,
        grant: { ...validRead.grant, teamWorkspaceId: uuidFor(999) },
        items: [sourceItem()]
      }
    });
    expectFailure(
      await loadInitialSource(wrongWorkspace, "memory_events", 10),
      "permission_denied"
    );

    const substituted = createFixture({
      mutateResponse: (request, response) =>
        request.method === "GET" && !request.pathname.includes("local-edge")
          ? {
              ...response,
              sharedMemory: {
                ...((response.sharedMemory ?? {}) as Record<string, unknown>),
                representation: {
                  ...(((response.sharedMemory as Record<string, unknown>)
                    ?.representation ?? {}) as Record<string, unknown>),
                  representation: "lcm_leaves"
                }
              }
            }
          : response
    });
    expectFailure(
      await loadInitialSource(substituted, "memory_events", 10),
      "permission_denied"
    );
  });

  it("rejects remote preview scope drift and inline classification fields", async () => {
    const scopeDrift = createFixture({
      mutateResponse: (request, response) =>
        request.pathname.endsWith("/v1/shared-memory/previews")
          ? {
              preview: {
                ...(response.preview as Record<string, unknown>),
                teamWorkspaceId: uuidFor(999)
              }
            }
          : response
    });
    expectFailure(
      await scopeDrift.control.dispatch(previewCommand(), context()),
      "internal_error"
    );

    const classification = createFixture({
      mutateResponse: (request, response) =>
        request.pathname.endsWith("/v1/shared-memory/previews")
          ? {
              preview: {
                ...(response.preview as Record<string, unknown>),
                classification: { callerShareable: true }
              }
            }
          : response
    });
    expectFailure(
      await classification.control.dispatch(previewCommand(), context()),
      "internal_error"
    );
  });

  it("returns null for unrelated commands and does not touch authority", async () => {
    const fixture = createFixture();
    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.load"),
        input: {}
      },
      context()
    );
    expect(result).toBeNull();
    expect(fixture.requests).toHaveLength(0);
  });
});
