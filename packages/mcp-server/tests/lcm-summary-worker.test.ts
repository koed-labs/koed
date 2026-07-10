import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  buildLcmSummaryPrompt,
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  type LcmSummaryNode
} from "../src/lcm-summary-worker.js";
import { CodexAppServerTurnError } from "../src/codex-app-server-runner.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

const tempLockPath = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koed-lcm-test-"));
  tempDirs.push(directory);
  return path.join(directory, "lcm-summary.lock");
};

const summaryJson = (summary_text: string) =>
  JSON.stringify({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: "Structured LCM Details",
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

it("persists the loaded LCM prompt version for operator overrides", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koed-lcm-prompts-"));
  tempDirs.push(directory);
  await writeFile(
    path.join(directory, "lcm-summary-leaf.md"),
    [
      "---",
      "id: lcm-summary-leaf",
      "version: operator-leaf-v9",
      "---",
      "Summarize this leaf using the required JSON schema."
    ].join("\n")
  );
  vi.stubEnv("KOED_PROMPT_DIR", directory);

  const node: LcmSummaryNode = {
    id: "00000000-0000-4000-8000-000000000051",
    visibility: "personal",
    kind: "leaf",
    depth: 0,
    summaryText: "placeholder",
    sourceTokenEstimate: 20,
    sourceItems: [
      {
        kind: "memory_event",
        sourceId: "00000000-0000-4000-8000-000000000052",
        text: "The User prefers operator-controlled prompt files."
      }
    ]
  };
  const submissions: Record<string, unknown>[] = [];
  let listed = false;
  const client = {
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
  } as unknown as Parameters<typeof summarizePendingLcmNodes>[0];

  const result = await summarizePendingLcmNodes(client, {
    limit: 1,
    config: resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
      },
      {
        maxAttempts: 1,
        retryDelayMs: 0,
        timeoutMs: 1_000
      }
    ),
    runner: async (prompt) => {
      expect(prompt).toContain(
        "Summarize this leaf using the required JSON schema."
      );
      return {
        text: summaryJson("The User prefers operator-controlled prompts."),
        model: "codex:test"
      };
    }
  });

  expect(result.submittedCount).toBe(1);
  expect(submissions).toEqual([
    expect.objectContaining({
      summaryPromptVersion: "operator-leaf-v9"
    })
  ]);
});

