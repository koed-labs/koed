import { z } from "zod";

import {
  COLLABORATION_HISTORY_PAGE_MAX_ITEMS,
  COLLABORATION_MAX_DM_PARTICIPANTS as SHARED_COLLABORATION_MAX_DM_PARTICIPANTS,
  COLLABORATION_MESSAGE_MAX_UTF8_BYTES,
  COLLABORATION_NAME_MAX_CODE_POINTS,
  COLLABORATION_REALTIME_CURSOR_MAX_BYTES,
  COLLABORATION_TEAM_MESSAGE_MENTION_MAX,
  COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES
} from "@koed/shared";

export const COLLABORATION_CHANNEL_NAME_MAX_CODE_POINTS =
  COLLABORATION_NAME_MAX_CODE_POINTS;
export const COLLABORATION_TOPIC_MAX_BYTES =
  COLLABORATION_TOPIC_DESCRIPTION_MAX_UTF8_BYTES;
export const COLLABORATION_MESSAGE_MAX_BYTES =
  COLLABORATION_MESSAGE_MAX_UTF8_BYTES;
export const COLLABORATION_IDEMPOTENCY_KEY_MAX_LENGTH = 512;
export const COLLABORATION_MAX_DM_PARTICIPANTS =
  SHARED_COLLABORATION_MAX_DM_PARTICIPANTS;
export const COLLABORATION_MAX_PAGE_SIZE = COLLABORATION_HISTORY_PAGE_MAX_ITEMS;
export const COLLABORATION_REALTIME_CLIENT_KEY_MAX_LENGTH = 160;
export const COLLABORATION_REALTIME_CURSOR_MAX_LENGTH =
  COLLABORATION_REALTIME_CURSOR_MAX_BYTES;

const strictUuidSchema = z.uuid();
const normalizedRequiredTextSchema = z
  .string()
  .transform((value) => value.trim().normalize("NFC"))
  .pipe(z.string().min(1));
const boundedCodePointsSchema = (maximum: number) =>
  normalizedRequiredTextSchema.refine(
    (value) => [...value].length <= maximum,
    `Must contain at most ${maximum} Unicode code points`
  );
const boundedUtf8Schema = (maximum: number) =>
  normalizedRequiredTextSchema.refine(
    (value) => Buffer.byteLength(value, "utf8") <= maximum,
    `Must contain at most ${maximum} UTF-8 bytes`
  );
const channelNameSchema = boundedCodePointsSchema(
  COLLABORATION_CHANNEL_NAME_MAX_CODE_POINTS
);
const topicSchema = boundedUtf8Schema(COLLABORATION_TOPIC_MAX_BYTES);
const messageBodySchema = boundedUtf8Schema(COLLABORATION_MESSAGE_MAX_BYTES);
const realtimeBindingKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(COLLABORATION_REALTIME_CLIENT_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._:-]+$/);

const realtimeCursorSchema = z
  .string()
  .trim()
  .min(16)
  .max(COLLABORATION_REALTIME_CURSOR_MAX_LENGTH)
  .regex(/^crt1\.[A-Za-z0-9_-]+$/);

const includeArchivedSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const pageLimitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(COLLABORATION_MAX_PAGE_SIZE)
  .optional();

export const collaborationIdempotencyHeadersSchema = z.object({
  "idempotency-key": z
    .string()
    .trim()
    .min(1)
    .max(COLLABORATION_IDEMPOTENCY_KEY_MAX_LENGTH)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
});

export const emptyCollaborationBodySchema = z.object({}).strict().optional();

export const collaborationThreadParamsSchema = z
  .object({ threadId: strictUuidSchema })
  .strict();

export const teamCollaborationParamsSchema = z
  .object({ teamId: strictUuidSchema })
  .strict();

export const teamCollaborationThreadParamsSchema = z
  .object({
    teamId: strictUuidSchema,
    threadId: strictUuidSchema
  })
  .strict();

export const workspaceCollaborationParamsSchema = z
  .object({
    teamId: strictUuidSchema,
    teamWorkspaceId: strictUuidSchema
  })
  .strict();

export const sharedSessionDiscussionParamsSchema = z
  .object({
    teamId: strictUuidSchema,
    teamWorkspaceId: strictUuidSchema,
    sharedLogicalMemoryId: strictUuidSchema
  })
  .strict();

export const listCollaborationThreadsQuerySchema = z
  .object({
    includeArchived: includeArchivedSchema,
    limit: pageLimitSchema
  })
  .strict();

export const createCollaborationChannelSchema = z
  .object({
    name: channelNameSchema,
    topic: topicSchema.nullable().optional()
  })
  .strict();

export const createCollaborationDmSchema = z
  .object({ participantUserId: strictUuidSchema })
  .strict();

export const createCollaborationGroupDmSchema = z
  .object({
    participantUserIds: z
      .array(strictUuidSchema)
      .min(2)
      .max(COLLABORATION_MAX_DM_PARTICIPANTS - 1)
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.participantUserIds).size ===
      input.participantUserIds.length,
    { message: "participantUserIds must be distinct" }
  );

export const createSharedSessionDiscussionSchema = z
  .object({ shareGrantId: strictUuidSchema })
  .strict();

export const renameCollaborationThreadSchema = z
  .object({
    expectedVersion: z.number().int().safe().positive(),
    name: channelNameSchema
  })
  .strict();

export const updateCollaborationTopicSchema = z
  .object({
    expectedVersion: z.number().int().safe().positive(),
    topic: topicSchema.nullable()
  })
  .strict();

export const transitionCollaborationThreadSchema = z
  .object({ expectedVersion: z.number().int().safe().positive() })
  .strict();

export const createCollaborationMessageSchema = z
  .object({
    bodyText: messageBodySchema
  })
  .strict();

