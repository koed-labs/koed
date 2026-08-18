import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPrompt } from "./prompt-loader.js";

export interface CodexTokenUsageBreakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface CodexThreadTokenUsage {
  total?: CodexTokenUsageBreakdown;
  last?: CodexTokenUsageBreakdown;
  modelContextWindow?: number | null;
}

export interface CodexAppServerRawEvent {
  method: string;
  params?: unknown;
  result?: unknown;
  observedAt: string;
  sequence: number;
}

export interface CodexAppServerProcessMetrics {
  pid: number;
  peakRssBytes: number;
  measurement: "proc_status_tree" | "ps_rss" | "powershell_working_set";
  sampleCount: number;
  samplingIntervalMs: number;
}

export interface CodexAppServerThreadInfo {
  id: string;
  sessionId?: string;
  parentThreadId?: string;
  forkedFromId?: string;
  path?: string;
  cwd?: string;
  source?: unknown;
  modelProvider?: string;
  cliVersion?: string;
  gitInfo?: unknown;
  name?: string;
  raw: Record<string, unknown>;
}

export interface CodexAppServerThreadStartOptions {
  ephemeral?: boolean;
  historyMode?: "legacy" | "paginated";
  /** @deprecated Use historyMode. */
  persistExtendedHistory?: boolean;
  threadSource?: string;
  minimalContext?: boolean;
}

export interface CodexAppServerReasoningEffortOption {
  reasoningEffort: string;
  description?: string;
}

export interface CodexAppServerModelOption {
  id: string;
  model: string;
  label: string;
  description?: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: CodexAppServerReasoningEffortOption[];
}

export interface CodexAppServerDynamicToolSpec {
  namespace?: string;
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export interface CodexAppServerDynamicToolCall {
  threadId: string;
  turnId: string;
  callId: string;
  namespace?: string;
  tool: string;
  arguments: unknown;
}

export interface CodexAppServerDynamicToolResponse {
  success: boolean;
  text: string;
}

export interface CodexAppServerRunConfig {
  appServerBinary: string;
  model: string;
  reasoningEffort: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientName: string;
  baseInstructions: string;
  developerInstructions?: string;
  /** Direct-call diagnostics only; ordinary product calls leave this disabled. */
  captureProcessMetrics?: boolean;
  dynamicTools?: CodexAppServerDynamicToolSpec[];
  dynamicToolHandler?: (
    call: CodexAppServerDynamicToolCall
  ) => Promise<CodexAppServerDynamicToolResponse>;
}

export interface CodexAppServerJsonTaskConfig {
  appServerBinary: string;
  model: string;
  reasoningEffort: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientName: string;
  baseInstructions: string;
  developerInstructions?: string;
}

export interface CodexAppServerRunResult {
  text: string;
  model: string;
  tokenUsage?: CodexThreadTokenUsage;
  threadId?: string;
  turnId?: string;
  rawEvents?: CodexAppServerRawEvent[];
  primaryThreadId?: string;
  processMetrics?: CodexAppServerProcessMetrics;
}

export class CodexAppServerTurnError extends Error {
  readonly model: string;
  readonly tokenUsage?: CodexThreadTokenUsage;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly rawEvents?: CodexAppServerRawEvent[];
  readonly processMetrics?: CodexAppServerProcessMetrics;

  constructor(
    message: string,
    options: {
      model: string;
      tokenUsage?: CodexThreadTokenUsage;
      threadId?: string;
      turnId?: string;
      rawEvents?: CodexAppServerRawEvent[];
      processMetrics?: CodexAppServerProcessMetrics;
    }
  ) {
    super(message);
    this.name = "CodexAppServerTurnError";
    this.model = options.model;
    this.tokenUsage = options.tokenUsage;
    this.threadId = options.threadId;
    this.turnId = options.turnId;
    this.rawEvents = options.rawEvents;
    this.processMetrics = options.processMetrics;
  }
}

type JsonRpcId = number | string;

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    message?: string;
    [key: string]: unknown;
  };
}

export interface CodexAppServerClientOptions {
  requestTimeoutMs?: number;
  interruptRequestTimeoutMs?: number;
  serverRequestTimeoutMs?: number;
  closeGraceMs?: number;
  maxRawEvents?: number;
  maxRawEventBytes?: number;
  maxPendingRawEvents?: number;
  maxPendingRawEventBytes?: number;
  maxTurnStates?: number;
  maxTurnBytes?: number;
  maxLineBytes?: number;
  captureProcessMetrics?: boolean;
  onExit?: (exit: CodexAppServerExit) => void;
}

export interface CodexAppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  requestedClose: boolean;
  terminalError?: Error;
}

export class CodexAppServerCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerCapacityError";
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INTERRUPT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const DEFAULT_MAX_RAW_EVENTS = 2_000;
const DEFAULT_MAX_RAW_EVENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PENDING_RAW_EVENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TURN_STATES = 100;
const DEFAULT_MAX_TURN_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;

const positiveFiniteInteger = (value: number | undefined, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const resolveEnvValue = (
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined => {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
};

export const resolveCodexAppServerBinary = (
  env: NodeJS.ProcessEnv = process.env,
  compatibilityNames: string[] = []
): string =>
  resolveEnvValue(env, "MEMORY_CODEX_APP_SERVER_BINARY") ??
  compatibilityNames
    .map((name) => resolveEnvValue(env, name))
    .find((value): value is string => Boolean(value)) ??
  (process.platform === "win32" ? "codex.cmd" : "codex");

const sourceCodexHome = (env: NodeJS.ProcessEnv): string =>
  resolveEnvValue(env, "CODEX_HOME") ?? path.join(os.homedir(), ".codex");

const managedCodexRoot = (env: NodeJS.ProcessEnv): string => {
  const koedHome =
    resolveEnvValue(env, "KOED_HOME") ?? path.join(os.homedir(), ".koed");
  return path.resolve(koedHome, "codex-managed");
};

const MANAGED_HOME_MARKER_FILENAME = "koed-managed-home.json";
const MANAGED_HOME_LEASE_DIRECTORY = ".koed-managed-home.lease";
const MANAGED_HOME_LEASE_OWNER_FILENAME = "owner.json";

interface ManagedCodexHomeLeaseOwner {
  version: 1;
  pid: number;
  hostname: string;
  processStartId: string;
  token: string;
  createdAt: string;
}

export interface ManagedCodexHomeLease {
  managedHome: string;
  token: string;
  release: () => void;
}

export class CodexManagedHomeLeaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexManagedHomeLeaseError";
  }
}

const processStartId = (pid: number): string | undefined => {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) {
        return undefined;
      }
      return stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/)[19];
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
      ],
      { encoding: "utf8", windowsHide: true, timeout: 2_000 }
    );
    const value = result.status === 0 ? result.stdout.trim() : "";
    return value || undefined;
  }
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2_000
  });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || undefined;
};

const managedHomeMarkerIsValid = (managedHome: string): boolean => {
  const markerPath = path.join(managedHome, MANAGED_HOME_MARKER_FILENAME);
  try {
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      return false;
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as {
      version?: unknown;
      kind?: unknown;
    };
    return marker.version === 1 && marker.kind === "koed-managed-codex-home";
  } catch {
    return false;
  }
};

