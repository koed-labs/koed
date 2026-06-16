import koedMarkUrl from "../../explorer/src/koed/assets/koed-mark.svg";
import "./styles.css";
import {
  componentDefinitions,
  stateLabels,
  statusGroups,
  type StatusComponentKey,
  type StatusGroupId
} from "./status-model.js";
import type {
  ComponentState,
  ComponentStatus,
  KoedServerStatus
} from "./types.js";

const startupStepLabels = {
  status: "Local status",
  start: "Local services",
  setup: "Codex integration",
  health: "Health checks"
} as const;

const startupPhaseLabels = {
  status: "Checking local status",
  start: "Starting services",
  setup: "Configuring integration",
  health: "Verifying system"
} as const;

type StartupStepId = keyof typeof startupStepLabels;
type StartupStepState = "pending" | "running" | "done" | "skipped" | "error";

type StartupActionId =
  | "retry-startup"
  | "refresh-status"
  | "start"
  | "setup_codex"
  | "doctor"
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
  { id: "start", label: startupStepLabels.start },
  { id: "setup", label: startupStepLabels.setup },
  { id: "health", label: startupStepLabels.health }
];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing app root.");
}

let status: KoedServerStatus | null = null;
let busyAction: string | null = null;
let startupVisible = true;
let startupError = "";
let startupPhase: string = startupPhaseLabels.status;
let startupDetail: string =
  "Checking whether the local stack is already ready.";
let startupRunning = false;
let rendered = false;
let sidebarCollapsed = true;
let refreshInFlight: Promise<void> | null = null;
let lastStartupLogEntry = "";
type StartupLogLine = {
  key?: string;
  text: string;
};
const startupLogLines: StartupLogLine[] = [];
const desktopStartLogSeen = new Set<string>();
const startupProbeCounts: Partial<Record<StartupStepId, number>> = {};
const startupProbeLimits: Partial<Record<StartupStepId, number>> = {};
const DEFAULT_PROBE_LIMIT = 12;
const stepStates: Record<StartupStepId, StartupStepState> = {
  status: "pending",
  start: "pending",
  setup: "pending",
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

const timestamp = (): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());

const appendStartupLog = (message: string, key?: string): void => {
  const trimmed = message.trim();
  if (!trimmed) {
    return;
  }

  const text = `${timestamp()}  ${trimmed}`;
  if (key) {
    const existing = startupLogLines.find((line) => line.key === key);
    if (existing) {
      existing.text = text;
      lastStartupLogEntry = trimmed;
      return;
    }
  } else if (trimmed === lastStartupLogEntry) {
    return;
  }

  lastStartupLogEntry = trimmed;
  startupLogLines.push({ key, text });
  while (startupLogLines.length > 80) {
    startupLogLines.shift();
  }
};

const removeStartupLog = (key: string): void => {
  const index = startupLogLines.findIndex((line) => line.key === key);
  if (index >= 0) {
    startupLogLines.splice(index, 1);
  }
};

