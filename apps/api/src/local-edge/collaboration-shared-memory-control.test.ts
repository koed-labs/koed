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
  localSession: uuidFor(103)
};

const binding = () => ({
  sourceRevision: 4,
  sourceHash: hash,
  representationPolicyRevision: 3,
  representationPolicyHash: hash,
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

const previewResponse = (items: PreviewItem[] = [sourceItem()]) => ({
  previewId: ids.preview,
  previewHash: hash,
  previewRevision: 1,
  logicalMemoryId: ids.logicalMemory,
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  representation: "memory_events" as const,
  binding: binding(),
  items,
  redactedContentHash: hashB,
  sourceRevision: 4,
  sourceHash: hash,
  createdAt: iso
});

const consentResponse = () => ({
  id: ids.consent,
  logicalMemoryId: ids.logicalMemory,
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  mode: "continuous" as const,
  state: "active" as const,
  consentVersion: 1,
  allowedRepresentations: ["memory_events"] as const,
  selectedRepresentation: "memory_events" as const,
  previewRevision: 1,
  previewHash: hash,
  sourceRevision: 4,
  createdAt: iso,
  updatedAt: iso,
  activatedAt: iso,
  revokedAt: null
});

const grantResponse = (
  input: {
    lifecycle?: "active" | "unavailable" | "revoked";
    grantVersion?: number;
    representation?: "memory_events" | "lcm_leaves";
    consentId?: string;
    sourceRevision?: number;
    updatedAt?: string;
  } = {}
) => ({
  id: ids.grant,
  logicalGrantId: ids.logicalGrant,
  logicalMemoryId: ids.logicalMemory,
  ownerUserId: ids.upstreamUser,
  teamId: ids.team,
  teamWorkspaceId: ids.workspace,
  consentId: input.consentId ?? ids.consent,
  ownerAllowedRepresentations: [input.representation ?? "memory_events"],
  activeRepresentation: input.representation ?? "memory_events",
  representationPolicyRevision: 3,
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

const remoteReadResponse = () => ({
  grant: grantResponse(),
  representation: {
    shareGrantId: ids.grant,
    consentId: ids.consent,
    teamId: ids.team,
    teamWorkspaceId: ids.workspace,
    logicalMemoryId: ids.logicalMemory,
    representation: "memory_events" as const,
    sourceRevision: 4,
    sourceRevisionHash: hash,
    recordVersion: 1,
    state: "available" as const
  },
  items: [sourceItem(0), sourceItem(1), sourceItem(2)],
  sourcePage: { itemOffset: 0, itemCount: 3 },
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
    id: ids.consent,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    workspaceId: ids.workspace,
    mode: "continuous",
    state: "active",
    version: 1,
    allowedRepresentations: ["memory_events"],
    selectedRepresentation: "memory_events",
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
    representation?: "memory_events" | "lcm_leaves";
    consentId?: string;
    sourceRevision?: number;
    updatedAt?: string;
  } = {}
): CollaborationPersistedSharedMemoryGrant => ({
  backendId: "team-backend",
  localOwnerUserId: ids.localOwner,
  upstreamUserId: ids.upstreamUser,
  grant: {
    id: ids.grant,
    logicalGrantId: ids.logicalGrant,
    logicalMemoryId: ids.logicalMemory,
    ownerUserId: ids.upstreamUser,
    teamId: ids.team,
    workspaceId: ids.workspace,
    consentId: input.consentId ?? ids.consent,
    ownerAllowedRepresentations: [input.representation ?? "memory_events"],
    activeRepresentation: input.representation ?? "memory_events",
    representationPolicyRevision: 3,
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
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    workspaceId: ids.workspace,
    representation: "memory_events",
    allowedRepresentations: ["memory_events"],
    actionGrant: { id: ids.actionGrant }
  }
});

const shareCommand = () => ({
  ...commandBase("collaboration.share_memory"),
  input: {
    mutationId: randomUUID(),
    logicalGrantId: ids.logicalGrant,
    logicalMemoryId: ids.logicalMemory,
    teamId: ids.team,
    workspaceId: ids.workspace,
    consentId: ids.consent,
    mode: "continuous",
    allowedRepresentations: ["memory_events"],
    selectedRepresentation: "memory_events",
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
    preparePendingShareSource?: NonNullable<
      CollaborationSharedMemoryControlOptions["preparePendingShareSource"]
    >;
    loadLocalCandidatePreview?: NonNullable<
      CollaborationSharedMemoryControlOptions["loadLocalCandidatePreview"]
    >;
    remoteRead?: RemoteReadResponse;
    remoteOwnerGrants?: ReturnType<typeof grantResponse>[];
    remoteOwnedShares?: Record<string, unknown>[];
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
    localSessionId: string;
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
  const initialPreview: CollaborationPersistedSharedMemoryPreview = {
    ...previewResponse(previewItems),
    backendId: "team-backend",
    localOwnerUserId: ids.localOwner,
    upstreamUserId: ids.upstreamUser,
    allowedRepresentations: ["memory_events"]
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
        previewRevision: 1,
        allowedRepresentations: input.allowedRepresentations
      };
      previews.set(persisted.previewHash, persisted);
      return persisted;
    },
    async persistAuthoritativeCandidatePreview(input) {
      const persisted: CollaborationPersistedSharedMemoryPreview = {
        ...input.preview,
        ...input.identity,
        previewRevision: 1,
        allowedRepresentations: input.allowedRepresentations
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
          id: remote.id,
          logicalMemoryId: remote.logicalMemoryId,
          teamId: remote.teamId,
          workspaceId: remote.teamWorkspaceId,
          mode: remote.mode,
          state: remote.state,
          version: remote.consentVersion,
          allowedRepresentations: [...remote.allowedRepresentations],
          selectedRepresentation: remote.selectedRepresentation,
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
        representation:
          remote.activeRepresentation === "lcm_leaves"
            ? "lcm_leaves"
            : "memory_events",
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
        localSessionId: input.localSessionId
      });
      return overrides.persistPendingSourceWork ?? true;
    },
    async claimPendingShareSourceWork() {
      return [];
    },
    async finishPendingShareSourceWork() {
      return true;
    }
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
        url.pathname.endsWith("/v1/shared-memory/candidate-previews")
      ) {
        response = {
          admission: {
            previewId: ids.preview,
            previewHash: hashB,
            previewRevision: 1,
            logicalMemoryId: ids.logicalMemory,
            teamId: ids.team,
            teamWorkspaceId: ids.workspace,
            representation: "memory_events",
            allowedRepresentations: ["memory_events"],
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
      } else if (url.pathname.endsWith("/consents")) {
        response = { consent: consentResponse() };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/v1/shared-memory/pending-shares")
      ) {
        response = {
          pendingShare: {
            id: uuidFor(700),
            mutationId: recorded.body?.mutationId,
            logicalGrantId: recorded.body?.logicalGrantId,
            consentId: recorded.body?.consentId,
            logicalMemoryId: recorded.body?.logicalMemoryId,
            teamId: recorded.body?.teamId,
            workspaceId: recorded.body?.teamWorkspaceId,
            representation: recorded.body?.selectedRepresentation,
            allowedRepresentations: recorded.body?.allowedRepresentations,
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
            grantId: null
          }
        };
      } else if (
        recorded.method === "POST" &&
        url.pathname.endsWith("/v1/shared-memory/share-bundles")
      ) {
        response = {
          consent: consentResponse(),
          grant: grantResponse()
        };
      } else if (
        recorded.method === "PUT" &&
        url.pathname.endsWith("/representation-bundle")
      ) {
        response = {
          pendingShare: {
            id: uuidFor(701),
            mutationId: recorded.body?.mutationId,
            logicalGrantId: ids.logicalGrant,
            consentId: recorded.body?.consentId,
            logicalMemoryId: recorded.body?.logicalMemoryId,
            teamId: recorded.body?.teamId,
            workspaceId: recorded.body?.teamWorkspaceId,
            representation: "lcm_leaves",
            allowedRepresentations: ["lcm_leaves"],
            mode: recorded.body?.mode,
            sourceRevision: 4,
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
            grantId: ids.grant
          }
        };
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
      } else if (url.pathname.endsWith("/representation")) {
        response = {
          grant: grantResponse({
            representation: "lcm_leaves",
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
          }
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
    resolveUpstreamAuthorization: () =>
      overrides.upstreamAuthorization === undefined
        ? "Koed-Device upstream-key:upstream-secret"
        : overrides.upstreamAuthorization,
    authorityStore: store,
    prepareLocalLcmRepresentation:
      overrides.prepareLocalLcmRepresentation ?? (async () => "ready"),
    loadLocalCandidatePreview: overrides.loadLocalCandidatePreview,
    preparePendingShareSource: overrides.preparePendingShareSource,
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
    readLocalEdgeClientCredential: () => ({
      authorization:
        overrides.lecAuthorization ?? "Koed-Device lec-key:lec-secret",
      backendId: "team-backend",
      credentialKeyId: "lec-key",
      operationFamilies: overrides.lecFamilies ?? [
        "team_workspace_read",
        "share_grant_management"
      ]
    }),
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
    }),
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

describe("collaboration Shared Memory control", () => {
  it("returns a bounded local candidate without resolving remote authority", async () => {
    const loadLocalCandidatePreview = vi.fn(async () => ({
      sessionId: ids.localSession,
      logicalMemoryId: ids.logicalMemory,
      representation: "memory_events" as const,
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
          sessionId: ids.localSession,
          representation: "memory_events"
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
      representation: "memory_events"
    });
  });

  it("binds a local candidate to an authoritative destination without a sync target", async () => {
    const localCandidate = {
      sessionId: ids.localSession,
      logicalMemoryId: ids.logicalMemory,
      representation: "memory_events" as const,
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
          sessionId: ids.localSession,
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
        id: pendingShareId,
        mutationId: uuidFor(815),
        logicalGrantId: uuidFor(816),
        consentId: uuidFor(817),
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
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
        grantId: null
      },
      sourceAccess: null,
      summary: {
        sourceSessionId: uuidFor(818),
        sourceTitle: "Pending owner share",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
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
          sourceSessionId: ids.localSession,
          companionThreadId: ids.companion,
          sourceTitle: `Shared source ${index + 1}`,
          teamName: "Atlas Research",
          workspaceName: "Launch Plans",
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
        sourceSessionId: uuidFor(48),
        sourceTitle: "Owner preview",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
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
        id: pendingShareId,
        mutationId: uuidFor(47),
        logicalGrantId: ids.logicalGrant,
        consentId: ids.consent,
        logicalMemoryId: ids.logicalMemory,
        teamId: ids.team,
        workspaceId: ids.workspace,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
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
        grantId: ids.grant
      },
      sourceAccess: null,
      summary: {
        sourceSessionId: ids.localSession,
        sourceTitle: "Activated owner preview",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
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

  it("renames an owned Share and returns the refreshed local detail", async () => {
    const ownedGrant = {
      kind: "grant",
      grant: grantResponse(),
      sourceAccess: null,
      summary: {
        sourceSessionId: ids.localSession,
        sourceTitle: "Owner preview",
        teamName: "Atlas Research",
        workspaceName: "Launch Plans",
        mode: "continuous",
        authorizedPreview: null,
        lastReadyRevision: 4,
        lastSuccessfulUpdateAt: iso
      }
    };
    const fixture = createFixture({ remoteOwnedShares: [ownedGrant] });

    const result = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.rename_owned_share"),
        input: { kind: "grant", id: ids.grant, title: "Launch review" }
      },
      context()
    );

    expect(result).toMatchObject({
      ok: true,
      command: "collaboration.rename_owned_share",
      data: {
        share: { summary: { sourceTitle: "Launch review" } }
      }
    });
    expect(fixture.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "PATCH",
          body: { title: "Launch review" }
        })
      ])
    );
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
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.remoteReplica,
      teamId: ids.team,
      teamWorkspaceId: ids.workspace,
      representation: "memory_events",
      allowedRepresentations: ["memory_events"],
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
        representation: "lcm_leaves" as const,
        allowedRepresentations: ["lcm_leaves" as const]
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

  it("shares, revokes, and changes representation through persisted scoped authority", async () => {
    const shareFixture = createFixture();
    const shared = await shareFixture.control.dispatch(
      shareCommand(),
      context()
    );
    expect(shared).toMatchObject({
      ok: true,
      data: {
        grant: {
          id: ids.grant,
          companionThreadId: ids.companion,
          lifecycle: "active"
        }
      }
    });
    const materialization = shareFixture.requests.find((request) =>
      request.pathname.endsWith("/representations/memory_events")
    );
    expect(materialization).toMatchObject({
      method: "PUT",
      body: {
        consentId: ids.consent,
        expectedGrantVersion: 1,
        preview: { previewId: ids.preview, previewHash: hash }
      }
    });
    expect(materialization?.body?.mutationId).toMatch(/^[0-9a-f-]{36}$/i);

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
    expect(shareFixture.grantPersistenceModes).toEqual([
      "mutation",
      "revocation"
    ]);

    const changeFixture = createFixture();
    const replacementConsentId = uuidFor(500);
    const replacementPreviewId = uuidFor(501);
    changeFixture.previews.set(hashC, {
      ...previewResponse(),
      previewId: replacementPreviewId,
      previewHash: hashC,
      representation: "lcm_leaves",
      backendId: "team-backend",
      localOwnerUserId: ids.localOwner,
      upstreamUserId: ids.upstreamUser,
      allowedRepresentations: ["lcm_leaves"]
    });
    changeFixture.consents.set(replacementConsentId, {
      ...collaborationConsent(),
      previewId: replacementPreviewId,
      consent: {
        ...collaborationConsent().consent,
        id: replacementConsentId,
        selectedRepresentation: "lcm_leaves",
        allowedRepresentations: ["lcm_leaves"],
        previewHash: hashC
      }
    });
    const changed = await changeFixture.control.dispatch(
      {
        ...commandBase("collaboration.change_shared_memory_representation"),
        input: {
          mutationId: randomUUID(),
          logicalMemoryId: ids.logicalMemory,
          teamId: ids.team,
          workspaceId: ids.workspace,
          shareGrantId: ids.grant,
          consentId: replacementConsentId,
          representation: "lcm_leaves",
          expectedGrantVersion: 1,
          mode: "continuous",
          allowedRepresentations: ["lcm_leaves"],
          previewRevision: 1,
          previewHash: hashC,
          expiresAt: null,
          candidateSessionId: ids.localSession,
          actionGrant: { id: ids.actionGrant }
        }
      },
      context()
    );
    expect(changed).toMatchObject({
      ok: true,
      data: {
        pendingShare: {
          representation: "lcm_leaves",
          workspaceAccessState: "active",
          state: "preparing",
          grantId: ids.grant
        }
      }
    });
    const replacementRequest = changeFixture.requests.find((request) =>
      request.pathname.endsWith("/representation-bundle")
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
      localSessionId: ids.localSession
    });
  });

  it("durably records local source preparation before accepting a Pending Share", async () => {
    const preparePendingShareSource = vi.fn(async () => undefined);
    const fixture = createFixture({ preparePendingShareSource });
    const mutationId = randomUUID();
    const result = await fixture.control.dispatch(
      {
        ...shareCommand(),
        input: {
          ...shareCommand().input,
          mutationId,
          candidateSessionId: ids.localSession
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
        localSessionId: ids.localSession
      }
    ]);
    expect(preparePendingShareSource).toHaveBeenCalledWith({
      backendId: "team-backend",
      localOwnerUserId: ids.localOwner,
      sessionId: ids.localSession,
      pendingShareId: uuidFor(700),
      mutationId
    });
  });

  it("fails closed when Pending Share source work cannot be persisted", async () => {
    const preparePendingShareSource = vi.fn(async () => undefined);
    const fixture = createFixture({
      persistPendingSourceWork: false,
      preparePendingShareSource
    });
    const result = await fixture.control.dispatch(
      {
        ...shareCommand(),
        input: {
          ...shareCommand().input,
          candidateSessionId: ids.localSession
        }
      },
      context()
    );

    expectFailure(result, "not_available");
    expect(preparePendingShareSource).not.toHaveBeenCalled();
  });

  it("loads bounded source pages through an authorized remote grant read", async () => {
    const fixture = createFixture();
    const first = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.load_shared_source_page"),
        input: {
          sharedSession: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            sharedSessionId: ids.grant
          },
          direction: "older",
          cursor: null,
          limit: 2
        }
      },
      context()
    );
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
    expect(fixture.requests.at(-1)?.pathname.endsWith("/page")).toBe(true);
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

  it("fails closed when preview revision or companion thread persistence is unavailable", async () => {
    const previewGap = createFixture({ persistPreview: false });
    expectFailure(
      await previewGap.control.dispatch(previewCommand(), context()),
      "not_available"
    );
    const grantGap = createFixture({ persistGrant: false });
    expectFailure(
      await grantGap.control.dispatch(shareCommand(), context()),
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
        item.pathname.endsWith("/share-bundles")
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
    const first = await fixture.control.dispatch(
      {
        ...commandBase("collaboration.load_shared_source_page"),
        input: {
          sharedSession: {
            teamId: ids.team,
            workspaceId: ids.workspace,
            sharedSessionId: ids.grant
          },
          direction: "older",
          cursor: null,
          limit: 2
        }
      },
      context()
    );
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
    const wrongWorkspace = createFixture({
      remoteRead: {
        grant: { ...grantResponse(), teamWorkspaceId: uuidFor(999) },
        representation: {
          shareGrantId: ids.grant,
          consentId: ids.consent,
          teamId: ids.team,
          teamWorkspaceId: ids.workspace,
          logicalMemoryId: ids.logicalMemory,
          representation: "memory_events",
          sourceRevision: 4,
          sourceRevisionHash: hash,
          recordVersion: 1,
          state: "available"
        },
        items: [sourceItem()],
        sourcePage: { itemOffset: 0, itemCount: 1 },
        freshness: "fresh",
        companionScope: grantResponse().companionScope
      }
    });
    expectFailure(
      await wrongWorkspace.control.dispatch(
        {
          ...commandBase("collaboration.load_shared_source_page"),
          input: {
            sharedSession: {
              teamId: ids.team,
              workspaceId: ids.workspace,
              sharedSessionId: ids.grant
            },
            direction: "older",
            cursor: null,
            limit: 10
          }
        },
        context()
      ),
      "permission_denied"
    );

    const substituted = createFixture({
      mutateResponse: (request, response) =>
        request.method === "GET" && !request.pathname.includes("local-edge")
          ? {
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
      await substituted.control.dispatch(
        {
          ...commandBase("collaboration.load_shared_source_page"),
          input: {
            sharedSession: {
              teamId: ids.team,
              workspaceId: ids.workspace,
              sharedSessionId: ids.grant
            },
            direction: "older",
            cursor: null,
            limit: 10
          }
        },
        context()
      ),
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
