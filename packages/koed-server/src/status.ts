import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { resolveKoedServerConfig } from "./config.js";
import { resolveActiveIntegrationApiToken } from "./credentials.js";
import { loadRepoEnv, resolveApiUrl } from "./env-file.js";
import { resolveKoedAppRuntime } from "./app-runtime.js";
import { parseCodexOwnershipBlock } from "./codex-ownership-marker.js";
import { collectLocalEmbeddingRuntimeStatus } from "./local-embedding-runtime.js";
import { collectLocalPostgresRuntimeStatus } from "./local-postgres-runtime.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import { applyPersistedLocalPorts } from "./ports.js";
import { isProcessRunning } from "./process-liveness.js";
import { inspectDeviceIdentityStatus } from "./device-identity.js";
import { collectUpstreamRegistryStatus } from "./upstream-registry.js";
import {
  isSupportedPiVersion,
  MINIMUM_PI_VERSION,
  piSetupInvocation,
  piModelIdsFromListOutput,
  piSetupEnvironment,
  resolvePiSetupExecutable
} from "./pi-setup.js";
import {
  CLAUDE_HOOK_EVENTS,
  claudeMcpEntryIsKoedOwned,
  claudeProcessEnvironment,
  hasClaudeKoedHook,
  isSupportedClaudeCodeVersion,
  MINIMUM_CLAUDE_CODE_VERSION,
  resolveClaudeSettingsPath
} from "./claude-setup.js";
import { aiClientReadinessUnknown } from "./types.js";
import {
  codeDefaultAssignmentFor,
  documentDefault,
  environmentDefaultFor,
  localAiClientFlowKeys,
  type AiClientCapabilityDescriptor,
  type LocalAiClientDefault,
  type LocalAiClientFlowKey,
  type LocalAiClientRuntimeAssignment
} from "@koed/shared";
import type {
  KoedServerComponentState,
  KoedServerComponentStatus,
  KoedServerDoctorCheck,
  KoedServerDoctorResult,
  KoedServerRuntimeState,
  KoedServerStatus,
  KoedAiClientFlowReadiness,
  KoedAiClientReadiness
} from "./types.js";

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

const resolveWorkQueueBackend = (
  value: string | undefined
): "bullmq" | "local" => (value?.trim() === "local" ? "local" : "bullmq");

const resolveEffectiveWorkQueueBackend = (
  dependencyMode: "bundled-local" | "external",
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): "bullmq" | "local" => {
  if (environment.WORK_QUEUE_BACKEND) {
    return resolveWorkQueueBackend(environment.WORK_QUEUE_BACKEND);
  }
  if (dependencyMode === "bundled-local") {
    return "local";
  }
  return resolveWorkQueueBackend(repoEnv.WORK_QUEUE_BACKEND);
};

export interface KoedServerStatusDependencies {
  fetch?: typeof fetch;
  spawnSync?: SpawnSyncLike;
  existsSync?: typeof existsSync;
  readFileSync?: typeof readFileSync;
  resolvePiExecutable?: typeof resolvePiSetupExecutable;
  checkPid?: (pid: number) => boolean;
  now?: () => Date;
}

const defaultDependencies = (): Required<KoedServerStatusDependencies> => ({
  fetch: globalThis.fetch.bind(globalThis),
  spawnSync: nodeSpawnSync as SpawnSyncLike,
  existsSync,
  readFileSync,
  resolvePiExecutable: resolvePiSetupExecutable,
  checkPid: isProcessRunning,
  now: () => new Date()
});

const withDefaults = (
  dependencies: KoedServerStatusDependencies = {}
): Required<KoedServerStatusDependencies> => ({
  ...defaultDependencies(),
  ...dependencies
});

export const needsAttention = (
  message: string,
  action?: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "needs_attention",
  message,
  ...(action ? { action } : {}),
  ...(details ? { details } : {})
});

export const healthy = (
  message?: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "healthy",
  ...(message ? { message } : {}),
  ...(details ? { details } : {})
});

export const notConfigured = (
  message: string,
  action?: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "not_configured",
  message,
  ...(action ? { action } : {}),
  ...(details ? { details } : {})
});

export const starting = (
  message: string,
  details?: Record<string, unknown>
): KoedServerComponentStatus => ({
  state: "starting",
  message,
  ...(details ? { details } : {})
});

const readJsonFile = <T>(
  path: string,
  reader: typeof readFileSync = readFileSync
): T | null => {
  try {
    return JSON.parse(reader(path, "utf8") as string) as T;
  } catch {
    return null;
  }
};

export const inspectPi = (
  environment: NodeJS.ProcessEnv,
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
): KoedServerStatus["pi"] => {
  const packagePath = resolve(paths.koedHome, "integrations/pi");
  const extensionPath = resolve(packagePath, "extensions/koed.mjs");
  const profilePath = resolve(
    environment.PI_CODING_AGENT_DIR?.trim() ||
      `${environment.HOME?.trim() || homedir()}/.pi/agent`
  );
  const detectedFromConfig = [
    "settings.json",
    "auth.json",
    "models-store.json"
  ].some((name) => deps.existsSync(resolve(profilePath, name)));
  let executable: string;
  try {
    executable = deps.resolvePiExecutable(environment);
  } catch (error) {
    return {
      ...notConfigured(
        error instanceof Error
          ? error.message
          : "Pi is not installed or could not be started.",
        `Install Pi ${MINIMUM_PI_VERSION} or newer, then set up Pi integration.`
      ),
      configured: false,
      detected: detectedFromConfig
    };
  }
  const childEnvironment = piSetupEnvironment(environment, paths.koedHome);
  const runPi = (args: string[], timeout: number, maxBuffer?: number) => {
    const invocation = piSetupInvocation(executable, args);
    return deps.spawnSync(invocation.command, invocation.args, {
      encoding: "utf8",
      env: childEnvironment,
      timeout,
      ...(maxBuffer ? { maxBuffer } : {})
    });
  };
  const version = runPi(["--version"], 5_000);
  const versionText = version.stdout?.trim() ?? "";
  if (version.error || version.status !== 0) {
    return {
      ...notConfigured(
        "Pi is not installed or could not be started.",
        `Install Pi ${MINIMUM_PI_VERSION} or newer, then set up Pi integration.`
      ),
      configured: false,
      detected: detectedFromConfig
    };
  }
  if (!isSupportedPiVersion(versionText)) {
    return {
      ...needsAttention(
        `Pi ${versionText || "version"} is unsupported.`,
        `Install Pi ${MINIMUM_PI_VERSION} or newer, then repair Pi integration.`,
        { executable, version: versionText }
      ),
      configured: false,
      detected: true
    };
  }
  if (!deps.existsSync(extensionPath)) {
    return {
      ...notConfigured(
        "Koed's Pi package is not installed.",
        "Set up Pi integration from Koed Desktop.",
        { executable, version: versionText, packagePath }
      ),
      configured: false,
      detected: true
    };
  }
  const listed = runPi(["list"], 5_000);
  if (listed.error || listed.status !== 0) {
    return {
      ...needsAttention(
        "Koed could not inspect the active Pi profile.",
        "Repair Pi integration from Koed Desktop.",
        { executable, version: versionText, packagePath }
      ),
      configured: false,
      detected: true
    };
  }
  if (!listed.stdout.includes(packagePath)) {
    return {
      ...notConfigured(
        "Koed's package is not registered in the active Pi profile.",
        "Set up Pi integration from Koed Desktop.",
        { executable, version: versionText, packagePath }
      ),
      configured: false,
      detected: true
    };
  }
  const listedModels = runPi(["--list-models"], 15_000, 4 * 1024 * 1024);
  const models =
    listedModels.error || listedModels.status !== 0
      ? []
      : piModelIdsFromListOutput(listedModels.stdout ?? "");
  if (models.length === 0) {
    return {
      ...needsAttention(
        "Pi's Koed package is registered, but Pi has no authenticated models.",
        "Authenticate at least one Pi model, then refresh status.",
        {
          executable,
          version: versionText,
          packagePath,
          packageRegistered: true,
          authenticated: false,
          modelCount: 0
        }
      ),
      configured: true,
      detected: true
    };
  }
  return {
    ...healthy("Pi is configured and authenticated for Koed.", {
      executable,
      version: versionText,
      packagePath,
      packageRegistered: true,
      authenticated: true,
      modelCount: models.length
    }),
    configured: true,
    detected: true
  };
};

