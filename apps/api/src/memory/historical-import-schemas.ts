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
const checkpointHash = z.string().regex(/^[0-9a-f]{64}$/);
const boundedBytes = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
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

export const historicalImportRunListSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional()
});

export const historicalImportRunParamsSchema = z.object({
  runId: z.string().uuid()
});

export const historicalImportSourceParamsSchema = z.object({
  sourceId: z.string().uuid()
});

export const historicalImportSourceLookupSchema = z
  .object({
    aiClient: z.literal("codex"),
    sourceKind: z.literal("codex"),
    sourceSessionId: boundedText
  })
  .strict();

export const historicalImportSourceObservationSchema = z
  .object({
    localSourcePath: localPath,
    sourceSizeBytes: boundedBytes,
    sourceModifiedAt: z.string().datetime({ offset: true }).optional()
  })
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
    fingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
  })
  .strict();

export const createHistoricalImportSourceSchema = z
  .object({
    runId: z.string().uuid(),
    aiClient: z.literal("codex"),
    sourceKind: z.literal("codex"),
    sourceSessionId: boundedText,
    sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    registrationFrontierOffset: boundedBytes,
    registrationPrefixHash: checkpointHash,
    localSourcePath: localPath,
    sourceSizeBytes: boundedBytes,
    sourceModifiedAt: z.string().datetime({ offset: true }).optional(),
    sourceEventFrom: z.string().datetime({ offset: true }).optional(),
    sourceEventTo: z.string().datetime({ offset: true }).optional(),
    discoveredRecordCount: boundedCounter.optional(),
    detectedProject: detectedProjectSchema.optional()
  })
  .superRefine((value, context) => {
    if (
      value.sourceSizeBytes !== undefined &&
      value.registrationFrontierOffset > value.sourceSizeBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["registrationFrontierOffset"],
        message: "Registration frontier exceeds source size"
      });
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
      transcriptByteOffset: boundedBytes.optional(),
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
    legacyIdempotencyKeys: z.array(boundedText).max(16).optional(),
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
    projectionVersion: z.literal("codex-transcript-v1").optional(),
    metadata: historicalItemMetadataSchema
  })
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

const historicalImportBatchBaseSchema = z.object({
  expectedCheckpointOffset: boundedBytes,
  expectedCheckpointHash: checkpointHash.nullable().optional(),
  checkpointOffset: boundedBytes,
  checkpointLine: boundedCounter,
  checkpointHash,
  sourceSizeBytes: boundedBytes,
  skippedRecordCount: boundedCounter.optional(),
  malformedRecordCount: boundedCounter.optional(),
  sourceEventFrom: z.string().datetime({ offset: true }).optional(),
  sourceEventTo: z.string().datetime({ offset: true }).optional(),
  items: z.array(historicalConversationItemSchema).max(1000)
});

type HistoricalImportBatch = z.infer<typeof historicalImportBatchBaseSchema>;

const validateBatchItems = (
  value: HistoricalImportBatch,
  context: z.RefinementCtx
): void => {
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
      return;
    }
  }
};

const validateBatchCheckpoint = (
  value: HistoricalImportBatch,
  context: z.RefinementCtx
): void => {
  if (
    value.checkpointOffset <= value.expectedCheckpointOffset ||
    value.checkpointOffset > value.sourceSizeBytes
  ) {
    context.addIssue({
      code: "custom",
      path: ["checkpointOffset"],
      message: "Checkpoint must advance within current source size"
    });
  }
  const initialHashInvalid =
    value.expectedCheckpointOffset === 0 &&
    value.expectedCheckpointHash != null;
  const resumeHashMissing =
    value.expectedCheckpointOffset > 0 && !value.expectedCheckpointHash;
  if (initialHashInvalid || resumeHashMissing) {
    context.addIssue({
      code: "custom",
      path: ["expectedCheckpointHash"],
      message: initialHashInvalid
        ? "Initial checkpoint must not have a hash"
        : "Resume checkpoint hash is required"
    });
  }
};

const validateBatchEventRange = (
  value: HistoricalImportBatch,
  context: z.RefinementCtx
): void => {
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
};

export const historicalImportBatchSchema =
  historicalImportBatchBaseSchema.superRefine((value, context) => {
    validateBatchItems(value, context);
    validateBatchCheckpoint(value, context);
    validateBatchEventRange(value, context);
  });

export const liveTranscriptCursorSchema = z
  .object({
    expectedCursorOffset: boundedBytes,
    expectedCursorHash: checkpointHash.nullable().optional(),
    cursorOffset: boundedBytes,
    cursorLine: boundedCounter,
    cursorHash: checkpointHash,
    sourceSizeBytes: boundedBytes
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.cursorOffset <= value.expectedCursorOffset ||
      value.cursorOffset > value.sourceSizeBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["cursorOffset"],
        message: "Live cursor must advance within current source size"
      });
    }
    if (
      (value.expectedCursorOffset === 0 && value.expectedCursorHash != null) ||
      (value.expectedCursorOffset > 0 && !value.expectedCursorHash)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedCursorHash"],
        message: "Live cursor expected hash does not match its offset"
      });
    }
  });
