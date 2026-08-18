import { z } from "zod";

export const PERSONAL_DESKTOP_CONTRACT_VERSION = 3;
export const PERSONAL_DESKTOP_INITIAL_EVENT_LIMIT = 50;
export const PERSONAL_DESKTOP_OLDER_EVENT_LIMIT = 500;

const APPROVAL_REVIEW_TRANSCRIPT_MAX_SEGMENTS = 200;
const APPROVAL_REVIEW_TRANSCRIPT_MAX_CONTENT_LENGTH = 65_536;
const APPROVAL_REVIEW_TRANSCRIPT_MAX_TOTAL_LENGTH = 524_288;
const APPROVAL_REVIEW_TRANSCRIPT_PREFIXES = [
  "The following is the Codex agent history whose request action you are assessing",
  "The following is the Codex agent history added since your last approval assessment"
] as const;

export const isApprovalReviewTranscriptEnvelopeText = (
  source: string
): boolean => {
  const normalized = source.trimStart();
  return APPROVAL_REVIEW_TRANSCRIPT_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix)
  );
};

export const approvalReviewTranscriptSegmentSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("message"),
        sequence: z.number().int().safe().nonnegative(),
        actor: z.enum(["user", "agent"]),
        content: z.string().max(APPROVAL_REVIEW_TRANSCRIPT_MAX_CONTENT_LENGTH)
      })
      .strict(),
    z
      .object({
        kind: z.enum(["tool_call", "tool_result"]),
        sequence: z.number().int().safe().nonnegative(),
        toolName: z.string().trim().min(1).max(128),
        content: z.string().max(APPROVAL_REVIEW_TRANSCRIPT_MAX_CONTENT_LENGTH)
      })
      .strict()
  ]
);

export const approvalReviewTranscriptDisplaySchema = z
  .object({
    kind: z.literal("approval_review"),
    version: z.literal(1),
    segments: z
      .array(approvalReviewTranscriptSegmentSchema)
      .min(1)
      .max(APPROVAL_REVIEW_TRANSCRIPT_MAX_SEGMENTS),
    truncated: z.boolean()
  })
  .strict();

export const approvalDecisionDisplaySchema = z
  .object({
    kind: z.literal("auto_approval"),
    version: z.literal(1),
    riskLevel: z.enum(["low", "medium", "high"]),
    userAuthorization: z.enum(["low", "medium", "high"]),
    outcome: z.enum(["allow", "deny"]),
    rationale: z.string().trim().min(1).max(8_192)
  })
  .strict();

export const personalDesktopToolDisplaySchema = z
  .object({
    kind: z.enum(["command", "file_change", "file_read", "search", "tool"]),
    label: z.string().trim().min(1).max(80),
    preview: z.string().max(2_048),
    toolName: z.string().max(256).optional(),
    status: z.string().max(64).optional(),
    callId: z.string().max(512).optional(),
    patchSource: z.string().max(1_048_576).optional()
  })
  .strict();

type ApprovalReviewTranscriptHeader = {
  actor?: "user" | "agent";
  contentStart: number;
  headerStart: number;
  kind: "message" | "tool_call" | "tool_result";
  sequence: number;
  toolName?: string;
};

const approvalReviewTranscriptHeaders = (
  source: string
): ApprovalReviewTranscriptHeader[] => {
  const pattern =
    /\[(\d+)\]\s+(?:(user|assistant):\s*|tool\s+([a-zA-Z0-9_.:-]{1,128})\s+(call|result):\s*)/gu;
  const headers: ApprovalReviewTranscriptHeader[] = [];
  let previousSequence = -1;
  for (const match of source.matchAll(pattern)) {
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence <= previousSequence) {
      continue;
    }
    previousSequence = sequence;
    const role = match[2];
    const toolName = match[3];
    const toolDirection = match[4];
    headers.push({
      sequence,
      headerStart: match.index,
      contentStart: match.index + match[0].length,
      ...(role
        ? {
            kind: "message" as const,
            actor: role === "user" ? ("user" as const) : ("agent" as const)
          }
        : {
            kind:
              toolDirection === "call"
                ? ("tool_call" as const)
                : ("tool_result" as const),
            toolName: toolName!
          })
    });
  }
  return headers;
};