export const inspectClaudeCode = (
  environment: NodeJS.ProcessEnv,
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
): KoedServerStatus["claudeCode"] => {
  const executable =
    environment.KOED_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  const settingsPath = resolveClaudeSettingsPath(environment);
  const detectedFromConfig = deps.existsSync(settingsPath);
  const mcpName = environment.MEMORY_MCP_NAME?.trim() || "koed";
  const runtime = resolveKoedAppRuntime(paths, environment, deps.existsSync);
  const childEnvironment = claudeProcessEnvironment(environment);
  const version = deps.spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: childEnvironment,
    timeout: 5_000
  });
  const versionText = version.stdout?.trim() ?? "";
  if (version.error || version.status !== 0) {
    return {
      ...notConfigured(
        "Claude Code is not installed or could not be started.",
        `Install Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or newer, then set up its integration.`
      ),
      configured: false,
      detected: detectedFromConfig
    };
  }
  if (!isSupportedClaudeCodeVersion(versionText)) {
    return {
      ...needsAttention(
        `Claude Code ${versionText || "version"} is unsupported.`,
        `Install Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or newer, then repair its integration.`,
        { executable, version: versionText, settingsPath }
      ),
      configured: false,
      detected: true
    };
  }
  if (
    !deps.existsSync(runtime.mcpCli) ||
    !deps.existsSync(runtime.captureHook)
  ) {
    return {
      ...needsAttention(
        "Koed's Claude Code integration artifacts are missing.",
        "Repair Koed, then repair the Claude Code integration.",
        { executable, version: versionText, settingsPath }
      ),
      configured: false,
      detected: true
    };
  }
  if (!deps.existsSync(settingsPath)) {
    return {
      ...notConfigured(
        "Koed is not configured in Claude Code.",
        "Set up Claude Code integration from Koed Desktop.",
        { executable, version: versionText, settingsPath }
      ),
      configured: false,
      detected: true
    };
  }
  let settings: { hooks?: Record<string, unknown> };
  try {
    settings = JSON.parse(
      String(deps.readFileSync(settingsPath, "utf8"))
    ) as typeof settings;
  } catch {
    return {
      ...needsAttention(
        "Claude Code settings are malformed or unreadable.",
        "Fix the settings file, then repair the Claude Code integration.",
        { executable, version: versionText, settingsPath }
      ),
      configured: false,
      detected: true
    };
  }
  const missingHooks = CLAUDE_HOOK_EVENTS.filter(
    (eventName) =>
      !hasClaudeKoedHook(settings.hooks?.[eventName], runtime.captureHook)
  );
  const mcp = deps.spawnSync(executable, ["mcp", "get", mcpName], {
    encoding: "utf8",
    env: childEnvironment,
    timeout: 10_000
  });
  if (
    !mcp.error &&
    mcp.status === 0 &&
    !claudeMcpEntryIsKoedOwned(mcp.stdout ?? "", runtime.mcpCli, paths.koedHome)
  ) {
    return {
      ...needsAttention(
        `Claude Code has an unrelated user-scoped MCP server named ${mcpName}.`,
        "Rename or remove the conflicting entry before setting up Koed.",
        { executable, version: versionText, settingsPath, mcpName }
      ),
      configured: false,
      detected: true
    };
  }
  if (mcp.error || mcp.status !== 0 || missingHooks.length > 0) {
    return {
      ...notConfigured(
        "Claude Code's Koed MCP or Capture Hook configuration is incomplete.",
        "Set up Claude Code integration from Koed Desktop.",
        {
          executable,
          version: versionText,
          settingsPath,
          missingHooks
        }
      ),
      configured: false,
      detected: true
    };
  }
  const auth = deps.spawnSync(executable, ["auth", "status", "--json"], {
    encoding: "utf8",
    env: childEnvironment,
    timeout: 10_000
  });
  if (auth.error || auth.status !== 0) {
    return {
      ...needsAttention(
        "Claude Code is configured for Koed but is not signed in.",
        "Run `claude auth login`, then refresh status.",
        { executable, version: versionText, settingsPath, authenticated: false }
      ),
      configured: false,
      detected: true
    };
  }
  return {
    ...healthy("Claude Code is configured for Koed capture and recall.", {
      executable,
      version: versionText,
      settingsPath,
      authenticated: true
    }),
    configured: true,
    detected: true
  };
};

const fetchJson = async <T>(
  url: string,
  fetcher: typeof fetch
): Promise<{ ok: boolean; status: number; body: T | null; error?: string }> => {
  try {
    const response = await fetcher(url);
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text ? (JSON.parse(text) as T) : null
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

interface ApiReadyPayload {
  status?: string;
  checks?: Array<{
    service?: string;
    status?: string;
    details?: Record<string, unknown>;
  }>;
}

export const statusFromApiReady = async (
  apiUrl: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  options: { dependencyMode?: "bundled-local" | "external" } = {}
): Promise<{
  api: KoedServerComponentStatus;
  database: KoedServerComponentStatus;
  redis: KoedServerComponentStatus;
  workerQueues: KoedServerComponentStatus;
  embeddingService: KoedServerComponentStatus;
}> => {
  const readyUrl = new URL("/ready", apiUrl).toString();
  const response = await fetchJson<ApiReadyPayload>(readyUrl, fetcher);
  if (!response.body) {
    return {
      api: needsAttention(
        `API is not ready at ${readyUrl}${response.error ? ` (${response.error})` : response.status ? ` (HTTP ${response.status})` : ""}`,
        options.dependencyMode === "external"
          ? "Run koed-server start and check Operator-managed services are reachable."
          : "Run koed-server start and check local dependencies."
      ),
      database: starting(
        "Waiting for API readiness to confirm database state."
      ),
      redis: starting("Waiting for API readiness to confirm Redis state."),
      workerQueues: starting(
        "Waiting for API readiness to confirm work queue state."
      ),
      embeddingService: starting(
        "Waiting for API readiness to confirm Embedding Service state."
      )
    };
  }

  const checks = response.body.checks ?? [];
  const serviceCheck = (service: string) =>
    checks.find((check) => check.service === service);
  const actionFor = (service: string, fallback: string): string => {
    if (service === "migrations") {
      return "Run pnpm db:migrate:check or restart koed-server so startup migrations run.";
    }
    if (service === "pgvector") {
      return "Install and enable pgvector in the Koed database.";
    }
    if (service === "postgres-version") {
      return "Upgrade Postgres to a Koed-compatible version.";
    }
    if (service === "embedding-model") {
      return "Fix the bundled-local Embedding Service model or configured embedding dimensions.";
    }
    if (service === "work-queue") {
      return "Set WORK_QUEUE_BACKEND=local or configure Redis for BullMQ queues.";
    }
    return fallback;
  };
  const component = (
    service: string,
    label: string
  ): KoedServerComponentStatus => {
    const check = serviceCheck(service);
    const value = check?.status;
    if (value === "ok") {
      return healthy(undefined, check?.details);
    }
    if (value === "degraded") {
      return needsAttention(
        `${label} is degraded.`,
        actionFor(service, "Run koed-server doctor --json for details."),
        check?.details
      );
    }
    if (value === "error") {
      return needsAttention(
        `${label} is unavailable or incompatible.`,
        actionFor(service, "Run koed-server start or inspect Koed logs."),
        check?.details
      );
    }
    return starting(`${label} status is not available yet.`);
  };
  const aggregateComponent = (
    services: Array<[string, string]>,
    healthyMessage: string
  ): KoedServerComponentStatus => {
    const components = services.map(([service, label]) =>
      component(service, label)
    );
    const state = aggregateState(components);
    if (state === "healthy") {
      return healthy(healthyMessage, {
        checks: services
          .map(([service]) => serviceCheck(service))
          .filter((check): check is NonNullable<typeof check> => Boolean(check))
      });
    }
    return components.find((entry) => entry.state === state) ?? components[0]!;
  };

  return {
    api: response.ok
      ? healthy(undefined, { readyUrl })
      : starting("API is reachable but readiness checks have not passed.", {
          readyUrl,
          httpStatus: response.status
        }),
    database: aggregateComponent(
      [
        ["postgres", "Database"],
        ["postgres-version", "Postgres version"],
        ["migrations", "Database migrations"],
        ["pgvector", "pgvector"]
      ],
      "Database, migrations, Postgres version, and pgvector are ready."
    ),
    redis: component("redis", "Redis"),
    workerQueues: component("work-queue", "Work queue"),
    embeddingService: aggregateComponent(
      [
        ["embedding-service", "Embedding Service"],
        ["embedding-model", "Embedding model"]
      ],
      "Embedding Service model and dimensions are ready."
    )
  };
};

const statusWaitingForManagedRuntime = (
  staleRuntime: boolean
): Awaited<ReturnType<typeof statusFromApiReady>> => {
  const api = staleRuntime
    ? needsAttention(
        "Koed Desktop's managed supervisor is not running.",
        "Restart Koed Desktop or run koed-server start."
      )
    : starting("Waiting for Koed Desktop to start its managed API.");
  return {
    api,
    database: starting(
      "Waiting for the managed API to confirm database state."
    ),
    redis: starting("Waiting for the managed API to confirm Redis state."),
    workerQueues: starting(
      "Waiting for the managed API to confirm work queue state."
    ),
    embeddingService: starting(
      "Waiting for the managed API to confirm Embedding Service state."
    )
  };
};

const koedServerConfigEnvironment = (
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): NodeJS.ProcessEnv => ({
  ...environment,
  KOED_RUNTIME_MODE: environment.KOED_RUNTIME_MODE ?? repoEnv.KOED_RUNTIME_MODE,
  KOED_DEPENDENCY_MODE:
    environment.KOED_DEPENDENCY_MODE ?? repoEnv.KOED_DEPENDENCY_MODE,
  KOED_EXTERNAL_DATABASE_URL:
    environment.KOED_EXTERNAL_DATABASE_URL ??
    repoEnv.KOED_EXTERNAL_DATABASE_URL,
  KOED_EXTERNAL_REDIS_URL:
    environment.KOED_EXTERNAL_REDIS_URL ?? repoEnv.KOED_EXTERNAL_REDIS_URL,
  KOED_EXTERNAL_EMBEDDING_SERVICE_URL:
    environment.KOED_EXTERNAL_EMBEDDING_SERVICE_URL ??
    repoEnv.KOED_EXTERNAL_EMBEDDING_SERVICE_URL,
  MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED:
    environment.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED ??
    repoEnv.MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED
});

const inspectApiToken = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  apiUrl: string,
  fetch: typeof globalThis.fetch
): Promise<KoedServerStatus["apiToken"]> => {
  const token = resolveActiveIntegrationApiToken(paths, environment, repoEnv);
  if (!token) {
    return {
      ...notConfigured(
        "No local API Token is configured for Koed core services.",
        "Run koed-server setup core --json or create an API Token."
      ),
      configured: false
    };
  }
  try {
    const response = await fetch(new URL("/v1/access/check", apiUrl), {
      headers: { authorization: `Bearer ${token.token}` }
    });
    if (response.ok) {
      return {
        ...healthy("Local API Token authenticated successfully."),
        configured: true
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ...needsAttention(
          "Local API Token is invalid or revoked.",
          "Run koed-server setup core --json to validate or rotate the local credential.",
          { httpStatus: response.status }
        ),
        configured: true
      };
    }
    return {
      ...needsAttention(
        `Koed API access validation returned HTTP ${response.status}.`,
        "Check Koed API health and rerun diagnostics.",
        { kind: "service_error", httpStatus: response.status }
      ),
      configured: true
    };
  } catch (error) {
    return {
      ...needsAttention(
        "Koed API could not validate local API Token.",
        "Check Koed API/network health and rerun diagnostics. Token was not rotated.",
        {
          kind: "service_error",
          error: error instanceof Error ? error.message : String(error)
        }
      ),
      configured: true
    };
  }
};

const fetchAiClientCapabilityReadModel = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  apiUrl: string,
  fetcher: typeof globalThis.fetch
): Promise<CapabilitySnapshotReadModel | null> => {
  const token = resolveActiveIntegrationApiToken(paths, environment, repoEnv);
  if (!token) return null;
  try {
    const response = await fetcher(
      new URL("/v1/memory/local-agent-settings", apiUrl),
      {
        headers: { authorization: `Bearer ${token.token}` }
      }
    );
    if (!response.ok) return null;
    const body = JSON.parse(
      await response.text()
    ) as Partial<CapabilitySnapshotReadModel>;
    if (
      !Array.isArray(body.instances) ||
      !Array.isArray(body.capabilitySnapshots)
    ) {
      return null;
    }
    return body as CapabilitySnapshotReadModel;
  } catch {
    return null;
  }
};

