import { z } from "zod";
import { personalFolderReferenceSchema } from "@koed-labs/shared/personal-source";

export const v1StateChannel = "koed:v1-state:command";
const id = z.string().trim().min(1).max(512);
const uuid = z.uuid();
const name = z.string().trim().min(1).max(80);
// A Create your Kin JSON file is about 500 characters; leave room for growth.
const look = z.string().trim().min(1).max(4096);
const optionalText = z.string().trim().min(1).max(512);

export const v1ProfileSchema = z
  .object({
    agentName: name.optional(),
    agentLook: look.optional(),
    onboarding: z
      .object({
        draft: z.record(z.string().max(80), z.unknown()).optional(),
        step: z.string().trim().min(1).max(80).optional(),
        selections: z
          .record(z.string().max(80), z.string().max(512))
          .default({}),
        completed: z.boolean().default(false)
      })
      .strict()
      .default({ selections: {}, completed: false })
  })
  .strict();
export type V1Profile = z.infer<typeof v1ProfileSchema>;

export const v1InitialPromptSchema = z
  .object({
    clientUserMessageId: uuid,
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(256 * 1024),
    status: z.enum(["rejected", "reconciling", "queued"]),
    message: z.string().max(512)
  })
  .strict();

export const v1ConversationIntentSchema = z
  .object({
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._:-]+$/u)
      .refine(
        (value) => !["__proto__", "constructor", "prototype"].includes(value)
      ),
    projectId: id,
    presentationProjectId: uuid.optional(),
    projectMembershipConfirmed: z.boolean().optional(),
    contextKind: z.enum(["project", "independent"]).optional(),
    aiClientDriverId: z.enum(["codex", "claude", "pi"]),
    aiClientInstanceId: id,
    model: optionalText,
    reasoningEffort: optionalText.nullable(),
    permissionMode: z.enum(["supervised", "auto_edit", "auto", "full_access"]),
    runnerKind: z.literal("local_device"),
    chiefOfStaffName: name.optional(),
    executionId: uuid.optional(),
    capturedSessionId: uuid.optional(),
    initialPrompt: v1InitialPromptSchema.optional(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();
export type V1ConversationIntent = z.infer<typeof v1ConversationIntentSchema>;

export const v1ProjectIntentSchema = z
  .object({
    requestId: uuid,
    name: z.string().trim().min(1).max(160),
    folder: personalFolderReferenceSchema.optional(),
    folderAttached: z.boolean().optional(),
    projectId: uuid.optional(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();
export type V1ProjectIntent = z.infer<typeof v1ProjectIntentSchema>;

export const v1ProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversations: z.record(z.string(), v1ConversationIntentSchema),
    projects: z.record(z.string(), v1ProjectIntentSchema)
  })
  .strict();
export type V1Provenance = z.infer<typeof v1ProvenanceSchema>;

export const v1StateRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("identity_read") }).strict(),
  z.object({ operation: z.literal("profile_read") }).strict(),
  z
    .object({ operation: z.literal("profile_write"), profile: v1ProfileSchema })
    .strict(),
  z.object({ operation: z.literal("provenance_read") }).strict(),
  z
    .object({
      operation: z.literal("conversation_intent_put"),
      intent: v1ConversationIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("conversation_ack"),
      idempotencyKey: v1ConversationIntentSchema.shape.idempotencyKey,
      executionId: uuid,
      capturedSessionId: uuid.optional(),
      projectMembershipConfirmed: z.literal(true).optional()
    })
    .strict(),
  z
    .object({
      operation: z.literal("conversation_prompt"),
      idempotencyKey: v1ConversationIntentSchema.shape.idempotencyKey,
      initialPrompt: v1InitialPromptSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("project_intent_put"),
      intent: v1ProjectIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("project_ack"),
      requestId: uuid,
      projectId: uuid
    })
    .strict(),
  z
    .object({ operation: z.literal("project_folder_ack"), requestId: uuid })
    .strict()
]);
export type V1StateRequest = z.infer<typeof v1StateRequestSchema>;

export const v1StateResponseSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("identity_read"),
      ownerId: uuid,
      scopeKey: z.string().regex(/^[0-9a-f]{64}$/u)
    })
    .strict(),
  z
    .object({ operation: z.literal("profile_read"), profile: v1ProfileSchema })
    .strict(),
  z
    .object({ operation: z.literal("profile_write"), profile: v1ProfileSchema })
    .strict(),
  z
    .object({
      operation: z.literal("provenance_read"),
      provenance: v1ProvenanceSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("conversation_intent_put"),
      intent: v1ConversationIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("conversation_ack"),
      intent: v1ConversationIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("conversation_prompt"),
      intent: v1ConversationIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("project_intent_put"),
      intent: v1ProjectIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("project_ack"),
      intent: v1ProjectIntentSchema
    })
    .strict(),
  z
    .object({
      operation: z.literal("project_folder_ack"),
      intent: v1ProjectIntentSchema
    })
    .strict()
]);
export type V1StateResponse = z.infer<typeof v1StateResponseSchema>;

export interface V1StateDesktopApi {
  readIdentity(): Promise<{ ownerId: string; scopeKey: string }>;
  readProfile(): Promise<V1Profile>;
  writeProfile(profile: V1Profile): Promise<V1Profile>;
  readProvenance(): Promise<V1Provenance>;
  putConversationIntent(
    intent: V1ConversationIntent
  ): Promise<V1ConversationIntent>;
  saveInitialPrompt(input: {
    idempotencyKey: string;
    initialPrompt: z.infer<typeof v1InitialPromptSchema>;
  }): Promise<V1ConversationIntent>;
  ackConversation(input: {
    idempotencyKey: string;
    executionId: string;
    capturedSessionId?: string;
    projectMembershipConfirmed?: true;
  }): Promise<V1ConversationIntent>;
  putProjectIntent(intent: V1ProjectIntent): Promise<V1ProjectIntent>;
  ackProjectFolder(requestId: string): Promise<V1ProjectIntent>;
  ackProject(input: {
    requestId: string;
    projectId: string;
  }): Promise<V1ProjectIntent>;
}
