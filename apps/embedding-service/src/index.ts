import { loadEmbeddingServiceEnv, resolveEnv } from "./env-config.js";
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

const start = async (): Promise<void> => {
  await runtime.loadEmbeddingModel();
  await runtime.loadRerankerModel();

  const service = createEmbeddingService(config, runtime, logger);
  const server = createNodeHttpServer(service);
  await listenNodeHttpServer(server, config.host, config.port);
  logger.info("Embedding Service listening", {
    event: { name: "embedding.service.listening" },
    http: { host: config.host, port: config.port }
  });

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = Promise.all([
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
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
  process.once("SIGINT", shutdownFromSignal);
  process.once("SIGTERM", shutdownFromSignal);
};

start().catch(async (error: unknown) => {
  logger.error("Embedding Service startup failed", {
    event: { name: "embedding.service.startup_failed" },
    error: {
      type:
        error instanceof Error ? (error.constructor.name ?? "Error") : "Error",
      message: error instanceof Error ? error.message : String(error)
    }
  });
  await runtime.shutdownRuntime();
  process.exitCode = 1;
});
