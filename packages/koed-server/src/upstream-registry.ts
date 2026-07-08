import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { KoedServerPaths } from "./paths.js";

export type UpstreamDeploymentProfile =
  | "developer"
  | "local_personal"
  | "private_vps"
  | "team_self_hosted"
  | "koed_managed_cloud";

export type UpstreamCapabilityState =
  | "not_checked"
  | "validated"
  | "stale"
  | "failed";

export type UpstreamFailureCategory =
  | "network"
  | "http"
  | "invalid_capabilities"
  | "unsupported_schema"
  | "unexpected";

export interface UpstreamRoutePolicy {
  personalMemoryRead: "disabled" | "enabled";
  teamWorkspaceRead: "disabled" | "enabled";
  shareGrantManagement: "disabled" | "enabled";
  captureWrites: "disabled" | "enabled";
  sync: "disabled" | "enabled";
  admin: "disabled" | "enabled";
}

export interface UpstreamCapabilityCache {
  state: UpstreamCapabilityState;
  checkedAt: string | null;
  expiresAt: string | null;
  schemaVersion: number | null;
  profile: UpstreamDeploymentProfile | null;
  releaseVersion: string | null;
  failureCategory?: UpstreamFailureCategory;
  failureMessage?: string;
  payload?: SanitizedCapabilitiesPayload;
}

export interface UpstreamCredentialStatus {
  status: "not_configured" | "configured" | "revoked" | "unknown";
  reference?: string;
}

export interface UpstreamBackendRecord {
  id: string;
  displayName: string;
  baseUrl: string;
  profile: UpstreamDeploymentProfile | null;
  createdAt: string;
  updatedAt: string;
  routePolicy: UpstreamRoutePolicy;
  credential: UpstreamCredentialStatus;
  capabilities: UpstreamCapabilityCache;
}

export interface UpstreamBackendRegistry {
  schemaVersion: 1;
  updatedAt: string;
  backends: UpstreamBackendRecord[];
}

export interface UpstreamBackendSummary {
  id: string;
  displayName: string;
  baseUrl: string;
  profile: UpstreamDeploymentProfile | null;
  routePolicy: UpstreamRoutePolicy;
  credential: UpstreamCredentialStatus;
  capabilities: Omit<UpstreamCapabilityCache, "payload">;
}

export interface UpstreamRegistryResult {
  ok: boolean;
  state:
    | "listed"
    | "registered"
    | "updated"
    | "removed"
    | "missing"
    | "validated"
    | "failed";
  backend?: UpstreamBackendSummary;
  backends?: UpstreamBackendSummary[];
  message: string;
}

export type UpstreamRoutePolicyUpdate = Partial<UpstreamRoutePolicy>;

interface CapabilityDescriptor {
  availability?: unknown;
  description?: unknown;
  endpoints?: unknown;
  requiresAuthentication?: unknown;
}

export interface SanitizedCapabilitiesPayload {
  product: "koed";
  apiVersion: "v1";
  capabilitySchemaVersion: number;
  releaseVersion?: string;
  audience?: "public" | "authenticated";
  deployment?: {
    profile?: UpstreamDeploymentProfile;
    managedBy?: string;
    distribution?: string;
    productBoundary?: string;
  };
  runtime?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  commercial?: Record<string, unknown>;
  security?: Record<string, unknown>;
  authenticatedCapabilities?: Record<string, unknown>;
  providers?: string[];
  capabilities?: Record<string, CapabilityDescriptor>;
}

export interface UpstreamRegistryDeps {
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  writeFileSync?: typeof writeFileSync;
  renameSync?: typeof renameSync;
  fetch?: typeof fetch;
  now?: () => Date;
}

const defaultRoutePolicy = (): UpstreamRoutePolicy => ({
  personalMemoryRead: "disabled",
  teamWorkspaceRead: "disabled",
  shareGrantManagement: "disabled",
  captureWrites: "disabled",
  sync: "disabled",
  admin: "disabled"
});