const startupLogText = (): string =>
  startupLogLines.length > 0
    ? startupLogLines.map((line) => line.text).join("\n")
    : `${timestamp()}  Preparing startup sequence…`;

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
      (parsed.msg === "incoming request" || parsed.msg === "request completed") &&
      (statusCode === undefined || statusCode < 400);
    if (isSuccessfulAccessLog) {
      return null;
    }
    if (parsed.service === "koed-api" && parsed.msg?.startsWith("Server listening")) {
      return `API: ${parsed.msg}`;
    }
    if (parsed.service === "koed-worker" && parsed.msg) {
      return `Worker: ${parsed.msg}`;
    }
    if (parsed.level && parsed.level >= 40) {
      return `api ${parsed.msg ?? "log"}${
        parsed.request?.path ? ` ${parsed.request.method ?? ""} ${parsed.request.path}` : ""
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
      appendStartupLog(formatted);
    }
  }
};

const componentMessage = (component: ComponentStatus): string =>
  component.message ?? component.action ?? "No details.";

const apiIsHealthy = (): boolean => status?.api.state === "healthy";

const explorerCredentialProvisioned = (): boolean =>
  status?.explorer.details?.appCredentialProvisioned === true;

const desktopReady = (): boolean =>
  status?.state === "healthy" &&
  status.explorer.state === "healthy" &&
  explorerCredentialProvisioned();

const commandResultError = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.length > 0 ? error : null;
};

const explorerEmbedUrl = (rawUrl: string): string => {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("koedDesktop", "1");
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

const dockerDependenciesHealthy = (): boolean =>
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
  if (!dockerDependenciesHealthy()) {
    return `status probe ${attempt}: Docker deps db=${statusState(
      status?.database
    )} redis=${statusState(status?.redis)} embeddings=${statusState(
      status?.embeddingService
    )}${reason ? `; blocked by ${reason}` : ""}`;
  }
  if (status?.api.state !== "healthy") {
    return `status probe ${attempt}: Docker deps ok; waiting for local API :3300${
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
  start: {
    liveTitle: "Live: local services",
    liveBody:
      "Runs koed-server start: ensure Docker deps, build apps, then spawn API/worker/Explorer.",
    componentKeys: [
      "api",
      "explorer",
      "database",
      "redis",
      "workerQueues",
      "embeddingService"
    ],
    probeMessage: localServicesProbeMessage,
    actions: () =>
      stepHasExhaustedProbes("start")
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
              title: "Run koed-server start again"
            }
          ])
        : []
  },
  setup: {
    liveTitle: "Live: Codex integration",
    liveBody:
      "Provisioning the local API token, Explorer credential, and Codex capture settings.",
    componentKeys: ["apiToken", "mcpServer", "captureHook", "codex"],
    probeMessage: (attempt, blocker) =>
      `status probe ${attempt}: checking Codex/MCP/capture hook${
        friendlyBlocker(blocker) ? `; blocked by ${friendlyBlocker(blocker)}` : ""
      }`,
    actions: () =>
      stepHasExhaustedProbes("setup")
        ? supportActions([
            {
              id: "keep-waiting",
              label: "Keep waiting",
              title: "Continue checking integration readiness for another batch",
              primary: true
            },
            {
              id: "setup_codex",
              label: "Rerun setup",
              title: "Repeat the integration provisioning step"
            }
          ])
        : []
  },
  health: {
    liveTitle: "Live: health checks",
    liveBody: "Waiting for every required component to report healthy.",
    componentKeys: [
      "api",
      "database",
      "redis",
      "workerQueues",
      "embeddingService",
      "apiToken",
      "mcpServer",
      "captureHook",
      "codex",
      "lcmSummaryService",
      "lastVerification"
    ],
    probeMessage: (attempt, blocker) =>
      `status probe ${attempt}: final readiness check${
        friendlyBlocker(blocker) ? `; blocked by ${friendlyBlocker(blocker)}` : ""
      }`,
    actions: () =>
      supportActions([
        {
          id: "doctor",
          label: "Diagnostics",
          title: "Print the current health check details",
          primary: true
        }
      ])
  }
};

const componentsForStep = (step: StartupStepId): ComponentStatus[] =>
  startupLiveConfig[step].componentKeys
    .map((key) => status?.[key] as ComponentStatus | undefined)
    .filter((component): component is ComponentStatus => Boolean(component));

const startupStepReady = (step: StartupStepId): boolean => {
  if (step === "status") {
    return Boolean(status);
  }
  if (step === "health") {
    return desktopReady();
  }
  const config = startupLiveConfig[step];
  const components = componentsForStep(step);
  const componentsReady =
    components.length === config.componentKeys.length &&
    components.every((component) => component.state === "healthy");
  return step === "setup"
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
  if (step === "setup" && !explorerCredentialProvisioned()) {
    return "Explorer credential has not been provisioned for Desktop.";
  }
  return `${startupStepLabels[step]} did not become ready.`;
};

const assertStartupStepReady = (step: StartupStepId): void => {
  if (!startupStepReady(step)) {
    throw new Error(startupStepBlocker(step));
  }
};

