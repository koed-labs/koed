import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import type {
  CollaborationRepository,
  DeviceCredentialAuthContext,
  HighRiskActionRepository,
  SharedMemoryConsentRecord,
  SharedMemoryGrantRecord,
  SharedMemoryPolicyRecord,
  SharedMemoryReadResult,
  SharedMemoryRepository,
  SharedMemoryRepresentationRecord,
  UserRecord
} from "@koed/db";
import {
  SHARED_MEMORY_AUTHORITY,
  SharedMemoryAuthorizationError,
  SharedMemoryConflictError
} from "@koed/db";
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

  let grantVersion = 1;
  let revoked = false;
  let representationAvailable = true;
  let repositoryCalls = 0;
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

  const policyRecord = (
    scope: SharedMemoryPolicyRecord["scope"],
    allowedRepresentations: SharedMemoryPolicyRecord["allowedRepresentations"]
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
    allowedRepresentations,
    policyHash: hash,
    effectiveAt: iso,
    supersededAt: null
  });

  const grantRecord = (): SharedMemoryGrantRecord => ({
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
    sourceOwnerPolicyId: randomUUID(),
    sourceOwnerPolicyVersion: 1,
    teamPolicyId: randomUUID(),
    teamPolicyVersion: 1,
    workspacePolicyId: randomUUID(),
    workspacePolicyVersion: 1,
    ownerAllowedRepresentations: ["memory_events", "lcm_leaves"],
    activeRepresentation: "memory_events",
    representationPolicyRevision: 1,
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

  const representationRecord = (): SharedMemoryRepresentationRecord => ({
    id: ids.representation,
    shareGrantId: ids.grant,
    consentId: ids.consent,
    sourcePreviewId: ids.preview,
    sourceArtifactId: randomUUID(),
    teamId: ids.teamA,
    teamWorkspaceId: ids.workspaceA,
    logicalMemoryId: ids.logicalMemory,
    representation: "memory_events",
    sourceRevision: 1,
    sourceRevisionHash: hash,
    provenanceHash: hash,
    sourceOwnerPolicyId: randomUUID(),
    sourceOwnerPolicyVersion: 1,
    teamPolicyId: randomUUID(),
    teamPolicyVersion: 1,
    workspacePolicyId: randomUUID(),
    workspacePolicyVersion: 1,
    representationPolicyRevision: 1,
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
      representation: "memory_events" | "lcm_leaves" | "lcm_rollups";
    } = {
      logicalMemoryId: ids.logicalMemory,
      remoteReplicaId: ids.remoteReplica,
      teamId: ids.teamA,
      teamWorkspaceId: ids.workspaceA,
      representation: "memory_events"
    }
  ): SharedMemoryPersistedPreviewRecord => ({
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
    previewRevision: 1,
    binding: binding(),
    items: [
      {
        itemType:
          input.representation === "lcm_leaves" ? "lcm_leaf" : "user_message",
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
                sourceIds: [ids.source]
              }
            : { text: "server-loaded source" }
      }
    ],
    redactedContentHash: hash,
    sourceRevision: 1,
    sourceHash: hash,
    syncRelationshipId: randomUUID(),
    deviceProvenanceHash: hash,
    createdAt: iso
  });

  const readResult = (page?: {
    direction: "older" | "newer";
    boundary?: number;
    limit: number;
  }): SharedMemoryReadResult => {
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
      representation: representationRecord(),
      items: [
        {
          itemType: "tool_result" as const,
          schemaVersion: 1 as const,
          sourceId: ids.source,
          sourceLogicalMemoryId: ids.logicalMemory,
          sourceRevision: 1,
          occurredAt: iso,
          content: {
            toolName: "fixture_tool",
            toolCallId: "call-shared-route-fixture",
            payload: {
              authorization: "raw-device-secret",
              note: "Bearer secret-value-with-enough-length"
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
    allowedRepresentations: ["memory_events"],
    selectedRepresentation: "memory_events",
    previewRevision: 1,
    previewHash: hash,
    sourceRevision: 1,
    maximumAuthorizedSourceRevision: 1,
    sourceHash: hash,
    representationPolicyRevision: 1,
    representationPolicyHash: hash,
    contentPolicyVersion: 1,
    contentPolicyHash: hash,
    classifierVersion: 1,
    classifierHash: hash,
    redactedContentHash: hash,
    createdAt: iso,
    updatedAt: iso,
    activatedAt: iso,
    revokedAt: null
  });

  const repository: SharedMemoryRepository = {
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
      return previewRecord(input);
    },
    async putSourceOwnerPolicy(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private owner detail");
      }
      return policyRecord("source_owner", input.allowedRepresentations);
    },
    async putTeamPolicy(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError("private manager detail");
      }
      representationAvailable =
        input.allowedRepresentations.includes("memory_events");
      return policyRecord("team", input.allowedRepresentations);
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
      representationAvailable =
        input.allowedRepresentations.includes("memory_events");
      return policyRecord("workspace", input.allowedRepresentations);
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
      return grantRecord();
    },
    async selectGrantRepresentation(actor, input) {
      repositoryCalls += 1;
      if (actor.userId !== ids.alice) {
        throw new SharedMemoryAuthorizationError(
          "Only the private source owner may select this representation"
        );
      }
      if (input.expectedGrantVersion !== grantVersion) {
        throw new SharedMemoryConflictError(
          "Private optimistic state and policy detail"
        );
      }
      grantVersion += 1;
      return grantRecord();
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
        ...representationRecord(),
        representation:
          input.preview.previewId === ids.lcmPreview
            ? "lcm_leaves"
            : "memory_events"
      };
    },
    async advanceContinuousGrantRepresentations() {
      return { advanced: 0 };
    },
    async listWorkspaceGrants(actor, input) {
      repositoryCalls += 1;
      lastListInput = input;
      if (actor.userId !== ids.alice && actor.userId !== ids.bob) {
        throw new SharedMemoryAuthorizationError("private workspace detail");
      }
      const entry = {
        shareGrantId: ids.grant,
        logicalMemoryId: ids.logicalMemory,
        ownerUserId: ids.alice,
        activeRepresentation: "memory_events" as const,
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
      const all = revoked || !representationAvailable ? [] : [entry];
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
        !representationAvailable
      ) {
        throw new SharedMemoryAuthorizationError(
          "Private Team, Workspace, and lifecycle detail"
        );
      }
      return readResult(input.page);
    }
  };

  return {
    ids,
    users,
    repository,
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
    restoreRepresentation() {
      representationAvailable = true;
    }
  };
};