const distinctTeamMessageMentionUserIdsSchema = z
  .array(strictUuidSchema)
  .max(COLLABORATION_TEAM_MESSAGE_MENTION_MAX)
  .transform((userIds) => userIds.map((userId) => userId.toLowerCase()))
  .superRefine((userIds, context) => {
    if (new Set(userIds).size !== userIds.length) {
      context.addIssue({
        code: "custom",
        message: "Mentioned User IDs must be unique"
      });
    }
  });

export const createTeamCollaborationMessageV2Schema = z
  .object({
    bodyText: messageBodySchema,
    replyToMessageId: strictUuidSchema.nullable(),
    mentionsUserIds: distinctTeamMessageMentionUserIdsSchema
  })
  .strict();

export const teamCollaborationMessageV2ApiSchema = z
  .object({
    id: strictUuidSchema,
    threadId: strictUuidSchema,
    threadSequence: z.number().int().safe().positive(),
    audienceVersion: z.number().int().safe().positive(),
    scope: z.literal("team"),
    personalOwnerUserId: z.null(),
    teamId: strictUuidSchema,
    teamWorkspaceId: strictUuidSchema.nullable(),
    senderKind: z.literal("user"),
    senderPrincipalId: z.string().nullable(),
    senderUserId: strictUuidSchema.nullable(),
    senderDisplayName: z.string().nullable(),
    recipientStatus: z.enum(["sent", "delivered", "read"]).nullable(),
    bodyText: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    provenance: z
      .object({
        kind: z.string(),
        id: z.string(),
        details: z.record(z.string(), z.unknown()).optional()
      })
      .strict(),
    createdAt: z.string(),
    updatedAt: z.string(),
    replyToMessageId: strictUuidSchema.nullable(),
    mentionsUserIds: distinctTeamMessageMentionUserIdsSchema
  })
  .strict();

export const teamCollaborationMessageV2ApiPageSchema = z
  .object({
    messages: z.array(teamCollaborationMessageV2ApiSchema).max(200),
    hasMore: z.boolean(),
    nextBeforeSequence: z.number().int().safe().positive().nullable(),
    nextAfterSequence: z.number().int().safe().positive().nullable()
  })
  .strict();

export const listCollaborationMessagesQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().safe().min(0).optional(),
    beforeSequence: z.coerce.number().int().safe().positive().optional(),
    limit: pageLimitSchema
  })
  .strict()
  .refine(
    (input) =>
      input.afterSequence === undefined || input.beforeSequence === undefined,
    { message: "afterSequence and beforeSequence cannot be combined" }
  );

export const listTeamCollaborationMessagesV2QuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().safe().min(0).optional(),
    beforeSequence: z.coerce.number().int().safe().positive().optional(),
    limit: pageLimitSchema
  })
  .strict()
  .refine(
    (input) =>
      input.afterSequence === undefined ||
      input.beforeSequence === undefined ||
      input.beforeSequence > input.afterSequence,
    {
      path: ["beforeSequence"],
      message: "beforeSequence must be greater than afterSequence"
    }
  );

export const advanceCollaborationReadStateSchema = z
  .object({ messageId: strictUuidSchema })
  .strict();

export const listPersonalNotesQuerySchema = z
  .object({
    beforeSequence: z.coerce.number().int().safe().positive().optional(),
    limit: z.coerce.number().int().safe().min(1).max(50).default(50)
  })
  .strict();

export const personalNoteParamsSchema = z
  .object({ noteId: strictUuidSchema })
  .strict();

export const renamePersonalNoteSchema = z
  .object({
    expectedTitleVersion: z.number().int().safe().positive(),
    title: z
      .string()
      .transform((value) => value.trim().normalize("NFC"))
      .pipe(z.string().min(1).max(80))
  })
  .strict();

export const updatePersonalNoteBodySchema = z
  .object({
    expectedRevision: z.number().int().safe().positive(),
    bodyText: messageBodySchema
  })
  .strict();

export const collaborationRealtimeScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("personal") }).strict(),
  z.object({ scope: z.literal("team"), teamId: strictUuidSchema }).strict()
]);

export const collaborationRealtimeSnapshotSchema = z
  .object({
    clientInstanceId: realtimeBindingKeySchema,
    subscriptionKey: realtimeBindingKeySchema
  })
  .and(collaborationRealtimeScopeSchema);

export const teamCollaborationRealtimeV2SnapshotSchema = z
  .object({
    clientInstanceId: realtimeBindingKeySchema,
    subscriptionKey: realtimeBindingKeySchema,
    scope: z.literal("team"),
    teamId: strictUuidSchema
  })
  .strict();

export const collaborationRealtimeStreamQuerySchema = z
  .object({
    clientInstanceId: realtimeBindingKeySchema,
    subscriptionKey: realtimeBindingKeySchema,
    cursor: realtimeCursorSchema.optional()
  })
  .and(collaborationRealtimeScopeSchema);

export const teamCollaborationRealtimeV2StreamQuerySchema = z
  .object({
    clientInstanceId: realtimeBindingKeySchema,
    subscriptionKey: realtimeBindingKeySchema,
    cursor: realtimeCursorSchema.optional(),
    scope: z.literal("team"),
    teamId: strictUuidSchema
  })
  .strict();

export const collaborationRealtimeAckSchema = z
  .object({
    subscriptionId: strictUuidSchema,
    eventId: strictUuidSchema,
    cursor: realtimeCursorSchema,
    clientInstanceId: realtimeBindingKeySchema,
    subscriptionKey: realtimeBindingKeySchema
  })
  .strict();

export const teamCollaborationRealtimeV2AckSchema =
  collaborationRealtimeAckSchema;
