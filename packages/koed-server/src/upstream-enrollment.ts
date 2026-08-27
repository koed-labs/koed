import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertSecureHttpTransport,
  deleteLocalEdgeClientCredential,
  deleteUpstreamCredentialSecret,
  readLocalEdgeUpstreamEnrollmentBinding,
  readUpstreamCredentialAuthorization,
  storeEnrollmentCredentialCustody,
  upstreamCredentialReferenceFor,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret
} from "@koed/shared";
import {
  createSecureUpstreamFetch,
  registeredPrivateNetworkPolicy
} from "@koed/shared/secure-upstream-fetch";
import type { KoedServerPaths } from "./paths.js";
import { ensureDeviceIdentity } from "./device-identity.js";
import {
  beginUpstreamDisconnectCleanup,
  updateUpstreamDisconnectCleanup,
  upstreamDisconnectCleanupPending
} from "./upstream-disconnect-cleanup.js";
import { withUpstreamEnrollmentLock } from "./upstream-enrollment-lock.js";
import {
  createUpstreamEnrollmentTransaction,
  decideUpstreamEnrollmentTransaction,
  executeUpstreamEnrollmentTransactionEffect,
  upstreamEnrollmentObservationApplies,
  type UpstreamEnrollmentTransactionSnapshot
} from "./upstream-enrollment-transaction.js";
import {
  clearUpstreamBackendCapabilities,
  collectUpstreamRegistryStatus,
  getActiveUpstreamBackend,
  setActiveUpstreamBackend,
  upstreamBackendAdvertisesCapability,
  updateUpstreamBackendCredential,
  updateUpstreamBackendRoutePolicy,
  type UpstreamBackendSummary,
  type UpstreamCredentialStatus,
  type UpstreamRoutePolicy
} from "./upstream-registry.js";

export type UpstreamEnrollmentState =
  | "pending"
  | "approved"
  | "exchanged"
  | "denied"
  | "expired"
  | "canceled"
  | "revoked"
  | "failed";

export interface UpstreamEnrollmentRecord {
  backendId: string;
  requestId: string;
  state: UpstreamEnrollmentState;
  activationUrl: string | null;
  requestedOperationFamilies: string[];
  transaction:
    | { kind: "initial" }
    | {
        kind: "replacement";
        predecessorCredentialId: string;
        predecessorCredentialReference: string;
      };
  transactionState: UpstreamEnrollmentTransactionSnapshot;
  activeCredentialReference?: string;
  pendingCredentialReference?: string;
  challengeHash?: string;
  challengeId?: string;
  credentialKeyId?: string;
  credentialReference?: string;
  localClientCredentialReference?: string;
  deviceCredentialId?: string;
  principalUserId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  failureReason?: string;
  failureMessage?: string;
  credential?: UpstreamCredentialStatus;
}

interface UpstreamEnrollmentStore {
  schemaVersion: 1;
  updatedAt: string;
  enrollments: UpstreamEnrollmentRecord[];
}

export interface UpstreamEnrollmentSummary {
  backendId: string;
  requestId: string;
  state: UpstreamEnrollmentState;
  activationUrl: string | null;
  requestedOperationFamilies: string[];
  challengeId?: string;
  deviceCredentialId?: string;
  principalUserId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  failureReason?: string;
  failureMessage?: string;
  credential: UpstreamCredentialStatus;
}

export interface UpstreamEnrollmentResult {
  ok: boolean;
  state: UpstreamEnrollmentState | "missing";
  backend?: UpstreamBackendSummary;
  enrollment?: UpstreamEnrollmentSummary;
  message: string;
}

export interface UpstreamEnrollmentDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  fetch?: typeof fetch;
  now?: () => Date;
  randomId?: () => string;
  randomBytes?: typeof randomBytes;
  beforeEnrollmentEffect?: (boundary: string) => void;
  sourceOwnerPrincipalId?: string;
}

const depsWithDefaults = (
  deps: UpstreamEnrollmentDeps = {}
): Required<UpstreamEnrollmentDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
  now: deps.now ?? (() => new Date()),
  randomId: deps.randomId ?? randomUUID,
  randomBytes: deps.randomBytes ?? randomBytes,
  beforeEnrollmentEffect: deps.beforeEnrollmentEffect ?? (() => undefined),
  sourceOwnerPrincipalId: deps.sourceOwnerPrincipalId ?? ""
});

const defaultStore = (now: string): UpstreamEnrollmentStore => ({
  schemaVersion: 1,
  updatedAt: now,
  enrollments: []
});

const validateBackendId = (id: string): string => {
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(trimmed)) {
    throw new Error(
      "Upstream backend id must be 2-64 characters of letters, numbers, hyphen, or underscore."
    );
  }
  return trimmed;
};

const readStore = (
  paths: KoedServerPaths,
  deps: Required<UpstreamEnrollmentDeps>
): UpstreamEnrollmentStore => {
  const now = deps.now().toISOString();
  if (!deps.existsSync(paths.upstreamEnrollmentsPath)) {
    return defaultStore(now);
  }
  try {
    const parsed = JSON.parse(
      deps.readFileSync(paths.upstreamEnrollmentsPath, "utf8") as string
    ) as Partial<UpstreamEnrollmentStore>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
      enrollments: Array.isArray(parsed.enrollments)
        ? parsed.enrollments.map((record) => normalizeRecord(record, now))
        : []
    };
  } catch {
    throw new Error("Upstream enrollment state is malformed.");
  }
};

const normalizeRecord = (
  record: Partial<UpstreamEnrollmentRecord> & {
    rotationCredentialId?: string;
    rotationCredentialReference?: string;
  },
  now: string
): UpstreamEnrollmentRecord => {
  const requestId =
    typeof record.requestId === "string" && record.requestId.trim()
      ? record.requestId.trim().slice(0, 120)
      : "unknown";
  const state = normalizeEnrollmentState(record.state);
  const transactionKind =
    record.transaction?.kind === "replacement" ||
    (typeof record.rotationCredentialId === "string" &&
      uuidPattern.test(record.rotationCredentialId) &&
      typeof record.rotationCredentialReference === "string" &&
      record.rotationCredentialReference.trim())
      ? "replacement"
      : "initial";
  const candidateTransaction = record.transactionState;
  const phase =
    candidateTransaction?.phase === "prepared" ||
    candidateTransaction?.phase === "awaiting_remote" ||
    candidateTransaction?.phase === "awaiting_exchange" ||
    candidateTransaction?.phase === "committing" ||
    candidateTransaction?.phase === "committed" ||
    candidateTransaction?.phase === "aborting" ||
    candidateTransaction?.phase === "aborted" ||
    candidateTransaction?.phase === "recovery_required"
      ? candidateTransaction.phase
      : state === "exchanged"
        ? "committed"
        : state === "denied" ||
            state === "expired" ||
            state === "canceled" ||
            state === "revoked" ||
            state === "failed"
          ? "aborted"
          : state === "approved"
            ? "awaiting_exchange"
            : "awaiting_remote";
  const pendingEffect =
    candidateTransaction?.pendingEffect === "stage_pending_custody" ||
    candidateTransaction?.pendingEffect === "compensate_pending_custody" ||
    candidateTransaction?.pendingEffect === "record_challenge" ||
    candidateTransaction?.pendingEffect === "commit_successor" ||
    candidateTransaction?.pendingEffect === "abort_pending" ||
    candidateTransaction?.pendingEffect === "revoke_active"
      ? candidateTransaction.pendingEffect
      : null;
  const transactionTargetState =
    candidateTransaction?.state === "pending" ||
    candidateTransaction?.state === "approved" ||
    candidateTransaction?.state === "exchanged" ||
    candidateTransaction?.state === "denied" ||
    candidateTransaction?.state === "expired" ||
    candidateTransaction?.state === "canceled" ||
    candidateTransaction?.state === "revoked" ||
    candidateTransaction?.state === "failed"
      ? candidateTransaction.state
      : state;
  const transactionState: UpstreamEnrollmentTransactionSnapshot = {
    id:
      typeof candidateTransaction?.id === "string" &&
      candidateTransaction.id.trim()
        ? candidateTransaction.id.trim().slice(0, 120)
        : requestId,
    generation:
      Number.isSafeInteger(candidateTransaction?.generation) &&
      candidateTransaction!.generation > 0
        ? candidateTransaction!.generation
        : 1,
    kind: transactionKind,
    phase,
    state: transactionTargetState,
    pendingEffect
  };
  return {
    backendId:
      typeof record.backendId === "string"
        ? validateBackendId(record.backendId)
        : "missing",
    requestId,
    state,
    activationUrl:
      typeof record.activationUrl === "string"
        ? sanitizeActivationUrl(record.activationUrl)
        : null,
    requestedOperationFamilies: Array.isArray(record.requestedOperationFamilies)
      ? record.requestedOperationFamilies.filter(isOperationFamily)
      : [],
    transaction:
      record.transaction?.kind === "replacement" &&
      uuidPattern.test(record.transaction.predecessorCredentialId) &&
      record.transaction.predecessorCredentialReference.trim()
        ? {
            kind: "replacement",
            predecessorCredentialId:
              record.transaction.predecessorCredentialId.toLowerCase(),
            predecessorCredentialReference:
              record.transaction.predecessorCredentialReference
                .trim()
                .slice(0, 180)
          }
        : typeof record.rotationCredentialId === "string" &&
            uuidPattern.test(record.rotationCredentialId) &&
            typeof record.rotationCredentialReference === "string" &&
            record.rotationCredentialReference.trim()
          ? {
              kind: "replacement",
              predecessorCredentialId:
                record.rotationCredentialId.toLowerCase(),
              predecessorCredentialReference: record.rotationCredentialReference
                .trim()
                .slice(0, 180)
            }
          : { kind: "initial" },
    transactionState,
    ...(typeof record.activeCredentialReference === "string" &&
    record.activeCredentialReference.trim()
      ? {
          activeCredentialReference: record.activeCredentialReference
            .trim()
            .slice(0, 180)
        }
      : {}),
    ...(typeof record.pendingCredentialReference === "string" &&
    record.pendingCredentialReference.trim()
      ? {
          pendingCredentialReference: record.pendingCredentialReference
            .trim()
            .slice(0, 180)
        }
      : {}),
    ...(typeof record.challengeHash === "string" &&
    /^[0-9a-f]{64}$/.test(record.challengeHash)
      ? { challengeHash: record.challengeHash }
      : {}),
    ...(typeof record.challengeId === "string" && record.challengeId.trim()
      ? { challengeId: record.challengeId.trim().slice(0, 120) }
      : {}),
    ...(typeof record.credentialKeyId === "string" &&
    record.credentialKeyId.trim()
      ? { credentialKeyId: record.credentialKeyId.trim().slice(0, 160) }
      : {}),
    ...(typeof record.credentialReference === "string" &&
    record.credentialReference.trim()
      ? { credentialReference: record.credentialReference.trim().slice(0, 180) }
      : {}),
    ...(typeof record.localClientCredentialReference === "string" &&
    record.localClientCredentialReference.trim()
      ? {
          localClientCredentialReference: record.localClientCredentialReference
            .trim()
            .slice(0, 200)
        }
      : {}),
    ...(typeof record.deviceCredentialId === "string" &&
    uuidPattern.test(record.deviceCredentialId)
      ? { deviceCredentialId: record.deviceCredentialId.toLowerCase() }
      : {}),
    ...(typeof record.principalUserId === "string" &&
    uuidPattern.test(record.principalUserId)
      ? { principalUserId: record.principalUserId.toLowerCase() }
      : {}),
    createdAt: typeof record.createdAt === "string" ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : now,
    expiresAt: typeof record.expiresAt === "string" ? record.expiresAt : null,
    ...(typeof record.failureReason === "string"
      ? { failureReason: record.failureReason.slice(0, 80) }
      : {}),
    ...(typeof record.failureMessage === "string"
      ? { failureMessage: record.failureMessage.slice(0, 240) }
      : {}),
    credential: sanitizeCredential(record.credential)
  };
};

