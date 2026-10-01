import { z } from "zod";

import {
  PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH,
  PERSONAL_AGENT_MODEL_MAX_LENGTH,
  PERSONAL_AGENT_NAME_MAX_LENGTH,
  PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH,
  PERSONAL_AGENT_ROLE_MAX_LENGTH,
  PERSONAL_AGENT_SOUL_MAX_LENGTH
} from "@koed/shared";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedTextAllowEmpty = (maximum: number) =>
  z.string().trim().max(maximum);

const optionalNullableText = (maximum: number) =>
  z.string().trim().max(maximum).nullable();
const optionalDefaultProvider = z
  .string()
  .trim()
  .min(1)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/)
  .nullable();
const optionalDefaultModel = z
  .string()
  .trim()
  .min(1)
  .max(PERSONAL_AGENT_MODEL_MAX_LENGTH)
  .nullable();
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

export const personalAgentCreateSchema = z
  .object({
    requestId: z.uuid(),
    name: boundedText(PERSONAL_AGENT_NAME_MAX_LENGTH),
    role: boundedTextAllowEmpty(PERSONAL_AGENT_ROLE_MAX_LENGTH)
      .optional()
      .default(""),
    avatarReference: optionalNullableText(
      PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH
    )
      .optional()
      .default(null),
    soulInstructions: boundedText(PERSONAL_AGENT_SOUL_MAX_LENGTH),
    defaultProvider: optionalDefaultProvider.optional().default(null),
    defaultModel: optionalDefaultModel.optional().default(null),
    defaultReasoningEffort: optionalNullableText(
      PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH
    )
      .optional()
      .default(null),
    sourceTemplateId: z
      .string()
      .max(96)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .nullable()
      .optional()
      .default(null),
    sourceTemplateVersion: z
      .number()
      .int()
      .positive()
      .safe()
      .nullable()
      .optional()
      .default(null)
  })
  .strict()
  .refine(
    (value) =>
      (value.defaultProvider === null) === (value.defaultModel === null),
    { message: "Default provider and model must both be set or both be null" }
  )
  .refine(
    (value) =>
      value.defaultProvider !== null || value.defaultReasoningEffort === null,
    {
      message:
        "Default reasoning effort must be null when no provider and model are saved"
    }
  )
  .refine(
    (value) =>
      (value.sourceTemplateId === null) ===
      (value.sourceTemplateVersion === null),
    {
      message: "Template source ID and version must both be set or both be null"
    }
  );

export const personalAgentUpdateSchema = z
  .object({
    requestId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    name: boundedText(PERSONAL_AGENT_NAME_MAX_LENGTH).optional(),
    role: boundedTextAllowEmpty(PERSONAL_AGENT_ROLE_MAX_LENGTH).optional(),
    avatarReference: optionalNullableText(
      PERSONAL_AGENT_AVATAR_REFERENCE_MAX_LENGTH
    ).optional(),
    soulInstructions: boundedText(PERSONAL_AGENT_SOUL_MAX_LENGTH).optional(),
    defaultProvider: optionalDefaultProvider.optional(),
    defaultModel: optionalDefaultModel.optional(),
    defaultReasoningEffort: optionalNullableText(
      PERSONAL_AGENT_REASONING_EFFORT_MAX_LENGTH
    ).optional(),
    sourceTemplateId: z
      .string()
      .max(96)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .nullable()
      .optional(),
    sourceTemplateVersion: z
      .number()
      .int()
      .positive()
      .safe()
      .nullable()
      .optional()
  })
  .strict()
  .refine(
    (value) =>
      !(
        value.defaultProvider === null &&
        value.defaultModel === null &&
        value.defaultReasoningEffort != null
      ),
    {
      message:
        "Default reasoning effort must be null when no provider and model are saved"
    }
  )
  .refine(
    (value) =>
      (value.sourceTemplateId === undefined &&
        value.sourceTemplateVersion === undefined) ||
      (value.sourceTemplateId === null &&
        value.sourceTemplateVersion === null) ||
      (typeof value.sourceTemplateId === "string" &&
        typeof value.sourceTemplateVersion === "number"),
    { message: "Template source ID and version must be updated together" }
  )
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => key !== "requestId" && key !== "expectedVersion"
      ),
    { message: "At least one Personal Agent field must be updated" }
  );

export const personalAgentRetireSchema = z
  .object({ requestId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();

export const personalAgentRestoreSchema = z
  .object({ requestId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();
