import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryApiClient,
  allTools,
  defaultTools,
  diagnosticMemoryTools,
  exposedTools,
  lowLevelMemoryTools,
  memoryAnswerToolDescription,
  memoryAccessCheck,
  memoryServerInstructions,
  requiredTools,
  resolveToolExposureConfig
} from "../src/index.js";
import {
  MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  answerWithMemoryWorker,
  compactMemoryAnswerPayload,
  resolveMemoryAnswerWorkerConfig,
  type CodexAnswerRunner
} from "../src/answer-worker.js";
import {
  resolveLcmSummaryServiceConfig,
  startLcmSummaryService
} from "../src/lcm-summary-service.js";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  type LcmSummaryNode
} from "../src/lcm-summary-worker.js";

const servers: http.Server[] = [];

const memoryAnswerObject = (answer_markdown: string) => ({
  schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  memory_status: "found",
  relevant_memory_found: true,
  answer_markdown,
  relevance_explanation: "The evidence directly supports the answer.",
  evidence: [
    {
      evidence_index: 0,
      source_id: "node-1",
      visibility: "personal",
      relevance: "directly supports the answer"
    }
  ],
  missing: [],
  missing_evidence: []
});

const lcmSummaryJson = (summary_text: string) =>
  JSON.stringify({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    summary_text,
    user_requests: [],
    decisions: [],
    facts: [summary_text],
    files: [],
    commands: [],
    model_names: [],
    tool_outcomes: [],
    errors: [],
    unresolved_questions: [],
    provenance_hints: []
  });

const createApi = async (handler: http.RequestListener): Promise<string> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

describe("MCP tool exposure", () => {
  it("exposes only memory_answer by default", () => {
    const config = resolveToolExposureConfig({} as NodeJS.ProcessEnv);

    expect([...defaultTools]).toEqual(["memory_answer"]);
    expect([...requiredTools]).toEqual(["memory_answer"]);
    expect(exposedTools(config)).toEqual(["memory_answer"]);
    expect(exposedTools(config)).not.toContain("memory_access_check");
    expect(exposedTools(config)).not.toContain("memory_search");
    expect(exposedTools(config)).not.toContain("memory_expand");
    expect(exposedTools(config)).not.toContain("memory_lcm_summarize_pending");
  });

  it("exposes diagnostic and low-level tools only through explicit env flags", () => {
    expect([...diagnosticMemoryTools]).toEqual(["memory_access_check"]);
    expect([...lowLevelMemoryTools]).toEqual([
      "memory_search",
      "memory_expand"
    ]);
    expect([...allTools]).not.toContain("memory_lcm_summarize_pending");

    expect(
      exposedTools(
        resolveToolExposureConfig({
          MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS: "true"
        } as NodeJS.ProcessEnv)
      )
    ).toEqual(["memory_answer", "memory_access_check"]);

    expect(
      exposedTools(
        resolveToolExposureConfig({
          MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS: "true"
        } as NodeJS.ProcessEnv)
      )
    ).toEqual(["memory_answer", "memory_search", "memory_expand"]);

    expect(
      exposedTools(
        resolveToolExposureConfig({
          MEMORY_EXPOSE_DIAGNOSTIC_MEMORY_TOOLS: "true",
          MEMORY_EXPOSE_LOW_LEVEL_MEMORY_TOOLS: "true"
        } as NodeJS.ProcessEnv)
      )
    ).toEqual([
      "memory_answer",
      "memory_access_check",
      "memory_search",
      "memory_expand"
    ]);
  });
});

