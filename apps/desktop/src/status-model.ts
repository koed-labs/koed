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
      label: "Setup Codex",
      command: "setup_codex",
      timeoutMs: 300_000
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
