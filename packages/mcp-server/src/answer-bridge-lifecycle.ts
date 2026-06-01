import type http from "node:http";
import {
  createAnswerBridgeServer,
  host as defaultAnswerBridgeHost,
  parseAnswerBridgePort
} from "./answer-bridge.js";
import { answerBridgeLogger } from "./logger.js";

export const DEFAULT_ANSWER_BRIDGE_RETRY_DELAY_MS = 1000;

export interface AnswerBridgeLifecycleHandle {
  close(): void;
}

type TimerHandle = ReturnType<typeof setTimeout> | number;
type SetTimeoutFn = (callback: () => void, delayMs: number) => TimerHandle;
type ClearTimeoutFn = (timer: TimerHandle) => void;

interface AnswerBridgeLifecycleOptions {
  clearTimeoutFn?: ClearTimeoutFn;
  createServer?: () => http.Server;
  enabled?: boolean;
  host?: string;
  log?: {
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  portValue?: string;
  retryDelayMs?: number;
  setTimeoutFn?: SetTimeoutFn;
}

const resolveRetryDelayMs = (value?: string): number => {
  const candidate = value?.trim() ?? "";
  if (!/^\d+$/.test(candidate)) {
    return DEFAULT_ANSWER_BRIDGE_RETRY_DELAY_MS;
  }
  const parsed = Number.parseInt(candidate, 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ANSWER_BRIDGE_RETRY_DELAY_MS;
};

export const startAnswerBridgeWithRetry = (
  options: AnswerBridgeLifecycleOptions = {}
): AnswerBridgeLifecycleHandle => {
  const enabled =
    options.enabled ??
    process.env.MEMORY_ANSWER_BRIDGE_ENABLED?.trim().toLowerCase() !== "false";
  const log = options.log ?? answerBridgeLogger;

  if (!enabled) {
    log.info("memory answer bridge disabled by configuration");
    return { close() {} };
  }

  const configuredPort = parseAnswerBridgePort(
    options.portValue ?? process.env.MEMORY_ANSWER_BRIDGE_PORT
  );
  if (!configuredPort) {
    log.warn(
      {
        configuredPort:
          options.portValue ?? process.env.MEMORY_ANSWER_BRIDGE_PORT
      },
      "memory answer bridge disabled due to invalid port"
    );
    return { close() {} };
  }

  const host = options.host ?? defaultAnswerBridgeHost;
  const retryDelayMs =
    options.retryDelayMs ??
    resolveRetryDelayMs(process.env.MEMORY_ANSWER_BRIDGE_RETRY_DELAY_MS);
  const createServer = options.createServer ?? createAnswerBridgeServer;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let closed = false;
  let retryTimer: TimerHandle | null = null;
  let server: http.Server | null = null;

  const scheduleRetry = () => {
    if (closed || retryTimer) {
      return;
    }
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      bind();
    }, retryDelayMs);
  };

  const bind = () => {
    if (closed) {
      return;
    }
    log.debug(
      {
        host,
        port: configuredPort
      },
      "binding memory answer bridge"
    );
    const nextServer = createServer();
    server = nextServer;
    nextServer.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        log.warn(
          {
            err: error,
            host,
            port: configuredPort,
            retryDelayMs
          },
          "memory answer bridge port already in use; retrying"
        );
        nextServer.close();
        if (server === nextServer) {
          server = null;
        }
        scheduleRetry();
        return;
      }
      log.error(
        {
          err: error,
          host,
          port: configuredPort
        },
        "memory answer bridge failed"
      );
    });
    nextServer.once("listening", () => {
      log.info(
        {
          host,
          port: configuredPort,
          url: `http://${host}:${configuredPort}`
        },
        "memory answer bridge listening"
      );
    });
    nextServer.listen(configuredPort, host);
  };

  bind();

  return {
    close() {
      closed = true;
      if (retryTimer) {
        clearTimeoutFn(retryTimer);
        retryTimer = null;
      }
      server?.close();
      server = null;
    }
  };
};
