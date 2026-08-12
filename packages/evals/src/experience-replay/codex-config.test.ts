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