const replacementTransaction = (record: UpstreamEnrollmentRecord) =>
  record.transaction.kind === "replacement" ? record.transaction : null;

const normalizeEnrollmentState = (value: unknown): UpstreamEnrollmentState => {
  if (
    value === "approved" ||
    value === "exchanged" ||
    value === "denied" ||
    value === "expired" ||
    value === "canceled" ||
    value === "revoked" ||
    value === "failed"
  ) {
    return value;
  }
  return "pending";
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const sanitizeActivationUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    assertSecureHttpTransport(parsed, "Activation URL");
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretKey(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const sanitizeCredential = (
  credential: Partial<UpstreamCredentialStatus> | undefined
): UpstreamCredentialStatus => {
  if (
    credential?.status === "configured" ||
    credential?.status === "revoked" ||
    credential?.status === "unknown"
  ) {
    return {
      status: credential.status,
      ...(typeof credential.reference === "string" &&
      credential.reference.trim() &&
      !isSecretKey(credential.reference)
        ? { reference: credential.reference.trim().slice(0, 240) }
        : {})
    };
  }
  return { status: "not_configured" };
};

const isSecretKey = (value: string): boolean =>
  /(?:token|secret|password|bearer|cookie|authorization|verifier|challenge)/i.test(
    value
  );

const isOperationFamily = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-z0-9_.:-]{1,80}$/i.test(value) &&
  !isSecretKey(value);

const writeStore = (
  paths: KoedServerPaths,
  store: UpstreamEnrollmentStore,
  deps: Required<UpstreamEnrollmentDeps>
): void => {
  mkdirSync(dirname(paths.upstreamEnrollmentsPath), {
    recursive: true,
    mode: 0o700
  });
  const tempPath = `${paths.upstreamEnrollmentsPath}.tmp`;
  deps.writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(tempPath, paths.upstreamEnrollmentsPath);
};

const summarizeEnrollment = (
  record: UpstreamEnrollmentRecord,
  backend?: UpstreamBackendSummary
): UpstreamEnrollmentSummary => {
  const credential =
    record.state === "revoked"
      ? (record.credential ?? { status: "revoked" })
      : backend?.credential.status === "configured" ||
          backend?.credential.status === "revoked"
        ? backend.credential
        : (record.credential ?? backend?.credential ?? { status: "unknown" });
  return {
    backendId: record.backendId,
    requestId: record.requestId,
    state: record.state,
    activationUrl: record.activationUrl,
    requestedOperationFamilies: record.requestedOperationFamilies,
    ...(record.challengeId ? { challengeId: record.challengeId } : {}),
    ...(record.deviceCredentialId
      ? { deviceCredentialId: record.deviceCredentialId }
      : {}),
    ...(record.principalUserId
      ? { principalUserId: record.principalUserId }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(record.failureReason ? { failureReason: record.failureReason } : {}),
    ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
    credential
  };
};

const routePolicyOperationFamilies = (
  routePolicy: UpstreamRoutePolicy,
  options: { collaboration: boolean } = { collaboration: false }
): string[] => {
  const entries: Array<[keyof UpstreamRoutePolicy, string]> = [
    ["personalMemoryRead", "personal_memory_read"],
    ...(options.collaboration
      ? ([
          ["personalCollaboration", "personal_collaboration_read"],
          ["personalCollaboration", "personal_collaboration_write"]
        ] as Array<[keyof UpstreamRoutePolicy, string]>)
      : []),
    ["teamWorkspaceRead", "team_workspace_read"],
    ...(options.collaboration
      ? ([
          ["teamWorkspaceRead", "team_chat_read"],
          ["teamWorkspaceRead", "team_chat_write"]
        ] as Array<[keyof UpstreamRoutePolicy, string]>)
      : []),
    ["shareGrantManagement", "share_grant_management"],
    ["captureWrites", "capture_writes"],
    ["sync", "sync"],
    ["managedExecution", "managed_execution"],
    ["admin", "action_grant"]
  ];
  return entries
    .filter(([key]) => routePolicy[key] === "enabled")
    .map(([, family]) => family);
};

const browserEnrollmentOperationFamilies = (
  routePolicy: UpstreamRoutePolicy,
  options: { collaboration: boolean }
): string[] => routePolicyOperationFamilies(routePolicy, options);

const localClientOperationFamiliesFor = (operationFamilies: string[]) =>
  operationFamilies.filter(
    (family) =>
      family === "personal_collaboration_read" ||
      family === "personal_collaboration_write" ||
      family === "team_workspace_read" ||
      family === "team_chat_read" ||
      family === "team_chat_write" ||
      family === "share_grant_management" ||
      family === "managed_execution"
  );

const expiresAtFor = (now: Date): string =>
  new Date(now.getTime() + 10 * 60 * 1000).toISOString();

const randomSecret = (
  deps: Required<UpstreamEnrollmentDeps>,
  bytes = 32
): string => deps.randomBytes(bytes).toString("base64url");

const challengeHashFor = (
  backendId: string,
  requestId: string,
  secret: string
): string =>
  createHash("sha256")
    .update(`${backendId}:${requestId}:${secret}`)
    .digest("hex");

const approvalUrlFor = (
  backend: UpstreamBackendSummary,
  challengeId: string
): string =>
  new URL(
    `device-enrollment/${encodeURIComponent(challengeId)}`,
    `${backend.baseUrl}/`
  ).toString();

const jsonFetch = async (
  deps: Required<UpstreamEnrollmentDeps>,
  url: URL,
  init: RequestInit
): Promise<{
  status: number;
  ok: boolean;
  payload: Record<string, unknown>;
}> => {
  const response = await deps.fetch(url, {
    ...init,
    redirect: "error",
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers
    }
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { status: response.status, ok: response.ok, payload };
};

const createUpstreamChallenge = async (
  backend: UpstreamBackendSummary,
  input: {
    backendId: string;
    deviceInstanceId: string;
    protocolDeploymentId: string;
    sourceOwnerPrincipalId: string;
    challengeHash: string;
    credentialKeyId: string;
    verifierSecret: string;
    operationFamilies: string[];
    requestId: string;
    expiresAt: string | null;
    rotation?: {
      credentialId: string;
      credentialReference: string;
      authorization: string;
    };
  },
  deps: Required<UpstreamEnrollmentDeps>
): Promise<{ challengeId: string; activationUrl: string }> => {
  const result = await jsonFetch(
    deps,
    new URL(
      "v1/local-edge/device-enrollments/challenges",
      `${backend.baseUrl}/`
    ),
    {
      method: "POST",
      headers: input.rotation
        ? { authorization: input.rotation.authorization }
        : undefined,
      body: JSON.stringify({
        challenge_hash: input.challengeHash,
        upstream_backend_id: input.backendId,
        device_instance_id: input.deviceInstanceId,
        protocol_deployment_id: input.protocolDeploymentId,
        ...(input.sourceOwnerPrincipalId
          ? { source_owner_principal_id: input.sourceOwnerPrincipalId }
          : {}),
        ...(input.rotation
          ? { rotate_credential_id: input.rotation.credentialId }
          : {}),
        device_label: "Koed local edge",
        requested_operation_families: input.operationFamilies,
        pending_credential: {
          credential_key_id: input.credentialKeyId,
          verifier_kind: "secret_hash",
          verifier_secret: input.verifierSecret,
          operation_families: input.operationFamilies
        },
        metadata: {
          source: "koed-server-upstream-enroll",
          requestId: input.requestId
        },
        ttl_seconds: 600
      })
    }
  );
  if (!result.ok) {
    throw new Error(
      typeof result.payload.error === "string"
        ? result.payload.error
        : `Upstream challenge creation failed with HTTP ${result.status}.`
    );
  }
  const challenge = result.payload.challenge;
  const rawChallengeId =
    challenge && typeof challenge === "object" && "id" in challenge
      ? (challenge as { id?: unknown }).id
      : "";
  const challengeId = typeof rawChallengeId === "string" ? rawChallengeId : "";
  if (!challengeId) {
    throw new Error(
      "Upstream challenge response did not include a challenge id."
    );
  }
  const rawActivationUrl = result.payload.activationUrl;
  const activationUrl =
    typeof rawActivationUrl === "string"
      ? sanitizeActivationUrl(rawActivationUrl)
      : null;
  return {
    challengeId,
    activationUrl: activationUrl ?? approvalUrlFor(backend, challengeId)
  };
};

const readUpstreamChallengeStatus = async (
  backend: UpstreamBackendSummary,
  challengeId: string,
  deviceInstanceId: string,
  deps: Required<UpstreamEnrollmentDeps>
): Promise<"pending" | "approved" | "denied" | "expired" | "unknown"> => {
  const result = await jsonFetch(
    deps,
    new URL(
      `v1/local-edge/device-enrollments/challenges/${encodeURIComponent(
        challengeId
      )}`,
      `${backend.baseUrl}/`
    ),
    {
      method: "GET",
      headers: { "x-koed-device-instance-id": deviceInstanceId }
    }
  );
  if (!result.ok) {
    return "unknown";
  }
  const challenge = result.payload.challenge;
  const rawStatus =
    challenge && typeof challenge === "object" && "status" in challenge
      ? (challenge as { status?: unknown }).status
      : "";
  const status = typeof rawStatus === "string" ? rawStatus : "";
  return status === "pending" ||
    status === "approved" ||
    status === "denied" ||
    status === "expired"
    ? status
    : "unknown";
};

type RemoteCredentialStatus =
  | {
      state: "active";
      deviceCredentialId: string;
      principalUserId: string;
    }
  | { state: "rejected" | "unknown" };

type RemoteCredentialRevocationStatus =
  | "revoked"
  | "already_inactive"
  | "unavailable";

const remoteCredentialStatus = async (
  paths: KoedServerPaths,
  backend: UpstreamBackendSummary,
  reference: string | undefined,
  deps: Required<UpstreamEnrollmentDeps>
): Promise<RemoteCredentialStatus> => {
  const authorization = readUpstreamCredentialAuthorization(
    paths.koedHome,
    reference
  );
  if (!authorization) {
    return { state: "unknown" };
  }
  try {
    const result = await jsonFetch(
      deps,
      new URL("v1/local-edge/device-credentials/status", `${backend.baseUrl}/`),
      {
        method: "GET",
        headers: { authorization }
      }
    );
    if (result.status === 401 || result.status === 403) {
      return { state: "rejected" };
    }
    const credential = result.payload.credential;
    const user = result.payload.user;
    const deviceCredentialId =
      credential && typeof credential === "object" && "id" in credential
        ? (credential as { id?: unknown }).id
        : null;
    const principalUserId =
      user && typeof user === "object" && "id" in user
        ? (user as { id?: unknown }).id
        : null;
    return result.ok &&
      result.payload.ok === true &&
      typeof deviceCredentialId === "string" &&
      uuidPattern.test(deviceCredentialId) &&
      typeof principalUserId === "string" &&
      uuidPattern.test(principalUserId)
      ? {
          state: "active",
          deviceCredentialId: deviceCredentialId.toLowerCase(),
          principalUserId: principalUserId.toLowerCase()
        }
      : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
};

type RotationCredentialDiscovery =
  | {
      state: "active";
      credentialId: string;
      principalUserId: string;
      credentialReference: string;
      authorization: string;
    }
  | { state: "none" }
  | { state: "unavailable" };

const discoverRotationCredential = async (
  paths: KoedServerPaths,
  backend: UpstreamBackendSummary,
  store: UpstreamEnrollmentStore,
  deps: Required<UpstreamEnrollmentDeps>
): Promise<RotationCredentialDiscovery> => {
  const candidates = [...store.enrollments]
    .reverse()
    .filter(
      (record) =>
        record.backendId === backend.id &&
        typeof record.credentialReference === "string"
    );
  for (const candidate of candidates) {
    const credentialReference = candidate.credentialReference!;
    const authorization = readUpstreamCredentialAuthorization(
      paths.koedHome,
      credentialReference
    );
    if (!authorization) continue;
    const status = await remoteCredentialStatus(
      paths,
      backend,
      credentialReference,
      deps
    );
    if (status.state === "active") {
      return {
        state: "active",
        credentialId: status.deviceCredentialId,
        principalUserId: status.principalUserId,
        credentialReference,
        authorization
      };
    }
    if (status.state === "unknown") return { state: "unavailable" };
  }
  return { state: "none" };
};

const revokeRemoteCredential = async (
  paths: KoedServerPaths,
  backend: UpstreamBackendSummary,
  reference: string | undefined,
  deps: Required<UpstreamEnrollmentDeps>
): Promise<RemoteCredentialRevocationStatus> => {
  const authorization = readUpstreamCredentialAuthorization(
    paths.koedHome,
    reference
  );
  if (!authorization) return "unavailable";
  try {
    const result = await jsonFetch(
      deps,
      new URL(
        "v1/local-edge/device-credentials/current",
        `${backend.baseUrl}/`
      ),
      {
        method: "DELETE",
        headers: { authorization }
      }
    );
    if (result.ok && result.payload.revoked === true) return "revoked";
    if (result.status === 401) return "already_inactive";
    return "unavailable";
  } catch {
    return "unavailable";
  }
};

const latestEnrollment = (
  store: UpstreamEnrollmentStore,
  backendId: string
): UpstreamEnrollmentRecord | undefined =>
  [...store.enrollments]
    .reverse()
    .find((enrollment) => enrollment.backendId === backendId);

export const readUpstreamEnrollmentBinding = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): {
  backendId: string;
  enrollmentId: string;
  deviceCredentialId: string;
  principalUserId: string;
} | null =>
  readLocalEdgeUpstreamEnrollmentBinding(
    paths.upstreamEnrollmentsPath,
    validateBackendId(id),
    {
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync
    }
  );

const backendById = (
  paths: KoedServerPaths,
  backendId: string,
  deps: Required<UpstreamEnrollmentDeps>
): { backend?: UpstreamBackendSummary; parseError?: string } => {
  const registry = collectUpstreamRegistryStatus(paths, {
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    now: deps.now
  });
  return {
    backend: registry.backends.find((backend) => backend.id === backendId),
    parseError: registry.parseError
  };
};

const enrollmentCanReceiveRemoteStatus = (
  record: UpstreamEnrollmentRecord
): boolean =>
  record.state === "pending" ||
  record.state === "approved" ||
  record.state === "exchanged";

const sameEnrollmentIdentity = (
  current: UpstreamEnrollmentRecord | undefined,
  expected: UpstreamEnrollmentRecord
): current is UpstreamEnrollmentRecord =>
  current?.requestId === expected.requestId &&
  current.credentialReference === expected.credentialReference &&
  upstreamEnrollmentObservationApplies(current.transactionState, {
    transactionId: expected.transactionState.id,
    generation: expected.transactionState.generation
  });

const enrollmentResultFromSnapshot = (
  backendId: string,
  record: UpstreamEnrollmentRecord | undefined,
  backend: UpstreamBackendSummary | undefined
): UpstreamEnrollmentResult =>
  record
    ? {
        ok: true,
        state: record.state,
        backend,
        enrollment: summarizeEnrollment(record, backend),
        message: `Upstream enrollment for ${backendId} is ${record.state}.`
      }
    : {
        ok: true,
        state: "missing",
        backend,
        message: `No upstream enrollment has been started for ${backendId}.`
      };

const materializeState = (
  record: UpstreamEnrollmentRecord,
  now: Date,
  backend?: UpstreamBackendSummary
): UpstreamEnrollmentRecord => {
  const replacement = replacementTransaction(record);
  if (
    backend?.credential.status === "configured" &&
    (!replacement ||
      backend.credential.reference === record.credentialReference)
  ) {
    return {
      ...record,
      state: "exchanged",
      credential: backend.credential
    };
  }
  if (backend?.credential.status === "revoked") {
    return {
      ...record,
      state: "revoked",
      credential: backend.credential
    };
  }
  if (
    record.state === "exchanged" &&
    backend?.credential.status === "not_configured"
  ) {
    return {
      ...record,
      state: "failed",
      updatedAt: now.toISOString(),
      failureReason: "credential_reset",
      failureMessage:
        "Upstream backend credential is no longer configured; restart enrollment.",
      credential: backend.credential
    };
  }
  if (
    record.state === "denied" ||
    record.state === "canceled" ||
    record.state === "expired" ||
    record.state === "failed"
  ) {
    return record;
  }
  if (
    (record.state === "pending" || record.state === "approved") &&
    record.expiresAt &&
    Date.parse(record.expiresAt) <= now.getTime()
  ) {
    return {
      ...record,
      state: "expired",
      updatedAt: now.toISOString()
    };
  }
  return record;
};

const withSecureFetchForBackend = async <T>(
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps,
  operation: (resolvedDeps: UpstreamEnrollmentDeps) => Promise<T>
): Promise<T> => {
  if (deps.fetch) return operation(deps);
  const backend = backendById(
    paths,
    validateBackendId(id),
    depsWithDefaults(deps)
  ).backend;
  if (!backend) return operation(deps);
  const secureFetch = createSecureUpstreamFetch({
    allowPrivateNetworkForUrl: registeredPrivateNetworkPolicy(() => [
      { baseUrl: backend.baseUrl, profile: backend.profile }
    ])
  });
  try {
    return await operation({ ...deps, fetch: secureFetch });
  } finally {
    await secureFetch.close();
  }
};

const startUpstreamEnrollmentWithFetch = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  const identity = await ensureDeviceIdentity(paths);
  if (!identity.remoteOperationsAllowed) {
    return {
      ok: false,
      state: "failed",
      message: `Local device identity is ${identity.health}; upstream enrollment is blocked until explicit identity rotation.`
    };
  }
  const now = resolvedDeps.now();
  const nowIso = now.toISOString();
  const { backend, parseError } = backendById(paths, backendId, resolvedDeps);
  if (parseError) {
    return {
      ok: false,
      state: "failed",
      message: "Upstream backend registry is malformed."
    };
  }
  if (!backend) {
    return {
      ok: false,
      state: "missing",
      message: `Upstream backend ${backendId} is not registered.`
    };
  }
  if (upstreamDisconnectCleanupPending(paths, backendId)) {
    return {
      ok: false,
      state: "failed",
      backend,
      message: `Upstream backend ${backendId} cannot enroll until disconnect cleanup completes.`
    };
  }
  if (backend.capabilities.state !== "validated") {
    return {
      ok: false,
      state: "failed",
      backend,
      message: `Upstream backend ${backendId} capabilities are not validated. Run koed-server upstream refresh --id ${backendId} --json.`
    };
  }
  const configuredOperationFamilies = routePolicyOperationFamilies(
    backend.routePolicy
  );
  const collaboration = upstreamBackendAdvertisesCapability(
    paths,
    backendId,
    "memory.collaboration",
    {
      existsSync: resolvedDeps.existsSync,
      readFileSync: resolvedDeps.readFileSync,
      now: resolvedDeps.now
    }
  );
  const operationFamilies = browserEnrollmentOperationFamilies(
    backend.routePolicy,
    { collaboration }
  );
  if (configuredOperationFamilies.length === 0) {
    return {
      ok: false,
      state: "failed",
      backend,
      message: `Upstream backend ${backendId} has no enabled route-policy families.`
    };
  }
  if (operationFamilies.length === 0) {
    return {
      ok: false,
      state: "failed",
      backend,
      message: `Upstream backend ${backendId} has no browser-enrollable route-policy families.`
    };
  }
  if (
    operationFamilies.includes("share_grant_management") &&
    !uuidPattern.test(resolvedDeps.sourceOwnerPrincipalId)
  ) {
    return {
      ok: false,
      state: "failed",
      backend,
      message:
        "Share Grant enrollment requires the authenticated local owner principal."
    };
  }

  let store = readStore(paths, resolvedDeps);
  let expectedRecord = latestEnrollment(store, backendId);
  if (expectedRecord) {
    const current = await getUpstreamEnrollmentStatus(
      paths,
      backendId,
      resolvedDeps
    );
    if (
      current.state === "pending" ||
      current.state === "approved" ||
      (current.state === "exchanged" &&
        JSON.stringify(current.enrollment?.requestedOperationFamilies ?? []) ===
          JSON.stringify(operationFamilies))
    ) {
      return current;
    }
    store = readStore(paths, resolvedDeps);
    expectedRecord = latestEnrollment(store, backendId);
  }

  const rotation = await discoverRotationCredential(
    paths,
    backend,
    store,
    resolvedDeps
  );
  if (rotation.state === "unavailable") {
    return {
      ok: false,
      state: "failed",
      backend,
      message:
        "Could not verify the existing upstream device credential required for authenticated rotation. Retry when the Team Backend is available."
    };
  }

  const requestId = resolvedDeps.randomId();
  const deviceInstanceId = identity.deviceInstanceId!;
  const verifierSecret = randomSecret(resolvedDeps);
  const challengeSecret = randomSecret(resolvedDeps);
  const challengeHash = challengeHashFor(backendId, requestId, challengeSecret);
  const credentialKeyId = `koed_${createHash("sha256")
    .update(`${backendId}:${requestId}:${verifierSecret}`)
    .digest("hex")
    .slice(0, 40)}`;
  const expiresAt = expiresAtFor(now);
  const localClientOperationFamilies =
    localClientOperationFamiliesFor(operationFamilies);
  const localClientSecret = randomSecret(resolvedDeps);

  const staged = await withUpstreamEnrollmentLock(paths, backendId, () => {
    store = readStore(paths, resolvedDeps);
    const currentRecord = latestEnrollment(store, backendId);
    const currentBackend = backendById(paths, backendId, resolvedDeps).backend;
    const expectedStillCurrent = expectedRecord
      ? sameEnrollmentIdentity(currentRecord, expectedRecord) &&
        currentRecord.state === expectedRecord.state
      : currentRecord === undefined;
    const currentCollaboration = upstreamBackendAdvertisesCapability(
      paths,
      backendId,
      "memory.collaboration",
      {
        existsSync: resolvedDeps.existsSync,
        readFileSync: resolvedDeps.readFileSync,
        now: resolvedDeps.now
      }
    );
    const currentOperationFamilies = currentBackend
      ? browserEnrollmentOperationFamilies(currentBackend.routePolicy, {
          collaboration: currentCollaboration
        })
      : [];
    if (
      !expectedStillCurrent ||
      !currentBackend ||
      currentBackend.capabilities.state !== "validated" ||
      JSON.stringify(currentOperationFamilies) !==
        JSON.stringify(operationFamilies)
    ) {
      return {
        kind: "result" as const,
        result: currentRecord
          ? enrollmentResultFromSnapshot(
              backendId,
              currentRecord,
              currentBackend
            )
          : {
              ok: false,
              state: "failed" as const,
              backend: currentBackend,
              message: `Upstream backend ${backendId} changed while enrollment was starting; retry with its current configuration.`
            }
      };
    }

    const reference = upstreamCredentialReferenceFor({
      backendId,
      credentialKeyId
    });
    const transactionGeneration =
      Math.max(
        0,
        ...store.enrollments
          .filter((entry) => entry.backendId === backendId)
          .map((entry) => entry.transactionState.generation)
      ) + 1;
    const preparedTransaction = createUpstreamEnrollmentTransaction({
      id: requestId,
      generation: transactionGeneration,
      kind: rotation.state === "active" ? "replacement" : "initial"
    });
    const stageDecision = decideUpstreamEnrollmentTransaction(
      preparedTransaction,
      { type: "prepare" }
    );
    const record: UpstreamEnrollmentRecord = {
      backendId,
      requestId,
      state: "pending",
      activationUrl: null,
      requestedOperationFamilies: operationFamilies,
      transaction:
        rotation.state === "active"
          ? {
              kind: "replacement",
              predecessorCredentialId: rotation.credentialId,
              predecessorCredentialReference: rotation.credentialReference
            }
          : { kind: "initial" },
      transactionState: stageDecision.next,
      ...(rotation.state === "active"
        ? { activeCredentialReference: rotation.credentialReference }
        : {}),
      pendingCredentialReference: reference,
      challengeHash,
      credentialKeyId,
      credentialReference: reference,
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
      credential: { status: "unknown", reference }
    };
    if (rotation.state === "active") {
      store.enrollments = store.enrollments.map((entry) =>
        entry.backendId === backendId &&
        entry.credentialReference === rotation.credentialReference
          ? {
              ...entry,
              state: "exchanged",
              updatedAt: nowIso,
              deviceCredentialId: rotation.credentialId,
              principalUserId: rotation.principalUserId,
              credential: {
                status: "configured",
                reference: rotation.credentialReference
              }
            }
          : entry
      );
    }
    store.enrollments.push(record);
    store.updatedAt = nowIso;
    writeStore(paths, store, resolvedDeps);
    try {
      let stagedRecord = record;
      executeUpstreamEnrollmentTransactionEffect(stageDecision, {
        stage_pending_custody: () => {
          resolvedDeps.beforeEnrollmentEffect("stage_upstream_credential");
          if (
            rotation.state !== "active" &&
            localClientOperationFamilies.length > 0
          ) {
            resolvedDeps.beforeEnrollmentEffect(
              "stage_local_client_credential"
            );
            const custody = storeEnrollmentCredentialCustody(paths.koedHome, {
              upstream: { backendId, credentialKeyId, secret: verifierSecret },
              localEdgeClient: {
                backendId,
                secret: localClientSecret,
                operationFamilies: localClientOperationFamilies
              }
            });
            if (custody.upstreamReference !== reference) {
              throw new Error("Staged upstream credential reference changed.");
            }
            stagedRecord = {
              ...stagedRecord,
              localClientCredentialReference: custody.localEdgeClientReference
            };
          } else {
            const stored = storeUpstreamCredentialSecret(paths.koedHome, {
              backendId,
              credentialKeyId,
              secret: verifierSecret
            });
            if (stored.reference !== reference) {
              throw new Error("Staged upstream credential reference changed.");
            }
          }
          resolvedDeps.beforeEnrollmentEffect("stage_registry_credential");
          updateUpstreamBackendCredential(
            paths,
            backendId,
            rotation.state === "active"
              ? {
                  status: "configured",
                  reference: rotation.credentialReference
                }
              : { status: "unknown", reference },
            {
              existsSync: resolvedDeps.existsSync,
              readFileSync: resolvedDeps.readFileSync,
              writeFileSync: resolvedDeps.writeFileSync,
              renameSync: resolvedDeps.renameSync,
              now: resolvedDeps.now
            }
          );
        }
      });
      stagedRecord = {
        ...stagedRecord,
        transactionState: decideUpstreamEnrollmentTransaction(
          stageDecision.next,
          { type: "effect_succeeded" }
        ).next,
        updatedAt: resolvedDeps.now().toISOString()
      };
      store.enrollments = store.enrollments.map((entry) =>
        entry.backendId === record.backendId &&
        entry.requestId === record.requestId
          ? stagedRecord
          : entry
      );
      store.updatedAt = stagedRecord.updatedAt;
      resolvedDeps.beforeEnrollmentEffect("commit_prepared_state");
      writeStore(paths, store, resolvedDeps);
      return { kind: "record" as const, record: stagedRecord };
    } catch (error) {
      const recoveryRequired: UpstreamEnrollmentRecord = {
        ...record,
        transactionState: decideUpstreamEnrollmentTransaction(
          stageDecision.next,
          { type: "effect_failed" }
        ).next,
        updatedAt: resolvedDeps.now().toISOString(),
        failureReason: "prepared_effect_interrupted",
        failureMessage:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "Enrollment preparation was interrupted."
      };
      store.enrollments = store.enrollments.map((entry) =>
        entry.backendId === record.backendId &&
        entry.requestId === record.requestId
          ? recoveryRequired
          : entry
      );
      store.updatedAt = recoveryRequired.updatedAt;
      writeStore(paths, store, resolvedDeps);
      return {
        kind: "result" as const,
        result: {
          ok: false,
          state: "failed" as const,
          backend: backendById(paths, backendId, resolvedDeps).backend,
          enrollment: summarizeEnrollment(
            recoveryRequired,
            backendById(paths, backendId, resolvedDeps).backend
          ),
          message:
            "Upstream enrollment preparation was interrupted and requires recovery."
        }
      };
    }
  });
  if (staged.kind === "result") return staged.result;
  expectedRecord = staged.record;

  let challenge: { challengeId: string; activationUrl: string };
  try {
    challenge = await createUpstreamChallenge(
      backend,
      {
        backendId,
        deviceInstanceId,
        protocolDeploymentId: identity.deploymentId!,
        sourceOwnerPrincipalId: resolvedDeps.sourceOwnerPrincipalId,
        challengeHash,
        credentialKeyId,
        verifierSecret,
        operationFamilies,
        requestId,
        expiresAt,
        ...(rotation.state === "active" ? { rotation } : {})
      },
      resolvedDeps
    );
  } catch (error) {
    await withUpstreamEnrollmentLock(paths, backendId, () => {
      const failedStore = readStore(paths, resolvedDeps);
      let current = latestEnrollment(failedStore, backendId);
      if (!sameEnrollmentIdentity(current, staged.record)) return;
      const abortDecision = decideUpstreamEnrollmentTransaction(
        current.transactionState,
        { type: "cancel" }
      );
      const aborting = abortDecision.next;
      current = {
        ...current,
        transactionState: aborting,
        updatedAt: resolvedDeps.now().toISOString(),
        failureReason: "challenge_creation_failed",
        failureMessage:
          error instanceof Error
            ? error.message.slice(0, 240)
            : "Failed to create upstream enrollment challenge."
      };
      failedStore.enrollments = failedStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? current
          : entry
      );
      failedStore.updatedAt = current.updatedAt;
      writeStore(paths, failedStore, resolvedDeps);
      let aborted: ReturnType<typeof abortPendingEnrollmentCredential>;
      try {
        aborted = executeUpstreamEnrollmentTransactionEffect(abortDecision, {
          abort_pending: () =>
            abortPendingEnrollmentCredential(
              paths,
              backendId,
              current,
              resolvedDeps
            )
        })!;
      } catch (abortError) {
        const recoveryRequired: UpstreamEnrollmentRecord = {
          ...current,
          transactionState: decideUpstreamEnrollmentTransaction(aborting, {
            type: "effect_failed"
          }).next,
          updatedAt: resolvedDeps.now().toISOString(),
          failureReason: "challenge_abort_interrupted",
          failureMessage:
            abortError instanceof Error
              ? abortError.message.slice(0, 240)
              : "Challenge cleanup was interrupted."
        };
        failedStore.enrollments = failedStore.enrollments.map((entry) =>
          entry.backendId === current.backendId &&
          entry.requestId === current.requestId
            ? recoveryRequired
            : entry
        );
        failedStore.updatedAt = recoveryRequired.updatedAt;
        writeStore(paths, failedStore, resolvedDeps);
        return;
      }
      const transactionState = {
        ...decideUpstreamEnrollmentTransaction(aborting, {
          type: "effect_succeeded"
        }).next,
        state: "failed" as const
      };
      const failed: UpstreamEnrollmentRecord = {
        ...current,
        state: "failed",
        activationUrl: null,
        updatedAt: resolvedDeps.now().toISOString(),
        transactionState,
        credential: aborted.credential,
        failureReason: "challenge_creation_failed",
        failureMessage: current.failureMessage
      };
      delete failed.pendingCredentialReference;
      failedStore.enrollments = failedStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? failed
          : entry
      );
      failedStore.updatedAt = failed.updatedAt;
      writeStore(paths, failedStore, resolvedDeps);
    });
    return {
      ok: false,
      state: "failed",
      backend: backendById(paths, backendId, resolvedDeps).backend,
      message:
        error instanceof Error
          ? error.message
          : "Failed to create upstream enrollment challenge."
    };
  }

  return withUpstreamEnrollmentLock(paths, backendId, () => {
    const currentStore = readStore(paths, resolvedDeps);
    const current = latestEnrollment(currentStore, backendId);
    const currentBackend = backendById(paths, backendId, resolvedDeps).backend;
    if (!sameEnrollmentIdentity(current, staged.record)) {
      return enrollmentResultFromSnapshot(backendId, current, currentBackend);
    }
    const challengeDecision = decideUpstreamEnrollmentTransaction(
      current.transactionState,
      { type: "challenge_created" }
    );
    const pending = executeUpstreamEnrollmentTransactionEffect(
      challengeDecision,
      {
        record_challenge: (): UpstreamEnrollmentRecord => ({
          ...current,
          challengeId: challenge.challengeId,
          activationUrl: challenge.activationUrl,
          transactionState: decideUpstreamEnrollmentTransaction(
            challengeDecision.next,
            { type: "effect_succeeded" }
          ).next,
          updatedAt: resolvedDeps.now().toISOString()
        })
      }
    )!;
    currentStore.enrollments = currentStore.enrollments.map((entry) =>
      entry.backendId === current.backendId &&
      entry.requestId === current.requestId
        ? pending
        : entry
    );
    currentStore.updatedAt = pending.updatedAt;
    writeStore(paths, currentStore, resolvedDeps);
    return {
      ok: true,
      state: "pending" as const,
      backend: currentBackend,
      enrollment: summarizeEnrollment(pending, currentBackend),
      message: `Started upstream enrollment for ${backendId}. Open the activation URL to approve this local edge.`
    };
  });
};

