import {
  localMemoryAgentSettingFor,
  type MemoryApiClient,
  workerOverridesFromLocalMemorySetting
} from "./index.js";
import {
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  type LcmSummaryWorkerConfig
} from "./lcm-summary-worker.js";

export interface LcmSummaryServiceConfig {
  initialDelayMs: number;
  pushDelayMs: number;
  intervalMs: number;
  batchLimit: number;
}

export interface LcmSummaryServiceHandle {
  stop(): void;
  trigger(
    reason?: string,
    options?: {
      limit?: number;
      workerConfig?: LcmSummaryWorkerConfig;
    }
  ): Promise<{
    ran: boolean;
    skippedReason?: "already_running" | "stopped";
    result?: unknown;
    error?: string;
  }>;
  nudge(
    reason?: string,
    options?: {
      limit?: number;
      workerConfig?: LcmSummaryWorkerConfig;
    }
  ): void;
  snapshot(): {
    running: boolean;
    stopped: boolean;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastResult: unknown;
    lastError: string | null;
  };
}

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

const positiveIntEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number
): number => {
  const parsed = Number.parseInt(envValue(env, name) ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const resolveLcmSummaryServiceConfig = (
  env: NodeJS.ProcessEnv = process.env
): LcmSummaryServiceConfig => ({
  initialDelayMs: positiveIntEnv(
    env,
    "MEMORY_LCM_BACKGROUND_INITIAL_DELAY_MS",
    30_000
  ),
  pushDelayMs: positiveIntEnv(
    env,
    "MEMORY_LCM_BACKGROUND_PUSH_DELAY_MS",
    10_000
  ),
  intervalMs: positiveIntEnv(
    env,
    "MEMORY_LCM_BACKGROUND_INTERVAL_MS",
    1_800_000
  ),
  batchLimit: positiveIntEnv(env, "MEMORY_LCM_BACKGROUND_BATCH_LIMIT", 2)
});

export const startLcmSummaryService = (
  client: MemoryApiClient,
  options: {
    serviceConfig?: LcmSummaryServiceConfig;
    workerConfig?: LcmSummaryWorkerConfig;
  } = {}
): LcmSummaryServiceHandle | null => {
  const serviceConfig =
    options.serviceConfig ?? resolveLcmSummaryServiceConfig();
  const fallbackWorkerConfig = options.workerConfig;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let lastRunAt: string | null = null;
  let lastSuccessAt: string | null = null;
  let lastResult: unknown = null;
  let lastError: string | null = null;

  const schedule = (delayMs: number) => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (stopped) {
      return;
    }
    timer = setTimeout(() => {
      void run("timer");
    }, delayMs);
  };

  const nudge = (
    reason = "nudge",
    runOptions: {
      limit?: number;
      workerConfig?: LcmSummaryWorkerConfig;
    } = {}
  ) => {
    if (stopped || running) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    timer = setTimeout(() => {
      void run(reason, runOptions);
    }, serviceConfig.pushDelayMs);
  };

  const run = async (
    reason = "manual",
    runOptions: {
      limit?: number;
      workerConfig?: LcmSummaryWorkerConfig;
    } = {}
  ) => {
    if (stopped) {
      return { ran: false, skippedReason: "stopped" as const };
    }
    if (running) {
      return { ran: false, skippedReason: "already_running" as const };
    }
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = true;
    void reason;
    lastRunAt = new Date().toISOString();
    try {
      const persistedSettings = await client
        .listLocalMemoryAgentSettings()
        .then((response) => response.settings)
        .catch(() => []);
      const persistedWorkerOverrides = workerOverridesFromLocalMemorySetting(
        localMemoryAgentSettingFor(persistedSettings, "lcm_summary")
      );
      const currentWorkerConfig =
        runOptions.workerConfig ??
        (persistedWorkerOverrides
          ? resolveLcmSummaryWorkerConfig(process.env, persistedWorkerOverrides)
          : (fallbackWorkerConfig ??
            resolveLcmSummaryWorkerConfig(process.env)));
      lastResult = await summarizePendingLcmNodes(client, {
        limit: runOptions.limit ?? serviceConfig.batchLimit,
        config: currentWorkerConfig
      });
      lastError = null;
      lastSuccessAt = new Date().toISOString();
      return { ran: true, result: lastResult };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return { ran: true, error: lastError };
    } finally {
      running = false;
      schedule(serviceConfig.intervalMs);
    }
  };

  schedule(serviceConfig.initialDelayMs);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    trigger: run,
    nudge,
    snapshot() {
      return {
        running,
        stopped,
        lastRunAt,
        lastSuccessAt,
        lastResult,
        lastError
      };
    }
  };
};
