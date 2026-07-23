import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { describe, expect, it } from "vitest";
import { createWorkerQueueProducer } from "./queue.js";

const redisUrl = process.env.KOED_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

const connection = (url: string) => ({ url, maxRetriesPerRequest: null });

describeRedis("BullMQ priority integration", () => {
  it("runs newly arrived live work before sustained queued historical work", async () => {
    const queueName = `koed-priority-${randomUUID()}`;
    const producer = createWorkerQueueProducer<{ label: string }>(queueName, {
      backend: "bullmq",
      redisUrl: redisUrl!
    });
    const admin = new Queue(queueName, { connection: connection(redisUrl!) });
    const workers: Array<Worker<{ label: string }>> = [];
    let releaseFirst!: () => void;
    let signalFirstStarted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });

    try {
      for (let index = 0; index < 10; index += 1) {
        await producer.add(
          "historical",
          { label: `historical-${index}` },
          { priority: 20 }
        );
      }
      const processed: string[] = [];
      const completed = new Promise<void>((resolve, reject) => {
        const worker = new Worker<{ label: string }>(
          queueName,
          async (job) => {
            processed.push(job.data.label);
            if (processed.length === 1) {
              signalFirstStarted();
              await release;
            }
            if (processed.length === 11) resolve();
          },
          { connection: connection(redisUrl!) }
        );
        workers.push(worker);
        worker.on("error", reject);
      });

      await firstStarted;
      await producer.add("live", { label: "live" }, { priority: 5 });
      releaseFirst();
      await completed;

      expect(processed[0]).toBe("historical-0");
      expect(processed[1]).toBe("live");
      expect(processed.slice(2)).toEqual(
        Array.from({ length: 9 }, (_, index) => `historical-${index + 1}`)
      );
    } finally {
      releaseFirst();
      await Promise.all(workers.map((worker) => worker.close()));
      await producer.close();
      await admin.obliterate({ force: true });
      await admin.close();
    }
  }, 15_000);
});
