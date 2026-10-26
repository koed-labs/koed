import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  PINNED_PRIVACY_MODEL_FILES,
  PRIVACY_WINDOW_MAX_TOKENS
} from "@koed/shared";
import { ClassificationError } from "./errors.js";
import {
  validateBatchInput,
  validateBatchOutput,
  validLogits,
  type PrivacyBatchInput,
  type PrivacyBatchOutput
} from "./inference-contract.js";
import type { PrivacyModelExecution } from "./runtime.js";

export const ONNX_WORKER_PROTOCOL = 2;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
type WorkerProcess = ChildProcessByStdio<Writable, Readable, null>;
type Pending = {
  job: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

export interface OnnxWorkerOptions {
  threads?: number;
  startupTimeoutMs?: number;
  inferenceTimeoutMs?: number;
  onUnavailable?: () => void;
  /** Injection for focused protocol/lifecycle checks; never read from the environment. */
  spawnWorker?: (
    generation: string,
    modelPath: string,
    threads: number
  ) => WorkerProcess;
}

async function verifyModel(modelPath: string): Promise<void> {
  for (const file of PINNED_PRIVACY_MODEL_FILES) {
    const path = resolve(modelPath, file.path);
    const info = await stat(path);
    if (!info.isFile() || ("size" in file && info.size !== file.size)) {
      throw new ClassificationError(
        "privacy model artifact verification failed"
      );
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest("hex") !== file.sha256) {
      throw new ClassificationError(
        "privacy model artifact verification failed"
      );
    }
  }
}

/** One process, one outstanding bounded job. No request text or credentials cross IPC. */
export class OnnxWorkerExecution implements PrivacyModelExecution {
  private child: WorkerProcess | undefined;
  private generation = "";
  private pending: Pending | undefined;
  private buffer = Buffer.alloc(0);
  private ready = false;
  private failed = false;
  private closing: Promise<void> | undefined;
  private loading: Promise<void> | undefined;
  private childClosed = false;

  constructor(private readonly options: OnnxWorkerOptions = {}) {
    if (![1, 2, 4].includes(options.threads ?? 4)) {
      throw new Error("invalid privacy worker thread budget");
    }
  }

  isReady(): boolean {
    return this.ready && this.child !== undefined && !this.failed;
  }

  async load(modelPath: string): Promise<void> {
    if (this.isReady()) return;
    if (this.failed) throw this.error();
    if (!this.loading) {
      this.loading = this.start(modelPath).finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  private async start(modelPath: string): Promise<void> {
    try {
      await this.verifyAssets(modelPath);
      if (this.failed) throw this.error();
      this.generation = randomUUID();
      const generation = this.generation;
      const child = this.options.spawnWorker
        ? this.options.spawnWorker(
            generation,
            modelPath,
            this.options.threads ?? 4
          )
        : spawn(
            "/opt/koed-privacy/bin/python",
            [
              "-I",
              "-u",
              fileURLToPath(new URL("../worker/inference.py", import.meta.url)),
              modelPath,
              generation,
              String(this.options.threads ?? 4)
            ],
            {
              stdio: ["pipe", "pipe", "ignore"],
              env: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                LANG: "C.UTF-8",
                HOME: "/nonexistent",
                ORT_DISABLE_TELEMETRY: "1",
                OPENBLAS_NUM_THREADS: "1",
                OMP_NUM_THREADS: "1"
              }
            }
          );
      this.child = child;
      this.childClosed = false;
      const ready = this.expect(
        "ready",
        this.options.startupTimeoutMs ?? 90_000
      );
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.child === child && this.generation === generation)
          this.receive(chunk);
      });
      child.stdin.on("error", () => this.fail());
      child.once("error", () => this.fail());
      child.once("close", () => {
        this.childClosed = true;
        if (this.child === child) this.fail();
      });
      const metadata = await ready;
      if (
        metadata.engine !== "1.31.0" ||
        metadata.numpy !== "2.2.6" ||
        metadata.python !== "3.11.14"
      ) {
        throw this.error();
      }
      this.ready = true;
    } catch {
      this.fail();
      await this.stop();
      throw this.error();
    }
  }

  protected verifyAssets(modelPath: string): Promise<void> {
    return verifyModel(modelPath);
  }

  private error(): ClassificationError {
    // Native exception text, stderr and protocol payloads may contain private data.
    return new ClassificationError("privacy inference worker unavailable");
  }

  private expect(
    job: string,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    if (this.pending) throw this.error();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), timeoutMs);
      this.pending = { job, resolve, reject, timer };
    });
  }

  private receive(chunk: Buffer): void {
    try {
      if (this.buffer.length + chunk.length > MAX_FRAME_BYTES + 4)
        throw this.error();
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length < 4) return;
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw this.error();
      if (this.buffer.length < length + 4) return;
      // No unsolicited frames, trailing frames or response before dispatch.
      if (this.buffer.length !== length + 4 || !this.pending)
        throw this.error();
      const frame = JSON.parse(
        this.buffer.subarray(4).toString("utf8")
      ) as Record<string, unknown>;
      const pending = this.pending;
      if (
        !frame ||
        frame.protocol !== ONNX_WORKER_PROTOCOL ||
        frame.generation !== this.generation ||
        frame.job !== pending.job
      )
        throw this.error();
      this.buffer = Buffer.alloc(0);
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(frame);
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    const firstFailure = !this.failed;
    this.ready = false;
    this.failed = true;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(this.error());
    }
    this.buffer = Buffer.alloc(0);
    void this.stop();
    if (firstFailure) this.options.onUnavailable?.();
  }

  async infer(
    tokenIds: readonly number[],
    signal?: AbortSignal
  ): Promise<number[][]> {
    if (
      tokenIds.length === 0 ||
      tokenIds.length > PRIVACY_WINDOW_MAX_TOKENS ||
      tokenIds.some((id) => !Number.isSafeInteger(id) || id < 0)
    )
      throw this.error();
    return this.exchange(
      { tokenIds },
      (frame) => {
        if (!validLogits(frame.logits, tokenIds.length)) throw this.error();
        return frame.logits;
      },
      signal
    );
  }

  async inferBatch(
    rows: readonly PrivacyBatchInput[],
    signal?: AbortSignal
  ): Promise<PrivacyBatchOutput[]> {
    const paddedTokens = validateBatchInput(rows);
    return this.exchange(
      { rows },
      (frame) => {
        if (
          frame.paddedTokens !== paddedTokens ||
          !Array.isArray(frame.rows) ||
          frame.rows.length !== rows.length
        )
          throw this.error();
        const expected = new Map(rows.map((row) => [row.id, row]));
        const trimmed = frame.rows.map((row: unknown) => {
          if (
            !row ||
            typeof row !== "object" ||
            !("id" in row) ||
            typeof row.id !== "string" ||
            !("tokenLength" in row) ||
            row.tokenLength !== expected.get(row.id)?.tokenIds.length ||
            !("logits" in row) ||
            !validLogits(row.logits, paddedTokens)
          )
            throw this.error();
          return {
            id: row.id,
            logits: row.logits.slice(0, Number(row.tokenLength))
          };
        });
        return validateBatchOutput(rows, trimmed);
      },
      signal
    );
  }

  private async exchange<T>(
    body: object,
    validate: (frame: Record<string, unknown>) => T,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!this.isReady() || this.pending) throw this.error();
    const job = randomUUID();
    const result = this.expect(job, this.options.inferenceTimeoutMs ?? 60_000);
    const abort = () => this.fail();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const payload = Buffer.from(
        JSON.stringify({
          protocol: ONNX_WORKER_PROTOCOL,
          generation: this.generation,
          job,
          ...body
        })
      );
      if (payload.length > 65_536) throw this.error();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      this.child!.stdin.write(Buffer.concat([header, payload]));
      const frame = await result;
      signal?.throwIfAborted();
      return validate(frame);
    } catch {
      this.fail();
      await result.catch(() => undefined);
      await this.stop();
      signal?.throwIfAborted();
      throw this.error();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private stop(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.ready = false;
    this.closing = new Promise<void>((resolveClose) => {
      const done = () => {
        clearTimeout(timer);
        if (this.child === child) this.child = undefined;
        resolveClose();
      };
      const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      child.once("close", done);
      if (this.childClosed) done();
      else child.kill("SIGTERM");
    }).finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  async unload(): Promise<void> {
    this.fail();
    await this.loading?.catch(() => undefined);
    await this.stop();
  }
}
