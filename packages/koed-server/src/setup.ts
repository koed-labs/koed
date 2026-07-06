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
import { loadRepoEnv, resolveApiUrl, resolveExplorerUrl } from "./env-file.js";
import { ensureKoedHome, resolveKoedServerPaths } from "./paths.js";
import { applyPersistedLocalPorts } from "./ports.js";
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

const readRuntimeState = (
  path: string,
  readFileSync: typeof nodeReadFileSync = nodeReadFileSync
): KoedServerRuntimeState | null => {
  try {
    return JSON.parse(
      String(readFileSync(path, "utf8"))
    ) as KoedServerRuntimeState;
  } catch {
    return null;
  }
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
  now = () => new Date()
}: Omit<
  KoedServerSetupOptions,
  "spawnSync"
> = {}): KoedServerRepairCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  environment = applyActiveRuntimeUrls(
    applyPersistedLocalPorts(paths, environment),
    readRuntimeState(paths.runtimeStatePath)
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

export const setupCodex = ({
  environment = process.env,
  spawnSync = nodeSpawnSync as SpawnSyncLike,
  writeFileSync = nodeWriteFileSync,
  now = () => new Date()
}: KoedServerSetupOptions = {}): KoedServerSetupCodexResult => {
  const paths = resolveKoedServerPaths(environment);
  ensureKoedHome(paths);
  environment = applyActiveRuntimeUrls(
    applyPersistedLocalPorts(paths, environment),
    readRuntimeState(paths.runtimeStatePath)
  );
  const repoEnv = loadRepoEnv(paths.repoRoot);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...repoEnv,
    ...environment,
    KOED_SERVER_MANAGED: "1"
  };
  const apiUrl = resolveApiUrl(environment, repoEnv);
  const explorerUrl = resolveExplorerUrl(environment, repoEnv);
  const checkedAt = now().toISOString();
  const apiToken = resolveLocalApiToken(environment, repoEnv);
  if (apiToken) {
    writeExplorerCredential(paths, {
      apiToken: apiToken.token,
      provisionedAt: checkedAt,
      source: apiToken.source
    });
  }
  const scriptPath = resolve(paths.repoRoot, "scripts/clients-bootstrap.mjs");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: paths.repoRoot,
    env: childEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000
  });

  const payload: KoedServerSetupCodexResult = result.error
    ? {
        ok: false,
        state: "needs_attention",
        koedHome: paths.koedHome,
        apiUrl,
        explorerUrl,
        checkedAt,
        command: `node ${scriptPath}`,
        error: result.error.message,
        action:
          "Fix the reported setup failure, then rerun koed-server setup codex --json."
      }
    : result.status === 0
      ? {
          ok: true,
          state: "healthy",
          koedHome: paths.koedHome,
          apiUrl,
          explorerUrl,
          checkedAt,
          command: `node ${scriptPath}`,
          stdout: result.stdout.trim() || undefined,
          stderr: result.stderr.trim() || undefined
        }
      : {
          ok: false,
          state: "needs_attention",
          koedHome: paths.koedHome,
          apiUrl,
          explorerUrl,
          checkedAt,
          command: `node ${scriptPath}`,
          stdout: result.stdout.trim() || undefined,
          stderr: result.stderr.trim() || undefined,
          error: `Codex setup failed with exit code ${result.status ?? 1}.`,
          action:
            "Review stdout/stderr, fix the reported setup failure, then rerun koed-server setup codex --json."
        };

  if (payload.ok) {
    const refreshedApiToken = resolveLocalApiToken(
      environment,
      loadRepoEnv(paths.repoRoot)
    );
    if (refreshedApiToken) {
      writeExplorerCredential(paths, {
        apiToken: refreshedApiToken.token,
        provisionedAt: checkedAt,
        source: refreshedApiToken.source
      });
    }
  }

  writeFileSync(
    paths.lastVerificationPath,
    `${JSON.stringify(
      {
        ok: payload.ok,
        checkedAt,
        message: payload.ok ? "Codex setup completed." : payload.error
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );

  return payload;
};
