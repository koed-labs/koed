import { z } from "zod";

export const PERSONAL_DESKTOP_CONTRACT_VERSION = 1;
export const PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT = 50;
export const PERSONAL_DESKTOP_OLDER_EVENT_LIMIT = 500;

const identifierSchema = z.string().trim().min(1).max(512);
const projectNameSchema = z.string().trim().min(1).max(160);
const localProjectPathSchema = z.string().trim().min(1).max(4_096);
const timestampSchema = z.string().max(64).datetime({ offset: true });

export const personalDesktopProjectThreadSchema = z
  .object({
    id: identifierSchema,
    name: z.string().max(512),
    sessionId: z.uuid().nullable(),
    sourceAiClient: z.enum(["codex", "codex-cli"]).nullable(),
    projectId: identifierSchema,
    projectName: projectNameSchema,
    projectPath: localProjectPathSchema.nullable(),
    projectAssignmentSource: z.enum(["detected", "user_override"]).nullable(),
    eventCount: z.number().int().safe().nonnegative(),
    invalidatedCount: z.number().int().safe().nonnegative(),
    latestAt: timestampSchema,
    sample: z.string().max(16_384)
  })
  .strict();

export const personalDesktopProjectSchema = z
  .object({
    id: identifierSchema,
    name: projectNameSchema,
    path: localProjectPathSchema.nullable(),
    eventCount: z.number().int().safe().nonnegative(),
    threads: z.array(personalDesktopProjectThreadSchema).max(5_000)
  })
  .strict();

export const personalDesktopConversationEventSchema = z
  .object({
    id: z.uuid(),
    actor: z.string().max(64).nullable(),
    eventType: z.string().max(256),
    timestamp: timestampSchema,
    sourceEventTime: timestampSchema.nullable(),
    sourceSequence: z.number().int().safe().nonnegative().nullable(),
    content: z.string().max(1_048_576).optional(),
    contentPreview: z.string().max(16_384),
    invalidatedAt: timestampSchema.nullable(),
    metadata: z
      .object({
        toolName: z.string().max(256).optional()
      })
      .strict()
  })
  .strict();

export const personalDesktopConversationCursorSchema = z
  .object({
    id: z.uuid(),
    sourceSequence: z.number().int().safe().nonnegative().nullable(),
    timestamp: timestampSchema
  })
  .strict();

export const personalDesktopChangeEventRefSchema = z
  .object({
    id: z.uuid(),
    projectId: identifierSchema,
    threadId: identifierSchema
  })
  .strict();

export const personalDesktopChangeSchema = z
  .object({
    contractVersion: z.literal(PERSONAL_DESKTOP_CONTRACT_VERSION),
    type: z.literal("conversation_events_changed"),
    eventRefs: z.array(personalDesktopChangeEventRefSchema).min(1).max(500)
  })
  .strict();

export const personalDesktopEventPageInputSchema = z
  .object({
    projectId: identifierSchema,
    threadId: identifierSchema,
    limit: z.union([
      z.literal(PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT),
      z.literal(PERSONAL_DESKTOP_OLDER_EVENT_LIMIT)
    ]),
    cursor: personalDesktopConversationCursorSchema.optional(),
    eventIds: z.array(z.uuid()).min(1).max(500).optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.cursor && input.eventIds) {
      context.addIssue({
        code: "custom",
        path: ["eventIds"],
        message: "eventIds cannot be combined with a pagination cursor"
      });
    }
    if (
      input.eventIds &&
      new Set(input.eventIds).size !== input.eventIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["eventIds"],
        message: "eventIds must be distinct"
      });
    }
  });

export const personalDesktopSessionProjectInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        action: z.literal("move"),
        sessionId: z.uuid(),
        targetProjectId: identifierSchema
      })
      .strict(),
    z
      .object({
        action: z.literal("reset"),
        sessionId: z.uuid()
      })
      .strict()
  ]
);

