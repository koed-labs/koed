import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  aiClientCapabilityIds,
  defaultAiClientInstanceId,
  sanitizeAiClientDiagnostics,
  type AiClientCapabilityDescriptor,
  type AiClientDiagnostic,
  type AiClientModelCapability,
  type AiClientRecoveryActionId
} from "@koed/shared";
import {
  query,
  type ModelInfo,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  checkPiAvailability,
  listPiModels,
  resolvePiExecutable,
  runPiRpcTask
} from "./pi-rpc-runner.js";
import {
  checkCodexAppServerAvailability,
  koedAiClientWorkerDeveloperInstructions,
  listCodexAppServerModels,
  resolveCodexAppServerBinary,
  runCodexAppServerJsonTask,
  type CodexAppServerModelOption,
  type CodexAppServerRawEvent,
  type CodexThreadTokenUsage
} from "./codex-app-server-runner.js";

export type AiClientProvider = "codex" | "claude" | "pi";

export interface AiClientRunConfig {
  provider: AiClientProvider;
  aiClientInstanceId?: string;
  model: string;
  modelProvider?: string;
  reasoningEffort: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  clientName: string;
  systemPrompt: string;
  developerInstructions?: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AiClientRunResult {
  text: string;
  model: string;
  modelProvider?: string;
  tokenUsage?: CodexThreadTokenUsage;
  provider?: AiClientProvider;
  aiClientInstanceId?: string;
  transport?: "app_server" | "agent_sdk" | "pi_rpc";
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
  providerEvents?: unknown[];
}

export interface AiClientExecutionIdentity {
  provider: AiClientProvider;
  driverId: AiClientProvider;
  aiClientInstanceId: string;
  modelProvider?: string;
  modelId?: string;
  transport: "app_server" | "agent_sdk" | "pi_rpc";
  sourceRuntime: "codex" | "claude-code" | "pi";
  sourceKind: "codex" | "claude-code" | "pi";
  sourceAdapterVersion:
    | "codex-app-server-v1"
    | "claude-agent-sdk-v1"
    | "pi-rpc-v1";
  usageSource: "app_server" | "connector_native";
  connectorClient: "codex" | "claude" | "pi";
}

export const aiClientExecutionIdentity = (
  provider: AiClientProvider,
  aiClientInstanceId = `${provider}.default`,
  model?: { provider?: string; id?: string }
): AiClientExecutionIdentity =>
  provider === "pi"
    ? {
        provider,
        driverId: provider,
        aiClientInstanceId,
        ...(model?.provider ? { modelProvider: model.provider } : {}),
        ...(model?.id ? { modelId: model.id } : {}),
        transport: "pi_rpc",
        sourceRuntime: "pi",
        sourceKind: "pi",
        sourceAdapterVersion: "pi-rpc-v1",
        usageSource: "connector_native",
        connectorClient: "pi"
      }
    : provider === "claude"
      ? {
          provider,
          driverId: provider,
          aiClientInstanceId,
          ...(model?.provider ? { modelProvider: model.provider } : {}),
          ...(model?.id ? { modelId: model.id } : {}),
          transport: "agent_sdk",
          sourceRuntime: "claude-code",
          sourceKind: "claude-code",
          sourceAdapterVersion: "claude-agent-sdk-v1",
          usageSource: "connector_native",
          connectorClient: "claude"
        }
      : {
          provider,
          driverId: provider,
          aiClientInstanceId,
          ...(model?.provider ? { modelProvider: model.provider } : {}),
          ...(model?.id ? { modelId: model.id } : {}),
          transport: "app_server",
          sourceRuntime: "codex",
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          usageSource: "app_server",
          connectorClient: "codex"
        };

export interface AiClientTaskDriver {
  id: AiClientProvider;
  runJsonTask(
    prompt: string,
    config: AiClientRunConfig,
    timeoutMs: number
  ): Promise<AiClientRunResult>;
}

export interface AiClientDriverDiscoveryInput {
  instanceId: string;
  environment: NodeJS.ProcessEnv;
  executablePath?: string;
  cwd?: string;
}

export interface AiClientDriverDiscovery {
  installationIdentityHash: string;
  clientVersion: string | null;
  authenticationState: "authenticated" | "unauthenticated" | "unknown";
  healthState: "healthy" | "unavailable" | "incompatible" | "error";
  models: AiClientModelCapability[];
  capabilities: AiClientCapabilityDescriptor[];
  diagnostics: AiClientDiagnostic[];
}

export interface AiClientDriver extends AiClientTaskDriver {
  displayName: string;
  discover(
    input: AiClientDriverDiscoveryInput
  ): Promise<AiClientDriverDiscovery>;
}

export interface ClaudeCodeAvailability {
  available: boolean;
  executablePath: string | null;
  version: string | null;
  authenticated: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  error: string | null;
}

export const MINIMUM_SUPPORTED_CLAUDE_CODE_VERSION = "2.1.227";

const numericVersion = (value: string): [number, number, number] | null => {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const assertClaudeCodeVersionCompatibility = (value: string): void => {
  const actual = numericVersion(value);
  const minimum = numericVersion(MINIMUM_SUPPORTED_CLAUDE_CODE_VERSION)!;
  const comparison = actual
    ? actual.reduce(
        (result, part, index) =>
          result !== 0 ? result : Math.sign(part - minimum[index]!),
        0
      )
    : -1;
  if (comparison < 0) {
    throw new Error(
      `Claude Code ${value.trim() || "version output"} is incompatible. Koed requires Claude Code ${MINIMUM_SUPPORTED_CLAUDE_CODE_VERSION} or newer.`
    );
  }
};

const execFileAsync = promisify(execFile);
const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;
const CODEX_VERSION_PROBE_MAX_BUFFER = 16 * 1024;

export const parseCodexVersion = (output: string): string | null => {
  const normalized = [...output]
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? " "
        : character
    )
    .join("");
  const match = normalized.match(
    /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![0-9.])/
  );
  return match?.[1] ?? null;
};

