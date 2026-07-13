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
  lcmSummaryService: ComponentStatus;
  upstreamBackends: ComponentStatus & {
    registered: number;
    validated: number;
    stale: number;
    failed: number;
    notChecked: number;
  };
  explorer: ComponentStatus & { url: string };
  lastVerification: ComponentStatus & { checkedAt: string | null };
  serverPackage?: ComponentStatus & {
    currentVersion?: string;
    source?: "standalone" | "bundled-fallback" | "unavailable";
  };
  desktopStartLog?: string[];
}

export interface DesktopApi {
  invoke: <T = unknown>(
    command: string,
    args?: Record<string, unknown>
  ) => Promise<T>;
}

declare global {
  interface Window {
    koedDesktop?: DesktopApi;
  }
}