describe("LCM summary worker", () => {
  it("uses the structured summary contract for leaf, rollup, partial, and reduce prompts", () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000031",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 100,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "00000000-0000-4000-8000-000000000032",
          text: "User asked to preserve structured LCM details."
        }
      ]
    };

    for (const mode of ["summary", "partial", "reduce"] as const) {
      const prompt = buildLcmSummaryPrompt(node, mode);
      expect(prompt).toContain(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION);
      expect(prompt).toContain('"title"');
      expect(prompt).toContain('"summary_text"');
      expect(prompt).toContain('"user_requests"');
      expect(prompt).toContain('"decisions"');
      expect(prompt).toContain('"provenance_hints"');
      expect(prompt).toContain("Do not reproduce API tokens");
      expect(prompt).toContain(
        "redaction rule overrides the instruction to preserve exact identifiers"
      );
      expect(prompt).toContain("Return only one JSON object");
    }

    const rollupPrompt = buildLcmSummaryPrompt({ ...node, kind: "rollup" });
    expect(rollupPrompt).toContain("Roll up these child LCM summaries");
    expect(rollupPrompt).toContain(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION);
    expect(rollupPrompt).toContain("Do not reproduce API tokens");
    expect(rollupPrompt).toContain(
      "When ordered source items or child summaries conflict, prefer the later item"
    );
    expect(rollupPrompt).toContain(
      "older conflicting items only as superseded context"
    );

    const reducePrompt = buildLcmSummaryPrompt(node, "reduce");
    expect(reducePrompt).toContain(
      "When ordered source items or child summaries conflict, prefer the later item"
    );
  });

  it("keeps payload metadata out of LCM prompts while preserving source anchors", () => {
    const prompt = buildLcmSummaryPrompt({
      id: "00000000-0000-4000-8000-000000000041",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 12,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "00000000-0000-4000-8000-000000000042",
          actor: "agent",
          turnId: "00000000-0000-4000-8000-000000000043",
          createdAt: "2026-05-29T00:00:00.000Z",
          text: "Agent decided to keep LCM boundaries aligned to semantic memory events.",
          payload: {
            metadata: {
              rawTranscriptPayload: "noisy raw metadata ".repeat(500)
            }
          }
        }
      ]
    });

    expect(prompt).toContain(
      "Agent decided to keep LCM boundaries aligned to semantic memory events."
    );
    expect(prompt).toContain("source:memory_events");
    expect(prompt).toContain("turn:00000000-0000-4000-8000-000000000043");
    expect(prompt).not.toContain("rawTranscriptPayload");
    expect(prompt).not.toContain("noisy raw metadata");
  });

  it("submits rollup summaries through the same local runner path", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000011",
      visibility: "personal",
      kind: "rollup",
      depth: 1,
      summaryText: "rollup placeholder",
      sourceTokenEstimate: 1_200,
      sourceItems: [
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000000012",
          text: "Child summary says the project moved memory answers to app-server mode."
        },
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000000013",
          text: "Child summary says browser questions still use the local bridge."
        }
      ]
    };
    const submitted: unknown[] = [];
    const rawItemRequests: unknown[] = [];
    const tokenUsageRequests: unknown[] = [];
    const operations: string[] = [];
    const tokenConversationItemId = "00000000-0000-4000-8000-000000000099";
    const client = {
      async listPendingLcmSummaries() {
        return submitted.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async createConversationItems(input: unknown) {
        operations.push("raw");
        rawItemRequests.push(input);
        const items = (
          input as { items?: Array<{ sourceEventType?: string }> }
        ).items?.map((item) => ({
          id:
            item.sourceEventType === "thread/tokenUsage/updated"
              ? tokenConversationItemId
              : "00000000-0000-4000-8000-000000000098",
          sourceEventType: item.sourceEventType
        }));
        return { items: items ?? [] };
      },
      async recordTokenUsage(input: unknown) {
        operations.push("token");
        tokenUsageRequests.push(input);
        return { tokenUsage: { id: "token-usage-test" } };
      },
      async projectConversationItems() {
        operations.push("project");
        return {
          projection: {
            rawItemsScanned: 1,
            rawItemsProjected: 1,
            messagesCreated: 0,
            toolEventsCreated: 0,
            memoryEventsCreated: 0,
            tokenUsageRowsCreated: 0
          }
        };
      },
      async submitLcmSummary(_nodeId: string, input: unknown) {
        operations.push("submit");
        submitted.push(input);
        return { ok: true };
      }
    };
    const config = resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
      },
      {
        maxAttempts: 1
      }
    );

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config,
      runner: async (prompt) => {
        expect(prompt).toContain("Roll up these child LCM summaries");
        expect(prompt).toContain("Required JSON schema");
        return {
          text: summaryJson("rollup summarized"),
          model: "codex-app-server:test",
          threadId: "thread-lcm-test",
          turnId: "turn-lcm-test",
          rawEvents: [
            {
              method: "turn/completed",
              observedAt: "2026-05-27T00:00:00.000Z",
              params: { threadId: "thread-lcm-test" }
            },
            {
              method: "thread/tokenUsage/updated",
              observedAt: "2026-05-27T00:00:01.000Z",
              params: {
                threadId: "thread-lcm-test",
                turnId: "turn-lcm-test",
                tokenUsage: {
                  modelContextWindow: 32768,
                  last: {
                    inputTokens: 20,
                    cachedInputTokens: 5,
                    outputTokens: 8,
                    reasoningOutputTokens: 2,
                    totalTokens: 28
                  }
                }
              }
            }
          ],
          tokenUsage: {
            modelContextWindow: 32768,
            last: {
              inputTokens: 20,
              cachedInputTokens: 5,
              outputTokens: 8,
              reasoningOutputTokens: 2,
              totalTokens: 28
            },
            total: {
              inputTokens: 20,
              cachedInputTokens: 5,
              outputTokens: 8,
              reasoningOutputTokens: 2,
              totalTokens: 28
            }
          }
        };
      }
    });

    expect(result.submittedCount).toBe(1);
    expect(result.results[0]).toMatchObject({
      kind: "rollup",
      depth: 1,
      summaryModel: "codex-app-server:test"
    });
    expect(submitted[0]).toMatchObject({
      summaryText: "rollup summarized",
      summaryModel: "codex-app-server:test",
      summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
    });
    expect(
      (submitted[0] as { summaryStructuredJson?: unknown })
        .summaryStructuredJson
    ).toMatchObject({
      summary_text: "rollup summarized",
      facts: ["rollup summarized"]
    });
    expect(rawItemRequests).toEqual([
      {
        items: [
          expect.objectContaining({
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalThreadId: "thread-lcm-test",
            externalTurnId: "turn-lcm-test",
            sourceEventType: "turn/completed"
          }),
          expect.objectContaining({
            sourceKind: "codex",
            sourceAdapterVersion: "codex-app-server-v1",
            sourceTransport: "app_server",
            externalThreadId: "thread-lcm-test",
            externalTurnId: "turn-lcm-test",
            sourceEventType: "thread/tokenUsage/updated"
          })
        ]
      }
    ]);
    const firstRawItem = (
      rawItemRequests[0] as { items?: Array<{ metadata?: unknown }> }
    ).items?.[0];
    expect(firstRawItem?.metadata).toMatchObject({
      workflow: "lcm_summary",
      nodeId: node.id
    });
    expect(tokenUsageRequests).toEqual([
      expect.objectContaining({
        workflowType: "lcm_summary",
        workflowId: node.id,
        conversationItemId: tokenConversationItemId,
        idempotencyKey: `token:${tokenConversationItemId}:last`
      })
    ]);
    expect(operations).toEqual(["raw", "token", "project", "submit"]);
  });

  it("persists usage-bearing failed LCM retry attempts separately", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000061",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "leaf placeholder",
      sourceTokenEstimate: 200,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "00000000-0000-4000-8000-000000000062",
          text: "The retry path should preserve token telemetry."
        }
      ]
    };
    const submitted: unknown[] = [];
    const tokenUsageRequests: unknown[] = [];
    let rawCallIndex = 0;
    const client = {
      async listPendingLcmSummaries() {
        return submitted.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async createConversationItems(input: unknown) {
        rawCallIndex += 1;
        const items = (
          input as { items?: Array<{ sourceEventType?: string }> }
        ).items?.map((item, itemIndex) => ({
          id:
            item.sourceEventType === "thread/tokenUsage/updated"
              ? `00000000-0000-4000-8000-00000000007${rawCallIndex}`
              : `00000000-0000-4000-8000-00000000008${itemIndex}`,
          sourceEventType: item.sourceEventType
        }));
        return { items: items ?? [] };
      },
      async recordTokenUsage(input: unknown) {
        tokenUsageRequests.push(input);
        return { tokenUsage: { id: "token-usage-test" } };
      },
      async projectConversationItems() {
        return {
          projection: {
            rawItemsScanned: 1,
            rawItemsProjected: 1,
            messagesCreated: 0,
            toolEventsCreated: 0,
            memoryEventsCreated: 0,
            tokenUsageRowsCreated: 0
          }
        };
      },
      async submitLcmSummary(_nodeId: string, input: unknown) {
        submitted.push(input);
        return { ok: true };
      }
    };
    const config = resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
      },
      {
        maxAttempts: 2,
        retryDelayMs: 0
      }
    );
    let calls = 0;

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config,
      runner: async () => {
        calls += 1;
        if (calls === 1) {
          throw new CodexAppServerTurnError("first summary attempt failed", {
            model: "codex-app-server:test",
            threadId: "thread-lcm-failed",
            turnId: "turn-lcm-failed",
            rawEvents: [
              {
                method: "thread/tokenUsage/updated",
                observedAt: "2026-05-27T00:00:00.000Z",
                params: { threadId: "thread-lcm-failed" }
              }
            ],
            tokenUsage: {
              modelContextWindow: 32768,
              last: {
                inputTokens: 12,
                cachedInputTokens: 2,
                outputTokens: 1,
                reasoningOutputTokens: 1,
                totalTokens: 13
              }
            }
          });
        }
        return {
          text: summaryJson("retry summarized"),
          model: "codex-app-server:test",
          threadId: "thread-lcm-success",
          turnId: "turn-lcm-success",
          rawEvents: [
            {
              method: "thread/tokenUsage/updated",
              observedAt: "2026-05-27T00:00:01.000Z",
              params: { threadId: "thread-lcm-success" }
            }
          ],
          tokenUsage: {
            modelContextWindow: 32768,
            last: {
              inputTokens: 18,
              cachedInputTokens: 3,
              outputTokens: 5,
              reasoningOutputTokens: 1,
              totalTokens: 23
            }
          }
        };
      }
    });

    expect(result.submittedCount).toBe(1);
    expect(submitted[0]).toMatchObject({ summaryText: "retry summarized" });
    expect(tokenUsageRequests).toHaveLength(2);
    const failedUsage = tokenUsageRequests[0] as {
      workflowType?: string;
      workflowId?: string;
      totalTokens?: number;
      metadata?: Record<string, unknown>;
    };
    const succeededUsage = tokenUsageRequests[1] as {
      workflowType?: string;
      workflowId?: string;
      totalTokens?: number;
      metadata?: Record<string, unknown>;
    };
    expect(failedUsage.workflowType).toBe("lcm_summary");
    expect(failedUsage.workflowId).toBe(node.id);
    expect(failedUsage.totalTokens).toBe(13);
    expect(failedUsage.metadata).toMatchObject({
      attemptIndex: 1,
      executionStatus: "failed",
      errorMessage: "first summary attempt failed"
    });
    expect(succeededUsage.workflowType).toBe("lcm_summary");
    expect(succeededUsage.workflowId).toBe(node.id);
    expect(succeededUsage.totalTokens).toBe(23);
    expect(succeededUsage.metadata).toMatchObject({
      attemptIndex: 2,
      executionStatus: "succeeded"
    });
  });

  it("ignores oversized source payload metadata so it does not block catch-up", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000001",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 200_000,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "00000000-0000-4000-8000-000000000002",
          text: "A tool call captured a large payload that should not monopolize the prompt.",
          payload: {
            output: "large-payload ".repeat(80_000)
          }
        }
      ]
    };
    const submitted: unknown[] = [];
    const client = {
      async listPendingLcmSummaries() {
        return submitted.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async submitLcmSummary(_nodeId: string, input: unknown) {
        submitted.push(input);
        return { ok: true };
      }
    };
    const config = resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
      },
      {
        maxPromptTokens: 4_000,
        maxAttempts: 1
      }
    );

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config,
      runner: async (prompt) => {
        expect(prompt).toContain(
          "A tool call captured a large payload that should not monopolize the prompt."
        );
        expect(prompt).not.toContain("large-payload");
        return {
          text: summaryJson("summarized"),
          model: "codex-app-server:test"
        };
      }
    });

    expect(result.submittedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      summaryText: "summarized",
      summaryModel: "codex-app-server:test",
      summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
    });
  });

  it("does not submit invalid structured summary output", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000021",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 100,
      sourceItems: [
        {
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: "00000000-0000-4000-8000-000000000022",
          text: "The worker must reject prose-only summaries."
        }
      ]
    };
    const submitted: unknown[] = [];
    const client = {
      async listPendingLcmSummaries() {
        return submitted.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async submitLcmSummary(_nodeId: string, input: unknown) {
        submitted.push(input);
        return { ok: true };
      }
    };
    const config = resolveLcmSummaryWorkerConfig(
      {
        MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
      },
      {
        maxAttempts: 1
      }
    );

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config,
      runner: async () => ({
        text: "plain summary text is no longer a valid LCM worker contract",
        model: "codex-app-server:test"
      })
    });

    expect(result.submittedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.results[0]?.error).toContain("Unexpected token");
    expect(submitted).toHaveLength(0);
  });
});