const tomlStringValue = (content: string, key: string): string | null => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(content);
  return match?.[1] ?? null;
};

const tomlSection = (content: string, sectionName: string): string => {
  const lines = content.split(/\r?\n/);
  const header = `[${sectionName}]`;
  const sectionLines: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) {
      inSection = true;
      continue;
    }
    if (inSection && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      break;
    }
    if (inSection) {
      sectionLines.push(line);
    }
  }
  return sectionLines.join("\n");
};

const inspectCodex = (
  environment: NodeJS.ProcessEnv,
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
): KoedServerStatus["codex"] => {
  const codexConfigPath = resolve(
    environment.CODEX_CONFIG_PATH ??
      `${environment.CODEX_HOME ?? `${environment.HOME ?? ""}/.codex`}/config.toml`
  );
  if (!deps.existsSync(codexConfigPath)) {
    return {
      ...notConfigured(
        "Codex configuration was not found.",
        "Select Codex in Desktop AI Client setup, or run koed-server setup codex --json."
      ),
      configured: false
    };
  }
  const content = deps.readFileSync(codexConfigPath, "utf8") as string;
  const mcpName = environment.MEMORY_MCP_NAME ?? "koed";
  const ownership = parseCodexOwnershipBlock(content);
  const ownedBlock = ownership.kind === "valid" ? ownership.block : "";
  const mcpBlock = tomlSection(ownedBlock, `mcp_servers.${mcpName}`);
  const mcpEnvBlock = tomlSection(ownedBlock, `mcp_servers.${mcpName}.env`);
  const configured = ownership.kind === "valid" && Boolean(mcpBlock);
  if (!configured) {
    return {
      ...notConfigured(
        "Codex is installed but Koed is not configured in Codex.",
        "Run the Codex-specific setup action."
      ),
      configured: false
    };
  }

  const configuredKoedHome = tomlStringValue(mcpEnvBlock, "KOED_HOME");
  const runtime = resolveKoedAppRuntime(paths, environment, deps.existsSync);
  const hasExpectedAdapter = mcpBlock.includes(JSON.stringify(runtime.mcpCli));
  const containsRetiredCredentials =
    tomlStringValue(mcpEnvBlock, "MEMORY_API_URL") !== null ||
    tomlStringValue(mcpEnvBlock, "MEMORY_API_TOKEN") !== null;
  if (configuredKoedHome !== paths.koedHome || !hasExpectedAdapter) {
    return {
      ...needsAttention(
        "Codex Koed integration points at a different Local AI Runtime.",
        "Run the Codex-specific repair action, then restart Codex and trust updated hooks if prompted.",
        {
          configuredKoedHome: configuredKoedHome ?? null,
          expectedKoedHome: paths.koedHome,
          expectedMcpAdapter: runtime.mcpCli,
          codexConfigPath
        }
      ),
      configured: true
    };
  }
  if (containsRetiredCredentials) {
    return {
      ...needsAttention(
        "Codex Koed integration still contains retired API credentials.",
        "Run the Codex-specific repair action, then restart Codex and trust updated hooks if prompted.",
        { codexConfigPath }
      ),
      configured: true
    };
  }
  return {
    ...healthy("Codex Koed integration is configured.", {
      configuredKoedHome,
      mcpAdapter: runtime.mcpCli,
      codexConfigPath
    }),
    configured: true
  };
};

const inspectCaptureHook = (
  environment: NodeJS.ProcessEnv,
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
) => {
  const codexConfigPath = resolve(
    environment.CODEX_CONFIG_PATH ??
      `${environment.CODEX_HOME ?? `${environment.HOME ?? ""}/.codex`}/config.toml`
  );
  if (!deps.existsSync(codexConfigPath)) {
    return notConfigured(
      "Codex configuration containing the Supported Capture Hook was not found.",
      "Run the Codex-specific setup action."
    );
  }
  const content = String(deps.readFileSync(codexConfigPath, "utf8"));
  const runtime = resolveKoedAppRuntime(paths, environment, deps.existsSync);
  const requiredEvents = [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SubagentStart",
    "SubagentStop"
  ];
  const missingEvents = requiredEvents.filter(
    (eventName) => !content.includes(`[[hooks.${eventName}]]`)
  );
  const ownership = parseCodexOwnershipBlock(content);
  const ownedBlock = ownership.kind === "valid" ? ownership.block : "";
  if (
    ownership.kind !== "valid" ||
    !ownedBlock.includes("capture-hook") ||
    missingEvents.length > 0
  ) {
    return needsAttention(
      "Supported Capture Hook signal entries are incomplete.",
      "Run the Codex-specific repair action, then restart Codex and trust updated hooks if prompted.",
      {
        codexConfigPath,
        captureHookPath: runtime.captureHook,
        missingEvents
      }
    );
  }
  return healthy("Supported Capture Hook is configured.", {
    codexConfigPath,
    captureHookPath: runtime.captureHook,
    mode: "transcript_watcher_signal"
  });
};