export const probeCodexVersion = async (
  executablePath: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = CODEX_VERSION_PROBE_TIMEOUT_MS
): Promise<string> => {
  const requestedTimeoutMs = Number.isFinite(timeoutMs)
    ? timeoutMs
    : CODEX_VERSION_PROBE_TIMEOUT_MS;
  const boundedTimeoutMs = Math.min(
    CODEX_VERSION_PROBE_TIMEOUT_MS,
    Math.max(1, requestedTimeoutMs)
  );
  const result = await execFileAsync(executablePath, ["--version"], {
    env: environment,
    timeout: boundedTimeoutMs,
    maxBuffer: CODEX_VERSION_PROBE_MAX_BUFFER,
    windowsHide: true,
    encoding: "utf8"
  });
  const version = parseCodexVersion(String(result.stdout));
  if (!version) {
    throw new Error("Codex --version returned no parseable version.");
  }
  return version;
};

export interface ClaudeExecutableDiscoveryOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  isWsl?: boolean;
}

interface ConfirmedClaudeInstallation {
  version: 1;
  executablePath: string;
  installationIdentity: string;
}

const isWslEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) ||
  os.release().toLowerCase().includes("microsoft");

export const isWslWindowsMount = (candidate: string): boolean =>
  /^\/mnt\/[a-z](?:\/|$)/i.test(candidate);

const executableNamesFor = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] => {
  if (platform !== "win32") return ["claude"];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return ["", ...new Set(extensions)].map((extension) => `claude${extension}`);
};

export const claudeExecutableInstallationIdentity = (
  executablePath: string
): string => {
  const canonical = fs.realpathSync(executablePath);
  const stat = fs.statSync(canonical);
  return createHash("sha256")
    .update(
      JSON.stringify({
        canonical,
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedMs: stat.mtimeMs
      })
    )
    .digest("hex");
};

