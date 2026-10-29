import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  boundedDesktopAskConversationContext,
  MemoryToolExecutor,
  type MemoryToolExecutorServices
} from "../src/memory-tool-executor.js";
import type { MemoryApiClient } from "../src/index.js";
import { memoryAnswerInputSchema } from "../src/memory-tool-schemas.js";

describe("MemoryToolExecutor", () => {
  it.each([
    [undefined, false],
    ["with_citations", false],
    ["with_evidence", false],
    [undefined, true]
  ] as const)(
    "preserves caller detail %s / include_evidence=%s across blocking and task results",
    async (detail, includeEvidence) => {
      for (const route of ["blocking", "task"] as const) {
        const evidence = [
          { sourceId: "selected", summaryText: "Selected body" }
        ];
        const citations = [{ sourceId: "selected" }];
        const worker = {
          provider: "codex",
          promptVersion: "test",
          jobId: "detail-job",
          model: "fixture-model",
          usedFallback: false,
          tokenUsage: { last: { totalTokens: 1234 } },
          appServerExecutions: [
            { model: "fixture-model", threadId: "INTERNAL THREAD" }
          ]
        };
        const createFinalQuestion = vi.fn(
          async (input: Record<string, unknown>) => ({
            question: {
              id: "11111111-1111-4111-8111-111111111111",
              answerMarkdown: input.answer_markdown,
              evidence: input.evidence,
              citations: input.citations,
              retrieval: input.retrieval,
              localMemoryWorker: input.local_memory_worker,
              response: input.response
            }
          })
        );
        const client = {
          accessCheck: vi.fn(async () => ({})),
          listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
          recordTokenUsage: vi.fn(async () => ({})),
          createFinalQuestion
        } as unknown as MemoryApiClient;
        const executor = new MemoryToolExecutor(
          client,
          {},
          {
            answerWithMemoryWorker: async () => ({
              markdown: "The answer",
              structuredAnswer: undefined,
              evidenceBundle: {
                evidence,
                retrieval: { trace: "INTERNAL TRACE" }
              },
              citations,
              retrieval: { evidenceCount: 1 },
              localMemoryWorker: worker
            })
          }
        );
        const input = memoryAnswerInputSchema.parse({
          query: "What did we decide?",
          search_domain: "global",
          response_detail: detail,
          include_evidence: includeEvidence
        });
        const caller = { cwd: "/work/requesting-project" };
        const taskResult =
          route === "task"
            ? await executor.executeMemoryAnswerTask(
                input,
                caller,
                "22222222-2222-4222-8222-222222222222"
              )
            : undefined;
        const result =
          route === "blocking"
            ? await executor.execute("memory_answer", input, caller)
            : taskResult!.result;
        const withEvidence = detail === "with_evidence" || includeEvidence;
        expect(result.markdown).toBe("The answer");
        expect(result).not.toHaveProperty("evidenceBundle");
        expect(result.evidence).toEqual(withEvidence ? evidence : undefined);
        expect(result.citations).toEqual(
          withEvidence || detail === "with_citations" ? citations : undefined
        );
        expect(JSON.stringify(result)).not.toMatch(
          /INTERNAL|tokenUsage|appServerExecutions/
        );
        expect(
          route === "task"
            ? taskResult!.finalQuestion
            : createFinalQuestion.mock.calls[0]![0]
        ).toMatchObject({
          evidence,
          citations,
          local_memory_worker: worker,
          retrieval: { trace: "INTERNAL TRACE" }
        });
      }
    }
  );

  it.each([undefined, "unavailable-team-backend"])(
    "requires trusted task authority before direct Team retrieval with backend %s",
    async (backendId) => {
      const home = fs.mkdtempSync(
        path.join(os.tmpdir(), "koed-answer-detail-")
      );
      try {
        const client = {
          accessCheck: vi.fn(async () => ({})),
          listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] }))
        } as unknown as MemoryApiClient;
        const executor = new MemoryToolExecutor(client, { KOED_HOME: home });
        await expect(
          executor.execute(
            "memory_answer",
            {
              query: "What did the Team decide?",
              search_domain: "global",
              team_workspace_id: "11111111-1111-4111-8111-111111111111",
              team_backend_id: backendId
            },
            { cwd: "/work/requesting-project" }
          )
        ).rejects.toMatchObject({
          statusCode: 403,
          memoryAnswerTaskErrorCode: "team_task_authority_required"
        });
        expect(client.accessCheck).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  );

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

  it("records task worker usage while preparing the final question for its authoritative commit", async () => {
    const recordTokenUsage = vi.fn(async (input: Record<string, unknown>) => {
      void input;
      return {};
    });
    const executor = new MemoryToolExecutor(
      {
        recordTokenUsage,
        accessCheck: vi.fn(async () => ({})),
        listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] }))
      } as unknown as MemoryApiClient,
      {},
      {
        answerWithMemoryWorker: async () => ({
          markdown: "answer",
          retrieval: { evidenceCount: 1 },
          localMemoryWorker: {
            provider: "codex",
            promptVersion: "fixture",
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
        })
      }
    );
    const completed = await executor.executeMemoryAnswerTask(
      memoryAnswerInputSchema.parse({
        query: "What changed?",
        search_domain: "global"
      }),
      { cwd: "/fixture" },
      "task",
      undefined,
      undefined,
      { getExecutionAuthority: () => ({ scope: "personal" }) }
    );

    expect(recordTokenUsage).toHaveBeenCalledTimes(1);
    const recordedUsage = recordTokenUsage.mock.calls[0]![0];
    expect(recordedUsage.questionId).toBeUndefined();
    expect(recordedUsage.metadata).toMatchObject({
      questionId: undefined,
      answerJobId: "fixture-answer-job"
    });
    expect(completed.finalQuestion).toMatchObject({
      answer_markdown: "answer",
      local_memory_worker: { jobId: "fixture-answer-job" }
    });
  });

  it("returns matching memories with citations for a direct recall without a second AI Client run", async () => {
    const search = vi.fn(async () => ({
      hits: [
        {
          nodeId: "11111111-1111-4111-8111-111111111111",
          sourceType: "curated_memory",
          sourceId: "11111111-1111-4111-8111-111111111111",
          visibility: "personal",
          summaryText: "Keep answers short",
          occurredAt: "2026-10-01T09:00:00.000Z",
          score: 0.9,
          citation: {
            nodeId: "11111111-1111-4111-8111-111111111111",
            sourceType: "curated_memory",
            sourceId: "11111111-1111-4111-8111-111111111111",
            visibility: "personal"
          }
        },
        {
          nodeId: "22222222-2222-4222-8222-222222222222",
          visibility: "personal",
          summaryText: "No citation, so not offered",
          score: 0.8
        },
        {
          nodeId: "33333333-3333-4333-8333-333333333333",
          sourceType: "memory_event",
          sourceId: "33333333-3333-4333-8333-333333333333",
          visibility: "personal",
          summaryText: "How do I like my answers? Check memory?",
          score: 0.95,
          citation: {
            nodeId: "33333333-3333-4333-8333-333333333333",
            sourceType: "memory_event",
            sourceId: "33333333-3333-4333-8333-333333333333",
            visibility: "personal"
          }
        }
      ],
      retrieval: { semanticRetrievalComplete: true }
    }));
    const listLocalMemoryAgentSettings = vi.fn(async () => ({
      settings: []
    }));
    const answerWithMemoryWorker = vi.fn();
    const executor = new MemoryToolExecutor(
      {
        search,
        recordTokenUsage: vi.fn(async () => ({})),
        accessCheck: vi.fn(async () => ({})),
        listLocalMemoryAgentSettings
      } as unknown as MemoryApiClient,
      {},
      { answerWithMemoryWorker }
    );
    const completed = await executor.executeMemoryAnswerTask(
      {
        query: "How do I like my answers?",
        search_domain: "global",
        response_detail: "with_citations",
        direct_recall: true
      },
      { cwd: "/fixture" },
      "task",
      undefined,
      undefined,
      { getExecutionAuthority: () => ({ scope: "personal" }) }
    );
    expect(answerWithMemoryWorker).not.toHaveBeenCalled();
    expect(listLocalMemoryAgentSettings).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "How do I like my answers?",
        search_domain: "global",
        retrieval_scope: "personal"
      })
    );
    const markdown = String(completed.finalQuestion.answer_markdown);
    expect(markdown).toContain("Koed did not write an answer");
    expect(markdown).toContain(
      "[1] (saved memory, 2026-10-01) Keep answers short"
    );
    expect(markdown).not.toContain("No citation");
    expect(markdown).not.toContain("Check memory?");
    expect(completed.finalQuestion).toMatchObject({
      status: "answered",
      citations: [{ nodeId: "11111111-1111-4111-8111-111111111111" }],
      local_memory_worker: { provider: "koed", usedFallback: false }
    });
    expect(completed.result).toMatchObject({
      citations: [{ nodeId: "11111111-1111-4111-8111-111111111111" }]
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

  it("keeps remote Project paths as metadata without choosing the local execution directory", async () => {
    const client = {
      accessCheck: vi.fn(async () => ({})),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      listAiClientInstances: vi.fn(async () => ({
        instances: [],
        capabilitySnapshots: []
      }))
    } as unknown as MemoryApiClient;
    let observed: { cwd?: string; projectId?: string } | undefined;
    const executor = new MemoryToolExecutor(
      client,
      { KOED_HEADLESS_FUTURE_CAPTURE_ONLY: "1" },
      {
        answerWithMemoryWorker: async (_payload, options) => {
          observed = {
            cwd: options?.config?.cwd,
            projectId: options?.projectId
          };
          throw new Error("worker boundary reached");
        }
      }
    );
    const project = "C:\\projects\\sample";
    await expect(
      executor.execute(
        "memory_answer",
        {
          query: "What changed?",
          search_domain: "project",
          project_id: project
        },
        { cwd: project }
      )
    ).rejects.toThrow("worker boundary reached");
    expect(observed).toEqual({ cwd: process.cwd(), projectId: project });
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

  it("prepares an idempotent final question and result for atomic task completion", async () => {
    const persistedWorker = {
      jobId: "first-attempt-job",
      model: "fixture-model",
      provider: "codex" as const,
      promptVersion: "test",
      usedFallback: false
    };
    const client = {
      accessCheck: vi.fn(async () => ({})),
      createFinalQuestion: vi.fn(async () => ({
        question: {
          id: "11111111-1111-4111-8111-111111111111",
          answerMarkdown: "Persisted first-attempt answer",
          evidence: [],
          citations: [],
          retrieval: { evidenceCount: 0 },
          localMemoryWorker: persistedWorker,
          response: {
            markdown: "Persisted first-attempt answer",
            retrieval: { evidenceCount: 0 },
            localMemoryWorker: persistedWorker
          }
        }
      })),
      listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
      recordTokenUsage: vi.fn(async () => ({}))
    } as unknown as MemoryApiClient;
    const executor = new MemoryToolExecutor(
      client,
      {},
      {
        answerWithMemoryWorker: async (payload) => ({
          ...payload,
          markdown: "Different retry answer",
          retrieval: { evidenceCount: 0 },
          localMemoryWorker: {
            ...persistedWorker,
            jobId: "retry-job"
          }
        })
      }
    );

    const completed = await executor.executeMemoryAnswerTask(
      {
        include_evidence: false,
        limit: 10,
        query: "What did we decide?",
        response_detail: "answer_only",
        retrieval_hints: {},
        search_domain: "global"
      },
      { cwd: "/work/requesting-project" },
      "22222222-2222-4222-8222-222222222222"
    );

    expect(completed).toMatchObject({
      finalQuestion: {
        idempotency_key:
          "memory-answer-task:22222222-2222-4222-8222-222222222222",
        status: "answered",
        answer_markdown: "Different retry answer"
      },
      result: { markdown: "Different retry answer" }
    });
    expect(client.createFinalQuestion).not.toHaveBeenCalled();
  });

  it("terminally rejects a recovered task whose route is now Team-owned", async () => {
    const executor = new MemoryToolExecutor({} as MemoryApiClient, {});

    await expect(
      executor.executeMemoryAnswerTask(
        {
          include_evidence: false,
          limit: 10,
          query: "What did we decide?",
          response_detail: "answer_only",
          retrieval_hints: {},
          search_domain: "global",
          team_workspace_id: "11111111-1111-4111-8111-111111111111"
        },
        { cwd: "/work/requesting-project" },
        "22222222-2222-4222-8222-222222222222"
      )
    ).rejects.toMatchObject({
      memoryAnswerTaskErrorCode: "personal_route_changed",
      retryable: false
    });
  });

  it.each([false, true])(
    "executes a trusted Team task through its authoritative backend (injected=%s)",
    async (injected) => {
      const workspace = "11111111-1111-4111-8111-111111111111";
      let boundary = "signed-initial";
      const search = vi.fn(async () => ({ items: [] }));
      const expand = vi.fn(async () => ({ items: [] }));
      const createFinalQuestion = vi.fn();
      const client = {
        accessCheck: vi.fn(async () => ({})),
        listLocalMemoryAgentSettings: vi.fn(async () => ({ settings: [] })),
        recordTokenUsage: vi.fn(async () => ({})),
        createFinalQuestion,
        createFinalTeamQuestion: vi.fn(),
        teamMemorySearch: vi.fn(),
        teamMemoryAnswer: vi.fn(),
        search,
        expand
      } as unknown as MemoryApiClient;
      const answer = vi.fn<
        NonNullable<MemoryToolExecutorServices["answerWithMemoryWorker"]>
      >(async (payload, options) => {
        expect(payload.authorizationBoundary).toBe("signed-initial");
        expect(options?.config?.cwd).not.toBe("/untrusted/remote/path");
        expect(options?.teamWorkspaceId).toBe(workspace);
        await options!.client!.search({
          query: "decision",
          team_workspace_id: "forged-workspace",
          authorization_boundary: "forged-token"
        });
        boundary = "signed-renewed";
        await options!.client!.expand("node", {
          teamWorkspaceId: "forged-workspace",
          authorizationBoundary: "forged-token"
        });
        return {
          markdown: "Authorized Team answer",
          retrieval: { evidenceCount: 1 },
          localMemoryWorker: {
            provider: "codex",
            promptVersion: "test",
            jobId: "team-job",
            model: "fixture",
            usedFallback: false
          }
        };
      });
      const executor = new MemoryToolExecutor(
        client,
        {},
        { answerWithMemoryWorker: answer }
      );
      const input = memoryAnswerInputSchema.parse({
        query: "decision",
        search_domain: "global",
        team_workspace_id: workspace,
        team_backend_id: "remote"
      });
      const completed = await executor.executeMemoryAnswerTask(
        input,
        { cwd: "/untrusted/remote/path" },
        "22222222-2222-4222-8222-222222222222",
        undefined,
        undefined,
        {
          getExecutionAuthority: () => ({
            scope: "team",
            teamWorkspaceId: workspace,
            authorizationBoundary: boundary
          }),
          ...(injected ? { taskBackend: { search, expand } } : {})
        }
      );
      expect(search).toHaveBeenCalledWith({
        query: "decision",
        team_workspace_id: workspace,
        authorization_boundary: "signed-initial"
      });
      expect(expand).toHaveBeenCalledWith("node", {
        teamWorkspaceId: workspace,
        authorizationBoundary: "signed-renewed"
      });
      expect(completed).toMatchObject({
        finalQuestion: {
          team_workspace_id: workspace,
          retrieval_scope: "personal",
          status: "answered",
          answer_markdown: "Authorized Team answer"
        },
        result: { markdown: "Authorized Team answer" }
      });
      expect(createFinalQuestion).not.toHaveBeenCalled();
      expect(client.createFinalTeamQuestion).not.toHaveBeenCalled();
      expect(client.teamMemoryAnswer).not.toHaveBeenCalled();
      expect(JSON.stringify(completed)).not.toContain("signed-");
    }
  );

  it("rejects a Team request inconsistent with the trusted task Workspace", async () => {
    const executor = new MemoryToolExecutor({} as MemoryApiClient, {});
    await expect(
      executor.executeMemoryAnswerTask(
        memoryAnswerInputSchema.parse({
          query: "decision",
          search_domain: "global",
          team_workspace_id: "11111111-1111-4111-8111-111111111111"
        }),
        { cwd: "/remote" },
        "task",
        undefined,
        undefined,
        {
          getExecutionAuthority: () => ({
            scope: "team",
            teamWorkspaceId: "22222222-2222-4222-8222-222222222222",
            authorizationBoundary: "signed"
          })
        }
      )
    ).rejects.toMatchObject({
      memoryAnswerTaskErrorCode: "team_scope_changed",
      retryable: false
    });
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
