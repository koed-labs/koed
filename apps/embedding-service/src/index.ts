import {
  loadEmbeddingServiceEnv,
  resolveEnv,
  verifyEmbeddingModelArtifact
} from "./env-config.js";
import { createEmbeddingLogger } from "./logging.js";
import { EmbeddingRuntime } from "./runtime.js";
import {
  createEmbeddingService,
  createNodeHttpServer,
  listenNodeHttpServer
} from "./server.js";

loadEmbeddingServiceEnv();
const config = resolveEnv();
const logger = createEmbeddingLogger(config.logLevel);
const runtime = new EmbeddingRuntime(config, logger);
let shutdownPromise: Promise<void> | null = null;
let server: ReturnType<typeof createNodeHttpServer> | null = null;

const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  const listening = server;
  shutdownPromise = Promise.all([
    listening
      ? new Promise<void>((resolve) => {
          listening.close(() => resolve());
          listening.closeIdleConnections();
        })
      : Promise.resolve(),
    runtime.shutdownRuntime()
  ]).then(() => undefined);
  return shutdownPromise;
};
const shutdownFromSignal = () => {
  void shutdown().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
// Registered before the model loads: a stop that arrives while llama-server
// is still starting must end it too, not leave it running on its own.
process.once("SIGINT", shutdownFromSignal);
process.once("SIGTERM", shutdownFromSignal);

const start = async (): Promise<void> => {
  await verifyEmbeddingModelArtifact(config);
  await runtime.loadEmbeddingModel();
  if (shutdownPromise) return;

  const service = createEmbeddingService(config, runtime, logger);
  server = createNodeHttpServer(service);
  await listenNodeHttpServer(server, config.host, config.port);
  logger.info("Embedding Service listening", {
    event: { name: "embedding.service.listening" },
    http: { host: config.host, port: config.port }
  });
};

start().catch(async (error: unknown) => {
  logger.error("Embedding Service startup failed", {
    event: { name: "embedding.service.startup_failed" },
    error: {
      type:
        error instanceof Error ? (error.constructor.name ?? "Error") : "Error"
    }
  });
  await runtime.shutdownRuntime();
  process.exitCode = 1;
});
