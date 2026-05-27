import { z } from "zod";
import { metadataSchema } from "./common-schemas.js";

const rawVisibilitySchema = z.enum(["personal", "team"]);

const conversationItemSchema = z.object({
  visibility: rawVisibilitySchema.optional(),
  teamId: z.string().uuid().optional(),
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
});

export const createConversationItemsSchema = z.object({
  items: z.array(conversationItemSchema).min(1).max(1000)
});

export const tokenUsageSchema = z.object({
  workflowType: z.string().min(1),
  workflowId: z.string().min(1).optional(),
  sessionId: z.string().uuid().optional(),
  turnId: z.string().uuid().optional(),
  conversationItemId: z.string().uuid().optional(),
  sourceRuntime: z.enum(["codex", "codex-cli"]).optional(),
  sourceKind: z.string().min(1).optional(),
  sourceAdapterVersion: z.string().min(1).optional(),
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

export const projectConversationItemsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  conversationItemIds: z.array(z.string().uuid()).max(1000).optional()
});
