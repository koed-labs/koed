import { z } from "zod";
import { metadataSchema } from "./common-schemas.js";

export const historicalImportStateSchema = z.enum([
  "discovered",
  "eligible",
  "queued",
  "importing",
  "paused",
  "skipped",
  "completed",
  "failed"
]);

const boundedCounter = z.number().int().nonnegative().max(2_000_000_000);
const boundedOffset = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const boundedText = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !hasControlCharacter(value), {
    message: "Control characters are not allowed"
  });
const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !hasControlCharacter(value), {
    message: "Control characters are not allowed"
  });

export const historicalImportRunListSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional()
  })
  .strict();

export const historicalImportRunParamsSchema = z
  .object({ runId: z.string().uuid() })
  .strict();

export const historicalImportSourceParamsSchema = z
  .object({ sourceId: z.string().uuid() })
  .strict();

export const historicalImportSourceLookupSchema = z
  .object({ artifactId: z.string().uuid() })
  .strict();

const detectedProjectSchema = z
  .object({
    projectId: boundedText.optional(),
    name: boundedText.regex(/^[^/\\]+$/).optional(),
    path: localPath.optional(),
    cwd: localPath.optional(),
    repositoryUrl: z.string().url().max(4096).optional(),
    branch: boundedText.optional(),
    ref: boundedText.optional(),
    fingerprint: digest.optional()
  })
  .strict();

export const createHistoricalImportSourceSchema = z
  .object({
    runId: z.string().uuid(),
    artifactId: z.string().uuid(),
    aiClient: z.enum(["codex", "claude", "pi"]),
    sourceEventFrom: z.string().datetime({ offset: true }).optional(),
    sourceEventTo: z.string().datetime({ offset: true }).optional(),
    discoveredRecordCount: boundedCounter.optional(),
    detectedProject: detectedProjectSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceEventFrom &&
      value.sourceEventTo &&
      Date.parse(value.sourceEventFrom) > Date.parse(value.sourceEventTo)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceEventTo"],
        message: "Source event range is invalid"
      });
    }
  });

export const historicalImportTransitionSchema = z
  .object({
    expectedState: historicalImportStateSchema,
    state: historicalImportStateSchema,
    failureReason: z
      .string()
      .regex(/^[a-z0-9_.:-]{1,128}$/)
      .nullable()
      .optional(),
    nextRetryAt: z.string().datetime({ offset: true }).nullable().optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "failed" && !value.failureReason) {
      context.addIssue({
        code: "custom",
        path: ["failureReason"],
        message: "Failed state requires failureReason"
      });
    }
  });

const historicalItemMetadataSchema = metadataSchema.and(
  z
    .object({
      transcriptByteOffset: boundedOffset.optional(),
      transcriptItemDiscriminator: boundedText,
      transcriptSourceLineNumber: boundedCounter.optional()
    })
    .passthrough()
);

const historicalConversationItemSchema = z
  .object({
    observationOnly: z.boolean().optional(),
    sessionId: z.string().uuid().optional(),
    turnId: z.string().uuid().optional(),
    externalThreadId: boundedText.optional(),
    externalTurnId: boundedText.optional(),
    externalItemId: boundedText.optional(),
    parentExternalItemId: boundedText.optional(),
    sourceRecordType: boundedText,
    sourceEventType: boundedText.optional(),
    sourceLineNumber: boundedCounter.optional(),
    sourceSequence: boundedCounter.optional(),
    eventTime: z.string().datetime({ offset: true }).optional(),
    rawJson: z.unknown().refine((value) => value !== undefined),
    rawText: z.string().max(4_000_000).optional(),
    logicalSourceId: boundedText.optional(),
    transportChunkIndex: boundedCounter.optional(),
    transportChunkCount: z.number().int().positive().max(100_000).optional(),
    transportChunkText: z.string().max(4_000_000).optional(),
    transportChunkEncoding: boundedText.optional(),
    sourceHash: boundedText,
    idempotencyKey: boundedText,
    canonicalItemKey: boundedText.optional(),
    canonicalStableItemId: boundedText.optional(),
    canonicalSourcePriority: z
      .number()
      .int()
      .nonnegative()
      .max(2_147_483_647)
      .optional(),
    observationKind: z
      .enum([
        "snapshot",
        "lifecycle_started",
        "lifecycle_completed",
        "control",
        "reconciliation"
      ])
      .optional(),
    observationComponent: boundedText.optional(),
    projectionStatus: z.enum(["pending", "raw_only"]).optional(),
    projectionVersion: z
      .enum([
        "codex-transcript-v1",
        "claude-code-transcript-v1",
        "pi-session-v1"
      ])
      .optional(),
    metadata: historicalItemMetadataSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.observationOnly && value.canonicalItemKey) {
      context.addIssue({
        code: "custom",
        path: ["canonicalItemKey"],
        message: "Observation-only records cannot claim canonical identity"
      });
    }
    const chunked = value.logicalSourceId !== undefined;
    const chunkFields = [
      value.transportChunkIndex,
      value.transportChunkCount,
      value.transportChunkText,
      value.transportChunkEncoding
    ];
    if (chunked !== chunkFields.every((field) => field !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["logicalSourceId"],
        message: "Transport chunk fields must be complete"
      });
    }
    if (chunked && value.transportChunkIndex! >= value.transportChunkCount!) {
      context.addIssue({
        code: "custom",
        path: ["transportChunkIndex"],
        message: "Transport chunk index is outside chunk count"
      });
    }
    if (
      !chunked &&
      value.metadata.transcriptByteOffset === undefined &&
      value.sourceSequence === undefined &&
      value.sourceLineNumber === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "transcriptByteOffset"],
        message: "Transcript item position is required"
      });
    }
  });

const historicalItemPosition = (
  item: z.infer<typeof historicalConversationItemSchema>
): number =>
  item.metadata.transcriptByteOffset ??
  item.sourceSequence ??
  item.sourceLineNumber ??
  0;

export const historicalImportBatchSchema = z
  .object({
    expectedSourceOffset: boundedOffset,
    sourceOffset: boundedOffset,
    sourceLine: boundedCounter,
    segmentIndex: z.number().int().nonnegative().max(2_147_483_647),
    lastVerifiedDigest: digest,
    parserState: z.record(z.string(), z.unknown()).optional(),
    skippedRecordCount: boundedCounter.optional(),
    malformedRecordCount: boundedCounter.optional(),
    sourceEventFrom: z.string().datetime({ offset: true }).optional(),
    sourceEventTo: z.string().datetime({ offset: true }).optional(),
    items: z.array(historicalConversationItemSchema).max(1000)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceOffset <= value.expectedSourceOffset) {
      context.addIssue({
        code: "custom",
        path: ["sourceOffset"],
        message: "Historical journal cursor must advance"
      });
    }
    if (Buffer.byteLength(JSON.stringify(value.items), "utf8") > 4_000_000) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Historical import batch exceeds byte limit"
      });
    }
    for (let index = 1; index < value.items.length; index += 1) {
      if (
        historicalItemPosition(value.items[index]!) <
        historicalItemPosition(value.items[index - 1]!)
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Transcript items must use source order"
        });
        break;
      }
    }
    if (
      value.sourceEventFrom &&
      value.sourceEventTo &&
      Date.parse(value.sourceEventFrom) > Date.parse(value.sourceEventTo)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceEventTo"],
        message: "Source event range is invalid"
      });
    }
  });
