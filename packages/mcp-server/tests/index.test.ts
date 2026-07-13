import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  resolveMemoryAnswerWorkerConfig
} from "../src/answer-worker.js";
import {
  resolveLcmSummaryWorkerConfigFromSettings,
  resolvePersistedLcmSummaryWorkerConfig,
  resolveLcmSummaryServiceConfig,
  startLcmSummaryService
} from "../src/lcm-summary-service.js";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  type LcmSummaryNode
} from "../src/lcm-summary-worker.js";
import {
  resolveProjectTeamWorkspaceLink,
  teamMemoryDogfoodEnabled
} from "../src/project-team-workspace-links.js";

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

const writeFakeMemoryAnswerAppServer = (directory: string): string => {
  const modulePath = path.join(directory, "fake-memory-answer-app-server.mjs");
  const scriptPath = path.join(directory, "fake-memory-answer-app-server");
  fs.writeFileSync(
    scriptPath,
    `#!/bin/sh
exec "${process.execPath}" "${modulePath}" "$@"
`,
    { mode: 0o700 }
  );
  fs.writeFileSync(
    modulePath,
    `
import readline from "node:readline";

const lineReader = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const threadId = "thread-index-memory-answer";
const turnId = "turn-index-memory-answer";

lineReader.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake", codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model, modelProvider: "openai", serviceTier: null, cwd: message.params.cwd, runtimeWorkspaceRoots: [], instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, reasoningEffort: null } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: null, completedAt: null, durationMs: null } } });
    send({ id: 9001, method: "item/tool/call", params: { threadId, turnId, callId: "call-scan", namespace: "koed_memory", tool: "scan", arguments: { query: "MVP recall flow", search_domain: "project", workspace_id: "/repo/koed" } } });
    return;
  }
  if (message.id === 9001) {
    send({ id: 9002, method: "item/tool/call", params: { threadId, turnId, callId: "call-search", namespace: "koed_memory", tool: "search", arguments: { query: "MVP recall flow", stage: "leaf_search", search_domain: "project", workspace_id: "/repo/koed", limit: 1 } } });
    return;
  }
  if (message.id === 9002) {
    const answer = ${JSON.stringify(
      memoryAnswerObject(
        "The MVP flow captures by hook, summarizes locally, and recalls through memory_answer. [personal]"
      )
    )};
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-final", delta: JSON.stringify(answer) } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000 } } });
    return;
  }
});
`,
    { mode: 0o600 }
  );
  return scriptPath;
};

const lcmSummaryJson = (summary_text: string) =>
  JSON.stringify({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: "Captured Memory Summary",
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

describe("Project Team Workspace dogfood mapping", () => {
  it("resolves Team Workspace mapping only from non-secret local config", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-mcp-ptw-"));
    const configPath = path.join(directory, "project-team-workspaces.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        links: [
          {
            projectRoot: "/repo/koed",
            teamWorkspaceId: "11111111-1111-4111-8111-111111111111",
            backendId: "dev_backend"
          }
        ]
      })
    );

    expect(
      teamMemoryDogfoodEnabled({
        KOED_TEAM_MEMORY_DOGFOOD: "1"
      } as NodeJS.ProcessEnv)
    ).toBe(true);
    expect(
      resolveProjectTeamWorkspaceLink("/repo/koed", {
        KOED_PROJECT_TEAM_WORKSPACE_LINKS_PATH: configPath
      } as NodeJS.ProcessEnv)
    ).toMatchObject({
      projectRoot: "/repo/koed",
      teamWorkspaceId: "11111111-1111-4111-8111-111111111111",
      backendId: "dev_backend"
    });
    expect(fs.readFileSync(configPath, "utf8")).not.toMatch(
      /token|secret|password|cookie|credential/i
    );
  });
});

