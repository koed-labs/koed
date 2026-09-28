import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  readLocalEdgeUpstreamRegistry,
  sanitizeAiClientDiagnostics,
  readLocalEdgeClientCredentialAuthorization,
  type LocalEdgeUpstreamBackend,
  type AiClientCapabilityDescriptor
} from "@koed/shared";
import {
  aiClientDiscoveryError,
  aiClientDriverFor,
  type AiClientDriverDiscovery
} from "./ai-client-runner.js";
import {
  environmentForLocalAiClientInstance,
  loadLocalAiClientInstanceRegistry,
  localAiClientInstanceConfigIdentity,
  type LocalAiClientInstanceConfiguration
} from "./ai-client-instance-registry.js";
import type { MemoryApiClient } from "./index.js";
import { resolveKoedHome } from "./local-runtime-protocol.js";

const positiveInteger = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_SNAPSHOT_TTL_MS = 10 * 60_000;
const HOSTED_CAPABILITY_OPERATION_FAMILY = "ai_client_capability_publish";
const upstreamCapabilityRefreshes = new Map<string, Promise<boolean>>();
const execFileAsync = promisify(execFile);

type UpstreamCapabilityRefresher = (
  backendId: string,
  environment: NodeJS.ProcessEnv
) => Promise<boolean>;

const refreshUpstreamCapabilitiesWithServerCli: UpstreamCapabilityRefresher =
  async (backendId, environment) => {
    const serverCliPath = environment.KOED_SERVER_CLI_PATH?.trim();
    if (!serverCliPath) return false;
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [serverCliPath, "upstream", "refresh", "--id", backendId, "--json"],
        {
          env: environment,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 1024 * 1024
        }
      );
      const result = JSON.parse(stdout) as {
        ok?: unknown;
        state?: unknown;
      };
      return result.ok === true && result.state === "validated";
    } catch {
      // CLI stderr may contain upstream details, so keep it out of status/logs.
      return false;
    }
  };

const upstreamCapabilitiesAreFresh = (
  backend: LocalEdgeUpstreamBackend,
  now = Date.now()
): boolean => {
  if (backend.capabilities?.state !== "validated") return false;
  const expiresAt = backend.capabilities.expiresAt;
  return !expiresAt || Date.parse(expiresAt) > now;
};

const ensureUpstreamCapabilitiesFresh = async (
  backend: LocalEdgeUpstreamBackend,
  environment: NodeJS.ProcessEnv,
  refresh: UpstreamCapabilityRefresher
): Promise<boolean> => {
  if (upstreamCapabilitiesAreFresh(backend)) return true;
  const key = `${resolveKoedHome(environment)}\0${backend.id}`;
  const existing = upstreamCapabilityRefreshes.get(key);
  if (existing) return existing;
  const pending = refresh(backend.id, environment).catch(() => false);
  upstreamCapabilityRefreshes.set(key, pending);
  try {
    return await pending;
  } finally {
    if (upstreamCapabilityRefreshes.get(key) === pending) {
      upstreamCapabilityRefreshes.delete(key);
    }
  }
};

export interface AiClientCapabilityPublication {
  instanceId: string;
  driverId: string;
  published: boolean;
  error: string | null;
  hostedPublication: "not_configured" | "published" | "failed";
}

export interface AiClientCapabilityPublisherHandle {
  refresh(): Promise<AiClientCapabilityPublication[]>;
  stop(): void;
}

const instancesFor = (
  environment: NodeJS.ProcessEnv
): LocalAiClientInstanceConfiguration[] =>
  loadLocalAiClientInstanceRegistry(environment).instances;

const capabilitiesRecord = (
  capabilities: AiClientCapabilityDescriptor[]
): Record<string, unknown> =>
  Object.fromEntries(
    capabilities.map((descriptor) => [descriptor.id, descriptor])
  );

