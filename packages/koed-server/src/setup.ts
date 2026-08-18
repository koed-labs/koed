import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncReturns
} from "node:child_process";
import {
  chmodSync as nodeChmodSync,
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSync,
  statSync as nodeStatSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  resolveActiveIntegrationApiToken,
  resolveLocalApiToken,
  writeLocalAppCredential
} from "./credentials.js";
import {
  resolveKoedServerConfig,
  writeCodexGlobalMemoryGuidancePreference,
  type KoedServerConfig
} from "./config.js";
import { loadRepoEnv, resolveApiUrl } from "./env-file.js";
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
import {
  assertAiClientRegistryWritable,
  captureAiClientRegistry,
  migrateKoedOwnedCodexRegistrationBestEffort,
  registerExplicitAiClient,
  removeExplicitAiClient,
  restoreAiClientRegistry,
  resolveExecutablePath
} from "./ai-client-registry.js";
import { provisionLocalApiToken } from "./local-api-token.js";
import {
  applyActiveRuntimeUrls,
  readActiveRuntimeState
} from "./runtime-state.js";
import type { KoedServerRuntimeState } from "./types.js";
import {
  parseCodexOwnershipBlock,
  stripCodexOwnershipBlock
} from "./codex-ownership-marker.js";
import {
  reconcileManagedCodexGuidance,
  removeManagedCodexGuidance,
  resolveCodexGlobalInstructionsPath,
  resolveCodexGuidancePath
} from "./codex-global-instructions.js";

