import { describe, expect, it } from "vitest";
import {
  BACKGROUND_PRIORITY,
  EmbeddingPriorityScheduler,
  INTERACTIVE_PRIORITY,
  normalizeEmbeddingPriority
} from "./priority-scheduler.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const waitForSnapshot = async (
  scheduler: EmbeddingPriorityScheduler,
  expected: { interactive: number; background: number }
) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const snapshot = scheduler.snapshot();
    if (
      snapshot.waiting_interactive === expected.interactive &&
      snapshot.waiting_background === expected.background
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `scheduler waiters did not reach expected counts: ${JSON.stringify(
      scheduler.snapshot()
    )}`
  );
};

describe("EmbeddingPriorityScheduler", () => {
  it("normalizes unknown or blank priority to interactive", () => {
    expect(normalizeEmbeddingPriority(null)).toBe(INTERACTIVE_PRIORITY);
    expect(normalizeEmbeddingPriority("")).toBe(INTERACTIVE_PRIORITY);
    expect(normalizeEmbeddingPriority("unknown")).toBe(INTERACTIVE_PRIORITY);
    expect(normalizeEmbeddingPriority("question")).toBe(INTERACTIVE_PRIORITY);
    expect(normalizeEmbeddingPriority("foreground")).toBe(INTERACTIVE_PRIORITY);
    expect(normalizeEmbeddingPriority("background")).toBe(BACKGROUND_PRIORITY);
  });

  it("runs interactive waiters before background waiters and FIFO within rank", async () => {
    const scheduler = new EmbeddingPriorityScheduler();
    const releaseActive = deferred();
    const acquiredOrder: string[] = [];
    const active = scheduler.slot(BACKGROUND_PRIORITY, async () => {
      await releaseActive.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const background = scheduler.slot(BACKGROUND_PRIORITY, () => {
      acquiredOrder.push(BACKGROUND_PRIORITY);
    });
    await waitForSnapshot(scheduler, { interactive: 0, background: 1 });
    const interactiveOne = scheduler.slot("question", () => {
      acquiredOrder.push("interactive-1");
    });
    const interactiveTwo = scheduler.slot("foreground", () => {
      acquiredOrder.push("interactive-2");
    });
    await waitForSnapshot(scheduler, { interactive: 2, background: 1 });

    releaseActive.resolve();
    await Promise.all([active, background, interactiveOne, interactiveTwo]);

    expect(acquiredOrder).toEqual([
      "interactive-1",
      "interactive-2",
      BACKGROUND_PRIORITY
    ]);
  });
});
