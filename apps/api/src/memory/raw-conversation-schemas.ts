import { z } from "zod";
import {
  metadataWithNulSanitization,
  sanitizeNulCharacters
} from "@koed/shared";
import { metadataSchema } from "./common-schemas.js";

const rawVisibilitySchema = z.literal("personal");

const conversationItemSchema = z
  .object({
    visibility: rawVisibilitySchema.optional(),
    sessionId: z.string().uuid().optional(),
    turnId: z.string().uuid().optional(),
    sourceKind: z.string().min(1),
    sourceAdapterVersion: z.string().min(1),
    sourceTransport: z.string().min(1),
    externalSessionId: z.string().min(1).optional(),
    externalThreadId: z.string().min(1).optional(),
    externalTurnId: z.string().min(1).optional(),
    externalItemId: z.string().min(1).optional(),
    parentExternalItemId: z.string().min(1).optional(),
    sourceRecordType: z.string().min(1),
    sourceEventType: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    sourceLineNumber: z.number().int().nonnegative().optional(),
    sourceSequence: z.number().int().nonnegative().optional(),
    eventTime: z.string().datetime({ offset: true }).optional(),
    rawJson: z.unknown(),
    rawText: z.string().optional(),
    logicalSourceId: z.string().min(1).optional(),
    transportChunkIndex: z.number().int().nonnegative().optional(),
    transportChunkCount: z.number().int().positive().optional(),
    transportChunkText: z.string().optional(),
    transportChunkEncoding: z.string().min(1).optional(),
    sourceHash: z.string().min(1),
    idempotencyKey: z.string().min(1),
    projectionStatus: z.string().min(1).optional(),
    projectionVersion: z.string().min(1).optional(),
    projectionError: z.string().optional(),
    metadata: metadataSchema
  })
  .transform((item) => {
    const rawJson = sanitizeNulCharacters(item.rawJson);
    const rawText = sanitizeNulCharacters(item.rawText);
    const transportChunkText = sanitizeNulCharacters(item.transportChunkText);
    const projectionError = sanitizeNulCharacters(item.projectionError);
    const sourcePath = sanitizeNulCharacters(item.sourcePath);
    const metadata = sanitizeNulCharacters(item.metadata);
    const replacementCount =
      rawJson.replacementCount +
      rawText.replacementCount +
      transportChunkText.replacementCount +
      projectionError.replacementCount +
      sourcePath.replacementCount +
      metadata.replacementCount;

    return {
      ...item,
      rawJson: rawJson.value,
      rawText: rawText.value as string | undefined,
      transportChunkText: transportChunkText.value as string | undefined,
      projectionError: projectionError.value as string | undefined,
      sourcePath: sourcePath.value as string | undefined,
      metadata: metadataWithNulSanitization(
        metadata.value as Record<string, unknown>,
        replacementCount
      )
    };
  });

export const createConversationItemsSchema = z.object({
  items: z.array(conversationItemSchema).min(1).max(1000)
});

const tokenUsageSourceReferenceSchema = z.object({
  type: z.enum([
    "question",
    "answer_job",
    "lcm_node",
    "message",
    "tool_event",
    "memory_event"
  ]),
  id: z.string().min(1)
});

export const tokenUsageSchema = z.object({
  workflowType: z.string().min(1),
  workflowId: z.string().min(1).optional(),
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  conversationItemId: z.string().uuid().optional(),
  questionId: z.string().uuid().optional(),
  answerJobId: z.string().min(1).optional(),
  lcmNodeId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  toolEventId: z.string().uuid().optional(),
  memoryEventId: z.string().uuid().optional(),
  sourceReferences: z.array(tokenUsageSourceReferenceSchema).max(20).optional(),
  sourceRuntime: z.enum(["codex", "codex-cli"]).optional(),
  sourceKind: z.string().min(1).optional(),
  sourceAdapterVersion: z.string().min(1).optional(),
  usageSource: z
    .enum(["app_server", "transcript", "connector_native", "local_estimate"])
    .optional(),
  usageAccuracy: z
    .enum([
      "provider_reported",
      "provider_replayed",
      "provider_partial",
      "local_estimate"
    ])
    .optional(),
  usageKind: z
    .enum([
      "turn_delta",
      "cumulative_snapshot",
      "estimate",
      "structural_chunk_count"
    ])
    .optional(),
  connectorClient: z.string().min(1).optional(),
  tokenizerPackage: z.string().min(1).optional(),
  tokenizerEncoding: z.string().min(1).optional(),
  tokenizerModel: z.string().min(1).optional(),
  tokenizerExactModelMatch: z.boolean().nullable().optional(),
  tokenizerHeuristicFallback: z.boolean().nullable().optional(),
  tokenizerVersion: z.string().min(1).optional(),
  model: z.string().min(1).nullable().optional(),
  modelContextWindow: z.number().int().nonnegative().nullable().optional(),
  inputTokens: z.number().int().nonnegative().nullable().optional(),
  cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
  outputTokens: z.number().int().nonnegative().nullable().optional(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable().optional(),
  totalTokens: z.number().int().nonnegative().nullable().optional(),
  usageScope: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  sourceHash: z.string().min(1).optional()
});

const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const tokenUsageRollupQuerySchema = z.object({
  group_by: z
    .string()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined
    )
    .pipe(
      z
        .array(
          z.enum([
            "workflow",
            "model",
            "owner",
            "project",
            "thread",
            "connector",
            "accuracy",
            "date"
          ])
        )
        .optional()
    ),
  include_estimates: booleanQuerySchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional()
});

export const projectConversationItemsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  conversationItemIds: z.array(z.string().uuid()).max(1000).optional()
});
