import type {
  CollaborationCommandResult,
  CollaborationRendererCommand,
  CollaborationRendererEvent,
  PersonalDesktopApi
} from "@koed/shared";
import type { PersonalDevicePairingProgress } from "./ipc/personal-device-pairing-protocol.js";
import type { DesktopThemePreference } from "./window/theme-preference.js";
import type { ManagedConversationDesktopApi } from "./ipc/managed-conversation-protocol.js";

export type ComponentState =
  | "not_configured"
  | "starting"
  | "healthy"
  | "needs_attention";

export interface ComponentStatus {
  state: ComponentState;
  message?: string;
  action?: string;
  details?: Record<string, unknown>;
}

export interface KoedServerStatus {
  ok: boolean;
  state: ComponentState;
  koedHome: string;
  generatedAt: string;
  runtimeMode: "local-personal" | "external" | "developer";
  dependencyMode: "bundled-local" | "external";
  api: ComponentStatus & { url: string };
  database: ComponentStatus;
  redis: ComponentStatus;
  workerQueues: ComponentStatus;
  embeddingService: ComponentStatus;
  apiToken: ComponentStatus & { configured: boolean };
  mcpServer: ComponentStatus;
  captureHook: ComponentStatus;
  codex: ComponentStatus & { configured: boolean };
  claudeCode?: ComponentStatus & { configured: boolean; detected?: boolean };
  pi?: ComponentStatus & { configured: boolean; detected?: boolean };
  lcmSummaryService: ComponentStatus;
  personalDeviceSync?: ComponentStatus;
  upstreamBackends: ComponentStatus & {
    registered: number;
    validated: number;
    stale: number;
    failed: number;
    notChecked: number;
  };
  lastVerification: ComponentStatus & { checkedAt: string | null };
  serverPackage?: ComponentStatus & {
    currentVersion?: string;
    source?: "standalone" | "bundled-fallback" | "unavailable";
  };
}

export type DesktopSetupStageId =
  | "package"
  | "runtime"
  | "model"
  | "services"
  | "integration"
  | "verification";

export type DesktopSetupStageState =
  | "pending"
  | "running"
  | "complete"
  | "failed";

export interface DesktopSetupStage {
  completedBytes: number | null;
  detectedAiClients?: readonly string[];
  id: DesktopSetupStageId;
  message: string;
  state: DesktopSetupStageState;
  totalBytes: number | null;
}

export interface DesktopSetupSnapshot {
  activeStage: DesktopSetupStageId | null;
  error: string | null;
  runId: string;
  sequence: number;
  stages: DesktopSetupStage[];
  state: "inspecting" | "ready" | "running" | "complete" | "failed";
}

export interface DesktopSetupApi {
  inspect: () => Promise<DesktopSetupSnapshot>;
  run: () => Promise<DesktopSetupSnapshot>;
  subscribe: (listener: (snapshot: DesktopSetupSnapshot) => void) => () => void;
}

export interface DesktopApi {
  invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>
  ) => Promise<T>;
  personalMemory?: PersonalDesktopApi;
  managedConversations?: ManagedConversationDesktopApi;
  clipboard?: {
    writeText: (value: string) => Promise<void>;
  };
  devices?: {
    consumePairingLink: (expectedUrl?: string) => Promise<string | null>;
    subscribePairingLinks: (listener: (url: string) => void) => () => void;
    subscribePairingProgress: (
      listener: (progress: PersonalDevicePairingProgress) => void
    ) => () => void;
  };
  theme?: {
    get: () => Promise<DesktopThemePreference>;
    set: (
      preference: DesktopThemePreference
    ) => Promise<{ preference: DesktopThemePreference; resolvedDark: boolean }>;
  };
  setup?: DesktopSetupApi;
  collaboration?: {
    command: (
      command: CollaborationRendererCommand
    ) => Promise<CollaborationCommandResult>;
    subscribe: (
      listener: (event: CollaborationRendererEvent) => void
    ) => () => void;
  };
}

declare global {
  interface Window {
    koedDesktop?: DesktopApi;
  }
}
