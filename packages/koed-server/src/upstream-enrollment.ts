import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertSecureHttpTransport,
  deleteLocalEdgeClientCredential,
  deleteUpstreamCredentialSecret,
  readUpstreamCredentialAuthorization,
  storeLocalEdgeClientCredential,
  storeUpstreamCredentialSecret
} from "@koed/shared";
import type { KoedServerPaths } from "./paths.js";
import { ensureDeviceIdentity } from "./device-identity.js";
import { withUpstreamEnrollmentLock } from "./upstream-enrollment-lock.js";
import {
  collectUpstreamRegistryStatus,
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
  challengeId?: string;
  credentialKeyId?: string;
  credentialReference?: string;
  localClientCredentialReference?: string;
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
  randomBytes: deps.randomBytes ?? randomBytes
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
  record: Partial<UpstreamEnrollmentRecord>,
  now: string
): UpstreamEnrollmentRecord => ({
  backendId:
    typeof record.backendId === "string"
      ? validateBackendId(record.backendId)
      : "missing",
  requestId:
    typeof record.requestId === "string" && record.requestId.trim()
      ? record.requestId.trim().slice(0, 120)
      : "unknown",
  state: normalizeEnrollmentState(record.state),
  activationUrl:
    typeof record.activationUrl === "string"
      ? sanitizeActivationUrl(record.activationUrl)
      : null,
  requestedOperationFamilies: Array.isArray(record.requestedOperationFamilies)
    ? record.requestedOperationFamilies.filter(isOperationFamily)
    : [],
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
});

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
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    ...(record.failureReason ? { failureReason: record.failureReason } : {}),
    ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
    credential
  };
};

const routePolicyOperationFamilies = (
  routePolicy: UpstreamRoutePolicy
): string[] => {
  const entries: Array<[keyof UpstreamRoutePolicy, string]> = [
    ["personalMemoryRead", "personal_memory_read"],
    ["teamWorkspaceRead", "team_workspace_read"],
    ["shareGrantManagement", "share_grant_management"],
    ["captureWrites", "capture_writes"],
    ["sync", "sync"],
    ["admin", "admin"]
  ];
  return entries
    .filter(([key]) => routePolicy[key] === "enabled")
    .map(([, family]) => family);
};

const browserEnrollmentOperationFamilies = (
  routePolicy: UpstreamRoutePolicy
): string[] =>
  routePolicyOperationFamilies(routePolicy).filter(
    (family) => family !== "admin"
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
    challengeHash: string;
    credentialKeyId: string;
    verifierSecret: string;
    operationFamilies: string[];
    requestId: string;
    expiresAt: string | null;
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
      body: JSON.stringify({
        challenge_hash: input.challengeHash,
        upstream_backend_id: input.backendId,
        device_instance_id: "koed-local-edge",
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
  return {
    challengeId,
    activationUrl: approvalUrlFor(backend, challengeId)
  };
};

const readUpstreamChallengeStatus = async (
  backend: UpstreamBackendSummary,
  challengeId: string,
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
    { method: "GET" }
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

type RemoteCredentialStatus = "active" | "rejected" | "unknown";

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
    return "unknown";
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
      return "rejected";
    }
    return result.ok && result.payload.ok === true ? "active" : "unknown";
  } catch {
    return "unknown";
  }
};

