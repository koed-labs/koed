import {
  spawnSync as nodeSpawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { nodeCliInvocation, nodeCliProcessEnvironment } from "@koed/shared";
import { resolveKoedAppRuntime } from "./app-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";
import {
  assertAiClientRegistryWritable,
  captureAiClientRegistry,
  type ExecutablePathDependencies,
  registerExplicitAiClient,
  removeExplicitAiClient,
  restoreAiClientRegistry,
  resolveExecutablePathWithPlatformFallbacks
} from "./ai-client-registry.js";

export const resolveClaudeExecutablePath = (
  environment: NodeJS.ProcessEnv,
  dependencies: ExecutablePathDependencies = {},
  platform: NodeJS.Platform = process.platform
): string =>
  resolveExecutablePathWithPlatformFallbacks(
    environment.KOED_CLAUDE_CODE_EXECUTABLE?.trim() || "claude",
    environment,
    dependencies,
    platform
  );

export const MINIMUM_CLAUDE_CODE_VERSION = "2.1.227";
export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "SessionEnd"
] as const;

export interface KoedServerSetupClaudeResult {
  ok: boolean;
  state: "healthy" | "needs_attention";
  command: string;
  koedHome: string;
  checkedAt: string;
  settingsPath: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  action?: string;
}

type SpawnSyncLike = typeof nodeSpawnSync;

const spawnClaude = (
  spawnSync: SpawnSyncLike,
  executablePath: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding
): SpawnSyncReturns<string> => {
  const invocation = nodeCliInvocation(executablePath, args);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    env: nodeCliProcessEnvironment(invocation, options.env ?? {}, process.env)
  });
};
type ClaudeSettings = {
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
};

export const isSupportedClaudeCodeVersion = (value: string): boolean => {
  const parsed = value
    .trim()
    .match(/(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parsed) return false;
  const [major, minor, patch] = parsed as [number, number, number];
  return (
    major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 227)))
  );
};

export const resolveClaudeSettingsPath = (
  environment: NodeJS.ProcessEnv
): string =>
  resolve(
    environment.CLAUDE_SETTINGS_PATH?.trim() ||
      `${
        environment.CLAUDE_CONFIG_DIR?.trim() ||
        `${environment.HOME?.trim() || homedir()}/.claude`
      }/settings.json`
  );

export const hasClaudeKoedHook = (
  entries: unknown,
  captureHookPath: string
): boolean =>
  (Array.isArray(entries) ? entries : []).some((entry) =>
    JSON.stringify(entry).includes(captureHookPath)
  );

const looksLikeKoedClaudeHook = (
  entry: unknown,
  captureHookPath: string
): boolean => {
  const serialized = JSON.stringify(entry);
  return (
    serialized.includes(captureHookPath) ||
    serialized.includes("koed-capture-hook") ||
    (serialized.includes("capture-hook.js") &&
      serialized.includes("--source") &&
      serialized.includes("claude") &&
      serialized.includes("--koed-home"))
  );
};

const withoutKoedHook = (
  entries: unknown,
  captureHookPath: string
): unknown[] =>
  (Array.isArray(entries) ? entries : []).filter(
    (entry) => !looksLikeKoedClaudeHook(entry, captureHookPath)
  );

export const claudeProcessEnvironment = (
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const allowed = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "CLAUDE_CONFIG_DIR",
    "SYSTEMROOT",
    "COMSPEC",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PATHEXT"
  ];
  return Object.fromEntries(
    allowed.flatMap((name) =>
      environment[name] ? [[name, environment[name]]] : []
    )
  );
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  return trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ? trimmed.slice(1, -1)
    : trimmed;
};

type ClaudeMcpEntry = {
  command: string;
  args: string[];
  environment: Array<[string, string]>;
};

const parseClaudeMcpEntry = (output: string): ClaudeMcpEntry | null => {
  const command = output.match(/^\s*Command:\s+(.+)$/m)?.[1];
  const args = output.match(/^\s*Args:\s+(.+)$/m)?.[1];
  if (!args) return null;
  const environment = [
    ...output.matchAll(/^\s*([A-Z_][A-Z0-9_]*)=(.+)$/gm)
  ].map(([, name, value]) => [name!, unquote(value!)] as [string, string]);
  return {
    command: unquote(command ?? "node"),
    args: [unquote(args)],
    environment
  };
};