export const approvalReviewTranscriptDisplayFromText = (
  source: string
): ApprovalReviewTranscriptDisplay | undefined => {
  const normalized = source.trimStart();
  if (!isApprovalReviewTranscriptEnvelopeText(normalized)) {
    return undefined;
  }
  const start = /\bTRANSCRIPT( DELTA)? START\s+/u.exec(normalized);
  if (!start) return undefined;
  const endLabel = start[1] ? "TRANSCRIPT DELTA END" : "TRANSCRIPT END";
  const contentStart = start.index + start[0].length;
  const endIndex = normalized.indexOf(endLabel, contentStart);
  if (endIndex < 0) return undefined;
  const suffix = normalized.slice(endIndex + endLabel.length, endIndex + 512);
  if (!/Reviewed Codex session id:\s*[0-9a-f-]{16,}/iu.test(suffix)) {
    return undefined;
  }

  const transcript = normalized.slice(contentStart, endIndex).trim();
  const headers = approvalReviewTranscriptHeaders(transcript);
  if (headers.length === 0) return undefined;
  const segments: ApprovalReviewTranscriptSegment[] = [];
  let totalLength = 0;
  let truncated = headers.length > APPROVAL_REVIEW_TRANSCRIPT_MAX_SEGMENTS;
  for (const [index, header] of headers.entries()) {
    if (segments.length >= APPROVAL_REVIEW_TRANSCRIPT_MAX_SEGMENTS) break;
    const next = headers[index + 1];
    const rawContent = transcript
      .slice(header.contentStart, next?.headerStart ?? transcript.length)
      .trim();
    const remaining = Math.max(
      0,
      APPROVAL_REVIEW_TRANSCRIPT_MAX_TOTAL_LENGTH - totalLength
    );
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const limit = Math.min(
      APPROVAL_REVIEW_TRANSCRIPT_MAX_CONTENT_LENGTH,
      remaining
    );
    const content = rawContent.slice(0, limit);
    if (content.length < rawContent.length) truncated = true;
    if (header.kind === "message") {
      segments.push({
        kind: "message",
        sequence: header.sequence,
        actor: header.actor!,
        content
      });
    } else {
      segments.push({
        kind: header.kind,
        sequence: header.sequence,
        toolName: header.toolName!,
        content
      });
    }
    totalLength += content.length;
  }
  return approvalReviewTranscriptDisplaySchema.parse({
    kind: "approval_review",
    version: 1,
    segments,
    truncated
  });
};

const identifierSchema = z.string().trim().min(1).max(512);
const projectNameSchema = z.string().trim().min(1).max(160);
const localProjectPathSchema = z.string().trim().min(1).max(4_096);
const timestampSchema = z.string().max(64).datetime({ offset: true });

