import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { MemorySourceRepository } from "@koed/db";
import {
  discoverConfiguredAiClientResources,
  loadLocalAiClientInstanceRegistry,
  type LocalAiClientInstanceConfiguration
} from "@koed/mcp-server";
import type { AiClientResourceDiscoveryRunnerClaim } from "@koed/shared";
import type { AiClientResourceRunnerAuthority } from "./ai-client-resource-authority-client.js";

const pollMs = 1_500;
const leaseMs = 90_000;
const validProjectId = /^lp_[0-9a-f]{32}$/iu;

const resolveProjectPath = async (
  koedHome: string,
  projectId: string | null
): Promise<string | null> => {
  if (projectId === null) return null;
  if (!validProjectId.test(projectId))
    throw new Error("AiClientResourceProjectUnavailable");
  const home = await realpath(koedHome).catch(() => null);
  const catalogPath = resolve(koedHome, "config", "projects.json");
  const canonicalCatalog = await realpath(catalogPath).catch(() => null);
  const metadata = await lstat(catalogPath).catch(() => null);
  if (
    !home ||
    !canonicalCatalog ||
    !canonicalCatalog.startsWith(`${home}${sep}`) ||
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 4 * 1024 * 1024
  )
    throw new Error("AiClientResourceProjectUnavailable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonicalCatalog, "utf8"));
  } catch {
    throw new Error("AiClientResourceProjectUnavailable");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("AiClientResourceProjectUnavailable");
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== 3 || !Array.isArray(root.projects))
    throw new Error("AiClientResourceProjectUnavailable");
  const matches = root.projects.filter(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).localProjectId === projectId
  );
  if (matches.length !== 1)
    throw new Error("AiClientResourceProjectUnavailable");
  const candidate = matches[0] as Record<string, unknown>;
  const location = candidate.path;
  if (!location || typeof location !== "object" || Array.isArray(location))
    throw new Error("AiClientResourceProjectUnavailable");
  const paths = location as Record<string, unknown>;
  const selectedPath =
    typeof paths.projectRoot === "string" ? paths.projectRoot : paths.cwd;
  if (typeof selectedPath !== "string" || !isAbsolute(selectedPath))
    throw new Error("AiClientResourceProjectUnavailable");
  const canonicalPath = await realpath(selectedPath).catch(() => null);
  const projectStat = canonicalPath
    ? await lstat(canonicalPath).catch(() => null)
    : null;
  if (
    !canonicalPath ||
    !projectStat?.isDirectory() ||
    projectStat.isSymbolicLink()
  )
    throw new Error("AiClientResourceProjectUnavailable");
  return canonicalPath;
};

const safeFailureCode = (error: unknown): string => {
  const candidate = error instanceof Error ? error.message : "";
  const allowed = new Set([
    "AiClientResourceProjectUnavailable",
    "AiClientResourceTargetScopeMismatch",
    "AiClientConfigurationUnavailable",
    "AiClientExecutableUnavailable",
    "AiClientProviderUnsupported",
    "AiClientResourceOwnerInvalid",
    "AiClientCodexAuthenticationRequired",
    "AiClientCodexVersionUnsupported",
    "AiClientCodexUnavailable",
    "AiClientClaudeAuthenticationRequired",
    "AiClientClaudeVersionUnsupported",
    "AiClientClaudeUnavailable",
    "AiClientPiAuthenticationRequired",
    "AiClientPiVersionUnsupported",
    "AiClientPiUnavailable",
    "AiClientResourceDiscoveryTimedOut",
    "AiClientResourceLeaseLost"
  ]);
  return allowed.has(candidate)
    ? candidate
    : "AiClientResourceDiscoveryUnavailable";
};

export interface AiClientResourceRunner {
  start(): void;
  stop(): Promise<void>;
}

