import { resolve } from "node:path";
import type { PrivacyServiceConfig } from "./config.js";
import type { PrivacyRuntimeProvider } from "./provider.js";
import type { LoadablePrivacyRuntime } from "./runtime-manager.js";
import {
  HuggingFacePrivacyRuntime,
  type PrivacyModelExecution
} from "./runtime.js";
import { OnnxWorkerExecution } from "./onnx-worker.js";
import { OnnxPoolExecution } from "./onnx-pool.js";
import { SupervisedPrivacyRuntime } from "./supervised-runtime.js";

export function createPrivacyRuntime(
  config: PrivacyServiceConfig,
  provider: PrivacyRuntimeProvider
): LoadablePrivacyRuntime {
  const create = (execution?: PrivacyModelExecution) =>
    new HuggingFacePrivacyRuntime(
      config.modelId,
      config.modelRevision,
      config.transformersCache,
      undefined,
      undefined,
      provider,
      execution
    );
  if (config.runtimeEngine !== "onnx-worker") return create();
  if (provider !== "cpu")
    throw new Error("packaged Privacy worker is CPU-only");
  if ((config.cpuWorkers ?? 2) === 1) {
    return new SupervisedPrivacyRuntime((onUnavailable) =>
      create(new OnnxWorkerExecution({ onUnavailable, threads: 4 }))
    );
  }
  const modelPath = resolve(
    config.transformersCache,
    ...config.modelId.split("/"),
    config.modelRevision
  );
  return create(
    new OnnxPoolExecution(
      modelPath,
      (onReady) =>
        new SupervisedPrivacyRuntime(
          (onUnavailable) =>
            create(new OnnxWorkerExecution({ onUnavailable, threads: 2 })),
          { onReady }
        )
    )
  );
}
