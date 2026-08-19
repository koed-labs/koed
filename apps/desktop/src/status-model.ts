import type { ComponentState, KoedServerStatus } from "./types.js";

export const stateLabels = {
  not_configured: "Not configured",
  starting: "Starting",
  healthy: "Healthy",
  needs_attention: "Needs attention"
} as const satisfies Record<ComponentState, string>;

export const statusComponentKeys = [
  "serverPackage",
  "api",
  "database",
  "redis",
  "workerQueues",
  "embeddingService",
  "localAiRuntime",
  "apiToken",
  "mcpServer",
  "captureHook",
  "codex",
  "claudeCode",
  "pi",
  "lcmSummaryService",
  "upstreamBackends",
  "lastVerification"
] as const satisfies ReadonlyArray<keyof KoedServerStatus>;

export type StatusComponentKey = (typeof statusComponentKeys)[number];

export interface StatusComponentDefinition {
  label: string;
  description: string;
}

export const componentDefinitions = {
  api: {
    label: "API",
    description: "Koed HTTP API used by local integrations and Desktop."
  },
  serverPackage: {
    label: "Server package",
    description:
      "Standalone koed-server app-runtime package installed under KOED_HOME."
  },
  database: {
    label: "Database",
    description: "Postgres storage for users, projects, sessions, and memory."
  },
  redis: {
    label: "Redis",
    description: "Local Redis instance used by queues and service coordination."
  },
  workerQueues: {
    label: "Redis/queues",
    description: "Queue connectivity used by background workers."
  },
  embeddingService: {
    label: "Embedding Service",
    description: "Local service that turns memory text into retrieval vectors."
  },
  localAiRuntime: {
    label: "Local AI Runtime",
    description: "Supervised local process for memory work and LCM summaries."
  },
  apiToken: {
    label: "Local runtime credential",
    description:
      "User-owned API Token retained by the supervised Local AI Runtime."
  },
  mcpServer: {
    label: "MCP Server",
    description: "Local recall integration exposed to the AI Client."
  },
  captureHook: {
    label: "Supported Capture Hook",
    description:
      "TypeScript Capture Hook used for automatic conversation capture."
  },
  codex: {
    label: "Codex configuration",
    description: "Supported AI Client settings for Koed capture and recall."
  },
  claudeCode: {
    label: "Claude Code configuration",
    description:
      "Koed MCP and Supported Capture Hook configuration in Claude Code."
  },
  pi: {
    label: "Pi configuration",
    description:
      "Koed-owned local package registered in the active global Pi profile."
  },
  lcmSummaryService: {
    label: "LCM Summary Service",
    description: "Local background summarization service for memory nodes."
  },
  upstreamBackends: {
    label: "Team Backend",
    description:
      "Registered remote Team Backend used by local-edge routing and Team Workspace recall."
  },
  lastVerification: {
    label: "Last verification",
    description: "Most recent local system verification result."
  }
} as const satisfies Record<StatusComponentKey, StatusComponentDefinition>;

export interface StatusGroupDefinition {
  id: string;
  title: string;
  description: string;
  healthySummary: string;
  componentKeys: readonly StatusComponentKey[];
}

export type StatusCardActionCommand =
  | "status"
  | "start"
  | "package_install"
  | "setup_core"
  | "setup_codex"
  | "check_codex"
  | "repair_codex"
  | "remove_codex"
  | "setup_pi"
  | "check_pi"
  | "repair_pi"
  | "remove_pi"
  | "setup_claude"
  | "check_claude"
  | "repair_claude"
  | "remove_claude"
  | "runtime_install"
  | "models_install"
  | "doctor"
  | "open_logs"
  | "copy_diagnostics"
  | "connect_team_backend"
  | "disconnect_team_backend";

export interface StatusCardAction {
  label: string;
  command: StatusCardActionCommand;
  timeoutMs?: number;
  primary?: boolean;
}

export interface StatusCardDefinition {
  id: string;
  title: string;
  role: string;
  impact: string;
  componentKeys: readonly StatusComponentKey[];
  primaryAction: StatusCardAction;
  secondaryActions: readonly StatusCardAction[];
}

