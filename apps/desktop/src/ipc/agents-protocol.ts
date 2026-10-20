import {
  agentCreateSchema,
  agentPatchSchema,
  agentSchema
} from "@koed/shared/agent-contract";
import {
  agentDelegationBodySchema,
  agentDelegationColdBodySchema,
  agentDelegationParamsSchema,
  agentDelegationProjectParamsSchema,
  agentDelegationResponseSchema,
  agentDelegationsResponseSchema
} from "@koed/shared/agent-delegation-contract";
import { z } from "zod";

export const agentsCommandChannel = "koed:agents:command";
export const agentsRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("ensureChief") }).strict(),
  z.object({ operation: z.literal("ensureHelpers") }).strict(),
  agentDelegationProjectParamsSchema
    .extend({ operation: z.literal("delegations") })
    .strict(),
  z
    .object({
      operation: z.literal("delegate"),
      parentExecutionId: agentDelegationParamsSchema.shape.executionId,
      ...agentDelegationBodySchema.shape
    })
    .strict(),
  z
    .object({
      operation: z.literal("delegateCold"),
      ...agentDelegationProjectParamsSchema.shape,
      ...agentDelegationColdBodySchema.shape
    })
    .strict(),
  z
    .object({ operation: z.literal("create"), agent: agentCreateSchema })
    .strict(),
  z
    .object({
      operation: z.literal("patch"),
      id: z.uuid(),
      patch: agentPatchSchema
    })
    .strict()
]);
export const agentsResultSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("list"), agents: z.array(agentSchema) })
    .strict(),
  z
    .object({ operation: z.literal("ensureChief"), agent: agentSchema })
    .strict(),
  z
    .object({
      operation: z.literal("ensureHelpers"),
      agents: z.array(agentSchema)
    })
    .strict(),
  z.object({ operation: z.literal("create"), agent: agentSchema }).strict(),
  agentDelegationsResponseSchema
    .extend({ operation: z.literal("delegations") })
    .strict(),
  agentDelegationResponseSchema
    .extend({ operation: z.literal("delegate") })
    .strict(),
  agentDelegationResponseSchema
    .extend({ operation: z.literal("delegateCold") })
    .strict(),
  z.object({ operation: z.literal("patch"), agent: agentSchema }).strict()
]);
export type AgentsRequest = z.infer<typeof agentsRequestSchema>;
export type AgentsResult = z.infer<typeof agentsResultSchema>;
export interface AgentsDesktopApi {
  delegations(
    projectId: string
  ): Promise<Extract<AgentsResult, { operation: "delegations" }>["items"]>;
  delegate(
    input: Omit<Extract<AgentsRequest, { operation: "delegate" }>, "operation">
  ): Promise<Extract<AgentsResult, { operation: "delegate" }>>;
  delegateCold(
    input: Omit<
      Extract<AgentsRequest, { operation: "delegateCold" }>,
      "operation"
    >
  ): Promise<Extract<AgentsResult, { operation: "delegateCold" }>>;
  list(): Promise<z.infer<typeof agentSchema>[]>;
  ensureChief(): Promise<z.infer<typeof agentSchema>>;
  ensureHelpers(): Promise<z.infer<typeof agentSchema>[]>;
  create(
    agent: z.infer<typeof agentCreateSchema>
  ): Promise<z.infer<typeof agentSchema>>;
  patch(
    id: string,
    patch: z.infer<typeof agentPatchSchema>
  ): Promise<z.infer<typeof agentSchema>>;
}