const confirmedInstallationPath = (env: NodeJS.ProcessEnv): string =>
  path.resolve(
    env.KOED_CLAUDE_CODE_DISCOVERY_CACHE ??
      path.join(
        env.KOED_HOME ?? path.join(env.HOME ?? os.homedir(), ".koed"),
        "state",
        "claude-code-installation.json"
      )
  );

const readConfirmedInstallation = (
  env: NodeJS.ProcessEnv
): ConfirmedClaudeInstallation | null => {
  const target = confirmedInstallationPath(env);
  try {
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) return null;
    const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !==
        "executablePath,installationIdentity,version" ||
      value.version !== 1 ||
      typeof value.executablePath !== "string" ||
      !path.isAbsolute(value.executablePath) ||
      typeof value.installationIdentity !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.installationIdentity)
    ) {
      return null;
    }
    if (
      claudeExecutableInstallationIdentity(value.executablePath) !==
      value.installationIdentity
    ) {
      return null;
    }
    return value as unknown as ConfirmedClaudeInstallation;
  } catch {
    return null;
  }
};

const rememberConfirmedInstallation = (
  env: NodeJS.ProcessEnv,
  executablePath: string
): void => {
  const target = confirmedInstallationPath(env);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  const value: ConfirmedClaudeInstallation = {
    version: 1,
    executablePath,
    installationIdentity: claudeExecutableInstallationIdentity(executablePath)
  };
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  fs.renameSync(temporary, target);
};

const executableOnPath = (
  env: NodeJS.ProcessEnv,
  names: string[],
  options: { platform: NodeJS.Platform; isWsl: boolean }
): string | undefined => {
  const pathValue = env.PATH;
  if (!pathValue) {
    return undefined;
  }
  const delimiter = options.platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.resolve(directory, name);
      if (options.isWsl && isWslWindowsMount(candidate)) continue;
      try {
        if (fs.statSync(candidate).isFile()) {
          if (options.platform !== "win32") {
            fs.accessSync(candidate, fs.constants.X_OK);
          }
          return fs.realpathSync(candidate);
        }
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
};

const WINDOWS_CLAUDE_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);

export const resolveClaudeSdkExecutablePath = (
  candidate: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (
    platform !== "win32" ||
    !WINDOWS_CLAUDE_SHIM_EXTENSIONS.has(path.extname(candidate).toLowerCase())
  ) {
    return candidate;
  }
  const directory = path.dirname(candidate);
  for (const relative of [
    ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
    ["node_modules", "@anthropic-ai", "claude-code", "cli.js"]
  ]) {
    const target = path.join(directory, ...relative);
    try {
      if (fs.statSync(target).isFile()) return fs.realpathSync(target);
    } catch {
      // Continue through the documented package entry points.
    }
  }
  throw new Error(
    `Claude Code launcher ${candidate} cannot be passed safely to the Agent SDK. Install the native Claude Code executable or use an npm installation with a verifiable package entry.`
  );
};

const claudeProbeInvocation = (
  executablePath: string,
  args: string[]
): { command: string; args: string[] } =>
  path.extname(executablePath).toLowerCase() === ".js"
    ? { command: process.execPath, args: [executablePath, ...args] }
    : { command: executablePath, args };

