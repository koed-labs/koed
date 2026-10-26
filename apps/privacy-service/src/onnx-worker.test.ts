import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  OnnxWorkerExecution,
  ONNX_WORKER_PROTOCOL,
  type OnnxWorkerOptions
} from "./onnx-worker.js";
import { randomUUID } from "node:crypto";
import type { PrivacyBatchInput } from "./inference-contract.js";

class SyntheticAssetsWorker extends OnnxWorkerExecution {
  protected override verifyAssets(): Promise<void> {
    return Promise.resolve();
  }
}

const frame = (value: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
};

function fixture(mode = "valid") {
  let process: EventEmitter & {
    stdout: PassThrough;
    stdin: Writable;
    kill(): boolean;
  };
  let job: Record<string, unknown> | undefined;
  let killed = 0;
  const spawnWorker: OnnxWorkerOptions["spawnWorker"] = (generation) => {
    const stdout = new PassThrough();
    const send = (value: unknown) => stdout.write(frame(value));
    process = Object.assign(new EventEmitter(), {
      stdout,
      stdin: new Writable({
        write(data: Buffer, _encoding, done) {
          job = JSON.parse(data.subarray(4).toString()) as Record<
            string,
            unknown
          >;
          const logits = ((job.tokenIds as number[] | undefined) ?? []).map(
            () => Array(33).fill(0)
          );
          const response: Record<string, unknown> = {
            protocol: ONNX_WORKER_PROTOCOL,
            generation,
            job: job.job,
            logits
          };
          if (job.rows) {
            const inputs = job.rows as PrivacyBatchInput[];
            const length = Math.max(
              ...inputs.map((row) => row.tokenIds.length)
            );
            response.paddedTokens = length;
            response.rows = inputs
              .map((row) => ({
                id: row.id,
                tokenLength: row.tokenIds.length,
                logits: Array.from({ length }, () => Array(33).fill(0))
              }))
              .reverse();
            const rows = response.rows as Array<{
              id: string;
              tokenLength: number;
              logits: number[][];
            }>;
            if (mode === "duplicate-row") rows[1]!.id = rows[0]!.id;
            if (mode === "missing-row") rows.pop();
            if (mode === "wrong-padding") response.paddedTokens = length + 1;
            if (mode === "wrong-length") rows[0]!.tokenLength += 1;
            if (mode === "bad-padding-values")
              rows[0]!.logits[length - 1]![0] = Infinity;
          }
          if (mode === "wrong-job") response.job = "another-job";
          if (mode === "wrong-generation") response.generation = "retired";
          if (mode === "bad-shape") response.logits = [[0]];
          if (mode === "non-finite") logits[0]![0] = Infinity;
          queueMicrotask(() => {
            if (mode === "stall") return;
            if (mode === "exit") {
              process.emit("close", 1);
              return;
            }
            if (mode === "oversized") {
              const header = Buffer.alloc(4);
              header.writeUInt32BE(2 * 1024 * 1024 + 1);
              stdout.write(header);
              return;
            }
            if (mode === "incomplete") {
              stdout.write(frame(response).subarray(0, 20));
              return;
            }
            // Deliberately split both the header and payload across deliveries.
            const output = frame(response);
            stdout.write(output.subarray(0, 2));
            stdout.write(output.subarray(2, 11));
            stdout.write(output.subarray(11));
          });
          done();
        }
      }),
      kill() {
        killed += 1;
        queueMicrotask(() => process.emit("close", null));
        return true;
      }
    });
    queueMicrotask(() =>
      send({
        protocol: ONNX_WORKER_PROTOCOL,
        generation,
        job: "ready",
        engine: "1.31.0",
        numpy: "2.2.6",
        python: "3.11.14"
      })
    );
    return process as ReturnType<NonNullable<OnnxWorkerOptions["spawnWorker"]>>;
  };
  const worker = new SyntheticAssetsWorker({
    spawnWorker,
    inferenceTimeoutMs: 20
  });
  return {
    worker,
    get killed() {
      return killed;
    },
    late() {
      process.stdout.write(frame({ ...job, logits: [[0]] }));
    }
  };
}

describe("bounded ONNX worker", () => {
  const batchRows = () => [
    { id: randomUUID(), tokenIds: [3, 4] },
    { id: randomUUID(), tokenIds: [5] }
  ];
  it("validates every padded batch row, restores row identity and trims before decoding", async () => {
    const { worker } = fixture();
    await worker.load("synthetic-assets");
    const rows = batchRows();
    expect(await worker.inferBatch(rows)).toEqual(
      rows.map((row) => ({
        id: row.id,
        logits: row.tokenIds.map(() => Array(33).fill(0))
      }))
    );
    await worker.unload();
  });
  it.each([
    "duplicate-row",
    "missing-row",
    "wrong-padding",
    "wrong-length",
    "bad-padding-values"
  ])("rejects %s for the whole batch", async (mode) => {
    const { worker } = fixture(mode);
    await worker.load("synthetic-assets");
    await expect(worker.inferBatch(batchRows())).rejects.toThrow();
    expect(worker.isReady()).toBe(false);
    await worker.unload();
  });
  it("validates framed output, preserves every row and stops its child", async () => {
    const { worker } = fixture();
    await worker.load("synthetic-assets");
    expect(worker.isReady()).toBe(true);
    expect(await worker.infer([3, 4])).toEqual([
      Array(33).fill(0),
      Array(33).fill(0)
    ]);
    await worker.unload();
    expect(worker.isReady()).toBe(false);
  });

  it.each([
    "wrong-job",
    "wrong-generation",
    "bad-shape",
    "non-finite",
    "oversized",
    "incomplete",
    "stall",
    "exit"
  ])("fails closed for %s without accepting late output", async (mode) => {
    const f = fixture(mode);
    await f.worker.load("synthetic-assets");
    await expect(f.worker.infer([3])).rejects.toThrow(
      "privacy inference worker unavailable"
    );
    expect(f.worker.isReady()).toBe(false);
    f.late();
    await expect(f.worker.infer([4])).rejects.toThrow();
    await f.worker.unload();
  });

  it("cancels active inference and rejects late output", async () => {
    const f = fixture("stall");
    await f.worker.load("synthetic-assets");
    const cancellation = new AbortController();
    const result = f.worker.infer([3], cancellation.signal);
    cancellation.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(f.killed).toBeGreaterThan(0);
    f.late();
    expect(f.worker.isReady()).toBe(false);
    await f.worker.unload();
  });
});
