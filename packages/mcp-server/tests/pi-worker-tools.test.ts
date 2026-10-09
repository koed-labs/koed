import { describe, expect, it, vi } from "vitest";
import { startPiWorkerTools } from "../src/pi-worker-tools.js";
import {
  parseStructuredMemoryAnswer,
  MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION
} from "../src/answer-worker.js";
import type { AiClientRunConfig } from "../src/ai-client-runner.js";

const config = (
  overrides: Partial<AiClientRunConfig> = {}
): AiClientRunConfig => ({
  provider: "pi",
  model: "test/model",
  reasoningEffort: "off",
  cwd: "/repo",
  env: {},
  executablePath: "pi",
  clientName: "test",
  systemPrompt: "test",
  ...overrides
});
const partial = {
  schema_version: MEMORY_ANSWER_STRUCTURED_SCHEMA_VERSION,
  memory_status: "insufficient",
  relevant_memory_found: true,
  answer_markdown: "Supported partial answer",
  relevance_explanation: "Relevant partial evidence",
  evidence: [{ evidence_index: 0 }],
  missing: ["remaining detail"],
  missing_evidence: []
};

describe("Pi worker retrieval and result bridge", () => {
  it("rejects invalid results before completion and accepts a corrected partial answer", async () => {
    const bridge = await startPiWorkerTools(
      config({
        validateOutput: (value) => {
          parseStructuredMemoryAnswer(value);
        }
      })
    );
    const submit = (value: unknown) =>
      fetch(bridge.url, {
        method: "POST",
        headers: { authorization: bridge.authorization },
        body: JSON.stringify({ name: "koed_structured_result", value })
      });
    try {
      const invalid = await submit({
        ...partial,
        relevant_memory_found: false
      });
      expect(invalid.status).toBe(422);
      expect(await invalid.json()).toMatchObject({
        error: expect.stringContaining("insufficient requires") as unknown
      });
      const corrected = await submit(partial);
      expect(corrected.status).toBe(200);
      expect(await corrected.json()).toEqual({ value: partial });
    } finally {
      await bridge.close();
    }
  });

  it("dispatches only registered tools through the runtime's scoped handler", async () => {
    const handler = vi.fn(async () => ({ success: true, text: '{"hits":[]}' }));
    const bridge = await startPiWorkerTools(
      config({
        dynamicTools: [
          {
            namespace: "koed_memory",
            name: "search",
            description: "search",
            inputSchema: { type: "object" }
          }
        ],
        dynamicToolHandler: handler
      })
    );
    const request = (name: string, authorization = bridge.authorization) =>
      fetch(bridge.url, {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify({ name, value: { query: "synthetic question" } })
      });
    try {
      expect(
        (await request("koed_memory_search", "Bearer invalid")).status
      ).toBe(401);
      expect((await request("unregistered_tool")).status).toBe(404);
      expect(handler).not.toHaveBeenCalled();
      const response = await request("koed_memory_search");
      expect(await response.json()).toEqual({
        success: true,
        text: '{"hits":[]}'
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          namespace: "koed_memory",
          tool: "search",
          arguments: { query: "synthetic question" }
        })
      );
      await fetch(bridge.url, {
        method: "GET",
        headers: { authorization: bridge.authorization }
      }).then((result) => expect(result.status).toBe(404));
    } finally {
      await bridge.close();
    }
  });
});
