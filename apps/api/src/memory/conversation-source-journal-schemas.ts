import { z } from "zod";

const boundedOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedLine = z.number().int().min(0).max(2_147_483_647);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sourceKind = z.literal("codex");
const maximumSegmentBytes = 16 * 1024 * 1024;
const maximumSegmentBase64Bytes = Math.ceil(maximumSegmentBytes / 3) * 4;

export const conversationSourceArtifactSchema = z
  .object({
    sourceSession: z
      .object({
        externalSessionId: z.string().min(1).max(1024),
        sourceRuntime: z.enum(["codex", "codex-cli"]),
        captureMethod: z.literal("api"),
        model: z.string().min(1).max(512).optional(),
        cwd: z.string().min(1).max(4096).optional(),
        idempotencyKey: z.string().min(1).max(2048),
        sourceHash: digest.optional(),
        metadata: z.record(z.string(), z.unknown()),
        detectedProjects: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(512),
                name: z.string().trim().min(1).max(160),
                path: z.string().trim().min(1).max(4096).nullable()
              })
              .strict()
          )
          .max(20)
          .optional()
      })
      .strict(),
    sourceKind,
    externalSessionId: z.string().min(1).max(1024),
    sourceFingerprint: digest,
    artifactFormat: z.literal("codex_rollout_jsonl"),
    artifactFormatVersion: z.literal(1),
    journalStartOffset: boundedOffset,
    journalStartLine: boundedLine,
    liveStartOffset: boundedOffset,
    liveStartLine: boundedLine,
    currentSourceLength: boundedOffset,
    sourceCreatedAt: z.string().datetime({ offset: true }),
    sourceModifiedAt: z.string().datetime({ offset: true }).optional(),
    redactedSourceLabel: z.string().min(1).max(255)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceSession.externalSessionId !== value.externalSessionId) {
      context.addIssue({
        code: "custom",
        path: ["sourceSession", "externalSessionId"],
        message: "Captured Session and source artifact identities must match"
      });
    }
    if (value.journalStartOffset > value.currentSourceLength) {
      context.addIssue({
        code: "custom",
        path: ["journalStartOffset"],
        message: "Journal start must be within the observed source"
      });
    }
    if (
      value.liveStartOffset < value.journalStartOffset ||
      value.liveStartOffset > value.currentSourceLength ||
      value.liveStartLine < value.journalStartLine
    ) {
      context.addIssue({
        code: "custom",
        path: ["liveStartOffset"],
        message: "Live start must be within the retained source range"
      });
    }
  });

export const conversationSourceArtifactLookupSchema = z
  .object({
    source_kind: sourceKind,
    external_session_id: z.string().min(1).max(1024)
  })
  .strict();

export const conversationSourceArtifactParamsSchema = z
  .object({ artifactId: z.string().uuid() })
  .strict();

export const conversationSourceGenerationParamsSchema = z
  .object({ sourceGenerationId: z.string().uuid() })
  .strict();

export const conversationSourceSegmentParamsSchema = z
  .object({
    artifactId: z.string().uuid(),
    segmentId: z.string().uuid()
  })
  .strict();

export const conversationSourceSegmentAppendSchema = z
  .object({
    expectedProviderOffset: boundedOffset,
    expectedProviderLine: boundedLine,
    sourceEndOffset: boundedOffset,
    sourceEndLine: boundedLine,
    plaintextDigest: digest,
    plaintextSize: z.number().int().positive().max(maximumSegmentBytes),
    bytesBase64: z.string().min(1).max(maximumSegmentBase64Bytes),
    currentSourceLength: boundedOffset,
    sourceModifiedAt: z.string().datetime({ offset: true }).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceEndOffset <= value.expectedProviderOffset ||
      value.sourceEndLine <= value.expectedProviderLine ||
      value.plaintextSize !==
        value.sourceEndOffset - value.expectedProviderOffset ||
      value.sourceEndOffset > value.currentSourceLength
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceEndOffset"],
        message: "Conversation source segment range is invalid"
      });
    }
  });

export const conversationSourceSegmentListSchema = z
  .object({
    after_offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

export const conversationSourceArtifactFinalizeSchema = z
  .object({
    expectedProviderOffset: boundedOffset,
    expectedProviderLine: boundedLine
  })
  .strict();

export const conversationSourceSuccessorGenerationSchema = z
  .object({
    expectedParentClosureHash: digest,
    sourceGenerationId: z.string().uuid(),
    originKeyId: z.string().uuid()
  })
  .strict();

export const conversationSourceCursorSchema = z
  .object({
    consumerKind: z.enum([
      "canonical_live",
      "canonical_historical",
      "remote_upload",
      "remote_processing",
      "projection"
    ]),
    expectedSourceOffset: boundedOffset,
    sourceOffset: boundedOffset,
    sourceLine: boundedLine,
    segmentIndex: z.number().int().nonnegative(),
    lastVerifiedDigest: digest,
    parserState: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceOffset <= value.expectedSourceOffset) {
      context.addIssue({
        code: "custom",
        path: ["sourceOffset"],
        message: "Conversation source consumer cursor must advance"
      });
    }
  });

export const conversationSourceCursorLookupSchema = z
  .object({
    consumer_kind: z.enum([
      "canonical_live",
      "canonical_historical",
      "remote_upload",
      "remote_processing",
      "projection"
    ])
  })
  .strict();
