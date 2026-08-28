const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;
const DEFAULT_PROCESS_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_PROCESS_RETRY_DELAY_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface NotificationDrainClient {
  query(sql: string): Promise<unknown>;
  on(
    event: "notification",
    listener: (message: { channel: string; payload?: string }) => void
  ): void;
  on(event: "error", listener: (error: unknown) => void): void;
  removeAllListeners(event?: "notification" | "error"): void;
  release(): void;
}

export interface NotificationDrainPool {
  connect(): Promise<NotificationDrainClient>;
}

export interface NotificationDrainController {
  start(): void;
  stop(): Promise<void>;
  requestDrain(): void;
  scheduleRetry(retryAt: string | null): void;
}

export const createNotificationDrainController = <Result>(options: {
  channels: readonly string[];
  wakePool: NotificationDrainPool;
  processOnce(): Promise<Result>;
  shouldContinue?(result: Result): boolean;
  onProcessed?(result: Result): void;
  onProcessError(error: unknown): void;
  reconnectBaseMs?: number;
  maxReconnectDelayMs?: number;
  processRetryBaseMs?: number;
  maxProcessRetryDelayMs?: number;
}): NotificationDrainController => {
  const channels = [...new Set(options.channels)];
  if (
    channels.length === 0 ||
    channels.some((channel) => !/^[a-z][a-z0-9_]*$/.test(channel))
  ) {
    throw new TypeError(
      "Notification drain channels must be non-empty PostgreSQL identifiers"
    );
  }
  const channelSet = new Set(channels);
  const reconnectBaseMs = Math.max(options.reconnectBaseMs ?? 250, 1);
  const maxReconnectDelayMs = Math.max(
    options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
    1
  );
  const processRetryBaseMs = Math.max(
    options.processRetryBaseMs ?? DEFAULT_PROCESS_RETRY_BASE_MS,
    1
  );
  const maxProcessRetryDelayMs = Math.max(
    options.maxProcessRetryDelayMs ?? DEFAULT_MAX_PROCESS_RETRY_DELAY_MS,
    1
  );
  let lifecycle: "idle" | "started" | "stopped" = "idle";
  let wakeClient: NotificationDrainClient | null = null;
  let connection: Promise<void> | null = null;
  let processing: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAtMs: number | null = null;
  let reconnectAttempt = 0;
  let processFailureAttempt = 0;
  let runAgain = false;
  const releasedClients = new WeakSet<object>();

  const releaseClient = (client: NotificationDrainClient): void => {
    const identity = client as object;
    if (releasedClients.has(identity)) return;
    releasedClients.add(identity);
    client.removeAllListeners();
    client.release();
  };

  const unlistenAndRelease = async (
    client: NotificationDrainClient,
    listenedChannels: readonly string[]
  ): Promise<void> => {
    client.removeAllListeners();
    for (const channel of listenedChannels) {
      await client.query(`unlisten ${channel}`).catch(() => undefined);
    }
    releaseClient(client);
  };

  const requestDrain = (): void => {
    if (lifecycle !== "started") return;
    if (processing) {
      runAgain = true;
      return;
    }
    processing = (async () => {
      do {
        runAgain = false;
        const result = await options.processOnce();
        processFailureAttempt = 0;
        options.onProcessed?.(result);
        if (options.shouldContinue?.(result)) runAgain = true;
      } while (lifecycle === "started" && runAgain);
    })()
      .catch((error: unknown) => {
        const delayMs = Math.min(
          processRetryBaseMs * 2 ** processFailureAttempt,
          maxProcessRetryDelayMs
        );
        processFailureAttempt += 1;
        scheduleRetry(new Date(Date.now() + delayMs).toISOString());
        options.onProcessError(error);
      })
      .finally(() => {
        processing = null;
        if (lifecycle === "started" && runAgain) requestDrain();
      });
  };

  const scheduleRetry = (retryAt: string | null): void => {
    if (lifecycle !== "started" || !retryAt) return;
    const candidateAtMs = Date.parse(retryAt);
    if (!Number.isFinite(candidateAtMs)) {
      throw new TypeError(
        "Notification drain retry time must be valid ISO-8601"
      );
    }
    if (retryAtMs !== null && retryAtMs <= candidateAtMs) return;
    if (retryTimer) clearTimeout(retryTimer);
    retryAtMs = candidateAtMs;
    const delayMs = Math.max(candidateAtMs - Date.now(), 0);
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        retryAtMs = null;
        requestDrain();
      },
      Math.min(delayMs, MAX_TIMER_DELAY_MS)
    );
    retryTimer.unref?.();
  };

  const scheduleReconnect = (): void => {
    if (lifecycle !== "started" || reconnectTimer) return;
    const delayMs = Math.min(
      reconnectBaseMs * 2 ** reconnectAttempt,
      maxReconnectDelayMs
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWakeClient();
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const connectWakeClient = (): void => {
    if (lifecycle !== "started" || wakeClient || connection) return;
    connection = (async () => {
      let client: NotificationDrainClient | null = null;
      const listenedChannels: string[] = [];
      try {
        client = await options.wakePool.connect();
        if (lifecycle !== "started") {
          releaseClient(client);
          return;
        }
        for (const channel of channels) {
          await client.query(`listen ${channel}`);
          listenedChannels.push(channel);
        }
        if (lifecycle !== "started") {
          await unlistenAndRelease(client, listenedChannels);
          return;
        }
        const activeClient = client;
        wakeClient = activeClient;
        reconnectAttempt = 0;
        activeClient.on("notification", (message) => {
          if (channelSet.has(message.channel)) requestDrain();
        });
        activeClient.on("error", () => {
          if (wakeClient !== activeClient) return;
          wakeClient = null;
          releaseClient(activeClient);
          scheduleReconnect();
        });
        requestDrain();
      } catch {
        if (client) {
          if (wakeClient === client) wakeClient = null;
          await unlistenAndRelease(client, listenedChannels);
        }
        scheduleReconnect();
      }
    })().finally(() => {
      connection = null;
    });
  };

  return {
    start() {
      if (lifecycle !== "idle") return;
      lifecycle = "started";
      connectWakeClient();
    },
    stop() {
      if (stopping) return stopping;
      if (lifecycle === "stopped") return Promise.resolve();
      lifecycle = "stopped";
      runAgain = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      retryAtMs = null;
      const client = wakeClient;
      wakeClient = null;
      stopping = (async () => {
        if (client) await unlistenAndRelease(client, channels);
        await connection;
        await processing;
      })();
      return stopping;
    },
    requestDrain,
    scheduleRetry
  };
};
