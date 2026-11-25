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

const conversationSummary = z.strictObject({
  sessionId,
  action: z.literal("conversation")
});
const projectSummary = z.strictObject({
  sessionId,
  action: z.literal("project"),
  projectId
});
export const floatingKinSummaryRequestSchema = z.discriminatedUnion("action", [
  conversationSummary,
  projectSummary
]);

export const floatingKinEvidenceLimit = 32;
export const floatingKinEvidenceBudgetBytes = 48_000;
const evidenceIds = z
  .array(z.string().uuid())
  .min(1)
  .max(floatingKinEvidenceLimit)
  .refine(
    (ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length
  )
  .optional();
export const floatingKinEvidenceRequestSchema = z.discriminatedUnion("action", [
  conversationSummary.extend({ evidenceIds }),
  projectSummary.extend({ evidenceIds })
]);
export type FloatingKinEvidenceRequest = z.infer<
  typeof floatingKinEvidenceRequestSchema
>;

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