export const personalDesktopRequestSchema = z.discriminatedUnion("operation", [
  z
    .object({
      contractVersion: z.literal(PERSONAL_DESKTOP_CONTRACT_VERSION),
      operation: z.literal("personal.projects.list"),
      input: z.object({}).strict()
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(PERSONAL_DESKTOP_CONTRACT_VERSION),
      operation: z.literal("personal.events.load_page"),
      input: personalDesktopEventPageInputSchema
    })
    .strict(),
  z
    .object({
      contractVersion: z.literal(PERSONAL_DESKTOP_CONTRACT_VERSION),
      operation: z.literal("personal.sessions.assign_project"),
      input: personalDesktopSessionProjectInputSchema
    })
    .strict()
]);

export const personalDesktopProjectsDataSchema = z
  .object({
    projects: z.array(personalDesktopProjectSchema).max(500)
  })
  .strict();

export const personalDesktopEventsDataSchema = z
  .object({
    events: z.array(personalDesktopConversationEventSchema).max(500)
  })
  .strict();

export const personalDesktopSessionProjectDataSchema = z
  .object({
    projectId: identifierSchema.nullable()
  })
  .strict();

export const personalDesktopErrorSchema = z
  .object({
    code: z.enum([
      "not_ready",
      "not_found",
      "request_failed",
      "invalid_response"
    ]),
    message: z.string().min(1).max(256),
    retryable: z.boolean()
  })
  .strict();

const resultBase = {
  contractVersion: z.literal(PERSONAL_DESKTOP_CONTRACT_VERSION)
} as const;

const failedResult = <Operation extends string>(operation: Operation) =>
  z
    .object({
      ...resultBase,
      operation: z.literal(operation),
      ok: z.literal(false),
      error: personalDesktopErrorSchema
    })
    .strict();

export const personalDesktopResultSchema = z.union([
  z
    .object({
      ...resultBase,
      operation: z.literal("personal.projects.list"),
      ok: z.literal(true),
      data: personalDesktopProjectsDataSchema
    })
    .strict(),
  failedResult("personal.projects.list"),
  z
    .object({
      ...resultBase,
      operation: z.literal("personal.events.load_page"),
      ok: z.literal(true),
      data: personalDesktopEventsDataSchema
    })
    .strict(),
  failedResult("personal.events.load_page"),
  z
    .object({
      ...resultBase,
      operation: z.literal("personal.sessions.assign_project"),
      ok: z.literal(true),
      data: personalDesktopSessionProjectDataSchema
    })
    .strict(),
  failedResult("personal.sessions.assign_project")
]);

export type PersonalDesktopProjectThread = z.infer<
  typeof personalDesktopProjectThreadSchema
>;
export type PersonalDesktopProject = z.infer<
  typeof personalDesktopProjectSchema
>;
export type PersonalDesktopConversationEvent = z.infer<
  typeof personalDesktopConversationEventSchema
>;
export type PersonalDesktopConversationCursor = z.infer<
  typeof personalDesktopConversationCursorSchema
>;
export type PersonalDesktopChange = z.infer<typeof personalDesktopChangeSchema>;
export type PersonalDesktopEventPageInput = z.infer<
  typeof personalDesktopEventPageInputSchema
>;
export type PersonalDesktopSessionProjectInput = z.infer<
  typeof personalDesktopSessionProjectInputSchema
>;
export type PersonalDesktopRequest = z.infer<
  typeof personalDesktopRequestSchema
>;
export type PersonalDesktopResult = z.infer<typeof personalDesktopResultSchema>;

export interface PersonalDesktopApi {
  listProjects: () => Promise<PersonalDesktopProject[]>;
  loadEventPage: (
    input: PersonalDesktopEventPageInput
  ) => Promise<PersonalDesktopConversationEvent[]>;
  assignSessionProject: (
    input: PersonalDesktopSessionProjectInput
  ) => Promise<{ projectId: string | null }>;
  subscribe: (listener: (change: PersonalDesktopChange) => void) => () => void;
}
