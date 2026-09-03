import type {
  CollaborationCommandResult,
  CollaborationRendererCommand,
  AiClientCapabilityDescriptor,
  CollaborationRendererEvent,
  PersonalDesktopApi
} from "@koed/shared";
import type { PersonalDevicePairingProgress } from "./ipc/personal-device-pairing-protocol.js";
import type { DesktopThemePreference } from "./window/theme-preference.js";
import type { ManagedConversationDesktopApi } from "./ipc/managed-conversation-protocol.js";
import type {
  LocalAiClientFlowKey,
  LocalAiClientResponse
} from "./ipc/local-ai-client-protocol.js";
import type { DesktopFeatureFlags } from "./ipc/desktop-feature-flags.js";

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
  codex: ComponentStatus & { configured: boolean };
  claudeCode?: ComponentStatus & { configured: boolean; detected?: boolean };
  pi?: ComponentStatus & { configured: boolean; detected?: boolean };
  aiClients?: Record<string, AiClientReadiness>;
  aiClientInstances?: Record<string, AiClientReadiness>;
  aiClientFlowReadiness?: Record<string, ComponentStatus>;
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
    reset: (flowKey: LocalAiClientFlowKey) => Promise<LocalAiClientResponse>;
  };
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