export const resolveClaudeCodeExecutable = (
  env: NodeJS.ProcessEnv = process.env,
  options: ClaudeExecutableDiscoveryOptions = {}
): string => {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? env.HOME ?? os.homedir();
  const isWsl =
    options.isWsl ?? (platform === "linux" && isWslEnvironment(env));
  const configured = env.KOED_CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("KOED_CLAUDE_CODE_EXECUTABLE must be an absolute path.");
  }
  if (configured && isWsl && isWslWindowsMount(configured)) {
    throw new Error(
      "Claude Code for WSL must be installed inside WSL; Windows executables are a separate execution boundary."
    );
  }
  const confirmedExecutable = readConfirmedInstallation(env)?.executablePath;
  const remembered =
    confirmedExecutable && !(isWsl && isWslWindowsMount(confirmedExecutable))
      ? confirmedExecutable
      : undefined;
  const knownLocations =
    platform === "win32"
      ? [
          path.join(homeDirectory, ".local", "bin", "claude.exe"),
          ...(env.LOCALAPPDATA
            ? [
                path.join(
                  env.LOCALAPPDATA,
                  "Programs",
                  "Claude Code",
                  "claude.exe"
                )
              ]
            : [])
        ]
      : platform === "darwin"
        ? [
            path.join(homeDirectory, ".local", "bin", "claude"),
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude"
          ]
        : [
            path.join(homeDirectory, ".local", "bin", "claude"),
            "/usr/local/bin/claude"
          ];
  const candidate = configured
    ? configured
    : (remembered ??
      executableOnPath(env, executableNamesFor(platform, env), {
        platform,
        isWsl
      }) ??
      knownLocations.find((location) => {
        if (isWsl && isWslWindowsMount(location)) return false;
        try {
          return fs.statSync(location).isFile();
        } catch {
          return false;
        }
      }));
  if (!candidate) {
    throw new Error(
      "Claude Code was not found. Install and sign in to Claude Code, or set KOED_CLAUDE_CODE_EXECUTABLE to its absolute path."
    );
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(
      resolveClaudeSdkExecutablePath(candidate, platform)
    );
  } catch {
    throw new Error(`Claude Code executable does not exist: ${candidate}`);
  }
  if (!fs.statSync(canonical).isFile()) {
    throw new Error(`Claude Code executable is not a file: ${canonical}`);
  }
  if (platform !== "win32") {
    try {
      fs.accessSync(canonical, fs.constants.X_OK);
    } catch {
      throw new Error(`Claude Code executable is not executable: ${canonical}`);
    }
  }
  return canonical;
};

export const checkClaudeCodeAvailability = async (
  env: NodeJS.ProcessEnv = process.env,
  options: ClaudeExecutableDiscoveryOptions = {}
): Promise<ClaudeCodeAvailability> => {
  try {
    const executablePath = resolveClaudeCodeExecutable(env, options);
    const versionProbe = claudeProbeInvocation(executablePath, ["--version"]);
    const authProbe = claudeProbeInvocation(executablePath, [
      "auth",
      "status",
      "--json"
    ]);
    const [{ stdout: versionOutput }, { stdout: authOutput }] =
      await Promise.all([
        execFileAsync(versionProbe.command, versionProbe.args, {
          env: claudeAgentSdkEnvironment(env, "availability-check"),
          timeout: 10_000
        }),
        execFileAsync(authProbe.command, authProbe.args, {
          env: claudeAgentSdkEnvironment(env, "availability-check"),
          timeout: 10_000
        })
      ]);
    const auth = JSON.parse(authOutput) as Record<string, unknown>;
    assertClaudeCodeVersionCompatibility(versionOutput);
    const authenticated = auth.loggedIn === true;
    rememberConfirmedInstallation(env, executablePath);
    return {
      available: authenticated,
      executablePath,
      version: versionOutput.trim() || null,
      authenticated,
      authMethod: typeof auth.authMethod === "string" ? auth.authMethod : null,
      apiProvider:
        typeof auth.apiProvider === "string" ? auth.apiProvider : null,
      error: authenticated ? null : "Claude Code is not signed in."
    };
  } catch (error) {
    return {
      available: false,
      executablePath: null,
      version: null,
      authenticated: false,
      authMethod: null,
      apiProvider: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};

export const claudeAgentSdkEnvironment = (
  env: NodeJS.ProcessEnv,
  clientName: string
): Record<string, string | undefined> => {
  const allowedNames = [
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
    "TERM",
    "COLORTERM",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "CLAUDE_CONFIG_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS"
  ];
  return Object.fromEntries([
    ...allowedNames
      .map((name) => [name, env[name]] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1])),
    ["CLAUDE_AGENT_SDK_CLIENT_APP", `koed/${clientName}`]
  ]);
};