const sameRegistryIdentity = (
  left: LocalAiClientInstanceConfiguration,
  right: LocalAiClientInstanceConfiguration
): boolean => {
  if (left.configurationError || right.configurationError) {
    return (
      left.configurationError === right.configurationError &&
      left.instanceId === right.instanceId &&
      left.driverId === right.driverId &&
      left.executablePath === right.executablePath &&
      left.configHome === right.configHome
    );
  }
  return (
    localAiClientInstanceConfigIdentity(left) ===
    localAiClientInstanceConfigIdentity(right)
  );
};

const combinedIdentityHash = (input: {
  installationIdentityHash: string;
  configIdentityHash: string | null;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        installationIdentityHash: input.installationIdentityHash,
        configIdentityHash: input.configIdentityHash
      })
    )
    .digest("hex");

const publishDiscovery = async (
  apiClient: MemoryApiClient,
  instance: LocalAiClientInstanceConfiguration,
  discovery: AiClientDriverDiscovery,
  environment: NodeJS.ProcessEnv,
  now: Date,
  ttlMs: number,
  refreshUpstream: UpstreamCapabilityRefresher
): Promise<AiClientCapabilityPublication["hostedPublication"]> => {
  const sanitizedDiagnostics = sanitizeAiClientDiagnostics(
    discovery.diagnostics
  );
  const sanitizedCapabilities = discovery.capabilities.map((descriptor) => ({
    ...descriptor,
    diagnostics: sanitizeAiClientDiagnostics(descriptor.diagnostics)
  }));
  const configIdentityHash = instance.configurationError
    ? null
    : localAiClientInstanceConfigIdentity(instance);
  const identityHash = combinedIdentityHash({
    installationIdentityHash: discovery.installationIdentityHash,
    configIdentityHash
  });
  await apiClient.upsertAiClientInstance(instance.instanceId, {
    driver_id: instance.driverId,
    display_name: instance.displayName,
    config_identity_hash: identityHash
  });
  await apiClient.recordAiClientCapabilitySnapshot(instance.instanceId, {
    installation_identity_hash: identityHash,
    client_version: discovery.clientVersion,
    authentication_state: discovery.authenticationState,
    health_state: discovery.healthState,
    models: discovery.models.map((model) => ({
      id: model.id,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.model ? { model: model.model } : {}),
      ...(model.fullId ? { fullId: model.fullId } : {}),
      provenance: model.provenance,
      ...(model.supportedReasoningEfforts
        ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
        : {})
    })),
    capabilities: {
      descriptors: capabilitiesRecord(sanitizedCapabilities),
      diagnostics: sanitizedDiagnostics
    },
    observed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString()
  });

  const koedHome = resolveKoedHome(environment);
  let upstreamBackendId: string | null = null;
  let activeUpstreamBackend: LocalEdgeUpstreamBackend | null = null;
  try {
    const registry = readLocalEdgeUpstreamRegistry(
      resolve(koedHome, "config", "upstream-backends.json")
    );
    const active = registry.backends.find(
      (backend) => backend.id === registry.activeBackendId
    );
    if (active?.routePolicy.managedExecution === "enabled") {
      activeUpstreamBackend = active;
      upstreamBackendId = active.id;
    }
  } catch {
    // A broken or unreadable registry must stop hosted publication. It must
    // never reuse an earlier backend selection.
    return "not_configured";
  }
  let localEdgeCredential: ReturnType<
    typeof readLocalEdgeClientCredentialAuthorization
  > = null;
  try {
    localEdgeCredential = upstreamBackendId
      ? readLocalEdgeClientCredentialAuthorization(koedHome, upstreamBackendId)
      : null;
  } catch {
    return "not_configured";
  }
  if (
    !upstreamBackendId ||
    !activeUpstreamBackend ||
    !localEdgeCredential?.operationFamilies.includes(
      HOSTED_CAPABILITY_OPERATION_FAMILY
    )
  ) {
    return "not_configured";
  }
  if (
    !(await ensureUpstreamCapabilitiesFresh(
      activeUpstreamBackend,
      environment,
      refreshUpstream
    ))
  ) {
    return "failed";
  }
  try {
    const refreshedRegistry = readLocalEdgeUpstreamRegistry(
      resolve(koedHome, "config", "upstream-backends.json")
    );
    const refreshedActive = refreshedRegistry.backends.find(
      (backend) => backend.id === refreshedRegistry.activeBackendId
    );
    const refreshedCredential = readLocalEdgeClientCredentialAuthorization(
      koedHome,
      upstreamBackendId
    );
    if (
      refreshedActive?.id !== upstreamBackendId ||
      refreshedActive.routePolicy.managedExecution !== "enabled" ||
      !refreshedCredential?.operationFamilies.includes(
        HOSTED_CAPABILITY_OPERATION_FAMILY
      )
    ) {
      return "not_configured";
    }
  } catch {
    return "not_configured";
  }

  // Do not send local paths, configuration identities, or machine labels to the
  // hosted registry. The hosted identity is namespaced by the authenticated
  // device credential at the API boundary. This digest changes with local
  // installation/configuration changes without exposing either source hash.
  const hostedIdentityHash = createHash("sha256")
    .update(`hosted-ai-client-v1\0${identityHash}`)
    .digest("hex");
  const safeHostedInstance = {
    driver_id: instance.driverId,
    display_name: instance.driverId,
    config_identity_hash: hostedIdentityHash
  };
  const safeHostedDescriptors = discovery.capabilities.map((descriptor) => ({
    id: descriptor.id,
    support: descriptor.support,
    readiness: descriptor.readiness,
    diagnostics: sanitizeAiClientDiagnostics(descriptor.diagnostics),
    ...(descriptor.recoveryAction
      ? {
          recoveryAction: {
            id: descriptor.recoveryAction.id,
            label: descriptor.recoveryAction.label,
            available: descriptor.recoveryAction.available
          }
        }
      : {})
  }));
  const safeHostedSnapshot = {
    installation_identity_hash: hostedIdentityHash,
    client_version: discovery.clientVersion,
    authentication_state: discovery.authenticationState,
    health_state: discovery.healthState,
    models: discovery.models.map((model) => ({
      id: model.id,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.model ? { model: model.model } : {}),
      ...(model.fullId ? { fullId: model.fullId } : {}),
      provenance: model.provenance,
      ...(model.supportedReasoningEfforts
        ? { supportedReasoningEfforts: model.supportedReasoningEfforts }
        : {})
    })),
    capabilities: {
      descriptors: capabilitiesRecord(safeHostedDescriptors),
      diagnostics: sanitizedDiagnostics
    },
    observed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString()
  };
  try {
    await apiClient.publishAiClientUpstreamOperation(
      upstreamBackendId,
      localEdgeCredential.authorization,
      {
        method: "PUT",
        path: `/v1/memory/ai-client-instances/${encodeURIComponent(instance.instanceId)}`,
        body: safeHostedInstance
      }
    );
    await apiClient.publishAiClientUpstreamOperation(
      upstreamBackendId,
      localEdgeCredential.authorization,
      {
        method: "POST",
        path: `/v1/memory/ai-client-instances/${encodeURIComponent(instance.instanceId)}/capability-snapshots`,
        body: safeHostedSnapshot
      }
    );
    return "published";
  } catch {
    return "failed";
  }
};

