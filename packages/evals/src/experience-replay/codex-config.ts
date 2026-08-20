import { conditionUsesKoed, type ReplayCondition } from "./core/index.js";

export const BENCHMARK_MCP_TOKEN_ENV = "KOED_BENCHMARK_MCP_TOKEN";
export const PRODUCT_PATH_MEMORY_INSTRUCTION =
  'This is a product-path validation run. Before making changes, call the available memory_answer tool exactly once with a concise project-scoped query asking for prior experience relevant to the task. Explicitly set search_domain to "project" and response_detail to "answer_only". Use the answer if useful, then complete the task normally. Do not call memory_answer again.';

const tomlString = (value: string): string => JSON.stringify(value);

export interface TrialCodexConfiguration {
  serialized: string;
  inline: Readonly<Record<string, unknown>>;
  agentEnvironment: Readonly<
    Record<typeof BENCHMARK_MCP_TOKEN_ENV, string>
  > | null;
}

export const createTrialCodexConfiguration = ({
  condition,
  model,
  reasoningEffort,
  bridgeUrl,
  bridgeToken,
  requireMemoryAnswer = false,
  developerInstructions
}: {
  condition: ReplayCondition;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  bridgeUrl?: string;
  bridgeToken?: string;
  requireMemoryAnswer?: boolean;
  developerInstructions?: string;
}): TrialCodexConfiguration => {
  const koedEnabled = conditionUsesKoed(condition);
  if (koedEnabled !== Boolean(bridgeUrl && bridgeToken)) {
    throw new Error(
      koedEnabled
        ? "Koed replay conditions require a bridge URL and credential"
        : "Cold replay must not receive a Koed bridge"
    );
  }
  if (
    requireMemoryAnswer &&
    condition !== "empty" &&
    condition !== "relevant" &&
    condition !== "relevant_guidance" &&
    condition !== "relevant_trace" &&
    condition !== "relevant_full"
  ) {
    throw new Error(
      "Required product-path memory recall is valid only for a relevant arm"
    );
  }
  if (
    developerInstructions !== undefined &&
    (!developerInstructions.trim() || developerInstructions.includes("\0"))
  ) {
    throw new Error("Developer instructions must be non-empty safe text");
  }
  if (requireMemoryAnswer && developerInstructions !== undefined) {
    throw new Error(
      "Product-path recall and source-generation instructions cannot be combined"
    );
  }
  const resolvedDeveloperInstructions = requireMemoryAnswer
    ? PRODUCT_PATH_MEMORY_INSTRUCTION
    : developerInstructions;
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
    "suppress_unstable_features_warning = true",
    ...(resolvedDeveloperInstructions
      ? [
          `developer_instructions = ${tomlString(resolvedDeveloperInstructions)}`
        ]
      : []),
    "include_permissions_instructions = false",
    "include_apps_instructions = false",
    "include_collaboration_mode_instructions = false",
    "include_environment_context = false",
    "project_doc_max_bytes = 4096",
    'web_search = "disabled"',
    "",
    "[features]",
    "mcp_2026_07_28 = true",
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
  const inline: Record<string, unknown> = {
    model,
    model_reasoning_effort: reasoningEffort,
    model_reasoning_summary: "concise",
    approval_policy: "never",
    suppress_unstable_features_warning: true,
    ...(resolvedDeveloperInstructions
      ? { developer_instructions: resolvedDeveloperInstructions }
      : {}),
    include_permissions_instructions: false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    project_doc_max_bytes: 4096,
    web_search: "disabled",
    features: { mcp_2026_07_28: true },
    agents: { enabled: false },
    skills: { include_instructions: false },
    ...(koedEnabled
      ? {
          mcp_servers: {
            koed: {
              url: bridgeUrl!,
              bearer_token_env_var: BENCHMARK_MCP_TOKEN_ENV,
              enabled_tools: ["memory_answer"],
              required: true,
              default_tools_approval_mode: "approve"
            }
          }
        }
      : {})
  };
  return {
    serialized: `${lines.join("\n")}\n`,
    inline: Object.freeze(inline),
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
