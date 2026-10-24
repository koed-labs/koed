import { HuggingFacePrivacyRuntime } from "./runtime.js";
import { serveNativeRuntimeWorker } from "./native-runtime-worker-server.js";

serveNativeRuntimeWorker(
  ({ modelId, modelRevision, cacheDir, provider }) =>
    new HuggingFacePrivacyRuntime(
      modelId,
      modelRevision,
      cacheDir,
      undefined,
      undefined,
      provider
    )
);