describe("MemoryApiClient", () => {
  it("uses a scoped local-edge credential instead of the Personal API Token for upstream operations", async () => {
    let authorization = "";
    const apiUrl = await createApi((request, response) => {
      authorization = request.headers.authorization ?? "";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ hits: [] }));
    });
    const client = new MemoryApiClient({ apiUrl, apiToken: "personal-token" });

    await client.upstreamOperation(
      {
        upstreamBackendId: "team-vps",
        operationFamily: "team_workspace_read",
        method: "POST",
        path: "/v1/memory/search",
        body: { query: "team" }
      },
      "Koed-Device local-key:local-secret"
    );

    expect(authorization).toBe("Koed-Device local-key:local-secret");
  });
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
      batchLimit: 2,
      titleBatchLimit: 5,
      titleMinUserEvents: 3
    });
  });

  it("applies persisted LCM summary settings before env fallback for local memory processing", () => {
    const config = resolveLcmSummaryWorkerConfigFromSettings(
      {
        MEMORY_LCM_SUMMARY_MODEL: "gpt-env-fallback",
        MEMORY_LCM_SUMMARY_REASONING_EFFORT: "medium",
        MEMORY_LCM_SUMMARY_TIMEOUT_MS: "60000",
        MEMORY_LCM_SUMMARY_MAX_ATTEMPTS: "2"
      } as NodeJS.ProcessEnv,
      [
        {
          ownerUserId: "user-1",
          flowKey: "lcm_summary",
          provider: "codex",
          model: "gpt-persisted",
          reasoningEffort: "high",
          timeoutMs: 122_000,
          maxAttempts: 4,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    );

    expect(config).toMatchObject({
      model: "gpt-persisted",
      reasoningEffort: "high",
      timeoutMs: 122_000,
      maxAttempts: 4
    });
  });

  it("keeps explicit local memory CLI overrides ahead of persisted settings", () => {
    const config = resolveLcmSummaryWorkerConfigFromSettings(
      {
        MEMORY_LCM_SUMMARY_MODEL: "gpt-env-fallback",
        MEMORY_LCM_SUMMARY_REASONING_EFFORT: "medium"
      } as NodeJS.ProcessEnv,
      [
        {
          ownerUserId: "user-1",
          flowKey: "lcm_summary",
          provider: "codex",
          model: "gpt-persisted",
          reasoningEffort: "high",
          timeoutMs: 122_000,
          maxAttempts: 4,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      {
        model: "gpt-cli",
        reasoningEffort: "low",
        retryDelayMs: 17
      }
    );

    expect(config).toMatchObject({
      model: "gpt-cli",
      reasoningEffort: "low",
      timeoutMs: 122_000,
      maxAttempts: 4,
      retryDelayMs: 17
    });
  });

  it("falls back to env config when no persisted LCM settings exist", async () => {
    const fallback = resolveLcmSummaryWorkerConfig(
      {},
      {
        model: "gpt-startup-fallback",
        reasoningEffort: "medium",
        timeoutMs: 60_000,
        maxAttempts: 2
      }
    );
    const client = {
      async listLocalMemoryAgentSettings() {
        return { settings: [] };
      }
    };

    await expect(
      resolvePersistedLcmSummaryWorkerConfig(
        client as never,
        {} as NodeJS.ProcessEnv,
        {},
        fallback
      )
    ).resolves.toMatchObject({
      model: "gpt-startup-fallback",
      reasoningEffort: "medium",
      timeoutMs: 60_000,
      maxAttempts: 2
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
      async listPendingSessionTitles() {
        return { sessions: [] };
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
        batchLimit: 2,
        titleBatchLimit: 5,
        titleMinUserEvents: 3
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
      async listPendingSessionTitles() {
        return { sessions: [] };
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
        batchLimit: 2,
        titleBatchLimit: 5,
        titleMinUserEvents: 3
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
      lcmSummaries: {
        config: {
          model: "gpt-5.4-persisted",
          reasoningEffort: "xhigh",
          timeoutMs: 123_000,
          maxAttempts: 4
        }
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

  it("shapes memory_answer Team Workspace search requests without changing retrieval scope", async () => {
    const nodeId = randomUUID();
    const teamWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const searchBodies: Record<string, unknown>[] = [];
    const apiUrl = await createApi((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/memory/search") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          searchBodies.push(parsed);
          if (parsed.retrieval_stage === "score_scan") {
            response.end(
              JSON.stringify({
                retrieval: {
                  stages: [
                    {
                      name: "leaf_search",
                      countAboveThreshold: 1,
                      maxAllowed: 1
                    }
                  ]
                }
              })
            );
            return;
          }
          response.end(
            JSON.stringify({
              hits: [
                {
                  nodeId,
                  sourceId: nodeId,
                  visibility: "personal",
                  summaryText: "Team Workspace memory is available.",
                  citation: { nodeId, visibility: "personal" }
                }
              ],
              retrieval: { stage: parsed.retrieval_stage }
            })
          );
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-index-"));
    try {
      const answered = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "What did the Team decide?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
          client: new MemoryApiClient({ apiUrl, apiToken: "cmt_test" }),
          retrievalScope: "personal",
          searchDomain: "project",
          workspaceId: "/repo/koed",
          teamWorkspaceId,
          limit: 10,
          config: {
            ...resolveMemoryAnswerWorkerConfig({
              MEMORY_ANSWER_PROVIDER: "codex",
              MEMORY_ANSWER_TIMEOUT_MS: "1000",
              MEMORY_ANSWER_MAX_ATTEMPTS: "1",
              MEMORY_ANSWER_MAX_SEARCHES: "2",
              MEMORY_ANSWER_MAX_EXPANSIONS: "0",
              MEMORY_ANSWER_CODEX_BINARY:
                writeFakeMemoryAnswerAppServer(directory)
            }),
            cwd: "/tmp"
          }
        }
      );
      expect(answered.localMemoryWorker.usedFallback).toBe(false);
      expect(searchBodies).toHaveLength(2);
      expect(searchBodies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            retrieval_scope: "personal",
            team_workspace_id: teamWorkspaceId,
            workspace_id: "/repo/koed"
          })
        ])
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
      if (request.url === "/v1/memory/search") {
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
        });
        request.on("end", () => {
          const parsed = JSON.parse(body) as { retrieval_stage?: string };
          if (parsed.retrieval_stage === "score_scan") {
            response.end(
              JSON.stringify({
                retrieval: {
                  stages: [
                    {
                      name: "leaf_search",
                      countAboveThreshold: submittedSummary ? 1 : 0,
                      maxAllowed: submittedSummary ? 1 : 0
                    }
                  ]
                }
              })
            );
            return;
          }
          response.end(
            JSON.stringify({
              hits: submittedSummary
                ? [
                    {
                      nodeId,
                      sourceId: nodeId,
                      visibility: "personal",
                      summaryText: submittedSummary,
                      citation: { nodeId, visibility: "personal" }
                    }
                  ]
                : [],
              retrieval: { stage: parsed.retrieval_stage }
            })
          );
        });
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

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koed-index-"));
    try {
      const appServerBinary = writeFakeMemoryAnswerAppServer(directory);
      const answered = await answerWithMemoryWorker(
        {
          markdown: "",
          evidenceBundle: {
            query: "What is the MVP recall flow?",
            evidence: [],
            retrieval: { mode: "app_server_dynamic_tools" }
          }
        },
        {
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
              MEMORY_ANSWER_MAX_SEARCHES: "2",
              MEMORY_ANSWER_MAX_EXPANSIONS: "0",
              MEMORY_ANSWER_CODEX_BINARY: appServerBinary
            }),
            cwd: "/tmp"
          }
        }
      );
      const compact = compactMemoryAnswerPayload(answered);
      expect(compact.markdown).toContain("memory_answer");
      expect(compact.retrieval.evidenceCount).toBe(1);
      expect(compact).not.toHaveProperty("evidenceBundle");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