const claudeResultText = (message: Extract<SDKMessage, { type: "result" }>) => {
  if (message.subtype !== "success" || message.is_error) {
    const detail =
      "errors" in message && Array.isArray(message.errors)
        ? message.errors.join("; ")
        : "Claude Agent SDK execution failed";
    throw new Error(detail);
  }
  if (message.structured_output !== undefined) {
    return JSON.stringify(message.structured_output);
  }
  return message.result;
};

export const claudeAgentSdkTokenUsage = (
  message: Extract<SDKMessage, { type: "result" }>
): CodexThreadTokenUsage | undefined => {
  const usages = Object.values(message.modelUsage ?? {});
  if (usages.length === 0) return undefined;
  const last = usages.reduce(
    (total, usage) => ({
      inputTokens: (total.inputTokens ?? 0) + usage.inputTokens,
      cachedInputTokens:
        (total.cachedInputTokens ?? 0) + usage.cacheReadInputTokens,
      outputTokens: (total.outputTokens ?? 0) + usage.outputTokens,
      totalTokens:
        (total.totalTokens ?? 0) + usage.inputTokens + usage.outputTokens
    }),
    {} as NonNullable<CodexThreadTokenUsage["last"]>
  );
  return {
    last,
    total: { ...last },
    modelContextWindow: Math.max(...usages.map((usage) => usage.contextWindow))
  };
};

export const claudeSupportedReasoningEfforts = (
  model: Pick<ModelInfo, "supportsEffort" | "supportedEffortLevels">
): string[] | undefined => {
  if (model.supportsEffort === false) return ["none"];
  return Array.isArray(model.supportedEffortLevels)
    ? [...model.supportedEffortLevels]
    : undefined;
};

export const claudeAgentSdkEffort = (
  value: string
): "low" | "medium" | "high" | "xhigh" | "max" | undefined => {
  if (value === "none") return undefined;
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  ) {
    return value;
  }
  throw new Error(`Unsupported Claude reasoning effort: ${value}`);
};

export const runClaudeAgentSdkTask = async (
  prompt: string,
  config: AiClientRunConfig,
  timeoutMs: number
): Promise<AiClientRunResult> => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  const providerEvents: SDKMessage[] = [];
  let resultMessage: Extract<SDKMessage, { type: "result" }> | undefined;
  let sessionId: string | undefined;
  try {
    const effort = claudeAgentSdkEffort(config.reasoningEffort);
    const stream = query({
      prompt,
      options: {
        abortController,
        cwd: config.cwd,
        env: claudeAgentSdkEnvironment(config.env, config.clientName),
        pathToClaudeCodeExecutable: config.executablePath,
        model: config.model,
        ...(effort ? { effort } : {}),
        thinking: { type: "disabled" },
        systemPrompt: [
          config.systemPrompt,
          config.developerInstructions ??
            koedAiClientWorkerDeveloperInstructions
        ],
        outputFormat: config.outputSchema
          ? { type: "json_schema", schema: config.outputSchema }
          : undefined,
        tools: [],
        allowedTools: [],
        permissionMode: "dontAsk",
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        includePartialMessages: false,
        forwardSubagentText: false
      }
    });
    for await (const message of stream) {
      providerEvents.push(message);
      if ("session_id" in message && typeof message.session_id === "string") {
        sessionId = message.session_id;
      }
      if (message.type === "result") {
        resultMessage = message;
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(`Claude Agent SDK timed out after ${timeoutMs}ms`, {
        cause: error
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!resultMessage) {
    throw new Error("Claude Agent SDK completed without a result message");
  }
  const model = Object.keys(resultMessage.modelUsage ?? {})[0] ?? config.model;
  return {
    text: claudeResultText(resultMessage),
    model,
    tokenUsage: claudeAgentSdkTokenUsage(resultMessage),
    threadId: sessionId,
    providerEvents
  };
};

export const listClaudeAgentSdkModels = async (
  env: NodeJS.ProcessEnv = process.env,
  queryFactory: typeof query = query
): Promise<ModelInfo[]> => {
  const executablePath = resolveClaudeCodeExecutable(env);
  const abortController = new AbortController();
  async function* idlePrompt(): AsyncGenerator<never> {
    yield* [] as never[];
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve(), {
        once: true
      });
    });
  }
  const stream = queryFactory({
    prompt: idlePrompt(),
    options: {
      abortController,
      env: claudeAgentSdkEnvironment(env, "model-discovery"),
      pathToClaudeCodeExecutable: executablePath,
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false
    }
  });
  try {
    return await stream.supportedModels();
  } finally {
    stream.close();
    abortController.abort();
  }
};

