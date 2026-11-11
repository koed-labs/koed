import type {
  CollaborationCommandResult,
  CollaborationRendererCommand,
  AiClientCapabilityDescriptor,
  CollaborationRendererEvent,
  EmbeddingStateSnapshot,
  HistoricalIngestionProgress,
  PersonalDesktopApi
} from "@koed-labs/shared";
import type { PersonalDevicePairingProgress } from "./ipc/personal-device-pairing-protocol.js";
import type { DesktopThemePreference } from "./window/theme-preference.js";
import type { ManagedConversationDesktopApi } from "./ipc/managed-conversation-protocol.js";
import type { V1StateDesktopApi } from "./ipc/v1-state-protocol.js";
import type {
  MemoryModelInput,
  LocalAiClientFlowKey,
  LocalAiClientResponse
} from "./ipc/local-ai-client-protocol.js";
import type { DesktopFeatureFlags } from "./ipc/desktop-feature-flags.js";
import type { ManagedProjectDesktopApi } from "./ipc/managed-project-protocol.js";
import type { CliInstallApi } from "./cli-install/protocol.js";
import type { DesktopUpdateApi } from "@koed-labs/shared/desktop-update-contract";
import type {
  AccelerationChoice,
  DesktopAccelerationApi
} from "@koed-labs/server";

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

export interface AiClientReadiness {
  driverId: "codex" | "claude" | "pi";
  instanceId: string;
  displayName: string;
  installed: ComponentStatus;
  version: string | null;
  authentication: "authenticated" | "unauthenticated" | "unknown";
  profile: ComponentStatus;
  capabilities: AiClientCapabilityDescriptor[];
  observedAt: string;
  snapshotState: "profile" | "current" | "stale" | "unknown";
}

export interface KoedServerStartupStatus {
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
  privacyService: ComponentStatus;
  localAiRuntime: ComponentStatus;
  apiToken: ComponentStatus & { configured: boolean };
}

export interface KoedServerStatus {
  ok: boolean;
  state: ComponentState;
  lifecycle?: {
    state: "running" | "starting" | "stopped" | "unavailable";
    message: string;
    epoch?: string;
    pid?: number;
  };
  koedHome: string;
  generatedAt: string;
  runtimeMode: "local-personal" | "external" | "developer";
  dependencyMode: "bundled-local" | "external";
  api: ComponentStatus & { url: string };
  database: ComponentStatus;
  redis: ComponentStatus;
  workerQueues: ComponentStatus;
  embeddingService: ComponentStatus;
  privacyService?: ComponentStatus;
  localAiRuntime?: ComponentStatus;
  apiToken: ComponentStatus & { configured: boolean };
  mcpServer: ComponentStatus;
  captureHook: ComponentStatus;
  codexTranscriptWatcher?: ComponentStatus;
  claudeTranscriptWatcher?: ComponentStatus;
  piTranscriptWatcher?: ComponentStatus;
  codex: ComponentStatus & { configured: boolean };
  claudeCode?: ComponentStatus & { configured: boolean; detected?: boolean };
  pi?: ComponentStatus & { configured: boolean; detected?: boolean };
  aiClients?: Record<string, AiClientReadiness>;
  aiClientInstances?: Record<string, AiClientReadiness>;
  aiClientFlowReadiness?: Record<string, ComponentStatus>;
  lcmSummaryService: ComponentStatus;
  historicalIngestion?: Record<string, HistoricalIngestionProgress>;
  embeddingState?: EmbeddingStateSnapshot | null;
  personalDeviceSync?: ComponentStatus;
  upstreamBackends: ComponentStatus & {
    registered: number;
    validated: number;
    stale: number;
    failed: number;
    notChecked: number;
  };
  lastVerification: ComponentStatus & { checkedAt: string | null };
  core?: {
    state: ComponentState;
    components: Record<string, ComponentStatus>;
  };
  serverPackage?: ComponentStatus & {
    currentVersion?: string;
    source?: "standalone" | "bundled-fallback" | "unavailable";
  };
}

export type DesktopSetupStageId =
  | "package"
  | "runtime"
  | "model"
  | "acceleration"
  | "services"
  | "integration"
  | "verification";

export type DesktopSetupStageState =
  | "pending"
  | "running"
  | "complete"
  | "failed";

export interface DesktopSetupStage {
  progressPhase?: "downloading" | "verifying" | "complete";
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
  // An interrupted run carried a processing choice that was not kept. Setup
  // needs that choice again before it can continue.
  reviewProcessing?: true;
}

export interface DesktopSetupRunOptions {
  // The User continued with Operator-managed processing instead of a choice.
  acknowledgeOperatorProcessing?: true;
}

export interface DesktopSetupApi {
  inspect: () => Promise<DesktopSetupSnapshot>;
  run: (
    acceleration?: AccelerationChoice,
    options?: DesktopSetupRunOptions
  ) => Promise<DesktopSetupSnapshot>;
  subscribe: (listener: (snapshot: DesktopSetupSnapshot) => void) => () => void;
}

export type DesktopLaunchAtStartupStatus =
  | "disabled"
  | "enabled"
  | "requires-approval"
  | "unsupported";

export interface DesktopLaunchAtStartupState {
  enabled: boolean;
  status: DesktopLaunchAtStartupStatus;
  supported: boolean;
}

export interface DesktopApi {
  featureFlags?: DesktopFeatureFlags;
  invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>
  ) => Promise<T>;
  personalMemory?: PersonalDesktopApi;
  managedConversations?: ManagedConversationDesktopApi;
  v1State?: V1StateDesktopApi;
  localAiClients?: {
    list: () => Promise<LocalAiClientResponse>;
    refresh: () => Promise<LocalAiClientResponse>;
    set: (
      flowKey: LocalAiClientFlowKey,
      assignment: {
        provider: "codex" | "claude" | "pi";
        ai_client_instance_id: string;
        model: string;
        reasoning_effort: string;
        timeout_ms: number;
        max_attempts: number;
      }
    ) => Promise<LocalAiClientResponse>;
    setMemoryModel?: (
      input: MemoryModelInput
    ) => Promise<LocalAiClientResponse>;
    reset: (flowKey: LocalAiClientFlowKey) => Promise<LocalAiClientResponse>;
  };
  managedProject?: ManagedProjectDesktopApi;
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
  presentationPreferences?: {
    get: () => Promise<{ graphicsAcceleration: boolean; showMenuBar: boolean }>;
    set: (value: {
      graphicsAcceleration: boolean;
      showMenuBar: boolean;
    }) => Promise<{ graphicsAcceleration: boolean; showMenuBar: boolean }>;
  };
  acceleration?: DesktopAccelerationApi;
  hardwareAcceleration?: {
    get: () => Promise<{
      enabled: boolean;
      managedByEnvironment: boolean;
    }>;
    set: (enabled: boolean) => Promise<{
      enabled: boolean;
      managedByEnvironment: boolean;
    }>;
  };
  launchAtStartup?: {
    get: () => Promise<DesktopLaunchAtStartupState>;
    set: (enabled: boolean) => Promise<DesktopLaunchAtStartupState>;
  };
  setup?: DesktopSetupApi;
  cliInstall?: CliInstallApi;
  updates?: DesktopUpdateApi;
  status?: {
    subscribe: (listener: () => void) => () => void;
  };
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
