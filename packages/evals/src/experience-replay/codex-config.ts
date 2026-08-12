import type { ReplayCondition } from "./core/index.js";

export const BENCHMARK_MCP_TOKEN_ENV = "KOED_BENCHMARK_MCP_TOKEN";

const tomlString = (value: string): string => JSON.stringify(value);

export interface TrialCodexConfiguration {
  serialized: string;
  agentEnvironment: Readonly<
    Record<typeof BENCHMARK_MCP_TOKEN_ENV, string>
  > | null;
}

export const createTrialCodexConfiguration = ({
  condition,
  model,
  reasoningEffort,
  bridgeUrl,
  bridgeToken
}: {
  condition: ReplayCondition;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  bridgeUrl?: string;
  bridgeToken?: string;
}): TrialCodexConfiguration => {
  const koedEnabled = condition !== "cold";
  if (koedEnabled !== Boolean(bridgeUrl && bridgeToken)) {
    throw new Error(
      koedEnabled
        ? "Koed replay conditions require a bridge URL and credential"
        : "Cold replay must not receive a Koed bridge"
    );
  }
  if (bridgeUrl) {
    const parsed = new URL(bridgeUrl);
    if (
      parsed.protocol !== "http:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        "Benchmark bridge URL must be a credential-free HTTP origin"
      );
    }
  }
  const lines = [
    `model = ${tomlString(model)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    'model_reasoning_summary = "concise"',
    'approval_policy = "never"',
    "include_permissions_instructions = false",
    "include_apps_instructions = false",
    "include_collaboration_mode_instructions = false",
    "include_environment_context = false",
    "project_doc_max_bytes = 0",
    'web_search = "disabled"',
    "",
    "[agents]",
    "enabled = false",
    "",
    "[skills]",
    "include_instructions = false"
  ];
  if (koedEnabled) {
    lines.push(
      "",
      "[mcp_servers.koed]",
      `url = ${tomlString(bridgeUrl!)}`,
      `bearer_token_env_var = ${tomlString(BENCHMARK_MCP_TOKEN_ENV)}`,
      'enabled_tools = ["memory_answer"]',
      "required = true",
      'default_tools_approval_mode = "approve"'
    );
  }
  return {
    serialized: `${lines.join("\n")}\n`,
    agentEnvironment: koedEnabled
      ? Object.freeze({ [BENCHMARK_MCP_TOKEN_ENV]: bridgeToken! })
      : null
  };
};

export const semanticCodexConfig = (serialized: string): string =>
  serialized.replace(/\n\[mcp_servers\.koed\][\s\S]*$/, "\n").trimEnd();

export const assertCodexArmParity = (
  configurations: readonly TrialCodexConfiguration[]
): void => {
  if (configurations.length === 0)
    throw new Error("No Codex configurations supplied");
  const semantic = semanticCodexConfig(configurations[0]!.serialized);
  for (const config of configurations.slice(1)) {
    if (semanticCodexConfig(config.serialized) !== semantic) {
      throw new Error(
        "Codex arm configurations differ outside the Koed MCP table"
      );
    }
  }
};
