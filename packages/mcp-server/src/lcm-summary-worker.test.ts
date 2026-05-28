import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  buildLcmSummaryPrompt,
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  type LcmSummaryNode
} from "./lcm-summary-worker.js";

const tempDirs: string[] = [];

afterEach(async () => {
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
      expect(prompt).toContain('"summary_text"');
      expect(prompt).toContain('"user_requests"');
      expect(prompt).toContain('"decisions"');
      expect(prompt).toContain('"provenance_hints"');
      expect(prompt).toContain("Return only one JSON object");
    }

    const rollupPrompt = buildLcmSummaryPrompt({ ...node, kind: "rollup" });
    expect(rollupPrompt).toContain("Roll up these child LCM summaries");
    expect(rollupPrompt).toContain(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION);
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
          text: "Child summary says the team moved memory answers to app-server mode."
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
                  modelContextWindow: 32000,
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
            modelContextWindow: 32000,
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

  it("bounds structured payloads so oversized tool payloads do not block catch-up", async () => {
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
        expect(prompt).toContain("[payload truncated for prompt");
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
