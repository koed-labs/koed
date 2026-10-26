import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrivacyBatchInput } from "./inference-contract.js";
import { OnnxPoolExecution, type PrivacyPoolWorker } from "./onnx-pool.js";

type Work = { ids: readonly number[]; complete(): void; fail(): void };
class Worker implements PrivacyPoolWorker {
  ready = false;
  stopped = false;
  jobs: Work[] = [];
  constructor(readonly onReady: () => void) {}
  async load() {
    this.ready = true;
    this.onReady();
  }
  isReady() {
    return this.ready;
  }
  availability() {
    return this.ready ? ("ready" as const) : ("unavailable" as const);
  }
  inferWindow(
    ids: readonly number[],
    signal?: AbortSignal
  ): Promise<number[][]> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      this.jobs.push({
        ids,
        complete: () => {
          signal?.removeEventListener("abort", abort);
          resolve(ids.map((id) => [id]));
        },
        fail: () => {
          signal?.removeEventListener("abort", abort);
          this.ready = false;
          reject(new Error("worker failed"));
        }
      });
    });
  }
  async dispose() {
    this.stopped = true;
    this.ready = false;
  }
  async inferBatch(rows: readonly PrivacyBatchInput[], signal?: AbortSignal) {
    await this.inferWindow([rows.length], signal);
    return rows.map((row) => ({
      id: row.id,
      logits: row.tokenIds.map(() => Array(33).fill(0))
    }));
  }
}
const fixture = () => {
  const workers: Worker[] = [];
  const pool = new OnnxPoolExecution("/synthetic", (onReady) => {
    const worker = new Worker(onReady);
    workers.push(worker);
    return worker;
  });
  return { pool, workers };
};

describe("bounded fair CPU window pool", () => {
  it("bounds combined padded positions while preserving both workers for smaller ready jobs", async () => {
    const { pool, workers } = fixture();
    await pool.load("/synthetic");
    const rows = (tokens: number) =>
      Array.from({ length: 8 }, () => ({
        id: randomUUID(),
        tokenIds: Array(tokens).fill(1)
      }));
    const first = pool.inferBatch(rows(256)),
      second = pool.inferBatch(rows(256));
    expect(workers[0]!.jobs).toHaveLength(1);
    expect(workers[1]!.jobs).toHaveLength(0);
    workers[0]!.jobs[0]!.complete();
    await first;
    expect(workers[0]!.jobs).toHaveLength(2);
    workers[0]!.jobs[1]!.complete();
    await second;
    const small = pool.inferBatch(rows(128)),
      window = pool.infer(Array(512).fill(1));
    expect(workers[1]!.jobs).toHaveLength(1);
    workers[0]!.jobs[2]!.complete();
    workers[1]!.jobs[0]!.complete();
    await Promise.all([small, window]);
    await pool.unload();
  });
  it("dispatches independent fields to both workers and rotates waiting request groups", async () => {
    const { pool, workers } = fixture();
    await pool.load("/synthetic");
    const a = new AbortController(),
      b = new AbortController();
    const first = pool.infer([1], a.signal),
      second = pool.infer([2], a.signal);
    const third = pool.infer([3], b.signal),
      fourth = pool.infer([4], a.signal);
    expect(workers.map((worker) => worker.jobs[0]?.ids)).toEqual([[1], [2]]);
    await expect(pool.infer([5], b.signal)).rejects.toThrow(
      "capacity unavailable"
    );
    workers[0]!.jobs[0]!.complete();
    await first;
    expect(workers[0]!.jobs[1]!.ids).toEqual([3]);
    workers[1]!.jobs[0]!.complete();
    await second;
    expect(workers[1]!.jobs[1]!.ids).toEqual([4]);
    workers[0]!.jobs[1]!.complete();
    workers[1]!.jobs[1]!.complete();
    expect(await third).toEqual([[3]]);
    expect(await fourth).toEqual([[4]]);
    await pool.unload();
    expect(workers.every((worker) => worker.stopped)).toBe(true);
  });

  it("removes cancelled queued work without mixing another request's result", async () => {
    const { pool, workers } = fixture();
    await pool.load("/synthetic");
    const a = new AbortController(),
      b = new AbortController();
    const first = pool.infer([10], a.signal),
      second = pool.infer([20], b.signal);
    const queued = pool.infer([30], a.signal);
    a.abort();
    await expect(first).rejects.toThrow();
    await expect(queued).rejects.toThrow();
    workers[1]!.jobs[0]!.complete();
    expect(await second).toEqual([[20]]);
    expect(
      workers.flatMap((worker) => worker.jobs).some((job) => job.ids[0] === 30)
    ).toBe(false);
    await pool.unload();
  });

  it("reduces advertised capacity during recovery and resumes queued work only on validated readiness", async () => {
    const { pool, workers } = fixture();
    await pool.load("/synthetic");
    const first = pool.infer([1]),
      second = pool.infer([2]),
      queued = pool.infer([3]);
    workers[0]!.jobs[0]!.fail();
    await expect(first).rejects.toThrow();
    expect(pool.maximumConcurrentRequests).toBe(1);
    expect(workers[0]!.jobs).toHaveLength(1);
    workers[0]!.ready = true;
    workers[0]!.onReady();
    expect(workers[0]!.jobs[1]!.ids).toEqual([3]);
    expect(pool.maximumConcurrentRequests).toBe(2);
    workers[1]!.jobs[0]!.complete();
    workers[0]!.jobs[1]!.complete();
    await Promise.all([second, queued]);
    await pool.unload();
  });
});
