import koedMarkUrl from "../../explorer/src/koed/assets/koed-mark.svg";
import "./styles.css";
import {
  stateLabels,
  statusCards,
  type StatusCardAction,
  type StatusCardId,
  type StatusComponentKey
} from "./status-model.js";
import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "./types.js";

const startupStepLabels = {
  status: "Local status",
  runtime: "Runtime assets",
  models: "Embedding model",
  database: "Database init/migrations",
  services: "API, Worker, Explorer",
  integration: "Codex/MCP/Capture Hook",
  health: "Health checks"
} as const;

const startupPhaseLabels = {
  status: "Checking local status",
  runtime: "Verifying runtime assets",
  models: "Verifying embedding model",
  database: "Initializing database",
  services: "Starting local services",
  integration: "Configuring AI Client integration",
  health: "Verifying system"
} as const;

type StartupStepId = keyof typeof startupStepLabels;
type StartupStepState = "pending" | "running" | "done" | "skipped" | "error";

type StartupActionId =
  | "retry-startup"
  | "refresh-status"
  | "start"
  | "setup_codex"
  | "repair_codex"
  | "runtime_install"
  | "models_install"
  | "doctor"
  | "open_logs"
  | "keep-waiting";

type StartupSupportAction = {
  id: StartupActionId;
  label: string;
  title: string;
  primary?: boolean;
  command?: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
};

type StartupSupport = {
  title: string;
  body: string;
  actions: StartupSupportAction[];
};

const startupSteps: Array<{ id: StartupStepId; label: string }> = [
  { id: "status", label: startupStepLabels.status },
  { id: "runtime", label: startupStepLabels.runtime },
  { id: "models", label: startupStepLabels.models },
  { id: "database", label: startupStepLabels.database },
  { id: "services", label: startupStepLabels.services },
  { id: "integration", label: startupStepLabels.integration },
  { id: "health", label: startupStepLabels.health }
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing app root.");
}

let status: KoedServerStatus | null = null;
let busyAction: string | null = null;
let startupVisible = false;
let startupError = "";
let startupPhase: string = startupPhaseLabels.status;
let startupDetail: string =
  "Checking whether the local stack is already ready.";
let startupRunning = false;
let rendered = false;
let sidebarCollapsed = true;
let refreshInFlight: Promise<void> | null = null;
let explorerApiToken: string | null = null;
type StartupLogLine = {
  key?: string;
  text: string;
};
const startupStepLogs: Record<StartupStepId, StartupLogLine[]> = {
  status: [],
  runtime: [],
  models: [],
  database: [],
  services: [],
  integration: [],
  health: []
};
const readinessCheckLogs: Record<StartupStepId, StartupLogLine[]> = {
  status: [],
  runtime: [],
  models: [],
  database: [],
  services: [],
  integration: [],
  health: []
};
const lastStartupLogEntry: Partial<Record<StartupStepId, string>> = {};
const lastReadinessLogEntry: Partial<Record<StartupStepId, string>> = {};
const startupStepExpanded: Partial<Record<StartupStepId, boolean>> = {};
const readinessCheckExpanded: Partial<Record<StartupStepId, boolean>> = {};
const readinessCheckedAt: Partial<Record<StartupStepId, string>> = {};
const statusCardExpanded: Partial<Record<StatusCardId, boolean>> = {};
const statusCardCheckedAt: Partial<Record<StatusCardId, string>> = {};
const statusCardActionLogs = Object.fromEntries(
  statusCards.map((card) => [card.id, [] as StartupLogLine[]])
) as Record<StatusCardId, StartupLogLine[]>;
const lastStatusCardActionLogEntry: Partial<Record<StatusCardId, string>> = {};
let syncingStartupStepOpen = false;
let syncingReadinessCheckOpen = false;
let syncingStatusCardOpen = false;
const desktopStartLogSeen = new Set<string>();
const startupProbeCounts: Partial<Record<StartupStepId, number>> = {};
const startupProbeLimits: Partial<Record<StartupStepId, number>> = {};
const DEFAULT_PROBE_LIMIT = 12;
let runtimeAssetsReady = false;
let modelAssetsReady = false;
let startRequested = false;

const stepStates: Record<StartupStepId, StartupStepState> = {
  status: "pending",
  runtime: "pending",
  models: "pending",
  database: "pending",
  services: "pending",
  integration: "pending",
  health: "pending"
};

const invokeWithTimeout = async <T>(
  command: string,
  args?: Record<string, unknown>,
  timeoutMs = 35_000
): Promise<T> => {
  if (!window.koedDesktop) {
    throw new Error("Koed Desktop bridge unavailable.");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      window.koedDesktop.invoke<T>(command, args),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${command} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const copyText = async (value: string): Promise<void> => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
};

const timestamp = (): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());

const appendReadinessLog = (
  step: StartupStepId,
  message: string,
  key?: string
): void => {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  const lines = readinessCheckLogs[step];
  const text = `${timestamp()}  ${trimmed}`;
  if (key) {
    const existing = lines.find((line) => line.key === key);
    if (existing) {
      existing.text = text;
      lastReadinessLogEntry[step] = trimmed;
      return;
    }
  } else if (trimmed === lastReadinessLogEntry[step]) {
    return;
  }
  lastReadinessLogEntry[step] = trimmed;
  lines.push({ key, text });
  while (lines.length > 80) {
    lines.shift();
  }
};

const appendStatusCardLog = (
  cardId: StatusCardId,
  message: string,
  key?: string
): void => {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }
  const lines = statusCardActionLogs[cardId];
  const text = `${timestamp()}  ${trimmed}`;
  if (key) {
    const existing = lines.find((line) => line.key === key);
    if (existing) {
      existing.text = text;
      lastStatusCardActionLogEntry[cardId] = trimmed;
      return;
    }
  } else if (trimmed === lastStatusCardActionLogEntry[cardId]) {
    return;
  }
  lastStatusCardActionLogEntry[cardId] = trimmed;
  lines.push({ key, text });
  while (lines.length > 24) {
    lines.shift();
  }
};

const appendStartupLog = (
  message: string,
  key?: string,
  step: StartupStepId = currentStartupStep() ?? "status"
): void => {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  const lines = startupStepLogs[step];
  const text = `${timestamp()}  ${trimmed}`;
  if (key) {
    const existing = lines.find((line) => line.key === key);
    if (existing) {
      existing.text = text;
      lastStartupLogEntry[step] = trimmed;
      appendReadinessLog(step, trimmed, key);
      return;
    }
  } else if (trimmed === lastStartupLogEntry[step]) {
    return;
  }

  lastStartupLogEntry[step] = trimmed;
  lines.push({ key, text });
  while (lines.length > 80) {
    lines.shift();
  }
  appendReadinessLog(step, trimmed, key);
};

const removeStartupLog = (key: string, step?: StartupStepId): void => {
  const targets = step ? [step] : startupSteps.map((entry) => entry.id);
  for (const target of targets) {
    const lines = startupStepLogs[target];
    const index = lines.findIndex((line) => line.key === key);
    if (index >= 0) {
      lines.splice(index, 1);
    }
  }
};

const startupLogText = (step: StartupStepId): string => {
  const lines = startupStepLogs[step];
  return lines.length > 0
    ? lines.map((line) => line.text).join("\n")
    : `${timestamp()}  Waiting for ${startupStepLabels[step]}…`;
};

const readinessLogText = (step: StartupStepId): string => {
  const lines = readinessCheckLogs[step];
  return lines.length > 0
    ? lines.map((line) => line.text).join("\n")
    : `${timestamp()}  No output recorded for ${startupStepLabels[step]} yet.`;
};

const checkedAtLabel = (step: StartupStepId): string => {
  const checkedAt = readinessCheckedAt[step] ?? status?.generatedAt;
  if (!checkedAt) {
    return "Not checked yet";
  }
  return `Checked ${new Date(checkedAt).toLocaleTimeString()}`;
};

