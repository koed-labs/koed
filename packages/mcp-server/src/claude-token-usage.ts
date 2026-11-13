import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CodexThreadTokenUsage } from "./codex-app-server-runner.js";

const sum = (values: unknown[]): number | undefined => {
  if (
    !values.length ||
    !values.every(
      (value) =>
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    )
  )
    return undefined;
  const total = (values as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(total) ? total : undefined;
};

export const claudeAgentSdkTokenUsage = (
  message: Extract<SDKMessage, { type: "result" }>
): CodexThreadTokenUsage | undefined => {
  const usages = Object.values(message.modelUsage ?? {});
  if (!usages.length) return undefined;
  const inputTokens = sum(
    usages.flatMap((usage) => [
      usage.inputTokens,
      usage.cacheReadInputTokens,
      usage.cacheCreationInputTokens
    ])
  );
  const outputTokens = sum(usages.map((usage) => usage.outputTokens));
  const last = {
    inputTokens,
    outputTokens,
    cachedInputTokens: sum(usages.map((usage) => usage.cacheReadInputTokens)),
    totalTokens: sum([inputTokens, outputTokens])
  };
  const windows = usages
    .map((usage) => usage.contextWindow)
    .filter(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
    );
  return {
    last,
    total: { ...last },
    modelContextWindow: windows.length ? Math.max(...windows) : undefined
  };
};

/** One independent SDK query: the latest cumulative result replaces steps.
 * Without a result, assistant IDs deduplicate input/cache observations. Their
 * output counts are placeholders and must remain unknown.
 */
export function createClaudeTokenUsageAccumulator() {
  let result: CodexThreadTokenUsage | undefined;
  const inputs = new Map<string, { input?: number; cached?: number }>();
  return {
    observe(message: SDKMessage) {
      if (message.type === "result") result = claudeAgentSdkTokenUsage(message);
      if (message.type !== "assistant" || message.parent_tool_use_id) return;
      const { id, usage } = message.message;
      if (!id || !usage) return;
      inputs.set(id, {
        input: sum([
          usage.input_tokens,
          usage.cache_read_input_tokens,
          usage.cache_creation_input_tokens
        ]),
        cached: sum([usage.cache_read_input_tokens])
      });
    },
    value(): CodexThreadTokenUsage | undefined {
      if (result) return result;
      if (!inputs.size) return undefined;
      return {
        last: {
          inputTokens: sum([...inputs.values()].map((usage) => usage.input)),
          cachedInputTokens: sum(
            [...inputs.values()].map((usage) => usage.cached)
          )
        }
      };
    }
  };
}
