import { describe, expect, it } from "vitest";
import { createPiTokenUsageAccumulator } from "../src/pi-token-usage.js";
import { createClaudeTokenUsageAccumulator } from "../src/claude-token-usage.js";

describe("partial provider usage", () => {
  it("counts terminal pi messages once and preserves absent output across failure", () => {
    const usage = createPiTokenUsageAccumulator();
    const message = {
      role: "assistant",
      responseId: "first",
      stopReason: "toolUse",
      usage: {
        input: 10,
        cacheRead: 20,
        cacheWrite: 5,
        output: 7,
        totalTokens: 42,
        reasoning: 2
      }
    };
    usage.observe({ type: "message_update", message });
    expect(usage.value()).toBeUndefined();
    usage.observe({ type: "message_end", message });
    usage.observe({ type: "message_end", message });
    usage.observe({ type: "agent_end", messages: [message] });
    expect(usage.value()?.last).toEqual({
      inputTokens: 35,
      cachedInputTokens: 20,
      outputTokens: 7,
      totalTokens: 42,
      reasoningOutputTokens: 2
    });
    usage.observe({
      type: "message_end",
      message: {
        role: "assistant",
        responseId: "second",
        stopReason: "error",
        usage: { input: 2, cacheRead: 0, cacheWrite: 0 }
      }
    });
    expect(usage.value()?.last).toEqual({
      inputTokens: 37,
      cachedInputTokens: 20,
      outputTokens: undefined,
      totalTokens: undefined,
      reasoningOutputTokens: undefined
    });
  });
  it("keeps absent pi reporting unknown", () => {
    const usage = createPiTokenUsageAccumulator();
    usage.observe({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted" }
    });
    expect(usage.value()).toBeUndefined();
  });
  it("deduplicates Claude input observations and never treats placeholder output as reported usage", () => {
    const usage = createClaudeTokenUsageAccumulator();
    const message = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "first",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 1
        }
      }
    };
    usage.observe(message as never);
    usage.observe(message as never);
    expect(usage.value()?.last).toEqual({
      inputTokens: 35,
      cachedInputTokens: 20
    });
    usage.observe({
      type: "result",
      modelUsage: {
        model: {
          inputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
          outputTokens: 7,
          contextWindow: 1000
        }
      }
    } as never);
    expect(usage.value()?.last).toEqual({
      inputTokens: 35,
      cachedInputTokens: 20,
      outputTokens: 7,
      totalTokens: 42
    });
  });
});