export const personalDesktopProjectThreadSchema = z
  .object({
    id: identifierSchema,
    name: z.string().max(512),
    sessionId: z.uuid().nullable(),
    sourceAiClient: z.enum(["codex", "codex-cli", "claude-code"]).nullable(),
    projectId: identifierSchema,
    projectName: projectNameSchema,
    projectPath: localProjectPathSchema.nullable(),
    projectAssignmentSource: z.enum(["detected", "user_override"]).nullable(),
    eventCount: z.number().int().safe().nonnegative(),
    invalidatedCount: z.number().int().safe().nonnegative(),
    latestAt: timestampSchema,
    sample: z.string().max(16_384),
    threadKind: z.enum(["conversation", "subagent"]).optional(),
    parentThreadId: identifierSchema.nullable().optional(),
    parentSessionId: identifierSchema.nullable().optional()
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
    approvalDecisionDisplay: approvalDecisionDisplaySchema.optional(),
    transcriptDisplay: approvalReviewTranscriptDisplaySchema.optional(),
    toolDisplay: personalDesktopToolDisplaySchema.optional(),
    activityDisplay: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("approval_review"),
            label: z.literal("Approval activity"),
            transcript: approvalReviewTranscriptDisplaySchema
          })
          .strict(),
        z
          .object({
            kind: z.literal("approval_decision"),
            label: z.literal("Approval activity"),
            decision: approvalDecisionDisplaySchema
          })
          .strict(),
        z
          .object({
            kind: z.literal("approval_status"),
            label: z.literal("Approval activity"),
            status: z.enum([
              "request",
              "decision",
              "tool_result",
              "helper_conversation",
              "incomplete"
            ])
          })
          .strict()
      ])
      .optional(),
    metadata: z
      .object({
        parentSourceComponentId: identifierSchema.optional(),
        sourceComponentId: identifierSchema.optional(),
        sourceComponentRole: z.enum(["primary", "auxiliary"]).optional(),
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

export const personalDesktopSessionTitleInputSchema = z
  .object({
    sessionId: z.uuid(),
    title: z.string().trim().min(1).max(120)
  })
  .strict();

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
    .strict(),
  z
    .object({
      contractVersion: z.literal(PERSONAL_DESKTOP_CONTRACT_VERSION),
      operation: z.literal("personal.sessions.update_title"),
      input: personalDesktopSessionTitleInputSchema
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

export const personalDesktopSessionTitleDataSchema = z
  .object({
    title: z.string().trim().min(1).max(120)
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
  failedResult("personal.sessions.assign_project"),
  z
    .object({
      ...resultBase,
      operation: z.literal("personal.sessions.update_title"),
      ok: z.literal(true),
      data: personalDesktopSessionTitleDataSchema
    })
    .strict(),
  failedResult("personal.sessions.update_title")
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
export type ApprovalReviewTranscriptSegment = z.infer<
  typeof approvalReviewTranscriptSegmentSchema
>;
export type ApprovalReviewTranscriptDisplay = z.infer<
  typeof approvalReviewTranscriptDisplaySchema
>;
export type ApprovalDecisionDisplay = z.infer<
  typeof approvalDecisionDisplaySchema
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
export type PersonalDesktopSessionTitleInput = z.infer<
  typeof personalDesktopSessionTitleInputSchema
>;
export type PersonalDesktopRequest = z.infer<
  typeof personalDesktopRequestSchema
>;
export type PersonalDesktopResult = z.infer<typeof personalDesktopResultSchema>;

export const conversationToolKindAndLabel = (
  toolName: string,
  signals: {
    command?: string;
    path?: string;
    query?: string;
    patchSource?: string;
  } = {}
): Pick<
  NonNullable<PersonalDesktopConversationEvent["toolDisplay"]>,
  "kind" | "label"
> => {
  const canonicalName =
    toolName
      .toLocaleLowerCase()
      .split(/__|[.:/]/u)
      .at(-1)
      ?.trim() ?? "";
  const explicitKinds: Record<
    string,
    Pick<
      NonNullable<PersonalDesktopConversationEvent["toolDisplay"]>,
      "kind" | "label"
    >
  > = {
    apply_patch: { kind: "file_change", label: "Changed files" },
    exec_command: { kind: "command", label: "Ran command" },
    read_file: { kind: "file_read", label: "Read file" },
    rg: { kind: "search", label: "Searched files" },
    view_image: { kind: "file_read", label: "Read file" },
    write_stdin: { kind: "command", label: "Ran command" }
  };
  const explicit = explicitKinds[canonicalName];
  if (explicit) return explicit;
  const lowerName = toolName.toLocaleLowerCase().replace(/[_-]+/gu, " ");
  if (
    signals.command ||
    /\b(exec|shell|bash|terminal|command|run)\b/u.test(lowerName)
  ) {
    return { kind: "command", label: "Ran command" };
  }
  if (
    signals.patchSource ||
    /\b(write|edit|patch|save|change|diff)\b/u.test(lowerName)
  ) {
    return { kind: "file_change", label: "Changed files" };
  }
  if (signals.path || /\b(read|open|cat|view|file)\b/u.test(lowerName)) {
    return { kind: "file_read", label: "Read file" };
  }
  if (signals.query || /\b(search|find|grep|rg|list)\b/u.test(lowerName)) {
    return { kind: "search", label: "Searched files" };
  }
  const humanized = toolName
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return {
    kind: "tool",
    label: humanized
      ? humanized.charAt(0).toLocaleUpperCase() + humanized.slice(1)
      : "Tool call"
  };
};

export interface PersonalDesktopApi {
  listProjects: () => Promise<PersonalDesktopProject[]>;
  loadEventPage: (
    input: PersonalDesktopEventPageInput
  ) => Promise<PersonalDesktopConversationEvent[]>;
  assignSessionProject: (
    input: PersonalDesktopSessionProjectInput
  ) => Promise<{ projectId: string | null }>;
  updateSessionTitle: (
    input: PersonalDesktopSessionTitleInput
  ) => Promise<{ title: string }>;
  subscribe: (listener: (change: PersonalDesktopChange) => void) => () => void;
}
