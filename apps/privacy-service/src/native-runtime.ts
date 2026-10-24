import { Worker } from "node:worker_threads";
import { ClassificationError } from "./errors.js";
import { parseNativeRuntimeResponse } from "./native-runtime-worker-protocol.js";
import type {
  NativeRuntimeRequest,
  NativeRuntimeResponse,
  NativeRuntimeWorkerConfig
} from "./native-runtime-worker-protocol.js";
import type { LoadablePrivacyRuntime } from "./runtime-manager.js";
import type { RawPrivacyClassification } from "./runtime.js";

type Pending = {
  resolve: (response: NativeRuntimeResponse) => void;
  reject: (error: Error) => void;
};

/** Native model calls stay on a provider worker so HTTP health remains responsive. */
export class NativePrivacyRuntime implements LoadablePrivacyRuntime {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly provider: NativeRuntimeWorkerConfig["provider"];
  readonly classifierHash: string;
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private ready = false;
  private failure: Error | undefined;
  private disposed = false;
  private termination: Promise<number> | undefined;

  constructor(
    config: NativeRuntimeWorkerConfig & { classifierHash: string },
    workerUrl: URL = new URL("./native-runtime-worker.js", import.meta.url)
  ) {
    this.modelId = config.modelId;
    this.modelRevision = config.modelRevision;
    this.provider = config.provider;
    this.classifierHash = config.classifierHash;
    this.worker = new Worker(workerUrl, {
      workerData: {
        modelId: config.modelId,
        modelRevision: config.modelRevision,
        cacheDir: config.cacheDir,
        provider: config.provider
      } satisfies NativeRuntimeWorkerConfig
    });
    this.worker.on("message", (value: unknown) => {
      const response = parseNativeRuntimeResponse(value);
      if (!response) {
        this.failAndTerminate(
          new Error("Privacy native runtime sent an invalid response")
        );
        return;
      }
      const pending = this.pending.get(response.id);
      if (!pending) {
        this.failAndTerminate(
          new Error("Privacy native runtime sent an unexpected response")
        );
        return;
      }
      if (
        response.ok &&
        (response.identity.modelId !== this.modelId ||
          response.identity.modelRevision !== this.modelRevision ||
          response.identity.classifierHash !== this.classifierHash ||
          response.identity.provider !== this.provider)
      ) {
        const error = new Error("Privacy native runtime identity changed");
        this.failAndTerminate(error);
        return;
      }
      this.pending.delete(response.id);
      this.ready = response.ready;
      if (response.ok) pending.resolve(response);
      else {
        const error =
          response.error.name === "ClassificationError"
            ? new ClassificationError(response.error.message)
            : new Error(response.error.message);
        error.name = response.error.name;
        pending.reject(error);
      }
    });
    this.worker.once("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error)))
    );
    this.worker.once("exit", (code) =>
      this.fail(new Error(`Privacy native runtime worker exited (${code})`))
    );
  }

  private fail(error: Error): void {
    this.ready = false;
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  private terminateWorker(): void {
    this.termination ??= this.worker.terminate().catch(() => -1);
  }

  private failAndTerminate(error: Error): void {
    this.fail(error);
    this.terminateWorker();
  }

  private request(
    operation: NativeRuntimeRequest["operation"],
    text?: string
  ): Promise<NativeRuntimeResponse> {
    if (this.disposed)
      return Promise.reject(new Error("Privacy native runtime is disposed"));
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const message: NativeRuntimeRequest =
      operation === "classify"
        ? { id, operation, text: text ?? "" }
        : { id, operation };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  isReady(): boolean {
    return this.ready && !this.failure && !this.disposed;
  }

  isAlive(): boolean {
    return !this.failure && !this.disposed;
  }

  async load(): Promise<void> {
    await this.request("load");
  }

  async classify(text: string): Promise<RawPrivacyClassification> {
    const response = await this.request("classify", text);
    if (!response.ok || !response.classification) {
      throw new ClassificationError("privacy runtime omitted classification");
    }
    return response.classification;
  }

  async unload(): Promise<void> {
    this.ready = false;
    await this.request("unload");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.failAndTerminate(new Error("Privacy native runtime is disposed"));
  }
}
