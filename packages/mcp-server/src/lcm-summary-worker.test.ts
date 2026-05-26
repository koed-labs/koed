import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
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

describe("LCM summary worker", () => {
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
      runner: async (prompt) => {
        expect(prompt).toContain("Roll up these child LCM summaries");
        return { text: "rollup summarized", model: "codex-app-server:test" };
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
      summaryModel: "codex-app-server:test"
    });
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
        return { text: "summarized", model: "codex-app-server:test" };
      }
    });

    expect(result.submittedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      summaryText: "summarized",
      summaryModel: "codex-app-server:test"
    });
  });
});