const discoverInstance = async (
  instance: LocalAiClientInstanceConfiguration,
  environment: NodeJS.ProcessEnv
): Promise<AiClientDriverDiscovery> => {
  const driver = aiClientDriverFor(instance.driverId);
  const instanceEnvironment = environmentForLocalAiClientInstance({
    instance: instance.configurationError ? null : instance,
    driverId: instance.driverId,
    env: environment
  });
  if (instance.configurationError) {
    return aiClientDiscoveryError(
      {
        instanceId: instance.instanceId,
        environment: instanceEnvironment,
        executablePath: instance.executablePath || instance.instanceId
      },
      driver.id,
      new Error(instance.configurationError)
    );
  }
  try {
    return await driver.discover({
      instanceId: instance.instanceId,
      environment: instanceEnvironment,
      executablePath: instance.executablePath
    });
  } catch (error) {
    return aiClientDiscoveryError(
      {
        instanceId: instance.instanceId,
        environment: instanceEnvironment,
        executablePath: instance.executablePath
      },
      driver.id,
      error
    );
  }
};

export const publishAiClientCapabilities = async (
  apiClient: MemoryApiClient,
  environment: NodeJS.ProcessEnv = process.env,
  options: {
    now?: () => Date;
    snapshotTtlMs?: number;
    isActive?: () => boolean;
    refreshUpstreamCapabilities?: UpstreamCapabilityRefresher;
  } = {}
): Promise<AiClientCapabilityPublication[]> => {
  const now = (options.now ?? (() => new Date()))();
  const ttlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const publishInstance = async (
    instance: LocalAiClientInstanceConfiguration
  ): Promise<AiClientCapabilityPublication | null> => {
    if (options.isActive && !options.isActive()) return null;
    try {
      const discovery = await discoverInstance(instance, environment);
      if (options.isActive && !options.isActive()) return null;
      const current = instancesFor(environment).find(
        (candidate) => candidate.instanceId === instance.instanceId
      );
      if (!current || !sameRegistryIdentity(instance, current)) {
        throw new Error(
          `AI Client instance "${instance.instanceId}" changed during capability discovery`
        );
      }
      const hostedPublication = await publishDiscovery(
        apiClient,
        instance,
        discovery,
        environment,
        now,
        ttlMs,
        options.refreshUpstreamCapabilities ??
          refreshUpstreamCapabilitiesWithServerCli
      );
      return {
        instanceId: instance.instanceId,
        driverId: instance.driverId,
        published: true,
        error: instance.configurationError ?? null,
        hostedPublication
      };
    } catch (error) {
      return {
        instanceId: instance.instanceId,
        driverId: instance.driverId,
        published: false,
        error: error instanceof Error ? error.message : String(error),
        hostedPublication: "not_configured"
      };
    }
  };
  const results: AiClientCapabilityPublication[] = [];
  const instances = instancesFor(environment);
  // Limit concurrent CLI discovery while keeping independent clients off each other's critical path.
  for (let offset = 0; offset < instances.length; offset += 3) {
    if (options.isActive && !options.isActive()) break;
    const batch = await Promise.all(
      instances.slice(offset, offset + 3).map(publishInstance)
    );
    for (const publication of batch) if (publication) results.push(publication);
  }
  return results;
};

export const startAiClientCapabilityPublisher = (
  apiClient: MemoryApiClient,
  environment: NodeJS.ProcessEnv = process.env
): AiClientCapabilityPublisherHandle => {
  const refreshMs = positiveInteger(
    environment.KOED_AI_CLIENT_CAPABILITY_REFRESH_MS,
    DEFAULT_REFRESH_MS
  );
  let stopped = false;
  let refreshing: Promise<AiClientCapabilityPublication[]> | undefined;
  const refresh = (): Promise<AiClientCapabilityPublication[]> => {
    if (stopped) return Promise.resolve([]);
    if (refreshing) return refreshing;
    refreshing = publishAiClientCapabilities(apiClient, environment, {
      isActive: () => !stopped
    }).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const timer = setInterval(() => {
    void refresh().catch((error) => {
      if (stopped) return;
      process.emitWarning(
        error instanceof Error ? error.message : String(error),
        "KoedAiClientCapabilityRefresh"
      );
    });
  }, refreshMs);
  timer.unref?.();
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    }
  };
};
