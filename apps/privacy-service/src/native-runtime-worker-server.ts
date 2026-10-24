import { parentPort, workerData } from "node:worker_threads";
import type {
  NativeRuntimeWorkerConfig,
  NativeRuntimeRequest,
  NativeRuntimeResponse
} from "./native-runtime-worker-protocol.js";
import type { LoadablePrivacyRuntime } from "./runtime-manager.js";

/** The same dispatcher is used by the packaged worker and a blocking test fixture. */
export const serveNativeRuntimeWorker = (
  factory: (config: NativeRuntimeWorkerConfig) => LoadablePrivacyRuntime
): void => {
  if (!parentPort)
    throw new Error("Privacy native runtime requires a worker thread");
  const port = parentPort;
  const runtime = factory(workerData as NativeRuntimeWorkerConfig);
  let tail = Promise.resolve();
  port.on("message", (request: NativeRuntimeRequest) => {
    tail = tail.then(async () => {
      let response: NativeRuntimeResponse;
      try {
        let classification;
        switch (request.operation) {
          case "load":
            await runtime.load();
            break;
          case "classify":
            classification = await runtime.classify(request.text);
            break;
          case "unload":
            await runtime.unload?.();
            break;
          case "dispose":
            await runtime.dispose?.();
            break;
        }
        response = {
          id: request.id,
          ok: true,
          ready: runtime.isReady(),
          identity: {
            modelId: runtime.modelId,
            modelRevision: runtime.modelRevision,
            classifierHash: runtime.classifierHash,
            provider: runtime.provider
          },
          ...(classification ? { classification } : {})
        };
      } catch (error) {
        response = {
          id: request.id,
          ok: false,
          ready: runtime.isReady(),
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
      port.postMessage(response);
    });
  });
};