export const startUpstreamEnrollment = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> =>
  withSecureFetchForBackend(paths, id, deps, (resolvedDeps) =>
    startUpstreamEnrollmentWithFetch(paths, id, resolvedDeps)
  );

const abortPendingEnrollmentCredential = (
  paths: KoedServerPaths,
  backendId: string,
  record: UpstreamEnrollmentRecord,
  deps: Required<UpstreamEnrollmentDeps>
): { credential: UpstreamCredentialStatus; predecessorRestored: boolean } => {
  const replacement = replacementTransaction(record);
  deps.beforeEnrollmentEffect("abort_delete_pending_credential");
  deleteUpstreamCredentialSecret(paths.koedHome, record.credentialReference);
  if (
    replacement &&
    replacement.predecessorCredentialReference !== record.credentialReference
  ) {
    deps.beforeEnrollmentEffect("abort_restore_predecessor_registry");
    updateUpstreamBackendCredential(
      paths,
      backendId,
      {
        status: "configured",
        reference: replacement.predecessorCredentialReference
      },
      {
        existsSync: deps.existsSync,
        readFileSync: deps.readFileSync,
        writeFileSync: deps.writeFileSync,
        renameSync: deps.renameSync,
        now: deps.now
      }
    );
    return {
      credential: {
        status: "configured",
        reference: replacement.predecessorCredentialReference
      },
      predecessorRestored: true
    };
  }
  deps.beforeEnrollmentEffect("abort_delete_local_client_credential");
  deleteLocalEdgeClientCredential(paths.koedHome, backendId);
  deps.beforeEnrollmentEffect("abort_clear_registry_credential");
  updateUpstreamBackendCredential(
    paths,
    backendId,
    { status: "not_configured" },
    {
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync,
      writeFileSync: deps.writeFileSync,
      renameSync: deps.renameSync,
      now: deps.now
    }
  );
  return {
    credential: { status: "not_configured" },
    predecessorRestored: false
  };
};