const validatedManagedCodexHome = (
  managedHome: string,
  env: NodeJS.ProcessEnv
): string => {
  const root = managedCodexRoot(env);
  const resolved = path.resolve(managedHome);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Managed Codex home is outside KOED_HOME");
  }
  const homeStat = fs.lstatSync(resolved);
  const configPath = path.join(resolved, "config.toml");
  const configStat = fs.lstatSync(configPath);
  if (
    !homeStat.isDirectory() ||
    homeStat.isSymbolicLink() ||
    !configStat.isFile() ||
    configStat.isSymbolicLink() ||
    !managedHomeMarkerIsValid(resolved)
  ) {
    throw new Error("Managed Codex home is incomplete or unrecognized");
  }
  const realRoot = fs.realpathSync(root);
  const realHome = fs.realpathSync(resolved);
  if (realHome === realRoot || !realHome.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error("Managed Codex home resolves outside KOED_HOME");
  }
  return resolved;
};

const parseManagedHomeLeaseOwner = (
  leasePath: string
): ManagedCodexHomeLeaseOwner => {
  let owner: Partial<ManagedCodexHomeLeaseOwner>;
  try {
    const leaseStat = fs.lstatSync(leasePath);
    if (!leaseStat.isDirectory() || leaseStat.isSymbolicLink()) {
      throw new Error("lease path is not a directory");
    }
    owner = JSON.parse(
      fs.readFileSync(
        path.join(leasePath, MANAGED_HOME_LEASE_OWNER_FILENAME),
        "utf8"
      )
    ) as Partial<ManagedCodexHomeLeaseOwner>;
  } catch (error) {
    throw new CodexManagedHomeLeaseError(
      "Managed Codex home lease is malformed and cannot be safely recovered",
      { cause: error }
    );
  }
  if (
    owner.version !== 1 ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0 ||
    typeof owner.hostname !== "string" ||
    typeof owner.token !== "string" ||
    owner.token.length < 8 ||
    typeof owner.createdAt !== "string" ||
    Number.isNaN(Date.parse(owner.createdAt)) ||
    typeof owner.processStartId !== "string" ||
    owner.processStartId.length === 0
  ) {
    throw new CodexManagedHomeLeaseError(
      "Managed Codex home lease is malformed and cannot be safely recovered"
    );
  }
  return owner as ManagedCodexHomeLeaseOwner;
};

const managedHomeLeaseOwnerIsAlive = (
  owner: ManagedCodexHomeLeaseOwner
): boolean => {
  if (owner.hostname !== os.hostname()) {
    return true;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  const currentStartId = processStartId(owner.pid);
  return (
    currentStartId === undefined || owner.processStartId === currentStartId
  );
};

const writeManagedHomeLeaseCandidate = (
  candidatePath: string,
  owner: ManagedCodexHomeLeaseOwner
): void => {
  fs.mkdirSync(candidatePath, { mode: 0o700 });
  const ownerPath = path.join(candidatePath, MANAGED_HOME_LEASE_OWNER_FILENAME);
  fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
  const descriptor = fs.openSync(ownerPath, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

export const acquireManagedCodexHomeLease = (
  managedHome: string,
  env: NodeJS.ProcessEnv = process.env
): ManagedCodexHomeLease => {
  const resolved = validatedManagedCodexHome(managedHome, env);
  const leasePath = path.join(resolved, MANAGED_HOME_LEASE_DIRECTORY);
  const currentProcessStartId = processStartId(process.pid);
  if (!currentProcessStartId) {
    throw new CodexManagedHomeLeaseError(
      "Could not establish the current process start identity"
    );
  }
  const owner: ManagedCodexHomeLeaseOwner = {
    version: 1,
    pid: process.pid,
    hostname: os.hostname(),
    processStartId: currentProcessStartId,
    token: randomUUID(),
    createdAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidatePath = `${leasePath}.candidate-${owner.token}-${attempt}`;
    writeManagedHomeLeaseCandidate(candidatePath, owner);
    try {
      fs.renameSync(candidatePath, leasePath);
      let released = false;
      return {
        managedHome: resolved,
        token: owner.token,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          if (!fs.existsSync(leasePath)) {
            return;
          }
          const current = parseManagedHomeLeaseOwner(leasePath);
          if (current.token !== owner.token) {
            return;
          }
          fs.rmSync(leasePath, { recursive: true, force: true });
        }
      };
    } catch (error) {
      fs.rmSync(candidatePath, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "EEXIST" &&
        code !== "ENOTEMPTY" &&
        code !== "EPERM" &&
        code !== "EACCES"
      ) {
        throw error;
      }
    }

    const existing = parseManagedHomeLeaseOwner(leasePath);
    if (managedHomeLeaseOwnerIsAlive(existing)) {
      throw new CodexManagedHomeLeaseError(
        `Managed Codex home is active under lease owned by pid ${existing.pid}`
      );
    }
    const staleIdentity = createHash("sha256")
      .update(JSON.stringify(existing))
      .digest("hex")
      .slice(0, 16);
    const quarantinePath = `${leasePath}.stale-${staleIdentity}`;
    try {
      fs.renameSync(leasePath, quarantinePath);
      // Keep the non-empty tombstone. A contender that inspected this same
      // stale owner cannot then rename a newly acquired live lease over it.
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY") {
        throw error;
      }
    }
  }
  throw new CodexManagedHomeLeaseError(
    "Managed Codex home lease changed repeatedly during acquisition"
  );
};

const copyCodexCredentials = (sourceHome: string, targetHome: string): void => {
  for (const filename of ["auth.json", ".credentials.json"]) {
    const source = path.join(sourceHome, filename);
    const target = path.join(targetHome, filename);
    if (!fs.existsSync(source)) {
      fs.rmSync(target, { force: true });
      continue;
    }
    if (path.resolve(source) === path.resolve(target)) {
      continue;
    }
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
  }
};

export const prepareManagedCodexHome = (
  env: NodeJS.ProcessEnv = process.env
): string => {
  const sourceHome = sourceCodexHome(env);
  const managedRoot = managedCodexRoot(env);
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(managedRoot, 0o700);
  const managedHome = fs.mkdtempSync(path.join(managedRoot, "session-"));
  fs.chmodSync(managedHome, 0o700);
  try {
    copyCodexCredentials(sourceHome, managedHome);
    fs.writeFileSync(
      path.join(managedHome, "config.toml"),
      [
        "# Koed managed conversations use an isolated Codex home.",
        "# Provider credentials are copied in, but user hooks and MCP servers are not."
      ].join("\n"),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(managedHome, MANAGED_HOME_MARKER_FILENAME),
      JSON.stringify({ version: 1, kind: "koed-managed-codex-home" }),
      { mode: 0o600 }
    );
    return managedHome;
  } catch (error) {
    fs.rmSync(managedHome, { recursive: true, force: true });
    throw error;
  }
};

export const reuseManagedCodexHome = (
  managedHome: string,
  env: NodeJS.ProcessEnv = process.env
): string => {
  const resolved = validatedManagedCodexHome(managedHome, env);
  const configPath = path.join(resolved, "config.toml");
  fs.chmodSync(resolved, 0o700);
  fs.chmodSync(configPath, 0o600);
  copyCodexCredentials(sourceCodexHome(env), resolved);
  return resolved;
};

export const destroyManagedCodexHome = (
  managedHome: string,
  env: NodeJS.ProcessEnv = process.env
): void => {
  const resolved = validatedManagedCodexHome(managedHome, env);
  const lease = acquireManagedCodexHomeLease(resolved, env);
  try {
    fs.rmSync(resolved, {
      recursive: true,
      force: false,
      maxRetries: 3,
      retryDelay: 100
    });
  } catch (error) {
    lease.release();
    throw error;
  }
};

export const removeManagedCodexHome = (
  managedHome: string,
  env: NodeJS.ProcessEnv = process.env
): void => {
  try {
    destroyManagedCodexHome(managedHome, env);
  } catch {
    // The app-server lifecycle error remains the actionable failure.
  }
};

export const koedAppServerMinimalContextConfig = {
  include_permissions_instructions: false,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
  include_environment_context: false,
  project_doc_max_bytes: 0,
  web_search: "disabled",
  tools: {
    experimental_request_user_input: {
      enabled: false
    }
  }
} as const;

export const koedAiClientWorkerDeveloperInstructions = loadPrompt(
  "ai-client-worker-developer"
).body;

const createIsolatedCodexHome = (
  env: NodeJS.ProcessEnv,
  model: string
): string => {
  const sourceHome = sourceCodexHome(env);
  let isolatedHome: string;
  try {
    isolatedHome = fs.mkdtempSync(
      path.join(
        fs.existsSync(sourceHome) ? sourceHome : os.tmpdir(),
        ".koed-app-server-"
      )
    );
  } catch {
    isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), ".koed-app-server-"));
  }
  fs.chmodSync(isolatedHome, 0o700);

  copyCodexCredentials(sourceHome, isolatedHome);

  fs.writeFileSync(
    path.join(isolatedHome, "config.toml"),
    [
      `model = ${JSON.stringify(model)}`,
      "",
      "# Koed worker app-server home is intentionally minimal.",
      "# The user's capture hooks and MCP servers remain configured in their real CODEX_HOME.",
      "include_permissions_instructions = false",
      "include_apps_instructions = false",
      "include_collaboration_mode_instructions = false",
      "include_environment_context = false",
      "project_doc_max_bytes = 0",
      'web_search = "disabled"',
      "",
      "[tools.experimental_request_user_input]",
      "enabled = false",
      "",
      "[skills]",
      "include_instructions = false"
    ].join("\n"),
    { mode: 0o600 }
  );

  return isolatedHome;
};