const emptyCapabilityCache = (): UpstreamCapabilityCache => ({
  state: "not_checked",
  checkedAt: null,
  expiresAt: null,
  schemaVersion: null,
  profile: null,
  releaseVersion: null
});

const defaultRegistry = (now: string): UpstreamBackendRegistry => ({
  schemaVersion: 1,
  updatedAt: now,
  backends: []
});

const depsWithDefaults = (
  deps: UpstreamRegistryDeps = {}
): Required<UpstreamRegistryDeps> => ({
  existsSync: deps.existsSync ?? existsSync,
  readFileSync: deps.readFileSync ?? readFileSync,
  writeFileSync: deps.writeFileSync ?? writeFileSync,
  renameSync: deps.renameSync ?? renameSync,
  fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
  now: deps.now ?? (() => new Date())
});

const normalizeProfile = (
  value: string | undefined | null
): UpstreamDeploymentProfile | null => {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "local-personal") {
    return "local_personal";
  }
  if (trimmed === "private-vps" || trimmed === "self-hosted") {
    return "private_vps";
  }
  if (trimmed === "team-self-hosted") {
    return "team_self_hosted";
  }
  if (trimmed === "koed-managed-cloud" || trimmed === "cloud") {
    return "koed_managed_cloud";
  }
  if (
    trimmed === "developer" ||
    trimmed === "local_personal" ||
    trimmed === "private_vps" ||
    trimmed === "team_self_hosted" ||
    trimmed === "koed_managed_cloud"
  ) {
    return trimmed;
  }
  return null;
};

const normalizeBaseUrl = (value: string): string => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Upstream URL must use http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Upstream URL must not include credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      "Upstream URL must not include query strings or fragments."
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
};

const stableBackendId = (baseUrl: string): string =>
  `up_${createHash("sha256").update(baseUrl).digest("hex").slice(0, 16)}`;

const validateBackendId = (id: string): string => {
  const trimmed = id.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(trimmed)) {
    throw new Error(
      "Upstream backend id must be 2-64 characters of letters, numbers, hyphen, or underscore."
    );
  }
  return trimmed;
};

const readRegistry = (
  paths: KoedServerPaths,
  deps: Required<UpstreamRegistryDeps>
): UpstreamBackendRegistry => {
  const now = deps.now().toISOString();
  if (!deps.existsSync(paths.upstreamBackendsPath)) {
    return defaultRegistry(now);
  }
  try {
    const parsed = JSON.parse(
      deps.readFileSync(paths.upstreamBackendsPath, "utf8") as string
    ) as Partial<UpstreamBackendRegistry>;
    return {
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
      backends: Array.isArray(parsed.backends)
        ? parsed.backends.map((backend) => normalizeBackendRecord(backend, now))
        : []
    };
  } catch {
    throw new Error("Upstream backend registry is malformed.");
  }
};

const normalizeBackendRecord = (
  backend: Partial<UpstreamBackendRecord>,
  now: string
): UpstreamBackendRecord => {
  const baseUrl =
    typeof backend.baseUrl === "string"
      ? normalizeBaseUrl(backend.baseUrl)
      : "http://localhost";
  return {
    id:
      typeof backend.id === "string"
        ? validateBackendId(backend.id)
        : stableBackendId(baseUrl),
    displayName:
      typeof backend.displayName === "string" && backend.displayName.trim()
        ? backend.displayName.trim()
        : baseUrl,
    baseUrl,
    profile: normalizeProfile(backend.profile),
    createdAt: typeof backend.createdAt === "string" ? backend.createdAt : now,
    updatedAt: typeof backend.updatedAt === "string" ? backend.updatedAt : now,
    routePolicy: { ...defaultRoutePolicy(), ...backend.routePolicy },
    credential: sanitizeCredential(backend.credential),
    capabilities: sanitizeCapabilityCache(backend.capabilities)
  };
};

