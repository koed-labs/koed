import { describe, expect, it, vi } from "vitest";
import {
  MemoryToolExecutor,
  type MemoryToolExecutorServices
} from "../src/memory-tool-executor.js";
import type { MemoryApiClient } from "../src/index.js";

describe("MemoryToolExecutor", () => {
  it("runs Memory Answer from the requesting adapter cwd", async () => {
    const client = {
      accessCheck: vi.fn(async () => ({})),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] }))
    } as unknown as MemoryApiClient;
    let observedOptions: {
      cwd: string | undefined;
      projectId: string | undefined;
    } | null = null;
    const answerWithMemoryWorker: NonNullable<
      MemoryToolExecutorServices["answerWithMemoryWorker"]
    > = async (_payload, options) => {
      if (!options) {
        throw new Error("worker options are required");
      }
      observedOptions = {
        cwd: options.config?.cwd,
        projectId: options.projectId
      };
      throw new Error("worker boundary reached");
    };
    const executor = new MemoryToolExecutor(
      client,
      {},
      {
        answerWithMemoryWorker
      }
    );

    await expect(
      executor.execute(
        "memory_answer",
        { query: "What changed?", search_domain: "project" },
        { cwd: "/work/requesting-project" }
      )
    ).rejects.toThrow("worker boundary reached");
    expect(observedOptions).toEqual({
      cwd: "/work/requesting-project",
      projectId: "/work/requesting-project"
    });
  });
});
