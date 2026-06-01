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

const validLogLevels = new Set<McpLogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent"
]);

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
      "*.apiToken",
      "*.token",
      "*.authorization",
      "*.headers.authorization"
    ],
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return pino(loggerOptions, options.destination ?? pino.destination(2));
};

export const logger = createMcpLogger("koed-mcp-server");
export const answerBridgeLogger = logger.child({
  service_component: "memory-answer-bridge"
});
