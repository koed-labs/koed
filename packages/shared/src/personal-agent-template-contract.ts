import { z } from "zod";

export const PERSONAL_AGENT_TEMPLATE_ID_MAX_LENGTH = 96;
export const PERSONAL_AGENT_TEMPLATE_TITLE_MAX_LENGTH = 128;
export const PERSONAL_AGENT_TEMPLATE_SOUL_MAX_LENGTH = 65_536;

const templateId = z
  .string()
  .min(1)
  .max(PERSONAL_AGENT_TEMPLATE_ID_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

export const personalAgentTemplateProvenanceSchema = z
  .object({
    sourceTemplateId: templateId.nullable(),
    sourceTemplateVersion: z.number().int().positive().safe().nullable()
  })
  .strict()
  .refine(
    (value) =>
      (value.sourceTemplateId === null) ===
      (value.sourceTemplateVersion === null),
    {
      message: "Template source ID and version must both be set or both be null"
    }
  );

export type PersonalAgentTemplateProvenance = z.infer<
  typeof personalAgentTemplateProvenanceSchema
>;

export const personalAgentRoleTemplateSchema = z
  .object({
    id: templateId,
    version: z.number().int().positive(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(PERSONAL_AGENT_TEMPLATE_TITLE_MAX_LENGTH),
    role: z.string().trim().min(1).max(160),
    soulInstructions: z
      .string()
      .trim()
      .min(1)
      .max(PERSONAL_AGENT_TEMPLATE_SOUL_MAX_LENGTH),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict();

export type PersonalAgentRoleTemplate = z.infer<
  typeof personalAgentRoleTemplateSchema
>;