const buildTestServer = async (fixture: ReturnType<typeof createFixture>) => {
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
        sharedMemory: fixture.repository
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
    requireCollaborationRepository: () => collaborationRepository,
    requireHighRiskRepository: () => highRiskRepository,
    authenticateSession: sessionUser,
    authenticateSessionContext: async (request) => ({
      sessionId: fixture.ids.sessionAuthority,
      createdAt: new Date(iso),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      user: await sessionUser(request)
    }),
    authenticateDeviceCredential: deviceContext,
    authenticateSessionOrDeviceCredential,
    readRateLimit: noRateLimit,
    writeRateLimit: noRateLimit
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
  representationPolicyRevision: 1,
  representationPolicyHash: hash,
  contentPolicyVersion: 1,
  contentPolicyHash: hash,
  classifierVersion: 1,
  classifierHash: hash
});

const selectionBody = (fixture: ReturnType<typeof createFixture>) => ({
  mutationId: randomUUID(),
  teamId: fixture.ids.teamA,
  teamWorkspaceId: fixture.ids.workspaceA,
  consentId: fixture.ids.consent,
  representation: "memory_events" as const,
  expectedGrantVersion: 1,
  authority: authority()
});

const scopedGrantUrl = (fixture: ReturnType<typeof createFixture>) =>
  `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/share-grants/${fixture.ids.grant}`;

const workspaceGrantIndexUrl = (fixture: ReturnType<typeof createFixture>) =>
  `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/share-grants`;

const ownerGrantIndexUrl = (fixture: ReturnType<typeof createFixture>) =>
  `/v1/shared-memory/logical-memories/${fixture.ids.logicalMemory}/share-grants`;