const latestEnrollment = (
  store: UpstreamEnrollmentStore,
  backendId: string
): UpstreamEnrollmentRecord | undefined =>
  [...store.enrollments]
    .reverse()
    .find((enrollment) => enrollment.backendId === backendId);

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
  current.credentialReference === expected.credentialReference;

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
  if (backend?.credential.status === "configured") {
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

export const startUpstreamEnrollment = async (
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
  const operationFamilies = browserEnrollmentOperationFamilies(
    backend.routePolicy
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
      message: `Upstream backend ${backendId} only enables admin routing, which cannot be enrolled through browser-mediated device enrollment.`
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
      current.state === "exchanged"
    ) {
      return current;
    }
    store = readStore(paths, resolvedDeps);
    expectedRecord = latestEnrollment(store, backendId);
  }

  const requestId = resolvedDeps.randomId();
  const verifierSecret = randomSecret(resolvedDeps);
  const challengeSecret = randomSecret(resolvedDeps);
  const challengeHash = challengeHashFor(backendId, requestId, challengeSecret);
  const credentialKeyId = `koed_${createHash("sha256")
    .update(`${backendId}:${requestId}:${verifierSecret}`)
    .digest("hex")
    .slice(0, 40)}`;
  const expiresAt = expiresAtFor(now);
  const localClientOperationFamilies = operationFamilies.filter(
    (family) => family === "team_workspace_read"
  );
  const localClientSecret = randomSecret(resolvedDeps);

  let challenge: { challengeId: string; activationUrl: string };
  try {
    challenge = await createUpstreamChallenge(
      backend,
      {
        backendId,
        challengeHash,
        credentialKeyId,
        verifierSecret,
        operationFamilies,
        requestId,
        expiresAt
      },
      resolvedDeps
    );
  } catch (error) {
    return {
      ok: false,
      state: "failed",
      backend,
      message:
        error instanceof Error
          ? error.message
          : "Failed to create upstream enrollment challenge."
    };
  }

  return withUpstreamEnrollmentLock(paths, backendId, () => {
    store = readStore(paths, resolvedDeps);
    const currentRecord = latestEnrollment(store, backendId);
    const currentBackend = backendById(paths, backendId, resolvedDeps).backend;
    const expectedStillCurrent = expectedRecord
      ? sameEnrollmentIdentity(currentRecord, expectedRecord) &&
        currentRecord.state === expectedRecord.state
      : currentRecord === undefined;
    const currentOperationFamilies = currentBackend
      ? browserEnrollmentOperationFamilies(currentBackend.routePolicy)
      : [];
    if (
      !expectedStillCurrent ||
      !currentBackend ||
      currentBackend.capabilities.state !== "validated" ||
      JSON.stringify(currentOperationFamilies) !==
        JSON.stringify(operationFamilies)
    ) {
      return currentRecord
        ? enrollmentResultFromSnapshot(backendId, currentRecord, currentBackend)
        : {
            ok: false,
            state: "failed" as const,
            backend: currentBackend,
            message: `Upstream backend ${backendId} changed while enrollment was starting; retry with its current configuration.`
          };
    }

    const { reference } = storeUpstreamCredentialSecret(paths.koedHome, {
      backendId,
      credentialKeyId,
      secret: verifierSecret
    });
    const localClientCredential =
      localClientOperationFamilies.length > 0
        ? storeLocalEdgeClientCredential(paths.koedHome, {
            backendId,
            secret: localClientSecret,
            operationFamilies: localClientOperationFamilies
          })
        : null;
    updateUpstreamBackendCredential(
      paths,
      backendId,
      { status: "unknown", reference },
      {
        existsSync: resolvedDeps.existsSync,
        readFileSync: resolvedDeps.readFileSync,
        writeFileSync: resolvedDeps.writeFileSync,
        renameSync: resolvedDeps.renameSync,
        now: resolvedDeps.now
      }
    );

    const record: UpstreamEnrollmentRecord = {
      backendId,
      requestId,
      state: "pending",
      activationUrl: challenge.activationUrl,
      requestedOperationFamilies: operationFamilies,
      challengeId: challenge.challengeId,
      credentialKeyId,
      credentialReference: reference,
      ...(localClientCredential
        ? { localClientCredentialReference: localClientCredential.reference }
        : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt,
      credential: { status: "unknown", reference }
    };
    store.enrollments.push(record);
    store.updatedAt = nowIso;
    writeStore(paths, store, resolvedDeps);
    const refreshedBackend = backendById(
      paths,
      backendId,
      resolvedDeps
    ).backend;
    return {
      ok: true,
      state: "pending" as const,
      backend: refreshedBackend,
      enrollment: summarizeEnrollment(record, refreshedBackend),
      message: `Started upstream enrollment for ${backendId}. Open the activation URL to approve this local edge.`
    };
  });
};

export const getUpstreamEnrollmentStatus = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
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
      credentialStatus !== "active" &&
      !(
        materialized.state === "exchanged" &&
        (credentialStatus === "rejected" || credentialStatus === "unknown")
      ) &&
      materialized.challengeId
    ) {
      upstreamStatus = await readUpstreamChallengeStatus(
        backend,
        materialized.challengeId,
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
    const remoteResultStillApplies =
      currentBackend &&
      enrollmentCanReceiveRemoteStatus(current) &&
      current.credentialReference === record.credentialReference &&
      currentBackend.credential.status !== "revoked" &&
      currentBackend.credential.status !== "not_configured" &&
      currentBackend.credential.reference === record.credentialReference;

    if (remoteResultStillApplies && credentialStatus === "active") {
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
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      current = {
        ...current,
        state: "exchanged",
        updatedAt: now.toISOString(),
        failureReason: undefined,
        failureMessage: undefined,
        credential: {
          status: "configured",
          reference: current.credentialReference
        }
      };
    } else if (
      remoteResultStillApplies &&
      credentialStatus === "rejected" &&
      current.state === "exchanged"
    ) {
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
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
      current = {
        ...current,
        state: "failed",
        updatedAt: now.toISOString(),
        failureReason: "credential_rejected",
        failureMessage:
          "Upstream backend rejected the stored device credential; restart enrollment.",
        credential: { status: "not_configured" }
      };
    } else if (
      remoteResultStillApplies &&
      credentialStatus === "unknown" &&
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
        currentBackend = backendById(paths, backendId, resolvedDeps).backend;
        current = {
          ...current,
          state: upstreamStatus,
          updatedAt: now.toISOString(),
          credential: { status: "not_configured" }
        };
      } else if (upstreamStatus === "approved") {
        current = {
          ...current,
          state: "approved",
          updatedAt: now.toISOString()
        };
      }
    }

    if (current.state === "expired") {
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
      currentBackend = backendById(paths, backendId, resolvedDeps).backend;
    }

    if (JSON.stringify(current) !== JSON.stringify(currentRecord)) {
      currentStore.enrollments = currentStore.enrollments.map((entry) =>
        entry.backendId === currentRecord.backendId &&
        entry.requestId === currentRecord.requestId
          ? current
          : entry
      );
      currentStore.updatedAt = now.toISOString();
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
    const canceled: UpstreamEnrollmentRecord = {
      ...materialized,
      state: "canceled",
      updatedAt: now,
      credential: { status: "not_configured" }
    };
    deleteUpstreamCredentialSecret(
      paths.koedHome,
      materialized.credentialReference
    );
    deleteLocalEdgeClientCredential(paths.koedHome, backendId);
    store.enrollments = store.enrollments.map((entry) =>
      entry.backendId === record.backendId &&
      entry.requestId === record.requestId
        ? canceled
        : entry
    );
    store.updatedAt = now;
    writeStore(paths, store, resolvedDeps);
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
): Promise<void> => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = collectUpstreamRegistryStatus(paths, {
    existsSync: resolvedDeps.existsSync,
    readFileSync: resolvedDeps.readFileSync,
    now: resolvedDeps.now
  });
  if (registry.parseError) {
    throw new Error("Upstream backend registry is malformed.");
  }
  for (const backend of registry.backends) {
    await withUpstreamEnrollmentLock(paths, backend.id, () => {
      const now = resolvedDeps.now().toISOString();
      const current = backendById(paths, backend.id, resolvedDeps).backend;
      if (!current) return;
      updateUpstreamBackendRoutePolicy(
        paths,
        backend.id,
        {
          personalMemoryRead: "disabled",
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
};

export const disconnectUpstreamBackendEnrollment = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): Promise<UpstreamEnrollmentResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  return withUpstreamEnrollmentLock(paths, backendId, () => {
    const now = resolvedDeps.now().toISOString();
    const { backend } = backendById(paths, backendId, resolvedDeps);
    if (!backend) {
      return {
        ok: false,
        state: "missing" as const,
        message: `Upstream backend ${backendId} is not registered.`
      };
    }
    updateUpstreamBackendRoutePolicy(
      paths,
      backendId,
      {
        personalMemoryRead: "disabled",
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
      { status: "revoked", reference: backend.credential.reference },
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
      ...(existing ?? {
        backendId,
        requestId: resolvedDeps.randomId(),
        activationUrl: null,
        requestedOperationFamilies: []
      }),
      state: "revoked",
      updatedAt: now,
      createdAt: existing?.createdAt ?? now,
      expiresAt: existing?.expiresAt ?? null,
      credential: { status: "revoked", reference: backend.credential.reference }
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
    return {
      ok: true,
      state: "revoked" as const,
      backend: refreshedBackend,
      enrollment: summarizeEnrollment(record, refreshedBackend),
      message: `Disconnected upstream backend ${backendId} locally. Revoke any browser/session-issued device credential on the upstream backend if it was already exchanged.`
    };
  });
};