export interface KoedServerSetupCoreResult {
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

export type KoedServerSetupCodexResult = KoedServerSetupCoreResult;

type SpawnSyncLike = (
  command: string,
  args: string[],
  options?: Parameters<typeof nodeSpawnSync>[2]
) => SpawnSyncReturns<string>;

export interface KoedServerSetupOptions {
  environment?: NodeJS.ProcessEnv;
  spawnSync?: SpawnSyncLike;
  readFileSync?: typeof nodeReadFileSync;
  writeFileSync?: typeof nodeWriteFileSync;
  mkdirSync?: typeof nodeMkdirSync;
  existsSync?: typeof nodeExistsSync;
  checkPid?: (pid: number) => boolean;
  now?: () => Date;
  resolveRuntime?: typeof resolveKoedAppRuntime;
  provisionLocalApiToken?: typeof provisionLocalApiToken;
  migrateCodex?: typeof migrateKoedOwnedCodexRegistrationBestEffort;
  registerAiClient?: typeof registerExplicitAiClient;
  reportDiagnostic?: (message: string) => void;
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

interface ManagedFileSnapshot {
  content: string | null;
  mode: number | null;
}

const captureManagedFile = (
  path: string,
  existsSync: typeof nodeExistsSync,
  readFileSync: typeof nodeReadFileSync
): ManagedFileSnapshot =>
  existsSync(path)
    ? {
        content: String(readFileSync(path, "utf8")),
        mode: nodeStatSync(path).mode & 0o777
      }
    : { content: null, mode: null };

const restoreManagedFile = (
  path: string,
  snapshot: ManagedFileSnapshot,
  existsSync: typeof nodeExistsSync,
  writeFileSync: typeof nodeWriteFileSync,
  mkdirSync: typeof nodeMkdirSync
): void => {
  if (snapshot.content === null) {
    if (existsSync(path)) nodeUnlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, snapshot.content, { mode: snapshot.mode ?? 0o600 });
  if (snapshot.mode !== null) nodeChmodSync(path, snapshot.mode);
};

const tomlString = (value: string): string => JSON.stringify(value);

const configureCodexIntegration = ({
  paths,
  environment,
  apiUrl,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  memoryGuidanceEnabled
}: {
  paths: ReturnType<typeof resolveKoedServerPaths>;
  environment: NodeJS.ProcessEnv;
  apiUrl: string;
  readFileSync: typeof nodeReadFileSync;
  writeFileSync: typeof nodeWriteFileSync;
  mkdirSync: typeof nodeMkdirSync;
  existsSync: typeof nodeExistsSync;
  memoryGuidanceEnabled: boolean;
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
  const mcpName = environment.MEMORY_MCP_NAME ?? "koed";
  const codexConfigPath = resolve(
    environment.CODEX_CONFIG_PATH ??
      `${environment.CODEX_HOME ?? `${homedir()}/.codex`}/config.toml`
  );
  const codexInstructionsPath = resolveCodexGlobalInstructionsPath(environment);
  const guidancePath = resolveCodexGuidancePath(runtime.mcpCli);
  const existingInstructions = existsSync(codexInstructionsPath)
    ? String(readFileSync(codexInstructionsPath, "utf8"))
    : "";
  let nextInstructions: string;
  if (memoryGuidanceEnabled) {
    if (!existsSync(guidancePath)) {
      throw new Error(
        `Packaged Codex memory guidance is missing: ${guidancePath}. Rebuild Koed so the MCP Server prompt assets are complete.`
      );
    }
    const guidance = String(readFileSync(guidancePath, "utf8"));
    nextInstructions = reconcileManagedCodexGuidance(
      existingInstructions,
      guidance
    );
  } else {
    nextInstructions = removeManagedCodexGuidance(existingInstructions);
  }
  const markerStart = "# >>> koed";
  const markerEnd = "# <<< koed";
  const hookCommand = [
    nodeCommand,
    runtime.captureHook,
    "--koed-home",
    paths.koedHome
  ]
    .map(tomlString)
    .join(" ");
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
KOED_HOME = ${tomlString(paths.koedHome)}

${hookBlocks}
${markerEnd}
`;
  const existing = existsSync(codexConfigPath)
    ? String(readFileSync(codexConfigPath, "utf8"))
    : "";
  const withoutPrevious = stripCodexOwnershipBlock(existing);
  mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    codexConfigPath,
    `${withoutPrevious.trimEnd()}\n\n${koedBlock}`
  );
  mkdirSync(dirname(codexInstructionsPath), { recursive: true, mode: 0o700 });
  if (nextInstructions !== existingInstructions) {
    writeFileSync(codexInstructionsPath, nextInstructions, { mode: 0o600 });
  }

  return {
    command,
    stdout: [
      "Codex integration configured.",
      `Detected API URL: ${apiUrl}`,
      `Detected Node command: ${nodeCommand}`,
      `Wrote Codex MCP config: ${codexConfigPath}`,
      memoryGuidanceEnabled
        ? `Reconciled Codex global instructions: ${codexInstructionsPath}`
        : `Koed global memory guidance disabled: ${codexInstructionsPath}`
    ].join("\n")
  };
};

const codexBlockIsExpectedKoedOwned = (
  block: string,
  environment: NodeJS.ProcessEnv,
  paths: ReturnType<typeof resolveKoedServerPaths>
): boolean => {
  const runtime = resolveKoedAppRuntime(paths, environment);
  const nodeCommand = environment.MEMORY_NODE_COMMAND ?? "node";
  const mcpName = environment.MEMORY_MCP_NAME ?? "koed";
  const mcpHeader = `[mcp_servers.${mcpName}]`;
  const requiredHooks = [
    "SessionStart",
    "UserPromptSubmit",
    "PostToolUse",
    "Stop",
    "SubagentStart",
    "SubagentStop"
  ];
  return (
    block.includes(mcpHeader) &&
    block.includes(`command = ${tomlString(nodeCommand)}`) &&
    block.includes(`args = [${tomlString(runtime.mcpCli)}]`) &&
    block.includes(`[mcp_servers.${mcpName}.env]`) &&
    block.includes(`KOED_HOME = ${tomlString(paths.koedHome)}`) &&
    requiredHooks.every(
      (eventName) =>
        block.includes(`[[hooks.${eventName}]]`) &&
        block.includes(runtime.captureHook)
    )
  );
};

export const removeCodexIntegration = ({
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
  const codexConfigPath = resolve(
    environment.CODEX_CONFIG_PATH ??
      `${environment.CODEX_HOME ?? `${homedir()}/.codex`}/config.toml`
  );
  const codexInstructionsPath = resolveCodexGlobalInstructionsPath(environment);
  const checkedAt = now().toISOString();
  const base = {
    koedHome: paths.koedHome,
    apiUrl: resolveApiUrl(environment, loadRepoEnv(paths.repoRoot)),
    checkedAt,
    command: "remove Koed Codex integration"
  };
  let registrySnapshot;
  let configSnapshot: ManagedFileSnapshot | undefined;
  let instructionsSnapshot: ManagedFileSnapshot | undefined;
  try {
    assertAiClientRegistryWritable(environment);
    registrySnapshot = captureAiClientRegistry(environment);
    configSnapshot = captureManagedFile(
      codexConfigPath,
      existsSync,
      readFileSync
    );
    instructionsSnapshot = captureManagedFile(
      codexInstructionsPath,
      existsSync,
      readFileSync
    );
    let nextConfig = configSnapshot.content;
    if (configSnapshot.content !== null) {
      const parsed = parseCodexOwnershipBlock(configSnapshot.content);
      if (parsed.kind === "malformed") throw new Error(parsed.reason);
      if (
        parsed.kind === "valid" &&
        !codexBlockIsExpectedKoedOwned(parsed.block, environment, paths)
      ) {
        throw new Error(
          "Codex Koed ownership block does not contain expected MCP and Supported Capture Hook configuration."
        );
      }
      const withoutKoed = stripCodexOwnershipBlock(configSnapshot.content);
      if (withoutKoed !== configSnapshot.content) {
        nextConfig = withoutKoed.trimEnd() + "\n";
      }
    }
    const nextInstructions =
      instructionsSnapshot.content === null
        ? null
        : removeManagedCodexGuidance(instructionsSnapshot.content);
    if (nextConfig !== configSnapshot.content && nextConfig !== null) {
      mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
      writeFileSync(codexConfigPath, nextConfig, {
        mode: configSnapshot.mode ?? 0o600
      });
    }
    if (
      nextInstructions !== instructionsSnapshot.content &&
      nextInstructions !== null
    ) {
      mkdirSync(dirname(codexInstructionsPath), {
        recursive: true,
        mode: 0o700
      });
      writeFileSync(codexInstructionsPath, nextInstructions, {
        mode: instructionsSnapshot.mode ?? 0o600
      });
    }
    removeExplicitAiClient({ environment, driverId: "codex" });
    return {
      ...base,
      ok: true,
      state: "healthy",
      stdout:
        "Codex integration and managed global guidance removed; unrelated settings were preserved.",
      action: "Restart Codex before starting new Conversations."
    };
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    if (configSnapshot) {
      try {
        restoreManagedFile(
          codexConfigPath,
          configSnapshot,
          existsSync,
          writeFileSync,
          mkdirSync
        );
      } catch (restoreError) {
        failures.push(
          `Codex configuration rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (instructionsSnapshot) {
      try {
        restoreManagedFile(
          codexInstructionsPath,
          instructionsSnapshot,
          existsSync,
          writeFileSync,
          mkdirSync
        );
      } catch (restoreError) {
        failures.push(
          `Codex global instructions rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (registrySnapshot) {
      try {
        restoreAiClientRegistry(environment, registrySnapshot);
      } catch (restoreError) {
        failures.push(
          `AI Client registry rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    return {
      ...base,
      ok: false,
      state: "needs_attention",
      error: failures.join(" "),
      action: "Fix Koed-owned Codex configuration, then retry removal."
    };
  }
};

export const repairCodexIntegration = ({
  environment = process.env,
  readFileSync = nodeReadFileSync,
  writeFileSync = nodeWriteFileSync,
  mkdirSync = nodeMkdirSync,
  existsSync = nodeExistsSync,
  checkPid = isProcessRunning,
  registerAiClient = registerExplicitAiClient,
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
      error: "No Koed API Token is available for the Local AI Runtime.",
      action:
        "Start Koed Desktop first so it can provision a local API Token, then run the Codex-specific repair action again."
    };
  }

  const integrationEnvironment: NodeJS.ProcessEnv = {
    ...repoEnv,
    ...environment,
    KOED_HOME: paths.koedHome
  };
  const codexConfigPath = resolve(
    integrationEnvironment.CODEX_CONFIG_PATH ??
      `${integrationEnvironment.CODEX_HOME ?? `${homedir()}/.codex`}/config.toml`
  );
  const codexInstructionsPath = resolveCodexGlobalInstructionsPath(
    integrationEnvironment
  );
  let registrySnapshot: ReturnType<typeof captureAiClientRegistry> | undefined;
  let configSnapshot: ManagedFileSnapshot | undefined;
  let instructionsSnapshot: ManagedFileSnapshot | undefined;
  try {
    assertAiClientRegistryWritable(integrationEnvironment);
    registrySnapshot = captureAiClientRegistry(integrationEnvironment);
    configSnapshot = captureManagedFile(
      codexConfigPath,
      existsSync,
      readFileSync
    );
    instructionsSnapshot = captureManagedFile(
      codexInstructionsPath,
      existsSync,
      readFileSync
    );
    const codexExecutablePath = resolveExecutablePath(
      integrationEnvironment.MEMORY_CODEX_APP_SERVER_BINARY ?? "codex",
      integrationEnvironment
    );
    const result = configureCodexIntegration({
      paths,
      environment: integrationEnvironment,
      apiUrl,
      readFileSync,
      writeFileSync,
      mkdirSync,
      existsSync,
      memoryGuidanceEnabled: resolveKoedServerConfig(
        paths,
        { ...repoEnv, ...environment },
        { existsSync, readFileSync }
      ).codexGlobalMemoryGuidanceEnabled
    });
    const registered = registerAiClient({
      environment: integrationEnvironment,
      driverId: "codex",
      executablePath: codexExecutablePath,
      displayName: "Codex",
      configHome: integrationEnvironment.CODEX_HOME
    });
    if (!registered) throw new Error("Codex registration failed.");
    const repaired: KoedServerRepairCodexResult = {
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
    writeSetupVerification(paths, repaired, writeFileSync);
    return repaired;
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    if (configSnapshot) {
      try {
        restoreManagedFile(
          codexConfigPath,
          configSnapshot,
          existsSync,
          writeFileSync,
          mkdirSync
        );
      } catch (restoreError) {
        failures.push(
          `Codex profile rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (instructionsSnapshot) {
      try {
        restoreManagedFile(
          codexInstructionsPath,
          instructionsSnapshot,
          existsSync,
          writeFileSync,
          mkdirSync
        );
      } catch (restoreError) {
        failures.push(
          `Codex global instructions rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (registrySnapshot) {
      try {
        restoreAiClientRegistry(integrationEnvironment, registrySnapshot);
      } catch (restoreError) {
        failures.push(
          `AI Client registry rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    const failed: KoedServerRepairCodexResult = {
      ok: false,
      state: "needs_attention",
      koedHome: paths.koedHome,
      apiUrl,
      checkedAt,
      command: "write Codex config",
      error: failures.join(" "),
      action:
        "Review the reported failure, fix the Codex integration artifacts, then run the Codex-specific repair action again."
    };
    writeSetupVerification(paths, failed, writeFileSync);
    return failed;
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
  dependencies: Pick<KoedServerSetupOptions, "existsSync" | "readFileSync">,
  recoveryCommand = "codex"
): BundledDatabaseResolution => {
  const explicitDatabaseUrl = trimValue(invocationEnvironment.DATABASE_URL);
  if (explicitDatabaseUrl && recoveryCommand !== "core") {
    return { ok: true, environment: { DATABASE_URL: explicitDatabaseUrl } };
  }
  if (explicitDatabaseUrl && recoveryCommand === "core") {
    const persisted = readLocalServiceSecrets(paths, dependencies);
    if (persisted.state === "invalid") {
      return {
        ok: false,
        error: `Persisted local service secrets at ${persisted.path} are malformed: ${persisted.error}.`,
        action: `Fix or remove ${persisted.path}, then rerun koed-server setup core --json.`
      };
    }
    return {
      ok: true,
      environment: {
        DATABASE_URL: explicitDatabaseUrl,
        ...(persisted.state === "valid" && persisted.secrets.API_TOKEN_PEPPER
          ? { API_TOKEN_PEPPER: persisted.secrets.API_TOKEN_PEPPER }
          : {})
      }
    };
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
      action: `Fix or remove ${persisted.path}, restart packaged Koed Desktop to regenerate local service secrets, then rerun koed-server setup ${recoveryCommand} --json.`
    };
  }
  if (persisted.state === "valid" && !persisted.secrets.POSTGRES_PASSWORD) {
    return {
      ok: false,
      error: `Persisted local service secrets at ${persisted.path} are missing required POSTGRES_PASSWORD.`,
      action: `Fix or remove ${persisted.path}, restart packaged Koed Desktop to regenerate local service secrets, then rerun koed-server setup ${recoveryCommand} --json.`
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
    environment: {
      ...localPostgresEnv(
        resolveLocalPostgresRuntimePaths(paths, postgresEnvironment)
      ),
      ...(recoveryCommand === "core" &&
      persisted.state === "valid" &&
      persisted.secrets.API_TOKEN_PEPPER
        ? { API_TOKEN_PEPPER: persisted.secrets.API_TOKEN_PEPPER }
        : {})
    }
  };
};

interface SetupCodexBaseContext {
  paths: KoedServerPaths;
  environment: NodeJS.ProcessEnv;
  repoEnv: Record<string, string>;
  dependencyMode: "bundled-local" | "external";
  apiUrl: string;
  checkedAt: string;
  scriptPath: string;
  config: KoedServerConfig;
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
  const config = resolveKoedServerConfig(
    paths,
    { ...repoEnv, ...environment },
    {
      existsSync: options.existsSync,
      readFileSync: options.readFileSync
    }
  );
  environment = applyPersistedLocalPorts(paths, environment, {
    force: config.dependencyMode === "bundled-local"
  });
  return {
    paths,
    environment,
    repoEnv,
    dependencyMode: config.dependencyMode,
    apiUrl: resolveApiUrl(environment, repoEnv),
    checkedAt: (options.now ?? (() => new Date()))().toISOString(),
    scriptPath: resolve(paths.repoRoot, "scripts/clients-bootstrap.mjs"),
    config
  };
};

const prepareSetupCodex = (
  invocationEnvironment: NodeJS.ProcessEnv,
  options: KoedServerSetupOptions,
  recoveryCommand = "codex"
): PreparedSetupCodex => {
  const base = resolveSetupCodexBase(invocationEnvironment, options);
  const database =
    base.dependencyMode === "bundled-local"
      ? resolveBundledDatabaseEnvironment(
          base.paths,
          invocationEnvironment,
          base.environment,
          base.repoEnv,
          options,
          recoveryCommand
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
        ...base.repoEnv,
        ...base.environment,
        ...database.environment,
        KOED_HOME: base.paths.koedHome,
        KOED_SERVER_MANAGED: "1",
        KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED: String(
          base.config.codexGlobalMemoryGuidanceEnabled
        )
      }
    }
  };
};

const persistSetupApiToken = (
  context: SetupCodexContext,
  repoEnv: Record<string, string> = context.repoEnv,
  preferRepoToken = false
): void => {
  const apiToken = preferRepoToken
    ? (resolveLocalApiToken({}, repoEnv) ??
      resolveLocalApiToken(context.environment, repoEnv))
    : resolveLocalApiToken(context.environment, repoEnv);
  if (!apiToken) return;
  writeLocalAppCredential(context.paths, {
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
    env: { ...context.childEnv, KOED_CORE_TOKEN_VALIDATED: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000
  });
  const base = {
    koedHome: context.paths.koedHome,
    apiUrl: context.apiUrl,
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
        "Fix the reported client setup failure, then rerun koed-server setup codex --json."
    };
  }
  const redactApiTokens = (value: string): string =>
    value.replace(/(^|\n)(Token:\s*)\S+/g, "$1$2<redacted>");
  const output = {
    stdout: redactApiTokens(result.stdout).trim() || undefined,
    stderr: redactApiTokens(result.stderr).trim() || undefined
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
          "Review stdout/stderr, fix the reported client setup failure, then rerun koed-server setup codex --json."
      };
};

const writeSetupVerification = (
  paths: KoedServerPaths,
  result: { ok: boolean; checkedAt: string; error?: string },
  writeFileSync: typeof nodeWriteFileSync,
  successMessage = "Koed core setup completed."
): void => {
  writeFileSync(
    paths.lastVerificationPath,
    `${JSON.stringify(
      {
        ok: result.ok,
        checkedAt: result.checkedAt,
        message: result.ok ? successMessage : result.error
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
};

export const setupCore = async (
  options: KoedServerSetupOptions = {}
): Promise<KoedServerSetupCoreResult> => {
  const environment = options.environment ?? process.env;
  const prepared = prepareSetupCodex(environment, options, "core");
  if (!prepared.ok) return prepared.result;
  const { context } = prepared;
  const base = {
    koedHome: context.paths.koedHome,
    apiUrl: context.apiUrl,
    checkedAt: context.checkedAt,
    command: "provision local API Token"
  };
  try {
    const runtime = (options.resolveRuntime ?? resolveKoedAppRuntime)(
      context.paths,
      context.childEnv,
      options.existsSync ?? nodeExistsSync
    );
    if (runtime.missing.length > 0) {
      throw new Error(
        `Koed runtime artifacts are missing: ${runtime.missing.join(", ")}.`
      );
    }
    const provisioned = await (
      options.provisionLocalApiToken ?? provisionLocalApiToken
    )(
      context.paths,
      runtime,
      context.childEnv,
      context.repoEnv,
      options.now ?? (() => new Date())
    );
    const migration = (
      options.migrateCodex ?? migrateKoedOwnedCodexRegistrationBestEffort
    )({
      environment: context.childEnv,
      readFileSync: options.readFileSync ?? nodeReadFileSync
    });
    if (migration.diagnostic) {
      (options.reportDiagnostic ?? (() => undefined))(migration.diagnostic);
    }
    return {
      ...base,
      ok: true,
      state: "healthy",
      stdout: provisioned.reused
        ? "Reused validated local API Token."
        : "Provisioned local API Token.",
      ...(migration.diagnostic ? { stderr: migration.diagnostic } : {})
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      state: "needs_attention",
      error: error instanceof Error ? error.message : String(error),
      action:
        "Fix the reported core setup failure, then rerun koed-server setup core --json."
    };
  }
};

export const setupCodex = async (
  options: KoedServerSetupOptions = {}
): Promise<KoedServerSetupCodexResult> => {
  const core = await setupCore(options);
  const writeFileSync = options.writeFileSync ?? nodeWriteFileSync;
  if (!core.ok) {
    const paths = resolveKoedServerPaths(options.environment ?? process.env);
    writeSetupVerification(
      paths,
      core,
      writeFileSync,
      "Codex setup completed."
    );
    return core;
  }
  const environment = options.environment ?? process.env;
  const prepared = prepareSetupCodex(environment, options);
  if (!prepared.ok) {
    writeSetupVerification(prepared.paths, prepared.result, writeFileSync);
    return prepared.result;
  }
  const { context } = prepared;
  try {
    assertAiClientRegistryWritable(context.childEnv);
  } catch (error) {
    const failed = {
      ok: false,
      state: "needs_attention" as const,
      koedHome: context.paths.koedHome,
      apiUrl: context.apiUrl,
      checkedAt: context.checkedAt,
      command: "resolve AI Client registry",
      error: error instanceof Error ? error.message : String(error),
      action: "Fix malformed AI Client registry, then rerun Codex setup."
    };
    writeSetupVerification(
      context.paths,
      failed,
      writeFileSync,
      "Codex setup completed."
    );
    return failed;
  }
  if (
    environment.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED === "true" ||
    environment.KOED_CODEX_GLOBAL_MEMORY_GUIDANCE_ENABLED === "false"
  ) {
    writeCodexGlobalMemoryGuidancePreference(
      context.paths,
      context.config.codexGlobalMemoryGuidanceEnabled,
      {
        existsSync: options.existsSync,
        readFileSync: options.readFileSync,
        writeFileSync
      }
    );
  }
  persistSetupApiToken(context);
  const result = runSetupBootstrap(
    context,
    options.spawnSync ?? (nodeSpawnSync as SpawnSyncLike)
  );
  if (result.ok) {
    try {
      persistSetupApiToken(context, loadRepoEnv(context.paths.repoRoot), true);
      const registered = (options.registerAiClient ?? registerExplicitAiClient)(
        {
          environment: context.childEnv,
          driverId: "codex",
          executablePath:
            context.childEnv.MEMORY_CODEX_APP_SERVER_BINARY ?? "codex",
          displayName: "Codex",
          configHome: context.childEnv.CODEX_HOME
        }
      );
      if (!registered) throw new Error("Codex registration failed.");
    } catch (error) {
      const failed = {
        ...result,
        ok: false,
        state: "needs_attention" as const,
        error: error instanceof Error ? error.message : String(error),
        action:
          "Fix the Codex-specific registration, then rerun koed-server setup codex --json."
      };
      writeSetupVerification(
        context.paths,
        failed,
        writeFileSync,
        "Codex setup completed."
      );
      return failed;
    }
  }
  writeSetupVerification(
    context.paths,
    result,
    writeFileSync,
    "Codex setup completed."
  );
  return result;
};