describe("MCP memory_answer schema wording", () => {
  it("keeps the server instructions aligned with recall policy", () => {
    expect(memoryServerInstructions).toContain("prior conversations");
    expect(memoryServerInstructions).toContain("previous project decisions");
    expect(memoryServerInstructions).toContain("remembered preferences");
    expect(memoryServerInstructions).toContain("user-provided facts");
    expect(memoryServerInstructions).toContain("Default to project scope");
    expect(memoryServerInstructions).toContain("Use session scope");
    expect(memoryServerInstructions).toContain("Use global scope only");
    expect(memoryServerInstructions).toContain(
      "Do not keep querying memory after a clear not-found result"
    );
  });

  it("keeps the memory_answer tool description concise and scope-explicit", () => {
    expect(memoryAnswerToolDescription).toContain(
      "captured Codex conversations"
    );
    expect(memoryAnswerToolDescription).toContain(
      "remembered user preferences"
    );
    expect(memoryAnswerToolDescription).toContain("user-provided facts");
    expect(memoryAnswerToolDescription).toContain(
      "Default to search_domain=project"
    );
    expect(memoryAnswerToolDescription).toContain("search_domain=session");
    expect(memoryAnswerToolDescription).toContain("search_domain=global only");
    expect(memoryAnswerToolDescription).toContain(
      "do not repeat after a clear not-found answer"
    );
    expect(memoryAnswerToolDescription.length).toBeLessThan(1_000);
  });
});

describe("MemoryApiClient", () => {
  it("validates bearer token access through /v1/access/check", async () => {
    const apiUrl = await createApi((request, response) => {
      expect(request.headers.authorization).toBe("Bearer cmt_test");
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/memory/graph/overview") {
        response.end(
          JSON.stringify({
            overview: {
              pendingLcmDiagnostics: {
                pendingCount: 3,
                oldestPendingCreatedAt: null,
                staleThresholdMinutes: 15,
                stale: false
              }
            }
          })
        );
        return;
      }
      expect(request.method).toBe("GET");
      expect(request.url).toBe("/v1/access/check");
      response.end(
        JSON.stringify({
          ok: true,
          auth: "bearer_api_token",
          user: { id: "user-1", email: "solo@example.com", displayName: null },
          canWritePersonal: true,
          providerConfigSupported: false
        })
      );
    });

    const result = await memoryAccessCheck(
      new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
      false
    );

    expect(result.ok).toBe(true);
    expect(result.configuredApiUrl).toBe(apiUrl);
    expect(result.defaultAutomaticCaptureScope).toBe("personal");
    expect(result.defaultAnswerScope).toBe("personal");
    expect(result.localLcmSummaryDiagnostics.pendingCount).toBe(3);
    expect(result.localMemoryAnswerWorker.defaultResponseDetail).toBe(
      "answer_only"
    );
    expect(result.notes).toEqual([]);
  });

  it("keeps memory_answer scope personal when unsupported scope is configured", async () => {
    const apiUrl = await createApi((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/memory/graph/overview") {
        response.end(JSON.stringify({ overview: {} }));
        return;
      }
      response.end(
        JSON.stringify({
          ok: true,
          auth: "bearer_api_token",
          user: { id: "user-1", email: "solo@example.com", displayName: null },
          canWritePersonal: true,
          providerConfigSupported: false
        })
      );
    });

    const result = await memoryAccessCheck(
      new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
      false
    );

    expect(result.defaultAnswerScope).toBe("personal");

    vi.stubEnv("MEMORY_DEFAULT_RETRIEVAL_SCOPE", "shared");
    const configured = await memoryAccessCheck(
      new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
      false
    );
    expect(configured.defaultAnswerScope).toBe("personal");
  });

  it("posts raw conversation items for source adapters", async () => {
    const requests: unknown[] = [];
    const apiUrl = await createApi((request, response) => {
      response.setHeader("content-type", "application/json");
      expect(request.headers.authorization).toBe("Bearer cmt_test");
      if (
        request.method === "POST" &&
        request.url === "/v1/memory/conversation-items"
      ) {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          requests.push(parsed);
          response.end(
            JSON.stringify({
              items: [
                {
                  id: "00000000-0000-4000-8000-000000000001",
                  sessionId: null,
                  turnId: null,
                  sourceKind: "codex",
                  sourceAdapterVersion: "codex-app-server-v1",
                  sourceTransport: "app_server",
                  externalSessionId: "thread-1",
                  externalThreadId: "thread-1",
                  externalTurnId: "turn-1",
                  externalItemId: null,
                  sourceRecordType: "app_server_notification",
                  sourceEventType: "turn/completed",
                  sourceSequence: 0,
                  idempotencyKey: "raw-1",
                  createdAt: new Date().toISOString()
                }
              ]
            })
          );
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });

    const result = await new MemoryApiClient({
      apiUrl,
      apiToken: "cmt_test"
    }).createConversationItems({
      items: [
        {
          sourceKind: "codex",
          sourceAdapterVersion: "codex-app-server-v1",
          sourceTransport: "app_server",
          externalSessionId: "thread-1",
          externalThreadId: "thread-1",
          externalTurnId: "turn-1",
          sourceRecordType: "app_server_notification",
          sourceEventType: "turn/completed",
          sourceSequence: 0,
          rawJson: { method: "turn/completed" },
          sourceHash: "raw-1",
          idempotencyKey: "raw-1"
        }
      ]
    });

    expect(requests).toEqual([
      {
        items: [
          expect.objectContaining({
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            rawJson: { method: "turn/completed" }
          })
        ]
      }
    ]);
    expect((result.items as Record<string, unknown>[])[0]).toMatchObject({
      id: "00000000-0000-4000-8000-000000000001",
      sourceEventType: "turn/completed"
    });
  });
});

