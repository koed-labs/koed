import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countTokensForModel } from "@koed/core";
import {
  LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
  acquireLocalSummaryLock,
  buildLcmSummaryPrompt,
  lcmSummaryLockState,
  parseStructuredLcmSummary,
  resolveLcmSummaryWorkerConfig,
  summarizePendingLcmNodes,
  validateLcmLexicalAnchors,
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

const summaryJson = (summary_text: string, lexical_anchors: string[] = []) =>
  JSON.stringify({
    schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
    title: "Structured LCM Details",
    summary_text,
    lexical_anchors
  });

it("reclaims an LCM summary lock whose process no longer exists", async () => {
  const lockPath = await tempLockPath();
  await writeFile(
    lockPath,
    JSON.stringify({ pid: 2_147_483_647, createdAt: new Date().toISOString() })
  );
  const env = { MEMORY_LCM_SUMMARY_LOCK_PATH: lockPath };

  expect(lcmSummaryLockState(env, 60_000)).toEqual({
    locked: false,
    stale: true
  });
  const release = acquireLocalSummaryLock(env, 60_000);
  expect(release).not.toBeNull();
  expect(lcmSummaryLockState(env, 60_000)).toEqual({
    locked: true,
    stale: false
  });
  release?.();
});

it("does not steal a current process LCM summary lock", async () => {
  const lockPath = await tempLockPath();
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
  );
  const env = { MEMORY_LCM_SUMMARY_LOCK_PATH: lockPath };

  expect(lcmSummaryLockState(env, 60_000)).toEqual({
    locked: true,
    stale: false
  });
  expect(acquireLocalSummaryLock(env, 60_000)).toBeNull();
});

it("isolates the default LCM summary lock by KOED_HOME", async () => {
  const firstHome = await mkdtemp(path.join(os.tmpdir(), "koed-lcm-home-a-"));
  const secondHome = await mkdtemp(path.join(os.tmpdir(), "koed-lcm-home-b-"));
  tempDirs.push(firstHome, secondHome);

  const releaseFirst = acquireLocalSummaryLock(
    { KOED_HOME: firstHome },
    60_000
  );
  const releaseSecond = acquireLocalSummaryLock(
    { KOED_HOME: secondHome },
    60_000
  );
  expect(releaseFirst).not.toBeNull();
  expect(releaseSecond).not.toBeNull();
  releaseFirst?.();
  releaseSecond?.();
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
      `output_schema: ${LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION}`,
      "---",
      "Summarize this leaf using the required JSON schema."
    ].join("\n")
  );

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
        KOED_PROMPT_DIR: directory,
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

