import { z } from "zod";

import {
  PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH,
  PERSONAL_AGENT_NAME_MAX_LENGTH,
  PERSONAL_AGENT_ROLE_MAX_LENGTH
} from "@koed/shared";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedTextAllowEmpty = (maximum: number) =>
  z.string().trim().max(maximum);

const optionalNullableText = (maximum: number) =>
  z.string().trim().max(maximum).nullable();
export const personalAgentIdParamsSchema = z
  .object({ agentId: z.uuid() })
  .strict();

export const personalAgentListQuerySchema = z.object({}).strict();

export const personalAgentActivityQuerySchema = z
  .object({
    agentId: z.union([z.uuid(), z.array(z.uuid()).min(1).max(100)])
  })
  .strict()
  .transform(({ agentId }) => {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];
    return { agentIds };
  })
  .refine(({ agentIds }) => new Set(agentIds).size === agentIds.length, {
    message: "Agent IDs must be unique"
  });

const historyLimit = z
  .string()
  .regex(/^\d{1,2}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(20));

export const personalAgentHistoryQuerySchema = z
  .object({
    limit: historyLimit.optional().default(20),
    before: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional()
  })
  .strict();

// Agent profiles are presentation metadata. Execution settings belong to chats.
const agentAppearanceFields = {
  name: boundedText(PERSONAL_AGENT_NAME_MAX_LENGTH),
  role: boundedTextAllowEmpty(PERSONAL_AGENT_ROLE_MAX_LENGTH),
  avatarReference: optionalNullableText(
    PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH
  )
};

export const personalAgentCreateSchema = z
  .object({
    requestId: z.uuid(),
    name: agentAppearanceFields.name,
    role: agentAppearanceFields.role.optional().default(""),
    avatarReference: agentAppearanceFields.avatarReference
      .optional()
      .default(null)
  })
  .strict();

export const personalAgentUpdateSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    name: agentAppearanceFields.name.optional(),
    role: agentAppearanceFields.role.optional(),
    avatarReference: agentAppearanceFields.avatarReference.optional()
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => key !== "requestId" && key !== "expectedVersion"
      ),
    {
      message: "At least one Personal Agent field must be updated"
    }
  );

export const personalAgentRetireSchema = z
  .object({ requestId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();

export const personalAgentRestoreSchema = z
  .object({ requestId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();
