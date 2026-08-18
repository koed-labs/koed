import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { resolveKoedAppRuntime } from "./app-runtime.js";
import { resolveKoedServerPaths } from "./paths.js";

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

export const claudeMcpEntryIsKoedOwned = (
  output: string,
  expectedMcpCli: string,
  expectedKoedHome: string
): boolean => {
  const args = output.match(/^\s*Args:\s+(.+)$/m)?.[1];
  const koedHome = output.match(/^\s*KOED_HOME=(.+)$/m)?.[1];
  if (!args || !koedHome) return false;
  return (
    resolve(unquote(args)) === resolve(expectedMcpCli) &&
    resolve(unquote(koedHome)) === resolve(expectedKoedHome)
  );
};

export const setupClaude = (
  environment: NodeJS.ProcessEnv = process.env,
  spawnSync: SpawnSyncLike = nodeSpawnSync
): KoedServerSetupClaudeResult => {
  const paths = resolveKoedServerPaths(environment);
  const runtime = resolveKoedAppRuntime(paths, environment);
  const executable =
    environment.KOED_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  const settingsPath = resolveClaudeSettingsPath(environment);
  const mcpName = environment.MEMORY_MCP_NAME?.trim() || "koed";
  const nodeCommand = environment.MEMORY_NODE_COMMAND?.trim() || "node";
  const checkedAt = new Date().toISOString();
  const command = `${executable} mcp add --scope user ${mcpName}`;
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
    if (!existsSync(runtime.mcpCli) || !existsSync(runtime.captureHook)) {
      return failure(
        "Koed's Claude Code integration artifacts are missing.",
        "Repair Koed, then set up Claude Code integration again."
      );
    }
    const childEnvironment = claudeProcessEnvironment(environment);
    const version = spawnSync(executable, ["--version"], {
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
    const auth = spawnSync(executable, ["auth", "status", "--json"], {
      encoding: "utf8",
      env: childEnvironment,
      timeout: 10_000
    });
    if (auth.error || auth.status !== 0) {
      return failure(
        "Claude Code is not signed in.",
        "Run `claude auth login`, then set up Claude Code integration again.",
        auth
      );
    }

    const settings: ClaudeSettings = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettings)
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

    const existingMcp = spawnSync(executable, ["mcp", "get", mcpName], {
      encoding: "utf8",
      env: childEnvironment,
      timeout: 10_000
    });
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
      const remove = spawnSync(
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
    }
    const add = spawnSync(
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
      return failure(
        add.error?.message ?? add.stderr?.trim() ?? "Claude MCP setup failed.",
        "Fix the reported Claude Code MCP error, then repair the integration.",
        add
      );
    }

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
    return failure(
      error instanceof Error ? error.message : String(error),
      "Fix Claude Code settings permissions or malformed settings, then repair the integration."
    );
  }
};
