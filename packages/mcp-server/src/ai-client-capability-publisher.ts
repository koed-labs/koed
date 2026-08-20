import { createHash } from "node:crypto";

import {
  sanitizeAiClientDiagnostics,
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

const positiveInteger = (
  value: string | undefined,
  fallback: number
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const DEFAULT_REFRESH_MS = 5 * 60_000;
const DEFAULT_SNAPSHOT_TTL_MS = 10 * 60_000;

export interface AiClientCapabilityPublication {
  instanceId: string;
  driverId: string;
  published: boolean;
  error: string | null;
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
  now: Date,
  ttlMs: number
): Promise<void> => {
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
    models: discovery.models,
    capabilities: {
      descriptors: capabilitiesRecord(sanitizedCapabilities),
      diagnostics: sanitizedDiagnostics
    },
    observed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString()
  });
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
  } = {}
): Promise<AiClientCapabilityPublication[]> => {
  const now = (options.now ?? (() => new Date()))();
  const ttlMs = options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS;
  const results: AiClientCapabilityPublication[] = [];
  for (const instance of instancesFor(environment)) {
    if (options.isActive && !options.isActive()) break;
    try {
      const discovery = await discoverInstance(instance, environment);
      if (options.isActive && !options.isActive()) break;
      const current = instancesFor(environment).find(
        (candidate) => candidate.instanceId === instance.instanceId
      );
      if (!current || !sameRegistryIdentity(instance, current)) {
        throw new Error(
          `AI Client instance "${instance.instanceId}" changed during capability discovery`
        );
      }
      await publishDiscovery(apiClient, instance, discovery, now, ttlMs);
      results.push({
        instanceId: instance.instanceId,
        driverId: instance.driverId,
        published: true,
        error: instance.configurationError ?? null
      });
    } catch (error) {
      results.push({
        instanceId: instance.instanceId,
        driverId: instance.driverId,
        published: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