const installationIdentityHash = (executablePath: string): string => {
  try {
    const canonical = fs.realpathSync(executablePath);
    const stat = fs.statSync(canonical);
    return createHash("sha256")
      .update(
        JSON.stringify({
          canonical,
          device: stat.dev,
          inode: stat.ino,
          size: stat.size,
          modifiedMs: stat.mtimeMs
        })
      )
      .digest("hex");
  } catch {
    return createHash("sha256").update(executablePath).digest("hex");
  }
};

const managedCapabilityIds: Set<string> = new Set([
  aiClientCapabilityIds.managedConversationStart,
  aiClientCapabilityIds.managedConversationResume,
  aiClientCapabilityIds.managedConversationSend,
  aiClientCapabilityIds.managedConversationCancel,
  aiClientCapabilityIds.approvals,
  aiClientCapabilityIds.streaming,
  aiClientCapabilityIds.sessionIdentity,
  aiClientCapabilityIds.handoff,
  aiClientCapabilityIds.fork
]);

const implementedManagedCapabilityIds: Set<string> = new Set([
  aiClientCapabilityIds.managedConversationStart,
  aiClientCapabilityIds.managedConversationResume,
  aiClientCapabilityIds.managedConversationSend,
  aiClientCapabilityIds.sessionIdentity,
  aiClientCapabilityIds.handoff,
  aiClientCapabilityIds.fork
]);

const supportedCapabilityIds = (driver: AiClientProvider): Set<string> => {
  if (driver === "pi") {
    return new Set(
      Object.values(aiClientCapabilityIds).filter(
        (id) => !managedCapabilityIds.has(id)
      )
    );
  }
  return new Set(
    Object.values(aiClientCapabilityIds).filter(
      (id) =>
        !managedCapabilityIds.has(id) || implementedManagedCapabilityIds.has(id)
    )
  );
};

const capability = (
  id: (typeof aiClientCapabilityIds)[keyof typeof aiClientCapabilityIds],
  driver: AiClientProvider,
  synthesisReady: boolean,
  recoveryAction?: AiClientRecoveryActionId
): AiClientCapabilityDescriptor => {
  const supported = supportedCapabilityIds(driver).has(id);
  const readiness = !supported
    ? "not_ready"
    : id === aiClientCapabilityIds.localSynthesis
      ? synthesisReady
        ? "ready"
        : "not_ready"
      : managedCapabilityIds.has(id)
        ? implementedManagedCapabilityIds.has(id)
          ? "ready"
          : "not_ready"
        : "unknown";
  return {
    id,
    support: supported ? "supported" : "unsupported",
    readiness,
    diagnostics: [],
    ...(recoveryAction
      ? {
          recoveryAction: {
            id: recoveryAction,
            label: `${recoveryAction[0]!.toUpperCase()}${recoveryAction.slice(1)} AI Client`,
            available: true
          }
        }
      : {})
  };
};

const capabilitiesFor = (
  driver: AiClientProvider,
  synthesisReady: boolean
): AiClientCapabilityDescriptor[] =>
  Object.values(aiClientCapabilityIds).map((id) =>
    capability(
      id,
      driver,
      synthesisReady,
      id === aiClientCapabilityIds.setup ||
        id === aiClientCapabilityIds.check ||
        id === aiClientCapabilityIds.repair ||
        id === aiClientCapabilityIds.remove
        ? id
        : undefined
    )
  );

