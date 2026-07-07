import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const schemaVersion = "embedding_service_log_v1";
export const serviceName = "koed-embedding-service";

export type LogLevel = "debug" | "info" | "warning" | "error" | "critical";

export interface RequestLogContext {
  request: {
    id: string;
    method: string;
    path: string;
  };
  trace?: {
    trace_id: string;
    span_id: string;
  };
}

const requestContext = new AsyncLocalStorage<RequestLogContext>();
const requestIdPattern = /^[A-Za-z0-9._~:-]{1,128}$/;
const traceparentPattern =
  /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i;

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50
};

const normalizeLogLevel = (value: string | undefined): LogLevel => {
  const normalized = (value ?? "info").trim().toLowerCase();
  if (normalized === "warn") return "warning";
  return normalized in levelRank ? (normalized as LogLevel) : "info";
};

export const resolveRequestId = (value: string | null): string =>
  value && requestIdPattern.test(value) ? value : randomUUID();

export const parseTraceparent = (
  value: string | null
): { trace_id: string; span_id: string } | null => {
  const match = value?.match(traceparentPattern);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { trace_id: match[1].toLowerCase(), span_id: match[2].toLowerCase() };
};

export const event = (name: string): { name: string } => ({ name });

export const errorType = (error: unknown): { type: string } => ({
  type:
    typeof error === "object" && error !== null && "constructor" in error
      ? ((error as { constructor?: { name?: string } }).constructor?.name ??
        "Error")
      : "Error"
});

export interface EmbeddingLogger {
  debug(message: string, bindings?: Record<string, unknown>): void;
  info(message: string, bindings?: Record<string, unknown>): void;
  warning(message: string, bindings?: Record<string, unknown>): void;
  error(message: string, bindings?: Record<string, unknown>): void;
  withRequestContext<T>(
    context: RequestLogContext,
    task: () => Promise<T>
  ): Promise<T>;
}

export const createEmbeddingLogger = (
  logLevel: string,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): EmbeddingLogger => {
  const threshold = levelRank[normalizeLogLevel(logLevel)];
  const log = (
    level: LogLevel,
    message: string,
    bindings: Record<string, unknown> = {}
  ) => {
    if (levelRank[level] < threshold) {
      return;
    }
    const context = requestContext.getStore();
    write(
      JSON.stringify({
        schema_version: schemaVersion,
        service: serviceName,
        level,
        time: new Date().toISOString(),
        message,
        ...(context ?? {}),
        ...bindings
      })
    );
  };

  return {
    debug: (message, bindings) => log("debug", message, bindings),
    info: (message, bindings) => log("info", message, bindings),
    warning: (message, bindings) => log("warning", message, bindings),
    error: (message, bindings) => log("error", message, bindings),
    withRequestContext: (context, task) => requestContext.run(context, task)
  };
};
