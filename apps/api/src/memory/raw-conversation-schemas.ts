import { z } from "zod";
import {
  combineStorageSanitizationCounts,
  canonicalConversationItemKey,
  resolveAiClientSourceAdapter,
  codexCanonicalConversationItemKey,
  metadataWithStorageSanitization,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
  rawConversationTransportChunkGroupId,
  sanitizeForPostgresStorage
} from "@koed/shared";
import { metadataSchema } from "./common-schemas.js";

const rawVisibilitySchema = z.literal("personal");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const postgresNonNegativeInt = z.number().int().min(0).max(2_147_483_647);
const tokenIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const tokenIdentifierSchema = (maxLength: number, label: string) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(
      tokenIdentifierPattern,
      `${label} may only contain bounded opaque identifier characters`
    );
const providerIdentifierSchema = tokenIdentifierSchema(
  512,
  "Provider identifiers"
);
const classificationTokenSchema = tokenIdentifierSchema(
  128,
  "Classification fields"
);
const toolNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9._:/@-]*$/,
    "Tool names may only contain bounded tool identifier characters"
  );
const sourceHashSchema = tokenIdentifierSchema(256, "Source hashes");
const idempotencyKeySchema = tokenIdentifierSchema(512, "Idempotency keys");
const canonicalItemKeySchema = z
  .string()
  .regex(/^conversation-item:[a-f0-9]{64}$/);
const memoryActorSchema = z.enum([
  "user",
  "assistant",
  "agent",
  "subagent",
  "tool",
  "system"
]);

const serverSanitizationEntrySchema = z
  .object({
    replacement: z.literal("U+FFFD"),
    replacementCount: postgresNonNegativeInt
  })
  .strict();

const conversationToolCallMetadataSchema = z
  .object({
    kind: classificationTokenSchema.nullable().optional(),
    type: classificationTokenSchema.nullable().optional(),
    name: toolNameSchema.nullable().optional(),
    id: providerIdentifierSchema.nullable().optional(),
    status: classificationTokenSchema.nullable().optional()
  })
  .catchall(z.unknown());

const conversationMetadataSchema = z
  .object({
    projectId: z.string().min(1).max(4096).nullable().optional(),
    transcriptType: classificationTokenSchema.nullable().optional(),
    transcriptParentType: classificationTokenSchema.nullable().optional(),
    transcriptIndex: postgresNonNegativeInt.nullable().optional(),
    transcriptId: providerIdentifierSchema.nullable().optional(),
    transcriptByteOffset: postgresNonNegativeInt.nullable().optional(),
    transcriptSourceLineNumber: postgresNonNegativeInt.nullable().optional(),
    transcriptAssignedTurnId: providerIdentifierSchema.nullable().optional(),
    toolEventKind: classificationTokenSchema.nullable().optional(),
    toolName: toolNameSchema.nullable().optional(),
    callId: providerIdentifierSchema.nullable().optional(),
    toolCallId: providerIdentifierSchema.nullable().optional(),
    status: classificationTokenSchema.nullable().optional(),
    threadKind: z.enum(["conversation", "subagent"]).nullable().optional(),
    parentThreadId: providerIdentifierSchema.nullable().optional(),
    parentSessionId: providerIdentifierSchema.nullable().optional(),
    parentExternalSessionId: providerIdentifierSchema.nullable().optional(),
    managedConversationReconciliation: z.boolean().nullable().optional(),
    managedConversationSourceRole: z
      .enum(["ambiguous_user_context_provenance", "duplicate_representation"])
      .nullable()
      .optional(),
    appServerItemType: classificationTokenSchema.nullable().optional(),
    clientUserMessageId: providerIdentifierSchema.nullable().optional(),
    phase: classificationTokenSchema.nullable().optional(),
    sourceEventTimeAccuracy: z
      .enum([
        "source",
        "observation_only",
        "interpolated_between_sources",
        "observed_fallback"
      ])
      .nullable()
      .optional(),
    canonicalIdentityBasis: z
      .enum(["provider_ids", "source_observation"])
      .nullable()
      .optional(),
    questionId: z.string().uuid().nullable().optional(),
    nodeId: z.string().uuid().nullable().optional(),
    transportChunkGroupId: sourceHashSchema.nullable().optional(),
    sourceItemHash: sourceHashSchema.nullable().optional(),
    sourceChunkIndex: postgresNonNegativeInt.nullable().optional(),
    sourceChunkCount: z.number().int().min(1).max(4096).nullable().optional(),
    toolCall: conversationToolCallMetadataSchema.nullable().optional(),
    workflow: z.enum(["memory_question", "lcm_summary"]).nullable().optional(),

    // These are accepted for compatibility, validated, then discarded below.
    managedConversation: z.boolean().nullable().optional(),
    projectionPolicyKey: classificationTokenSchema.nullable().optional(),
    projectionActor: memoryActorSchema.nullable().optional(),
    semanticControl: classificationTokenSchema.nullable().optional(),
    canonicalConversationItemKey: canonicalItemKeySchema.nullable().optional(),
    canonicalConversationItemActor: memoryActorSchema.nullable().optional(),
    canonicalConversationItemKind: classificationTokenSchema
      .nullable()
      .optional(),
    canonicalConversationItemContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    canonicalStableItemId: providerIdentifierSchema.nullable().optional(),
    includeInLcm: z.boolean().nullable().optional(),
    storageSanitization: z
      .record(classificationTokenSchema, postgresNonNegativeInt)
      .nullable()
      .optional(),
    koedSanitization: z
      .object({
        nulCharacters: serverSanitizationEntrySchema.optional(),
        malformedUtf16: serverSanitizationEntrySchema.optional()
      })
      .strict()
      .nullable()
      .optional()
  })
  .catchall(z.unknown())
  .default({});

