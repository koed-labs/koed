import { createHash } from "node:crypto";
import { codexCanonicalConversationItemKey } from "@koed/shared";
import { NORMALIZED_IMPORT_SOURCE_ADAPTER } from "@koed/db";
import type {
  AtifSanitizationManifest,
  NormalizedTranscriptItem
} from "./atif/index.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
    .join(",")}}`;
};

const componentByType = {
  system_message: "message",
  user_message: "message",
  agent_message: "message",
  reasoning_summary: "reasoning_summary",
  tool_call: "tool_call",
  tool_result: "tool_result"
} as const;

export interface NormalizedImportClient {
  createSession(input: Record<string, unknown>): Promise<{
    session?: { id: string };
    skipped?: boolean;
  }>;
  /** Calls the production-owned normalized-import route/capability. */
  createTrustedNormalizedImport(input: Record<string, unknown>): Promise<{
    items?: Array<{ id: string }>;
  }>;
  projectConversationItems(input: Record<string, unknown>): Promise<unknown>;
}

export interface NormalizedProjectionDisposition {
  eventId: string;
  visibility: "personal";
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  workClass: string;
}

export interface NormalizedProjectionAttestation {
  rawItemsScanned: number;
  rawItemsProjected: number;
  memoryEventsCreated: number;
  memoryEventIds: string[];
  dispositions: NormalizedProjectionDisposition[];
  scheduledLcmEventIds: string[];
}

export interface ImportNormalizedAttemptInput {
  client: NormalizedImportClient;
  projectId: string;
  projectCwd: string;
  taskDigest: string;
  sourceAttemptId: string;
  items: readonly NormalizedTranscriptItem[];
  sanitizationManifest: AtifSanitizationManifest;
}

export const normalizedImportThreadId = (
  taskDigest: string,
  sourceAttemptId: string
): string =>
  `koed-eval-${sha256(`${taskDigest}\0${sourceAttemptId}`).slice(0, 40)}`;

export const normalizedImportPayload = ({
  sessionId,
  externalThreadId,
  projectId,
  taskDigest,
  sourceAttemptId,
  sanitizationManifestHash,
  item
}: {
  sessionId: string;
  externalThreadId: string;
  projectId: string;
  taskDigest: string;
  sourceAttemptId: string;
  sanitizationManifestHash: string;
  item: NormalizedTranscriptItem;
}): Record<string, unknown> => {
  const component = componentByType[item.type];
  const stableItemId = item.sourceIdentity;
  const externalTurnId = `attempt:${sha256(sourceAttemptId).slice(0, 32)}:step:${item.stepId}`;
  const rawText =
    item.content ??
    (item.toolCall
      ? `Tool call: ${item.toolCall.function_name}\n\nInput:\n${JSON.stringify(item.toolCall.arguments)}`
      : undefined);
  const rawJson = {
    type: "normalized_import_item",
    payload: {
      type: item.type,
      ...(item.content !== undefined ? { content: item.content } : {}),
      ...(item.toolCall ? { toolCall: item.toolCall } : {}),
      ...(item.type === "tool_result" && item.sourceCallId
        ? { sourceCallId: item.sourceCallId }
        : {})
    }
  };
  return {
    sessionId,
    sourceKind: NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceKind,
    sourceAdapterVersion: NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceAdapterVersion,
    sourceTransport: NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceTransport,
    externalSessionId: externalThreadId,
    externalThreadId,
    externalTurnId,
    externalItemId: stableItemId,
    canonicalStableItemId: stableItemId,
    canonicalItemKey: codexCanonicalConversationItemKey({
      externalThreadId,
      externalTurnId,
      stableItemId,
      component
    }),
    observationComponent: component,
    sourceRecordType: NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceRecordType,
    sourceEventType: item.type,
    sourceSequence: item.sequence,
    ...(item.timestamp ? { eventTime: item.timestamp } : {}),
    rawJson,
    ...(rawText !== undefined ? { rawText } : {}),
    sourceHash: `sha256:${sha256(
      JSON.stringify({ externalThreadId, stableItemId, rawJson })
    )}`,
    idempotencyKey: `normalized-import:${sha256(item.sourceIdentity)}`,
    ...(item.type === "tool_result" && item.sourceCallId
      ? { parentExternalItemId: item.sourceCallId }
      : {}),
    metadata: {
      projectId,
      transcriptType: item.type,
      transcriptIndex: item.sequence,
      transcriptAssignedTurnId: externalTurnId,
      ...(item.sourceCallId ? { toolCallId: item.sourceCallId } : {}),
      ...(item.toolCall
        ? {
            toolName: item.toolCall.function_name,
            toolCallId: item.toolCall.tool_call_id,
            toolCall: {
              kind: "call",
              type: "function_call",
              id: item.toolCall.tool_call_id,
              name: item.toolCall.function_name,
              input: item.toolCall.arguments
            }
          }
        : {}),
      normalizedImportProvenance: {
        sourceFormat: NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceFormat,
        sourceSchemaVersion:
          NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceSchemaVersion,
        sourceProducer: NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceProducer,
        normalizerAdapter: NORMALIZED_IMPORT_SOURCE_ADAPTER.normalizerAdapter,
        normalizerAdapterVersion:
          NORMALIZED_IMPORT_SOURCE_ADAPTER.normalizerAdapterVersion,
        taskDigest,
        sourceAttemptId,
        atifIdentity: item.atifIdentity,
        stepId: String(item.stepId),
        sanitizationManifestHash
      }
    }
  };
};

export const normalizedImportSourceIdentity = (input: {
  taskDigest: string;
  sourceAttemptId: string;
  atifIdentity: string;
  sequence: number;
}): string =>
  `${NORMALIZED_IMPORT_SOURCE_ADAPTER.normalizerAdapter}:${NORMALIZED_IMPORT_SOURCE_ADAPTER.normalizerAdapterVersion}:${sha256(
    canonicalize(input)
  )}`;

export const importNormalizedAttempt = async (
  input: ImportNormalizedAttemptInput
): Promise<{
  sessionId: string;
  conversationItemIds: string[];
  projection: NormalizedProjectionAttestation;
}> => {
  if (input.items.length === 0)
    throw new Error("Normalized attempt has no items");
  if (
    input.sanitizationManifest.schemaVersion !==
      NORMALIZED_IMPORT_SOURCE_ADAPTER.sourceSchemaVersion ||
    input.sanitizationManifest.rejectionReason !== null ||
    input.sanitizationManifest.outputSha256 === null ||
    !input.sanitizationManifest.cutoffAttested
  ) {
    throw new Error(
      "Normalized attempt lacks a successful ATIF sanitization manifest"
    );
  }
  for (const [index, item] of input.items.entries()) {
    const expectedSourceIdentity = normalizedImportSourceIdentity({
      taskDigest: input.taskDigest,
      sourceAttemptId: input.sourceAttemptId,
      atifIdentity: item.atifIdentity,
      sequence: item.sequence
    });
    if (
      item.sequence !== index ||
      item.adapterName !== NORMALIZED_IMPORT_SOURCE_ADAPTER.normalizerAdapter ||
      item.adapterVersion !==
        NORMALIZED_IMPORT_SOURCE_ADAPTER.normalizerAdapterVersion ||
      item.sourceIdentity !== expectedSourceIdentity
    ) {
      throw new Error(
        "Normalized attempt item order or adapter identity is invalid"
      );
    }
  }
  const sanitizationManifestHash = `sha256:${sha256(
    canonicalize(input.sanitizationManifest)
  )}`;
  const externalThreadId = normalizedImportThreadId(
    input.taskDigest,
    input.sourceAttemptId
  );
  const created = await input.client.createSession({
    projectId: input.projectId,
    externalSessionId: externalThreadId,
    sourceRuntime: "codex-cli",
    captureMethod: "api",
    cwd: input.projectCwd,
    idempotencyKey: `normalized-import-session:${externalThreadId}`,
    sourceHash: `sha256:${sha256(`${input.taskDigest}\0${input.sourceAttemptId}`)}`,
    metadata: {
      projectName: `Experience Replay ${input.projectId}`,
      sourceKind: "benchmark_normalized_import"
    }
  });
  if (created.skipped || !created.session?.id) {
    throw new Error(
      "Capture policy did not admit the normalized import session"
    );
  }
  const conversationItemIds: string[] = [];
  const batch = input.items.map((item) =>
    normalizedImportPayload({
      sessionId: created.session!.id,
      externalThreadId,
      projectId: input.projectId,
      taskDigest: input.taskDigest,
      sourceAttemptId: input.sourceAttemptId,
      sanitizationManifestHash,
      item
    })
  );
  const stored = await input.client.createTrustedNormalizedImport({
    attestation: {
      sessionId: created.session.id,
      projectId: input.projectId,
      externalThreadId,
      taskDigest: input.taskDigest,
      sourceAttemptId: input.sourceAttemptId,
      sanitizationManifestHash,
      sequenceStart: 0
    },
    items: batch
  });
  const ids = stored.items?.map((item) => item.id) ?? [];
  if (ids.length !== batch.length) {
    throw new Error("Canonical ingestion did not return every normalized item");
  }
  conversationItemIds.push(...ids);
  const projection: NormalizedProjectionAttestation = {
    rawItemsScanned: 0,
    rawItemsProjected: 0,
    memoryEventsCreated: 0,
    memoryEventIds: [],
    dispositions: [],
    scheduledLcmEventIds: []
  };
  for (let offset = 0; offset < conversationItemIds.length; offset += 1000) {
    const response = await input.client.projectConversationItems({
      conversationItemIds: conversationItemIds.slice(offset, offset + 1000),
      limit: Math.min(1000, conversationItemIds.length - offset)
    });
    const value = response as {
      projection?: {
        rawItemsScanned?: unknown;
        rawItemsProjected?: unknown;
        memoryEventsCreated?: unknown;
        memoryEventIds?: unknown;
        memoryEventScopes?: unknown;
      };
      processing?: { compactions?: unknown };
    };
    const projected = value?.projection;
    const numbers = [
      projected?.rawItemsScanned,
      projected?.rawItemsProjected,
      projected?.memoryEventsCreated
    ];
    if (
      !projected ||
      !numbers.every(
        (number) => Number.isSafeInteger(number) && Number(number) >= 0
      ) ||
      !Array.isArray(projected.memoryEventIds) ||
      !projected.memoryEventIds.every((id) => typeof id === "string") ||
      !Array.isArray(projected.memoryEventScopes)
    ) {
      throw new Error("Projection did not return a structured disposition");
    }
    const dispositions = projected.memoryEventScopes.map((scope) => {
      const candidate = scope as Record<string, unknown>;
      if (
        typeof candidate.eventId !== "string" ||
        candidate.visibility !== "personal" ||
        typeof candidate.includeInEmbedding !== "boolean" ||
        typeof candidate.includeInLcm !== "boolean" ||
        typeof candidate.workClass !== "string"
      ) {
        throw new Error("Projection returned an invalid Memory Event scope");
      }
      return candidate as unknown as NormalizedProjectionDisposition;
    });
    const eventIds = projected.memoryEventIds as string[];
    if (
      eventIds.length !== dispositions.length ||
      eventIds.some((id) => !dispositions.some((scope) => scope.eventId === id))
    ) {
      throw new Error("Projection Memory Event disposition set is not exact");
    }
    const lcmEventIds = dispositions
      .filter((scope) => scope.includeInLcm)
      .map((scope) => scope.eventId);
    if (lcmEventIds.length > 0) {
      const compactions = value.processing?.compactions;
      if (
        !Array.isArray(compactions) ||
        compactions.length < 1 ||
        !compactions.every((job) => {
          const candidate = job as Record<string, unknown>;
          return candidate.queued === true || candidate.inline === true;
        })
      ) {
        throw new Error("Projection did not schedule every eligible LCM job");
      }
      projection.scheduledLcmEventIds.push(...lcmEventIds);
    }
    projection.rawItemsScanned += Number(projected.rawItemsScanned);
    projection.rawItemsProjected += Number(projected.rawItemsProjected);
    projection.memoryEventsCreated += Number(projected.memoryEventsCreated);
    projection.memoryEventIds.push(...eventIds);
    projection.dispositions.push(...dispositions);
  }
  if (projection.rawItemsScanned !== conversationItemIds.length) {
    throw new Error(
      "Projection did not scan every canonical Conversation Item"
    );
  }
  return { sessionId: created.session.id, conversationItemIds, projection };
};
