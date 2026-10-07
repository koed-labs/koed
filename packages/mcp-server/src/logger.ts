import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions
} from "pino";

export const mcpLogSchemaVersion = "mcp_log_v1";

export type McpLogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "silent";

export type McpLogDestination = "stderr" | "file" | "both";

const validLogLevels = new Set<McpLogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent"
]);

const validLogDestinations = new Set<McpLogDestination>([
  "stderr",
  "file",
  "both"
]);

export interface McpLogDestinationConfig {
  destination: McpLogDestination;
  filePath?: string;
}

export const resolveMcpLogLevel = (
  environment: NodeJS.ProcessEnv = process.env
): McpLogLevel => {
  const configured = (
    environment.MEMORY_LOG_LEVEL ??
    (environment.NODE_ENV === "test" ? "silent" : "info")
  )
    .trim()
    .toLowerCase();
  return validLogLevels.has(configured as McpLogLevel)
    ? (configured as McpLogLevel)
    : "info";
};

const expandLogFilePath = (value: string): string => {
  const expanded = value.startsWith("~/")
    ? `${homedir()}${value.slice(1)}`
    : value;
  return resolve(expanded);
};

export const resolveMcpLogDestinationConfig = (
  environment: NodeJS.ProcessEnv = process.env
): McpLogDestinationConfig => {
  const configuredDestination =
    environment.MEMORY_LOG_DESTINATION?.trim().toLowerCase();
  const configuredFilePath = environment.MEMORY_LOG_FILE?.trim();
  const filePath = configuredFilePath
    ? expandLogFilePath(configuredFilePath)
    : undefined;
  const destination = validLogDestinations.has(
    configuredDestination as McpLogDestination
  )
    ? (configuredDestination as McpLogDestination)
    : filePath
      ? "file"
      : "stderr";

  if ((destination === "file" || destination === "both") && !filePath) {
    return { destination: "stderr" };
  }

  return {
    destination,
    ...(filePath ? { filePath } : {})
  };
};

const createMcpLogDestination = (
  config: McpLogDestinationConfig
): DestinationStream => {
  if (config.destination === "stderr" || !config.filePath) {
    return pino.destination(2);
  }

  mkdirSync(dirname(config.filePath), { recursive: true });
  const fileDestination = pino.destination(config.filePath);
  if (config.destination === "file") {
    return fileDestination;
  }

  return pino.multistream([
    { stream: pino.destination(2) },
    { stream: fileDestination }
  ]) as unknown as DestinationStream;
};

// Exceptions can contain retrieved memory, provider responses or credentials in
// any property. Keep only explicitly approved numeric/status metadata, error
// class names, and codes from fixed allowlists. Any other string value, even
// one shaped like a code, is treated as content.
const ownValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};
const allowedErrorCodes = new Set([
  "ABORT_ERR",
  "EACCES",
  "EADDRINUSE",
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOENT",
  "ENOTFOUND",
  "EPERM",
  "EPIPE",
  "ERR_HTTP_HEADERS_SENT",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
const allowedTaskErrorCodes = new Set(["personal_route_changed"]);
const diagnosticError = (
  value: unknown,
  includeCause = true
): Record<string, unknown> => {
  const result: Record<string, unknown> = { type: "Error" };
  if (!value || typeof value !== "object") return result;
  try {
    // `name` is usually inherited from the class prototype. Read data
    // descriptors only, so no getter runs. Only class-shaped names (for
    // example MemoryApiError) are kept.
    let name: unknown;
    for (
      let target: object | null = value, depth = 0;
      target && depth < 8 && name === undefined;
      target = Object.getPrototypeOf(target) as object | null, depth += 1
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(target, "name");
      if (descriptor) name = "value" in descriptor ? descriptor.value : null;
    }
    if (
      typeof name === "string" &&
      /^(?:[A-Z][A-Za-z0-9]{0,58})?Error$/.test(name)
    )
      result.name = name;
    for (const key of ["status", "statusCode", "retryAfterMs"]) {
      const field = ownValue(value, key);
      if (typeof field === "number" && Number.isFinite(field))
        result[key] = field;
    }
    const code = ownValue(value, "code");
    if (typeof code === "string" && allowedErrorCodes.has(code))
      result.code = code;
    const taskCode = ownValue(value, "memoryAnswerTaskErrorCode");
    if (typeof taskCode === "string" && allowedTaskErrorCodes.has(taskCode))
      result.memoryAnswerTaskErrorCode = taskCode;
    const cause = ownValue(value, "cause");
    if (includeCause && cause && typeof cause === "object")
      result.cause = diagnosticError(cause, false);
  } catch {
    return { type: "Error" };
  }
  return result;
};
const contentKeys = new Set([
  "message",
  "stack",
  "cause",
  "payload",
  "query",
  "answer",
  "result",
  "input",
  "body",
  "request",
  "response",
  "retrievalHints",
  "retrieval",
  "trace",
  "apiToken",
  "token",
  "authorization"
]);
const boundedDiagnostic = (
  value: unknown,
  depth = 0,
  budget = { remaining: 24 }
): unknown => {
  if (--budget.remaining < 0) return "[Redacted]";
  if (value instanceof Error) return diagnosticError(value);
  if (depth >= 4) return "[Redacted]";
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value
      .slice(0, 16)
      .map((item) => boundedDiagnostic(item, depth + 1, budget));
  if (!value || typeof value !== "object") return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value)
  ).slice(0, 32)) {
    const item: unknown =
      "value" in descriptor ? descriptor.value : "[Redacted]";
    result[key.slice(0, 64)] =
      key === "err" || key === "error"
        ? diagnosticError(item)
        : contentKeys.has(key)
          ? "[Redacted]"
          : boundedDiagnostic(item, depth + 1, budget);
  }
  return result;
};

export const createMcpLogger = (
  service: string,
  options: {
    destination?: DestinationStream;
    environment?: NodeJS.ProcessEnv;
  } = {}
): Logger => {
  const environment = options.environment ?? process.env;
  const loggerOptions: LoggerOptions = {
    level: resolveMcpLogLevel(environment),
    serializers: { err: diagnosticError, error: diagnosticError },
    formatters: {
      log: (object) => {
        try {
          const metadata = boundedDiagnostic(object) as Record<string, unknown>;
          return Buffer.byteLength(JSON.stringify(metadata)) <= 4096
            ? metadata
            : { diagnostic: "metadata limit exceeded" };
        } catch {
          return { diagnostic: "[Redacted]" };
        }
      }
    },
    hooks: {
      logMethod(args, method) {
        if (args[0] instanceof Error) {
          method.call(
            this,
            { err: diagnosticError(args[0]) },
            typeof args[1] === "string"
              ? args[1].slice(0, 256)
              : "operation failed"
          );
          return;
        }
        const boundedArgs = args.map((arg) =>
          typeof arg === "string" ? arg.slice(0, 256) : arg
        );
        method.apply(this, boundedArgs as typeof args);
      }
    },
    base: {
      schema_version: mcpLogSchemaVersion,
      service,
      env: environment.NODE_ENV ?? "development"
    },
    redact: [
      "apiToken",
      "token",
      "authorization",
      "headers.authorization",
      "request.headers.authorization",
      "retrievalHints",
      "*.retrievalHints",
      "retrieval",
      "*.retrieval",
      "trace",
      "*.trace",
      "*.apiToken",
      "*.token",
      "*.authorization",
      "*.headers.authorization"
    ],
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return pino(
    loggerOptions,
    options.destination ??
      createMcpLogDestination(resolveMcpLogDestinationConfig(environment))
  );
};

export const logger = createMcpLogger("koed-mcp-server");
