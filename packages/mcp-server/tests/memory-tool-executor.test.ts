import { describe, expect, it, vi } from "vitest";
import {
  boundedDesktopAskConversationContext,
  MemoryToolExecutor,
  type MemoryToolExecutorServices
} from "../src/memory-tool-executor.js";
import type { MemoryApiClient } from "../src/index.js";

describe("MemoryToolExecutor", () => {
  it("bounds Desktop Ask context to the newest completed text-only turns", () => {
    const questions = Array.from({ length: 25 }, (_, index) => ({
      status: index === 24 ? "pending" : "answered",
      query: `Question ${index} ${"q".repeat(4_000)}`,
      answerMarkdown: `Answer ${index} ${"a".repeat(4_000)}`,
      evidence: [{ secret: `evidence-${index}` }],
      localMemoryWorker: { secret: `diagnostic-${index}` }
    }));

    const context = boundedDesktopAskConversationContext({ questions });

    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(20);
    expect(context.at(-1)?.question).toContain("Question 23");
    expect(context[0]?.question).not.toContain("Question 0 ");
    expect(
      context.reduce(
        (total, turn) =>
          total +
          Buffer.byteLength(turn.question) +
          Buffer.byteLength(turn.answer),
        0
      )
    ).toBeLessThanOrEqual(64 * 1024);
    expect(JSON.stringify(context)).not.toContain("evidence-");
    expect(JSON.stringify(context)).not.toContain("diagnostic-");
  });

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
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      listAiClientInstances: vi.fn(async () => ({
        instances: [],
        capabilitySnapshots: []
      }))
    } as unknown as MemoryApiClient;
    let observedOptions: {
      cwd: string | undefined;
      projectId: string | undefined;
      responseDetail: string | undefined;
    } | null = null;
    const answerWithMemoryWorker: NonNullable<
      MemoryToolExecutorServices["answerWithMemoryWorker"]
    > = async (_payload, options) => {
      if (!options) {
        throw new Error("worker options are required");
      }
      observedOptions = {
        cwd: options.config?.cwd,
        projectId: options.projectId,
        responseDetail: options.responseDetail
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
      projectId: "/work/requesting-project",
      responseDetail: "internal"
    });
  });

  it("keeps origin out of untrusted tool input", async () => {
    const executor = new MemoryToolExecutor({} as MemoryApiClient, {});

    await expect(
      executor.execute(
        "memory_answer",
        {
          query: "What changed?",
          search_domain: "global",
          origin: "desktop_ask"
        },
        { cwd: "/work/requesting-project" }
      )
    ).rejects.toThrow();
  });

  it("passes trusted Desktop origin and conversation context through the reusable path", async () => {
    const completePendingDesktopAsk = vi.fn(
      async (_questionId: string, input: Record<string, unknown>) => ({
        question: { id: "11111111-1111-4111-8111-111111111111", input }
      })
    );
    const client = {
      accessCheck: vi.fn(async () => ({})),
      completePendingDesktopAsk,
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      recordTokenUsage: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;
    const conversationContext = [
      { question: "What did we choose?", answer: "We chose option A." }
    ];
    let observedContext: unknown;
    const answerWithMemoryWorker: NonNullable<
      MemoryToolExecutorServices["answerWithMemoryWorker"]
    > = async (payload, options) => {
      observedContext = options?.conversationContext;
      return {
        ...payload,
        retrieval: { evidenceCount: 0 },
        localMemoryWorker: {
          jobId: "desktop-answer-job",
          model: null,
          provider: "codex",
          promptVersion: "test",
          displayMessage:
            "The Codex worker could not verify enough supporting Personal Memory evidence.",
          skippedReason: "disabled",
          usedFallback: true
        }
      };
    };
    const executor = new MemoryToolExecutor(
      client,
      {},
      { answerWithMemoryWorker }
    );

    await executor.executeMemoryAnswer(
      {
        include_evidence: false,
        limit: 10,
        query: "Why?",
        response_detail: "answer_only",
        retrieval_hints: {},
        search_domain: "global"
      },
      { cwd: "/work/requesting-project" },
      {
        conversationContext,
        origin: "desktop_ask",
        pendingQuestionId: "11111111-1111-4111-8111-111111111111"
      }
    );

    expect(observedContext).toEqual(conversationContext);
    expect(completePendingDesktopAsk).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "error",
        error_message:
          "The Codex worker could not verify enough supporting Personal Memory evidence."
      })
    );
  });

  it("creates a pending Desktop Ask turn before synthesis and returns display-safe detail", async () => {
    const callOrder: string[] = [];
    const question = {
      id: "11111111-1111-4111-8111-111111111111",
      askThreadId: "22222222-2222-4222-8222-222222222222",
      askTurnIndex: 0,
      query: "What did I decide?",
      answerMarkdown: null,
      errorMessage: null,
      status: "pending",
      createdAt: "2026-08-17T12:00:00.000Z",
      updatedAt: "2026-08-17T12:00:00.000Z",
      answeredAt: null
    } as const;
    const client = {
      createPendingDesktopAsk: vi.fn(async () => {
        callOrder.push("pending");
        return { question };
      }),
      accessCheck: vi.fn(async () => ({})),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      completePendingDesktopAsk: vi.fn(
        async (_questionId: string, input: Record<string, unknown>) => {
          callOrder.push("complete");
          return {
            question: {
              ...question,
              ...input,
              answerMarkdown: "You chose the Ask welcome page.",
              status: "answered"
            }
          };
        }
      ),
      getQuestion: vi.fn(async () => ({
        question: {
          ...question,
          answerMarkdown: "You chose the Ask welcome page.",
          status: "answered",
          updatedAt: "2026-08-17T12:00:01.000Z",
          answeredAt: "2026-08-17T12:00:01.000Z",
          evidence: [{ secret: "must not cross the display boundary" }],
          localMemoryWorker: { diagnostic: true }
        }
      })),
      recordTokenUsage: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;
    const answerWithMemoryWorker: NonNullable<
      MemoryToolExecutorServices["answerWithMemoryWorker"]
    > = async (payload) => {
      callOrder.push("synthesis");
      return {
        ...payload,
        markdown: "You chose the Ask welcome page.",
        retrieval: { evidenceCount: 0 },
        localMemoryWorker: {
          jobId: "desktop-answer-job",
          model: "gpt-test",
          provider: "codex",
          promptVersion: "test",
          usedFallback: false
        }
      };
    };
    const executor = new MemoryToolExecutor(
      client,
      {},
      { answerWithMemoryWorker }
    );

    const result = await executor.executeDesktopAsk(
      {
        idempotencyKey: "desktop-ask-request-1",
        query: question.query
      },
      { cwd: "/work" }
    );

    expect(callOrder).toEqual(["pending", "synthesis", "complete"]);
    expect(result).toEqual({
      question: {
        id: question.id,
        askThreadId: question.askThreadId,
        askTurnIndex: 0,
        query: question.query,
        answerMarkdown: "You chose the Ask welcome page.",
        errorMessage: null,
        status: "answered",
        createdAt: question.createdAt,
        updatedAt: "2026-08-17T12:00:01.000Z",
        answeredAt: "2026-08-17T12:00:01.000Z"
      }
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("diagnostic");
  });
});