const formatDesktopStartLogLine = (line: string): string | null => {
  const trimmed = line.trim();
  const isViteAssetLine =
    trimmed.includes("dist/assets/") && trimmed.includes("│ gzip:");
  const isViteChunkWarningDetail =
    trimmed.startsWith("- Using dynamic import()") ||
    trimmed.startsWith("- Use build.rolldownOptions") ||
    trimmed.startsWith("- Adjust chunk size limit") ||
    trimmed.includes("Some chunks are larger than 500 kB") ||
    trimmed.includes("[plugin builtin:vite-reporter]");
  const isDockerBuildNoise = /^#\d+\s/.test(trimmed);
  const isJsonStatusFragment =
    trimmed === "{" ||
    trimmed === "}" ||
    trimmed === "}," ||
    trimmed === "[" ||
    trimmed === "]" ||
    /^"(ok|state|koedHome|apiUrl|explorerUrl|services|postgres|redis|embedding-service|api|worker|explorer|database|details|readyUrl|url)"/.test(
      trimmed
    );

  if (
    isViteAssetLine ||
    isViteChunkWarningDetail ||
    isDockerBuildNoise ||
    isJsonStatusFragment
  ) {
    return null;
  }
  if (trimmed.includes(" build: ✓ built")) {
    return `${trimmed.split(" build:")[0]} build complete`;
  }
  if (trimmed.endsWith(" build: Done")) {
    return `${trimmed.split(" build:")[0]} build done`;
  }
  if (trimmed.startsWith("➜  Local:")) {
    return `Explorer: preview available at ${trimmed.replace("➜  Local:", "").trim()}`;
  }

  try {
    const parsed = JSON.parse(line) as {
      level?: number;
      msg?: string;
      service?: string;
      request?: { method?: string; path?: string };
      response?: { status_code?: number };
      error?: unknown;
    };
    const statusCode = parsed.response?.status_code;
    const isSuccessfulAccessLog =
      parsed.service === "koed-api" &&
      (parsed.msg === "incoming request" ||
        parsed.msg === "request completed") &&
      (statusCode === undefined || statusCode < 400);
    if (isSuccessfulAccessLog) {
      return null;
    }
    if (
      parsed.service === "koed-api" &&
      parsed.msg?.startsWith("Server listening")
    ) {
      return `API: ${parsed.msg}`;
    }
    if (parsed.service === "koed-worker" && parsed.msg) {
      return `Worker: ${parsed.msg}`;
    }
    if (parsed.level && parsed.level >= 40) {
      return `api ${parsed.msg ?? "log"}${
        parsed.request?.path
          ? ` ${parsed.request.method ?? ""} ${parsed.request.path}`
          : ""
      }${statusCode ? ` (${statusCode})` : ""}`;
    }
    return null;
  } catch {
    // Non-JSON startup lines are already human-readable enough.
  }

  if (line.startsWith(">") || line.startsWith("$")) {
    return line;
  }
  return `start output: ${line}`;
};

const appendDesktopStartLog = (nextStatus: KoedServerStatus): void => {
  for (const line of nextStatus.desktopStartLog ?? []) {
    if (desktopStartLogSeen.has(line)) {
      continue;
    }
    desktopStartLogSeen.add(line);
    const formatted = formatDesktopStartLogLine(line);
    if (formatted) {
      appendStartupLog(formatted, undefined, "services");
    }
  }
};

const componentMessage = (component: ComponentStatus): string =>
  component.message ?? component.action ?? "No details.";

const formatCheckTime = (checkedAt?: string): string => {
  if (!checkedAt) {
    return "Not checked yet";
  }
  return `Checked ${new Date(checkedAt).toLocaleTimeString()}`;
};

const componentLabel = (key: StatusComponentKey): string => {
  switch (key) {
    case "api":
      return "API";
    case "explorer":
      return "Explorer";
    case "database":
      return "Postgres";
    case "redis":
      return "Redis";
    case "workerQueues":
      return "Worker/queues";
    case "embeddingService":
      return "Embedding Service";
    case "apiToken":
      return "API Token";
    case "mcpServer":
      return "MCP Server";
    case "captureHook":
      return "Capture Hook";
    case "codex":
      return "Codex";
    case "lcmSummaryService":
      return "LCM Summary Service";
    case "lastVerification":
      return "Last verification";
  }
};

const compactDetail = (value: unknown): string => {
  if (value === null || value === undefined) {
    return "not available";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entryValue]) => entryValue !== null && entryValue !== undefined
      )
      .slice(0, 3)
      .map(([key, entryValue]) => `${key}=${compactDetail(entryValue)}`);
    return entries.length > 0 ? entries.join(" · ") : "available";
  }
  return String(value);
};

const apiIsHealthy = (): boolean => status?.api.state === "healthy";

const explorerCredentialProvisioned = (): boolean =>
  status?.explorer.details?.appCredentialProvisioned === true;

const explorerReady = (): boolean =>
  status?.explorer.state === "healthy" &&
  explorerCredentialProvisioned() &&
  Boolean(explorerApiToken);

const desktopReady = (): boolean =>
  status?.api.state === "healthy" &&
  status?.workerQueues.state === "healthy" &&
  explorerReady();

const commandResultExplicitError = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const payload = value as { error?: unknown };
  return typeof payload.error === "string" ? payload.error : null;
};

const commandResultError = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const payload = value as {
    error?: unknown;
    message?: unknown;
    action?: unknown;
    summary?: unknown;
    ok?: unknown;
  };
  const error = commandResultExplicitError(value);
  if (error) {
    return error;
  }
  if (payload.ok === false) {
    const parts = [payload.message, payload.action, payload.summary].filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0
    );
    return parts.length > 0 ? parts.join(" ") : "Command failed.";
  }
  return null;
};

const commandResultField = (value: unknown, key: string): string | null => {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
};

const commandResultState = (value: unknown): string =>
  commandResultField(value, "state") ?? "unknown";

const commandResultProvider = (value: unknown): string =>
  commandResultField(value, "provider") ?? "unknown";

const runtimeInstallConsentArgs = (
  provider: string,
  reason: string
): Record<string, unknown> | undefined => {
  if (provider !== "homebrew") {
    return undefined;
  }
  const confirmed = window.confirm(
    `${reason}\n\nKoed Desktop will ask koed-server to run Homebrew-backed runtime install. This may run \`brew install postgresql@17 pgvector llama.cpp\` and link selected binaries under KOED_HOME. Continue?`
  );
  if (!confirmed) {
    throw new Error(
      "Runtime install cancelled by Operator before Homebrew package-manager mutation."
    );
  }
  return { operatorConsented: true };
};

const explorerEmbedUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("koedDesktop", "1");
    if (status?.api.url) {
      url.searchParams.set("koedApiBaseUrl", status.api.url);
    }
    if (explorerApiToken) {
      url.searchParams.set("koedApiToken", explorerApiToken);
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
};

const currentStartupStep = (): StartupStepId | null =>
  startupSteps.find((step) => stepStates[step.id] === "running")?.id ??
  startupSteps.find((step) => stepStates[step.id] === "error")?.id ??
  null;

const describeBlockingComponents = (
  components: Array<ComponentStatus | undefined>
): string[] =>
  components
    .filter(
      (component): component is ComponentStatus =>
        Boolean(component) && (component as ComponentStatus).state !== "healthy"
    )
    .map((component) => componentMessage(component as ComponentStatus));

const primaryBlocker = (items: string[]): string | null => items[0] ?? null;

const probeLimitForStep = (step: StartupStepId): number =>
  startupProbeLimits[step] ?? DEFAULT_PROBE_LIMIT;

const probeCountForStep = (step: StartupStepId): number =>
  startupProbeCounts[step] ?? 0;

const stepHasExhaustedProbes = (step: StartupStepId): boolean =>
  probeCountForStep(step) >= probeLimitForStep(step);

const nextProbeAttempt = (step: StartupStepId): string => {
  const limit = probeLimitForStep(step);
  const nextCount = Math.min(probeCountForStep(step) + 1, limit);
  startupProbeCounts[step] = nextCount;
  return `${nextCount}/${limit}`;
};

const extendProbeLimit = (step: StartupStepId): void => {
  startupProbeLimits[step] = probeLimitForStep(step) + DEFAULT_PROBE_LIMIT;
};

const supportActions = (
  actions: StartupSupportAction[]
): StartupSupportAction[] => actions.slice(0, 2);

type StartupLiveConfig = {
  liveTitle: string;
  liveBody: string;
  componentKeys: readonly StatusComponentKey[];
  probeMessage: (attempt: string, blocker: string | null) => string;
  actions: () => StartupSupportAction[];
};

const localDependenciesHealthy = (): boolean =>
  status?.database.state === "healthy" &&
  status.redis.state === "healthy" &&
  status.embeddingService.state === "healthy";

const statusState = (component: ComponentStatus | undefined): string =>
  component?.state === "healthy" ? "ok" : "waiting";

const friendlyBlocker = (message: string | null): string | null => {
  if (!message) {
    return null;
  }
  if (message.includes("localhost:3300") || message.includes("/ready")) {
    return "local API is not reachable on :3300";
  }
  if (message.includes("MCP Server doctor failed")) {
    return "MCP Server cannot reach the local API";
  }
  return message;
};