it("fails before listing work when an LCM override omits its output schema", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "koed-lcm-prompts-"));
  tempDirs.push(directory);
  await writeFile(
    path.join(directory, "lcm-summary-leaf.md"),
    [
      "---",
      "id: lcm-summary-leaf",
      "version: lcm-codex-summary-json-v2",
      "---",
      "Summarize this captured memory span using structured detail arrays."
    ].join("\n")
  );

  const listPendingLcmSummaries = vi.fn();
  const runner = vi.fn();

  await expect(
    summarizePendingLcmNodes(
      { listPendingLcmSummaries } as unknown as Parameters<
        typeof summarizePendingLcmNodes
      >[0],
      {
        limit: 1,
        config: resolveLcmSummaryWorkerConfig(
          {
            KOED_PROMPT_DIR: directory,
            MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
          },
          { maxAttempts: 1, retryDelayMs: 0, timeoutMs: 1_000 }
        ),
        runner
      }
    )
  ).rejects.toThrow(
    /output_schema <missing>.*Update or remove the incompatible KOED_PROMPT_DIR override/
  );
  expect(listPendingLcmSummaries).not.toHaveBeenCalled();
  expect(runner).not.toHaveBeenCalled();
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
      expect(prompt).toContain('"lexical_anchors"');
      expect(prompt).not.toContain('"decisions"');
      expect(prompt).not.toContain('"provenance_hints"');
      expect(prompt).toContain("Do not reproduce API tokens");
      expect(prompt).toContain(
        "redaction rule overrides every preservation requirement"
      );
      expect(prompt).toContain("authoritative drill-down evidence");
      expect(prompt).toContain(
        "semantic coverage and clear retrieval cues over exhaustive detail"
      );
      expect(prompt).toContain(
        "title is only a label and must not carry unique information"
      );
      expect(prompt).toContain("Return only one JSON object");
    }

    const rollupPrompt = buildLcmSummaryPrompt({ ...node, kind: "rollup" });
    expect(rollupPrompt).toContain(
      "Roll up these child LCM summaries into a compact higher-level semantic index"
    );
    expect(rollupPrompt).toContain(LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION);
    expect(rollupPrompt).toContain("Do not reproduce API tokens");
    expect(rollupPrompt).toContain(
      "When ordered source items or child summaries conflict, prefer the later item"
    );
    expect(rollupPrompt).toContain(
      "older conflicting items only as superseded context"
    );
    expect(rollupPrompt).toContain(
      "compress more aggressively than a leaf summary"
    );
    expect(rollupPrompt).toContain(
      "Do not concatenate children or repeat detailed commands"
    );

    const reducePrompt = buildLcmSummaryPrompt(node, "reduce");
    expect(reducePrompt).toContain(
      "When ordered source items or child summaries conflict, prefer the later item"
    );
  });

  it("validates lexical anchors only against exact supplied payload substrings", () => {
    expect(
      validateLcmLexicalAnchors(
        [
          "memory_answer",
          "memory_answer",
          "Memory_Answer",
          "",
          "x".repeat(121)
        ],
        ["Use memory_answer from packages/db/src/repository.ts."]
      )
    ).toEqual({
      valid: ["memory_answer"],
      rejected: [
        { anchor: "Memory_Answer", reason: "unsupported" },
        { anchor: "", reason: "empty" },
        { anchor: "x".repeat(121), reason: "too_long" }
      ]
    });
  });

  it("enforces the anchor count boundary and exact adversarial Unicode grounding", () => {
    const bounded = Array.from({ length: 13 }, (_, index) => `anchor-${index}`);
    const unicodePayload =
      "composed café; decomposed cafe\u0301; emoji 👩🏽‍💻; bidi abc\u202Edef; confusable Αlpha.";

    expect(validateLcmLexicalAnchors(bounded, [bounded.join(" ")])).toEqual({
      valid: bounded.slice(0, 12),
      rejected: [{ anchor: "anchor-12", reason: "count_limit" }]
    });
    expect(
      validateLcmLexicalAnchors(
        ["café", "cafe\u0301", "👩🏽‍💻", "abc\u202Edef", "Αlpha", "café", "Alpha"],
        [unicodePayload]
      )
    ).toEqual({
      valid: ["café", "cafe\u0301", "👩🏽‍💻", "abc\u202Edef", "Αlpha"],
      rejected: [{ anchor: "Alpha", reason: "unsupported" }]
    });
    expect(
      validateLcmLexicalAnchors(
        ["🧠".repeat(120), "🧠".repeat(121)],
        ["🧠".repeat(121)]
      )
    ).toEqual({
      valid: ["🧠".repeat(120)],
      rejected: [{ anchor: "🧠".repeat(121), reason: "too_long" }]
    });
  });

  it("repairs rejected anchors once and retains valid output after a partial repair", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000071",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 20,
      sourceItems: [
        {
          kind: "memory_event",
          sourceId: "00000000-0000-4000-8000-000000000072",
          text: "Use memory_answer in packages/db/src/repository.ts."
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
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        text: summaryJson("Canonical summary.", [
          "memory_answer",
          "Memory_Answer",
          "x".repeat(121)
        ]),
        model: "codex:test"
      })
      .mockImplementationOnce(async (prompt: string) => {
        expect(prompt).toContain("Lexical anchor grounding repair");
        expect(prompt).toContain("packages/db/src/repository.ts");
        expect(prompt).toContain('"unsupported":1');
        expect(prompt).toContain('"too_long":1');
        return {
          text: JSON.stringify({
            lexical_anchors: ["packages/db/src/repository.ts"]
          }),
          model: "codex:test"
        };
      });

    const result = await summarizePendingLcmNodes(client, {
      limit: 1,
      config: resolveLcmSummaryWorkerConfig(
        { MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath() },
        { maxAttempts: 1, retryDelayMs: 0, timeoutMs: 1_000 }
      ),
      runner
    });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(result.results[0]).toMatchObject({
      submitted: true,
      promptCallCount: 2
    });
    expect(submissions[0]).toMatchObject({
      summaryText: "Canonical summary.",
      summaryStructuredJson: {
        summary_text: "Canonical summary.",
        lexical_anchors: ["memory_answer", "packages/db/src/repository.ts"]
      }
    });
  });

  it("bounds one repair call near the primary prompt limit and preserves the primary summary when repair fails", async () => {
    const sourceText = `Grounded replacement marker. ${"near limit source context ".repeat(300)}`;
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000073",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 2_000,
      sourceItems: [
        {
          kind: "memory_event",
          sourceId: "00000000-0000-4000-8000-000000000074",
          text: sourceText
        }
      ]
    };
    const primaryPrompt = buildLcmSummaryPrompt(node);
    const model = "gpt-5.1-codex-mini";
    const maxPromptTokens = countTokensForModel(primaryPrompt, {
      model
    }).tokens;
    const canonicalSummary = "Primary summary survives. ".repeat(1_000);
    const submitted: Record<string, unknown>[] = [];
    let listed = false;
    const client = {
      async listPendingLcmSummaries() {
        if (listed) return { nodes: [] };
        listed = true;
        return { nodes: [node] };
      },
      async submitLcmSummary(_nodeId: string, input: Record<string, unknown>) {
        submitted.push(input);
        return {};
      }
    } as unknown as Parameters<typeof summarizePendingLcmNodes>[0];
    const prompts: string[] = [];
    const runner = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("Lexical anchor grounding repair")) {
        return { text: "not json", model: "codex:test" };
      }
      return {
        text: summaryJson(canonicalSummary, ["unsupported anchor"]),
        model: "codex:test"
      };
    });

    const result = await summarizePendingLcmNodes(client, {
      limit: 1,
      config: resolveLcmSummaryWorkerConfig(
        { MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath() },
        { maxAttempts: 1, maxPromptTokens, model, retryDelayMs: 0 }
      ),
      runner
    });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain("Lexical anchor grounding repair");
    expect(
      prompts.map((prompt) => countTokensForModel(prompt, { model }).tokens)
    ).toEqual(expect.arrayContaining([maxPromptTokens]));
    expect(
      prompts.every(
        (prompt) =>
          countTokensForModel(prompt, { model }).tokens <= maxPromptTokens
      )
    ).toBe(true);
    expect(result.results[0]).toMatchObject({
      submitted: true,
      promptCallCount: 2
    });
    expect(submitted[0]).toMatchObject({
      summaryText: canonicalSummary.trim(),
      summaryStructuredJson: {
        summary_text: canonicalSummary.trim(),
        lexical_anchors: []
      }
    });
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
              sequence: 1,
              method: "turn/completed",
              observedAt: "2026-05-27T00:00:00.000Z",
              params: { threadId: "thread-lcm-test" }
            },
            {
              sequence: 2,
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
      summary_text: "rollup summarized"
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

  it("grounds rollup anchors against child text and validated child values before JSON escaping", async () => {
    const quoteAnchor = 'flag "quoted"';
    const backslashAnchor = "C:\\repo\\koed";
    const newlineAnchor = "line one\nline two";
    const childSummary = {
      schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
      title: "Escaped child values",
      summary_text: `The child retained ${quoteAnchor} and ${backslashAnchor}.`,
      lexical_anchors: [quoteAnchor, backslashAnchor, newlineAnchor]
    };
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000014",
      visibility: "personal",
      kind: "rollup",
      depth: 1,
      summaryText: "rollup placeholder",
      sourceTokenEstimate: 100,
      sourceItems: [
        {
          kind: "lcm_child",
          nodeId: "00000000-0000-4000-8000-000000000015",
          text: JSON.stringify(childSummary)
        }
      ]
    };
    const submitted: Record<string, unknown>[] = [];
    let listed = false;
    const client = {
      async listPendingLcmSummaries() {
        if (listed) return { nodes: [] };
        listed = true;
        return { nodes: [node] };
      },
      async submitLcmSummary(_nodeId: string, input: Record<string, unknown>) {
        submitted.push(input);
        return { ok: true };
      }
    };
    const runner = vi.fn(async (prompt: string) => {
      expect(prompt).not.toContain("Lexical anchor grounding repair");
      return {
        text: summaryJson("Escaped anchors survive rollup.", [
          quoteAnchor,
          backslashAnchor,
          newlineAnchor
        ]),
        model: "codex-app-server:test"
      };
    });

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config: resolveLcmSummaryWorkerConfig(
        { MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath() },
        { maxAttempts: 1 }
      ),
      runner
    });

    expect(result.submittedCount).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(submitted[0]).toMatchObject({
      summaryStructuredJson: {
        lexical_anchors: [quoteAnchor, backslashAnchor, newlineAnchor]
      }
    });
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
                sequence: 1,
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
              sequence: 1,
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

  it("records Claude usage with Agent SDK execution identity", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000091",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 20,
      sourceItems: [{ kind: "memory_event", text: "A durable decision." }]
    };
    const submitted: unknown[] = [];
    const tokenUsageRequests: unknown[] = [];
    const client = {
      async listPendingLcmSummaries() {
        return submitted.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async recordTokenUsage(input: unknown) {
        tokenUsageRequests.push(input);
        return { tokenUsage: { id: "usage-claude" } };
      },
      async submitLcmSummary(_nodeId: string, input: unknown) {
        submitted.push(input);
        return { ok: true };
      }
    };
    const config = resolveLcmSummaryWorkerConfig(
      { MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath() },
      {
        provider: "claude",
        aiClientInstanceId: "claude.default",
        executablePath: process.execPath,
        maxAttempts: 1
      }
    );

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config,
      runner: async () => ({
        text: summaryJson("Claude summarized"),
        model: "claude-sonnet",
        threadId: "claude-session",
        tokenUsage: {
          modelContextWindow: 200_000,
          last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
        }
      })
    });

    expect(result.submittedCount).toBe(1);
    expect(tokenUsageRequests).toHaveLength(1);
    expect(tokenUsageRequests[0]).toMatchObject({
      sourceRuntime: "claude-code",
      sourceKind: "claude-code",
      sourceAdapterVersion: "claude-agent-sdk-v1",
      usageSource: "connector_native",
      connectorClient: "claude",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      metadata: {
        provider: "claude",
        aiClientInstanceId: "claude.default",
        transport: "agent_sdk"
      }
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

  it("passes complete compact shard summaries into large-leaf reduction", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000081",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 4_000,
      sourceItems: [
        {
          kind: "memory_event",
          sourceId: "00000000-0000-4000-8000-000000000082",
          text: `DECISION_MARKER flag "quoted" C:\\repo\\koed ${"decision context ".repeat(900)}`
        },
        {
          kind: "memory_event",
          sourceId: "00000000-0000-4000-8000-000000000083",
          text: `UNRESOLVED_MARKER line one\nline two ${"open question context ".repeat(900)}`
        }
      ]
    };
    const submissions: Record<string, unknown>[] = [];
    const client = {
      async listPendingLcmSummaries() {
        return submissions.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async submitLcmSummary(_nodeId: string, input: Record<string, unknown>) {
        submissions.push(input);
        return { ok: true };
      }
    };
    let reduceCalls = 0;

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config: resolveLcmSummaryWorkerConfig(
        {
          MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
        },
        {
          maxPromptTokens: 2_000,
          maxAttempts: 1
        }
      ),
      runner: async (prompt) => {
        expect(prompt).not.toContain("Lexical anchor grounding repair");
        if (prompt.includes("Combine these shard summaries")) {
          reduceCalls += 1;
          expect(prompt).toContain('"schema_version"');
          expect(prompt).toContain('"title"');
          expect(prompt).toContain('"summary_text"');
          expect(prompt).toContain("Use scoped device credentials");
          expect(prompt).toContain("Determine the revocation TTL");
          return {
            text: summaryJson(
              "Use scoped device credentials; determine the revocation TTL.",
              ['flag "quoted"', "C:\\repo\\koed", "line one\nline two"]
            ),
            model: "codex-app-server:test"
          };
        }
        const summary = prompt.includes("DECISION_MARKER")
          ? "Use scoped device credentials."
          : prompt.includes("UNRESOLVED_MARKER")
            ? "Determine the revocation TTL."
            : "Supporting context only.";
        return {
          text: summaryJson(
            summary,
            prompt.includes("DECISION_MARKER")
              ? ['flag "quoted"', "C:\\repo\\koed"]
              : prompt.includes("UNRESOLVED_MARKER")
                ? ["line one\nline two"]
                : []
          ),
          model: "codex-app-server:test"
        };
      }
    });

    expect(reduceCalls).toBeGreaterThan(0);
    expect(result.submittedCount).toBe(1);
    expect(submissions[0]).toMatchObject({
      summaryText:
        "Use scoped device credentials; determine the revocation TTL.",
      summaryStructuredJson: {
        lexical_anchors: [
          'flag "quoted"',
          "C:\\repo\\koed",
          "line one\nline two"
        ]
      }
    });
  });

  it("does not ground a shard anchor against source text outside that shard", async () => {
    const node: LcmSummaryNode = {
      id: "00000000-0000-4000-8000-000000000084",
      visibility: "personal",
      kind: "leaf",
      depth: 0,
      summaryText: "placeholder",
      sourceTokenEstimate: 4_000,
      sourceItems: [
        {
          kind: "memory_event",
          sourceId: "00000000-0000-4000-8000-000000000085",
          text: `FIRST_SHARD ${"bounded context ".repeat(1_000)} LAST_SHARD_ONLY`
        }
      ]
    };
    const submissions: Record<string, unknown>[] = [];
    const client = {
      async listPendingLcmSummaries() {
        return submissions.length === 0 ? { nodes: [node] } : { nodes: [] };
      },
      async submitLcmSummary(_nodeId: string, input: Record<string, unknown>) {
        submissions.push(input);
        return { ok: true };
      }
    };
    let repairCalls = 0;

    const result = await summarizePendingLcmNodes(client as never, {
      limit: 1,
      config: resolveLcmSummaryWorkerConfig(
        {
          MEMORY_LCM_SUMMARY_LOCK_PATH: await tempLockPath()
        },
        { maxPromptTokens: 1_500, maxAttempts: 1 }
      ),
      runner: async (prompt) => {
        if (prompt.includes("Lexical anchor grounding repair")) {
          repairCalls += 1;
          return {
            text: summaryJson("First shard summary.", []),
            model: "codex-app-server:test"
          };
        }
        if (prompt.includes("Combine these shard summaries")) {
          return {
            text: summaryJson("Combined shard summary.", []),
            model: "codex-app-server:test"
          };
        }
        return {
          text: summaryJson(
            prompt.includes("FIRST_SHARD")
              ? "First shard summary."
              : "Later shard summary.",
            prompt.includes("FIRST_SHARD") &&
              !prompt.includes("LAST_SHARD_ONLY")
              ? ["LAST_SHARD_ONLY"]
              : []
          ),
          model: "codex-app-server:test"
        };
      }
    });

    expect(result.failedCount).toBe(0);
    expect(repairCalls).toBe(1);
    expect(submissions).toHaveLength(1);
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

  it("rejects legacy detail arrays in the minimal summary contract", async () => {
    const legacy = summaryJson("Canonical semantic summary.").replace(
      '"summary_text":"Canonical semantic summary."',
      '"summary_text":"Canonical semantic summary.","decisions":["Duplicate detail"]'
    );
    expect(() => parseStructuredLcmSummary(legacy)).toThrow(/decisions/);
  });
});