export const createAiClientResourceRunner = (options: {
  authority: AiClientResourceRunnerAuthority;
  repository: MemorySourceRepository;
  localOwnerUserId: string;
  deviceId: string;
  deploymentId: string;
  koedHome: string;
  loadRegistry?: () => { instances: LocalAiClientInstanceConfiguration[] };
  discoverResources?: typeof discoverConfiguredAiClientResources;
  discoveryTimeoutMs?: number;
  /** Test seam for lease behavior; production uses the 90s default. */
  leaseMs?: number;
  /** Test seam for lease behavior; production uses a 20s interval. */
  heartbeatIntervalMs?: number;
  onError?: (code: string) => void;
}): AiClientResourceRunner => {
  const runnerDeviceKey = createHash("sha256")
    .update(options.deviceId)
    .digest("hex")
    .slice(0, 16);
  const runnerId = `ai-resource:${runnerDeviceKey}:${randomUUID()}`;
  const loadRegistry =
    options.loadRegistry ??
    (() =>
      loadLocalAiClientInstanceRegistry({
        KOED_HOME: options.koedHome
      }));
  const discoverResources =
    options.discoverResources ?? discoverConfiguredAiClientResources;
  const discoveryTimeoutMs = Math.min(
    75_000,
    Math.max(1_000, options.discoveryTimeoutMs ?? 60_000)
  );
  const activeLeaseMs = Math.min(
    5 * 60_000,
    Math.max(1_000, options.leaseMs ?? leaseMs)
  );
  const heartbeatIntervalMs = Math.min(
    Math.floor(activeLeaseMs / 2),
    Math.max(250, options.heartbeatIntervalMs ?? 20_000)
  );
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let current: Promise<void> | null = null;

  const runClaim = async (
    claim: AiClientResourceDiscoveryRunnerClaim
  ): Promise<void> => {
    let leaseLost = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();
    const scheduleHeartbeat = () => {
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = null;
        void options.authority
          .heartbeat(claim, runnerId, activeLeaseMs)
          .then((accepted) => {
            if (!accepted) {
              leaseLost = true;
              abortController.abort();
              return;
            }
            if (!leaseLost && !stopped) scheduleHeartbeat();
          })
          .catch(() => {
            leaseLost = true;
            abortController.abort();
          });
      }, heartbeatIntervalMs);
    };
    scheduleHeartbeat();
    try {
      if (
        claim.ownerUserId !== options.localOwnerUserId ||
        claim.targetDeviceId !== options.deviceId ||
        claim.targetDeploymentId !== options.deploymentId
      )
        throw new Error("AiClientResourceTargetScopeMismatch");
      const matches = loadRegistry().instances.filter(
        (instance) =>
          instance.instanceId === claim.aiClientInstanceId &&
          instance.driverId === claim.provider
      );
      if (matches.length !== 1)
        throw new Error("AiClientConfigurationUnavailable");
      const projectPath = await resolveProjectPath(
        options.koedHome,
        claim.projectId
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        discoveryTimer = setTimeout(() => {
          abortController.abort();
          reject(new Error("AiClientResourceDiscoveryTimedOut"));
        }, discoveryTimeoutMs);
      });
      const catalog = await Promise.race([
        discoverResources({
          instance: matches[0]!,
          ownerUserId: claim.ownerUserId,
          hostedInstanceId: claim.hostedInstanceId,
          computerLabel: claim.computerLabel,
          projectId: claim.projectId,
          projectPath,
          signal: abortController.signal
        }),
        timeoutPromise
      ]);
      if (leaseLost) throw new Error("AiClientResourceLeaseLost");
      await options.authority.complete(claim, runnerId, catalog);
    } catch (error) {
      const errorCode = safeFailureCode(error);
      options.onError?.(errorCode);
      try {
        await options.authority.fail(claim, runnerId, errorCode);
      } catch (settleError) {
        options.onError?.(safeFailureCode(settleError));
      }
    } finally {
      if (heartbeatTimer) clearTimeout(heartbeatTimer);
      if (discoveryTimer) clearTimeout(discoveryTimer);
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const claims = await options.authority.claim({
        runnerId,
        limit: 1,
        leaseMs: activeLeaseMs
      });
      for (const claim of claims) {
        if (stopped) break;
        await runClaim(claim);
      }
    } catch (error) {
      options.onError?.(safeFailureCode(error));
    } finally {
      if (!stopped)
        timer = setTimeout(() => {
          current = poll();
        }, pollMs);
    }
  };

  return {
    start() {
      stopped = false;
      if (!stopped && !timer && !current) current = poll();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await current?.catch(() => undefined);
      current = null;
    }
  };
};
