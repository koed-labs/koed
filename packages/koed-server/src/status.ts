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
        { executable, version: versionText, settingsPath }
      ),
      configured: false,
      detected: true
    };
  }
  return {
    ...healthy("Claude Code is configured for Koed capture and recall.", {
      executable,
      version: versionText,
      settingsPath
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
        "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
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
        "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
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
      "Run Fix Codex integration."
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
  if (
    !content.includes("# >>> koed") ||
    !content.includes("capture-hook") ||
    missingEvents.length > 0
  ) {
    return needsAttention(
      "Supported Capture Hook signal entries are incomplete.",
      "Run Fix Codex integration, then restart Codex and trust updated hooks if prompted.",
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
        : "Run pnpm --filter @koed/mcp-server build or koed-server setup codex --json.",
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
  const apiToken = inspectApiToken(paths, runtimeEnvironment, repoEnv);
  const codex = inspectCodex(runtimeEnvironment, paths, deps);
  const claudeCode = inspectClaudeCode(runtimeEnvironment, paths, deps);
  const pi = inspectPi(runtimeEnvironment, paths, deps);
  const captureHook = inspectCaptureHook(runtimeEnvironment, paths, deps);
  const codexTranscriptWatcher = inspectCodexTranscriptWatcher(
    serverConfig.codexTranscriptWatcherEnabled,
    runtime,
    runtimeProcessRunning,
    deps
  );
  const mcpServer = inspectMcp(runtimeEnvironment, paths, deps);
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
    claudeTranscriptWatcher,
    codex,
    claudeCode,
    pi,
    lcmSummaryService,
    deviceIdentity,
    upstreamBackends,
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
    [
      "claudeTranscriptWatcher",
      "Claude Transcript Watcher",
      status.claudeTranscriptWatcher
    ],
    ["codex", "Codex configuration", status.codex],
    ["claudeCode", "Claude Code configuration", status.claudeCode],
    ["pi", "Pi configuration", status.pi],
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
      check.id !== "codexTranscriptWatcher" &&
      check.id !== "claudeTranscriptWatcher" &&
      check.id !== "claudeCode" &&
      check.id !== "pi"
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