const sanitizeCredential = (
  credential: Partial<UpstreamCredentialStatus> | undefined
): UpstreamCredentialStatus => {
  const reference = sanitizeCredentialReference(credential?.reference);
  if (
    credential?.status === "configured" ||
    credential?.status === "revoked" ||
    credential?.status === "unknown"
  ) {
    return {
      status: credential.status,
      ...(reference ? { reference } : {})
    };
  }
  return { status: "not_configured" };
};

const sanitizeCredentialReference = (
  reference: string | undefined
): string | undefined => {
  const trimmed = reference?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed.length > 120 ||
    /[\s?#]/.test(trimmed) ||
    /(?:token|secret|password|bearer|cookie|authorization)/i.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
};

const sanitizeCapabilityCache = (
  cache: Partial<UpstreamCapabilityCache> | undefined
): UpstreamCapabilityCache => ({
  state:
    cache?.state === "validated" ||
    cache?.state === "stale" ||
    cache?.state === "failed"
      ? cache.state
      : "not_checked",
  checkedAt: typeof cache?.checkedAt === "string" ? cache.checkedAt : null,
  expiresAt: typeof cache?.expiresAt === "string" ? cache.expiresAt : null,
  schemaVersion:
    typeof cache?.schemaVersion === "number" ? cache.schemaVersion : null,
  profile: normalizeProfile(cache?.profile),
  releaseVersion:
    typeof cache?.releaseVersion === "string" ? cache.releaseVersion : null,
  ...(cache?.failureCategory ? { failureCategory: cache.failureCategory } : {}),
  ...(cache?.failureMessage
    ? { failureMessage: cache.failureMessage.slice(0, 240) }
    : {}),
  ...(cache?.payload ? { payload: cache.payload } : {})
});

const writeRegistry = (
  paths: KoedServerPaths,
  registry: UpstreamBackendRegistry,
  deps: Required<UpstreamRegistryDeps>
): void => {
  mkdirSync(dirname(paths.upstreamBackendsPath), {
    recursive: true,
    mode: 0o700
  });
  const tempPath = `${paths.upstreamBackendsPath}.tmp`;
  deps.writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600
  });
  deps.renameSync(tempPath, paths.upstreamBackendsPath);
};

const summarize = (backend: UpstreamBackendRecord): UpstreamBackendSummary => {
  const { payload: _payload, ...capabilities } = backend.capabilities;
  void _payload;
  return {
    id: backend.id,
    displayName: backend.displayName,
    baseUrl: backend.baseUrl,
    profile: backend.profile,
    routePolicy: backend.routePolicy,
    credential: backend.credential,
    capabilities
  };
};

export const listUpstreamBackends = (
  paths: KoedServerPaths,
  deps: UpstreamRegistryDeps = {}
): UpstreamRegistryResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = readRegistry(paths, resolvedDeps);
  return {
    ok: true,
    state: "listed",
    backends: registry.backends.map(summarize),
    message: `${registry.backends.length} upstream backend(s) registered.`
  };
};

export const registerUpstreamBackend = (
  paths: KoedServerPaths,
  input: {
    url: string;
    id?: string;
    displayName?: string;
    profile?: string;
  },
  deps: UpstreamRegistryDeps = {}
): UpstreamRegistryResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const now = resolvedDeps.now().toISOString();
  const baseUrl = normalizeBaseUrl(input.url);
  const id = input.id ? validateBackendId(input.id) : stableBackendId(baseUrl);
  const profile = normalizeProfile(input.profile);
  if (input.profile && !profile) {
    throw new Error(
      `Unsupported upstream deployment profile: ${input.profile}`
    );
  }
  const registry = readRegistry(paths, resolvedDeps);
  const existingIndex = registry.backends.findIndex(
    (backend) => backend.id === id || backend.baseUrl === baseUrl
  );
  const existing = registry.backends[existingIndex];
  const nextProfile = profile ?? existing?.profile ?? null;
  const trustBoundaryChanged = Boolean(
    existing &&
    (existing.id !== id ||
      existing.baseUrl !== baseUrl ||
      existing.profile !== nextProfile)
  );
  const record: UpstreamBackendRecord = existing
    ? {
        ...existing,
        id,
        baseUrl,
        displayName: input.displayName?.trim() || existing.displayName,
        profile: nextProfile,
        updatedAt: now,
        ...(trustBoundaryChanged
          ? {
              routePolicy: defaultRoutePolicy(),
              credential: { status: "not_configured" },
              capabilities: emptyCapabilityCache()
            }
          : {})
      }
    : {
        id,
        displayName: input.displayName?.trim() || baseUrl,
        baseUrl,
        profile,
        createdAt: now,
        updatedAt: now,
        routePolicy: defaultRoutePolicy(),
        credential: { status: "not_configured" },
        capabilities: emptyCapabilityCache()
      };

  if (existingIndex >= 0) {
    registry.backends[existingIndex] = record;
  } else {
    registry.backends.push(record);
  }
  registry.updatedAt = now;
  writeRegistry(paths, registry, resolvedDeps);
  return {
    ok: true,
    state: existing ? "updated" : "registered",
    backend: summarize(record),
    message: existing
      ? `Updated upstream backend ${record.id}.`
      : `Registered upstream backend ${record.id}.`
  };
};