const localServicesProbeMessage = (
  attempt: string,
  blocker: string | null
): string => {
  const reason = friendlyBlocker(blocker);
  if (!localDependenciesHealthy()) {
    return `status probe ${attempt}: dependencies db=${statusState(
      status?.database
    )} redis=${statusState(status?.redis)} embeddings=${statusState(
      status?.embeddingService
    )}${reason ? `; blocked by ${reason}` : ""}`;
  }
  if (status?.api.state !== "healthy") {
    return `status probe ${attempt}: dependencies ok; waiting for local API :3300${
      reason ? ` (${reason})` : ""
    }`;
  }
  return `status probe ${attempt}: API ok; worker=${statusState(
    status?.workerQueues
  )} explorer=${statusState(status?.explorer)}${
    reason ? `; blocked by ${reason}` : ""
  }`;
};

const startupLiveConfig: Record<StartupStepId, StartupLiveConfig> = {
  status: {
    liveTitle: "Live: local status",
    liveBody: "Checking whether Koed is already running locally.",
    componentKeys: [],
    probeMessage: () => "Local status: checking current readiness",
    actions: () =>
      supportActions([
        {
          id: "refresh-status",
          label: "Refresh",
          title: "Ask koed-server for the latest status",
          primary: true
        }
      ])
  },
  runtime: {
    liveTitle: "Live: runtime assets",
    liveBody:
      "Checking koed-server runtime status before installing bundled-local assets.",
    componentKeys: [],
    probeMessage: () =>
      "runtime assets: waiting for koed-server runtime status",
    actions: () =>
      stepHasExhaustedProbes("runtime")
        ? supportActions([
            {
              id: "runtime_install",
              label: "Install runtime",
              title: "Run koed-server runtime install",
              primary: true
            },
            {
              id: "doctor",
              label: "Diagnostics",
              title: "Run koed-server doctor"
            }
          ])
        : []
  },
  models: {
    liveTitle: "Live: embedding model",
    liveBody:
      "Checking koed-server model status before downloading missing model files.",
    componentKeys: [],
    probeMessage: () =>
      "embedding model: waiting for koed-server models status",
    actions: () =>
      stepHasExhaustedProbes("models")
        ? supportActions([
            {
              id: "models_install",
              label: "Install model",
              title: "Run koed-server models install",
              primary: true
            },
            {
              id: "doctor",
              label: "Diagnostics",
              title: "Run koed-server doctor"
            }
          ])
        : []
  },
  database: {
    liveTitle: "Live: database init/migrations",
    liveBody:
      "Starting koed-server and waiting for Postgres, pgvector, and migrations to become ready.",
    componentKeys: ["database"],
    probeMessage: (attempt, blocker) =>
      `status probe ${attempt}: database=${statusState(status?.database)}${
        friendlyBlocker(blocker)
          ? `; blocked by ${friendlyBlocker(blocker)}`
          : ""
      }`,
    actions: () =>
      stepHasExhaustedProbes("database")
        ? supportActions([
            {
              id: "keep-waiting",
              label: "Keep waiting",
              title: "Continue checking database readiness",
              primary: true
            },
            {
              id: "start",
              label: "Start services",
              title: "Run koed-server start --daemon again"
            }
          ])
        : []
  },
  services: {
    liveTitle: "Live: API, Worker, Explorer",
    liveBody:
      "Runs koed-server start --daemon, then waits for API, Worker, and Explorer readiness from koed-server status.",
    componentKeys: ["api", "workerQueues", "explorer"],
    probeMessage: localServicesProbeMessage,
    actions: () =>
      stepHasExhaustedProbes("services")
        ? supportActions([
            {
              id: "keep-waiting",
              label: "Keep waiting",
              title: "Continue probing services for another batch",
              primary: true
            },
            {
              id: "start",
              label: "Restart services",
              title: "Run koed-server start --daemon again"
            }
          ])
        : []
  },
  integration: {
    liveTitle: "Live: Codex/MCP/Capture Hook",
    liveBody:
      "Provisioning local API Token, Explorer credential, MCP Server, Supported Capture Hook, and Codex settings.",
    componentKeys: ["apiToken", "mcpServer", "captureHook", "codex"],
    probeMessage: (attempt, blocker) =>
      `status probe ${attempt}: checking Codex/MCP/capture hook${
        friendlyBlocker(blocker)
          ? `; blocked by ${friendlyBlocker(blocker)}`
          : ""
      }`,
    actions: () =>
      stepHasExhaustedProbes("integration")
        ? supportActions([
            {
              id: "keep-waiting",
              label: "Keep waiting",
              title:
                "Continue checking integration readiness for another batch",
              primary: true
            },
            {
              id: "repair_codex",
              label: "Fix integration",
              title: "Rewrite Codex/MCP/Capture Hook configuration"
            }
          ])
        : []
  },
  health: {
    liveTitle: "Live: diagnostics",
    liveBody: "Waiting for final Desktop readiness and diagnostics.",
    componentKeys: ["api", "workerQueues", "explorer"],
    probeMessage: (attempt, blocker) =>
      `status probe ${attempt}: final Desktop readiness${
        friendlyBlocker(blocker)
          ? `; blocked by ${friendlyBlocker(blocker)}`
          : ""
      }`,
    actions: () =>
      supportActions([
        {
          id: "doctor",
          label: "Diagnostics",
          title: "Print current health check details",
          primary: true
        },
        {
          id: "open_logs",
          label: "Open logs",
          title: "Open KOED_HOME logs"
        }
      ])
  }
};

type ReadinessCheckDefinition = {
  id: StartupStepId;
  title: string;
  description: string;
  componentKeys: readonly StatusComponentKey[];
  action?: {
    label: string;
    command: string;
    timeoutMs: number;
  };
};

const readinessChecks: readonly ReadinessCheckDefinition[] = [
  {
    id: "status",
    title: "Local status",
    description: "Latest koed-server status snapshot.",
    componentKeys: [],
    action: {
      label: "Refresh status",
      command: "status",
      timeoutMs: 10_000
    }
  },
  {
    id: "runtime",
    title: "Runtime assets",
    description: "koed-server runtime status/install contract.",
    componentKeys: [],
    action: {
      label: "Install runtime",
      command: "runtime_install",
      timeoutMs: 600_000
    }
  },
  {
    id: "models",
    title: "Embedding model",
    description: "koed-server model status/install contract.",
    componentKeys: [],
    action: {
      label: "Install model",
      command: "models_install",
      timeoutMs: 600_000
    }
  },
  {
    id: "database",
    title: "Database init/migrations",
    description:
      "Postgres, pgvector, and migrations reported by koed-server status.",
    componentKeys: startupLiveConfig.database.componentKeys,
    action: {
      label: "Ensure database",
      command: "start",
      timeoutMs: 180_000
    }
  },
  {
    id: "services",
    title: "API, Worker, Explorer",
    description: "Local app processes reported by koed-server status.",
    componentKeys: startupLiveConfig.services.componentKeys,
    action: {
      label: "Ensure services",
      command: "start",
      timeoutMs: 180_000
    }
  },
  {
    id: "integration",
    title: "Codex/MCP/Capture Hook",
    description:
      "API Token, MCP Server, Supported Capture Hook, and Codex settings.",
    componentKeys: startupLiveConfig.integration.componentKeys,
    action: {
      label: "Fix integration",
      command: "repair_codex",
      timeoutMs: 120_000
    }
  },
  {
    id: "health",
    title: "Health checks",
    description: "Final readiness, diagnostics, and memory services.",
    componentKeys: startupLiveConfig.health.componentKeys,
    action: {
      label: "Run diagnostics",
      command: "doctor",
      timeoutMs: 90_000
    }
  }
];

const componentsForStep = (step: StartupStepId): ComponentStatus[] =>
  startupLiveConfig[step].componentKeys
    .map((key) => status?.[key] as ComponentStatus | undefined)
    .filter((component): component is ComponentStatus => Boolean(component));

const startupStepReady = (step: StartupStepId): boolean => {
  if (step === "status") {
    return Boolean(status);
  }
  if (step === "runtime") {
    return status?.dependencyMode !== "bundled-local" || runtimeAssetsReady;
  }
  if (step === "models") {
    return status?.dependencyMode !== "bundled-local" || modelAssetsReady;
  }
  if (step === "health") {
    return desktopReady();
  }
  const config = startupLiveConfig[step];
  const components = componentsForStep(step);
  const componentsReady =
    components.length === config.componentKeys.length &&
    components.every((component) => component.state === "healthy");
  return step === "integration"
    ? componentsReady && explorerCredentialProvisioned()
    : componentsReady;
};

const startupStepBlocker = (step: StartupStepId): string => {
  const blocker = friendlyBlocker(
    primaryBlocker(describeBlockingComponents(componentsForStep(step)))
  );
  if (blocker) {
    return `${startupStepLabels[step]} did not become ready: ${blocker}.`;
  }
  if (step === "runtime") {
    return "Runtime assets have not been installed through koed-server.";
  }
  if (step === "models") {
    return "Embedding model has not been installed through koed-server.";
  }
  if (step === "integration" && !explorerCredentialProvisioned()) {
    return "Explorer credential has not been provisioned for Desktop.";
  }
  return `${startupStepLabels[step]} did not become ready.`;
};