export const claudeMcpEntryIsKoedOwned = (
  output: string,
  expectedMcpCli: string,
  expectedKoedHome: string
): boolean => {
  const entry = parseClaudeMcpEntry(output);
  const koedHome = entry?.environment.find(
    ([name]) => name === "KOED_HOME"
  )?.[1];
  return Boolean(
    entry?.args[0] &&
    koedHome &&
    resolve(entry.args[0]) === resolve(expectedMcpCli) &&
    resolve(koedHome) === resolve(expectedKoedHome)
  );
};

const claudeMcpAddArgs = (mcpName: string, entry: ClaudeMcpEntry) => [
  "mcp",
  "add",
  "--scope",
  "user",
  mcpName,
  ...entry.environment.flatMap(([name, value]) => [
    "--env",
    `${name}=${value}`
  ]),
  "--",
  entry.command,
  ...entry.args
];

const claudeMcpLookupConfirmsAbsent = (
  result: ReturnType<SpawnSyncLike>
): boolean =>
  result.status !== 0 &&
  !result.error &&
  /(?:not found|does not exist|no .*mcp|unknown .*server|not configured)/i.test(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );

export const removeClaude = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: SpawnSyncLike = nodeSpawnSync
): KoedServerSetupClaudeResult => {
  const paths = resolveKoedServerPaths(environment);
  const settingsPath = resolveClaudeSettingsPath(environment);
  let executable = environment.KOED_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  const mcpName = environment.MEMORY_MCP_NAME?.trim() || "koed";
  const checkedAt = new Date().toISOString();
  const base = {
    command: `${executable} mcp remove --scope user ${mcpName}`,
    koedHome: paths.koedHome,
    checkedAt,
    settingsPath
  };
  let originalSettings: string | null = null;
  let registrySnapshot;
  let removedMcp = false;
  try {
    assertAiClientRegistryWritable(environment);
    executable = resolveClaudeExecutablePath(environment);
    registrySnapshot = captureAiClientRegistry(environment);
    originalSettings = existsSync(settingsPath)
      ? readFileSync(settingsPath, "utf8")
      : null;
    const settings: ClaudeSettings = originalSettings
      ? (JSON.parse(originalSettings) as ClaudeSettings)
      : {};
    const childEnvironment = claudeProcessEnvironment(environment);
    const runtime = resolveKoedAppRuntime(paths, environment);
    const existingMcp = spawnClaude(
      spawnSync,
      executable,
      ["mcp", "get", mcpName],
      {
        encoding: "utf8",
        env: childEnvironment,
        timeout: 10_000
      }
    );
    if (existingMcp.error) {
      throw new Error(`Claude MCP lookup failed: ${existingMcp.error.message}`);
    }
    if (
      existingMcp.status === 0 &&
      !claudeMcpEntryIsKoedOwned(
        existingMcp.stdout ?? "",
        runtime.mcpCli,
        paths.koedHome
      )
    ) {
      throw new Error(
        `Claude Code MCP server ${mcpName} is unrelated to Koed; it was not removed.`
      );
    }
    if (
      existingMcp.status !== 0 &&
      !claudeMcpLookupConfirmsAbsent(existingMcp)
    ) {
      throw new Error(
        existingMcp.stderr?.trim() ||
          "Claude MCP lookup failed; absence could not be confirmed."
      );
    }
    if (existingMcp.status === 0) {
      const removed = spawnClaude(
        spawnSync,
        executable,
        ["mcp", "remove", "--scope", "user", mcpName],
        { encoding: "utf8", env: childEnvironment, timeout: 10_000 }
      );
      if (removed.error || removed.status !== 0) {
        throw new Error(
          removed.error?.message ??
            removed.stderr?.trim() ??
            "Claude MCP removal failed."
        );
      }
      removedMcp = true;
    }
    for (const eventName of CLAUDE_HOOK_EVENTS) {
      const remaining = withoutKoedHook(
        settings.hooks?.[eventName],
        runtime.captureHook
      );
      if (remaining.length > 0) settings.hooks![eventName] = remaining;
      else delete settings.hooks?.[eventName];
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    if (existsSync(settingsPath)) {
      writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
        mode: 0o600
      });
      chmodSync(settingsPath, 0o600);
    }
    removeExplicitAiClient({ environment, driverId: "claude" });
    return {
      ...base,
      ok: true,
      state: "healthy",
      stdout:
        "Claude Code integration removed; unrelated settings were preserved."
    };
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    if (originalSettings !== null) {
      try {
        writeFileSync(settingsPath, originalSettings, { mode: 0o600 });
        chmodSync(settingsPath, 0o600);
      } catch (restoreError) {
        failures.push(
          `Claude settings rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (removedMcp) {
      try {
        const runtime = resolveKoedAppRuntime(paths, environment);
        const restored = spawnClaude(
          spawnSync,
          executable,
          [
            "mcp",
            "add",
            "--scope",
            "user",
            mcpName,
            "--env",
            `KOED_HOME=${paths.koedHome}`,
            "--",
            environment.MEMORY_NODE_COMMAND?.trim() || "node",
            runtime.mcpCli
          ],
          {
            encoding: "utf8",
            env: claudeProcessEnvironment(environment),
            timeout: 15_000
          }
        );
        if (restored.error || restored.status !== 0) {
          throw (
            restored.error ??
            new Error(restored.stderr?.trim() || "restore failed")
          );
        }
      } catch (restoreError) {
        failures.push(
          `Claude MCP rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
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
      action: "Fix Koed-owned Claude Code settings, then retry removal."
    };
  }
};

export const setupClaude = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: SpawnSyncLike = nodeSpawnSync
): KoedServerSetupClaudeResult => {
  const paths = resolveKoedServerPaths(environment);
  const runtime = resolveKoedAppRuntime(paths, environment);
  let executable = environment.KOED_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  const settingsPath = resolveClaudeSettingsPath(environment);
  const mcpName = environment.MEMORY_MCP_NAME?.trim() || "koed";
  const nodeCommand = environment.MEMORY_NODE_COMMAND?.trim() || "node";
  const checkedAt = new Date().toISOString();
  const command = `${executable} mcp add --scope user ${mcpName}`;
  let originalSettings: string | null = null;
  let registrySnapshot;
  let previousMcp: ClaudeMcpEntry | null = null;
  let removedExistingMcp = false;
  let addedMcp = false;
  const failure = (
    error: string,
    action: string,
    output?: { stdout?: string | null; stderr?: string | null }
  ): KoedServerSetupClaudeResult => ({
    ok: false,
    state: "needs_attention",
    command,
    koedHome: paths.koedHome,
    checkedAt,
    settingsPath,
    ...(output?.stdout?.trim() ? { stdout: output.stdout.trim() } : {}),
    ...(output?.stderr?.trim() ? { stderr: output.stderr.trim() } : {}),
    error,
    action
  });

  try {
    assertAiClientRegistryWritable(environment);
    executable = resolveClaudeExecutablePath(environment);
    if (!existsSync(runtime.mcpCli) || !existsSync(runtime.captureHook)) {
      return failure(
        "Koed's Claude Code integration artifacts are missing.",
        "Repair Koed, then set up Claude Code integration again."
      );
    }
    const childEnvironment = claudeProcessEnvironment(environment);
    const version = spawnClaude(spawnSync, executable, ["--version"], {
      encoding: "utf8",
      env: childEnvironment,
      timeout: 5_000
    });
    if (
      version.error ||
      version.status !== 0 ||
      !isSupportedClaudeCodeVersion(version.stdout?.trim() ?? "")
    ) {
      return failure(
        `Claude Code ${version.stdout?.trim() || "version"} is unavailable or unsupported.`,
        `Install Claude Code ${MINIMUM_CLAUDE_CODE_VERSION} or newer, then try again.`,
        version
      );
    }
    const auth = spawnClaude(
      spawnSync,
      executable,
      ["auth", "status", "--json"],
      {
        encoding: "utf8",
        env: childEnvironment,
        timeout: 10_000
      }
    );
    if (auth.error || auth.status !== 0) {
      return failure(
        "Claude Code is not signed in.",
        "Run `claude auth login`, then set up Claude Code integration again.",
        auth
      );
    }

    registrySnapshot = captureAiClientRegistry(environment);
    originalSettings = existsSync(settingsPath)
      ? readFileSync(settingsPath, "utf8")
      : null;
    const settings: ClaudeSettings = originalSettings
      ? (JSON.parse(originalSettings) as ClaudeSettings)
      : {};
    settings.hooks ??= {};
    const hookCommand = [
      nodeCommand,
      runtime.captureHook,
      "--source",
      "claude",
      "--koed-home",
      paths.koedHome
    ]
      .map((value) => JSON.stringify(value))
      .join(" ");

    const existingMcp = spawnClaude(
      spawnSync,
      executable,
      ["mcp", "get", mcpName],
      {
        encoding: "utf8",
        env: childEnvironment,
        timeout: 10_000
      }
    );
    if (
      existingMcp.status === 0 &&
      !claudeMcpEntryIsKoedOwned(
        existingMcp.stdout ?? "",
        runtime.mcpCli,
        paths.koedHome
      )
    ) {
      return failure(
        `Claude Code already has an unrelated user-scoped MCP server named ${mcpName}.`,
        `Rename or remove that MCP entry, or set MEMORY_MCP_NAME to a distinct name before setup.`
      );
    }
    if (existingMcp.status === 0) {
      previousMcp = parseClaudeMcpEntry(existingMcp.stdout ?? "");
      if (!previousMcp) {
        return failure(
          "Claude Code Koed MCP entry could not be parsed for safe replacement.",
          "Inspect the Koed-owned Claude MCP entry, then retry setup."
        );
      }
      const remove = spawnClaude(
        spawnSync,
        executable,
        ["mcp", "remove", "--scope", "user", mcpName],
        {
          encoding: "utf8",
          env: childEnvironment,
          timeout: 10_000
        }
      );
      if (remove.error || remove.status !== 0) {
        return failure(
          remove.error?.message ??
            remove.stderr?.trim() ??
            "Claude MCP removal failed.",
          "Fix the existing Koed-owned Claude MCP entry, then retry setup.",
          remove
        );
      }
      removedExistingMcp = true;
    }
    const add = spawnClaude(
      spawnSync,
      executable,
      [
        "mcp",
        "add",
        "--scope",
        "user",
        mcpName,
        "--env",
        `KOED_HOME=${paths.koedHome}`,
        "--",
        nodeCommand,
        runtime.mcpCli
      ],
      {
        encoding: "utf8",
        env: childEnvironment,
        timeout: 15_000
      }
    );
    if (add.error || add.status !== 0) {
      throw new Error(
        add.error?.message ?? add.stderr?.trim() ?? "Claude MCP setup failed."
      );
    }
    addedMcp = true;

    for (const eventName of CLAUDE_HOOK_EVENTS) {
      settings.hooks[eventName] = [
        ...withoutKoedHook(settings.hooks[eventName], runtime.captureHook),
        {
          hooks: [{ type: "command", command: hookCommand, timeout: 3 }]
        }
      ];
    }
    mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600
    });
    chmodSync(settingsPath, 0o600);
    const registered = registerExplicitAiClient({
      environment,
      driverId: "claude",
      executablePath: executable,
      displayName: "Claude Code",
      configHome: environment.CLAUDE_CONFIG_DIR
    });
    if (!registered) throw new Error("Claude Code registration failed.");

    return {
      ok: true,
      state: "healthy",
      command,
      koedHome: paths.koedHome,
      checkedAt,
      settingsPath,
      ...(add.stdout?.trim() ? { stdout: add.stdout.trim() } : {}),
      ...(add.stderr?.trim() ? { stderr: add.stderr.trim() } : {})
    };
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    if (addedMcp) {
      try {
        const removed = spawnClaude(
          spawnSync,
          executable,
          ["mcp", "remove", "--scope", "user", mcpName],
          {
            encoding: "utf8",
            env: claudeProcessEnvironment(environment),
            timeout: 15_000
          }
        );
        if (removed.error || removed.status !== 0) {
          throw (
            removed.error ??
            new Error(removed.stderr?.trim() || "remove failed")
          );
        }
      } catch (rollbackError) {
        failures.push(
          `Claude MCP rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    if (removedExistingMcp && previousMcp) {
      try {
        const restored = spawnClaude(
          spawnSync,
          executable,
          claudeMcpAddArgs(mcpName, previousMcp),
          {
            encoding: "utf8",
            env: claudeProcessEnvironment(environment),
            timeout: 15_000
          }
        );
        if (restored.error || restored.status !== 0) {
          throw (
            restored.error ??
            new Error(restored.stderr?.trim() || "restore failed")
          );
        }
      } catch (restoreError) {
        failures.push(
          `Claude MCP rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    }
    if (originalSettings !== null) {
      try {
        writeFileSync(settingsPath, originalSettings, { mode: 0o600 });
        chmodSync(settingsPath, 0o600);
      } catch (restoreError) {
        failures.push(
          `Claude settings rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
        );
      }
    } else if (existsSync(settingsPath)) {
      try {
        unlinkSync(settingsPath);
      } catch (restoreError) {
        failures.push(
          `Claude settings rollback failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`
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
    return failure(
      failures.join(" "),
      "Fix Claude Code settings permissions or malformed settings, then repair the integration."
    );
  }
};
