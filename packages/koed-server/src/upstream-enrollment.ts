import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { KoedServerPaths } from "./paths.js";
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
  now?: () => Date;
  randomId?: () => string;
}

const depsWithDefaults = (
  deps: UpstreamEnrollmentDeps = {}
): Required<UpstreamEnrollmentDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  now: deps.now ?? (() => new Date()),
  randomId: deps.randomId ?? randomUUID
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
        ? { reference: credential.reference.trim().slice(0, 120) }
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
): UpstreamEnrollmentSummary => ({
  backendId: record.backendId,
  requestId: record.requestId,
  state: record.state,
  activationUrl: record.activationUrl,
  requestedOperationFamilies: record.requestedOperationFamilies,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  expiresAt: record.expiresAt,
  ...(record.failureReason ? { failureReason: record.failureReason } : {}),
  ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
  credential:
    record.state === "revoked"
      ? (record.credential ?? { status: "revoked" })
      : (backend?.credential ?? record.credential ?? { status: "unknown" })
});

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

export const startUpstreamEnrollment = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): UpstreamEnrollmentResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
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

  const store = readStore(paths, resolvedDeps);
  const existing = latestEnrollment(store, backendId);
  if (existing) {
    const materialized = materializeState(existing, now, backend);
    if (materialized.state !== existing.state) {
      store.enrollments = store.enrollments.map((entry) =>
        entry.backendId === existing.backendId &&
        entry.requestId === existing.requestId
          ? materialized
          : entry
      );
      store.updatedAt = nowIso;
      writeStore(paths, store, resolvedDeps);
    }
    if (
      materialized.state === "pending" ||
      materialized.state === "approved" ||
      materialized.state === "exchanged" ||
      materialized.state === "revoked" ||
      materialized.state === "failed"
    ) {
      return {
        ok: true,
        state: materialized.state,
        backend,
        enrollment: summarizeEnrollment(materialized, backend),
        message: `Upstream enrollment for ${backendId} is already ${materialized.state}.`
      };
    }
  }

  const record: UpstreamEnrollmentRecord = {
    backendId,
    requestId: resolvedDeps.randomId(),
    state: "pending",
    activationUrl: null,
    requestedOperationFamilies: operationFamilies,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt: expiresAtFor(now),
    credential: backend.credential
  };
  store.enrollments.push(record);
  store.updatedAt = nowIso;
  writeStore(paths, store, resolvedDeps);
  return {
    ok: true,
    state: "pending",
    backend,
    enrollment: summarizeEnrollment(record, backend),
    message: `Started upstream enrollment for ${backendId}. Open Explorer and create a browser-mediated device enrollment challenge to approve this device.`
  };
};

export const getUpstreamEnrollmentStatus = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): UpstreamEnrollmentResult => {
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
  if (materialized.state !== record.state) {
    store.enrollments = store.enrollments.map((entry) =>
      entry.backendId === record.backendId &&
      entry.requestId === record.requestId
        ? materialized
        : entry
    );
    store.updatedAt = now.toISOString();
    writeStore(paths, store, resolvedDeps);
  }
  return {
    ok: true,
    state: materialized.state,
    backend,
    enrollment: summarizeEnrollment(materialized, backend),
    message: `Upstream enrollment for ${backendId} is ${materialized.state}.`
  };
};

export const cancelUpstreamEnrollment = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): UpstreamEnrollmentResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  const nowDate = resolvedDeps.now();
  const now = nowDate.toISOString();
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
    updatedAt: now
  };
  store.enrollments = store.enrollments.map((entry) =>
    entry.backendId === record.backendId && entry.requestId === record.requestId
      ? canceled
      : entry
  );
  store.updatedAt = now;
  writeStore(paths, store, resolvedDeps);
  return {
    ok: true,
    state: "canceled",
    backend,
    enrollment: summarizeEnrollment(canceled, backend),
    message: `Canceled upstream enrollment for ${backendId}.`
  };
};

export const disconnectUpstreamBackendEnrollment = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamEnrollmentDeps = {}
): UpstreamEnrollmentResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const backendId = validateBackendId(id);
  const now = resolvedDeps.now().toISOString();
  const { backend } = backendById(paths, backendId, resolvedDeps);
  if (!backend) {
    return {
      ok: false,
      state: "missing",
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
  const refreshedBackend = backendById(paths, backendId, resolvedDeps).backend;
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
    state: "revoked",
    backend: refreshedBackend,
    enrollment: summarizeEnrollment(record, refreshedBackend),
    message: `Disconnected upstream backend ${backendId} locally. Revoke any browser/session-issued device credential on the upstream backend if it was already exchanged.`
  };
};
