import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExpandedMemoryNode,
  MemoryActor,
  MemoryEventRecord,
  MemorySearchResult
} from "@koed/core";
import releaseManifest from "@koed/koed/package.json" with { type: "json" };
import pdsFixture from "../../../packages/shared/test-fixtures/personal-device-sync-v1.json" with { type: "json" };
import type {
  ActorContext,
  ActivationAnalyticsFunnelRecord,
  AiClientCapabilitySnapshotDiagnosticRecord,
  AiClientCapabilitySnapshotRecord,
  AiClientInstanceRecord,
  AuditEventRecord,
  ApiTokenRecord,
  AcceptedTeamInviteRecord,
  CapturedSessionRecord,
  ConversationItemInput,
  ConversationSourceArtifactRecord,
  ConversationSourceConsumerCursorRecord,
  ConversationSourceSegmentRecord,
  CreateMemoryNodeInput,
  CreateUserInput,
  DeviceCredentialRecord,
  DeviceEnrollmentChallengeRecord,
  EmbeddingCapacityRepository,
  ExternalAuthIdentityRecord,
  ExternalAuthOrganizationRecord,
  HistoricalImportRunRecord,
  HistoricalImportSourceRecord,
  LocalMemoryAgentSettingRecord,
  MemoryQuestionDetailRecord,
  MemoryNodeRecord,
  MemorySourceRepository,
  TeamBillingSeatStateRecord,
  TeamInviteRecord,
  TeamEntitlementGateRecord,
  TeamMembershipRecord,
  TeamRecord,
  TeamSupportOverviewRecord,
  TeamWorkspaceAccessRecord,
  TeamWorkspaceRecord,
  UserRecord,
  UserSessionContext,
  Visibility
} from "@koed/db";
import { createDbPool, createMemorySourceRepository } from "@koed/db";
import {
  COLLABORATION_CONTRACT_VERSION,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
  canonicalizePdsJson,
  createPdsAuthorizedKeyBundle,
  signPdsGroupDraft,
  calculateConversationSourceClosureDigest,
  codexCanonicalConversationItemKey,
  createLocalTestKeyEnvelopeEncryptionProvider,
  storeDesktopLocalCredential,
  decryptEncryptedJsonPackage,
  rawConversationTransportChunkGroupId,
  storeLocalEdgeClientCredential,
  type EnvelopeEncryptionProvider,
  type EncryptedJsonPackage
} from "@koed/shared";
import {
  buildServer as buildApiServer,
  canReceiveGraphStreamPayload,
  graphUpdateActionForPayload,
  shouldIgnoreGraphStreamPayload
} from "./server/index.js";
import type { BuildServerOptions } from "./server/index.js";
import type { WorkosAuthKitClient } from "./auth/workos.js";

const testProtocolDeploymentId = "00000000-0000-4000-8000-000000000001";

const buildServer = (options: BuildServerOptions = {}) =>
  buildApiServer({
    inspectDeploymentIdentity:
      options.inspectDeploymentIdentity ??
      (() => ({
        health: "healthy",
        deploymentId: testProtocolDeploymentId,
        deviceInstanceId: "00000000-0000-4000-8000-000000000002",
        remoteOperationsAllowed: true,
        message: "Test deployment identity is verified.",
        platformProtection: "verified"
      })),
    ...options
  });

const hashSecretForTest = (secret: string) =>
  createHash("sha256")
    .update(`${process.env.API_TOKEN_PEPPER ?? ""}${secret}`)
    .digest("hex");

const codexCanonicalConversationItemKeyForTest = (input: {
  externalThreadId: string;
  externalTurnId?: string;
  stableItemId: string;
  component: string;
}) =>
  `conversation-item:${createHash("sha256")
    .update(
      JSON.stringify({
        version: 3,
        provider: "codex",
        externalThreadId: input.externalThreadId,
        externalTurnId: input.externalTurnId ?? null,
        stableItemId: input.stableItemId,
        component: input.component
      })
    )
    .digest("hex")}`;

afterEach(() => {
  for (const name of [
    "KOED_ALLOW_PUBLIC_REGISTRATION",
    "KOED_TEAM_COLLABORATION_ENABLED",
    "KOED_DEVELOPER_TEAM_BACKEND_ENABLED",
    "MEMORY_RATE_LIMIT_WINDOW_MS",
    "MEMORY_RATE_LIMIT_MAX",
    "MEMORY_READ_RATE_LIMIT_WINDOW_MS",
    "MEMORY_READ_RATE_LIMIT_MAX",
    "MEMORY_WRITE_RATE_LIMIT_WINDOW_MS",
    "MEMORY_WRITE_RATE_LIMIT_MAX",
    "MEMORY_RECALL_RATE_LIMIT_WINDOW_MS",
    "MEMORY_RECALL_RATE_LIMIT_MAX",
    "MEMORY_PROJECTION_REBUILD_RATE_LIMIT_WINDOW_MS",
    "MEMORY_PROJECTION_REBUILD_RATE_LIMIT_MAX",
    "RATE_LIMIT_STORE",
    "RATE_LIMIT_REDIS_URL",
    "REDIS_URL",
    "WORK_QUEUE_BACKEND",
    "CACHE_STORE",
    "CACHE_REDIS_URL",
    "GRAPH_CACHE_TTL_SECONDS",
    "KOED_HOST_CHECKOUT_PATH",
    "KOED_DEPLOYMENT_PROFILE",
    "KOED_RUNTIME_MODE",
    "KOED_DEPENDENCY_MODE",
    "BROWSER_PUBLIC_URL",
    "CORS_ORIGINS",
    "API_CORS_ORIGINS",
    "WORKOS_AUTHKIT_ENABLED",
    "WORKOS_API_BASE_URL",
    "WORKOS_CLIENT_ID",
    "WORKOS_API_KEY",
    "WORKOS_REDIRECT_URI",
    "WORKOS_PROVIDER_ENVIRONMENT",
    "API_DATA_ENCRYPTION_KEY",
    "API_ENVELOPE_ENCRYPTION_PROVIDER",
    "KOED_MANAGED_CLOUD_RELEASE_STAGE",
    "MANAGED_KMS_KEY_ID",
    "MANAGED_KMS_KEY_VERSION",
    "MANAGED_KMS_ENDPOINT_URL",
    "MANAGED_KMS_AUTH_TOKEN",
    "OWNER_PRIVATE_REPLICA_DATA_ENCRYPTION_KEY",
    "OWNER_PRIVATE_REPLICA_ENVELOPE_ENCRYPTION_PROVIDER",
    "OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_ID",
    "OWNER_PRIVATE_REPLICA_MANAGED_KMS_KEY_VERSION",
    "OWNER_PRIVATE_REPLICA_MANAGED_KMS_ENDPOINT_URL",
    "OWNER_PRIVATE_REPLICA_MANAGED_KMS_AUTH_TOKEN",
    "KOED_HOME",
    "KOED_BACKUP_STATUS_PATH",
    "KOED_BACKUP_MAX_AGE_SECONDS",
    "KOED_OPS_REQUEST_METRICS_STATUS_PATH",
    "KOED_RUNBOOK_BASE_URL",
    "KOED_OPS_OPERATOR_EMAILS",
    "KOED_OPS_ALERT_WEBHOOK_URL",
    "KOED_OPS_ALERT_WEBHOOK_TOKEN",
    "KOED_OPS_METRICS_TOKEN"
  ]) {
    delete process.env[name];
  }
});

beforeEach(() => {
  process.env.KOED_TEAM_COLLABORATION_ENABLED = "true";
});

const cookieHeader = (response: {
  headers: Record<string, unknown>;
}): string => {
  const cookie = response.headers["set-cookie"];
  const firstCookie = isStringArray(cookie)
    ? cookie[0]
    : typeof cookie === "string"
      ? cookie
      : undefined;
  return firstCookie?.split(";")[0] ?? "";
};

const cookieJarHeader = (response: {
  headers: Record<string, unknown>;
}): string => {
  const cookie = response.headers["set-cookie"];
  const cookies = isStringArray(cookie)
    ? cookie
    : typeof cookie === "string"
      ? [cookie]
      : [];
  return cookies.map((item) => item.split(";")[0]).join("; ");
};

const browserSessionHeaders = (
  cookie: string,
  extra: Record<string, string> = {}
): Record<string, string> => ({
  cookie,
  origin: "http://localhost:3300",
  "sec-fetch-site": "same-origin",
  ...extra
});

const configureTestWorkos = (): void => {
  process.env.WORKOS_AUTHKIT_ENABLED = "true";
  process.env.WORKOS_CLIENT_ID = "client_test_123";
  process.env.WORKOS_API_KEY = "sk_test_hidden";
  process.env.WORKOS_REDIRECT_URI =
    "https://cloud.example.test/auth/workos/callback";
  process.env.WORKOS_PROVIDER_ENVIRONMENT = "test";
};

const createVerifiedWorkosSessionForTest = async (
  repository: MemorySourceRepository,
  email: string
): Promise<string> => {
  const result = await repository.upsertExternalAuthSession({
    provider: "workos_authkit",
    providerEnvironment: "test",
    providerUserId: `workos-${randomUUID()}`,
    email,
    emailVerified: true,
    displayName: null,
    profile: {}
  });
  const sessionSecret = `cms_${randomBytes(32).toString("base64url")}`;
  await repository.createSession(
    result.user.id,
    hashSecretForTest(sessionSecret),
    new Date(Date.now() + 60 * 60 * 1_000)
  );
  return `cm_session=${sessionSecret}`;
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const jsonBody = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;

const enrollDeviceCredentialForTest = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  cookie: string,
  operationFamilies: string[],
  upstreamBackendId = "team-vps"
): Promise<{
  authorization: string;
  credentialKeyId: string;
  deviceSecret: string;
}> => {
  const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
  const deviceSecret = `device-secret-${randomUUID()}`;
  const credentialKeyId = `device-key-${randomUUID()}`;
  await app.inject({
    method: "POST",
    url: "/v1/local-edge/device-enrollments/challenges",
    headers: browserSessionHeaders(cookie),
    payload: {
      challenge_hash: challengeHash,
      upstream_backend_id: upstreamBackendId,
      protocol_deployment_id: testProtocolDeploymentId,
      device_instance_id: `device-${randomUUID()}`,
      requested_operation_families: operationFamilies
    }
  });
  const redeemed = await app.inject({
    method: "POST",
    url: "/v1/local-edge/device-enrollments/credentials",
    headers: browserSessionHeaders(cookie),
    payload: {
      challenge_hash: challengeHash,
      credential_key_id: credentialKeyId,
      verifier_kind: "secret_hash",
      verifier_secret: deviceSecret
    }
  });
  expect(redeemed.statusCode).toBe(200);

  return {
    authorization: `Koed-Device ${credentialKeyId}:${deviceSecret}`,
    credentialKeyId,
    deviceSecret
  };
};

const writeUpstreamRegistryFixture = (
  input: {
    id?: string;
    baseUrl?: string;
    routePolicy?: Record<string, string>;
    capabilityState?: string;
    credentialStatus?: string;
    expiresAt?: string | null;
  } = {}
): string => {
  const dir = mkdtempSync(resolve(tmpdir(), "koed-api-upstreams-"));
  const path = resolve(dir, "upstream-backends.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      activeBackendId: input.id ?? "team-vps",
      backends: [
        {
          id: input.id ?? "team-vps",
          displayName: "Team VPS",
          baseUrl: input.baseUrl ?? "https://team.example.test/koed",
          profile: "private_vps",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          routePolicy: {
            personalMemoryRead: "disabled",
            teamWorkspaceRead: "disabled",
            shareGrantManagement: "disabled",
            captureWrites: "disabled",
            sync: "disabled",
            admin: "disabled",
            ...input.routePolicy
          },
          credential: {
            status: input.credentialStatus ?? "configured"
          },
          capabilities: {
            state: input.capabilityState ?? "validated",
            checkedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: input.expiresAt ?? "2099-01-01T00:00:00.000Z",
            schemaVersion: 2,
            profile: "private_vps",
            releaseVersion: "0.2.0"
          }
        }
      ]
    })
  );
  return path;
};

type TokenResponse = {
  token: string;
  apiToken: {
    id: string;
    ownerUserId: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
  };
};

const registerApiClientForTest = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  email: string
): Promise<{ authorization: string; cookie: string; token: string }> => {
  const registered = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "password123" }
  });
  expect(registered.statusCode).toBe(200);
  const cookie = cookieHeader(registered);
  const createdToken = await app.inject({
    method: "POST",
    url: "/api-tokens",
    headers: browserSessionHeaders(cookie),
    payload: { name: "Raw Conversation Test Client" }
  });
  expect(createdToken.statusCode).toBe(200);
  const token = jsonBody<TokenResponse>(createdToken).token;
  return { authorization: `Bearer ${token}`, cookie, token };
};

const createCapturedSessionForTest = async (
  app: Awaited<ReturnType<typeof buildServer>>,
  authorization: string,
  input: {
    externalSessionId?: string;
    captureMethod?: "transcript" | "mcp" | "web" | "api";
    metadata?: Record<string, unknown>;
  } = {}
): Promise<CapturedSessionRecord> => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: { authorization },
    payload: {
      externalSessionId: input.externalSessionId ?? `thread-${randomUUID()}`,
      sourceRuntime: "codex",
      captureMethod: input.captureMethod ?? "api",
      metadata: input.metadata ?? {}
    }
  });
  expect(response.statusCode).toBe(200);
  return jsonBody<{ session: CapturedSessionRecord }>(response).session;
};

const rawConversationItemPayload = (
  sessionId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  sessionId,
  sourceKind: "codex",
  sourceAdapterVersion: "codex-app-server-v1",
  sourceTransport: "app_server",
  sourceRecordType: "app_server_notification",
  sourceEventType: "thread/started",
  rawJson: { method: "thread/started" },
  sourceHash: `raw-source-${randomUUID()}`,
  idempotencyKey: `raw-idempotency-${randomUUID()}`,
  metadata: {},
  ...overrides
});

type AccessResponse = {
  ok?: boolean;
  auth?: string;
  providerConfigSupported?: boolean;
};

type LocalEdgeDecisionResponse = {
  action: string;
  reason: string;
  credentialState: string;
  relayCredentialState?: string;
};

type CapabilitiesResponse = {
  product: string;
  apiVersion: string;
  capabilitySchemaVersion: number;
  audience: string;
  releaseVersion: string;
  deployment: {
    profile: string;
    distribution: string;
    managedBy: string;
    productBoundary: string;
  };
  runtime: {
    localEdge: boolean;
    remoteUpstreams: string;
    dependencyMode: string;
  };
  auth: {
    providers: string[];
    session: string;
    apiTokens: string;
    deviceEnrollment: string;
    enrollment: {
      setupPath: string;
      deviceEnrollment: string;
      apiTokenFallback: string;
      authenticatedStatusEndpoint: string;
      mcpAndCaptureHookTarget: string;
      notes: string[];
    };
  };
  memory: {
    personal: string;
    teamWorkspaces: string;
    collaboration: string;
    shareGrants: string;
    crossIdentitySync: string;
    memoryInbox: string;
  };
  protocols: {
    collaborationRealtime: {
      version: number;
      transport: string;
      snapshotEndpoint: string;
      streamEndpoint: string;
      acknowledgementEndpoint: string;
    };
  };
  commercial: {
    billingEntitlements: string;
    accessSuspension: string;
    supportAdmin: string;
    stateVocabulary: {
      entitlementStatuses: string[];
      billingStatuses: string[];
      billingSeatSyncStatuses: string[];
    };
    entitlement: {
      scope: string;
      status: string;
      allowsTeamAccess: boolean | null;
      deniedOperationFamilies: string[];
      teamId?: string;
      requiresAuthentication: boolean;
    };
    billing: {
      scope: string;
      status: string;
      overLimit: boolean | null;
      seatSyncStatus: string | null;
      requiresAuthentication: boolean;
    };
    featureGates: Record<
      string,
      {
        capability: string;
        availability: string;
        entitlementStatus: string;
        billingStatus: string;
        enforcement: string;
        requiresAuthentication: boolean;
      }
    >;
  };
  security: {
    applicationLayerEncryption: string;
    queryableVectors: string;
    objectStorage: string;
    deploymentTlsRequired: boolean;
  };
  authenticatedCapabilities: {
    available: boolean;
    endpoint: string;
  };
  providers: string[];
  capabilities: Record<
    string,
    {
      availability: string;
      description: string;
      endpoints?: string[];
      requiresAuthentication?: boolean;
    }
  >;
};
type TeamResponse = {
  team: TeamRecord;
  defaultWorkspace: TeamWorkspaceRecord;
};
type TeamInviteResponse = {
  invite: TeamInviteRecord;
  inviteToken: string;
};
type TeamInviteAcceptResponse = {
  invite: TeamInviteRecord;
  membership: TeamMembershipRecord;
  user: { id: string; email: string };
  createdUser: boolean;
};
type TeamMembershipResponse = {
  membership: TeamMembershipRecord;
};
type TeamWorkspaceResponse = {
  teamWorkspace: TeamWorkspaceRecord;
};
type TeamWorkspaceAccessResponse = {
  access: TeamWorkspaceAccessRecord;
};
type TeamEntitlementResponse = {
  entitlement: TeamEntitlementGateRecord;
};
type TeamBillingSeatResponse = {
  billingSeats: TeamBillingSeatStateRecord;
};
type TeamSupportOverviewResponse = {
  supportOverview: TeamSupportOverviewRecord;
};
type TeamAuditEventsResponse = {
  auditEvents: Array<{
    actorUserId: string | null;
    action: string;
    targetTable: string | null;
    targetId: string | null;
    metadata: Record<string, unknown>;
  }>;
};

type CaptureResponse = {
  event: {
    id: string;
    visibility: string;
    metadata: Record<string, unknown>;
  };
  compaction?: { leafNodeIds: string[] };
  processing?: { compaction: { inline: boolean } };
};

type SearchResponse = { hits: unknown[] };
type AnswerResponse = {
  markdown: string;
  evidenceBundle: { instructions: string };
  evidence: Array<{ summaryText?: string }>;
  citations: unknown[];
};
type PolicyResponse = { policy: { captureState: string } };
type ClusterResponse = { clusters: Array<Record<string, unknown>> };
type MemoryItemsResponse = { memories: Array<Record<string, unknown>> };
type GraphOverviewResponse = { overview: Record<string, unknown> };
type GraphNodesResponse = { nodes: Array<Record<string, unknown>> };
type GraphNodeResponse = {
  node: Record<string, unknown> & {
    sources: Array<Record<string, unknown>>;
  };
};
type GraphEventsResponse = {
  events: Array<
    Record<string, unknown> & {
      id: string;
      actor: MemoryActor;
      content?: string;
      timestamp: string;
    }
  >;
};
type GraphThreadIndexResponse = {
  projects: Array<{
    id: string;
    name: string;
    path: string | null;
    eventCount: number;
    threads: Array<{
      id: string;
      name: string;
      sessionId: string | null;
      sourceAiClient: "codex" | "codex-cli" | null;
      projectId: string;
      projectName: string;
      projectPath: string | null;
      projectAssignmentSource: "detected" | "user_override" | null;
      capturedProjectProvenance: Record<string, unknown>;
      eventCount: number;
      invalidatedCount: number;
      latestAt: string;
      sample: string;
      threadKind: string;
      parentThreadId: string | null;
      parentSessionId: string | null;
    }>;
  }>;
};
type GraphEventResponse = {
  event: Record<string, unknown> & { rawContent?: string };
};
type MemoryExportResponse = { nodes: Array<Record<string, unknown>> };
type EncryptedMemoryExportResponse = EncryptedJsonPackage;
type SessionResponse = { session: CapturedSessionRecord };
type ExpandedResponse = { expanded: { sources: Array<{ content: string }> } };
type OpenApiResponse = { paths: Record<string, unknown> };
type MemoryQuestionResponse = { question: MemoryQuestionDetailRecord };
type MemoryQuestionsResponse = { questions: MemoryQuestionDetailRecord[] };

const createFakeRepository = () => {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, UserSessionContext>();
  const tokens = new Map<string, ApiTokenRecord & { tokenHash: string }>();
  const deviceChallenges = new Map<
    string,
    DeviceEnrollmentChallengeRecord & { challengeHash: string }
  >();
  const deviceCredentials = new Map<
    string,
    DeviceCredentialRecord & {
      verifierHash?: string | null;
      publicKeyJwk?: Record<string, unknown> | null;
    }
  >();
  const externalAuthIdentities = new Map<string, ExternalAuthIdentityRecord>();
  const externalAuthOrganizations = new Map<
    string,
    ExternalAuthOrganizationRecord
  >();
  const memories: MemoryNodeRecord[] = [];
  const policies: Array<{
    id: string;
    ownerUserId: string;
    targetType: "global" | "project" | "thread";
    projectId: string | null;
    projectName: string | null;
    projectPath: string | null;
    threadId: string | null;
    threadName: string | null;
    captureState: "enabled" | "disabled" | "ask" | null;
    visibility: Visibility | null;
    pauseUntil: string | null;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const capturedSessions = new Map<string, CapturedSessionRecord>();
  const capturedSessionIdsByIdempotencyKey = new Map<string, string>();
  const historicalImportRuns = new Map<string, HistoricalImportRunRecord>();
  const historicalImportSources = new Map<
    string,
    HistoricalImportSourceRecord
  >();
  const conversationSourceArtifacts = new Map<
    string,
    ConversationSourceArtifactRecord
  >();
  const conversationSourceSegments = new Map<
    string,
    ConversationSourceSegmentRecord[]
  >();
  const conversationSourceCursors = new Map<
    string,
    ConversationSourceConsumerCursorRecord
  >();
  let capturedSessionCounter = 0;
  const teams = new Map<string, TeamRecord>();
  const teamCreationReceipts = new Map<
    string,
    { name: string; teamId: string }
  >();
  const teamInvites = new Map<
    string,
    TeamInviteRecord & { tokenHash: string }
  >();
  const teamMemberships = new Map<string, TeamMembershipRecord>();
  const teamBillingSeatStates = new Map<string, TeamBillingSeatStateRecord>();
  const teamWorkspaces = new Map<string, TeamWorkspaceRecord>();
  const teamWorkspaceAccess = new Map<string, TeamWorkspaceAccessRecord>();
  const fakeDeploymentId = randomUUID();
  const auditEvents: AuditEventRecord[] = [];
  const events: MemoryEventRecord[] = [];
  const eventIdempotencyKeys = new Map<string, string>();
  const eventSourceHashes = new Map<string, string>();
  const nodeSources = new Map<string, string[]>();
  const invalidatedNodes = new Set<string>();
  const invalidatedEvents = new Set<string>();
  const summaryCorrections = new Map<string, string>();
  const memoryQuestions = new Map<string, MemoryQuestionDetailRecord>();
  const localMemoryAgentSettings = new Map<
    string,
    LocalMemoryAgentSettingRecord
  >();
  const aiClientInstances = new Map<string, AiClientInstanceRecord>();
  const aiClientCapabilitySnapshots = new Map<
    string,
    AiClientCapabilitySnapshotRecord
  >();
  const pushTeamAudit = (input: {
    actorUserId: string;
    action: string;
    targetTable: string;
    targetId: string;
    metadata: Record<string, unknown>;
  }) => {
    auditEvents.push({
      id: randomUUID(),
      actorUserId: input.actorUserId,
      ownerUserId: input.actorUserId,
      visibility: null,
      action: input.action,
      targetTable: input.targetTable,
      targetId: input.targetId,
      metadata: input.metadata,
      createdAt: new Date().toISOString()
    });
  };
  const teamAllowsAccess = (team: TeamRecord | undefined): boolean =>
    team?.lifecycle === "active" &&
    (team.entitlementStatus === "active" || team.entitlementStatus === "grace");
  const staleVersion = (): never => {
    throw Object.assign(new Error("Stale version"), {
      code: "STALE_VERSION"
    });
  };
  const entitlementGateForTeam = (
    team: TeamRecord
  ): TeamEntitlementGateRecord => ({
    teamId: team.id,
    version: team.version,
    status: team.entitlementStatus,
    allowsTeamAccess: teamAllowsAccess(team),
    deniedOperationFamilies: teamAllowsAccess(team)
      ? []
      : ["ingestion", "recall", "share", "sync", "team_admin"],
    reason: team.entitlementReason,
    updatedAt: team.entitlementUpdatedAt
  });
  const reconcileTeamBillingSeats = (
    teamId: string,
    actorUserId: string | null,
    reason: string,
    initialSync = false
  ): TeamBillingSeatStateRecord => {
    const now = new Date().toISOString();
    const previous = teamBillingSeatStates.get(teamId);
    const billableSeatCount = [...teamMemberships.values()].filter(
      (membership) =>
        membership.teamId === teamId && membership.status === "enabled"
    ).length;
    const seatLimit = previous?.seatLimit ?? null;
    const overLimit = seatLimit !== null && billableSeatCount > seatLimit;
    const syncStatus = overLimit
      ? "over_limit"
      : initialSync && !previous
        ? "synced"
        : "pending_provider_update";
    const state: TeamBillingSeatStateRecord = {
      teamId,
      version: previous ? previous.version + 1 : 1,
      seatLimit,
      billableSeatCount,
      pendingBillingSeatCount: billableSeatCount,
      syncStatus,
      overLimitAt: overLimit ? (previous?.overLimitAt ?? now) : null,
      lastSyncedAt: previous?.lastSyncedAt ?? null,
      lastErrorMessage: null,
      updatedByUserId: actorUserId,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    teamBillingSeatStates.set(teamId, state);

    const team = teams.get(teamId);
    if (team) {
      if (overLimit && team.entitlementStatus === "active") {
        team.entitlementStatus = "grace";
        team.entitlementReason = "seat_limit_exceeded";
        team.entitlementUpdatedAt = now;
        team.version += 1;
        team.updatedAt = now;
      } else if (
        !overLimit &&
        team.entitlementStatus === "grace" &&
        team.entitlementReason === "seat_limit_exceeded"
      ) {
        team.entitlementStatus = "active";
        team.entitlementReason = "seat_limit_restored";
        team.entitlementUpdatedAt = now;
        team.version += 1;
        team.updatedAt = now;
      }
    }

    if (
      !previous ||
      previous.billableSeatCount !== billableSeatCount ||
      previous.pendingBillingSeatCount !== billableSeatCount ||
      previous.syncStatus !== syncStatus ||
      previous.seatLimit !== seatLimit
    ) {
      pushTeamAudit({
        actorUserId: actorUserId ?? "",
        action: "team.billing_seats.changed",
        targetTable: "team_billing_seat_states",
        targetId: teamId,
        metadata: {
          teamId,
          reason,
          previousBillableSeatCount: previous?.billableSeatCount ?? null,
          billableSeatCount,
          pendingBillingSeatCount: billableSeatCount,
          seatLimit,
          syncStatus,
          overLimit
        }
      });
    }

    return state;
  };
  const buildSupportOverview = (
    actor: ActorContext,
    input: {
      teamId: string;
      policy: TeamSupportOverviewRecord["supportAccess"]["policy"];
      actorRole: TeamSupportOverviewRecord["supportAccess"]["actorRole"];
      auditAction: string;
      supportOverviewPath: string;
    }
  ): TeamSupportOverviewRecord | null => {
    const team = teams.get(input.teamId);
    if (!team || team.lifecycle !== "active") {
      return null;
    }
    const now = new Date().toISOString();
    const memberships = [...teamMemberships.values()].filter(
      (item) => item.teamId === input.teamId
    );
    const workspaces = [...teamWorkspaces.values()].filter(
      (item) => item.teamId === input.teamId
    );
    const workspaceAccess = [...teamWorkspaceAccess.values()].filter(
      (item) => item.teamId === input.teamId
    );
    const invites = [...teamInvites.values()].filter(
      (item) => item.teamId === input.teamId
    );
    const teamUserIds = new Set(memberships.map((item) => item.userId));
    const teamExternalAuthOrganizations = [
      ...externalAuthOrganizations.values()
    ].filter((item) => item.teamId === input.teamId);
    const teamExternalAuthIdentities = [
      ...externalAuthIdentities.values()
    ].filter((item) => teamUserIds.has(item.userId));
    const teamDeviceCredentials = [...deviceCredentials.values()].filter(
      (item) => teamUserIds.has(item.ownerUserId)
    );
    const latestTimestamp = (
      values: Array<string | null | undefined>
    ): string | null =>
      values.reduce<string | null>((latest, value) => {
        if (!value) {
          return latest;
        }
        if (!latest || Date.parse(value) > Date.parse(latest)) {
          return value;
        }
        return latest;
      }, null);
    const existingAuditEvents = auditEvents.filter(
      (event) =>
        event.action.startsWith("team.") &&
        event.metadata?.teamId === input.teamId
    );

    pushTeamAudit({
      actorUserId: actor.userId,
      action: input.auditAction,
      targetTable: "teams",
      targetId: input.teamId,
      metadata: {
        teamId: input.teamId,
        policy: input.policy,
        rawContentAccess: "not_permitted"
      }
    });

    return {
      generatedAt: now,
      supportAccess: {
        policy: input.policy,
        actorUserId: actor.userId,
        actorRole: input.actorRole,
        rawContentAccess: "not_permitted",
        breakGlassRequiredForRawContent: true
      },
      team,
      entitlement: entitlementGateForTeam(team),
      billingSeats: teamBillingSeatStates.get(input.teamId) ?? null,
      diagnosticSurfaces: {
        auth: "browser_session",
        rawContentAccess: "not_permitted",
        operationsStatusPath: "/ops/status",
        capabilitiesPath: `/v1/capabilities/authenticated?teamId=${team.id}`,
        auditEventsPath: `/v1/teams/${team.id}/audit-events`,
        entitlementPath: `/v1/teams/${team.id}/entitlement`,
        billingSeatsPath: `/v1/teams/${team.id}/billing-seats`,
        supportOverviewPath: input.supportOverviewPath
      },
      counts: {
        memberships: {
          enabled: memberships.filter((item) => item.status === "enabled")
            .length,
          invited: memberships.filter((item) => item.status === "invited")
            .length,
          disabled: memberships.filter((item) => item.status === "disabled")
            .length
        },
        workspaces: {
          active: workspaces.filter((item) => item.archivedAt === null).length,
          archived: workspaces.filter((item) => item.archivedAt !== null).length
        },
        workspaceAccess: {
          read: workspaceAccess.filter((item) => item.access === "read").length,
          write: workspaceAccess.filter((item) => item.access === "write")
            .length,
          disabled: workspaceAccess.filter((item) => item.access === "disabled")
            .length
        },
        invites: {
          pending: invites.filter(
            (item) =>
              item.acceptedAt === null &&
              item.revokedAt === null &&
              Date.parse(item.expiresAt) > Date.now()
          ).length,
          accepted: invites.filter((item) => item.acceptedAt !== null).length,
          revoked: invites.filter((item) => item.revokedAt !== null).length,
          expired: invites.filter(
            (item) =>
              item.acceptedAt === null &&
              item.revokedAt === null &&
              Date.parse(item.expiresAt) <= Date.now()
          ).length
        },
        sessionShareGrants: {
          active: 0,
          revoked: 0,
          retainedAfterPersonalDeletion: 0
        },
        auditEvents: {
          teamEventCount: existingAuditEvents.length,
          lastTeamEventAt:
            existingAuditEvents[existingAuditEvents.length - 1]?.createdAt ??
            null
        },
        setupAndIntegrations: {
          externalAuthOrganizations: {
            linked: teamExternalAuthOrganizations.filter(
              (item) => item.status === "linked"
            ).length,
            disabled: teamExternalAuthOrganizations.filter(
              (item) => item.status === "disabled"
            ).length,
            lastSeenAt: latestTimestamp(
              teamExternalAuthOrganizations.map((item) => item.lastSeenAt)
            )
          },
          externalAuthIdentities: {
            linked: teamExternalAuthIdentities.filter(
              (item) => item.status === "linked"
            ).length,
            disabled: teamExternalAuthIdentities.filter(
              (item) => item.status === "disabled"
            ).length,
            emailVerified: teamExternalAuthIdentities.filter(
              (item) => item.emailVerified
            ).length,
            lastSeenAt: latestTimestamp(
              teamExternalAuthIdentities.map((item) => item.lastSeenAt)
            )
          },
          deviceCredentials: {
            active: teamDeviceCredentials.filter(
              (item) =>
                item.revokedAt === null &&
                (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
            ).length,
            revoked: teamDeviceCredentials.filter(
              (item) => item.revokedAt !== null
            ).length,
            expired: teamDeviceCredentials.filter(
              (item) =>
                item.revokedAt === null &&
                item.expiresAt !== null &&
                Date.parse(item.expiresAt) <= Date.now()
            ).length,
            lastValidatedAt: latestTimestamp(
              teamDeviceCredentials.map((item) => item.lastValidatedAt)
            )
          }
        }
      }
    };
  };

  const sourceCursorKey = (
    artifactId: string,
    consumerKind: ConversationSourceConsumerCursorRecord["consumerKind"]
  ) => `${artifactId}:${consumerKind}`;

  const currentHistoricalSource = (
    source: HistoricalImportSourceRecord
  ): HistoricalImportSourceRecord => {
    const artifact = conversationSourceArtifacts.get(source.artifactId);
    if (!artifact) return source;
    const cursor = conversationSourceCursors.get(
      sourceCursorKey(source.artifactId, "canonical_historical")
    );
    const historicalCursorOffset =
      cursor?.sourceOffset ?? artifact.journalStartOffset;
    const cursorCurrentTurnId = cursor?.parserState.currentTurnId;
    const cursorHasControlCharacter =
      typeof cursorCurrentTurnId === "string" &&
      [...cursorCurrentTurnId].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      });
    const historicalCursorCurrentTurnId =
      typeof cursorCurrentTurnId === "string" &&
      cursorCurrentTurnId.length > 0 &&
      cursorCurrentTurnId.length <= 512 &&
      !cursorHasControlCharacter
        ? cursorCurrentTurnId
        : undefined;
    const imported = historicalCursorOffset >= artifact.liveStartOffset;
    return {
      ...source,
      sourceKind: artifact.sourceKind,
      sourceAdapterVersion: artifact.sourceAdapterVersion,
      sourceSessionId: artifact.externalSessionId,
      sourceFingerprint: artifact.sourceFingerprint,
      sessionId: artifact.sessionId,
      registrationFrontierOffset: artifact.liveStartOffset,
      redactedSourceLabel: artifact.redactedSourceLabel,
      historicalCursorOffset,
      historicalCursorLine: cursor?.sourceLine ?? artifact.journalStartLine,
      historicalCursorDigest: cursor?.lastVerifiedDigest ?? null,
      historicalCursorParserState: cursor?.parserState ?? {},
      ...(historicalCursorCurrentTurnId
        ? { historicalCursorCurrentTurnId }
        : {}),
      providerCursorOffset: artifact.providerCursorOffset,
      providerCursorLine: artifact.providerCursorLine,
      sourceSizeBytes: artifact.currentSourceLength,
      sourceModifiedAt: artifact.sourceModifiedAt,
      rawIngested: imported,
      projected: imported,
      semanticReady: imported && source.fullyEmbedded
    };
  };

  const repository = {
    health: async () => true,
    getLocalSyncDeployment: async () => null,
    getConversationProjectionBacklog: async () => ({
      liveProjectionRows: 0,
      historicalImportRows: 0,
      historicalImportBytes: 0
    }),
    async countUsers() {
      return users.size;
    },
    async createUser(input: CreateUserInput) {
      const id = randomUUID();
      users.set(id, {
        id,
        email: input.email.toLowerCase(),
        displayName: input.displayName ?? null,
        passwordHash: input.passwordHash ?? null
      });
      return { id };
    },
    async findUserByEmail(email: string) {
      return (
        [...users.values()].find(
          (user) => user.email === email.toLowerCase()
        ) ?? null
      );
    },
    async getUser(userId: string) {
      return users.get(userId) ?? null;
    },
    async getExternalAuthIdentity(input) {
      return (
        externalAuthIdentities.get(
          `${input.provider}:${input.providerEnvironment ?? "default"}:${input.providerUserId}`
        ) ?? null
      );
    },
    async getVerifiedExternalAuthIdentityForUser(userId) {
      return (
        [...externalAuthIdentities.values()].find(
          (identity) =>
            identity.userId === userId &&
            identity.status === "linked" &&
            identity.emailVerified &&
            identity.email === users.get(userId)?.email
        ) ?? null
      );
    },
    async ensureLocalSyncDeployment(input) {
      const protocolDeploymentId =
        input.protocolDeploymentId ?? fakeDeploymentId;
      return {
        id: protocolDeploymentId,
        protocolDeploymentId,
        locality: "local" as const,
        profile: input.profile,
        baseUrl: null,
        upstreamBackendId: null
      };
    },
    async upsertExternalAuthSession(input) {
      const now = new Date().toISOString();
      const providerEnvironment = input.providerEnvironment ?? "default";
      const identityKey = `${input.provider}:${providerEnvironment}:${input.providerUserId}`;
      const existingIdentity = externalAuthIdentities.get(identityKey);
      if (existingIdentity?.status === "disabled") {
        throw Object.assign(new Error("External identity is disabled"), {
          statusCode: 403
        });
      }
      let user = existingIdentity
        ? (users.get(existingIdentity.userId) ?? null)
        : null;
      let createdUser = false;
      if (!user) {
        const existingEmailUser = [...users.values()].find(
          (candidate) => candidate.email === input.email.toLowerCase()
        );
        if (existingEmailUser && !existingIdentity) {
          throw Object.assign(
            new Error(
              "External identity is not linked to the existing Koed account"
            ),
            { statusCode: 409 }
          );
        }
        user = {
          id: randomUUID(),
          email: input.email.toLowerCase(),
          displayName: input.displayName ?? null,
          passwordHash: null
        };
        users.set(user.id, user);
        createdUser = true;
      }
      const identity: ExternalAuthIdentityRecord = {
        id: existingIdentity?.id ?? randomUUID(),
        provider: input.provider,
        providerEnvironment,
        providerUserId: input.providerUserId,
        userId: user.id,
        email: input.email.toLowerCase(),
        emailVerified: input.emailVerified ?? false,
        displayName: input.displayName ?? null,
        status: "linked",
        profile: input.profile ?? {},
        createdAt: existingIdentity?.createdAt ?? now,
        updatedAt: now,
        lastSeenAt: now
      };
      externalAuthIdentities.set(identityKey, identity);

      let organization: ExternalAuthOrganizationRecord | null = null;
      if (input.organization) {
        const organizationKey = `${input.provider}:${providerEnvironment}:${input.organization.providerOrganizationId}`;
        const existing = externalAuthOrganizations.get(organizationKey);
        const teamId = existing?.teamId ?? randomUUID();
        if (!existing) {
          teams.set(teamId, {
            id: teamId,
            name:
              input.organization.name ??
              input.organization.providerOrganizationId,
            version: 1,
            lifecycle: "active",
            entitlementStatus: "active",
            entitlementReason: null,
            entitlementUpdatedAt: null,
            createdAt: now,
            updatedAt: now,
            suspendedAt: null,
            deletionRequestedAt: null,
            tombstonedAt: null,
            retainUntil: null,
            purgeCompletedAt: null
          });
        }
        organization = {
          id: existing?.id ?? randomUUID(),
          provider: input.provider,
          providerEnvironment,
          providerOrganizationId: input.organization.providerOrganizationId,
          teamId,
          name: input.organization.name ?? null,
          status: "linked",
          metadata: input.organization.metadata ?? {},
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          lastSeenAt: now
        };
        externalAuthOrganizations.set(organizationKey, organization);
      }

      auditEvents.push({
        id: randomUUID(),
        actorUserId: user.id,
        ownerUserId: user.id,
        visibility: "personal",
        action: createdUser
          ? "external_auth.user_created"
          : "external_auth.identity_seen",
        targetTable: "external_auth_identities",
        targetId: identity.id,
        metadata: {
          provider: input.provider,
          providerEnvironment,
          providerUserId: input.providerUserId,
          organizationId: organization?.id ?? null
        },
        createdAt: now
      });
      return { user, identity, organization, createdUser };
    },
    async createTeam(actor, input) {
      const receiptKey = input.idempotencyKey
        ? `${actor.userId}:${input.idempotencyKey}`
        : null;
      const receipt = receiptKey ? teamCreationReceipts.get(receiptKey) : null;
      if (receipt) {
        if (receipt.name !== input.name) {
          throw Object.assign(
            new Error("Team creation idempotency key was reused"),
            { code: "IDEMPOTENCY_CONFLICT", statusCode: 409 }
          );
        }
        return teams.get(receipt.teamId)!;
      }
      const now = new Date().toISOString();
      const team: TeamRecord = {
        id: randomUUID(),
        name: input.name,
        version: 1,
        lifecycle: "active",
        entitlementStatus: "active",
        entitlementReason: null,
        entitlementUpdatedAt: null,
        createdAt: now,
        updatedAt: now,
        suspendedAt: null,
        deletionRequestedAt: null,
        tombstonedAt: null,
        retainUntil: null,
        purgeCompletedAt: null
      };
      const membership: TeamMembershipRecord = {
        id: randomUUID(),
        teamId: team.id,
        userId: actor.userId,
        role: "owner",
        status: "enabled",
        version: 1,
        createdAt: now,
        updatedAt: now,
        acceptedAt: now,
        disabledAt: null
      };
      teams.set(team.id, team);
      if (receiptKey) {
        teamCreationReceipts.set(receiptKey, {
          name: input.name,
          teamId: team.id
        });
      }
      teamMemberships.set(`${team.id}:${actor.userId}`, membership);
      const defaultWorkspace: TeamWorkspaceRecord = {
        id: randomUUID(),
        teamId: team.id,
        name: "General",
        description: null,
        version: 1,
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        retentionPolicyId: null,
        retentionPolicyVersion: null,
        retainUntil: null,
        purgeCompletedAt: null
      };
      teamWorkspaces.set(defaultWorkspace.id, defaultWorkspace);
      teamWorkspaceAccess.set(`${defaultWorkspace.id}:${actor.userId}`, {
        teamWorkspaceId: defaultWorkspace.id,
        teamId: team.id,
        userId: actor.userId,
        role: "owner",
        membershipStatus: "enabled",
        access: "write",
        version: 1,
        teamEntitlementStatus: "active",
        teamEntitlementAllowsAccess: true,
        canManageTeam: true,
        canManageWorkspace: true,
        canRecall: true,
        canShareOwnedMemory: true,
        canCreateShare: true
      });
      pushTeamAudit({
        actorUserId: actor.userId,
        action: "team.created",
        targetTable: "teams",
        targetId: team.id,
        metadata: {
          teamId: team.id,
          version: team.version,
          defaultTeamWorkspaceId: defaultWorkspace.id
        }
      });
      pushTeamAudit({
        actorUserId: actor.userId,
        action: "team.workspace.created",
        targetTable: "team_workspaces",
        targetId: defaultWorkspace.id,
        metadata: {
          teamId: team.id,
          teamWorkspaceId: defaultWorkspace.id,
          version: defaultWorkspace.version,
          defaultWorkspace: true
        }
      });
      reconcileTeamBillingSeats(team.id, actor.userId, "team_created", true);
      return team;
    },
    async getTeamDefaultWorkspace(actor, teamId) {
      const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
      if (!membership || membership.status !== "enabled") return null;
      return (
        [...teamWorkspaces.values()].find((workspace) => {
          const access = teamWorkspaceAccess.get(
            `${workspace.id}:${actor.userId}`
          );
          return (
            workspace.teamId === teamId &&
            workspace.name === "General" &&
            workspace.lifecycle === "active" &&
            access !== undefined &&
            access.access !== "disabled"
          );
        }) ?? null
      );
    },
    async listTeams(actor) {
      return [...teams.values()].filter((team) => {
        const membership = teamMemberships.get(`${team.id}:${actor.userId}`);
        return team.lifecycle === "active" && membership?.status === "enabled";
      });
    },
    async getTeamMembership(actor, teamId) {
      const team = teams.get(teamId);
      const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
      return team?.lifecycle === "active" &&
        membership?.status === "enabled" &&
        membership.disabledAt === null
        ? membership
        : null;
    },
    async getTeamEntitlementGate(actor, teamId) {
      const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
      const team = teams.get(teamId);
      if (
        !team ||
        team.lifecycle !== "active" ||
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
      return entitlementGateForTeam(team);
    },
    async setTeamEntitlementState(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      const team = teams.get(input.teamId);
      if (
        !team ||
        !membership ||
        membership.status !== "enabled" ||
        membership.role !== "owner"
      ) {
        return null;
      }
      if (team.version !== input.expectedVersion) {
        staleVersion();
      }
      const previousStatus = team.entitlementStatus;
      team.entitlementStatus = input.status;
      team.entitlementReason = input.reason ?? null;
      team.entitlementUpdatedAt = new Date().toISOString();
      team.version += 1;
      team.updatedAt = team.entitlementUpdatedAt;
      const gate = entitlementGateForTeam(team);
      auditEvents.push({
        id: randomUUID(),
        actorUserId: actor.userId,
        ownerUserId: actor.userId,
        visibility: null,
        action: "team.entitlement.changed",
        targetTable: "teams",
        targetId: team.id,
        metadata: {
          teamId: team.id,
          previousStatus,
          status: gate.status,
          reason: gate.reason,
          deniedOperationFamilies: gate.deniedOperationFamilies
        },
        createdAt: new Date().toISOString()
      });
      return gate;
    },
    async getTeamBillingSeatState(actor, teamId) {
      const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
      return teamBillingSeatStates.get(teamId) ?? null;
    },
    async setTeamBillingSeatPolicy(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        membership.role !== "owner"
      ) {
        return null;
      }
      if (
        input.seatLimit !== null &&
        (!Number.isInteger(input.seatLimit) || input.seatLimit < 0)
      ) {
        throw new Error("seatLimit must be a non-negative integer or null");
      }
      const now = new Date().toISOString();
      const previous = teamBillingSeatStates.get(input.teamId);
      if (!previous || previous.version !== input.expectedVersion) {
        staleVersion();
      }
      teamBillingSeatStates.set(input.teamId, {
        teamId: input.teamId,
        version: previous!.version,
        seatLimit: input.seatLimit,
        billableSeatCount: previous?.billableSeatCount ?? 0,
        pendingBillingSeatCount: previous?.pendingBillingSeatCount ?? 0,
        syncStatus: "pending_provider_update",
        overLimitAt: previous?.overLimitAt ?? null,
        lastSyncedAt: previous?.lastSyncedAt ?? null,
        lastErrorMessage: null,
        updatedByUserId: actor.userId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      });
      return reconcileTeamBillingSeats(
        input.teamId,
        actor.userId,
        "seat_policy_changed"
      );
    },
    async getTeamSupportOverview(actor, teamId) {
      const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
      return buildSupportOverview(actor, {
        teamId,
        policy: "team_manager_redacted",
        actorRole: membership.role as Exclude<
          TeamSupportOverviewRecord["supportAccess"]["actorRole"],
          "member"
        >,
        auditAction: "team.support_overview.viewed",
        supportOverviewPath: `/v1/teams/${teamId}/support/overview`
      });
    },
    async getHostedSupportOverview(actor, teamId) {
      return buildSupportOverview(actor, {
        teamId,
        policy: "hosted_operator_redacted",
        actorRole: "hosted_operator",
        auditAction: "team.hosted_support_overview.viewed",
        supportOverviewPath: `/ops/support/teams/${teamId}/overview`
      });
    },
    async listTeamManagementMembers(actor, teamId) {
      const actorMembership = teamMemberships.get(`${teamId}:${actor.userId}`);
      if (
        !actorMembership ||
        actorMembership.status !== "enabled" ||
        !["owner", "admin"].includes(actorMembership.role) ||
        teams.get(teamId)?.lifecycle !== "active"
      ) {
        return null;
      }
      return [...teamMemberships.values()]
        .filter((membership) => membership.teamId === teamId)
        .map((membership) => ({
          ...membership,
          email: users.get(membership.userId)?.email ?? "",
          displayName: users.get(membership.userId)?.displayName ?? null,
          avatarReference: null,
          presenceMode: "auto" as const,
          manualPresenceStatus: "available" as const,
          presenceVersion: 1,
          lastHumanActivityAt: null,
          workspaceAccess: [...teamWorkspaceAccess.values()]
            .filter(
              (access) =>
                access.teamId === teamId && access.userId === membership.userId
            )
            .map((access) => ({
              teamWorkspaceId: access.teamWorkspaceId,
              userId: access.userId,
              access: access.access,
              version: access.version ?? 1
            }))
        }));
    },
    async createTeamWorkspace(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role) ||
        !teamAllowsAccess(teams.get(input.teamId))
      ) {
        return null;
      }
      const now = new Date().toISOString();
      const workspace: TeamWorkspaceRecord = {
        id: randomUUID(),
        teamId: input.teamId,
        name: input.name,
        description: input.description ?? null,
        version: 1,
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        retentionPolicyId: null,
        retentionPolicyVersion: null,
        retainUntil: null,
        purgeCompletedAt: null
      };
      teamWorkspaces.set(workspace.id, workspace);
      teamWorkspaceAccess.set(`${workspace.id}:${actor.userId}`, {
        teamWorkspaceId: workspace.id,
        teamId: workspace.teamId,
        userId: actor.userId,
        role: membership.role,
        membershipStatus: membership.status,
        access: "write",
        version: 1,
        teamEntitlementStatus: "active",
        teamEntitlementAllowsAccess: true,
        canManageTeam: true,
        canManageWorkspace: true,
        canRecall: true,
        canShareOwnedMemory: true,
        canCreateShare: true
      });
      pushTeamAudit({
        actorUserId: actor.userId,
        action: "team.workspace.created",
        targetTable: "team_workspaces",
        targetId: workspace.id,
        metadata: {
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id
        }
      });
      return workspace;
    },
    async listTeamWorkspaces(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      if (!membership || membership.status !== "enabled") return null;
      return [...teamWorkspaces.values()]
        .filter((workspace) => {
          const access = teamWorkspaceAccess.get(
            `${workspace.id}:${actor.userId}`
          );
          return (
            workspace.teamId === input.teamId &&
            (input.includeArchived || workspace.lifecycle === "active") &&
            access !== undefined &&
            access.access !== "disabled"
          );
        })
        .slice(0, input.limit ?? 100);
    },
    async listTeamRoster(actor, teamId) {
      const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
      if (!membership || membership.status !== "enabled") return null;
      return [...teamMemberships.values()]
        .filter(
          (candidate) =>
            candidate.teamId === teamId && candidate.status === "enabled"
        )
        .map((candidate) => ({
          userId: candidate.userId,
          displayName: users.get(candidate.userId)?.displayName ?? null,
          avatarReference: null,
          status: "enabled" as const,
          presenceMode: "auto" as const,
          manualPresenceStatus: "available" as const,
          presenceVersion: 1,
          lastHumanActivityAt: null
        }));
    },
    async createTeamInvite(actor, input) {
      const actorMembership = teamMemberships.get(
        `${input.teamId}:${actor.userId}`
      );
      if (
        !actorMembership ||
        actorMembership.status !== "enabled" ||
        !["owner", "admin"].includes(actorMembership.role) ||
        !teamAllowsAccess(teams.get(input.teamId))
      ) {
        return null;
      }
      if (input.role === "owner" && actorMembership.role !== "owner") {
        return null;
      }
      const defaultWorkspace = teamWorkspaces.get(input.defaultTeamWorkspaceId);
      if (
        defaultWorkspace?.teamId !== input.teamId ||
        defaultWorkspace.lifecycle !== "active"
      ) {
        return null;
      }
      const now = new Date().toISOString();
      const invite: TeamInviteRecord & { tokenHash: string } = {
        id: randomUUID(),
        teamId: input.teamId,
        defaultTeamWorkspaceId: input.defaultTeamWorkspaceId,
        defaultWorkspaceAccess: input.defaultWorkspaceAccess,
        email: input.email.toLowerCase(),
        normalizedEmail: input.email.toLowerCase(),
        backendOriginHash: input.backendOriginHash,
        role: input.role,
        version: 1,
        lifecycle: "pending",
        createdByUserId: actor.userId,
        acceptedByUserId: null,
        createdAt: now,
        expiresAt: input.expiresAt.toISOString(),
        acceptedAt: null,
        revokedAt: null,
        tokenHash: input.tokenHash
      };
      teamInvites.set(input.tokenHash, invite);
      pushTeamAudit({
        actorUserId: actor.userId,
        action: "team.invite.created",
        targetTable: "team_invites",
        targetId: invite.id,
        metadata: {
          teamId: input.teamId,
          email: invite.email,
          role: input.role,
          existingUser: false
        }
      });

      const invitedUser = [...users.values()].find(
        (user) => user.email === invite.email
      );
      if (invitedUser) {
        const existingMembership = teamMemberships.get(
          `${input.teamId}:${invitedUser.id}`
        );
        if (existingMembership?.status !== "enabled") {
          teamMemberships.set(`${input.teamId}:${invitedUser.id}`, {
            id: existingMembership?.id ?? randomUUID(),
            teamId: input.teamId,
            userId: invitedUser.id,
            role: input.role,
            status: "invited",
            version: (existingMembership?.version ?? 0) + 1,
            createdAt: existingMembership?.createdAt ?? now,
            updatedAt: now,
            acceptedAt: null,
            disabledAt: null
          });
        }
      }

      return invite;
    },
    async getPendingTeamInviteByTokenHash(tokenHash) {
      const invite = teamInvites.get(tokenHash);
      if (
        !invite ||
        invite.lifecycle !== "pending" ||
        invite.acceptedAt ||
        invite.revokedAt ||
        new Date(invite.expiresAt).getTime() <= Date.now()
      ) {
        return null;
      }
      if (!teamAllowsAccess(teams.get(invite.teamId))) {
        return null;
      }
      return invite;
    },
    async acceptTeamInvite(input) {
      const invite = teamInvites.get(input.tokenHash);
      if (
        !invite ||
        invite.lifecycle !== "pending" ||
        invite.acceptedAt ||
        invite.revokedAt ||
        new Date(invite.expiresAt).getTime() <= Date.now() ||
        invite.version !== input.expectedVersion ||
        invite.backendOriginHash !== input.expectedBackendOriginHash
      ) {
        return null;
      }

      const invitedEmail = invite.email.toLowerCase();
      const user = users.get(input.userId) ?? null;
      const createdUser = false;

      if (!user || user.email.toLowerCase() !== invitedEmail) {
        return null;
      }

      const now = new Date().toISOString();
      invite.acceptedAt = now;
      invite.acceptedByUserId = user.id;
      invite.lifecycle = "accepted";
      invite.version += 1;
      const existingMembership = teamMemberships.get(
        `${invite.teamId}:${user.id}`
      );
      const membership: TeamMembershipRecord = {
        id: existingMembership?.id ?? randomUUID(),
        teamId: invite.teamId,
        userId: user.id,
        role: invite.role,
        status: "enabled",
        version: (existingMembership?.version ?? 0) + 1,
        createdAt: existingMembership?.createdAt ?? now,
        updatedAt: now,
        acceptedAt: now,
        disabledAt: null
      };
      teamMemberships.set(`${invite.teamId}:${user.id}`, membership);
      teamWorkspaceAccess.set(`${invite.defaultTeamWorkspaceId}:${user.id}`, {
        teamWorkspaceId: invite.defaultTeamWorkspaceId,
        teamId: invite.teamId,
        userId: user.id,
        role: membership.role,
        membershipStatus: "enabled",
        access: invite.defaultWorkspaceAccess,
        version: 1,
        teamEntitlementStatus:
          teams.get(invite.teamId)?.entitlementStatus ?? "revoked",
        teamEntitlementAllowsAccess: teamAllowsAccess(teams.get(invite.teamId)),
        canManageTeam:
          membership.role === "owner" || membership.role === "admin",
        canManageWorkspace:
          (membership.role === "owner" || membership.role === "admin") &&
          invite.defaultWorkspaceAccess === "write",
        canShareOwnedMemory: invite.defaultWorkspaceAccess === "write",
        canRecall: true,
        canCreateShare: invite.defaultWorkspaceAccess === "write"
      });
      pushTeamAudit({
        actorUserId: user.id,
        action: "team.invite.accepted",
        targetTable: "team_invites",
        targetId: invite.id,
        metadata: {
          teamId: invite.teamId,
          email: invite.email,
          role: invite.role,
          userId: user.id,
          createdUser
        }
      });
      pushTeamAudit({
        actorUserId: user.id,
        action: "team.member.enabled",
        targetTable: "team_memberships",
        targetId: membership.id,
        metadata: {
          teamId: invite.teamId,
          userId: user.id,
          role: membership.role,
          status: membership.status,
          source: "invite_acceptance"
        }
      });
      reconcileTeamBillingSeats(invite.teamId, user.id, "team.invite.accepted");

      const result: AcceptedTeamInviteRecord = {
        invite,
        membership,
        user,
        createdUser
      };
      return result;
    },
    async listTeamInvites(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role) ||
        teams.get(input.teamId)?.lifecycle !== "active"
      ) {
        return null;
      }
      const invites = [...teamInvites.values()]
        .filter(
          (invite) =>
            invite.teamId === input.teamId &&
            (input.includeRevoked || invite.lifecycle !== "revoked")
        )
        .slice(0, input.limit ?? 100);
      return { invites, nextCursor: null };
    },
    async revokeTeamInvite(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      const invite = [...teamInvites.values()].find(
        (candidate) =>
          candidate.id === input.inviteId && candidate.teamId === input.teamId
      );
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role) ||
        !invite ||
        invite.lifecycle !== "pending"
      ) {
        return null;
      }
      if (invite.version !== input.expectedVersion) {
        staleVersion();
      }
      invite.lifecycle = "revoked";
      invite.version += 1;
      invite.revokedAt = new Date().toISOString();
      return invite;
    },
    async updateTeamMemberRole(actor, input) {
      const actorMembership = teamMemberships.get(
        `${input.teamId}:${actor.userId}`
      );
      const targetMembership = teamMemberships.get(
        `${input.teamId}:${input.userId}`
      );
      if (
        !actorMembership ||
        actorMembership.status !== "enabled" ||
        !["owner", "admin"].includes(actorMembership.role) ||
        !targetMembership ||
        targetMembership.status !== "enabled" ||
        !teamAllowsAccess(teams.get(input.teamId))
      ) {
        return null;
      }
      if (targetMembership.version !== input.expectedVersion) {
        staleVersion();
      }
      if (
        actorMembership.role !== "owner" &&
        (targetMembership.role === "owner" || input.role === "owner")
      ) {
        return null;
      }
      if (
        targetMembership.role === "owner" &&
        input.role !== "owner" &&
        [...teamMemberships.values()].filter(
          (candidate) =>
            candidate.teamId === input.teamId &&
            candidate.role === "owner" &&
            candidate.status === "enabled"
        ).length <= 1
      ) {
        return null;
      }
      targetMembership.role = input.role;
      targetMembership.version += 1;
      targetMembership.updatedAt = new Date().toISOString();
      return targetMembership;
    },
    async leaveTeam(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        teams.get(input.teamId)?.lifecycle !== "active"
      ) {
        return null;
      }
      if (membership.version !== input.expectedVersion) {
        staleVersion();
      }
      if (
        membership.role === "owner" &&
        [...teamMemberships.values()].filter(
          (candidate) =>
            candidate.teamId === input.teamId &&
            candidate.role === "owner" &&
            candidate.status === "enabled"
        ).length <= 1
      ) {
        return null;
      }
      membership.status = "disabled";
      membership.version += 1;
      membership.updatedAt = new Date().toISOString();
      membership.disabledAt = membership.updatedAt;
      reconcileTeamBillingSeats(input.teamId, actor.userId, "team.member.left");
      return membership;
    },
    async disableTeamMember(actor, input) {
      const actorMembership = teamMemberships.get(
        `${input.teamId}:${actor.userId}`
      );
      if (
        !actorMembership ||
        actorMembership.status !== "enabled" ||
        !["owner", "admin"].includes(actorMembership.role) ||
        !teamAllowsAccess(teams.get(input.teamId)) ||
        input.userId === actor.userId
      ) {
        return null;
      }
      const targetMembership = teamMemberships.get(
        `${input.teamId}:${input.userId}`
      );
      if (!targetMembership) {
        return null;
      }
      if (targetMembership.version !== input.expectedVersion) {
        staleVersion();
      }
      if (
        targetMembership.role === "owner" &&
        actorMembership.role !== "owner"
      ) {
        return null;
      }
      const disabledMembership: TeamMembershipRecord = {
        ...targetMembership,
        status: "disabled",
        version: targetMembership.version + 1,
        updatedAt: new Date().toISOString(),
        disabledAt: new Date().toISOString()
      };
      teamMemberships.set(
        `${input.teamId}:${input.userId}`,
        disabledMembership
      );
      pushTeamAudit({
        actorUserId: actor.userId,
        action: "team.member.disabled",
        targetTable: "team_memberships",
        targetId: disabledMembership.id,
        metadata: {
          teamId: input.teamId,
          userId: input.userId,
          role: disabledMembership.role,
          status: disabledMembership.status
        }
      });
      reconcileTeamBillingSeats(
        input.teamId,
        actor.userId,
        "team.member.disabled"
      );
      return disabledMembership;
    },
    async setTeamWorkspaceAccess(actor, input) {
      const actorAccess = teamWorkspaceAccess.get(
        `${input.teamWorkspaceId}:${actor.userId}`
      );
      const workspace = teamWorkspaces.get(input.teamWorkspaceId);
      const team = workspace ? teams.get(workspace.teamId) : undefined;
      if (
        !workspace ||
        !actorAccess?.canManageWorkspace ||
        !teamAllowsAccess(team)
      ) {
        return null;
      }
      const membership = teamMemberships.get(
        `${workspace.teamId}:${input.userId}`
      );
      if (!membership) {
        return null;
      }
      const existingAccess = teamWorkspaceAccess.get(
        `${workspace.id}:${input.userId}`
      );
      if (
        (existingAccess && existingAccess.version !== input.expectedVersion) ||
        (!existingAccess && input.expectedVersion !== null)
      ) {
        staleVersion();
      }
      const previousAccess = existingAccess?.access ?? "disabled";
      const access: TeamWorkspaceAccessRecord = {
        teamWorkspaceId: workspace.id,
        teamId: workspace.teamId,
        userId: input.userId,
        role: membership.role,
        membershipStatus: membership.status,
        access: input.access,
        version: (existingAccess?.version ?? 0) + 1,
        teamEntitlementStatus: team?.entitlementStatus ?? "active",
        teamEntitlementAllowsAccess: teamAllowsAccess(team),
        canManageTeam:
          membership.status === "enabled" &&
          teamAllowsAccess(team) &&
          ["owner", "admin"].includes(membership.role),
        canManageWorkspace:
          membership.status === "enabled" &&
          teamAllowsAccess(team) &&
          input.access === "write" &&
          ["owner", "admin"].includes(membership.role),
        canRecall:
          membership.status === "enabled" &&
          teamAllowsAccess(team) &&
          (input.access === "read" || input.access === "write"),
        canShareOwnedMemory:
          membership.status === "enabled" &&
          teamAllowsAccess(team) &&
          input.access === "write",
        canCreateShare:
          membership.status === "enabled" &&
          teamAllowsAccess(team) &&
          input.access === "write"
      };
      teamWorkspaceAccess.set(`${workspace.id}:${input.userId}`, access);
      pushTeamAudit({
        actorUserId: actor.userId,
        action:
          input.access === "disabled"
            ? "team.workspace_access.removed"
            : previousAccess === "disabled"
              ? "team.workspace_access.created"
              : "team.workspace_access.updated",
        targetTable: "team_workspace_access_grants",
        targetId: workspace.id,
        metadata: {
          teamId: workspace.teamId,
          teamWorkspaceId: workspace.id,
          userId: input.userId,
          access: input.access,
          previousAccess
        }
      });
      return access;
    },
    async archiveTeamWorkspace(actor, input) {
      const workspace = teamWorkspaces.get(input.teamWorkspaceId);
      const membership = workspace
        ? teamMemberships.get(`${workspace.teamId}:${actor.userId}`)
        : null;
      if (
        !workspace ||
        workspace.lifecycle !== "active" ||
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
      if (workspace.version !== input.expectedVersion) {
        staleVersion();
      }
      workspace.lifecycle = "archived";
      workspace.version += 1;
      workspace.archivedAt = new Date().toISOString();
      workspace.updatedAt = workspace.archivedAt;
      return workspace;
    },
    async restoreTeamWorkspace(actor, input) {
      const workspace = teamWorkspaces.get(input.teamWorkspaceId);
      const membership = workspace
        ? teamMemberships.get(`${workspace.teamId}:${actor.userId}`)
        : null;
      if (
        !workspace ||
        workspace.lifecycle !== "archived" ||
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
      if (workspace.version !== input.expectedVersion) {
        staleVersion();
      }
      workspace.lifecycle = "active";
      workspace.version += 1;
      workspace.archivedAt = null;
      workspace.updatedAt = new Date().toISOString();
      return workspace;
    },
    async getTeamWorkspaceAccess(actor, teamWorkspaceId) {
      const access = teamWorkspaceAccess.get(
        `${teamWorkspaceId}:${actor.userId}`
      );
      const workspace = teamWorkspaces.get(teamWorkspaceId);
      const team = workspace ? teams.get(workspace.teamId) : undefined;
      const entitlementAllowsAccess = teamAllowsAccess(team);
      return access
        ? {
            ...access,
            teamEntitlementStatus: team?.entitlementStatus ?? "active",
            teamEntitlementAllowsAccess: entitlementAllowsAccess,
            canManageTeam: access.canManageTeam && entitlementAllowsAccess,
            canManageWorkspace:
              access.canManageWorkspace && entitlementAllowsAccess,
            canRecall: access.canRecall && entitlementAllowsAccess,
            canCreateShare: access.canCreateShare && entitlementAllowsAccess
          }
        : null;
    },
    async listTeamWorkspaceContexts(actor) {
      return [...teamWorkspaceAccess.values()]
        .filter((access) => access.userId === actor.userId && access.canRecall)
        .flatMap((access) => {
          const workspace = teamWorkspaces.get(access.teamWorkspaceId);
          const team = workspace ? teams.get(workspace.teamId) : null;
          const membership = workspace
            ? teamMemberships.get(`${workspace.teamId}:${actor.userId}`)
            : null;
          if (
            !workspace ||
            !team ||
            !membership ||
            access.access === "disabled" ||
            !teamAllowsAccess(team)
          ) {
            return [];
          }
          return [
            {
              teamId: team.id,
              teamName: team.name,
              teamRole: membership.role,
              teamWorkspaceId: workspace.id,
              teamWorkspaceName: workspace.name,
              access: access.access
            }
          ];
        })
        .sort(
          (left, right) =>
            left.teamName.localeCompare(right.teamName) ||
            left.teamWorkspaceName.localeCompare(right.teamWorkspaceName)
        );
    },
    async listTeamAuditEvents(actor, input) {
      const membership = teamMemberships.get(`${input.teamId}:${actor.userId}`);
      if (
        !membership ||
        membership.status !== "enabled" ||
        !["owner", "admin"].includes(membership.role)
      ) {
        return null;
      }
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      return auditEvents
        .filter(
          (event) =>
            event.action.startsWith("team.") &&
            event.metadata.teamId === input.teamId &&
            (!input.action || event.action === input.action)
        )
        .slice(-limit)
        .reverse();
    },
    async createSession(userId: string, sessionHash: string, expiresAt: Date) {
      const user = users.get(userId);
      if (!user) {
        throw new Error("Session user not found");
      }
      sessions.set(sessionHash, {
        sessionId: sessionHash,
        createdAt: new Date(),
        expiresAt,
        user
      });
    },
    async getSessionUser(sessionHash: string) {
      const session = sessions.get(sessionHash);
      return session && session.expiresAt.getTime() > Date.now()
        ? session.user
        : null;
    },
    async getSessionContext(sessionHash: string) {
      const session = sessions.get(sessionHash);
      return session && session.expiresAt.getTime() > Date.now()
        ? session
        : null;
    },
    async revokeSession(sessionHash: string) {
      sessions.delete(sessionHash);
    },
    async createApiToken(input) {
      const id = randomUUID();
      const record = {
        id,
        ownerUserId: input.ownerUserId,
        name: input.name,
        tokenPrefix: input.tokenPrefix,
        scopes: input.scopes ?? [],
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        tokenHash: input.tokenHash
      };
      tokens.set(input.tokenHash, record);
      if (input.audit) {
        auditEvents.push({
          id: randomUUID(),
          actorUserId: input.audit.actorUserId ?? null,
          ownerUserId: input.ownerUserId,
          visibility: "personal",
          action: "api_token.created",
          targetTable: "api_tokens",
          targetId: record.id,
          metadata: {
            actorType: input.audit.actorType,
            name: record.name,
            tokenPrefix: record.tokenPrefix,
            scopes: record.scopes
          },
          createdAt: new Date().toISOString()
        });
      }
      return record;
    },
    async listApiTokens(userId: string) {
      return [...tokens.values()].filter(
        (token) => token.ownerUserId === userId && !token.revokedAt
      );
    },
    async revokeApiToken(userId: string, tokenId: string, audit) {
      const token = [...tokens.values()].find(
        (candidate) =>
          candidate.id === tokenId && candidate.ownerUserId === userId
      );
      if (!token || token.revokedAt) {
        return false;
      }
      token.revokedAt = new Date().toISOString();
      if (audit) {
        auditEvents.push({
          id: randomUUID(),
          actorUserId: audit.actorUserId ?? null,
          ownerUserId: userId,
          visibility: "personal",
          action: "api_token.revoked",
          targetTable: "api_tokens",
          targetId: tokenId,
          metadata: { actorType: audit.actorType },
          createdAt: new Date().toISOString()
        });
      }
      return true;
    },
    async getApiTokenUser(tokenHash: string) {
      const token = tokens.get(tokenHash);
      return token ? (users.get(token.ownerUserId) ?? null) : null;
    },
    async createDeviceEnrollmentChallenge(input) {
      const record = {
        id: randomUUID(),
        challengeHash: input.challengeHash,
        upstreamBackendId: input.upstreamBackendId,
        deviceInstanceId: input.deviceInstanceId ?? null,
        rotationLineageId: input.rotationLineageId ?? null,
        rotationOwnerUserId: input.rotationOwnerUserId ?? null,
        rotationCredentialId: input.rotationCredentialId ?? null,
        deviceLabel: input.deviceLabel ?? null,
        requestedOperationFamilies: input.requestedOperationFamilies ?? [],
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString(),
        expiresAt: input.expiresAt.toISOString(),
        boundByUserId: null,
        boundAt: null,
        redeemedAt: null
      };
      deviceChallenges.set(input.challengeHash, record);
      return record;
    },
    async getDeviceEnrollmentChallenge(challengeId: string) {
      return (
        [...deviceChallenges.values()].find(
          (challenge) => challenge.id === challengeId
        ) ?? null
      );
    },
    async redeemDeviceEnrollmentChallenge(actor, input) {
      const challenge = deviceChallenges.get(input.challengeHash);
      if (
        !challenge ||
        challenge.redeemedAt ||
        Date.parse(challenge.expiresAt) <= Date.now() ||
        (challenge.rotationOwnerUserId !== null &&
          challenge.rotationOwnerUserId !== actor.userId)
      ) {
        return null;
      }
      const operationFamilies = Array.from(
        new Set(input.operationFamilies ?? challenge.requestedOperationFamilies)
      );
      const allowedFamilies = new Set(challenge.requestedOperationFamilies);
      if (operationFamilies.some((family) => !allowedFamilies.has(family))) {
        throw Object.assign(
          new Error(
            "Device credential operation families exceed enrollment challenge"
          ),
          { statusCode: 400 }
        );
      }
      const now = new Date().toISOString();
      challenge.boundByUserId = actor.userId;
      challenge.boundAt = now;
      challenge.redeemedAt = now;
      const lineageId = challenge.rotationLineageId ?? randomUUID();
      if (challenge.rotationLineageId) {
        const activePredecessors = [...deviceCredentials.values()].filter(
          (existing) =>
            existing.ownerUserId === actor.userId &&
            existing.upstreamBackendId === challenge.upstreamBackendId &&
            existing.deviceInstanceId === challenge.deviceInstanceId &&
            existing.lineageId === challenge.rotationLineageId &&
            existing.id === challenge.rotationCredentialId &&
            !existing.revokedAt
        );
        if (activePredecessors.length !== 1) {
          throw Object.assign(
            new Error(
              "Active device credential requires authenticated rotation"
            ),
            { statusCode: 409 }
          );
        }
        for (const existing of deviceCredentials.values()) {
          if (
            existing.ownerUserId === actor.userId &&
            existing.lineageId === challenge.rotationLineageId &&
            !existing.revokedAt
          ) {
            existing.revokedAt = now;
            existing.revokedByUserId = actor.userId;
            existing.revocationReason = "rotated";
          }
        }
      }
      const credential = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        enrollmentChallengeId: challenge.id,
        credentialKeyId: input.credentialKeyId,
        upstreamBackendId: challenge.upstreamBackendId,
        deviceInstanceId:
          challenge.deviceInstanceId ?? `device-${challenge.id}`,
        lineageId,
        deviceLabel: challenge.deviceLabel,
        credentialVersion: 1,
        verifierKind: input.verifierKind,
        verifierHash: input.verifierHash ?? null,
        publicKeyJwk: input.publicKeyJwk ?? null,
        operationFamilies,
        metadata: input.metadata ?? challenge.metadata,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        lastValidatedAt: null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        revokedAt: null,
        revokedByUserId: null,
        revocationReason: null
      } satisfies DeviceCredentialRecord & {
        verifierHash?: string | null;
        publicKeyJwk?: Record<string, unknown> | null;
      };
      deviceCredentials.set(credential.id, credential);
      auditEvents.push({
        id: randomUUID(),
        actorUserId: actor.userId,
        ownerUserId: actor.userId,
        visibility: "personal",
        action: "device_credential.created",
        targetTable: "device_credentials",
        targetId: credential.id,
        metadata: {
          credentialKeyId: credential.credentialKeyId,
          upstreamBackendId: credential.upstreamBackendId,
          deviceInstanceId: credential.deviceInstanceId,
          operationFamilies: credential.operationFamilies
        },
        createdAt: now
      });
      return credential;
    },
    async approveDeviceEnrollmentChallenge(actor, challengeId, input) {
      const challenge = [...deviceChallenges.values()].find(
        (candidate) => candidate.id === challengeId
      );
      if (
        !challenge ||
        challenge.redeemedAt ||
        Date.parse(challenge.expiresAt) <= Date.now() ||
        (challenge.rotationOwnerUserId !== null &&
          challenge.rotationOwnerUserId !== actor.userId)
      ) {
        return null;
      }
      const operationFamilies = Array.from(
        new Set(input.operationFamilies ?? challenge.requestedOperationFamilies)
      );
      const allowedFamilies = new Set(challenge.requestedOperationFamilies);
      if (operationFamilies.some((family) => !allowedFamilies.has(family))) {
        throw Object.assign(
          new Error(
            "Device credential operation families exceed enrollment challenge"
          ),
          { statusCode: 400 }
        );
      }
      const now = new Date().toISOString();
      challenge.boundByUserId = actor.userId;
      challenge.boundAt = now;
      challenge.redeemedAt = now;
      const lineageId = challenge.rotationLineageId ?? randomUUID();
      if (challenge.rotationLineageId) {
        const activePredecessors = [...deviceCredentials.values()].filter(
          (existing) =>
            existing.ownerUserId === actor.userId &&
            existing.upstreamBackendId === challenge.upstreamBackendId &&
            existing.deviceInstanceId === challenge.deviceInstanceId &&
            existing.lineageId === challenge.rotationLineageId &&
            existing.id === challenge.rotationCredentialId &&
            !existing.revokedAt
        );
        if (activePredecessors.length !== 1) {
          throw Object.assign(
            new Error(
              "Active device credential requires authenticated rotation"
            ),
            { statusCode: 409 }
          );
        }
        for (const existing of deviceCredentials.values()) {
          if (
            existing.ownerUserId === actor.userId &&
            existing.lineageId === challenge.rotationLineageId &&
            !existing.revokedAt
          ) {
            existing.revokedAt = now;
            existing.revokedByUserId = actor.userId;
            existing.revocationReason = "rotated";
          }
        }
      }
      const credential = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        enrollmentChallengeId: challenge.id,
        credentialKeyId: input.credentialKeyId,
        upstreamBackendId: challenge.upstreamBackendId,
        deviceInstanceId:
          challenge.deviceInstanceId ?? `device-${challenge.id}`,
        lineageId,
        deviceLabel: challenge.deviceLabel,
        credentialVersion: 1,
        verifierKind: input.verifierKind,
        verifierHash: input.verifierHash ?? null,
        publicKeyJwk: input.publicKeyJwk ?? null,
        operationFamilies,
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        lastValidatedAt: null,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        revokedAt: null,
        revokedByUserId: null,
        revocationReason: null
      } satisfies DeviceCredentialRecord & {
        verifierHash?: string | null;
        publicKeyJwk?: Record<string, unknown> | null;
      };
      deviceCredentials.set(credential.id, credential);
      return credential;
    },
    async denyDeviceEnrollmentChallenge(actor, challengeId) {
      const challenge = [...deviceChallenges.values()].find(
        (candidate) => candidate.id === challengeId
      );
      if (
        !challenge ||
        challenge.redeemedAt ||
        Date.parse(challenge.expiresAt) <= Date.now() ||
        (challenge.rotationOwnerUserId !== null &&
          challenge.rotationOwnerUserId !== actor.userId)
      ) {
        return null;
      }
      const now = new Date().toISOString();
      challenge.boundByUserId = actor.userId;
      challenge.boundAt = now;
      challenge.redeemedAt = now;
      challenge.metadata = {
        ...challenge.metadata,
        enrollmentDecision: "denied"
      };
      return challenge;
    },
    async listDeviceCredentials(actor, input) {
      return [...deviceCredentials.values()].filter(
        (credential) =>
          credential.ownerUserId === actor.userId &&
          !credential.revokedAt &&
          (!input?.upstreamBackendId ||
            credential.upstreamBackendId === input.upstreamBackendId)
      );
    },
    async revokeDeviceCredential(actor, credentialId, reason) {
      const credential = deviceCredentials.get(credentialId);
      if (
        !credential ||
        credential.ownerUserId !== actor.userId ||
        credential.revokedAt
      ) {
        return false;
      }
      credential.revokedAt = new Date().toISOString();
      credential.revokedByUserId = actor.userId;
      credential.revocationReason = reason ?? null;
      auditEvents.push({
        id: randomUUID(),
        actorUserId: actor.userId,
        ownerUserId: actor.userId,
        visibility: "personal",
        action: "device_credential.revoked",
        targetTable: "device_credentials",
        targetId: credential.id,
        metadata: {
          credentialKeyId: credential.credentialKeyId,
          upstreamBackendId: credential.upstreamBackendId,
          deviceInstanceId: credential.deviceInstanceId,
          reason: reason ?? null
        },
        createdAt: new Date().toISOString()
      });
      return true;
    },
    async getDeviceCredentialUser(input) {
      const credential = [...deviceCredentials.values()].find(
        (candidate) =>
          candidate.credentialKeyId === input.credentialKeyId &&
          candidate.verifierHash === input.verifierHash &&
          candidate.verifierKind === "secret_hash" &&
          !candidate.revokedAt &&
          (!candidate.expiresAt || Date.parse(candidate.expiresAt) > Date.now())
      );
      if (!credential) {
        return null;
      }
      const user = users.get(credential.ownerUserId);
      if (!user) {
        return null;
      }
      const now = new Date().toISOString();
      credential.lastUsedAt = now;
      credential.lastValidatedAt = now;
      credential.updatedAt = now;
      return { user, credential };
    },
    async recordAuditEvent(input) {
      const record: AuditEventRecord = {
        id: randomUUID(),
        actorUserId: input.actorUserId ?? null,
        ownerUserId: input.ownerUserId ?? null,
        visibility: input.visibility ?? null,
        action: input.action,
        targetTable: input.targetTable ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
        createdAt: new Date().toISOString()
      };
      auditEvents.push(record);
      return record;
    },
    async listAuditEvents(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      return auditEvents
        .filter(
          (event) =>
            event.ownerUserId === actor.userId &&
            (!input.action || event.action === input.action)
        )
        .slice(0, limit);
    },
    async getActivationAnalyticsFunnel(actor, input = {}) {
      let teamId = input.teamId ?? null;
      const teamWorkspaceId = input.teamWorkspaceId ?? null;
      if (teamWorkspaceId) {
        const workspace = teamWorkspaces.get(teamWorkspaceId);
        if (!workspace || (teamId && teamId !== workspace.teamId)) {
          return null;
        }
        teamId = workspace.teamId;
      }
      if (teamId) {
        const membership = teamMemberships.get(`${teamId}:${actor.userId}`);
        if (
          !membership ||
          membership.status !== "enabled" ||
          !["owner", "admin"].includes(membership.role)
        ) {
          return null;
        }
      }
      const events = auditEvents.filter((event) => {
        if (!event.action.startsWith("analytics.activation.")) {
          return false;
        }
        if (teamId) {
          if (event.metadata.teamId !== teamId) {
            return false;
          }
        } else if (event.ownerUserId !== actor.userId) {
          return false;
        }
        if (
          teamWorkspaceId &&
          event.metadata.teamWorkspaceId !== teamWorkspaceId
        ) {
          return false;
        }
        if (
          input.since &&
          Date.parse(event.createdAt) < input.since.getTime()
        ) {
          return false;
        }
        if (
          input.until &&
          Date.parse(event.createdAt) > input.until.getTime()
        ) {
          return false;
        }
        return true;
      });
      const byEvent = new Map<
        string,
        ActivationAnalyticsFunnelRecord["events"][number]
      >();
      for (const auditEvent of events) {
        const event =
          typeof auditEvent.metadata.event === "string"
            ? auditEvent.metadata.event
            : auditEvent.action.replace("analytics.activation.", "");
        const summary =
          byEvent.get(event) ??
          ({
            event,
            count: 0,
            firstSeenAt: null,
            lastSeenAt: null,
            surfaces: {},
            deploymentProfiles: {}
          } satisfies ActivationAnalyticsFunnelRecord["events"][number]);
        summary.count += 1;
        if (
          !summary.firstSeenAt ||
          Date.parse(auditEvent.createdAt) < Date.parse(summary.firstSeenAt)
        ) {
          summary.firstSeenAt = auditEvent.createdAt;
        }
        if (
          !summary.lastSeenAt ||
          Date.parse(auditEvent.createdAt) > Date.parse(summary.lastSeenAt)
        ) {
          summary.lastSeenAt = auditEvent.createdAt;
        }
        if (typeof auditEvent.metadata.surface === "string") {
          summary.surfaces[auditEvent.metadata.surface] =
            (summary.surfaces[auditEvent.metadata.surface] ?? 0) + 1;
        }
        if (typeof auditEvent.metadata.deploymentProfile === "string") {
          summary.deploymentProfiles[auditEvent.metadata.deploymentProfile] =
            (summary.deploymentProfiles[
              auditEvent.metadata.deploymentProfile
            ] ?? 0) + 1;
        }
        byEvent.set(event, summary);
      }
      return {
        generatedAt: new Date().toISOString(),
        scope: {
          ownerUserId: teamId ? null : actor.userId,
          teamId,
          teamWorkspaceId
        },
        window: {
          since: input.since ? input.since.toISOString() : null,
          until: input.until ? input.until.toISOString() : null
        },
        events: [...byEvent.values()].sort((left, right) =>
          left.event.localeCompare(right.event)
        )
      };
    },
    async ensureConversationSourceArtifact(actor, input) {
      const session = capturedSessions.get(input.sessionId);
      if (
        !session ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal"
      ) {
        throw Object.assign(
          new Error("Captured Session not found for source artifact"),
          { statusCode: 404 }
        );
      }
      const existing = [...conversationSourceArtifacts.values()].find(
        (artifact) =>
          artifact.ownerUserId === actor.userId &&
          artifact.sourceKind === input.sourceKind &&
          artifact.externalSessionId === input.externalSessionId &&
          artifact.sourceComponentId === input.sourceComponentId
      );
      if (existing) {
        if (
          existing.sessionId !== input.sessionId ||
          existing.sourceFingerprint !== input.sourceFingerprint ||
          existing.artifactFormat !== input.artifactFormat ||
          existing.artifactFormatVersion !== input.artifactFormatVersion ||
          existing.journalStartOffset !== input.journalStartOffset ||
          existing.liveStartOffset !== input.liveStartOffset
        ) {
          throw Object.assign(
            new Error("Conversation source identity conflict"),
            { statusCode: 409 }
          );
        }
        return existing;
      }
      const now = new Date().toISOString();
      const artifact: ConversationSourceArtifactRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        sessionId: input.sessionId,
        logicalSourceId: input.logicalSourceId,
        sourceGenerationId: input.sourceGenerationId,
        sourceComponentId: input.sourceComponentId ?? "main",
        sourceComponentRole: input.sourceComponentRole ?? "primary",
        parentSourceComponentId: input.parentSourceComponentId ?? null,
        contentFraming: input.contentFraming ?? "jsonl",
        replicaRole: input.replicaRole,
        sourceKind: input.sourceKind,
        sourceRuntime: input.sourceRuntime,
        externalSessionId: input.externalSessionId,
        sourceFingerprint: input.sourceFingerprint,
        artifactFormat: input.artifactFormat,
        artifactFormatVersion: input.artifactFormatVersion,
        sourceAdapterVersion: input.sourceAdapterVersion,
        lifecycle: "active",
        journalStartOffset: input.journalStartOffset,
        journalStartLine: input.journalStartLine,
        liveStartOffset: input.liveStartOffset,
        liveStartLine: input.liveStartLine,
        providerCursorOffset: input.journalStartOffset,
        providerCursorLine: input.journalStartLine,
        currentSourceLength: input.currentSourceLength,
        currentJournalSequence: -1,
        sourceCreatedAt: input.sourceCreatedAt,
        sourceModifiedAt: input.sourceModifiedAt ?? null,
        storageProvider: input.storageProvider,
        storagePrefix: input.storagePrefix,
        closureHash: null,
        closureManifest: null,
        closureSignature: null,
        sourceSetClosureHash: null,
        sourceSetClosureManifest: null,
        sourceSetClosureSignature: null,
        sourceSetFinalizedAt: null,
        originDeploymentId: input.originDeploymentId,
        originDeviceId: input.originDeviceId,
        originKeyId: input.originKeyId,
        originPublicKey: input.originPublicKey,
        originKeyStatus: "active",
        priorGenerationClosure: input.priorGenerationClosure ?? null,
        redactedSourceLabel: input.redactedSourceLabel,
        createdAt: now,
        updatedAt: now,
        finalizedAt: null
      };
      conversationSourceArtifacts.set(artifact.id, artifact);
      return artifact;
    },
    async getConversationSourceArtifact(actor, artifactId) {
      const artifact = conversationSourceArtifacts.get(artifactId);
      return artifact?.ownerUserId === actor.userId ? artifact : null;
    },
    async getConversationSourceArtifactByIdentity(actor, input) {
      return (
        [...conversationSourceArtifacts.values()].find(
          (artifact) =>
            artifact.ownerUserId === actor.userId &&
            artifact.logicalSourceId === input.logicalSourceId &&
            artifact.sourceGenerationId === input.sourceGenerationId
        ) ?? null
      );
    },
    async getConversationSourceArtifactByProviderIdentity(actor, input) {
      return (
        [...conversationSourceArtifacts.values()]
          .filter(
            (artifact) =>
              artifact.ownerUserId === actor.userId &&
              artifact.sourceKind === input.sourceKind &&
              artifact.externalSessionId === input.externalSessionId
          )
          .sort((left, right) =>
            right.sourceCreatedAt.localeCompare(left.sourceCreatedAt)
          )[0] ?? null
      );
    },
    async getConversationSourceArtifactByGeneration(
      actor,
      sourceGenerationId,
      sourceComponentId = "main"
    ) {
      return (
        [...conversationSourceArtifacts.values()].find(
          (artifact) =>
            artifact.ownerUserId === actor.userId &&
            artifact.sourceGenerationId === sourceGenerationId &&
            artifact.sourceComponentId === sourceComponentId
        ) ?? null
      );
    },
    async createConversationSourceSuccessorGeneration(actor, input) {
      const parent = conversationSourceArtifacts.get(input.parentArtifactId);
      if (
        !parent ||
        parent.ownerUserId !== actor.userId ||
        parent.lifecycle !== "finalized" ||
        parent.closureHash !== input.expectedParentClosureHash ||
        !parent.finalizedAt
      ) {
        throw Object.assign(
          new Error("Conversation source parent is not finalized"),
          { statusCode: 409 }
        );
      }
      const priorGenerationClosure = {
        sourceGenerationId: parent.sourceGenerationId,
        contentDigest: parent.closureHash,
        closedAt: parent.finalizedAt
      };
      const existing = [...conversationSourceArtifacts.values()].find(
        (artifact) =>
          artifact.ownerUserId === actor.userId &&
          artifact.logicalSourceId === parent.logicalSourceId &&
          JSON.stringify(artifact.priorGenerationClosure) ===
            JSON.stringify(priorGenerationClosure)
      );
      if (existing) {
        if (
          existing.sourceGenerationId !== input.sourceGenerationId ||
          existing.originDeploymentId !== input.originDeploymentId ||
          existing.originDeviceId !== input.originDeviceId ||
          existing.originKeyId !== input.originKeyId ||
          existing.originPublicKey !== input.originPublicKey
        ) {
          throw Object.assign(
            new Error("Conversation source successor already exists"),
            { statusCode: 409 }
          );
        }
        return { artifact: existing, replayed: true };
      }
      const now = new Date().toISOString();
      const artifact: ConversationSourceArtifactRecord = {
        ...parent,
        id: randomUUID(),
        sourceGenerationId: input.sourceGenerationId,
        lifecycle: "active",
        journalStartOffset: parent.providerCursorOffset,
        journalStartLine: parent.providerCursorLine,
        liveStartOffset: parent.providerCursorOffset,
        liveStartLine: parent.providerCursorLine,
        currentJournalSequence: -1,
        sourceCreatedAt: input.sourceCreatedAt,
        storageProvider: input.storageProvider,
        storagePrefix: input.storagePrefix,
        closureHash: null,
        closureManifest: null,
        closureSignature: null,
        originDeploymentId: input.originDeploymentId,
        originDeviceId: input.originDeviceId,
        originKeyId: input.originKeyId,
        originPublicKey: input.originPublicKey,
        priorGenerationClosure,
        createdAt: now,
        updatedAt: now,
        finalizedAt: null
      };
      conversationSourceArtifacts.set(artifact.id, artifact);
      return { artifact, replayed: false };
    },
    async appendConversationSourceSegment(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) {
        throw Object.assign(
          new Error("Conversation source artifact not found"),
          { statusCode: 404 }
        );
      }
      const segments = conversationSourceSegments.get(input.artifactId) ?? [];
      const replay = segments.find(
        (segment) =>
          segment.sourceStartOffset === input.expectedProviderOffset &&
          segment.sourceEndOffset === input.sourceEndOffset
      );
      if (replay) {
        if (
          replay.plaintextDigest !== input.plaintextDigest ||
          replay.storageKey !== input.storageKey
        ) {
          throw Object.assign(
            new Error("Conversation source segment replay conflict"),
            { statusCode: 409 }
          );
        }
        return { artifact, segment: replay, replayed: true };
      }
      if (
        artifact.lifecycle !== "active" ||
        artifact.providerCursorOffset !== input.expectedProviderOffset ||
        artifact.providerCursorLine !== input.expectedProviderLine
      ) {
        throw Object.assign(new Error("Conversation source cursor conflict"), {
          statusCode: 409
        });
      }
      const now = new Date().toISOString();
      const segment: ConversationSourceSegmentRecord = {
        id: randomUUID(),
        artifactId: artifact.id,
        segmentIndex: artifact.currentJournalSequence + 1,
        sourceStartOffset: input.expectedProviderOffset,
        sourceEndOffset: input.sourceEndOffset,
        sourceStartLine: input.expectedProviderLine,
        sourceEndLine: input.sourceEndLine,
        plaintextDigest: input.plaintextDigest,
        ciphertextDigest: input.ciphertextDigest ?? null,
        plaintextSize: input.plaintextSize,
        storedSize: input.storedSize,
        storageKey: input.storageKey,
        storageProvider: input.storageProvider,
        encryptionEnvelope: input.encryptionEnvelope ?? null,
        signedManifest: input.signedManifest,
        originSignature: input.originSignature,
        manifestDigest: input.manifestDigest,
        previousContentDigest: input.previousContentDigest,
        contentDigest: input.contentDigest,
        createdAt: now,
        sealedAt: now
      };
      const updated = {
        ...artifact,
        providerCursorOffset: input.sourceEndOffset,
        providerCursorLine: input.sourceEndLine,
        currentSourceLength: Math.max(
          artifact.currentSourceLength,
          input.currentSourceLength
        ),
        currentJournalSequence: segment.segmentIndex,
        sourceModifiedAt: input.sourceModifiedAt ?? artifact.sourceModifiedAt,
        updatedAt: now
      };
      segments.push(segment);
      conversationSourceSegments.set(artifact.id, segments);
      conversationSourceArtifacts.set(artifact.id, updated);
      return { artifact: updated, segment, replayed: false };
    },
    async finalizeConversationSourceArtifact(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) {
        throw Object.assign(
          new Error("Conversation source artifact not found"),
          { statusCode: 404 }
        );
      }
      const closureHash = calculateConversationSourceClosureDigest(
        input.signedClosure
      );
      if (artifact.lifecycle === "finalized") {
        if (artifact.closureHash !== closureHash) {
          throw Object.assign(
            new Error("Conversation source closure conflict"),
            { statusCode: 409 }
          );
        }
        return { artifact, replayed: true };
      }
      const finalized = {
        ...artifact,
        lifecycle: "finalized" as const,
        closureHash,
        closureManifest: input.signedClosure.manifest as unknown as Record<
          string,
          unknown
        >,
        closureSignature: input.signedClosure.signature,
        finalizedAt: input.signedClosure.manifest.closedAt,
        updatedAt: new Date().toISOString()
      };
      conversationSourceArtifacts.set(artifact.id, finalized);
      return { artifact: finalized, replayed: false };
    },
    async listConversationSourceSegments(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) return [];
      return (conversationSourceSegments.get(input.artifactId) ?? [])
        .filter((segment) => segment.sourceEndOffset > input.afterOffset)
        .slice(0, input.limit);
    },
    async listConversationSourceSegmentsByIndex(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) return [];
      return (conversationSourceSegments.get(input.artifactId) ?? [])
        .filter(
          (segment) =>
            segment.segmentIndex > input.afterSegmentIndex &&
            segment.segmentIndex <= input.throughSegmentIndex
        )
        .slice(0, input.limit);
    },
    async getConversationSourceSegment(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) return null;
      return (
        (conversationSourceSegments.get(input.artifactId) ?? []).find(
          (segment) => segment.id === input.segmentId
        ) ?? null
      );
    },
    async getConversationSourceConsumerCursor(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) return null;
      return (
        conversationSourceCursors.get(
          sourceCursorKey(input.artifactId, input.consumerKind)
        ) ?? null
      );
    },
    async advanceConversationSourceConsumerCursor(actor, input) {
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (!artifact || artifact.ownerUserId !== actor.userId) {
        throw Object.assign(
          new Error("Conversation source consumer cursor conflict"),
          { statusCode: 409 }
        );
      }
      const key = sourceCursorKey(input.artifactId, input.consumerKind);
      const existing = conversationSourceCursors.get(key);
      const initialOffset =
        input.consumerKind === "canonical_live"
          ? artifact.liveStartOffset
          : artifact.journalStartOffset;
      if (
        (existing?.sourceOffset ?? initialOffset) !==
          input.expectedSourceOffset ||
        input.sourceOffset <= input.expectedSourceOffset ||
        input.sourceOffset > artifact.providerCursorOffset
      ) {
        throw Object.assign(
          new Error("Conversation source consumer cursor conflict"),
          { statusCode: 409 }
        );
      }
      const cursor: ConversationSourceConsumerCursorRecord = {
        artifactId: input.artifactId,
        consumerKind: input.consumerKind,
        segmentIndex: input.segmentIndex,
        sourceOffset: input.sourceOffset,
        sourceLine: input.sourceLine,
        lastVerifiedDigest: input.lastVerifiedDigest,
        parserState: input.parserState ?? {},
        failureCode: null,
        retryCount: 0,
        nextAttemptAt: null,
        updatedAt: new Date().toISOString()
      };
      conversationSourceCursors.set(key, cursor);
      return cursor;
    },
    async createHistoricalImportRun(actor) {
      const now = new Date().toISOString();
      const run: HistoricalImportRunRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        state: "discovered",
        sourceCount: 0,
        completedSourceCount: 0,
        failedSourceCount: 0,
        skippedSourceCount: 0,
        discoveredRecordCount: 0,
        importedRecordCount: 0,
        skippedRecordCount: 0,
        scannedByteCount: 0,
        retryCount: 0,
        failureReason: null,
        nextRetryAt: null,
        discoveredAt: now,
        eligibleAt: null,
        queuedAt: null,
        importStartedAt: null,
        pausedAt: null,
        skippedAt: null,
        completedAt: null,
        failedAt: null,
        lastAttemptAt: null,
        createdAt: now,
        updatedAt: now
      };
      historicalImportRuns.set(run.id, run);
      return run;
    },
    async listHistoricalImportRuns(actor, input = {}) {
      return [...historicalImportRuns.values()]
        .filter((run) => run.ownerUserId === actor.userId)
        .slice(0, input.limit ?? 20);
    },
    async getHistoricalImportRun(actor, runId) {
      const run = historicalImportRuns.get(runId);
      if (!run || run.ownerUserId !== actor.userId) {
        return null;
      }
      return {
        ...run,
        sources: [...historicalImportSources.values()]
          .filter((source) => source.runId === run.id)
          .map(currentHistoricalSource)
      };
    },
    async createHistoricalImportSource(actor, input) {
      const run = historicalImportRuns.get(input.runId);
      const artifact = conversationSourceArtifacts.get(input.artifactId);
      if (
        !run ||
        run.ownerUserId !== actor.userId ||
        !artifact ||
        artifact.ownerUserId !== actor.userId ||
        artifact.lifecycle !== "active"
      ) {
        return null;
      }
      const existing = [...historicalImportSources.values()].find(
        (source) =>
          source.ownerUserId === actor.userId &&
          source.artifactId === input.artifactId
      );
      if (existing) {
        return currentHistoricalSource(existing);
      }
      const now = new Date().toISOString();
      const source: HistoricalImportSourceRecord = {
        id: randomUUID(),
        runId: run.id,
        ownerUserId: actor.userId,
        state: "discovered",
        artifactId: artifact.id,
        aiClient: input.aiClient,
        sourceKind: artifact.sourceKind,
        sourceAdapterVersion: artifact.sourceAdapterVersion,
        sourceSessionId: artifact.externalSessionId,
        sourceFingerprint: artifact.sourceFingerprint,
        sessionId: artifact.sessionId,
        registrationFrontierOffset: artifact.liveStartOffset,
        redactedSourceLabel: artifact.redactedSourceLabel,
        historicalCursorOffset: artifact.journalStartOffset,
        historicalCursorLine: artifact.journalStartLine,
        historicalCursorDigest: null,
        historicalCursorParserState: {},
        providerCursorOffset: artifact.providerCursorOffset,
        providerCursorLine: artifact.providerCursorLine,
        sourceSizeBytes: artifact.currentSourceLength,
        sourceModifiedAt: artifact.sourceModifiedAt,
        sourceEventFrom: input.sourceEventFrom ?? null,
        sourceEventTo: input.sourceEventTo ?? null,
        discoveredRecordCount: input.discoveredRecordCount ?? 0,
        importedRecordCount: 0,
        skippedRecordCount: 0,
        malformedRecordCount: 0,
        rawIngestedRecordCount: 0,
        projectedRecordCount: 0,
        embeddingEligibleEventCount: 0,
        embeddedEventCount: 0,
        embeddingEligibleEstimatedTokenCount: 0,
        embeddedMeasuredTokenCount: 0,
        pendingEmbeddingEstimatedTokenCount: 0,
        embeddingQueueAheadEstimatedTokenCount: 0,
        embeddingEtaLowerSeconds: null,
        embeddingEtaUpperSeconds: null,
        embeddingEtaConfidence: "conservative",
        oldestEmbeddedSourceTime: null,
        newestEmbeddedSourceTime: null,
        lcmEligibleEventCount: 0,
        lcmCompletedEventCount: 0,
        rawIngested: artifact.liveStartOffset === artifact.journalStartOffset,
        projected: artifact.liveStartOffset === artifact.journalStartOffset,
        partiallyEmbedded: false,
        fullyEmbedded: true,
        semanticReady: artifact.liveStartOffset === artifact.journalStartOffset,
        lcmComplete: true,
        retryCount: 0,
        failureReason: null,
        nextRetryAt: null,
        detectedProject: input.detectedProject ?? {},
        discoveredAt: now,
        eligibleAt: null,
        queuedAt: null,
        importStartedAt: null,
        pausedAt: null,
        skippedAt: null,
        completedAt: null,
        failedAt: null,
        lastObservedAt: null,
        createdAt: now,
        updatedAt: now
      };
      historicalImportSources.set(source.id, source);
      historicalImportRuns.set(run.id, {
        ...run,
        sourceCount: run.sourceCount + 1
      });
      return source;
    },
    async transitionHistoricalImportRun(actor, input) {
      const run = historicalImportRuns.get(input.runId);
      if (
        !run ||
        run.ownerUserId !== actor.userId ||
        run.state !== input.expectedState
      ) {
        return null;
      }
      const updated = {
        ...run,
        state: input.state,
        failureReason: input.failureReason ?? null,
        nextRetryAt: input.nextRetryAt ?? null,
        updatedAt: new Date().toISOString()
      };
      historicalImportRuns.set(run.id, updated);
      return updated;
    },
    async transitionHistoricalImportSource(actor, input) {
      const source = historicalImportSources.get(input.sourceId);
      if (
        !source ||
        source.ownerUserId !== actor.userId ||
        source.state !== input.expectedState
      ) {
        return null;
      }
      const updated = {
        ...source,
        state: input.state,
        failureReason: input.failureReason ?? null,
        nextRetryAt: input.nextRetryAt ?? null,
        updatedAt: new Date().toISOString()
      };
      historicalImportSources.set(source.id, updated);
      return currentHistoricalSource(updated);
    },
    async ingestHistoricalImportBatch(actor, input) {
      const storedSource = historicalImportSources.get(input.sourceId);
      const source = storedSource
        ? currentHistoricalSource(storedSource)
        : undefined;
      if (!source || source.ownerUserId !== actor.userId) {
        throw Object.assign(new Error("Historical import source not found"), {
          statusCode: 404
        });
      }
      const policy = await this.getEffectiveCapturePolicy!(actor, {
        projectId:
          typeof source.detectedProject.projectId === "string"
            ? source.detectedProject.projectId
            : undefined,
        threadId: source.sourceSessionId
      });
      if (policy.captureState !== "enabled" || policy.paused) {
        throw Object.assign(
          new Error("Historical import blocked by effective Capture Policy"),
          { statusCode: 409 }
        );
      }
      const cursorKey = sourceCursorKey(
        source.artifactId,
        "canonical_historical"
      );
      const existingCursor = conversationSourceCursors.get(cursorKey);
      if (
        existingCursor?.sourceOffset === input.sourceOffset &&
        existingCursor.lastVerifiedDigest === input.lastVerifiedDigest
      ) {
        return { items: [], source, policy, replayed: true };
      }
      if (
        source.historicalCursorOffset !== input.expectedSourceOffset ||
        input.sourceOffset > source.registrationFrontierOffset
      ) {
        throw Object.assign(new Error("Historical import cursor conflict"), {
          statusCode: 409
        });
      }
      const segment = (
        conversationSourceSegments.get(source.artifactId) ?? []
      ).find((candidate) => candidate.segmentIndex === input.segmentIndex);
      if (
        !segment ||
        segment.sourceStartOffset >= input.sourceOffset ||
        segment.sourceEndOffset < input.sourceOffset ||
        segment.plaintextDigest !== input.lastVerifiedDigest
      ) {
        throw Object.assign(
          new Error("Historical import segment verification failed"),
          { statusCode: 409 }
        );
      }
      const items = await this.createConversationItems!(actor, {
        items: input.items.map((item) => ({
          ...item,
          sessionId: source.sessionId,
          sourceKind: source.sourceKind,
          sourceAdapterVersion: source.sourceAdapterVersion,
          sourceTransport: "historical_import",
          externalSessionId: source.sourceSessionId,
          sourceFingerprint: source.sourceFingerprint,
          importObservedAt: new Date().toISOString(),
          metadata: {
            ...item.metadata,
            historicalImportRunId: source.runId,
            historicalImportSourceId: source.id,
            conversationSourceArtifactId: source.artifactId
          }
        }))
      });
      const now = new Date().toISOString();
      conversationSourceCursors.set(cursorKey, {
        artifactId: source.artifactId,
        consumerKind: "canonical_historical",
        segmentIndex: input.segmentIndex,
        sourceOffset: input.sourceOffset,
        sourceLine: input.sourceLine,
        lastVerifiedDigest: input.lastVerifiedDigest,
        parserState: input.parserState ?? {},
        failureCode: null,
        retryCount: 0,
        nextAttemptAt: null,
        updatedAt: now
      });
      const updated = currentHistoricalSource({
        ...source,
        state: "importing",
        importedRecordCount: source.importedRecordCount + input.items.length,
        rawIngestedRecordCount:
          source.rawIngestedRecordCount + input.items.length,
        projectedRecordCount: source.projectedRecordCount + input.items.length,
        skippedRecordCount:
          source.skippedRecordCount + (input.skippedRecordCount ?? 0),
        malformedRecordCount:
          source.malformedRecordCount + (input.malformedRecordCount ?? 0),
        sourceEventFrom:
          source.sourceEventFrom ?? input.sourceEventFrom ?? null,
        sourceEventTo: input.sourceEventTo ?? source.sourceEventTo,
        importStartedAt: source.importStartedAt ?? now,
        lastObservedAt: now,
        updatedAt: now
      });
      historicalImportSources.set(source.id, updated);
      return { items, source: updated, policy, replayed: false };
    },
    async getHistoricalImportSource(actor, sourceId) {
      const source = historicalImportSources.get(sourceId);
      return source?.ownerUserId === actor.userId
        ? currentHistoricalSource(source)
        : null;
    },
    async getHistoricalImportSourceByIdentity(actor, identity) {
      const source = [...historicalImportSources.values()].find(
        (source) =>
          source.ownerUserId === actor.userId &&
          source.artifactId === identity.artifactId
      );
      return source ? currentHistoricalSource(source) : null;
    },
    async createCapturedSession(actor: ActorContext, input) {
      const id = randomUUID();
      const detectedProjects =
        input.detectedProjects ??
        (input.projectId
          ? [
              {
                id: input.projectId,
                name:
                  input.projectId.split("/").filter(Boolean).at(-1) ??
                  input.projectId,
                path: input.cwd ?? null
              }
            ]
          : null) ??
        (input.cwd
          ? [
              {
                id: input.cwd,
                name: input.cwd.split("/").filter(Boolean).at(-1) ?? input.cwd,
                path: input.cwd
              }
            ]
          : []);
      const automaticProject =
        detectedProjects.length === 1 ? detectedProjects[0]! : null;
      const detectedProjectInputProvided =
        input.detectedProjects !== undefined ||
        input.projectId !== undefined ||
        input.cwd !== undefined;
      const createdAt = new Date(
        Date.now() + capturedSessionCounter++
      ).toISOString();
      const scopedIdempotencyKey = input.idempotencyKey
        ? `${actor.userId}:${input.idempotencyKey}`
        : null;
      const existingId = scopedIdempotencyKey
        ? capturedSessionIdsByIdempotencyKey.get(scopedIdempotencyKey)
        : undefined;
      const existing = existingId
        ? capturedSessions.get(existingId)
        : undefined;
      const record: CapturedSessionRecord = {
        id: existing?.id ?? id,
        logicalSessionId: existing?.logicalSessionId ?? randomUUID(),
        ownerUserId: actor.userId,
        visibility: "personal",
        externalSessionId:
          existing?.externalSessionId ?? input.externalSessionId ?? null,
        forkedFromExternalThreadId:
          existing?.forkedFromExternalThreadId ??
          input.forkedFromExternalThreadId ??
          null,
        sourceRuntime:
          existing?.sourceRuntime ?? input.sourceRuntime ?? "codex",
        captureMethod: existing?.captureMethod ?? input.captureMethod ?? "mcp",
        model: existing?.model ?? input.model ?? null,
        cwd: existing?.cwd ?? input.cwd ?? null,
        sourceKind: existing?.sourceKind ?? input.sourceKind ?? "codex",
        sourceAdapterVersion:
          existing?.sourceAdapterVersion ?? input.sourceAdapterVersion ?? null,
        sourceFingerprint:
          existing?.sourceFingerprint ?? input.sourceFingerprint ?? null,
        capturedProject:
          existing && Object.keys(existing.capturedProject).length > 0
            ? existing.capturedProject
            : (input.capturedProject ?? {}),
        importObservedAt:
          existing?.importObservedAt ?? input.importObservedAt ?? null,
        metadata: { ...existing?.metadata, ...input.metadata },
        capturedProjectProvenance: existing?.capturedProjectProvenance ?? {
          capturedCwd: input.cwd ?? null,
          candidates: detectedProjects,
          outcome:
            detectedProjects.length === 1
              ? "unambiguous"
              : detectedProjects.length > 1
                ? "ambiguous"
                : "no_signal"
        },
        automaticProject:
          existing && !detectedProjectInputProvided
            ? existing.automaticProject
            : automaticProject,
        projectOverride: existing?.projectOverride ?? null,
        project:
          existing?.projectOverride ??
          (existing && !detectedProjectInputProvided
            ? existing.automaticProject
            : automaticProject),
        projectAssignmentSource: existing?.projectOverride
          ? "user_override"
          : existing && !detectedProjectInputProvided
            ? existing.projectAssignmentSource
            : automaticProject
              ? "detected"
              : null,
        projectAssignmentUpdatedAt: existing?.projectOverride
          ? existing.projectAssignmentUpdatedAt
          : existing && !detectedProjectInputProvided
            ? existing.projectAssignmentUpdatedAt
            : automaticProject
              ? createdAt
              : null,
        createdAt: existing?.createdAt ?? createdAt
      };
      capturedSessions.set(record.id, record);
      if (scopedIdempotencyKey) {
        capturedSessionIdsByIdempotencyKey.set(scopedIdempotencyKey, record.id);
      }
      return record;
    },
    async getCapturedSession(actor, sessionId) {
      const session = capturedSessions.get(sessionId);
      if (
        !session ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal"
      ) {
        return null;
      }
      return session;
    },
    async updateCapturedSessionTitle(actor, sessionId, input) {
      const session = capturedSessions.get(sessionId);
      const title = input.title.replace(/\s+/g, " ").trim();
      if (
        !session ||
        !title ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal"
      ) {
        return null;
      }
      const nextSession: CapturedSessionRecord = {
        ...session,
        metadata: {
          ...session.metadata,
          threadName: title,
          threadNameSource: "manual",
          threadNameEditedAt: new Date().toISOString()
        }
      };
      capturedSessions.set(sessionId, nextSession);
      return nextSession;
    },
    async moveCapturedSessionToProject(actor, sessionId, project) {
      const session = capturedSessions.get(sessionId);
      if (
        !session ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal"
      )
        return null;
      const updatedAt = new Date().toISOString();
      const nextSession: CapturedSessionRecord = {
        ...session,
        projectOverride: project,
        project,
        projectAssignmentSource: "user_override",
        projectAssignmentUpdatedAt: updatedAt
      };
      capturedSessions.set(sessionId, nextSession);
      return nextSession;
    },
    async resetCapturedSessionProject(actor, sessionId) {
      const session = capturedSessions.get(sessionId);
      if (
        !session ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal"
      )
        return null;
      const nextSession: CapturedSessionRecord = {
        ...session,
        projectOverride: null,
        project: session.automaticProject,
        projectAssignmentSource: session.automaticProject ? "detected" : null,
        projectAssignmentUpdatedAt: session.automaticProject
          ? new Date().toISOString()
          : null
      };
      capturedSessions.set(sessionId, nextSession);
      return nextSession;
    },
    async listCapturedSessionsNeedingTitles(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 5, 1), 25);
      const minUserEvents = Math.min(Math.max(input.minUserEvents ?? 3, 1), 50);
      const candidates = [...capturedSessions.values()]
        .filter((session) => {
          if (
            session.ownerUserId !== actor.userId ||
            session.visibility !== "personal"
          ) {
            return false;
          }
          if (session.metadata.threadNameSource === "manual") {
            return false;
          }
          const title =
            typeof session.metadata.threadName === "string"
              ? session.metadata.threadName.trim()
              : "";
          return (
            !title ||
            title === session.id ||
            title === session.externalSessionId ||
            session.metadata.threadNameSource === "provisional"
          );
        })
        .map((session) => {
          const sessionEvents = events.filter(
            (event) =>
              event.sessionId === session.id &&
              event.ownerUserId === actor.userId &&
              event.visibility === "personal"
          );
          const titleEventCount = sessionEvents.filter(
            (event) => event.actor === "user" || event.actor === "agent"
          ).length;
          return { session, sessionEvents, titleEventCount };
        })
        .filter((candidate) => candidate.titleEventCount >= minUserEvents)
        .slice(0, limit);

      return candidates.map(({ session, sessionEvents, titleEventCount }) => ({
        id: session.id,
        externalSessionId: session.externalSessionId,
        projectName: session.project?.name ?? "Unassigned",
        projectPath: session.project?.path ?? null,
        currentTitle:
          typeof session.metadata.threadName === "string"
            ? session.metadata.threadName
            : null,
        eventCount: titleEventCount,
        sourceItems: sessionEvents
          .filter(
            (event) =>
              (event.actor === "user" ||
                event.actor === "assistant" ||
                event.actor === "agent" ||
                event.actor === "subagent") &&
              event.content.trim()
          )
          .slice(0, 8)
          .map((event) => ({
            id: event.id,
            actor: event.actor,
            content: event.content,
            capturedAt: event.createdAt
          }))
      }));
    },
    async getLatestCapturedSessionForProject(actor, input) {
      return (
        [...capturedSessions.values()]
          .filter(
            (session) =>
              session.ownerUserId === actor.userId &&
              session.visibility === "personal" &&
              (session.project?.id === input.projectId ||
                session.project?.path === input.projectId ||
                session.automaticProject?.id === input.projectId ||
                session.automaticProject?.path === input.projectId ||
                session.cwd === input.projectId ||
                session.metadata.projectId === input.projectId ||
                session.metadata.projectPath === input.projectId)
          )
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt)
          )[0] ?? null
      );
    },
    async updateCapturedSessionGeneratedTitle(actor, sessionId, input) {
      const session = capturedSessions.get(sessionId);
      const title = input.title.replace(/\s+/g, " ").trim();
      if (
        !session ||
        !title ||
        session.ownerUserId !== actor.userId ||
        session.visibility !== "personal" ||
        session.metadata.threadNameSource === "manual"
      ) {
        return null;
      }
      const existingTitle =
        typeof session.metadata.threadName === "string"
          ? session.metadata.threadName.trim()
          : "";
      if (
        existingTitle &&
        existingTitle !== session.id &&
        existingTitle !== session.externalSessionId &&
        !["generated", "lcm", "provisional"].includes(
          typeof session.metadata.threadNameSource === "string"
            ? session.metadata.threadNameSource
            : ""
        )
      ) {
        return null;
      }
      const nextSession: CapturedSessionRecord = {
        ...session,
        metadata: {
          ...session.metadata,
          threadName: title,
          threadNameSource: input.source,
          threadNameGeneratedAt: new Date().toISOString()
        }
      };
      capturedSessions.set(sessionId, nextSession);
      return nextSession;
    },
    async createConversationItems(_actor, input) {
      return input.items.flatMap((item, index) =>
        item.observationOnly
          ? []
          : [
              {
                id: randomUUID(),
                canonicalItemKey: item.canonicalItemKey ?? item.idempotencyKey,
                sessionId: item.sessionId ?? null,
                turnId: item.turnId ?? null,
                sourceKind: item.sourceKind,
                sourceAdapterVersion: item.sourceAdapterVersion,
                sourceTransport: item.sourceTransport,
                externalSessionId: item.externalSessionId ?? null,
                externalThreadId: item.externalThreadId ?? null,
                externalTurnId: item.externalTurnId ?? null,
                externalItemId: item.externalItemId ?? null,
                canonicalStableItemId: item.canonicalStableItemId ?? null,
                sourceRecordType: item.sourceRecordType,
                sourceEventType: item.sourceEventType ?? null,
                sourceSequence: item.sourceSequence ?? index,
                idempotencyKey: item.idempotencyKey,
                observedAt: new Date().toISOString(),
                importObservedAt: item.importObservedAt ?? null,
                sourceFingerprint: item.sourceFingerprint ?? null,
                capturedProject: item.capturedProject ?? {},
                createdAt: new Date().toISOString()
              }
            ]
      );
    },
    async createTrustedNormalizedImport(actor, input) {
      const createConversationItems = this.createConversationItems;
      if (!createConversationItems) {
        throw new Error(
          "Fake repository Conversation Item ingestion is absent"
        );
      }
      return createConversationItems(actor, { items: input.items });
    },
    async releaseConversationProjectionHold() {
      return { conversationItemIds: [] };
    },
    async resetConversationProjection() {
      return {
        conversationItemIds: [],
        invalidatedMemoryEventIds: [],
        projectionPolicyRevision: 1
      };
    },
    async recordWorkflowTokenUsage(_actor, input) {
      return {
        id: randomUUID(),
        workflowType: input.workflowType,
        workflowId: input.workflowId ?? null,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        conversationItemId: input.conversationItemId ?? null,
        model: input.model ?? null,
        usageSource: input.usageSource ?? "app_server",
        usageAccuracy: input.usageAccuracy ?? "provider_reported",
        usageKind: input.usageKind ?? "turn_delta",
        connectorClient: input.connectorClient ?? null,
        tokenizerPackage: input.tokenizerPackage ?? null,
        tokenizerEncoding: input.tokenizerEncoding ?? null,
        tokenizerModel: input.tokenizerModel ?? null,
        tokenizerExactModelMatch: input.tokenizerExactModelMatch ?? null,
        tokenizerHeuristicFallback: input.tokenizerHeuristicFallback ?? null,
        tokenizerVersion: input.tokenizerVersion ?? null,
        inputTokens: input.inputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        reasoningOutputTokens: input.reasoningOutputTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        usageScope: input.usageScope ?? "last",
        createdAt: new Date().toISOString()
      };
    },
    async listWorkflowTokenUsageRollups() {
      return [
        {
          group: { workflow: "memory_question" },
          rowCount: 1,
          inputTokens: 4,
          cachedInputTokens: 1,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 6
        }
      ];
    },
    async projectPendingConversationItems(_actor, input) {
      if (input?.visibility !== "personal") {
        throw new Error("API token projection must stay personal-scoped");
      }
      return {
        rawItemsScanned: 0,
        rawItemsProjected: 0,
        rawItemsWaitingForAgentSeal: 0,
        messagesCreated: 0,
        toolEventsCreated: 0,
        memoryEventsCreated: 0,
        tokenUsageRowsCreated: 0,
        memoryEventIds: [],
        memoryEventScopes: []
      };
    },
    async listConversationProjectionActors() {
      return [];
    },
    async tryAcquireHistoricalProjectionLease() {
      return { release: async () => undefined };
    },
    async listPendingConversationProjectionProcessing() {
      return [];
    },
    async markConversationProjectionProcessingDispatched(eventIds) {
      return eventIds.length;
    },
    async listSemanticMemoryRebuildActors() {
      return [];
    },
    async processDueSemanticMemoryRebuilds() {
      return {
        jobsClaimed: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        memoryEventsCreated: 0,
        memoryEventIds: [],
        memoryEventScopes: []
      };
    },
    async createPendingDesktopAsk(actor, input) {
      const existing = [...memoryQuestions.values()].find(
        (question) =>
          question.ownerUserId === actor.userId &&
          (question as MemoryQuestionDetailRecord & { idempotencyKey?: string })
            .idempotencyKey === input.idempotencyKey
      ) as
        | (MemoryQuestionDetailRecord & { idempotencyKey?: string })
        | undefined;
      if (existing) return existing;
      const askThreadId = input.askThreadId ?? randomUUID();
      const ownedTurns = [...memoryQuestions.values()].filter(
        (question) =>
          question.ownerUserId === actor.userId &&
          question.origin === "desktop_ask" &&
          question.askThreadId === askThreadId
      );
      if (input.askThreadId && ownedTurns.length === 0) {
        throw new Error("Ask thread not found or not visible");
      }
      const now = new Date().toISOString();
      const record: MemoryQuestionDetailRecord & { idempotencyKey: string } = {
        id: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        ownerUserId: actor.userId,
        visibility: "personal",
        origin: "desktop_ask",
        retrievalScope: "personal",
        teamWorkspaceId: null,
        searchDomain: "global",
        projectId: null,
        projectName: null,
        projectPath: null,
        sessionId: null,
        threadId: null,
        threadName: null,
        askThreadId,
        askTurnIndex: ownedTurns.length,
        query: input.query,
        answerPreview: null,
        answerMarkdown: null,
        errorMessage: null,
        evidence: null,
        citations: null,
        retrieval: null,
        localMemoryWorker: null,
        response: null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        answeredAt: null,
        attemptCount: 0,
        evidenceCount: 0
      };
      memoryQuestions.set(record.id, record);
      return record;
    },
    async completePendingDesktopAsk(actor, input) {
      const existing = memoryQuestions.get(input.questionId);
      if (
        !existing ||
        existing.ownerUserId !== actor.userId ||
        existing.origin !== "desktop_ask"
      ) {
        throw new Error("Ask turn not found or not visible");
      }
      if (existing.status !== "pending") return existing;
      const now = new Date().toISOString();
      const completed: MemoryQuestionDetailRecord = {
        ...existing,
        answerPreview:
          input.status === "answered"
            ? input.answerMarkdown.slice(0, 280)
            : null,
        answerMarkdown:
          input.status === "answered" ? input.answerMarkdown : null,
        errorMessage: input.status === "error" ? input.errorMessage : null,
        evidence: input.status === "answered" ? (input.evidence ?? null) : null,
        citations:
          input.status === "answered" ? (input.citations ?? null) : null,
        retrieval: input.retrieval ?? null,
        localMemoryWorker: input.localMemoryWorker ?? null,
        response: input.response ?? null,
        status: input.status,
        updatedAt: now,
        answeredAt: now,
        attemptCount: input.attemptCount ?? 1,
        evidenceCount:
          input.status === "answered" ? (input.evidence?.length ?? 0) : 0
      };
      memoryQuestions.set(completed.id, completed);
      return completed;
    },
    async recoverPendingDesktopAsks(actor, input) {
      let recovered = 0;
      const now = new Date().toISOString();
      for (const question of memoryQuestions.values()) {
        if (
          question.ownerUserId !== actor.userId ||
          question.origin !== "desktop_ask" ||
          question.status !== "pending"
        ) {
          continue;
        }
        memoryQuestions.set(question.id, {
          ...question,
          errorMessage: input.errorMessage,
          status: "error",
          updatedAt: now,
          answeredAt: now,
          attemptCount: Math.max(question.attemptCount, 1)
        });
        recovered += 1;
      }
      return { recovered };
    },
    async listDesktopAskThreads(actor, input = {}) {
      const grouped = new Map<string, MemoryQuestionDetailRecord[]>();
      for (const question of memoryQuestions.values()) {
        if (
          question.ownerUserId !== actor.userId ||
          question.origin !== "desktop_ask" ||
          !question.askThreadId
        ) {
          continue;
        }
        const turns = grouped.get(question.askThreadId) ?? [];
        turns.push(question);
        grouped.set(question.askThreadId, turns);
      }
      const limit = input.limit ?? 50;
      const threads = [...grouped.entries()]
        .map(([askThreadId, turns]) => {
          const ordered = turns.sort(
            (left, right) => left.askTurnIndex! - right.askTurnIndex!
          );
          const latest = [...turns].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt)
          )[0]!;
          return {
            askThreadId,
            firstQuestion: ordered[0]!.query,
            latestStatus: latest.status,
            turnCount: turns.length,
            updatedAt: latest.updatedAt,
            latestQuestionId: latest.id
          };
        })
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const start = input.cursor
        ? Math.max(
            0,
            threads.findIndex(
              (thread) =>
                thread.latestQuestionId === input.cursor?.latestQuestionId
            ) + 1
          )
        : 0;
      const selected = threads.slice(start, start + limit);
      const last = selected.at(-1);
      return {
        threads: selected.map((thread) => ({
          askThreadId: thread.askThreadId,
          firstQuestion: thread.firstQuestion,
          latestStatus: thread.latestStatus,
          turnCount: thread.turnCount,
          updatedAt: thread.updatedAt
        })),
        nextCursor:
          start + limit < threads.length && last
            ? {
                latestQuestionId: last.latestQuestionId,
                updatedAt: last.updatedAt
              }
            : null
      };
    },
    async getDesktopAskThread(actor, askThreadId) {
      return [...memoryQuestions.values()]
        .filter(
          (question) =>
            question.ownerUserId === actor.userId &&
            question.origin === "desktop_ask" &&
            question.askThreadId === askThreadId
        )
        .sort((left, right) => left.askTurnIndex! - right.askTurnIndex!);
    },
    async createFinalMemoryQuestion(actor, input) {
      const now = new Date().toISOString();
      const record: MemoryQuestionDetailRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        visibility: "personal",
        origin: input.origin ?? "mcp_memory_answer",
        retrievalScope: input.retrievalScope ?? "personal",
        teamWorkspaceId: input.teamWorkspaceId ?? null,
        searchDomain: input.searchDomain,
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        projectPath: input.projectPath ?? null,
        sessionId: input.sessionId ?? null,
        threadId: input.threadId ?? null,
        threadName: input.threadName ?? null,
        askThreadId: null,
        askTurnIndex: null,
        query: input.query,
        answerPreview:
          input.status === "answered"
            ? input.answerMarkdown.slice(0, 280)
            : null,
        answerMarkdown:
          input.status === "answered" ? input.answerMarkdown : null,
        errorMessage: input.status === "error" ? input.errorMessage : null,
        evidence: input.status === "answered" ? (input.evidence ?? null) : null,
        citations:
          input.status === "answered" ? (input.citations ?? null) : null,
        retrieval: input.retrieval ?? null,
        localMemoryWorker: input.localMemoryWorker ?? null,
        response: input.response ?? null,
        status: input.status,
        createdAt: now,
        updatedAt: now,
        answeredAt: now,
        attemptCount: input.attemptCount ?? 1,
        evidenceCount:
          input.status === "answered" ? (input.evidence?.length ?? 0) : 0
      };
      memoryQuestions.set(record.id, record);
      return record;
    },
    async listMemoryQuestions(actor, input = {}) {
      const query = input.query?.toLowerCase();
      return [...memoryQuestions.values()]
        .filter((question) => question.ownerUserId === actor.userId)
        .filter(
          (question) =>
            !input.searchDomain || question.searchDomain === input.searchDomain
        )
        .filter(
          (question) =>
            !input.projectId || question.projectId === input.projectId
        )
        .filter(
          (question) =>
            !input.sessionId || question.sessionId === input.sessionId
        )
        .filter((question) => !input.status || question.status === input.status)
        .filter(
          (question) =>
            !query ||
            question.query.toLowerCase().includes(query) ||
            (question.answerMarkdown ?? "").toLowerCase().includes(query)
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100));
    },
    async getMemoryQuestion(actor, questionId) {
      const question = memoryQuestions.get(questionId);
      return question?.ownerUserId === actor.userId ? question : null;
    },
    async listAiClientInstances(actor) {
      return [...aiClientInstances.values()]
        .filter((instance) => instance.ownerUserId === actor.userId)
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },
    async upsertAiClientInstance(actor, input) {
      const key = `${actor.userId}:${input.instanceId}`;
      const existing = aiClientInstances.get(key);
      const now = new Date().toISOString();
      const instance: AiClientInstanceRecord = {
        ownerUserId: actor.userId,
        instanceId: input.instanceId,
        driverId: input.driverId,
        displayName: input.displayName,
        configIdentityHash:
          input.configIdentityHash !== undefined
            ? input.configIdentityHash
            : (existing?.configIdentityHash ?? null),
        enabled:
          input.enabled !== undefined
            ? input.enabled
            : (existing?.enabled ?? true),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      aiClientInstances.set(key, instance);
      return instance;
    },
    async recordAiClientCapabilitySnapshot(actor, input) {
      const snapshot: AiClientCapabilitySnapshotRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        instanceId: input.instanceId,
        installationIdentityHash: input.installationIdentityHash,
        clientVersion: input.clientVersion ?? null,
        authenticationState: input.authenticationState,
        healthState: input.healthState,
        models: input.models,
        capabilities: input.capabilities,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        createdAt: new Date().toISOString()
      };
      aiClientCapabilitySnapshots.set(
        `${actor.userId}:${input.instanceId}`,
        snapshot
      );
      return snapshot;
    },
    async listAiClientCapabilitySnapshots(
      actor
    ): Promise<AiClientCapabilitySnapshotDiagnosticRecord[]> {
      const now = Date.now();
      return [...aiClientCapabilitySnapshots.values()]
        .filter((snapshot) => snapshot.ownerUserId === actor.userId)
        .map((snapshot) => ({
          ...snapshot,
          stale: Date.parse(snapshot.expiresAt) <= now
        }))
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },
    async listCurrentAiClientCapabilitySnapshots(actor) {
      const now = Date.now();
      return [...aiClientCapabilitySnapshots.values()]
        .filter(
          (snapshot) =>
            snapshot.ownerUserId === actor.userId &&
            Date.parse(snapshot.expiresAt) > now
        )
        .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    },
    async listLocalMemoryAgentSettings(actor) {
      return [...localMemoryAgentSettings.values()]
        .filter((setting) => setting.ownerUserId === actor.userId)
        .sort((left, right) => left.flowKey.localeCompare(right.flowKey));
    },
    async upsertLocalMemoryAgentSetting(actor, input) {
      const key = `${actor.userId}:${input.flowKey}`;
      const existing = localMemoryAgentSettings.get(key);
      const now = new Date().toISOString();
      const record: LocalMemoryAgentSettingRecord = {
        ownerUserId: actor.userId,
        flowKey: input.flowKey,
        provider: input.provider,
        aiClientInstanceId: input.aiClientInstanceId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        timeoutMs: input.timeoutMs,
        maxAttempts: input.maxAttempts,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      localMemoryAgentSettings.set(key, record);
      return record;
    },
    async deleteLocalMemoryAgentSetting(actor, flowKey) {
      return localMemoryAgentSettings.delete(`${actor.userId}:${flowKey}`);
    },
    async createMemoryNode(actor: ActorContext, input: CreateMemoryNodeInput) {
      const record: MemoryNodeRecord = {
        id: randomUUID(),
        ownerUserId: actor.userId,
        visibility: input.visibility,
        title: input.title ?? null,
        summaryText: input.summaryText
      };
      memories.push(record);
      return record;
    },
    async getEffectiveCapturePolicy(actor, input = {}) {
      const session = input.sessionId
        ? capturedSessions.get(input.sessionId)
        : null;
      const projectId = input.projectId ?? session?.project?.id ?? undefined;
      const threadIds = [
        input.threadId,
        input.sessionId,
        session?.externalSessionId
      ].filter(Boolean);
      const matching = policies
        .filter((policy) => policy.ownerUserId === actor.userId)
        .filter(
          (policy) =>
            policy.targetType === "global" ||
            (policy.targetType === "project" &&
              policy.projectId === projectId) ||
            (policy.targetType === "thread" &&
              threadIds.includes(policy.threadId ?? ""))
        )
        .sort((left, right) => {
          const priority = { global: 1, project: 2, thread: 3 };
          return priority[right.targetType] - priority[left.targetType];
        });
      const effective = matching[0] ?? null;
      const global = matching.find((policy) => policy.targetType === "global");
      const pauseUntil = effective?.pauseUntil ?? global?.pauseUntil ?? null;
      const paused = pauseUntil
        ? new Date(pauseUntil).getTime() > Date.now()
        : false;
      return {
        captureState: paused
          ? "disabled"
          : (effective?.captureState ?? global?.captureState ?? "enabled"),
        visibility: effective?.visibility ?? global?.visibility ?? "personal",
        paused,
        pauseUntil,
        source: effective?.targetType ?? (global ? "global" : "default"),
        policy: effective
      };
    },
    async listCapturePolicies(actor, targetType) {
      return policies.filter(
        (policy) =>
          policy.ownerUserId === actor.userId &&
          (!targetType || policy.targetType === targetType)
      );
    },
    async upsertCapturePolicy(actor, input) {
      const existing = policies.find(
        (policy) =>
          policy.ownerUserId === actor.userId &&
          policy.targetType === input.targetType &&
          (policy.projectId ?? "") === (input.projectId ?? "") &&
          (policy.threadId ?? "") === (input.threadId ?? "")
      );
      const now = new Date().toISOString();
      const record = {
        id: existing?.id ?? randomUUID(),
        ownerUserId: actor.userId,
        targetType: input.targetType,
        projectId: input.projectId ?? null,
        projectName: input.projectName ?? null,
        projectPath: input.projectPath ?? null,
        threadId: input.threadId ?? null,
        threadName: input.threadName ?? null,
        captureState: input.captureState ?? null,
        visibility: input.visibility ?? null,
        pauseUntil:
          input.pauseUntil instanceof Date
            ? input.pauseUntil.toISOString()
            : (input.pauseUntil ?? null),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing) {
        Object.assign(existing, record);
        return existing;
      }
      policies.push(record);
      return record;
    },
    async deleteCapturePolicy(actor, policyId) {
      const index = policies.findIndex(
        (policy) =>
          policy.id === policyId && policy.ownerUserId === actor.userId
      );
      if (index === -1) return false;
      policies.splice(index, 1);
      return true;
    },
    async getVisibleMemoryNode(actor: ActorContext, nodeId: string) {
      return (
        memories.find((memory) => {
          if (invalidatedNodes.has(memory.id)) return false;
          if (memory.id !== nodeId) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return false;
        }) ?? null
      );
    },
    async listVisibleMemoryNodes(actor: ActorContext, visibility?: Visibility) {
      return memories.filter((memory) => {
        if (invalidatedNodes.has(memory.id)) return false;
        if (visibility && memory.visibility !== visibility) {
          return false;
        }
        if (memory.visibility === "personal") {
          return memory.ownerUserId === actor.userId;
        }
        return false;
      });
    },
    async getLocalEmbeddingStatus() {
      return {
        enabled: true,
        healthy: false,
        model: null,
        dimensions: null,
        error: "test repository"
      };
    },
    async listMemoryBrowserItems(actor, input = {}) {
      return memories
        .filter((memory) => {
          if (input.visibility && memory.visibility !== input.visibility)
            return false;
          if (invalidatedNodes.has(memory.id)) return false;
          if (
            input.pinned !== undefined &&
            Boolean(memory.pinnedAt) !== input.pinned
          )
            return false;
          if (
            input.query &&
            !memory.summaryText
              .toLowerCase()
              .includes(input.query.toLowerCase())
          )
            return false;
          if (memory.visibility === "personal")
            return memory.ownerUserId === actor.userId;
          return false;
        })
        .slice(0, input.limit ?? 100)
        .map((memory) => ({
          id: memory.id,
          clusterId:
            memory.summaryText.toLowerCase().includes("football") ||
            memory.summaryText.toLowerCase().includes("tennis")
              ? "sports"
              : "general",
          clusterLabel:
            memory.summaryText.toLowerCase().includes("football") ||
            memory.summaryText.toLowerCase().includes("tennis")
              ? "Sports"
              : "General",
          text: memory.summaryText,
          title: memory.title,
          visibility: memory.visibility,
          createdAt: memory.createdAt ?? new Date().toISOString(),
          updatedAt: memory.updatedAt ?? new Date().toISOString(),
          pinnedAt: memory.pinnedAt ?? null,
          projectId: memory.projectId ?? null,
          projectName: memory.projectName ?? null,
          projectPath: memory.projectPath ?? null,
          threadId: memory.threadId ?? null,
          threadName: memory.threadName ?? null
        }));
    },
    async listMemoryClusters(actor, input = {}) {
      const items = await this.listMemoryBrowserItems!(actor, input);
      const groups = new Map<
        string,
        {
          id: string;
          label: string;
          count: number;
          latestUpdatedAt: string;
          pinnedCount: number;
          items: typeof items;
        }
      >();
      for (const item of items) {
        const group = groups.get(item.clusterId);
        if (group) {
          group.count += 1;
          group.items.push(item);
        } else {
          groups.set(item.clusterId, {
            id: item.clusterId,
            label: item.clusterLabel,
            count: 1,
            latestUpdatedAt: item.updatedAt,
            pinnedCount: item.pinnedAt ? 1 : 0,
            items: [item]
          });
        }
      }
      return [...groups.values()];
    },
    async listMemoriesInCluster(actor, clusterId, input = {}) {
      const items = await this.listMemoryBrowserItems!(actor, input);
      return items.filter((item) => item.clusterId === clusterId);
    },
    async updateMemoryPresentation(actor, nodeId, input) {
      const memory = await this.getVisibleMemoryNode!(actor, nodeId);
      if (!memory) return null;
      if (input.summaryText) memory.summaryText = input.summaryText;
      if (input.pinned !== undefined)
        memory.pinnedAt = input.pinned ? new Date().toISOString() : null;
      if (input.visibility) memory.visibility = input.visibility;
      return (
        (await this.listMemoryBrowserItems!(actor)).find(
          (item) => item.id === nodeId
        ) ?? null
      );
    },
    async deleteMemory(actor, nodeId) {
      const memory = await this.getVisibleMemoryNode!(actor, nodeId);
      if (!memory) return false;
      invalidatedNodes.add(memory.id);
      return true;
    },
    async getLcmGraphOverview(actor) {
      const visibleNodes = await this.listLcmGraphNodes!(actor, {
        includeInvalidated: true
      });
      const visibleEvents = await this.listLcmGraphEvents!(actor, {
        includeInvalidated: true
      });
      return {
        capturedEvents: visibleEvents.filter((event) => !event.invalidatedAt)
          .length,
        leafNodes: visibleNodes.filter(
          (node) => node.kind === "leaf" && !node.invalidatedAt
        ).length,
        rollupNodes: visibleNodes.filter(
          (node) => node.kind === "rollup" && !node.invalidatedAt
        ).length,
        pendingSummaries: visibleNodes.filter(
          (node) => node.summaryStatus === "pending" && !node.invalidatedAt
        ).length,
        pendingLcmDiagnostics: {
          pendingCount: visibleNodes.filter(
            (node) => node.summaryStatus === "pending" && !node.invalidatedAt
          ).length,
          oldestPendingCreatedAt: null,
          staleThresholdMinutes: 15,
          stale: false
        },
        invalidatedRecords:
          visibleNodes.filter((node) => node.invalidatedAt).length +
          visibleEvents.filter((event) => event.invalidatedAt).length,
        embeddings: {
          enabled: true,
          healthy: false,
          model: null,
          dimensions: null,
          total: 0,
          memoryNodes: 0,
          memoryEvents: 0,
          messages: 0
        }
      };
    },
    async listLcmGraphNodes(actor, input = {}) {
      return memories
        .filter((memory) => {
          if (!input.includeInvalidated && invalidatedNodes.has(memory.id))
            return false;
          if (input.visibility && memory.visibility !== input.visibility)
            return false;
          if (
            input.query &&
            memory.id !== input.query &&
            !memory.summaryText
              .toLowerCase()
              .includes(input.query.toLowerCase())
          )
            return false;
          if (memory.visibility === "personal")
            return memory.ownerUserId === actor.userId;
          return false;
        })
        .slice(0, input.limit ?? 100)
        .map((memory) => ({
          id: memory.id,
          kind: "leaf" as const,
          depth: 0,
          summaryText: memory.summaryText,
          summaryStatus: summaryCorrections.has(memory.id)
            ? ("summarized" as const)
            : ("pending" as const),
          visibility: memory.visibility,
          ownerUserId: memory.ownerUserId,
          projectId: memory.projectId ?? null,
          projectName: memory.projectName ?? null,
          projectPath: memory.projectPath ?? null,
          sessionId: null,
          threadId: memory.threadId ?? null,
          threadName: memory.threadName ?? null,
          createdAt: memory.createdAt ?? new Date().toISOString(),
          updatedAt: memory.updatedAt ?? new Date().toISOString(),
          invalidatedAt: invalidatedNodes.has(memory.id)
            ? new Date().toISOString()
            : null,
          invalidationReason: invalidatedNodes.has(memory.id)
            ? "user_deleted"
            : null,
          sourceEventCount: nodeSources.get(memory.id)?.length ?? 0,
          sourceTokenEstimate: null,
          summaryTokenEstimate: null,
          summaryModel: summaryCorrections.get(memory.id) ?? null,
          summaryPromptVersion: null,
          summaryStructuredJson: null,
          summaryStructuredSchemaVersion: null,
          lcmAlgorithmVersion: "test-lcm",
          embeddingCount: 0,
          summaryCorrectedAt: summaryCorrections.has(memory.id)
            ? new Date().toISOString()
            : null,
          summaryCorrectedByUserId: summaryCorrections.has(memory.id)
            ? actor.userId
            : null
        }));
    },
    async getLcmGraphNode(actor, nodeId, input = {}) {
      const node = (
        await this.listLcmGraphNodes!(actor, {
          includeInvalidated: input.includeInvalidated,
          query: nodeId,
          limit: 1
        })
      ).find((candidate) => candidate.id === nodeId);
      if (!node) return null;
      const sourceIds = nodeSources.get(nodeId) ?? [];
      const sources = (
        await this.listLcmGraphEvents!(actor, {
          includeInvalidated: true,
          limit: 500
        })
      ).filter((event) => sourceIds.includes(event.id));
      return {
        ...node,
        sourceItems: sourceIds.map((eventId, position) => ({
          kind: "memory_event" as const,
          sourceTable: "memory_events" as const,
          sourceId: eventId,
          position
        })),
        sources,
        childNodes: [],
        parentNodes: []
      };
    },
    async updateLcmGraphNode(actor, nodeId, input) {
      const memory = await this.getVisibleMemoryNode!(actor, nodeId);
      if (!memory) return null;
      if (input.summaryText) {
        memory.summaryText = input.summaryText;
        memory.updatedAt = new Date().toISOString();
        summaryCorrections.set(nodeId, "user-corrected");
      }
      if (input.visibility) memory.visibility = input.visibility;
      return this.getLcmGraphNode!(actor, nodeId);
    },
    async invalidateLcmGraphNode(actor, nodeId) {
      return this.deleteMemory!(actor, nodeId);
    },
    async listLcmGraphEvents(actor, input = {}) {
      return events
        .filter((event) => {
          if (!input.includeInvalidated && invalidatedEvents.has(event.id))
            return false;
          if (input.visibility && event.visibility !== input.visibility)
            return false;
          if (
            input.query &&
            event.id !== input.query &&
            !event.content.toLowerCase().includes(input.query.toLowerCase())
          )
            return false;
          const session = event.sessionId
            ? capturedSessions.get(event.sessionId)
            : undefined;
          const projectId = session
            ? (session.project?.id ?? "unassigned")
            : event.projectId;
          const projectPath = session?.project?.path ?? null;
          const threadId =
            typeof event.metadata.externalSessionId === "string"
              ? event.metadata.externalSessionId
              : event.sessionId;
          if (
            input.projectId &&
            projectId !== input.projectId &&
            projectPath !== input.projectId
          )
            return false;
          if (input.threadId && threadId !== input.threadId) return false;
          if (event.visibility === "personal")
            return event.ownerUserId === actor.userId;
          return false;
        })
        .sort(
          (left, right) =>
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id)
        )
        .filter((event) => {
          if (!input.cursorTimestamp) return true;
          return (
            event.createdAt < input.cursorTimestamp ||
            (event.createdAt === input.cursorTimestamp &&
              input.cursorId !== undefined &&
              event.id < input.cursorId)
          );
        })
        .slice(0, input.limit ?? 100)
        .map((event) => {
          const session = event.sessionId
            ? capturedSessions.get(event.sessionId)
            : undefined;
          const threadKind =
            event.metadata.threadKind ?? session?.metadata.threadKind;
          const graphActor =
            threadKind === "subagent" && event.actor === "user"
              ? "agent"
              : threadKind === "subagent" && event.actor === "assistant"
                ? "subagent"
                : event.metadata.transcriptType === "agent_message" &&
                    event.actor === "assistant"
                  ? "agent"
                  : event.actor;
          return {
            id: event.id,
            actor: graphActor,
            eventType: event.eventType,
            sourceRuntime: "codex-cli" as const,
            captureMethod: "transcript" as const,
            model: null,
            projectId: session
              ? (session.project?.id ?? "unassigned")
              : event.projectId,
            projectName:
              session?.project?.name ??
              (typeof event.metadata.projectName === "string"
                ? event.metadata.projectName
                : session
                  ? "Unassigned"
                  : null),
            projectPath:
              session?.project?.path ??
              (typeof event.metadata.projectPath === "string"
                ? event.metadata.projectPath
                : null),
            sessionId: event.sessionId,
            threadId:
              typeof event.metadata.externalSessionId === "string"
                ? event.metadata.externalSessionId
                : event.sessionId,
            threadName:
              typeof event.metadata.threadName === "string"
                ? event.metadata.threadName
                : null,
            timestamp: event.createdAt,
            sourceEventTime: null,
            sourceSequence: null,
            capturedAt: event.createdAt,
            createdAt: event.createdAt,
            visibility: event.visibility,
            invalidatedAt: invalidatedEvents.has(event.id)
              ? new Date().toISOString()
              : null,
            invalidationReason: invalidatedEvents.has(event.id)
              ? "user_deleted"
              : null,
            contentPreview:
              event.content.length > 220
                ? `${event.content.slice(0, 217)}...`
                : event.content,
            ...(input.includeContent ? { content: event.content } : {}),
            ...(input.includeRaw || input.query === event.id
              ? { rawContent: event.content }
              : {}),
            metadata: event.metadata,
            linkedNodeIds: [...nodeSources.entries()]
              .filter(([, ids]) => ids.includes(event.id))
              .map(([nodeId]) => nodeId)
          };
        });
    },
    async listLcmGraphThreads(actor, input = {}) {
      const visibleEvents = await this.listLcmGraphEvents!(actor, {
        ...input,
        limit: 500
      });
      const projectMap = new Map<
        string,
        {
          id: string;
          name: string;
          path: string | null;
          eventCount: number;
          threads: Array<{
            id: string;
            name: string;
            sessionId: string | null;
            sourceAiClient: CapturedSessionRecord["sourceRuntime"] | null;
            projectId: string;
            projectName: string;
            projectPath: string | null;
            projectAssignmentSource: "detected" | "user_override" | null;
            capturedProjectProvenance: Record<string, unknown>;
            eventCount: number;
            invalidatedCount: number;
            latestAt: string;
            sample: string;
            threadKind: "conversation" | "subagent";
            parentThreadId: string | null;
            parentSessionId: string | null;
          }>;
        }
      >();
      const threadMap = new Map<
        string,
        {
          id: string;
          name: string;
          sessionId: string | null;
          sourceAiClient: CapturedSessionRecord["sourceRuntime"] | null;
          projectId: string;
          projectName: string;
          projectPath: string | null;
          projectAssignmentSource: "detected" | "user_override" | null;
          capturedProjectProvenance: Record<string, unknown>;
          eventCount: number;
          invalidatedCount: number;
          latestAt: string;
          sample: string;
          threadKind: "conversation" | "subagent";
          parentThreadId: string | null;
          parentSessionId: string | null;
        }
      >();

      for (const event of visibleEvents) {
        const session = event.sessionId
          ? capturedSessions.get(event.sessionId)
          : undefined;
        const projectId =
          event.projectId ?? event.projectPath ?? "unknown-project";
        const projectName =
          event.projectName ?? event.projectPath ?? "Unknown project";
        const project = projectMap.get(projectId) ?? {
          id: projectId,
          name: projectName,
          path: event.projectPath,
          eventCount: 0,
          threads: []
        };
        const threadId = event.threadId ?? event.sessionId ?? event.id;
        const threadMapKey = `${projectId}:${threadId}`;
        let thread = threadMap.get(threadMapKey);
        if (!thread) {
          thread = {
            id: threadId,
            name:
              event.threadName ??
              event.threadId ??
              event.sessionId ??
              "Untitled conversation",
            sessionId: event.sessionId,
            sourceAiClient:
              session?.sourceRuntime ?? event.sourceRuntime ?? null,
            projectId,
            projectName,
            projectPath: event.projectPath,
            projectAssignmentSource: session?.projectAssignmentSource ?? null,
            capturedProjectProvenance: session?.capturedProjectProvenance ?? {},
            eventCount: 0,
            invalidatedCount: 0,
            latestAt: event.timestamp,
            sample: event.contentPreview as string,
            threadKind:
              event.metadata.threadKind === "subagent"
                ? "subagent"
                : "conversation",
            parentThreadId:
              typeof event.metadata.parentThreadId === "string"
                ? event.metadata.parentThreadId
                : null,
            parentSessionId:
              typeof event.metadata.parentSessionId === "string"
                ? event.metadata.parentSessionId
                : null
          };
          threadMap.set(threadMapKey, thread);
          project.threads.push(thread);
        }
        project.eventCount += 1;
        thread.eventCount += 1;
        if (event.invalidatedAt) {
          thread.invalidatedCount += 1;
        }
        if (event.timestamp > thread.latestAt) {
          thread.name =
            event.threadName ??
            event.threadId ??
            event.sessionId ??
            "Untitled conversation";
          thread.projectName = projectName;
          thread.latestAt = event.timestamp;
          thread.sample = event.contentPreview as string;
        }
        projectMap.set(projectId, project);
      }

      for (const session of capturedSessions.values()) {
        if (input.visibility && session.visibility !== input.visibility)
          continue;
        if (
          session.visibility === "personal" &&
          session.ownerUserId !== actor.userId
        )
          continue;
        const projectId = session.project?.id ?? "unassigned";
        const projectName = session.project?.name ?? "Unassigned";
        const threadId =
          (typeof session.metadata.externalSessionId === "string"
            ? session.metadata.externalSessionId
            : null) ??
          session.externalSessionId ??
          session.id;
        if (input.projectId && projectId !== input.projectId) continue;
        if (input.threadId && threadId !== input.threadId) continue;
        if (
          input.query &&
          session.id !== input.query &&
          !threadId.toLowerCase().includes(input.query.toLowerCase()) &&
          !projectName.toLowerCase().includes(input.query.toLowerCase())
        )
          continue;
        const project = projectMap.get(projectId) ?? {
          id: projectId,
          name: projectName,
          path: session.project?.path ?? null,
          eventCount: 0,
          threads: []
        };
        const threadMapKey = `${projectId}:${threadId}`;
        if (!threadMap.has(threadMapKey)) {
          const thread = {
            id: threadId,
            name:
              (typeof session.metadata.threadName === "string"
                ? session.metadata.threadName
                : null) ??
              session.externalSessionId ??
              "Untitled conversation",
            sessionId: session.id,
            sourceAiClient: session.sourceRuntime,
            projectId,
            projectName,
            projectPath: session.project?.path ?? null,
            projectAssignmentSource: session.projectAssignmentSource,
            capturedProjectProvenance: session.capturedProjectProvenance,
            eventCount: 0,
            invalidatedCount: 0,
            latestAt: session.createdAt,
            sample: "",
            threadKind:
              session.metadata.threadKind === "subagent"
                ? ("subagent" as const)
                : ("conversation" as const),
            parentThreadId:
              typeof session.metadata.parentThreadId === "string"
                ? session.metadata.parentThreadId
                : null,
            parentSessionId:
              typeof session.metadata.parentSessionId === "string"
                ? session.metadata.parentSessionId
                : null
          };
          threadMap.set(threadMapKey, thread);
          project.threads.push(thread);
        }
        projectMap.set(projectId, project);
      }

      const limitedThreads = [...threadMap.values()]
        .sort((left, right) => right.latestAt.localeCompare(left.latestAt))
        .slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? 100));
      const limitedThreadIds = new Set(
        limitedThreads.map((thread) => `${thread.projectId}:${thread.id}`)
      );

      return [...projectMap.values()]
        .map((project) => {
          const threads = project.threads
            .filter((thread) =>
              limitedThreadIds.has(`${thread.projectId}:${thread.id}`)
            )
            .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
          return {
            ...project,
            eventCount: threads.reduce(
              (total, thread) => total + thread.eventCount,
              0
            ),
            threads
          };
        })
        .filter((project) => project.threads.length > 0)
        .sort((left, right) => {
          const leftLatest = left.threads[0]?.latestAt ?? "";
          const rightLatest = right.threads[0]?.latestAt ?? "";
          return rightLatest.localeCompare(leftLatest);
        });
    },
    async getLcmGraphEvent(actor, eventId, input = {}) {
      const event = (
        await this.listLcmGraphEvents!(actor, {
          includeInvalidated: input.includeInvalidated,
          query: eventId,
          limit: 1
        })
      ).find((candidate) => candidate.id === eventId);
      return event && input.includeRaw
        ? {
            ...event,
            rawContent:
              events.find((candidate) => candidate.id === eventId)?.content ??
              ""
          }
        : (event ?? null);
    },
    async updateLcmGraphEvent(actor, eventId, input) {
      const event = await this.getLcmGraphEvent!(actor, eventId);
      if (!event) return null;
      const raw = events.find((candidate) => candidate.id === eventId);
      if (raw && input.visibility) raw.visibility = input.visibility;
      if (input.invalidated) invalidatedEvents.add(eventId);
      return this.getLcmGraphEvent!(actor, eventId, {
        includeInvalidated: Boolean(input.invalidated)
      });
    },
    async invalidateLcmGraphEvent(actor, eventId) {
      const event = await this.getLcmGraphEvent!(actor, eventId);
      if (!event) return false;
      invalidatedEvents.add(eventId);
      return true;
    },
    async exportMemoryRecords(actor) {
      const overview = await this.getLcmGraphOverview!(actor);
      const nodes = await Promise.all(
        (
          await this.listLcmGraphNodes!(actor, { includeInvalidated: true })
        ).map((node) =>
          this.getLcmGraphNode!(actor, node.id, { includeInvalidated: true })
        )
      );
      return {
        exportedAt: new Date().toISOString(),
        overview,
        nodes: nodes.filter((node): node is NonNullable<typeof node> =>
          Boolean(node)
        ),
        events: await this.listLcmGraphEvents!(actor, {
          includeInvalidated: true
        }),
        curatedMemory: {
          topics: [],
          assertions: [],
          proposals: []
        }
      };
    },
    async listSourcesNeedingEmbeddings() {
      return [];
    },
    async getEmbeddableSource() {
      return null;
    },
    async getLcmNodeForSummarization() {
      return null;
    },
    async listLcmNodesNeedingSummaries() {
      return [];
    },
    async claimLcmNodesForSummarization() {
      return [];
    },
    async renewLcmSummaryWorkClaim() {
      return null;
    },
    async getVisibleLcmNodeForSummarization() {
      return null;
    },
    async updateLcmNodeSummary() {},
    async upsertSourceEmbedding() {
      return { id: randomUUID(), inserted: true };
    },
    async createMemoryEvent(actor, input) {
      if (input.sessionId) {
        const session = capturedSessions.get(input.sessionId);
        if (!session || session.ownerUserId !== actor.userId) {
          throw new Error("Session not found or not visible");
        }
      }
      const duplicateId =
        (input.idempotencyKey
          ? eventIdempotencyKeys.get(input.idempotencyKey)
          : undefined) ??
        (input.sourceHash
          ? eventSourceHashes.get(input.sourceHash)
          : undefined);
      const duplicate = duplicateId
        ? events.find((event) => event.id === duplicateId)
        : undefined;
      if (duplicate) {
        return duplicate;
      }
      const event: MemoryEventRecord = {
        id: randomUUID(),
        projectId: input.projectId,
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        actor: input.actor as MemoryActor,
        eventType: input.rawEventType,
        content: input.content,
        metadata: input.metadata ?? {},
        visibility: input.visibility,
        ownerUserId: actor.userId,
        createdAt: new Date(Date.now() + events.length).toISOString()
      };
      events.push(event);
      if (input.idempotencyKey) {
        eventIdempotencyKeys.set(input.idempotencyKey, event.id);
      }
      if (input.sourceHash) {
        eventSourceHashes.set(input.sourceHash, event.id);
      }
      return event;
    },
    async searchMemoryNodes(actor, input) {
      const results = memories
        .filter((memory) => {
          if (memory.visibility !== input.scope) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return false;
        })
        .filter((memory) =>
          memory.summaryText.toLowerCase().includes(input.query.toLowerCase())
        )
        .slice(0, input.limit ?? 10)
        .map(
          (memory): MemorySearchResult => ({
            nodeId: memory.id,
            visibility: memory.visibility,
            summaryText: memory.summaryText,
            score: 1,
            citation: { nodeId: memory.id, visibility: memory.visibility }
          })
        );
      return {
        results,
        metadata: {
          retrievalMode: "semantic_vector",
          vectorHitsCount: 0,
          textHitsCount: 0,
          embeddingModel: null,
          embeddingDimensions: null
        }
      };
    },
    async createLcmNodes(actor) {
      const uncompacted = events.filter((event) => {
        const visible = event.ownerUserId === actor.userId;
        return (
          visible &&
          ![...nodeSources.values()].some((sourceIds) =>
            sourceIds.includes(event.id)
          )
        );
      });
      const leafNodeIds = uncompacted.map((event) => {
        const node: MemoryNodeRecord = {
          id: randomUUID(),
          ownerUserId: actor.userId,
          visibility: event.visibility,
          title: null,
          summaryText: event.content,
          createdAt: event.createdAt,
          updatedAt: event.createdAt,
          pinnedAt: null,
          projectId: event.projectId,
          projectName:
            typeof event.metadata.projectName === "string"
              ? event.metadata.projectName
              : null,
          projectPath:
            typeof event.metadata.projectPath === "string"
              ? event.metadata.projectPath
              : event.projectId,
          threadId:
            typeof event.metadata.externalSessionId === "string"
              ? event.metadata.externalSessionId
              : event.sessionId,
          threadName:
            typeof event.metadata.threadName === "string"
              ? event.metadata.threadName
              : null
        };
        memories.push(node);
        nodeSources.set(node.id, [event.id]);
        return node.id;
      });
      return { leafNodeIds, rollupNodeId: null };
    },
    async expandMemoryNode(nodeId, actor) {
      const node =
        memories.find((memory) => {
          if (memory.id !== nodeId) {
            return false;
          }
          if (memory.visibility === "personal") {
            return memory.ownerUserId === actor.userId;
          }
          return false;
        }) ?? null;
      if (!node) {
        throw new Error("Memory node not found or not visible");
      }
      return {
        nodeId,
        visibility: node.visibility,
        sourceItems: (nodeSources.get(nodeId) ?? []).map(
          (eventId, position) => ({
            kind: "memory_event",
            sourceTable: "memory_events",
            sourceId: eventId,
            position
          })
        ),
        sources: (nodeSources.get(nodeId) ?? []).map(
          (eventId) => events.find((event) => event.id === eventId)!
        )
      } satisfies ExpandedMemoryNode;
    }
  } satisfies Partial<MemorySourceRepository>;
  const repositoryWithSourceRegistration = repository as typeof repository &
    Pick<
      MemorySourceRepository,
      "ensureConversationSourceArtifactForCapturedSession"
    >;
  repositoryWithSourceRegistration.ensureConversationSourceArtifactForCapturedSession =
    async (actor, input) => {
      const session = await repository.createCapturedSession(
        actor,
        input.session
      );
      const artifact = await repository.ensureConversationSourceArtifact(
        actor,
        {
          ...input.artifact,
          sessionId: session.id
        }
      );
      return { session, artifact };
    };
  return repositoryWithSourceRegistration as unknown as MemorySourceRepository;
};

const createFakeEmbeddingCapacityRepository =
  (): EmbeddingCapacityRepository => ({
    async tryAcquireCalibrationLease() {
      return { async release() {} };
    },
    async getActiveProfile() {
      return null;
    },
    async getLatestUsableProfile() {
      return {
        id: "capacity-profile-test",
        poolKey: "default",
        profileKey: "a".repeat(64),
        profileVersion: "embedding-capacity-v1",
        capacityContractRevision: "embedding-capacity-v1",
        state: "usable",
        calibrationMode: "refined",
        modelKey: "qwen3-0.6b",
        modelArtifactHash: "unknown",
        embeddingDimensions: 1024,
        tokenizer: "qwen3",
        inputTransform: "query-document-v1",
        pooling: "last-token",
        normalization: "l2",
        runtimeKind: "llama-server",
        runtimeVersion: "test",
        backendClass: "cpu",
        hardwareFingerprint: "b".repeat(64),
        settingsFingerprint: "c".repeat(64),
        runtimeSettings: {
          parallel: 1,
          modelPath: "/private/operator/models/customer-model.gguf"
        },
        sampleMeasurements: [
          {
            targetTokenClass: 1024,
            measuredTokenCount: 1_000,
            durationMs: 500
          }
        ],
        testedConcurrency: 1,
        sampleCount: 12,
        measuredTokenCount: 12_000,
        durationMs: 6_000,
        measuredTokensPerSecond: 2_000,
        p50LatencyMs: 100,
        p95LatencyMs: 150,
        failureCode: null,
        calibratedAt: "2026-07-31T00:00:00.000Z",
        invalidatedAt: null,
        invalidationReason: null
      };
    },
    async listActiveUsableProfiles() {
      const profile = await this.getLatestUsableProfile();
      return profile ? [profile] : [];
    },
    async replaceActiveProfile(input) {
      return {
        id: "capacity-profile-test",
        ...input,
        failureCode: input.failureCode ?? null,
        calibratedAt: "2026-07-31T00:00:00.000Z",
        invalidatedAt: null,
        invalidationReason: null
      };
    },
    async invalidateProfilesExcept() {
      return 0;
    },
    async heartbeatProfile() {
      return true;
    },
    async recordTelemetry() {},
    async getRollingTelemetry() {
      return [1, 5, 15].map((windowMinutes) => ({
        windowMinutes: windowMinutes as 1 | 5 | 15,
        arrivalEventCount: 3,
        eventCount: 2,
        memoryEventCount: 2,
        memoryNodeCount: 0,
        messageCount: 0,
        lcmCompactionCount: 1,
        chunkCount: 3,
        measuredTokenCount: 1_200,
        retries: 0,
        failures: 0,
        arrivalsPerMinute: 3 / windowMinutes,
        eventsPerMinute: 2 / windowMinutes,
        memoryEventsPerMinute: 2 / windowMinutes,
        memoryNodesPerMinute: 0,
        messagesPerMinute: 0,
        lcmCompactionsPerMinute: 1 / windowMinutes,
        measuredTokensPerSecond: 20 / windowMinutes,
        averageQueueWaitMs: 25,
        averageExecutionMs: 75,
        averageEndToEndMs: 100
      }));
    },
    async getCumulativeTelemetry() {
      return [
        {
          queueName: "memory-embed",
          sourceClass: "memory_event",
          outcome: "completed",
          eventCount: 2,
          chunkCount: 3,
          measuredTokenCount: 1_200,
          queueWaitMsTotal: 50,
          queueWaitSampleCount: 2,
          executionMsTotal: 150,
          executionSampleCount: 2,
          endToEndMsTotal: 200,
          endToEndSampleCount: 2
        }
      ];
    },
    async getSemanticBacklog() {
      return {
        pendingMemoryEvents: 4,
        pendingMemoryNodes: 2,
        pendingMessages: 0,
        pendingEstimatedTokens: 8_000,
        completedMeasuredTokens: 1_200
      };
    }
  });

describe("api health", () => {
  it("closes every memory job queue producer during shutdown", async () => {
    const closeByQueue = new Map<string, ReturnType<typeof vi.fn>>();
    const memoryJobQueueFactory = ((name: string) => {
      const close = vi.fn().mockResolvedValue(undefined);
      closeByQueue.set(name, close);
      return {
        add: vi.fn(),
        getJobCounts: vi.fn().mockResolvedValue({}),
        getOldestPendingAgeMs: vi.fn().mockResolvedValue(null),
        close
      };
    }) as NonNullable<BuildServerOptions["memoryJobQueueFactory"]>;
    const app = await buildServer({
      repository: createFakeRepository(),
      memoryJobQueueFactory
    });

    await app.close();

    expect([...closeByQueue.keys()]).toEqual([
      "memory-embed",
      "lcm-compact",
      "lcm-embed"
    ]);
    for (const close of closeByQueue.values()) {
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("invalidates graph cache for embedding updates without broadcasting them", () => {
    const embeddingPayload = {
      id: randomUUID(),
      operation: "INSERT",
      table: "memory_embeddings"
    } as const;
    const eventPayload = {
      id: randomUUID(),
      operation: "INSERT",
      table: "memory_events"
    } as const;
    const questionPayload = {
      id: randomUUID(),
      operation: "UPDATE",
      table: "memory_questions"
    } as const;

    expect(graphUpdateActionForPayload(embeddingPayload)).toEqual({
      broadcast: false,
      invalidateCache: true
    });
    expect(graphUpdateActionForPayload(eventPayload)).toEqual({
      broadcast: true,
      invalidateCache: true
    });
    expect(graphUpdateActionForPayload(questionPayload)).toEqual({
      broadcast: true,
      invalidateCache: false
    });
    expect(shouldIgnoreGraphStreamPayload(embeddingPayload)).toBe(true);
    expect(shouldIgnoreGraphStreamPayload(eventPayload)).toBe(false);
    expect(shouldIgnoreGraphStreamPayload(questionPayload)).toBe(false);
  });

  it("authorizes graph stream payloads by memory visibility", () => {
    const ownerId = randomUUID();
    const outsiderId = randomUUID();

    expect(
      canReceiveGraphStreamPayload(
        { userId: ownerId },
        {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: ownerId
        }
      )
    ).toBe(true);
    expect(
      canReceiveGraphStreamPayload(
        { userId: outsiderId },
        {
          table: "memory_events",
          visibility: "personal",
          ownerUserId: ownerId
        }
      )
    ).toBe(false);
    expect(
      canReceiveGraphStreamPayload(
        { userId: outsiderId },
        {
          table: "memory_events",
          visibility: "unsupported"
        }
      )
    ).toBe(false);
    expect(
      canReceiveGraphStreamPayload(
        { userId: outsiderId },
        {
          table: "drizzle.__drizzle_migrations"
        }
      )
    ).toBe(true);
  });

  it("returns OK", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("OK");
  });

  it("orients operators who open the API root", async () => {
    process.env.KOED_HOST_CHECKOUT_PATH = "/sensitive/local/path";
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "koed-api",
      status: "ok",
      routes: {
        health: "/health",
        readiness: "/ready",
        publicStatus: "/self-host/status",
        capabilities: "/v1/capabilities",
        openapi: "/openapi.json"
      }
    });
    expect(response.body).not.toContain("/sensitive/local/path");
  });

  it("returns a request id header and accepts safe caller-provided ids", async () => {
    const app = await buildServer();
    const generated = await app.inject({ method: "GET", url: "/health" });
    const provided = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "operator-request-1" }
    });
    await app.close();

    expect(generated.headers["x-request-id"]).toEqual(expect.any(String));
    expect(provided.headers["x-request-id"]).toBe("operator-request-1");
  });

  it("publishes a safe unauthenticated capability contract", async () => {
    process.env.KOED_HOST_CHECKOUT_PATH = "/sensitive/local/path";
    process.env.KOED_RUNTIME_MODE = "local-personal";
    process.env.KOED_DEPENDENCY_MODE = "bundled-local";
    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    await app.close();

    const capabilities = jsonBody<CapabilitiesResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(capabilities.releaseVersion).toBe(releaseManifest.version);
    expect(capabilities).toMatchObject({
      product: "koed",
      apiVersion: "v1",
      capabilitySchemaVersion: 6,
      audience: "public",
      deployment: {
        profile: "local_personal",
        distribution: "source_available",
        managedBy: "operator",
        productBoundary: "koed-server"
      },
      runtime: {
        localEdge: true,
        remoteUpstreams: "partial",
        dependencyMode: "bundled-local"
      },
      auth: {
        providers: ["local"],
        session: "available",
        apiTokens: "available",
        deviceEnrollment: "available",
        enrollment: {
          setupPath: "local_simple_api_token",
          deviceEnrollment: "available",
          apiTokenFallback: "personal_ai_client_only",
          authenticatedStatusEndpoint: "/v1/capabilities/authenticated",
          mcpAndCaptureHookTarget: "local_koed_server"
        }
      },
      memory: {
        personal: "available",
        teamWorkspaces: "unavailable",
        collaboration: "unavailable",
        shareGrants: "unavailable",
        crossIdentitySync: "unavailable",
        memoryInbox: "unavailable"
      },
      protocols: {
        collaborationRealtime: {
          version: COLLABORATION_CONTRACT_VERSION,
          transport: "sse",
          snapshotEndpoint: "/v1/collaboration/realtime/snapshot",
          streamEndpoint: "/v1/collaboration/realtime/stream",
          acknowledgementEndpoint: "/v1/collaboration/realtime/ack"
        }
      },
      commercial: {
        billingEntitlements: "unavailable",
        accessSuspension: "unavailable",
        supportAdmin: "unavailable",
        stateVocabulary: {
          entitlementStatuses: [
            "not_applicable",
            "not_requested",
            "active",
            "grace",
            "suspended",
            "revoked"
          ],
          billingStatuses: [
            "not_applicable",
            "not_requested",
            "inactive",
            "trial",
            "active",
            "grace",
            "pending_provider_update",
            "expired",
            "canceled",
            "over_limit",
            "suspended",
            "revoked",
            "error",
            "unsupported"
          ],
          billingSeatSyncStatuses: [
            "synced",
            "pending_provider_update",
            "over_limit",
            "error"
          ]
        },
        entitlement: {
          scope: "none",
          status: "not_applicable",
          allowsTeamAccess: null,
          deniedOperationFamilies: [],
          requiresAuthentication: false
        },
        billing: {
          scope: "none",
          status: "not_applicable",
          overLimit: null,
          seatSyncStatus: null,
          requiresAuthentication: false
        },
        featureGates: {
          teamWorkspaces: {
            capability: "memory.teamWorkspaces",
            availability: "unavailable",
            entitlementStatus: "not_applicable",
            billingStatus: "not_applicable",
            enforcement: "not_applicable",
            requiresAuthentication: false
          },
          collaboration: {
            capability: "memory.collaboration",
            availability: "unavailable",
            entitlementStatus: "not_applicable",
            billingStatus: "not_applicable",
            enforcement: "not_applicable",
            requiresAuthentication: false
          },
          memoryInbox: {
            capability: "memory.memoryInbox",
            availability: "unavailable",
            entitlementStatus: "not_applicable",
            billingStatus: "not_applicable",
            enforcement: "not_applicable",
            requiresAuthentication: false
          },
          teamLimits: {
            capability: "commercial.billingEntitlements",
            availability: "unavailable",
            entitlementStatus: "not_applicable",
            billingStatus: "not_applicable",
            enforcement: "not_applicable",
            requiresAuthentication: false
          }
        }
      },
      security: {
        applicationLayerEncryption: "unavailable",
        queryableVectors: "unavailable",
        objectStorage: "unavailable",
        deploymentTlsRequired: false
      },
      capabilities: {
        "clients.codex": {
          availability: "available"
        },
        "clients.electronBackendTarget": {
          availability: "available"
        },
        "memory.personal": {
          availability: "available"
        },
        "memory.captureHook": {
          availability: "available"
        },
        "memory.mcpRecall": {
          availability: "available"
        },
        "memory.curatedIntake": {
          availability: "available",
          endpoints: ["/v1/memory/curated/proposals"]
        },
        "memory.localLcmSummaries": {
          availability: "available"
        },
        "memory.teamWorkspaces": {
          availability: "unavailable"
        },
        "memory.collaboration": {
          availability: "unavailable",
          requiresAuthentication: true
        },
        "memory.shareGrants": {
          availability: "unavailable"
        },
        "operations.diagnostics": {
          availability: "available",
          requiresAuthentication: true
        },
        "auth.enrollment": {
          availability: "available",
          endpoints: ["/v1/capabilities", "/v1/capabilities/authenticated"]
        },
        "auth.deviceEnrollment": {
          availability: "available",
          requiresAuthentication: true
        }
      }
    });
    expect(capabilities.providers).toEqual(
      expect.arrayContaining([
        "deployment",
        "operations",
        "auth",
        "clients",
        "memory"
      ])
    );
    expect(capabilities.auth.providers).toEqual(["local"]);
    expect(capabilities.authenticatedCapabilities).toEqual({
      available: true,
      endpoint: "/v1/capabilities/authenticated"
    });
    expect(response.body).not.toContain("/sensitive/local/path");
    expect(response.body).not.toContain("DATABASE_URL");
    expect(response.body).not.toContain("API_TOKEN");
    expect(response.body).not.toContain("replace_with_generated");
    expect(response.body).not.toContain("WORKOS_API_KEY");
  });

  it("publishes cloud and Team self-hosted profile capabilities without route probing", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.KOED_DEPENDENCY_MODE = "server";
    process.env.WORKOS_AUTHKIT_ENABLED = "false";
    const cloudApp = await buildServer();
    const cloudResponse = await cloudApp.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    await cloudApp.close();

    const cloud = jsonBody<CapabilitiesResponse>(cloudResponse);
    expect(cloud).toMatchObject({
      deployment: {
        profile: "koed_managed_cloud",
        distribution: "managed_service",
        managedBy: "koed"
      },
      runtime: {
        localEdge: false,
        remoteUpstreams: "unavailable",
        dependencyMode: "server"
      },
      auth: {
        providers: [],
        session: "unavailable",
        deviceEnrollment: "available",
        enrollment: {
          setupPath: "remote_device_enrollment",
          deviceEnrollment: "available",
          apiTokenFallback: "personal_ai_client_only",
          authenticatedStatusEndpoint: "/v1/capabilities/authenticated",
          mcpAndCaptureHookTarget: "local_koed_server"
        }
      },
      memory: {
        teamWorkspaces: "partial",
        collaboration: "partial",
        shareGrants: "partial",
        crossIdentitySync: "unavailable"
      },
      commercial: {
        billingEntitlements: "partial",
        accessSuspension: "available",
        supportAdmin: "partial",
        entitlement: {
          scope: "team",
          status: "not_requested",
          allowsTeamAccess: null,
          deniedOperationFamilies: [],
          requiresAuthentication: true
        },
        billing: {
          scope: "team",
          status: "not_requested",
          overLimit: null,
          seatSyncStatus: null,
          requiresAuthentication: true
        },
        featureGates: {
          teamWorkspaces: {
            capability: "memory.teamWorkspaces",
            availability: "partial",
            entitlementStatus: "not_requested",
            billingStatus: "not_requested",
            enforcement: "server_side",
            requiresAuthentication: true
          },
          collaboration: {
            capability: "memory.collaboration",
            availability: "partial",
            entitlementStatus: "not_requested",
            billingStatus: "not_requested",
            enforcement: "server_side",
            requiresAuthentication: true
          },
          hostedOperations: {
            capability: "operations.hostedStatus",
            availability: "partial",
            entitlementStatus: "not_requested",
            billingStatus: "not_requested",
            enforcement: "server_side",
            requiresAuthentication: true
          },
          teamLimits: {
            capability: "commercial.billingEntitlements",
            availability: "partial",
            entitlementStatus: "not_requested",
            billingStatus: "not_requested",
            enforcement: "server_side",
            requiresAuthentication: true
          }
        }
      },
      security: {
        queryableVectors: "partial",
        objectStorage: "partial",
        deploymentTlsRequired: true
      }
    });
    expect(cloud.capabilities["auth.workos"]!.availability).toBe("unavailable");
    expect(cloud.capabilities["auth.deviceEnrollment"]!).toMatchObject({
      availability: "available",
      requiresAuthentication: true
    });
    expect(cloud.capabilities["memory.crossIdentitySync"]!.availability).toBe(
      "unavailable"
    );
    expect(cloudResponse.body).not.toContain("WORKOS_API_KEY");
    expect(cloudResponse.body).not.toContain("COOKIE_PASSWORD");

    process.env.KOED_DEPLOYMENT_PROFILE = "team-self-hosted";
    process.env.KOED_DEPENDENCY_MODE = "external";
    const teamApp = await buildServer();
    const teamResponse = await teamApp.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    await teamApp.close();

    const teamSelfHosted = jsonBody<CapabilitiesResponse>(teamResponse);
    expect(teamSelfHosted).toMatchObject({
      deployment: {
        profile: "team_self_hosted",
        distribution: "source_available",
        managedBy: "team_operator"
      },
      runtime: {
        localEdge: false,
        remoteUpstreams: "unavailable",
        dependencyMode: "external"
      },
      auth: {
        providers: ["local"],
        deviceEnrollment: "available",
        enrollment: {
          setupPath: "remote_device_enrollment",
          deviceEnrollment: "available",
          apiTokenFallback: "personal_ai_client_only",
          authenticatedStatusEndpoint: "/v1/capabilities/authenticated",
          mcpAndCaptureHookTarget: "local_koed_server"
        }
      },
      memory: {
        teamWorkspaces: "partial",
        collaboration: "partial",
        shareGrants: "partial"
      },
      commercial: {
        billingEntitlements: "unavailable",
        accessSuspension: "available",
        entitlement: {
          scope: "team",
          status: "not_requested",
          allowsTeamAccess: null,
          deniedOperationFamilies: []
        },
        billing: {
          scope: "team",
          status: "not_requested",
          overLimit: null,
          seatSyncStatus: null
        },
        featureGates: {
          teamWorkspaces: {
            capability: "memory.teamWorkspaces",
            availability: "partial",
            entitlementStatus: "not_requested",
            billingStatus: "not_requested",
            enforcement: "server_side"
          },
          teamLimits: {
            capability: "commercial.billingEntitlements",
            availability: "unavailable",
            entitlementStatus: "not_requested",
            billingStatus: "not_requested",
            enforcement: "server_side"
          }
        },
        supportAdmin: "unavailable"
      }
    });

    process.env.KOED_DEPLOYMENT_PROFILE = "private-vps";
    const privateVpsApp = await buildServer();
    const privateVpsResponse = await privateVpsApp.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    await privateVpsApp.close();

    const privateVps = jsonBody<CapabilitiesResponse>(privateVpsResponse);
    expect(privateVps).toMatchObject({
      deployment: {
        profile: "private_vps",
        distribution: "source_available",
        managedBy: "operator"
      },
      runtime: {
        localEdge: false,
        remoteUpstreams: "unavailable"
      },
      auth: {
        providers: ["local"],
        deviceEnrollment: "available",
        enrollment: {
          setupPath: "remote_device_enrollment",
          apiTokenFallback: "personal_ai_client_only"
        }
      },
      memory: {
        teamWorkspaces: "partial",
        collaboration: "partial",
        shareGrants: "partial"
      },
      commercial: {
        billingEntitlements: "unavailable",
        accessSuspension: "available",
        supportAdmin: "unavailable"
      }
    });
  });

  it("fails Team surfaces closed while Personal Memory remains routed when collaboration is disabled", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    process.env.KOED_TEAM_COLLABORATION_ENABLED = "false";
    const app = await buildServer();

    const capabilitiesResponse = await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    const teamResponse = await app.inject({
      method: "GET",
      url: "/v1/teams/sensitive-team-id"
    });
    const personalResponse = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      payload: { query: "personal memory remains routed" }
    });
    const personalCollaborationResponse = await app.inject({
      method: "GET",
      url: "/v1/collaboration/personal/threads"
    });
    await app.close();

    const capabilities = jsonBody<CapabilitiesResponse>(capabilitiesResponse);
    expect(capabilities.memory).toMatchObject({
      personal: "available",
      teamWorkspaces: "unavailable",
      collaboration: "unavailable",
      shareGrants: "unavailable",
      crossIdentitySync: "unavailable"
    });
    expect(capabilities.auth.apiTokens).toBe("available");
    expect(capabilities.auth.deviceEnrollment).toBe("unavailable");
    expect(
      capabilities.capabilities["memory.personalCollaboration"]
    ).toMatchObject({ availability: "available" });
    expect(teamResponse.statusCode).toBe(404);
    expect(teamResponse.body).toBe("");
    expect([401, 503]).toContain(personalResponse.statusCode);
    expect([401, 503]).toContain(personalCollaborationResponse.statusCode);
    for (const response of [personalResponse, personalCollaborationResponse]) {
      if (response.statusCode === 401) {
        expect(response.body).not.toContain("Database is not configured");
      } else {
        expect(response.body).toContain("Database is not configured");
      }
    }
  });

  it("gates Pending Share workers and does not poll activation work", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-worker-gate-"));
    process.env.KOED_HOME = koedHome;
    vi.useFakeTimers();
    const processPendingShares = vi.fn(async () => ({
      claimed: 0,
      activated: 0,
      failed: 0,
      deferred: 0
    }));
    const claimPendingShareSourceWork = vi.fn(async () => []);
    const authorityStore = {
      claimPendingShareSourceWork,
      finishPendingShareSourceWork: vi.fn(async () => true)
    } as unknown as NonNullable<
      BuildServerOptions["collaborationSharedMemoryAuthorityStore"]
    >;
    const repository = Object.assign(createFakeRepository(), {
      processPendingShares
    });

    process.env.KOED_TEAM_COLLABORATION_ENABLED = "false";
    const disabled = await buildServer({
      repository,
      collaborationSharedMemoryAuthorityStore: authorityStore
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processPendingShares).not.toHaveBeenCalled();
    expect(claimPendingShareSourceWork).not.toHaveBeenCalled();
    await disabled.close();

    process.env.KOED_TEAM_COLLABORATION_ENABLED = "true";
    const enabled = await buildServer({
      repository,
      collaborationSharedMemoryAuthorityStore: authorityStore
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(processPendingShares).toHaveBeenCalledTimes(1);
    expect(claimPendingShareSourceWork).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(processPendingShares).toHaveBeenCalledTimes(1);
    expect(claimPendingShareSourceWork).toHaveBeenCalledTimes(2);
    await enabled.close();
    vi.useRealTimers();
    rmSync(koedHome, { recursive: true, force: true });
  });

  it("advertises KMS-backed application-layer encryption when configured", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.API_ENVELOPE_ENCRYPTION_PROVIDER = "managed_kms";
    process.env.MANAGED_KMS_KEY_ID = "managed-kms:capability-key";
    process.env.MANAGED_KMS_KEY_VERSION = "3";
    process.env.MANAGED_KMS_ENDPOINT_URL = "http://localhost:19999/kms/";
    process.env.MANAGED_KMS_AUTH_TOKEN = "capability-token";

    const app = await buildServer({ repository: createFakeRepository() });
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    await app.close();

    const capabilities = jsonBody<CapabilitiesResponse>(response);

    expect(response.statusCode).toBe(200);
    expect(capabilities.deployment.profile).toBe("koed_managed_cloud");
    expect(capabilities.security.applicationLayerEncryption).toBe("available");
    expect(
      capabilities.capabilities["security.applicationLayerEncryption"]
    ).toMatchObject({
      availability: "available"
    });
  });

  it("rejects reusing one provider instance for owner-private replicas", async () => {
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      randomBytes(32).toString("base64")
    );

    await expect(
      buildServer({
        repository: createFakeRepository(),
        envelopeEncryptionProvider: provider,
        ownerPrivateReplicaEnvelopeEncryptionProvider: provider
      })
    ).rejects.toThrow(
      "Owner-private replica envelope encryption must use a distinct key"
    );
  });

  it("rejects separate providers that resolve to the same encryption key", async () => {
    const rootKey = randomBytes(32).toString("base64");

    await expect(
      buildServer({
        repository: createFakeRepository(),
        envelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(rootKey),
        ownerPrivateReplicaEnvelopeEncryptionProvider:
          createLocalTestKeyEnvelopeEncryptionProvider(rootKey)
      })
    ).rejects.toThrow(
      "Owner-private replica envelope encryption must use a distinct key"
    );
  });

  it("advertises WorkOS only when AuthKit is configured", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://cloud.example.test/auth/workos/callback";

    const app = await buildServer();
    const response = await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    await app.close();

    const capabilities = jsonBody<CapabilitiesResponse>(response);
    expect(capabilities.auth.providers).toEqual(["workos"]);
    expect(capabilities.auth.session).toBe("available");
    expect(capabilities.capabilities["auth.local"]!.availability).toBe(
      "unavailable"
    );
    expect(capabilities.capabilities["auth.workos"]!.availability).toBe(
      "partial"
    );
    expect(response.body).not.toContain("sk_test_hidden");
    expect(response.body).not.toContain("client_test_123");
  });

  it("does not expose WorkOS auth routes when the deployment profile does not support WorkOS", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "developer";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://cloud.example.test/auth/workos/callback";

    const app = await buildServer();
    const capabilities = await app.inject({
      method: "GET",
      url: "/v1/capabilities"
    });
    const login = await app.inject({
      method: "GET",
      url: "/auth/workos/login"
    });
    const callback = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code&state=state"
    });
    await app.close();

    expect(jsonBody<CapabilitiesResponse>(capabilities).auth.providers).toEqual(
      ["local"]
    );
    expect(login.statusCode).toBe(404);
    expect(callback.statusCode).toBe(404);
    expect(login.body).not.toContain("client_test_123");
    expect(login.body).not.toContain("sk_test_hidden");
  });

  it("requires session authentication for authenticated capabilities", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    const app = await buildServer({ repository: createFakeRepository() });
    const denied = await app.inject({
      method: "GET",
      url: "/v1/capabilities/authenticated"
    });
    const register = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "capability-user@example.test",
        password: "correct horse battery staple"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(register)),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const deniedBearer = await app.inject({
      method: "GET",
      url: "/v1/capabilities/authenticated",
      headers: { authorization: `Bearer ${token}` }
    });
    const allowed = await app.inject({
      method: "GET",
      url: "/v1/capabilities/authenticated",
      headers: browserSessionHeaders(cookieHeader(register))
    });
    await app.close();

    expect(denied.statusCode).toBe(401);
    expect(deniedBearer.statusCode).toBe(401);
    expect(jsonBody<{ error: string }>(deniedBearer).error).toBe(
      "Session cookie required"
    );
    expect(allowed.statusCode).toBe(200);
    expect(jsonBody<CapabilitiesResponse>(allowed)).toMatchObject({
      audience: "authenticated",
      capabilitySchemaVersion: 6
    });
  });

  it("reports Team entitlement state through authenticated capability discovery", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    configureTestWorkos();
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const cookie = await createVerifiedWorkosSessionForTest(
      repository,
      "capability-team-owner@example.test"
    );
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Capability Team" }
    });
    expect(createdTeam.statusCode, createdTeam.body).toBe(200);
    const createdTeamBody = jsonBody<TeamResponse>(createdTeam);
    const team = createdTeamBody.team;
    const initial = await app.inject({
      method: "GET",
      url: `/v1/capabilities/authenticated?teamId=${team.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const overLimitPolicy = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/billing-seats/policy`,
      headers: browserSessionHeaders(cookie),
      payload: { expectedVersion: 1, seatLimit: 0 }
    });
    const overLimit = await app.inject({
      method: "GET",
      url: `/v1/capabilities/authenticated?teamId=${team.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const suspended = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(cookie),
      payload: {
        expectedVersion: 2,
        status: "suspended",
        reason: "do_not_expose_this_reason"
      }
    });
    const blocked = await app.inject({
      method: "GET",
      url: `/v1/capabilities/authenticated?teamId=${team.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const unauthorized = await app.inject({
      method: "GET",
      url: `/v1/capabilities/authenticated?teamId=00000000-0000-4000-8000-000000000000`,
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(createdTeam.statusCode).toBe(200);
    expect(initial.statusCode).toBe(200);
    const initialCommercial =
      jsonBody<CapabilitiesResponse>(initial).commercial;
    expect(initialCommercial).toMatchObject({
      billingEntitlements: "partial",
      accessSuspension: "available",
      entitlement: {
        scope: "team",
        teamId: team.id,
        status: "active",
        allowsTeamAccess: true,
        deniedOperationFamilies: [],
        requiresAuthentication: true
      },
      billing: {
        scope: "team",
        status: "active",
        overLimit: false,
        seatSyncStatus: "synced",
        requiresAuthentication: true
      },
      featureGates: {
        teamWorkspaces: {
          capability: "memory.teamWorkspaces",
          availability: "partial",
          entitlementStatus: "active",
          billingStatus: "active",
          enforcement: "server_side",
          requiresAuthentication: false
        },
        collaboration: {
          capability: "memory.collaboration",
          availability: "partial",
          entitlementStatus: "active",
          billingStatus: "active",
          enforcement: "server_side",
          requiresAuthentication: false
        },
        memoryInbox: {
          capability: "memory.memoryInbox",
          availability: "unavailable",
          entitlementStatus: "active",
          billingStatus: "active",
          enforcement: "server_side",
          requiresAuthentication: false
        },
        teamLimits: {
          capability: "commercial.billingEntitlements",
          availability: "partial",
          entitlementStatus: "active",
          billingStatus: "active",
          enforcement: "server_side",
          requiresAuthentication: false
        }
      }
    });
    expect(initialCommercial.stateVocabulary.billingStatuses).toEqual(
      expect.arrayContaining([
        "trial",
        "inactive",
        "expired",
        "canceled",
        "over_limit",
        "unsupported"
      ])
    );
    expect(overLimitPolicy.statusCode).toBe(200);
    expect(overLimit.statusCode).toBe(200);
    expect(jsonBody<CapabilitiesResponse>(overLimit).commercial).toMatchObject({
      entitlement: {
        status: "grace",
        allowsTeamAccess: true
      },
      billing: {
        status: "over_limit",
        overLimit: true,
        seatSyncStatus: "over_limit",
        requiresAuthentication: true
      },
      featureGates: {
        teamWorkspaces: {
          entitlementStatus: "grace",
          billingStatus: "over_limit",
          enforcement: "server_side",
          requiresAuthentication: false
        },
        teamLimits: {
          entitlementStatus: "grace",
          billingStatus: "over_limit",
          enforcement: "server_side",
          requiresAuthentication: false
        }
      }
    });
    expect(suspended.statusCode).toBe(200);
    expect(blocked.statusCode).toBe(200);
    expect(jsonBody<CapabilitiesResponse>(blocked).commercial).toMatchObject({
      entitlement: {
        status: "suspended",
        allowsTeamAccess: false,
        deniedOperationFamilies: [
          "ingestion",
          "recall",
          "share",
          "sync",
          "team_admin"
        ]
      },
      featureGates: {
        teamWorkspaces: {
          entitlementStatus: "suspended",
          billingStatus: "over_limit",
          enforcement: "server_side",
          requiresAuthentication: false
        },
        shareGrants: {
          entitlementStatus: "suspended",
          billingStatus: "over_limit",
          enforcement: "server_side",
          requiresAuthentication: false
        }
      }
    });
    expect(blocked.body).not.toContain("do_not_expose_this_reason");
    expect(unauthorized.statusCode).toBe(403);
  });

  it("allows browser write preflight requests", async () => {
    const app = await buildServer();
    const patchResponse = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/questions/00000000-0000-4000-8000-000000000000",
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "PATCH"
      }
    });
    const putResponse = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/local-agent-settings/mcp_memory_answer",
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "PUT"
      }
    });
    const streamResponse = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/graph/stream",
      headers: {
        origin: "http://localhost:5174",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,accept"
      }
    });
    await app.close();

    expect(patchResponse.statusCode).toBe(204);
    expect(putResponse.statusCode).toBe(204);
    expect(streamResponse.statusCode).toBe(204);
    expect(patchResponse.headers["access-control-allow-methods"]).toContain(
      "PATCH"
    );
    expect(putResponse.headers["access-control-allow-methods"]).toContain(
      "PUT"
    );
    expect(streamResponse.headers["access-control-allow-methods"]).toContain(
      "GET"
    );
    expect(streamResponse.headers["access-control-allow-headers"]).toContain(
      "authorization"
    );
  });

  it("allows Electron graph preflight without allowing untrusted origins", async () => {
    process.env.CORS_ORIGINS = "koed://app";
    const app = await buildServer();
    const trusted = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/graph/stream",
      headers: {
        origin: "koed://app",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,accept"
      }
    });
    const untrusted = await app.inject({
      method: "OPTIONS",
      url: "/v1/memory/graph/stream",
      headers: {
        origin: "koed://app.evil",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,accept"
      }
    });
    await app.close();

    expect(trusted.statusCode).toBe(204);
    expect(trusted.headers["access-control-allow-origin"]).toBe("koed://app");
    expect(trusted.headers["access-control-allow-methods"]).toContain("GET");
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps public status probes coarse and requires auth for details", async () => {
    process.env.KOED_HOST_CHECKOUT_PATH = "/sensitive/local/path";
    process.env.WORK_QUEUE_BACKEND = "local";
    const app = await buildServer({ repository: createFakeRepository() });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const details = await app.inject({ method: "GET", url: "/health/details" });
    const publicStatus = await app.inject({
      method: "GET",
      url: "/self-host/status"
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "status@example.com", password: "password123" }
    });
    const privateStatus = await app.inject({
      method: "GET",
      url: "/self-host/status",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    await app.close();

    expect(ready.statusCode).toBe(503);
    expect(ready.body).not.toContain("test repository");
    expect(details.statusCode).toBe(401);
    expect(publicStatus.statusCode).toBe(200);
    expect(publicStatus.body).toContain("not_disclosed");
    expect(publicStatus.body).not.toContain("/sensitive/local/path");
    expect(privateStatus.statusCode).toBe(200);
    expect(privateStatus.body).not.toContain("/sensitive/local/path");
  });

  it("reports readiness error when embedding health is degraded", async () => {
    process.env.WORK_QUEUE_BACKEND = "local";
    const app = await buildServer({ repository: createFakeRepository() });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    const body = jsonBody<{
      status: "error";
      checks: Array<{ service: string; status: string; checkedAt: string }>;
    }>(ready);

    expect(ready.statusCode).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toContainEqual({
      service: "embedding-service",
      status: "degraded",
      checkedAt: expect.any(String) as string
    });
  });

  it("reports readiness error when BullMQ queue backend lacks Redis", async () => {
    delete process.env.REDIS_URL;
    process.env.WORK_QUEUE_BACKEND = "bullmq";
    const app = await buildServer({ repository: createFakeRepository() });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    await app.close();

    const body = jsonBody<{
      status: "error";
      checks: Array<{ service: string; status: string; checkedAt: string }>;
    }>(ready);

    expect(ready.statusCode).toBe(503);
    expect(body.status).toBe("error");
    expect(body.checks).toContainEqual({
      service: "redis",
      status: "error",
      checkedAt: expect.any(String) as string
    });
  });

  it("does not advertise planned AI clients in self-host status", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "client-status@example.com", password: "password123" }
    });
    const response = await app.inject({
      method: "GET",
      url: "/self-host/status",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    await app.close();

    const status = jsonBody<{
      configuration: {
        supportedClients: string[];
        plannedClients?: string[];
      };
    }>(response);

    expect(response.statusCode).toBe(200);
    expect(status.configuration).not.toHaveProperty("plannedClients");
  });

  it("uses separate memory rate-limit buckets with Retry-After headers", async () => {
    process.env.MEMORY_READ_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_READ_RATE_LIMIT_MAX = "1";
    process.env.MEMORY_WRITE_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_WRITE_RATE_LIMIT_MAX = "2";
    process.env.MEMORY_RECALL_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_RECALL_RATE_LIMIT_MAX = "1";
    const app = await buildServer({ repository: createFakeRepository() });
    const headers = { authorization: "Bearer invalid" };

    const firstRead = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers
    });
    const secondRead = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers
    });
    const firstWrite = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {}
    });
    const firstRecall = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers,
      payload: {}
    });
    const secondRecall = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers,
      payload: {}
    });
    await app.close();

    expect(firstRead.statusCode).not.toBe(429);
    expect(firstRead.headers["x-ratelimit-limit"]).toBe("1");
    expect(firstRead.headers["retry-after"]).toBeUndefined();
    expect(secondRead.statusCode).toBe(429);
    expect(secondRead.headers["retry-after"]).toBeDefined();
    expect(firstWrite.statusCode).not.toBe(429);
    expect(firstWrite.headers["x-ratelimit-limit"]).toBe("2");
    expect(firstRecall.statusCode).not.toBe(429);
    expect(firstRecall.headers["x-ratelimit-limit"]).toBe("1");
    expect(secondRecall.statusCode).toBe(429);
  });

  it("keys valid device credentials by user while invalid credentials remain IP-scoped", async () => {
    process.env.MEMORY_READ_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_READ_RATE_LIMIT_MAX = "1";
    let enforceLimits = false;
    const counts = new Map<string, number>();
    const app = await buildServer({
      repository: createFakeRepository(),
      rateLimitStore: {
        increment(key, windowMs) {
          if (!enforceLimits) {
            return Promise.resolve({
              count: 1,
              resetAt: Date.now() + windowMs
            });
          }
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          return Promise.resolve({
            count,
            resetAt: Date.now() + windowMs
          });
        }
      }
    });
    const aliceRegistration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "device-rate-alice@example.com",
        password: "password123"
      }
    });
    const bobRegistration = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "device-rate-bob@example.com", password: "password123" }
    });
    const aliceCredential = await enrollDeviceCredentialForTest(
      app,
      cookieHeader(aliceRegistration),
      ["team_workspace_read"]
    );
    const bobCredential = await enrollDeviceCredentialForTest(
      app,
      cookieHeader(bobRegistration),
      ["team_workspace_read"]
    );
    enforceLimits = true;

    const status = (authorization: string) =>
      app.inject({
        method: "GET",
        url: "/v1/local-edge/device-credentials/status",
        headers: { authorization }
      });
    const aliceFirst = await status(aliceCredential.authorization);
    const bobFirst = await status(bobCredential.authorization);
    const aliceSecond = await status(aliceCredential.authorization);
    counts.clear();
    const invalidFirst = await status("Koed-Device invalid-one:secret");
    const invalidSecond = await status("Koed-Device invalid-two:secret");
    await app.close();

    expect(aliceFirst.statusCode).toBe(200);
    expect(bobFirst.statusCode).toBe(200);
    expect(aliceSecond.statusCode).toBe(429);
    expect(invalidFirst.statusCode).toBe(401);
    expect(invalidSecond.statusCode).toBe(429);
  });

  it("uses injected rate-limit and cache providers", async () => {
    const cacheReads: string[] = [];
    const cacheWrites: string[] = [];
    const rateLimitKeys: string[] = [];
    const app = await buildServer({
      repository: createFakeRepository(),
      rateLimitStore: {
        increment(key, windowMs) {
          rateLimitKeys.push(key);
          return Promise.resolve({
            count: 1,
            resetAt: Date.now() + windowMs
          });
        }
      },
      cacheProvider: {
        getJson<T>(key: string) {
          cacheReads.push(key);
          return Promise.resolve(null as T | null);
        },
        setJson<T>(key: string, value: T) {
          void value;
          cacheWrites.push(key);
          return Promise.resolve();
        },
        deleteByPrefix() {
          return Promise.resolve();
        }
      }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "cache@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const overview = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/overview",
      headers: browserSessionHeaders(cookie)
    });
    const regularThreads = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads",
      headers: browserSessionHeaders(cookie)
    });
    const threadCacheReadsBeforeTeam = cacheReads.filter((key) =>
      key.startsWith("koed:graph:threads:")
    ).length;
    const threadCacheWritesBeforeTeam = cacheWrites.filter((key) =>
      key.startsWith("koed:graph:threads:")
    ).length;
    const teamThreads = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/threads?teamWorkspaceId=${randomUUID()}`,
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(overview.statusCode).toBe(200);
    expect(regularThreads.statusCode).toBe(200);
    expect(teamThreads.statusCode).toBe(404);
    expect(jsonBody<{ error: string }>(teamThreads).error).toBe(
      "Team Shared Memory graph is not available"
    );
    expect(rateLimitKeys.some((key) => key.startsWith("memoryRead:"))).toBe(
      true
    );
    expect(
      cacheReads.some((key) => key.startsWith("koed:graph:overview:"))
    ).toBe(true);
    expect(
      cacheWrites.some((key) => key.startsWith("koed:graph:overview:"))
    ).toBe(true);
    expect(threadCacheReadsBeforeTeam).toBe(1);
    expect(threadCacheWritesBeforeTeam).toBe(1);
    expect(
      cacheReads.filter((key) => key.startsWith("koed:graph:threads:")).length
    ).toBe(threadCacheReadsBeforeTeam);
    expect(
      cacheWrites.filter((key) => key.startsWith("koed:graph:threads:")).length
    ).toBe(threadCacheWritesBeforeTeam);
  });
});

describe("account and access flows", () => {
  it("disables browser session bootstrap by default outside tests", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousLogLevel = process.env.LOG_LEVEL;
    process.env.NODE_ENV = "production";
    process.env.LOG_LEVEL = "silent";
    const app = await buildServer({ repository: createFakeRepository() });
    try {
      const setup = await app.inject({
        method: "POST",
        url: "/auth/setup",
        payload: { email: "setup@example.com", password: "password123" }
      });
      const register = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { email: "register@example.com", password: "password123" }
      });
      const setupStatus = await app.inject({
        method: "GET",
        url: "/auth/setup-status"
      });

      expect(setup.statusCode).toBe(410);
      expect(register.statusCode).toBe(410);
      expect(jsonBody<{ authMode: string }>(setupStatus).authMode).toBe(
        "local_operator_token_bootstrap"
      );
    } finally {
      await app.close();
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousLogLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = previousLogLevel;
      }
    }
  });

  it("creates browser sessions from WorkOS AuthKit callbacks without storing provider tokens", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://cloud.example.test/auth/workos/callback";
    process.env.WORKOS_PROVIDER_ENVIRONMENT = "test";
    const repository = createFakeRepository();
    const workosClient: WorkosAuthKitClient = {
      getAuthorizationUrl: ({ state }) =>
        `https://workos.example.test/authorize?state=${state}`,
      async authenticateWithCode(input) {
        expect(input.code).toBe("auth-code-1");
        return {
          user: {
            id: "user_01HZ",
            email: "Remote.User@example.test",
            emailVerified: true,
            firstName: "Remote",
            lastName: "User",
            profile: {
              id: "user_01HZ",
              email: "Remote.User@example.test"
            }
          },
          organizationId: "org_01HZ"
        };
      }
    };

    const app = await buildServer({ repository, workosClient });
    const login = await app.inject({
      method: "GET",
      url: "/auth/workos/login?return_to=/settings"
    });
    const callback = await app.inject({
      method: "GET",
      url:
        "/auth/workos/callback?code=auth-code-1&state=" +
        new URL(login.headers.location as string).searchParams.get("state"),
      headers: browserSessionHeaders(cookieJarHeader(login))
    });
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: browserSessionHeaders(cookieHeader(callback))
    });
    const identity = await repository.getExternalAuthIdentity({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId: "user_01HZ"
    });
    await app.close();

    expect(login.statusCode).toBe(302);
    const transientCookies = isStringArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"]
      : typeof login.headers["set-cookie"] === "string"
        ? [login.headers["set-cookie"]]
        : [];
    expect(transientCookies).toHaveLength(2);
    expect(transientCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("koed_workos_state="),
        expect.stringContaining("koed_workos_return_to=")
      ])
    );
    for (const transientCookie of transientCookies) {
      expect(transientCookie).toContain("Path=/;");
      expect(transientCookie).toContain("HttpOnly");
      expect(transientCookie).toContain("Secure");
      expect(transientCookie).toContain("SameSite=Lax");
    }
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/settings");
    const sessionCookie = (
      isStringArray(callback.headers["set-cookie"])
        ? callback.headers["set-cookie"]
        : [callback.headers["set-cookie"]]
    ).find(
      (value): value is string =>
        typeof value === "string" && value.startsWith("cm_session=")
    );
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    const meBody = jsonBody<{
      user: { email: string; displayName: string | null };
    }>(me);
    expect(meBody.user.email).toBe("remote.user@example.test");
    expect(meBody.user.displayName).toBe("Remote User");
    expect(identity).toMatchObject({
      provider: "workos_authkit",
      providerEnvironment: "test",
      providerUserId: "user_01HZ",
      email: "remote.user@example.test",
      emailVerified: true
    });
    expect(JSON.stringify(identity?.profile)).not.toContain("refresh_token");
  });

  it("rejects WorkOS AuthKit callbacks without verified email", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://cloud.example.test/auth/workos/callback";
    const repository = createFakeRepository();
    const workosClient: WorkosAuthKitClient = {
      getAuthorizationUrl: ({ state }) =>
        `https://workos.example.test/authorize?state=${state}`,
      async authenticateWithCode() {
        return {
          user: {
            id: "user_unverified",
            email: "unverified@example.test",
            emailVerified: false,
            firstName: "Unverified",
            lastName: "User",
            profile: {}
          },
          organizationId: "org_unverified"
        };
      }
    };

    const app = await buildServer({ repository, workosClient });
    const login = await app.inject({
      method: "GET",
      url: "/auth/workos/login"
    });
    const callback = await app.inject({
      method: "GET",
      url:
        "/auth/workos/callback?code=auth-code-unverified&state=" +
        new URL(login.headers.location as string).searchParams.get("state"),
      headers: browserSessionHeaders(cookieJarHeader(login))
    });
    const identity = await repository.getExternalAuthIdentity({
      provider: "workos_authkit",
      providerEnvironment: "default",
      providerUserId: "user_unverified"
    });
    await app.close();

    expect(callback.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(callback).error).toBe(
      "Verified WorkOS email required"
    );
    expect(identity).toBeNull();
  });

  it("normalizes unsafe WorkOS return targets before redirecting", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://cloud.example.test/auth/workos/callback";
    const repository = createFakeRepository();
    const workosClient: WorkosAuthKitClient = {
      getAuthorizationUrl: ({ state }) =>
        `https://workos.example.test/authorize?state=${state}`,
      async authenticateWithCode() {
        return {
          user: {
            id: "user_unsafe_return",
            email: "unsafe-return@example.test",
            emailVerified: true,
            firstName: "Unsafe",
            lastName: "Return",
            profile: {}
          },
          organizationId: null
        };
      }
    };

    const app = await buildServer({ repository, workosClient });
    const login = await app.inject({
      method: "GET",
      url:
        "/auth/workos/login?return_to=" +
        encodeURIComponent("//evil.example.test/phish")
    });
    const callback = await app.inject({
      method: "GET",
      url:
        "/auth/workos/callback?code=auth-code-open-redirect&state=" +
        new URL(login.headers.location as string).searchParams.get("state"),
      headers: browserSessionHeaders(cookieJarHeader(login))
    });
    await app.close();

    expect(login.statusCode).toBe(302);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
  });

  it("rejects cross-origin WorkOS return targets even when a browser URL is configured", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://api.example.test/auth/workos/callback";
    process.env.BROWSER_PUBLIC_URL = "https://app.example.test";
    const workosClient: WorkosAuthKitClient = {
      getAuthorizationUrl: ({ state }) =>
        `https://workos.example.test/authorize?state=${state}`,
      async authenticateWithCode() {
        return {
          user: {
            id: "user_browser_return",
            email: "browser-return@example.test",
            emailVerified: true,
            firstName: "Browser",
            lastName: "Return",
            profile: {}
          },
          organizationId: null
        };
      }
    };
    const returnTo =
      "https://app.example.test/koed/device-enrollment/challenge-1";
    const app = await buildServer({
      repository: createFakeRepository(),
      workosClient
    });
    const login = await app.inject({
      method: "GET",
      url: `/auth/workos/login?return_to=${encodeURIComponent(returnTo)}`
    });
    const callback = await app.inject({
      method: "GET",
      url:
        "/auth/workos/callback?code=auth-code-browser-return&state=" +
        new URL(login.headers.location as string).searchParams.get("state"),
      headers: browserSessionHeaders(cookieJarHeader(login))
    });
    await app.close();

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
  });

  it("rejects WorkOS callbacks with invalid state or email-only account matches", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    process.env.WORKOS_AUTHKIT_ENABLED = "true";
    process.env.WORKOS_CLIENT_ID = "client_test_123";
    process.env.WORKOS_API_KEY = "sk_test_hidden";
    process.env.WORKOS_REDIRECT_URI =
      "https://cloud.example.test/auth/workos/callback";
    const repository = createFakeRepository();
    await repository.createUser({
      email: "existing@example.test",
      displayName: "Existing Local User",
      passwordHash: "hash"
    });
    const workosClient: WorkosAuthKitClient = {
      getAuthorizationUrl: ({ state }) =>
        `https://workos.example.test/authorize?state=${state}`,
      async authenticateWithCode() {
        return {
          user: {
            id: "user_different_provider_id",
            email: "existing@example.test",
            emailVerified: true,
            firstName: "Existing",
            lastName: "Remote",
            profile: {}
          },
          organizationId: null
        };
      }
    };

    const app = await buildServer({ repository, workosClient });
    const login = await app.inject({
      method: "GET",
      url: "/auth/workos/login"
    });
    const badState = await app.inject({
      method: "GET",
      url: "/auth/workos/callback?code=auth-code-2&state=wrong-state",
      headers: browserSessionHeaders(cookieJarHeader(login))
    });
    const state = new URL(login.headers.location as string).searchParams.get(
      "state"
    );
    const emailConflict = await app.inject({
      method: "GET",
      url: `/auth/workos/callback?code=auth-code-2&state=${state}`,
      headers: browserSessionHeaders(cookieJarHeader(login))
    });
    await app.close();

    expect(badState.statusCode).toBe(400);
    expect(jsonBody<{ error: string }>(badState).error).toBe(
      "Invalid WorkOS callback state"
    );
    expect(emailConflict.statusCode).toBe(409);
    expect(jsonBody<{ error: string }>(emailConflict).error).toBe(
      "External identity is not linked to the existing Koed account"
    );
  });

  it("registers a solo user without exposing manual memory-node writes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "solo@example.com", password: "password123" }
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "solo@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: browserSessionHeaders(cookie)
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/memory-nodes",
      headers: browserSessionHeaders(cookie),
      payload: { visibility: "shared", summaryText: "shared memory" }
    });
    await app.close();

    expect(registered.statusCode).toBe(200);
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toBe("no-store");
    const localSessionCookie = (
      isStringArray(login.headers["set-cookie"])
        ? login.headers["set-cookie"]
        : [login.headers["set-cookie"]]
    ).find(
      (value): value is string =>
        typeof value === "string" && value.startsWith("cm_session=")
    );
    expect(localSessionCookie).toContain("HttpOnly");
    expect(localSessionCookie).toContain("Secure");
    expect(localSessionCookie).toContain("SameSite=Lax");
    expect(jsonBody<{ user: { email: string } }>(me).user.email).toBe(
      "solo@example.com"
    );
    expect(rejected.statusCode).toBe(404);
  });

  it("authenticates API requests with bearer tokens", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "token@example.com", password: "password123" }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const authed = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: { authorization: `Bearer ${token}` }
    });
    await app.close();

    expect(createdToken.statusCode).toBe(200);
    expect(jsonBody<TokenResponse>(createdToken).apiToken.tokenPrefix).toBe(
      token.slice(0, 12)
    );
    expect(authed.statusCode).toBe(200);
    expect(jsonBody<AccessResponse>(authed).ok).toBe(true);
  });

  it("requires and replays an exact Team creation idempotency key", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "team-idempotency@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const missing = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Idempotent Team" }
    });
    const idempotencyKey = randomUUID();
    const create = () =>
      app.inject({
        method: "POST",
        url: "/v1/teams",
        headers: browserSessionHeaders(cookie, {
          "idempotency-key": idempotencyKey
        }),
        payload: { name: "Idempotent Team" }
      });
    const first = await create();
    const replay = await create();
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookie, {
        "idempotency-key": idempotencyKey
      }),
      payload: { name: "Changed Team" }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(missing.statusCode).toBe(400);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(jsonBody<TeamResponse>(replay)).toEqual(
      jsonBody<TeamResponse>(first)
    );
    expect(conflict.statusCode).toBe(409);
    expect(jsonBody<{ teams: TeamRecord[] }>(listed).teams).toHaveLength(1);
  });

  it("exposes session-only team management APIs", async () => {
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const ownerRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "team-owner@example.com", password: "password123" }
    });
    const ownerCookie = cookieHeader(ownerRegistered);
    const owner = jsonBody<{ user: { id: string } }>(ownerRegistered).user;
    const memberRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "team-member@example.com",
        password: "password123",
        displayName: "Team Member"
      }
    });
    const memberCookie = cookieHeader(memberRegistered);

    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "A-Team" }
    });
    const createdTeamBody = jsonBody<TeamResponse>(createdTeam);
    const team = createdTeamBody.team;
    const defaultWorkspace = createdTeamBody.defaultWorkspace;

    const listedTeams = await app.inject({
      method: "GET",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie)
    });

    const createdWorkspace = await app.inject({
      method: "POST",
      url: "/v1/team-workspaces",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { teamId: team.id, name: "Launch Workspace" }
    });
    const teamWorkspace =
      jsonBody<TeamWorkspaceResponse>(createdWorkspace).teamWorkspace;

    const createdInvite = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: {
        defaultTeamWorkspaceId: teamWorkspace.id,
        defaultWorkspaceAccess: "write",
        email: "team-member@example.com",
        role: "member",
        ttlHours: 24
      }
    });
    const invite = jsonBody<TeamInviteResponse>(createdInvite);

    const acceptedInvite = await app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      headers: browserSessionHeaders(memberCookie),
      payload: { inviteToken: invite.inviteToken }
    });
    const accepted = jsonBody<TeamInviteAcceptResponse>(acceptedInvite);

    const grantedAccess = await app.inject({
      method: "PUT",
      url: `/v1/team-workspaces/${teamWorkspace.id}/access`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        userId: accepted.user.id,
        access: "read",
        expectedVersion: 1
      }
    });

    const listedWorkspaces = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/workspaces`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const listedRoster = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/members`,
      headers: browserSessionHeaders(memberCookie)
    });

    const memberAccess = await app.inject({
      method: "GET",
      url: `/v1/team-workspaces/${teamWorkspace.id}/access`,
      headers: browserSessionHeaders(memberCookie)
    });
    const memberTeamContext = await app.inject({
      method: "GET",
      url: "/v1/team-context",
      headers: browserSessionHeaders(memberCookie)
    });
    const memberReadDevice = await enrollDeviceCredentialForTest(
      app,
      memberCookie,
      ["team_workspace_read"]
    );
    const memberDeviceTeamContext = await app.inject({
      method: "GET",
      url: "/v1/team-context",
      headers: { authorization: memberReadDevice.authorization }
    });
    const rejectedAnonymousTeamContext = await app.inject({
      method: "GET",
      url: "/v1/team-context"
    });
    const initialEntitlement = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const graceEntitlement = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        expectedVersion: 1,
        status: "grace",
        reason: "payment_retry"
      }
    });
    const suspendedEntitlement = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        expectedVersion: 2,
        status: "suspended",
        reason: "billing_suspended"
      }
    });
    const memberAccessSuspended = await app.inject({
      method: "GET",
      url: `/v1/team-workspaces/${teamWorkspace.id}/access`,
      headers: browserSessionHeaders(memberCookie)
    });
    const rejectedSuspendedInvite = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        defaultTeamWorkspaceId: defaultWorkspace.id,
        defaultWorkspaceAccess: "read",
        email: "suspended-invite@example.com",
        role: "member"
      }
    });
    const revokedEntitlement = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        expectedVersion: 3,
        status: "revoked",
        reason: "license_revoked"
      }
    });
    const rejectedRevokedWorkspace = await app.inject({
      method: "POST",
      url: "/v1/team-workspaces",
      headers: browserSessionHeaders(ownerCookie),
      payload: { teamId: team.id, name: "Blocked Workspace" }
    });
    const reactivatedEntitlement = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        expectedVersion: 4,
        status: "active",
        reason: "billing_restored"
      }
    });
    const initialBillingSeats = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/billing-seats`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const rejectedMemberBillingPolicy = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/billing-seats/policy`,
      headers: browserSessionHeaders(memberCookie),
      payload: { expectedVersion: 2, seatLimit: 1 }
    });
    const overLimitBillingSeats = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/billing-seats/policy`,
      headers: browserSessionHeaders(ownerCookie),
      payload: { expectedVersion: 2, seatLimit: 1 }
    });
    const supportOverview = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/support/overview`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const rejectedMemberSupportOverview = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/support/overview`,
      headers: browserSessionHeaders(memberCookie)
    });
    const teamAuditEvents = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/audit-events`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const rejectedOwnerSelfDisable = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/members/${owner.id}/disable`,
      headers: browserSessionHeaders(ownerCookie),
      payload: { expectedVersion: 1 }
    });

    const rejectedMemberInvite = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(memberCookie),
      payload: {
        defaultTeamWorkspaceId: defaultWorkspace.id,
        defaultWorkspaceAccess: "read",
        email: "other-member@example.com",
        role: "member"
      }
    });
    const rejectedMemberAudit = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/audit-events`,
      headers: browserSessionHeaders(memberCookie)
    });
    await app.close();

    expect(createdTeam.statusCode).toBe(200);
    expect(team).toMatchObject({
      name: "A-Team",
      version: 1,
      lifecycle: "active"
    });
    expect(defaultWorkspace).toMatchObject({
      teamId: team.id,
      name: "General",
      version: 1,
      lifecycle: "active"
    });
    expect(listedTeams.statusCode).toBe(200);
    expect(jsonBody<{ teams: TeamRecord[] }>(listedTeams).teams).toEqual([
      expect.objectContaining({ id: team.id, lifecycle: "active" })
    ]);
    expect(createdWorkspace.statusCode).toBe(200);
    expect(teamWorkspace).toMatchObject({
      teamId: team.id,
      name: "Launch Workspace",
      version: 1,
      lifecycle: "active"
    });
    expect(createdInvite.statusCode).toBe(200);
    expect(invite.invite).toMatchObject({
      teamId: team.id,
      defaultTeamWorkspaceId: teamWorkspace.id,
      defaultWorkspaceAccess: "write",
      email: "team-member@example.com",
      normalizedEmail: "team-member@example.com",
      role: "member",
      version: 1,
      lifecycle: "pending"
    });
    expect(invite.invite.backendOriginHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.inviteToken).toMatch(/^kti_/);
    expect(acceptedInvite.statusCode).toBe(200);
    expect(accepted).toMatchObject({
      createdUser: false,
      invite: { version: 2, lifecycle: "accepted" },
      membership: {
        teamId: team.id,
        status: "enabled",
        role: "member",
        version: 2
      },
      user: { email: "team-member@example.com" }
    });
    expect(listedWorkspaces.statusCode).toBe(200);
    expect(
      jsonBody<{ teamWorkspaces: TeamWorkspaceRecord[] }>(listedWorkspaces)
        .teamWorkspaces
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: defaultWorkspace.id }),
        expect.objectContaining({ id: teamWorkspace.id })
      ])
    );
    expect(listedRoster.statusCode).toBe(200);
    expect(
      jsonBody<{ members: Array<{ userId: string }> }>(listedRoster).members
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.id }),
        expect.objectContaining({ userId: accepted.user.id })
      ])
    );
    expect(memberCookie).toMatch(/^cm_session=/);
    expect(grantedAccess.statusCode).toBe(200);
    expect(
      jsonBody<TeamWorkspaceAccessResponse>(grantedAccess).access
    ).toMatchObject({
      teamWorkspaceId: teamWorkspace.id,
      userId: accepted.user.id,
      access: "read",
      version: 2,
      canManageWorkspace: false,
      canRecall: true,
      canCreateShare: false
    });
    expect(memberAccess.statusCode).toBe(200);
    expect(
      jsonBody<TeamWorkspaceAccessResponse>(memberAccess).access
    ).toMatchObject({
      teamWorkspaceId: teamWorkspace.id,
      userId: accepted.user.id,
      access: "read",
      teamEntitlementStatus: "active",
      teamEntitlementAllowsAccess: true,
      canRecall: true
    });
    expect(memberTeamContext.statusCode).toBe(200);
    expect(memberDeviceTeamContext.statusCode).toBe(200);
    expect(jsonBody(memberTeamContext)).toEqual({
      workspaces: [
        {
          teamId: team.id,
          teamName: "A-Team",
          teamRole: "member",
          teamWorkspaceId: teamWorkspace.id,
          teamWorkspaceName: "Launch Workspace",
          access: "read"
        }
      ]
    });
    expect(jsonBody(memberDeviceTeamContext)).toEqual(
      jsonBody(memberTeamContext)
    );
    expect(rejectedAnonymousTeamContext.statusCode).toBe(401);
    expect(initialEntitlement.statusCode).toBe(200);
    expect(
      jsonBody<TeamEntitlementResponse>(initialEntitlement).entitlement
    ).toMatchObject({
      teamId: team.id,
      version: 1,
      status: "active",
      allowsTeamAccess: true,
      deniedOperationFamilies: []
    });
    expect(graceEntitlement.statusCode).toBe(200);
    expect(
      jsonBody<TeamEntitlementResponse>(graceEntitlement).entitlement
    ).toMatchObject({
      status: "grace",
      version: 2,
      allowsTeamAccess: true,
      reason: "payment_retry"
    });
    expect(suspendedEntitlement.statusCode).toBe(200);
    const suspendedEntitlementBody =
      jsonBody<TeamEntitlementResponse>(suspendedEntitlement).entitlement;
    expect(suspendedEntitlementBody).toMatchObject({
      status: "suspended",
      version: 3,
      allowsTeamAccess: false
    });
    expect(suspendedEntitlementBody.deniedOperationFamilies).toEqual(
      expect.arrayContaining([
        "ingestion",
        "recall",
        "share",
        "sync",
        "team_admin"
      ])
    );
    expect(
      jsonBody<TeamWorkspaceAccessResponse>(memberAccessSuspended).access
    ).toMatchObject({
      teamEntitlementStatus: "suspended",
      teamEntitlementAllowsAccess: false,
      canRecall: false,
      canCreateShare: false
    });
    expect(rejectedSuspendedInvite.statusCode).toBe(403);
    expect(revokedEntitlement.statusCode).toBe(200);
    expect(
      jsonBody<TeamEntitlementResponse>(revokedEntitlement).entitlement
    ).toMatchObject({
      status: "revoked",
      version: 4,
      allowsTeamAccess: false
    });
    expect(rejectedRevokedWorkspace.statusCode).toBe(403);
    expect(reactivatedEntitlement.statusCode).toBe(200);
    expect(
      jsonBody<TeamEntitlementResponse>(reactivatedEntitlement).entitlement
    ).toMatchObject({
      status: "active",
      version: 5,
      allowsTeamAccess: true
    });
    expect(initialBillingSeats.statusCode).toBe(200);
    expect(
      jsonBody<TeamBillingSeatResponse>(initialBillingSeats).billingSeats
    ).toMatchObject({
      teamId: team.id,
      version: 2,
      seatLimit: null,
      billableSeatCount: 2,
      pendingBillingSeatCount: 2,
      syncStatus: "pending_provider_update"
    });
    expect(rejectedMemberBillingPolicy.statusCode).toBe(403);
    expect(overLimitBillingSeats.statusCode).toBe(200);
    expect(
      jsonBody<TeamBillingSeatResponse>(overLimitBillingSeats).billingSeats
    ).toMatchObject({
      teamId: team.id,
      version: 3,
      seatLimit: 1,
      billableSeatCount: 2,
      pendingBillingSeatCount: 2,
      syncStatus: "over_limit"
    });
    expect(supportOverview.statusCode).toBe(200);
    const supportOverviewBody =
      jsonBody<TeamSupportOverviewResponse>(supportOverview).supportOverview;
    expect(supportOverviewBody).toMatchObject({
      supportAccess: {
        policy: "team_manager_redacted",
        actorUserId: owner.id,
        actorRole: "owner",
        rawContentAccess: "not_permitted",
        breakGlassRequiredForRawContent: true
      },
      team: { id: team.id, name: "A-Team" },
      entitlement: { teamId: team.id, status: "grace" },
      billingSeats: {
        teamId: team.id,
        seatLimit: 1,
        billableSeatCount: 2,
        syncStatus: "over_limit"
      },
      diagnosticSurfaces: {
        auth: "browser_session",
        rawContentAccess: "not_permitted",
        operationsStatusPath: "/ops/status",
        capabilitiesPath: `/v1/capabilities/authenticated?teamId=${team.id}`,
        auditEventsPath: `/v1/teams/${team.id}/audit-events`,
        entitlementPath: `/v1/teams/${team.id}/entitlement`,
        billingSeatsPath: `/v1/teams/${team.id}/billing-seats`,
        supportOverviewPath: `/v1/teams/${team.id}/support/overview`
      },
      counts: {
        memberships: { enabled: 2, invited: 0, disabled: 0 },
        workspaces: { active: 2, archived: 0 },
        workspaceAccess: { read: 1, write: 2, disabled: 0 },
        invites: { pending: 0, accepted: 1, revoked: 0, expired: 0 },
        sessionShareGrants: {
          active: 0,
          revoked: 0,
          retainedAfterPersonalDeletion: 0
        },
        setupAndIntegrations: {
          externalAuthOrganizations: {
            linked: 0,
            disabled: 0,
            lastSeenAt: null
          },
          externalAuthIdentities: {
            linked: 0,
            disabled: 0,
            emailVerified: 0,
            lastSeenAt: null
          },
          deviceCredentials: {
            active: 1,
            revoked: 0,
            expired: 0
          }
        }
      }
    });
    expect(
      supportOverviewBody.counts.setupAndIntegrations.deviceCredentials
        .lastValidatedAt
    ).toEqual(expect.any(String));
    expect(JSON.stringify(supportOverviewBody)).not.toContain(
      invite.inviteToken
    );
    expect(JSON.stringify(supportOverviewBody)).not.toContain("password123");
    expect(JSON.stringify(supportOverviewBody)).not.toContain(
      "Smoke from owner"
    );
    expect(rejectedMemberSupportOverview.statusCode).toBe(403);
    expect(teamAuditEvents.statusCode).toBe(200);
    expect(rejectedOwnerSelfDisable.statusCode).toBe(403);
    const auditEvents =
      jsonBody<TeamAuditEventsResponse>(teamAuditEvents).auditEvents;
    expect(auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "team.created",
        "team.workspace.created",
        "team.invite.created",
        "team.invite.accepted",
        "team.member.enabled",
        "team.workspace_access.updated",
        "team.billing_seats.changed",
        "team.entitlement.changed",
        "team.support_overview.viewed"
      ])
    );
    expect(
      auditEvents.filter((event) => event.action === "team.entitlement.changed")
    ).toHaveLength(4);
    expect(
      auditEvents.find(
        (event) => event.action === "team.workspace_access.updated"
      )
    ).toMatchObject({
      targetTable: "team_workspace_access_grants",
      targetId: teamWorkspace.id,
      metadata: {
        teamId: team.id,
        teamWorkspaceId: teamWorkspace.id,
        userId: accepted.user.id,
        access: "read",
        previousAccess: "write"
      }
    });
    expect(
      JSON.stringify(auditEvents.map((event) => event.metadata))
    ).not.toContain(invite.inviteToken);
    expect(
      JSON.stringify(auditEvents.map((event) => event.metadata))
    ).not.toContain("password123");
    expect(rejectedMemberInvite.statusCode).toBe(403);
    expect(rejectedMemberAudit.statusCode).toBe(403);
  });

  it("does not grant API-token access to team management routes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "team-token@example.com", password: "password123" }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const teamId = randomUUID();
    const userId = randomUUID();
    const teamWorkspaceId = randomUUID();
    const bearerHeaders = { authorization: `Bearer ${token}` };
    const rejectedRoutes = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/teams",
        headers: bearerHeaders
      }),
      app.inject({
        method: "POST",
        url: "/v1/teams",
        headers: bearerHeaders,
        payload: { name: "Bearer Team" }
      }),
      app.inject({
        method: "GET",
        url: `/v1/teams/${teamId}/membership`,
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/teams/${teamId}/audit-events`,
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/teams/${teamId}/support/overview`,
        headers: bearerHeaders
      }),
      app.inject({
        method: "POST",
        url: `/v1/teams/${teamId}/invites`,
        headers: bearerHeaders,
        payload: {
          defaultTeamWorkspaceId: teamWorkspaceId,
          defaultWorkspaceAccess: "read",
          email: "invitee@example.test",
          role: "member"
        }
      }),
      app.inject({
        method: "POST",
        url: `/v1/teams/${teamId}/members/${userId}/disable`,
        headers: bearerHeaders,
        payload: { expectedVersion: 1 }
      }),
      app.inject({
        method: "POST",
        url: "/v1/team-workspaces",
        headers: bearerHeaders,
        payload: { teamId, name: "Bearer Workspace" }
      }),
      app.inject({
        method: "GET",
        url: `/v1/team-workspaces/${teamWorkspaceId}/access`,
        headers: bearerHeaders
      }),
      app.inject({
        method: "PUT",
        url: `/v1/team-workspaces/${teamWorkspaceId}/access`,
        headers: bearerHeaders,
        payload: { userId, access: "read", expectedVersion: null }
      })
    ]);
    await app.close();

    expect(rejectedRoutes.map((response) => response.statusCode)).toEqual(
      rejectedRoutes.map(() => 403)
    );
    for (const response of rejectedRoutes) {
      expect(jsonBody<{ error: string }>(response).error).toBe(
        "Personal API Tokens cannot access Team operations"
      );
    }
  });

  it("reconciles billing seats when a Team member is disabled through the API", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registeredOwner = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "seat-api-owner@example.com",
        password: "password123"
      }
    });
    const ownerCookie = cookieHeader(registeredOwner);
    const registeredMember = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "seat-api-member@example.com",
        password: "password123"
      }
    });
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Seat API Team" }
    });
    const createdTeamBody = jsonBody<TeamResponse>(createdTeam);
    const team = createdTeamBody.team;
    const createdInvite = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        defaultTeamWorkspaceId: createdTeamBody.defaultWorkspace.id,
        defaultWorkspaceAccess: "write",
        email: "seat-api-member@example.com",
        role: "member"
      }
    });
    const invite = jsonBody<TeamInviteResponse>(createdInvite);
    const acceptedInvite = await app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      headers: browserSessionHeaders(cookieHeader(registeredMember)),
      payload: { inviteToken: invite.inviteToken }
    });
    const accepted = jsonBody<TeamInviteAcceptResponse>(acceptedInvite);
    const overLimitSeats = await app.inject({
      method: "PUT",
      url: `/v1/teams/${team.id}/billing-seats/policy`,
      headers: browserSessionHeaders(ownerCookie),
      payload: { expectedVersion: 2, seatLimit: 1 }
    });
    const disabledMember = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/members/${accepted.user.id}/disable`,
      headers: browserSessionHeaders(ownerCookie),
      payload: { expectedVersion: accepted.membership.version }
    });
    const restoredSeats = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/billing-seats`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const restoredEntitlement = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/entitlement`,
      headers: browserSessionHeaders(ownerCookie)
    });
    const teamAuditEvents = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/audit-events`,
      headers: browserSessionHeaders(ownerCookie)
    });
    await app.close();

    expect(overLimitSeats.statusCode).toBe(200);
    expect(
      jsonBody<TeamBillingSeatResponse>(overLimitSeats).billingSeats
    ).toMatchObject({
      billableSeatCount: 2,
      seatLimit: 1,
      syncStatus: "over_limit"
    });
    expect(disabledMember.statusCode).toBe(200);
    expect(
      jsonBody<TeamMembershipResponse>(disabledMember).membership
    ).toMatchObject({
      userId: accepted.user.id,
      status: "disabled"
    });
    expect(restoredSeats.statusCode).toBe(200);
    expect(
      jsonBody<TeamBillingSeatResponse>(restoredSeats).billingSeats
    ).toMatchObject({
      billableSeatCount: 1,
      seatLimit: 1,
      syncStatus: "pending_provider_update"
    });
    expect(
      jsonBody<TeamEntitlementResponse>(restoredEntitlement).entitlement
    ).toMatchObject({
      status: "active",
      reason: "seat_limit_restored",
      allowsTeamAccess: true
    });
    expect(
      jsonBody<TeamAuditEventsResponse>(teamAuditEvents).auditEvents.map(
        (event) => event.action
      )
    ).toEqual(
      expect.arrayContaining([
        "team.member.disabled",
        "team.billing_seats.changed"
      ])
    );
  });

  it("enrolls and revokes device credentials independently from API Tokens", async () => {
    process.env.BROWSER_PUBLIC_URL = "https://app.example.test/koed";
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "device-owner@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const apiToken = jsonBody<TokenResponse>(createdToken).token;
    const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const overScopedChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const deviceSecret = `device-secret-${randomUUID()}`;
    const credentialKeyId = `device-key-${randomUUID()}`;
    const tokenCreatedChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        challenge_hash: challengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        requested_operation_families: ["team_workspace_read"]
      }
    });
    const createdChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        device_instance_id: "desktop-1",
        device_label: "Desktop",
        requested_operation_families: ["team.recall", "sync.outbox"],
        metadata: {
          platform: "linux",
          deviceSecret: "metadata-device-secret",
          nested: { apiKey: "metadata-api-key" }
        }
      }
    });
    const deniedAdminChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        requested_operation_families: ["team_workspace_read", "admin"]
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: overScopedChallengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        device_instance_id: "desktop-over-scoped",
        requested_operation_families: ["team_workspace_read"]
      }
    });
    const deniedOverScopedRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: overScopedChallengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "secret_hash",
        verifier_secret: deviceSecret,
        operation_families: ["team_workspace_read", "admin"]
      }
    });
    const deniedPublicKeyRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "public_key_jwk",
        public_key_jwk: { kty: "OKP", crv: "Ed25519", x: "unused" }
      }
    });
    const boundedOverScopedRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: overScopedChallengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "secret_hash",
        verifier_secret: deviceSecret,
        operation_families: ["team_workspace_read"]
      }
    });
    const redeemed = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        credential_key_id: credentialKeyId,
        verifier_kind: "secret_hash",
        verifier_secret: deviceSecret
      }
    });
    const credential = jsonBody<{
      credential: {
        id: string;
        verifierHash?: string;
        metadata: Record<string, unknown>;
      };
    }>(redeemed).credential;
    const listed = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials?upstream_backend_id=team-vps",
      headers: browserSessionHeaders(cookie)
    });
    const deniedBearerStatus = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials/status",
      headers: { authorization: `Bearer ${apiToken}` }
    });
    const deviceStatus = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials/status",
      headers: {
        authorization: `Koed-Device ${credentialKeyId}:${deviceSecret}`
      }
    });
    const deniedTeamRoute = await app.inject({
      method: "POST",
      url: "/v1/team-workspaces",
      headers: {
        authorization: `Koed-Device ${credentialKeyId}:${deviceSecret}`
      },
      payload: { teamId: randomUUID(), name: "Workspace" }
    });
    const deniedDeviceOperations = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: {
        authorization: `Koed-Device ${credentialKeyId}:${deviceSecret}`
      }
    });
    const deniedApiTokenSelfRevoke = await app.inject({
      method: "DELETE",
      url: "/v1/local-edge/device-credentials/current",
      headers: { authorization: `Bearer ${apiToken}` }
    });
    const selfRevoked = await app.inject({
      method: "DELETE",
      url: "/v1/local-edge/device-credentials/current",
      headers: {
        authorization: `Koed-Device ${credentialKeyId}:${deviceSecret}`
      }
    });
    const revokedDeviceStatus = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials/status",
      headers: {
        authorization: `Koed-Device ${credentialKeyId}:${deviceSecret}`
      }
    });
    const apiTokenStillWorks = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: { authorization: `Bearer ${apiToken}` }
    });
    await app.close();

    expect(tokenCreatedChallenge.statusCode).toBe(200);
    expect(createdChallenge.statusCode).toBe(200);
    expect(
      jsonBody<{ activationUrl: string }>(createdChallenge).activationUrl
    ).toMatch(
      /^https:\/\/app\.example\.test\/koed\/device-enrollment\/[0-9a-f-]+$/
    );
    expect(deniedAdminChallenge.statusCode).toBe(400);
    expect(deniedOverScopedRedeem.statusCode).toBe(400);
    expect(deniedPublicKeyRedeem.statusCode).toBe(400);
    expect(boundedOverScopedRedeem.statusCode).toBe(200);
    expect(redeemed.statusCode).toBe(200);
    expect(JSON.stringify(redeemed.json())).not.toContain(deviceSecret);
    expect(JSON.stringify(redeemed.json())).not.toContain(
      "metadata-device-secret"
    );
    expect(JSON.stringify(redeemed.json())).not.toContain("metadata-api-key");
    expect(credential.verifierHash).toBeUndefined();
    expect(credential.metadata).toMatchObject({
      platform: "linux",
      deviceSecret: "[redacted]",
      nested: { apiKey: "[redacted]" }
    });
    expect(listed.statusCode).toBe(200);
    expect(
      jsonBody<{ credentials: unknown[] }>(listed).credentials
    ).toHaveLength(2);
    expect(deniedBearerStatus.statusCode).toBe(401);
    expect(jsonBody<{ error: string }>(deniedBearerStatus).error).toBe(
      "Device credential required"
    );
    expect(deviceStatus.statusCode).toBe(200);
    expect(jsonBody<{ auth: string }>(deviceStatus).auth).toBe(
      "device_credential"
    );
    expect(deniedTeamRoute.statusCode).toBe(403);
    expect(deniedDeviceOperations.statusCode).toBe(401);
    expect(jsonBody<{ error: string }>(deniedTeamRoute).error).toBe(
      "Device credential is not allowed for Team administration"
    );
    expect(deniedApiTokenSelfRevoke.statusCode).toBe(401);
    expect(selfRevoked.statusCode).toBe(200);
    expect(jsonBody<{ revoked: boolean }>(selfRevoked).revoked).toBe(true);
    expect(revokedDeviceStatus.statusCode).toBe(401);
    expect(apiTokenStillWorks.statusCode).toBe(200);
  });

  it("bounds device enrollment attempts by device and origin before persistence", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const headers = { origin: "https://desktop.example.test" };

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/local-edge/device-enrollments/challenges",
        headers,
        payload: {
          challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
          upstream_backend_id: "team-vps",
          protocol_deployment_id: testProtocolDeploymentId,
          device_instance_id: "desktop-rate-limit",
          requested_operation_families: ["team_workspace_read"]
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers,
      payload: {
        challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        device_instance_id: "desktop-rate-limit",
        requested_operation_families: ["team_workspace_read"]
      }
    });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers["x-ratelimit-policy"]).toBe("connectionFailure");
    expect(rejected.headers["retry-after"]).toBeDefined();

    await app.close();
  });

  it("inherits the authenticated device identity when rotating a credential", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "device-rotation-owner@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const otherUser = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "device-rotation-other@example.com",
        password: "password123"
      }
    });
    const otherCookie = cookieHeader(otherUser);
    const initialChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const sourceOwnerPrincipalId = randomUUID();
    const initialKeyId = `device-key-${randomUUID()}`;
    const initialSecret = `device-secret-${randomUUID()}`;
    await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: initialChallengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        source_owner_principal_id: sourceOwnerPrincipalId,
        device_instance_id: "desktop-rotation-1",
        requested_operation_families: ["sync"]
      }
    });
    const initialRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: initialChallengeHash,
        credential_key_id: initialKeyId,
        verifier_kind: "secret_hash",
        verifier_secret: initialSecret
      }
    });
    const initialCredential = jsonBody<{
      credential: { id: string };
    }>(initialRedeem).credential;
    const changedDeploymentRotation = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: {
        authorization: `Koed-Device ${initialKeyId}:${initialSecret}`
      },
      payload: {
        challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: randomUUID(),
        source_owner_principal_id: sourceOwnerPrincipalId,
        rotate_credential_id: initialCredential.id,
        requested_operation_families: ["sync"]
      }
    });
    const changedPrincipalRotation = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: {
        authorization: `Koed-Device ${initialKeyId}:${initialSecret}`
      },
      payload: {
        challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        source_owner_principal_id: randomUUID(),
        rotate_credential_id: initialCredential.id,
        requested_operation_families: ["sync"]
      }
    });
    const rotationChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const rotationChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: {
        authorization: `Koed-Device ${initialKeyId}:${initialSecret}`
      },
      payload: {
        challenge_hash: rotationChallengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        source_owner_principal_id: sourceOwnerPrincipalId,
        rotate_credential_id: initialCredential.id,
        requested_operation_families: ["sync"]
      }
    });
    const rotationChallengeRecord = jsonBody<{
      challenge: { id: string };
    }>(rotationChallenge).challenge;
    const siblingRotationChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const siblingRotationChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: {
        authorization: `Koed-Device ${initialKeyId}:${initialSecret}`
      },
      payload: {
        challenge_hash: siblingRotationChallengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        source_owner_principal_id: sourceOwnerPrincipalId,
        rotate_credential_id: initialCredential.id,
        requested_operation_families: ["sync"]
      }
    });
    const crossUserDenial = await app.inject({
      method: "POST",
      url: `/v1/local-edge/device-enrollments/challenges/${rotationChallengeRecord.id}/approval`,
      headers: browserSessionHeaders(otherCookie),
      payload: { decision: "deny" }
    });
    const rotatedKeyId = `device-key-${randomUUID()}`;
    const rotatedSecret = `device-secret-${randomUUID()}`;
    const crossUserRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(otherCookie),
      payload: {
        challenge_hash: rotationChallengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "secret_hash",
        verifier_secret: `device-secret-${randomUUID()}`
      }
    });
    const rotatedRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: rotationChallengeHash,
        credential_key_id: rotatedKeyId,
        verifier_kind: "secret_hash",
        verifier_secret: rotatedSecret
      }
    });
    const staleSiblingRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: siblingRotationChallengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "secret_hash",
        verifier_secret: `device-secret-${randomUUID()}`
      }
    });
    const rotatedCredential = jsonBody<{
      credential: {
        deviceInstanceId: string;
      };
    }>(rotatedRedeem).credential;
    const oldStatus = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials/status",
      headers: {
        authorization: `Koed-Device ${initialKeyId}:${initialSecret}`
      }
    });
    const newStatus = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials/status",
      headers: {
        authorization: `Koed-Device ${rotatedKeyId}:${rotatedSecret}`
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials?upstream_backend_id=team-vps",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(initialRedeem.statusCode).toBe(200);
    expect(changedDeploymentRotation.statusCode).toBe(403);
    expect(changedPrincipalRotation.statusCode).toBe(403);
    expect(rotationChallenge.statusCode).toBe(200);
    expect(siblingRotationChallenge.statusCode).toBe(200);
    expect(crossUserDenial.statusCode).toBe(200);
    expect(
      jsonBody<{ challenge: { status: string } }>(crossUserDenial).challenge
        .status
    ).toBe("pending");
    expect(crossUserRedeem.statusCode).toBe(404);
    expect(rotatedRedeem.statusCode).toBe(200);
    expect(staleSiblingRedeem.statusCode).toBe(409);
    expect(rotatedCredential).toMatchObject({
      deviceInstanceId: "desktop-rotation-1"
    });
    expect(oldStatus.statusCode).toBe(401);
    expect(newStatus.statusCode).toBe(200);
    expect(
      jsonBody<{ credentials: unknown[] }>(listed).credentials
    ).toHaveLength(1);
  });

  it("approves and denies browser-visible device enrollment challenges without exposing verifier material", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "approval-owner@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const apiToken = jsonBody<TokenResponse>(createdToken).token;
    const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const verifierSecret = `device-secret-${randomUUID()}-${randomUUID()}`;
    const verifierHash = hashSecretForTest(verifierSecret);
    const credentialKeyId = `device-key-${randomUUID()}`;
    const createdChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        device_instance_id: "desktop-approval-1",
        device_label: "Work laptop",
        requested_operation_families: ["team_workspace_read", "sync"],
        pending_credential: {
          credential_key_id: credentialKeyId,
          verifier_kind: "secret_hash",
          verifier_secret: verifierSecret,
          operation_families: ["team_workspace_read"]
        },
        metadata: {
          backendDisplayName: "Team Backend",
          backendProfile: "remote",
          highLevelContext: "Team Workspace recall enrollment",
          supportToken: "must-not-leak",
          enrollmentDecision: "denied"
        }
      }
    });
    const challenge = jsonBody<{
      challenge: {
        id: string;
        status: string;
        metadata: Record<string, unknown>;
      };
    }>(createdChallenge).challenge;
    const tokenLookup = await app.inject({
      method: "GET",
      url: `/v1/local-edge/device-enrollments/challenges/${challenge.id}`,
      headers: { authorization: `Bearer ${apiToken}` }
    });
    const lookup = await app.inject({
      method: "GET",
      url: `/v1/local-edge/device-enrollments/challenges/${challenge.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const approved = await app.inject({
      method: "POST",
      url: `/v1/local-edge/device-enrollments/challenges/${challenge.id}/approval`,
      headers: browserSessionHeaders(cookie),
      payload: { decision: "approve" }
    });
    const approvedBody = jsonBody<{
      challenge: { status: string };
      credential: { credentialKeyId: string; verifierHash?: string };
    }>(approved);
    const deniedChallengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const createdDenied = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: deniedChallengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        requested_operation_families: ["team_workspace_read"],
        pending_credential: {
          credential_key_id: `device-key-${randomUUID()}`,
          verifier_kind: "secret_hash",
          verifier_secret: `device-secret-${randomUUID()}-${randomUUID()}`
        }
      }
    });
    const deniedChallenge = jsonBody<{
      challenge: { id: string };
    }>(createdDenied).challenge;
    const denied = await app.inject({
      method: "POST",
      url: `/v1/local-edge/device-enrollments/challenges/${deniedChallenge.id}/approval`,
      headers: browserSessionHeaders(cookie),
      payload: { decision: "deny" }
    });
    const deniedRedeem = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: deniedChallengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "secret_hash",
        verifier_secret: `device-secret-${randomUUID()}-${randomUUID()}`
      }
    });
    const publicKeyCredentialChallenge = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        requested_operation_families: ["team_workspace_read"],
        pending_credential: {
          credential_key_id: `device-key-${randomUUID()}`,
          verifier_kind: "public_key_jwk",
          public_key_jwk: { kty: "OKP", crv: "Ed25519", x: "test" }
        }
      }
    });
    const impossiblePendingScope = await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: `challenge-${randomUUID()}-${randomUUID()}`,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        requested_operation_families: ["team_workspace_read"],
        pending_credential: {
          credential_key_id: `device-key-${randomUUID()}`,
          verifier_kind: "secret_hash",
          verifier_secret: `device-secret-${randomUUID()}-${randomUUID()}`,
          operation_families: ["sync"]
        }
      }
    });
    await app.close();

    expect(createdChallenge.statusCode).toBe(200);
    expect(JSON.stringify(createdChallenge.json())).not.toContain(
      challengeHash
    );
    expect(JSON.stringify(createdChallenge.json())).not.toContain(verifierHash);
    expect(JSON.stringify(createdChallenge.json())).not.toContain(
      credentialKeyId
    );
    expect(JSON.stringify(createdChallenge.json())).not.toContain(
      "must-not-leak"
    );
    expect(challenge.status).toBe("pending");
    expect(challenge.metadata).toMatchObject({
      backendDisplayName: "Team Backend",
      backendProfile: "remote",
      highLevelContext: "Team Workspace recall enrollment",
      supportToken: "[redacted]"
    });
    expect(challenge.metadata).not.toHaveProperty("enrollmentDecision");
    expect(tokenLookup.statusCode).toBe(200);
    expect(JSON.stringify(tokenLookup.json())).not.toContain(verifierHash);
    expect(lookup.statusCode).toBe(200);
    expect(JSON.stringify(lookup.json())).not.toContain(verifierHash);
    expect(approved.statusCode).toBe(200);
    expect(approvedBody.challenge.status).toBe("approved");
    expect(approvedBody.credential.credentialKeyId).toBe(credentialKeyId);
    expect(approvedBody.credential.verifierHash).toBeUndefined();
    expect(JSON.stringify(approved.json())).not.toContain(verifierHash);
    expect(denied.statusCode).toBe(200);
    expect(
      jsonBody<{ challenge: { status: string } }>(denied).challenge.status
    ).toBe("denied");
    expect(deniedRedeem.statusCode).toBe(404);
    expect(publicKeyCredentialChallenge.statusCode).toBe(400);
    expect(impossiblePendingScope.statusCode).toBe(400);
  });

  it("proxies typed Team Memory after scoped local-edge authorization", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-team-memory-"));
    process.env.KOED_HOME = koedHome;
    const localClient = storeLocalEdgeClientCredential(koedHome, {
      backendId: "team-vps",
      secret: "scoped-team-memory-secret",
      operationFamilies: ["team_workspace_read"]
    });
    const localAuthorization = `Koed-Device ${localClient.credentialKeyId}:scoped-team-memory-secret`;
    const upstreamBackendsPath = writeUpstreamRegistryFixture({
      baseUrl: "https://team.example.test",
      routePolicy: {
        personalCollaboration: "enabled",
        teamWorkspaceRead: "enabled",
        sync: "enabled"
      }
    });
    const repository = createFakeRepository();
    const upstreamCalls: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildServer({
      repository,
      upstreamBackendsPath,
      resolveUpstreamAuthorization: (backend) =>
        backend.id === "team-vps"
          ? "Koed-Device upstream-key:upstream-secret"
          : null,
      fetch: async (url, init) => {
        upstreamCalls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ markdown: "proxied" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "route-owner@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Local MCP" }
    });
    const apiToken = jsonBody<TokenResponse>(createdToken).token;
    const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    const deviceSecret = `device-secret-${randomUUID()}`;
    const credentialKeyId = `device-key-${randomUUID()}`;
    await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        device_instance_id: "desktop-1",
        requested_operation_families: [
          "personal_collaboration_read",
          "personal_collaboration_write",
          "team_workspace_read",
          "sync"
        ]
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        credential_key_id: credentialKeyId,
        verifier_kind: "secret_hash",
        verifier_secret: deviceSecret
      }
    });

    const localDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: { operation_family: "personal_memory_read" }
    });
    const teamDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "team_workspace_read",
        upstream_backend_id: "team-vps"
      }
    });
    const personalCollaborationReadDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "personal_collaboration_read",
        upstream_backend_id: "team-vps"
      }
    });
    const personalCollaborationWriteDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "personal_collaboration_write",
        upstream_backend_id: "team-vps"
      }
    });
    const syncDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "sync",
        upstream_backend_id: "team-vps"
      }
    });
    const deniedCaptureDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "capture_writes",
        upstream_backend_id: "team-vps",
        capture_context: { project_id: "repo" }
      }
    });
    const proxied = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/answer",
      headers: { authorization: localAuthorization },
      payload: {
        upstream_backend_id: "team-vps",
        input: { query: "postgres", team_workspace_id: randomUUID() }
      }
    });
    const proxiedWithApiToken = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/search",
      headers: { authorization: `Bearer ${apiToken}` },
      payload: {
        upstream_backend_id: "team-vps",
        input: { query: "redis", team_workspace_id: randomUUID() }
      }
    });
    const blockedGeneralProxy = await app.inject({
      method: "POST",
      url: "/v1/local-edge/upstream-operations",
      headers: { authorization: localAuthorization },
      payload: {
        operation_family: "team_workspace_read",
        upstream_backend_id: "team-vps",
        method: "POST",
        path: "/v1/memory/answer",
        body: {}
      }
    });
    const blockedArbitraryPath = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/search",
      headers: { authorization: localAuthorization },
      payload: {
        upstream_backend_id: "team-vps",
        path: "/v1/teams/team-id/members",
        input: { query: "team", team_workspace_id: randomUUID() }
      }
    });
    await app.close();

    expect(
      jsonBody<{ decision: { action: string } }>(localDecision).decision
    ).toMatchObject({ action: "local_only" });
    expect(
      jsonBody<{ decision: { action: string } }>(teamDecision).decision
    ).toMatchObject({ action: "live_upstream_proxy" });
    expect(
      jsonBody<{ decision: { action: string } }>(
        personalCollaborationReadDecision
      ).decision
    ).toMatchObject({ action: "live_upstream_proxy" });
    expect(
      jsonBody<{ decision: { action: string } }>(
        personalCollaborationWriteDecision
      ).decision
    ).toMatchObject({ action: "live_upstream_proxy" });
    expect(
      jsonBody<{ decision: { action: string } }>(syncDecision).decision
    ).toMatchObject({ action: "queued_sync_handoff" });
    expect(
      jsonBody<{ decision: { action: string; reason: string } }>(
        deniedCaptureDecision
      ).decision
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "route_policy_disabled"
    });
    expect(proxied.statusCode).toBe(200);
    expect(proxiedWithApiToken.statusCode).toBe(401);
    expect(blockedGeneralProxy.statusCode).toBe(400);
    expect(blockedArbitraryPath.statusCode).toBe(400);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("accepts typed Team Memory with a scoped local-edge client credential", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-local-client-"));
    process.env.KOED_HOME = koedHome;
    const upstreamPath = writeUpstreamRegistryFixture({
      baseUrl: "https://team.example.test",
      routePolicy: { teamWorkspaceRead: "enabled" }
    });
    const localClient = storeLocalEdgeClientCredential(koedHome, {
      backendId: "team-vps",
      secret: "scoped-local-client-secret",
      operationFamilies: ["team_workspace_read"]
    });
    const authorization = `Koed-Device ${localClient.credentialKeyId}:scoped-local-client-secret`;
    const upstreamCalls: string[] = [];
    const app = await buildServer({
      repository: createFakeRepository(),
      upstreamBackendsPath: upstreamPath,
      resolveUpstreamAuthorization: () =>
        "Koed-Device upstream-key:upstream-secret",
      fetch: async (input) => {
        upstreamCalls.push(String(input));
        return new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "local-client-session@example.test",
        password: "password123"
      }
    });

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/search",
      headers: { authorization },
      payload: {
        upstream_backend_id: "team-vps",
        input: { query: "team", team_workspace_id: randomUUID() }
      }
    });
    const allowedQuestion = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/questions/final",
      headers: { authorization },
      payload: {
        upstream_backend_id: "team-vps",
        input: {
          idempotency_key: `team-question-${randomUUID()}`,
          query: "What did the Team decide?",
          origin: "mcp_memory_answer",
          team_workspace_id: randomUUID(),
          status: "answered",
          answer_markdown: "Use the Team evidence."
        }
      }
    });
    const invalidCredential = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/search",
      headers: {
        authorization: `Koed-Device ${localClient.credentialKeyId}:wrong-secret`
      },
      payload: {
        upstream_backend_id: "team-vps",
        input: { query: "team", team_workspace_id: randomUUID() }
      }
    });
    const browserSessionOnly = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/search",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: {
        upstream_backend_id: "team-vps",
        input: { query: "team", team_workspace_id: randomUUID() }
      }
    });
    const malformedCredentialMatrix = await Promise.all(
      ["search", "answer", "expand"].flatMap((operation) => [
        app.inject({
          method: "POST",
          url: `/v1/local-edge/team-memory/${operation}`,
          headers: { authorization: "Bearer personal-api-token" },
          payload: {}
        }),
        app.inject({
          method: "POST",
          url: `/v1/local-edge/team-memory/${operation}`,
          headers: browserSessionHeaders(cookieHeader(registered)),
          payload: {}
        }),
        app.inject({
          method: "POST",
          url: `/v1/local-edge/team-memory/${operation}`,
          headers: {
            authorization: `Koed-Device ${localClient.credentialKeyId}:wrong-secret`
          },
          payload: {}
        })
      ])
    );
    const malformedAuthorized = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/search",
      headers: { authorization },
      payload: { upstream_backend_id: "team-vps" }
    });
    await app.close();

    expect(allowed.statusCode).toBe(200);
    expect(allowedQuestion.statusCode).toBe(200);
    expect(invalidCredential.statusCode).toBe(401);
    expect(browserSessionOnly.statusCode).toBe(401);
    expect(
      malformedCredentialMatrix.map((response) => response.statusCode)
    ).toEqual(malformedCredentialMatrix.map(() => 401));
    expect(malformedAuthorized.statusCode).toBe(400);
    expect(upstreamCalls).toEqual([
      "https://team.example.test/v1/memory/search",
      "https://team.example.test/v1/memory/questions/final"
    ]);
  });

  it("does not expose local-edge runtime proxy operations from non-local deployment profiles", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "non-local-edge-profile@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const status = await app.inject({
      method: "GET",
      url: "/v1/local-edge/device-credentials/status",
      headers: {
        authorization: `Koed-Device device-key-${randomUUID()}:secret-${randomUUID()}`
      }
    });
    const decision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: { operation_family: "team_workspace_read" }
    });
    const relayed = await app.inject({
      method: "POST",
      url: "/v1/local-edge/team-memory/answer",
      headers: {
        authorization: `Koed-Device device-key-${randomUUID()}:secret-${randomUUID()}`
      },
      payload: {
        upstream_backend_id: "team-vps",
        input: { query: "postgres", team_workspace_id: randomUUID() }
      }
    });
    await app.close();

    expect(status.statusCode).toBe(401);
    expect(decision.statusCode).toBe(404);
    expect(relayed.statusCode).toBe(404);
  });

  it("does not route local-edge operations with only expired device credentials", async () => {
    const upstreamPath = writeUpstreamRegistryFixture({
      baseUrl: "https://team.example.test",
      routePolicy: { teamWorkspaceRead: "enabled" }
    });
    process.env.KOED_HOME = mkdtempSync(resolve(tmpdir(), "koed-api-home-"));
    const app = await buildServer({
      repository: createFakeRepository(),
      upstreamBackendsPath: upstreamPath
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "expired-device-owner@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const challengeHash = `challenge-${randomUUID()}-${randomUUID()}`;
    await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/challenges",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        upstream_backend_id: "team-vps",
        protocol_deployment_id: testProtocolDeploymentId,
        device_instance_id: "expired-desktop",
        requested_operation_families: ["team_workspace_read"]
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/local-edge/device-enrollments/credentials",
      headers: browserSessionHeaders(cookie),
      payload: {
        challenge_hash: challengeHash,
        credential_key_id: `device-key-${randomUUID()}`,
        verifier_kind: "secret_hash",
        verifier_secret: `expired-device-${randomUUID()}`,
        expires_at: new Date(Date.now() - 60_000).toISOString()
      }
    });

    const decision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "team_workspace_read",
        upstream_backend_id: "team-vps"
      }
    });
    await app.close();

    expect(decision.statusCode).toBe(200);
    expect(
      jsonBody<{ decision: { action: string; reason: string } }>(decision)
        .decision
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "missing"
    });
  });

  it("selects an active device credential that allows the requested operation", async () => {
    const upstreamPath = writeUpstreamRegistryFixture({
      baseUrl: "https://team.example.test",
      routePolicy: {
        teamWorkspaceRead: "enabled",
        sync: "enabled"
      }
    });
    const app = await buildServer({
      repository: createFakeRepository(),
      upstreamBackendsPath: upstreamPath,
      resolveUpstreamAuthorization: () => "Koed-Device upstream-key:secret"
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "operation-device-owner@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    await enrollDeviceCredentialForTest(app, cookie, ["sync"]);
    await enrollDeviceCredentialForTest(app, cookie, ["team_workspace_read"]);

    const teamDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "team_workspace_read",
        upstream_backend_id: "team-vps"
      }
    });
    const syncDecision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "sync",
        upstream_backend_id: "team-vps"
      }
    });
    await app.close();

    expect(
      jsonBody<{ decision: LocalEdgeDecisionResponse }>(teamDecision).decision
    ).toMatchObject({
      action: "live_upstream_proxy",
      credentialState: "configured"
    });
    expect(
      jsonBody<{ decision: LocalEdgeDecisionResponse }>(syncDecision).decision
    ).toMatchObject({
      action: "queued_sync_handoff",
      credentialState: "configured"
    });
  });

  it("applies Capture Policy to local route decisions without an upstream id", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "local-capture-policy@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
      },
      payload: {
        targetType: "project",
        projectId: "disabled-local-capture",
        captureState: "disabled"
      }
    });
    const decision = await app.inject({
      method: "POST",
      url: "/v1/local-edge/route-decisions",
      headers: browserSessionHeaders(cookie),
      payload: {
        operation_family: "capture_writes",
        capture_context: { project_id: "disabled-local-capture" }
      }
    });
    await app.close();

    expect(
      jsonBody<{ decision: LocalEdgeDecisionResponse }>(decision).decision
    ).toMatchObject({
      action: "deny_fail_closed",
      reason: "capture_disabled"
    });
  });

  it("requires an authenticated session before accepting matching invites", async () => {
    const repository = createFakeRepository();
    await repository.upsertExternalAuthSession({
      provider: "workos_authkit",
      providerUserId: `workos-${randomUUID()}`,
      email: "workos-invitee@example.com",
      emailVerified: true,
      displayName: "WorkOS Invitee"
    });
    const app = await buildServer({ repository });
    const ownerRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "workos-invite-owner@example.com",
        password: "password123"
      }
    });
    const ownerCookie = cookieHeader(ownerRegistered);
    const teamResponse = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "WorkOS Invite Test" }
    });
    const teamBody = jsonBody<TeamResponse>(teamResponse);
    const team = teamBody.team;
    const inviteResponse = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        defaultTeamWorkspaceId: teamBody.defaultWorkspace.id,
        defaultWorkspaceAccess: "read",
        email: "workos-invitee@example.com",
        role: "member",
        ttlHours: 24
      }
    });
    const invite = jsonBody<TeamInviteResponse>(inviteResponse);
    const acceptedWithoutExternalAuth = await app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      payload: { inviteToken: invite.inviteToken }
    });
    await app.close();

    expect(acceptedWithoutExternalAuth.statusCode).toBe(401);
    expect(jsonBody<{ error: string }>(acceptedWithoutExternalAuth).error).toBe(
      "Session cookie required"
    );
    expect(cookieHeader(acceptedWithoutExternalAuth)).toBe("");
  });

  it("binds invite acceptance to the authenticated user's email", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const ownerRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "invite-owner@example.com", password: "password123" }
    });
    const registeredInvitee = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "invitee@example.com", password: "password456" }
    });
    const registeredAttacker = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "attacker@example.com", password: "password456" }
    });
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookieHeader(ownerRegistered), {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Invite Boundary" }
    });
    const teamBody = jsonBody<TeamResponse>(createdTeam);
    const team = teamBody.team;
    const createdInvite = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(cookieHeader(ownerRegistered)),
      payload: {
        defaultTeamWorkspaceId: teamBody.defaultWorkspace.id,
        defaultWorkspaceAccess: "read",
        email: "invitee@example.com",
        role: "member"
      }
    });
    const invite = jsonBody<TeamInviteResponse>(createdInvite);

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      headers: browserSessionHeaders(cookieHeader(registeredAttacker)),
      payload: { inviteToken: invite.inviteToken }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      headers: browserSessionHeaders(cookieHeader(registeredInvitee)),
      payload: { inviteToken: invite.inviteToken }
    });
    await app.close();

    expect(rejected.statusCode).toBe(400);
    expect(cookieHeader(rejected)).toBe("");
    expect(jsonBody<{ error: string }>(rejected).error).toBe(
      "Invite email does not match authenticated user"
    );
    expect(accepted.statusCode).toBe(200);
    expect(cookieHeader(accepted)).toBe("");
    expect(jsonBody<TeamInviteAcceptResponse>(accepted)).toMatchObject({
      createdUser: false,
      user: { email: "invitee@example.com" }
    });
  });

  it("audits API token lifecycle routes", async () => {
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "token-audit@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const created = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Client Integration" }
    });
    const apiToken = jsonBody<TokenResponse>(created).apiToken;
    const revoked = await app.inject({
      method: "DELETE",
      url: `/api-tokens/${apiToken.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const notFound = await app.inject({
      method: "DELETE",
      url: `/api-tokens/${apiToken.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const auditEvents = await repository.listAuditEvents({
      userId: apiToken.ownerUserId
    });
    await app.close();

    expect(created.statusCode).toBe(200);
    expect(revoked.statusCode).toBe(200);
    expect(notFound.statusCode).toBe(404);
    expect(auditEvents.map((event) => event.action)).toEqual([
      "api_token.created",
      "api_token.revoked"
    ]);
    expect(auditEvents[0]).toMatchObject({
      actorUserId: apiToken.ownerUserId,
      ownerUserId: apiToken.ownerUserId,
      visibility: "personal",
      targetTable: "api_tokens",
      targetId: apiToken.id,
      metadata: {
        actorType: "user",
        name: "Client Integration",
        tokenPrefix: apiToken.tokenPrefix,
        scopes: []
      }
    });
    expect(auditEvents[0]?.metadata).not.toHaveProperty("tokenHash");
    expect(auditEvents[1]).toMatchObject({
      actorUserId: apiToken.ownerUserId,
      ownerUserId: apiToken.ownerUserId,
      visibility: "personal",
      action: "api_token.revoked",
      targetId: apiToken.id,
      metadata: { actorType: "user" }
    });
  });

  it("records privacy-safe activation analytics through session auth", async () => {
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "analytics-owner@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Activation Analytics" }
    });
    const teamBody = jsonBody<TeamResponse>(createdTeam);
    const team = teamBody.team;
    const createdEvent = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookie),
      payload: {
        event: "desktop_connected",
        surface: "desktop",
        deploymentProfile: "private_vps",
        teamId: team.id,
        metadata: {
          os: "linux",
          durationMs: 42,
          repaired: false
        }
      }
    });
    const createdSecondEvent = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookie),
      payload: {
        event: "first_memory_answer_completed",
        surface: "api",
        deploymentProfile: "private_vps",
        teamId: team.id,
        metadata: {
          source: "manual"
        }
      }
    });
    const rejectedSecret = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookie),
      payload: {
        event: "first_memory_answer_completed",
        surface: "api",
        metadata: {
          promptText: "this must not be accepted"
        }
      }
    });
    const rejectedFreeTextValue = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookie),
      payload: {
        event: "first_memory_answer_completed",
        surface: "api",
        metadata: {
          source: "raw memory sentinel should never enter analytics"
        }
      }
    });
    const rejectedWrongShape = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookie),
      payload: {
        event: "desktop_connected",
        surface: "desktop",
        metadata: {
          durationMs: -1,
          repaired: "false"
        }
      }
    });
    const rejectedApiToken = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: { authorization: "Bearer not-a-session" },
      payload: {
        event: "desktop_connected",
        surface: "desktop"
      }
    });
    const otherRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "analytics-other@example.com",
        password: "password123"
      }
    });
    const rejectedOtherTeam = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookieHeader(otherRegistered)),
      payload: {
        event: "workspace_created",
        surface: "api",
        teamId: team.id
      }
    });
    const ownedSession = await repository.createCapturedSession(
      { userId: jsonBody<{ user: { id: string } }>(registered).user.id },
      { sourceRuntime: "codex", captureMethod: "mcp" }
    );
    const rejectedOtherSession = await app.inject({
      method: "POST",
      url: "/v1/analytics/activation-events",
      headers: browserSessionHeaders(cookieHeader(otherRegistered)),
      payload: {
        event: "first_capture_completed",
        surface: "capture_hook",
        sessionId: ownedSession.id
      }
    });
    const funnel = await app.inject({
      method: "GET",
      url: `/v1/analytics/activation-funnel?teamId=${team.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const rejectedOtherTeamFunnel = await app.inject({
      method: "GET",
      url: `/v1/analytics/activation-funnel?teamId=${team.id}`,
      headers: browserSessionHeaders(cookieHeader(otherRegistered))
    });
    const auditEvents = await repository.listAuditEvents({
      userId: jsonBody<{ user: { id: string } }>(registered).user.id
    });
    await app.close();

    expect(createdEvent.statusCode).toBe(200);
    expect(
      jsonBody<{ event: AuditEventRecord }>(createdEvent).event
    ).toMatchObject({
      action: "analytics.activation.desktop_connected",
      targetTable: "teams",
      targetId: team.id,
      visibility: null,
      metadata: {
        event: "desktop_connected",
        surface: "desktop",
        deploymentProfile: "private_vps",
        teamId: team.id,
        attributes: {
          os: "linux",
          durationMs: 42,
          repaired: false
        }
      }
    });
    expect(createdSecondEvent.statusCode).toBe(200);
    expect(rejectedSecret.statusCode).toBe(400);
    expect(rejectedFreeTextValue.statusCode).toBe(400);
    expect(rejectedWrongShape.statusCode).toBe(400);
    expect(rejectedApiToken.statusCode).toBe(401);
    expect(rejectedOtherTeam.statusCode).toBe(403);
    expect(rejectedOtherSession.statusCode).toBe(403);
    expect(rejectedOtherTeamFunnel.statusCode).toBe(403);
    expect(funnel.statusCode).toBe(200);
    expect(
      jsonBody<{ funnel: ActivationAnalyticsFunnelRecord }>(funnel).funnel
    ).toMatchObject({
      scope: { ownerUserId: null, teamId: team.id, teamWorkspaceId: null },
      events: [
        {
          event: "desktop_connected",
          count: 1,
          surfaces: { desktop: 1 },
          deploymentProfiles: { private_vps: 1 }
        },
        {
          event: "first_memory_answer_completed",
          count: 1,
          surfaces: { api: 1 },
          deploymentProfiles: { private_vps: 1 }
        }
      ]
    });
    expect(JSON.stringify(jsonBody(funnel))).not.toContain("manual");
    expect(JSON.stringify(jsonBody(funnel))).not.toContain("linux");
    expect(
      JSON.stringify(auditEvents.map((event) => event.metadata))
    ).not.toContain("this must not be accepted");
    expect(
      JSON.stringify(auditEvents.map((event) => event.metadata))
    ).not.toContain("raw memory sentinel");
  });

  it("rejects cross-origin browser-session writes without blocking bearer API tokens", async () => {
    process.env.BROWSER_PUBLIC_URL = "http://console.example.test/koed";

    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "origin@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const rejected = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie, origin: "http://evil.example.test" },
      payload: { name: "Blocked" }
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: { cookie, origin: "http://console.example.test" },
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(allowed).token;
    const bearerRequest = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: {
        authorization: `Bearer ${token}`,
        origin: "http://evil.example.test"
      },
      payload: { query: "anything" }
    });
    const mixedCredentialRequest = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: {
        cookie,
        authorization: `Bearer ${token}`,
        origin: "http://evil.example.test"
      },
      payload: { name: "Mixed Credentials" }
    });
    await app.close();

    expect(rejected.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    expect(bearerRequest.statusCode).toBe(200);
    expect(mixedCredentialRequest.statusCode).toBe(403);
  });

  it("rejects cross-origin session-establishing writes", async () => {
    process.env.CORS_ORIGINS = "http://console.example.test";
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";

    const app = await buildServer({ repository: createFakeRepository() });
    const rejectedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://evil.example.test" },
      payload: { email: "blocked-origin@example.com", password: "password123" }
    });
    const allowedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://console.example.test" },
      payload: { email: "allowed-origin@example.com", password: "password123" }
    });
    const rejectedLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "http://evil.example.test" },
      payload: { email: "allowed-origin@example.com", password: "password123" }
    });
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(cookieHeader(allowedRegister), {
        origin: "http://console.example.test",
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Origin Guard Team" }
    });
    const teamBody = jsonBody<TeamResponse>(createdTeam);
    const team = teamBody.team;
    const createdInvite = await app.inject({
      method: "POST",
      url: `/v1/teams/${team.id}/invites`,
      headers: browserSessionHeaders(cookieHeader(allowedRegister), {
        origin: "http://console.example.test"
      }),
      payload: {
        defaultTeamWorkspaceId: teamBody.defaultWorkspace.id,
        defaultWorkspaceAccess: "read",
        email: "origin-invite@example.com",
        role: "member"
      }
    });
    const invite = jsonBody<TeamInviteResponse>(createdInvite);
    const rejectedInviteAccept = await app.inject({
      method: "POST",
      url: "/v1/team-invites/accept",
      headers: { origin: "http://evil.example.test" },
      payload: { inviteToken: invite.inviteToken }
    });
    await app.close();

    expect(rejectedRegister.statusCode).toBe(403);
    expect(allowedRegister.statusCode).toBe(200);
    expect(rejectedLogin.statusCode).toBe(403);
    expect(rejectedInviteAccept.statusCode).toBe(401);
    expect(cookieHeader(rejectedInviteAccept)).toBe("");
  });

  it("rejects a malformed stored password hash without failing the request", async () => {
    const repository = createFakeRepository();
    await repository.createUser({
      email: "fixture-login@example.com",
      passwordHash: "team-saas-fixture-v1:password-not-for-login"
    });
    const app = await buildServer({ repository });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "fixture-login@example.com",
        password: "password123"
      }
    });
    await app.close();

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Invalid email or password" });
  });

  it("does not treat root-level API_CORS_ORIGINS as an API process setting", async () => {
    process.env.CORS_ORIGINS = "http://console.example.test";
    process.env.API_CORS_ORIGINS = "http://legacy.example.test";
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";

    const app = await buildServer({ repository: createFakeRepository() });
    const rejectedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://legacy.example.test" },
      payload: { email: "legacy-cors@example.com", password: "password123" }
    });
    const allowedRegister = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { origin: "http://console.example.test" },
      payload: { email: "configured-cors@example.com", password: "password123" }
    });
    await app.close();

    expect(rejectedRegister.statusCode).toBe(403);
    expect(allowedRegister.statusCode).toBe(200);
  });

  it("does not grant API-token access to session-only routes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "console-auth@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const bearerHeaders = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };

    const consoleRequests = await Promise.all([
      app.inject({ method: "GET", url: "/me", headers: bearerHeaders }),
      app.inject({
        method: "GET",
        url: "/api-tokens",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/self-host/diagnostics",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/health/details",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/self-host/status",
        headers: bearerHeaders
      }),
      app.inject({
        method: "GET",
        url: "/ops/status",
        headers: bearerHeaders
      })
    ]);
    const accessCheck = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: bearerHeaders
    });
    const sessionMe = await app.inject({
      method: "GET",
      url: "/me",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(createdToken.statusCode).toBe(200);
    expect(consoleRequests.map((response) => response.statusCode)).toEqual([
      401, 401, 401, 401, 200, 401
    ]);
    expect(jsonBody<{ redacted: boolean }>(consoleRequests[4]).redacted).toBe(
      true
    );
    expect(accessCheck.statusCode).toBe(200);
    expect(sessionMe.statusCode).toBe(200);
  });

  it("exposes redacted hosted operations status to browser sessions", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-ops-status-"));
    const backupStatusPath = resolve(koedHome, "backup-status.json");
    const requestMetricsStatusPath = resolve(
      koedHome,
      "request-metrics-status.json"
    );
    const rawMemorySentinel =
      "RawMemorySentinel: customer pricing decision must not enter diagnostics";
    const secretSentinel = "sk-koed-diagnostics-secret-must-not-leak";
    writeFileSync(
      backupStatusPath,
      JSON.stringify({
        status: "ok",
        provider: "smoke",
        checkedAt: new Date().toISOString(),
        lastSuccessfulAt: new Date().toISOString(),
        ignoredRawMemory: rawMemorySentinel,
        ignoredProviderSecret: secretSentinel
      })
    );
    writeFileSync(
      requestMetricsStatusPath,
      JSON.stringify({
        status: "ok",
        checkedAt: new Date().toISOString(),
        windowSeconds: 60,
        requestRatePerSecond: 12.5,
        p95LatencyMs: 250,
        p99LatencyMs: 400,
        errorRate: 0.001,
        ignoredRawMemory: rawMemorySentinel,
        ignoredProviderSecret: secretSentinel
      })
    );
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.WORK_QUEUE_BACKEND = "local";
    process.env.KOED_HOME = koedHome;
    process.env.KOED_BACKUP_STATUS_PATH = backupStatusPath;
    process.env.KOED_OPS_REQUEST_METRICS_STATUS_PATH = requestMetricsStatusPath;
    process.env.KOED_OPS_MAX_RSS_BYTES = "999999999999";
    process.env.KOED_RUNBOOK_BASE_URL = "https://runbooks.example.test/koed";
    process.env.KOED_OPS_ALERT_WEBHOOK_URL = "https://alerts.example.test/koed";
    process.env.KOED_OPS_ALERT_WEBHOOK_TOKEN = secretSentinel;
    process.env.API_ENVELOPE_ENCRYPTION_PROVIDER = "managed_kms";
    process.env.MANAGED_KMS_KEY_ID = "managed-kms:ops-status-key";
    process.env.MANAGED_KMS_KEY_VERSION = "4";
    process.env.MANAGED_KMS_ENDPOINT_URL = "https://kms.ops-status.test/v1/";
    process.env.MANAGED_KMS_AUTH_TOKEN = secretSentinel;
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "ops-status@example.com", password: "password123" }
    });
    const status = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    const rejected = await app.inject({ method: "GET", url: "/ops/status" });
    await app.close();

    const body = jsonBody<{
      status: string;
      redacted: boolean;
      deployment: { queueBackend: string };
      components: {
        api: { status: string };
        backups: { status: string; details: { provider: string | null } };
        requestMetrics: {
          status: string;
          details: { p95LatencyMs: number; errorRate: number };
        };
        runtimeResources: {
          status: string;
          details: { rssBytes: number; maxRssBytes: number };
        };
        redis: { status: string };
        disk: { status: string; details: { path: string } };
        envelopeEncryption: {
          status: string;
          details: {
            mode: string;
            keyId: string;
            keyVersion: number;
            status: string;
            details: { endpointOrigin: string };
          };
        };
        historicalImport: {
          status: string;
          details: {
            diagnosticOnly: boolean;
            pendingRows: number;
            pendingBytes: number;
          };
        };
        alertDelivery: {
          status: string;
          details: {
            sink: string;
            tokenConfigured: boolean;
            endpointConfigured: boolean;
          };
        };
      };
      alerts: Array<{ code: string; runbookUrl: string | null }>;
    }>(status);

    expect(status.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(401);
    expect(body.redacted).toBe(true);
    expect(body.deployment.queueBackend).toBe("local");
    expect(body.components.api.status).toBe("ok");
    expect(body.components.redis.status).toBe("not_required");
    expect(body.components.backups).toMatchObject({
      status: "ok",
      details: { provider: "smoke" }
    });
    expect(body.components.requestMetrics).toMatchObject({
      status: "ok",
      details: { p95LatencyMs: 250, errorRate: 0.001 }
    });
    expect(body.components.runtimeResources.status).toBe("ok");
    expect(body.components.runtimeResources.details.maxRssBytes).toBe(
      999999999999
    );
    expect(body.components.disk.details.path).toBe(koedHome);
    expect(body.components.envelopeEncryption).toEqual({
      status: "ok",
      details: {
        mode: "managed_kms",
        keyId: "managed-kms:ops-status-key",
        keyVersion: 4,
        status: "configured",
        details: {
          endpointOrigin: "https://kms.ops-status.test"
        }
      }
    });
    expect(body.components.historicalImport).toEqual({
      status: "ok",
      details: {
        diagnosticOnly: true,
        pendingRows: 0,
        pendingBytes: 0,
        liveProjectionRows: 0
      }
    });
    expect(body.components.alertDelivery).toEqual({
      status: "ok",
      details: {
        sink: "webhook",
        tokenConfigured: true,
        endpointConfigured: true
      }
    });
    expect(
      body.alerts.some((alert) => alert.code === "embeddingService.degraded")
    ).toBe(true);
    expect(
      body.alerts.every((alert) =>
        alert.runbookUrl?.startsWith("https://runbooks.example.test/koed/")
      )
    ).toBe(true);
    expect(status.body).not.toContain(rawMemorySentinel);
    expect(status.body).not.toContain(secretSentinel);
  });

  it("protects capacity metrics with a dedicated machine credential", async () => {
    const metricsToken = "metrics-only-secret";
    const rawMemorySentinel = "customer-memory-must-not-enter-metrics";
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_OPS_METRICS_TOKEN = metricsToken;
    const app = await buildServer({
      repository: createFakeRepository(),
      embeddingCapacityRepository: createFakeEmbeddingCapacityRepository()
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "metrics-user@example.com", password: "password123" }
    });
    const sessionCookie = cookieHeader(registered);

    const [anonymous, wrongToken, browserSession, accepted] = await Promise.all(
      [
        app.inject({ method: "GET", url: "/internal/metrics" }),
        app.inject({
          method: "GET",
          url: "/internal/metrics",
          headers: { authorization: "Bearer wrong-secret" }
        }),
        app.inject({
          method: "GET",
          url: "/internal/metrics",
          headers: browserSessionHeaders(sessionCookie)
        }),
        app.inject({
          method: "GET",
          url: "/internal/metrics",
          headers: { authorization: `Bearer ${metricsToken}` }
        })
      ]
    );
    await app.close();

    expect(anonymous.statusCode).toBe(401);
    expect(wrongToken.statusCode).toBe(401);
    expect(browserSession.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["content-type"]).toContain(
      "application/openmetrics-text"
    );
    expect(accepted.body).toContain(
      "koed_embedding_capacity_tokens_per_second 2000"
    );
    expect(accepted.body).toContain(
      'koed_embedding_backlog_sources{source="memory_event"} 4'
    );
    expect(accepted.body).toContain(
      'koed_embedding_events_total{queue="memory-embed",source="memory_event",outcome="completed"} 2'
    );
    expect(accepted.body.endsWith("# EOF\n")).toBe(true);
    expect(accepted.body).not.toContain(metricsToken);
    expect(accepted.body).not.toContain(rawMemorySentinel);
    expect(accepted.body).not.toContain("hardwareFingerprint");
    expect(accepted.body).not.toContain("runtimeSettings");
  });

  it("aggregates compatible hosted worker-pool capacity", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    const capacity = createFakeEmbeddingCapacityRepository();
    const first = await capacity.getLatestUsableProfile();
    capacity.listActiveUsableProfiles = async () => [
      first!,
      {
        ...first!,
        id: "capacity-profile-pool-b",
        poolKey: "pool-b",
        profileKey: "capacity-profile-key-pool-b",
        backendClass: "cuda",
        testedConcurrency: 4,
        sampleCount: 16,
        measuredTokensPerSecond: 3_000,
        p50LatencyMs: 80,
        p95LatencyMs: 120
      }
    ];
    const app = await buildServer({
      repository: createFakeRepository(),
      embeddingCapacityRepository: capacity
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "pool-ops@example.com", password: "password123" }
    });
    const response = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(
      jsonBody<{
        components: { embeddingCapacity: { details: { profile: unknown } } };
      }>(response).components.embeddingCapacity.details.profile
    ).toMatchObject({
      poolCount: 2,
      backendClasses: ["cpu", "cuda"],
      testedConcurrency: 5,
      sampleCount: 28,
      measuredTokensPerSecond: 5_000,
      p50LatencyMs: 100,
      p95LatencyMs: 150
    });
  });

  it("does not expose a metrics route without a machine credential", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      embeddingCapacityRepository: createFakeEmbeddingCapacityRepository()
    });
    const response = await app.inject({
      method: "GET",
      url: "/internal/metrics",
      headers: { authorization: "Bearer any-token" }
    });
    await app.close();

    expect(response.statusCode).toBe(404);
  });

  it("reports a conservative ETA without opening historical admission", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    const capacity = createFakeEmbeddingCapacityRepository();
    capacity.listActiveUsableProfiles = async () => [];
    const app = await buildServer({
      repository: createFakeRepository(),
      embeddingCapacityRepository: capacity
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "fallback-eta@example.com", password: "password123" }
    });
    const response = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(
      jsonBody<{
        components: {
          embeddingCapacity: {
            status: string;
            details: Record<string, unknown>;
          };
        };
      }>(response).components.embeddingCapacity
    ).toMatchObject({
      status: "degraded",
      details: {
        admission: "historical_closed",
        drainEstimate: {
          confidence: "conservative",
          source: "documented_fallback"
        }
      }
    });
  });

  it("keeps health and readiness independent from capacity queries", async () => {
    const capacity = createFakeEmbeddingCapacityRepository();
    capacity.listActiveUsableProfiles = vi.fn(
      capacity.listActiveUsableProfiles
    );
    capacity.getSemanticBacklog = vi.fn(capacity.getSemanticBacklog);
    capacity.getRollingTelemetry = vi.fn(capacity.getRollingTelemetry);
    const app = await buildServer({
      repository: createFakeRepository(),
      embeddingCapacityRepository: capacity
    });

    const [health, ready] = await Promise.all([
      app.inject({ method: "GET", url: "/health" }),
      app.inject({ method: "GET", url: "/ready" })
    ]);
    await app.close();

    expect(health.statusCode).toBe(200);
    expect([200, 503]).toContain(ready.statusCode);
    expect(capacity.listActiveUsableProfiles).not.toHaveBeenCalled();
    expect(capacity.getSemanticBacklog).not.toHaveBeenCalled();
    expect(capacity.getRollingTelemetry).not.toHaveBeenCalled();
  });

  it("keeps historical backlog out of readiness and diagnostic-only", async () => {
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-history-status-"));
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.WORK_QUEUE_BACKEND = "local";
    process.env.KOED_HOME = koedHome;
    const repository = createFakeRepository();
    repository.getConversationProjectionBacklog = async () => ({
      liveProjectionRows: 0,
      historicalImportRows: 50_000,
      historicalImportBytes: 9_000_000
    });
    repository.getLocalEmbeddingStatus = async () => ({
      enabled: true,
      healthy: true,
      model: "qwen3-0.6b",
      dimensions: 1024
    });
    const app = await buildServer({ repository });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "history-status@example.com", password: "password123" }
    });
    const ops = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie: cookieHeader(registered) }
    });
    await app.close();

    expect(ready.statusCode).toBe(200);
    expect(ready.body).not.toContain("historicalImport");
    expect(
      jsonBody<{ components: Record<string, unknown> }>(ops).components
    ).toHaveProperty("historicalImport", {
      status: "ok",
      details: {
        diagnosticOnly: true,
        pendingRows: 50_000,
        pendingBytes: 9_000_000,
        liveProjectionRows: 0
      }
    });
  });

  it("reports managed KMS status failures as redacted operations alerts", async () => {
    const secretSentinel = "kms-status-secret-must-not-leak";
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_RUNBOOK_BASE_URL = "https://runbooks.example.test/koed";
    const failingProvider = {
      mode: "managed_kms",
      keyId: "managed-kms:degraded-status-key",
      keyVersion: 7,
      async encrypt() {
        throw new Error("not used");
      },
      async decrypt() {
        throw new Error("not used");
      },
      async status() {
        throw new Error(`KMS unavailable: ${secretSentinel}`);
      }
    } satisfies EnvelopeEncryptionProvider;
    const app = await buildServer({
      repository: createFakeRepository(),
      envelopeEncryptionProvider: failingProvider
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "ops-kms-status@example.com", password: "password123" }
    });
    const status = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    await app.close();

    const body = jsonBody<{
      status: string;
      redacted: boolean;
      components: {
        envelopeEncryption: {
          status: string;
          details: {
            mode: string;
            keyId: string;
            keyVersion: number;
          };
        };
      };
      alerts: Array<{ code: string; runbookUrl: string | null }>;
    }>(status);

    expect(status.statusCode).toBe(200);
    expect(body.status).toBe("error");
    expect(body.redacted).toBe(true);
    expect(body.components.envelopeEncryption).toEqual({
      status: "error",
      details: {
        mode: "managed_kms",
        keyId: "managed-kms:degraded-status-key",
        keyVersion: 7
      }
    });
    expect(body.alerts).toContainEqual(
      expect.objectContaining({
        code: "envelopeEncryption.error",
        runbookUrl:
          "https://runbooks.example.test/koed/envelopeEncryption.error"
      })
    );
    expect(status.body).not.toContain(secretSentinel);
  });

  it("exposes a redacted hosted operations test-alert path to browser sessions", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_RUNBOOK_BASE_URL = "https://runbooks.example.test/koed";
    process.env.KOED_OPS_ALERT_WEBHOOK_URL = "https://alerts.example.test/koed";
    process.env.KOED_OPS_ALERT_WEBHOOK_TOKEN = "test-alert-secret";
    const alertRequests: Array<{ url: string; init: RequestInit }> = [];
    const app = await buildServer({
      repository: createFakeRepository(),
      fetch: async (url, init) => {
        alertRequests.push({ url: String(url), init: init ?? {} });
        return new Response("ok", { status: 202 });
      }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "ops-test-alert@example.com", password: "password123" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/ops/test-alert",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/ops/test-alert"
    });
    await app.close();

    const body = jsonBody<{
      redacted: boolean;
      test: boolean;
      alert: { code: string; runbookUrl: string | null };
      delivery: { status: string; sink: string; redacted: boolean };
    }>(accepted);

    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(401);
    expect(body.redacted).toBe(true);
    expect(body.test).toBe(true);
    expect(body.alert.code).toBe("testAlert.degraded");
    expect(body.alert.runbookUrl).toBe(
      "https://runbooks.example.test/koed/testAlert.degraded"
    );
    expect(body.delivery).toEqual({
      status: "sent",
      sink: "webhook",
      redacted: true
    });
    expect(alertRequests).toHaveLength(1);
    expect(alertRequests[0]).toMatchObject({
      url: "https://alerts.example.test/koed",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-alert-secret"
        }
      }
    });
    expect(String(alertRequests[0]?.init.body)).toContain("testAlert.degraded");
    expect(accepted.body).not.toContain("test-alert-secret");
  });

  it("restricts hosted operations status to configured operator sessions", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    process.env.KOED_OPS_OPERATOR_EMAILS = "ops@example.test";
    configureTestWorkos();
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const operator = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "ops@example.test", password: "password123" }
    });
    const userCookie = await createVerifiedWorkosSessionForTest(
      repository,
      "user@example.test"
    );
    const team = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(userCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Team membership does not grant operations" }
    });
    const operatorStatus = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: browserSessionHeaders(cookieHeader(operator))
    });
    const userStatus = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: browserSessionHeaders(userCookie)
    });
    const operatorAlert = await app.inject({
      method: "POST",
      url: "/ops/test-alert",
      headers: browserSessionHeaders(cookieHeader(operator))
    });
    const userAlert = await app.inject({
      method: "POST",
      url: "/ops/test-alert",
      headers: browserSessionHeaders(userCookie)
    });
    await app.close();

    expect(operatorStatus.statusCode).toBe(200);
    expect(team.statusCode).toBe(200);
    expect(operatorAlert.statusCode).toBe(200);
    expect(userStatus.statusCode).toBe(403);
    expect(userAlert.statusCode).toBe(403);
  });

  it("exposes hosted support overview only to configured ops operators", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    process.env.KOED_OPS_OPERATOR_EMAILS = "ops-support@example.test";
    configureTestWorkos();
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const ownerCookie = await createVerifiedWorkosSessionForTest(
      repository,
      "hosted-support-owner@example.test"
    );
    const operator = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "ops-support@example.test",
        password: "password123"
      }
    });
    const normalUser = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "hosted-support-user@example.test",
        password: "password123"
      }
    });
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Hosted Support Team" }
    });
    expect(createdTeam.statusCode, createdTeam.body).toBe(200);
    const team = jsonBody<TeamResponse>(createdTeam).team;
    const accepted = await app.inject({
      method: "GET",
      url: `/ops/support/teams/${team.id}/overview`,
      headers: browserSessionHeaders(cookieHeader(operator))
    });
    const rejectedNormalUser = await app.inject({
      method: "GET",
      url: `/ops/support/teams/${team.id}/overview`,
      headers: browserSessionHeaders(cookieHeader(normalUser))
    });
    const rejectedAnonymous = await app.inject({
      method: "GET",
      url: `/ops/support/teams/${team.id}/overview`
    });
    const auditEventsResponse = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/audit-events`,
      headers: browserSessionHeaders(ownerCookie)
    });
    await app.close();

    expect(accepted.statusCode).toBe(200);
    expect(rejectedNormalUser.statusCode).toBe(403);
    expect(rejectedAnonymous.statusCode).toBe(401);
    const body =
      jsonBody<TeamSupportOverviewResponse>(accepted).supportOverview;
    expect(body).toMatchObject({
      supportAccess: {
        policy: "hosted_operator_redacted",
        actorRole: "hosted_operator",
        rawContentAccess: "not_permitted",
        breakGlassRequiredForRawContent: true
      },
      team: { id: team.id, name: "Hosted Support Team" },
      diagnosticSurfaces: {
        auth: "browser_session",
        rawContentAccess: "not_permitted",
        operationsStatusPath: "/ops/status",
        capabilitiesPath: `/v1/capabilities/authenticated?teamId=${team.id}`,
        auditEventsPath: `/v1/teams/${team.id}/audit-events`,
        entitlementPath: `/v1/teams/${team.id}/entitlement`,
        billingSeatsPath: `/v1/teams/${team.id}/billing-seats`,
        supportOverviewPath: `/ops/support/teams/${team.id}/overview`
      }
    });
    expect(accepted.body).not.toContain("password123");
    const auditEvents =
      jsonBody<TeamAuditEventsResponse>(auditEventsResponse).auditEvents;
    expect(auditEvents.map((event) => event.action)).toContain(
      "team.hosted_support_overview.viewed"
    );
    expect(
      auditEvents.find(
        (event) => event.action === "team.hosted_support_overview.viewed"
      )
    ).toMatchObject({
      actorUserId: jsonBody<{ user: { id: string } }>(operator).user.id,
      targetTable: "teams",
      targetId: team.id,
      metadata: {
        teamId: team.id,
        policy: "hosted_operator_redacted",
        rawContentAccess: "not_permitted"
      }
    });
  });

  it("creates encrypted hosted support bundles without exposing raw content", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    process.env.KOED_OPS_OPERATOR_EMAILS = "ops-bundle@example.test";
    configureTestWorkos();
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(
      Buffer.alloc(32, 31).toString("base64")
    );
    const repository = createFakeRepository();
    const app = await buildServer({
      repository,
      envelopeEncryptionProvider: provider
    });
    const ownerCookie = await createVerifiedWorkosSessionForTest(
      repository,
      "hosted-support-bundle-owner@example.test"
    );
    const operator = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "ops-bundle@example.test",
        password: "password123"
      }
    });
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Hosted Support Bundle Team" }
    });
    expect(createdTeam.statusCode, createdTeam.body).toBe(200);
    const team = jsonBody<TeamResponse>(createdTeam).team;
    const bundleResponse = await app.inject({
      method: "POST",
      url: `/ops/support/teams/${team.id}/bundle`,
      headers: browserSessionHeaders(cookieHeader(operator))
    });
    const auditEventsResponse = await app.inject({
      method: "GET",
      url: `/v1/teams/${team.id}/audit-events`,
      headers: browserSessionHeaders(ownerCookie)
    });
    await app.close();

    expect(bundleResponse.statusCode).toBe(200);
    expect(bundleResponse.body).not.toContain("password123");
    expect(bundleResponse.body).not.toContain("cm_session=");
    const body = jsonBody<{
      redacted: boolean;
      encryptedPackage: EncryptedJsonPackage;
    }>(bundleResponse);
    expect(body.redacted).toBe(true);
    expect(body.encryptedPackage.manifest).toMatchObject({
      objectClass: "support_bundle",
      scope: {
        tenantId: team.id,
        teamId: team.id,
        objectClass: "support_bundle"
      },
      metadata: {
        teamId: team.id,
        reason: "hosted_support_diagnostics",
        redacted: true
      }
    });
    expect(JSON.stringify(body.encryptedPackage.manifest)).not.toContain(
      "Hosted Support Bundle Team"
    );
    const decrypted = await decryptEncryptedJsonPackage<{
      redacted: boolean;
      supportOverview: TeamSupportOverviewRecord;
    }>(provider, body.encryptedPackage);
    expect(decrypted).toMatchObject({
      redacted: true,
      supportOverview: {
        team: { id: team.id, name: "Hosted Support Bundle Team" },
        supportAccess: {
          policy: "hosted_operator_redacted",
          rawContentAccess: "not_permitted"
        }
      }
    });
    const auditEvents =
      jsonBody<TeamAuditEventsResponse>(auditEventsResponse).auditEvents;
    expect(auditEvents.map((event) => event.action)).toContain(
      "team.hosted_support_bundle.created"
    );
    expect(
      auditEvents.find(
        (event) => event.action === "team.hosted_support_bundle.created"
      )
    ).toMatchObject({
      targetTable: "teams",
      targetId: team.id,
      metadata: {
        teamId: team.id,
        policy: "hosted_operator_redacted",
        rawContentAccess: "not_permitted"
      }
    });
  });

  it("fails closed for hosted support bundles without envelope encryption", async () => {
    process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    process.env.KOED_OPS_OPERATOR_EMAILS = "ops-bundle-required@example.test";
    configureTestWorkos();
    const repository = createFakeRepository();
    const app = await buildServer({ repository });
    const ownerCookie = await createVerifiedWorkosSessionForTest(
      repository,
      "hosted-support-bundle-required-owner@example.test"
    );
    const operator = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "ops-bundle-required@example.test",
        password: "password123"
      }
    });
    const createdTeam = await app.inject({
      method: "POST",
      url: "/v1/teams",
      headers: browserSessionHeaders(ownerCookie, {
        "idempotency-key": randomUUID()
      }),
      payload: { name: "Hosted Support Bundle Required Team" }
    });
    expect(createdTeam.statusCode, createdTeam.body).toBe(200);
    const team = jsonBody<TeamResponse>(createdTeam).team;
    const response = await app.inject({
      method: "POST",
      url: `/ops/support/teams/${team.id}/bundle`,
      headers: browserSessionHeaders(cookieHeader(operator))
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("password123");
  });

  it("does not expose provider configuration routes", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "provider@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const saved = await app.inject({
      method: "POST",
      url: "/provider-configs",
      headers: browserSessionHeaders(cookie),
      payload: {
        provider: "openai-compatible",
        visibility: "personal",
        apiKey: "sk-test",
        baseUrl: "https://models.example.test/v1",
        embeddingModel: "embed-model",
        summaryModel: "summary-model",
        answerModel: "answer-model",
        embeddingDimensions: 1536,
        enabled: true
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/provider-configs",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(saved.statusCode).toBe(404);
    expect(listed.statusCode).toBe(404);
  });

  it("supports MCP bearer access checks and rejects cookie auth on v1 endpoints", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "mcp-check@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    expect(createdToken.statusCode).toBe(200);
    const token = jsonBody<TokenResponse>(createdToken).token;
    const rejectedCookie = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: browserSessionHeaders(cookie)
    });
    const checked = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: { authorization: `Bearer ${token}` }
    });
    const rejectedCookieRoutes = await Promise.all([
      app.inject({
        method: "GET",
        url: "/v1/capture-policy/effective?projectId=repo-a",
        headers: browserSessionHeaders(cookie)
      }),
      app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: browserSessionHeaders(cookie),
        payload: {}
      }),
      app.inject({
        method: "POST",
        url: "/v1/memory/capture-personal-event",
        headers: browserSessionHeaders(cookie),
        payload: {}
      }),
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items",
        headers: browserSessionHeaders(cookie),
        payload: {}
      }),
      app.inject({
        method: "POST",
        url: "/v1/memory/token-usage",
        headers: browserSessionHeaders(cookie),
        payload: {}
      }),
      app.inject({
        method: "GET",
        url: "/v1/memory/token-usage/rollups",
        headers: browserSessionHeaders(cookie)
      }),
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items/project",
        headers: browserSessionHeaders(cookie),
        payload: {}
      })
    ]);
    await app.close();

    expect(rejectedCookie.statusCode).toBe(401);
    expect(checked.statusCode).toBe(200);
    expect(jsonBody<AccessResponse>(checked).auth).toBe("bearer_api_token");
    expect(rejectedCookieRoutes.map((response) => response.statusCode)).toEqual(
      rejectedCookieRoutes.map(() => 401)
    );
    for (const response of rejectedCookieRoutes) {
      expect(jsonBody<{ error: string }>(response).error).toBe(
        "Bearer API token required"
      );
    }
  });

  it("keeps hosted sync operations invisible to non-operator sessions", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    process.env.KOED_OPS_OPERATOR_EMAILS = "sync-operator@example.com";
    const app = await buildServer({ repository: createFakeRepository() });
    const member = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "sync-member@example.com", password: "password123" }
    });
    const operator = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "sync-operator@example.com", password: "password123" }
    });

    const memberDetails = await app.inject({
      method: "GET",
      url: "/health/details",
      headers: browserSessionHeaders(cookieHeader(member))
    });
    const memberStatus = await app.inject({
      method: "GET",
      url: "/self-host/status",
      headers: browserSessionHeaders(cookieHeader(member))
    });
    const operatorDetails = await app.inject({
      method: "GET",
      url: "/health/details",
      headers: browserSessionHeaders(cookieHeader(operator))
    });
    await app.close();

    expect(memberDetails.statusCode).toBe(403);
    expect(memberStatus.statusCode).toBe(200);
    expect(jsonBody<{ redacted: boolean }>(memberStatus).redacted).toBe(true);
    expect(memberStatus.body).not.toContain("crossIdentitySync");
    expect(operatorDetails.statusCode).toBe(200);
    expect(operatorDetails.body).toContain("crossIdentitySync");
  });

  it("keeps Cross-Identity Sync behind profile and scoped device boundaries", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    const targetApp = await buildServer({ repository: createFakeRepository() });
    const registered = await targetApp.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "sync-boundary@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await targetApp.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Sync boundary API Token" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const relationshipId = randomUUID();
    const bearerTargetRequests = await Promise.all([
      targetApp.inject({
        method: "POST",
        url: "/v1/cross-identity-sync/intake/relationships",
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      }),
      targetApp.inject({
        method: "POST",
        url: `/v1/cross-identity-sync/relationships/${relationshipId}/upload-sessions`,
        headers: { authorization: `Bearer ${token}` },
        payload: {}
      }),
      targetApp.inject({
        method: "GET",
        url: `/v1/cross-identity-sync/relationships/${relationshipId}`,
        headers: { authorization: `Bearer ${token}` }
      }),
      targetApp.inject({
        method: "POST",
        url: `/v1/cross-identity-sync/relationships/${relationshipId}/retry`,
        headers: { authorization: `Bearer ${token}` }
      })
    ]);
    expect(bearerTargetRequests.map((response) => response.statusCode)).toEqual(
      [401, 401, 403, 403]
    );

    const readOnlyDevice = await enrollDeviceCredentialForTest(
      targetApp,
      cookie,
      ["team_workspace_read"]
    );
    const rejectedScope = await targetApp.inject({
      method: "POST",
      url: "/v1/cross-identity-sync/intake/relationships",
      headers: { authorization: readOnlyDevice.authorization },
      payload: {}
    });
    expect(rejectedScope.statusCode).toBe(403);

    const syncDevice = await enrollDeviceCredentialForTest(targetApp, cookie, [
      "sync"
    ]);
    const malformedAfterAuth = await targetApp.inject({
      method: "POST",
      url: "/v1/cross-identity-sync/intake/relationships",
      headers: { authorization: syncDevice.authorization },
      payload: {}
    });
    expect(malformedAfterAuth.statusCode).toBe(400);
    await targetApp.close();

    process.env.KOED_DEPLOYMENT_PROFILE = "developer";
    const sourceApp = await buildServer({ repository: createFakeRepository() });
    const sourceRegistered = await sourceApp.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "sync-source-boundary@example.com",
        password: "password123"
      }
    });
    const sourceCookie = cookieHeader(sourceRegistered);
    const sourceTokenResponse = await sourceApp.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(sourceCookie),
      payload: { name: "Source boundary API Token" }
    });
    const sourceToken = jsonBody<TokenResponse>(sourceTokenResponse).token;
    const rejectedSourceToken = await sourceApp.inject({
      method: "POST",
      url: "/v1/cross-identity-sync/relationships",
      headers: { authorization: `Bearer ${sourceToken}` },
      payload: {}
    });
    const rejectedLocalIntake = await sourceApp.inject({
      method: "POST",
      url: "/v1/cross-identity-sync/intake/relationships",
      headers: browserSessionHeaders(sourceCookie),
      payload: {}
    });
    expect(rejectedSourceToken.statusCode).toBe(401);
    expect(rejectedLocalIntake.statusCode).toBe(404);
    await sourceApp.close();
  });

  it("requires verified deployment identity before source and target sync initialization", async () => {
    const unhealthyIdentity = () => ({
      health: "missing_proof" as const,
      deploymentId: "00000000-0000-4000-8000-000000000001",
      deviceInstanceId: "00000000-0000-4000-8000-000000000002",
      remoteOperationsAllowed: false,
      message: "Device identity proof is missing.",
      action: "Rotate identity.",
      platformProtection: "verified" as const
    });
    const sourceApp = await buildServer({
      repository: createFakeRepository(),
      inspectDeploymentIdentity: unhealthyIdentity
    });
    const sourceRegistered = await sourceApp.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "sync-unverified-source@example.com",
        password: "password123"
      }
    });
    const source = await sourceApp.inject({
      method: "POST",
      url: "/v1/cross-identity-sync/relationships",
      headers: browserSessionHeaders(cookieHeader(sourceRegistered)),
      payload: {
        session_id: randomUUID(),
        upstream_backend_id: "team-vps",
        idempotency_key: `sync-${randomUUID()}`,
        consent: {
          consented_at: new Date().toISOString(),
          policy_version: 1,
          source_boundary: "captured_session"
        }
      }
    });
    await sourceApp.close();

    process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
    const targetApp = await buildServer({
      repository: createFakeRepository(),
      inspectDeploymentIdentity: unhealthyIdentity
    });
    const targetRegistered = await targetApp.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "sync-unverified-target@example.com",
        password: "password123"
      }
    });
    const targetCredential = await enrollDeviceCredentialForTest(
      targetApp,
      cookieHeader(targetRegistered),
      ["sync"]
    );
    const target = await targetApp.inject({
      method: "POST",
      url: "/v1/cross-identity-sync/intake/context",
      headers: { authorization: targetCredential.authorization },
      payload: {}
    });
    await targetApp.close();

    expect(source.statusCode, source.body).toBe(424);
    expect(target.statusCode, target.body).toBe(424);
    expect(jsonBody<{ error: string }>(source).error).toBe(
      "Local deployment identity is not verified"
    );
    expect(jsonBody<{ error: string }>(target).error).toBe(
      "Local deployment identity is not verified"
    );
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "writes encrypted Memory Event companions through the real API repository wiring",
    async () => {
      process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
      process.env.KOED_DEPLOYMENT_PROFILE = "team_self_hosted";
      process.env.API_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.API_ENVELOPE_ENCRYPTION_PROVIDER = "local_test_key";
      const app = await buildServer({ runMemoryJobsInlineForTests: true });
      const queryPool = createDbPool();
      try {
        const registered = await app.inject({
          method: "POST",
          url: "/auth/register",
          payload: {
            email: `encrypted-api-capture-${randomUUID()}@example.com`,
            password: "password123"
          }
        });
        const cookie = cookieHeader(registered);
        const createdToken = await app.inject({
          method: "POST",
          url: "/api-tokens",
          headers: browserSessionHeaders(cookie),
          payload: { name: "Encrypted Capture Client" }
        });
        const token = jsonBody<TokenResponse>(createdToken).token;
        const content =
          "Runtime API encryption wiring sentinel should not appear in encrypted payload rows";
        const captured = await app.inject({
          method: "POST",
          url: "/v1/memory/capture-personal-event",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            actor: "user",
            eventType: "user_prompt",
            content,
            sourceHash: `encrypted-api-${randomUUID()}`
          }
        });

        expect(captured.statusCode).toBe(200);
        const event = jsonBody<CaptureResponse>(captured).event;
        const encrypted = await queryPool.query<{
          provider_mode: string;
          source_table: string;
          source_column: string;
          ciphertext: string;
          provenance: { sourceId?: string };
        }>(
          `
            select provider_mode, source_table, source_column, ciphertext, provenance
            from encrypted_field_payloads
            where source_table = 'memory_events'
              and source_id = $1
              and source_column = 'payload'
              and invalidated_at is null
          `,
          [event.id]
        );

        expect(encrypted.rowCount).toBe(1);
        expect(encrypted.rows[0]).toMatchObject({
          provider_mode: "local_test_key",
          source_table: "memory_events",
          source_column: "payload"
        });
        expect(encrypted.rows[0]?.provenance.sourceId).toBe(event.id);
        expect(JSON.stringify(encrypted.rows[0])).not.toContain(content);

        const storedEvent = await queryPool.query<{ payload_text: string }>(
          `
            select payload::text as payload_text
            from memory_events
            where id = $1
          `,
          [event.id]
        );
        expect(storedEvent.rows[0]?.payload_text).toContain(
          '"contentEncrypted": true'
        );
        expect(storedEvent.rows[0]?.payload_text).not.toContain('"content":');
        expect(storedEvent.rows[0]?.payload_text).not.toContain(content);
      } finally {
        await queryPool.end();
        await app.close();
      }
    }
  );

  it("captures conversation memory through MCP endpoints", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "mcp-memory@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const headers = { authorization: `Bearer ${token}` };
    const capturedSession = await createCapturedSessionForTest(
      app,
      headers.authorization,
      { externalSessionId: "thread-api-test" }
    );

    const personal = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "Alice prefers concise changelog summaries"
      }
    });
    const search = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "personal" }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "personal" }
    });
    const rawConversationItems = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers,
      payload: {
        items: [
          {
            sessionId: capturedSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalThreadId: "thread-api-test",
            externalTurnId: "turn-api-test",
            sourceRecordType: "app_server_notification",
            sourceEventType: "turn/completed",
            sourceSequence: 0,
            rawJson: { method: "turn/completed" },
            sourceHash: "api-raw-source-hash",
            idempotencyKey: "api-raw-idempotency-key"
          }
        ]
      }
    });
    const tokenUsage = await app.inject({
      method: "POST",
      url: "/v1/memory/token-usage",
      headers,
      payload: {
        workflowType: "memory_question",
        workflowId: "question-api-test",
        answerJobId: "question-api-test",
        sourceReferences: [{ type: "answer_job", id: "question-api-test" }],
        usageSource: "local_estimate",
        usageAccuracy: "local_estimate",
        usageKind: "estimate",
        connectorClient: "codex",
        tokenizerPackage: "js-tiktoken",
        tokenizerEncoding: "o200k_base",
        tokenizerModel: "gpt-5-codex",
        tokenizerExactModelMatch: true,
        tokenizerHeuristicFallback: false,
        tokenizerVersion: "test",
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 2,
        totalTokens: 6,
        usageScope: "last"
      }
    });
    const release = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/release",
      headers,
      payload: {
        sessionId: capturedSession.id,
        externalTurnId: "turn-api-test"
      }
    });
    const tokenUsageRollups = await app.inject({
      method: "GET",
      url: "/v1/memory/token-usage/rollups?group_by=workflow&include_estimates=false",
      headers
    });
    const projection = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/project",
      headers,
      payload: { limit: 10 }
    });
    const rejectedSharedAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "concise changelog", retrieval_scope: "shared" }
    });
    const cookieAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: browserSessionHeaders(cookie),
      payload: { query: "concise changelog", retrieval_scope: "personal" }
    });
    await app.close();

    expect(personal.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(personal).event.visibility).toBe(
      "personal"
    );
    expect(search.statusCode).toBe(200);
    expect(jsonBody<SearchResponse>(search).hits).toHaveLength(1);
    expect(answer.statusCode).toBe(200);
    const answerBody = jsonBody<AnswerResponse>(answer);
    expect(answerBody.markdown).toContain("Evidence bundle returned");
    expect(answerBody.evidenceBundle.instructions).toContain(
      "Codex should synthesize"
    );
    expect(answerBody.evidence[0]?.summaryText).toContain("concise changelog");
    expect(answerBody.citations).toHaveLength(1);
    expect(rawConversationItems.statusCode).toBe(200);
    expect(
      jsonBody<{ items: unknown[] }>(rawConversationItems).items
    ).toHaveLength(1);
    expect(tokenUsage.statusCode).toBe(200);
    expect(release.statusCode).toBe(200);
    expect(tokenUsageRollups.statusCode).toBe(200);
    expect(
      jsonBody<{ rollups: Array<{ totalTokens: number }> }>(tokenUsageRollups)
        .rollups[0]?.totalTokens
    ).toBe(6);
    expect(projection.statusCode).toBe(200);
    expect(rejectedSharedAnswer.statusCode).toBe(400);
    expect(cookieAnswer.statusCode).toBe(200);
    expect(
      jsonBody<AnswerResponse>(cookieAnswer).evidence[0]?.summaryText
    ).toContain("concise changelog");
  });

  it("keeps historical rows out of direct live Projection requests", async () => {
    const repository = createFakeRepository();
    const projectPendingConversationItems = vi.spyOn(
      repository,
      "projectPendingConversationItems"
    );
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "live-projection-only@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Projection Client" }
    });
    expect(createdToken.statusCode, createdToken.body).toBe(200);
    const token = jsonBody<TokenResponse>(createdToken).token;

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/project",
      headers: { authorization: `Bearer ${token}` },
      payload: { limit: 10 }
    });
    await app.close();

    expect(response.statusCode, response.body).toBe(200);
    expect(projectPendingConversationItems).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        limit: 10,
        visibility: "personal",
        workClass: "live_capture_projection"
      })
    );
  });

  it.skipIf(!process.env.DATABASE_URL)(
    "leaves explicit historical ids pending through direct Projection",
    async () => {
      process.env.KOED_ALLOW_PUBLIC_REGISTRATION = "true";
      process.env.WORK_QUEUE_BACKEND = "local";
      const app = await buildServer();
      const queryPool = createDbPool();
      try {
        const email = `historical-direct-${randomUUID()}@example.com`;
        const registered = await app.inject({
          method: "POST",
          url: "/auth/register",
          payload: {
            email,
            password: "password123"
          }
        });
        const cookie = cookieHeader(registered);
        const createdToken = await app.inject({
          method: "POST",
          url: "/api-tokens",
          headers: browserSessionHeaders(cookie),
          payload: { name: "Historical Direct Test" }
        });
        expect(createdToken.statusCode).toBe(200);
        const token = jsonBody<TokenResponse>(createdToken).token;
        const headers = { authorization: `Bearer ${token}` };
        const session = await createCapturedSessionForTest(
          app,
          headers.authorization
        );
        const user = await queryPool.query<{ id: string }>(
          "select id from users where email = $1",
          [email]
        );
        const [item] = await createMemorySourceRepository(
          queryPool
        ).createConversationItems(
          { userId: user.rows[0]!.id },
          {
            items: [
              {
                sessionId: session.id,
                sourceKind: "codex",
                sourceAdapterVersion: "codex-history-v1",
                sourceTransport: "historical_import",
                sourceRecordType: "app_server_notification",
                sourceEventType: "item/completed",
                rawJson: {
                  method: "item/completed",
                  params: { item: { type: "userMessage", text: "History" } }
                },
                sourceHash: `history-${randomUUID()}`,
                idempotencyKey: `history-${randomUUID()}`,
                metadata: { transcriptType: "user_message" }
              }
            ]
          }
        );
        const itemId = item!.id;

        const projected = await app.inject({
          method: "POST",
          url: "/v1/memory/conversation-items/project",
          headers,
          payload: { conversationItemIds: [itemId], limit: 10 }
        });
        const stored = await queryPool.query<{ projection_status: string }>(
          "select projection_status from conversation_items where id = $1",
          [itemId]
        );

        expect(projected.statusCode).toBe(200);
        expect(
          jsonBody<{ projection: { rawItemsScanned: number } }>(projected)
            .projection.rawItemsScanned
        ).toBe(0);
        expect(stored.rows[0]?.projection_status).toBe("pending");
      } finally {
        await app.close();
        await queryPool.end();
      }
    }
  );

  it("sanitizes storage-unsafe strings before forwarding raw conversation item ingestion", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const forwardedInputs: Array<Record<string, unknown>> = [];
    repository.createConversationItems = async (actor, input) => {
      forwardedInputs.push(input as Record<string, unknown>);
      const encodedInput = JSON.stringify(input);
      if (encodedInput.includes("\u0000") || encodedInput.includes("\\u0000")) {
        throw new Error("Repository received unsanitized NUL");
      }
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "nul-raw-ingestion@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const capturedSession = await createCapturedSessionForTest(
      app,
      `Bearer ${token}`,
      { externalSessionId: "nul-api-thread" }
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        items: [
          {
            sessionId: capturedSession.id,
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            rawJson: {
              method: "item/completed",
              params: {
                item: {
                  type: "agentMessage",
                  text: `Raw API text a${"\u0000"}b${"\uD800"}c`
                }
              }
            },
            rawText: `Raw text 你好 🚀\nline a${"\u0000"}b`,
            sourceHash: "nul-api-source-hash",
            idempotencyKey: "nul-api-idempotency-key",
            canonicalSourcePriority: 999999,
            projectionStatus: "projected",
            projectionVersion: "forged-client-version",
            metadata: { label: `metadata a${"\u0000"}b`, valid: "Cafe\u0301" }
          }
        ]
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const forwardedItem = (
      forwardedInputs[0]?.items as Array<{
        rawJson: { params: { item: { text: string } } };
        rawText: string;
        metadata: Record<string, unknown>;
      }>
    )?.[0];
    expect(forwardedItem?.rawJson.params.item.text).toBe("Raw API text a�b�c");
    expect(forwardedItem?.rawText).toBe("Raw text 你好 🚀\nline a�b");
    expect(forwardedItem?.metadata).toMatchObject({
      valid: "Cafe\u0301",
      koedSanitization: {
        nulCharacters: {
          replacement: "U+FFFD",
          replacementCount: 3
        },
        malformedUtf16: {
          replacement: "U+FFFD",
          replacementCount: 1
        }
      }
    });
    expect(JSON.stringify(forwardedItem)).not.toContain("\\u0000");
    expect(forwardedItem).not.toHaveProperty("canonicalSourcePriority");
    expect(forwardedItem).not.toHaveProperty("projectionStatus");
    expect(forwardedItem).not.toHaveProperty("projectionVersion");
  });

  it("rejects raw JSON and metadata that exceed byte, depth, or entry limits", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    let repositoryWriteCalls = 0;
    repository.createConversationItems = async (actor, input) => {
      repositoryWriteCalls += 1;
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "raw-shape-limits@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const nestedValue = (levels: number): unknown => {
      let value: unknown = "leaf";
      for (let index = 0; index < levels; index += 1) {
        value = { child: value };
      }
      return value;
    };
    const oversizedMetadata = Object.fromEntries(
      Array.from({ length: 4_097 }, (_, index) => [`field-${index}`, null])
    );
    const missingRawJson = rawConversationItemPayload(session.id) as Record<
      string,
      unknown
    >;
    delete missingRawJson.rawJson;
    const invalidItems = [
      missingRawJson,
      rawConversationItemPayload(session.id, {
        rawJson: { value: "é".repeat(1_000_001) }
      }),
      rawConversationItemPayload(session.id, {
        metadata: { value: "é".repeat(131_073) }
      }),
      rawConversationItemPayload(session.id, { rawJson: nestedValue(64) }),
      rawConversationItemPayload(session.id, { metadata: nestedValue(32) }),
      rawConversationItemPayload(session.id, {
        rawJson: Array.from({ length: 50_001 }, () => null)
      }),
      rawConversationItemPayload(session.id, { metadata: oversizedMetadata })
    ];
    const responses = [];
    for (const item of invalidItems) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/memory/conversation-items",
          headers: { authorization: client.authorization },
          payload: { items: [item] }
        })
      );
    }
    await app.close();

    for (const response of responses) {
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.statusCode).toBeLessThan(500);
    }
    expect(repositoryWriteCalls).toBe(0);
  });

  it("accepts exact batch and transport chunk maxima and rejects overflow", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    let repositoryWriteCalls = 0;
    repository.createConversationItems = async (actor, input) => {
      repositoryWriteCalls += 1;
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "raw-batch-limits@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const batch = Array.from({ length: 1_000 }, (_, index) =>
      rawConversationItemPayload(session.id, {
        sourceSequence: index,
        rawJson: null,
        sourceHash: `batch-source-${index}`,
        idempotencyKey: `batch-idempotency-${index}`
      })
    );
    const acceptedBatch = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: { items: batch }
    });
    const chunkLogicalSourceId = "codex://chunk/max";
    const chunkSourceItemHash = "chunk-max-source-item";
    const chunkEncoding = "conversation-item-json-v2";
    const chunkGroupId = rawConversationTransportChunkGroupId({
      sourceKind: "codex",
      sourceAdapterVersion: "codex-app-server-v1",
      sourceTransport: "app_server",
      logicalSourceId: chunkLogicalSourceId,
      sourceItemHash: chunkSourceItemHash,
      transportChunkCount: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
      transportChunkEncoding: chunkEncoding
    });
    const acceptedChunk = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            logicalSourceId: chunkLogicalSourceId,
            transportChunkIndex: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT - 1,
            transportChunkCount: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
            transportChunkText: "x".repeat(
              RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES
            ),
            transportChunkEncoding: chunkEncoding,
            rawJson: {
              transportChunk: true,
              sourceItemHash: chunkSourceItemHash,
              transportChunkGroupId: chunkGroupId
            },
            metadata: {
              sourceItemHash: chunkSourceItemHash,
              transportChunkGroupId: chunkGroupId,
              sourceChunkIndex: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT - 1,
              sourceChunkCount: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT
            }
          })
        ]
      }
    });
    const rejectedBatch = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          ...batch,
          rawConversationItemPayload(session.id, {
            sourceSequence: 1_000,
            sourceHash: "batch-source-1000",
            idempotencyKey: "batch-idempotency-1000"
          })
        ]
      }
    });
    const rejectedChunkIndex = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            transportChunkIndex: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
            transportChunkCount: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT
          })
        ]
      }
    });
    const rejectedChunkCount = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            transportChunkIndex: 0,
            transportChunkCount: RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT + 1
          })
        ]
      }
    });
    const rejectedChunkText = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            transportChunkText: "x".repeat(
              RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES + 1
            )
          })
        ]
      }
    });
    await app.close();

    expect(acceptedBatch.statusCode).toBe(200);
    expect(
      jsonBody<{ acceptedCount: number }>(acceptedBatch).acceptedCount
    ).toBe(1_000);
    expect(acceptedChunk.statusCode).toBe(200);
    expect(
      [
        rejectedBatch,
        rejectedChunkIndex,
        rejectedChunkCount,
        rejectedChunkText
      ].map((response) => response.statusCode)
    ).toEqual([400, 400, 400, 400]);
    expect(repositoryWriteCalls).toBe(2);
  });

  it("rejects incomplete and inconsistent raw transport chunk tuples", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    let repositoryWriteCalls = 0;
    repository.createConversationItems = async (actor, input) => {
      repositoryWriteCalls += 1;
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "raw-chunk-tuples@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const invalidChunks = [
      { transportChunkIndex: 0 },
      {
        transportChunkIndex: 0,
        transportChunkCount: 1,
        transportChunkText: "chunk without encoding"
      },
      { transportChunkEncoding: "conversation-item-json-v2" },
      {
        transportChunkIndex: 1,
        transportChunkCount: 1,
        transportChunkText: "out of range",
        transportChunkEncoding: "conversation-item-json-v2"
      },
      {
        transportChunkIndex: 2,
        transportChunkCount: 2,
        transportChunkText: "also out of range",
        transportChunkEncoding: "conversation-item-json-v2"
      }
    ];
    const responses = [];
    for (const chunk of invalidChunks) {
      responses.push(
        await app.inject({
          method: "POST",
          url: "/v1/memory/conversation-items",
          headers: { authorization: client.authorization },
          payload: {
            items: [rawConversationItemPayload(session.id, chunk)]
          }
        })
      );
    }
    await app.close();

    expect(responses.map((response) => response.statusCode)).toEqual(
      responses.map(() => 400)
    );
    expect(repositoryWriteCalls).toBe(0);
  });

  it("accepts underscore-prefixed tool names without rejecting later batch items", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const forwardedItems: ConversationItemInput[] = [];
    repository.createConversationItems = async (actor, input) => {
      forwardedItems.push(...input.items);
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "underscore-tool-name@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            sourceEventType: "function_call",
            metadata: {
              toolName: "_read_file",
              toolCall: { name: "_read_file" }
            }
          }),
          rawConversationItemPayload(session.id, {
            sourceEventType: "agent_message",
            rawText: "The item after the tool call still ingests."
          })
        ]
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(forwardedItems).toHaveLength(2);
    expect(forwardedItems[0]?.metadata).toMatchObject({
      toolName: "_read_file",
      toolCall: { name: "_read_file" }
    });
    expect(forwardedItems[1]?.rawText).toBe(
      "The item after the tool call still ingests."
    );
  });

  it("rejects caller-asserted normalized imports on the API-token route", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const forwardedItems: ConversationItemInput[] = [];
    repository.createConversationItems = async (actor, input) => {
      forwardedItems.push(...input.items);
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "normalized-import@example.com"
    );
    const externalThreadId = `normalized-thread-${randomUUID()}`;
    const externalTurnId = "source-attempt-1";
    const stableItemId = "atif-step-4-message";
    const session = await createCapturedSessionForTest(
      app,
      client.authorization,
      { externalSessionId: externalThreadId }
    );
    const normalizedItem = rawConversationItemPayload(session.id, {
      sourceKind: "codex",
      sourceAdapterVersion: "koed-normalized-import-v1",
      sourceTransport: "normalized_import",
      externalSessionId: externalThreadId,
      externalThreadId,
      externalTurnId,
      externalItemId: stableItemId,
      canonicalStableItemId: stableItemId,
      canonicalItemKey: codexCanonicalConversationItemKeyForTest({
        externalThreadId,
        externalTurnId,
        stableItemId,
        component: "message"
      }),
      observationComponent: "message",
      sourceRecordType: "normalized_import_item",
      sourceEventType: "agent_message",
      sourceSequence: 4,
      rawJson: {
        type: "normalized_import_item",
        content: "A sanitized AI Client-visible message."
      },
      rawText: "A sanitized AI Client-visible message.",
      metadata: {
        transcriptType: "agent_message",
        normalizedImportProvenance: {
          sourceFormat: "atif",
          sourceSchemaVersion: "ATIF-v1.7",
          sourceProducer: "harbor-codex"
        }
      }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: { items: [normalizedItem] }
    });
    await app.close();

    expect(response.statusCode).toBe(400);
    expect(forwardedItems).toEqual([]);
  });

  it("rejects content-like provider identifiers while accepting Codex IDs", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const forwardedItems: ConversationItemInput[] = [];
    repository.createConversationItems = async (actor, input) => {
      forwardedItems.push(...input.items);
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "raw-provider-identifiers@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const threadId = "019cda8a-7b0d-7d70-b634-5c93dd43286a";
    const validIdentifiers = {
      externalSessionId: threadId,
      externalThreadId: threadId,
      externalTurnId: "turn_019cda8a-7b0d-7d70-b634-5c93dd43286b",
      externalItemId: "item_019cda8a-7b0d-7d70-b634-5c93dd43286c",
      parentExternalItemId: "call_4J6mVQp/A@9:result",
      logicalSourceId: `codex://thread/${threadId}/turn/1`,
      canonicalStableItemId:
        "koed-user-message:019cda8a-7b0d-7d70-b634-5c93dd43286d"
    };
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [rawConversationItemPayload(session.id, validIdentifiers)]
      }
    });
    const invalidIdentifiers = [
      ["externalSessionId", " thread-id"],
      ["externalThreadId", "thread id"],
      ["externalTurnId", `turn${"\u0000"}id`],
      ["externalItemId", "assistant response content"],
      ["parentExternalItemId", '{"role":"assistant"}'],
      ["logicalSourceId", "<tool_call>memory</tool_call>"],
      ["canonicalStableItemId", "message\tcontent"]
    ] as const;
    const rejected = [];
    for (const [field, value] of invalidIdentifiers) {
      rejected.push(
        await app.inject({
          method: "POST",
          url: "/v1/memory/conversation-items",
          headers: { authorization: client.authorization },
          payload: {
            items: [rawConversationItemPayload(session.id, { [field]: value })]
          }
        })
      );
    }
    await app.close();

    expect(accepted.statusCode).toBe(200);
    expect(rejected.map((response) => response.statusCode)).toEqual(
      rejected.map(() => 400)
    );
    expect(forwardedItems).toEqual([expect.objectContaining(validIdentifiers)]);
  });

  it("accepts only content-free Capture Hook boundaries with exact turn identity", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const client = await registerApiClientForTest(
      app,
      "hook-turn-boundary@example.com"
    );
    const externalThreadId = `hook-thread-${randomUUID()}`;
    const externalTurnId = `hook-turn-${randomUUID()}`;
    const session = await createCapturedSessionForTest(
      app,
      client.authorization,
      { externalSessionId: externalThreadId }
    );
    const stableItemId = `turn:${externalTurnId}:completed`;
    const canonicalItemKey = codexCanonicalConversationItemKeyForTest({
      externalThreadId,
      externalTurnId,
      stableItemId,
      component: "control"
    });
    const payload = {
      sessionId: session.id,
      sourceKind: "codex",
      sourceAdapterVersion: "codex-hook-signal-v1",
      sourceTransport: "hook_signal",
      externalSessionId: externalThreadId,
      externalThreadId,
      externalTurnId,
      externalItemId: stableItemId,
      canonicalStableItemId: stableItemId,
      canonicalItemKey,
      observationKind: "control",
      observationComponent: "control",
      sourceRecordType: "hook_signal",
      sourceEventType: "turn_completed",
      sourceSequence: 4,
      eventTime: "2026-07-26T00:00:04.000Z",
      observedAt: "2026-07-26T00:00:04.000Z",
      rawJson: {
        type: "hook_signal",
        payload: {
          type: "turn_completed",
          sourceFrontierOffset: 1_024,
          sourceFrontierLine: 4
        }
      },
      sourceHash: `hook-boundary-${randomUUID()}`,
      idempotencyKey: `hook-boundary-${randomUUID()}`,
      metadata: {}
    };
    const ingest = (overrides: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items",
        headers: { authorization: client.authorization },
        payload: { items: [{ ...payload, ...overrides }] }
      });

    const accepted = await ingest();
    const rejectedContent = await ingest({
      sourceHash: `hook-boundary-${randomUUID()}`,
      idempotencyKey: `hook-boundary-${randomUUID()}`,
      rawText: "forged assistant output"
    });
    const rejectedFrontier = await ingest({
      sourceHash: `hook-boundary-${randomUUID()}`,
      idempotencyKey: `hook-boundary-${randomUUID()}`,
      rawJson: {
        type: "hook_signal",
        payload: { type: "turn_completed", sourceFrontierOffset: -1 }
      }
    });
    const rejectedIdentity = await ingest({
      sourceHash: `hook-boundary-${randomUUID()}`,
      idempotencyKey: `hook-boundary-${randomUUID()}`,
      canonicalItemKey: `conversation-item:${"0".repeat(64)}`
    });
    await app.close();

    expect(accepted.statusCode).toBe(200);
    expect([
      rejectedContent.statusCode,
      rejectedFrontier.statusCode,
      rejectedIdentity.statusCode
    ]).toEqual([400, 400, 400]);
  });

  it("closes managed-profile plaintext classification side channels", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const forwardedItems: ConversationItemInput[] = [];
    repository.createConversationItems = async (actor, input) => {
      forwardedItems.push(...input.items);
      return createConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "managed-raw-classification@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: client.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            sourceRecordType: "app_server_notification",
            sourceEventType: "item/completed",
            sourceHash: "sha256:0123456789abcdef",
            idempotencyKey: "codex-observation:0123456789abcdef",
            metadata: {
              projectId: "/home/user/My Koed Project",
              transcriptType: "agent_message",
              threadKind: "conversation",
              appServerItemType: "agentMessage",
              sourceEventTimeAccuracy: "observation_only",
              canonicalIdentityBasis: "provider_ids",
              managedConversation: true,
              semanticControl: "turn_completed",
              projectionPolicyKey: "managed_context_user",
              projectionActor: "system"
            }
          })
        ]
      }
    });
    const unsafeOverrides = [
      { sourceRecordType: "app server notification includes a prompt" },
      { sourceEventType: "item/completed\nraw assistant content" },
      { sourceHash: "hash containing plaintext content" },
      { idempotencyKey: "observation key containing plaintext content" },
      { metadata: { transcriptType: "agent message with raw content" } },
      {
        metadata: {
          toolCall: {
            kind: "call",
            type: "function_call",
            name: { plaintext: "client-controlled content" },
            id: "call_123"
          }
        }
      }
    ];
    const rejected = [];
    for (const overrides of unsafeOverrides) {
      rejected.push(
        await app.inject({
          method: "POST",
          url: "/v1/memory/conversation-items",
          headers: { authorization: client.authorization },
          payload: {
            items: [rawConversationItemPayload(session.id, overrides)]
          }
        })
      );
    }
    await app.close();

    expect(accepted.statusCode).toBe(200);
    expect(rejected.map((response) => response.statusCode)).toEqual(
      rejected.map(() => 400)
    );
    expect(forwardedItems).toHaveLength(1);
    expect(forwardedItems[0]?.metadata).toMatchObject({
      projectId: "/home/user/My Koed Project",
      transcriptType: "agent_message",
      threadKind: "conversation",
      appServerItemType: "agentMessage",
      sourceEventTimeAccuracy: "observation_only",
      canonicalIdentityBasis: "provider_ids"
    });
    for (const key of [
      "managedConversation",
      "semanticControl",
      "projectionPolicyKey",
      "projectionActor"
    ]) {
      expect(forwardedItems[0]?.metadata).not.toHaveProperty(key);
    }
  });

  it("maps missing, wrong-owner, and mismatched Captured Sessions to 4xx without raw writes", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    let repositoryValidationCalls = 0;
    let createdConversationItems = 0;
    repository.createConversationItems = async (actor, input) => {
      repositoryValidationCalls += 1;
      for (const item of input.items) {
        const session = item.sessionId
          ? await repository.getCapturedSession(actor, item.sessionId)
          : null;
        if (!session) {
          throw Object.assign(new Error("Session not found or not visible"), {
            statusCode: 404,
            code: "conversation_session_not_found"
          });
        }
        const suppliedThreadIds = [
          item.externalSessionId,
          item.externalThreadId
        ].filter((value): value is string => Boolean(value));
        if (
          session.externalSessionId &&
          suppliedThreadIds.some(
            (threadId) => threadId !== session.externalSessionId
          )
        ) {
          throw Object.assign(
            new Error(
              "Conversation source thread does not match its Captured Session"
            ),
            {
              statusCode: 409,
              code: "conversation_session_thread_mismatch"
            }
          );
        }
      }
      const created = await createConversationItems(actor, input);
      createdConversationItems += created.length;
      return created;
    };
    const app = await buildServer({ repository });
    const owner = await registerApiClientForTest(
      app,
      "raw-session-owner@example.com"
    );
    const otherUser = await registerApiClientForTest(
      app,
      "raw-session-other@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      owner.authorization,
      { externalSessionId: "owner-thread-1" }
    );
    const missingSession = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: owner.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            sessionId: undefined,
            externalSessionId: "owner-thread-1",
            externalThreadId: "owner-thread-1"
          })
        ]
      }
    });
    const wrongOwner = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: otherUser.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            externalSessionId: "owner-thread-1",
            externalThreadId: "owner-thread-1"
          })
        ]
      }
    });
    const mismatchedThread = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: { authorization: owner.authorization },
      payload: {
        items: [
          rawConversationItemPayload(session.id, {
            externalSessionId: "different-thread",
            externalThreadId: "different-thread"
          })
        ]
      }
    });
    await app.close();

    expect(
      [missingSession, wrongOwner, mismatchedThread].map(
        (response) => response.statusCode
      )
    ).toEqual([400, 404, 409]);
    expect(repositoryValidationCalls).toBe(2);
    expect(createdConversationItems).toBe(0);
  });

  it("requires a browser session and rate-limits Projection rebuilds", async () => {
    process.env.MEMORY_PROJECTION_REBUILD_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_PROJECTION_REBUILD_RATE_LIMIT_MAX = "1";
    const repository = createFakeRepository();
    let resetCalls = 0;
    repository.resetConversationProjection = async () => {
      resetCalls += 1;
      return {
        conversationItemIds: [],
        invalidatedMemoryEventIds: [],
        projectionPolicyRevision: 1
      };
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "projection-rebuild-auth@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const rejectedApiToken = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/rebuild",
      headers: { authorization: client.authorization },
      payload: { sessionId: session.id }
    });
    const acceptedSession = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/rebuild",
      headers: browserSessionHeaders(client.cookie),
      payload: { sessionId: session.id }
    });
    const rateLimitedSession = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/rebuild",
      headers: browserSessionHeaders(client.cookie),
      payload: { sessionId: session.id }
    });
    await app.close();

    expect(rejectedApiToken.statusCode).toBe(401);
    expect(jsonBody<{ error: string }>(rejectedApiToken).error).toBe(
      "Session cookie required"
    );
    expect(acceptedSession.statusCode).toBe(200);
    expect(acceptedSession.headers["x-ratelimit-limit"]).toBe("1");
    expect(rateLimitedSession.statusCode).toBe(429);
    expect(rateLimitedSession.headers["retry-after"]).toBeDefined();
    expect(resetCalls).toBe(1);
  });

  it("authenticates Projection rebuilds before user-keyed rate limiting", async () => {
    process.env.MEMORY_PROJECTION_REBUILD_RATE_LIMIT_WINDOW_MS = "60000";
    process.env.MEMORY_PROJECTION_REBUILD_RATE_LIMIT_MAX = "1";
    const repository = createFakeRepository();
    let resetCalls = 0;
    repository.resetConversationProjection = async () => {
      resetCalls += 1;
      return {
        conversationItemIds: [],
        invalidatedMemoryEventIds: [],
        projectionPolicyRevision: 1
      };
    };
    const app = await buildServer({ repository });
    const firstClient = await registerApiClientForTest(
      app,
      "projection-rebuild-key-a@example.com"
    );
    const secondClient = await registerApiClientForTest(
      app,
      "projection-rebuild-key-b@example.com"
    );
    const firstSession = await createCapturedSessionForTest(
      app,
      firstClient.authorization
    );
    const secondSession = await createCapturedSessionForTest(
      app,
      secondClient.authorization
    );
    const rebuild = (cookie: string, sessionId: string) =>
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items/rebuild",
        headers: browserSessionHeaders(cookie),
        payload: { sessionId }
      });

    const unauthenticated = await rebuild(
      "cm_session=invalid",
      firstSession.id
    );
    const firstAccepted = await rebuild(firstClient.cookie, firstSession.id);
    const firstLimited = await rebuild(firstClient.cookie, firstSession.id);
    const secondAccepted = await rebuild(secondClient.cookie, secondSession.id);
    await app.close();

    expect(
      [unauthenticated, firstAccepted, firstLimited, secondAccepted].map(
        (response) => response.statusCode
      )
    ).toEqual([401, 200, 429, 200]);
    expect(resetCalls).toBe(2);
  });

  it("fails an oversized Projection rebuild before projecting any raw items", async () => {
    const repository = createFakeRepository();
    let resetCalls = 0;
    let projectionCalls = 0;
    const projectPendingConversationItems =
      repository.projectPendingConversationItems.bind(repository);
    repository.resetConversationProjection = async () => {
      resetCalls += 1;
      throw Object.assign(
        new Error(
          "Conversation projection rebuild exceeds the 10000-item safety limit"
        ),
        { statusCode: 413, code: "projection_rebuild_too_large" }
      );
    };
    repository.projectPendingConversationItems = async (actor, input) => {
      projectionCalls += 1;
      return projectPendingConversationItems(actor, input);
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "projection-rebuild-size@example.com"
    );
    const session = await createCapturedSessionForTest(
      app,
      client.authorization
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items/rebuild",
      headers: browserSessionHeaders(client.cookie),
      payload: { sessionId: session.id }
    });
    await app.close();

    expect(response.statusCode).toBe(413);
    expect(jsonBody<{ error: string }>(response).error).toContain(
      "10000-item safety limit"
    );
    expect(resetCalls).toBe(1);
    expect(projectionCalls).toBe(0);
  });

  it("releases a managed Projection hold only after terminal JSONL reconciliation", async () => {
    const repository = createFakeRepository();
    const createConversationItems =
      repository.createConversationItems.bind(repository);
    const terminalReconciliations = new Set<string>();
    repository.createConversationItems = async (actor, input) => {
      const created = await createConversationItems(actor, input);
      for (const item of input.items) {
        if (
          item.sessionId &&
          item.externalTurnId &&
          item.sourceAdapterVersion === "codex-transcript-v1" &&
          item.sourceTransport === "transcript" &&
          item.observationKind === "reconciliation" &&
          ["task_complete", "turn_aborted"].includes(item.sourceEventType ?? "")
        ) {
          terminalReconciliations.add(
            `${actor.userId}:${item.sessionId}:${item.externalTurnId}`
          );
        }
      }
      return created;
    };
    repository.releaseConversationProjectionHold = async (actor, input) => {
      const session = await repository.getCapturedSession(
        actor,
        input.sessionId
      );
      if (
        !session ||
        session.captureMethod !== "api" ||
        session.metadata.managedConversation !== true
      ) {
        throw Object.assign(
          new Error("Managed conversation session not found or not visible"),
          { statusCode: 404, code: "managed_session_not_found" }
        );
      }
      if (
        !terminalReconciliations.has(
          `${actor.userId}:${input.sessionId}:${input.externalTurnId}`
        )
      ) {
        throw Object.assign(
          new Error(
            "Managed turn cannot be projected before terminal reconciliation"
          ),
          { statusCode: 409, code: "managed_turn_not_terminal" }
        );
      }
      return { conversationItemIds: ["managed-held-item"] };
    };
    const app = await buildServer({ repository });
    const client = await registerApiClientForTest(
      app,
      "managed-release@example.com"
    );
    const threadId = "managed-thread-1";
    const externalTurnId = "managed-turn-1";
    const session = await createCapturedSessionForTest(
      app,
      client.authorization,
      {
        externalSessionId: threadId,
        captureMethod: "api",
        metadata: { managedConversation: true }
      }
    );
    const ingest = (overrides: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items",
        headers: { authorization: client.authorization },
        payload: {
          items: [
            rawConversationItemPayload(session.id, {
              externalSessionId: threadId,
              externalThreadId: threadId,
              externalTurnId,
              ...overrides
            })
          ]
        }
      });
    const release = () =>
      app.inject({
        method: "POST",
        url: "/v1/memory/conversation-items/release",
        headers: { authorization: client.authorization },
        payload: { sessionId: session.id, externalTurnId }
      });
    const terminalStableItemId = `turn:${externalTurnId}:completed`;
    const terminalCanonicalItemKey = codexCanonicalConversationItemKeyForTest({
      externalThreadId: threadId,
      externalTurnId,
      stableItemId: terminalStableItemId,
      component: "control"
    });
    const forgedCanonicalTerminal = await ingest({
      sourceAdapterVersion: "codex-app-server-conversation-v1",
      sourceTransport: "app_server",
      sourceEventType: "turn/completed",
      observationKind: "control",
      observationComponent: "control",
      canonicalItemKey: `conversation-item:${"0".repeat(64)}`,
      canonicalStableItemId: terminalStableItemId,
      rawJson: {
        method: "turn/completed",
        params: { turn: { id: externalTurnId, status: "completed" } }
      }
    });
    const appServerTerminal = await ingest({
      sourceAdapterVersion: "codex-app-server-conversation-v1",
      sourceTransport: "app_server",
      sourceEventType: "turn/completed",
      observationKind: "control",
      observationComponent: "control",
      canonicalItemKey: terminalCanonicalItemKey,
      canonicalStableItemId: terminalStableItemId,
      rawJson: {
        method: "turn/completed",
        params: { turn: { id: externalTurnId, status: "completed" } }
      }
    });
    const rejectedAfterAppServer = await release();
    const nonReconciledJsonlTerminal = await ingest({
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "transcript",
      sourceRecordType: "event_msg",
      sourceEventType: "task_complete",
      sourceLineNumber: 1,
      observationKind: "snapshot",
      observationComponent: "control",
      canonicalItemKey: terminalCanonicalItemKey,
      canonicalStableItemId: terminalStableItemId,
      rawJson: {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: externalTurnId }
      }
    });
    const rejectedWithoutReconciliation = await release();
    const reconciledJsonlTerminal = await ingest({
      sourceAdapterVersion: "codex-transcript-v1",
      sourceTransport: "transcript",
      sourceRecordType: "event_msg",
      sourceEventType: "task_complete",
      sourceLineNumber: 2,
      observationKind: "reconciliation",
      observationComponent: "control",
      canonicalItemKey: terminalCanonicalItemKey,
      canonicalStableItemId: terminalStableItemId,
      rawJson: {
        type: "event_msg",
        payload: { type: "task_complete", turn_id: externalTurnId }
      }
    });
    const released = await release();
    await app.close();

    expect(appServerTerminal.statusCode).toBe(200);
    expect(forgedCanonicalTerminal.statusCode).toBe(400);
    expect(nonReconciledJsonlTerminal.statusCode).toBe(200);
    expect(reconciledJsonlTerminal.statusCode).toBe(200);
    expect(rejectedAfterAppServer.statusCode).toBe(409);
    expect(rejectedWithoutReconciliation.statusCode).toBe(409);
    expect(released.statusCode).toBe(200);
    expect(
      jsonBody<{ conversationItemIds: string[] }>(released).conversationItemIds
    ).toEqual(["managed-held-item"]);
  });

  it("serves Team Shared Memory evidence behind Team authentication", async () => {
    process.env.KOED_HOME = mkdtempSync(
      resolve(tmpdir(), "koed-team-note-evidence-")
    );
    const repository = createFakeRepository();
    const recallInputs: Array<Record<string, unknown>> = [];
    const originalSearchMemoryNodes =
      repository.searchMemoryNodes.bind(repository);
    repository.searchMemoryNodes = async (actor, input) => {
      recallInputs.push(input as Record<string, unknown>);
      return originalSearchMemoryNodes(actor, input);
    };
    const teamCandidateId = randomUUID();
    const teamShareGrantId = randomUUID();
    const teamSourceArtifactId = randomUUID();
    const teamNoteId = randomUUID();
    const teamMemoryEventId = randomUUID();
    const teamLogicalMemoryId = randomUUID();
    const teamSourceRevisionHash = "b".repeat(64);
    repository.searchAuthorizedSharedMemorySemanticItems = async () => [
      {
        source: {
          kind: "personal_note",
          noteId: teamNoteId,
          noteRevision: 1,
          memoryEventId: teamMemoryEventId,
          logicalMemoryId: teamLogicalMemoryId
        },
        candidateId: teamCandidateId,
        shareGrantId: teamShareGrantId,
        sourceArtifactId: teamSourceArtifactId,
        sourceRevisionHash: teamSourceRevisionHash,
        representationId: randomUUID(),
        representation: "lcm_rollups",
        pseudonymousSourceId: "team-source",
        sourceItemIndex: 0,
        sourceRevision: 1,
        provenanceHash: "a".repeat(64),
        representationPolicyRevision: 1,
        contentPolicyVersion: 1,
        classifierVersion: 1,
        embeddingModel: "qwen3-0.6b",
        embeddingDimensions: 1024,
        embeddingVersion: "1",
        itemType: "lcm_rollup",
        occurredAt: null,
        text: "Team evidence must not be returned during score scan.",
        lexicalAnchors: [],
        score: 0.9,
        freshness: "fresh"
      }
    ];
    repository.scanAuthorizedSharedMemorySemanticItems = async () => [
      {
        representation: "lcm_rollups",
        candidateCount: 1,
        topScore: 0.9
      },
      {
        representation: "memory_events",
        candidateCount: 1,
        topScore: 0.8
      }
    ];
    repository.freezeSharedMemorySemanticRecallBoundary = async (
      _actor,
      input
    ) => ({
      teamId: randomUUID(),
      teamVersion: 1,
      teamWorkspaceId: input.teamWorkspaceId,
      workspaceVersion: 1,
      membershipVersion: 1,
      workspaceAccessVersion: 1,
      userRowVersion: "1",
      shareGrantIds: []
    });
    const app = await buildServer({
      repository,
      fetch: async () => {
        throw new Error(
          "Local-edge upstream transport must not embed Team queries"
        );
      },
      internalServiceFetch: async () =>
        new Response(
          JSON.stringify({
            model: "qwen3-0.6b",
            dimensions: 1024,
            vectors: [Array.from({ length: 1024 }, () => 0)]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "staged-retrieval@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const device = await enrollDeviceCredentialForTest(app, cookie, [
      "team_workspace_read"
    ]);
    const wrongScopeDevice = await enrollDeviceCredentialForTest(app, cookie, [
      "sync"
    ]);
    const parentNodeId = randomUUID();
    const teamWorkspaceId = randomUUID();

    const search = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        retrieval_stage: "rollup_search",
        exact_hints: ["Seraphina"],
        parent_node_ids: [parentNodeId],
        strict_limit: "false",
        limit: 2
      }
    });
    const rejectedTeamSearch = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        team_workspace_id: teamWorkspaceId
      }
    });
    const rejectedTeamAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: { authorization: `bEaReR ${token}` },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        team_workspace_id: teamWorkspaceId
      }
    });
    const rejectedWrongScopeDeviceAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: { authorization: wrongScopeDevice.authorization },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        team_workspace_id: teamWorkspaceId
      }
    });
    const deviceAnswer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: {
        authorization: device.authorization.replace(
          "Koed-Device",
          "kOeD-dEvIcE"
        )
      },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        retrieval_stage: "score_scan",
        team_workspace_id: teamWorkspaceId,
        strict_limit: true,
        limit: 1
      }
    });
    const deviceScoreScan = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: { authorization: device.authorization },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        retrieval_stage: "score_scan",
        team_workspace_id: teamWorkspaceId,
        strict_limit: true,
        limit: 1
      }
    });
    const deviceTeamSearch = await app.inject({
      method: "POST",
      url: "/v1/memory/search",
      headers: { authorization: device.authorization },
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        team_workspace_id: teamWorkspaceId,
        limit: 1
      }
    });
    const deviceTeamQuestion = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers: { authorization: device.authorization },
      payload: {
        idempotency_key: `team-question-${randomUUID()}`,
        query: "What did the Team decide?",
        origin: "mcp_memory_answer",
        team_workspace_id: teamWorkspaceId,
        status: "answered",
        answer_markdown: "Use the authorized Team evidence."
      }
    });
    const rejectedApiTokenTeamQuestion = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        idempotency_key: `team-question-${randomUUID()}`,
        query: "What did the Team decide?",
        origin: "mcp_memory_answer",
        team_workspace_id: teamWorkspaceId,
        status: "answered",
        answer_markdown: "This must not be accepted."
      }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers: browserSessionHeaders(cookie),
      payload: {
        query: "Seraphina",
        retrieval_scope: "personal",
        retrieval_stage: "score_scan",
        team_workspace_id: teamWorkspaceId,
        strict_limit: true,
        limit: 1
      }
    });
    await app.close();

    expect(search.statusCode).toBe(200);
    expect(answer.statusCode).toBe(200);
    expect(deviceAnswer.statusCode).toBe(200);
    expect(deviceScoreScan.statusCode).toBe(200);
    expect(deviceTeamSearch.statusCode).toBe(200);
    expect(deviceTeamQuestion.statusCode).toBe(200);
    expect(rejectedApiTokenTeamQuestion.statusCode).toBe(403);
    const scoreScan = jsonBody<{
      hits: unknown[];
      rawHitsCount: number;
      retrieval: {
        vectorCandidateCount: number;
        stages: Array<Record<string, unknown>>;
      };
    }>(deviceScoreScan);
    expect(scoreScan.hits).toEqual([]);
    expect(scoreScan.rawHitsCount).toBe(0);
    expect(scoreScan.retrieval.vectorCandidateCount).toBe(2);
    expect(scoreScan.retrieval.stages).toContainEqual(
      expect.objectContaining({
        name: "rollup_search",
        used: false,
        selectedCount: 0,
        countAboveThreshold: 1,
        maxAllowed: 1
      })
    );
    const teamVisibilityProvenance = jsonBody<{
      hits: Array<{ visibilityProvenance: Record<string, unknown> }>;
    }>(deviceTeamSearch).hits[0]?.visibilityProvenance;
    expect(teamVisibilityProvenance).toEqual({
      shareGrantId: teamShareGrantId,
      representation: "lcm_rollups",
      sourceRevision: 1
    });
    expect(JSON.stringify(deviceTeamSearch.json())).not.toContain(teamNoteId);
    expect(JSON.stringify(deviceTeamSearch.json())).not.toContain(
      teamMemoryEventId
    );
    expect(JSON.stringify(deviceTeamSearch.json())).not.toContain(
      teamLogicalMemoryId
    );
    expect(JSON.stringify(deviceTeamSearch.json())).not.toContain(
      teamSourceArtifactId
    );
    expect(JSON.stringify(deviceTeamSearch.json())).not.toContain(
      teamSourceRevisionHash
    );
    expect(scoreScan.retrieval.stages).toContainEqual(
      expect.objectContaining({
        name: "fresh_pending_search",
        used: false,
        selectedCount: 0,
        countAboveThreshold: 1,
        maxAllowed: 1
      })
    );
    expect(recallInputs[0]).toMatchObject({
      retrievalStage: "rollup_search",
      exactHints: ["Seraphina"],
      parentNodeIds: [parentNodeId],
      strictLimit: false,
      limit: 2
    });
    expect(rejectedTeamSearch.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(rejectedTeamSearch).error).toBe(
      "Session cookie or scoped device credential required for Team Workspace recall"
    );
    expect(rejectedTeamAnswer.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(rejectedTeamAnswer).error).toBe(
      "Session cookie or scoped device credential required for Team Workspace recall"
    );
    expect(rejectedWrongScopeDeviceAnswer.statusCode).toBe(403);
    expect(
      jsonBody<{ error: string }>(rejectedWrongScopeDeviceAnswer).error
    ).toBe("Device credential is not allowed for this operation");
    expect(recallInputs).toHaveLength(1);
  });

  it("serves Team Shared Memory expansion behind Team authentication", async () => {
    process.env.KOED_HOME = mkdtempSync(
      resolve(tmpdir(), "koed-team-note-expansion-")
    );
    const repository = createFakeRepository();
    const expandInputs: Array<Record<string, unknown>> = [];
    const teamShareGrantId = randomUUID();
    const teamSourceArtifactId = randomUUID();
    const teamRepresentationId = randomUUID();
    const teamSourceRevisionHash = "b".repeat(64);
    const teamProvenanceHash = "a".repeat(64);
    const pseudonymousSourceId = randomUUID();
    repository.expandMemoryNode = async (nodeId, _actor, input) => {
      expandInputs.push({ nodeId, ...(input as Record<string, unknown>) });
      return {
        nodeId,
        visibility: "personal",
        sourceItems: [],
        sources: []
      } satisfies ExpandedMemoryNode;
    };
    repository.expandAuthorizedSharedMemorySemanticItem = async (
      _actor,
      input
    ) => {
      expandInputs.push(input as unknown as Record<string, unknown>);
      return {
        parent: {
          source: {
            kind: "captured_session" as const,
            sessionId: randomUUID(),
            logicalMemoryId: randomUUID()
          },
          candidateId: input.candidateId,
          shareGrantId: teamShareGrantId,
          sourceArtifactId: teamSourceArtifactId,
          sourceRevisionHash: teamSourceRevisionHash,
          representationId: teamRepresentationId,
          representation: "lcm_rollups" as const,
          pseudonymousSourceId,
          sourceItemIndex: 0,
          sourceRevision: 1,
          provenanceHash: teamProvenanceHash,
          representationPolicyRevision: 1,
          contentPolicyVersion: 1,
          classifierVersion: 1,
          embeddingModel: "qwen3-0.6b",
          embeddingDimensions: 1024,
          embeddingVersion: "team-semantic-v1:test",
          itemType: "lcm_rollup" as const,
          occurredAt: null,
          text: "Authorized Team evidence.",
          lexicalAnchors: [],
          score: 1,
          freshness: "fresh" as const
        },
        items: [
          {
            candidateId: randomUUID(),
            pseudonymousSourceId,
            sourceChunkIndex: 0,
            itemType: "lcm_leaf" as const,
            occurredAt: null,
            text: "Authorized Team evidence.",
            lexicalAnchors: []
          }
        ]
      };
    };
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "team-expand@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const device = await enrollDeviceCredentialForTest(app, cookie, [
      "team_workspace_read"
    ]);
    const nodeId = randomUUID();
    const teamWorkspaceId = randomUUID();
    const rejectedTokenExpand = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}/expand?team_workspace_id=${teamWorkspaceId}`,
      headers: { authorization: `Bearer ${token}` }
    });
    const deviceExpand = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}/expand?team_workspace_id=${teamWorkspaceId}`,
      headers: { authorization: device.authorization }
    });
    const sessionExpand = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}/expand?team_workspace_id=${teamWorkspaceId}`,
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(rejectedTokenExpand.statusCode).toBe(403);
    expect(jsonBody<{ error: string }>(rejectedTokenExpand).error).toBe(
      "Session cookie or scoped device credential required"
    );
    expect(deviceExpand.statusCode).toBe(200);
    expect(sessionExpand.statusCode).toBe(200);
    const expanded = jsonBody<{
      expanded: {
        visibilityProvenance: Record<string, unknown>;
        generation?: unknown;
        sourceItems: Array<Record<string, unknown>>;
      };
    }>(deviceExpand).expanded;
    expect(expanded.visibilityProvenance).toEqual({
      shareGrantId: teamShareGrantId,
      representation: "lcm_rollups",
      sourceRevision: 1
    });
    expect(expanded).not.toHaveProperty("generation");
    expect(expanded.sourceItems[0]).not.toHaveProperty("sourceTable");
    expect(JSON.stringify(expanded)).not.toContain(teamSourceArtifactId);
    expect(JSON.stringify(expanded)).not.toContain(teamRepresentationId);
    expect(JSON.stringify(expanded)).not.toContain(teamSourceRevisionHash);
    expect(JSON.stringify(expanded)).not.toContain(teamProvenanceHash);
    expect(expandInputs).toEqual([
      { teamWorkspaceId, candidateId: nodeId, searchDomain: "global" },
      { teamWorkspaceId, candidateId: nodeId, searchDomain: "global" }
    ]);
  });

  it("keeps Team Shared Memory graph APIs unavailable behind Team authentication", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "team-graph-token@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const token = jsonBody<TokenResponse>(createdToken).token;
    const tokenHeaders = { authorization: `Bearer ${token}` };
    const device = await enrollDeviceCredentialForTest(app, cookie, [
      "team_workspace_read"
    ]);
    const deviceHeaders = { authorization: device.authorization };
    const teamWorkspaceId = randomUUID();
    const nodeId = randomUUID();
    const eventId = randomUUID();

    const tokenResponses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/nodes?teamWorkspaceId=${teamWorkspaceId}`,
        headers: tokenHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/events?teamWorkspaceId=${teamWorkspaceId}`,
        headers: tokenHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/threads?teamWorkspaceId=${teamWorkspaceId}`,
        headers: tokenHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/nodes/${nodeId}?teamWorkspaceId=${teamWorkspaceId}`,
        headers: tokenHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/events/${eventId}?teamWorkspaceId=${teamWorkspaceId}`,
        headers: tokenHeaders
      })
    ]);
    const deviceResponses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/nodes?teamWorkspaceId=${teamWorkspaceId}`,
        headers: deviceHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/events?teamWorkspaceId=${teamWorkspaceId}`,
        headers: deviceHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/threads?teamWorkspaceId=${teamWorkspaceId}`,
        headers: deviceHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/nodes/${nodeId}?teamWorkspaceId=${teamWorkspaceId}`,
        headers: deviceHeaders
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/events/${eventId}?teamWorkspaceId=${teamWorkspaceId}`,
        headers: deviceHeaders
      })
    ]);
    const sessionResponses = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/nodes?teamWorkspaceId=${teamWorkspaceId}`,
        headers: browserSessionHeaders(cookie)
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/events?teamWorkspaceId=${teamWorkspaceId}`,
        headers: browserSessionHeaders(cookie)
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/threads?teamWorkspaceId=${teamWorkspaceId}`,
        headers: browserSessionHeaders(cookie)
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/nodes/${nodeId}?teamWorkspaceId=${teamWorkspaceId}`,
        headers: browserSessionHeaders(cookie)
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/graph/events/${eventId}?teamWorkspaceId=${teamWorkspaceId}`,
        headers: browserSessionHeaders(cookie)
      })
    ]);
    await app.close();

    expect(tokenResponses.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403
    ]);
    for (const response of tokenResponses) {
      expect(jsonBody<{ error: string }>(response).error).toBe(
        "Session cookie or scoped device credential required"
      );
    }
    expect(deviceResponses.map((response) => response.statusCode)).toEqual([
      404, 404, 404, 404, 404
    ]);
    expect(sessionResponses.map((response) => response.statusCode)).toEqual([
      404, 404, 404, 404, 404
    ]);
    for (const response of [...deviceResponses, ...sessionResponses]) {
      expect(jsonBody<{ error: string }>(response).error).toBe(
        "Team Shared Memory graph is not available"
      );
    }
  });

  it("rejects unsupported capture policy visibility for API-token setup", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "unsupported-capture@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    const unsupportedPolicy = await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "global",
        captureState: "enabled",
        visibility: "public"
      }
    });
    await app.close();

    expect(unsupportedPolicy.statusCode).toBe(400);
  });

  it("authorizes, redacts, and rechecks policy for local historical import batches", async () => {
    const repository = createFakeRepository();
    const sourceSigningKey = generateKeyPairSync("ed25519");
    const sourcePublicJwk = sourceSigningKey.publicKey.export({
      format: "jwk"
    });
    if (typeof sourcePublicJwk.x !== "string") {
      throw new Error("Test source signing key is invalid");
    }
    let forwardedHistoricalItems: ConversationItemInput[] = [];
    const originalHistoricalIngest =
      repository.ingestHistoricalImportBatch.bind(repository);
    repository.ingestHistoricalImportBatch = async (actor, input) => {
      forwardedHistoricalItems = input.items;
      return originalHistoricalIngest(actor, input);
    };
    const app = await buildServer({
      repository,
      runMemoryJobsInlineForTests: true,
      historicalImportAdmission: async () => ({
        admitted: false,
        reason: "live_projection_pressure"
      }),
      conversationSourceSignerFactory: (input) => ({
        deploymentId: "00000000-0000-4000-8000-000000000001",
        deviceInstanceId: "00000000-0000-4000-8000-000000000002",
        keyId: input.originKeyId,
        publicKey: sourcePublicJwk.x!,
        sign: (payload) =>
          sign(null, payload, sourceSigningKey.privateKey).toString("base64url")
      })
    });
    const owner = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "history-owner@example.com", password: "password123" }
    });
    const ownerToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(owner)),
      payload: { name: "Historical Import" }
    });
    expect(ownerToken.statusCode, ownerToken.body).toBe(200);
    const ownerHeaders = {
      authorization: `Bearer ${jsonBody<TokenResponse>(ownerToken).token}`
    };
    const admission = await app.inject({
      method: "GET",
      url: "/v1/historical-import-admission",
      headers: ownerHeaders
    });
    const unauthenticatedAdmission = await app.inject({
      method: "GET",
      url: "/v1/historical-import-admission"
    });
    expect(admission.statusCode, admission.body).toBe(200);
    expect(admission.json()).toEqual({
      admitted: false,
      reason: "live_projection_pressure"
    });
    expect(unauthenticatedAdmission.statusCode).toBe(401);
    const runResponse = await app.inject({
      method: "POST",
      url: "/v1/historical-imports",
      headers: ownerHeaders
    });
    expect(runResponse.statusCode, runResponse.body).toBe(200);
    const runId = jsonBody<{ run: { id: string } }>(runResponse).run.id;
    const journalBytes = Buffer.from(
      `${JSON.stringify({
        timestamp: "2026-07-01T12:00:00.000Z",
        type: "response_item",
        payload: {
          id: "assistant-message-1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Imported memory" }]
        }
      })}\n`
    );
    const journalDigest = createHash("sha256")
      .update(journalBytes)
      .digest("hex");
    const journalLength = journalBytes.byteLength;
    const artifactPayload = {
      sourceSession: {
        externalSessionId: "historical-session",
        sourceRuntime: "codex",
        captureMethod: "api",
        cwd: "project-history",
        idempotencyKey: "journal-session:historical-session",
        metadata: {
          projectId: "project-history",
          projectName: "Koed"
        }
      },
      sourceKind: "codex",
      externalSessionId: "historical-session",
      sourceFingerprint: "a".repeat(64),
      artifactFormat: "codex_rollout_jsonl",
      artifactFormatVersion: 1,
      journalStartOffset: 0,
      journalStartLine: 0,
      liveStartOffset: journalLength,
      liveStartLine: 1,
      currentSourceLength: journalLength,
      sourceCreatedAt: "2026-07-11T09:59:59.000Z",
      redactedSourceLabel: "Codex session historical-session"
    };
    const browserOnlyArtifactResponse = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-artifacts",
      headers: browserSessionHeaders(cookieHeader(owner)),
      payload: artifactPayload
    });
    expect(
      browserOnlyArtifactResponse.statusCode,
      browserOnlyArtifactResponse.body
    ).toBe(401);
    const mismatchedArtifactResponse = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-artifacts",
      headers: ownerHeaders,
      payload: {
        ...artifactPayload,
        sourceSession: {
          ...artifactPayload.sourceSession,
          externalSessionId: "different-session"
        }
      }
    });
    expect(
      mismatchedArtifactResponse.statusCode,
      mismatchedArtifactResponse.body
    ).toBe(400);
    const artifactResponse = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-artifacts",
      headers: ownerHeaders,
      payload: artifactPayload
    });
    expect(artifactResponse.statusCode, artifactResponse.body).toBe(200);
    const artifactId = jsonBody<{
      artifact: { id: string };
    }>(artifactResponse).artifact.id;
    const claudeArtifactResponse = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-artifacts",
      headers: ownerHeaders,
      payload: {
        ...artifactPayload,
        sourceSession: {
          ...artifactPayload.sourceSession,
          externalSessionId: "claude-session",
          sourceRuntime: "claude-code",
          idempotencyKey: "journal-session:claude-session"
        },
        sourceKind: "claude-code",
        sourceComponentId: "main",
        sourceComponentRole: "primary",
        externalSessionId: "claude-session",
        sourceFingerprint: "b".repeat(64),
        artifactFormat: "claude_session_jsonl"
      }
    });
    expect(claudeArtifactResponse.statusCode, claudeArtifactResponse.body).toBe(
      200
    );
    expect(
      jsonBody<{
        session: {
          sourceRuntime: string;
          sourceKind: string;
          sourceAdapterVersion: string;
        };
      }>(claudeArtifactResponse).session
    ).toMatchObject({
      sourceRuntime: "claude-code",
      sourceKind: "claude-code",
      sourceAdapterVersion: "claude-code-transcript-v1"
    });
    const segmentPayload = {
      expectedProviderOffset: 0,
      expectedProviderLine: 0,
      sourceEndOffset: journalLength,
      sourceEndLine: 1,
      plaintextDigest: journalDigest,
      plaintextSize: journalLength,
      bytesBase64: journalBytes.toString("base64"),
      currentSourceLength: journalLength
    };
    const malformedBase64 = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/segments`,
      headers: ownerHeaders,
      payload: {
        ...segmentPayload,
        bytesBase64: `${segmentPayload.bytesBase64}=`
      }
    });
    const invalidUtf8Bytes = Buffer.from([0xff, 0x0a]);
    const invalidUtf8 = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/segments`,
      headers: ownerHeaders,
      payload: {
        ...segmentPayload,
        sourceEndOffset: invalidUtf8Bytes.byteLength,
        plaintextDigest: createHash("sha256")
          .update(invalidUtf8Bytes)
          .digest("hex"),
        plaintextSize: invalidUtf8Bytes.byteLength,
        bytesBase64: invalidUtf8Bytes.toString("base64")
      }
    });
    expect(malformedBase64.statusCode, malformedBase64.body).toBe(400);
    expect(invalidUtf8.statusCode, invalidUtf8.body).toBe(400);
    const segmentResponse = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/segments`,
      headers: ownerHeaders,
      payload: segmentPayload
    });
    expect(segmentResponse.statusCode, segmentResponse.body).toBe(200);
    const segmentReplay = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/segments`,
      headers: ownerHeaders,
      payload: segmentPayload
    });
    const conflictingBytes = Buffer.from(
      journalBytes
        .toString("utf8")
        .replace("Imported memory", "Jmported memory")
    );
    const segmentConflict = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/segments`,
      headers: ownerHeaders,
      payload: {
        ...segmentPayload,
        plaintextDigest: createHash("sha256")
          .update(conflictingBytes)
          .digest("hex"),
        bytesBase64: conflictingBytes.toString("base64")
      }
    });
    expect(segmentReplay.statusCode, segmentReplay.body).toBe(200);
    expect(jsonBody<{ replayed: boolean }>(segmentReplay).replayed).toBe(true);
    expect(segmentConflict.statusCode, segmentConflict.body).toBe(409);
    const replayedArtifactResponse = await app.inject({
      method: "POST",
      url: "/v1/conversation-source-artifacts",
      headers: ownerHeaders,
      payload: artifactPayload
    });
    expect(
      replayedArtifactResponse.statusCode,
      replayedArtifactResponse.body
    ).toBe(200);
    expect(
      jsonBody<{
        artifact: { id: string; providerCursorLine: number };
      }>(replayedArtifactResponse)
    ).toMatchObject({
      artifact: { id: artifactId, providerCursorLine: 1 }
    });
    const sourceResponse = await app.inject({
      method: "POST",
      url: "/v1/historical-import-sources",
      headers: ownerHeaders,
      payload: {
        runId,
        artifactId,
        aiClient: "codex",
        detectedProject: {
          projectId: "project-history",
          name: "Koed",
          branch: "main"
        }
      }
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(200);
    const sourceId = jsonBody<{ source: { id: string } }>(sourceResponse).source
      .id;
    const lookupUrl = `/v1/historical-import-sources/lookup?artifactId=${artifactId}`;
    const lookup = await app.inject({
      method: "GET",
      url: lookupUrl,
      headers: ownerHeaders
    });
    const strictLookup = await app.inject({
      method: "GET",
      url: `${lookupUrl}&unexpected=true`,
      headers: ownerHeaders
    });
    const unauthenticatedLookup = await app.inject({
      method: "GET",
      url: lookupUrl
    });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.body).not.toContain("/Users/alice");
    expect(
      jsonBody<{
        source: {
          id: string;
          sourceLabel: string;
          detectedProject: { projectId: string };
        };
      }>(lookup)
    ).toMatchObject({
      source: {
        id: sourceId,
        sourceLabel: "Codex session historical-session",
        detectedProject: { projectId: "project-history" }
      }
    });
    expect(strictLookup.statusCode).toBe(400);
    expect(unauthenticatedLookup.statusCode).toBe(401);

    const bypass = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers: ownerHeaders,
      payload: {
        items: [
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "historical_import",
            sourceRecordType: "event_msg",
            rawJson: {},
            sourceHash: "bypass",
            idempotencyKey: "bypass",
            metadata: {}
          }
        ]
      }
    });
    expect(bypass.statusCode).toBe(400);
    const status = await app.inject({
      method: "GET",
      url: `/v1/historical-imports/${runId}`,
      headers: ownerHeaders
    });
    expect(status.body).not.toContain("/Users/alice");
    expect(
      jsonBody<{ run: { sources: unknown[] } }>(status).run.sources
    ).toEqual([
      expect.objectContaining({
        artifactId,
        sourceLabel: "Codex session historical-session",
        registrationFrontierOffset: journalLength,
        historicalCursorOffset: 0,
        providerCursorOffset: journalLength,
        rawIngested: false,
        projected: false,
        partiallyEmbedded: false,
        fullyEmbedded: true,
        semanticReady: false,
        lcmComplete: true,
        detectedProject: {
          projectId: "project-history",
          name: "Koed",
          branch: "main"
        }
      })
    ]);

    const outsider = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "history-outsider@example.com",
        password: "password123"
      }
    });
    const outsiderHeaders = browserSessionHeaders(cookieHeader(outsider));
    const outsiderRead = await app.inject({
      method: "GET",
      url: `/v1/historical-imports/${runId}`,
      headers: outsiderHeaders
    });
    const outsiderLookup = await app.inject({
      method: "GET",
      url: lookupUrl,
      headers: outsiderHeaders
    });
    expect(outsiderRead.statusCode).toBe(404);
    expect(outsiderLookup.statusCode).toBe(404);

    for (const [expectedState, state] of [
      ["discovered", "eligible"],
      ["eligible", "queued"]
    ] as const) {
      const runTransition = await app.inject({
        method: "PATCH",
        url: `/v1/historical-imports/${runId}`,
        headers: ownerHeaders,
        payload: { expectedState, state }
      });
      const sourceTransition = await app.inject({
        method: "PATCH",
        url: `/v1/historical-import-sources/${sourceId}`,
        headers: ownerHeaders,
        payload: { expectedState, state }
      });
      expect(runTransition.statusCode).toBe(200);
      expect(sourceTransition.statusCode).toBe(200);
    }
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers: ownerHeaders,
      payload: {
        targetType: "project",
        projectId: "project-history",
        captureState: "disabled",
        visibility: "personal"
      }
    });
    const batchPayload = {
      expectedSourceOffset: 0,
      sourceOffset: journalLength,
      sourceLine: 1,
      segmentIndex: 0,
      lastVerifiedDigest: journalDigest,
      parserState: {
        currentTurnId: "turn-1",
        rawTranscript: "must-not-be-presented"
      },
      malformedRecordCount: 1,
      items: [
        {
          externalThreadId: "historical-session",
          externalTurnId: "turn-1",
          externalItemId: "assistant-message-1",
          sourceRecordType: "response_item",
          sourceEventType: "message",
          sourceLineNumber: 0,
          sourceSequence: 0,
          eventTime: "2026-07-01T12:00:00.000Z",
          rawJson: {
            timestamp: "2026-07-01T12:00:00.000Z",
            type: "response_item",
            payload: {
              id: "assistant-message-1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Imported memory" }]
            }
          },
          rawText: "Imported memory",
          sourceHash: "adapter-source-hash",
          idempotencyKey: "adapter-idempotency-key",
          canonicalItemKey: codexCanonicalConversationItemKey({
            externalThreadId: "historical-session",
            externalTurnId: "turn-1",
            stableItemId: "assistant-message-1",
            component: "message"
          }),
          canonicalStableItemId: "assistant-message-1",
          canonicalSourcePriority: 200,
          observationKind: "reconciliation",
          observationComponent: "message",
          projectionStatus: "pending",
          metadata: {
            transcriptByteOffset: 0,
            transcriptItemDiscriminator: "primary:codex_response_message",
            transcriptType: "message"
          }
        },
        {
          observationOnly: true,
          sourceRecordType: "event_msg",
          sourceEventType: "agent_message",
          sourceLineNumber: 1,
          sourceSequence: 1,
          rawJson: {
            type: "event_msg",
            payload: { type: "agent_message", message: "Imported memory" }
          },
          rawText: "Imported memory",
          sourceHash: "adapter-observation-hash",
          idempotencyKey: "adapter-observation-key",
          observationKind: "reconciliation",
          observationComponent: "message",
          projectionStatus: "raw_only",
          metadata: {
            transcriptByteOffset: 1,
            transcriptItemDiscriminator: "observation:duplicate_agent_message",
            transcriptType: "agent_message"
          }
        }
      ]
    };
    const blocked = await app.inject({
      method: "POST",
      url: `/v1/historical-import-sources/${sourceId}/batches`,
      headers: ownerHeaders,
      payload: batchPayload
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toContain("Capture Policy");

    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers: ownerHeaders,
      payload: {
        targetType: "project",
        projectId: "project-history",
        captureState: "enabled",
        visibility: "personal",
        pauseUntil: null
      }
    });
    const parserBypass = await app.inject({
      method: "POST",
      url: `/v1/historical-import-sources/${sourceId}/batches`,
      headers: ownerHeaders,
      payload: {
        ...batchPayload,
        items: batchPayload.items.map((item) => ({
          ...item,
          metadata: { transcriptType: "user_message" }
        }))
      }
    });
    const imported = await app.inject({
      method: "POST",
      url: `/v1/historical-import-sources/${sourceId}/batches`,
      headers: ownerHeaders,
      payload: batchPayload
    });
    const replayed = await app.inject({
      method: "POST",
      url: `/v1/historical-import-sources/${sourceId}/batches`,
      headers: ownerHeaders,
      payload: batchPayload
    });
    const mutatedReplay = await app.inject({
      method: "POST",
      url: `/v1/historical-import-sources/${sourceId}/batches`,
      headers: ownerHeaders,
      payload: { ...batchPayload, lastVerifiedDigest: "d".repeat(64) }
    });
    const unsafeFailure = await app.inject({
      method: "PATCH",
      url: `/v1/historical-import-sources/${sourceId}`,
      headers: ownerHeaders,
      payload: {
        expectedState: "importing",
        state: "failed",
        failureReason: "/Users/alice/private.jsonl"
      }
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/finalize`,
      headers: ownerHeaders,
      payload: {
        expectedProviderOffset: journalLength,
        expectedProviderLine: 1
      }
    });
    expect(finalized.statusCode, finalized.body).toBe(200);
    const finalizedArtifact = jsonBody<{
      artifact: {
        logicalSourceId: string;
        sourceGenerationId: string;
        closureHash: string;
      };
    }>(finalized).artifact;
    const nextSourceGenerationId = randomUUID();
    const nextOriginKeyId = randomUUID();
    const successorPayload = {
      expectedParentClosureHash: finalizedArtifact.closureHash,
      sourceGenerationId: nextSourceGenerationId,
      originKeyId: nextOriginKeyId
    };
    const successor = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/successor`,
      headers: ownerHeaders,
      payload: successorPayload
    });
    const successorReplay = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/successor`,
      headers: ownerHeaders,
      payload: successorPayload
    });
    const successorConflict = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/successor`,
      headers: ownerHeaders,
      payload: {
        ...successorPayload,
        sourceGenerationId: randomUUID()
      }
    });
    const successorWithSessionOnly = await app.inject({
      method: "POST",
      url: `/v1/conversation-source-artifacts/${artifactId}/successor`,
      headers: browserSessionHeaders(cookieHeader(owner)),
      payload: successorPayload
    });
    const exactGeneration = await app.inject({
      method: "GET",
      url: `/v1/conversation-source-artifacts/generations/${finalizedArtifact.sourceGenerationId}`,
      headers: ownerHeaders
    });
    const resumedLookup = await app.inject({
      method: "GET",
      url: lookupUrl,
      headers: ownerHeaders
    });
    await app.close();

    expect(parserBypass.statusCode).toBe(400);
    expect(imported.statusCode).toBe(200);
    expect(forwardedHistoricalItems).toEqual([
      expect.objectContaining({
        sourceRecordType: "response_item",
        canonicalStableItemId: "assistant-message-1",
        canonicalSourcePriority: 200,
        observationKind: "reconciliation",
        observationComponent: "message",
        projectionStatus: "pending"
      }),
      expect.objectContaining({
        observationOnly: true,
        observationKind: "reconciliation",
        observationComponent: "message",
        projectionStatus: "raw_only"
      })
    ]);
    expect(imported.body).not.toContain("/Users/alice");
    expect(imported.body).not.toContain("historicalCursorCurrentTurnId");
    expect(
      jsonBody<{
        source: {
          historicalCursorOffset: number;
          malformedRecordCount: number;
        };
      }>(imported).source
    ).toMatchObject({
      historicalCursorOffset: journalLength,
      malformedRecordCount: 1
    });
    expect(replayed.statusCode).toBe(200);
    expect(mutatedReplay.statusCode).toBe(409);
    expect(unsafeFailure.statusCode).toBe(400);
    expect(unsafeFailure.body).not.toContain("/Users/alice");
    expect(
      jsonBody<{
        replayed: boolean;
        items: unknown[];
        source: { importedRecordCount: number };
      }>(replayed)
    ).toMatchObject({
      replayed: true,
      items: [],
      source: { importedRecordCount: 2 }
    });
    expect(successor.statusCode, successor.body).toBe(200);
    expect(
      jsonBody<{
        artifact: {
          logicalSourceId: string;
          sourceGenerationId: string;
          originKeyId: string;
          lifecycle: string;
          journalStartOffset: number;
        };
        replayed: boolean;
      }>(successor)
    ).toMatchObject({
      artifact: {
        logicalSourceId: finalizedArtifact.logicalSourceId,
        sourceGenerationId: nextSourceGenerationId,
        originKeyId: nextOriginKeyId,
        lifecycle: "active",
        journalStartOffset: journalLength
      },
      replayed: false
    });
    expect(successorReplay.statusCode).toBe(200);
    expect(jsonBody<{ replayed: boolean }>(successorReplay).replayed).toBe(
      true
    );
    expect(successorConflict.statusCode).toBe(409);
    expect(successorWithSessionOnly.statusCode).toBe(401);
    expect(exactGeneration.statusCode).toBe(200);
    expect(resumedLookup.statusCode).toBe(200);
    expect(resumedLookup.body).not.toContain("must-not-be-presented");
    const resumedSource = jsonBody<{
      source: {
        historicalCursorCurrentTurnId?: string;
        historicalCursorParserState?: Record<string, unknown>;
      };
    }>(resumedLookup).source;
    expect(resumedSource.historicalCursorCurrentTurnId).toBe("turn-1");
    expect(resumedSource.historicalCursorParserState).toEqual({
      currentTurnId: "turn-1"
    });
    expect(
      jsonBody<{ artifact: { sourceGenerationId: string } }>(exactGeneration)
        .artifact.sourceGenerationId
    ).toBe(finalizedArtifact.sourceGenerationId);
  });

  it("keeps historical controls and raw source paths off remote profiles", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "private_vps";
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "remote-import@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Remote token" }
    });
    expect(createdToken.statusCode, createdToken.body).toBe(200);
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const control = await app.inject({
      method: "POST",
      url: "/v1/historical-imports",
      headers
    });
    const lookup = await app.inject({
      method: "GET",
      url: "/v1/historical-import-sources/lookup?artifactId=11111111-1111-4111-8111-111111111111",
      headers
    });
    const admission = await app.inject({
      method: "GET",
      url: "/v1/historical-import-admission",
      headers
    });
    const liveCursor = await app.inject({
      method: "POST",
      url: "/v1/historical-import-sources/11111111-1111-4111-8111-111111111111/live-cursor",
      headers,
      payload: {
        expectedCursorOffset: 0,
        cursorOffset: 1,
        cursorLine: 1,
        cursorHash: "a".repeat(64),
        sourceSizeBytes: 1
      }
    });
    const rawPath = await app.inject({
      method: "POST",
      url: "/v1/memory/conversation-items",
      headers,
      payload: {
        items: [
          {
            sourceKind: "codex",
            sourceAdapterVersion: "codex-transcript-v1",
            sourceTransport: "transcript",
            sourceRecordType: "event_msg",
            sourcePath: "/Users/alice/private/session.jsonl",
            rawJson: {},
            sourceHash: "remote-path",
            idempotencyKey: "remote-path",
            metadata: {}
          }
        ]
      }
    });
    await app.close();

    expect(control.statusCode).toBe(404);
    expect(lookup.statusCode).toBe(404);
    expect(admission.statusCode).toBe(404);
    expect(liveCursor.statusCode).toBe(404);
    expect(rawPath.statusCode, rawPath.body).toBe(400);
    expect(rawPath.body).not.toContain("/Users/alice");
  });

  it("treats duplicate capture source hashes as idempotent", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "duplicate-capture@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const payload = {
      actor: "user",
      eventType: "user_prompt",
      content: "Duplicate source hash should not create two events",
      sourceHash: "duplicate-source-hash-test"
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    const graph = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?query=Duplicate%20source%20hash&includeInvalidated=false",
      headers
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(second).event.id).toBe(
      jsonBody<CaptureResponse>(first).event.id
    );
    expect(jsonBody<GraphEventsResponse>(graph).events).toHaveLength(1);
  });

  it("compacts duplicate captures using the returned event visibility", async () => {
    const repository = createFakeRepository();
    const compactionScopes: Array<{ visibility: Visibility }> = [];
    const originalCreateLcmNodes = repository.createLcmNodes.bind(repository);
    repository.createLcmNodes = async (actor, input) => {
      compactionScopes.push({
        visibility: input.visibility
      });
      return originalCreateLcmNodes(actor, input);
    };
    const app = await buildServer({
      repository,
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "duplicate-capture-scope@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const payload = {
      actor: "user",
      eventType: "user_prompt",
      content: "Duplicate capture scope should follow returned event",
      sourceHash: "duplicate-source-hash-scope-test"
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload
    });
    await app.close();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(jsonBody<CaptureResponse>(second).event.visibility).toBe("personal");
    expect(compactionScopes.at(-1)).toEqual({
      visibility: "personal"
    });
  });

  it("resolves capture policy inheritance and skips disabled capture", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "policy@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "global",
        captureState: "enabled",
        visibility: "personal"
      }
    });
    const global = await app.inject({
      method: "GET",
      url: "/v1/capture-policy/effective?projectId=repo-a",
      headers
    });
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "project",
        projectId: "repo-a",
        captureState: "disabled"
      }
    });
    const project = await app.inject({
      method: "GET",
      url: "/v1/capture-policy/effective?projectId=repo-a",
      headers
    });
    await app.inject({
      method: "PUT",
      url: "/v1/capture-policies",
      headers,
      payload: {
        targetType: "thread",
        projectId: "repo-a",
        threadId: "thread-a",
        captureState: "enabled"
      }
    });
    const thread = await app.inject({
      method: "GET",
      url: "/v1/capture-policy/effective?projectId=repo-a&threadId=thread-a",
      headers
    });
    const skipped = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-a",
        actor: "user",
        eventType: "user_prompt",
        content: "This disabled capture should not store"
      }
    });
    await app.close();

    expect(jsonBody<PolicyResponse>(global).policy.captureState).toBe(
      "enabled"
    );
    expect(jsonBody<PolicyResponse>(project).policy.captureState).toBe(
      "disabled"
    );
    expect(jsonBody<PolicyResponse>(thread).policy.captureState).toBe(
      "enabled"
    );
    expect(jsonBody<Record<string, unknown>>(skipped)).toMatchObject({
      skipped: true,
      reason: "capture_disabled"
    });
  });

  it("stores provenance and presents memories as browsable clusters", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "browser@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const captured = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "/repo/sports",
        actor: "user",
        eventType: "user_prompt",
        content: "Jacobo likes football",
        metadata: {
          projectName: "Sports Repo",
          projectPath: "/repo/sports",
          externalSessionId: "thread-sports",
          threadName: "Sports chat"
        }
      }
    });
    const nodeId =
      jsonBody<CaptureResponse>(captured).compaction?.leafNodeIds[0];
    await app.inject({
      method: "PATCH",
      url: `/v1/memory/nodes/${nodeId}`,
      headers: browserSessionHeaders(cookie),
      payload: { pinned: true }
    });
    const clusters = await app.inject({
      method: "GET",
      url: "/v1/memory/clusters",
      headers: browserSessionHeaders(cookie)
    });
    const items = await app.inject({
      method: "GET",
      url: "/v1/memory/items?pinned=true",
      headers: browserSessionHeaders(cookie)
    });
    const rejectedTeamBrowserRoutes = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/memory/clusters?teamWorkspaceId=${randomUUID()}`,
        headers
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/items?teamWorkspaceId=${randomUUID()}`,
        headers
      }),
      app.inject({
        method: "GET",
        url: `/v1/memory/clusters/sports/memories?team_workspace_id=${randomUUID()}`,
        headers
      })
    ]);
    await app.close();

    expect(jsonBody<CaptureResponse>(captured).event.metadata.projectName).toBe(
      "Sports Repo"
    );
    expect(jsonBody<ClusterResponse>(clusters).clusters[0]).toMatchObject({
      label: "Sports"
    });
    const pinnedMemory = jsonBody<MemoryItemsResponse>(items).memories[0];
    expect(pinnedMemory).toMatchObject({
      text: "Jacobo likes football",
      projectName: "Sports Repo",
      threadName: "Sports chat"
    });
    expect(typeof pinnedMemory?.pinnedAt).toBe("string");
    expect(clusters.headers.deprecation).toBe("true");
    for (const response of rejectedTeamBrowserRoutes) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: "Invalid request payload"
      });
    }
  });

  it("browses and governs LCM graph records without curated memory endpoints", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "graph@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const captured = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-graph",
        actor: "user",
        eventType: "user_prompt",
        content: "Graph browser source record",
        metadata: {
          projectName: "Graph Repo",
          externalSessionId: "thread-graph",
          threadName: "Graph thread"
        }
      }
    });
    const capturedBody = jsonBody<CaptureResponse>(captured);
    const eventId = capturedBody.event.id;
    const nodeId = capturedBody.compaction?.leafNodeIds[0];
    const overview = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/overview",
      headers: browserSessionHeaders(cookie)
    });
    const nodes = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/nodes",
      headers: browserSessionHeaders(cookie)
    });
    const nodeDetail = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/nodes/${nodeId}`,
      headers: browserSessionHeaders(cookie)
    });
    const nodeBatch = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/nodes?ids=${nodeId}`,
      headers: browserSessionHeaders(cookie)
    });
    const corrected = await app.inject({
      method: "PATCH",
      url: `/v1/memory/nodes/${nodeId}`,
      headers: browserSessionHeaders(cookie),
      payload: { summaryText: "Corrected graph browser summary" }
    });
    const events = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events",
      headers: browserSessionHeaders(cookie)
    });
    const rawEvent = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/events/${eventId}?includeRaw=true`,
      headers: browserSessionHeaders(cookie)
    });
    const deletedEvent = await app.inject({
      method: "DELETE",
      url: `/v1/memory/graph/events/${eventId}`,
      headers: browserSessionHeaders(cookie)
    });
    const activeEvents = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events",
      headers: browserSessionHeaders(cookie)
    });
    const deletedNode = await app.inject({
      method: "DELETE",
      url: `/v1/memory/nodes/${nodeId}`,
      headers: browserSessionHeaders(cookie)
    });
    const activeNodes = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/nodes",
      headers: browserSessionHeaders(cookie)
    });
    const exported = await app.inject({
      method: "GET",
      url: "/v1/memory/export",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(jsonBody<GraphOverviewResponse>(overview).overview).toMatchObject({
      capturedEvents: 1,
      leafNodes: 1,
      rollupNodes: 0,
      pendingSummaries: 1
    });
    expect(jsonBody<GraphNodesResponse>(nodes).nodes[0]).toMatchObject({
      id: nodeId,
      projectName: "Graph Repo",
      threadName: "Graph thread",
      visibility: "personal"
    });
    expect(jsonBody<GraphNodesResponse>(nodeBatch).nodes).toHaveLength(1);
    expect(jsonBody<GraphNodesResponse>(nodeBatch).nodes[0]).toMatchObject({
      id: nodeId
    });
    expect(
      jsonBody<GraphNodeResponse>(nodeDetail).node.sources[0]
    ).toMatchObject({
      id: eventId,
      contentPreview: "Graph browser source record"
    });
    const correctedNode = jsonBody<GraphNodeResponse>(corrected).node;
    expect(correctedNode).toMatchObject({
      summaryText: "Corrected graph browser summary"
    });
    expect(typeof correctedNode.summaryCorrectedByUserId).toBe("string");
    expect(jsonBody<GraphEventsResponse>(events).events[0]).toMatchObject({
      id: eventId,
      linkedNodeIds: [nodeId]
    });
    expect(jsonBody<GraphEventResponse>(rawEvent).event.rawContent).toBe(
      "Graph browser source record"
    );
    expect(deletedEvent.statusCode).toBe(200);
    expect(jsonBody<GraphEventsResponse>(activeEvents).events).toHaveLength(0);
    expect(deletedNode.statusCode).toBe(200);
    expect(jsonBody<GraphNodesResponse>(activeNodes).nodes).toHaveLength(0);
    expect(jsonBody<MemoryExportResponse>(exported).nodes[0]).toMatchObject({
      id: nodeId,
      invalidationReason: "user_deleted"
    });
  });

  it("encrypts memory export packages when envelope encryption is configured", async () => {
    const rootKey = randomBytes(32).toString("base64");
    process.env.API_ENVELOPE_ENCRYPTION_PROVIDER = "local_test_key";
    process.env.API_DATA_ENCRYPTION_KEY = rootKey;
    const repository = createFakeRepository();
    const exportMemoryRecords = repository.exportMemoryRecords.bind(repository);
    const curatedPlaintext = "Encrypted Curated Memory export marker";
    repository.exportMemoryRecords = async (actor) => {
      const records = await exportMemoryRecords(actor);
      return {
        ...records,
        curatedMemory: {
          topics: [
            {
              id: "00000000-0000-4000-8000-000000000901",
              ownerUserId: actor.userId,
              visibility: "personal",
              title: curatedPlaintext,
              normalizedTitle: curatedPlaintext.toLowerCase(),
              createdAt: "2026-07-10T00:00:00.000Z",
              updatedAt: "2026-07-10T00:00:00.000Z"
            }
          ],
          assertions: [],
          proposals: []
        }
      };
    };
    const app = await buildServer({
      repository,
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "encrypted-export@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const plaintext = "Encrypted export should hide this Memory text";
    const captured = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-encrypted-export",
        actor: "user",
        eventType: "user_prompt",
        content: plaintext,
        metadata: {
          projectName: "Encrypted Export Repo",
          externalSessionId: "thread-encrypted-export",
          threadName: "Encrypted export thread"
        }
      }
    });
    const exported = await app.inject({
      method: "GET",
      url: "/v1/memory/export",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(captured.statusCode).toBe(200);
    const body = jsonBody<EncryptedMemoryExportResponse>(exported);
    expect(body.manifest).toMatchObject({
      objectClass: "memory_export",
      metadata: {
        eventCount: 1,
        nodeCount: 1
      }
    });
    expect(JSON.stringify(body.manifest)).not.toContain(plaintext);
    expect(exported.body).not.toContain(plaintext);
    expect(exported.body).not.toContain(curatedPlaintext);
    const provider = createLocalTestKeyEnvelopeEncryptionProvider(rootKey);
    await expect(
      decryptEncryptedJsonPackage(provider, body)
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ contentPreview: plaintext })],
      curatedMemory: {
        topics: [expect.objectContaining({ title: curatedPlaintext })]
      }
    });
    const auditEvents = await repository.listAuditEvents(
      { userId: jsonBody<{ user: { id: string } }>(registered).user.id },
      { action: "memory.export.created" }
    );
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "memory.export.created",
      targetTable: "memory_exports"
    });
    expect(auditEvents[0]?.metadata).toMatchObject({
      objectClass: "memory_export",
      reason: "user_requested_export",
      target: "self"
    });
  });

  it("fails closed for hosted memory exports without envelope encryption", async () => {
    process.env.KOED_DEPLOYMENT_PROFILE = "koed_managed_cloud";
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "hosted-export@example.com",
        password: "password123"
      }
    });
    const exported = await app.inject({
      method: "GET",
      url: "/v1/memory/export",
      headers: browserSessionHeaders(cookieHeader(registered))
    });
    await app.close();

    expect(exported.statusCode).toBe(503);
    expect(jsonBody<{ error: string }>(exported).error).toBe(
      "Encrypted export package provider required"
    );
  });

  it("serves a lightweight graph thread index without raw event rows", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "thread-index@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    const firstThreadEvent = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-index-a",
        actor: "user",
        eventType: "user_prompt",
        content:
          "First conversation event with details that should stay out of raw rows",
        metadata: {
          projectName: "Index Repo A",
          projectPath: "/work/repo-index-a",
          externalSessionId: "thread-index-a",
          threadName: "Index conversation A"
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-index-a",
        actor: "assistant",
        eventType: "assistant_response",
        content: "Renamed conversation event preview",
        metadata: {
          projectName: "Renamed Index Repo A",
          projectPath: "/work/renamed-repo-index-a",
          externalSessionId: "thread-index-a",
          threadName: "Renamed index conversation A"
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-index-b",
        actor: "user",
        eventType: "user_prompt",
        content: "Another project conversation preview",
        metadata: {
          projectName: "Index Repo B",
          externalSessionId: "thread-index-b",
          threadName: "Index conversation B"
        }
      }
    });

    const activeIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?limit=100&includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    const limitedIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?limit=1&includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    const offsetIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?limit=1&offset=1&includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    const firstEventPage = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=thread-index-a&limit=1&includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    const firstCursorEvent = jsonBody<GraphEventsResponse>(firstEventPage)
      .events[0] as { id: string; timestamp: string };
    const secondEventPage = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/events?threadId=thread-index-a&limit=1&cursorTimestamp=${encodeURIComponent(firstCursorEvent.timestamp)}&cursorId=${encodeURIComponent(firstCursorEvent.id)}&includeInvalidated=false`,
      headers: browserSessionHeaders(cookie)
    });
    const invalidCursorPage = await app.inject({
      method: "GET",
      url: `/v1/memory/graph/events?threadId=thread-index-a&limit=1&cursorTimestamp=${encodeURIComponent(firstCursorEvent.timestamp)}&includeInvalidated=false`,
      headers: browserSessionHeaders(cookie)
    });
    await app.inject({
      method: "DELETE",
      url: `/v1/memory/graph/events/${jsonBody<CaptureResponse>(firstThreadEvent).event.id}`,
      headers: browserSessionHeaders(cookie)
    });
    const activeAfterDelete = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    const includingInvalidated = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=true",
      headers: browserSessionHeaders(cookie)
    });
    const selectedThreadEvents = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=thread-index-a&limit=250&includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    const active = jsonBody<GraphThreadIndexResponse>(activeIndex);
    const indexA = active.projects
      .flatMap((project) => project.threads)
      .find((thread) => thread.id === "thread-index-a");
    expect(indexA).toMatchObject({
      name: "Renamed index conversation A",
      projectId: "repo-index-a",
      projectName: "Renamed Index Repo A",
      eventCount: 2,
      invalidatedCount: 0,
      sample: "Renamed conversation event preview"
    });
    const projectA = active.projects.find(
      (project) => project.id === "repo-index-a"
    );
    expect(projectA).toMatchObject({
      name: "Renamed Index Repo A",
      path: "/work/renamed-repo-index-a",
      eventCount: 2
    });
    expect(indexA).not.toHaveProperty("rawContent");
    expect(indexA).not.toHaveProperty("contentPreview");
    expect(indexA).toMatchObject({ sourceAiClient: "codex-cli" });
    expect(indexA).not.toHaveProperty("metadata");
    expect(
      jsonBody<GraphThreadIndexResponse>(limitedIndex).projects
    ).toHaveLength(1);
    expect(
      jsonBody<GraphThreadIndexResponse>(limitedIndex).projects.flatMap(
        (project) => project.threads
      )
    ).toHaveLength(1);
    expect(
      jsonBody<GraphThreadIndexResponse>(offsetIndex).projects.flatMap(
        (project) => project.threads
      )
    ).toMatchObject([{ id: "thread-index-a" }]);
    expect(jsonBody<GraphEventsResponse>(secondEventPage).events).toHaveLength(
      1
    );
    expect(
      (
        jsonBody<GraphEventsResponse>(secondEventPage).events[0] as {
          id: string;
        }
      ).id
    ).not.toBe(firstCursorEvent.id);
    expect(invalidCursorPage.statusCode).toBe(400);
    expect(
      jsonBody<GraphThreadIndexResponse>(activeAfterDelete)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.id === "thread-index-a")
    ).toMatchObject({ eventCount: 1, invalidatedCount: 0 });
    expect(
      jsonBody<GraphThreadIndexResponse>(includingInvalidated)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.id === "thread-index-a")
    ).toMatchObject({ eventCount: 2, invalidatedCount: 1 });
    expect(
      jsonBody<GraphEventsResponse>(selectedThreadEvents).events
    ).toHaveLength(1);
  });

  it("moves, preserves, resets, and owner-authorizes Personal Project assignment", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const owner = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "project-assignment-owner@example.com",
        password: "password123"
      }
    });
    const other = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "project-assignment-other@example.com",
        password: "password123"
      }
    });
    const ownerCookie = cookieHeader(owner);
    const ownerToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(ownerCookie),
      payload: { name: "Project assignment capture" }
    });
    const otherToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(other)),
      payload: { name: "Other Project assignment capture" }
    });
    const captureHeaders = {
      authorization: `Bearer ${jsonBody<TokenResponse>(ownerToken).token}`
    };
    const otherCaptureHeaders = {
      authorization: `Bearer ${jsonBody<TokenResponse>(otherToken).token}`
    };
    const idempotencyKey = "project-assignment-session";
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: captureHeaders,
      payload: {
        externalSessionId: "project-assignment-thread",
        cwd: "/work/automatic-a",
        idempotencyKey,
        detectedProjects: [
          { id: "project-a", name: "Project A", path: "/work/automatic-a" }
        ]
      }
    });
    const session = jsonBody<SessionResponse>(created).session;
    const incompleteReplay = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: captureHeaders,
      payload: {
        externalSessionId: "project-assignment-thread",
        idempotencyKey
      }
    });
    const otherOwnerSession = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: otherCaptureHeaders,
      payload: {
        externalSessionId: "attacker-thread",
        cwd: "/work/attacker",
        idempotencyKey,
        detectedProjects: [
          {
            id: "attacker-project",
            name: "Attacker Project",
            path: "/work/attacker"
          }
        ]
      }
    });
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${session.id}/events`,
      headers: captureHeaders,
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "Effective Project grouping marker",
        metadata: { externalSessionId: "project-assignment-thread" }
      }
    });

    const moved = await app.inject({
      method: "PATCH",
      url: `/v1/memory/graph/sessions/${session.id}/project`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        action: "move",
        project: { id: "project-b", name: "Project B", path: "/work/manual-b" }
      }
    });
    const redetected = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: captureHeaders,
      payload: {
        externalSessionId: "project-assignment-thread",
        cwd: "/work/automatic-c",
        idempotencyKey,
        detectedProjects: [
          { id: "project-c", name: "Project C", path: "/work/automatic-c" }
        ]
      }
    });
    const originalCaptureLookup = await app.inject({
      method: "GET",
      url: "/v1/sessions/latest?project_id=project-a",
      headers: captureHeaders
    });
    const organizationalLookup = await app.inject({
      method: "GET",
      url: "/v1/sessions/latest?project_id=project-b",
      headers: captureHeaders
    });
    const groupedAfterMove = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?projectId=project-b",
      headers: browserSessionHeaders(ownerCookie)
    });
    const rejectedOtherOwner = await app.inject({
      method: "PATCH",
      url: `/v1/memory/graph/sessions/${session.id}/project`,
      headers: browserSessionHeaders(cookieHeader(other)),
      payload: {
        action: "move",
        project: { id: "project-a", name: "Project A", path: null }
      }
    });
    const rejectedTeamAuthority = await app.inject({
      method: "PATCH",
      url: `/v1/memory/graph/sessions/${session.id}/project`,
      headers: browserSessionHeaders(ownerCookie),
      payload: {
        action: "move",
        project: { id: "project-a", name: "Project A", path: null },
        teamWorkspaceId: randomUUID()
      }
    });
    const reset = await app.inject({
      method: "PATCH",
      url: `/v1/memory/graph/sessions/${session.id}/project`,
      headers: browserSessionHeaders(ownerCookie),
      payload: { action: "reset" }
    });
    const ambiguous = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: captureHeaders,
      payload: {
        externalSessionId: "ambiguous-project-thread",
        idempotencyKey: "ambiguous-project-session",
        detectedProjects: [
          { id: "project-a", name: "Project A", path: "/work/a" },
          { id: "project-b", name: "Project B", path: "/work/b" }
        ]
      }
    });
    const unassigned = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?projectId=unassigned",
      headers: browserSessionHeaders(ownerCookie)
    });
    await app.close();

    expect(otherOwnerSession.statusCode).toBe(200);
    expect(jsonBody<SessionResponse>(otherOwnerSession).session).toMatchObject({
      ownerUserId: jsonBody<{ user: { id: string } }>(other).user.id,
      externalSessionId: "attacker-thread",
      project: { id: "attacker-project" }
    });
    expect(jsonBody<SessionResponse>(otherOwnerSession).session.id).not.toBe(
      session.id
    );
    expect(session).toMatchObject({
      project: { id: "project-a" },
      projectAssignmentSource: "detected",
      capturedProjectProvenance: {
        outcome: "unambiguous",
        candidates: [{ id: "project-a" }]
      }
    });
    expect(jsonBody<SessionResponse>(incompleteReplay).session).toMatchObject({
      id: session.id,
      automaticProject: { id: "project-a" },
      project: { id: "project-a" },
      projectAssignmentSource: "detected"
    });
    expect(jsonBody<SessionResponse>(moved).session).toMatchObject({
      project: { id: "project-b" },
      projectOverride: { id: "project-b" },
      projectAssignmentSource: "user_override"
    });
    expect(jsonBody<SessionResponse>(redetected).session).toMatchObject({
      id: session.id,
      automaticProject: { id: "project-c" },
      project: { id: "project-b" },
      projectAssignmentSource: "user_override",
      capturedProjectProvenance: {
        candidates: [{ id: "project-a" }]
      }
    });
    expect(originalCaptureLookup.statusCode).toBe(404);
    expect(organizationalLookup.statusCode).toBe(200);
    expect(jsonBody<SessionResponse>(organizationalLookup).session.id).toBe(
      session.id
    );
    expect(
      jsonBody<GraphThreadIndexResponse>(groupedAfterMove).projects[0]
    ).toMatchObject({ id: "project-b", eventCount: 1 });
    expect(rejectedOtherOwner.statusCode).toBe(404);
    expect(rejectedTeamAuthority.statusCode).toBe(400);
    expect(jsonBody<SessionResponse>(reset).session).toMatchObject({
      automaticProject: { id: "project-c" },
      projectOverride: null,
      project: { id: "project-c" },
      projectAssignmentSource: "detected"
    });
    expect(jsonBody<SessionResponse>(ambiguous).session).toMatchObject({
      project: null,
      projectAssignmentSource: null,
      capturedProjectProvenance: { outcome: "ambiguous" }
    });
    expect(jsonBody<GraphThreadIndexResponse>(unassigned).projects).toEqual([
      expect.objectContaining({ id: "unassigned", name: "Unassigned" })
    ]);
  });

  it("renames captured session titles in the graph thread index", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "session-title@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "thread-title-a",
        cwd: "/work/title-repo",
        metadata: {
          projectName: "Title Repo",
          threadName: "thread-title-a"
        }
      }
    });
    const session = jsonBody<SessionResponse>(sessionResponse).session;
    const initialThreads = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/memory/graph/sessions/${session.id}/title`,
      headers: browserSessionHeaders(cookie),
      payload: { title: "Redis Projection Followup" }
    });
    const threads = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    expect(renamed.statusCode).toBe(200);
    expect(
      jsonBody<GraphThreadIndexResponse>(initialThreads)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.sessionId === session.id)
    ).toMatchObject({ name: "thread-title-a" });
    expect(jsonBody<SessionResponse>(renamed).session).toMatchObject({
      id: session.id
    });
    expect(
      jsonBody<GraphThreadIndexResponse>(threads)
        .projects.flatMap((project) => project.threads)
        .find((thread) => thread.sessionId === session.id)
    ).toMatchObject({
      id: "thread-title-a",
      name: "Redis Projection Followup"
    });
  });

  it("lists and accepts local generated session titles", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "generated-session-title@example.com",
        password: "password123"
      }
    });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "thread-generated-title",
        cwd: "/work/title-repo",
        metadata: { threadName: "thread-generated-title" }
      }
    });
    const session = jsonBody<SessionResponse>(sessionResponse).session;
    for (const content of [
      "Can we add early generated titles for Desktop chats?",
      "Can those generated titles avoid waiting for LCM summaries?",
      "Please make manual renames keep winning over generated names."
    ]) {
      await app.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/events`,
        headers,
        payload: {
          actor: "user",
          eventType: "user_prompt",
          content,
          metadata: {}
        }
      });
    }

    const pending = await app.inject({
      method: "GET",
      url: "/v1/memory/session-titles/pending?min_user_events=3",
      headers
    });
    const submitted = await app.inject({
      method: "POST",
      url: `/v1/memory/session-titles/${session.id}`,
      headers,
      payload: {
        title: "Desktop Titles",
        titleModel: "codex-app-server:test",
        titlePromptVersion: "session-title-codex-json-v1"
      }
    });
    const pendingAfterSubmit = await app.inject({
      method: "GET",
      url: "/v1/memory/session-titles/pending?min_user_events=3",
      headers
    });
    await app.close();

    expect(pending.statusCode).toBe(200);
    expect(
      jsonBody<{ sessions: Array<{ id: string }> }>(pending).sessions
    ).toEqual([expect.objectContaining({ id: session.id })]);
    expect(submitted.statusCode).toBe(200);
    expect(jsonBody<{ title: string }>(submitted).title).toBe("Desktop Titles");
    expect(
      jsonBody<{ sessions: Array<{ id: string }> }>(pendingAfterSubmit).sessions
    ).toHaveLength(0);
  });

  it("keeps captured session shells for child threads and exposes parent linkage", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "child-thread-shell@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };

    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "parent-thread",
        sourceRuntime: "codex-cli",
        captureMethod: "transcript",
        cwd: "/work/koed",
        idempotencyKey: "parent-thread-key",
        metadata: {
          externalSessionId: "parent-thread",
          threadName: "Parent conversation",
          projectName: "Koed",
          projectPath: "/work/koed",
          threadKind: "conversation"
        }
      }
    });
    await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "child-thread",
        sourceRuntime: "codex-cli",
        captureMethod: "transcript",
        cwd: "/work/koed",
        idempotencyKey: "child-thread-key",
        metadata: {
          externalSessionId: "child-thread",
          threadName: "Capture reviewer",
          projectName: "Koed",
          projectPath: "/work/koed",
          threadKind: "subagent",
          parentThreadId: "parent-thread",
          parentSessionId: "parent-session"
        }
      }
    });

    const threadIndex = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/threads?includeInvalidated=false",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    const threads = jsonBody<GraphThreadIndexResponse>(
      threadIndex
    ).projects.flatMap((project) => project.threads);
    expect(
      threads.find((thread) => thread.id === "child-thread")
    ).toMatchObject({
      name: "Capture reviewer",
      eventCount: 0,
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      parentSessionId: "parent-session"
    });
    expect(
      threads.find((thread) => thread.id === "parent-thread")
    ).toMatchObject({
      name: "Parent conversation",
      threadKind: "conversation"
    });
  });

  it("preserves explicit subagent display actors in graph events", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "subagent-display-actors@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const metadata = {
      externalSessionId: "child-thread",
      threadKind: "subagent",
      parentThreadId: "parent-thread",
      transcriptType: "agent_message"
    };

    for (const event of [
      {
        actor: "agent",
        content: "Parent agent prompt to child"
      },
      {
        actor: "subagent",
        content: "Child subagent reply"
      },
      {
        actor: "user",
        content: "Legacy parent prompt"
      },
      {
        actor: "assistant",
        content: "Legacy child reply"
      }
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/v1/memory/capture-personal-event",
        headers,
        payload: {
          projectId: "repo-subagent",
          actor: event.actor,
          eventType: "codex_transcript_agent",
          content: event.content,
          metadata
        }
      });
    }

    const events = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=child-thread&includeContent=true",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    const actorsByContent = jsonBody<GraphEventsResponse>(events).events.reduce<
      Record<string, MemoryActor>
    >((result, event) => {
      if (event.content) {
        result[event.content] = event.actor;
      }
      return result;
    }, {});
    expect(actorsByContent).toMatchObject({
      "Parent agent prompt to child": "agent",
      "Child subagent reply": "subagent",
      "Legacy parent prompt": "agent",
      "Legacy child reply": "subagent"
    });
  });

  it("returns full event content from the list endpoint without raw content", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "graph-include-content@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const fullContent = `${"Expanded content. ".repeat(20)}Tail marker.`;

    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        projectId: "repo-content",
        actor: "agent",
        eventType: "codex_transcript_agent",
        content: fullContent,
        metadata: {
          externalSessionId: "thread-content",
          transcriptType: "agent_message"
        }
      }
    });

    const events = await app.inject({
      method: "GET",
      url: "/v1/memory/graph/events?threadId=thread-content&includeContent=true&includeRaw=false",
      headers: browserSessionHeaders(cookie)
    });
    await app.close();

    const event = jsonBody<GraphEventsResponse>(events).events[0];
    expect(event).toMatchObject({
      actor: "agent",
      content: fullContent
    });
    expect(event?.contentPreview).not.toBe(fullContent);
    expect(event).not.toHaveProperty("rawContent");
  });

  it("returns evidence for memory_answer without backend provider configuration", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "no-provider-answer@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    expect(createdToken.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers,
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "No provider answer marker"
      }
    });
    const answer = await app.inject({
      method: "POST",
      url: "/v1/memory/answer",
      headers,
      payload: { query: "provider answer marker", retrieval_scope: "personal" }
    });
    await app.close();

    expect(answer.statusCode).toBe(200);
    const body = jsonBody<AnswerResponse>(answer);
    expect(body.evidence[0]?.summaryText).toContain("No provider answer");
  });

  it("does not compact captured conversation events on the API hot path by default", async () => {
    const repository = createFakeRepository();
    let compactionCalls = 0;
    const originalCreateLcmNodes = repository.createLcmNodes.bind(repository);
    repository.createLcmNodes = async (...args) => {
      compactionCalls += 1;
      return originalCreateLcmNodes(...args);
    };
    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "async-write@example.com",
        password: "password123"
      }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/memory/capture-personal-event",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      },
      payload: {
        actor: "user",
        eventType: "user_prompt",
        content: "Async processing marker"
      }
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(compactionCalls).toBe(0);
    const body = jsonBody<CaptureResponse>(response);
    expect(body.compaction).toBeUndefined();
    if (!body.processing) {
      throw new Error("Expected async processing metadata");
    }
    expect(body.processing.compaction.inline).toBe(false);
  });

  it("reports provider configuration as unsupported for API-token access checks", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "server-synthesis-opt-in@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const access = await app.inject({
      method: "GET",
      url: "/v1/access/check",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      }
    });
    await app.close();

    expect(access.statusCode).toBe(200);
    const body = jsonBody<AccessResponse>(access);
    expect(body.providerConfigSupported).toBe(false);
  });

  it("persists final memory questions and exposes shell and detail records", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "memory-question@example.com", password: "password123" }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers,
      payload: {
        idempotency_key: `final-question-${randomUUID()}`,
        query: "What did we decide about rate limits?",
        origin: "mcp_memory_answer",
        search_domain: "project",
        project_id: "project-1",
        project_name: "Koed",
        thread_id: "thread-1",
        thread_name: "Codex",
        status: "answered",
        answer_markdown: "Use the documented read and write limits.",
        evidence: [{ id: "evidence-1" }],
        citations: [{ id: "citation-1" }],
        retrieval: { searchDomain: "project" },
        local_memory_worker: { status: "ok" },
        response: { markdown: "Use the documented read and write limits." }
      }
    });
    const questionId = jsonBody<MemoryQuestionResponse>(created).question.id;
    await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers,
      payload: {
        idempotency_key: `final-question-${randomUUID()}`,
        query: "What did we decide about an unrelated topic?",
        origin: "mcp_memory_answer",
        status: "answered",
        answer_markdown: "An unrelated answer."
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/memory/questions?search_domain=project&project_id=project-1",
      headers
    });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/memory/questions/${questionId}`,
      headers
    });
    const searched = await app.inject({
      method: "GET",
      url: "/v1/memory/questions?query=rate%20limits",
      headers
    });
    await app.close();

    expect(created.statusCode).toBe(200);
    expect(jsonBody<MemoryQuestionResponse>(created).question.status).toBe(
      "answered"
    );
    expect(jsonBody<MemoryQuestionResponse>(created).question.origin).toBe(
      "mcp_memory_answer"
    );
    expect(
      jsonBody<MemoryQuestionResponse>(created).question.retrievalScope
    ).toBe("personal");
    expect(jsonBody<MemoryQuestionsResponse>(listed).questions).toHaveLength(1);
    expect(jsonBody<MemoryQuestionsResponse>(searched).questions).toHaveLength(
      1
    );
    expect(jsonBody<MemoryQuestionResponse>(detail).question).toMatchObject({
      id: questionId,
      origin: "mcp_memory_answer",
      answerMarkdown: "Use the documented read and write limits.",
      evidenceCount: 1,
      searchDomain: "project",
      projectId: "project-1"
    });
  });

  it("creates and completes ordered Desktop Ask turns idempotently", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "desktop-ask@example.com", password: "password123" }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Desktop" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const idempotencyKey = `desktop-ask-${randomUUID()}`;
    const initial = await app.inject({
      method: "POST",
      url: "/v1/memory/ask/questions",
      headers,
      payload: {
        idempotency_key: idempotencyKey,
        query: "What did I decide?"
      }
    });
    const retried = await app.inject({
      method: "POST",
      url: "/v1/memory/ask/questions",
      headers,
      payload: {
        idempotency_key: idempotencyKey,
        query: "This retry must not create a second turn."
      }
    });
    const initialQuestion = jsonBody<MemoryQuestionResponse>(initial).question;
    const followUp = await app.inject({
      method: "POST",
      url: "/v1/memory/ask/questions",
      headers,
      payload: {
        ask_thread_id: initialQuestion.askThreadId,
        idempotency_key: `desktop-ask-follow-up-${randomUUID()}`,
        query: "What happened next?"
      }
    });
    const completed = await app.inject({
      method: "PATCH",
      url: `/v1/memory/ask/questions/${initialQuestion.id}`,
      headers,
      payload: {
        status: "answered",
        answer_markdown: "You selected the Personal Memory design.",
        evidence: [{ id: "evidence-1" }]
      }
    });
    const completedAgain = await app.inject({
      method: "PATCH",
      url: `/v1/memory/ask/questions/${initialQuestion.id}`,
      headers,
      payload: { status: "error", error_message: "must not replace answer" }
    });
    const recovered = await app.inject({
      method: "POST",
      url: "/v1/memory/ask/questions/recover-pending",
      headers,
      payload: {}
    });
    const threads = await app.inject({
      method: "GET",
      url: "/v1/memory/ask/threads?limit=50",
      headers
    });
    const thread = await app.inject({
      method: "GET",
      url: `/v1/memory/ask/threads/${initialQuestion.askThreadId}`,
      headers
    });
    const otherRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "desktop-ask-other@example.com",
        password: "password123"
      }
    });
    const otherToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(otherRegistered)),
      payload: { name: "Other Desktop" }
    });
    const hidden = await app.inject({
      method: "GET",
      url: `/v1/memory/ask/threads/${initialQuestion.askThreadId}`,
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(otherToken).token}`
      }
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/memory/ask/questions",
      headers,
      payload: {
        idempotency_key: `desktop-ask-malformed-${randomUUID()}`,
        query: "Question",
        retrieval_scope: "team"
      }
    });
    await app.close();

    expect(initial.statusCode).toBe(200);
    expect(initialQuestion).toMatchObject({
      origin: "desktop_ask",
      searchDomain: "global",
      retrievalScope: "personal",
      askTurnIndex: 0,
      status: "pending"
    });
    expect(initialQuestion.askThreadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(jsonBody<MemoryQuestionResponse>(retried).question.id).toBe(
      initialQuestion.id
    );
    expect(jsonBody<MemoryQuestionResponse>(followUp).question).toMatchObject({
      askThreadId: initialQuestion.askThreadId,
      askTurnIndex: 1,
      status: "pending"
    });
    expect(jsonBody<MemoryQuestionResponse>(completed).question).toMatchObject({
      status: "answered",
      answerMarkdown: "You selected the Personal Memory design.",
      evidenceCount: 1
    });
    expect(
      jsonBody<MemoryQuestionResponse>(completedAgain).question.status
    ).toBe("answered");
    expect(jsonBody<{ recovered: number }>(recovered)).toEqual({
      recovered: 1
    });
    expect(jsonBody<{ threads: unknown[] }>(threads).threads).toEqual([
      expect.objectContaining({
        askThreadId: initialQuestion.askThreadId,
        firstQuestion: "What did I decide?",
        turnCount: 2
      })
    ]);
    expect(
      jsonBody<{ questions: MemoryQuestionDetailRecord[] }>(
        thread
      ).questions.map((question) => question.askTurnIndex)
    ).toEqual([0, 1]);
    expect(
      jsonBody<{ questions: MemoryQuestionDetailRecord[] }>(thread).questions[1]
    ).toMatchObject({
      status: "error",
      errorMessage:
        "This Ask was interrupted when the Local AI Runtime stopped. Try again."
    });
    expect(hidden.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
  });

  it("records final MCP memory answer questions", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "final-memory-question@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers,
      payload: {
        idempotency_key: `final-question-${randomUUID()}`,
        query: "What did memory_answer find?",
        origin: "mcp_memory_answer",
        search_domain: "project",
        project_id: "project-1",
        status: "answered",
        answer_markdown: "The answer came from recalled memory.",
        attempt_count: 1,
        response: {
          markdown: "The answer came from recalled memory.",
          retrieval: { evidenceCount: 1 },
          localMemoryWorker: { usedFallback: false }
        },
        evidence: [{ id: "evidence-1", text: "large evidence payload" }],
        retrieval: { mode: "app_server_dynamic_tools" },
        local_memory_worker: { usedFallback: false }
      }
    });
    const question = jsonBody<MemoryQuestionResponse>(created).question;
    await app.close();

    expect(created.statusCode).toBe(200);
    expect(question).toMatchObject({
      origin: "mcp_memory_answer",
      status: "answered",
      answerMarkdown: "The answer came from recalled memory.",
      evidenceCount: 1
    });
    expect(question.response).not.toHaveProperty("evidenceBundle");
  });

  it("does not expose the retired pending Memory Question queue", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "memory-question-retired-routes@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const createPending = await app.inject({
      method: "POST",
      url: "/v1/memory/questions",
      headers,
      payload: { query: "What should not be queued?" }
    });
    const claimPending = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/claim-pending",
      headers,
      payload: {}
    });
    const patchPending = await app.inject({
      method: "PATCH",
      url: "/v1/memory/questions/11111111-1111-4111-8111-111111111111",
      headers,
      payload: { status: "error", error_message: "not used" }
    });
    await app.close();

    expect(createPending.statusCode).toBe(404);
    expect(claimPending.statusCode).toBe(404);
    expect(patchPending.statusCode).toBe(404);
  });

  it("persists local memory agent settings through API tokens", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "local-agent-settings@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const instance = await app.inject({
      method: "PUT",
      url: "/v1/memory/ai-client-instances/codex.default",
      headers,
      payload: {
        driver_id: "codex",
        display_name: "Codex",
        enabled: true
      }
    });
    const now = Date.now();
    const snapshot = await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/codex.default/capability-snapshots",
      headers,
      payload: {
        installation_identity_hash: "a".repeat(64),
        client_version: "test",
        authentication_state: "authenticated",
        health_state: "healthy",
        models: [
          {
            id: "gpt-5.4",
            provider: "openai",
            model: "gpt-5.4",
            fullId: "openai/gpt-5.4",
            provenance: "reported",
            supportedReasoningEfforts: ["high"]
          },
          {
            id: "gpt-5.4-mini",
            model: "gpt-5.4-mini",
            provenance: "reported",
            supportedReasoningEfforts: ["medium", "high"]
          }
        ],
        capabilities: {
          descriptors: {
            local_synthesis: {
              id: "local_synthesis",
              support: "supported",
              readiness: "ready",
              diagnostics: []
            }
          }
        },
        observed_at: new Date(now).toISOString(),
        expires_at: new Date(now + 300_000).toISOString()
      }
    });

    const listedClients = await app.inject({
      method: "GET",
      url: "/v1/memory/ai-client-instances",
      headers
    });
    const savedMcp = await app.inject({
      method: "PUT",
      url: "/v1/memory/local-agent-settings/mcp_memory_answer",
      headers,
      payload: {
        provider: "codex",
        model: "gpt-5.4",
        reasoning_effort: "high",
        timeout_ms: 180000,
        max_attempts: 3
      }
    });
    const savedLcm = await app.inject({
      method: "PUT",
      url: "/v1/memory/local-agent-settings/lcm_summary",
      headers,
      payload: {
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoning_effort: "medium",
        timeout_ms: 120000,
        max_attempts: 2
      }
    });
    const savedCuratedReview = await app.inject({
      method: "PUT",
      url: "/v1/memory/local-agent-settings/curated_memory_review",
      headers,
      payload: {
        provider: "codex",
        model: "gpt-5.4-mini",
        reasoning_effort: "high",
        timeout_ms: 150000,
        max_attempts: 4
      }
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/memory/local-agent-settings",
      headers
    });
    const resetMcp = await app.inject({
      method: "DELETE",
      url: "/v1/memory/local-agent-settings/mcp_memory_answer",
      headers
    });
    const resetAgain = await app.inject({
      method: "DELETE",
      url: "/v1/memory/local-agent-settings/mcp_memory_answer",
      headers
    });
    const listedAfterReset = await app.inject({
      method: "GET",
      url: "/v1/memory/local-agent-settings",
      headers
    });
    const unauthenticatedReset = await app.inject({
      method: "DELETE",
      url: "/v1/memory/local-agent-settings/lcm_summary"
    });
    const invalidFlowReset = await app.inject({
      method: "DELETE",
      url: "/v1/memory/local-agent-settings/unsupported_flow",
      headers
    });
    const secondRegistered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "local-agent-settings-other@example.com",
        password: "password123"
      }
    });
    const secondToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(secondRegistered)),
      payload: { name: "Other Client" }
    });
    const crossUserReset = await app.inject({
      method: "DELETE",
      url: "/v1/memory/local-agent-settings/lcm_summary",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(secondToken).token}`
      }
    });
    await app.close();

    expect(instance.statusCode, instance.body).toBe(200);
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    expect(listedClients.statusCode, listedClients.body).toBe(200);
    expect(
      jsonBody<{ capabilitySnapshots: Array<{ stale: boolean }> }>(
        listedClients
      ).capabilitySnapshots
    ).toEqual([expect.objectContaining({ stale: false })]);
    expect(savedMcp.statusCode).toBe(200);
    expect(savedLcm.statusCode).toBe(200);
    expect(savedCuratedReview.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
    const listedPayload = jsonBody<{
      instances: Array<{ instanceId: string; driverId: string }>;
      capabilitySnapshots: Array<{ instanceId: string; stale: boolean }>;
      defaults: {
        mcp_memory_answer: {
          source: string;
          available: boolean;
          provider: string;
          model: string;
        };
      };
    }>(listed);
    expect(listedPayload.instances).toEqual([
      expect.objectContaining({
        instanceId: "codex.default",
        driverId: "codex"
      })
    ]);
    expect(listedPayload.capabilitySnapshots).toEqual([
      expect.objectContaining({ instanceId: "codex.default", stale: false })
    ]);
    expect(listedPayload.defaults.mcp_memory_answer.source).toBe("code");
    expect(listedPayload.defaults.mcp_memory_answer.available).toBe(true);
    expect(listedPayload.defaults.mcp_memory_answer.provider).toBe("codex");
    expect(listedPayload.defaults.mcp_memory_answer.model).toBe("gpt-5.6-luna");
    expect(
      jsonBody<{ settings: LocalMemoryAgentSettingRecord[] }>(listed).settings
    ).toEqual([
      expect.objectContaining({
        flowKey: "curated_memory_review",
        model: "gpt-5.4-mini",
        reasoningEffort: "high"
      }),
      expect.objectContaining({
        flowKey: "lcm_summary",
        model: "gpt-5.4-mini",
        reasoningEffort: "medium"
      }),
      expect.objectContaining({
        flowKey: "mcp_memory_answer",
        model: "gpt-5.4",
        reasoningEffort: "high"
      })
    ]);
    expect(resetMcp.statusCode).toBe(200);
    expect(jsonBody<{ reset: boolean }>(resetMcp).reset).toBe(true);
    expect(resetAgain.statusCode).toBe(200);
    expect(jsonBody<{ reset: boolean }>(resetAgain).reset).toBe(false);
    expect(unauthenticatedReset.statusCode).toBe(401);
    expect(invalidFlowReset.statusCode).toBe(400);
    expect(crossUserReset.statusCode).toBe(200);
    expect(jsonBody<{ reset: boolean }>(crossUserReset).reset).toBe(false);
    expect(listedAfterReset.statusCode).toBe(200);
    expect(
      jsonBody<{ defaults: Record<string, unknown> }>(listed).defaults
    ).toHaveProperty("mcp_memory_answer");
    expect(
      jsonBody<{ settings: LocalMemoryAgentSettingRecord[] }>(listedAfterReset)
        .settings
    ).toEqual([
      expect.objectContaining({ flowKey: "curated_memory_review" }),
      expect.objectContaining({ flowKey: "lcm_summary" })
    ]);
  });

  it("rejects unsupported retrieval scope for persisted questions", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "memory-question-scope@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      },
      payload: {
        idempotency_key: `invalid-scope-${randomUUID()}`,
        query: "What did we decide about memory?",
        origin: "mcp_memory_answer",
        retrieval_scope: "shared",
        search_domain: "global",
        status: "answered",
        answer_markdown: "Not persisted."
      }
    });
    await app.close();

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: "Invalid request payload"
    });
  });

  it("rejects Explorer origin on final memory question creation", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "memory-question-explorer-origin@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/memory/questions/final",
      headers: {
        authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
      },
      payload: {
        idempotency_key: `invalid-origin-${randomUUID()}`,
        query: "What did memory_answer find?",
        origin: "explorer",
        search_domain: "global",
        status: "answered",
        answer_markdown: "Not persisted."
      }
    });
    await app.close();

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      error: "Invalid request payload"
    });
  });

  it("finds the latest Personal Captured Session for a Project via API Token", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "latest-session@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const older = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "latest-session-a",
        cwd: "/tmp/latest-project"
      }
    });
    const newer = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "latest-session-b",
        cwd: "/tmp/latest-project"
      }
    });
    const latest = await app.inject({
      method: "GET",
      url: "/v1/sessions/latest?project_id=%2Ftmp%2Flatest-project",
      headers
    });
    await app.close();

    expect(latest.statusCode).toBe(200);
    expect(jsonBody<SessionResponse>(latest).session.id).toBe(
      jsonBody<SessionResponse>(newer).session.id
    );
    expect(jsonBody<SessionResponse>(latest).session.id).not.toBe(
      jsonBody<SessionResponse>(older).session.id
    );
  });

  it("fails closed when a workflow assignment is not backed by a current matching AI Client capability", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "invalid-agent-assignment@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const assignment = (model: string) =>
      app.inject({
        method: "PUT",
        url: "/v1/memory/local-agent-settings/mcp_memory_answer",
        headers,
        payload: {
          provider: "codex",
          ai_client_instance_id: "codex.work",
          model,
          reasoning_effort: "low",
          timeout_ms: 120000,
          max_attempts: 1
        }
      });

    const missing = await assignment("gpt-5.4");
    await app.inject({
      method: "PUT",
      url: "/v1/memory/ai-client-instances/codex.work",
      headers,
      payload: {
        driver_id: "codex",
        display_name: "Work Codex",
        enabled: false
      }
    });
    const disabled = await assignment("gpt-5.4");
    await app.inject({
      method: "PUT",
      url: "/v1/memory/ai-client-instances/codex.work",
      headers,
      payload: {
        driver_id: "codex",
        display_name: "Work Codex",
        enabled: true
      }
    });
    const withoutSnapshot = await assignment("gpt-5.4");
    const now = Date.now();
    await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/codex.work/capability-snapshots",
      headers,
      payload: {
        installation_identity_hash: "b".repeat(64),
        client_version: "test",
        authentication_state: "authenticated",
        health_state: "healthy",
        models: [
          {
            id: "gpt-5.4",
            provider: "openai",
            model: "gpt-5.4",
            fullId: "openai/gpt-5.4",
            provenance: "reported",
            supportedReasoningEfforts: ["low"]
          }
        ],
        capabilities: {
          descriptors: {
            local_synthesis: {
              id: "local_synthesis",
              support: "supported",
              readiness: "ready",
              diagnostics: []
            }
          }
        },
        observed_at: new Date(now).toISOString(),
        expires_at: new Date(now + 300_000).toISOString()
      }
    });
    const unknownModel = await assignment("not-reported");
    const valid = await assignment("gpt-5.4");
    const validQualifiedAlias = await assignment("openai/gpt-5.4");
    await app.close();

    expect(missing.statusCode).toBe(409);
    expect(disabled.statusCode).toBe(409);
    expect(withoutSnapshot.statusCode).toBe(409);
    expect(unknownModel.statusCode).toBe(409);
    expect(valid.statusCode).toBe(200);
    expect(validQualifiedAlias.statusCode).toBe(200);
  });

  it("validates Claude reasoning effort against the reported model capability", async () => {
    const app = await buildServer({ repository: createFakeRepository() });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: "claude-option-validation@example.com",
        password: "password123"
      }
    });
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Client Integration" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    await app.inject({
      method: "PUT",
      url: "/v1/memory/ai-client-instances/claude.default",
      headers,
      payload: {
        driver_id: "claude",
        display_name: "Claude Code",
        enabled: true
      }
    });
    const now = Date.now();
    await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/claude.default/capability-snapshots",
      headers,
      payload: {
        installation_identity_hash: "c".repeat(64),
        client_version: "2.1.227",
        authentication_state: "authenticated",
        health_state: "healthy",
        models: [
          {
            id: "claude-haiku",
            model: "claude-haiku",
            provenance: "reported",
            supportedReasoningEfforts: ["low"]
          },
          {
            id: "claude-no-effort",
            model: "claude-no-effort",
            provenance: "reported",
            supportedReasoningEfforts: ["none"]
          }
        ],
        capabilities: {
          descriptors: {
            local_synthesis: {
              id: "local_synthesis",
              support: "supported",
              readiness: "ready",
              diagnostics: []
            }
          }
        },
        observed_at: new Date(now).toISOString(),
        expires_at: new Date(now + 300_000).toISOString()
      }
    });
    const assign = (model: string, reasoningEffort: string) =>
      app.inject({
        method: "PUT",
        url: "/v1/memory/local-agent-settings/mcp_memory_answer",
        headers,
        payload: {
          provider: "claude",
          model,
          reasoning_effort: reasoningEffort,
          timeout_ms: 120000,
          max_attempts: 1
        }
      });

    const unsupported = await assign("claude-haiku", "high");
    const supported = await assign("claude-haiku", "low");
    const noEffort = await assign("claude-no-effort", "none");
    await app.inject({
      method: "POST",
      url: "/v1/memory/ai-client-instances/claude.default/capability-snapshots",
      headers,
      payload: {
        installation_identity_hash: "c".repeat(64),
        client_version: "2.1.227",
        authentication_state: "authenticated",
        health_state: "healthy",
        models: [
          { id: "claude-haiku", model: "claude-haiku", provenance: "reported" }
        ],
        capabilities: {
          descriptors: {
            local_synthesis: {
              id: "local_synthesis",
              support: "unsupported",
              readiness: "not_ready",
              diagnostics: []
            }
          }
        },
        observed_at: new Date(now + 1_000).toISOString(),
        expires_at: new Date(now + 300_000).toISOString()
      }
    });
    const unsupportedSynthesis = await assign("claude-haiku", "low");
    await app.close();

    expect(unsupported.statusCode).toBe(409);
    expect(unsupported.body).toContain("is not reported");
    expect(supported.statusCode).toBe(200);
    expect(noEffort.statusCode).toBe(200);
    expect(unsupportedSynthesis.statusCode).toBe(409);
  });

  it("creates MCP sessions, captures session events, exposes nodes, and serves OpenAPI JSON", async () => {
    const app = await buildServer({
      repository: createFakeRepository(),
      runMemoryJobsInlineForTests: true
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "mcp-session@example.com", password: "password123" }
    });
    const cookie = cookieHeader(registered);
    const createdToken = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookie),
      payload: { name: "Client Integration" }
    });
    expect(createdToken.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(createdToken).token}`
    };
    const session = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        externalSessionId: "codex-session-1",
        model: "gpt-5.5",
        cwd: "/tmp/project"
      }
    });
    expect(session.statusCode).toBe(200);
    const sessionId = jsonBody<SessionResponse>(session).session.id;
    const event = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/events`,
      headers,
      payload: {
        actor: "assistant",
        eventType: "message",
        content: "Session event memory marker"
      }
    });
    const nodeId = jsonBody<CaptureResponse>(event).compaction?.leafNodeIds[0];
    const node = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}`,
      headers
    });
    const expanded = await app.inject({
      method: "GET",
      url: `/v1/memory/nodes/${nodeId}/expand`,
      headers
    });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    await app.close();

    expect(session.statusCode).toBe(200);
    expect(event.statusCode).toBe(200);
    expect(node.statusCode).toBe(200);
    expect(
      jsonBody<ExpandedResponse>(expanded).expanded.sources[0]?.content
    ).toBe("Session event memory marker");
    expect(
      jsonBody<OpenApiResponse>(openapi).paths["/v1/memory/answer"]
    ).toBeDefined();
    expect(
      jsonBody<OpenApiResponse>(openapi).paths["/v1/capabilities"]
    ).toMatchObject({
      get: {
        security: []
      }
    });
  });

  it("commits only the evidence selected by a local Curated Memory review", async () => {
    const repository = createFakeRepository();
    const selectedId = "11111111-1111-4111-8111-111111111111";
    const unselectedId = "22222222-2222-4222-8222-222222222222";
    const proposalId = "33333333-3333-4333-8333-333333333333";
    const reviewInputs: unknown[] = [];
    const now = new Date().toISOString();
    const proposal = {
      id: proposalId,
      ownerUserId: "route-auth-owner",
      visibility: "personal" as const,
      proposedClaim: "window seat",
      proposedTopic: "Travel",
      rationale: null,
      tags: ["travel"],
      sensitivityHint: "normal" as const,
      expiresAt: null,
      evidenceConversationItemIds: [selectedId, unselectedId],
      evidenceMemoryEventIds: [],
      operation: "store" as const,
      targetAssertionId: null,
      status: "pending" as const,
      decisionReason: null,
      assertionId: null,
      workerResult: null,
      processingStartedAt: now,
      processingLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
      attemptCount: 1,
      lastErrorMessage: null,
      createdByModel: "codex",
      createdByPromptVersion: "memory-intake-propose-mcp-v1",
      createdAt: now,
      updatedAt: now,
      decidedAt: null
    };
    repository.claimPendingCuratedMemoryProposals = async () => [
      {
        proposal,
        evidence: [
          {
            sourceType: "conversation_item",
            sourceId: selectedId,
            sourceHash: "selected-hash",
            text: "I strongly prefer a window seat.",
            occurredAt: now,
            sessionId: null,
            metadata: {}
          },
          {
            sourceType: "conversation_item",
            sourceId: unselectedId,
            sourceHash: "unselected-hash",
            text: "This separate evidence is not needed.",
            occurredAt: now,
            sessionId: null,
            metadata: {}
          }
        ],
        rejectedSourceCount: 0,
        currentAssertions: []
      }
    ];
    repository.getCuratedMemoryProposal = async () => proposal;
    repository.processCuratedMemoryProposal = async (_actor, input) => {
      reviewInputs.push(input);
      return {
        ...proposal,
        status: input.decision === "skip" ? "skipped" : "stored",
        assertionId: "44444444-4444-4444-8444-444444444444"
      };
    };

    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: `curated-review-${randomUUID()}@example.com`,
        password: "password123"
      }
    });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Curated review test" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const claimed = await app.inject({
      method: "POST",
      url: "/v1/memory/curated/proposals/claim-pending",
      headers,
      payload: { proposal_id: proposalId, limit: 1 }
    });
    expect(claimed.statusCode).toBe(200);

    const missingSelection = await app.inject({
      method: "PATCH",
      url: `/v1/memory/curated/proposals/${proposalId}/review`,
      headers,
      payload: {
        outcome: "accepted",
        operation: "store",
        attempt_count: 1,
        evidence_revisions: [],
        candidate_assertion_ids: [],
        assertion_text: "The user prefers window seats.",
        decision_reason: "Supported.",
        reviewer_model: "gpt-5.4-mini",
        reviewer_prompt_version: "curated-memory-local-review-v1"
      }
    });
    expect(missingSelection.statusCode).toBe(400);

    const completed = await app.inject({
      method: "PATCH",
      url: `/v1/memory/curated/proposals/${proposalId}/review`,
      headers,
      payload: {
        outcome: "accepted",
        operation: "store",
        target_assertion_id: null,
        attempt_count: 1,
        evidence_revisions: [
          {
            source_type: "conversation_item",
            source_id: selectedId,
            source_hash: "selected-hash"
          },
          {
            source_type: "conversation_item",
            source_id: unselectedId,
            source_hash: "unselected-hash"
          }
        ],
        selected_evidence_ids: [selectedId],
        candidate_assertion_ids: [],
        assertion_text: "The user strongly prefers window seats when flying.",
        topic_title: "Travel preferences",
        tags: ["travel"],
        sensitivity: "normal",
        confidence: 95,
        expires_at: null,
        decision_reason: "Supported durable preference.",
        reviewer_model: "gpt-5.4-mini",
        reviewer_prompt_version: "curated-memory-local-review-v1"
      }
    });
    await app.close();

    expect(completed.statusCode).toBe(200);
    expect(reviewInputs).toHaveLength(1);
    expect(reviewInputs[0]).toMatchObject({
      selectedEvidenceIds: [selectedId],
      assertion: {
        sources: [
          {
            sourceType: "conversation_item",
            conversationItemId: selectedId
          }
        ]
      }
    });
  });

  it("fails closed when Curated Memory reviewer output weakens proposal policy", async () => {
    const repository = createFakeRepository();
    const proposalId = randomUUID();
    const evidenceId = randomUUID();
    const now = new Date().toISOString();
    const decisions: Array<Record<string, unknown>> = [];
    let proposalPolicy: {
      sensitivityHint: "normal" | "sensitive" | "review_required" | null;
      expiresAt: string | null;
    } = { sensitivityHint: "review_required", expiresAt: null };
    const proposal = () => ({
      id: proposalId,
      ownerUserId: "route-auth-owner",
      visibility: "personal" as const,
      proposedClaim: "Policy-bound memory",
      proposedTopic: null,
      rationale: null,
      tags: [],
      ...proposalPolicy,
      evidenceConversationItemIds: [evidenceId],
      evidenceMemoryEventIds: [],
      operation: "store" as const,
      targetAssertionId: null,
      status: "pending" as const,
      decisionReason: null,
      assertionId: null,
      workerResult: null,
      processingStartedAt: now,
      processingLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
      attemptCount: 1,
      lastErrorMessage: null,
      createdByModel: "codex",
      createdByPromptVersion: "memory-intake-propose-mcp-v1",
      createdAt: now,
      updatedAt: now,
      decidedAt: null
    });
    repository.getCuratedMemoryProposal = async () => proposal();
    repository.processCuratedMemoryProposal = async (_actor, input) => {
      decisions.push(input as unknown as Record<string, unknown>);
      return { ...proposal(), status: "skipped" as const };
    };

    const app = await buildServer({ repository });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: `curated-policy-${randomUUID()}@example.com`,
        password: "password123"
      }
    });
    const tokenResponse = await app.inject({
      method: "POST",
      url: "/api-tokens",
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: { name: "Curated policy test" }
    });
    const headers = {
      authorization: `Bearer ${jsonBody<TokenResponse>(tokenResponse).token}`
    };
    const acceptedPayload = {
      outcome: "accepted",
      operation: "store",
      target_assertion_id: null,
      attempt_count: 1,
      evidence_revisions: [
        {
          source_type: "conversation_item",
          source_id: evidenceId,
          source_hash: "current"
        }
      ],
      selected_evidence_ids: [evidenceId],
      candidate_assertion_ids: [],
      assertion_text: "Policy-bound memory",
      topic_title: null,
      tags: [],
      sensitivity: "normal",
      confidence: 90,
      expires_at: null,
      decision_reason: "Accepted by reviewer",
      reviewer_model: "test",
      reviewer_prompt_version: "test"
    };

    for (const testCase of [
      {
        policy: {
          sensitivityHint: "review_required" as const,
          expiresAt: null
        },
        payload: acceptedPayload
      },
      {
        policy: { sensitivityHint: "sensitive" as const, expiresAt: null },
        payload: acceptedPayload
      },
      {
        policy: {
          sensitivityHint: "normal" as const,
          expiresAt: "2027-01-01T00:00:00.000Z"
        },
        payload: {
          ...acceptedPayload,
          expires_at: "2028-01-01T00:00:00.000Z"
        }
      }
    ]) {
      proposalPolicy = testCase.policy;
      const response = await app.inject({
        method: "PATCH",
        url: `/v1/memory/curated/proposals/${proposalId}/review`,
        headers,
        payload: testCase.payload
      });
      expect(response.statusCode).toBe(200);
    }
    await app.close();

    expect(decisions).toHaveLength(3);
    expect(decisions.every((input) => input.decision === "skip")).toBe(true);
    expect(decisions.map((input) => input.decisionReason)).toEqual([
      "Curated Memory requires explicit user review",
      "Curated Memory reviewer cannot lower proposed sensitivity",
      "Curated Memory reviewer cannot remove or extend proposed expiry"
    ]);
  });

  it("maps signed PDS repository CAS conflicts to HTTP 409", async () => {
    const genesis = JSON.parse(
      pdsFixture.signedRecords.genesis.canonicalPayloadUtf8
    ) as { draft: { groupId: string; body: Record<string, string> } };
    const add = JSON.parse(
      pdsFixture.signedRecords.addDevice.canonicalPayloadUtf8
    ) as { draft: { body: Record<string, string> } };
    const key = (seedHex: string, publicKey: string) =>
      createPrivateKey({
        key: {
          kty: "OKP",
          crv: "Ed25519",
          d: Buffer.from(seedHex, "hex").toString("base64url"),
          x: publicKey
        },
        format: "jwk"
      });
    const authority = key(
      pdsFixture.nonProductionKeyMaterial.authoritySigningSeedHex,
      genesis.draft.body.authorityPublicKey!
    );
    const group = {
      id: randomUUID(),
      groupId: genesis.draft.groupId,
      authorityKeyId: genesis.draft.body.authorityKeyId!,
      authorityPublicKey: genesis.draft.body.authorityPublicKey!,
      recoverySigningKeyId: genesis.draft.body.recoverySigningKeyId!,
      recoverySigningPublicKey: genesis.draft.body.recoverySigningPublicKey!,
      recoveryKemKeyId: genesis.draft.body.recoveryKemKeyId!,
      recoveryKemPublicKey: genesis.draft.body.recoveryKemPublicKey!,
      recoveryKitHash: genesis.draft.body.recoveryKitHash!,
      currentEpoch: "1",
      pendingEpoch: null,
      pendingStatementSequence: null,
      pendingStatementHash: null,
      pendingBundleHash: null,
      headSequence: "1",
      headHash: pdsFixture.signedRecords.genesis.recordHash,
      state: "active" as const,
      stateReason: null,
      members: [
        {
          deviceId: genesis.draft.body.initialDeviceId!,
          signingKeyId: genesis.draft.body.initialDeviceSigningKeyId!,
          signingPublicKey: genesis.draft.body.initialDeviceSigningPublicKey!,
          kemKeyId: genesis.draft.body.initialDeviceKemKeyId!,
          kemPublicKey: genesis.draft.body.initialDeviceKemPublicKey!,
          operationFamilies: ["pds_relay"],
          status: "active" as const,
          admittedSequence: "1",
          revokedSequence: null,
          revokedAt: null
        }
      ],
      policy: {
        enabled: false,
        futureClosedSessionsOnly: true as const,
        historicalBackfillEnabled: false as const
      }
    };
    const bundle = createPdsAuthorizedKeyBundle({
      groupId: group.groupId,
      epoch: "2",
      transitionKind: "add-device",
      authorizationKeyId: group.members[0]!.signingKeyId,
      authorizationPrivateKey: key(
        pdsFixture.nonProductionKeyMaterial.initialDeviceSigningSeedHex,
        group.members[0]!.signingPublicKey
      ),
      recipients: [
        {
          recipientId: group.members[0]!.deviceId,
          recipientKind: "device",
          recipientKemKeyId: group.members[0]!.kemKeyId,
          recipientKemPublicKey: group.members[0]!.kemPublicKey
        },
        {
          recipientId: add.draft.body.deviceId!,
          recipientKind: "device",
          recipientKemKeyId: add.draft.body.deviceKemKeyId!,
          recipientKemPublicKey: add.draft.body.deviceKemPublicKey!
        },
        {
          recipientId: group.recoveryKemKeyId,
          recipientKind: "recovery",
          recipientKemKeyId: group.recoveryKemKeyId,
          recipientKemPublicKey: group.recoveryKemPublicKey
        }
      ],
      secrets: {
        epochSecret: randomBytes(32).toString("base64url"),
        sourceFingerprintKey: randomBytes(32).toString("base64url"),
        tombstoneFloorKey: randomBytes(32).toString("base64url"),
        projectAliasKey: randomBytes(32).toString("base64url")
      }
    });
    const draft = {
      ...add.draft,
      body: { ...add.draft.body, keyBundleHash: bundle.authorizationHash }
    };
    const authorization = {
      signerKeyId: group.members[0]!.signingKeyId,
      signature: signPdsGroupDraft(
        draft,
        key(
          pdsFixture.nonProductionKeyMaterial.initialDeviceSigningSeedHex,
          group.members[0]!.signingPublicKey
        )
      )
    };
    const challengeId = randomUUID();
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const proofUnsigned = (browserSubjectId: string) => ({
      challengeId,
      challenge,
      groupId: group.groupId,
      deviceId: add.draft.body.deviceId,
      deviceSigningKeyId: add.draft.body.deviceSigningKeyId,
      deviceSigningPublicKey: add.draft.body.deviceSigningPublicKey,
      deviceKemKeyId: add.draft.body.deviceKemKeyId,
      deviceKemPublicKey: add.draft.body.deviceKemPublicKey,
      browserSubjectId,
      browserDeploymentId: testProtocolDeploymentId,
      expiresAt
    });
    const commitPersonalDeviceTransition = vi.fn(async () => ({
      outcome: "conflict" as const,
      group,
      statement: pdsFixture.signedRecords.genesis.canonicalPayloadUtf8
    }));
    const repository = Object.assign(createFakeRepository(), {
      createPersonalDeviceEnrollmentChallenge: async () => ({
        id: challengeId,
        expiresAt
      }),
      getPersonalDeviceGroup: async () => group,
      commitPersonalDeviceTransition
    });
    const app = await buildServer({
      repository,
      pdsAuthoritySigner: {
        keyId: group.authorityKeyId,
        publicKey: group.authorityPublicKey,
        privateKey: authority
      }
    });
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        email: `pds-cas-${randomUUID()}@example.com`,
        password: "password123"
      }
    });
    const userId = jsonBody<{ user: { id: string } }>(registered).user.id;
    const response = await app.inject({
      method: "POST",
      url: `/v1/personal-device-sync/groups/${group.groupId}/transitions`,
      headers: browserSessionHeaders(cookieHeader(registered)),
      payload: {
        statement: canonicalizePdsJson({ draft, authorization }),
        key_bundle: canonicalizePdsJson(bundle.bundle),
        proof: {
          challenge_id: challengeId,
          challenge,
          device_id: add.draft.body.deviceId,
          expires_at: expiresAt,
          signature: sign(
            null,
            Buffer.from(
              `koed/pds/v1/enrollment-proof\n${canonicalizePdsJson(proofUnsigned(userId))}`,
              "utf8"
            ),
            key(
              pdsFixture.nonProductionKeyMaterial.secondDeviceSigningSeedHex,
              add.draft.body.deviceSigningPublicKey!
            )
          ).toString("base64url")
        }
      }
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(commitPersonalDeviceTransition).toHaveBeenCalledOnce();
    await app.close();
  });

  it("denies API Tokens and device credentials for PDS governance", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    const app = await buildServer({
      repository: createFakeRepository(),
      pdsAuthoritySigner: {
        keyId: "test-authority",
        publicKey: publicJwk.x!,
        privateKey
      }
    });
    for (const authorization of [
      "Bearer personal-api-token",
      "Koed-Device device:credential"
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/challenges",
        headers: { authorization },
        payload: {}
      });
      expect(response.statusCode).toBe(403);
      expect(jsonBody<{ error: string }>(response).error).toContain(
        "browser session"
      );
    }
    await app.close();
  });

  it("permits a scoped Desktop credential only on the local Personal boundary", async () => {
    const previousKoedHome = process.env.KOED_HOME;
    const previousProfile = process.env.KOED_DEPLOYMENT_PROFILE;
    const koedHome = mkdtempSync(resolve(tmpdir(), "koed-pds-desktop-"));
    process.env.KOED_HOME = koedHome;
    process.env.KOED_DEPLOYMENT_PROFILE = "local_personal";
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
    const wakePdsLocalSync = vi.fn(async () => undefined);
    const repository = Object.assign(createFakeRepository(), {
      listPersonalDeviceGroups: async () => [],
      wakePdsLocalSync
    });
    const app = await buildServer({
      repository,
      pdsAuthoritySigner: {
        keyId: "test-authority",
        publicKey: publicJwk.x!,
        privateKey
      }
    });
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          email: `pds-desktop-${randomUUID()}@example.com`,
          password: "password123"
        }
      });
      const userId = jsonBody<{ user: { id: string } }>(registered).user.id;
      const desktop = storeDesktopLocalCredential(koedHome, {
        ownerUserId: userId,
        operationFamilies: [
          "personal_collaboration_read",
          "personal_collaboration_write"
        ]
      });

      const accepted = await app.inject({
        method: "GET",
        url: "/v1/personal-device-sync/groups",
        headers: { authorization: desktop.authorization }
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(
        jsonBody<{
          groups: unknown[];
          pairing_invitation_group_ids: string[];
        }>(accepted)
      ).toEqual({
        groups: [],
        pairing_invitation_group_ids: []
      });

      const wake = await app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        headers: { authorization: desktop.authorization }
      });
      expect(wake.statusCode, wake.body).toBe(200);
      expect(wakePdsLocalSync).toHaveBeenCalledWith("desktop_runtime_updated");

      const invalid = await app.inject({
        method: "GET",
        url: "/v1/personal-device-sync/groups",
        headers: {
          authorization: `${desktop.authorization.slice(0, -1)}${
            desktop.authorization.endsWith("A") ? "B" : "A"
          }`
        }
      });
      expect(invalid.statusCode).toBe(401);

      const remote = await app.inject({
        method: "GET",
        url: "/v1/personal-device-sync/groups",
        remoteAddress: "192.0.2.10",
        headers: { authorization: desktop.authorization }
      });
      expect(remote.statusCode).toBe(403);

      const remoteWake = await app.inject({
        method: "POST",
        url: "/v1/personal-device-sync/local-runtime-wake",
        remoteAddress: "192.0.2.10",
        headers: { authorization: desktop.authorization }
      });
      expect(remoteWake.statusCode).toBe(403);
    } finally {
      await app.close();
      rmSync(koedHome, { recursive: true, force: true });
      if (previousKoedHome === undefined) delete process.env.KOED_HOME;
      else process.env.KOED_HOME = previousKoedHome;
      if (previousProfile === undefined)
        delete process.env.KOED_DEPLOYMENT_PROFILE;
      else process.env.KOED_DEPLOYMENT_PROFILE = previousProfile;
    }
  });
});
