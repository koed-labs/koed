import { z } from "zod";

import {
  aiClientIdentifierPattern,
  aiClientPermissionModes
} from "./ai-client-contract.js";

const uuid = z.uuid();
const timestamp = z.string().datetime({ offset: true });
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum: number) => text(maximum).nullable();

export const personalAgentChatStatusSchema = z.enum([
  "idle",
  "queued",
  "running",
  "blocked",
  "uncertain",
  "failed",
  "canceled"
]);

export const personalAgentChatDeliveryStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "uncertain",
  "blocked",
  "canceled",
  "skipped"
]);

export const personalAgentChatContextTransferSchema = z
  .object({
    cursorBeforeSequence: z.number().int().nonnegative(),
    cursorThroughSequence: z.number().int().nonnegative(),
    lastContextMessageSequence: z.number().int().nonnegative().nullable(),
    transferredExchanges: z.number().int().nonnegative(),
    transferredMessages: z.number().int().nonnegative(),
    omittedExchanges: z.number().int().nonnegative(),
    omittedMessages: z.number().int().nonnegative(),
    includedUtf8Bytes: z.number().int().nonnegative(),
    omittedUtf8Bytes: z.number().int().nonnegative(),
    omittedUtf8BytesKnown: z.boolean().default(true),
    truncated: z.boolean(),
    omissionsStatus: z.literal("not_provided"),
    omittedSequenceRange: z
      .object({
        from: z.number().int().positive(),
        through: z.number().int().positive()
      })
      .strict()
      .nullable()
  })
  .strict();

const launchSettings = {
  provider: text(96).regex(aiClientIdentifierPattern),
  aiClientInstanceId: text(128).regex(aiClientIdentifierPattern),
  targetDeviceId: text(128),
  model: text(512),
  reasoningEffort: nullableText(64),
  permissionMode: z.enum(aiClientPermissionModes),
  selectedResourceIds: z.array(text(160)).max(32).default([]),
  selectedResourceHostedInstanceId: text(160).optional()
};

export const personalAgentChatAgentLaunchSnapshotSchema = z
  .object({
    kind: z.literal("agent"),
    agentId: uuid,
    agentVersion: z.number().int().positive(),
    ...launchSettings
  })
  .strict();

export const personalAgentChatGenericLaunchSnapshotSchema = z
  .object({
    kind: z.literal("generic"),
    agentId: z.null(),
    agentVersion: z.null(),
    ...launchSettings
  })
  .strict();

export const personalAgentChatLaunchSnapshotSchema = z
  .discriminatedUnion("kind", [
    personalAgentChatAgentLaunchSnapshotSchema,
    personalAgentChatGenericLaunchSnapshotSchema
  ])
  .refine(
    (launch) =>
      launch.selectedResourceIds.length > 0 ===
      Boolean(launch.selectedResourceHostedInstanceId),
    { message: "Selected AI Client Skills require their verified instance" }
  );

export const personalAgentChatSubmitSchema = z
  .object({
    requestId: uuid,
    text: text(256_000),
    sourceExecutionId: uuid.optional(),
    context: z
      .object({
        projectId: text(2_048).nullable(),
        contextKind: z.enum(["project", "independent"]),
        targetDeviceId: text(128)
      })
      .strict()
      .refine(
        (value) =>
          (value.contextKind === "project") === (value.projectId !== null),
        { message: "Conversation context and Project selection do not match" }
      ),
    recipients: z.array(personalAgentChatLaunchSnapshotSchema).min(1).max(16)
  })
  .strict()
  .refine(
    (value) =>
      new Set(
        value.recipients
          .filter((recipient) => recipient.kind === "agent")
          .map((recipient) => recipient.agentId)
      ).size === value.recipients.filter((r) => r.kind === "agent").length,
    { message: "A Personal Agent can appear only once per submission" }
  )
  .refine(
    (value) =>
      value.recipients.every((recipient) => recipient.kind === "agent") ||
      (value.recipients.length === 1 &&
        value.recipients[0]?.kind === "generic"),
    { message: "An unnamed AI Client turn cannot share a recipient batch" }
  )
  .refine(
    (value) =>
      value.recipients.every(
        (recipient) => recipient.targetDeviceId === value.context.targetDeviceId
      ),
    {
      message:
        "All Agents in one conversation must use the same Personal Device"
    }
  );

export const personalAgentChatParticipantSchema = z
  .object({
    agentId: uuid,
    agentVersion: z.number().int().positive(),
    name: text(80),
    avatarReference: z.string().trim().max(2_048).nullable(),
    ordinal: z.number().int().nonnegative(),
    launch: personalAgentChatAgentLaunchSnapshotSchema,
    executionId: uuid.nullable(),
    lastContextCursor: z.number().int().nonnegative(),
    status: personalAgentChatDeliveryStatusSchema,
    updatedAt: timestamp
  })
  .strict();

export const personalAgentChatMessageSchema = z
  .object({
    id: uuid,
    sequence: z.number().int().positive(),
    turnId: uuid,
    requestId: uuid,
    kind: z.enum(["user", "agent_reply"]),
    text: z.string(),
    authorAgentId: uuid.nullable(),
    authorAgentVersion: z.number().int().positive().nullable(),
    authorName: text(80).nullable(),
    provider: text(96).nullable(),
    aiClientInstanceId: text(128).nullable(),
    executionId: uuid.nullable(),
    sourceExecutionId: uuid.nullable(),
    sourceCommandId: uuid.nullable(),
    jobId: uuid.nullable(),
    truncated: z.boolean(),
    state: z.enum(["pending", "completed", "failed", "uncertain", "canceled"]),
    createdAt: timestamp
  })
  .strict();