const inspectMcp = (
  environment: NodeJS.ProcessEnv,
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
) => {
  const appRuntime = resolveKoedAppRuntime(paths, environment, deps.existsSync);
  const cliPath = appRuntime.mcpCli;
  if (!deps.existsSync(cliPath)) {
    return notConfigured(
      appRuntime.kind === "packaged"
        ? "Packaged MCP Server artifact was not found."
        : "MCP Server build output was not found.",
      appRuntime.kind === "packaged"
        ? "Rebuild Koed Desktop packaging so koed-runtime includes the MCP Server and Supported Capture Hook artifacts."
        : "Run pnpm --filter @koed/mcp-server build or koed-server setup core --json.",
      {
        artifactSource: appRuntime.artifactSource,
        runtimeRoot: appRuntime.root,
        missing: appRuntime.missing
      }
    );
  }
  const {
    MEMORY_API_TOKEN: _memoryApiToken,
    CODEX_MEMORY_API_TOKEN: _codexMemoryApiToken,
    MEMORY_API_URL: _memoryApiUrl,
    ...doctorEnvironment
  } = environment;
  void _memoryApiToken;
  void _codexMemoryApiToken;
  void _memoryApiUrl;
  const result = deps.spawnSync(process.execPath, [cliPath, "doctor"], {
    cwd: paths.repoRoot,
    env: {
      ...doctorEnvironment,
      KOED_HOME: paths.koedHome
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) {
    return healthy("MCP Server doctor passed.", {
      artifactSource: appRuntime.artifactSource,
      runtimeRoot: appRuntime.root
    });
  }
  return needsAttention(
    "MCP Server doctor failed.",
    "Run koed-server doctor --json for details.",
    {
      stderr: result.stderr.trim(),
      stdout: result.stdout.trim(),
      artifactSource: appRuntime.artifactSource,
      runtimeRoot: appRuntime.root
    }
  );
};

const inspectLocalAiRuntime = (
  runtime: KoedServerRuntimeState | null,
  runtimeProcessRunning: boolean,
  runtimeMode: "local-personal" | "external" | "developer",
  deps: Required<KoedServerStatusDependencies>
): KoedServerComponentStatus => {
  if (runtimeMode === "external") {
    return healthy(
      "Local AI Runtime is not required in external runtime mode.",
      {
        required: false
      }
    );
  }
  const pid = runtime?.processes?.localAiRuntime;
  if (!runtimeProcessRunning) {
    return runtime
      ? needsAttention(
          "Local AI Runtime process is not running.",
          "Run koed-server start --daemon or inspect Koed logs."
        )
      : starting("Waiting for Koed server to start the Local AI Runtime.");
  }
  if (!pid) {
    return needsAttention(
      "Local AI Runtime process is not recorded in runtime state.",
      "Restart koed-server and inspect Koed logs."
    );
  }
  return deps.checkPid(pid)
    ? healthy("Local AI Runtime process is running.", { pid })
    : needsAttention(
        "Local AI Runtime process is not running.",
        "Run koed-server restart --json or inspect Koed logs.",
        { pid }
      );
};

const inspectCodexTranscriptWatcher = (
  enabled: boolean,
  runtime: KoedServerRuntimeState | null,
  runtimeProcessRunning: boolean,
  deps: Required<KoedServerStatusDependencies>
): KoedServerComponentStatus => {
  const localAiRuntimePid = runtime?.processes?.localAiRuntime;
  const details = { enabled, localAiRuntimePid: localAiRuntimePid ?? null };
  if (!enabled) {
    return notConfigured(
      "Codex Transcript Watcher is disabled.",
      undefined,
      details
    );
  }
  if (!runtimeProcessRunning) {
    return starting(
      "Koed server supervisor is not currently running.",
      details
    );
  }
  if (!localAiRuntimePid) {
    return needsAttention(
      "Local AI Runtime process is not recorded in koed-server runtime state.",
      "Verify an API Token is configured, then restart koed-server or inspect Koed logs.",
      details
    );
  }
  if (!deps.checkPid(localAiRuntimePid)) {
    return needsAttention(
      "Local AI Runtime process hosting the Codex Transcript Watcher is not running.",
      "Run koed-server restart --json or inspect Koed logs.",
      details
    );
  }
  return healthy(
    "Codex Transcript Watcher is running in the Local AI Runtime.",
    details
  );
};

const inspectClaudeTranscriptWatcher = (
  enabled: boolean,
  runtime: KoedServerRuntimeState | null,
  runtimeProcessRunning: boolean,
  deps: Required<KoedServerStatusDependencies>
): KoedServerComponentStatus => {
  const localAiRuntimePid = runtime?.processes?.localAiRuntime;
  const details = { enabled, localAiRuntimePid: localAiRuntimePid ?? null };
  if (!enabled) {
    return notConfigured(
      "Claude Transcript Watcher is disabled.",
      undefined,
      details
    );
  }
  if (!runtimeProcessRunning) {
    return starting(
      "Koed server supervisor is not currently running.",
      details
    );
  }
  if (!localAiRuntimePid) {
    return needsAttention(
      "Local AI Runtime process is not recorded in koed-server runtime state.",
      "Verify an API Token is configured, then restart koed-server or inspect Koed logs.",
      details
    );
  }
  if (!deps.checkPid(localAiRuntimePid)) {
    return needsAttention(
      "Local AI Runtime process hosting the Claude Transcript Watcher is not running.",
      "Run koed-server restart --json or inspect Koed logs.",
      details
    );
  }
  return healthy(
    "Claude Transcript Watcher is running in the Local AI Runtime.",
    details
  );
};

const readinessForState = (
  state: KoedServerComponentStatus["state"]
): "ready" | "not_ready" | "unknown" =>
  state === "healthy"
    ? "ready"
    : state === "needs_attention"
      ? "not_ready"
      : "unknown";

type CapabilitySnapshotReadModel = {
  instances: Array<{
    instanceId: string;
    driverId: "codex" | "claude" | "pi";
    displayName: string;
    configIdentityHash?: string | null;
    enabled?: boolean;
  }>;
  settings?: Array<{
    flowKey: LocalAiClientFlowKey;
    provider: "codex" | "claude" | "pi";
    aiClientInstanceId: string;
    model: string;
    reasoningEffort: string;
    timeoutMs: number;
    maxAttempts: number;
  }>;
  defaults?: Partial<Record<LocalAiClientFlowKey, LocalAiClientDefault>>;
  capabilitySnapshots: Array<{
    instanceId: string;
    installationIdentityHash?: string;
    clientVersion: string | null;
    authenticationState: "authenticated" | "unauthenticated" | "unknown";
    healthState: "healthy" | "unavailable" | "incompatible" | "error";
    models: unknown[];
    capabilities: {
      descriptors?: Record<string, unknown>;
    };
    observedAt: string;
    expiresAt: string;
    stale?: boolean;
  }>;
};

type SelectedCapabilitySnapshot = NonNullable<
  CapabilitySnapshotReadModel["capabilitySnapshots"][number]
> & { stale: boolean };

const capabilityDescriptor = (
  id:
    | "automatic_capture"
    | "mcp_recall"
    | "local_synthesis"
    | "managed_conversation_start",
  support: "supported" | "unsupported",
  readiness: "ready" | "not_ready" | "unknown",
  message: string
): AiClientCapabilityDescriptor => ({
  id,
  support,
  readiness: support === "unsupported" ? "unknown" : readiness,
  diagnostics: [
    {
      code: "profile_check",
      message,
      severity: readiness === "not_ready" ? "warning" : "info"
    }
  ],
  ...(readiness === "ready" && support === "supported"
    ? {
        recoveryAction: {
          id: "check" as const,
          label: "Check integration",
          available: true
        }
      }
    : {})
});

const descriptorFor = (
  snapshot: SelectedCapabilitySnapshot | null,
  id: AiClientCapabilityDescriptor["id"]
): AiClientCapabilityDescriptor | null => {
  const candidate = snapshot?.capabilities.descriptors?.[id];
  if (!candidate || typeof candidate !== "object") return null;
  const descriptor = candidate as Partial<AiClientCapabilityDescriptor>;
  if (
    descriptor.id !== id ||
    (descriptor.support !== "supported" &&
      descriptor.support !== "unsupported") ||
    ![
      "ready",
      "not_ready",
      "unauthenticated",
      "unavailable",
      "stale",
      "unknown"
    ].includes(descriptor.readiness ?? "") ||
    !Array.isArray(descriptor.diagnostics)
  ) {
    return null;
  }
  return descriptor as AiClientCapabilityDescriptor;
};

const snapshotFor = (
  readModel: CapabilitySnapshotReadModel | null,
  driverId: "codex" | "claude" | "pi",
  now: string,
  preferredInstanceId?: string
): SelectedCapabilitySnapshot | null => {
  if (!readModel) return null;
  const preferredInstance = preferredInstanceId
    ? readModel.instances.find(
        (candidate) =>
          candidate.instanceId === preferredInstanceId &&
          candidate.driverId === driverId &&
          candidate.enabled !== false
      )
    : undefined;
  const instance = preferredInstanceId
    ? preferredInstance
    : (readModel.instances.find(
        (candidate) =>
          typeof candidate.instanceId === "string" &&
          typeof candidate.driverId === "string" &&
          candidate.driverId === driverId &&
          candidate.instanceId === `${driverId}.default` &&
          candidate.enabled !== false
      ) ??
      readModel.instances.find(
        (candidate) =>
          typeof candidate.instanceId === "string" &&
          typeof candidate.driverId === "string" &&
          candidate.driverId === driverId &&
          candidate.enabled !== false
      ));
  if (!instance) return null;
  const snapshot = readModel.capabilitySnapshots
    .filter(
      (candidate) =>
        candidate.instanceId === instance.instanceId &&
        typeof candidate.observedAt === "string" &&
        typeof candidate.expiresAt === "string" &&
        candidate.capabilities !== null &&
        typeof candidate.capabilities === "object" &&
        Array.isArray(candidate.models) &&
        Number.isFinite(Date.parse(candidate.observedAt)) &&
        Number.isFinite(Date.parse(candidate.expiresAt)) &&
        Date.parse(candidate.expiresAt) > Date.parse(candidate.observedAt)
    )
    .sort(
      (left, right) =>
        Date.parse(right.observedAt) - Date.parse(left.observedAt)
    )[0];
  if (!snapshot) return null;
  const expiresAt = Date.parse(snapshot.expiresAt);
  return {
    ...snapshot,
    stale: snapshot.stale === true || expiresAt <= Date.parse(now)
  };
};

const staleDescriptor = (
  descriptor: AiClientCapabilityDescriptor,
  stale: boolean
): AiClientCapabilityDescriptor =>
  stale && descriptor.support === "supported"
    ? {
        ...descriptor,
        readiness: "stale",
        diagnostics: [
          ...descriptor.diagnostics,
          {
            code: "capability_snapshot_stale",
            message:
              "Capability snapshot is stale and cannot be used to run this capability.",
            severity: "warning"
          }
        ]
      }
    : descriptor;

const unknownCapabilityDescriptor = (
  id: AiClientCapabilityDescriptor["id"],
  support: "supported" | "unsupported",
  message: string
): AiClientCapabilityDescriptor => ({
  id,
  support,
  readiness: "unknown",
  diagnostics: [
    { code: "capability_snapshot_unknown", message, severity: "warning" }
  ]
});

const localSynthesisReadiness = (
  snapshot: SelectedCapabilitySnapshot | null,
  descriptor: AiClientCapabilityDescriptor | null
): AiClientCapabilityDescriptor => {
  if (!snapshot || !descriptor) {
    return unknownCapabilityDescriptor(
      "local_synthesis",
      "supported",
      "Local Synthesis capability snapshot is unavailable."
    );
  }
  const current = staleDescriptor(descriptor, snapshot.stale);
  if (current.readiness === "stale") return current;
  if (snapshot.authenticationState === "unauthenticated") {
    return { ...current, readiness: "unauthenticated" };
  }
  if (snapshot.authenticationState !== "authenticated") {
    return { ...current, readiness: "unknown" };
  }
  if (snapshot.healthState !== "healthy") {
    return { ...current, readiness: "unavailable" };
  }
  if (snapshot.models.length === 0) {
    return {
      ...current,
      readiness: "unavailable",
      diagnostics: [
        ...current.diagnostics,
        {
          code: "model_unavailable",
          message: "No runnable model was reported by AI Client snapshot.",
          severity: "warning"
        }
      ]
    };
  }
  return current;
};

export const inspectAiClientReadiness = (input: {
  codex: KoedServerStatus["codex"];
  claudeCode: KoedServerStatus["claudeCode"];
  pi: KoedServerStatus["pi"];
  codexTranscriptWatcher: KoedServerComponentStatus;
  claudeTranscriptWatcher: KoedServerComponentStatus;
  mcpServer: KoedServerComponentStatus;
  localAiRuntime: KoedServerComponentStatus;
  capabilityReadModel?: CapabilitySnapshotReadModel | null;
  /** Select one instance for its driver's readiness view. */
  instanceId?: string;
  now: string;
}): Record<string, KoedAiClientReadiness> => {
  const clients = [
    {
      driverId: "codex" as const,
      displayName: "Codex",
      profile: input.codex,
      capture: input.codexTranscriptWatcher
    },
    {
      driverId: "claude" as const,
      displayName: "Claude Code",
      profile: input.claudeCode,
      capture: input.claudeTranscriptWatcher
    },
    {
      driverId: "pi" as const,
      displayName: "Pi",
      profile: input.pi,
      capture: input.pi
    }
  ];
  return Object.fromEntries(
    clients.map(({ driverId, displayName, profile, capture }) => {
      const details = profile.details ?? {};
      const snapshot = snapshotFor(
        input.capabilityReadModel ?? null,
        driverId,
        input.now,
        input.instanceId
      );
      const profileReady = readinessForState(profile.state);
      const captureFallback =
        profileReady === "ready"
          ? readinessForState(capture.state)
          : profileReady === "unknown"
            ? "unknown"
            : "not_ready";
      const mcpFallback =
        profileReady === "ready" && input.mcpServer.state === "healthy"
          ? "ready"
          : profileReady === "unknown" || input.mcpServer.state === "starting"
            ? "unknown"
            : "not_ready";
      const overlayUnknownProfileReadiness = (
        descriptor: AiClientCapabilityDescriptor,
        fallback: "ready" | "not_ready" | "unknown"
      ): AiClientCapabilityDescriptor =>
        descriptor.readiness === "unknown" && descriptor.support === "supported"
          ? {
              ...descriptor,
              readiness: fallback,
              diagnostics: [
                ...descriptor.diagnostics,
                {
                  code: "profile_readiness_overlay",
                  message:
                    "Snapshot was unknown; current integration profile readiness was used.",
                  severity: fallback === "not_ready" ? "warning" : "info"
                }
              ]
            }
          : descriptor;
      const captureDescriptor = overlayUnknownProfileReadiness(
        descriptorFor(snapshot, "automatic_capture") ??
          capabilityDescriptor(
            "automatic_capture",
            "supported",
            captureFallback,
            capture.message ?? "Automatic capture profile check completed."
          ),
        captureFallback
      );
      const mcpDescriptor = overlayUnknownProfileReadiness(
        descriptorFor(snapshot, "mcp_recall") ??
          capabilityDescriptor(
            "mcp_recall",
            "supported",
            mcpFallback,
            input.mcpServer.message ?? "MCP Recall profile check completed."
          ),
        mcpFallback
      );
      const synthesisDescriptor = localSynthesisReadiness(
        snapshot,
        descriptorFor(snapshot, "local_synthesis")
      );
      const managedCapabilityIds = [
        "managed_conversation_start",
        "managed_conversation_resume",
        "managed_conversation_send",
        "managed_conversation_cancel",
        "approvals",
        "streaming",
        "session_identity",
        "handoff",
        "fork"
      ] as const;
      const managedDescriptors = managedCapabilityIds.map((id) =>
        staleDescriptor(
          driverId === "pi"
            ? unknownCapabilityDescriptor(
                id,
                "unsupported",
                "Pi does not support Managed Conversation."
              )
            : (descriptorFor(snapshot, id) ??
                unknownCapabilityDescriptor(
                  id,
                  "supported",
                  "Managed Conversation capability snapshot is unavailable."
                )),
          snapshot?.stale ?? false
        )
      );
      const capabilities = [
        staleDescriptor(captureDescriptor, snapshot?.stale ?? false),
        staleDescriptor(mcpDescriptor, snapshot?.stale ?? false),
        synthesisDescriptor,
        ...managedDescriptors
      ];
      const version =
        snapshot?.clientVersion ??
        (typeof details.version === "string" ? details.version : null);
      const authenticated =
        snapshot?.authenticationState ??
        (details.authenticated === true
          ? "authenticated"
          : details.authenticated === false
            ? "unauthenticated"
            : "unknown");
      const installed =
        version || ("detected" in profile && profile.detected === true)
          ? healthy(
              version
                ? `${displayName} ${version} is installed.`
                : `${displayName} is installed.`,
              { version }
            )
          : profile.state === "not_configured"
            ? notConfigured(`${displayName} installation is unknown.`)
            : profile;
      return [
        driverId,
        {
          driverId,
          instanceId: snapshot?.instanceId ?? `${driverId}.default`,
          displayName: snapshot
            ? (input.capabilityReadModel?.instances.find(
                (instance) => instance.instanceId === snapshot.instanceId
              )?.displayName ?? displayName)
            : displayName,
          installed,
          version,
          authentication: authenticated,
          profile,
          capabilities,
          observedAt: snapshot?.observedAt ?? input.now,
          snapshotState: snapshot
            ? snapshot.stale
              ? "stale"
              : "current"
            : input.capabilityReadModel === undefined
              ? "profile"
              : "unknown"
        }
      ];
    })
  );
};

/**
 * Build readiness keyed by persisted instance id. `inspectAiClientReadiness`
 * remains provider-keyed for older status consumers.
 */
export const inspectAiClientInstanceReadiness = (
  input: Parameters<typeof inspectAiClientReadiness>[0]
): Record<string, KoedAiClientReadiness> => {
  const instances = input.capabilityReadModel?.instances ?? [];
  return Object.fromEntries(
    instances.map((instance) => {
      const readiness = inspectAiClientReadiness({
        ...input,
        instanceId: instance.instanceId
      })[instance.driverId];
      return [
        instance.instanceId,
        readiness
          ? {
              ...readiness,
              instanceId: instance.instanceId,
              displayName: instance.displayName
            }
          : aiClientReadinessUnknown(
              instance.driverId,
              instance.displayName,
              input.now
            )
      ];
    })
  ) as Record<string, KoedAiClientReadiness>;
};

const assignmentFromSetting = (
  setting: NonNullable<CapabilitySnapshotReadModel["settings"]>[number]
): LocalAiClientRuntimeAssignment => ({
  provider: setting.provider,
  ai_client_instance_id: setting.aiClientInstanceId,
  model: setting.model,
  reasoning_effort: setting.reasoningEffort,
  timeout_ms: setting.timeoutMs,
  max_attempts: setting.maxAttempts
});

const modelIdentifier = (model: unknown): string | null => {
  if (!model || typeof model !== "object") return null;
  const value = model as Record<string, unknown>;
  for (const candidate of [value.fullId, value.id, value.model]) {
    if (typeof candidate === "string" && candidate.trim())
      return candidate.trim();
  }
  return null;
};

const modelEfforts = (model: unknown): string[] => {
  if (!model || typeof model !== "object") return [];
  const values = (model as Record<string, unknown>).supportedReasoningEfforts;
  return Array.isArray(values)
    ? values.flatMap((value) =>
        typeof value === "string"
          ? [value]
          : value &&
              typeof value === "object" &&
              typeof (value as Record<string, unknown>).reasoningEffort ===
                "string"
            ? [(value as Record<string, unknown>).reasoningEffort as string]
            : []
      )
    : [];
};

const flowAssignmentReadiness = (input: {
  flowKey: LocalAiClientFlowKey;
  environment: NodeJS.ProcessEnv;
  readModel: CapabilitySnapshotReadModel | null;
  now: string;
}): KoedAiClientFlowReadiness => {
  const documented =
    input.readModel?.defaults?.[input.flowKey] ??
    documentDefault(codeDefaultAssignmentFor(input.flowKey));
  const setting = input.readModel?.settings?.find(
    (candidate) => candidate.flowKey === input.flowKey
  );
  const resolved = setting
    ? {
        source: "setting" as const,
        available: true,
        assignment: assignmentFromSetting(setting),
        reason: null
      }
    : environmentDefaultFor(input.flowKey, documented, input.environment);
  const source = resolved.source;
  if (!resolved.assignment || !resolved.available) {
    return {
      flowKey: input.flowKey,
      source: "unavailable",
      assignment: resolved.assignment,
      state: "needs_attention",
      message:
        resolved.reason ?? "No effective AI Client assignment is available."
    };
  }
  const assignment = resolved.assignment;
  const instance = input.readModel?.instances.find(
    (candidate) => candidate.instanceId === assignment.ai_client_instance_id
  );
  if (!instance || instance.enabled === false) {
    return {
      flowKey: input.flowKey,
      source,
      assignment,
      state: "needs_attention",
      message: `AI Client instance "${assignment.ai_client_instance_id}" is unavailable for ${input.flowKey}.`
    };
  }
  if (instance.driverId !== assignment.provider) {
    return {
      flowKey: input.flowKey,
      source,
      assignment,
      state: "needs_attention",
      message: `AI Client instance "${instance.instanceId}" belongs to another AI Client driver.`
    };
  }
  const snapshot = snapshotFor(
    input.readModel,
    instance.driverId,
    input.now,
    instance.instanceId
  );
  const unavailable = (message: string): KoedAiClientFlowReadiness => ({
    flowKey: input.flowKey,
    source,
    assignment,
    state: "needs_attention",
    message
  });
  if (!snapshot || snapshot.stale) {
    return unavailable(
      `AI Client instance "${instance.instanceId}" has no current capability snapshot.`
    );
  }
  if (
    !instance.configIdentityHash ||
    !snapshot.installationIdentityHash ||
    snapshot.installationIdentityHash !== instance.configIdentityHash
  ) {
    return unavailable(
      `AI Client instance "${instance.instanceId}" capability identity is unavailable or changed.`
    );
  }
  if (snapshot.authenticationState !== "authenticated") {
    return unavailable(
      `AI Client instance "${instance.instanceId}" is not authenticated.`
    );
  }
  if (snapshot.healthState !== "healthy") {
    return unavailable(
      `AI Client instance "${instance.instanceId}" is not healthy.`
    );
  }
  const synthesis = descriptorFor(snapshot, "local_synthesis");
  if (
    !synthesis ||
    synthesis.support !== "supported" ||
    synthesis.readiness !== "ready"
  ) {
    return unavailable(
      `AI Client instance "${instance.instanceId}" local synthesis is unavailable.`
    );
  }
  const model = snapshot.models.find(
    (candidate) => modelIdentifier(candidate) === assignment.model
  );
  if (!model) {
    return unavailable(
      `Model "${assignment.model}" is unavailable on AI Client instance "${instance.instanceId}".`
    );
  }
  if (!modelEfforts(model).includes(assignment.reasoning_effort)) {
    return unavailable(
      `Reasoning effort "${assignment.reasoning_effort}" is unavailable for model "${assignment.model}".`
    );
  }
  return {
    flowKey: input.flowKey,
    source,
    assignment,
    state: "healthy",
    message: `AI Client instance "${instance.instanceId}" is ready for ${input.flowKey}.`
  };
};

export const inspectAiClientFlowReadiness = (input: {
  environment: NodeJS.ProcessEnv;
  capabilityReadModel?: CapabilitySnapshotReadModel | null;
  now: string;
}): Record<LocalAiClientFlowKey, KoedAiClientFlowReadiness> =>
  Object.fromEntries(
    localAiClientFlowKeys.map((flowKey) => [
      flowKey,
      flowAssignmentReadiness({
        flowKey,
        environment: input.environment,
        readModel: input.capabilityReadModel ?? null,
        now: input.now
      })
    ])
  ) as Record<LocalAiClientFlowKey, KoedAiClientFlowReadiness>;

export const evaluateAiClientReadiness = (
  readiness: KoedAiClientReadiness | null | undefined
): {
  ok: boolean;
  state: "healthy" | "needs_attention";
  message: string;
  action?: string;
} => {
  const required = [
    "automatic_capture",
    "mcp_recall",
    "local_synthesis"
  ] as const;
  const missing = required.filter(
    (id) =>
      !readiness?.capabilities.some(
        (capability) =>
          capability.id === id &&
          capability.support === "supported" &&
          capability.readiness === "ready"
      )
  );
  const profileReady = readiness?.profile.state === "healthy";
  const ok = Boolean(readiness && profileReady && missing.length === 0);
  if (ok && readiness) {
    return {
      ok: true,
      state: "healthy",
      message: `${readiness.displayName} profile and required capabilities are ready.`
    };
  }
  const message = !readiness
    ? "AI Client readiness snapshot is unavailable."
    : !profileReady
      ? (readiness.profile.message ??
        `${readiness.displayName} profile is not ready.`)
      : `Required AI Client capabilities are not ready: ${missing.join(", ")}.`;
  return {
    ok: false,
    state: "needs_attention",
    message,
    ...(readiness?.profile.action ? { action: readiness.profile.action } : {})
  };
};

const inspectLastVerification = (
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
) => {
  const value = readJsonFile<{
    checkedAt?: string;
    ok?: boolean;
    message?: string;
  }>(paths.lastVerificationPath, deps.readFileSync);
  if (!value?.checkedAt) {
    return {
      ...notConfigured(
        "No setup verification has been recorded yet.",
        "Run koed-server setup core --json."
      ),
      checkedAt: null
    };
  }
  return {
    ...(value.ok === false
      ? needsAttention(
          value.message ?? "Last verification failed.",
          "Run koed-server setup core --json."
        )
      : healthy("Last setup verification passed.")),
    checkedAt: value.checkedAt
  };
};

const inspectDeviceIdentity = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv
): Promise<KoedServerStatus["deviceIdentity"]> => {
  const identity = await inspectDeviceIdentityStatus(paths, { environment });
  const component = identity.remoteOperationsAllowed
    ? healthy(identity.message)
    : needsAttention(identity.message, identity.action);
  return {
    ...component,
    health: identity.health,
    deploymentId: identity.deploymentId,
    deviceInstanceId: identity.deviceInstanceId,
    remoteOperationsAllowed: identity.remoteOperationsAllowed,
    ...(identity.pendingRemoteRevocation
      ? { pendingRemoteRevocation: true as const }
      : {}),
    platformProtection: identity.platformProtection
  };
};

const inspectUpstreamBackends = (
  paths: KoedServerPaths,
  deps: Required<KoedServerStatusDependencies>
): KoedServerStatus["upstreamBackends"] => {
  const registry = collectUpstreamRegistryStatus(paths, {
    existsSync: deps.existsSync,
    readFileSync: deps.readFileSync,
    now: deps.now
  });
  const details = {
    backends: registry.backends.map((backend) => ({
      id: backend.id,
      displayName: backend.displayName,
      baseUrl: backend.baseUrl,
      profile: backend.profile,
      routePolicy: backend.routePolicy,
      credential: backend.credential,
      capabilities: backend.capabilities
    }))
  };
  if (registry.parseError) {
    return {
      ...needsAttention(
        "Upstream backend registry is malformed.",
        "Fix or remove KOED_HOME/config/upstream-backends.json, then re-register upstream backends.",
        { ...details, error: registry.parseError }
      ),
      registered: registry.registered,
      validated: registry.validated,
      stale: registry.stale,
      failed: registry.failed,
      notChecked: registry.notChecked
    };
  }
  if (registry.failed > 0) {
    return {
      ...needsAttention(
        "One or more upstream backend capability refreshes failed.",
        "Run koed-server upstream refresh --id <id> --json.",
        details
      ),
      registered: registry.registered,
      validated: registry.validated,
      stale: registry.stale,
      failed: registry.failed,
      notChecked: registry.notChecked
    };
  }
  if (registry.stale > 0 || registry.notChecked > 0) {
    return {
      ...needsAttention(
        "One or more upstream backends need capability validation.",
        "Run koed-server upstream refresh --id <id> --json.",
        details
      ),
      registered: registry.registered,
      validated: registry.validated,
      stale: registry.stale,
      failed: registry.failed,
      notChecked: registry.notChecked
    };
  }
  return {
    ...healthy(
      registry.registered
        ? "Registered upstream backend capabilities are validated."
        : "No upstream backends are registered.",
      details
    ),
    registered: registry.registered,
    validated: registry.validated,
    stale: registry.stale,
    failed: registry.failed,
    notChecked: registry.notChecked
  };
};

export const aggregateState = (
  components: KoedServerComponentStatus[]
): KoedServerComponentState => {
  if (components.some((component) => component.state === "needs_attention")) {
    return "needs_attention";
  }
  if (components.some((component) => component.state === "not_configured")) {
    return "not_configured";
  }
  if (components.some((component) => component.state === "starting")) {
    return "starting";
  }
  return "healthy";
};

const inspectSafely = <T>(label: string, inspect: () => T, fallback: T): T => {
  try {
    return inspect();
  } catch {
    return {
      ...needsAttention(
        `${label} status could not be inspected.`,
        `Repair ${label} integration, then refresh status.`,
        { kind: "inspection_error" }
      ),
      ...fallback
    } as T;
  }
};

export const collectKoedServerStatus = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: KoedServerStatusDependencies = {}
): Promise<KoedServerStatus> => {
  const deps = withDefaults(dependencies);
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  environment = applyPersistedLocalPorts(paths, environment);
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const runtime = readJsonFile<KoedServerRuntimeState>(
    paths.runtimeStatePath,
    deps.readFileSync
  );
  const runtimeProcessRunning = runtime ? deps.checkPid(runtime.pid) : false;
  const runtimeEnvironment =
    runtime && runtimeProcessRunning
      ? {
          ...environment,
          KOED_RUNTIME_MODE: runtime.runtimeMode,
          KOED_DEPENDENCY_MODE: runtime.dependencyMode,
          ...(runtime.automaticPorts ? { KOED_AUTO_PORTS: "1" } : {}),
          ...(runtime.codexTranscriptWatcherEnabled === undefined
            ? {}
            : {
                MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: String(
                  runtime.codexTranscriptWatcherEnabled
                )
              }),
          ...(runtime.claudeTranscriptWatcherEnabled === undefined
            ? {}
            : {
                MEMORY_CLAUDE_TRANSCRIPT_WATCHER_ENABLED: String(
                  runtime.claudeTranscriptWatcherEnabled
                )
              })
        }
      : environment;
  const serverConfig = resolveKoedServerConfig(
    paths,
    koedServerConfigEnvironment(runtimeEnvironment, repoEnv),
    {
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync
    }
  );
  const apiUrl =
    runtimeProcessRunning && runtime?.apiUrl
      ? runtime.apiUrl
      : resolveApiUrl(runtimeEnvironment, repoEnv);
  // Automatic ports identify a Desktop-owned local control plane. Without a
  // live runtime for this KOED_HOME, a healthy service on the default port may
  // be an unrelated Koed backend and must not satisfy local readiness.
  const apiReady =
    runtimeEnvironment.KOED_AUTO_PORTS === "1" && !runtimeProcessRunning
      ? statusWaitingForManagedRuntime(Boolean(runtime))
      : await statusFromApiReady(apiUrl, deps.fetch, {
          dependencyMode: serverConfig.dependencyMode
        });
  const serviceEnvironment = { ...repoEnv, ...runtimeEnvironment };
  const useBundledLocalDependencies =
    serverConfig.dependencyMode === "bundled-local";
  const apiToken = await inspectApiToken(
    paths,
    runtimeEnvironment,
    repoEnv,
    apiUrl,
    deps.fetch
  );
  const capabilityReadModel = await fetchAiClientCapabilityReadModel(
    paths,
    runtimeEnvironment,
    repoEnv,
    apiUrl,
    deps.fetch
  );
  const localAiRuntime = inspectLocalAiRuntime(
    runtime,
    runtimeProcessRunning,
    serverConfig.runtimeMode,
    deps
  );
  const codex = inspectSafely(
    "Codex",
    () => inspectCodex(runtimeEnvironment, paths, deps),
    { state: "needs_attention", configured: false }
  );
  const claudeCode = inspectSafely(
    "Claude Code",
    () => inspectClaudeCode(runtimeEnvironment, paths, deps),
    { state: "needs_attention", configured: false, detected: false }
  );
  const pi = inspectSafely(
    "Pi",
    () => inspectPi(runtimeEnvironment, paths, deps),
    { state: "needs_attention", configured: false, detected: false }
  );
  const captureHook = inspectSafely(
    "Supported Capture Hook",
    () => inspectCaptureHook(runtimeEnvironment, paths, deps),
    { state: "needs_attention" }
  );
  const codexTranscriptWatcher = inspectCodexTranscriptWatcher(
    serverConfig.codexTranscriptWatcherEnabled,
    runtime,
    runtimeProcessRunning,
    deps
  );
  const mcpServer = inspectSafely(
    "MCP Server",
    () => inspectMcp(runtimeEnvironment, paths, deps),
    { state: "needs_attention" }
  );
  const claudeTranscriptWatcher = inspectClaudeTranscriptWatcher(
    serverConfig.claudeTranscriptWatcherEnabled,
    runtime,
    runtimeProcessRunning,
    deps
  );
  const externalRedisUrl =
    serverConfig.external?.redisUrl ??
    runtimeEnvironment.REDIS_URL ??
    repoEnv.REDIS_URL;
  const queueBackend = resolveEffectiveWorkQueueBackend(
    serverConfig.dependencyMode,
    runtimeEnvironment,
    repoEnv
  );
  const localQueueRedisBypass = healthy(
    "Postgres-backed local queue does not require Redis.",
    { backend: queueBackend, required: false }
  );
  const localQueueStatus =
    apiReady.workerQueues.state === "healthy"
      ? healthy("Postgres-backed local queue is ready.", {
          backend: queueBackend,
          readiness: apiReady.workerQueues.details
        })
      : apiReady.workerQueues;
  const redisStatus =
    queueBackend === "local"
      ? apiReady.redis.state === "starting"
        ? localQueueRedisBypass
        : apiReady.redis
      : apiReady.redis;
  const databaseStatus =
    useBundledLocalDependencies && apiReady.database.state === "starting"
      ? collectLocalPostgresRuntimeStatus(paths, serviceEnvironment, {
          existsSync: deps.existsSync,
          spawnSync: deps.spawnSync
        })
      : apiReady.database;
  const embeddingStatus =
    useBundledLocalDependencies &&
    apiReady.embeddingService.state === "starting"
      ? await collectLocalEmbeddingRuntimeStatus(paths, serviceEnvironment, {
          existsSync: deps.existsSync,
          fetch: deps.fetch
        })
      : apiReady.embeddingService;
  const queueDependency =
    queueBackend === "local"
      ? localQueueStatus
      : externalRedisUrl
        ? apiReady.redis
        : needsAttention(
            `${serverConfig.dependencyMode === "external" ? "External dependency mode" : "Bundled-local mode with WORK_QUEUE_BACKEND=bullmq"} requires an Operator-managed Redis URL for BullMQ queues.`,
            "Set external.redisUrl in KOED_HOME/config/server.json or set REDIS_URL, or set WORK_QUEUE_BACKEND=local."
          );
  const workerPid = runtime?.processes?.worker;
  const workerRunning = workerPid ? deps.checkPid(workerPid) : false;
  const workerQueues =
    queueDependency.state !== "healthy"
      ? queueDependency
      : workerRunning
        ? healthy("Queue dependency and Worker process are running.", {
            queue: queueDependency.details,
            workerPid
          })
        : starting("Worker process has not reported as running yet.", {
            queue: queueDependency.details,
            workerPid: workerPid ?? null
          });
  const lcmSummaryService =
    localAiRuntime.state === "healthy"
      ? healthy(
          "LCM Summary Service process is available through the Local AI Runtime."
        )
      : needsAttention(
          "LCM Summary Service process is not healthy.",
          "Fix Local AI Runtime health first."
        );
  const coreComponents = {
    api: apiReady.api,
    database: databaseStatus,
    redis: redisStatus,
    workerQueues,
    embeddingService: embeddingStatus,
    localAiRuntime,
    apiToken,
    mcpServer
  };
  const coreState = aggregateState(Object.values(coreComponents));
  const lastVerification = inspectLastVerification(paths, deps);
  const readinessInput = {
    codex,
    claudeCode,
    pi,
    codexTranscriptWatcher,
    claudeTranscriptWatcher,
    mcpServer,
    localAiRuntime,
    capabilityReadModel,
    now: deps.now().toISOString()
  };
  const aiClients = inspectAiClientReadiness(readinessInput);
  const aiClientInstances = inspectAiClientInstanceReadiness(readinessInput);
  const aiClientFlowReadiness = inspectAiClientFlowReadiness({
    environment: serviceEnvironment,
    capabilityReadModel,
    now: readinessInput.now
  });
  const [deviceIdentity, upstreamBackends] = await Promise.all([
    inspectDeviceIdentity(paths, environment),
    Promise.resolve(inspectUpstreamBackends(paths, deps))
  ]);
  const statusWithoutState = {
    ok: false,
    state: "starting" as KoedServerComponentState,
    koedHome: paths.koedHome,
    generatedAt: deps.now().toISOString(),
    runtimeMode: serverConfig.runtimeMode,
    dependencyMode: serverConfig.dependencyMode,
    api: { ...apiReady.api, url: apiUrl },
    database: databaseStatus,
    redis: redisStatus,
    workerQueues,
    embeddingService: embeddingStatus,
    localAiRuntime,
    apiToken,
    mcpServer,
    captureHook,
    codexTranscriptWatcher,
    claudeTranscriptWatcher,
    codex,
    claudeCode,
    pi,
    aiClients,
    aiClientInstances,
    aiClientFlowReadiness,
    lcmSummaryService,
    deviceIdentity,
    upstreamBackends,
    lastVerification,
    core: { state: coreState, components: coreComponents }
  } satisfies KoedServerStatus;

  return {
    ...statusWithoutState,
    state: coreState,
    ok: coreState === "healthy"
  };
};

