import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import { resolveKoedServerConfig } from "./config.js";
import {
  loadExplorerCredential,
  resolveActiveIntegrationApiToken
} from "./credentials.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import { resolveKoedAppRuntime } from "./app-runtime.js";
import { collectLocalEmbeddingRuntimeStatus } from "./local-embedding-runtime.js";
import { collectLocalPostgresRuntimeStatus } from "./local-postgres-runtime.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import { applyPersistedLocalPorts } from "./ports.js";
import { isProcessRunning } from "./process-liveness.js";
import { ensureDeviceIdentity } from "./device-identity.js";
import { collectUpstreamRegistryStatus } from "./upstream-registry.js";
import type {
  KoedServerComponentState,
  KoedServerComponentStatus,
  KoedServerDoctorCheck,
  KoedServerDoctorResult,
  KoedServerRuntimeState,
  KoedServerStatus
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
  checkPid?: (pid: number) => boolean;
  now?: () => Date;
}

const defaultDependencies = (): Required<KoedServerStatusDependencies> => ({
  fetch: globalThis.fetch.bind(globalThis),
  spawnSync: nodeSpawnSync as SpawnSyncLike,
  existsSync,
  readFileSync,
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

const inspectApiToken = (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>
): KoedServerStatus["apiToken"] => {
  const token = resolveActiveIntegrationApiToken(paths, environment, repoEnv);
  if (!token) {
    return {
      ...notConfigured(
        "No local API Token is configured for Koed integrations.",
        "Run koed-server setup codex --json or create an API Token."
      ),
      configured: false
    };
  }
  return { ...healthy("A local API Token is configured."), configured: true };
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
  apiUrl: string,
  apiToken: string | undefined,
  environment: NodeJS.ProcessEnv,
  deps: Required<KoedServerStatusDependencies>
): KoedServerStatus["codex"] => {
  const codexConfigPath = resolve(
    environment.CODEX_CONFIG_PATH ??
      `${environment.HOME ?? ""}/.codex/config.toml`
  );
  if (!deps.existsSync(codexConfigPath)) {
    return {
      ...notConfigured(
        "Codex configuration was not found.",
        "Run Fix Codex integration to configure the supported AI Client integration."
      ),
      configured: false
    };
  }
  const content = deps.readFileSync(codexConfigPath, "utf8") as string;
  const mcpName = environment.MEMORY_MCP_NAME ?? "koed";
  const mcpBlock = tomlSection(content, `mcp_servers.${mcpName}`);
  const mcpEnvBlock = tomlSection(content, `mcp_servers.${mcpName}.env`);
  const configured = content.includes("# >>> koed") && Boolean(mcpBlock);
  if (!configured) {
    return {
      ...notConfigured(
        "Codex is installed but Koed is not configured in Codex.",
        "Run Fix Codex integration."
      ),
      configured: false
    };
  }

  const configuredApiUrl = tomlStringValue(mcpEnvBlock, "MEMORY_API_URL");
  const configuredToken = tomlStringValue(mcpEnvBlock, "MEMORY_API_TOKEN");
  if (
    configuredApiUrl &&
    configuredApiUrl.replace(/\/+$/, "") !== apiUrl.replace(/\/+$/, "")
  ) {
    return {
      ...needsAttention(
        `Codex Koed integration points to ${configuredApiUrl}, but Koed Desktop is running at ${apiUrl}.`,
        "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
        { configuredApiUrl, expectedApiUrl: apiUrl, codexConfigPath }
      ),
      configured: true
    };
  }
  if (apiToken && configuredToken && configuredToken !== apiToken) {
    return {
      ...needsAttention(
        "Codex Koed integration uses a different API Token than Koed Desktop.",
        "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
        {
          configuredApiUrl: configuredApiUrl ?? null,
          expectedApiUrl: apiUrl,
          codexConfigPath
        }
      ),
      configured: true
    };
  }
  if (!configuredApiUrl || !configuredToken) {
    return {
      ...needsAttention(
        "Codex Koed integration is missing API URL or API Token configuration.",
        "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
        { codexConfigPath }
      ),
      configured: true
    };
  }
  return {
    ...healthy("Codex Koed integration is configured.", {
      configuredApiUrl,
      codexConfigPath
    }),
    configured: true
  };
};

const inspectCaptureHook = (
  apiUrl: string,
  apiToken: string | undefined,
  environment: NodeJS.ProcessEnv,
  deps: Required<KoedServerStatusDependencies>
) => {
  const hookConfigPath = resolve(
    environment.MEMORY_HOOK_CONFIG ??
      `${environment.HOME ?? ""}/.koed/config.json`
  );
  if (!deps.existsSync(hookConfigPath)) {
    return notConfigured(
      "Supported Capture Hook config was not found.",
      "Run Fix Codex integration."
    );
  }
  const parsed = readJsonFile<{
    apiUrl?: string;
    apiToken?: string;
    captureEnabled?: boolean;
  }>(hookConfigPath, deps.readFileSync);
  if (!parsed?.apiUrl || !parsed.apiToken) {
    return needsAttention(
      "Supported Capture Hook config is incomplete.",
      "Run Fix Codex integration to rewrite hook configuration.",
      { hookConfigPath }
    );
  }
  if (parsed.apiUrl.replace(/\/+$/, "") !== apiUrl.replace(/\/+$/, "")) {
    return needsAttention(
      `Supported Capture Hook points to ${parsed.apiUrl}, but Koed Desktop is running at ${apiUrl}.`,
      "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
      {
        configuredApiUrl: parsed.apiUrl,
        expectedApiUrl: apiUrl,
        hookConfigPath
      }
    );
  }
  if (apiToken && parsed.apiToken !== apiToken) {
    return needsAttention(
      "Supported Capture Hook uses a different API Token than Koed Desktop.",
      "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
      {
        configuredApiUrl: parsed.apiUrl,
        expectedApiUrl: apiUrl,
        hookConfigPath
      }
    );
  }
  if (parsed.captureEnabled === false) {
    return needsAttention(
      "Supported Capture Hook is configured but capture is disabled.",
      "Run Fix Codex integration or enable capture in the Koed hook config.",
      { hookConfigPath }
    );
  }
  return healthy("Supported Capture Hook is configured.", {
    configuredApiUrl: parsed.apiUrl,
    hookConfigPath
  });
};

const inspectMcp = (
  apiUrl: string,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
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
        : "Run pnpm --filter @koed/mcp-server build or koed-server setup codex --json.",
      {
        artifactSource: appRuntime.artifactSource,
        runtimeRoot: appRuntime.root,
        missing: appRuntime.missing
      }
    );
  }
  const token = resolveActiveIntegrationApiToken(
    paths,
    environment,
    repoEnv
  )?.token;
  if (!token) {
    return notConfigured(
      "MCP Server needs a local API Token.",
      "Run koed-server setup codex --json."
    );
  }
  const result = deps.spawnSync(process.execPath, [cliPath, "doctor"], {
    cwd: paths.repoRoot,
    env: {
      ...process.env,
      ...repoEnv,
      MEMORY_API_URL: apiUrl,
      MEMORY_API_TOKEN: token
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

const inspectExplorer = async (
  explorerUrl: string,
  runtime: KoedServerRuntimeState | null,
  runtimeProcessRunning: boolean,
  explorerCredentialConfigured: boolean,
  deps: Required<KoedServerStatusDependencies>
): Promise<KoedServerComponentStatus> => {
  const explorerPid = runtime?.processes?.explorer;
  const details = {
    appCredentialProvisioned: explorerCredentialConfigured,
    explorerPid: explorerPid ?? null
  };
  if (!runtimeProcessRunning) {
    return starting(
      "Koed server supervisor is not currently running.",
      details
    );
  }
  if (!explorerPid) {
    return needsAttention(
      "Explorer process is not recorded in koed-server runtime state.",
      "Restart koed-server or inspect Koed logs.",
      details
    );
  }
  if (!deps.checkPid(explorerPid)) {
    return needsAttention(
      "Explorer process is not running.",
      "Run koed-server restart --json or inspect Koed logs.",
      details
    );
  }

  try {
    const response = await deps.fetch(explorerUrl);
    if (response.ok) {
      return healthy("Explorer is reachable through the Koed local service.", {
        ...details,
        httpStatus: response.status
      });
    }
    return needsAttention(
      `Explorer is not reachable at ${explorerUrl} (HTTP ${response.status}).`,
      "Run koed-server restart --json or inspect Explorer logs.",
      { ...details, httpStatus: response.status }
    );
  } catch (error) {
    return needsAttention(
      `Explorer is not reachable at ${explorerUrl} (${error instanceof Error ? error.message : String(error)}).`,
      "Run koed-server restart --json or inspect Explorer logs.",
      details
    );
  }
};

const inspectCodexTranscriptWatcher = (
  enabled: boolean,
  runtime: KoedServerRuntimeState | null,
  runtimeProcessRunning: boolean,
  deps: Required<KoedServerStatusDependencies>
): KoedServerComponentStatus => {
  const watcherPid = runtime?.processes?.codexTranscriptWatcher;
  const details = { enabled, watcherPid: watcherPid ?? null };
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
  if (!watcherPid) {
    return needsAttention(
      "Codex Transcript Watcher process is not recorded in koed-server runtime state.",
      "Verify an API Token is configured, then restart koed-server or inspect Koed logs.",
      details
    );
  }
  if (!deps.checkPid(watcherPid)) {
    return needsAttention(
      "Codex Transcript Watcher process is not running.",
      "Run koed-server restart --json or inspect Koed logs.",
      details
    );
  }
  return healthy("Codex Transcript Watcher process is running.", details);
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
        "Run koed-server setup codex --json."
      ),
      checkedAt: null
    };
  }
  return {
    ...(value.ok === false
      ? needsAttention(
          value.message ?? "Last verification failed.",
          "Run koed-server setup codex --json."
        )
      : healthy("Last setup verification passed.")),
    checkedAt: value.checkedAt
  };
};

const inspectDeviceIdentity = async (
  paths: KoedServerPaths,
  environment: NodeJS.ProcessEnv
): Promise<KoedServerStatus["deviceIdentity"]> => {
  const identity = await ensureDeviceIdentity(paths, { environment });
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
          ...(runtime.codexTranscriptWatcherEnabled === undefined
            ? {}
            : {
                MEMORY_CODEX_TRANSCRIPT_WATCHER_ENABLED: String(
                  runtime.codexTranscriptWatcherEnabled
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
  const explorerUrl =
    runtimeProcessRunning && runtime?.explorerUrl
      ? runtime.explorerUrl
      : resolveExplorerUrl(runtimeEnvironment, repoEnv);
  const apiReady = await statusFromApiReady(apiUrl, deps.fetch, {
    dependencyMode: serverConfig.dependencyMode
  });
  const serviceEnvironment = { ...repoEnv, ...runtimeEnvironment };
  const useBundledLocalDependencies =
    serverConfig.dependencyMode === "bundled-local";
  const integrationToken = resolveActiveIntegrationApiToken(
    paths,
    runtimeEnvironment,
    repoEnv
  );
  const apiToken = inspectApiToken(paths, runtimeEnvironment, repoEnv);
  const codex = inspectCodex(
    apiUrl,
    integrationToken?.token,
    runtimeEnvironment,
    deps
  );
  const captureHook = inspectCaptureHook(
    apiUrl,
    integrationToken?.token,
    runtimeEnvironment,
    deps
  );
  const codexTranscriptWatcher = inspectCodexTranscriptWatcher(
    serverConfig.codexTranscriptWatcherEnabled,
    runtime,
    runtimeProcessRunning,
    deps
  );
  const mcpServer = inspectMcp(
    apiUrl,
    runtimeEnvironment,
    repoEnv,
    paths,
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
    { backend: queueBackend }
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
    mcpServer.state === "healthy"
      ? healthy("LCM Summary Service is available through the MCP Server.")
      : mcpServer.state === "not_configured"
        ? notConfigured(
            "LCM Summary Service needs the MCP Server setup.",
            "Run koed-server setup codex --json."
          )
        : needsAttention(
            "LCM Summary Service status could not be verified.",
            "Fix MCP Server health first."
          );
  const lastVerification = inspectLastVerification(paths, deps);
  const [deviceIdentity, upstreamBackends] = await Promise.all([
    inspectDeviceIdentity(paths, environment),
    Promise.resolve(inspectUpstreamBackends(paths, deps))
  ]);
  const explorerCredential = loadExplorerCredential(paths);
  const explorer = await inspectExplorer(
    explorerUrl,
    runtime,
    runtimeProcessRunning,
    Boolean(explorerCredential),
    deps
  );
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
    apiToken,
    mcpServer,
    captureHook,
    codexTranscriptWatcher,
    codex,
    lcmSummaryService,
    deviceIdentity,
    upstreamBackends,
    explorer: { ...explorer, url: explorerUrl },
    lastVerification
  } satisfies KoedServerStatus;

  const blockingComponents = [
    statusWithoutState.api,
    statusWithoutState.database,
    statusWithoutState.redis,
    statusWithoutState.workerQueues,
    statusWithoutState.embeddingService,
    statusWithoutState.apiToken,
    statusWithoutState.mcpServer,
    statusWithoutState.captureHook,
    statusWithoutState.codex,
    statusWithoutState.lcmSummaryService
  ];
  const state = aggregateState(blockingComponents);
  return { ...statusWithoutState, state, ok: state === "healthy" };
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
    ["apiToken", "Local credential/API Token", status.apiToken],
    ["mcpServer", "MCP Server", status.mcpServer],
    ["captureHook", "Supported Capture Hook", status.captureHook],
    [
      "codexTranscriptWatcher",
      "Codex Transcript Watcher",
      status.codexTranscriptWatcher
    ],
    ["codex", "Codex configuration", status.codex],
    ["lcmSummaryService", "LCM Summary Service", status.lcmSummaryService],
    ["deviceIdentity", "Device identity", status.deviceIdentity],
    ["upstreamBackends", "Upstream Backends", status.upstreamBackends],
    ["lastVerification", "Last verification", status.lastVerification]
  ].map(([id, label, component]) => ({
    id: id as string,
    label: label as string,
    ...(component as KoedServerComponentStatus)
  }));
  const blockingChecks = checks.filter(
    (check) =>
      check.id !== "lastVerification" &&
      check.id !== "upstreamBackends" &&
      check.id !== "deviceIdentity" &&
      check.id !== "codexTranscriptWatcher"
  );
  const failed = blockingChecks.filter(
    (check) => check.state === "needs_attention"
  );
  const missing = blockingChecks.filter(
    (check) => check.state === "not_configured"
  );
  const summary =
    failed[0]?.message ??
    missing[0]?.message ??
    "Koed local control plane is healthy.";
  return {
    ok: failed.length === 0 && missing.length === 0,
    state: status.state,
    summary,
    koedHome: status.koedHome,
    generatedAt: status.generatedAt,
    runtimeMode: status.runtimeMode,
    dependencyMode: status.dependencyMode,
    checks
  };
};