export const removeUpstreamBackend = (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamRegistryDeps = {}
): UpstreamRegistryResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = readRegistry(paths, resolvedDeps);
  const backendId = validateBackendId(id);
  const nextBackends = registry.backends.filter(
    (backend) => backend.id !== backendId
  );
  if (nextBackends.length === registry.backends.length) {
    return {
      ok: true,
      state: "missing",
      message: `Upstream backend ${backendId} is not registered.`
    };
  }
  registry.backends = nextBackends;
  registry.updatedAt = resolvedDeps.now().toISOString();
  writeRegistry(paths, registry, resolvedDeps);
  return {
    ok: true,
    state: "removed",
    message: `Removed upstream backend ${backendId}.`
  };
};

const updateUpstreamBackend = (
  paths: KoedServerPaths,
  id: string,
  update: (
    backend: UpstreamBackendRecord,
    now: string
  ) => UpstreamBackendRecord,
  deps: UpstreamRegistryDeps = {}
): UpstreamRegistryResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = readRegistry(paths, resolvedDeps);
  const backendId = validateBackendId(id);
  const index = registry.backends.findIndex(
    (backend) => backend.id === backendId
  );
  if (index < 0) {
    return {
      ok: false,
      state: "missing",
      message: `Upstream backend ${backendId} is not registered.`
    };
  }

  const now = resolvedDeps.now().toISOString();
  const next = update(registry.backends[index]!, now);
  registry.backends[index] = next;
  registry.updatedAt = now;
  writeRegistry(paths, registry, resolvedDeps);
  return {
    ok: true,
    state: "updated",
    backend: summarize(next),
    message: `Updated upstream backend ${backendId}.`
  };
};

export const updateUpstreamBackendCredential = (
  paths: KoedServerPaths,
  id: string,
  credential: UpstreamCredentialStatus,
  deps: UpstreamRegistryDeps = {}
): UpstreamRegistryResult =>
  updateUpstreamBackend(
    paths,
    id,
    (backend, now) => ({
      ...backend,
      updatedAt: now,
      credential: sanitizeCredential(credential)
    }),
    deps
  );

export const updateUpstreamBackendRoutePolicy = (
  paths: KoedServerPaths,
  id: string,
  routePolicy: UpstreamRoutePolicyUpdate,
  deps: UpstreamRegistryDeps = {}
): UpstreamRegistryResult => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = readRegistry(paths, resolvedDeps);
  const backendId = validateBackendId(id);
  const index = registry.backends.findIndex(
    (backend) => backend.id === backendId
  );
  if (index < 0) {
    return {
      ok: false,
      state: "missing",
      message: `Upstream backend ${backendId} is not registered.`
    };
  }
  if (Object.keys(routePolicy).length === 0) {
    throw new Error("At least one route policy flag is required.");
  }

  const now = resolvedDeps.now().toISOString();
  const existing = registry.backends[index]!;
  const next: UpstreamBackendRecord = {
    ...existing,
    updatedAt: now,
    routePolicy: {
      ...existing.routePolicy,
      ...routePolicy
    }
  };
  registry.backends[index] = next;
  registry.updatedAt = now;
  writeRegistry(paths, registry, resolvedDeps);
  return {
    ok: true,
    state: "updated",
    backend: summarize(next),
    message: `Updated upstream backend ${backendId} route policy.`
  };
};

