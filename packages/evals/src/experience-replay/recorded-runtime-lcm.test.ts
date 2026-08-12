import type { MemorySourceRepository } from "@koed/db";
import { LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION } from "@koed/mcp-server";
import { describe, expect, it, vi } from "vitest";
import { resolveExperienceReplayConfig } from "./core/index.js";
import { createRecordedLcmJobRunner } from "./recorded-runtime-lcm.js";

const config = resolveExperienceReplayConfig({
  version: 1,
  profile: "quick",
  seed: "recorded-lcm",
  output_dir: "/tmp/recorded-lcm",
  codex_cli: {
    version: "codex-1",
    host_sha256: "a".repeat(64),
    container_sha256: "a".repeat(64),
    container_code_mode_host_sha256: "b".repeat(64)
  },
  coding_agent: { id: "gpt-5.6-luna", reasoning_effort: "low" },
  memory_answer: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    prompt_version: "answer-v1",
    output_schema_version: "answer-v1"
  },
  lcm_summary: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    prompt_version: "lcm-codex-summary-json-v4",
    output_schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
  },
  session_title: {
    model: { id: "gpt-5.6-luna", reasoning_effort: "low" },
    prompt_version: "title-v1",
    output_schema_version: "title-v1"
  },
  embedding: {
    model: "qwen3-0.6b",
    artifact_sha256: "b".repeat(64),
    tokenizer: "qwen3",
    transform: "query-document-v1",
    dimensions: 1024
  },
  price_table: {
    version: "v1",
    sha256: "c".repeat(64),
    models: {
      "gpt-5.6-luna": {
        uncached_input_usd_per_million: 1,
        cached_input_usd_per_million: 0.1,
        output_usd_per_million: 2
      }
    }
  },
  timeouts: {
    agent_seconds: 10,
    setup_seconds: 10,
    verifier_seconds: 10,
    preparation_seconds: 10,
    teardown_seconds: 10
  },
  admission: {
    maximum_trajectory_bytes: 1000,
    estimated_attempt_artifact_bytes: 1000,
    estimated_image_bytes_per_task: 0,
    scratch_multiplier: 1,
    minimum_free_space_reserve_bytes: 0,
    max_input_tokens_per_call: 4000,
    max_output_tokens_per_call: 1000,
    max_memory_answer_calls_per_attempt: 1,
    max_preparation_calls_per_source: 1,
    provider_spending_limit_usd: 1
  },
  paid_cost_stop_usd: 1
});