export const statusCards = [
  {
    id: "controlPlane",
    title: "Koed Control Plane",
    role: "Supervises KOED_HOME plus local API and Worker processes.",
    impact:
      "Local startup and process supervision are blocked when this is down.",
    componentKeys: ["api", "workerQueues"],
    primaryAction: {
      label: "Start Koed",
      command: "start",
      timeoutMs: 180_000,
      primary: true
    },
    secondaryActions: [
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Open logs", command: "open_logs", timeoutMs: 10_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "serverPackage",
    title: "Server Package",
    role: "Installs and activates the standalone koed-server app-runtime package.",
    impact:
      "Desktop falls back to its embedded koed-server runtime until a standalone package is installed.",
    componentKeys: ["serverPackage"],
    primaryAction: {
      label: "Install package",
      command: "package_install",
      timeoutMs: 600_000,
      primary: true
    },
    secondaryActions: [
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      { label: "Open logs", command: "open_logs", timeoutMs: 10_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "api",
    title: "Core API",
    role: "HTTP API used by Desktop, Capture Hook, the Local AI Runtime, and recall.",
    impact:
      "Capture, recall, settings, and Desktop calls fail when unreachable.",
    componentKeys: ["api"],
    primaryAction: {
      label: "Ensure API is running",
      command: "start",
      timeoutMs: 180_000,
      primary: true
    },
    secondaryActions: [
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 }
    ]
  },
  {
    id: "memoryStore",
    title: "Memory Store",
    role: "Postgres/pgvector storage for users, tokens, memory, and embeddings.",
    impact: "Durable memory capture and recall are unavailable without it.",
    componentKeys: ["database"],
    primaryAction: {
      label: "Start dependencies",
      command: "start",
      timeoutMs: 180_000,
      primary: true
    },
    secondaryActions: [
      {
        label: "Install runtime",
        command: "runtime_install",
        timeoutMs: 600_000
      },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Open logs", command: "open_logs", timeoutMs: 10_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "queueWorker",
    title: "Queue + Worker",
    role: "Redis queues and Worker process for projection, embeddings, and compaction.",
    impact:
      "Captured memory may remain raw or unembedded when this is degraded.",
    componentKeys: ["redis", "workerQueues"],
    primaryAction: {
      label: "Ensure worker stack",
      command: "start",
      timeoutMs: 180_000,
      primary: true
    },
    secondaryActions: [
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 }
    ]
  },
  {
    id: "embeddingEngine",
    title: "Embedding Engine",
    role: "Local model runtime that turns memory text into retrieval vectors.",
    impact:
      "Semantic recall and new memory indexing are degraded without the model.",
    componentKeys: ["embeddingService"],
    primaryAction: {
      label: "Ensure embedding stack",
      command: "start",
      timeoutMs: 180_000,
      primary: true
    },
    secondaryActions: [
      {
        label: "Install embedding model",
        command: "models_install",
        timeoutMs: 600_000
      },
      {
        label: "Install runtime",
        command: "runtime_install",
        timeoutMs: 600_000
      },
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 }
    ]
  },
  {
    id: "coreIntegration",
    title: "Koed Core Runtime",
    role: "Local credential, MCP artifacts, and supervised runtime used by Koed.",
    impact: "Core memory services cannot operate when this is incomplete.",
    componentKeys: ["apiToken", "mcpServer", "localAiRuntime"],
    primaryAction: {
      label: "Set up Koed core",
      command: "setup_core",
      timeoutMs: 330_000,
      primary: true
    },
    secondaryActions: [
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "codexIntegration",
    title: "Codex Integration",
    role: "Configures Koed MCP recall and Supported Capture Hook in Codex.",
    impact:
      "Codex cannot capture Conversations or call Koed memory tools until configured.",
    componentKeys: ["codex"],
    primaryAction: {
      label: "Repair Codex integration",
      command: "repair_codex",
      timeoutMs: 120_000,
      primary: true
    },
    secondaryActions: [
      {
        label: "Set up Codex integration",
        command: "setup_codex",
        timeoutMs: 120_000
      },
      { label: "Check Codex integration", command: "check_codex" },
      { label: "Remove Codex integration", command: "remove_codex" },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "capturePath",
    title: "Capture Path",
    role: "Transcript Watcher and content-free Capture Hook used to turn AI-client activity into memory.",
    impact:
      "New conversations will not be captured automatically when this is blocked.",
    componentKeys: ["captureHook", "apiToken", "api"],
    primaryAction: {
      label: "Run diagnostics",
      command: "doctor",
      timeoutMs: 90_000,
      primary: true
    },
    secondaryActions: [
      { label: "Refresh", command: "status", timeoutMs: 10_000 }
    ]
  },
  {
    id: "piIntegration",
    title: "Pi Integration",
    role: "Registers Koed's local package in the active Pi profile for capture and recall.",
    impact:
      "Ordinary Pi sessions cannot use Koed memory tools until this package is configured.",
    componentKeys: ["pi"],
    primaryAction: {
      label: "Repair Pi integration",
      command: "repair_pi",
      timeoutMs: 120_000,
      primary: true
    },
    secondaryActions: [
      {
        label: "Set up Pi integration",
        command: "setup_pi",
        timeoutMs: 120_000
      },
      { label: "Check Pi integration", command: "check_pi" },
      { label: "Remove Pi integration", command: "remove_pi" },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "claudeIntegration",
    title: "Claude Code Integration",
    role: "Configures Koed MCP recall and the Supported Capture Hook in Claude Code.",
    impact:
      "Claude Code cannot capture Conversations or call Koed memory tools until configured.",
    componentKeys: ["claudeCode"],
    primaryAction: {
      label: "Repair Claude Code integration",
      command: "repair_claude",
      timeoutMs: 120_000,
      primary: true
    },
    secondaryActions: [
      {
        label: "Set up Claude Code integration",
        command: "setup_claude",
        timeoutMs: 120_000
      },
      { label: "Check Claude Code integration", command: "check_claude" },
      { label: "Remove Claude Code integration", command: "remove_claude" },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "teamBackend",
    title: "Team Backend",
    role: "Remote Team Backend connection used for Team Workspace memory.",
    impact:
      "Team Workspace recall stays unavailable until a backend is connected and enrolled.",
    componentKeys: ["upstreamBackends"],
    primaryAction: {
      label: "Connect backend",
      command: "connect_team_backend",
      timeoutMs: 120_000,
      primary: true
    },
    secondaryActions: [
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      {
        label: "Disconnect",
        command: "disconnect_team_backend",
        timeoutMs: 45_000
      },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 }
    ]
  },
  {
    id: "memoryProcessing",
    title: "Memory Processing",
    role: "LCM Summary Service and verification that keep captured memory compact and useful.",
    impact:
      "Recall still works, but summaries and titles can be stale when degraded.",
    componentKeys: ["lcmSummaryService", "lastVerification"],
    primaryAction: {
      label: "Run diagnostics",
      command: "doctor",
      timeoutMs: 90_000,
      primary: true
    },
    secondaryActions: [
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  }
] as const satisfies readonly StatusCardDefinition[];

export type StatusCardId = (typeof statusCards)[number]["id"];

const recoveryCardIdByComponent = {
  serverPackage: "serverPackage",
  api: "api",
  database: "memoryStore",
  redis: "queueWorker",
  workerQueues: "queueWorker",
  embeddingService: "embeddingEngine",
  localAiRuntime: "coreIntegration",
  apiToken: "coreIntegration",
  mcpServer: "coreIntegration",
  captureHook: "capturePath",
  codex: "codexIntegration",
  claudeCode: "claudeIntegration",
  pi: "piIntegration",
  lcmSummaryService: "memoryProcessing",
  upstreamBackends: "teamBackend",
  lastVerification: "memoryProcessing"
} as const satisfies Record<StatusComponentKey, StatusCardId>;

export const recoveryActionForStatusComponent = (
  componentKey: StatusComponentKey,
  state?: ComponentState
): StatusCardAction => {
  const cardId = recoveryCardIdByComponent[componentKey];
  const card = statusCards.find((entry) => entry.id === cardId);
  if (!card) {
    throw new Error(`Missing Desktop recovery card: ${cardId}`);
  }
  if (state === "not_configured") {
    if (componentKey === "codex") {
      const setupAction = card.secondaryActions.find(
        (action) => action.command === "setup_codex"
      );
      if (setupAction) return setupAction;
    }
    if (componentKey === "claudeCode") {
      const setupAction = card.secondaryActions.find(
        (action) => action.command === "setup_claude"
      );
      if (setupAction) return setupAction;
    }
    if (componentKey === "pi") {
      const setupAction = card.secondaryActions.find(
        (action) => action.command === "setup_pi"
      );
      if (setupAction) return setupAction;
    }
    const installCommand =
      componentKey === "embeddingService"
        ? "models_install"
        : componentKey === "database"
          ? "runtime_install"
          : null;
    const installAction = installCommand
      ? card.secondaryActions.find(
          (action) => action.command === installCommand
        )
      : undefined;
    if (installAction) {
      return installAction;
    }
  }
  return card.primaryAction;
};

export const statusGroups = [
  {
    id: "capture",
    title: "Capture",
    description: "Collect new AI Client Conversations into Personal Memory.",
    healthySummary: "New Conversations are being captured locally.",
    componentKeys: ["api", "apiToken", "captureHook", "codex"]
  },
  {
    id: "recall",
    title: "Recall",
    description: "Let your AI Client find and use Personal Memory.",
    healthySummary: "Your AI Client can search Personal Memory.",
    componentKeys: [
      "api",
      "database",
      "embeddingService",
      "apiToken",
      "mcpServer",
      "codex"
    ]
  },
  {
    id: "processing",
    title: "Memory processing",
    description: "Prepare captured memory for useful summaries and recall.",
    healthySummary: "Captured memory is processed and ready for recall.",
    componentKeys: [
      "redis",
      "workerQueues",
      "lcmSummaryService",
      "lastVerification"
    ]
  }
] as const satisfies readonly StatusGroupDefinition[];

export type StatusGroupId = (typeof statusGroups)[number]["id"];