const serverAuthoritativeMetadataKeys = new Set([
  "managedConversation",
  "projectionPolicyKey",
  "projectionActor",
  "semanticControl",
  "canonicalConversationItemKey",
  "canonicalConversationItemActor",
  "canonicalConversationItemKind",
  "canonicalConversationItemContentHash",
  "canonicalStableItemId",
  "transportChunkGroupId",
  "sourceItemHash",
  "sourceChunkIndex",
  "sourceChunkCount",
  "includeInLcm",
  "storageSanitization",
  "koedSanitization"
]);

const withoutClientClassificationOverrides = (
  metadata: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => !serverAuthoritativeMetadataKeys.has(key)
    )
  );

const jsonShape = (
  value: unknown
): { bytes: number; depth: number; entries: number } => {
  const serialized = JSON.stringify(value);
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let depth = 0;
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    depth = Math.max(depth, current.depth);
    if (Array.isArray(current.value)) {
      entries += current.value.length;
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (current.value && typeof current.value === "object") {
      const fields = Object.values(current.value as Record<string, unknown>);
      entries += fields.length;
      for (const child of fields) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return {
    bytes: Buffer.byteLength(serialized ?? "null", "utf8"),
    depth,
    entries
  };
};

const conversationItemSchema = z
  .object({
    observationOnly: z.boolean().optional(),
    visibility: rawVisibilitySchema.optional(),
    sessionId: z.string().uuid().optional(),
    turnId: z.string().uuid().optional(),
    sourceKind: z.enum(["codex", "codex-cli", "claude-code"]),
    sourceAdapterVersion: z.enum([
      "codex-transcript-v1",
      "codex-hook-signal-v1",
      "codex-app-server-conversation-v1",
      "codex-app-server-v1",
      "claude-code-transcript-v1",
      "claude-code-hook-signal-v1"
    ]),
    sourceTransport: z.enum([
      "transcript",
      "hook_signal",
      "app_server",
      "mcp",
      "web"
    ]),
    externalSessionId: providerIdentifierSchema.optional(),
    externalThreadId: providerIdentifierSchema.optional(),
    externalTurnId: providerIdentifierSchema.optional(),
    externalItemId: providerIdentifierSchema.optional(),
    parentExternalItemId: providerIdentifierSchema.optional(),
    sourceRecordType: classificationTokenSchema,
    sourceEventType: classificationTokenSchema.optional(),
    sourceLineNumber: postgresNonNegativeInt.optional(),
    sourceSequence: postgresNonNegativeInt.optional(),
    eventTime: z.string().datetime({ offset: true }).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
    rawJson: z
      .unknown()
      .refine((value) => value !== undefined, "rawJson is required"),
    rawText: z.string().max(2_000_000).optional(),
    logicalSourceId: providerIdentifierSchema.optional(),
    transportChunkIndex: postgresNonNegativeInt
      .max(RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT - 1)
      .optional(),
    transportChunkCount: z
      .number()
      .int()
      .min(1)
      .max(RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT)
      .optional(),
    transportChunkText: z
      .string()
      .max(RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES)
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <=
          RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_BYTES,
        "Transport chunk exceeds the UTF-8 byte limit"
      )
      .optional(),
    transportChunkEncoding: classificationTokenSchema.optional(),
    sourceHash: sourceHashSchema,
    idempotencyKey: idempotencyKeySchema,
    canonicalItemKey: canonicalItemKeySchema.optional(),
    canonicalStableItemId: providerIdentifierSchema.optional(),
    observationKind: z
      .enum([
        "snapshot",
        "lifecycle_started",
        "lifecycle_completed",
        "control",
        "reconciliation"
      ])
      .optional(),
    observationComponent: classificationTokenSchema.optional(),
    metadata: conversationMetadataSchema
  })
  .superRefine((item, context) => {
    if (
      item.sourceTransport === "transcript" &&
      !resolveAiClientSourceAdapter({
        sourceKind: item.sourceKind === "codex-cli" ? "codex" : item.sourceKind,
        sourceRuntime:
          item.sourceKind === "codex-cli" ? "codex-cli" : item.sourceKind,
        artifactFormat:
          item.sourceKind === "claude-code"
            ? "claude_session_jsonl"
            : "codex_rollout_jsonl",
        artifactFormatVersion: 1,
        sourceAdapterVersion: item.sourceAdapterVersion
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Source adapter and source kind classifications disagree",
        path: ["sourceAdapterVersion"]
      });
    }
    if (item.observationOnly && item.canonicalItemKey) {
      context.addIssue({
        code: "custom",
        message:
          "Observation-only source records cannot claim canonical identity",
        path: ["canonicalItemKey"]
      });
    }
    const workflow =
      typeof item.metadata.workflow === "string"
        ? item.metadata.workflow
        : undefined;
    const sessionlessWorkflow =
      item.sourceAdapterVersion === "codex-app-server-v1" &&
      item.sourceTransport === "app_server" &&
      ["memory_question", "lcm_summary"].includes(workflow ?? "");
    if (!item.sessionId && !sessionlessWorkflow) {
      context.addIssue({
        code: "custom",
        message: "Conversation ingestion requires a Captured Session",
        path: ["sessionId"]
      });
    }
    if (
      item.sourceAdapterVersion === "codex-app-server-conversation-v1" &&
      /^item\/(started|completed)$/.test(item.sourceEventType ?? "") &&
      !item.externalTurnId
    ) {
      context.addIssue({
        code: "custom",
        message: "Managed item lifecycle records require externalTurnId",
        path: ["externalTurnId"]
      });
    }
    if (
      item.sourceAdapterVersion === "codex-app-server-conversation-v1" &&
      !item.observationOnly &&
      (/^item\/(started|completed)$/.test(item.sourceEventType ?? "") ||
        item.sourceEventType === "turn/completed") &&
      (!item.canonicalItemKey ||
        !item.canonicalStableItemId ||
        !item.observationComponent ||
        !item.externalThreadId ||
        !item.externalTurnId)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Managed semantic lifecycle records require exact canonical identity",
        path: ["canonicalItemKey"]
      });
    }
    if (
      item.sourceAdapterVersion === "codex-app-server-conversation-v1" &&
      !item.observationOnly &&
      (/^item\/(started|completed)$/.test(item.sourceEventType ?? "") ||
        item.sourceEventType === "turn/completed") &&
      item.canonicalItemKey &&
      item.canonicalStableItemId &&
      item.observationComponent &&
      item.externalThreadId &&
      item.canonicalItemKey !==
        codexCanonicalConversationItemKey({
          externalThreadId: item.externalThreadId,
          externalTurnId: item.externalTurnId,
          stableItemId: item.canonicalStableItemId,
          component: item.observationComponent
        })
    ) {
      context.addIssue({
        code: "custom",
        message: "Managed canonical identity does not match its source fields",
        path: ["canonicalItemKey"]
      });
    }
    const allowedTransports = {
      "codex-transcript-v1": ["transcript"],
      "codex-hook-signal-v1": ["hook_signal"],
      "codex-app-server-conversation-v1": ["app_server"],
      "codex-app-server-v1": ["app_server"],
      "claude-code-transcript-v1": ["transcript"],
      "claude-code-hook-signal-v1": ["hook_signal"]
    }[item.sourceAdapterVersion];
    if (!allowedTransports.includes(item.sourceTransport)) {
      context.addIssue({
        code: "custom",
        message: "Source adapter and transport classifications disagree",
        path: ["sourceTransport"]
      });
    }
    const expectedRecordType =
      item.sourceAdapterVersion === "codex-app-server-v1" ||
      item.sourceAdapterVersion === "codex-app-server-conversation-v1"
        ? "app_server_notification"
        : item.sourceAdapterVersion === "codex-hook-signal-v1" ||
            item.sourceAdapterVersion === "claude-code-hook-signal-v1"
          ? "hook_signal"
          : undefined;
    if (expectedRecordType && item.sourceRecordType !== expectedRecordType) {
      context.addIssue({
        code: "custom",
        message: "Source adapter and record classifications disagree",
        path: ["sourceRecordType"]
      });
    }
    if (
      item.sourceAdapterVersion === "codex-hook-signal-v1" ||
      item.sourceAdapterVersion === "claude-code-hook-signal-v1"
    ) {
      const expectedStableItemId = item.externalTurnId
        ? `turn:${item.externalTurnId}:completed`
        : null;
      const expectedCanonicalItemKey =
        item.externalThreadId && item.externalTurnId && expectedStableItemId
          ? canonicalConversationItemKey({
              provider:
                item.sourceAdapterVersion === "claude-code-hook-signal-v1"
                  ? "claude-code"
                  : "codex",
              externalThreadId: item.externalThreadId,
              externalTurnId: item.externalTurnId,
              stableItemId: expectedStableItemId,
              component: "control"
            })
          : null;
      const raw = isRecord(item.rawJson) ? item.rawJson : {};
      const payload = isRecord(raw.payload) ? raw.payload : {};
      if (
        item.sourceEventType !== "turn_completed" ||
        raw.type !== "hook_signal" ||
        payload.type !== "turn_completed" ||
        !Number.isSafeInteger(payload.sourceFrontierOffset) ||
        Number(payload.sourceFrontierOffset) < 0 ||
        !Number.isSafeInteger(payload.sourceFrontierLine) ||
        Number(payload.sourceFrontierLine) < 0 ||
        item.rawText !== undefined ||
        !item.eventTime ||
        !item.externalSessionId ||
        !item.externalThreadId ||
        !item.externalTurnId ||
        item.externalSessionId !== item.externalThreadId ||
        item.externalItemId !== expectedStableItemId ||
        item.canonicalStableItemId !== expectedStableItemId ||
        item.observationKind !== "control" ||
        item.observationComponent !== "control" ||
        item.canonicalItemKey !== expectedCanonicalItemKey
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Capture Hook turn boundaries require exact canonical turn identity",
          path: ["canonicalItemKey"]
        });
      }
    }
    const chunkFields = [
      ["transportChunkIndex", item.transportChunkIndex],
      ["transportChunkCount", item.transportChunkCount],
      ["transportChunkText", item.transportChunkText],
      ["transportChunkEncoding", item.transportChunkEncoding]
    ] as const;
    const suppliedChunkFields = chunkFields.filter(
      ([, value]) => value !== undefined
    );
    if (
      suppliedChunkFields.length > 0 &&
      suppliedChunkFields.length !== chunkFields.length
    ) {
      for (const [field, value] of chunkFields) {
        if (value === undefined) {
          context.addIssue({
            code: "custom",
            message: "Transport chunk fields must be supplied together",
            path: [field]
          });
        }
      }
    }
    if (
      item.transportChunkIndex !== undefined &&
      item.transportChunkCount !== undefined &&
      item.transportChunkIndex >= item.transportChunkCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Transport chunk index must be less than chunk count",
        path: ["transportChunkIndex"]
      });
    }
    if (suppliedChunkFields.length > 0 && !item.logicalSourceId) {
      context.addIssue({
        code: "custom",
        message: "Transport chunks require a logical source identifier",
        path: ["logicalSourceId"]
      });
    }
    if (suppliedChunkFields.length > 0) {
      const rawJson = isRecord(item.rawJson) ? item.rawJson : {};
      const sourceItemHash =
        typeof rawJson.sourceItemHash === "string"
          ? rawJson.sourceItemHash
          : undefined;
      const claimedGroupId =
        typeof rawJson.transportChunkGroupId === "string"
          ? rawJson.transportChunkGroupId
          : typeof item.metadata.transportChunkGroupId === "string"
            ? item.metadata.transportChunkGroupId
            : undefined;
      if (!sourceItemHash || !claimedGroupId) {
        context.addIssue({
          code: "custom",
          message:
            "Transport chunks require source item and chunk group identity",
          path: ["rawJson"]
        });
      } else if (
        item.logicalSourceId &&
        item.transportChunkCount &&
        item.transportChunkEncoding &&
        claimedGroupId !==
          rawConversationTransportChunkGroupId({
            sourceKind: item.sourceKind,
            sourceAdapterVersion: item.sourceAdapterVersion,
            sourceTransport: item.sourceTransport,
            logicalSourceId: item.logicalSourceId,
            sourceItemHash,
            transportChunkCount: item.transportChunkCount,
            transportChunkEncoding: item.transportChunkEncoding
          })
      ) {
        context.addIssue({
          code: "custom",
          message: "Transport chunk group identity does not match its source",
          path: ["rawJson", "transportChunkGroupId"]
        });
      }
    }
    if (
      item.metadata.sourceChunkIndex !== undefined &&
      item.metadata.sourceChunkIndex !== null &&
      item.transportChunkIndex !== item.metadata.sourceChunkIndex
    ) {
      context.addIssue({
        code: "custom",
        message: "Transport and metadata chunk indexes disagree",
        path: ["metadata", "sourceChunkIndex"]
      });
    }
    if (
      item.metadata.sourceChunkCount !== undefined &&
      item.metadata.sourceChunkCount !== null &&
      item.transportChunkCount !== item.metadata.sourceChunkCount
    ) {
      context.addIssue({
        code: "custom",
        message: "Transport and metadata chunk counts disagree",
        path: ["metadata", "sourceChunkCount"]
      });
    }
    for (const [field, value, maxBytes, maxDepth, maxEntries] of [
      ["rawJson", item.rawJson, 2_000_000, 64, 50_000],
      ["metadata", item.metadata, 262_144, 32, 4_096]
    ] as const) {
      const shape = jsonShape(value);
      if (shape.bytes > maxBytes) {
        context.addIssue({
          code: "custom",
          message: `${field} exceeds ${maxBytes} UTF-8 bytes`,
          path: [field]
        });
      }
      if (shape.depth > maxDepth || shape.entries > maxEntries) {
        context.addIssue({
          code: "custom",
          message: `${field} structure is too deep or complex`,
          path: [field]
        });
      }
    }
  })
  .transform((item) => {
    const rawJson = sanitizeForPostgresStorage(item.rawJson);
    const rawText = sanitizeForPostgresStorage(item.rawText);
    const transportChunkText = sanitizeForPostgresStorage(
      item.transportChunkText
    );
    const metadata = sanitizeForPostgresStorage(
      withoutClientClassificationOverrides(item.metadata)
    );
    const sanitizationCounts = combineStorageSanitizationCounts(
      rawJson,
      rawText,
      transportChunkText,
      metadata
    );

    const rawJsonValue = rawJson.value;
    const chunkSourceItemHash =
      isRecord(rawJsonValue) && typeof rawJsonValue.sourceItemHash === "string"
        ? rawJsonValue.sourceItemHash
        : undefined;
    const transportChunkGroupId =
      item.logicalSourceId &&
      item.transportChunkCount &&
      item.transportChunkEncoding &&
      chunkSourceItemHash
        ? rawConversationTransportChunkGroupId({
            sourceKind: item.sourceKind,
            sourceAdapterVersion: item.sourceAdapterVersion,
            sourceTransport: item.sourceTransport,
            logicalSourceId: item.logicalSourceId,
            sourceItemHash: chunkSourceItemHash,
            transportChunkCount: item.transportChunkCount,
            transportChunkEncoding: item.transportChunkEncoding
          })
        : undefined;
    return {
      ...item,
      rawJson: rawJsonValue,
      rawText: rawText.value as string | undefined,
      transportChunkText: transportChunkText.value as string | undefined,
      metadata: metadataWithStorageSanitization(
        {
          ...(metadata.value as Record<string, unknown>),
          ...(transportChunkGroupId
            ? {
                transportChunkGroupId,
                sourceItemHash: chunkSourceItemHash,
                sourceChunkIndex: item.transportChunkIndex,
                sourceChunkCount: item.transportChunkCount
              }
            : {})
        },
        sanitizationCounts
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
  sourceRuntime: z.enum(["codex", "codex-cli", "claude-code"]).optional(),
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
  modelContextWindow: postgresNonNegativeInt.nullable().optional(),
  inputTokens: postgresNonNegativeInt.nullable().optional(),
  cachedInputTokens: postgresNonNegativeInt.nullable().optional(),
  outputTokens: postgresNonNegativeInt.nullable().optional(),
  reasoningOutputTokens: postgresNonNegativeInt.nullable().optional(),
  totalTokens: postgresNonNegativeInt.nullable().optional(),
  usageScope: z.string().min(1).optional(),
  metadata: metadataSchema.optional(),
  idempotencyKey: z.string().min(1).max(512).optional(),
  sourceHash: z.string().min(1).max(256).optional()
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

export const releaseConversationProjectionHoldSchema = z.object({
  sessionId: z.string().uuid(),
  externalTurnId: providerIdentifierSchema
});

export const conversationItemStableIdentityQuerySchema = z
  .object({
    session_id: z.string().uuid(),
    canonical_stable_item_id: providerIdentifierSchema
  })
  .strict();

export const resetConversationProjectionSchema = z.object({
  sessionId: z.string().uuid()
});
