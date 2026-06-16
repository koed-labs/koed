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
  api: KoedServerComponentStatus & { url: string };
  database: KoedServerComponentStatus;
  redis: KoedServerComponentStatus;
  workerQueues: KoedServerComponentStatus;
  embeddingService: KoedServerComponentStatus;
  apiToken: KoedServerComponentStatus & { configured: boolean };
  mcpServer: KoedServerComponentStatus;
  captureHook: KoedServerComponentStatus;
  codex: KoedServerComponentStatus & { configured: boolean };
  lcmSummaryService: KoedServerComponentStatus;
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
  checks: KoedServerDoctorCheck[];
}

export interface KoedServerRuntimeState {
  pid: number;
  startedAt: string;
  repoRoot: string;
  apiUrl: string;
  explorerUrl: string;
  services: string[];
  processes?: Record<string, number>;
}