const normalizedModelCapability = (input: {
  id: string;
  provider: string;
  model?: string;
  displayName?: string;
  supportedReasoningEfforts?: string[];
}): AiClientModelCapability => {
  const model = input.model?.trim() || input.id.trim();
  const fullId = input.id.includes("/")
    ? input.id.trim()
    : `${input.provider}/${model}`;
  return {
    id: input.id,
    provider: input.provider,
    model,
    fullId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    provenance: "reported",
    ...(input.supportedReasoningEfforts
      ? { supportedReasoningEfforts: input.supportedReasoningEfforts }
      : {})
  };
};

export const aiClientDiscoveryError = (
  input: AiClientDriverDiscoveryInput,
  driver: AiClientProvider,
  error: unknown,
  models: AiClientModelCapability[] = []
): AiClientDriverDiscovery => {
  const message = error instanceof Error ? error.message : String(error);
  const authenticationState = /auth|sign in|logged in|credential/i.test(message)
    ? "unauthenticated"
    : "unknown";
  const diagnostics: AiClientDiagnostic[] = sanitizeAiClientDiagnostics([
    { code: "discovery_failed", message, severity: "error" }
  ]);
  return {
    installationIdentityHash: installationIdentityHash(
      input.executablePath ?? input.instanceId
    ),
    clientVersion: null,
    authenticationState,
    healthState: "unavailable",
    models,
    capabilities: capabilitiesFor(driver, false).map((item) => ({
      ...item,
      diagnostics,
      readiness:
        item.support === "supported" &&
        authenticationState === "unauthenticated"
          ? "unauthenticated"
          : "unavailable"
    })),
    diagnostics
  };
};

const codexDriver: AiClientDriver = {
  id: "codex",
  displayName: "Codex",
  runJsonTask(prompt, config, timeoutMs) {
    return runCodexAppServerJsonTask(
      prompt,
      {
        appServerBinary: config.executablePath,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        cwd: config.cwd,
        env: config.env,
        clientName: config.clientName,
        baseInstructions: config.systemPrompt,
        developerInstructions:
          config.developerInstructions ??
          koedAiClientWorkerDeveloperInstructions
      },
      timeoutMs
    );
  },
  async discover(input) {
    try {
      const executablePath =
        input.executablePath ?? resolveCodexAppServerBinary(input.environment);
      const cwd = input.cwd ?? process.cwd();
      const model = input.environment.MEMORY_CODEX_MODEL ?? "gpt-5.4-mini";
      const clientVersion = await probeCodexVersion(
        executablePath,
        input.environment
      );
      const models = await listCodexAppServerModels(
        {
          appServerBinary: executablePath,
          model,
          cwd,
          env: input.environment,
          clientName: "koed-capability-discovery",
          includeHidden: true
        },
        10_000
      );
      const normalized = models.map((candidate: CodexAppServerModelOption) =>
        normalizedModelCapability({
          id: candidate.id,
          provider: "openai",
          model: candidate.model,
          displayName: candidate.label,
          supportedReasoningEfforts: candidate.supportedReasoningEfforts.map(
            (effort) => effort.reasoningEffort
          )
        })
      );
      if (normalized.length === 0) {
        return aiClientDiscoveryError(
          { ...input, executablePath },
          "codex",
          new Error("Codex reported no models")
        );
      }
      const availability = await checkCodexAppServerAvailability(
        {
          appServerBinary: executablePath,
          model,
          cwd,
          env: input.environment,
          clientName: "koed-capability-check"
        },
        10_000
      );
      if (!availability.available) {
        return aiClientDiscoveryError(
          { ...input, executablePath },
          "codex",
          new Error(availability.error ?? "Codex is unavailable"),
          normalized
        );
      }
      return {
        installationIdentityHash: installationIdentityHash(executablePath),
        clientVersion,
        authenticationState: "authenticated",
        healthState: "healthy",
        models: normalized,
        capabilities: capabilitiesFor("codex", true),
        diagnostics: []
      };
    } catch (error) {
      return aiClientDiscoveryError(input, "codex", error);
    }
  }
};

