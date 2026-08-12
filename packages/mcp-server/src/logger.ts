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