const sanitizeCapabilitiesPayload = (
  value: unknown
): SanitizedCapabilitiesPayload => {
  const payload = value as SanitizedCapabilitiesPayload;
  if (
    payload?.product !== "koed" ||
    payload.apiVersion !== "v1" ||
    typeof payload.capabilitySchemaVersion !== "number"
  ) {
    throw new Error("Capability response is not a Koed v1 capability payload.");
  }
  if (![2, 3].includes(payload.capabilitySchemaVersion)) {
    throw new Error(
      `Unsupported capability schema version ${payload.capabilitySchemaVersion}.`
    );
  }
  return {
    product: "koed",
    apiVersion: "v1",
    capabilitySchemaVersion: payload.capabilitySchemaVersion,
    ...(typeof payload.releaseVersion === "string"
      ? { releaseVersion: payload.releaseVersion.slice(0, 80) }
      : {}),
    ...(payload.audience === "public" || payload.audience === "authenticated"
      ? { audience: payload.audience }
      : {}),
    ...(payload.deployment
      ? { deployment: redactCapabilityObject(payload.deployment) }
      : {}),
    ...(payload.runtime
      ? { runtime: redactCapabilityObject(payload.runtime) }
      : {}),
    ...(payload.auth ? { auth: redactCapabilityObject(payload.auth) } : {}),
    ...(payload.memory
      ? { memory: redactCapabilityObject(payload.memory) }
      : {}),
    ...(payload.commercial
      ? { commercial: redactCapabilityObject(payload.commercial) }
      : {}),
    ...(payload.security
      ? { security: redactCapabilityObject(payload.security) }
      : {}),
    ...(payload.authenticatedCapabilities
      ? {
          authenticatedCapabilities: redactCapabilityObject(
            payload.authenticatedCapabilities
          )
        }
      : {}),
    ...(Array.isArray(payload.providers)
      ? { providers: payload.providers }
      : {}),
    ...(payload.capabilities
      ? {
          capabilities: redactCapabilityObject(payload.capabilities) as Record<
            string,
            CapabilityDescriptor
          >
        }
      : {})
  };
};

const secretCapabilityKeyParts = [
  "token",
  "secret",
  "password",
  "cookie",
  "authorization",
  "apikey",
  "privatekey",
  "clientsecret",
  "verifierhash",
  "challengehash"
];

const isSecretCapabilityKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return secretCapabilityKeyParts.some((part) => normalized.includes(part));
};

const redactCapabilityObject = (
  value: Record<string, unknown>
): Record<string, unknown> =>
  redactCapabilitySecrets(value) as Record<string, unknown>;

const redactCapabilitySecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => redactCapabilitySecrets(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSecretCapabilityKey(key) ? "[redacted]" : redactCapabilitySecrets(entry)
    ])
  );
};

const capabilityExpiresAt = (checkedAt: Date): string =>
  new Date(checkedAt.getTime() + 15 * 60 * 1000).toISOString();