const getUpstreamEnrollmentStatusWithFetch = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  const identity = await ensureDeviceIdentity(paths);
  if (!identity.remoteOperationsAllowed || !identity.deviceInstanceId) {
    return {
      ok: false,
      state: "failed",
      message: `Local device identity is ${identity.health}; upstream enrollment is blocked until explicit identity rotation.`
    };
  }
  const now = resolvedDeps.now();
  const { backend } = backendById(paths, backendId, resolvedDeps);
  const store = readStore(paths, resolvedDeps);
  const record = latestEnrollment(store, backendId);
  if (!record) {
    return {
      ok: true,
      state: "missing",
      backend,
      message: `No upstream enrollment has been started for ${backendId}.`
    };
  }
  if (
    record.transactionState.phase === "recovery_required" &&
    record.transactionState.pendingEffect === "stage_pending_custody"
  ) {
    return withUpstreamEnrollmentLock(paths, backendId, () => {
      const recoveryStore = readStore(paths, resolvedDeps);
      const current = latestEnrollment(recoveryStore, backendId);
      const currentBackend = backendById(
        paths,
        backendId,
        resolvedDeps
      ).backend;
      if (!sameEnrollmentIdentity(current, record)) {
        return enrollmentResultFromSnapshot(backendId, current, currentBackend);
      }
      const recoveryDecision = decideUpstreamEnrollmentTransaction(
        current.transactionState,
        { type: "recover" }
      );
      const aborted = executeUpstreamEnrollmentTransactionEffect(
        recoveryDecision,
        {
          compensate_pending_custody: () =>
            abortPendingEnrollmentCredential(
              paths,
              backendId,
              current,
              resolvedDeps
            )
        }
      )!;
      const recovered: UpstreamEnrollmentRecord = {
        ...current,
        state: "failed",
        activationUrl: null,
        updatedAt: resolvedDeps.now().toISOString(),
        transactionState: decideUpstreamEnrollmentTransaction(
          recoveryDecision.next,
          { type: "effect_succeeded" }
        ).next,
        credential: aborted.credential,
        failureReason: "prepared_effect_compensated",
        failureMessage:
          "Interrupted enrollment preparation was compensated; start enrollment again."
      };
      delete recovered.pendingCredentialReference;
      recoveryStore.enrollments = recoveryStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? recovered
          : entry
      );
      recoveryStore.updatedAt = recovered.updatedAt;
      writeStore(paths, recoveryStore, resolvedDeps);
      return {
        ok: false,
        state: "failed" as const,
        backend: backendById(paths, backendId, resolvedDeps).backend,
        enrollment: summarizeEnrollment(
          recovered,
          backendById(paths, backendId, resolvedDeps).backend
        ),
        message: recovered.failureMessage!
      };
    });
  }
  if (
    (record.transactionState.phase === "aborting" ||
      record.transactionState.phase === "recovery_required") &&
    record.transactionState.pendingEffect === "abort_pending"
  ) {
    return withUpstreamEnrollmentLock(paths, backendId, () => {
      const recoveryStore = readStore(paths, resolvedDeps);
      const current = latestEnrollment(recoveryStore, backendId);
      let currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      if (!sameEnrollmentIdentity(current, record)) {
        return enrollmentResultFromSnapshot(backendId, current, currentBackend);
      }
      const replacement = replacementTransaction(current);
      const resumed = decideUpstreamEnrollmentTransaction(
        current.transactionState,
        { type: "recover" }
      );
      const aborted = executeUpstreamEnrollmentTransactionEffect(resumed, {
        abort_pending: () =>
          abortPendingEnrollmentCredential(
            paths,
            backendId,
            current,
            resolvedDeps
          )
      })!;
      const recovered: UpstreamEnrollmentRecord = {
        ...current,
        state: current.transactionState.state,
        activationUrl: null,
        updatedAt: resolvedDeps.now().toISOString(),
        transactionState: decideUpstreamEnrollmentTransaction(resumed.next, {
          type: "effect_succeeded"
        }).next,
        credential: aborted.credential,
        ...(aborted.predecessorRestored && replacement
          ? {
              credentialReference: replacement.predecessorCredentialReference,
              activeCredentialReference:
                replacement.predecessorCredentialReference
            }
          : {})
      };
      delete recovered.pendingCredentialReference;
      recoveryStore.enrollments = recoveryStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? recovered
          : entry
      );
      recoveryStore.updatedAt = recovered.updatedAt;
      writeStore(paths, recoveryStore, resolvedDeps);
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      return {
        ok: true,
        state: recovered.state,
        backend: currentBackend,
        enrollment: summarizeEnrollment(recovered, currentBackend),
        message: `Upstream enrollment for ${backendId} is ${recovered.state}.`
      };
    });
  }
  const materialized = materializeState(record, now, backend);
  let credentialStatus: RemoteCredentialStatus | null = null;
  let upstreamStatus:
    | "pending"
    | "approved"
    | "denied"
    | "expired"
    | "unknown"
    | null = null;
  if (
    backend &&
    enrollmentCanReceiveRemoteStatus(materialized) &&
    materialized.credentialReference
  ) {
    credentialStatus = await remoteCredentialStatus(
      paths,
      backend,
      materialized.credentialReference,
      resolvedDeps
    );
    if (
      credentialStatus?.state !== "active" &&
      !(
        materialized.state === "exchanged" &&
        (credentialStatus?.state === "rejected" ||
          credentialStatus?.state === "unknown")
      ) &&
      materialized.challengeId
    ) {
      upstreamStatus = await readUpstreamChallengeStatus(
        backend,
        materialized.challengeId,
        identity.deviceInstanceId,
        resolvedDeps
      );
    }
  }

  return withUpstreamEnrollmentLock(paths, backendId, () => {
    const currentStore = readStore(paths, resolvedDeps);
    const currentRecord = latestEnrollment(currentStore, backendId);
    let currentBackend = backendById(paths, backendId, resolvedDeps).backend;
    if (!sameEnrollmentIdentity(currentRecord, record)) {
      return enrollmentResultFromSnapshot(
        backendId,
        currentRecord,
        currentBackend
      );
    }

    let current = materializeState(currentRecord, now, currentBackend);
    let temporaryCredentialStatusFailure = false;
    const recordReplacement = replacementTransaction(record);
    const currentReplacement = replacementTransaction(current);
    const remoteResultStillApplies =
      currentBackend &&
      enrollmentCanReceiveRemoteStatus(current) &&
      current.credentialReference === record.credentialReference &&
      currentBackend.credential.status !== "revoked" &&
      currentBackend.credential.status !== "not_configured" &&
      (currentBackend.credential.reference === record.credentialReference ||
        (recordReplacement !== null &&
          currentBackend.credential.reference ===
            recordReplacement.predecessorCredentialReference));

    if (remoteResultStillApplies && credentialStatus?.state === "active") {
      const commitDecision = decideUpstreamEnrollmentTransaction(
        current.transactionState,
        { type: "credential_observed", status: "active" }
      );
      current = {
        ...current,
        transactionState: commitDecision.next,
        updatedAt: now.toISOString()
      };
      currentStore.enrollments = currentStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? current
          : entry
      );
      currentStore.updatedAt = current.updatedAt;
      writeStore(paths, currentStore, resolvedDeps);
      try {
        executeUpstreamEnrollmentTransactionEffect(commitDecision, {
          commit_successor: () => {
            if (currentReplacement) {
              const localFamilies = localClientOperationFamiliesFor(
                current.requestedOperationFamilies
              );
              if (localFamilies.length > 0) {
                resolvedDeps.beforeEnrollmentEffect(
                  "commit_local_client_credential"
                );
                const localClient = storeLocalEdgeClientCredential(
                  paths.koedHome,
                  {
                    backendId,
                    secret: randomSecret(resolvedDeps),
                    operationFamilies: localFamilies
                  }
                );
                current = {
                  ...current,
                  localClientCredentialReference: localClient.reference
                };
              } else {
                resolvedDeps.beforeEnrollmentEffect(
                  "commit_delete_local_client_credential"
                );
                deleteLocalEdgeClientCredential(paths.koedHome, backendId);
              }
            }
            resolvedDeps.beforeEnrollmentEffect("commit_registry_credential");
            updateUpstreamBackendCredential(
              paths,
              backendId,
              {
                status: "configured",
                reference: current.credentialReference
              },
              {
                existsSync: resolvedDeps.existsSync,
                readFileSync: resolvedDeps.readFileSync,
                writeFileSync: resolvedDeps.writeFileSync,
                renameSync: resolvedDeps.renameSync,
                now: resolvedDeps.now
              }
            );
            if (
              currentReplacement &&
              currentReplacement.predecessorCredentialReference !==
                current.credentialReference
            ) {
              resolvedDeps.beforeEnrollmentEffect(
                "commit_delete_predecessor_credential"
              );
              deleteUpstreamCredentialSecret(
                paths.koedHome,
                currentReplacement.predecessorCredentialReference
              );
            }
          }
        });
      } catch (error) {
        current = {
          ...current,
          transactionState: decideUpstreamEnrollmentTransaction(
            commitDecision.next,
            { type: "effect_failed" }
          ).next,
          updatedAt: now.toISOString(),
          failureReason: "commit_effect_interrupted",
          failureMessage:
            error instanceof Error
              ? error.message.slice(0, 240)
              : "Enrollment commit was interrupted."
        };
        currentStore.enrollments = currentStore.enrollments.map((entry) =>
          entry.backendId === current.backendId &&
          entry.requestId === current.requestId
            ? current
            : entry
        );
        currentStore.updatedAt = current.updatedAt;
        writeStore(paths, currentStore, resolvedDeps);
        currentBackend = backendById(paths, backendId, resolvedDeps).backend;
        return {
          ok: false,
          state: current.state,
          backend: currentBackend,
          enrollment: summarizeEnrollment(current, currentBackend),
          message:
            "Upstream enrollment commit was interrupted and will recover on retry."
        };
      }
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      current = {
        ...current,
        state: "exchanged",
        updatedAt: now.toISOString(),
        failureReason: undefined,
        failureMessage: undefined,
        transactionState: decideUpstreamEnrollmentTransaction(
          commitDecision.next,
          { type: "effect_succeeded" }
        ).next,
        activeCredentialReference: current.credentialReference,
        credential: {
          status: "configured",
          reference: current.credentialReference
        },
        deviceCredentialId: credentialStatus.deviceCredentialId,
        principalUserId: credentialStatus.principalUserId
      };
      delete current.pendingCredentialReference;
    } else if (
      remoteResultStillApplies &&
      credentialStatus?.state === "rejected" &&
      current.state === "exchanged"
    ) {
      const revokeDecision = decideUpstreamEnrollmentTransaction(
        current.transactionState,
        { type: "credential_observed", status: "rejected" }
      );
      current = {
        ...current,
        transactionState: revokeDecision.next,
        updatedAt: now.toISOString()
      };
      currentStore.enrollments = currentStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? current
          : entry
      );
      currentStore.updatedAt = current.updatedAt;
      writeStore(paths, currentStore, resolvedDeps);
      executeUpstreamEnrollmentTransactionEffect(revokeDecision, {
        revoke_active: () => {
          deleteUpstreamCredentialSecret(
            paths.koedHome,
            current.credentialReference
          );
          deleteLocalEdgeClientCredential(paths.koedHome, backendId);
          updateUpstreamBackendCredential(
            paths,
            backendId,
            { status: "not_configured" },
            {
              existsSync: resolvedDeps.existsSync,
              readFileSync: resolvedDeps.readFileSync,
              writeFileSync: resolvedDeps.writeFileSync,
              renameSync: resolvedDeps.renameSync,
              now: resolvedDeps.now
            }
          );
        }
      });
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      current = {
        ...current,
        state: "failed",
        updatedAt: now.toISOString(),
        transactionState: decideUpstreamEnrollmentTransaction(
          revokeDecision.next,
          { type: "effect_succeeded" }
        ).next,
        failureReason: "credential_rejected",
        failureMessage:
          "Upstream backend rejected the stored device credential; restart enrollment.",
        credential: { status: "not_configured" }
      };
      delete current.activeCredentialReference;
    } else if (
      remoteResultStillApplies &&
      credentialStatus?.state === "unknown" &&
      current.state === "exchanged"
    ) {
      temporaryCredentialStatusFailure = true;
      current = {
        ...current,
        updatedAt: now.toISOString(),
        failureReason: "credential_status_unavailable",
        failureMessage:
          "Could not verify the upstream device credential. Stored credentials were kept; retry when the Team Backend is available."
      };
    } else if (remoteResultStillApplies) {
      if (upstreamStatus === "denied" || upstreamStatus === "expired") {
        const abortDecision = decideUpstreamEnrollmentTransaction(
          current.transactionState,
          { type: "challenge_observed", status: upstreamStatus }
        );
        current = {
          ...current,
          transactionState: abortDecision.next,
          updatedAt: now.toISOString()
        };
        currentStore.enrollments = currentStore.enrollments.map((entry) =>
          entry.backendId === current.backendId &&
          entry.requestId === current.requestId
            ? current
            : entry
        );
        currentStore.updatedAt = current.updatedAt;
        writeStore(paths, currentStore, resolvedDeps);
        const aborted = executeUpstreamEnrollmentTransactionEffect(
          abortDecision,
          {
            abort_pending: () =>
              abortPendingEnrollmentCredential(
                paths,
                backendId,
                current,
                resolvedDeps
              )
          }
        )!;
        currentBackend = backendById(paths, backendId, resolvedDeps).backend;
        current = {
          ...current,
          state: upstreamStatus,
          updatedAt: now.toISOString(),
          transactionState: decideUpstreamEnrollmentTransaction(
            abortDecision.next,
            { type: "effect_succeeded" }
          ).next,
          credential: aborted.credential,
          ...(aborted.predecessorRestored
            ? {
                credentialReference:
                  currentReplacement!.predecessorCredentialReference,
                activeCredentialReference:
                  currentReplacement!.predecessorCredentialReference
              }
            : {})
        };
        delete current.pendingCredentialReference;
      } else if (upstreamStatus === "approved") {
        const approval = decideUpstreamEnrollmentTransaction(
          current.transactionState,
          { type: "challenge_observed", status: "approved" }
        );
        current = {
          ...current,
          state: "approved",
          transactionState: approval.next,
          updatedAt: now.toISOString()
        };
      }
    }

    if (
      current.state === "expired" &&
      current.credential?.status !== "configured" &&
      current.transactionState.phase !== "aborted"
    ) {
      const expiringReplacement = replacementTransaction(current);
      const abortDecision = decideUpstreamEnrollmentTransaction(
        current.transactionState,
        { type: "challenge_observed", status: "expired" }
      );
      current = {
        ...current,
        transactionState: abortDecision.next,
        updatedAt: now.toISOString()
      };
      currentStore.enrollments = currentStore.enrollments.map((entry) =>
        entry.backendId === current.backendId &&
        entry.requestId === current.requestId
          ? current
          : entry
      );
      currentStore.updatedAt = current.updatedAt;
      writeStore(paths, currentStore, resolvedDeps);
      const aborted = executeUpstreamEnrollmentTransactionEffect(
        abortDecision,
        {
          abort_pending: () =>
            abortPendingEnrollmentCredential(
              paths,
              backendId,
              current,
              resolvedDeps
            )
        }
      )!;
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      current = {
        ...current,
        transactionState: decideUpstreamEnrollmentTransaction(
          abortDecision.next,
          { type: "effect_succeeded" }
        ).next,
        credential: aborted.credential,
        ...(aborted.predecessorRestored
          ? {
              credentialReference:
                expiringReplacement!.predecessorCredentialReference,
              activeCredentialReference:
                expiringReplacement!.predecessorCredentialReference
            }
          : {})
      };
      delete current.pendingCredentialReference;
    }

    if (JSON.stringify(current) !== JSON.stringify(currentRecord)) {
      currentStore.enrollments = currentStore.enrollments.map((entry) =>
        entry.backendId === currentRecord.backendId &&
        entry.requestId === currentRecord.requestId
          ? current
          : entry
      );
      currentStore.updatedAt = now.toISOString();
      resolvedDeps.beforeEnrollmentEffect("commit_enrollment_state");
      writeStore(paths, currentStore, resolvedDeps);
    }
    return {
      ok: !temporaryCredentialStatusFailure,
      state: current.state,
      backend: currentBackend,
      enrollment: summarizeEnrollment(current, currentBackend),
      message: temporaryCredentialStatusFailure
        ? current.failureMessage!
        : `Upstream enrollment for ${backendId} is ${current.state}.`
    };
  });
};