describe("LCM summary background service", () => {
  it("resolves a prompt budget above the default leaf token threshold", () => {
    expect(resolveLcmSummaryWorkerConfig({}).maxPromptTokens).toBe(48_000);
  });

  it("resolves conservative default cadence", () => {
    expect(resolveLcmSummaryServiceConfig({})).toEqual({
      initialDelayMs: 30_000,
      pushDelayMs: 10_000,
      intervalMs: 1_800_000,
      batchLimit: 2
    });
  });

  it("uses a single in-process summarisation run", async () => {
    let releasePending!: () => void;
    const pending = new Promise<void>((resolve) => {
      releasePending = resolve;
    });
    const fakeClient = {
      async listLocalMemoryAgentSettings() {
        return { settings: [] };
      },
      async listPendingLcmSummaries() {
        await pending;
        return { nodes: [] };
      }
    } as unknown as MemoryApiClient;

    const service = startLcmSummaryService(fakeClient, {
      serviceConfig: {
        initialDelayMs: 60_000,
        pushDelayMs: 10_000,
        intervalMs: 60_000,
        batchLimit: 2
      }
    });

    expect(service).not.toBeNull();
    const firstRun = service!.trigger("test");
    const secondRun = await service!.trigger("test");
    expect(secondRun).toEqual({
      ran: false,
      skippedReason: "already_running"
    });
    releasePending();
    expect(await firstRun).toMatchObject({ ran: true });
    service!.stop();
  });

  it("applies persisted LCM summary settings before startup env fallback", async () => {
    const fakeClient = {
      async listLocalMemoryAgentSettings() {
        return {
          settings: [
            {
              ownerUserId: "user-1",
              flowKey: "lcm_summary",
              provider: "codex",
              model: "gpt-5.4-persisted",
              reasoningEffort: "xhigh",
              timeoutMs: 123_000,
              maxAttempts: 4,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          ]
        };
      },
      async listPendingLcmSummaries() {
        return { nodes: [] };
      }
    } as unknown as MemoryApiClient;

    const service = startLcmSummaryService(fakeClient, {
      serviceConfig: {
        initialDelayMs: 60_000,
        pushDelayMs: 10_000,
        intervalMs: 60_000,
        batchLimit: 2
      },
      workerConfig: resolveLcmSummaryWorkerConfig(
        {},
        {
          model: "gpt-5.4-env-fallback",
          reasoningEffort: "medium",
          timeoutMs: 60_000,
          maxAttempts: 2
        }
      )
    });

    expect(service).not.toBeNull();
    const result = await service!.trigger("test");
    expect(result.result).toMatchObject({
      config: {
        model: "gpt-5.4-persisted",
        reasoningEffort: "xhigh",
        timeoutMs: 123_000,
        maxAttempts: 4
      }
    });
    service!.stop();
  });

  it("summarizes oversized nodes through token-bounded local map/reduce prompts", async () => {
    const node: LcmSummaryNode = {
      id: "node-large",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: `placeholder ${"Aston Villa and Paul McGrath ".repeat(
        2_000
      )}`,
      sourceTokenEstimate: null,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "event-large",
          actor: "user",
          text: "Aston Villa and Paul McGrath ".repeat(2_000),
          payload: { lcmSessionKey: "session-large" },
          position: 0
        }
      ]
    };
    const submissions: Record<string, unknown>[] = [];
    let listed = false;
    const fakeClient = {
      async listLocalMemoryAgentSettings() {
        return { settings: [] };
      },
      async listPendingLcmSummaries() {
        if (listed) {
          return { nodes: [] };
        }
        listed = true;
        return { nodes: [node] };
      },
      async submitLcmSummary(_nodeId: string, input: Record<string, unknown>) {
        submissions.push(input);
        return {};
      }
    } as unknown as MemoryApiClient;
    const config = resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: `/tmp/koed-lcm-test-${randomUUID()}.lock`
      },
      {
        model: "gpt-5.4-mini",
        maxPromptTokens: 1_500,
        maxAttempts: 1,
        retryDelayMs: 0,
        timeoutMs: 1_000
      }
    );

    const result = await summarizePendingLcmNodes(fakeClient, {
      limit: 1,
      config,
      runner: async (prompt) => ({
        text: prompt.includes("Combine these shard summaries")
          ? lcmSummaryJson(
              "Final summary: Aston Villa and Paul McGrath were discussed."
            )
          : lcmSummaryJson(
              "Shard summary: Aston Villa and Paul McGrath were discussed."
            ),
        model: "codex:test"
      })
    });

    expect(result.submittedCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      submitted: true,
      summaryModel: "codex:test"
    });
    expect(typeof result.results[0]?.promptCallCount).toBe("number");
    expect(result.results[0]?.promptCallCount).toBeGreaterThan(1);
    expect(result.results[0]?.maxPromptTokenEstimate).toBeLessThanOrEqual(
      config.maxPromptTokens
    );
    expect(submissions[0]).toMatchObject({
      summaryText:
        "Final summary: Aston Villa and Paul McGrath were discussed.",
      summaryModel: "codex:test",
      summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
    });
  });

  it("covers capture hook to local LCM summary to one-tool recall", async () => {
    const sessionId = randomUUID();
    const eventId = randomUUID();
    const nodeId = randomUUID();
    let captured = false;
    let submittedSummary: string | null = null;
    const apiUrl = await createApi((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/memory/capture-personal-event") {
        captured = true;
        response.end(
          JSON.stringify({
            event: {
              id: eventId,
              sessionId,
              workspaceId: "/repo/koed",
              visibility: "personal"
            }
          })
        );
        return;
      }
      if (request.url === "/v1/memory/lcm/summaries/pending?limit=1") {
        response.end(
          JSON.stringify({
            nodes: submittedSummary
              ? []
              : [
                  {
                    id: nodeId,
                    visibility: "personal",
                    kind: "leaf",
                    depth: 0,
                    summaryText:
                      "LCM placeholder: capture hook recorded that MVP recall uses memory_answer.",
                    sourceItems: [
                      {
                        kind: "memory_event",
                        sourceTable: "memory_events",
                        sourceId: eventId,
                        actor: "user",
                        text: "The MVP recall flow should use only memory_answer.",
                        position: 0
                      }
                    ],
                    sourceTokenEstimate: null
                  }
                ],
            count: submittedSummary ? 0 : 1
          })
        );
        return;
      }
      if (request.url === `/v1/memory/lcm/summaries/${nodeId}`) {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          submittedSummary =
            (JSON.parse(body) as { summaryText?: string }).summaryText ?? null;
          response.end(JSON.stringify({ nodeId }));
        });
        return;
      }
      if (request.url === "/v1/memory/answer") {
        response.end(
          JSON.stringify({
            markdown: "Evidence bundle returned for Codex synthesis.",
            evidence: submittedSummary
              ? [
                  {
                    nodeId,
                    visibility: "personal",
                    summaryText: submittedSummary,
                    citation: { nodeId, visibility: "personal" }
                  }
                ]
              : [],
            citations: submittedSummary
              ? [{ nodeId, visibility: "personal" }]
              : [],
            evidenceBundle: {
              query: "What is the MVP recall flow?",
              instructions: "Use only cited memory evidence.",
              evidence: submittedSummary
                ? [
                    {
                      nodeId,
                      visibility: "personal",
                      summaryText: submittedSummary,
                      citation: { nodeId, visibility: "personal" }
                    }
                  ]
                : [],
              retrieval: { retrievalMode: "semantic_vector" }
            }
          })
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    const client = new MemoryApiClient({ apiUrl, apiToken: "cmt_test" });

    await client.capturePersonalEvent({
      workspaceId: "/repo/koed",
      sessionId,
      actor: "user",
      eventType: "user_prompt",
      content: "The MVP recall flow should use only memory_answer."
    });
    expect(captured).toBe(true);

    const summary = await summarizePendingLcmNodes(client, {
      limit: 1,
      config: resolveLcmSummaryWorkerConfig(
        {
          MEMORY_LCM_SUMMARY_LOCK_PATH: `/tmp/koed-lcm-e2e-${randomUUID()}.lock`
        },
        { timeoutMs: 1_000, maxAttempts: 1 }
      ),
      runner: async () => ({
        text: lcmSummaryJson(
          "The MVP recall flow captures by hook, summarizes locally, and recalls through memory_answer."
        ),
        model: "codex:test"
      })
    });
    expect(summary.submittedCount).toBe(1);

    const evidence = await client.answer({
      query: "What is the MVP recall flow?",
      retrieval_scope: "personal",
      search_domain: "project",
      workspace_id: "/repo/koed",
      limit: 10
    });
    const runner: CodexAnswerRunner = async (_prompt, config) => ({
      text: JSON.stringify({
        action: "answer",
        answer: memoryAnswerObject(
          "The MVP flow captures by hook, summarizes locally, and recalls through memory_answer. [personal]"
        )
      }),
      model: `codex:${config.model}:${config.reasoningEffort}`
    });
    const answered = await answerWithMemoryWorker(evidence, {
      runner,
      client,
      retrievalScope: "personal",
      searchDomain: "project",
      workspaceId: "/repo/koed",
      limit: 10,
      config: {
        ...resolveMemoryAnswerWorkerConfig({
          MEMORY_ANSWER_PROVIDER: "codex",
          MEMORY_ANSWER_TIMEOUT_MS: "1000",
          MEMORY_ANSWER_MAX_ATTEMPTS: "1",
          MEMORY_ANSWER_MAX_SEARCHES: "1",
          MEMORY_ANSWER_MAX_EXPANSIONS: "0"
        }),
        cwd: "/tmp"
      }
    });
    const compact = compactMemoryAnswerPayload(answered);
    expect(compact.markdown).toContain("memory_answer");
    expect(compact.retrieval.evidenceCount).toBe(1);
    expect(compact).not.toHaveProperty("evidenceBundle");
  });
});
