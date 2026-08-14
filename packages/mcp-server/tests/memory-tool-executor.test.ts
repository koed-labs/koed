import { describe, expect, it, vi } from "vitest";
import {
  MemoryToolExecutor,
  type MemoryToolExecutorServices
} from "../src/memory-tool-executor.js";
import type { MemoryApiClient } from "../src/index.js";

describe("MemoryToolExecutor", () => {
  it("records remote Team question identity as metadata without a local question foreign key", async () => {
    const recordTokenUsage = vi.fn(async (input: Record<string, unknown>) => {
      void input;
      return {};
    });
    const executor = new MemoryToolExecutor(
      { recordTokenUsage } as unknown as MemoryApiClient,
      {}
    );
    const remoteQuestionId = "11111111-1111-4111-8111-111111111111";
    const upstreamBackendId = "fixture-team-backend";
    await (
      executor as unknown as {
        recordTokenUsage(
          answer: unknown,
          input: unknown,
          projectId: string | undefined,
          question: { id: string },
          backendId: string
        ): Promise<void>;
      }
    ).recordTokenUsage(
      {
        localMemoryWorker: {
          jobId: "fixture-answer-job",
          model: "gpt-fixture",
          usedFallback: false,
          appServerExecutions: [
            {
              model: "gpt-fixture",
              tokenUsage: {
                last: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
              }
            }
          ]
        }
      },
      { query: "What changed?", search_domain: "global" },
      undefined,
      { id: remoteQuestionId },
      upstreamBackendId
    );

    expect(recordTokenUsage).toHaveBeenCalledTimes(1);
    const recordedUsage = recordTokenUsage.mock.calls[0]![0];
    expect(recordedUsage.questionId).toBeUndefined();
    expect(recordedUsage.metadata).toMatchObject({
      questionId: undefined,
      upstreamQuestionId: remoteQuestionId,
      upstreamBackendId
    });
  });

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
