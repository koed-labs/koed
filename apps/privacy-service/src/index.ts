import { createValidationCache } from "./validation-cache.js";
import { resolveConfig } from "./config.js";
import { PrivacyRuntimeManager } from "./runtime-manager.js";
import { HuggingFacePrivacyRuntime } from "./runtime.js";
import {
  createNodeHttpServer,
  createPrivacyService,
  listenNodeHttpServer
} from "./server.js";

const config = resolveConfig();
const startupStartedAt = performance.now();
const reportStartup = (stage: string) => {
  process.stdout.write(
    `${JSON.stringify({ event: "privacy.startup", stage, elapsedMs: Math.round(performance.now() - startupStartedAt) })}\n`
  );
};
if (!config.token) {
  throw new Error("PRIVACY_SERVICE_TOKEN is required");
}
if (!config.controlToken) {
  throw new Error("PRIVACY_RUNTIME_CONTROL_TOKEN is required");
}

reportStartup("initialization_started");
const runtime = await PrivacyRuntimeManager.create({
  onStartupProgress: reportStartup,
  preference: config.runtimeProvider,
  validationCache: await createValidationCache(config.transformersCache),
  acceleratorIdleUnloadSeconds: config.gpuIdleUnloadSeconds,
  factory: (provider) =>
    new HuggingFacePrivacyRuntime(
      config.modelId,
      config.modelRevision,
      config.transformersCache,
      undefined,
      undefined,
      provider
    )
});
const server = createNodeHttpServer(
  createPrivacyService(config, runtime),
  config.maxBodyBytes
);
await listenNodeHttpServer(server, config.host, config.port);
reportStartup("listening");
process.stdout.write(
  `Privacy Service listening on http://${config.host}:${config.port}\n`
);

const shutdown = () => {
  server.close(() => {
    void runtime.dispose().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