const assertStartupStepReady = (step: StartupStepId): void => {
  if (!startupStepReady(step)) {
    throw new Error(startupStepBlocker(step));
  }
};

const getStartupSupportForStep = (step: StartupStepId): StartupSupport => {
  if (stepStates[step] === "error" && startupError) {
    return {
      title: `${startupStepLabels[step]} needs attention`,
      body: startupError,
      actions: supportActions([
        {
          id: "retry-startup",
          label: "Retry",
          title: "Run the full startup sequence again",
          primary: true
        }
      ])
    };
  }

  const liveConfig = startupLiveConfig[step];
  const blocker = friendlyBlocker(
    primaryBlocker(describeBlockingComponents(componentsForStep(step)))
  );
  return {
    title: liveConfig.liveTitle,
    body: blocker ?? liveConfig.liveBody,
    actions: stepStates[step] === "running" ? liveConfig.actions() : []
  };
};

const startupStatusLabel = (value: StartupStepState): string => {
  switch (value) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "skipped":
      return "Skipped";
    case "error":
      return "Failed";
    default:
      return "Waiting";
  }
};

const aggregateGroupState = (states: ComponentState[]): ComponentState => {
  if (states.some((value) => value === "needs_attention")) {
    return "needs_attention";
  }
  if (states.some((value) => value === "not_configured")) {
    return "not_configured";
  }
  if (states.some((value) => value === "starting")) {
    return "starting";
  }
  return "healthy";
};

const statusComponent = (
  key: StatusComponentKey
): ComponentStatus | undefined => status?.[key] as ComponentStatus | undefined;

const rawStatusCardState = (cardId: StatusCardId): ComponentState => {
  if (!status) {
    return "starting";
  }
  const card = statusCards.find((entry) => entry.id === cardId);
  if (!card) {
    return status.state;
  }
  const states = card.componentKeys.map(
    (key) => statusComponent(key)?.state ?? "starting"
  );
  if (cardId === "controlPlane") {
    if (status.explorer.state !== "healthy") {
      return status.explorer.state;
    }
    if (status.api.state !== "healthy") {
      return status.api.state;
    }
  }
  return aggregateGroupState(states);
};

const statusCardState = (cardId: StatusCardId): ComponentState => {
  const state = rawStatusCardState(cardId);
  const startupInProgress = startupVisible && startupRunning && !startupError;
  if (
    startupInProgress &&
    (state === "needs_attention" || state === "not_configured")
  ) {
    return "starting";
  }
  return state;
};

const statusCardResultCue = (cardId: StatusCardId): string => {
  if (!status) {
    return "Waiting for first status";
  }
  const state = statusCardState(cardId);
  if (state === "healthy") {
    return "Reachable";
  }
  if (state === "starting") {
    return startupVisible && startupRunning && !startupError
      ? "Waiting for startup"
      : "Starting";
  }
  const card = statusCards.find((entry) => entry.id === cardId);
  const firstUnhealthy = card?.componentKeys
    .map((key) => statusComponent(key))
    .find((component) => component && component.state !== "healthy");
  if (firstUnhealthy) {
    return componentMessage(firstUnhealthy);
  }
  return stateLabels[state];
};

const statusCardSummary = (cardId: StatusCardId): string => {
  const checkedAt = statusCardCheckedAt[cardId] ?? status?.generatedAt;
  return `${formatCheckTime(checkedAt)} · ${statusCardResultCue(cardId)}`;
};

const statusCardMeta = (cardId: StatusCardId): string => {
  if (!status) {
    return "Awaiting local control-plane status.";
  }
  if (cardId === "controlPlane") {
    const workerPid = status.workerQueues.details?.workerPid;
    return `KOED_HOME ${status.koedHome} · worker ${workerPid ? `pid ${workerPid}` : "pending"}`;
  }
  if (cardId === "api") {
    return status.api.url;
  }
  if (cardId === "explorer") {
    return `${status.explorer.url} · credential ${
      explorerCredentialProvisioned() ? "provisioned" : "missing"
    }`;
  }
  if (cardId === "aiClientIntegration") {
    return `API Token ${status.apiToken.configured ? "configured" : "missing"} · Codex ${
      status.codex.configured ? "configured" : "missing"
    }`;
  }
  if (cardId === "memoryProcessing") {
    return `Last verification ${status.lastVerification.checkedAt ?? "not recorded"}`;
  }
  const card = statusCards.find((entry) => entry.id === cardId);
  const healthyCount = card?.componentKeys.filter(
    (key) => statusComponent(key)?.state === "healthy"
  ).length;
  return card
    ? `${healthyCount ?? 0}/${card.componentKeys.length} dependencies healthy`
    : "";
};

const statusCardLiveOutput = (cardId: StatusCardId): string => {
  const card = statusCards.find((entry) => entry.id === cardId);
  const checkedAt = statusCardCheckedAt[cardId] ?? status?.generatedAt;
  const lines: string[] = [];
  const time = checkedAt
    ? new Date(checkedAt).toLocaleTimeString()
    : new Date().toLocaleTimeString();
  if (!status || !card) {
    lines.push(`${time}  Waiting for koed-server status --json`);
  } else {
    lines.push(
      `${time}  ${card.title}: ${stateLabels[statusCardState(cardId)]}`
    );
    lines.push(`${time}  Impact: ${card.impact}`);
    if (cardId === "controlPlane") {
      lines.push(`${time}  KOED_HOME: ${status.koedHome}`);
      lines.push(`${time}  API: ${status.api.state} at ${status.api.url}`);
      lines.push(`${time}  Worker/queues: ${status.workerQueues.state}`);
      lines.push(
        `${time}  Explorer: ${status.explorer.state} at ${status.explorer.url}`
      );
    } else {
      for (const key of card.componentKeys) {
        const component = statusComponent(key);
        const message = component
          ? `${componentLabel(key)}: ${stateLabels[component.state]}${
              component.message ? ` — ${component.message}` : ""
            }`
          : `${componentLabel(key)}: waiting`;
        lines.push(`${time}  ${message}`);
        if (component?.action && component.state !== "healthy") {
          lines.push(`${time}  action: ${component.action}`);
        }
        if (component?.details) {
          lines.push(`${time}  details: ${compactDetail(component.details)}`);
        }
      }
    }
  }
  for (const entry of statusCardActionLogs[cardId]) {
    lines.push(entry.text);
  }
  return lines.join("\n");
};

const readinessCheckState = (
  check: ReadinessCheckDefinition
): ComponentState => {
  if (check.id === "status") {
    return status?.state ?? "starting";
  }
  if (check.id === "runtime") {
    return runtimeAssetsReady ? "healthy" : "starting";
  }
  if (check.id === "models") {
    return modelAssetsReady ? "healthy" : "starting";
  }
  const states = check.componentKeys.map(
    (key) => statusComponent(key)?.state ?? "starting"
  );
  const state = aggregateGroupState(states);
  if (
    check.id === "integration" &&
    state === "healthy" &&
    !explorerCredentialProvisioned()
  ) {
    return "needs_attention";
  }
  return state;
};

const readinessCheckSummary = (check: ReadinessCheckDefinition): string => {
  if (!status) {
    return `${checkedAtLabel(check.id)} · Waiting for first status.`;
  }
  if (check.id === "status") {
    return `${checkedAtLabel(check.id)} · Overall ${stateLabels[status.state]}.`;
  }
  const components = check.componentKeys.map((key) => statusComponent(key));
  const healthyCount = components.filter(
    (component) => component?.state === "healthy"
  ).length;
  const firstUnhealthy = components.find(
    (component) => component && component.state !== "healthy"
  );
  if (check.id === "runtime") {
    return `${checkedAtLabel(check.id)} · ${runtimeAssetsReady ? "Runtime assets ready" : "Waiting for runtime assets"}.`;
  }
  if (check.id === "models") {
    return `${checkedAtLabel(check.id)} · ${modelAssetsReady ? "Embedding model ready" : "Waiting for embedding model"}.`;
  }
  if (check.id === "integration" && !explorerCredentialProvisioned()) {
    return `${checkedAtLabel(check.id)} · Explorer credential is not provisioned.`;
  }
  const base = `${checkedAtLabel(check.id)} · ${healthyCount}/${check.componentKeys.length} healthy`;
  return firstUnhealthy
    ? `${base} · ${componentMessage(firstUnhealthy)}`
    : base;
};

const getStartupHint = (): string => {
  if (startupError) {
    return startupError;
  }
  if (!status) {
    return "Waiting for the first status update.";
  }

  if (!apiIsHealthy()) {
    return "This can take a minute while koed-server starts local dependencies and app processes.";
  }

  return startupVisible
    ? "Explorer opens automatically after the final check passes."
    : "";
};

