import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  resolveActiveIntegrationApiToken,
  resolveLocalApiToken,
  writeExplorerCredential
} from "./credentials.js";
import { resolveKoedServerConfig } from "./config.js";
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import {
  localPostgresEnv,
  resolveLocalPostgresRuntimePaths
} from "./local-postgres-runtime.js";
import { readLocalServiceSecrets } from "./local-service-secrets.js";
import {
  ensureKoedHome,
  resolveKoedServerPaths,
  type KoedServerPaths
} from "./paths.js";
import { applyPersistedLocalPorts } from "./ports.js";
import { isProcessRunning } from "./process-liveness.js";
import { resolveKoedAppRuntime } from "./app-runtime.js";
import type { KoedServerRuntimeState } from "./types.js";

export interface KoedServerSetupCodexResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  koedHome: string;
  apiUrl: string;
  explorerUrl: string;
  checkedAt: string;
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validHttpUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const validProcessMap = (value: unknown): boolean =>
  value === undefined ||
  (isRecord(value) &&
    Object.values(value).every(
      (pid) => typeof pid === "number" && Number.isInteger(pid) && pid >= 0
    ));

const validRuntimeState = (value: unknown): value is KoedServerRuntimeState => {
  if (!isRecord(value)) return false;
  const validRuntimeMode =
    value.runtimeMode === undefined ||
    value.runtimeMode === "local-personal" ||
    value.runtimeMode === "external" ||
    value.runtimeMode === "developer";
  const validDependencyMode =
    value.dependencyMode === undefined ||
    value.dependencyMode === "bundled-local" ||
    value.dependencyMode === "external";
  return (
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt)) &&
    typeof value.repoRoot === "string" &&
    Boolean(value.repoRoot.trim()) &&
    validHttpUrl(value.apiUrl) &&
    validHttpUrl(value.explorerUrl) &&
    Array.isArray(value.services) &&
    value.services.every((service) => typeof service === "string") &&
    validRuntimeMode &&
    validDependencyMode &&
    validProcessMap(value.processes)
  );
};