export const getUpstreamEnrollmentStatus = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> =>
  withSecureFetchForBackend(paths, id, deps, (resolvedDeps) =>
    getUpstreamEnrollmentStatusWithFetch(paths, id, resolvedDeps)
  );

export const cancelUpstreamEnrollment = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  return withUpstreamEnrollmentLock(paths, backendId, () => {
    const nowDate = resolvedDeps.now();
    const now = nowDate.toISOString();
    const { backend } = backendById(paths, backendId, resolvedDeps);
    const store = readStore(paths, resolvedDeps);
    const record = latestEnrollment(store, backendId);
    if (!record) {
      return {
        ok: true,
        state: "missing" as const,
        backend,
        message: `No upstream enrollment has been started for ${backendId}.`
      };
    }
    const materialized = materializeState(record, nowDate, backend);
    if (materialized.transactionState.pendingEffect === "commit_successor") {
      return {
        ok: false,
        state: materialized.state,
        backend,
        enrollment: summarizeEnrollment(materialized, backend),
        message:
          "The successor credential is already active and its local commit must recover before enrollment can be canceled."
      };
    }
    if (
      materialized.state === "exchanged" ||
      materialized.state === "revoked" ||
      materialized.state === "expired" ||
      materialized.state === "failed" ||
      materialized.state === "denied"
    ) {
      return {
        ok: true,
        state: materialized.state,
        backend,
        enrollment: summarizeEnrollment(materialized, backend),
        message: `Upstream enrollment for ${backendId} is already ${materialized.state}.`
      };
    }
    const abortDecision = decideUpstreamEnrollmentTransaction(
      materialized.transactionState,
      { type: "cancel" }
    );
    const aborting: UpstreamEnrollmentRecord = {
      ...materialized,
      transactionState: abortDecision.next,
      updatedAt: now
    };
    store.enrollments = store.enrollments.map((entry) =>
      entry.backendId === record.backendId &&
      entry.requestId === record.requestId
        ? aborting
        : entry
    );
    store.updatedAt = now;
    writeStore(paths, store, resolvedDeps);
    const aborted = executeUpstreamEnrollmentTransactionEffect(abortDecision, {
      abort_pending: () =>
        abortPendingEnrollmentCredential(
          paths,
          backendId,
          aborting,
          resolvedDeps
        )
    })!;
    const canceledReplacement = replacementTransaction(aborting);
    const canceled: UpstreamEnrollmentRecord = {
      ...aborting,
      state: "canceled",
      updatedAt: now,
      transactionState: decideUpstreamEnrollmentTransaction(
        abortDecision.next,
        { type: "effect_succeeded" }
      ).next,
      credential: aborted.credential,
      ...(aborted.predecessorRestored
        ? {
            credentialReference:
              canceledReplacement!.predecessorCredentialReference,
            activeCredentialReference:
              canceledReplacement!.predecessorCredentialReference
          }
        : {})
    };
    delete canceled.pendingCredentialReference;
    store.enrollments = store.enrollments.map((entry) =>
      entry.backendId === record.backendId &&
      entry.requestId === record.requestId
        ? canceled
        : entry
    );
    store.updatedAt = now;
    writeStore(paths, store, resolvedDeps);
    if (
      !aborted.predecessorRestored &&
      getActiveUpstreamBackend(paths)?.id === backendId
    ) {
      setActiveUpstreamBackend(paths, null, {
        existsSync: resolvedDeps.existsSync,
        readFileSync: resolvedDeps.readFileSync,
        writeFileSync: resolvedDeps.writeFileSync,
        renameSync: resolvedDeps.renameSync,
        now: resolvedDeps.now
      });
    }
    return {
      ok: true,
      state: "canceled" as const,
      backend,
      enrollment: summarizeEnrollment(canceled, backend),
      message: `Canceled upstream enrollment for ${backendId}.`
    };
  });
};