const getStartupSupport = (): StartupSupport | null => {
  if (!startupVisible) {
    return null;
  }

  const activeStep = currentStartupStep();
  if (!activeStep) {
    return null;
  }

  if (startupError) {
    return {
      title: `${startupStepLabels[activeStep]} needs attention`,
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

  const liveConfig = startupLiveConfig[activeStep];
  const blocker = primaryBlocker(describeBlockingComponents(componentsForStep(activeStep)));
  return {
    title: liveConfig.liveTitle,
    body: blocker ?? liveConfig.liveBody,
    actions: liveConfig.actions()
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

const groupState = (groupId: StatusGroupId): ComponentState => {
  const group = statusGroups.find((entry) => entry.id === groupId);
  if (!group) {
    return "starting";
  }
  const states = group.componentKeys.map(
    (key) => statusComponent(key)?.state ?? "starting"
  );
  return aggregateGroupState(states);
};

const groupStatusSummary = (
  componentKeys: readonly StatusComponentKey[]
): string => {
  if (!status) {
    return `${componentKeys.length} ${componentKeys.length === 1 ? "check" : "checks"}`;
  }

  const components = componentKeys.map((key) => statusComponent(key));
  const healthyCount = components.filter(
    (component) => component?.state === "healthy"
  ).length;
  const firstUnhealthy = components.find(
    (component) => component && component.state !== "healthy"
  );
  const base = `${healthyCount}/${componentKeys.length} healthy`;
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

  const dockerLikeIssue = [
    status.api.message,
    status.workerQueues.message,
    status.database.message,
    status.redis.message,
    status.embeddingService.message
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (
    status.api.state === "needs_attention" &&
    (dockerLikeIssue.includes("docker") ||
      dockerLikeIssue.includes("compose") ||
      dockerLikeIssue.includes("socket"))
  ) {
    return "Docker looks unavailable. Start Docker Desktop or Colima, then retry startup.";
  }

  if (!apiIsHealthy()) {
    return "This can take a minute when Docker is starting or rebuilding containers.";
  }

  return startupVisible
    ? "Explorer opens automatically after the final check passes."
    : "";
};

const renderShell = () => {
  if (rendered) {
    return;
  }

  app.innerHTML = `
    <section class="desktop-shell">
      <section class="startup-screen" data-startup-panel>
        <div class="startup-card">
          <div class="brand startup-brand">
            <img class="brand-logo" src="${koedMarkUrl}" alt="Koed" />
            <div>
              <h1>Koed Desktop</h1>
            </div>
          </div>
          <div class="startup-status" aria-live="polite">
            <p class="eyebrow">Startup progress</p>
            <h2 data-startup-phase>${escapeHtml(startupPhase)}</h2>
            <small data-startup-detail>${escapeHtml(startupDetail)}</small>
          </div>
          <div class="startup-steps" data-startup-steps>
            ${startupSteps
              .map(
                (step) => `
                  <div class="startup-step pending" data-startup-step="${step.id}">
                    <strong>${escapeHtml(step.label)}</strong>
                    <span data-startup-step-state="${step.id}">${startupStatusLabel(
                      stepStates[step.id]
                    )}</span>
                  </div>
                `
              )
              .join("")}
          </div>
          <p class="hint" data-startup-hint>${escapeHtml(getStartupHint())}</p>
          <section class="startup-help" data-startup-help hidden>
            <p class="startup-help-title" data-startup-help-title>Live output</p>
            <pre class="startup-help-body" data-startup-help-body></pre>
            <div class="startup-help-actions" data-startup-help-actions></div>
          </section>
        </div>
      </section>

      <section class="shell${sidebarCollapsed ? " sidebar-collapsed" : ""}" data-main-shell hidden>
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
            ${statusGroups
              .map((group) => {
                const buttonHtml = group.action
                  ? `<button type="button" data-group-action="${group.id}" ${busyAction ? "disabled" : ""}>${escapeHtml(group.action.label)}</button>`
                  : "";
                return `
                  <details class="status-group" data-status-group="${group.id}">
                    <summary>
                      <div class="status-group-summary">
                        <div class="status-group-title-row">
                          <span class="status-group-disclosure" aria-hidden="true"></span>
                          <strong>${escapeHtml(group.title)}</strong>
                          <span data-group-state="${group.id}">${stateLabels.starting}</span>
                        </div>
                        <p>
                          ${escapeHtml(group.description)}
                          <span class="status-group-count" data-group-summary="${group.id}">${escapeHtml(
                            groupStatusSummary(group.componentKeys)
                          )}</span>
                        </p>
                      </div>
                    </summary>
                    <div class="status-group-body">
                      ${group.componentKeys
                        .map(
                          (key) => `
                            <article class="component starting" data-component-card="${key}">
                              <strong>${escapeHtml(componentDefinitions[key].label)}</strong>
                              <span data-component-state="${key}">${stateLabels.starting}</span>
                              ${group.id === "services" ? "" : `<p data-component-message="${key}">Waiting for first status.</p>`}
                            </article>
                          `
                        )
                        .join("")}
                      ${buttonHtml ? `<div class="status-group-actions">${buttonHtml}</div>` : ""}
                    </div>
                  </details>
                `;
              })
              .join("")}
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
            <div class="empty" data-explorer-empty>
              Explorer will appear after startup completes.
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
    const node = app.querySelector<HTMLElement>(
      `[data-startup-step="${step.id}"]`
    );
    const stateNode = app.querySelector<HTMLElement>(
      `[data-startup-step-state="${step.id}"]`
    );
    if (node) {
      node.className = `startup-step ${stepState}`;
    }
    if (stateNode) {
      stateNode.textContent = startupStatusLabel(stepState);
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
  for (const group of statusGroups) {
    const state = groupState(group.id);
    const details = app.querySelector<HTMLDetailsElement>(
      `[data-status-group="${group.id}"]`
    );
    const stateNode = app.querySelector<HTMLElement>(
      `[data-group-state="${group.id}"]`
    );
    const summaryNode = app.querySelector<HTMLElement>(
      `[data-group-summary="${group.id}"]`
    );
    if (details) {
      details.className = `status-group ${state}`;
    }
    if (stateNode) {
      stateNode.textContent = stateLabels[state];
    }
    if (summaryNode) {
      summaryNode.textContent = groupStatusSummary(group.componentKeys);
    }
  }

  for (const [key] of statusGroups.flatMap((group) =>
    group.componentKeys.map((componentKey) => [componentKey] as const)
  )) {
    const component = statusComponent(key);
    const card = app.querySelector<HTMLElement>(
      `[data-component-card="${key}"]`
    );
    const stateNode = app.querySelector<HTMLElement>(
      `[data-component-state="${key}"]`
    );
    const messageNode = app.querySelector<HTMLElement>(
      `[data-component-message="${key}"]`
    );
    const state = component?.state ?? "starting";
    if (card) {
      card.className = `component ${state}`;
    }
    if (stateNode) {
      stateNode.textContent = stateLabels[state];
    }
    if (messageNode) {
      messageNode.textContent = component
        ? componentMessage(component)
        : "Waiting for first status.";
    }
  }

  if (startupPanel) {
    startupPanel.hidden = !startupVisible;
  }
  if (mainShell) {
    mainShell.hidden = startupVisible;
  }

  if (
    !startupVisible &&
    status?.explorer.url &&
    explorerFrame &&
    explorerEmpty
  ) {
    const nextUrl = explorerEmbedUrl(status.explorer.url);
    if (explorerFrame.dataset.loadedExplorerUrl !== nextUrl) {
      explorerFrame.src = nextUrl;
      explorerFrame.dataset.loadedExplorerUrl = nextUrl;
    }
    explorerFrame.hidden = false;
    explorerEmpty.hidden = true;
  }
};

const syncUI = () => {
  if (!rendered) {
    return;
  }
  syncStartupSteps();
  syncStatusCards();
  syncSidebar();

  const startupHelp = app.querySelector<HTMLElement>("[data-startup-help]");
  const startupHelpTitle = app.querySelector<HTMLElement>(
    "[data-startup-help-title]"
  );
  const startupHelpBody = app.querySelector<HTMLElement>(
    "[data-startup-help-body]"
  );
  const startupHelpActions = app.querySelector<HTMLElement>(
    "[data-startup-help-actions]"
  );
  const support = getStartupSupport();
  if (startupHelp && startupHelpTitle && startupHelpBody && startupHelpActions) {
    startupHelp.hidden = !support;
    if (support) {
      startupHelpTitle.textContent = "Live output";
      startupHelpBody.textContent = startupLogText();
      requestAnimationFrame(() => {
        startupHelpBody.scrollTop = startupHelpBody.scrollHeight;
      });
      startupHelpActions.innerHTML = support.actions
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

  app
    .querySelectorAll<HTMLButtonElement>("[data-group-action]")
    .forEach((button) => {
      button.disabled = Boolean(busyAction);
    });

  app
    .querySelectorAll<HTMLButtonElement>("[data-startup-action]")
    .forEach((button) => {
      button.disabled = Boolean(busyAction);
    });
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
      appendDesktopStartLog(nextStatus);
      syncUI();
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
    removeStartupLog(`probe:${step}`);
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
  startupLogLines.length = 0;
  desktopStartLogSeen.clear();
  lastStartupLogEntry = "";
  for (const step of startupSteps) {
    delete startupProbeCounts[step.id];
    delete startupProbeLimits[step.id];
  }
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
  const blocker = primaryBlocker(describeBlockingComponents(componentsForStep(step)));
  appendStartupLog(
    startupLiveConfig[step].probeMessage(nextProbeAttempt(step), blocker),
    `probe:${step}`
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

const runStartupSequence = async () => {
  if (startupRunning) {
    return;
  }

  startupRunning = true;
  startupVisible = true;
  resetStartupSteps();
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

    if (!startupStepReady("start")) {
      startupDetail =
        "Starting Docker dependencies plus the local API, worker, and Explorer processes.";
      setStartupStep("start", "running");
      appendStartupLog("command: koed-server start");
      appendStartupLog(
        "does: setup env; docker compose up deps; build apps; spawn API/worker/Explorer"
      );
      const startResult = await runWithStartupProbes("start", () =>
        invokeWithTimeout("start", undefined, 180_000)
      );
      const startError = commandResultError(startResult);
      if (startError) {
        throw new Error(`koed-server start failed: ${startError}`);
      }
      await waitForStartupStepReady("start");
      setStartupStep("start", "done");
    } else {
      setStartupStep("start", "skipped");
    }

    if (!startupStepReady("setup")) {
      startupDetail =
        "Provisioning Explorer credentials and Codex capture settings.";
      setStartupStep("setup", "running");
      appendStartupLog("command: koed-server setup codex --json");
      appendStartupLog(
        "does: write local API token, Explorer credential, MCP config, and capture hook settings"
      );
      const setupResult = await runWithStartupProbes("setup", () =>
        invokeWithTimeout("setup_codex", undefined, 300_000)
      );
      const setupError = commandResultError(setupResult);
      if (setupError) {
        throw new Error(`koed-server setup codex failed: ${setupError}`);
      }
      await waitForStartupStepReady("setup");
      setStartupStep("setup", "done");
    } else {
      setStartupStep("setup", "skipped");
    }

    startupDetail = "Waiting for every required component to report healthy.";
    setStartupStep("health", "running");
    appendStartupLog("checking: API, Explorer credential, MCP, capture hook, queues, memory services");
    await waitForDesktopReady();
    startupDetail = "Running one final verification before opening Explorer.";
    appendStartupLog("command: koed-server doctor --json");
    await invokeWithTimeout("doctor", undefined, 90_000);
    setStartupStep("health", "done");
    await refreshStatus();

    if (!desktopReady()) {
      throw new Error(
        "Koed is still not ready for Desktop Explorer. Check Explorer credentials and service health."
      );
    }

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

  app.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    const startupButton = target.closest<HTMLButtonElement>(
      '[data-startup-action]'
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
              `probe budget extended: will keep checking ${startupStepLabels[activeStep]} for ${DEFAULT_PROBE_LIMIT} more tries`
            );
            syncUI();
          }
          return;
        }
      }
    }
  });

  app
    .querySelectorAll<HTMLButtonElement>("[data-group-action]")
    .forEach((buttonEl) => {
      buttonEl.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const groupId = buttonEl.dataset.groupAction as
          | StatusGroupId
          | undefined;
        const group = statusGroups.find((entry) => entry.id === groupId);
        const actionConfig = group?.action;
        if (!actionConfig) {
          return;
        }
        void runAction(actionConfig.label, () =>
          invokeWithTimeout(
            actionConfig.command,
            undefined,
            actionConfig.timeoutMs
          )
        );
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