const readRuntimeState = (
  path: string,
  readFileSync: typeof nodeReadFileSync = nodeReadFileSync
): KoedServerRuntimeState | null => {
  try {
    const parsed: unknown = JSON.parse(String(readFileSync(path, "utf8")));
    return validRuntimeState(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readActiveRuntimeState = (
  path: string,
  readFileSync: typeof nodeReadFileSync,
  checkPid: (pid: number) => boolean
): KoedServerRuntimeState | null => {
  const runtime = readRuntimeState(path, readFileSync);
  return runtime && checkPid(runtime.pid) ? runtime : null;
};

const applyActiveRuntimeUrls = (
  environment: NodeJS.ProcessEnv,
  runtime: KoedServerRuntimeState | null
): NodeJS.ProcessEnv => ({
  ...environment,
  ...(runtime?.apiUrl && !environment.MEMORY_API_URL
    ? { MEMORY_API_URL: runtime.apiUrl }
    : {}),
  ...(runtime?.explorerUrl && !environment.KOED_EXPLORER_URL
    ? { KOED_EXPLORER_URL: runtime.explorerUrl }
    : {})
});

export interface KoedServerSetupOptions {
  environment?: NodeJS.ProcessEnv;
  spawnSync?: SpawnSyncLike;
  readFileSync?: typeof nodeReadFileSync;
  writeFileSync?: typeof nodeWriteFileSync;
  mkdirSync?: typeof nodeMkdirSync;
  existsSync?: typeof nodeExistsSync;
  checkPid?: (pid: number) => boolean;
  now?: () => Date;
}

export interface KoedServerRepairCodexResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  koedHome: string;
  apiUrl: string;
  checkedAt: string;
  command: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

const tomlString = (value: string): string => JSON.stringify(value);

const configureCodexIntegration = ({
  paths,
  environment,
  apiUrl,
  apiToken,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync
}: {
  paths: ReturnType<typeof resolveKoedServerPaths>;
  environment: NodeJS.ProcessEnv;
  apiUrl: string;
  apiToken: string;
  readFileSync: typeof nodeReadFileSync;
  writeFileSync: typeof nodeWriteFileSync;
  mkdirSync: typeof nodeMkdirSync;
  existsSync: typeof nodeExistsSync;
}): { command: string; stdout: string } => {
  const runtime = resolveKoedAppRuntime(paths, environment, existsSync);
  const missing = [runtime.mcpCli, runtime.captureHook].filter(
    (path) => !existsSync(path)
  );
  const command = `write Codex config using ${runtime.root}`;
  if (missing.length > 0) {
    throw new Error(
      `Koed MCP Server artifacts are missing: ${missing.join(", ")}. Rebuild Koed Desktop packaging so koed-runtime contains the MCP Server and Supported Capture Hook artifacts.`
    );
  }

  const nodeCommand = environment.MEMORY_NODE_COMMAND ?? "node";
  const appServerBinary = environment.MEMORY_CODEX_APP_SERVER_BINARY ?? "codex";
  const mcpName = environment.MEMORY_MCP_NAME ?? "koed";
  const codexConfigPath = resolve(
    environment.CODEX_CONFIG_PATH ?? `${homedir()}/.codex/config.toml`
  );
  const hookConfigPath = resolve(
    environment.MEMORY_HOOK_CONFIG ?? `${homedir()}/.koed/config.json`
  );
  const hookRequestTimeoutMs = Number.parseInt(
    environment.MEMORY_HOOK_API_REQUEST_TIMEOUT_MS ?? "1500",
    10
  );

  mkdirSync(dirname(hookConfigPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    hookConfigPath,
    `${JSON.stringify(
      {
        apiUrl,
        apiToken,
        captureEnabled: true,
        requestTimeoutMs:
          Number.isFinite(hookRequestTimeoutMs) && hookRequestTimeoutMs > 0
            ? hookRequestTimeoutMs
            : 1500
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  const markerStart = "# >>> koed";
  const markerEnd = "# <<< koed";
  const hookCommand = `${nodeCommand} ${runtime.captureHook} --config ${hookConfigPath}`;
  const hookEvents = [
    ["SessionStart", 10],
    ["UserPromptSubmit", 10],
    ["PostToolUse", 10],
    ["Stop", 30],
    ["SubagentStart", 10],
    ["SubagentStop", 30]
  ] as const;
  const hookBlocks = hookEvents
    .map(
      ([eventName, timeout]) => `[[hooks.${eventName}]]
[[hooks.${eventName}.hooks]]
type = "command"
command = ${tomlString(hookCommand)}
timeout = ${timeout}`
    )
    .join("\n\n");
  const koedBlock = `${markerStart}
[mcp_servers.${mcpName}]
command = ${tomlString(nodeCommand)}
args = [${tomlString(runtime.mcpCli)}]
enabled = true

[mcp_servers.${mcpName}.env]
MEMORY_API_URL = ${tomlString(apiUrl)}
MEMORY_API_TOKEN = ${tomlString(apiToken)}
MEMORY_CODEX_APP_SERVER_BINARY = ${tomlString(appServerBinary)}

${hookBlocks}
${markerEnd}
`;

  const existing = existsSync(codexConfigPath)
    ? String(readFileSync(codexConfigPath, "utf8"))
    : "";
  const withoutPrevious = existing.replace(
    new RegExp(`\\n?${markerStart}[\\s\\S]*?${markerEnd}\\n?`, "g"),
    "\n"
  );
  mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    codexConfigPath,
    `${withoutPrevious.trimEnd()}\n\n${koedBlock}`
  );

  return {
    command,
    stdout: [
      "Codex integration configured.",
      `Detected API URL: ${apiUrl}`,
      `Detected Node command: ${nodeCommand}`,
      `Detected Codex app-server binary: ${appServerBinary}`,
      `Wrote Codex MCP config: ${codexConfigPath}`,
      `Wrote Capture Hook config: ${hookConfigPath}`
    ].join("\n")
  };
};

export const repairCodexIntegration = ({
  environment = process.env,
  readFileSync = nodeReadFileSync,
  writeFileSync = nodeWriteFileSync,
  mkdirSync = nodeMkdirSync,
  existsSync = nodeExistsSync,
  checkPid = isProcessRunning,
  now = () => new Date()
}: Omit<
  KoedServerSetupOptions,
  "spawnSync"
> = {}): KoedServerRepairCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  environment = applyActiveRuntimeUrls(
    applyPersistedLocalPorts(paths, environment),
    readActiveRuntimeState(paths.runtimeStatePath, readFileSync, checkPid)
  );
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const checkedAt = now().toISOString();
  const apiToken = resolveActiveIntegrationApiToken(
    paths,
    environment,
    repoEnv
  );

  if (!apiToken) {
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command: "write Codex config",
      error: "No Koed API Token is available for the Codex integration.",
      action:
        "Start Koed Desktop first so it can provision a local Explorer/API Token, then run Fix Codex integration again."
    };
  }

  try {
    const result = configureCodexIntegration({
      paths,
      environment: { ...repoEnv, ...environment },
      apiUrl,
      apiToken: apiToken.token,
      readFileSync,
      writeFileSync,
      mkdirSync,
      existsSync
    });
    return {
      ok: true,
      state: "healthy",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command: result.command,
      stdout: result.stdout,
      action:
        "Restart Codex and trust updated hooks if prompted. New sessions will be captured after Codex reloads this config."
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command: "write Codex config",
      error: message,
      action:
        "Review the reported failure, fix the Codex integration artifacts, then run Fix Codex integration again."
    };
  }
};

const trimValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const setupRuntimeEnvironment = (
  environment: NodeJS.ProcessEnv,
  runtime: KoedServerRuntimeState | null
): NodeJS.ProcessEnv =>
  applyActiveRuntimeUrls(
    {
      ...environment,
      ...(runtime?.runtimeMode && !trimValue(environment.KOED_RUNTIME_MODE)
        ? { KOED_RUNTIME_MODE: runtime.runtimeMode }
        : {}),
      ...(runtime?.dependencyMode &&
      !trimValue(environment.KOED_DEPENDENCY_MODE)
        ? { KOED_DEPENDENCY_MODE: runtime.dependencyMode }
        : {})
    },
    runtime
  );

type BundledDatabaseResolution =
  | { ok: true; environment: NodeJS.ProcessEnv }
  | { ok: false; error: string; action: string };

const resolveBundledDatabaseEnvironment = (
  paths: KoedServerPaths,
  invocationEnvironment: NodeJS.ProcessEnv,
  environment: NodeJS.ProcessEnv,
  repoEnv: Record<string, string>,
  dependencies: Pick<KoedServerSetupOptions, "existsSync" | "readFileSync">
): BundledDatabaseResolution => {
  const explicitDatabaseUrl = trimValue(invocationEnvironment.DATABASE_URL);
  if (explicitDatabaseUrl) {
    return { ok: true, environment: { DATABASE_URL: explicitDatabaseUrl } };
  }
  const explicitPassword =
    trimValue(invocationEnvironment.POSTGRES_PASSWORD) ??
    trimValue(invocationEnvironment.KOED_BUNDLED_POSTGRES_PASSWORD);
  const persisted = explicitPassword
    ? ({ state: "absent" } as const)
    : readLocalServiceSecrets(paths, dependencies);
  if (persisted.state === "invalid") {
    return {
      ok: false,
      error: `Persisted local service secrets at ${persisted.path} are malformed: ${persisted.error}.`,
      action: `Fix or remove ${persisted.path}, restart packaged Koed Desktop to regenerate local service secrets, then rerun koed-server setup codex --json.`
    };
  }
  if (persisted.state === "valid" && !persisted.secrets.POSTGRES_PASSWORD) {
    return {
      ok: false,
      error: `Persisted local service secrets at ${persisted.path} are missing required POSTGRES_PASSWORD.`,
      action: `Fix or remove ${persisted.path}, restart packaged Koed Desktop to regenerate local service secrets, then rerun koed-server setup codex --json.`
    };
  }
  const password =
    explicitPassword ??
    (persisted.state === "valid"
      ? persisted.secrets.POSTGRES_PASSWORD
      : undefined) ??
    trimValue(repoEnv.POSTGRES_PASSWORD) ??
    trimValue(repoEnv.KOED_BUNDLED_POSTGRES_PASSWORD);
  const postgresEnvironment = {
    ...repoEnv,
    ...environment,
    ...(password ? { POSTGRES_PASSWORD: password } : {})
  };
  return {
    ok: true,
    environment: localPostgresEnv(
      resolveLocalPostgresRuntimePaths(paths, postgresEnvironment)
    )
  };
};

interface SetupCodexBaseContext {
  paths: KoedServerPaths;
  environment: NodeJS.ProcessEnv;
  repoEnv: Record<string, string>;
  dependencyMode: "bundled-local" | "external";
  apiUrl: string;
  explorerUrl: string;
  checkedAt: string;
  scriptPath: string;
}

interface SetupCodexContext extends SetupCodexBaseContext {
  childEnv: NodeJS.ProcessEnv;
}

type PreparedSetupCodex =
  | { ok: true; context: SetupCodexContext }
  | { ok: false; result: KoedServerSetupCodexResult; paths: KoedServerPaths };

const resolveSetupCodexBase = (
  invocationEnvironment: NodeJS.ProcessEnv,
  options: KoedServerSetupOptions
): SetupCodexBaseContext => {
  const paths = resolveKoedServerPaths(invocationEnvironment);
  ensureKoedHome(paths);
  const runtime = readActiveRuntimeState(
    paths.runtimeStatePath,
    options.readFileSync ?? nodeReadFileSync,
    options.checkPid ?? isProcessRunning
  );
  let environment = setupRuntimeEnvironment(invocationEnvironment, runtime);
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const config = resolveKoedServerConfig(paths, {
    ...repoEnv,
    ...environment
  });
  environment = applyPersistedLocalPorts(paths, environment, {
    force: config.dependencyMode === "bundled-local"
  });
  return {
    paths,
    environment,
    repoEnv,
    dependencyMode: config.dependencyMode,
    apiUrl: resolveApiUrl(environment, repoEnv),
    explorerUrl: resolveExplorerUrl(environment, repoEnv),
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    scriptPath: resolve(paths.repoRoot, "scripts/clients-bootstrap.mjs")
  };
};

const prepareSetupCodex = (
  invocationEnvironment: NodeJS.ProcessEnv,
  options: KoedServerSetupOptions
): PreparedSetupCodex => {
  const base = resolveSetupCodexBase(invocationEnvironment, options);
  const database =
    base.dependencyMode === "bundled-local"
      ? resolveBundledDatabaseEnvironment(
          base.paths,
          invocationEnvironment,
          base.environment,
          base.repoEnv,
          options
        )
      : { ok: true as const, environment: {} };
  if (!database.ok) {
    return {
      ok: false,
      paths: base.paths,
      result: {
        ok: false,
        state: "needs_attention",
        koedHome: base.paths.koedHome,
        apiUrl: base.apiUrl,
        explorerUrl: base.explorerUrl,
        checkedAt: base.checkedAt,
        command: "resolve bundled-local setup environment",
        error: database.error,
        action: database.action
      }
    };
  }
  return {
    ok: true,
    context: {
      ...base,
      childEnv: {
        ...process.env,
        ...base.repoEnv,
        ...base.environment,
        ...database.environment,
        KOED_SERVER_MANAGED: "1"
      }
    }
  };
};

const persistSetupApiToken = (
  context: SetupCodexContext,
  repoEnv: Record<string, string> = context.repoEnv
): void => {
  const apiToken = resolveLocalApiToken(context.environment, repoEnv);
  if (!apiToken) return;
  writeExplorerCredential(context.paths, {
    apiToken: apiToken.token,
    provisionedAt: context.checkedAt,
    source: apiToken.source
  });
};

const runSetupBootstrap = (
  context: SetupCodexContext,
  spawnSync: SpawnSyncLike
): KoedServerSetupCodexResult => {
  const result = spawnSync(process.execPath, [context.scriptPath], {
    cwd: context.paths.repoRoot,
    env: context.childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000
  });
  const base = {
    koedHome: context.paths.koedHome,
    apiUrl: context.apiUrl,
    explorerUrl: context.explorerUrl,
    checkedAt: context.checkedAt,
    command: `node ${context.scriptPath}`
  };
  if (result.error) {
    return {
      ...base,
      ok: false,
      state: "needs_attention",
      error: result.error.message,
      action:
        "Fix the reported setup failure, then rerun koed-server setup codex --json."
    };
  }
  const output = {
    stdout: result.stdout.trim() || undefined,
    stderr: result.stderr.trim() || undefined
  };
  return result.status === 0
    ? { ...base, ...output, ok: true, state: "healthy" }
    : {
        ...base,
        ...output,
        ok: false,
        state: "needs_attention",
        error: `Codex setup failed with exit code ${result.status ?? 1}.`,
        action:
          "Review stdout/stderr, fix the reported setup failure, then rerun koed-server setup codex --json."
      };
};

const writeSetupVerification = (
  paths: KoedServerPaths,
  result: KoedServerSetupCodexResult,
  writeFileSync: typeof nodeWriteFileSync
): void => {
  writeFileSync(
    paths.lastVerificationPath,
    `${JSON.stringify(
      {
        ok: result.ok,
        checkedAt: result.checkedAt,
        message: result.ok ? "Codex setup completed." : result.error
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
};

export const setupCodex = (
  options: KoedServerSetupOptions = {}
): KoedServerSetupCodexResult => {
  const environment = options.environment ?? process.env;
  const writeFileSync = options.writeFileSync ?? nodeWriteFileSync;
  const prepared = prepareSetupCodex(environment, options);
  if (!prepared.ok) {
    writeSetupVerification(prepared.paths, prepared.result, writeFileSync);
    return prepared.result;
  }
  const { context } = prepared;
  persistSetupApiToken(context);
  const result = runSetupBootstrap(
    context,
    options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike)
  );
  if (result.ok) {
    persistSetupApiToken(context, loadRepoEnv(context.paths.repoRoot));
  }
  writeSetupVerification(context.paths, result, writeFileSync);
  return result;
};