export const invalidateUpstreamEnrollmentReferences = async (
  paths: KoedServerPaths,
  deps: UpstreamEnrollmentDeps = {}
): Promise<{ pendingRemoteRevocation: boolean }> => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = collectUpstreamRegistryStatus(paths, {
    existsSync: resolvedDeps.existsSync,
    readFileSync: resolvedDeps.readFileSync,
    now: resolvedDeps.now
  });
  if (registry.parseError) {
    throw new Error("Upstream backend registry is malformed.");
  }
  let pendingRemoteRevocation = false;
  for (const backend of registry.backends) {
    await withUpstreamEnrollmentLock(paths, backend.id, () => {
      const now = resolvedDeps.now().toISOString();
      const current = backendById(paths, backend.id, resolvedDeps).backend;
      if (!current) return;
      if (
        current.credential.reference &&
        current.credential.status !== "revoked" &&
        current.credential.status !== "not_configured"
      ) {
        pendingRemoteRevocation = true;
      }
      updateUpstreamBackendRoutePolicy(
        paths,
        backend.id,
        {
          personalMemoryRead: "disabled",
          personalCollaboration: "disabled",
          teamWorkspaceRead: "disabled",
          shareGrantManagement: "disabled",
          captureWrites: "disabled",
          sync: "disabled",
          admin: "disabled"
        },
        {
          existsSync: resolvedDeps.existsSync,
          readFileSync: resolvedDeps.readFileSync,
          writeFileSync: resolvedDeps.writeFileSync,
          renameSync: resolvedDeps.renameSync,
          now: resolvedDeps.now
        }
      );
      updateUpstreamBackendCredential(
        paths,
        backend.id,
        { status: "revoked", reference: current.credential.reference },
        {
          existsSync: resolvedDeps.existsSync,
          readFileSync: resolvedDeps.readFileSync,
          writeFileSync: resolvedDeps.writeFileSync,
          renameSync: resolvedDeps.renameSync,
          now: resolvedDeps.now
        }
      );
      deleteUpstreamCredentialSecret(
        paths.koedHome,
        current.credential.reference
      );
      deleteLocalEdgeClientCredential(paths.koedHome, backend.id);
      const store = readStore(paths, resolvedDeps);
      store.enrollments = store.enrollments.map((record) =>
        record.backendId === backend.id
          ? {
              ...record,
              state: "revoked",
              updatedAt: now,
              credential: {
                status: "revoked",
                reference: record.credentialReference
              }
            }
          : record
      );
      store.updatedAt = now;
      writeStore(paths, store, resolvedDeps);
    });
  }
  return { pendingRemoteRevocation };
};