const removeIsolatedCodexHome = (isolatedHome: string): void => {
  try {
    fs.rmSync(isolatedHome, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100
    });
  } catch {
    // Best-effort cleanup only; do not turn a completed app-server call into a failure.
  }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const threadInfoFromResponse = (
  method: "thread/start" | "thread/resume" | "thread/fork",
  value: unknown
): CodexAppServerThreadInfo => {
  const thread = asRecord(asRecord(value).thread);
  if (typeof thread.id !== "string") {
    throw new Error(`Codex app-server ${method} returned no thread id`);
  }
  return {
    id: thread.id,
    ...(typeof thread.sessionId === "string"
      ? { sessionId: thread.sessionId }
      : {}),
    ...(typeof thread.parentThreadId === "string"
      ? { parentThreadId: thread.parentThreadId }
      : {}),
    ...(typeof thread.forkedFromId === "string"
      ? { forkedFromId: thread.forkedFromId }
      : {}),
    ...(typeof thread.path === "string" ? { path: thread.path } : {}),
    ...(typeof thread.cwd === "string" ? { cwd: thread.cwd } : {}),
    ...(thread.source !== undefined ? { source: thread.source } : {}),
    ...(typeof thread.modelProvider === "string"
      ? { modelProvider: thread.modelProvider }
      : {}),
    ...(typeof thread.cliVersion === "string"
      ? { cliVersion: thread.cliVersion }
      : {}),
    ...(thread.gitInfo !== undefined ? { gitInfo: thread.gitInfo } : {}),
    ...(typeof thread.name === "string" ? { name: thread.name } : {}),
    raw: thread
  };
};

const textFromCompletedItem = (params: unknown): string | null => {
  const item = asRecord(asRecord(params).item);
  return item.type === "agentMessage" && typeof item.text === "string"
    ? item.text
    : null;
};

const tokenUsageFromParams = (
  params: unknown,
  turnId: string | null
): CodexThreadTokenUsage | undefined => {
  const record = asRecord(params);
  if (turnId && record.turnId !== turnId) {
    return undefined;
  }
  const tokenUsage = record.tokenUsage;
  return tokenUsage && typeof tokenUsage === "object"
    ? (tokenUsage as CodexThreadTokenUsage)
    : undefined;
};

const appServerEventThreadId = (
  params: unknown,
  result?: unknown
): string | undefined => {
  const paramsRecord = asRecord(params);
  const resultRecord = asRecord(result);
  const candidates = [
    paramsRecord.threadId,
    asRecord(paramsRecord.thread).id,
    resultRecord.threadId,
    asRecord(resultRecord.thread).id
  ];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string"
  );
};

const isTransientDeltaMethod = (method: string): boolean =>
  /delta$/i.test(method);

export const codexAppServerRawEventByteLength = (
  event: CodexAppServerRawEvent
): number => Buffer.byteLength(JSON.stringify(event), "utf8");

const APP_SERVER_RSS_SAMPLING_INTERVAL_MS = 50;

const processRss = (
  pid: number
): Pick<
  CodexAppServerProcessMetrics,
  "peakRssBytes" | "measurement"
