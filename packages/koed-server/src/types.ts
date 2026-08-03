export type KoedServerComponentState =
  | "not_configured"
  | "starting"
  | "healthy"
  | "needs_attention";

export interface KoedServerComponentStatus {
  state: KoedServerComponentState;
  message?: string;
  action?: string;
  details?: Record<string, unknown>;
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
  apiToken: KoedServerComponentStatus & { configured: boolean };
  mcpServer: KoedServerComponentStatus;
  captureHook: KoedServerComponentStatus;
  codexTranscriptWatcher: KoedServerComponentStatus;
  codex: KoedServerComponentStatus & { configured: boolean };
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
  explorer: KoedServerComponentStatus & { url: string };
  lastVerification: KoedServerComponentStatus & { checkedAt: string | null };
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
  repoRoot: string;
  apiUrl: string;
  explorerUrl: string;
  services: string[];
  processes?: Record<string, number>;
}
