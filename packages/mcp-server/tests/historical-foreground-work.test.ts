import { describe, expect, it } from "vitest";
import {
  createHistoricalBatchScheduler,
  markForegroundWork
} from "../src/historical-ingestion-coordinator.js";

describe("historical batches and foreground work", () => {
  it("waits for a running Memory Answer before importing", async () => {
    const scheduler = createHistoricalBatchScheduler();
    const release = markForegroundWork();
    let ran = false;
    const batch = scheduler.runExclusive(async () => {
      ran = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(ran).toBe(false);
    release();
    await batch;
    expect(ran).toBe(true);
  });
});