> | null => {
  try {
    const pending = [pid];
    const seen = new Set<number>();
    let rssBytes = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      let status: string;
      let children = "";
      try {
        status = fs.readFileSync(`/proc/${current}/status`, "utf8");
        children = fs
          .readFileSync(`/proc/${current}/task/${current}/children`, "utf8")
          .trim();
      } catch {
        if (current === pid) throw new Error("root process is unavailable");
        continue;
      }
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (match?.[1]) rssBytes += Number(match[1]) * 1024;
      if (children) {
        pending.push(
          ...children
            .split(/\s+/)
            .map(Number)
            .filter((child) => Number.isInteger(child) && child > 0)
        );
      }
    }
    if (rssBytes > 0)
      return {
        peakRssBytes: rssBytes,
        measurement: "proc_status_tree"
      };
  } catch {
    // Non-Linux platforms fall through to their native process query.
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const bytes = Number(stdout.trim());
    return result.status === 0 && Number.isFinite(bytes) && bytes > 0
      ? { peakRssBytes: bytes, measurement: "powershell_working_set" }
      : null;
  }
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8"
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const kib = Number(stdout.trim());
  return result.status === 0 && Number.isFinite(kib) && kib > 0
    ? { peakRssBytes: kib * 1024, measurement: "ps_rss" }
    : null;
};

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: JsonRpcMessage) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
      method: string;
      params: unknown;
    }
  >();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly childClosed: Promise<void>;
  private stdoutBuffer = Buffer.alloc(0);
  private readonly stderrChunks: string[] = [];
  private readonly rawEvents: CodexAppServerRawEvent[] = [];
  private readonly rawEventByteLengths: number[] = [];
  private rawEventBytes = 0;
  private readonly pendingRawEvents: Array<{
    event: CodexAppServerRawEvent;
    bytes: number;
  }> = [];
  private pendingRawEventBytes = 0;
  private rawEventHandlerDrain: Promise<void> | null = null;
  private rawEventHandlerError: Error | null = null;
  private terminalError: Error | null = null;
  private nextRawEventSequence = 0;
  private closed = false;
  private closeRequested = false;
  private processMetricsValue: CodexAppServerProcessMetrics | undefined;
  private processMetricsTimer: NodeJS.Timeout | undefined;
  private readonly requestTimeoutMs: number;
  private readonly interruptRequestTimeoutMs: number;
  private readonly serverRequestTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly maxRawEvents: number;
  private readonly maxRawEventBytes: number;
  private readonly maxPendingRawEvents: number;
  private readonly maxPendingRawEventBytes: number;
  private readonly maxTurnStates: number;
  private readonly maxTurnBytes: number;
  private readonly maxLineBytes: number;
  private turnStateBytes = 0;
  private primaryThreadId: string | null = null;
  private activeTurnKey: string | null = null;
  private readonly turnStates = new Map<
    string,
    {
      text: string;
      textBytes: number;
      tokenUsage?: CodexThreadTokenUsage;
      completed: boolean;
      error?: Error;
    }
  >();
  private turnWaiter: {
    threadId: string;
    turnId: string;
    resolve: (value: CodexAppServerRunResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  private currentDynamicToolHandler:
    | CodexAppServerRunConfig["dynamicToolHandler"]
    | undefined;

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly rawEventHandler?: (
      event: CodexAppServerRawEvent
    ) => void | Promise<void>,
    options: CodexAppServerClientOptions = {}
  ) {
    this.requestTimeoutMs = positiveFiniteInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.interruptRequestTimeoutMs = positiveFiniteInteger(
      options.interruptRequestTimeoutMs,
      DEFAULT_INTERRUPT_REQUEST_TIMEOUT_MS
    );
    this.serverRequestTimeoutMs = positiveFiniteInteger(
      options.serverRequestTimeoutMs,
      DEFAULT_SERVER_REQUEST_TIMEOUT_MS
    );
    this.closeGraceMs = positiveFiniteInteger(
      options.closeGraceMs,
      DEFAULT_CLOSE_GRACE_MS
    );
    this.maxRawEvents = positiveFiniteInteger(
      options.maxRawEvents,
      DEFAULT_MAX_RAW_EVENTS
    );
    this.maxRawEventBytes = positiveFiniteInteger(
      options.maxRawEventBytes,
      DEFAULT_MAX_RAW_EVENT_BYTES
    );
    this.maxPendingRawEvents = positiveFiniteInteger(
      options.maxPendingRawEvents,
      this.maxRawEvents
    );
    this.maxPendingRawEventBytes = positiveFiniteInteger(
      options.maxPendingRawEventBytes,
      DEFAULT_MAX_PENDING_RAW_EVENT_BYTES
    );
    this.maxTurnStates = positiveFiniteInteger(
      options.maxTurnStates,
      DEFAULT_MAX_TURN_STATES
    );
    this.maxTurnBytes = positiveFiniteInteger(
      options.maxTurnBytes,
      DEFAULT_MAX_TURN_BYTES
    );
    this.maxLineBytes = positiveFiniteInteger(
      options.maxLineBytes,
      DEFAULT_MAX_LINE_BYTES
    );
    this.child = spawn(binary, ["app-server", "--listen", "stdio://"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true
    });
    if (options.captureProcessMetrics === true) {
      this.sampleProcessRss();
      this.processMetricsTimer = setInterval(
        () => this.sampleProcessRss(),
        APP_SERVER_RSS_SAMPLING_INTERVAL_MS
      );
      this.processMetricsTimer.unref();
    }
    let resolveChildClosed: () => void = () => undefined;
    this.childClosed = new Promise<void>((resolve) => {
      resolveChildClosed = resolve;
    });
    this.child.stdout.on("data", (chunk: Buffer | string) =>
      this.handleStdoutChunk(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")
      )
    );
    this.child.stdout.once("end", () => this.handleStdoutEnd());
    this.child.stdin.on("error", (error) => {
      this.failAll(error);
      this.close();
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrChunks.push(String(chunk));
      if (this.stderrChunks.length > 20) {
        this.stderrChunks.shift();
      }
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("close", (code, signal) => {
      if (this.processMetricsTimer) {
        clearInterval(this.processMetricsTimer);
        this.processMetricsTimer = undefined;
      }
      this.closed = true;
      if (this.pending.size > 0 || this.turnWaiter) {
        this.failAll(
          new Error(
            `Codex app-server exited before completion (${code ?? signal ?? "unknown"})${this.stderrSummary()}`
          )
        );
      }
      resolveChildClosed();
      try {
        options.onExit?.({
          code,
          signal,
          requestedClose: this.closeRequested,
          ...(this.terminalError ? { terminalError: this.terminalError } : {})
        });
      } catch {
        // Exit observers must not interfere with child-process cleanup.
      }
    });
  }

  async initialize(clientName: string): Promise<Record<string, unknown>> {
    const response = await this.request("initialize", {
      clientInfo: {
        name: clientName,
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized");
    return asRecord(response.result);
  }

  async listModels(
    includeHidden = false,
    cursor?: string | null
  ): Promise<unknown> {
    const response = await this.request("model/list", {
      includeHidden,
      ...(cursor ? { cursor } : {})
    });
    this.recordRawEvent(
      "model/list",
      { includeHidden, ...(cursor ? { cursor } : {}) },
      response.result
    );
    return response.result;
  }

  async startThread(
    config: CodexAppServerRunConfig,
    options: CodexAppServerThreadStartOptions = {}
  ): Promise<CodexAppServerThreadInfo> {
    this.currentDynamicToolHandler = config.dynamicToolHandler;
    const params = {
      model: config.model,
      cwd: config.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: options.ephemeral ?? true,
      experimentalRawEvents: false,
      historyMode:
        options.historyMode ??
        (options.persistExtendedHistory === false ? "paginated" : "legacy"),
      // Keep the default worker wire shape compatible with older Codex builds.
      ...(options.historyMode === undefined &&
      options.persistExtendedHistory === undefined
        ? { persistExtendedHistory: false }
        : {}),
      ...(options.minimalContext === false
        ? {}
        : { config: koedAppServerMinimalContextConfig }),
      baseInstructions: config.baseInstructions,
      developerInstructions: config.developerInstructions ?? "",
      personality: "none",
      threadSource: options.threadSource ?? "memory_consolidation",
      ...(config.dynamicTools && config.dynamicTools.length > 0
        ? { dynamicTools: config.dynamicTools }
        : {})
    };
    const response = await this.request("thread/start", params);
    this.recordRawEvent("thread/start", params, response.result);
    return threadInfoFromResponse("thread/start", response.result);
  }

  async resumeThread(
    threadId: string,
    config: CodexAppServerRunConfig
  ): Promise<CodexAppServerThreadInfo> {
    this.currentDynamicToolHandler = config.dynamicToolHandler;
    const params = {
      threadId,
      model: config.model,
      cwd: config.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: config.baseInstructions,
      developerInstructions: config.developerInstructions ?? "",
      personality: "none"
    };
    const response = await this.request("thread/resume", params);
    this.recordRawEvent("thread/resume", params, response.result);
    return threadInfoFromResponse("thread/resume", response.result);
  }

  async forkThread(
    threadId: string,
    sourcePath: string,
    config: CodexAppServerRunConfig
  ): Promise<CodexAppServerThreadInfo> {
    this.currentDynamicToolHandler = config.dynamicToolHandler;
    const params = {
      threadId,
      path: sourcePath,
      model: config.model,
      cwd: config.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      excludeTurns: true,
      deferGoalContinuation: true,
      config: koedAppServerMinimalContextConfig,
      baseInstructions: config.baseInstructions,
      developerInstructions: config.developerInstructions ?? "",
      threadSource: "user"
    };
    const response = await this.request("thread/fork", params);
    const thread = threadInfoFromResponse("thread/fork", response.result);
    this.recordRawEvent(
      "thread/fork",
      {
        ...params,
        parentThreadId: threadId,
        threadId: thread.id
      },
      response.result
    );
    return thread;
  }

  async startTurn(
    threadId: string,
    prompt: string,
    config: CodexAppServerRunConfig,
    clientUserMessageId?: string
  ): Promise<string> {
    const params = {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      cwd: config.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      model: config.model,
      effort: config.reasoningEffort
    };
    const response = await this.request("turn/start", params);
    const turn = asRecord(asRecord(response.result).turn);
    if (typeof turn.id !== "string") {
      throw new Error("Codex app-server turn/start returned no turn id");
    }
    this.recordRawEvent("turn/start", params, response.result);
    return turn.id;
  }

  waitForTurn(
    threadId: string,
    turnId: string
  ): Promise<CodexAppServerRunResult> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server is closed"));
    }
    if (this.turnWaiter) {
      return Promise.reject(
        new Error("Codex app-server is already waiting for an active turn")
      );
    }
    return new Promise((resolve, reject) => {
      this.turnWaiter = {
        threadId,
        turnId,
        resolve,
        reject
      };
      this.settleTurnIfReady(threadId, turnId);
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request(
      "turn/interrupt",
      { threadId, turnId },
      this.interruptRequestTimeoutMs
    );
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    this.closed = true;
    this.failAll(this.terminalError ?? new Error("Codex app-server is closed"));
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  async closeAndWait(graceMs = this.closeGraceMs): Promise<void> {
    let handlerError: unknown;
    try {
      await this.flushRawEventHandler();
    } catch (error) {
      handlerError = error;
    } finally {
      this.close();
      const closedInGrace = await this.waitForChildClose(graceMs);
      if (
        !closedInGrace &&
        this.child.exitCode === null &&
        this.child.signalCode === null
      ) {
        this.child.kill("SIGKILL");
        await this.waitForChildClose(Math.min(graceMs, 250));
      }
    }
    if (handlerError) {
      throw handlerError;
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  terminalFailure(): Error | null {
    return this.terminalError;
  }

  processMetrics(): CodexAppServerProcessMetrics | undefined {
    return this.processMetricsValue;
  }

  getRawEvents(): CodexAppServerRawEvent[] {
    return [...this.rawEvents];
  }

  rawEventCount(): number {
    return this.nextRawEventSequence;
  }

  rawEventsSince(index: number): CodexAppServerRawEvent[] {
    return this.rawEvents.filter((event) => event.sequence >= index);
  }

  async flushRawEventHandler(): Promise<void> {
    this.throwTerminalError();
    if (this.rawEventHandlerDrain) {
      await this.rawEventHandlerDrain;
    }
    this.throwTerminalError();
    if (this.pendingRawEvents.length > 0) {
      await this.scheduleRawEventHandlerDrain();
    }
    this.throwTerminalError();
    if (this.pendingRawEvents.length > 0) {
      if (!this.rawEventHandlerError) {
        throw new Error("Codex app-server raw event handler did not drain");
      }
      throw this.rawEventHandlerError;
    }
  }

  turnStateCount(): number {
    return this.turnStates.size;
  }

  turnTokenUsage(
    threadId: string,
    turnId: string
  ): CodexThreadTokenUsage | undefined {
    return this.turnStates.get(`${threadId}:${turnId}`)?.tokenUsage;
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<JsonRpcMessage> {
    if (this.terminalError) {
      return Promise.reject(this.terminalError);
    }
    if (this.closed) {
      return Promise.reject(new Error("Codex app-server is closed"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              `Codex app-server ${method} request timed out after ${timeoutMs}ms`
            )
          );
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method, params });
      try {
        this.child.stdin.write(`${payload}\n`, (error) => {
          if (error && this.pending.delete(id)) {
            clearTimeout(timeout);
            reject(error);
            this.close();
          }
        });
      } catch (error) {
        if (this.pending.delete(id)) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
          this.close();
        }
      }
    });
  }

  private sampleProcessRss(): void {
    const pid = this.child.pid;
    if (!pid) return;
    const sample = processRss(pid);
    if (!sample) return;
    if (!this.processMetricsValue) {
      this.processMetricsValue = {
        pid,
        peakRssBytes: sample.peakRssBytes,
        measurement: sample.measurement,
        sampleCount: 1,
        samplingIntervalMs: APP_SERVER_RSS_SAMPLING_INTERVAL_MS
      };
      return;
    }
    this.processMetricsValue.peakRssBytes = Math.max(
      this.processMetricsValue.peakRssBytes,
      sample.peakRssBytes
    );
    this.processMetricsValue.measurement = sample.measurement;
    this.processMetricsValue.sampleCount += 1;
  }

  private notify(method: string, params?: unknown): void {
    if (!this.closed) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  private respond(id: JsonRpcId, result: unknown): void {
    if (!this.closed) {
      this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
    }
  }

  private respondError(id: JsonRpcId, code: number, message: string): void {
    if (!this.closed) {
      this.child.stdin.write(
        `${JSON.stringify({ id, error: { code, message } })}\n`
      );
    }
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (this.terminalError || chunk.length === 0) {
      return;
    }
    const input =
      this.stdoutBuffer.length === 0
        ? chunk
        : Buffer.concat([this.stdoutBuffer, chunk]);
    let start = 0;
    while (true) {
      const newline = input.indexOf(0x0a, start);
      if (newline === -1) {
        break;
      }
      if (newline - start > this.maxLineBytes) {
        this.failTerminal(
          new CodexAppServerCapacityError(
            `Codex app-server stdout line byte capacity exceeded (${this.maxLineBytes} bytes)`
          )
        );
        return;
      }
      const line = input.subarray(start, newline).toString("utf8");
      this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      if (this.terminalError) {
        return;
      }
      start = newline + 1;
    }
    const remainder = input.subarray(start);
    if (remainder.length > this.maxLineBytes) {
      this.failTerminal(
        new CodexAppServerCapacityError(
          `Codex app-server stdout line byte capacity exceeded (${this.maxLineBytes} bytes)`
        )
      );
      return;
    }
    this.stdoutBuffer = Buffer.from(remainder);
  }

  private handleStdoutEnd(): void {
    if (this.terminalError || this.stdoutBuffer.length === 0) {
      this.stdoutBuffer = Buffer.alloc(0);
      return;
    }
    const line = this.stdoutBuffer.toString("utf8");
    this.stdoutBuffer = Buffer.alloc(0);
    this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.failTerminal(
        new Error(
          `Codex app-server emitted malformed JSON on stdout: ${line.slice(0, 200)}`,
          { cause: error }
        )
      );
      return;
    }
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      this.handleServerRequest(message);
      return;
    }

    if (typeof message.id === "number" || typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? "Codex app-server error")
        );
      } else {
        if (
          pending.method === "thread/start" ||
          pending.method === "thread/resume"
        ) {
          const threadId = appServerEventThreadId(undefined, message.result);
          if (threadId) {
            this.primaryThreadId = threadId;
          }
        }
        if (pending.method === "turn/start") {
          const threadId = asRecord(pending.params).threadId;
          const turnId = asRecord(asRecord(message.result).turn).id;
          if (typeof threadId === "string" && typeof turnId === "string") {
            this.activeTurnKey = `${threadId}:${turnId}`;
          }
        }
        pending.resolve(message);
      }
      return;
    }

    if (typeof message.method !== "string") {
      return;
    }

    const eventThreadId = appServerEventThreadId(
      message.params,
      message.result
    );
    this.recordRawEvent(message.method, message.params);
    if (
      this.primaryThreadId &&
      eventThreadId &&
      eventThreadId !== this.primaryThreadId
    ) {
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string" &&
        typeof params.delta === "string"
      ) {
        this.appendTurnText(params.threadId, params.turnId, params.delta);
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string"
      ) {
        const text = textFromCompletedItem(message.params);
        if (text !== null) {
          this.setTurnText(params.threadId, params.turnId, text);
        }
      }
      return;
    }

    if (message.method === "thread/tokenUsage/updated") {
      const params = asRecord(message.params);
      if (
        typeof params.threadId === "string" &&
        typeof params.turnId === "string"
      ) {
        const usage = tokenUsageFromParams(message.params, params.turnId);
        if (usage) {
          this.stateFor(params.threadId, params.turnId).tokenUsage = usage;
        }
      }
      return;
    }

    if (message.method === "error") {
      // Error notifications are diagnostic. turn/completed is the authoritative
      // terminal lifecycle event, including after non-retry error notices.
      return;
    }

    if (message.method === "turn/completed") {
      const params = asRecord(message.params);
      const turn = asRecord(params.turn);
      if (typeof params.threadId !== "string" || typeof turn.id !== "string") {
        return;
      }
      const state = this.stateFor(params.threadId, turn.id);
      if (turn.status === "completed") {
        state.completed = true;
      } else {
        const error = asRecord(turn.error);
        state.error = new Error(
          typeof error.message === "string"
            ? error.message
            : `Codex app-server turn ended with status ${
                typeof turn.status === "string" ? turn.status : "unknown"
              }`
        );
        state.completed = true;
      }
      this.settleTurnIfReady(params.threadId, turn.id);
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (
      (typeof message.id !== "number" && typeof message.id !== "string") ||
      typeof message.method !== "string"
    ) {
      return;
    }
    const requestThreadId = appServerEventThreadId(message.params);
    const recordRequest = !(
      this.primaryThreadId &&
      requestThreadId &&
      requestThreadId !== this.primaryThreadId
    );
    if (message.method !== "item/tool/call") {
      if (recordRequest) {
        this.recordRawEvent(message.method, message.params);
      }
      this.respondError(
        message.id,
        -32601,
        `Unsupported Codex app-server request: ${message.method}`
      );
      return;
    }
    if (recordRequest) {
      this.recordRawEvent(message.method, message.params);
    }
    const params = asRecord(message.params);
    const call: CodexAppServerDynamicToolCall = {
      threadId: typeof params.threadId === "string" ? params.threadId : "",
      turnId: typeof params.turnId === "string" ? params.turnId : "",
      callId: typeof params.callId === "string" ? params.callId : "",
      ...(typeof params.namespace === "string"
        ? { namespace: params.namespace }
        : {}),
      tool: typeof params.tool === "string" ? params.tool : "",
      arguments: params.arguments
    };
    const handler = this.currentDynamicToolHandler;
    if (!handler) {
      this.respond(message.id, {
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              error: "No dynamic tool handler is configured."
            })
          }
        ],
        success: false
      });
      return;
    }
    let handlerTimeout: NodeJS.Timeout | undefined;
    const handlerResult = Promise.race([
      Promise.resolve().then(() => handler(call)),
      new Promise<never>((_resolve, reject) => {
        handlerTimeout = setTimeout(
          () =>
            reject(
              new Error(
                `Codex app-server dynamic tool request timed out after ${this.serverRequestTimeoutMs}ms`
              )
            ),
          this.serverRequestTimeoutMs
        );
      })
    ]);
    void handlerResult
      .then((response) => {
        this.respond(message.id!, {
          contentItems: [{ type: "inputText", text: response.text }],
          success: response.success
        });
        if (recordRequest) {
          this.recordRawEvent("item/tool/call/response", message.params, {
            success: response.success
          });
        }
      })
      .catch((error) => {
        this.respond(message.id!, {
          contentItems: [
            {
              type: "inputText",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
              })
            }
          ],
          success: false
        });
        if (recordRequest) {
          this.recordRawEvent("item/tool/call/response", message.params, {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })
      .finally(() => {
        if (handlerTimeout) {
          clearTimeout(handlerTimeout);
        }
      });
  }

  private stateFor(
    threadId: string,
    turnId: string
  ): {
    text: string;
    textBytes: number;
    tokenUsage?: CodexThreadTokenUsage;
    completed: boolean;
    error?: Error;
  } {
    const key = `${threadId}:${turnId}`;
    const existing = this.turnStates.get(key);
    if (existing) {
      return existing;
    }
    const state = { text: "", textBytes: 0, completed: false };
    this.turnStates.set(key, state);
    this.pruneTurnStates();
    return state;
  }

  private appendTurnText(
    threadId: string,
    turnId: string,
    delta: string
  ): void {
    const state = this.stateFor(threadId, turnId);
    const deltaBytes = Buffer.byteLength(delta, "utf8");
    if (this.turnStateBytes + deltaBytes > this.maxTurnBytes) {
      this.failTerminal(
        new CodexAppServerCapacityError(
          `Codex app-server aggregate turn byte capacity exceeded (${this.maxTurnBytes} bytes)`
        )
      );
      return;
    }
    state.text += delta;
    state.textBytes += deltaBytes;
    this.turnStateBytes += deltaBytes;
  }

  private setTurnText(threadId: string, turnId: string, text: string): void {
    const state = this.stateFor(threadId, turnId);
    const textBytes = Buffer.byteLength(text, "utf8");
    const nextTotal = this.turnStateBytes - state.textBytes + textBytes;
    if (nextTotal > this.maxTurnBytes) {
      this.failTerminal(
        new CodexAppServerCapacityError(
          `Codex app-server aggregate turn byte capacity exceeded (${this.maxTurnBytes} bytes)`
        )
      );
      return;
    }
    state.text = text;
    state.textBytes = textBytes;
    this.turnStateBytes = nextTotal;
  }

  private settleTurnIfReady(threadId: string, turnId: string): void {
    if (
      !this.turnWaiter ||
      this.turnWaiter.threadId !== threadId ||
      this.turnWaiter.turnId !== turnId
    ) {
      return;
    }
    const state = this.stateFor(threadId, turnId);
    if (!state.completed) {
      return;
    }
    const waiter = this.turnWaiter;
    this.turnWaiter = null;
    this.turnStates.delete(`${threadId}:${turnId}`);
    if (this.activeTurnKey === `${threadId}:${turnId}`) {
      this.activeTurnKey = null;
    }
    this.turnStateBytes -= state.textBytes;
    if (state.error) {
      waiter.reject(
        new CodexAppServerTurnError(state.error.message, {
          model: "codex-app-server",
          tokenUsage: state.tokenUsage,
          threadId,
          turnId,
          rawEvents: this.getRawEvents()
        })
      );
    } else if (state.text.trim().length === 0) {
      waiter.reject(
        new CodexAppServerTurnError("Codex app-server produced empty output", {
          model: "codex-app-server",
          tokenUsage: state.tokenUsage,
          threadId,
          turnId,
          rawEvents: this.getRawEvents()
        })
      );
    } else {
      waiter.resolve({
        text: state.text.trim(),
        model: "codex-app-server",
        tokenUsage: state.tokenUsage,
        threadId,
        turnId
      });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.turnWaiter) {
      this.turnWaiter.reject(error);
      this.turnWaiter = null;
    }
    this.activeTurnKey = null;
  }

  private failTerminal(error: Error): void {
    if (this.terminalError) {
      return;
    }
    this.terminalError = error;
    this.rawEventHandlerError = error;
    this.closed = true;
    this.stdoutBuffer = Buffer.alloc(0);
    this.failAll(error);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  private throwTerminalError(): void {
    if (this.terminalError) {
      throw this.terminalError;
    }
  }

  private stderrSummary(): string {
    const stderr = this.stderrChunks.join("").trim();
    return stderr ? `: ${stderr}` : "";
  }

  private recordRawEvent(
    method: string,
    params?: unknown,
    result?: unknown
  ): void {
    const event: CodexAppServerRawEvent = {
      method,
      ...(params !== undefined ? { params } : {}),
      ...(result !== undefined ? { result } : {}),
      observedAt: new Date().toISOString(),
      sequence: this.nextRawEventSequence++
    };
    const bytes = codexAppServerRawEventByteLength(event);
    this.rawEvents.push(event);
    this.rawEventByteLengths.push(bytes);
    this.rawEventBytes += bytes;
    while (
      this.rawEvents.length > this.maxRawEvents ||
      this.rawEventBytes > this.maxRawEventBytes
    ) {
      this.rawEvents.shift();
      this.rawEventBytes -= this.rawEventByteLengths.shift() ?? 0;
    }
    if (
      !this.rawEventHandler ||
      isTransientDeltaMethod(method) ||
      this.terminalError
    ) {
      return;
    }
    if (
      this.pendingRawEvents.length >= this.maxPendingRawEvents ||
      this.pendingRawEventBytes + bytes > this.maxPendingRawEventBytes
    ) {
      this.failTerminal(
        new CodexAppServerCapacityError(
          `Codex app-server durable event capacity exceeded while enqueueing ${method} (${this.maxPendingRawEvents} events / ${this.maxPendingRawEventBytes} bytes)`
        )
      );
      return;
    }
    this.pendingRawEvents.push({ event, bytes });
    this.pendingRawEventBytes += bytes;
    void this.scheduleRawEventHandlerDrain();
  }

  private scheduleRawEventHandlerDrain(): Promise<void> {
    if (!this.rawEventHandler || this.pendingRawEvents.length === 0) {
      return Promise.resolve();
    }
    if (this.rawEventHandlerDrain) {
      return this.rawEventHandlerDrain;
    }
    const drain = (async () => {
      while (this.pendingRawEvents.length > 0) {
        const pending = this.pendingRawEvents[0]!;
        try {
          await this.rawEventHandler!(pending.event);
          this.pendingRawEvents.shift();
          this.pendingRawEventBytes -= pending.bytes;
          this.rawEventHandlerError = null;
          if (this.terminalError) {
            return;
          }
        } catch (error) {
          this.rawEventHandlerError =
            error instanceof Error ? error : new Error(String(error));
          return;
        }
      }
    })();
    this.rawEventHandlerDrain = drain.finally(() => {
      this.rawEventHandlerDrain = null;
      if (
        this.pendingRawEvents.length > 0 &&
        !this.rawEventHandlerError &&
        !this.terminalError
      ) {
        void this.scheduleRawEventHandlerDrain();
      }
    });
    return this.rawEventHandlerDrain;
  }

  private pruneTurnStates(): void {
    while (this.turnStates.size > this.maxTurnStates) {
      const activeKey = this.turnWaiter
        ? `${this.turnWaiter.threadId}:${this.turnWaiter.turnId}`
        : this.activeTurnKey;
      const oldestPrunable = [...this.turnStates.keys()].find(
        (key) => key !== activeKey
      );
      if (!oldestPrunable) {
        return;
      }
      this.turnStateBytes -=
        this.turnStates.get(oldestPrunable)?.textBytes ?? 0;
      this.turnStates.delete(oldestPrunable);
    }
  }

  private async waitForChildClose(timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.childClosed.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

export class CodexAppServerThreadSession {
  private readonly isolatedHome: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly client: CodexAppServerClient;
  private initialized = false;
  private threadId: string | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly config: CodexAppServerRunConfig) {
    this.isolatedHome = createIsolatedCodexHome(config.env, config.model);
    this.env = {
      ...config.env,
      CODEX_HOME: this.isolatedHome
    };
    this.client = new CodexAppServerClient(
      config.appServerBinary,
      config.cwd,
      this.env,
      undefined,
      { captureProcessMetrics: config.captureProcessMetrics }
    );
  }

  get primaryThreadId(): string | undefined {
    return this.threadId ?? undefined;
  }

  async runTurn(
    prompt: string,
    timeoutMs: number
  ): Promise<CodexAppServerRunResult> {
    const operation = this.turnQueue.then(() =>
      this.runTurnSerialized(prompt, timeoutMs)
    );
    this.turnQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async runTurnSerialized(
    prompt: string,
    timeoutMs: number
  ): Promise<CodexAppServerRunResult> {
    if (this.closed) {
      throw new Error("Codex app-server thread session is closed");
    }

    const rawEventStartIndex = this.client.rawEventCount();
    const threadId = await this.ensureThread();
    let turnId: string | null = null;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    const effectiveTimeoutMs = positiveFiniteInteger(timeoutMs, 1);
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        if (turnId) {
          void this.client
            .interruptTurn(threadId, turnId)
            .catch(() => undefined);
        } else {
          this.close();
        }
        reject(
          new Error(`Codex app-server timed out after ${effectiveTimeoutMs}ms`)
        );
      }, effectiveTimeoutMs);
    });

    try {
      turnId = await Promise.race([
        this.client.startTurn(threadId, prompt, this.config),
        timeoutPromise
      ]);
      const result = await Promise.race([
        this.client.waitForTurn(threadId, turnId),
        timeoutPromise
      ]);
      return {
        ...result,
        model: this.modelLabel(),
        threadId,
        turnId,
        primaryThreadId: threadId,
        rawEvents: this.client.rawEventsSince(rawEventStartIndex),
        processMetrics: this.client.processMetrics()
      };
    } catch (error) {
      const rawEvents = this.client.rawEventsSince(rawEventStartIndex);
      if (timedOut) {
        this.close();
        throw new CodexAppServerTurnError(
          `Codex app-server timed out after ${effectiveTimeoutMs}ms`,
          {
            model: this.modelLabel(),
            tokenUsage: turnId
              ? this.client.turnTokenUsage(threadId, turnId)
              : undefined,
            threadId,
            turnId: turnId ?? undefined,
            rawEvents,
            processMetrics: this.client.processMetrics()
          }
        );
      }
      if (!turnId) {
        // The server may have accepted turn/start before its response failed.
        this.close();
      }
      if (error instanceof CodexAppServerTurnError) {
        throw new CodexAppServerTurnError(error.message, {
          model: this.modelLabel(),
          tokenUsage: error.tokenUsage,
          threadId: error.threadId ?? threadId,
          turnId: error.turnId ?? turnId ?? undefined,
          rawEvents,
          processMetrics: this.client.processMetrics()
        });
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.client.close();
    removeIsolatedCodexHome(this.isolatedHome);
  }

  async closeAndWait(): Promise<void> {
    if (!this.closed) this.closed = true;
    try {
      await this.client.closeAndWait();
    } finally {
      removeIsolatedCodexHome(this.isolatedHome);
    }
  }

  processMetrics(): CodexAppServerProcessMetrics | undefined {
    return this.client.processMetrics();
  }

  private async ensureThread(): Promise<string> {
    if (!this.initialized) {
      await this.client.initialize(this.config.clientName);
      this.initialized = true;
    }
    if (!this.threadId) {
      this.threadId = (await this.client.startThread(this.config)).id;
    }
    return this.threadId;
  }

  private modelLabel(): string {
    return `codex-app-server:${this.config.model}:${this.config.reasoningEffort}`;
  }
}

