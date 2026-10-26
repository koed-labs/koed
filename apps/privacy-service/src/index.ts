import { createValidationCache } from "./validation-cache.js";
import { resolveConfig } from "./config.js";
import { PrivacyRuntimeManager } from "./runtime-manager.js";
import { createPrivacyRuntime } from "./runtime-factory.js";
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
  validationCache: await createValidationCache(
    config.transformersCache,
    undefined,
    config.runtimeEngine,
    config.cpuWorkers
  ),
  ...(config.runtimeEngine === "onnx-worker"
    ? { candidateProviders: ["cpu" as const] }
    : {}),
  acceleratorIdleUnloadSeconds: config.gpuIdleUnloadSeconds,
  factory: (provider) => createPrivacyRuntime(config, provider)
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
  const drainTimeout = setTimeout(() => server.closeAllConnections(), 5_000);
  drainTimeout.unref();
  server.close(() => {
    clearTimeout(drainTimeout);
    void runtime.dispose().finally(() => process.exit(0));
  });
  server.closeIdleConnections();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
