import { z } from "zod";

export const localMemoryAgentFlowKeySchema = z.enum([
  "mcp_memory_answer",
  "lcm_summary"
]);

export const localMemoryAgentSettingsParamsSchema = z.object({
  flowKey: localMemoryAgentFlowKeySchema
});

export const localMemoryAgentSettingsSchema = z
  .object({
    provider: z.literal("codex").default("codex"),
    model: z.string().trim().min(1),
    reasoning_effort: z.string().trim().min(1),
    timeout_ms: z.coerce.number().int().min(1000).max(600000),
    max_attempts: z.coerce.number().int().min(1).max(25)
  })
  .strict();
