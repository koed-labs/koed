import { loadEmbeddingServiceEnv, resolveEnv } from "./env-config.js";
import { createEmbeddingLogger } from "./logging.js";
import { EmbeddingRuntime } from "./runtime.js";
import { createEmbeddingService, createNodeHttpServer } from "./server.js";

loadEmbeddingServiceEnv();
const config = resolveEnv();
const logger = createEmbeddingLogger(config.logLevel);
const runtime = new EmbeddingRuntime(config, logger);

const start = async (): Promise<void> => {
  await runtime.loadEmbeddingModel();
  await runtime.loadRerankerModel();

  const service = createEmbeddingService(config, runtime, logger);
  const server = createNodeHttpServer(service);
  server.listen(config.port, config.host, () => {
    logger.info("Embedding Service listening", {
      event: { name: "embedding.service.listening" },
      http: { host: config.host, port: config.port }
    });
  });

  const shutdown = () => {
    server.close();
    runtime.shutdownRuntime();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
};

start().catch((error: unknown) => {
  logger.error("Embedding Service startup failed", {
    event: { name: "embedding.service.startup_failed" },
    error: {
      type:
        error instanceof Error ? (error.constructor.name ?? "Error") : "Error",
      message: error instanceof Error ? error.message : String(error)
    }
  });
  runtime.shutdownRuntime();
  process.exitCode = 1;
});