export const refreshUpstreamBackendCapabilities = async (
  paths: KoedServerPaths,
  id: string,
  deps: UpstreamRegistryDeps = {}
): Promise<UpstreamRegistryResult> => {
  const resolvedDeps = depsWithDefaults(deps);
  const registry = readRegistry(paths, resolvedDeps);
  const backendId = validateBackendId(id);
  const index = registry.backends.findIndex(
    (backend) => backend.id === backendId
  );
  const backend = registry.backends[index];
  if (!backend) {
    return {
      ok: false,
      state: "missing",
      message: `Upstream backend ${backendId} is not registered.`
    };
  }

  const attemptedAt = resolvedDeps.now();
  try {
    const response = await resolvedDeps.fetch(
      new URL("v1/capabilities", `${backend.baseUrl}/`)
    );
    if (!response.ok) {
      throw Object.assign(
        new Error(`Capability refresh failed with HTTP ${response.status}.`),
        {
          category: "http" as UpstreamFailureCategory
        }
      );
    }
    const payload = sanitizeCapabilitiesPayload(await response.json());
    const profile = normalizeProfile(payload.deployment?.profile);
    const refreshed: UpstreamBackendRecord = {
      ...backend,
      profile: profile ?? backend.profile,
      updatedAt: attemptedAt.toISOString(),
      capabilities: {
        state: "validated",
        checkedAt: attemptedAt.toISOString(),
        expiresAt: capabilityExpiresAt(attemptedAt),
        schemaVersion: payload.capabilitySchemaVersion,
        profile: profile ?? null,
        releaseVersion: payload.releaseVersion ?? null,
        payload
      }
    };
    registry.backends[index] = refreshed;
    registry.updatedAt = attemptedAt.toISOString();
    writeRegistry(paths, registry, resolvedDeps);
    return {
      ok: true,
      state: "validated",
      backend: summarize(refreshed),
      message: `Validated upstream backend ${backendId}.`
    };
  } catch (error) {
    const category =
      typeof error === "object" &&
      error !== null &&
      "category" in error &&
      typeof error.category === "string"
        ? (error.category as UpstreamFailureCategory)
        : error instanceof TypeError
          ? "network"
          : error instanceof SyntaxError
            ? "invalid_capabilities"
            : error instanceof Error &&
                error.message.startsWith("Unsupported capability schema")
              ? "unsupported_schema"
              : "unexpected";
    const failed: UpstreamBackendRecord = {
      ...backend,
      updatedAt: attemptedAt.toISOString(),
      capabilities: {
        ...backend.capabilities,
        state: "failed",
        checkedAt: attemptedAt.toISOString(),
        failureCategory: category,
        failureMessage:
          error instanceof Error ? error.message.slice(0, 240) : String(error)
      }
    };
    registry.backends[index] = failed;
    registry.updatedAt = attemptedAt.toISOString();
    writeRegistry(paths, registry, resolvedDeps);
    return {
      ok: false,
      state: "failed",
      backend: summarize(failed),
      message: `Failed to validate upstream backend ${backendId}.`
    };
  }
};

export const collectUpstreamRegistryStatus = (
  paths: KoedServerPaths,
  deps: UpstreamRegistryDeps = {}
): {
  registered: number;
  validated: number;
  stale: number;
  failed: number;
  notChecked: number;
  parseError?: string;
  backends: UpstreamBackendSummary[];
} => {
  const resolvedDeps = depsWithDefaults(deps);
  let registry: UpstreamBackendRegistry;
  try {
    registry = readRegistry(paths, resolvedDeps);
  } catch (error) {
    return {
      registered: 0,
      validated: 0,
      stale: 0,
      failed: 0,
      notChecked: 0,
      parseError:
        error instanceof Error
          ? error.message
          : "Upstream backend registry is malformed.",
      backends: []
    };
  }
  const now = resolvedDeps.now().getTime();
  const backends = registry.backends.map((backend) => {
    const expired =
      backend.capabilities.state === "validated" &&
      backend.capabilities.expiresAt &&
      Date.parse(backend.capabilities.expiresAt) <= now;
    return summarize(
      expired
        ? {
            ...backend,
            capabilities: { ...backend.capabilities, state: "stale" }
          }
        : backend
    );
  });
  return {
    registered: backends.length,
    validated: backends.filter(
      (backend) => backend.capabilities.state === "validated"
    ).length,
    stale: backends.filter((backend) => backend.capabilities.state === "stale")
      .length,
    failed: backends.filter(
      (backend) => backend.capabilities.state === "failed"
    ).length,
    notChecked: backends.filter(
      (backend) => backend.capabilities.state === "not_checked"
    ).length,
    backends
  };
};