const renderStatusCardActions = (cardId: StatusCardId): string => {
  const card = statusCards.find((entry) => entry.id === cardId);
  if (!card) {
    return "";
  }
  const actions = [card.primaryAction, ...card.secondaryActions];
  return actions
    .map(
      (action, index) => `
        <button
          type="button"
          class="${"primary" in action && action.primary ? "primary" : "secondary"}"
          data-status-card-action="${card.id}"
          data-status-card-action-index="${index}"
          ${busyAction ? "disabled" : ""}
        >${escapeHtml(action.label)}</button>
      `
    )
    .join("");
};

const renderStartupSteps = (): string => `
  <div class="startup-steps">
    ${startupSteps
      .map((step) => {
        const stepState = stepStates[step.id];
        const support = getStartupSupportForStep(step.id);
        return `
          <details class="startup-step ${stepState}" data-startup-step="${step.id}">
            <summary>
              <div class="startup-step-summary">
                <span class="startup-step-disclosure" aria-hidden="true"></span>
                <div class="startup-step-copy">
                  <strong>${escapeHtml(step.label)}</strong>
                  <small data-startup-step-summary="${step.id}">${escapeHtml(support.body)}</small>
                </div>
                <span data-startup-step-state="${step.id}">${startupStatusLabel(stepState)}</span>
              </div>
            </summary>
            <div class="startup-step-body">
              <pre class="startup-step-log" data-startup-step-log="${step.id}">${escapeHtml(startupLogText(step.id))}</pre>
              <div class="status-group-actions" data-startup-step-actions="${step.id}"></div>
            </div>
          </details>
        `;
      })
      .join("")}
  </div>
`;

const renderStatusCards = (variant: "startup" | "sidebar"): string => `
  <div class="dependency-cards ${variant}" data-status-card-list="${variant}">
    ${statusCards
      .map((card) => {
        const state = statusCardState(card.id);
        const liveOutputClass =
          variant === "sidebar" ? "status-card-live-output" : "readiness-log";
        return `
          <details class="status-group dependency-card ${state}" data-status-card="${card.id}">
            <summary>
              <div class="status-group-summary">
                <div class="status-group-title-row">
                  <span class="status-group-disclosure" aria-hidden="true"></span>
                  <strong>${escapeHtml(card.title)}</strong>
                  <span data-status-card-state="${card.id}">${stateLabels[state]}</span>
                </div>
                <p class="status-card-meta" data-status-card-meta="${card.id}">${escapeHtml(
                  statusCardMeta(card.id)
                )}</p>
              </div>
            </summary>
            <div class="status-group-body">
              <p class="status-card-role">${escapeHtml(card.role)}</p>
              <p class="status-card-checkline" data-status-card-summary="${card.id}">${escapeHtml(
                statusCardSummary(card.id)
              )}</p>
              <p class="status-card-impact">${escapeHtml(card.impact)}</p>
              <div class="status-card-live-heading">Live output</div>
              <div class="${liveOutputClass}" data-status-card-log="${card.id}"></div>
              <div class="status-card-live-heading">Actions</div>
              <div class="status-group-actions status-card-actions" data-status-card-actions="${card.id}">
                ${renderStatusCardActions(card.id)}
              </div>
            </div>
          </details>
        `;
      })
      .join("")}
  </div>
`;

const renderShell = () => {
  if (rendered) {
    return;
  }

  app.innerHTML = `
    <section class="desktop-shell">
      <section class="shell${sidebarCollapsed ? " sidebar-collapsed" : ""}" data-main-shell>
        <aside class="sidebar" data-sidebar>
          <div class="sidebar-header">
            <button
              type="button"
              class="brand brand-button"
              data-action="toggle-sidebar"
              aria-label="${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
              aria-expanded="${String(!sidebarCollapsed)}"
              title="${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            >
              <img class="brand-logo" src="${koedMarkUrl}" alt="Koed" />
              <div>
                <h1>Koed Desktop</h1>
              </div>
            </button>
            <span class="status-pill starting" data-status-pill>${stateLabels.starting}</span>
            <span
              class="status-dot starting"
              data-status-dot
              title="Overall health: ${stateLabels.starting}"
              aria-label="Overall health: ${stateLabels.starting}"
            ></span>
          </div>
          <div class="status-groups">
            <section class="sidebar-startup-status" aria-live="polite">
              <p class="eyebrow">Startup progress</p>
              <h2 data-startup-phase>${escapeHtml(startupPhase)}</h2>
              <small data-startup-detail>${escapeHtml(startupDetail)}</small>
              <p class="hint" data-startup-hint>${escapeHtml(getStartupHint())}</p>
            </section>
            ${renderStartupSteps()}
            ${renderStatusCards("sidebar")}
          </div>
          <div class="sidebar-footer">
            <button
              type="button"
              class="sidebar-toggle"
              data-action="toggle-sidebar"
              aria-label="${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
              aria-expanded="${String(!sidebarCollapsed)}"
              title="${sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}"
            >
              <span aria-hidden="true">${sidebarCollapsed ? "›" : "‹"}</span>
            </button>
          </div>
        </aside>
        <section class="explorer">
          <div class="explorer-body">
            <div class="empty explorer-overlay" data-explorer-empty>
              Starting Explorer…
            </div>
            <iframe title="Koed Explorer" data-explorer-frame hidden></iframe>
          </div>
        </section>
      </section>
    </section>
  `;

  rendered = true;
};

const syncSidebar = () => {
  const mainShell = app.querySelector<HTMLElement>("[data-main-shell]");
  const toggleButtons = app.querySelectorAll<HTMLButtonElement>(
    '[data-action="toggle-sidebar"]'
  );
  if (mainShell) {
    mainShell.classList.toggle("sidebar-collapsed", sidebarCollapsed);
  }
  for (const toggleButton of toggleButtons) {
    const label = sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar";
    toggleButton.setAttribute("aria-label", label);
    toggleButton.setAttribute("aria-expanded", String(!sidebarCollapsed));
    toggleButton.title = label;
    const icon = toggleButton.querySelector("span");
    if (icon) {
      icon.textContent = sidebarCollapsed ? "›" : "‹";
    }
  }
};

const syncStartupSteps = () => {
  for (const step of startupSteps) {
    const stepState = stepStates[step.id];
    const support = getStartupSupportForStep(step.id);
    const details = app.querySelector<HTMLDetailsElement>(
      `[data-startup-step="${step.id}"]`
    );
    const stateNode = app.querySelector<HTMLElement>(
      `[data-startup-step-state="${step.id}"]`
    );
    const summaryNode = app.querySelector<HTMLElement>(
      `[data-startup-step-summary="${step.id}"]`
    );
    const logNode = app.querySelector<HTMLElement>(
      `[data-startup-step-log="${step.id}"]`
    );
    const actionsNode = app.querySelector<HTMLElement>(
      `[data-startup-step-actions="${step.id}"]`
    );
    if (details) {
      details.className = `startup-step ${stepState}`;
      const shouldOpen = startupStepExpanded[step.id] === true;
      if (details.open !== shouldOpen) {
        syncingStartupStepOpen = true;
        details.open = shouldOpen;
        queueMicrotask(() => {
          syncingStartupStepOpen = false;
        });
      }
    }
    if (stateNode) {
      stateNode.textContent = startupStatusLabel(stepState);
    }
    if (summaryNode) {
      summaryNode.textContent = support.body;
    }
    if (logNode) {
      logNode.textContent = startupLogText(step.id);
      requestAnimationFrame(() => {
        logNode.scrollTop = logNode.scrollHeight;
      });
    }
    if (actionsNode) {
      actionsNode.innerHTML = support.actions
        .map(
          (action) => `
            <button
              type="button"
              data-startup-action="${action.id}"
              class="${action.primary ? "primary" : "secondary"}"
              title="${escapeHtml(action.title)}"
            >
              ${escapeHtml(action.label)}
            </button>
          `
        )
        .join("");
    }
  }
};