describe("recorded LCM preparation", () => {
  it("runs the production prompt contract and persists measured output", async () => {
    const updateLcmNodeSummary = vi.fn().mockResolvedValue(undefined);
    const repository = {
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          visibility: "personal",
          workClass: "historical_import_backfill",
          pendingMemoryEventIds: ["event-1"]
        }
      ]),
      createLcmNodes: vi.fn().mockResolvedValue({
        leafNodeIds: ["node-1"],
        rollupNodeId: null
      }),
      getLcmNodeForSummarization: vi.fn().mockResolvedValue({
        id: "node-1",
        ownerUserId: "user-1",
        visibility: "personal",
        kind: "leaf",
        depth: 0,
        summaryText: "pending",
        sourceItems: [{ kind: "memory_event", text: "exact source phrase" }],
        sourceTokenEstimate: 3,
        summaryTokenEstimate: null,
        summaryModel: null,
        summaryPromptVersion: null,
        summaryStructuredJson: null,
        summaryStructuredSchemaVersion: null,
        lcmAlgorithmVersion: "v1"
      }),
      updateLcmNodeSummary
    } as unknown as MemorySourceRepository;
    const runner = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
        title: "Recorded summary",
        summary_text: "A grounded summary.",
        lexical_anchors: ["exact source phrase"]
      }),
      model: "codex-app-server:gpt-5.6-luna:low",
      tokenUsage: { total: { inputTokens: 120, outputTokens: 20 } }
    });
    const run = createRecordedLcmJobRunner({
      config,
      environment: { MEMORY_CODEX_APP_SERVER_BINARY: "/opt/codex" },
      runner
    });
    await expect(
      run({
        repository,
        actor: { userId: "user-1" },
        scheduledEventIds: ["event-1"]
      })
    ).resolves.toMatchObject({
      nodeIds: ["node-1"],
      model: "gpt-5.6-luna",
      promptVersion: "lcm-codex-summary-json-v4",
      inputTokens: 120,
      outputTokens: 20
    });
    expect(updateLcmNodeSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        summaryText: "A grounded summary.",
        summaryPromptVersion: "lcm-codex-summary-json-v4",
        summaryStructuredSchemaVersion: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION
      })
    );
  });

  it("reports exact zero usage when no LCM work is scheduled", async () => {
    const repository = {
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([]),
      createLcmNodes: vi.fn(),
      getLcmNodeForSummarization: vi.fn()
    } as unknown as MemorySourceRepository;
    const run = createRecordedLcmJobRunner({
      config,
      environment: { MEMORY_CODEX_APP_SERVER_BINARY: "/opt/codex" },
      runner: vi.fn()
    });
    await expect(
      run({ repository, actor: { userId: "user-1" }, scheduledEventIds: [] })
    ).resolves.toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it("uses the production repair path and accounts for both calls", async () => {
    const updateLcmNodeSummary = vi.fn().mockResolvedValue(undefined);
    const repository = {
      listPendingLcmDispatchScopes: vi.fn().mockResolvedValue([
        {
          visibility: "personal",
          workClass: "historical_import_backfill",
          pendingMemoryEventIds: ["event-1"]
        }
      ]),
      createLcmNodes: vi.fn().mockResolvedValue({
        leafNodeIds: ["node-1"],
        rollupNodeId: null
      }),
      getLcmNodeForSummarization: vi.fn().mockResolvedValue({
        id: "node-1",
        ownerUserId: "user-1",
        visibility: "personal",
        kind: "leaf",
        depth: 0,
        summaryText: "pending",
        sourceItems: [{ kind: "memory_event", text: "exact source phrase" }],
        sourceTokenEstimate: 3,
        summaryTokenEstimate: null,
        summaryModel: null,
        summaryPromptVersion: null,
        summaryStructuredJson: null,
        summaryStructuredSchemaVersion: null,
        lcmAlgorithmVersion: "v1"
      }),
      updateLcmNodeSummary
    } as unknown as MemorySourceRepository;
    const runner = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          schema_version: LCM_STRUCTURED_SUMMARY_SCHEMA_VERSION,
          title: "Recorded summary",
          summary_text: "A grounded summary.",
          lexical_anchors: ["invented anchor"]
        }),
        model: "codex-app-server:gpt-5.6-luna:low",
        tokenUsage: { total: { inputTokens: 120, outputTokens: 20 } }
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ lexical_anchors: ["exact source phrase"] }),
        model: "codex-app-server:gpt-5.6-luna:low",
        tokenUsage: { total: { inputTokens: 40, outputTokens: 5 } }
      });
    const run = createRecordedLcmJobRunner({
      config,
      environment: { MEMORY_CODEX_APP_SERVER_BINARY: "/opt/codex" },
      runner
    });

    await expect(
      run({
        repository,
        actor: { userId: "user-1" },
        scheduledEventIds: ["event-1"]
      })
    ).resolves.toMatchObject({ inputTokens: 160, outputTokens: 25 });
    expect(runner).toHaveBeenCalledTimes(2);
    const persisted = updateLcmNodeSummary.mock.calls.at(-1)?.[0] as
      | { summaryStructuredJson?: { lexical_anchors?: string[] } }
      | undefined;
    expect(persisted?.summaryStructuredJson?.lexical_anchors).toEqual([
      "exact source phrase"
    ]);
  });
});
