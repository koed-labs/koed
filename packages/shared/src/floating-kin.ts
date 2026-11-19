import { z } from "zod";

const client = z.enum(["codex", "claude-code", "pi"]);
const capturedAt = z.string().datetime({ offset: true });
const sessionId = z.string().uuid();
const projectId = z.string().min(1).max(2048);

const conversation = z
  .object({
    sessionId,
    projectId: projectId.nullable(),
    client,
    lastActivityAt: capturedAt
  })
  .strict();

export const floatingKinActivitySchema = z
  .object({
    conversations: z.array(conversation).max(16),
    overflowCount: z.number().int().nonnegative()
  })
  .strict();

export const floatingKinSummaryRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ sessionId, action: z.literal("conversation") }),
  z.strictObject({ sessionId, action: z.literal("project"), projectId })
]);

const source = z
  .object({
    id: z.string().uuid(),
    sessionId,
    kind: z.enum(["conversation_item", "memory_event"]),
    occurredAt: capturedAt
  })
  .strict();

export const floatingKinEvidenceSchema = z
  .object({
    items: z
      .array(source.extend({ text: z.string().min(1).max(8192) }))
      .max(64),
    truncated: z.boolean()
  })
  .strict();

export const floatingKinSummarySchema = z.union([
  z
    .object({
      status: z.literal("answered"),
      captured: z.string().min(1).max(8192),
      inferred: z.string().min(1).max(8192).nullable(),
      asOf: capturedAt,
      truncated: z.boolean(),
      sources: z.array(source).min(1).max(64),
      client,
      model: z.string().min(1).max(256),
      effort: z.string().min(1).max(256).nullable()
    })
    .strict(),
  z
    .object({
      status: z.enum([
        "no_evidence",
        "client_unavailable",
        "unavailable",
        "cancelled",
        "busy",
        "timed_out"
      ])
    })
    .strict()
]);

export type FloatingKinActivity = z.infer<typeof floatingKinActivitySchema>;
export type FloatingKinEvidence = z.infer<typeof floatingKinEvidenceSchema>;
export type FloatingKinSummaryRequest = z.infer<
  typeof floatingKinSummaryRequestSchema
>;
export type FloatingKinSummary = z.infer<typeof floatingKinSummarySchema>;
