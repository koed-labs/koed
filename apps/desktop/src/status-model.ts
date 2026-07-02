import type { ComponentState, KoedServerStatus } from "./types.js";

export const stateLabels = {
  not_configured: "Not configured",
  starting: "Starting",
  healthy: "Healthy",
  needs_attention: "Needs attention"
} as const satisfies Record<ComponentState, string>;

export const statusComponentKeys = [
  "api",
  "explorer",
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
] as const satisfies ReadonlyArray<keyof KoedServerStatus>;

export type StatusComponentKey = (typeof statusComponentKeys)[number];

export interface StatusComponentDefinition {
  label: string;
  description: string;
}

export const componentDefinitions = {
  api: {
    label: "API",
    description: "Koed HTTP API used by local integrations and Explorer."
  },
  explorer: {
    label: "Explorer",
    description: "Embedded UI for browsing captured memory."
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
  apiToken: {
    label: "Local credential/API Token",
    description:
      "User-owned API Token available to the local AI Client integration."
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
  lcmSummaryService: {
    label: "LCM Summary Service",
    description: "Local background summarization service for memory nodes."
  },
  lastVerification: {
    label: "Last verification",
    description: "Most recent local system verification result."
  }
} as const satisfies Record<StatusComponentKey, StatusComponentDefinition>;

export interface StatusGroupAction {
  label: string;
  command: string;
  timeoutMs: number;
}

export interface StatusGroupDefinition {
  id: string;
  title: string;
  description: string;
  componentKeys: readonly StatusComponentKey[];
  action?: StatusGroupAction;
}

export type StatusCardActionCommand =
  | "status"
  | "start"
  | "setup_codex"
  | "repair_codex"
  | "runtime_install"
  | "doctor"
  | "open_explorer"
  | "copy_diagnostics";

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
    role: "Supervises KOED_HOME plus local API, Worker, and Explorer processes.",
    impact:
      "Local startup and process supervision are blocked when this is down.",
    componentKeys: ["api", "workerQueues", "explorer"],
    primaryAction: {
      label: "Start Koed",
      command: "start",
      timeoutMs: 180_000,
      primary: true
    },
    secondaryActions: [
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "api",
    title: "Core API",
    role: "HTTP API used by Explorer, Capture Hook, MCP Server, and recall.",
    impact:
      "Capture, recall, settings, and Explorer calls fail when unreachable.",
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
    impact: "Semantic recall and new memory indexing are degraded without it.",
    componentKeys: ["embeddingService"],
    primaryAction: {
      label: "Ensure embedding stack",
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
      { label: "Refresh", command: "status", timeoutMs: 10_000 },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 }
    ]
  },
  {
    id: "aiClientIntegration",
    title: "AI Client Integration",
    role: "API Token, Codex config, and MCP Server used for Memory Answer recall.",
    impact:
      "The AI Client cannot call Koed memory tools when this is incomplete.",
    componentKeys: ["apiToken", "mcpServer", "codex"],
    primaryAction: {
      label: "Fix Codex integration",
      command: "repair_codex",
      timeoutMs: 120_000,
      primary: true
    },
    secondaryActions: [
      { label: "Setup Codex", command: "setup_codex", timeoutMs: 300_000 },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "capturePath",
    title: "Capture Path",
    role: "Supported Capture Hook and credentials used to turn AI-client activity into memory.",
    impact:
      "New conversations will not be captured automatically when this is blocked.",
    componentKeys: ["captureHook", "apiToken", "api"],
    primaryAction: {
      label: "Fix Codex integration",
      command: "repair_codex",
      timeoutMs: 120_000,
      primary: true
    },
    secondaryActions: [
      { label: "Setup Codex", command: "setup_codex", timeoutMs: 300_000 },
      { label: "Run doctor", command: "doctor", timeoutMs: 90_000 },
      { label: "Refresh", command: "status", timeoutMs: 10_000 }
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
      {
        label: "Fix Codex integration",
        command: "repair_codex",
        timeoutMs: 120_000
      },
      { label: "Copy diagnostics", command: "copy_diagnostics" }
    ]
  },
  {
    id: "explorer",
    title: "Explorer",
    role: "Embedded UI for browsing captured memory and local settings.",
    impact: "Inspection UI is unavailable when this local surface is down.",
    componentKeys: ["explorer"],
    primaryAction: {
      label: "Open Explorer",
      command: "open_explorer",
      primary: true
    },
    secondaryActions: [
      { label: "Ensure Explorer", command: "start", timeoutMs: 180_000 },
      { label: "Refresh", command: "status", timeoutMs: 10_000 }
    ]
  }
] as const satisfies readonly StatusCardDefinition[];

export type StatusCardId = (typeof statusCards)[number]["id"];

export const statusGroups = [
  {
    id: "services",
    title: "Services",
    description:
      "Local services that power capture, recall, Explorer, and storage.",
    componentKeys: [
      "api",
      "explorer",
      "database",
      "redis",
      "workerQueues",
      "embeddingService"
    ],
    action: {
      label: "Refresh stack",
      command: "start",
      timeoutMs: 180_000
    }
  },
  {
    id: "integration",
    title: "AI Client integration",
    description:
      "Credentials and local integration pieces used by the supported AI Client.",
    componentKeys: ["apiToken", "mcpServer", "captureHook", "codex"],
    action: {
      label: "Fix Codex integration",
      command: "repair_codex",
      timeoutMs: 120_000
    }
  },
  {
    id: "memory",
    title: "Memory readiness",
    description: "Background summarization and the latest verification result.",
    componentKeys: ["lcmSummaryService", "lastVerification"],
    action: {
      label: "Check system",
      command: "doctor",
      timeoutMs: 90_000
    }
  }
] as const satisfies readonly StatusGroupDefinition[];

export type StatusGroupId = (typeof statusGroups)[number]["id"];