describe("Shared Memory HTTP routes", () => {
  it("denies API Tokens from owner mutations, previews, and Team reads", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const bearer = { authorization: "Bearer personal-api-token" };

    const selection = await app.inject({
      method: "PUT",
      url: `/v1/shared-memory/share-grants/${fixture.ids.grant}/representation`,
      headers: bearer,
      payload: selectionBody(fixture)
    });
    const preview = await app.inject({
      method: "POST",
      url: "/v1/shared-memory/previews",
      headers: bearer,
      payload: {
        logicalMemoryId: fixture.ids.logicalMemory,
        remoteReplicaId: fixture.ids.remoteReplica,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
        authority: authority()
      }
    });
    const read = await app.inject({
      method: "GET",
      url: scopedGrantUrl(fixture),
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
        logicalMemoryId: fixture.ids.logicalMemory,
        remoteReplicaId: fixture.ids.remoteReplica,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        representation: "memory_events",
        allowedRepresentations: ["memory_events"],
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
      redactedContentHash: hash,
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

  it("activates referenced consent and creates a Share Grant with explicit authority", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const preview = { previewId: fixture.ids.preview, previewHash: hash };

    const consent = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers: sessionHeaders(fixture.ids.alice),
      payload: {
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview,
        previewRevision: 1,
        mode: "snapshot",
        allowedRepresentations: ["memory_events"],
        selectedRepresentation: "memory_events",
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
        mutationId: randomUUID(),
        logicalGrantId: fixture.ids.logicalGrant,
        logicalMemoryId: fixture.ids.logicalMemory,
        teamId: fixture.ids.teamA,
        teamWorkspaceId: fixture.ids.workspaceA,
        consentId: fixture.ids.consent,
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
    ]).toEqual([201, 201, 400]);
    expect(fixture.browserAuthorityReferenceIds).toEqual([
      fixture.ids.sessionAuthority
    ]);
    expect(consent.body).not.toContain("remoteReplicaId");
    expect(consent.body).not.toContain("previewId");
    expect(consent.body).not.toContain(fixture.ids.remoteReplica);
    expect(grant.body).not.toContain("creatorAuthority");
    expect(grant.body).toContain("companionScope");
    await app.close();
  });

  it("rejects inline preview source payload smuggling before repository access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);
    const base = {
      logicalMemoryId: fixture.ids.logicalMemory,
      remoteReplicaId: fixture.ids.remoteReplica,
      teamId: fixture.ids.teamA,
      teamWorkspaceId: fixture.ids.workspaceA,
      representation: "memory_events",
      allowedRepresentations: ["memory_events"],
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
        allowedRepresentations: ["memory_events"],
        selectedRepresentation: "memory_events",
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
    const representationCeiling = await app.inject({
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
      representationCeiling.statusCode
    ]).toEqual([400, 400, 400, 400]);
    await app.close();
  });

  it("maps owner authorization and optimistic conflicts without repository detail", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const url = `/v1/shared-memory/share-grants/${fixture.ids.grant}/representation`;

    const denied = await app.inject({
      method: "PUT",
      url,
      headers: sessionHeaders(fixture.ids.bob),
      payload: selectionBody(fixture)
    });
    const conflicted = await app.inject({
      method: "PUT",
      url,
      headers: sessionHeaders(fixture.ids.alice),
      payload: { ...selectionBody(fixture), expectedGrantVersion: 999 }
    });

    expect(denied.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(denied).error).toBe(
      "Shared Memory operation is not authorized"
    );
    expect(denied.body).not.toContain("private source owner");
    expect(conflicted.statusCode).toBe(409);
    expect(jsonBody<{ error: string }>(conflicted).error).toBe(
      "Shared Memory state conflict"
    );
    expect(conflicted.body).not.toContain("policy detail");
    await app.close();
  });

  it("requires exact device scopes while repository reads re-evaluate access", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const url = scopedGrantUrl(fixture);

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

  it("returns the initial Shared Memory source and companion discussion under one authorization boundary", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const response = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}/initial-view`,
      headers: { authorization: "Koed-Device reader:secret" }
    });

    expect(response.statusCode).toBe(200);
    expect(jsonBody<Record<string, unknown>>(response)).toMatchObject({
      sharedMemory: {
        grant: {
          id: fixture.ids.grant,
          teamId: fixture.ids.teamA,
          teamWorkspaceId: fixture.ids.workspaceA
        },
        companionScope: {
          shareGrantId: fixture.ids.grant,
          logicalMemoryId: fixture.ids.logicalMemory
        },
        sourcePage: { itemOffset: 0, itemCount: 1 }
      },
      companion: {
        thread: {
          kind: "shared_session_discussion",
          shareGrantId: fixture.ids.grant
        },
        messages: {
          messages: [{ bodyText: "Review the shared source." }]
        }
      }
    });
    await app.close();
  });

  it("returns bounded Shared Memory pages and rejects out-of-range boundaries", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const page = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}/page?direction=older&limit=1`,
      headers: { authorization: "Koed-Device reader:secret" }
    });
    const outOfRange = await app.inject({
      method: "GET",
      url: `${scopedGrantUrl(fixture)}/page?direction=older&boundary=2&limit=1`,
      headers: { authorization: "Koed-Device reader:secret" }
    });

    expect(page.statusCode).toBe(200);
    expect(jsonBody<Record<string, unknown>>(page)).toMatchObject({
      sharedMemory: {
        sourcePage: { itemOffset: 0, itemCount: 1 },
        items: [{ sourceId: fixture.ids.source }]
      }
    });
    expect(outOfRange.statusCode).toBe(409);
    await app.close();
  });

  it("denies wrong preview references and consent path bindings", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.alice);

    const wrongPreview = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamA}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers,
      payload: {
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview: { previewId: randomUUID(), previewHash: "b".repeat(64) },
        previewRevision: 1,
        mode: "snapshot",
        allowedRepresentations: ["memory_events"],
        selectedRepresentation: "memory_events",
        authority: authority()
      }
    });
    const wrongPath = await app.inject({
      method: "POST",
      url: `/v1/shared-memory/teams/${fixture.ids.teamB}/workspaces/${fixture.ids.workspaceA}/consents`,
      headers,
      payload: {
        consentId: fixture.ids.consent,
        logicalMemoryId: fixture.ids.logicalMemory,
        preview: { previewId: fixture.ids.preview, previewHash: hash },
        previewRevision: 1,
        mode: "snapshot",
        allowedRepresentations: ["memory_events"],
        selectedRepresentation: "memory_events",
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
    ]).toEqual([403, 403, 403, 403]);
    for (const response of [
      wrongPreview,
      wrongPath,
      wrongMaterializationPreview,
      wrongRepresentationBinding
    ]) {
      expect(jsonBody<{ error: string }>(response).error).toBe(
        "Shared Memory operation is not authorized"
      );
    }
    await app.close();
  });

  it("fails closed across Team and Workspace paths even when a repository mock returns data", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.bob);
    const wrongTeam = scopedGrantUrl(fixture).replace(
      fixture.ids.teamA,
      fixture.ids.teamB
    );
    const wrongWorkspace = scopedGrantUrl(fixture).replace(
      fixture.ids.workspaceA,
      fixture.ids.workspaceB
    );
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
    expect(body.shareGrants[0]).toEqual({
      id: fixture.ids.grant,
      logicalMemoryId: fixture.ids.logicalMemory,
      ownerUserId: fixture.ids.alice,
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
        logicalMemoryId: fixture.ids.logicalMemory,
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

  it("returns redacted read, index, and detail DTOs with companion scope", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const headers = sessionHeaders(fixture.ids.bob);
    const url = scopedGrantUrl(fixture);

    const read = await app.inject({ method: "GET", url, headers });
    const index = await app.inject({
      method: "GET",
      url: `${url}/items`,
      headers
    });
    const detail = await app.inject({
      method: "GET",
      url: `${url}/items/${fixture.ids.source}`,
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
      expect(response.body).not.toContain(fixture.ids.remoteReplica);
    }
    expect(
      jsonBody<{ items: Array<{ content?: unknown }> }>(index).items[0]
    ).not.toHaveProperty("content");
    await app.close();
  });

  it("makes downgraded and revoked representations unavailable to future reads", async () => {
    const fixture = createFixture();
    const app = await buildTestServer(fixture);
    const readHeaders = sessionHeaders(fixture.ids.bob);
    const ownerHeaders = sessionHeaders(fixture.ids.alice);
    const url = scopedGrantUrl(fixture);
    const indexUrl = workspaceGrantIndexUrl(fixture);

    expect(
      (await app.inject({ method: "GET", url, headers: readHeaders }))
        .statusCode
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
        allowedRepresentations: ["lcm_leaves"]
      }
    });
    expect(downgrade.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url, headers: readHeaders }))
        .statusCode
    ).toBe(403);
    expect(
      jsonBody<{ shareGrants: unknown[] }>(
        await app.inject({ method: "GET", url: indexUrl, headers: readHeaders })
      ).shareGrants
    ).toEqual([]);

    fixture.restoreRepresentation();
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
      (await app.inject({ method: "GET", url, headers: readHeaders }))
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

  it("materializes an LCM representation from a persisted preview reference", async () => {
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

    expect(response.statusCode).toBe(200);
    expect(fixture.repositoryCalls).toBe(1);
    await app.close();
  });
});