const syncStatusCards = () => {
  const statusPill = app.querySelector<HTMLElement>("[data-status-pill]");
  const statusDot = app.querySelector<HTMLElement>("[data-status-dot]");
  const hintStartup = app.querySelector<HTMLElement>("[data-startup-hint]");
  const startupPhaseNode = app.querySelector<HTMLElement>(
    "[data-startup-phase]"
  );
  const startupDetailNode = app.querySelector<HTMLElement>(
    "[data-startup-detail]"
  );
  const startupPanel = app.querySelector<HTMLElement>("[data-startup-panel]");
  const mainShell = app.querySelector<HTMLElement>("[data-main-shell]");
  const explorerFrame = app.querySelector<HTMLIFrameElement>(
    "[data-explorer-frame]"
  );
  const explorerEmpty = app.querySelector<HTMLElement>("[data-explorer-empty]");

  if (startupPhaseNode) {
    startupPhaseNode.textContent = startupPhase;
  }
  if (startupDetailNode) {
    startupDetailNode.textContent = startupDetail;
  }

  if (statusPill) {
    const state = status?.state ?? "starting";
    statusPill.className = `status-pill ${state}`;
    statusPill.textContent = stateLabels[state];
    statusPill.title = `Overall health: ${stateLabels[state]}`;
  }
  if (statusDot) {
    const state = status?.state ?? "starting";
    const label = `Overall health: ${stateLabels[state]}`;
    statusDot.className = `status-dot ${state}`;
    statusDot.title = label;
    statusDot.setAttribute("aria-label", label);
  }

  if (hintStartup) {
    const hint = getStartupHint();
    hintStartup.textContent = hint;
    hintStartup.hidden = !hint;
  }
  for (const card of statusCards) {
    const state = statusCardState(card.id);
    const detailsNodes = app.querySelectorAll<HTMLDetailsElement>(
      `[data-status-card="${card.id}"]`
    );
    const stateNodes = app.querySelectorAll<HTMLElement>(
      `[data-status-card-state="${card.id}"]`
    );
    const summaryNodes = app.querySelectorAll<HTMLElement>(
      `[data-status-card-summary="${card.id}"]`
    );
    const metaNodes = app.querySelectorAll<HTMLElement>(
      `[data-status-card-meta="${card.id}"]`
    );
    const logNodes = app.querySelectorAll<HTMLElement>(
      `[data-status-card-log="${card.id}"]`
    );
    const actionsNodes = app.querySelectorAll<HTMLElement>(
      `[data-status-card-actions="${card.id}"]`
    );
    for (const details of detailsNodes) {
      details.className = `status-group dependency-card ${state}`;
      const shouldOpen = statusCardExpanded[card.id] === true;
      if (details.open !== shouldOpen) {
        syncingStatusCardOpen = true;
        details.open = shouldOpen;
        queueMicrotask(() => {
          syncingStatusCardOpen = false;
        });
      }
    }
    for (const stateNode of stateNodes) {
      stateNode.textContent = stateLabels[state];
    }
    for (const summaryNode of summaryNodes) {
      summaryNode.textContent = statusCardSummary(card.id);
    }
    for (const metaNode of metaNodes) {
      metaNode.textContent = statusCardMeta(card.id);
    }
    for (const logNode of logNodes) {
      logNode.textContent = statusCardLiveOutput(card.id);
      requestAnimationFrame(() => {
        logNode.scrollTop = logNode.scrollHeight;
      });
    }
    for (const actionsNode of actionsNodes) {
      actionsNode.innerHTML = renderStatusCardActions(card.id);
    }
  }
  for (const check of readinessChecks) {
    const state = readinessCheckState(check);
    const details = app.querySelector<HTMLDetailsElement>(
      `[data-readiness-check="${check.id}"]`
    );
    const stateNode = app.querySelector<HTMLElement>(
      `[data-readiness-state="${check.id}"]`
    );
    const summaryNode = app.querySelector<HTMLElement>(
      `[data-readiness-summary="${check.id}"]`
    );
    const logNode = app.querySelector<HTMLElement>(
      `[data-readiness-log="${check.id}"]`
    );
    if (details) {
      details.className = `status-group ${state}`;
      const shouldOpen = readinessCheckExpanded[check.id] === true;
      if (details.open !== shouldOpen) {
        syncingReadinessCheckOpen = true;
        details.open = shouldOpen;
        queueMicrotask(() => {
          syncingReadinessCheckOpen = false;
        });
      }
    }
    if (stateNode) {
      stateNode.textContent = stateLabels[state];
    }
    if (summaryNode) {
      summaryNode.textContent = readinessCheckSummary(check);
    }
    if (logNode) {
      logNode.textContent = readinessLogText(check.id);
      requestAnimationFrame(() => {
        logNode.scrollTop = logNode.scrollHeight;
      });
    }
  }

  if (startupPanel) {
    startupPanel.hidden = true;
  }
  if (mainShell) {
    mainShell.hidden = false;
  }

  if (explorerFrame && explorerEmpty) {
    const ready = explorerReady();
    const loadedUrl = explorerFrame.dataset.loadedExplorerUrl;
    explorerFrame.classList.toggle("explorer-blurred", !ready);

    if (ready && status?.explorer.url) {
      const nextUrl = explorerEmbedUrl(status.explorer.url);
      if (loadedUrl !== nextUrl) {
        explorerFrame.src = nextUrl;
        explorerFrame.dataset.loadedExplorerUrl = nextUrl;
      }
      explorerFrame.hidden = false;
      explorerEmpty.hidden = true;
      explorerEmpty.textContent = "";
    } else {
      explorerFrame.hidden = !loadedUrl;
      explorerEmpty.hidden = false;
      explorerEmpty.textContent =
        status?.explorer.message || "Waiting for Explorer to become healthy…";
    }
  }
};

