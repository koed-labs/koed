import type { CodexThreadTokenUsage } from "./codex-app-server-runner.js";

type Counts = NonNullable<CodexThreadTokenUsage["last"]>;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Count only terminal message_end events, never their streaming/snapshot copies.
 * Pi input excludes cache reads/writes; Koed input includes both. Reasoning is
 * already included in output. Missing fields remain unknown across the run.
 */
export function createPiTokenUsageAccumulator() {
  let messages = 0;
  let totals: Counts = {};
  const seen = new Set<string>();
  return {
    observe(event: Record<string, unknown>) {
      if (event.type !== "message_end") return;
      const message = event.message as Record<string, unknown> | undefined;
      if (
        !message ||
        message.role !== "assistant" ||
        message.stopReason === "pending"
      )
        return;
      // RPC can replay an identified completed message. Unidentified terminal
      // events are separate observations; content equality is not identity.
      const id =
        typeof message.responseId === "string"
          ? message.responseId
          : typeof message.id === "string"
            ? message.id
            : undefined;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      const usage =
        message.usage && typeof message.usage === "object"
          ? (message.usage as Record<string, unknown>)
          : {};
      const input = [
        count(usage.input),
        count(usage.cacheRead),
        count(usage.cacheWrite)
      ];
      const next: Counts = {
        inputTokens: input.every((v) => v !== undefined)
          ? input.reduce<number>((sum, v) => sum + v!, 0)
          : undefined,
        cachedInputTokens: count(usage.cacheRead),
        outputTokens: count(usage.output),
        reasoningOutputTokens: count(usage.reasoning),
        totalTokens: count(usage.totalTokens)
      };
      if (!messages++) totals = next;
      else
        for (const key of Object.keys(next) as (keyof Counts)[]) {
          const sum =
            totals[key] === undefined || next[key] === undefined
              ? undefined
              : totals[key]! + next[key]!;
          totals[key] =
            sum !== undefined && Number.isSafeInteger(sum) ? sum : undefined;
        }
    },
    value(): CodexThreadTokenUsage | undefined {
      return messages && Object.values(totals).some((v) => v !== undefined)
        ? { last: { ...totals }, total: { ...totals } }
        : undefined;
    }
  };
}