export const runCodexAppServerTurn = async (
  prompt: string,
  config: CodexAppServerRunConfig,
  timeoutMs: number
): Promise<CodexAppServerRunResult> => {
  const session = new CodexAppServerThreadSession(config);

  let result: CodexAppServerRunResult | undefined;
  let failure: unknown;
  try {
    result = await session.runTurn(prompt, timeoutMs);
  } catch (error) {
    failure = error;
  } finally {
    await session.closeAndWait();
  }
  const processMetrics = session.processMetrics();
  if (failure instanceof CodexAppServerTurnError)
    throw new CodexAppServerTurnError(failure.message, {
      model: failure.model,
      tokenUsage: failure.tokenUsage,
      threadId: failure.threadId,
      turnId: failure.turnId,
      rawEvents: failure.rawEvents,
      processMetrics
    });
  if (failure) throw failure;
  return { ...result!, processMetrics };
};

export const runCodexAppServerJsonTask = (
  prompt: string,
  config: CodexAppServerJsonTaskConfig,
  timeoutMs: number
): Promise<CodexAppServerRunResult> =>
  runCodexAppServerTurn(
    prompt,
    {
      appServerBinary: config.appServerBinary,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      cwd: config.cwd,
      env: config.env,
      clientName: config.clientName,
      baseInstructions: config.baseInstructions,
      developerInstructions:
        config.developerInstructions ?? koedAiClientWorkerDeveloperInstructions
    },
    timeoutMs
  );