const syncUI = () => {
  if (!rendered) {
    return;
  }
  syncStartupSteps();
  syncStatusCards();
  syncSidebar();

  app
    .querySelectorAll<HTMLButtonElement>("[data-readiness-action]")
    .forEach((button) => {
      button.disabled = Boolean(busyAction);
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-startup-action]")
    .forEach((button) => {
      button.disabled = Boolean(busyAction);
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-status-card-action]")
    .forEach((button) => {
      button.disabled = Boolean(busyAction);
    });
};

const refreshExplorerCredential = async (): Promise<void> => {
  if (!explorerCredentialProvisioned() && status?.api.state !== "healthy") {
    explorerApiToken = null;
    return;
  }
  const result = await invokeWithTimeout<
    { ok: true; apiToken: string } | { ok: false; error: string }
  >("explorer_credential", undefined, 130_000);
  if (result.ok) {
    explorerApiToken = result.apiToken;
  } else if (!explorerCredentialProvisioned()) {
    explorerApiToken = null;
  }
};

const refreshStatus = async () => {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = invokeWithTimeout<KoedServerStatus>(
    "status",
    undefined,
    10_000
  )
    .then((nextStatus) => {
      status = nextStatus;
      for (const check of readinessChecks) {
        readinessCheckedAt[check.id] = nextStatus.generatedAt;
      }
      for (const card of statusCards) {
        statusCardCheckedAt[card.id] = nextStatus.generatedAt;
      }
      appendReadinessLog(
        "status",
        `status result: overall ${stateLabels[nextStatus.state]}`,
        "latest-status"
      );
      appendDesktopStartLog(nextStatus);
      return refreshExplorerCredential()
        .catch(() => undefined)
        .then(() => {
          syncUI();
        });
    })
    .catch((error) => {
      startupError = error instanceof Error ? error.message : String(error);
      syncUI();
      throw error;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
};

const setStartupStep = (step: StartupStepId, state: StartupStepState) => {
  stepStates[step] = state;
  startupPhase = startupPhaseLabels[step];
  if (state === "running") {
    startupProbeCounts[step] = 0;
    startupProbeLimits[step] = DEFAULT_PROBE_LIMIT;
    appendStartupLog(`${startupStepLabels[step]}: ${startupDetail}`);
  } else if (state === "done" || state === "skipped" || state === "error") {
    removeStartupLog(`probe:${step}`, step);
    appendStartupLog(
      state === "error" && startupError
        ? `${startupStepLabels[step]}: Failed — ${startupError}`
        : `${startupStepLabels[step]}: ${startupStatusLabel(state)}`
    );
  }
  syncUI();
};

const resetStartupSteps = () => {
  for (const step of startupSteps) {
    stepStates[step.id] = "pending";
  }
  for (const step of startupSteps) {
    startupStepLogs[step.id].length = 0;
    readinessCheckLogs[step.id].length = 0;
    delete lastStartupLogEntry[step.id];
    delete lastReadinessLogEntry[step.id];
    delete startupStepExpanded[step.id];
    delete readinessCheckExpanded[step.id];
    delete readinessCheckedAt[step.id];
    delete startupProbeCounts[step.id];
    delete startupProbeLimits[step.id];
  }
  for (const card of statusCards) {
    statusCardActionLogs[card.id].length = 0;
    delete lastStatusCardActionLogEntry[card.id];
    delete statusCardCheckedAt[card.id];
  }
  desktopStartLogSeen.clear();
  runtimeAssetsReady = false;
  modelAssetsReady = false;
  startRequested = false;
  startupError = "";
  startupPhase = startupPhaseLabels.status;
  startupDetail = "Checking whether the local stack is already ready.";
  appendStartupLog(startupDetail);
  syncUI();
};

const waitForDesktopReady = async (timeoutMs = 600_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await refreshStatus();
    if (desktopReady()) {
      return;
    }
    appendStartupProbe("health");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  throw new Error(`Koed did not reach a healthy state within ${timeoutMs}ms.`);
};

const waitForStartupStepReady = async (
  step: StartupStepId,
  timeoutMs = 90_000
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await refreshStatus();
    if (startupStepReady(step)) {
      return;
    }
    appendStartupProbe(step);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  assertStartupStepReady(step);
};

const appendStartupProbe = (step: StartupStepId): void => {
  const blocker = primaryBlocker(
    describeBlockingComponents(componentsForStep(step))
  );
  appendStartupLog(
    startupLiveConfig[step].probeMessage(nextProbeAttempt(step), blocker),
    `probe:${step}`,
    step
  );
};

const runWithStartupProbes = async <T>(
  step: StartupStepId,
  action: () => Promise<T>
): Promise<T> => {
  let probeInFlight = false;
  let probing = true;
  const probe = () => {
    if (!probing || probeInFlight || stepStates[step] !== "running") {
      return;
    }
    probeInFlight = true;
    void invokeWithTimeout<KoedServerStatus>("status", undefined, 10_000)
      .then((nextStatus) => {
        if (!probing || stepStates[step] !== "running") {
          return;
        }
        status = nextStatus;
        appendDesktopStartLog(nextStatus);
        appendStartupProbe(step);
        syncUI();
      })
      .catch((error) => {
        if (!probing || stepStates[step] !== "running") {
          return;
        }
        appendStartupLog(
          `${startupStepLabels[step]}: status probe failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
          `probe:${step}`
        );
        syncUI();
      })
      .finally(() => {
        probeInFlight = false;
      });
  };

  probe();
  const probeTimer = window.setInterval(probe, 5_000);
  try {
    return await action();
  } finally {
    probing = false;
    window.clearInterval(probeTimer);
  }
};

const ensureDaemonStartRequested = async (
  step: StartupStepId
): Promise<void> => {
  if (startRequested) {
    appendStartupLog(
      "koed-server start --daemon already requested",
      undefined,
      step
    );
    return;
  }
  appendStartupLog(
    "command: koed-server start --daemon --json",
    undefined,
    step
  );
  const startResult = await runWithStartupProbes(step, () =>
    invokeWithTimeout("start_daemon", undefined, 60_000)
  );
  const startError = commandResultError(startResult);
  if (startError) {
    throw new Error(`koed-server start --daemon failed: ${startError}`);
  }
  startRequested = true;
};

const runStartupSequence = async () => {
  if (startupRunning) {
    return;
  }

  startupRunning = true;
  startupVisible = true;
  resetStartupSteps();
  startupVisible = true;
  syncUI();

  try {
    startupDetail =
      "Reading current Koed status before deciding what to start.";
    setStartupStep("status", "running");
    appendStartupLog("command: koed-server status --json");
    await refreshStatus();
    setStartupStep("status", "done");

    if (!status) {
      throw new Error("Unable to load Koed status.");
    }

    if (status.dependencyMode === "bundled-local") {
      startupDetail =
        "Checking native runtime assets through koed-server runtime status.";
      setStartupStep("runtime", "running");
      appendStartupLog(
        "command: koed-server runtime status --json",
        undefined,
        "runtime"
      );
      const runtimeStatus = await invokeWithTimeout(
        "runtime_status",
        undefined,
        60_000
      );
      const runtimeStatusError = commandResultExplicitError(runtimeStatus);
      if (runtimeStatusError) {
        throw new Error(
          `koed-server runtime status failed: ${runtimeStatusError}`
        );
      }
      const runtimeState = commandResultState(runtimeStatus);
      const runtimeProvider = commandResultProvider(runtimeStatus);
      appendStartupLog(
        `runtime status: provider=${runtimeProvider} state=${runtimeState}`,
        undefined,
        "runtime"
      );
      if (runtimeState !== "installed") {
        const consentArgs = runtimeInstallConsentArgs(
          runtimeProvider,
          "Koed needs native runtime assets before local personal startup can continue."
        );
        appendStartupLog(
          "command: koed-server runtime install --dependency-mode bundled-local --json",
          undefined,
          "runtime"
        );
        const installResult = await runWithStartupProbes("runtime", () =>
          invokeWithTimeout("runtime_install", consentArgs, 600_000)
        );
        const installError = commandResultError(installResult);
        if (installError) {
          throw new Error(
            `koed-server runtime install failed: ${installError}`
          );
        }
        appendStartupLog("runtime install completed", undefined, "runtime");
      } else {
        appendStartupLog(
          "runtime install skipped; runtime assets already verified.",
          undefined,
          "runtime"
        );
      }
      runtimeAssetsReady = true;
      setStartupStep("runtime", "done");

      startupDetail =
        "Checking embedding model files through koed-server models status.";
      setStartupStep("models", "running");
      appendStartupLog(
        "command: koed-server models status --kind embedding --json",
        undefined,
        "models"
      );
      const modelStatus = await invokeWithTimeout(
        "models_status",
        undefined,
        60_000
      );
      const modelStatusError = commandResultExplicitError(modelStatus);
      if (modelStatusError) {
        throw new Error(
          `koed-server models status failed: ${modelStatusError}`
        );
      }
      const modelState = commandResultState(modelStatus);
      appendStartupLog(`model status: ${modelState}`, undefined, "models");
      if (
        modelState === "missing" ||
        modelState === "checksum_mismatch" ||
        modelState === "not_configured"
      ) {
        appendStartupLog(
          "command: koed-server models install --kind embedding --json",
          undefined,
          "models"
        );
        const installResult = await runWithStartupProbes("models", () =>
          invokeWithTimeout("models_install", undefined, 600_000)
        );
        const installError = commandResultError(installResult);
        if (installError) {
          throw new Error(`koed-server models install failed: ${installError}`);
        }
        appendStartupLog("model install completed", undefined, "models");
      } else {
        appendStartupLog(
          "model install skipped; embedding model already verified.",
          undefined,
          "models"
        );
      }
      modelAssetsReady = true;
      setStartupStep("models", "done");
    } else {
      runtimeAssetsReady = true;
      modelAssetsReady = true;
      setStartupStep("runtime", "skipped");
      appendStartupLog(
        "external dependency mode: koed-server owns diagnostics, Desktop does not install runtime assets",
        undefined,
        "runtime"
      );
      setStartupStep("models", "skipped");
      appendStartupLog(
        "external dependency mode: embedding model install skipped",
        undefined,
        "models"
      );
    }

    if (!startupStepReady("database")) {
      startupDetail =
        "Starting koed-server and waiting for database init, migrations, and pgvector readiness.";
      setStartupStep("database", "running");
      await ensureDaemonStartRequested("database");
      await waitForStartupStepReady("database", 240_000);
      setStartupStep("database", "done");
    } else {
      setStartupStep("database", "skipped");
    }

    if (!startupStepReady("services")) {
      startupDetail =
        "Waiting for API, Worker, and Explorer processes reported by koed-server status.";
      setStartupStep("services", "running");
      await ensureDaemonStartRequested("services");
      await waitForStartupStepReady("services", 240_000);
      setStartupStep("services", "done");
    } else {
      setStartupStep("services", "skipped");
    }

    if (!startupStepReady("integration")) {
      startupDetail =
        "Configuring Codex, MCP Server, Supported Capture Hook, and Explorer credentials.";
      setStartupStep("integration", "running");
      appendStartupLog(
        "command: koed-server repair codex --json",
        undefined,
        "integration"
      );
      const setupResult = await runWithStartupProbes("integration", () =>
        invokeWithTimeout("repair_codex", undefined, 120_000)
      );
      const setupError = commandResultError(setupResult);
      if (setupError) {
        throw new Error(`koed-server repair codex failed: ${setupError}`);
      }
      await waitForStartupStepReady("integration");
      setStartupStep("integration", "done");
    } else {
      setStartupStep("integration", "skipped");
    }

    startupDetail =
      "Running final status and diagnostics gates before opening Explorer.";
    setStartupStep("health", "running");
    appendStartupLog(
      "checking: API, Worker/queues, Explorer, and integration readiness",
      undefined,
      "health"
    );
    await waitForDesktopReady();
    setStartupStep("health", "done");
    await refreshStatus();

    startupVisible = false;
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    const activeStep = startupSteps.find(
      (step) => stepStates[step.id] === "running"
    )?.id;
    if (activeStep) {
      setStartupStep(activeStep, "error");
    }
  } finally {
    startupRunning = false;
    syncUI();
  }
};

const runAction = async (label: string, action: () => Promise<unknown>) => {
  busyAction = label;
  syncUI();
  try {
    await action();
    await refreshStatus();
  } catch (error) {
    startupError = error instanceof Error ? error.message : String(error);
    syncUI();
  } finally {
    busyAction = null;
    syncUI();
  }
};

const runReadinessAction = async (
  check: ReadinessCheckDefinition,
  action: NonNullable<ReadinessCheckDefinition["action"]>
): Promise<void> => {
  busyAction = action.label;
  readinessCheckedAt[check.id] = new Date().toISOString();
  appendReadinessLog(check.id, `command: ${action.command}`);
  syncUI();
  try {
    const args =
      action.command === "runtime_install"
        ? runtimeInstallConsentArgs(
            commandResultProvider(
              await invokeWithTimeout("runtime_status", undefined, 60_000)
            ),
            "Install Koed native runtime assets?"
          )
        : undefined;
    const result = await invokeWithTimeout(
      action.command,
      args,
      action.timeoutMs
    );
    const error = commandResultError(result);
    if (error) {
      appendReadinessLog(check.id, `failed: ${error}`);
    } else {
      appendReadinessLog(check.id, "command completed");
    }
    await refreshStatus();
  } catch (error) {
    appendReadinessLog(
      check.id,
      `failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    readinessCheckedAt[check.id] = new Date().toISOString();
    busyAction = null;
    syncUI();
  }
};

const runStatusCardAction = async (
  cardId: StatusCardId,
  action: StatusCardAction
): Promise<void> => {
  busyAction = action.label;
  statusCardCheckedAt[cardId] = new Date().toISOString();
  appendStatusCardLog(cardId, `command: ${action.command}`);
  syncUI();
  try {
    if (action.command === "copy_diagnostics") {
      const payload = JSON.stringify(
        {
          card: cardId,
          generatedAt: new Date().toISOString(),
          status
        },
        null,
        2
      );
      await copyText(payload);
      appendStatusCardLog(cardId, "copied diagnostics to clipboard");
    } else if (action.command === "open_explorer") {
      const url = status?.explorer.url;
      if (!url) {
        throw new Error("Explorer URL is not available yet.");
      }
      await invokeWithTimeout(
        "open_external",
        { url },
        action.timeoutMs ?? 10_000
      );
      appendStatusCardLog(cardId, `opened ${url}`);
    } else if (action.command === "status") {
      await refreshStatus();
      appendStatusCardLog(cardId, "status refreshed");
    } else if (action.command === "runtime_install") {
      const runtimeStatus = await invokeWithTimeout(
        "runtime_status",
        undefined,
        60_000
      );
      const consentArgs = runtimeInstallConsentArgs(
        commandResultProvider(runtimeStatus),
        "Install Koed native runtime assets?"
      );
      const result = await invokeWithTimeout(
        "runtime_install",
        consentArgs,
        action.timeoutMs ?? 600_000
      );
      const error = commandResultError(result);
      if (error) {
        appendStatusCardLog(cardId, `failed: ${error}`);
      } else {
        appendStatusCardLog(cardId, "runtime install completed");
      }
      await refreshStatus();
    } else if (action.command === "open_logs") {
      const result = await invokeWithTimeout(
        "open_logs",
        undefined,
        action.timeoutMs ?? 10_000
      );
      const error = commandResultError(result);
      if (error) {
        appendStatusCardLog(cardId, `failed: ${error}`);
      } else {
        appendStatusCardLog(cardId, "opened KOED_HOME logs");
      }
    } else if (action.command === "models_install") {
      const result = await invokeWithTimeout(
        "models_install",
        undefined,
        action.timeoutMs ?? 600_000
      );
      const error = commandResultError(result);
      if (error) {
        appendStatusCardLog(cardId, `failed: ${error}`);
      } else {
        appendStatusCardLog(cardId, "embedding model install completed");
      }
      await refreshStatus();
    } else {
      const result = await invokeWithTimeout(
        action.command,
        undefined,
        action.timeoutMs ?? 90_000
      );
      const error = commandResultError(result);
      if (error) {
        appendStatusCardLog(cardId, `failed: ${error}`);
      } else {
        appendStatusCardLog(cardId, "command completed");
      }
      await refreshStatus();
    }
  } catch (error) {
    appendStatusCardLog(
      cardId,
      `failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    statusCardCheckedAt[cardId] = new Date().toISOString();
    busyAction = null;
    syncUI();
  }
};

const registerHandlers = () => {
  app
    .querySelector<HTMLElement>("[data-sidebar]")
    ?.addEventListener("click", () => {
      if (!sidebarCollapsed) {
        return;
      }
      sidebarCollapsed = false;
      syncUI();
    });

  app
    .querySelectorAll<HTMLButtonElement>('[data-action="toggle-sidebar"]')
    .forEach((button) =>
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        sidebarCollapsed = !sidebarCollapsed;
        syncUI();
      })
    );

  app.addEventListener(
    "toggle",
    (event) => {
      if (syncingStartupStepOpen) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) {
        return;
      }
      const step = target.dataset.startupStep as StartupStepId | undefined;
      if (step) {
        startupStepExpanded[step] = target.open;
        return;
      }
      if (syncingStatusCardOpen) {
        return;
      }
      const card = target.dataset.statusCard as StatusCardId | undefined;
      if (card) {
        statusCardExpanded[card] = target.open;
        return;
      }
      if (syncingReadinessCheckOpen) {
        return;
      }
      const check = target.dataset.readinessCheck as StartupStepId | undefined;
      if (check) {
        readinessCheckExpanded[check] = target.open;
      }
    },
    true
  );

  app.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const statusCardButton = target.closest<HTMLButtonElement>(
      "[data-status-card-action]"
    );
    if (statusCardButton) {
      event.preventDefault();
      event.stopPropagation();
      const cardId = statusCardButton.dataset.statusCardAction as
        | StatusCardId
        | undefined;
      const actionIndex = Number.parseInt(
        statusCardButton.dataset.statusCardActionIndex ?? "0",
        10
      );
      const card = statusCards.find((entry) => entry.id === cardId);
      const action = card
        ? [card.primaryAction, ...card.secondaryActions][actionIndex]
        : undefined;
      if (cardId && action) {
        void runStatusCardAction(cardId, action);
      }
      return;
    }

    const startupButton = target.closest<HTMLButtonElement>(
      "[data-startup-action]"
    );
    if (startupButton) {
      event.preventDefault();
      event.stopPropagation();
      const actionId = startupButton.dataset.startupAction as
        | StartupActionId
        | undefined;
      if (!actionId) {
        return;
      }
      switch (actionId) {
        case "retry-startup":
          void runAction("Retry startup", () => runStartupSequence());
          return;
        case "refresh-status":
          void runAction("Refresh status", () => refreshStatus());
          return;
        case "start":
          void runAction("Restart services", () =>
            invokeWithTimeout("start", undefined, 180_000)
          );
          return;
        case "setup_codex":
          void runAction("Rerun Codex setup", () =>
            invokeWithTimeout("setup_codex", undefined, 300_000)
          );
          return;
        case "runtime_install":
          void runAction("Install runtime", async () => {
            const runtimeStatus = await invokeWithTimeout(
              "runtime_status",
              undefined,
              60_000
            );
            return invokeWithTimeout(
              "runtime_install",
              runtimeInstallConsentArgs(
                commandResultProvider(runtimeStatus),
                "Install Koed native runtime assets?"
              ),
              600_000
            );
          });
          return;
        case "models_install":
          void runAction("Install model", () =>
            invokeWithTimeout("models_install", undefined, 600_000)
          );
          return;
        case "open_logs":
          void runAction("Open logs", () =>
            invokeWithTimeout("open_logs", undefined, 10_000)
          );
          return;
        case "doctor":
          void runAction("Run diagnostics", () =>
            invokeWithTimeout("doctor", undefined, 90_000)
          );
          return;
        case "keep-waiting": {
          const activeStep = currentStartupStep();
          if (activeStep) {
            extendProbeLimit(activeStep);
            appendStartupLog(
              `probe budget extended: will keep checking ${startupStepLabels[activeStep]} for ${DEFAULT_PROBE_LIMIT} more tries`,
              undefined,
              activeStep
            );
            syncUI();
          }
          return;
        }
      }
    }
  });

  app
    .querySelectorAll<HTMLButtonElement>("[data-readiness-action]")
    .forEach((buttonEl) => {
      buttonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const checkId = buttonEl.dataset.readinessAction as
          | StartupStepId
          | undefined;
        const check = readinessChecks.find((entry) => entry.id === checkId);
        const actionConfig = check?.action;
        if (!check || !actionConfig) {
          return;
        }
        void runReadinessAction(check, actionConfig);
      });
    });
};

renderShell();
registerHandlers();
syncUI();

void refreshStatus()
  .catch(() => undefined)
  .finally(() => void runStartupSequence());

setInterval(() => {
  void refreshStatus().catch(() => undefined);
}, 5_000);