const claudeDriver: AiClientDriver = {
  id: "claude",
  displayName: "Claude Code",
  runJsonTask: runClaudeAgentSdkTask,
  async discover(input) {
    try {
      const availability = await checkClaudeCodeAvailability(input.environment);
      if (!availability.available || !availability.executablePath) {
        return aiClientDiscoveryError(
          {
            ...input,
            executablePath: availability.executablePath ?? input.executablePath
          },
          "claude",
          new Error(availability.error ?? "Claude Code is unavailable")
        );
      }
      const models = await listClaudeAgentSdkModels(input.environment);
      const normalized = models.map((model) =>
        normalizedModelCapability({
          id: model.value,
          provider: "anthropic",
          model: model.value,
          displayName: model.displayName,
          supportedReasoningEfforts: claudeSupportedReasoningEfforts(model)
        })
      );
      return {
        installationIdentityHash: installationIdentityHash(
          availability.executablePath
        ),
        clientVersion: availability.version,
        authenticationState: "authenticated",
        healthState: "healthy",
        models: normalized,
        capabilities: capabilitiesFor("claude", true),
        diagnostics: []
      };
    } catch (error) {
      return aiClientDiscoveryError(input, "claude", error);
    }
  }
};

const piDriver: AiClientDriver = {
  id: "pi",
  displayName: "Pi",
  runJsonTask: runPiRpcTask,
  async discover(input) {
    try {
      const availability = await checkPiAvailability(input.environment);
      if (!availability.executablePath || !availability.available) {
        return aiClientDiscoveryError(
          {
            ...input,
            executablePath: availability.executablePath ?? input.executablePath
          },
          "pi",
          new Error(availability.error ?? "Pi is unavailable")
        );
      }
      const models = availability.models.map((model) =>
        normalizedModelCapability({
          id: model.id,
          provider: model.provider,
          model: model.model,
          displayName: model.model,
          supportedReasoningEfforts: model.supportedReasoningEfforts
        })
      );
      return {
        installationIdentityHash: installationIdentityHash(
          availability.executablePath
        ),
        clientVersion: availability.version,
        authenticationState: "authenticated",
        healthState: "healthy",
        models,
        capabilities: capabilitiesFor("pi", true),
        diagnostics: []
      };
    } catch (error) {
      return aiClientDiscoveryError(input, "pi", error);
    }
  }
};

export const aiClientDriverRegistry = new Map<AiClientProvider, AiClientDriver>(
  [codexDriver, claudeDriver, piDriver].map((driver) => [driver.id, driver])
);

export const aiClientDriverFor = (driverId: string): AiClientDriver => {
  const driver = aiClientDriverRegistry.get(driverId as AiClientProvider);
  if (!driver) {
    throw new Error(
      `AI Client driver "${driverId}" is not available in this Koed build.`
    );
  }
  return driver;
};

export { checkPiAvailability, listPiModels, resolvePiExecutable };

export const aiClientTaskDriverFor = (driverId: string): AiClientTaskDriver =>
  aiClientDriverFor(driverId);

export const runAiClientJsonTask = async (
  prompt: string,
  config: AiClientRunConfig,
  timeoutMs: number
): Promise<AiClientRunResult> => {
  const result = await aiClientTaskDriverFor(config.provider).runJsonTask(
    prompt,
    config,
    timeoutMs
  );
  return {
    ...result,
    ...aiClientExecutionIdentity(
      config.provider,
      config.aiClientInstanceId ?? defaultAiClientInstanceId(config.provider),
      {
        provider: result.modelProvider ?? config.modelProvider,
        id: result.model
      }
    ),
    modelProvider: result.modelProvider ?? config.modelProvider
  };
};