const disconnectUpstreamBackendEnrollmentWithFetch = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  return withUpstreamEnrollmentLock(paths, backendId, async () => {
    const now = resolvedDeps.now().toISOString();
    const { backend } = backendById(paths, backendId, resolvedDeps);
    if (!backend) {
      return {
        ok: false,
        state: "missing" as const,
        message: `Upstream backend ${backendId} is not registered.`
      };
    }
    beginUpstreamDisconnectCleanup(paths, backendId, {
      now: resolvedDeps.now
    });
    if (
      backend.credential.status !== "revoked" &&
      backend.credential.status !== "not_configured"
    ) {
      const remoteRevocation = await revokeRemoteCredential(
        paths,
        backend,
        backend.credential.reference,
        resolvedDeps
      );
      if (remoteRevocation === "unavailable") {
        updateUpstreamDisconnectCleanup(
          paths,
          backendId,
          {
            phase: "remote_revocation_pending",
            lastFailureCategory: "remote_unavailable"
          },
          { now: resolvedDeps.now }
        );
        return {
          ok: false,
          state: "failed" as const,
          backend,
          message:
            "The upstream device credential could not be revoked. Local credentials and routes were kept so disconnect can be retried safely."
        };
      }
    }
    updateUpstreamDisconnectCleanup(
      paths,
      backendId,
      {
        phase: "local_cleanup_pending",
        lastFailureCategory: null
      },
      { now: resolvedDeps.now }
    );
    updateUpstreamBackendRoutePolicy(
      paths,
      backendId,
      {
        personalMemoryRead: "disabled",
        personalCollaboration: "disabled",
        teamWorkspaceRead: "disabled",
        shareGrantManagement: "disabled",
        captureWrites: "disabled",
        sync: "disabled",
        admin: "disabled"
      },
      {
        existsSync: resolvedDeps.existsSync,
        readFileSync: resolvedDeps.readFileSync,
        writeFileSync: resolvedDeps.writeFileSync,
        renameSync: resolvedDeps.renameSync,
        now: resolvedDeps.now
      }
    );
    updateUpstreamBackendCredential(
      paths,
      backendId,
      { status: "revoked" },
      {
        existsSync: resolvedDeps.existsSync,
        readFileSync: resolvedDeps.readFileSync,
        writeFileSync: resolvedDeps.writeFileSync,
        renameSync: resolvedDeps.renameSync,
        now: resolvedDeps.now
      }
    );
    clearUpstreamBackendCapabilities(paths, backendId, {
      existsSync: resolvedDeps.existsSync,
      readFileSync: resolvedDeps.readFileSync,
      writeFileSync: resolvedDeps.writeFileSync,
      renameSync: resolvedDeps.renameSync,
      now: resolvedDeps.now
    });
    deleteUpstreamCredentialSecret(
      paths.koedHome,
      backend.credential.reference
    );
    deleteLocalEdgeClientCredential(paths.koedHome, backendId);
    const refreshedBackend = backendById(
      paths,
      backendId,
      resolvedDeps
    ).backend;
    const store = readStore(paths, resolvedDeps);
    const existing = latestEnrollment(store, backendId);
    const record: UpstreamEnrollmentRecord = {
      backendId,
      requestId: existing?.requestId ?? resolvedDeps.randomId(),
      state: "revoked",
      activationUrl: null,
      requestedOperationFamilies: [],
      transaction: { kind: "initial" },
      transactionState: {
        ...createUpstreamEnrollmentTransaction({
          id: existing?.transactionState.id ?? existing?.requestId ?? "revoked",
          generation: existing?.transactionState.generation ?? 1,
          kind: "initial"
        }),
        phase: "aborted",
        state: "revoked",
        pendingEffect: null
      },
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
      expiresAt: null,
      credential: { status: "revoked" }
    };
    if (existing) {
      store.enrollments = store.enrollments.map((entry) =>
        entry.backendId === existing.backendId &&
        entry.requestId === existing.requestId
          ? record
          : entry
      );
    } else {
      store.enrollments.push(record);
    }
    store.updatedAt = now;
    writeStore(paths, store, resolvedDeps);
    if (getActiveUpstreamBackend(paths)?.id === backendId) {
      setActiveUpstreamBackend(paths, null, {
        existsSync: resolvedDeps.existsSync,
        readFileSync: resolvedDeps.readFileSync,
        writeFileSync: resolvedDeps.writeFileSync,
        renameSync: resolvedDeps.renameSync,
        now: resolvedDeps.now
      });
    }
    return {
      ok: true,
      state: "revoked" as const,
      backend: refreshedBackend,
      enrollment: summarizeEnrollment(record, refreshedBackend),
      message: `Disconnected upstream backend ${backendId} and revoked its exchanged device credential.`
    };
  });
};

export const disconnectUpstreamBackendEnrollment = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> =>
  withSecureFetchForBackend(paths, id, deps, (resolvedDeps) =>
    disconnectUpstreamBackendEnrollmentWithFetch(paths, id, resolvedDeps)
  );
