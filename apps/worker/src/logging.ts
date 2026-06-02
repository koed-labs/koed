import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions
} from "pino";

export const workerLogSchemaVersion = "worker_log_v1";
export const workerServiceName = "koed-worker";

export type WorkerLogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "silent";

export type WorkerLogDestination = "stderr" | "file" | "both";

const validLogLevels = new Set<WorkerLogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent"
]);

const validLogDestinations = new Set<WorkerLogDestination>([
  "stderr",
  "file",
  "both"
]);

export interface WorkerLogDestinationConfig {
  destination: WorkerLogDestination;
  filePath?: string;
}

export interface WorkerLoggerConfig {
  nodeEnv: string;
  logLevel: WorkerLogLevel;
  logDestination: WorkerLogDestinationConfig;
}

export const resolveWorkerLogLevel = (
  environment: NodeJS.ProcessEnv = process.env
): WorkerLogLevel => {
  const configured = (
    environment.WORKER_LOG_LEVEL ??
    (environment.NODE_ENV === "test" ? "silent" : "info")
  )
    .trim()
    .toLowerCase();
  return validLogLevels.has(configured as WorkerLogLevel)
    ? (configured as WorkerLogLevel)
    : "info";
};

const expandLogFilePath = (value: string): string => {
  const expanded = value.startsWith("~/")
    ? `${homedir()}${value.slice(1)}`
    : value;
  return resolve(expanded);
};

export const resolveWorkerLogDestinationConfig = (
  environment: NodeJS.ProcessEnv = process.env
): WorkerLogDestinationConfig => {
  const configuredDestination =
    environment.WORKER_LOG_DESTINATION?.trim().toLowerCase();
  const configuredFilePath = environment.WORKER_LOG_FILE?.trim();
  const filePath = configuredFilePath
    ? expandLogFilePath(configuredFilePath)
    : undefined;
  const destination = validLogDestinations.has(
    configuredDestination as WorkerLogDestination
  )
    ? (configuredDestination as WorkerLogDestination)
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

const createWorkerLogDestination = (
  config: WorkerLogDestinationConfig
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

export const createWorkerLogger = (
  config: WorkerLoggerConfig,
  options: {
    destination?: DestinationStream;
  } = {}
): Logger => {
  const loggerOptions: LoggerOptions = {
    level: config.logLevel,
    base: {
      schema_version: workerLogSchemaVersion,
      service: workerServiceName,
      env: config.nodeEnv
    },
    redact: [
      "apiToken",
      "token",
      "authorization",
      "headers.authorization",
      "*.apiToken",
      "*.token",
      "*.authorization",
      "*.headers.authorization"
    ],
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return pino(
    loggerOptions,
    options.destination ?? createWorkerLogDestination(config.logDestination)
  );
};
