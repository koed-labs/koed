import { z } from "zod";

const boundedOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedLine = z.number().int().min(0).max(2_147_483_647);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const sourceKind = z.enum(["codex", "claude-code", "pi"]);
const sourceComponentId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+){0,7}$/);
const maximumSegmentBytes = 16 * 1024 * 1024;
const maximumSegmentBase64Bytes = Math.ceil(maximumSegmentBytes / 3) * 4;

export const conversationSourceArtifactSchema = z
  .object({
    sourceSession: z
      .object({
        externalSessionId: z.string().min(1).max(1024),
        sourceRuntime: z.enum(["codex", "codex-cli", "claude-code", "pi"]),
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
    sourceComponentId: sourceComponentId.default("main"),
    sourceComponentRole: z.enum(["primary", "auxiliary"]).default("primary"),
    parentSourceComponentId: sourceComponentId.nullable().default(null),
    contentFraming: z.enum(["jsonl", "immutable_blob"]).default("jsonl"),
    externalSessionId: z.string().min(1).max(1024),
    sourceFingerprint: digest,
    artifactFormat: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
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
    if (
      (value.sourceComponentRole === "primary" &&
        (value.sourceComponentId !== "main" ||
          value.parentSourceComponentId !== null)) ||
      (value.sourceComponentRole === "auxiliary" &&
        (!value.parentSourceComponentId ||
          value.parentSourceComponentId === value.sourceComponentId))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceComponentRole"],
        message: "Conversation source component relationship is invalid"
      });
    }
    const validSourceTuple =
      value.contentFraming === "immutable_blob" ||
      (value.sourceKind === "codex" &&
        value.artifactFormat === "codex_rollout_jsonl" &&
        ["codex", "codex-cli"].includes(value.sourceSession.sourceRuntime)) ||
      (value.sourceKind === "claude-code" &&
        value.artifactFormat === "claude_session_jsonl" &&
        value.sourceSession.sourceRuntime === "claude-code") ||
      (value.sourceKind === "pi" &&
        value.artifactFormat === "pi_session_jsonl" &&
        value.sourceSession.sourceRuntime === "pi");
    if (!validSourceTuple) {
      context.addIssue({
        code: "custom",
        path: ["sourceKind"],
        message: "Conversation source identity tuple is unsupported"
      });
    }
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
    external_session_id: z.string().min(1).max(1024),
    source_component_id: sourceComponentId.default("main")
  })
  .strict();

export const conversationSourceArtifactParamsSchema = z
  .object({ artifactId: z.string().uuid() })
  .strict();

export const conversationSourceGenerationParamsSchema = z
  .object({ sourceGenerationId: z.string().uuid() })
  .strict();

export const conversationSourceGenerationLookupSchema = z
  .object({ source_component_id: sourceComponentId.default("main") })
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
