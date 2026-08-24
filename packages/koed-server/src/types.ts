import type {
  AiClientCapabilityDescriptor,
  LocalAiClientFlowKey,
  LocalAiClientRuntimeAssignment
} from "@koed/shared";

export type KoedServerComponentState =
  | "not_configured"
  | "starting"
  | "healthy"
  | "needs_attention";

export interface KoedAiClientFlowReadiness extends KoedServerComponentStatus {
  flowKey: LocalAiClientFlowKey;
  source: "setting" | "environment" | "code" | "unavailable";
  assignment: LocalAiClientRuntimeAssignment | null;
}

export interface KoedAiClientReadiness {
  driverId: "codex" | "claude" | "pi";
  instanceId: string;
  displayName: string;
  installed: KoedServerComponentStatus;
  version: string | null;
  authentication: "authenticated" | "unauthenticated" | "unknown";
  profile: KoedServerComponentStatus;
  capabilities: AiClientCapabilityDescriptor[];
  observedAt: string;
  snapshotState: "profile" | "current" | "stale" | "unknown";
}

export const aiClientReadinessUnknown = (
  driverId: "codex" | "claude" | "pi",
  displayName: string,
  now: string
): KoedAiClientReadiness => ({
  driverId,
  instanceId: `${driverId}.default`,
  displayName,
  installed: { state: "not_configured", message: "Installation is unknown." },
  version: null,
  authentication: "unknown",
  profile: { state: "not_configured", message: "Profile setup is unknown." },
  capabilities: [],
  observedAt: now,
  snapshotState: "unknown"
});

export interface KoedServerComponentStatus {
  state: KoedServerComponentState;
  message?: string;
  action?: string;
  details?: Record<string, unknown>;
}

export interface KoedServerStartupStatus {
  ok: boolean;
  state: KoedServerComponentState;
  koedHome: string;
  generatedAt: string;
  runtimeMode: "local-personal" | "external" | "developer";
  dependencyMode: "bundled-local" | "external";
  api: KoedServerComponentStatus & { url: string };
  database: KoedServerComponentStatus;
  redis: KoedServerComponentStatus;
  workerQueues: KoedServerComponentStatus;
  embeddingService: KoedServerComponentStatus;
  privacyService: KoedServerComponentStatus;
  localAiRuntime: KoedServerComponentStatus;
  apiToken: KoedServerComponentStatus & { configured: boolean };
}

export interface KoedServerStatus {
  ok: boolean;
  state: KoedServerComponentState;
  koedHome: string;
  generatedAt: string;
  runtimeMode: "local-personal" | "external" | "developer";
  dependencyMode: "bundled-local" | "external";
  api: KoedServerComponentStatus & { url: string };
  database: KoedServerComponentStatus;
  redis: KoedServerComponentStatus;
  workerQueues: KoedServerComponentStatus;
  embeddingService: KoedServerComponentStatus;
  privacyService: KoedServerComponentStatus;
  localAiRuntime: KoedServerComponentStatus;
  apiToken: KoedServerComponentStatus & { configured: boolean };
  mcpServer: KoedServerComponentStatus;
  captureHook: KoedServerComponentStatus;
  codexTranscriptWatcher: KoedServerComponentStatus;
  claudeTranscriptWatcher: KoedServerComponentStatus;
  codex: KoedServerComponentStatus & { configured: boolean };
  claudeCode: KoedServerComponentStatus & {
    configured: boolean;
    detected: boolean;
  };
  pi: KoedServerComponentStatus & { configured: boolean; detected: boolean };
  /** Legacy provider-keyed readiness view. Kept for existing clients. */
  aiClients: Record<string, KoedAiClientReadiness>;
  /** Instance-keyed readiness view for multi-instance and flow assignments. */
  aiClientInstances: Record<string, KoedAiClientReadiness>;
  aiClientFlowReadiness: Record<
    LocalAiClientFlowKey,
    KoedAiClientFlowReadiness
  >;
  lcmSummaryService: KoedServerComponentStatus;
  deviceIdentity: KoedServerComponentStatus & {
    health: string;
    deploymentId: string | null;
    deviceInstanceId: string | null;
    remoteOperationsAllowed: boolean;
    pendingRemoteRevocation?: true;
    platformProtection: "verified" | "limited";
  };
  upstreamBackends: KoedServerComponentStatus & {
    registered: number;
    validated: number;
    stale: number;
    failed: number;
    notChecked: number;
  };
  lastVerification: KoedServerComponentStatus & { checkedAt: string | null };
  core: {
    state: KoedServerComponentState;
    components: Record<string, KoedServerComponentStatus>;
  };
}

export interface KoedServerDoctorCheck extends KoedServerComponentStatus {
  id: string;
  label: string;
}

export interface KoedServerDoctorResult {
  ok: boolean;
  state: KoedServerComponentState;
  summary: string;
  koedHome: string;
  generatedAt: string;
  runtimeMode: "local-personal" | "external" | "developer";
  dependencyMode: "bundled-local" | "external";
  checks: KoedServerDoctorCheck[];
}

export interface KoedServerRuntimeState {
  pid: number;
  startedAt: string;
  runtimeMode?: "local-personal" | "external" | "developer";
  dependencyMode?: "bundled-local" | "external";
  automaticPorts?: boolean;
  codexTranscriptWatcherEnabled?: boolean;
  claudeTranscriptWatcherEnabled?: boolean;
  repoRoot: string;
  apiUrl: string;
  services: string[];
  processes?: Record<string, number>;
}
