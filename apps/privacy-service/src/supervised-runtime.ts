import { setTimeout as delay } from "node:timers/promises";
import { ClassificationError } from "./errors.js";
import type {
  PrivacyBatchInput,
  PrivacyBatchOutput
} from "./inference-contract.js";
import {
  parityOutput,
  type LoadablePrivacyRuntime,
  type ParityBaseline
} from "./runtime-manager.js";
import type {
  RawPrivacyClassification,
  PrivacyRuntimeAvailability
} from "./runtime.js";

type Factory = (onUnavailable: () => void) => LoadablePrivacyRuntime;
export interface PrivacyRecoveryOptions {
  now?: () => number;
  /** Injectable backoff for focused lifecycle checks, not an environment control. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onReady?: () => void;
}

/** CPU-only recovery. Failed requests are never replayed into a replacement. */
export class SupervisedPrivacyRuntime implements LoadablePrivacyRuntime {
  readonly modelId: string;
  readonly modelRevision: string;
  readonly classifierHash: string;
  readonly provider = "cpu" as const;
  private current: LoadablePrivacyRuntime;
  private baseline: ParityBaseline | undefined;
  private initialLoad: Promise<void> | undefined;
  private recovery: Promise<void> | undefined;
  private ready = false;
  private stopping = false;
  private readonly shutdown = new AbortController();
  private attempts: number[] = [];

  constructor(
    private readonly factory: Factory,
    private readonly options: PrivacyRecoveryOptions = {}
  ) {
    this.current = this.createRuntime();
    this.modelId = this.current.modelId;
    this.modelRevision = this.current.modelRevision;
    this.classifierHash = this.current.classifierHash;
  }

  private createRuntime(): LoadablePrivacyRuntime {
    const runtime = this.factory(() => {
      if (this.current === runtime && this.baseline && !this.stopping)
        this.startRecovery();
    });
    return runtime;
  }

  isReady(): boolean {
    return !this.stopping && this.ready && this.current.isReady();
  }

  get supportsBatch(): boolean {
    return this.current.supportsBatch ?? false;
  }

  async classifyFields(
    texts: readonly string[],
    onField: (index: number, field: RawPrivacyClassification) => void,
    signal?: AbortSignal,
    onProgress?: () => void
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.isReady() || !this.current.classifyFields)
      throw this.unavailable();
    const runtime = this.current;
    try {
      return await runtime.classifyFields!(texts, onField, signal, onProgress);
    } catch (error) {
      if (!runtime.isReady() && runtime === this.current) this.startRecovery();
      throw error;
    }
  }

  async inferBatch(
    rows: readonly PrivacyBatchInput[],
    signal?: AbortSignal
  ): Promise<PrivacyBatchOutput[]> {
    signal?.throwIfAborted();
    if (!this.isReady() || !this.current.inferBatch) throw this.unavailable();
    const runtime = this.current;
    try {
      return await runtime.inferBatch!(rows, signal);
    } catch (error) {
      if (!runtime.isReady() && runtime === this.current) this.startRecovery();
      throw error;
    }
  }

  availability(): PrivacyRuntimeAvailability {
    if (this.stopping) return "stopping";
    if (this.recovery) return "recovering";
    if (this.isReady()) return "ready";
    return this.baseline ? "unavailable" : "loading";
  }

  async load(): Promise<void> {
    if (this.stopping) throw this.unavailable();
    if (this.isReady()) return;
    if (this.baseline) throw this.unavailable();
    this.initialLoad ??= (async () => {
      try {
        await this.current.load();
        const baseline = await parityOutput(this.current);
        this.shutdown.signal.throwIfAborted();
        if (!this.current.isReady()) throw this.unavailable();
        this.baseline = baseline;
        this.ready = true;
        this.options.onReady?.();
      } catch {
        await this.current.dispose?.();
        throw this.unavailable();
      }
    })();
    return this.initialLoad;
  }

  async classify(
    text: string,
    signal?: AbortSignal,
    onProgress?: () => void
  ): Promise<RawPrivacyClassification> {
    signal?.throwIfAborted();
    if (!this.isReady()) throw this.unavailable();
    const runtime = this.current;
    try {
      return await runtime.classify(text, signal, onProgress);
    } catch (error) {
      if (!runtime.isReady() && runtime === this.current) this.startRecovery();
      throw error;
    }
  }

  private unavailable(): ClassificationError {
    return new ClassificationError("privacy inference capacity unavailable");
  }

  async inferWindow(
    tokenIds: readonly number[],
    signal?: AbortSignal
  ): Promise<number[][]> {
    signal?.throwIfAborted();
    if (!this.isReady() || !this.current.inferWindow) throw this.unavailable();
    const runtime = this.current;
    try {
      return await runtime.inferWindow!(tokenIds, signal);
    } catch (error) {
      if (!runtime.isReady() && runtime === this.current) this.startRecovery();
      throw error;
    }
  }

  private startRecovery(): void {
    this.ready = false;
    if (this.recovery || this.stopping) return;
    this.recovery = this.recover()
      .catch(() => {
        // Readiness remains false. Never expose source, tensors or native exceptions.
      })
      .finally(() => {
        this.recovery = undefined;
      });
  }

  private async recover(): Promise<void> {
    // Retiring processes must release resources before any replacement loads.
    await this.current.dispose?.();
    const now = this.options.now ?? Date.now;
    const wait =
      this.options.wait ??
      ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    this.attempts = this.attempts.filter((time) => now() - time < 300_000);
    while (!this.stopping && this.attempts.length < 3) {
      const backoff = [250, 1_000, 5_000][this.attempts.length]!;
      this.attempts.push(now());
      await wait(backoff, this.shutdown.signal);
      this.shutdown.signal.throwIfAborted();
      const candidate = this.createRuntime();
      this.current = candidate;
      try {
        if (
          candidate.provider !== "cpu" ||
          candidate.modelId !== this.modelId ||
          candidate.modelRevision !== this.modelRevision ||
          candidate.classifierHash !== this.classifierHash
        )
          throw this.unavailable();
        await candidate.load();
        const baseline = await parityOutput(candidate);
        this.shutdown.signal.throwIfAborted();
        if (
          !candidate.isReady() ||
          JSON.stringify(baseline) !== JSON.stringify(this.baseline)
        )
          throw this.unavailable();
        this.ready = true;
        this.options.onReady?.();
        return;
      } catch {
        await candidate.dispose?.();
      }
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.shutdown.abort();
    await this.current.dispose?.();
    await this.initialLoad?.catch(() => undefined);
    await this.recovery;
    await this.current.dispose?.();
  }
}