const normalizeReasoningEfforts = (
  value: unknown
): CodexAppServerReasoningEffortOption[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      const record = asRecord(entry);
      const effort = record.reasoningEffort;
      if (typeof effort !== "string" || effort.trim().length === 0) {
        return null;
      }
      return {
        reasoningEffort: effort,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {})
      };
    })
    .filter(
      (entry): entry is CodexAppServerReasoningEffortOption => entry !== null
    );
};

const normalizeModelList = (payload: unknown): CodexAppServerModelOption[] => {
  const data = asRecord(payload).data;
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => {
      const record = asRecord(entry);
      const id = record.id;
      const model = record.model;
      if (typeof id !== "string" || typeof model !== "string") {
        return null;
      }
      return {
        id,
        model,
        label: model,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
        hidden: record.hidden === true,
        isDefault: record.isDefault === true,
        ...(typeof record.defaultReasoningEffort === "string"
          ? { defaultReasoningEffort: record.defaultReasoningEffort }
          : {}),
        supportedReasoningEfforts: normalizeReasoningEfforts(
          record.supportedReasoningEfforts
        )
      };
    })
    .filter((entry): entry is CodexAppServerModelOption => entry !== null);
};

const nextModelListCursor = (payload: unknown): string | null => {
  const nextCursor = asRecord(payload).nextCursor;
  return typeof nextCursor === "string" && nextCursor.trim().length > 0
    ? nextCursor
    : null;
};

