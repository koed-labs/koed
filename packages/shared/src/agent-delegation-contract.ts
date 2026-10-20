import { z } from "zod";

export const agentDelegationRequestIdSchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const agentDelegationPromptSchema = z
  .string()
  .min(1)
  .max(256_000)
  .refine((value) => value.trim().length > 0);

export const agentDelegationBodySchema = z
  .object({
    agentId: z.uuid(),
    executionGeneration: z.number().int().positive(),
    requestId: agentDelegationRequestIdSchema,
    prompt: agentDelegationPromptSchema
  })
  .strict();
export const agentDelegationColdBodySchema = agentDelegationBodySchema
  .omit({ executionGeneration: true })
  .strict();
export const agentDelegationParamsSchema = z
  .object({ executionId: z.uuid() })
  .strict();
export const agentDelegationProjectParamsSchema = z
  .object({ projectId: z.uuid() })
  .strict();
export const agentDelegationListQuerySchema =
  agentDelegationProjectParamsSchema;

export const agentDelegationItemSchema = z
  .object({
    parentExecutionId: z.uuid().nullable(),
    childExecutionId: z.uuid(),
    agentId: z.uuid(),
    taskLabel: z.string().min(1).max(200),
    childSessionId: z.uuid().nullable(),
    childState: z.string().min(1).max(64)
  })
  .strict();
export const agentDelegationsResponseSchema = z
  .object({ items: z.array(agentDelegationItemSchema).max(100) })
  .strict();
export const agentDelegationResponseSchema = z
  .object({
    executionId: z.uuid(),
    agentId: z.uuid(),
    reused: z.boolean()
  })
  .strict();
