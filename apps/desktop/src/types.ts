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
  explorer: ComponentStatus & { url: string };
  lastVerification: ComponentStatus & { checkedAt: string | null };
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
