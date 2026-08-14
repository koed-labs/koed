import { describe, expect, it } from "vitest";
import {
  assertCodexArmParity,
  BENCHMARK_MCP_TOKEN_ENV,
  createTrialCodexConfiguration
} from "./codex-config.js";

describe("isolated Codex replay configuration", () => {
  it("keeps the active credential out of serialized Harbor/Codex config", () => {
    const token = "super-secret-active-token";
    const config = createTrialCodexConfiguration({
      condition: "relevant",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      bridgeUrl: "http://127.0.0.1:4567",
      bridgeToken: token
    });
    expect(config.serialized).toContain(
      `bearer_token_env_var = ${JSON.stringify(BENCHMARK_MCP_TOKEN_ENV)}`
    );
    expect(config.serialized).not.toContain(token);
    expect(config.agentEnvironment).toEqual({
      [BENCHMARK_MCP_TOKEN_ENV]: token
    });
    expect(config.serialized).toContain("enabled = false");
    expect(config.serialized).toContain('web_search = "disabled"');
    expect(config.inline.features).toEqual({ mcp_2026_07_28: true });
    expect(config.inline.suppress_unstable_features_warning).toBe(true);
    expect(config.inline).not.toHaveProperty("developer_instructions");
    expect(config.serialized).not.toContain("developer_instructions");
  });

  it("adds the exact recall instruction to product-path memory arms", () => {
    const proof = createTrialCodexConfiguration({
      condition: "relevant",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      bridgeUrl: "http://127.0.0.1:4567",
      bridgeToken: "token",
      requireMemoryAnswer: true
    });
    expect(proof.inline.developer_instructions).toContain(
      "call the available memory_answer tool exactly once"
    );
    const empty = createTrialCodexConfiguration({
      condition: "empty",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      bridgeUrl: "http://127.0.0.1:4567",
      bridgeToken: "token",
      requireMemoryAnswer: true
    });
    expect(empty.inline.developer_instructions).toContain(
      'response_detail to "answer_only"'
    );
  });

  it("gives cold no Koed connection and proves the other arms differ only by MCP", () => {
    const cold = createTrialCodexConfiguration({
      condition: "cold",
      model: "gpt-5.6-luna",
      reasoningEffort: "low"
    });
    const relevant = createTrialCodexConfiguration({
      condition: "relevant",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      bridgeUrl: "http://127.0.0.1:1",
      bridgeToken: "one"
    });
    const placebo = createTrialCodexConfiguration({
      condition: "placebo",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      bridgeUrl: "http://127.0.0.1:2",
      bridgeToken: "two"
    });
    expect(cold.serialized).not.toContain("mcp_servers");
    expect(cold.agentEnvironment).toBeNull();
    expect(() => assertCodexArmParity([cold, relevant, placebo])).not.toThrow();
  });

  it("rejects credentials embedded in bridge URLs and cold bridge leakage", () => {
    expect(() =>
      createTrialCodexConfiguration({
        condition: "cold",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        bridgeUrl: "http://127.0.0.1:1",
        bridgeToken: "token"
      })
    ).toThrow("Cold replay");
    expect(() =>
      createTrialCodexConfiguration({
        condition: "empty",
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        bridgeUrl: "http://user:secret@127.0.0.1:1",
        bridgeToken: "token"
      })
    ).toThrow("credential-free");
  });
});