const listModelsWithClient = async (
  client: CodexAppServerClient,
  includeHidden?: boolean
): Promise<CodexAppServerModelOption[]> => {
  const models: CodexAppServerModelOption[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (cursor) {
      seenCursors.add(cursor);
    }
    const payload = await client.listModels(includeHidden, cursor);
    models.push(...normalizeModelList(payload));
    cursor = nextModelListCursor(payload);
  } while (cursor && !seenCursors.has(cursor));
  return models;
};

export const listCodexAppServerModels = async (
  input: {
    appServerBinary: string;
    model: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    includeHidden?: boolean;
    clientName?: string;
  },
  timeoutMs = 5000
): Promise<CodexAppServerModelOption[]> => {
  const isolatedHome = createIsolatedCodexHome(input.env, input.model);
  const env = {
    ...input.env,
    CODEX_HOME: isolatedHome
  };
  const client = new CodexAppServerClient(
    input.appServerBinary,
    input.cwd,
    env
  );
  const timeout = setTimeout(() => client.close(), timeoutMs);
  try {
    await client.initialize(input.clientName ?? "koed-settings-model-list");
    return await listModelsWithClient(client, input.includeHidden);
  } finally {
    clearTimeout(timeout);
    client.close();
    removeIsolatedCodexHome(isolatedHome);
  }
};

export const checkCodexAppServerAvailability = async (
  input: {
    appServerBinary: string;
    model: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    clientName?: string;
  },
  timeoutMs = 5000
): Promise<{ available: boolean; error?: string }> => {
  const isolatedHome = createIsolatedCodexHome(input.env, input.model);
  const env = {
    ...input.env,
    CODEX_HOME: isolatedHome
  };
  const client = new CodexAppServerClient(
    input.appServerBinary,
    input.cwd,
    env
  );
  const timeout = setTimeout(() => client.close(), timeoutMs);
  try {
    await client.initialize(input.clientName ?? "koed-settings-check");
    const models = await listModelsWithClient(client, true);
    if (
      !models.some(
        ({ id, model }) => id === input.model || model === input.model
      )
    ) {
      const lunaGuidance =
        input.model === "gpt-5.6-luna"
          ? " GPT-5.6 Luna requires Codex CLI 0.144.0 or newer."
          : "";
      return {
        available: false,
        error: `Codex app-server does not expose the configured model "${input.model}".${lunaGuidance} Upgrade Codex or select a model reported by model/list.`
      };
    }
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
    client.close();
    removeIsolatedCodexHome(isolatedHome);
  }
};