export const personalAgentChatDeliverySchema = z
  .object({
    id: uuid,
    turnId: uuid,
    messageId: uuid,
    recipientKind: z.enum(["agent", "generic"]),
    agentId: uuid.nullable(),
    agentVersion: z.number().int().positive().nullable(),
    agentName: text(80).nullable(),
    ordinal: z.number().int().nonnegative(),
    executionId: uuid.nullable(),
    commandId: uuid.nullable(),
    jobId: uuid.nullable(),
    provider: text(96).nullable(),
    aiClientInstanceId: text(128).nullable(),
    model: text(512).nullable(),
    status: personalAgentChatDeliveryStatusSchema,
    errorCode: text(120).nullable(),
    canContinue: z.boolean(),
    progress: z
      .object({
        stage: text(80).nullable(),
        summary: z.string().max(512).nullable(),
        observedAt: timestamp.nullable()
      })
      .strict(),
    contextTransfer: personalAgentChatContextTransferSchema.nullable(),
    diffAvailable: z.boolean(),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    updatedAt: timestamp
  })
  .strict();

export const personalAgentChatConversationSummarySchema = z
  .object({
    conversationId: uuid,
    title: text(120).nullable(),
    projectId: text(2_048).nullable(),
    contextKind: z.enum(["project", "independent"]),
    activeAgentId: uuid.nullable(),
    activeExecutionId: uuid.nullable(),
    activeProvider: text(96).nullable(),
    status: personalAgentChatStatusSchema,
    participantCount: z.number().int().nonnegative(),
    latestAgentId: uuid.nullable(),
    latestAgentName: text(80).nullable(),
    updatedAt: timestamp,
    sourceExecutionIds: z.array(uuid),
    childExecutionIds: z.array(uuid),
    capturedSessionIds: z.array(uuid)
  })
  .strict();

export const personalAgentChatConversationSchema = z
  .object({
    contractVersion: z.literal(1),
    conversationId: uuid,
    title: text(120).nullable(),
    projectId: text(2_048).nullable(),
    contextKind: z.enum(["project", "independent"]),
    status: personalAgentChatStatusSchema,
    activeAgentId: uuid.nullable(),
    activeExecutionId: uuid.nullable(),
    activeProvider: text(96).nullable(),
    sourceExecutionIds: z.array(uuid),
    childExecutionIds: z.array(uuid),
    capturedSessionIds: z.array(uuid),
    participants: z.array(personalAgentChatParticipantSchema).max(16),
    messages: z.array(personalAgentChatMessageSchema),
    deliveries: z.array(personalAgentChatDeliverySchema),
    createdAt: timestamp,
    updatedAt: timestamp
  })
  .strict();

export const personalAgentChatReadResponseSchema = z
  .object({
    conversation: personalAgentChatConversationSchema,
    timelinePage: z
      .object({
        hasMore: z.boolean(),
        nextCursor: z.number().int().positive().nullable()
      })
      .strict()
  })
  .strict();

export const personalAgentChatConversationPageSchema = z
  .object({
    conversations: z.array(personalAgentChatConversationSummarySchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable()
  })
  .strict();

export const personalAgentChatSubmitResponseSchema = z
  .object({
    conversation: personalAgentChatConversationSchema,
    message: personalAgentChatMessageSchema,
    deliveries: z.array(personalAgentChatDeliverySchema)
  })
  .strict();

export const personalAgentChatCancelSchema = z
  .object({ requestId: uuid })
  .strict();

export const personalAgentChatContinueSchema = z
  .object({ requestId: uuid, skipFailedDeliveryId: uuid })
  .strict();

export const personalAgentChatCancelResponseSchema = z
  .object({
    conversation: personalAgentChatConversationSchema,
    messageId: uuid,
    canceledDeliveryIds: z.array(uuid)
  })
  .strict();

export const personalAgentChatContinueResponseSchema = z
  .object({
    conversation: personalAgentChatConversationSchema,
    skippedDeliveryId: uuid,
    resumedDeliveryId: uuid.nullable()
  })
  .strict();

export const personalAgentChatRenameSchema = z
  .object({ requestId: uuid, title: text(120).nullable() })
  .strict();

export type PersonalAgentChatStatus = z.infer<
  typeof personalAgentChatStatusSchema
>;
export type PersonalAgentChatDeliveryStatus = z.infer<
  typeof personalAgentChatDeliveryStatusSchema
>;
export type PersonalAgentChatContextTransfer = z.infer<
  typeof personalAgentChatContextTransferSchema
>;
export type PersonalAgentChatLaunchSnapshot = z.infer<
  typeof personalAgentChatLaunchSnapshotSchema
>;
export type PersonalAgentChatSubmit = z.infer<
  typeof personalAgentChatSubmitSchema
>;
export type PersonalAgentChatParticipant = z.infer<
  typeof personalAgentChatParticipantSchema
>;
export type PersonalAgentChatMessage = z.infer<
  typeof personalAgentChatMessageSchema
>;
export type PersonalAgentChatDelivery = z.infer<
  typeof personalAgentChatDeliverySchema
>;
export type PersonalAgentChatConversationSummary = z.infer<
  typeof personalAgentChatConversationSummarySchema
>;
export type PersonalAgentChatConversation = z.infer<
  typeof personalAgentChatConversationSchema
>;
export type PersonalAgentChatConversationPage = z.infer<
  typeof personalAgentChatConversationPageSchema
>;
export type PersonalAgentChatReadResponse = z.infer<
  typeof personalAgentChatReadResponseSchema
>;
