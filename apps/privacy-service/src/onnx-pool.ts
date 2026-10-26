import { ClassificationError } from "./errors.js";
import { PRIVACY_WINDOW_MAX_TOKENS } from "@koed/shared";
import {
  validateBatchInput,
  PRIVACY_SHORT_BATCH_POSITIONS,
  type PrivacyBatchInput,
  type PrivacyBatchOutput
} from "./inference-contract.js";
import type {
  PrivacyModelExecution,
  PrivacyRuntimeAvailability
} from "./runtime.js";

export interface PrivacyPoolWorker {
  load(): Promise<void>;
  isReady(): boolean;
  availability(): PrivacyRuntimeAvailability;
  inferWindow(
    ids: readonly number[],
    signal?: AbortSignal
  ): Promise<number[][]>;
  dispose(): Promise<void>;
  inferBatch?(
    rows: readonly PrivacyBatchInput[],
    signal?: AbortSignal
  ): Promise<PrivacyBatchOutput[]>;
}

type Job = {
  positions: number;
  execute(worker: PrivacyPoolWorker, signal: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
  group: AbortSignal | symbol;
  state: "queued" | "running" | "finished";
  resolve(value: unknown): void;
  reject(error: unknown): void;
  onAbort(): void;
};
type Slot = { worker: PrivacyPoolWorker; busy: boolean };

/** Two two-thread processes; round-robin ready windows across admitted requests. */
export class OnnxPoolExecution implements PrivacyModelExecution {
  readonly maximumConcurrentFields = 2 as const;
  private readonly slots: Slot[];
  private readonly queues = new Map<AbortSignal | symbol, Job[]>();
  private readonly shutdown = new AbortController();
  private readonly internalGroup = Symbol("startup");
  private outstanding = 0;
  private activePositions = 0;
  private loaded = false;
  private stopping = false;
  private failed = false;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly modelPath: string,
    factory: (onReady: () => void) => PrivacyPoolWorker
  ) {
    this.slots = Array.from({ length: 2 }, () => ({
      worker: factory(() => this.pump()),
      busy: false
    }));
  }

  get maximumConcurrentRequests(): 1 | 2 {
    return this.slots.filter((slot) => slot.worker.isReady()).length === 2
      ? 2
      : 1;
  }

  isReady(): boolean {
    return (
      this.loaded &&
      !this.stopping &&
      this.slots.some((slot) => slot.worker.isReady())
    );
  }

  availability(): PrivacyRuntimeAvailability {
    if (this.stopping) return "stopping";
    if (this.isReady()) return "ready";
    if (this.slots.some((slot) => slot.worker.availability() === "recovering"))
      return "recovering";
    return !this.loaded && !this.failed ? "loading" : "unavailable";
  }

  async load(modelPath: string): Promise<void> {
    if (modelPath !== this.modelPath || this.stopping || this.failed)
      throw this.error();
    if (this.loaded) return;
    this.loading ??= (async () => {
      try {
        for (const slot of this.slots) {
          if (this.stopping) throw this.error();
          await slot.worker.load();
        }
        if (this.stopping || this.slots.some((slot) => !slot.worker.isReady()))
          throw this.error();
        this.loaded = true;
      } catch {
        this.failed = true;
        await this.unload();
        throw this.error();
      }
    })();
    return this.loading;
  }

  infer(ids: readonly number[], signal?: AbortSignal): Promise<number[][]> {
    if (
      ids.length < 1 ||
      ids.length > PRIVACY_WINDOW_MAX_TOKENS ||
      ids.some((id) => !Number.isSafeInteger(id) || id < 0)
    )
      return Promise.reject(this.error());
    return this.enqueue(
      (worker, requestSignal) => worker.inferWindow(ids, requestSignal),
      ids.length,
      signal
    );
  }

  inferBatch(
    rows: readonly PrivacyBatchInput[],
    signal?: AbortSignal
  ): Promise<PrivacyBatchOutput[]> {
    const positions = validateBatchInput(rows) * rows.length;
    return this.enqueue(
      (worker, requestSignal) => {
        if (!worker.inferBatch) throw this.error();
        return worker.inferBatch(rows, requestSignal);
      },
      positions,
      signal
    );
  }

  private enqueue<T>(
    execute: (worker: PrivacyPoolWorker, signal: AbortSignal) => Promise<T>,
    positions: number,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    if (
      !this.isReady() ||
      this.outstanding >= 4 ||
      positions < 1 ||
      positions > PRIVACY_SHORT_BATCH_POSITIONS
    )
      return Promise.reject(this.error());
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    const group = signal ?? this.internalGroup;
    this.outstanding += 1;
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        positions,
        execute,
        signal: combined,
        group,
        state: "queued",
        resolve: (value) => resolve(value as T),
        reject,
        onAbort: () => {
          if (job.state !== "queued") return;
          const queue = this.queues.get(group);
          if (queue) {
            const index = queue.indexOf(job);
            if (index !== -1) queue.splice(index, 1);
            if (queue.length === 0) this.queues.delete(group);
          }
          job.state = "finished";
          combined.removeEventListener("abort", job.onAbort);
          this.outstanding -= 1;
          queueMicrotask(() => this.pump());
          reject(combined.reason);
        }
      };
      const queue = this.queues.get(group) ?? [];
      queue.push(job);
      this.queues.set(group, queue);
      combined.addEventListener("abort", job.onAbort, { once: true });
      this.pump();
    });
  }

  private pump(): void {
    if (!this.loaded || this.stopping) return;
    for (const slot of this.slots) {
      if (slot.busy || !slot.worker.isReady()) continue;
      const entry = this.queues.entries().next().value;
      if (!entry) return;
      const [group, queue] = entry;
      // Drain activation capacity before taking the next request's large batch.
      if (
        this.activePositions + queue[0]!.positions >
        PRIVACY_SHORT_BATCH_POSITIONS
      )
        return;
      const job = queue.shift()!;
      this.queues.delete(group);
      if (queue.length > 0) this.queues.set(group, queue);
      job.state = "running";
      slot.busy = true;
      this.activePositions += job.positions;
      const finish = (result: unknown, error?: unknown) => {
        job.state = "finished";
        job.signal.removeEventListener("abort", job.onAbort);
        slot.busy = false;
        this.outstanding -= 1;
        this.activePositions -= job.positions;
        // Dispatch already-waiting requests before this field can enqueue its next window.
        this.pump();
        if (result !== undefined) job.resolve(result);
        else job.reject(error ?? this.error());
      };
      try {
        void job.execute(slot.worker, job.signal).then(
          (result) => finish(result),
          (error) => finish(undefined, error)
        );
      } catch (error) {
        finish(undefined, error);
      }
    }
  }

  private error(): ClassificationError {
    return new ClassificationError("privacy CPU pool capacity unavailable");
  }

  async unload(): Promise<void> {
    this.stopping = true;
    this.shutdown.abort();
    await Promise.all(this.slots.map((slot) => slot.worker.dispose()));
  }
}