export const collectKoedServerDoctor = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: KoedServerStatusDependencies = {}
): Promise<KoedServerDoctorResult> => {
  const status = await collectKoedServerStatus(environment, dependencies);
  const checks: KoedServerDoctorCheck[] = [
    ["api", "API", status.api],
    ["database", "Database", status.database],
    ["redis", "Redis", status.redis],
    ["workerQueues", "Redis/queues", status.workerQueues],
    ["embeddingService", "Embedding Service", status.embeddingService],
    ["localAiRuntime", "Local AI Runtime", status.localAiRuntime],
    ["apiToken", "Local credential/API Token", status.apiToken],
    ["mcpServer", "MCP Server", status.mcpServer],
    ["captureHook", "Supported Capture Hook", status.captureHook],
    [
      "codexTranscriptWatcher",
      "Codex Transcript Watcher",
      status.codexTranscriptWatcher
    ],
    [
      "claudeTranscriptWatcher",
      "Claude Transcript Watcher",
      status.claudeTranscriptWatcher
    ],
    ["codex", "Codex configuration", status.codex],
    ["claudeCode", "Claude Code configuration", status.claudeCode],
    ["pi", "Pi configuration", status.pi],
    ["lcmSummaryService", "LCM Summary Service", status.lcmSummaryService],
    ...localAiClientFlowKeys.map(
      (flowKey) =>
        [
          `aiClientFlow:${flowKey}`,
          `${flowKey} AI Client assignment`,
          status.aiClientFlowReadiness[flowKey]
        ] as const
    ),
    ["deviceIdentity", "Device identity", status.deviceIdentity],
    ["upstreamBackends", "Upstream Backends", status.upstreamBackends],
    ["lastVerification", "Last verification", status.lastVerification]
  ].map(([id, label, component]) => ({
    id: id as string,
    label: label as string,
    ...(component as KoedServerComponentStatus)
  }));
  const coreCheckIds = new Set(Object.keys(status.core.components));
  const blockingChecks = checks.filter((check) => coreCheckIds.has(check.id));
  const failed = blockingChecks.filter(
    (check) => check.state === "needs_attention"
  );
  const missing = blockingChecks.filter(
    (check) => check.state === "not_configured"
  );
  const startingChecks = blockingChecks.filter(
    (check) => check.state === "starting"
  );
  const summary =
    failed[0]?.message ??
    missing[0]?.message ??
    startingChecks[0]?.message ??
    "Koed local control plane is healthy.";
  return {
    ok: blockingChecks.every((check) => check.state === "healthy"),
    state: status.state,
    summary,
    koedHome: status.koedHome,
    generatedAt: status.generatedAt,
    runtimeMode: status.runtimeMode,
    dependencyMode: status.dependencyMode,
    checks
  };
};
