import { createHash } from "node:crypto";
import pg from "pg";
import {
  createAuditRepository,
  recordAuditEventWithClient
} from "./audit-repository.js";
import { createAuthSessionRepository } from "./auth-session-repository.js";
import { createCapturedSessionRepository } from "./captured-session-repository.js";
import { checkDatabase, createDb } from "./connection.js";
import {
  conversationSemanticChunkPolicyContent,
  conversationSemanticEventMetadata,
  conversationSemanticProjectionGroups,
  conversationSemanticUnitActor,
  conversationSemanticUnitChunks,
  conversationSemanticUnitTypeForActor,
  joinedSemanticContentTokenCount,
  uniqueOrderedStrings,
  type ConversationSemanticProjectionItem,
  type ConversationSemanticUnitType,
  type PendingAgentSemanticBundle,
  type SemanticBundleSealReason
} from "./conversation-semantic-projection.js";
import { createConversationItemRepository } from "./conversation-item-repository.js";
import { createHistoricalImportRepository } from "./historical-import-repository.js";
import { embeddingTableForDimensions } from "./embedding-coverage.js";
import { invalidateDerivedMemoryForMemoryEvents } from "./derived-memory-invalidation.js";
import { createCrossIdentitySyncRepository } from "./cross-identity-sync-repository.js";
import {
  createCuratedMemoryRepository,
  suppressCuratedMemoryWithoutActiveEvidenceWithClient
} from "./curated-memory-repository.js";
import { createDeviceCredentialRepository } from "./device-credential-repository.js";
import {
  createEncryptedPayloadRepository,
  upsertEncryptedFieldPayloadWithClient
} from "./encrypted-payload-repository.js";
import { createExternalAuthRepository } from "./external-auth-repository.js";
import { createLocalEmbeddingStatusRepository } from "./local-embedding-status-repository.js";
import { createMemoryNodeRepository } from "./memory-node-repository.js";
import { createMemoryQuestionRepository } from "./memory-question-repository.js";
import { createSettingsRepository } from "./settings-repository.js";
import { createTeamAccessRepository } from "./team-access-repository.js";
import {
  isGenericDevelopmentActivity,
  presentMemoryText
} from "./presentation.js";
import {
  isRecord,
  looksLikeToolPayloadText,
  truncateDisplayText
} from "./value-helpers.js";
import { createUserApiTokenRepository } from "./user-api-token-repository.js";
import { createWorkflowTokenUsageRepository } from "./workflow-token-usage-repository.js";
import {
  codexIdePromptUserText,
  estimateTokens,
  normalizeStoredLcmSummary,
  resolveTeamWorkspaceAuthorization,
  type LcmSourceItem
} from "@koed/core";
import type {
  CompactionResult,
  ExpandedMemoryNode,
  MemoryActor,
  MemoryEngineRepository,
  MemoryEventRecord,
  MemoryEventType,
  MemorySearchResult,
  RetrievalMetadata
} from "@koed/core";
import {
  combineStorageSanitizationCounts,
  metadataWithStorageSanitization,
  resolveRerankerKeyFromEnv,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig,
  lcmCompactionQueueJobId,
  RAW_CONVERSATION_LOGICAL_ITEM_MAX_BYTES,
  RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT,
  sanitizeForPostgresStorage,
  decryptEnvelopeToUtf8,
  type EncryptedPayloadEnvelope,
  type EnvelopeEncryptionProvider,
  type KoedWorkClass
} from "@koed/shared";

import type {
  CaptureMethod,
  ConversationItemInput,
  ConversationProjectionResult,
  EmbeddableSourceType,
  LcmGraphEvent,
  LcmGraphNode,
  LcmGraphNodeDetail,
  LcmGraphProjectThreads,
  LcmGraphThread,
  LcmNodeForSummarization,
  MemorySourceRepository,
  SemanticMemoryRebuildResult,
  SourceAiClient,
  SourceRuntime,
  TeamSessionShareGrantRecord,
  Visibility,
  ConversationProjectionBacklog
} from "./types.js";

export interface MemorySourceRepositoryOptions {
  envelopeEncryptionProvider?: EnvelopeEncryptionProvider;
  encryptedMemoryQuestionSearchBatchSize?: number;
}

interface LcmNodeForSummarizationRow {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  kind: "leaf" | "rollup";
  depth: number;
  summary_text: string;
  source_items_json: LcmSourceItem[];
  source_token_estimate: number | null;
  summary_token_estimate: number | null;
  summary_model: string | null;
  summary_prompt_version: string | null;
  summary_structured_json: Record<string, unknown> | null;
  summary_structured_schema_version: string | null;
  lcm_algorithm_version: string | null;
}

interface RerankResult {
  model: string;
  scores: number[];
}

type ConversationProjectionRawRow = {
  projection_source_table?:
    | "conversation_items"
    | "conversation_item_observations";
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  session_id: string | null;
  turn_id: string | null;
  source_kind: string;
  source_adapter_version: string;
  source_transport: string;
  external_session_id: string | null;
  external_thread_id: string | null;
  external_turn_id: string | null;
  external_item_id: string | null;
  source_record_type: string;
  source_event_type: string | null;
  source_path: string | null;
  source_sequence: number | null;
  event_time: Date | null;
  observed_at: Date;
  raw_json: unknown;
  raw_text: string | null;
  logical_source_id: string | null;
  transport_chunk_index: number;
  transport_chunk_count: number;
  transport_chunk_text: string | null;
  transport_chunk_encoding: string | null;
  source_hash: string;
  canonical_item_key: string;
  canonical_source_priority?: number;
  projection_policy_revision: number | null;
  idempotency_key: string;
  projection_work_class:
    | "live_capture_projection"
    | "historical_import_backfill";
  metadata: Record<string, unknown> | null;
  session_workspace_id: string | null;
  session_cwd: string | null;
  session_metadata: Record<string, unknown> | null;
  selection_unit_id?: string;
};

type LogicalConversationProjectionItem = {
  row: ConversationProjectionRawRow;
  sourceIds: string[];
  sourceIdentity: string;
  sourceHash: string;
  representativeSourceHash: string;
};

type ConversationProjectionBoundary = {
  visibility: Visibility;
  sessionIdentity: string;
  turnIdentity: string;
  threadIdentity: string;
  workspaceIdentity: string;
  key: string;
  scopeKey: string;
};

type SupportingContextProjectionItem = {
  row: ConversationProjectionRawRow;
  sourceIds: string[];
  content: string;
};

type SupportingContextItem = {
  sourceId: string;
  sourceRole: "supporting_context";
  contextKind: "ide_client_context";
  label: string;
  text: string;
};

const jsonbParam = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

const getStringField = (
  value: Record<string, unknown>,
  key: string
): string | null => {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
};

const mapLcmGraphNode = (row: {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  kind: "leaf" | "rollup";
  depth: number;
  summary_text: string;
  created_at: Date;
  updated_at: Date;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  source_event_count: number | null;
  source_token_estimate: number | null;
  summary_token_estimate: number | null;
  summary_model: string | null;
  summary_prompt_version: string | null;
  summary_structured_json?: Record<string, unknown> | null;
  summary_structured_schema_version?: string | null;
  lcm_algorithm_version: string | null;
  summary_corrected_at?: Date | null;
  summary_corrected_by_user_id?: string | null;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  session_id: string | null;
  thread_id: string | null;
  thread_name: string | null;
  embedding_count: string | number | null;
}): LcmGraphNode => ({
  id: row.id,
  kind: row.kind,
  depth: row.depth,
  summaryText: row.summary_text,
  summaryStatus: row.summary_model ? "summarized" : "pending",
  visibility: row.visibility,
  ownerUserId: row.owner_user_id,
  projectId: row.project_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  sessionId: row.session_id,
  threadId: row.thread_id,
  threadName: row.thread_name,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  invalidatedAt: row.invalidated_at?.toISOString() ?? null,
  invalidationReason: row.invalidation_reason,
  sourceEventCount: row.source_event_count ?? 0,
  sourceTokenEstimate: row.source_token_estimate,
  summaryTokenEstimate: row.summary_token_estimate,
  summaryModel: row.summary_model,
  summaryPromptVersion: row.summary_prompt_version,
  summaryStructuredJson: row.summary_structured_json ?? null,
  summaryStructuredSchemaVersion: row.summary_structured_schema_version ?? null,
  lcmAlgorithmVersion: row.lcm_algorithm_version,
  embeddingCount: Number(row.embedding_count ?? 0),
  summaryCorrectedAt: row.summary_corrected_at?.toISOString() ?? null,
  summaryCorrectedByUserId: row.summary_corrected_by_user_id ?? null
});

const redactLocalProjectMetadata = (
  metadata: Record<string, unknown> | null
): Record<string, unknown> => {
  const redacted = { ...(metadata ?? {}) };
  for (const key of ["cwd", "projectPath", "localProjectId", "projectId"]) {
    delete redacted[key];
  }
  return redacted;
};

const mapLcmGraphEvent = (row: {
  id: string;
  owner_user_id?: string | null;
  actor: string | null;
  event_type: string;
  source_runtime: SourceRuntime | null;
  capture_method: CaptureMethod;
  model: string | null;
  workspace_id: string | null;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  session_id: string | null;
  thread_id: string | null;
  thread_name: string | null;
  source_event_time: Date | null;
  source_sequence: number | string | null;
  captured_at: Date;
  created_at: Date;
  visibility: Visibility;
  invalidated_at: Date | null;
  invalidation_reason: string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  linked_node_ids: string[] | null;
  includeContent?: boolean;
  includeRaw?: boolean;
}): LcmGraphEvent => {
  const content = row.content ?? "";
  const sourceSequence =
    row.source_sequence === null
      ? null
      : typeof row.source_sequence === "number"
        ? row.source_sequence
        : Number.parseInt(row.source_sequence, 10);
  const timestamp = (row.source_event_time ?? row.captured_at).toISOString();
  return {
    id: row.id,
    actor: row.actor,
    eventType: row.event_type,
    sourceRuntime: row.source_runtime,
    captureMethod: row.capture_method,
    model: row.model,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    sessionId: row.session_id,
    threadId: row.thread_id,
    threadName: row.thread_name,
    timestamp,
    sourceEventTime: row.source_event_time?.toISOString() ?? null,
    sourceSequence: Number.isFinite(sourceSequence) ? sourceSequence : null,
    capturedAt: row.captured_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    visibility: row.visibility,
    invalidatedAt: row.invalidated_at?.toISOString() ?? null,
    invalidationReason: row.invalidation_reason,
    contentPreview: truncateDisplayText(content, 220),
    ...(row.includeContent ? { content } : {}),
    ...(row.includeRaw ? { rawContent: content } : {}),
    metadata: row.metadata ?? {},
    linkedNodeIds: row.linked_node_ids ?? []
  };
};

const mapLcmGraphThreadRow = (row: {
  project_id: string;
  project_name: string;
  project_path: string | null;
  project_assignment_source: "detected" | "user_override" | null;
  captured_project_provenance: Record<string, unknown> | null;
  thread_id: string;
  thread_name: string;
  session_id: string | null;
  source_ai_client: SourceAiClient | null;
  event_count: string | number;
  invalidated_count: string | number;
  latest_at: Date;
  sample: string | null;
  thread_kind: "conversation" | "subagent" | null;
  parent_thread_id: string | null;
  parent_session_id: string | null;
}): LcmGraphThread & { projectPath: string | null } => {
  const provenance = {
    project_name: row.project_name,
    project_path: row.project_path
  };
  const presentedName = presentMemoryText(row.thread_name, provenance);
  const name =
    presentedName === "Captured memory." ||
    isGenericDevelopmentActivity(presentedName, provenance)
      ? "Untitled conversation"
      : truncateDisplayText(presentedName, 120);
  const presentedSample = row.sample
    ? presentMemoryText(row.sample, provenance)
    : "";
  const sample =
    presentedSample === "Captured memory."
      ? ""
      : truncateDisplayText(presentedSample, 220);
  return {
    id: row.thread_id,
    name,
    sessionId: row.session_id,
    sourceAiClient: row.source_ai_client,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    projectAssignmentSource: row.project_assignment_source,
    capturedProjectProvenance: row.captured_project_provenance ?? {},
    eventCount: Number(row.event_count),
    invalidatedCount: Number(row.invalidated_count),
    latestAt: row.latest_at.toISOString(),
    sample,
    threadKind: row.thread_kind ?? "conversation",
    parentThreadId: row.parent_thread_id,
    parentSessionId: row.parent_session_id
  };
};

const numberField = (
  value: Record<string, unknown>,
  key: string
): number | null => {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
};

const stringField = (
  value: Record<string, unknown>,
  key: string
): string | null => {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
};

const stringFromNestedField = (
  value: unknown,
  path: string[]
): string | null => {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current : null;
};

const normalizeProjectionText = (value: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const joinProjectionTexts = (values: string[]): string | null =>
  normalizeProjectionText(values.map((value) => value.trim()).join("\n\n"));

const DERIVED_SOURCE_ROLE = "derived_from";
const SUPPORTING_CONTEXT_SOURCE_ROLE = "supporting_context";
const IDE_CLIENT_CONTEXT_KIND = "ide_client_context";

const additionalContextContainer = (
  rawJson: unknown
): Record<string, unknown> | null => {
  const raw = isRecord(rawJson) ? rawJson : null;
  const payload = raw && isRecord(raw.payload) ? raw.payload : raw;
  const params = payload && isRecord(payload.params) ? payload.params : null;
  const item =
    (params && isRecord(params.item) ? params.item : null) ??
    (payload && isRecord(payload.item) ? payload.item : null);
  for (const candidate of [
    params?.additionalContext,
    payload?.additionalContext,
    raw?.additionalContext,
    item?.additionalContext
  ]) {
    if (isRecord(candidate)) {
      return candidate;
    }
  }
  return null;
};

const additionalContextEntryText = (
  key: string,
  value: unknown
): string | null => {
  if (typeof value === "string") {
    return normalizeProjectionText(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  const text = normalizeProjectionText(
    typeof value.value === "string"
      ? value.value
      : typeof value.text === "string"
        ? value.text
        : typeof value.content === "string"
          ? value.content
          : null
  );
  if (!text) {
    return null;
  }
  const kind = stringField(value, "kind");
  const label = [key, kind].filter(Boolean).join(" ");
  return label ? `${label}\n${text}` : text;
};

const additionalContextText = (rawJson: unknown): string | null => {
  const container = additionalContextContainer(rawJson);
  if (!container) {
    return null;
  }
  return joinProjectionTexts(
    Object.entries(container)
      .map(([key, value]) => additionalContextEntryText(key, value))
      .filter((value): value is string => Boolean(value))
  );
};

const metadataMarksIdeClientContext = (
  metadata: Record<string, unknown> | null
): boolean => {
  const contextKind = stringField(metadata ?? {}, "contextKind");
  const sourceRole = stringField(metadata ?? {}, "sourceRole");
  const transcriptType = stringField(metadata ?? {}, "transcriptType");
  return (
    contextKind === IDE_CLIENT_CONTEXT_KIND ||
    sourceRole === SUPPORTING_CONTEXT_SOURCE_ROLE ||
    transcriptType === "ide_context" ||
    transcriptType === "client_context" ||
    transcriptType === "additional_context" ||
    transcriptType === "application_context"
  );
};

const projectionIsIdeClientContext = (row: {
  metadata?: Record<string, unknown> | null;
}): boolean => metadataMarksIdeClientContext(row.metadata ?? null);

const textFromReasoningSummaryValue = (value: unknown): string | null => {
  if (typeof value === "string") {
    return normalizeProjectionText(value);
  }
  if (!isRecord(value)) {
    return null;
  }
  return (
    stringField(value, "text") ??
    stringField(value, "summaryText") ??
    stringField(value, "summary_text") ??
    stringField(value, "message")
  );
};

const reasoningSummaryTextFromItem = (
  item: Record<string, unknown> | null
): string | null => {
  if (!item) {
    return null;
  }
  const summary = item.summary ?? item.summary_text ?? item.summaryText;
  if (Array.isArray(summary)) {
    return joinProjectionTexts(
      summary
        .map(textFromReasoningSummaryValue)
        .filter((value): value is string => Boolean(value))
    );
  }
  return textFromReasoningSummaryValue(summary);
};

const projectionIsRawReasoningLabel = (label: string): boolean =>
  /reasoning[_/ -]?raw|raw[_/ -]?reasoning|raw[_/ -]?content|reasoningTextDelta|ReasoningTextDelta|reasoning[_/ -]?text[_/ -]?delta|ReasoningRawContent|ReasoningRawContentDelta/i.test(
    label
  );

const projectionIsReasoningLabel = (label: string): boolean =>
  /reasoning|thought/i.test(label);

const projectionIsExplicitReasoningSummaryLabel = (label: string): boolean =>
  /reasoning[_/ -]?summary|summary[_/ -]?reasoning|ReasoningSummary|thought[_/ -]?summary|summary[_/ -]?thought/i.test(
    label
  );

const tokenUsageBreakdown = (
  value: unknown
): {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
} | null => {
  if (!isRecord(value)) {
    return null;
  }
  const totalTokens = numberField(value, "totalTokens");
  const inputTokens = numberField(value, "inputTokens");
  const cachedInputTokens = numberField(value, "cachedInputTokens");
  const outputTokens = numberField(value, "outputTokens");
  const reasoningOutputTokens = numberField(value, "reasoningOutputTokens");
  if (
    totalTokens === null &&
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningOutputTokens === null
  ) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
};

const tokenNumberField = (
  value: Record<string, unknown>,
  ...keys: string[]
): number | null => {
  for (const key of keys) {
    const direct = numberField(value, key);
    if (direct !== null) {
      return direct;
    }
  }
  return null;
};

const appServerTokenUsageFromRaw = (
  rawJson: unknown
): {
  modelContextWindow: number | null;
  last: ReturnType<typeof tokenUsageBreakdown>;
  total: ReturnType<typeof tokenUsageBreakdown>;
} | null => {
  if (!isRecord(rawJson)) {
    return null;
  }
  const params = isRecord(rawJson.params) ? rawJson.params : rawJson;
  const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
  if (!tokenUsage) {
    return null;
  }
  return {
    modelContextWindow: numberField(tokenUsage, "modelContextWindow"),
    last: tokenUsageBreakdown(tokenUsage.last),
    total: tokenUsageBreakdown(tokenUsage.total)
  };
};

const compactProjectionValue = (value: unknown, maxLength: number): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return truncateDisplayText(text ?? "", maxLength);
};

const hookToolContent = (
  raw: Record<string, unknown> | null
): string | null => {
  const toolName = raw ? stringField(raw, "tool_name") : null;
  if (!raw || !toolName) {
    return null;
  }
  return joinProjectionTexts([
    `Tool result: ${toolName}`,
    raw.tool_input !== undefined
      ? `Input:\n${compactProjectionValue(raw.tool_input, 800)}`
      : "",
    raw.tool_response !== undefined
      ? `Output:\n${compactProjectionValue(raw.tool_response, 1200)}`
      : ""
  ]);
};

const transcriptTokenUsageFromRaw = (
  rawJson: unknown
): {
  model: string | null;
  modelContextWindow: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
} | null => {
  if (!isRecord(rawJson)) {
    return null;
  }
  const payload = isRecord(rawJson.payload) ? rawJson.payload : rawJson;
  const type =
    stringField(payload, "type") ??
    stringField(rawJson, "type") ??
    stringField(payload, "event") ??
    stringField(rawJson, "event");
  if (!type || !/token[_-]?count/i.test(type)) {
    return null;
  }
  const info = isRecord(payload.info) ? payload.info : null;
  const usage = isRecord(payload.usage)
    ? payload.usage
    : isRecord(payload.token_count)
      ? payload.token_count
      : isRecord(payload.tokenCount)
        ? payload.tokenCount
        : isRecord(payload.info) && isRecord(payload.info.last_token_usage)
          ? payload.info.last_token_usage
          : payload;
  const inputTokens = tokenNumberField(
    usage,
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens"
  );
  const cachedInputTokens = tokenNumberField(
    usage,
    "cachedInputTokens",
    "cached_input_tokens",
    "cachedPromptTokens",
    "cached_prompt_tokens"
  );
  const outputTokens = tokenNumberField(
    usage,
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens"
  );
  const reasoningOutputTokens = tokenNumberField(
    usage,
    "reasoningOutputTokens",
    "reasoning_output_tokens",
    "reasoningTokens",
    "reasoning_tokens"
  );
  const totalTokens =
    tokenNumberField(usage, "totalTokens", "total_tokens", "tokens") ??
    [inputTokens, outputTokens].reduce<number | null>((sum, value) => {
      if (value === null) {
        return sum;
      }
      return (sum ?? 0) + value;
    }, null);
  if (
    inputTokens === null &&
    cachedInputTokens === null &&
    outputTokens === null &&
    reasoningOutputTokens === null &&
    totalTokens === null
  ) {
    return null;
  }
  return {
    model:
      stringField(usage, "model") ??
      stringField(payload, "model") ??
      stringField(rawJson, "model"),
    modelContextWindow:
      tokenNumberField(
        usage,
        "modelContextWindow",
        "model_context_window",
        "contextWindow",
        "context_window"
      ) ??
      tokenNumberField(
        info ?? {},
        "modelContextWindow",
        "model_context_window",
        "contextWindow",
        "context_window"
      ),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
};

const providerTokenUsageIdempotencyKey = (input: {
  sessionId: string | null;
  turnId: string | null;
  scope: "last" | "total";
  occurrenceIdentity: string;
}): string => {
  if (!input.sessionId || !input.turnId) {
    return `token:${input.occurrenceIdentity}:${input.scope}`;
  }
  const occurrenceFingerprint = createHash("sha256")
    .update(input.occurrenceIdentity)
    .digest("hex");
  return `token:provider:${input.sessionId}:${input.turnId}:${input.scope}:${occurrenceFingerprint}`;
};

const conversationItemContent = (row: {
  source_event_type?: string | null;
  source_record_type?: string;
  metadata?: Record<string, unknown> | null;
  raw_text: string | null;
  raw_json: unknown;
}): string | null => {
  const raw = isRecord(row.raw_json) ? row.raw_json : null;
  const payload = raw && isRecord(raw.payload) ? raw.payload : raw;
  const label =
    row.source_event_type !== undefined && row.source_record_type !== undefined
      ? projectionLabelForConversationItem({
          source_event_type: row.source_event_type,
          source_record_type: row.source_record_type,
          metadata: row.metadata ?? null
        })
      : "";
  const params = payload && isRecord(payload.params) ? payload.params : null;
  const item =
    (params && isRecord(params.item) ? params.item : null) ??
    (payload && isRecord(payload.item) ? payload.item : null) ??
    (payload && isRecord(payload) ? payload : null);
  if (projectionIsIdeClientContext(row)) {
    return additionalContextText(row.raw_json) ?? row.raw_text?.trim() ?? null;
  }
  if (row.source_record_type === "hook_payload") {
    const hookTool = hookToolContent(raw);
    if (hookTool) {
      return hookTool;
    }
  }
  if (projectionIsReasoningLabel(label)) {
    if (projectionIsRawReasoningLabel(label)) {
      return null;
    }
    return (
      reasoningSummaryTextFromItem(item) ??
      (projectionIsExplicitReasoningSummaryLabel(label)
        ? row.raw_text?.trim()
        : null) ??
      null
    );
  }
  if (item && /^reasoning$/i.test(stringField(item, "type") ?? "")) {
    return reasoningSummaryTextFromItem(item);
  }
  if (row.raw_text?.trim()) {
    return codexIdePromptUserText(row.raw_text.trim());
  }
  if (!payload) {
    return null;
  }
  const appServerParams = params;
  if (appServerParams) {
    for (const path of [
      ["delta"],
      ["text"],
      ["content"],
      ["message"],
      ["item", "text"],
      ["item", "content"],
      ["item", "message"]
    ]) {
      const value = stringFromNestedField(appServerParams, path);
      if (value) {
        return codexIdePromptUserText(value);
      }
    }
  }
  for (const key of ["message", "text", "content", "delta"]) {
    const value = stringField(payload, key);
    if (value) {
      return codexIdePromptUserText(value);
    }
  }
  const nestedItem = isRecord(payload.item) ? payload.item : null;
  const nestedText = nestedItem ? stringField(nestedItem, "text") : null;
  return nestedText ? codexIdePromptUserText(nestedText) : null;
};

const providerConversationItemFromRaw = (
  rawJson: unknown
): Record<string, unknown> | null => {
  const raw = isRecord(rawJson) ? rawJson : null;
  if (!raw) {
    return null;
  }
  const container = isRecord(raw.payload)
    ? raw.payload
    : isRecord(raw.params)
      ? raw.params
      : raw;
  return isRecord(container.item) ? container.item : container;
};

const providerConversationRoleFromRaw = (rawJson: unknown): string | null => {
  const item = providerConversationItemFromRaw(rawJson);
  return (
    stringField(item ?? {}, "role") ??
    (item && isRecord(item.message) ? stringField(item.message, "role") : null)
  );
};

const actorFromConversationItem = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
  raw_json?: unknown;
}): MemoryActor | null => {
  const metadata = row.metadata ?? {};
  const raw = isRecord(row.raw_json) ? row.raw_json : null;
  const role = providerConversationRoleFromRaw(row.raw_json)?.toLowerCase();
  const transcriptType =
    stringField(metadata, "transcriptType") ??
    row.source_event_type ??
    row.source_record_type;
  if (row.source_record_type === "hook_payload" && raw) {
    if (typeof raw.prompt === "string" && raw.prompt.trim()) {
      return stringField(metadata, "threadKind") === "subagent"
        ? "agent"
        : "user";
    }
    if (
      typeof raw.last_assistant_message === "string" &&
      raw.last_assistant_message.trim()
    ) {
      return stringField(metadata, "threadKind") === "subagent"
        ? "subagent"
        : "agent";
    }
    if (typeof raw.tool_name === "string" && raw.tool_name.trim()) {
      return "tool";
    }
  }
  if (role === "developer" || role === "system") {
    return "system";
  }
  if (role === "user") {
    return stringField(metadata, "threadKind") === "subagent"
      ? "agent"
      : "user";
  }
  if (role === "assistant") {
    return stringField(metadata, "threadKind") === "subagent"
      ? "subagent"
      : "agent";
  }
  if (
    /developer|instruction|rolling[_ -]?context|context[_ -]?summary/i.test(
      transcriptType
    )
  ) {
    return "system";
  }
  if (/user/i.test(transcriptType)) {
    return "user";
  }
  if (/subagent/i.test(transcriptType)) {
    return "subagent";
  }
  if (/agent|assistant|reasoning|thought/i.test(transcriptType)) {
    return "agent";
  }
  if (
    /^(plan|filechange|websearch|imageview|imagegeneration|contextcompaction|subagentactivity)$/i.test(
      transcriptType
    )
  ) {
    return "agent";
  }
  if (/tool|function_call|custom_tool/i.test(transcriptType)) {
    return "tool";
  }
  if (
    /filechange|websearch|imageview|imagegeneration|plan/i.test(transcriptType)
  ) {
    return /plan/i.test(transcriptType) ? "agent" : "tool";
  }
  if (
    /lifecycle|task_|turn[/_-]|token|context|compaction|unknown/i.test(
      transcriptType
    )
  ) {
    return "system";
  }
  if (/system/i.test(transcriptType)) {
    return "system";
  }
  return null;
};

const messageRoleForActor = (
  actor: MemoryActor | null
): "user" | "assistant" | "system" | "tool" | null => {
  if (actor === "user" || actor === "system" || actor === "tool") {
    return actor;
  }
  if (actor === "agent" || actor === "assistant" || actor === "subagent") {
    return "assistant";
  }
  return null;
};

const projectionTranscriptItemIdFor = (row: {
  source_sequence: number | null;
  metadata: Record<string, unknown> | null;
}): string | null => {
  const metadata = row.metadata ?? {};
  const stableItemId = stringField(metadata, "canonicalStableItemId");
  if (stableItemId) {
    return `${stableItemId}:${stringField(metadata, "canonicalConversationItemKind") ?? "item"}`;
  }
  return row.source_sequence === null ? null : String(row.source_sequence);
};

type ConversationProjectionPolicy = {
  createMessage: boolean;
  createToolEvent: boolean;
  createMemoryEvent: boolean;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  policyKey: string | null;
  reason: string;
};

type ConversationProjectionPolicyRule = {
  sourceKind: string;
  sourceAdapterVersion: string;
  transcriptType: string;
  projectToUi: boolean;
  createMessage: boolean;
  createToolEvent: boolean;
  createMemoryEvent: boolean;
  includeInEmbedding: boolean;
  includeInLcm: boolean;
  enabled: boolean;
};

type ConversationProjectionPolicySnapshot = {
  revision: number;
  rules: Map<string, ConversationProjectionPolicyRule>;
};

const projectionPolicyRuleMapKey = (
  sourceKind: string,
  sourceAdapterVersion: string,
  transcriptType: string
): string =>
  JSON.stringify([
    sourceKind,
    sourceAdapterVersion,
    normalizeProjectionRuleKey(transcriptType)
  ]);

type ConversationProjectionCandidate = {
  logicalItem: LogicalConversationProjectionItem;
  row: ConversationProjectionRawRow;
  sourceIds: string[];
  content: string | null;
  actorType: MemoryActor | null;
  messageRole: "user" | "assistant" | "system" | "tool" | null;
  tokenUsage: ReturnType<typeof appServerTokenUsageFromRaw>;
  transcriptTokenUsage: ReturnType<typeof transcriptTokenUsageFromRaw>;
  projectionMetadata: Record<string, unknown>;
  projectionPolicy: ConversationProjectionPolicy;
  turnCompleteSealReason: SemanticBundleSealReason | null;
  boundary: ConversationProjectionBoundary;
  semanticUnitType: ConversationSemanticUnitType | null;
  semanticItem: ConversationSemanticProjectionItem | null;
  disposition: ConversationProjectionDisposition;
  selectionUnitId: string;
};

type ConversationProjectionDisposition =
  | "raw_only"
  | "ready_for_semantic_projection"
  | "waiting_for_agent_seal";

const historicalProjectionAdvisoryLockId = "5279723041804876641";

type AgentSemanticQueueResult =
  | "waiting_for_agent_seal"
  | "projected_by_token_limit";

const projectionLabelForConversationItem = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
}): string => {
  const metadata = row.metadata ?? {};
  return [
    row.source_record_type,
    row.source_event_type,
    stringField(metadata, "transcriptType"),
    stringField(metadata, "transcriptParentType"),
    stringField(metadata, "toolEventKind")
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
};

const normalizeProjectionRuleKey = (value: string | null | undefined): string =>
  value?.trim().toLowerCase() ?? "";

const projectionRuleKeyForConversationItem = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
}): string =>
  normalizeProjectionRuleKey(
    (stringField(row.metadata ?? {}, "workflow")
      ? `workflow:${stringField(row.metadata ?? {}, "workflow")}`
      : null) ??
      stringField(row.metadata ?? {}, "transcriptType") ??
      row.source_event_type ??
      row.source_record_type
  );

const roleDerivedProjectionRuleKeyForConversationItem = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata?: Record<string, unknown> | null;
  raw_json?: unknown;
}): string | null => {
  const item = providerConversationItemFromRaw(row.raw_json);
  const itemType = normalizeProjectionRuleKey(
    (item && stringField(item, "type")) ?? row.source_event_type
  );
  const role = normalizeProjectionRuleKey(
    (item && stringField(item, "role")) ??
      (item && isRecord(item.message)
        ? stringField(item.message, "role")
        : null)
  );
  if (role === "developer") {
    return "developer_message";
  }
  if (role === "system") {
    return "system_message";
  }
  if (role === "assistant") {
    return "assistant_message";
  }
  if (role === "user") {
    if (
      normalizeProjectionRuleKey(row.source_record_type) === "response_item" &&
      !stringField(item ?? {}, "client_id") &&
      !stringField(item ?? {}, "clientId")
    ) {
      return "managed_context_user";
    }
    return "user_message";
  }
  if (itemType !== "message") {
    return null;
  }
  return null;
};

const projectionRuleLookupKeysForConversationItem = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
  raw_json?: unknown;
}): string[] => {
  const primaryKey = projectionRuleKeyForConversationItem(row);
  const roleDerivedKey = roleDerivedProjectionRuleKeyForConversationItem(row);
  return uniqueOrderedStrings(
    [
      roleDerivedKey,
      primaryKey && primaryKey !== "message" ? primaryKey : null,
      primaryKey,
      stringField(row.metadata ?? {}, "workflow")
        ? `workflow:${stringField(row.metadata ?? {}, "workflow")}`
        : null,
      stringField(row.metadata ?? {}, "toolEventKind"),
      row.source_event_type,
      row.source_record_type
    ].map(normalizeProjectionRuleKey)
  ).filter(Boolean);
};

const loadConversationProjectionPolicyRules = async (
  client: pg.Pool | pg.PoolClient
): Promise<ConversationProjectionPolicySnapshot> => {
  const state = await client.query<{ revision: string }>(
    "select revision::text as revision from projection_policy_state where id = 1"
  );
  const rows = await client.query<{
    source_kind: string;
    source_adapter_version: string;
    transcript_type: string;
    project_to_ui: boolean;
    create_message: boolean;
    create_tool_event: boolean;
    create_memory_event: boolean;
    include_in_embedding: boolean;
    include_in_lcm: boolean;
    enabled: boolean;
  }>(
    `
      select
        source_kind,
        source_adapter_version,
        transcript_type,
        project_to_ui,
        create_message,
        create_tool_event,
        create_memory_event,
        include_in_embedding,
        include_in_lcm,
        enabled
      from projection_policy_rules
    `
  );
  return {
    revision: Number(state.rows[0]?.revision ?? 0),
    rules: new Map(
      rows.rows.map((row) => [
        projectionPolicyRuleMapKey(
          row.source_kind,
          row.source_adapter_version,
          row.transcript_type
        ),
        {
          sourceKind: row.source_kind,
          sourceAdapterVersion: row.source_adapter_version,
          transcriptType: row.transcript_type,
          projectToUi: row.project_to_ui,
          createMessage: row.create_message,
          createToolEvent: row.create_tool_event,
          createMemoryEvent: row.create_memory_event,
          includeInEmbedding: row.include_in_embedding,
          includeInLcm: row.include_in_lcm,
          enabled: row.enabled
        }
      ])
    )
  };
};

const classifyConversationItemProjection = (
  row: {
    source_kind: string;
    source_adapter_version: string;
    source_event_type: string | null;
    source_record_type: string;
    external_turn_id: string | null;
    session_metadata: Record<string, unknown> | null;
    metadata: Record<string, unknown> | null;
    raw_json: unknown;
  },
  input: {
    actorType: MemoryActor | null;
    content: string | null;
    projectionRules: Map<string, ConversationProjectionPolicyRule>;
  }
): ConversationProjectionPolicy => {
  const base = {
    createMessage: false,
    createToolEvent: false,
    createMemoryEvent: false,
    includeInEmbedding: false,
    includeInLcm: false,
    policyKey: null,
    reason: "not-projectable"
  };
  if (projectionIsIdeClientContext(row)) {
    return { ...base, reason: "ide-client-supporting-context" };
  }
  if (
    row.session_metadata?.managedConversation === true &&
    !row.external_turn_id
  ) {
    return { ...base, reason: "managed-thread-level-provenance" };
  }
  if (row.source_record_type === "hook_payload") {
    return { ...base, reason: "hook-control-record" };
  }
  const lookupKeys = projectionRuleLookupKeysForConversationItem(row);
  const findRule = (sourceAdapterVersion: string) =>
    lookupKeys
      .map((key) =>
        input.projectionRules.get(
          projectionPolicyRuleMapKey(row.source_kind, sourceAdapterVersion, key)
        )
      )
      .find((rule): rule is ConversationProjectionPolicyRule => Boolean(rule));
  const matchedRule =
    findRule(row.source_adapter_version) ??
    (row.source_kind === "codex" &&
    row.source_adapter_version !== "codex-transcript-v1"
      ? findRule("codex-transcript-v1")
      : undefined);
  if (matchedRule) {
    if (!matchedRule.enabled) {
      return {
        ...base,
        reason: `projection-policy-disabled:${matchedRule.transcriptType}`
      };
    }
    if (!input.content || !input.actorType) {
      return {
        ...base,
        reason: `projection-policy-missing-content-or-actor:${matchedRule.transcriptType}`
      };
    }
    const createMessage = Boolean(
      matchedRule.projectToUi &&
      matchedRule.createMessage &&
      messageRoleForActor(input.actorType)
    );
    const createToolEvent = Boolean(
      matchedRule.projectToUi &&
      matchedRule.createToolEvent &&
      input.actorType === "tool"
    );
    const createMemoryEvent = matchedRule.createMemoryEvent;
    return {
      createMessage,
      createToolEvent,
      createMemoryEvent,
      includeInEmbedding: createMemoryEvent && matchedRule.includeInEmbedding,
      includeInLcm: createMemoryEvent && matchedRule.includeInLcm,
      policyKey: matchedRule.transcriptType,
      reason: createMemoryEvent
        ? `projection-policy:${matchedRule.transcriptType}`
        : `projection-policy-raw-only:${matchedRule.transcriptType}`
    };
  }

  return {
    ...base,
    reason: `projection-policy-missing:${projectionRuleKeyForConversationItem(row) || "unknown"}`
  };
};

const conversationItemTurnCompleteSealReason = (row: {
  source_adapter_version?: string;
  source_event_type: string | null;
  source_record_type: string;
  raw_json: unknown;
  metadata?: Record<string, unknown> | null;
}): SemanticBundleSealReason | null => {
  if (
    (row.source_adapter_version === "codex-app-server-conversation-v1" &&
      row.source_event_type === "turn/completed") ||
    (row.source_adapter_version === "codex-transcript-v1" &&
      ["task_complete", "turn_aborted"].includes(row.source_event_type ?? ""))
  ) {
    return "turn_completed";
  }
  if (row.source_record_type !== "hook_payload") {
    return null;
  }
  if (/^(Stop|SubagentStop)$/i.test(row.source_event_type ?? "")) {
    return "stop_hook";
  }
  const raw = isRecord(row.raw_json) ? row.raw_json : null;
  const hookEventName = stringField(raw ?? {}, "hook_event_name");
  if (/^(Stop|SubagentStop)$/i.test(hookEventName ?? "")) {
    return "stop_hook";
  }
  const metadataHookEventName = stringField(
    row.metadata ?? {},
    "hookEventName"
  );
  return /^(Stop|SubagentStop)$/i.test(metadataHookEventName ?? "")
    ? "stop_hook"
    : null;
};

const projectionMaxTokens = (): number =>
  Math.min(
    Math.max(
      Number.parseInt(process.env.MEMORY_EVENT_MAX_TOKENS ?? "", 10) ||
        DEFAULT_MEMORY_EVENT_MAX_TOKENS,
      1
    ),
    QWEN_OPERATIONAL_MAX_TOKENS
  );

const projectionHardMaxTokens = (): number =>
  Math.min(
    Math.max(
      Number.parseInt(process.env.EMBEDDING_MAX_TOKENS ?? "", 10) ||
        DEFAULT_EMBEDDING_MAX_TOKENS,
      1
    ),
    QWEN_OPERATIONAL_MAX_TOKENS
  );

const projectionAgentTurnStaleMs = (): number =>
  nonNegativeIntEnv(
    "MEMORY_AGENT_TURN_STALE_MS",
    DEFAULT_MEMORY_AGENT_TURN_STALE_MS
  );

const projectionRebuildMaxItems = (): number =>
  Math.min(
    Math.max(
      Number.parseInt(
        process.env.MEMORY_PROJECTION_REBUILD_MAX_ITEMS ?? "",
        10
      ) || 10_000,
      1
    ),
    100_000
  );

const DEFAULT_SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS = 5 * 60 * 1000;

const semanticMemoryRebuildDebounceMs = (): number =>
  nonNegativeIntEnv(
    "SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS",
    DEFAULT_SEMANTIC_MEMORY_REBUILD_DEBOUNCE_MS
  );

const CURRENT_CONVERSATION_PROJECTION_VERSION = "conversation-projection-v3";

const isTransportChunkRow = (row: {
  logical_source_id: string | null;
  transport_chunk_count: number;
  transport_chunk_text: string | null;
}): boolean =>
  Boolean(row.logical_source_id) ||
  row.transport_chunk_count > 1 ||
  row.transport_chunk_text !== null;

const encryptedConversationItemSource = (row: {
  projection_source_table?:
    | "conversation_items"
    | "conversation_item_observations";
  metadata: Record<string, unknown> | null;
  raw_json: unknown;
  raw_text?: string | null;
  transport_chunk_text?: string | null;
  source_path?: string | null;
}): {
  sourceTable: "conversation_items" | "conversation_item_observations";
  columns: Set<string>;
} => {
  const observationColumns =
    row.metadata?.encryptedConversationItemObservationColumns;
  const itemColumns = row.metadata?.encryptedConversationItemColumns;
  const sourceTable = row.projection_source_table ?? "conversation_items";
  const rawColumns =
    sourceTable === "conversation_item_observations"
      ? observationColumns
      : itemColumns;
  const values = Array.isArray(rawColumns)
    ? rawColumns.filter(
        (column): column is string => typeof column === "string"
      )
    : [];
  if (
    isRecord(row.raw_json) &&
    row.raw_json.contentEncrypted === true &&
    row.raw_json.encryptedSourceTable === sourceTable
  ) {
    values.push("raw_json");
  }
  if (
    row.metadata?.contentEncrypted === true &&
    row.metadata.encryptedSourceTable === sourceTable &&
    row.metadata.encryptedSourceColumn === "metadata"
  ) {
    values.push("metadata");
  }
  if (
    row.raw_text === "[koed encrypted conversation item]" ||
    row.raw_text === "[koed encrypted conversation item observation]"
  ) {
    values.push("raw_text");
  }
  if (
    row.transport_chunk_text === "[koed encrypted conversation item]" ||
    row.transport_chunk_text ===
      "[koed encrypted conversation item observation]"
  ) {
    values.push("transport_chunk_text");
  }
  if (
    row.source_path === "[koed encrypted conversation item]" ||
    row.source_path === "[koed encrypted conversation item observation]"
  ) {
    values.push("source_path");
  }
  return { sourceTable, columns: new Set(values) };
};

const decryptConversationItemColumn = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider | undefined,
  row: ConversationProjectionRawRow,
  sourceTable: "conversation_items" | "conversation_item_observations",
  sourceColumn:
    | "raw_json"
    | "raw_text"
    | "transport_chunk_text"
    | "source_path"
    | "metadata"
): Promise<unknown> => {
  const plaintext = await decryptAuthorizedEncryptedFieldPayload(
    pool,
    provider,
    {
      ownerUserId: row.owner_user_id,
      sourceTable,
      sourceId: row.id,
      sourceColumn
    }
  );
  if (plaintext === null) {
    throw new Error(
      `Encrypted conversation item source is missing ${sourceColumn}`
    );
  }
  return plaintext;
};

const hydrateConversationProjectionRow = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider | undefined,
  row: ConversationProjectionRawRow
): Promise<ConversationProjectionRawRow> => {
  const encryptedSource = encryptedConversationItemSource(row);
  const encryptedColumns = encryptedSource.columns;
  if (encryptedColumns.size === 0) {
    return row;
  }
  if (!provider) {
    throw new Error(
      "Envelope encryption provider is required to project encrypted conversation items"
    );
  }
  const rawJson = encryptedColumns.has("raw_json")
    ? await decryptConversationItemColumn(
        pool,
        provider,
        row,
        encryptedSource.sourceTable,
        "raw_json"
      )
    : row.raw_json;
  const rawText = encryptedColumns.has("raw_text")
    ? await decryptConversationItemColumn(
        pool,
        provider,
        row,
        encryptedSource.sourceTable,
        "raw_text"
      )
    : row.raw_text;
  const transportChunkText = encryptedColumns.has("transport_chunk_text")
    ? await decryptConversationItemColumn(
        pool,
        provider,
        row,
        encryptedSource.sourceTable,
        "transport_chunk_text"
      )
    : row.transport_chunk_text;
  const sourcePath = encryptedColumns.has("source_path")
    ? await decryptConversationItemColumn(
        pool,
        provider,
        row,
        encryptedSource.sourceTable,
        "source_path"
      )
    : row.source_path;
  const metadata = encryptedColumns.has("metadata")
    ? await decryptConversationItemColumn(
        pool,
        provider,
        row,
        encryptedSource.sourceTable,
        "metadata"
      )
    : row.metadata;

  return {
    ...row,
    raw_json: rawJson,
    raw_text: typeof rawText === "string" ? rawText : row.raw_text,
    source_path: typeof sourcePath === "string" ? sourcePath : row.source_path,
    metadata: isRecord(metadata) ? metadata : row.metadata,
    transport_chunk_text:
      typeof transportChunkText === "string"
        ? transportChunkText
        : row.transport_chunk_text
  };
};

const decodeTransportChunkEnvelope = (
  text: string,
  encoding: string | null
): {
  rawJson: unknown;
  rawText: string | null;
  metadata?: Record<string, unknown>;
} => {
  const parsed = JSON.parse(text) as unknown;
  if (
    encoding === "conversation-item-json-v1" ||
    encoding === "conversation-item-json-v2"
  ) {
    if (!isRecord(parsed)) {
      throw new Error("Invalid conversation item transport chunk envelope");
    }
    return {
      rawJson: parsed.rawJson,
      rawText: typeof parsed.rawText === "string" ? parsed.rawText : null,
      ...(encoding === "conversation-item-json-v2" && isRecord(parsed.metadata)
        ? { metadata: parsed.metadata }
        : {})
    };
  }
  return { rawJson: parsed, rawText: null };
};

const decodedConversationMetadata = (
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const serverAuthoritative = new Set([
    "managedConversation",
    "projectionPolicyKey",
    "projectionActor",
    "semanticControl",
    "canonicalConversationItemKey",
    "canonicalConversationItemActor",
    "canonicalConversationItemKind",
    "canonicalConversationItemContentHash",
    "canonicalStableItemId",
    "includeInLcm",
    "workspaceId",
    "storageSanitization",
    "koedSanitization",
    "transportChunkGroupId",
    "sourceItemHash",
    "sourceChunkIndex",
    "sourceChunkCount"
  ]);
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      ([key]) => !serverAuthoritative.has(key)
    )
  );
};

const loadLogicalConversationProjectionItem = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider | undefined,
  row: ConversationProjectionRawRow
): Promise<LogicalConversationProjectionItem> => {
  if (!isTransportChunkRow(row)) {
    return {
      row,
      sourceIds: [row.id],
      sourceIdentity:
        stringField(row.metadata ?? {}, "canonicalConversationItemKey") ??
        row.canonical_item_key,
      sourceHash: row.source_hash,
      representativeSourceHash: row.source_hash
    };
  }

  if (!row.logical_source_id) {
    throw new Error("Transport chunk row is missing logical_source_id");
  }
  const transportChunkGroupId = stringField(
    row.metadata ?? {},
    "transportChunkGroupId"
  );
  if (!transportChunkGroupId) {
    throw new Error("Transport chunk row is missing its group identity");
  }
  if (
    row.transport_chunk_count < 1 ||
    row.transport_chunk_count > RAW_CONVERSATION_TRANSPORT_CHUNK_MAX_COUNT
  ) {
    throw new Error("Transport chunk count exceeds the server limit");
  }

  const observationChunks = await pool.query<ConversationProjectionRawRow>(
    `
      select
        'conversation_item_observations'::text as projection_source_table,
        cio.id, cio.owner_user_id, cio.visibility, cio.session_id,
        ci.turn_id, cio.source_kind, cio.source_adapter_version,
        cio.source_transport, cio.external_session_id, cio.external_thread_id,
        cio.external_turn_id, cio.external_item_id, cio.source_record_type,
        cio.source_event_type, cio.source_path, cio.source_sequence,
        cio.event_time, cio.raw_json, cio.raw_text, ci.logical_source_id,
        cio.transport_chunk_index, cio.transport_chunk_count,
        cio.transport_chunk_text, cio.transport_chunk_encoding,
        cio.source_hash, ci.canonical_item_key, ci.canonical_source_priority,
        ci.projection_policy_revision, ci.projection_work_class,
        cio.source_idempotency_key as idempotency_key,
        cio.metadata, cio.observed_at,
        s.workspace_id as session_workspace_id,
        s.cwd as session_cwd,
        s.metadata as session_metadata
      from conversation_item_observations cio
      join conversation_items ci on ci.id = cio.conversation_item_id
      left join sessions s on s.id = cio.session_id
      where cio.conversation_item_id = $1
        and cio.owner_user_id = $2
        and cio.visibility = $3::visibility_scope
        and cio.ingestion_status = 'persisted'
        and cio.transport_chunk_count is not null
        and cio.transport_chunk_count = $4
        and cio.source_kind = $5
        and cio.source_adapter_version = $6
        and cio.source_transport = $7
        and cio.metadata ->> 'transportChunkGroupId' = $8
        and cio.transport_chunk_encoding = $9
      order by cio.transport_chunk_index asc, cio.id asc
    `,
    [
      row.id,
      row.owner_user_id,
      row.visibility,
      row.transport_chunk_count,
      row.source_kind,
      row.source_adapter_version,
      row.source_transport,
      transportChunkGroupId,
      row.transport_chunk_encoding
    ]
  );
  const expectedCount = row.transport_chunk_count;
  const usesObservationChunks =
    expectedCount > 1 && observationChunks.rows.length === expectedCount;
  const parentChunks = usesObservationChunks
    ? null
    : await pool.query<ConversationProjectionRawRow>(
        `
      select
        'conversation_items'::text as projection_source_table,
        ci.id, ci.owner_user_id, ci.visibility, ci.session_id,
        ci.turn_id, ci.source_kind, ci.source_adapter_version,
        ci.source_transport, ci.external_session_id, ci.external_thread_id,
        ci.external_turn_id, ci.external_item_id, ci.source_record_type,
        ci.source_event_type, ci.source_path, ci.source_sequence,
        ci.event_time, ci.raw_json, ci.raw_text, ci.logical_source_id,
        ci.transport_chunk_index, ci.transport_chunk_count,
        ci.transport_chunk_text, ci.transport_chunk_encoding,
        ci.source_hash, ci.canonical_item_key, ci.canonical_source_priority,
        ci.projection_policy_revision, ci.idempotency_key,
        ci.projection_work_class, ci.metadata, ci.observed_at,
        s.workspace_id as session_workspace_id,
        s.cwd as session_cwd,
        s.metadata as session_metadata
      from conversation_items ci
      left join sessions s on s.id = ci.session_id
      where ci.logical_source_id = $1
        and ci.visibility = $2::visibility_scope
        and ci.owner_user_id = $3
        and (
          ($4::text is not null and ci.metadata ->> 'transportChunkGroupId' = $4)
          or ($4::text is null and not (ci.metadata ? 'transportChunkGroupId'))
        )
        and ci.memory_excluded_at is null
      order by ci.transport_chunk_index asc, ci.id asc
    `,
        [
          row.logical_source_id,
          row.visibility,
          row.owner_user_id,
          stringField(row.metadata ?? {}, "transportChunkGroupId")
        ]
      );
  const chunkRows = usesObservationChunks
    ? observationChunks.rows
    : (parentChunks?.rows ?? []);

  const hydratedChunks = await Promise.all(
    chunkRows.map((chunk) =>
      hydrateConversationProjectionRow(pool, provider, chunk)
    )
  );
  if (hydratedChunks.length !== expectedCount) {
    throw new Error(
      `Incomplete transport chunk group: expected ${expectedCount}, found ${hydratedChunks.length}`
    );
  }
  const logicalItemBytes = hydratedChunks.reduce(
    (total, chunk) =>
      total + Buffer.byteLength(chunk.transport_chunk_text ?? "", "utf8"),
    0
  );
  if (logicalItemBytes > RAW_CONVERSATION_LOGICAL_ITEM_MAX_BYTES) {
    throw new Error("Transport chunk group exceeds the logical item limit");
  }

  const seen = new Set<number>();
  for (const chunk of hydratedChunks) {
    if (chunk.transport_chunk_count !== expectedCount) {
      throw new Error("Transport chunk count mismatch");
    }
    if (
      chunk.transport_chunk_index < 0 ||
      chunk.transport_chunk_index >= expectedCount
    ) {
      throw new Error("Transport chunk index out of range");
    }
    if (seen.has(chunk.transport_chunk_index)) {
      throw new Error("Duplicate transport chunk index");
    }
    if (typeof chunk.transport_chunk_text !== "string") {
      throw new Error("Transport chunk text is missing");
    }
    seen.add(chunk.transport_chunk_index);
  }
  for (let index = 0; index < expectedCount; index += 1) {
    if (!seen.has(index)) {
      throw new Error(`Missing transport chunk index ${index}`);
    }
  }

  const sorted = [...hydratedChunks].sort(
    (a, b) => a.transport_chunk_index - b.transport_chunk_index
  );
  const encoding = sorted[0]?.transport_chunk_encoding ?? null;
  const envelope = sorted
    .map((chunk) => chunk.transport_chunk_text ?? "")
    .join("");
  const decoded = decodeTransportChunkEnvelope(envelope, encoding);
  const decodedRawJson = sanitizeForPostgresStorage(decoded.rawJson);
  const decodedRawText = sanitizeForPostgresStorage(decoded.rawText);
  const decodedMetadata = metadataWithStorageSanitization(
    {
      ...(row.metadata ?? {}),
      ...decodedConversationMetadata(decoded.metadata)
    },
    combineStorageSanitizationCounts(decodedRawJson, decodedRawText)
  );
  const representative =
    sorted.find((chunk) => chunk.transport_chunk_index === 0) ?? row;
  const representativeSourceHash = representative.source_hash;
  const sourceItemHash =
    stringField(representative.metadata ?? {}, "sourceItemHash") ??
    row.logical_source_id;

  return {
    row: {
      ...representative,
      ...(usesObservationChunks
        ? {
            id: row.id,
            canonical_item_key: row.canonical_item_key,
            canonical_source_priority: row.canonical_source_priority,
            idempotency_key: row.idempotency_key,
            logical_source_id: row.logical_source_id,
            turn_id: row.turn_id
          }
        : {}),
      raw_json: decodedRawJson.value,
      raw_text: decodedRawText.value as string | null,
      metadata: decodedMetadata,
      source_hash: sourceItemHash
    },
    sourceIds: usesObservationChunks
      ? [row.id]
      : sorted.map((chunk) => chunk.id),
    sourceIdentity: usesObservationChunks
      ? row.canonical_item_key
      : row.logical_source_id,
    sourceHash: sourceItemHash,
    representativeSourceHash
  };
};

const conversationProjectionBoundary = (
  row: ConversationProjectionRawRow
): ConversationProjectionBoundary => {
  const visibility = row.visibility;
  const sessionIdentity =
    row.session_id ?? row.external_session_id ?? "sessionless";
  const turnIdentity = row.turn_id ?? row.external_turn_id ?? "turnless";
  const threadIdentity = row.external_thread_id ?? "threadless";
  const workspaceIdentity = canonicalWorkspaceId({
    metadata: row.metadata,
    sessionId: row.session_id,
    sessionWorkspaceId: row.session_workspace_id,
    sessionCwd: row.session_cwd
  });
  return {
    visibility,
    sessionIdentity,
    turnIdentity,
    threadIdentity,
    workspaceIdentity,
    key: [
      visibility,
      sessionIdentity,
      turnIdentity,
      threadIdentity,
      workspaceIdentity
    ].join(":"),
    scopeKey: [
      visibility,
      sessionIdentity,
      threadIdentity,
      workspaceIdentity
    ].join(":")
  };
};

const conversationSemanticBoundaryKey = (
  item: ConversationSemanticProjectionItem
): string => conversationProjectionBoundary(item.row).key;

const conversationProjectionScopeKey = (
  row: ConversationProjectionRawRow
): string => conversationProjectionBoundary(row).scopeKey;

const conversationItemToolPayload = (
  raw: Record<string, unknown>
): Record<string, unknown> => {
  const params = isRecord(raw.params) ? raw.params : {};
  const item = isRecord(params.item) ? params.item : {};
  return item;
};

const conversationItemToolCallId = (
  metadata: Record<string, unknown>,
  toolCall: Record<string, unknown>
): string | null =>
  stringField(metadata, "toolCallId") ??
  stringField(metadata, "callId") ??
  stringField(toolCall, "id");

const conversationItemToolEventIdentity = (
  row: ConversationProjectionRawRow,
  logicalItem: LogicalConversationProjectionItem,
  callId: string | null
): string => {
  if (row.session_id && callId) {
    return `tool-call:${row.session_id}:${callId}`;
  }
  return logicalItem.sourceIdentity;
};

const conversationItemToolName = (
  raw: Record<string, unknown>,
  metadata: Record<string, unknown>,
  toolCall: Record<string, unknown>,
  linkedToolName?: string | null
): string =>
  stringField(metadata, "toolName") ??
  stringField(toolCall, "name") ??
  stringField(toolCall, "title") ??
  linkedToolName ??
  stringField(conversationItemToolPayload(raw), "name") ??
  stringField(conversationItemToolPayload(raw), "title") ??
  stringField(raw, "tool_name") ??
  stringField(raw, "name") ??
  stringField(raw, "method") ??
  "tool";

const loadLinkedToolNameForCallId = async (
  pool: pg.Pool,
  row: ConversationProjectionRawRow,
  callId: string | null
): Promise<string | null> => {
  if (!callId || !row.session_id) {
    return null;
  }
  const result = await pool.query<{ tool_name: string | null }>(
    `
      select metadata ->> 'toolName' as tool_name
      from conversation_items
      where session_id = $1
        and owner_user_id = $2
        and metadata #>> '{toolCall,id}' = $3
        and metadata ->> 'toolName' is not null
      order by observed_at asc, source_sequence asc nulls last, id asc
      limit 1
    `,
    [row.session_id, row.owner_user_id, callId]
  );
  return result.rows[0]?.tool_name ?? null;
};

const conversationItemToolInput = (
  raw: Record<string, unknown>,
  toolCall: Record<string, unknown>
): unknown => {
  if (toolCall.kind === "output") {
    return undefined;
  }
  if (toolCall.input !== undefined) {
    return toolCall.input;
  }
  const item = conversationItemToolPayload(raw);
  if (item.arguments !== undefined) {
    return item.arguments;
  }
  if (item.input !== undefined) {
    return item.input;
  }
  if (raw.arguments !== undefined) {
    return raw.arguments;
  }
  if (raw.input !== undefined) {
    return raw.input;
  }
  if (raw.tool_input !== undefined) {
    return raw.tool_input;
  }
  return raw.toolInput;
};

const conversationItemToolResponse = (
  raw: Record<string, unknown>,
  toolCall: Record<string, unknown>,
  content: string | null,
  options: { allowContentFallback?: boolean } = {}
): unknown => {
  if (toolCall.kind === "call") {
    return undefined;
  }
  if (toolCall.output !== undefined) {
    return toolCall.output;
  }
  const item = conversationItemToolPayload(raw);
  if (item.output !== undefined) {
    return item.output;
  }
  if (item.result !== undefined) {
    return item.result;
  }
  if (item.content !== undefined) {
    return item.content;
  }
  if (raw.tool_response !== undefined) {
    return raw.tool_response;
  }
  return (
    raw.result ??
    raw.toolResponse ??
    (options.allowContentFallback === false ? undefined : content)
  );
};

const localEmbeddingServiceUrl = (): string | null =>
  (
    process.env.EMBEDDING_SERVICE_URL ?? "http://embedding-service:8000"
  ).trim() || null;

type EmbeddingRequestPriority = "interactive" | "background";

const embeddingServiceHeaders = (
  priority: EmbeddingRequestPriority = "interactive"
): Record<string, string> => {
  const token = process.env.EMBEDDING_SERVICE_TOKEN?.trim();
  return {
    ...(token ? { "x-koed-embedding-token": token } : {}),
    "x-koed-embedding-priority": priority
  };
};

const localEmbeddingModel = (): string =>
  resolveSupportedEmbeddingModelConfig(process.env.EMBEDDING_MODEL).key;

const localEmbeddingDimensions = (): number =>
  resolveSupportedEmbeddingModelConfig(process.env.EMBEDDING_MODEL).dimensions;

const localEmbeddingVersion = (): string =>
  resolveSupportedEmbeddingModelConfig(process.env.EMBEDDING_MODEL).key;

export const localRerankingEnabled = (
  environment: NodeJS.ProcessEnv = process.env
): boolean =>
  resolveSupportedRerankerModelConfig(
    resolveRerankerKeyFromEnv(environment)
  ) !== null;

const rerankingEnabled = (): boolean => localRerankingEnabled();

const sourceHash = (
  sourceType: EmbeddableSourceType,
  sourceId: string,
  text: string
): string =>
  createHash("sha256")
    .update(`${sourceType}:${sourceId}:${text}`)
    .digest("hex");

const vectorLiteral = (vector: number[]): string => `[${vector.join(",")}]`;

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const booleanEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
};

const optionalBooleanEnv = (name: string): boolean | null => {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return null;
};

const deploymentProfile = (): string =>
  process.env.KOED_DEPLOYMENT_PROFILE?.trim().toLowerCase() ?? "";

const plaintextLexicalSearchEnabled = (): boolean => {
  const explicit = optionalBooleanEnv(
    "MEMORY_PLAINTEXT_LEXICAL_SEARCH_ENABLED"
  );
  if (explicit !== null) {
    return explicit;
  }
  return !["koed_managed_cloud", "koed-managed-cloud", "cloud"].includes(
    deploymentProfile()
  );
};

const managedCloudPlaintextMemoryPayloadsDisabled = (): boolean => {
  const profile = deploymentProfile();
  const releaseStage =
    process.env.KOED_MANAGED_CLOUD_RELEASE_STAGE?.trim().toLowerCase() ?? "";
  if (
    [
      "koed_managed_cloud",
      "koed-managed-cloud",
      "cloud",
      "team_self_hosted",
      "team-self-hosted",
      "private_vps",
      "private-vps"
    ].includes(profile)
  ) {
    return true;
  }
  return (
    ["koed_managed_cloud", "koed-managed-cloud", "cloud"].includes(profile) &&
    ["paid", "production"].includes(releaseStage)
  );
};

const ENCRYPTED_MESSAGE_CONTENT = "[koed encrypted message]";
const ENCRYPTED_MEMORY_NODE_TEXT = "[koed encrypted memory node]";
const ENCRYPTED_MEMORY_EVENT_TEXT = "[koed encrypted memory event]";
const ENCRYPTED_EMBEDDING_SOURCE_TEXT = "[koed encrypted embedding source]";

const encryptedDisplayPayloadMarker = (
  sourceTable: "messages" | "tool_events"
): Record<string, unknown> => ({
  contentEncrypted: true,
  encryptedSourceTable: sourceTable
});

const isEncryptedDisplayPayloadMarker = (
  value: unknown,
  sourceTable: "messages" | "tool_events"
): boolean =>
  isRecord(value) &&
  value.contentEncrypted === true &&
  value.encryptedSourceTable === sourceTable;

const encryptedMemoryNodeJsonMarker = (): Record<string, unknown> => ({
  contentEncrypted: true,
  encryptedSourceTable: "memory_nodes"
});

const isEncryptedMemoryNodeJsonMarker = (value: unknown): boolean =>
  isRecord(value) &&
  value.contentEncrypted === true &&
  value.encryptedSourceTable === "memory_nodes";

const compactJson = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
};

const formatToolEventContent = (
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown
): string =>
  [
    `Tool call: ${toolName}`,
    toolInput === null || toolInput === undefined
      ? null
      : `Input:\n${compactJson(toolInput)}`,
    toolResponse === null || toolResponse === undefined
      ? null
      : `Output:\n${compactJson(toolResponse)}`
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n\n");

type MemoryEventPayload = MemoryEventRecord["metadata"] & {
  actor?: MemoryActor;
  content?: string;
  contentEncrypted?: boolean;
  metadata?: Record<string, unknown>;
  rawEventType?: string;
  workspaceId?: string;
};

const redactMemoryEventPayloadForPlaintextStorage = (
  payload: MemoryEventPayload
): MemoryEventPayload => {
  const metadata = payload.metadata ?? {};
  const redacted: MemoryEventPayload = {
    actor: payload.actor,
    rawEventType: payload.rawEventType,
    contentEncrypted: true,
    metadata: {
      projectionVersion: metadata.projectionVersion,
      semanticUnitType: metadata.semanticUnitType,
      semanticSourceActors: metadata.semanticSourceActors,
      semanticBundleSealedReason: metadata.semanticBundleSealedReason,
      includeInEmbedding: metadata.includeInEmbedding,
      includeInLcm: metadata.includeInLcm,
      tokenCount: metadata.tokenCount,
      tokenModel: metadata.tokenModel,
      sourceAdapterVersion: metadata.sourceAdapterVersion,
      sourceChunkIndex: metadata.sourceChunkIndex,
      sourceChunkCount: metadata.sourceChunkCount,
      sourceItemCount: metadata.sourceItemCount,
      rawConversationItemId: metadata.rawConversationItemId,
      rawConversationItemIds: metadata.rawConversationItemIds,
      logicalSourceId: metadata.logicalSourceId,
      logicalSourceIds: metadata.logicalSourceIds,
      semanticItemManifest: metadata.semanticItemManifest,
      externalSessionId: metadata.externalSessionId,
      externalThreadId: metadata.externalThreadId,
      externalTurnId: metadata.externalTurnId
    }
  };
  return redacted;
};

const memoryEventEmbeddingContent = (
  payload: MemoryEventPayload | null | undefined
): string | null => {
  if (!payload) {
    return null;
  }
  const metadata = payload.metadata ?? {};
  if (metadata.includeInEmbedding === false) {
    return null;
  }
  const embeddingContent = metadata.embeddingContent;
  if (typeof embeddingContent === "string" && embeddingContent.trim()) {
    return embeddingContent;
  }
  return typeof payload.content === "string" && payload.content.trim()
    ? payload.content
    : null;
};

const memoryEventLcmContent = (
  payload: MemoryEventPayload | null | undefined
): string | null => {
  if (!payload) {
    return null;
  }
  const metadata = payload.metadata ?? {};
  if (metadata.includeInLcm === false) {
    return null;
  }
  const lcmContent = metadata.lcmContent;
  if (typeof lcmContent === "string" && lcmContent.trim()) {
    return lcmContent;
  }
  return typeof payload.content === "string" && payload.content.trim()
    ? payload.content
    : null;
};

type EncryptedFieldPayloadLookupRow = {
  plaintext_content_type: string;
  envelope_version: number;
  provider_mode: EncryptedPayloadEnvelope["providerMode"];
  key_id: string;
  key_version: number;
  scope: EncryptedPayloadEnvelope["scope"];
  provenance: EncryptedPayloadEnvelope["provenance"];
  algorithm: EncryptedPayloadEnvelope["algorithm"];
  ciphertext: string;
  nonce: string;
  tag: string;
  wrapped_dek: EncryptedPayloadEnvelope["wrappedDek"];
  ciphertext_location: string;
  aad: EncryptedPayloadEnvelope["aad"];
  envelope_created_at: Date;
  envelope_reencrypted_at: Date | null;
};

const encryptedEnvelopeFromLookupRow = (
  row: EncryptedFieldPayloadLookupRow
): EncryptedPayloadEnvelope => ({
  version: row.envelope_version as EncryptedPayloadEnvelope["version"],
  providerMode: row.provider_mode,
  keyId: row.key_id,
  keyVersion: row.key_version,
  scope: row.scope,
  provenance: row.provenance,
  algorithm: row.algorithm,
  ciphertext: row.ciphertext,
  nonce: row.nonce,
  tag: row.tag,
  wrappedDek: row.wrapped_dek,
  ciphertextLocation: row.ciphertext_location,
  aad: row.aad,
  createdAt: row.envelope_created_at.toISOString(),
  reencryptedAt: row.envelope_reencrypted_at?.toISOString() ?? null
});

const decryptAuthorizedEncryptedFieldPayload = async (
  pool: pg.Pool | pg.PoolClient,
  provider: EnvelopeEncryptionProvider | undefined,
  input: {
    ownerUserId: string | null;
    sourceTable: string;
    sourceId: string;
    sourceColumn: string;
  }
): Promise<unknown | null> => {
  if (!provider || !input.ownerUserId) {
    return null;
  }
  const encrypted = await pool.query<EncryptedFieldPayloadLookupRow>(
    `
      select
        plaintext_content_type,
        envelope_version,
        provider_mode,
        key_id,
        key_version,
        scope,
        provenance,
        algorithm,
        ciphertext,
        nonce,
        tag,
        wrapped_dek,
        ciphertext_location,
        aad,
        envelope_created_at,
        envelope_reencrypted_at
      from encrypted_field_payloads
      where owner_user_id = $1
        and source_table = $2
        and source_id = $3
        and source_column = $4
        and invalidated_at is null
      limit 1
    `,
    [input.ownerUserId, input.sourceTable, input.sourceId, input.sourceColumn]
  );
  const row = encrypted.rows[0];
  if (!row) {
    return null;
  }
  const plaintext = await decryptEnvelopeToUtf8(
    provider,
    encryptedEnvelopeFromLookupRow(row)
  );
  if (row.plaintext_content_type === "application/json") {
    return JSON.parse(plaintext) as unknown;
  }
  return plaintext;
};

type HydratableMemoryNodeRow = {
  id: string;
  owner_user_id: string | null;
  summary_text?: string;
  body_text?: string | null;
  source_items_json?: unknown;
  summary_structured_json?: unknown;
};

const encryptedMemoryNodeColumns = (
  row: HydratableMemoryNodeRow
): Set<
  "summary_text" | "body_text" | "source_items_json" | "summary_structured_json"
> => {
  const columns = new Set<
    | "summary_text"
    | "body_text"
    | "source_items_json"
    | "summary_structured_json"
  >();
  if (row.summary_text === ENCRYPTED_MEMORY_NODE_TEXT) {
    columns.add("summary_text");
  }
  if (row.body_text === ENCRYPTED_MEMORY_NODE_TEXT) {
    columns.add("body_text");
  }
  if (isEncryptedMemoryNodeJsonMarker(row.source_items_json)) {
    columns.add("source_items_json");
  }
  if (isEncryptedMemoryNodeJsonMarker(row.summary_structured_json)) {
    columns.add("summary_structured_json");
  }
  return columns;
};

const hydrateMemoryNodeRow = async <T extends HydratableMemoryNodeRow>(
  pool: pg.Pool | pg.PoolClient,
  provider: EnvelopeEncryptionProvider | undefined,
  row: T
): Promise<T> => {
  const columns = encryptedMemoryNodeColumns(row);
  if (columns.size === 0) {
    return row;
  }
  if (!provider) {
    throw new Error(
      "Envelope encryption provider is required to expand encrypted Memory Nodes"
    );
  }

  const hydrated: HydratableMemoryNodeRow = { ...row };
  for (const column of columns) {
    const plaintext = await decryptAuthorizedEncryptedFieldPayload(
      pool,
      provider,
      {
        ownerUserId: row.owner_user_id,
        sourceTable: "memory_nodes",
        sourceId: row.id,
        sourceColumn: column
      }
    );
    if (plaintext === null) {
      throw new Error(`Encrypted Memory Node source is missing ${column}`);
    }
    if (column === "summary_text" || column === "body_text") {
      if (typeof plaintext !== "string") {
        throw new Error(`Encrypted Memory Node ${column} is invalid`);
      }
      hydrated[column] = plaintext;
    } else {
      hydrated[column] = plaintext;
    }
  }
  return hydrated as T;
};

const hydrateMemoryNodeRows = async <T extends HydratableMemoryNodeRow>(
  pool: pg.Pool | pg.PoolClient,
  provider: EnvelopeEncryptionProvider | undefined,
  rows: T[]
): Promise<T[]> => {
  const hydrated: T[] = [];
  for (const row of rows) {
    hydrated.push(await hydrateMemoryNodeRow(pool, provider, row));
  }
  return hydrated;
};

const persistEncryptedMemoryNodeField = async (
  client: pg.Pool | pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    ownerUserId: string;
    visibility: Visibility;
    nodeId: string;
    sourceColumn:
      | "summary_text"
      | "body_text"
      | "source_items_json"
      | "summary_structured_json";
    plaintext: unknown;
  }
): Promise<void> => {
  await upsertEncryptedFieldPayloadWithClient(
    client,
    { userId: input.ownerUserId },
    provider,
    {
      sourceTable: "memory_nodes",
      sourceId: input.nodeId,
      sourceColumn: input.sourceColumn,
      plaintext: input.plaintext,
      visibility: input.visibility,
      rowFamily: "memory_node",
      scope: {
        tenantId: input.ownerUserId,
        objectClass: "memory_node"
      },
      aad: {
        nodeId: input.nodeId
      }
    }
  );
};

const persistEncryptedMemoryNodeFields = async (
  client: pg.Pool | pg.PoolClient,
  provider: EnvelopeEncryptionProvider,
  input: {
    ownerUserId: string;
    visibility: Visibility;
    nodeId: string;
    summaryText?: string;
    bodyText?: string | null;
    sourceItems?: unknown;
    summaryStructuredJson?: unknown;
  }
): Promise<void> => {
  if (input.summaryText !== undefined) {
    await persistEncryptedMemoryNodeField(client, provider, {
      ownerUserId: input.ownerUserId,
      visibility: input.visibility,
      nodeId: input.nodeId,
      sourceColumn: "summary_text",
      plaintext: input.summaryText
    });
  }
  if (input.bodyText !== undefined && input.bodyText !== null) {
    await persistEncryptedMemoryNodeField(client, provider, {
      ownerUserId: input.ownerUserId,
      visibility: input.visibility,
      nodeId: input.nodeId,
      sourceColumn: "body_text",
      plaintext: input.bodyText
    });
  }
  if (input.sourceItems !== undefined) {
    await persistEncryptedMemoryNodeField(client, provider, {
      ownerUserId: input.ownerUserId,
      visibility: input.visibility,
      nodeId: input.nodeId,
      sourceColumn: "source_items_json",
      plaintext: input.sourceItems
    });
  }
  if (
    input.summaryStructuredJson !== undefined &&
    input.summaryStructuredJson !== null
  ) {
    await persistEncryptedMemoryNodeField(client, provider, {
      ownerUserId: input.ownerUserId,
      visibility: input.visibility,
      nodeId: input.nodeId,
      sourceColumn: "summary_structured_json",
      plaintext: input.summaryStructuredJson
    });
  }
};

const decryptAuthorizedMemoryEventPayload = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider | undefined,
  input: {
    ownerUserId: string | null;
    memoryEventId: string;
  }
): Promise<MemoryEventPayload | null> => {
  const parsed = await decryptAuthorizedEncryptedFieldPayload(pool, provider, {
    ownerUserId: input.ownerUserId,
    sourceTable: "memory_events",
    sourceId: input.memoryEventId,
    sourceColumn: "payload"
  });
  return isRecord(parsed) ? (parsed as MemoryEventPayload) : null;
};

const nonNegativeFloatEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const DEFAULT_EMBEDDING_QUERY_INSTRUCTION =
  "Given a question about captured AI-client memory, retrieve relevant memory events, conversation items, and summaries that answer the question.";

const embeddingQueryInstruction = (): string =>
  process.env.EMBEDDING_QUERY_INSTRUCTION?.trim() ||
  DEFAULT_EMBEDDING_QUERY_INSTRUCTION;

const embeddingQueryInstructionEnabled = (): boolean =>
  localEmbeddingVersion().startsWith("qwen3-") &&
  booleanEnv("EMBEDDING_QUERY_INSTRUCTION_ENABLED", true);

const formatEmbeddingQuery = (query: string): string =>
  embeddingQueryInstructionEnabled()
    ? `Instruct: ${embeddingQueryInstruction()}\nQuery: ${query}`
    : query;

const DEFAULT_MEMORY_EVENT_MAX_TOKENS = 2_048;
const DEFAULT_EMBEDDING_MAX_TOKENS = 4_096;
const DEFAULT_MEMORY_AGENT_TURN_STALE_MS = 15 * 60_000;
const QWEN_OPERATIONAL_MAX_TOKENS = 32_768;

const positiveIntEnvCapped = (
  name: string,
  fallback: number,
  max: number
): number => Math.min(positiveIntEnv(name, fallback), max);

const vectorCandidateLimit = (resultLimit: number): number =>
  Math.max(resultLimit, positiveIntEnv("MEMORY_VECTOR_CANDIDATE_LIMIT", 20));

const prepareRerankDocument = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const nonNegativeIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const lcmLeafEventThreshold = (): number =>
  positiveIntEnv("MEMORY_LCM_LEAF_EVENT_THRESHOLD", 100);

const lcmLeafTokenThreshold = (): number =>
  positiveIntEnvCapped(
    "MEMORY_LCM_LEAF_TOKEN_THRESHOLD",
    QWEN_OPERATIONAL_MAX_TOKENS,
    QWEN_OPERATIONAL_MAX_TOKENS
  );

const lcmFreshEventTail = (): number =>
  nonNegativeIntEnv("MEMORY_LCM_FRESH_EVENT_TAIL", 10);

const lcmCompactionMaxEvents = (): number =>
  positiveIntEnvCapped("MEMORY_LCM_COMPACTION_MAX_EVENTS", 1_000, 10_000);

const lcmDepthOneFanout = (): number =>
  positiveIntEnv("MEMORY_LCM_DEPTH1_FANOUT", 20);

const lcmSummaryModel = (): string =>
  process.env.MEMORY_LCM_SUMMARY_MODEL ?? "gpt-5.4-mini";

const normalizeForLcmSummary = (text: string): string =>
  text.replace(/\s+/g, " ").trim();

const lcmSourceItemsText = (items: LcmSourceItem[]): string =>
  items
    .map((item) => {
      const anchor =
        item.kind === "lcm_child"
          ? `child:${item.nodeId ?? "unknown"}`
          : `${item.sourceTable ?? "source"}:${item.sourceId ?? "unknown"}`;
      const turn = item.turnId ? ` turn:${item.turnId}` : "";
      const actor = item.actor ? ` ${item.actor}` : "";
      return `- [${item.kind} ${anchor}${turn}]${actor}: ${normalizeForLcmSummary(
        item.text ?? ""
      )}`;
    })
    .join("\n");

const leafSummaryText = (items: LcmSourceItem[]): string =>
  [
    "LCM depth 0 leaf summary",
    `Source items: ${items.length}`,
    "",
    "Exact ordered source outline:",
    lcmSourceItemsText(items)
  ].join("\n");

const rollupSummaryText = (
  children: Array<{ id: string; depth: number; summary_text: string }>
): string =>
  [
    "LCM depth 1 rollup summary",
    `Source LCM nodes: ${children.length}`,
    "",
    "Child summaries:",
    ...children.map(
      (child, index) =>
        `- [${index + 1}. node:${child.id} depth:${child.depth}] ${normalizeForLcmSummary(
          child.summary_text
        )}`
    )
  ].join("\n");

const sourceItemsTokenEstimate = (
  items: LcmSourceItem[],
  model = lcmSummaryModel()
): number =>
  items.reduce(
    (sum, item) => sum + estimateTokens(item.text ?? "", { model }),
    0
  );

const lcmSessionKeyForEvent = (event: {
  id: string;
  session_id: string | null;
}): string => event.session_id ?? "sessionless";

const lcmSourcePayloadForEvent = (event: {
  id: string;
  session_id: string | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> => {
  const payload = { ...event.payload };
  delete payload.content;
  return {
    ...payload,
    lcmSessionKey: lcmSessionKeyForEvent(event),
    sessionId: event.session_id
  };
};

const lcmSessionKeyForSourceItem = (item: LcmSourceItem): string | null => {
  const payload =
    item.payload && typeof item.payload === "object"
      ? (item.payload as { lcmSessionKey?: unknown })
      : null;
  return typeof payload?.lcmSessionKey === "string"
    ? payload.lcmSessionKey
    : null;
};

const normalizeSessionTitle = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 120) : null;
};

const deriveProvisionalSessionTitle = (
  actor: MemoryActor,
  content: string,
  metadata: Record<string, unknown> | undefined
): string | null => {
  if (actor !== "user") {
    return null;
  }
  const presented = presentMemoryText(content, {
    project_name: getStringField(metadata ?? {}, "projectName"),
    project_path: getStringField(metadata ?? {}, "projectPath")
  });
  if (
    !presented ||
    presented === "Captured memory." ||
    /^Development activity captured in\b/.test(presented)
  ) {
    return null;
  }
  const cleaned = presented
    .replace(
      /<environment_context\b[^>]*>[\s\S]*?<\/environment_context>/gi,
      " "
    )
    .replace(/<image\b[\s\S]*?<\/image>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:can|could|would)\s+you\s+(?:please\s+)?/i, "")
    .replace(/^please\s+/i, "")
    .replace(/^help\s+(?:me|us)\s+/i, "")
    .trim();
  if (cleaned.length < 8 || looksLikeToolPayloadText(cleaned)) {
    return null;
  }
  const firstClause =
    cleaned.match(/^(.{12,90}?)(?:[.!?\n]|$)/)?.[1]?.trim() ?? cleaned;
  return normalizeSessionTitle(firstClause);
};

const applyProvisionalCapturedSessionTitle = async (
  pool: pg.Pool,
  input: {
    ownerUserId: string;
    sessionId: string | null;
    actor: MemoryActor;
    content: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  if (!input.sessionId) {
    return;
  }
  const title = deriveProvisionalSessionTitle(
    input.actor,
    input.content,
    input.metadata
  );
  if (!title) {
    return;
  }
  await pool.query(
    `
      update sessions
      set
        metadata = metadata || jsonb_build_object(
          'threadName', $3::text,
          'threadNameSource', 'provisional',
          'threadNameGeneratedAt', now()
        ),
        updated_at = now()
      where id = $2
        and owner_user_id = $1
        and visibility = 'personal'
        and invalidated_at is null
        and coalesce(metadata ->> 'threadNameSource', '') <> 'manual'
        and (
          metadata ->> 'threadName' is null
          or btrim(metadata ->> 'threadName') = ''
          or metadata ->> 'threadName' = coalesce(external_session_id, '')
          or metadata ->> 'threadName' = id::text
        )
    `,
    [input.ownerUserId, input.sessionId, title]
  );
};

const lcmSourceItemSessionId = (item: LcmSourceItem): string | null => {
  const payload =
    item.payload && typeof item.payload === "object"
      ? (item.payload as { sessionId?: unknown })
      : null;
  return typeof payload?.sessionId === "string" && payload.sessionId
    ? payload.sessionId
    : null;
};

const singleSessionIdForLcmTitle = (
  kind: "leaf" | "rollup",
  sourceItems: LcmSourceItem[]
): string | null => {
  if (kind !== "leaf") {
    return null;
  }
  const sessionIds = new Set(
    sourceItems
      .map(lcmSourceItemSessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId))
  );
  return sessionIds.size === 1 ? [...sessionIds][0]! : null;
};

const lcmSessionKeyForNodeRow = (row: {
  id: string;
  source_items_json: LcmSourceItem[];
}): string => {
  const sourceItems = Array.isArray(row.source_items_json)
    ? row.source_items_json
    : [];
  const keys = new Set(
    sourceItems
      .map((item) => lcmSessionKeyForSourceItem(item))
      .filter((key): key is string => Boolean(key))
  );
  return keys.size === 1 ? [...keys][0]! : `node:${row.id}`;
};

const groupByLcmSessionKey = <
  T extends { id: string; session_id: string | null }
>(
  rows: T[]
): T[][] => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = lcmSessionKeyForEvent(row);
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return [...groups.values()];
};

const defaultRetrievalMetadata = (
  overrides: Partial<RetrievalMetadata> = {}
): RetrievalMetadata => ({
  retrievalMode: "embedding_unavailable",
  vectorHitsCount: 0,
  textHitsCount: 0,
  embeddingModel: null,
  embeddingDimensions: null,
  ...overrides
});

type TeamWorkspaceReadBoundary = {
  teamWorkspaceId: string;
  teamId: string;
} | null;

type TeamSessionShareGrantRow = {
  id: string;
  owner_user_id: string | null;
  session_id: string | null;
  team_id: string;
  team_workspace_id: string;
  granted_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  revoked_at: Date | string | null;
  revoked_by_user_id: string | null;
  revocation_reason: string | null;
  personal_deleted_at: Date | string | null;
  personal_deleted_by_user_id: string | null;
  personal_deletion_reason: string | null;
  retained_by_team_at: Date | string | null;
  retention_reason: string;
};

const isoTimestamp = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const nullableIsoTimestamp = (value: Date | string | null): string | null =>
  value ? isoTimestamp(value) : null;

const mapTeamSessionShareGrant = (
  row: TeamSessionShareGrantRow
): TeamSessionShareGrantRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  sessionId: row.session_id,
  teamId: row.team_id,
  teamWorkspaceId: row.team_workspace_id,
  grantedByUserId: row.granted_by_user_id,
  createdAt: isoTimestamp(row.created_at),
  updatedAt: isoTimestamp(row.updated_at),
  revokedAt: nullableIsoTimestamp(row.revoked_at),
  revokedByUserId: row.revoked_by_user_id,
  revocationReason: row.revocation_reason,
  personalDeletedAt: nullableIsoTimestamp(row.personal_deleted_at),
  personalDeletedByUserId: row.personal_deleted_by_user_id,
  personalDeletionReason: row.personal_deletion_reason,
  retainedByTeamAt: nullableIsoTimestamp(row.retained_by_team_at),
  retentionReason: row.retention_reason
});

const emptySearchResult = (
  overrides: Partial<RetrievalMetadata> = {}
): {
  results: MemorySearchResult[];
  metadata: RetrievalMetadata;
} => ({
  results: [],
  metadata: defaultRetrievalMetadata(overrides)
});

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const canonicalWorkspaceId = (input: {
  metadata?: Record<string, unknown> | null;
  sessionId?: string | null;
  sessionWorkspaceId?: string | null;
  sessionCwd?: string | null;
  fallback?: string;
}): string => {
  const explicit = stringField(input.metadata ?? {}, "workspaceId");
  if (
    explicit &&
    !(input.sessionId && explicit === input.sessionId) &&
    !(explicit === "conversation-projection" && input.sessionCwd)
  ) {
    return explicit;
  }
  if (input.sessionWorkspaceId) {
    return input.sessionWorkspaceId;
  }
  if (input.sessionCwd) {
    return input.sessionCwd;
  }
  return input.fallback ?? "conversation-projection";
};

const canonicalProjectMetadata = (input: {
  metadata?: Record<string, unknown> | null;
  sessionMetadata?: Record<string, unknown> | null;
  sessionId?: string | null;
  sessionWorkspaceId?: string | null;
  sessionCwd?: string | null;
}): Record<string, unknown> => {
  const sessionMetadata = input.sessionMetadata ?? {};
  const metadata = input.metadata ?? {};
  const workspaceId = canonicalWorkspaceId(input);
  const projectName =
    stringField(metadata, "projectName") ??
    stringField(sessionMetadata, "projectName") ??
    input.sessionWorkspaceId ??
    input.sessionCwd;
  const projectPath =
    stringField(metadata, "projectPath") ??
    stringField(sessionMetadata, "projectPath") ??
    input.sessionCwd;
  return {
    ...sessionMetadata,
    ...metadata,
    workspaceId,
    ...(projectName ? { projectName } : {}),
    ...(projectPath ? { projectPath } : {})
  };
};

const rawConversationItemIdsFromMetadata = (
  metadata: Record<string, unknown> | undefined
): string[] => {
  const values = [
    metadata?.rawConversationItemId,
    metadata?.rawConversationItemIds
  ];
  const ids = new Set<string>();
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : value ? [value] : [];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && uuidPattern.test(candidate)) {
        ids.add(candidate);
      }
    }
  }
  return [...ids];
};

const linkMemoryEventSources = async (
  pool: pg.Pool,
  memoryEventId: string,
  conversationItemIds: string[],
  sourceRole = DERIVED_SOURCE_ROLE,
  sourceOrderOffset = 0
): Promise<void> => {
  for (let index = 0; index < conversationItemIds.length; index += 1) {
    await pool.query(
      `
        insert into memory_event_sources (
          memory_event_id,
          conversation_item_id,
          source_order,
          source_role
        )
        select $1, ci.id, $3, $4
        from conversation_items ci
        join memory_events me on me.id = $1
        where ci.id = $2
          and ci.visibility = me.visibility
          and ci.owner_user_id = me.owner_user_id
        on conflict do nothing
      `,
      [
        memoryEventId,
        conversationItemIds[index],
        sourceOrderOffset + index,
        sourceRole
      ]
    );
  }
};

const scheduleSemanticMemoryRebuilds = async (
  pool: pg.Pool,
  input: {
    ownerUserId: string;
    memoryEventIds: string[];
  }
): Promise<void> => {
  const memoryEventIds = uniqueOrderedStrings(input.memoryEventIds);
  if (memoryEventIds.length === 0) {
    return;
  }
  const debounceMs = semanticMemoryRebuildDebounceMs();
  await pool.query(
    `
      with requested as (
        select
          me.id as memory_event_id,
          me.owner_user_id,
          me.visibility,
          now() + ($3::int * interval '1 millisecond') as scheduled_after
        from memory_events me
        where me.id = any($2::uuid[])
          and me.visibility = 'personal'
          and me.owner_user_id = $1
      ),
      updated as (
        update semantic_memory_rebuild_jobs job
        set
          scheduled_after = greatest(job.scheduled_after, requested.scheduled_after),
          status = case
            when job.status = 'processing' then job.status
            else 'pending'
          end,
          processing_started_at = case
            when job.status = 'processing' then job.processing_started_at
            else null
          end,
          processing_lease_until = case
            when job.status = 'processing' then job.processing_lease_until
            else null
          end,
          last_error_message = null,
          updated_at = now()
        from requested
        where job.memory_event_id = requested.memory_event_id
          and job.status in ('pending', 'processing')
        returning job.memory_event_id
      )
      insert into semantic_memory_rebuild_jobs (
        owner_user_id,
        visibility,
        memory_event_id,
        scheduled_after
      )
      select
        requested.owner_user_id,
        requested.visibility,
        requested.memory_event_id,
        requested.scheduled_after
      from requested
      where not exists (
        select 1
        from updated
        where updated.memory_event_id = requested.memory_event_id
      )
        and not exists (
          select 1
          from semantic_memory_rebuild_jobs existing
          where existing.memory_event_id = requested.memory_event_id
            and existing.status in ('pending', 'processing')
        )
    `,
    [input.ownerUserId, memoryEventIds, debounceMs]
  );
};

const sourceMemoryEventType = (row: {
  event_type: MemoryEventType;
  payload: { rawEventType?: string };
}): ConversationSemanticUnitType | null => {
  const rawEventType = row.payload.rawEventType;
  if (rawEventType === "user_turn" || rawEventType === "agent_turn") {
    return rawEventType;
  }
  return null;
};

const rebuiltSemanticMemoryEventsFromSources = async (
  pool: pg.Pool,
  provider: EnvelopeEncryptionProvider | undefined,
  input: {
    actorUserId: string;
    memoryEventId: string;
    createMemoryEvent(
      actor: { userId: string },
      input: Parameters<MemoryEngineRepository["createMemoryEvent"]>[1]
    ): Promise<MemoryEventRecord>;
  }
): Promise<
  Array<{
    eventId: string;
    visibility: Visibility;
    includeInEmbedding: boolean;
    includeInLcm: boolean;
  }>
> => {
  const sourceEvent = await pool.query<{
    id: string;
    owner_user_id: string | null;
    visibility: Visibility;
    event_type: MemoryEventType;
    session_id: string | null;
    turn_id: string | null;
    seal_reason: string | null;
    payload: {
      actor?: MemoryActor;
      metadata?: Record<string, unknown>;
      rawEventType?: string;
      workspaceId?: string;
    };
  }>(
    `
      select
        id, owner_user_id, visibility, event_type, session_id, turn_id,
        seal_reason, payload
      from memory_events
      where id = $2
        and visibility = 'personal'
        and owner_user_id = $1
      limit 1
    `,
    [input.actorUserId, input.memoryEventId]
  );
  const oldEvent = sourceEvent.rows[0];
  if (!oldEvent) {
    return [];
  }
  const unitType = sourceMemoryEventType(oldEvent);
  if (!unitType) {
    return [];
  }

  const sourceRows = await pool.query<ConversationProjectionRawRow>(
    `
      with ordered_sources as (
        select
          mes.source_order,
          'conversation_items'::text as projection_source_table,
          ci.id, ci.owner_user_id, ci.visibility, ci.session_id,
          ci.turn_id, ci.source_kind, ci.source_adapter_version,
          ci.source_transport, ci.external_session_id, ci.external_thread_id,
          ci.external_turn_id, ci.external_item_id, ci.source_record_type,
          ci.source_event_type, ci.source_path, ci.source_sequence,
          ci.event_time, ci.raw_json, ci.raw_text, ci.logical_source_id,
          ci.transport_chunk_index, ci.transport_chunk_count,
          ci.transport_chunk_text, ci.transport_chunk_encoding,
          ci.source_hash, ci.canonical_item_key, ci.canonical_source_priority,
          ci.projection_policy_revision, ci.idempotency_key,
          ci.projection_work_class, ci.metadata, ci.observed_at,
          s.workspace_id as session_workspace_id,
          s.cwd as session_cwd,
          s.metadata as session_metadata,
          row_number() over (partition by ci.id order by mes.source_order asc) as source_rank
        from memory_event_sources mes
        join conversation_items ci on ci.id = mes.conversation_item_id
        left join sessions s on s.id = ci.session_id
        where mes.memory_event_id = $2
          and mes.source_role = $3
          and ci.visibility = 'personal'
          and ci.owner_user_id = $1
          and ci.memory_excluded_at is null
      )
      select
        projection_source_table,
        id, owner_user_id, visibility, session_id, turn_id, source_kind,
        source_adapter_version, source_transport, external_session_id,
        external_thread_id, external_turn_id, external_item_id,
        source_record_type, source_event_type, source_path, source_sequence,
        event_time, raw_json, raw_text, logical_source_id,
        transport_chunk_index, transport_chunk_count, transport_chunk_text,
        transport_chunk_encoding, source_hash, canonical_item_key,
        canonical_source_priority, projection_policy_revision,
        idempotency_key, projection_work_class, metadata,
        observed_at, session_workspace_id, session_cwd, session_metadata
      from ordered_sources
      where source_rank = 1
      order by source_order asc, source_sequence asc nulls last, observed_at asc, id asc
    `,
    [input.actorUserId, input.memoryEventId, DERIVED_SOURCE_ROLE]
  );

  const processedSourceIdentities = new Set<string>();
  const semanticItems: ConversationSemanticProjectionItem[] = [];
  const projectionPolicySnapshot =
    await loadConversationProjectionPolicyRules(pool);
  const projectionRules = projectionPolicySnapshot.rules;
  for (const sourceRow of sourceRows.rows) {
    const hydratedSourceRow = await hydrateConversationProjectionRow(
      pool,
      provider,
      sourceRow
    );
    const logicalItem = await loadLogicalConversationProjectionItem(
      pool,
      provider,
      hydratedSourceRow
    );
    if (processedSourceIdentities.has(logicalItem.sourceIdentity)) {
      continue;
    }
    processedSourceIdentities.add(logicalItem.sourceIdentity);
    const row = logicalItem.row;
    const content = conversationItemContent(row);
    const actorType = actorFromConversationItem(row);
    const projectionPolicy = classifyConversationItemProjection(row, {
      actorType,
      content,
      projectionRules
    });
    if (!content || !actorType || !projectionPolicy.createMemoryEvent) {
      continue;
    }
    const itemUnitType = conversationSemanticUnitTypeForActor(actorType);
    if (itemUnitType !== unitType) {
      continue;
    }
    semanticItems.push({
      row,
      sourceIds: logicalItem.sourceIds,
      sourceIdentity: logicalItem.sourceIdentity,
      sourceHash: logicalItem.sourceHash,
      actorType,
      content,
      includeInEmbedding: projectionPolicy.includeInEmbedding,
      includeInLcm: projectionPolicy.includeInLcm,
      projectionPolicyKey: projectionPolicy.policyKey,
      projectionPolicyRevision: projectionPolicySnapshot.revision,
      projectionMetadata: canonicalProjectMetadata({
        metadata: row.metadata,
        sessionMetadata: row.session_metadata,
        sessionId: row.session_id,
        sessionWorkspaceId: row.session_workspace_id,
        sessionCwd: row.session_cwd
      })
    });
  }

  if (semanticItems.length === 0) {
    return [];
  }

  const first = semanticItems[0]!;
  const model = stringField(first.row.metadata ?? {}, "model");
  const chunks = conversationSemanticUnitChunks(semanticItems, {
    model,
    maxTokens: projectionMaxTokens(),
    hardMaxTokens: projectionHardMaxTokens()
  });
  const sourceCapturedAt =
    semanticItems
      .map((item) => item.row.event_time ?? item.row.observed_at)
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? undefined;
  const sourceActors = uniqueOrderedStrings(
    semanticItems.map((item) => item.actorType)
  );
  const unitActor = conversationSemanticUnitActor(unitType, sourceActors);
  const allSourceIds = uniqueOrderedStrings(
    semanticItems.flatMap((item) => item.sourceIds)
  );
  const includeInLcmBySourceIdentity = new Map(
    semanticItems.map((item) => [item.sourceIdentity, item.includeInLcm])
  );
  const supportingSources = await pool.query<{ id: string }>(
    `
      select distinct ci.id
      from memory_event_sources mes
      join conversation_items ci on ci.id = mes.conversation_item_id
      where mes.memory_event_id = $2
        and mes.source_role = $3
        and ci.visibility = 'personal'
        and ci.owner_user_id = $1
        and ci.memory_excluded_at is null
      order by ci.id asc
    `,
    [input.actorUserId, input.memoryEventId, SUPPORTING_CONTEXT_SOURCE_ROLE]
  );
  const supportingSourceIds = supportingSources.rows.map((row) => row.id);
  const created: Array<{
    eventId: string;
    visibility: Visibility;
    includeInEmbedding: boolean;
    includeInLcm: boolean;
  }> = [];
  const originalMetadata = oldEvent.payload.metadata ?? {};
  const originalSealReason =
    oldEvent.seal_reason ??
    stringField(originalMetadata, "semanticBundleSealedReason") ??
    "source_event_rebuild";

  for (const chunk of chunks) {
    const embeddingContent = conversationSemanticChunkPolicyContent(
      chunk,
      "includeInEmbedding"
    );
    const lcmContent = conversationSemanticChunkPolicyContent(
      chunk,
      "includeInLcm"
    );
    const includeInEmbedding = embeddingContent.trim().length > 0;
    const includeInLcm = chunk.sourceIdentities.some(
      (sourceIdentity) =>
        includeInLcmBySourceIdentity.get(sourceIdentity) === true
    );
    const unitHash = createHash("sha256")
      .update(
        JSON.stringify({
          projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
          rebuiltFromMemoryEventId: input.memoryEventId,
          unitType,
          sourceIdentities: chunk.sourceIdentities,
          chunkIndex: chunk.chunkIndex
        })
      )
      .digest("hex");
    const contentHash = createHash("sha256")
      .update(
        JSON.stringify({
          projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
          rebuiltFromMemoryEventId: input.memoryEventId,
          unitType,
          sourceHashes: chunk.sourceHashes,
          content: chunk.content,
          embeddingContent,
          lcmContent,
          includeInEmbedding,
          includeInLcm,
          chunkIndex: chunk.chunkIndex
        })
      )
      .digest("hex");
    const event = await input.createMemoryEvent(
      { userId: input.actorUserId },
      {
        workspaceId: canonicalWorkspaceId({
          metadata: first.row.metadata,
          sessionId: first.row.session_id,
          sessionWorkspaceId: first.row.session_workspace_id,
          sessionCwd: first.row.session_cwd
        }),
        sessionId: first.row.session_id ?? undefined,
        turnId: first.row.turn_id ?? undefined,
        actor: unitActor,
        eventType: "captured",
        rawEventType: unitType,
        content: chunk.content,
        metadata: {
          ...conversationSemanticEventMetadata({
            first,
            chunk,
            allSourceIds,
            sourceActors,
            unitType,
            sealedReason: originalSealReason,
            includeInEmbedding,
            includeInLcm,
            embeddingContent,
            lcmContent,
            projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
            model,
            rebuild: {
              reason: "source_event_deleted",
              memoryEventId: input.memoryEventId
            }
          }),
          projectionPolicyKey: first.projectionPolicyKey,
          projectionPolicyRevision: first.projectionPolicyRevision
        },
        visibility: first.row.visibility,
        sourceRuntime:
          first.row.source_kind === "codex-cli" ? "codex-cli" : "codex",
        captureMethod: captureMethodForConversationItem({
          sourceTransport: first.row.source_transport
        }),
        codexTranscriptPath: first.row.source_path ?? undefined,
        idempotencyKey: `projection:rebuild:${unitType}:${unitHash}`,
        sourceHash: `projection:rebuild:${unitType}:${contentHash}`,
        capturedAt: sourceCapturedAt?.toISOString(),
        sourceEventTime: chunk.sourceEventTime?.toISOString(),
        sourceSequence: chunk.sourceSequence ?? undefined,
        tokenModel: model ?? undefined,
        sealReason: originalSealReason
      }
    );
    created.push({
      eventId: event.id,
      visibility: first.row.visibility,
      includeInEmbedding,
      includeInLcm
    });
    if (supportingSourceIds.length > 0) {
      await linkMemoryEventSources(
        pool,
        event.id,
        supportingSourceIds,
        SUPPORTING_CONTEXT_SOURCE_ROLE,
        chunk.sourceIds.length
      );
    }
  }

  return created;
};

const invalidateSemanticMemoryForDisplayEvent = async (
  pool: pg.Pool,
  input: {
    actorUserId: string;
    eventId: string;
    sourceTable: "messages" | "tool_events";
  }
): Promise<{
  affectedMemoryEventIds: string[];
  excludedConversationItemIds: string[];
}> => {
  const sourcePrefix = input.sourceTable === "messages" ? "message" : "tool";
  const excluded = await pool.query<{ id: string }>(
    `
      with display_source as (
        select
          owner_user_id,
          visibility,
          session_id,
          idempotency_key,
          source_hash,
          transcript_item_id
        from ${input.sourceTable}
        where id = $1
          and visibility = 'personal'
          and owner_user_id = $2
        limit 1
      ),
      matched_raw_sources as (
        select distinct ci.id
        from display_source ds
        join conversation_items ci
          on ci.visibility = ds.visibility
          and ci.owner_user_id = ds.owner_user_id
        where (
          ds.idempotency_key = $3 || ':' || coalesce(ci.logical_source_id, ci.id::text)
          or ds.source_hash = $3 || ':' || coalesce(ci.logical_source_id, ci.source_hash)
          or (
            ds.session_id is not distinct from ci.session_id
            and ds.transcript_item_id is not null
            and ci.source_sequence is not null
            and ds.transcript_item_id = ci.source_sequence::text
          )
          or (
            $3 = 'tool'
            and ds.session_id is not null
            and ci.session_id = ds.session_id
            and (
              ds.idempotency_key = concat(
                'tool:tool-call:',
                ds.session_id::text,
                ':',
                coalesce(
                  ci.metadata ->> 'toolCallId',
                  ci.metadata ->> 'callId',
                  ci.metadata #>> '{toolCall,id}'
                )
              )
              or ds.source_hash = concat(
                'tool:tool-call:',
                ds.session_id::text,
                ':',
                coalesce(
                  ci.metadata ->> 'toolCallId',
                  ci.metadata ->> 'callId',
                  ci.metadata #>> '{toolCall,id}'
                )
              )
            )
          )
        )
      ),
      raw_sources as (
        select distinct ci.id
        from conversation_items ci
        join matched_raw_sources matched
          on matched.id = ci.id
          or (
            ci.logical_source_id is not null
            and ci.logical_source_id = (
              select source.logical_source_id
              from conversation_items source
              where source.id = matched.id
            )
          )
        where ci.visibility = 'personal'
          and ci.owner_user_id = $2
      )
      update conversation_items ci
      set
        memory_excluded_at = coalesce(ci.memory_excluded_at, now()),
        memory_exclusion_reason = coalesce(ci.memory_exclusion_reason, 'source_event_deleted'),
        memory_excluded_by_user_id = coalesce(ci.memory_excluded_by_user_id, $2::uuid)
      from raw_sources rs
      where ci.id = rs.id
      returning ci.id
    `,
    [input.eventId, input.actorUserId, sourcePrefix]
  );
  const excludedIds = excluded.rows.map((row) => row.id);
  const affected = await pool.query<{ id: string }>(
    `
      with affected_memory_events as (
        select distinct mes.memory_event_id as id
        from memory_event_sources mes
        join memory_events me on me.id = mes.memory_event_id
        where mes.conversation_item_id = any($1::uuid[])
          and me.visibility = 'personal'
          and me.owner_user_id = $2
          and me.invalidated_at is null and me.personal_deleted_at is null
      )
      update memory_events me
      set
        invalidated_at = coalesce(me.invalidated_at, now()),
        invalidation_reason = coalesce(me.invalidation_reason, 'source_event_deleted')
      from affected_memory_events affected
      where me.id = affected.id
      returning me.id
    `,
    [excludedIds, input.actorUserId]
  );
  const affectedIds = affected.rows.map((row) => row.id);
  await invalidateDerivedMemoryForMemoryEvents(pool, affectedIds);
  await scheduleSemanticMemoryRebuilds(pool, {
    ownerUserId: input.actorUserId,
    memoryEventIds: affectedIds
  });
  return {
    affectedMemoryEventIds: affectedIds,
    excludedConversationItemIds: excludedIds
  };
};

const captureMethodForConversationItem = (
  item: Pick<ConversationItemInput, "sourceTransport">
): CaptureMethod => {
  if (item.sourceTransport === "hook") {
    return "hook";
  }
  if (item.sourceTransport === "mcp") {
    return "mcp";
  }
  if (item.sourceTransport === "web") {
    return "web";
  }
  return "api";
};

const embedTexts = async (
  texts: string[]
): Promise<{ model: string; dimensions: number; vectors: number[][] }> => {
  const baseUrl = localEmbeddingServiceUrl();
  if (!baseUrl) {
    throw new Error("EMBEDDING_SERVICE_URL is not configured");
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...embeddingServiceHeaders()
    },
    body: JSON.stringify({ texts })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    model?: string;
    dimensions?: number;
    vectors?: number[][];
    detail?: string;
  };

  if (!response.ok) {
    throw new Error(
      payload.detail ?? `embedding service failed with ${response.status}`
    );
  }
  if (
    !payload.model ||
    !payload.dimensions ||
    !Array.isArray(payload.vectors)
  ) {
    throw new Error("embedding service returned an invalid response");
  }
  return {
    model: payload.model,
    dimensions: payload.dimensions,
    vectors: payload.vectors
  };
};

const embedQueryTexts = (
  texts: string[]
): Promise<{ model: string; dimensions: number; vectors: number[][] }> =>
  embedTexts(texts.map(formatEmbeddingQuery));

const rerankTexts = async (
  query: string,
  documents: string[]
): Promise<RerankResult> => {
  const baseUrl = localEmbeddingServiceUrl();
  if (!baseUrl) {
    throw new Error("EMBEDDING_SERVICE_URL is not configured");
  }

  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/rerank`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...embeddingServiceHeaders()
    },
    body: JSON.stringify({ query, documents })
  });
  const payload = (await response.json().catch(() => ({}))) as {
    model?: string;
    scores?: number[];
    detail?: string;
  };

  if (!response.ok) {
    throw new Error(
      payload.detail ?? `reranking service failed with ${response.status}`
    );
  }
  if (!payload.model || !Array.isArray(payload.scores)) {
    throw new Error("reranking service returned an invalid response");
  }
  const scores = payload.scores.map(Number);
  if (
    scores.length !== documents.length ||
    scores.some((score) => !Number.isFinite(score))
  ) {
    throw new Error("reranking service returned invalid scores");
  }
  return {
    model: payload.model,
    scores
  };
};

const mapMemoryEvent = (row: {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  event_type: MemoryEventType;
  session_id: string | null;
  turn_id: string | null;
  payload: {
    actor?: MemoryActor;
    content?: string;
    metadata?: Record<string, unknown>;
    rawEventType?: string;
    workspaceId?: string;
  };
  token_count?: number | null;
  seal_reason?: string | null;
  created_at: Date;
}): MemoryEventRecord => ({
  id: row.id,
  workspaceId: row.payload.workspaceId ?? "",
  sessionId: row.session_id,
  turnId: row.turn_id,
  actor: row.payload.actor ?? "system",
  eventType: row.payload.rawEventType ?? row.event_type,
  content: row.payload.content ?? "",
  metadata: row.payload.metadata ?? {},
  tokenCount: row.token_count ?? null,
  sealReason: row.seal_reason ?? null,
  visibility: row.visibility,
  ownerUserId: row.owner_user_id,
  createdAt: row.created_at.toISOString()
});

const mapLcmNodeForSummarization = async (
  pool: pg.Pool | pg.PoolClient,
  row: LcmNodeForSummarizationRow,
  provider: EnvelopeEncryptionProvider | undefined
): Promise<LcmNodeForSummarization> => {
  const hydratedRow = await hydrateMemoryNodeRow(pool, provider, row);
  let sourceItems = Array.isArray(hydratedRow.source_items_json)
    ? hydratedRow.source_items_json
    : [];

  if (
    hydratedRow.kind === "rollup" &&
    sourceItems.some((item) => item.kind === "lcm_child")
  ) {
    const children = await pool.query<{
      id: string;
      owner_user_id: string | null;
      depth: number;
      summary_text: string;
      summary_structured_json: Record<string, unknown> | null;
      summary_structured_schema_version: string | null;
    }>(
      `
        select
          child.id,
          child.owner_user_id,
          child.depth,
          child.summary_text,
          child.summary_structured_json,
          child.summary_structured_schema_version
        from memory_node_children mnc
        join memory_nodes child on child.id = mnc.child_memory_node_id
        where mnc.parent_memory_node_id = $1
          and child.invalidated_at is null and child.personal_deleted_at is null
        order by mnc.child_order asc
      `,
      [hydratedRow.id]
    );
    const hydratedChildren = await hydrateMemoryNodeRows(
      pool,
      provider,
      children.rows
    );
    const childSummaries = new Map(
      hydratedChildren.map((child) => {
        const structured = normalizeStoredLcmSummary({
          summaryText: child.summary_text,
          structuredSummary: child.summary_structured_json
        });
        return [
          child.id,
          {
            depth: child.depth,
            summaryText: JSON.stringify(structured)
          }
        ] as const;
      })
    );

    sourceItems = sourceItems.map((item) => {
      if (item.kind !== "lcm_child" || !item.nodeId) {
        return item;
      }
      const child = childSummaries.get(item.nodeId);
      if (!child) {
        return item;
      }
      return {
        ...item,
        text: child.summaryText,
        payload: {
          ...(typeof item.payload === "object" &&
          item.payload !== null &&
          !Array.isArray(item.payload)
            ? item.payload
            : {}),
          depth: child.depth
        }
      };
    });
  }

  return {
    id: hydratedRow.id,
    ownerUserId: hydratedRow.owner_user_id,
    visibility: hydratedRow.visibility,
    kind: hydratedRow.kind,
    depth: hydratedRow.depth,
    summaryText: hydratedRow.summary_text,
    sourceItems,
    sourceTokenEstimate: hydratedRow.source_token_estimate,
    summaryTokenEstimate: hydratedRow.summary_token_estimate,
    summaryModel: hydratedRow.summary_model,
    summaryPromptVersion: hydratedRow.summary_prompt_version,
    summaryStructuredJson: hydratedRow.summary_structured_json,
    summaryStructuredSchemaVersion:
      hydratedRow.summary_structured_schema_version,
    lcmAlgorithmVersion: hydratedRow.lcm_algorithm_version
  };
};

export const createMemorySourceRepository = (
  pool: pg.Pool,
  options: MemorySourceRepositoryOptions = {}
): MemorySourceRepository => {
  const db = createDb(pool);
  const encryptedPayloadRepository = createEncryptedPayloadRepository(pool);
  const settingsRepository = createSettingsRepository(db);
  const curatedMemoryRepository = createCuratedMemoryRepository(pool, {
    envelopeEncryptionProvider: options.envelopeEncryptionProvider
  });

  return {
    // Drizzle fragments cover table-shaped account, auth session, audit, and settings workflows.
    // Dense graph, vector, retrieval, and LCM paths stay raw SQL in this module.
    ...createUserApiTokenRepository(db),
    ...settingsRepository,
    ...createAuthSessionRepository(db),
    ...createDeviceCredentialRepository(db),
    ...createExternalAuthRepository(db),
    ...createAuditRepository(db),
    ...createTeamAccessRepository(db),
    ...createCapturedSessionRepository(pool),
    ...createConversationItemRepository(pool, {
      envelopeEncryptionProvider: options.envelopeEncryptionProvider,
      resolveCapturePolicy: settingsRepository.getEffectiveCapturePolicy
    }),
    ...createHistoricalImportRepository(pool),
    ...createCrossIdentitySyncRepository(pool, {
      envelopeEncryptionProvider: options.envelopeEncryptionProvider
    }),
    ...curatedMemoryRepository,
    ...encryptedPayloadRepository,
    ...createLocalEmbeddingStatusRepository(),
    ...createMemoryNodeRepository(pool, {
      envelopeEncryptionProvider: options.envelopeEncryptionProvider,
      onSourceLifecycleChanged: async (client, actor) => {
        await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
          client,
          actor,
          options.envelopeEncryptionProvider
        );
      }
    }),
    ...createMemoryQuestionRepository(pool, {
      envelopeEncryptionProvider: options.envelopeEncryptionProvider,
      encryptedMemoryQuestionSearchBatchSize:
        options.encryptedMemoryQuestionSearchBatchSize
    }),
    ...createWorkflowTokenUsageRepository(pool),

    health: () => checkDatabase(pool),

    async createTeamSessionShareGrant(actor, input) {
      const access = await this.getTeamWorkspaceAccess(
        actor,
        input.teamWorkspaceId
      );
      if (!access?.canCreateShare) {
        return null;
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        const sessionRows = await client.query<{
          id: string;
          owner_user_id: string;
        }>(
          `
          select id, owner_user_id
          from sessions
          where id = $1
            and owner_user_id = $2
            and visibility = 'personal'
            and invalidated_at is null
            and personal_deleted_at is null
            and not exists (
              select 1
              from memory_replicas sync_replica
              where sync_replica.local_session_id = sessions.id
                and sync_replica.replica_role = 'target'
                and not exists (
                  select 1
                  from cross_identity_sync_relationships sync_relationship
                  where sync_relationship.local_replica_id = sync_replica.id
                    and sync_relationship.side = 'target'
                    and sync_relationship.state = 'ready'
                    and sync_relationship.revoked_at is null
                    and sync_replica.freshness_status = 'fresh'
                )
            )
          limit 1
          for update
        `,
          [input.sessionId, actor.userId]
        );
        const session = sessionRows.rows[0];
        if (!session) {
          await client.query("rollback");
          return null;
        }

        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [`team-session-share:${session.id}:${access.teamWorkspaceId}`]
        );

        const grantRows = await client.query<
          TeamSessionShareGrantRow & { created: boolean }
        >(
          `
          with existing as (
            select *
            from team_session_share_grants
            where session_id = $2
              and team_workspace_id = $4
              and revoked_at is null
            limit 1
          ),
          inserted as (
            insert into team_session_share_grants (
              owner_user_id,
              session_id,
              team_id,
              team_workspace_id,
              granted_by_user_id
            )
            select $1, $2, $3, $4, $5
            where not exists (select 1 from existing)
            returning *, true as created
          )
          select * from inserted
          union all
          select existing.*, false as created
          from existing
        `,
          [
            session.owner_user_id,
            session.id,
            access.teamId,
            access.teamWorkspaceId,
            actor.userId
          ]
        );
        const row = grantRows.rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }

        if (row.created) {
          await recordAuditEventWithClient(client, {
            actorUserId: actor.userId,
            ownerUserId: session.owner_user_id,
            visibility: "personal",
            action: "team.session_share.created",
            targetTable: "team_session_share_grants",
            targetId: row.id,
            metadata: {
              teamId: access.teamId,
              teamWorkspaceId: access.teamWorkspaceId,
              sessionId: session.id
            }
          });
        }

        await client.query("commit");
        return mapTeamSessionShareGrant(row);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async revokeTeamSessionShareGrant(actor, input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const existingRows = await client.query<TeamSessionShareGrantRow>(
          `
          select *
          from team_session_share_grants
          where id = $1
            and team_workspace_id = $2
            and revoked_at is null
          limit 1
          for update
        `,
          [input.shareGrantId, input.teamWorkspaceId]
        );
        const existing = existingRows.rows[0];
        if (!existing) {
          await client.query("rollback");
          return null;
        }

        let canRevoke = existing.owner_user_id === actor.userId;
        if (!canRevoke) {
          const access = await this.getTeamWorkspaceAccess(
            actor,
            existing.team_workspace_id
          );
          canRevoke = access?.canCreateShare === true;
        }
        if (!canRevoke) {
          await client.query("rollback");
          return null;
        }

        const revokedRows = await client.query<TeamSessionShareGrantRow>(
          `
          update team_session_share_grants
          set
            revoked_at = now(),
            revoked_by_user_id = $1,
            revocation_reason = nullif(trim($4::text), ''),
            updated_at = now()
          where id = $2
            and team_workspace_id = $3
            and revoked_at is null
          returning *
        `,
          [
            actor.userId,
            input.shareGrantId,
            input.teamWorkspaceId,
            input.reason ?? null
          ]
        );
        const revoked = revokedRows.rows[0];
        if (!revoked) {
          await client.query("rollback");
          return null;
        }
        await recordAuditEventWithClient(client, {
          actorUserId: actor.userId,
          ownerUserId: existing.owner_user_id,
          visibility: "personal",
          action: "team.session_share.revoked",
          targetTable: "team_session_share_grants",
          targetId: revoked.id,
          metadata: {
            teamId: revoked.team_id,
            teamWorkspaceId: revoked.team_workspace_id,
            sessionId: revoked.session_id
          }
        });

        await client.query("commit");
        return mapTeamSessionShareGrant(revoked);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async listTeamSessionShareGrants(actor, input) {
      const access = await this.getTeamWorkspaceAccess(
        actor,
        input.teamWorkspaceId
      );
      if (!access?.canRecall) {
        return null;
      }
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
      const rows = await pool.query<TeamSessionShareGrantRow>(
        `
        select *
        from team_session_share_grants
        where team_workspace_id = $1
          and team_id = $2
          and ($3::boolean = true or revoked_at is null)
        order by created_at desc, id desc
        limit $4
      `,
        [
          input.teamWorkspaceId,
          access.teamId,
          input.includeRevoked ?? false,
          limit
        ]
      );
      return rows.rows.map(mapTeamSessionShareGrant);
    },

    async resetConversationProjection(actor, input) {
      const client = await pool.connect();
      let invalidatedMemoryEventIds: string[];
      let conversationItemIds: string[];
      let projectionPolicyRevision: number;
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`conversation-projection-session:${actor.userId}:${input.sessionId}`]
        );
        await client.query(
          "select pg_advisory_xact_lock_shared(hashtextextended($1, 0))",
          ["conversation-projection-policy"]
        );
        projectionPolicyRevision = (
          await loadConversationProjectionPolicyRules(client)
        ).revision;
        const session = await client.query<{ id: string }>(
          `
            select id
            from sessions
            where id = $2
              and owner_user_id = $1
              and visibility = 'personal'
              and invalidated_at is null
              and personal_deleted_at is null
            limit 1
          `,
          [actor.userId, input.sessionId]
        );
        if (session.rowCount === 0) {
          throw Object.assign(new Error("Session not found or not visible"), {
            statusCode: 404,
            code: "session_not_found"
          });
        }
        const sourceCount = await client.query<{ count: number }>(
          `
            select count(*)::int as count
            from conversation_items
            where owner_user_id = $1
              and visibility = 'personal'
              and session_id = $2
              and memory_excluded_at is null
              and personal_deleted_at is null
          `,
          [actor.userId, input.sessionId]
        );
        const maxItems = projectionRebuildMaxItems();
        if ((sourceCount.rows[0]?.count ?? 0) > maxItems) {
          throw Object.assign(
            new Error(
              `Conversation projection rebuild exceeds the ${maxItems}-item safety limit`
            ),
            { statusCode: 413, code: "projection_rebuild_too_large" }
          );
        }

        const memoryEvents = await client.query<{ id: string }>(
          `
            update memory_events
            set invalidated_at = coalesce(invalidated_at, now()),
                invalidation_reason = 'projection_policy_rebuild',
                updated_at = now()
            where owner_user_id = $1
              and visibility = 'personal'
              and session_id = $2
              and personal_deleted_at is null
              and exists (
                select 1
                from memory_event_sources mes
                join conversation_items ci
                  on ci.id = mes.conversation_item_id
                where mes.memory_event_id = memory_events.id
                  and ci.owner_user_id = $1
                  and ci.visibility = 'personal'
                  and ci.session_id = $2
              )
            returning id
          `,
          [actor.userId, input.sessionId]
        );
        invalidatedMemoryEventIds = memoryEvents.rows.map((row) => row.id);

        await client.query(
          `
            update messages
            set invalidated_at = coalesce(invalidated_at, now()),
                invalidation_reason = 'projection_policy_rebuild'
            where owner_user_id = $1
              and visibility = 'personal'
              and session_id = $2
              and idempotency_key in (
                select distinct
                  'message:' || coalesce(
                    ci.metadata ->> 'canonicalConversationItemKey',
                    ci.canonical_item_key,
                    ci.logical_source_id,
                    ci.id::text
                  )
                from conversation_items ci
                where ci.owner_user_id = $1
                  and ci.visibility = 'personal'
                  and ci.session_id = $2
              )
          `,
          [actor.userId, input.sessionId]
        );
        await client.query(
          `
            update tool_events
            set invalidated_at = coalesce(invalidated_at, now()),
                invalidation_reason = 'projection_policy_rebuild'
            where owner_user_id = $1
              and visibility = 'personal'
              and session_id = $2
              and idempotency_key in (
                select distinct
                  'tool:' || case
                    when coalesce(
                      ci.metadata ->> 'toolCallId',
                      ci.metadata ->> 'callId',
                      ci.metadata #>> '{toolCall,id}'
                    ) is not null
                    then 'tool-call:' || ci.session_id::text || ':' || coalesce(
                      ci.metadata ->> 'toolCallId',
                      ci.metadata ->> 'callId',
                      ci.metadata #>> '{toolCall,id}'
                    )
                    else coalesce(
                      ci.metadata ->> 'canonicalConversationItemKey',
                      ci.canonical_item_key,
                      ci.logical_source_id,
                      ci.id::text
                    )
                  end
                from conversation_items ci
                where ci.owner_user_id = $1
                  and ci.visibility = 'personal'
                  and ci.session_id = $2
              )
          `,
          [actor.userId, input.sessionId]
        );
        const activeRebuildJobs = await client.query<{
          id: string;
          status: string;
        }>(
          `
            select id, status
            from semantic_memory_rebuild_jobs
            where owner_user_id = $1
              and visibility = 'personal'
              and memory_event_id = any($2::uuid[])
              and status in ('pending', 'processing')
            for update
          `,
          [actor.userId, invalidatedMemoryEventIds]
        );
        if (activeRebuildJobs.rows.some((job) => job.status === "processing")) {
          throw Object.assign(
            new Error(
              "Conversation projection cannot rebuild while semantic memory repair is active"
            ),
            { statusCode: 409, code: "semantic_rebuild_in_progress" }
          );
        }
        await client.query(
          `
            delete from semantic_memory_rebuild_jobs
            where owner_user_id = $1
              and visibility = 'personal'
              and memory_event_id = any($2::uuid[])
              and status = 'pending'
          `,
          [actor.userId, invalidatedMemoryEventIds]
        );
        const rawItems = await client.query<{ id: string }>(
          `
            update conversation_items
            set projection_status = 'pending',
                projection_version = null,
                projection_policy_revision = $3,
                projection_error = null,
                projected_at = null
            where owner_user_id = $1
              and visibility = 'personal'
              and session_id = $2
              and projection_status <> 'held'
              and memory_excluded_at is null
              and personal_deleted_at is null
            returning id
          `,
          [actor.userId, input.sessionId, projectionPolicyRevision]
        );
        conversationItemIds = rawItems.rows.map((row) => row.id);
        await invalidateDerivedMemoryForMemoryEvents(
          client,
          invalidatedMemoryEventIds,
          "projection_policy_rebuild"
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return {
        conversationItemIds,
        invalidatedMemoryEventIds,
        projectionPolicyRevision
      };
    },

    async projectPendingConversationItems(actor, input = {}) {
      const conversationItemIds = input.conversationItemIds ?? null;
      const visibility = input.visibility ?? null;
      const workClass = input.workClass ?? null;
      const maxBytes = input.maxBytes ?? null;
      const deadlineAt = input.maxRuntimeMs
        ? Date.now() + input.maxRuntimeMs
        : null;
      if (conversationItemIds && conversationItemIds.length === 0) {
        return {
          rawItemsScanned: 0,
          rawItemsProjected: 0,
          rawItemsWaitingForAgentSeal: 0,
          messagesCreated: 0,
          toolEventsCreated: 0,
          memoryEventsCreated: 0,
          tokenUsageRowsCreated: 0,
          memoryEventIds: [],
          memoryEventScopes: []
        };
      }
      const limit = Math.min(
        Math.max(input.limit ?? conversationItemIds?.length ?? 100, 1),
        1000
      );
      const result: ConversationProjectionResult = {
        rawItemsScanned: 0,
        rawItemsProjected: 0,
        rawItemsWaitingForAgentSeal: 0,
        messagesCreated: 0,
        toolEventsCreated: 0,
        memoryEventsCreated: 0,
        tokenUsageRowsCreated: 0,
        memoryEventIds: [],
        memoryEventScopes: []
      };
      const suppressPlaintextDisplayPayloads =
        managedCloudPlaintextMemoryPayloadsDisabled();
      if (
        suppressPlaintextDisplayPayloads &&
        !options.envelopeEncryptionProvider
      ) {
        throw new Error(
          "Envelope encryption provider is required when plaintext display row storage is disabled"
        );
      }
      const rows = await pool.query<ConversationProjectionRawRow>(
        `
        with pending_items as (
          select
            'conversation_items'::text as projection_source_table,
            ci.id, ci.owner_user_id, ci.visibility, ci.session_id,
            ci.turn_id, ci.source_kind, ci.source_adapter_version,
            ci.source_transport, ci.external_session_id, ci.external_thread_id,
            ci.external_turn_id, ci.external_item_id, ci.source_record_type,
            ci.source_event_type, ci.source_path, ci.source_sequence,
            ci.event_time, ci.raw_json, ci.raw_text, ci.logical_source_id,
            ci.transport_chunk_index, ci.transport_chunk_count,
            ci.transport_chunk_text, ci.transport_chunk_encoding,
            ci.source_hash, ci.idempotency_key, ci.canonical_item_key,
            ci.projection_work_class, ci.metadata,
            ci.canonical_source_priority, ci.projection_policy_revision,
            ci.observed_at,
            s.workspace_id as session_workspace_id,
            s.cwd as session_cwd,
            s.metadata as session_metadata,
            coalesce(ci.session_id::text, ci.external_session_id, 'sessionless') as boundary_session,
            coalesce(ci.turn_id::text, ci.external_turn_id, 'turnless') as boundary_turn,
            coalesce(ci.external_thread_id, 'threadless') as boundary_thread,
            coalesce(
              case when ci.metadata ->> 'workspaceId' = ci.session_id::text then null else ci.metadata ->> 'workspaceId' end,
              s.workspace_id::text,
              s.cwd,
              'unknown-project'
            ) as boundary_workspace,
            coalesce(ci.event_time, ci.observed_at) as boundary_order_at,
            (
              ci.source_record_type = 'hook_payload'
              and (
                lower(coalesce(ci.source_event_type, '')) in ('stop', 'subagentstop')
                or lower(coalesce(ci.raw_json ->> 'hook_event_name', '')) in ('stop', 'subagentstop')
                or lower(coalesce(ci.metadata ->> 'hookEventName', '')) in ('stop', 'subagentstop')
              )
            ) as is_turn_complete_signal,
            (
              (ci.source_adapter_version = 'codex-app-server-conversation-v1'
                and ci.source_event_type = 'turn/completed')
              or
              (ci.source_adapter_version = 'codex-transcript-v1'
                and ci.source_event_type in ('task_complete', 'turn_aborted'))
            ) as is_semantic_turn_complete_signal
          from conversation_items ci
          left join sessions s on s.id = ci.session_id
          where ci.projection_status in ('pending', 'error')
            and ci.memory_excluded_at is null
            and ci.personal_deleted_at is null
            and (
              ci.session_id is null
              or (
                s.id is not null
                and s.invalidated_at is null
                and s.personal_deleted_at is null
              )
            )
            and ($4::visibility_scope is null or ci.visibility = $4)
            and ($5::text is null or ci.projection_work_class = $5)
            and (
              ci.logical_source_id is null
              or not exists (
                select 1
                from conversation_items higher_priority_chunk
                where higher_priority_chunk.owner_user_id = ci.owner_user_id
                  and higher_priority_chunk.visibility = ci.visibility
                  and higher_priority_chunk.logical_source_id = ci.logical_source_id
                  and higher_priority_chunk.transport_chunk_index = 0
                  and higher_priority_chunk.memory_excluded_at is null
                  and higher_priority_chunk.personal_deleted_at is null
                  and higher_priority_chunk.canonical_source_priority > ci.canonical_source_priority
              )
            )
            and ci.owner_user_id = $1
        ), ordered_items as (
          select
            *,
            coalesce(sum(is_turn_complete_signal::integer) over (
              partition by boundary_session, boundary_thread,
                boundary_workspace, projection_work_class
              order by boundary_order_at asc, source_sequence asc nulls last, id asc
              rows between unbounded preceding and 1 preceding
            ), 0) as completed_scope_segment
          from pending_items
        ), scoped_items as (
          select
            *,
            bool_or(
              is_turn_complete_signal
              and ($3::uuid[] is null or id = any($3::uuid[]))
            ) over (
              partition by boundary_session, boundary_thread,
                boundary_workspace, projection_work_class,
                completed_scope_segment
            ) as segment_has_selected_turn_complete_signal
          from ordered_items
        ), unit_items as (
          select
            *,
            case when segment_has_selected_turn_complete_signal
              then 'completed_scope'
              else 'turn'
            end as selection_unit_kind,
            case when segment_has_selected_turn_complete_signal
              then completed_scope_segment
              else null
            end as selection_unit_segment,
            case when segment_has_selected_turn_complete_signal
              then null
              else boundary_turn
            end as selection_unit_turn
          from scoped_items
        ), selected_units as (
          select
            boundary_session,
            selection_unit_kind,
            selection_unit_segment,
            selection_unit_turn,
            boundary_thread,
            boundary_workspace,
            projection_work_class,
            min(boundary_order_at) as oldest_at,
            min(id::text) as oldest_id,
            count(*) as row_count,
            sum(
              octet_length(raw_json::text)
              + octet_length(coalesce(raw_text, ''))
              + octet_length(coalesce(transport_chunk_text, ''))
            ) as byte_count
          from unit_items
          group by
            boundary_session,
            selection_unit_kind,
            selection_unit_segment,
            selection_unit_turn,
            boundary_thread,
            boundary_workspace,
            projection_work_class
          having $3::uuid[] is null or bool_or(id = any($3::uuid[]))
        ), ranked_units as (
          select
            *,
            row_number() over projection_order as unit_number,
            sum(row_count) over projection_order as selected_row_count,
            sum(byte_count) over projection_order as selected_byte_count
          from selected_units
          window projection_order as (
            order by
              case projection_work_class
                when 'live_capture_projection' then 0
                else 1
              end,
              oldest_at asc,
              oldest_id asc
          )
        ), admitted_units as (
          select *
          from ranked_units
          where (
            ($5::text = 'historical_import_backfill' and selected_row_count <= $2)
            or
            ($5::text is distinct from 'historical_import_backfill' and unit_number <= $2)
          )
          and ($6::bigint is null or selected_byte_count <= $6)
        )
        select
          pi.projection_source_table,
          pi.id, pi.owner_user_id, pi.visibility, pi.session_id,
          pi.turn_id, pi.source_kind, pi.source_adapter_version,
          pi.source_transport, pi.external_session_id, pi.external_thread_id,
          pi.external_turn_id, pi.external_item_id, pi.source_record_type,
          pi.source_event_type, pi.source_path, pi.source_sequence,
          pi.event_time, pi.raw_json, pi.raw_text, pi.logical_source_id,
          pi.transport_chunk_index, pi.transport_chunk_count,
          pi.transport_chunk_text, pi.transport_chunk_encoding,
          pi.source_hash, pi.idempotency_key, pi.canonical_item_key,
          pi.projection_work_class, pi.metadata, pi.observed_at,
          pi.canonical_source_priority, pi.projection_policy_revision,
          pi.session_workspace_id, pi.session_cwd, pi.session_metadata,
          au.oldest_id as selection_unit_id
        from unit_items pi
        join admitted_units au
          on au.boundary_session = pi.boundary_session
          and au.selection_unit_kind = pi.selection_unit_kind
          and au.selection_unit_segment is not distinct from pi.selection_unit_segment
          and au.selection_unit_turn is not distinct from pi.selection_unit_turn
          and au.boundary_thread = pi.boundary_thread
          and au.boundary_workspace = pi.boundary_workspace
          and au.projection_work_class = pi.projection_work_class
        where pi.transport_chunk_count = 1
          or pi.transport_chunk_index = 0
        order by
          au.unit_number asc,
          pi.is_semantic_turn_complete_signal asc,
          pi.source_sequence asc nulls last,
          pi.boundary_order_at asc,
          case pi.metadata ->> 'canonicalConversationItemKind'
            when 'tool_call' then 0
            when 'tool_result' then 1
            else 0
          end asc,
          pi.id asc
      `,
        [
          actor.userId,
          limit,
          conversationItemIds,
          visibility,
          workClass,
          maxBytes
        ]
      );

      const projectionCoordinatorClient = await pool.connect();
      const projectionResourceLockKeys = uniqueOrderedStrings(
        rows.rows.map((row) =>
          row.session_id
            ? `conversation-projection-session:${row.owner_user_id ?? "anonymous"}:${row.session_id}`
            : `conversation-item:${row.owner_user_id ?? "anonymous"}:${row.visibility}:${row.canonical_item_key}`
        )
      ).sort();
      const acquiredProjectionResourceLocks: string[] = [];
      const projectionPolicyLockKey = "conversation-projection-policy";
      let projectionPolicyLockAcquired = false;
      try {
        for (const lockKey of projectionResourceLockKeys) {
          await projectionCoordinatorClient.query(
            "select pg_advisory_lock(hashtextextended($1, 0))",
            [lockKey]
          );
          acquiredProjectionResourceLocks.push(lockKey);
        }
        await projectionCoordinatorClient.query(
          "select pg_advisory_lock_shared(hashtextextended($1, 0))",
          [projectionPolicyLockKey]
        );
        projectionPolicyLockAcquired = true;
        const projectionPolicySnapshot =
          await loadConversationProjectionPolicyRules(
            projectionCoordinatorClient
          );
        const projectionRules = projectionPolicySnapshot.rules;
        if (
          rows.rows.some(
            (row) =>
              row.projection_policy_revision !== null &&
              Number(row.projection_policy_revision) !==
                projectionPolicySnapshot.revision
          )
        ) {
          throw Object.assign(
            new Error(
              "Projection Policy changed after this conversation rebuild was prepared"
            ),
            { statusCode: 409, code: "projection_policy_changed" }
          );
        }

        const projectedStatusSourceIds = new Set<string>();
        const markProjected = async (sourceIds: string[]) => {
          const pendingIds = sourceIds.filter(
            (sourceId) => !projectedStatusSourceIds.has(sourceId)
          );
          if (pendingIds.length === 0) {
            return;
          }
          await pool.query(
            `
          update conversation_items
          set projection_status = 'projected',
              projection_version = $2,
              projection_policy_revision = $3,
              projection_error = null,
              projected_at = now()
          where id = any($1::uuid[])
        `,
            [
              pendingIds,
              CURRENT_CONVERSATION_PROJECTION_VERSION,
              projectionPolicySnapshot.revision
            ]
          );
          const superseded = await pool.query<{ id: string }>(
            `
            with projected_groups as (
              select logical_source_id, max(canonical_source_priority) as priority
              from conversation_items
              where id = any($1::uuid[])
                and logical_source_id is not null
              group by logical_source_id
            )
            update conversation_items superseded
            set projection_status = 'projected',
                projection_version = $2,
                projection_policy_revision = $4,
                projection_error = null,
                projected_at = now()
            from projected_groups selected
            where superseded.owner_user_id = $3
              and superseded.visibility = 'personal'
              and superseded.logical_source_id = selected.logical_source_id
              and superseded.canonical_source_priority < selected.priority
              and superseded.projection_status in ('pending', 'error')
            returning superseded.id
          `,
            [
              pendingIds,
              CURRENT_CONVERSATION_PROJECTION_VERSION,
              actor.userId,
              projectionPolicySnapshot.revision
            ]
          );
          for (const sourceId of pendingIds) {
            projectedStatusSourceIds.add(sourceId);
          }
          result.rawItemsProjected +=
            pendingIds.length + superseded.rows.length;
        };

        const markProjectionError = async (
          sourceIds: string[],
          error: unknown
        ) => {
          const pendingIds = sourceIds.filter(
            (sourceId) => !projectedStatusSourceIds.has(sourceId)
          );
          if (pendingIds.length === 0) {
            return;
          }
          await pool.query(
            `
          update conversation_items
          set projection_status = 'error',
              projection_error = $2
          where id = any($1::uuid[])
        `,
            [pendingIds, error instanceof Error ? error.message : String(error)]
          );
        };

        const runDisplayRowUpsert = async <T extends { id: string }>(
          sql: string,
          params: unknown[],
          persistEncryptedFields: (
            client: pg.Pool | pg.PoolClient,
            row: T
          ) => Promise<void>
        ): Promise<pg.QueryResult<T>> => {
          if (!suppressPlaintextDisplayPayloads) {
            return pool.query<T>(sql, params);
          }
          const client = await pool.connect();
          try {
            await client.query("begin");
            const upserted = await client.query<T>(sql, params);
            for (const row of upserted.rows) {
              await persistEncryptedFields(client, row);
            }
            await client.query("commit");
            return upserted;
          } catch (error) {
            await client.query("rollback");
            throw error;
          } finally {
            client.release();
          }
        };

        const processedSourceIdentities = new Set<string>();
        const candidates: ConversationProjectionCandidate[] = [];
        for (const sourceRow of rows.rows) {
          result.rawItemsScanned += 1;
          let sourceIds = [sourceRow.id];
          try {
            const hydratedSourceRow = await hydrateConversationProjectionRow(
              pool,
              options.envelopeEncryptionProvider,
              sourceRow
            );
            const logicalItem = await loadLogicalConversationProjectionItem(
              pool,
              options.envelopeEncryptionProvider,
              hydratedSourceRow
            );
            if (processedSourceIdentities.has(logicalItem.sourceIdentity)) {
              continue;
            }
            processedSourceIdentities.add(logicalItem.sourceIdentity);
            const row = logicalItem.row;
            sourceIds = logicalItem.sourceIds;
            const content = conversationItemContent(row);
            const actorType = actorFromConversationItem(row);
            const messageRole = messageRoleForActor(actorType);
            const tokenUsage = appServerTokenUsageFromRaw(row.raw_json);
            const transcriptTokenUsage = tokenUsage
              ? null
              : transcriptTokenUsageFromRaw(row.raw_json);
            const projectionMetadata = canonicalProjectMetadata({
              metadata: row.metadata,
              sessionMetadata: row.session_metadata,
              sessionId: row.session_id,
              sessionWorkspaceId: row.session_workspace_id,
              sessionCwd: row.session_cwd
            });
            const projectionPolicy = classifyConversationItemProjection(row, {
              actorType,
              content,
              projectionRules
            });
            const semanticUnitType =
              content && actorType && projectionPolicy.createMemoryEvent
                ? conversationSemanticUnitTypeForActor(actorType)
                : null;
            const semanticItem: ConversationSemanticProjectionItem | null =
              content && actorType && semanticUnitType
                ? {
                    row,
                    sourceIds,
                    sourceIdentity: logicalItem.sourceIdentity,
                    sourceHash: logicalItem.sourceHash,
                    actorType,
                    content,
                    includeInEmbedding: projectionPolicy.includeInEmbedding,
                    includeInLcm: projectionPolicy.includeInLcm,
                    projectionPolicyKey: projectionPolicy.policyKey,
                    projectionPolicyRevision: projectionPolicySnapshot.revision,
                    projectionMetadata
                  }
                : null;
            const disposition: ConversationProjectionDisposition =
              !semanticItem || !semanticUnitType
                ? "raw_only"
                : semanticUnitType === "agent_turn"
                  ? "waiting_for_agent_seal"
                  : "ready_for_semantic_projection";
            candidates.push({
              logicalItem,
              row,
              sourceIds,
              content,
              actorType,
              messageRole,
              tokenUsage,
              transcriptTokenUsage,
              projectionMetadata,
              projectionPolicy,
              turnCompleteSealReason:
                conversationItemTurnCompleteSealReason(row),
              boundary: conversationProjectionBoundary(row),
              semanticUnitType,
              semanticItem,
              disposition,
              selectionUnitId: sourceRow.selection_unit_id ?? sourceRow.id
            });
          } catch (error) {
            await markProjectionError(sourceIds, error);
          }
        }

        const pendingAgentBundles = new Map<
          string,
          PendingAgentSemanticBundle
        >();
        const pendingSupportingContextsByBoundary = new Map<
          string,
          SupportingContextProjectionItem[]
        >();

        const createSemanticMemoryUnit = async (
          unitType: ConversationSemanticUnitType,
          items: ConversationSemanticProjectionItem[],
          sealedReason: SemanticBundleSealReason
        ) => {
          if (items.length === 0) {
            return;
          }
          const first = items[0]!;
          const model = stringField(first.row.metadata ?? {}, "model");
          const chunks = conversationSemanticUnitChunks(items, {
            model,
            maxTokens: projectionMaxTokens(),
            hardMaxTokens: projectionHardMaxTokens()
          });
          const sourceCapturedAt =
            items
              .map((item) => item.row.event_time ?? item.row.observed_at)
              .filter((value): value is Date => value instanceof Date)
              .sort((left, right) => left.getTime() - right.getTime())[0] ??
            undefined;
          const sourceActors = uniqueOrderedStrings(
            items.map((item) => item.actorType)
          );
          const unitActor = conversationSemanticUnitActor(
            unitType,
            sourceActors
          );
          const allSourceIds = uniqueOrderedStrings(
            items.flatMap((item) => item.sourceIds)
          );
          const includeInLcmBySourceIdentity = new Map(
            items.map((item) => [item.sourceIdentity, item.includeInLcm])
          );
          const boundaryKey = conversationSemanticBoundaryKey(first);
          const supportingContexts =
            unitType === "user_turn"
              ? (pendingSupportingContextsByBoundary.get(boundaryKey) ?? [])
              : [];
          if (unitType === "user_turn") {
            pendingSupportingContextsByBoundary.delete(boundaryKey);
          }
          const supportingSourceIds = uniqueOrderedStrings(
            supportingContexts.flatMap((item) => item.sourceIds)
          );
          const createdEventIds: string[] = [];

          for (const chunk of chunks) {
            const embeddingContent = conversationSemanticChunkPolicyContent(
              chunk,
              "includeInEmbedding"
            );
            const lcmContent = conversationSemanticChunkPolicyContent(
              chunk,
              "includeInLcm"
            );
            const includeInEmbedding = embeddingContent.trim().length > 0;
            const includeInLcm = chunk.sourceIdentities.some(
              (sourceIdentity) =>
                includeInLcmBySourceIdentity.get(sourceIdentity) === true
            );
            const unitHash = createHash("sha256")
              .update(
                JSON.stringify({
                  projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
                  unitType,
                  sourceIdentities: chunk.sourceIdentities,
                  chunkIndex: chunk.chunkIndex
                })
              )
              .digest("hex");
            const contentHash = createHash("sha256")
              .update(
                JSON.stringify({
                  projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
                  unitType,
                  sourceHashes: chunk.sourceHashes,
                  content: chunk.content,
                  embeddingContent,
                  lcmContent,
                  includeInEmbedding,
                  includeInLcm,
                  chunkIndex: chunk.chunkIndex
                })
              )
              .digest("hex");
            const event = await this.createMemoryEvent(
              { userId: actor.userId },
              {
                workspaceId: canonicalWorkspaceId({
                  metadata: first.row.metadata,
                  sessionId: first.row.session_id,
                  sessionWorkspaceId: first.row.session_workspace_id,
                  sessionCwd: first.row.session_cwd
                }),
                sessionId: first.row.session_id ?? undefined,
                turnId: first.row.turn_id ?? undefined,
                actor: unitActor,
                eventType: "captured",
                rawEventType: unitType,
                content: chunk.content,
                metadata: {
                  ...conversationSemanticEventMetadata({
                    first,
                    chunk,
                    allSourceIds,
                    sourceActors,
                    unitType,
                    sealedReason,
                    includeInEmbedding,
                    includeInLcm,
                    embeddingContent,
                    lcmContent,
                    projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
                    model
                  }),
                  projectionPolicyKey: first.projectionPolicyKey,
                  projectionPolicyRevision: first.projectionPolicyRevision
                },
                visibility: first.row.visibility,
                sourceRuntime:
                  first.row.source_kind === "codex-cli" ? "codex-cli" : "codex",
                captureMethod: captureMethodForConversationItem({
                  sourceTransport: first.row.source_transport
                }),
                codexTranscriptPath: first.row.source_path ?? undefined,
                idempotencyKey: `projection:${unitType}:${unitHash}`,
                sourceHash: `projection:${unitType}:${contentHash}`,
                capturedAt: sourceCapturedAt?.toISOString(),
                sourceEventTime: chunk.sourceEventTime?.toISOString(),
                sourceSequence: chunk.sourceSequence ?? undefined,
                tokenModel: model ?? undefined,
                sealReason: sealedReason
              }
            );
            if (event.id) {
              createdEventIds.push(event.id);
              if (supportingSourceIds.length > 0) {
                await linkMemoryEventSources(
                  pool,
                  event.id,
                  supportingSourceIds,
                  SUPPORTING_CONTEXT_SOURCE_ROLE,
                  chunk.sourceIds.length
                );
              }
              await pool.query(
                `
                insert into conversation_projection_processing_outbox (
                  event_id, owner_user_id, visibility, work_class,
                  include_in_embedding, include_in_lcm, source_event_time
                )
                values ($1, $2, $3, $4, $5, $6, $7)
                on conflict (event_id) do nothing
              `,
                [
                  event.id,
                  actor.userId,
                  first.row.visibility,
                  first.row.projection_work_class,
                  includeInEmbedding,
                  includeInLcm,
                  chunk.sourceEventTime?.toISOString() ?? null
                ]
              );
              result.memoryEventsCreated += 1;
              result.memoryEventIds.push(event.id);
              result.memoryEventScopes.push({
                eventId: event.id,
                visibility: first.row.visibility,
                includeInEmbedding,
                includeInLcm,
                workClass: first.row.projection_work_class,
                sourceEventTime: chunk.sourceEventTime?.toISOString() ?? null
              });
            }
          }
          if (createdEventIds.length > 0 && supportingSourceIds.length > 0) {
            await markProjected(supportingSourceIds);
          }
        };

        const flushAgentBundle = async (
          boundaryKey: string,
          sealedReason: SemanticBundleSealReason
        ) => {
          const bundle = pendingAgentBundles.get(boundaryKey);
          if (!bundle || bundle.items.length === 0) {
            pendingAgentBundles.delete(boundaryKey);
            return;
          }
          pendingAgentBundles.delete(boundaryKey);
          const items = bundle.items;
          const sourceIds = uniqueOrderedStrings(
            items.flatMap((item) => item.sourceIds)
          );
          try {
            for (const group of conversationSemanticProjectionGroups(
              "agent_turn",
              items
            )) {
              await createSemanticMemoryUnit(
                group.unitType,
                group.items,
                sealedReason
              );
            }
            await markProjected(sourceIds);
          } catch (error) {
            await markProjectionError(sourceIds, error);
            throw error;
          }
        };

        const flushAgentBundlesForScope = async (
          scopeKey: string,
          sealedReason: SemanticBundleSealReason
        ) => {
          for (const [boundaryKey, bundle] of [...pendingAgentBundles]) {
            const first = bundle.items[0];
            if (
              first &&
              conversationProjectionScopeKey(first.row) === scopeKey
            ) {
              await flushAgentBundle(boundaryKey, sealedReason);
            }
          }
        };

        const pendingAgentLatestActivityTime = (
          bundle: PendingAgentSemanticBundle
        ): Date | null =>
          bundle.items
            .map((item) => item.row.event_time ?? item.row.observed_at)
            .filter((value): value is Date => value instanceof Date)
            .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

        const pendingAgentBundleIsStale = (
          bundle: PendingAgentSemanticBundle
        ): boolean => {
          if (bundle.items.length === 0) {
            return false;
          }
          const staleMs = projectionAgentTurnStaleMs();
          if (staleMs <= 0) {
            return true;
          }
          const latestActivityTime = pendingAgentLatestActivityTime(bundle);
          if (!latestActivityTime) {
            return false;
          }
          return Date.now() - latestActivityTime.getTime() >= staleMs;
        };

        const flushStaleAgentBundles = async () => {
          for (const [boundaryKey, bundle] of pendingAgentBundles) {
            if (pendingAgentBundleIsStale(bundle)) {
              await flushAgentBundle(boundaryKey, "catch_up_stale");
            }
          }
        };

        const queueAgentSemanticItem = async (
          semanticItem: ConversationSemanticProjectionItem
        ): Promise<AgentSemanticQueueResult> => {
          const boundaryKey = conversationSemanticBoundaryKey(semanticItem);
          const model = stringField(semanticItem.row.metadata ?? {}, "model");
          const itemTokens = estimateTokens(semanticItem.content, {
            model: model ?? "gpt-5.4-mini"
          });
          const maxTokens = projectionMaxTokens();
          let bundle = pendingAgentBundles.get(boundaryKey);
          if (!bundle) {
            bundle = { items: [] };
            pendingAgentBundles.set(boundaryKey, bundle);
          }

          const candidateTokens =
            bundle.items.length > 0
              ? joinedSemanticContentTokenCount(
                  [
                    ...bundle.items.map((item) => item.content),
                    semanticItem.content
                  ],
                  model
                )
              : itemTokens;
          if (bundle.items.length > 0 && candidateTokens > maxTokens) {
            await flushAgentBundle(boundaryKey, "token_limit");
            bundle = { items: [] };
            pendingAgentBundles.set(boundaryKey, bundle);
          }

          if (itemTokens > maxTokens) {
            pendingAgentBundles.set(boundaryKey, {
              items: [semanticItem]
            });
            await flushAgentBundle(boundaryKey, "token_limit");
            return "projected_by_token_limit";
          }

          bundle.items.push(semanticItem);
          return "waiting_for_agent_seal";
        };

        const waitingForAgentSealSourceIds = new Set<string>();
        let activeSelectionUnitId: string | null = null;

        for (const candidate of candidates) {
          if (
            activeSelectionUnitId !== null &&
            candidate.selectionUnitId !== activeSelectionUnitId &&
            deadlineAt &&
            Date.now() >= deadlineAt
          ) {
            break;
          }
          activeSelectionUnitId = candidate.selectionUnitId;
          const {
            logicalItem,
            row,
            sourceIds,
            content,
            messageRole,
            tokenUsage,
            transcriptTokenUsage,
            projectionPolicy,
            turnCompleteSealReason,
            boundary,
            semanticUnitType,
            semanticItem,
            disposition
          } = candidate;
          const projectionLockClient = projectionCoordinatorClient;
          const projectionLockKey = `conversation-item:${row.owner_user_id ?? "anonymous"}:${row.visibility}:${row.canonical_item_key}`;
          let projectionLockAcquired = false;
          try {
            await projectionLockClient.query(
              "select pg_advisory_lock(hashtextextended($1, 0))",
              [projectionLockKey]
            );
            projectionLockAcquired = true;
            const freshness = await projectionLockClient.query<{
              source_hash: string;
              canonical_source_priority: number;
              projection_status: string;
              projection_policy_revision: string | null;
            }>(
              `
              select
                source_hash, canonical_source_priority, projection_status,
                projection_policy_revision::text as projection_policy_revision
              from conversation_items
              where id = $1
                and owner_user_id = $2
                and visibility = $3::visibility_scope
              limit 1
            `,
              [row.id, actor.userId, row.visibility]
            );
            const current = freshness.rows[0];
            if (
              current?.projection_policy_revision !== null &&
              current?.projection_policy_revision !== undefined &&
              Number(current.projection_policy_revision) !==
                projectionPolicySnapshot.revision
            ) {
              throw Object.assign(
                new Error(
                  "Projection Policy changed after this conversation rebuild was prepared"
                ),
                { statusCode: 409, code: "projection_policy_changed" }
              );
            }
            if (
              !current ||
              !["pending", "error"].includes(current.projection_status) ||
              current.source_hash !== logicalItem.representativeSourceHash ||
              current.canonical_source_priority !==
                (row.canonical_source_priority ?? 0)
            ) {
              continue;
            }
            const ownerUserId = actor.userId;
            const projectionTranscriptItemId =
              projectionTranscriptItemIdFor(row);
            const requiresTranscriptSourceTime =
              row.source_transport === "hook" && row.source_kind === "codex";
            if (
              requiresTranscriptSourceTime &&
              (projectionPolicy.createMessage ||
                projectionPolicy.createToolEvent) &&
              !row.event_time
            ) {
              throw new Error(
                "Transcript display projection requires source event timestamp"
              );
            }
            if (projectionPolicy.reason === "ide-client-supporting-context") {
              if (content) {
                const supportingContext: SupportingContextProjectionItem = {
                  row,
                  sourceIds,
                  content
                };
                pendingSupportingContextsByBoundary.set(boundary.key, [
                  ...(pendingSupportingContextsByBoundary.get(boundary.key) ??
                    []),
                  supportingContext
                ]);
              } else {
                await markProjected(sourceIds);
              }
              continue;
            }

            if (tokenUsage) {
              for (const scope of ["last", "total"] as const) {
                const breakdown = tokenUsage[scope];
                if (!breakdown) {
                  continue;
                }
                await this.recordWorkflowTokenUsage(
                  { userId: actor.userId },
                  {
                    visibility: row.visibility,
                    workflowType:
                      stringField(row.metadata ?? {}, "workflow") ??
                      "conversation_projection",
                    workflowId:
                      stringField(row.metadata ?? {}, "questionId") ??
                      stringField(row.metadata ?? {}, "nodeId") ??
                      logicalItem.sourceIdentity,
                    sessionId: row.session_id ?? undefined,
                    turnId: row.turn_id ?? undefined,
                    conversationItemId: sourceIds[0],
                    sourceRuntime:
                      row.source_kind === "codex-cli" ? "codex-cli" : "codex",
                    sourceKind: row.source_kind,
                    sourceAdapterVersion: row.source_adapter_version,
                    usageSource:
                      row.source_transport === "hook"
                        ? "transcript"
                        : "app_server",
                    usageAccuracy:
                      scope === "last"
                        ? "provider_reported"
                        : "provider_replayed",
                    usageKind:
                      scope === "last" ? "turn_delta" : "cumulative_snapshot",
                    connectorClient: row.source_kind,
                    model:
                      stringField(row.metadata ?? {}, "model") ?? undefined,
                    modelContextWindow: tokenUsage.modelContextWindow,
                    usageScope: scope,
                    ...breakdown,
                    metadata: {
                      rawConversationItemId: sourceIds[0],
                      rawConversationItemIds: sourceIds,
                      logicalSourceId: logicalItem.sourceIdentity
                    },
                    idempotencyKey: providerTokenUsageIdempotencyKey({
                      sessionId: row.session_id,
                      turnId: row.turn_id,
                      scope,
                      occurrenceIdentity: logicalItem.sourceIdentity
                    })
                  }
                );
                result.tokenUsageRowsCreated += 1;
              }
            }
            if (transcriptTokenUsage) {
              const threadKind =
                stringField(row.metadata ?? {}, "threadKind") ??
                stringField(row.session_metadata ?? {}, "threadKind");
              const workflowType =
                threadKind === "subagent" ? "subagent_turn" : "main_agent_turn";
              await this.recordWorkflowTokenUsage(
                { userId: actor.userId },
                {
                  visibility: row.visibility,
                  workflowType,
                  workflowId:
                    stringField(row.metadata ?? {}, "transcriptId") ??
                    row.turn_id ??
                    row.session_id ??
                    logicalItem.sourceIdentity,
                  sessionId: row.session_id ?? undefined,
                  turnId: row.turn_id ?? undefined,
                  conversationItemId: sourceIds[0],
                  sourceRuntime:
                    row.source_kind === "codex-cli" ? "codex-cli" : "codex",
                  sourceKind: row.source_kind,
                  sourceAdapterVersion: row.source_adapter_version,
                  usageSource: "transcript",
                  usageAccuracy: "provider_reported",
                  usageKind: "turn_delta",
                  connectorClient: row.source_kind,
                  model:
                    transcriptTokenUsage.model ??
                    stringField(row.metadata ?? {}, "model") ??
                    undefined,
                  modelContextWindow: transcriptTokenUsage.modelContextWindow,
                  inputTokens: transcriptTokenUsage.inputTokens,
                  cachedInputTokens: transcriptTokenUsage.cachedInputTokens,
                  outputTokens: transcriptTokenUsage.outputTokens,
                  reasoningOutputTokens:
                    transcriptTokenUsage.reasoningOutputTokens,
                  totalTokens: transcriptTokenUsage.totalTokens,
                  usageScope: "last",
                  metadata: {
                    rawConversationItemId: sourceIds[0],
                    rawConversationItemIds: sourceIds,
                    logicalSourceId: logicalItem.sourceIdentity,
                    threadKind: threadKind ?? "conversation",
                    parentThreadId:
                      stringField(row.metadata ?? {}, "parentThreadId") ??
                      stringField(row.session_metadata ?? {}, "parentThreadId"),
                    parentSessionId:
                      stringField(row.metadata ?? {}, "parentSessionId") ??
                      stringField(
                        row.session_metadata ?? {},
                        "parentSessionId"
                      ),
                    transcriptPath: row.source_path,
                    sourceLineNumber: row.source_sequence
                  },
                  idempotencyKey: providerTokenUsageIdempotencyKey({
                    sessionId: row.session_id,
                    turnId: row.turn_id,
                    scope: "last",
                    occurrenceIdentity: logicalItem.sourceIdentity
                  })
                }
              );
              result.tokenUsageRowsCreated += 1;
            }

            if (
              row.session_id &&
              messageRole &&
              content &&
              projectionPolicy.createMessage
            ) {
              const messageContentForStorage = suppressPlaintextDisplayPayloads
                ? ENCRYPTED_MESSAGE_CONTENT
                : content;
              const messageContentJsonForStorage =
                suppressPlaintextDisplayPayloads
                  ? encryptedDisplayPayloadMarker("messages")
                  : row.raw_json;
              const inserted = await runDisplayRowUpsert<{
                id: string;
                inserted: boolean;
              }>(
                `
	              with existing as (
	                update messages
                set
                  turn_id = coalesce($2::uuid, messages.turn_id),
                  role = $5,
                  content = $6,
                  content_json = $7,
                  source_runtime = $8,
                  capture_method = $9,
                  codex_transcript_path = coalesce(
                    $10,
                    messages.codex_transcript_path
                  ),
                  transcript_item_id = coalesce(
                    $11,
                    messages.transcript_item_id
                  ),
                  idempotency_key = coalesce($12, messages.idempotency_key),
                  source_hash = coalesce($13, messages.source_hash),
                  token_count = $14,
                  source_event_time = $15,
                  captured_at = least(messages.captured_at, $16),
                  recall_eligible = $17,
                  projection_policy_key = $18,
                  projection_policy_revision = $19,
                  invalidated_at = null,
                  invalidation_reason = null
                where id = (
                  select id
                  from messages
                  where owner_user_id = $3
                    and visibility = $4::visibility_scope
                    and (
                      ($12::text is not null and idempotency_key = $12)
                      or ($13::text is not null and source_hash = $13)
                      or (
                        $11::text is not null
                        and session_id = $1
                        and transcript_item_id = $11
                      )
                    )
                  order by
                    case
                      when $12::text is not null and idempotency_key = $12 then 0
                      when $13::text is not null and source_hash = $13 then 1
                      when $11::text is not null and transcript_item_id = $11 then 2
                      else 3
                    end,
                    created_at asc,
                    id asc
                  limit 1
                )
                returning id, false as inserted
              ),
              inserted as (
                insert into messages (
                  session_id, turn_id, owner_user_id, visibility,
                  role, content, content_json, source_runtime, capture_method,
                  codex_transcript_path, transcript_item_id, idempotency_key,
                  source_hash, token_count, source_event_time, captured_at,
                  recall_eligible, projection_policy_key,
                  projection_policy_revision
                )
                select
                  $1, $2, $3, $4, $5, $6, $7,
                  $8, $9, $10, $11, $12, $13, $14, $15, $16,
                  $17, $18, $19
                where not exists (select 1 from existing)
                on conflict do nothing
                returning id, true as inserted
              ),
              fallback as (
                select id, false as inserted
                from messages
                where not exists (select 1 from existing)
                  and not exists (select 1 from inserted)
                  and owner_user_id = $3
                  and visibility = $4::visibility_scope
                  and (
                    ($12::text is not null and idempotency_key = $12)
                    or ($13::text is not null and source_hash = $13)
                    or (
                      $11::text is not null
                      and session_id = $1
                      and transcript_item_id = $11
                    )
                  )
                order by
                  case
                    when $12::text is not null and idempotency_key = $12 then 0
                    when $13::text is not null and source_hash = $13 then 1
                    when $11::text is not null and transcript_item_id = $11 then 2
                    else 3
                  end,
                  created_at asc,
                  id asc
                limit 1
              )
              select * from existing
              union all
              select * from inserted
              union all
              select * from fallback
              limit 1
            `,
                [
                  row.session_id,
                  row.turn_id,
                  ownerUserId,
                  row.visibility,
                  messageRole,
                  messageContentForStorage,
                  messageContentJsonForStorage,
                  row.source_kind === "codex-cli" ? "codex-cli" : "codex",
                  captureMethodForConversationItem({
                    sourceTransport: row.source_transport
                  }),
                  row.source_path,
                  projectionTranscriptItemId,
                  `message:${logicalItem.sourceIdentity}`,
                  `message:${logicalItem.sourceHash}`,
                  estimateTokens(content),
                  row.event_time,
                  row.observed_at,
                  projectionPolicy.createMemoryEvent,
                  projectionPolicy.policyKey,
                  projectionPolicySnapshot.revision
                ],
                async (client, message) => {
                  await upsertEncryptedFieldPayloadWithClient(
                    client,
                    { userId: ownerUserId },
                    options.envelopeEncryptionProvider!,
                    {
                      sourceTable: "messages",
                      sourceId: message.id,
                      sourceColumn: "content",
                      plaintext: content,
                      rowFamily: "message",
                      scope: {
                        tenantId: ownerUserId,
                        workspaceId: row.session_workspace_id,
                        objectClass: "message"
                      },
                      aad: {
                        sessionId: row.session_id,
                        transcriptItemId: projectionTranscriptItemId
                      }
                    }
                  );
                  await upsertEncryptedFieldPayloadWithClient(
                    client,
                    { userId: ownerUserId },
                    options.envelopeEncryptionProvider!,
                    {
                      sourceTable: "messages",
                      sourceId: message.id,
                      sourceColumn: "content_json",
                      plaintext: row.raw_json,
                      rowFamily: "message",
                      scope: {
                        tenantId: ownerUserId,
                        workspaceId: row.session_workspace_id,
                        objectClass: "message"
                      },
                      aad: {
                        sessionId: row.session_id,
                        transcriptItemId: projectionTranscriptItemId
                      }
                    }
                  );
                }
              );
              if (inserted.rows.some((message) => message.inserted)) {
                result.messagesCreated += 1;
              }
            }

            if (row.session_id && projectionPolicy.createToolEvent) {
              const raw = isRecord(row.raw_json) ? row.raw_json : {};
              const metadata = row.metadata ?? {};
              const toolCall = isRecord(metadata.toolCall)
                ? metadata.toolCall
                : {};
              const callId = conversationItemToolCallId(metadata, toolCall);
              const linkedToolName = await loadLinkedToolNameForCallId(
                pool,
                row,
                callId
              );
              const toolEventIdentity = conversationItemToolEventIdentity(
                row,
                logicalItem,
                callId
              );
              const toolInput = conversationItemToolInput(raw, toolCall);
              const toolResponse = conversationItemToolResponse(
                raw,
                toolCall,
                content,
                {
                  allowContentFallback:
                    row.source_record_type !== "hook_payload"
                }
              );
              const toolInputForStorage =
                suppressPlaintextDisplayPayloads &&
                toolInput !== null &&
                toolInput !== undefined
                  ? encryptedDisplayPayloadMarker("tool_events")
                  : toolInput;
              const toolResponseForStorage =
                suppressPlaintextDisplayPayloads &&
                toolResponse !== null &&
                toolResponse !== undefined
                  ? encryptedDisplayPayloadMarker("tool_events")
                  : toolResponse;
              const inserted = await runDisplayRowUpsert<{
                id: string;
                inserted: boolean;
              }>(
                `
	              with existing as (
	                update tool_events
                set
                  turn_id = coalesce($2::uuid, tool_events.turn_id),
                  tool_name = case
                    when $5 <> 'tool' or tool_events.tool_name = 'tool'
                      then $5
                    else tool_events.tool_name
                  end,
                  tool_input = coalesce($6::jsonb, tool_events.tool_input),
                  tool_response = coalesce($7::jsonb, tool_events.tool_response),
                  status = coalesce($8, tool_events.status),
                  source_runtime = $9,
                  capture_method = $10,
                  codex_transcript_path = coalesce(
                    $11,
                    tool_events.codex_transcript_path
                  ),
                  transcript_item_id = case
                    when tool_events.transcript_item_id is null then $12
                    when $12::text is null then tool_events.transcript_item_id
                    when tool_events.transcript_item_id ~ '^[0-9]+$'
                      and $12::text ~ '^[0-9]+$'
                      then least(
                        tool_events.transcript_item_id::bigint,
                        $12::bigint
                      )::text
                    else tool_events.transcript_item_id
                  end,
                  idempotency_key = coalesce($13, tool_events.idempotency_key),
                  source_hash = coalesce($14, tool_events.source_hash),
                  source_event_time = least(tool_events.source_event_time, $15),
                  captured_at = least(tool_events.captured_at, $16),
                  started_at = case
                    when $6::jsonb is not null
                      then coalesce(tool_events.started_at, $15)
                    else tool_events.started_at
                  end,
                  completed_at = case
                    when $7::jsonb is not null
                      then coalesce(tool_events.completed_at, $15)
                    else tool_events.completed_at
                  end,
                  invalidated_at = null,
                  invalidation_reason = null
                where id = (
                  select id
                  from tool_events
                  where owner_user_id = $3
                    and visibility = $4::visibility_scope
                    and (
                      ($13::text is not null and idempotency_key = $13)
                      or ($14::text is not null and source_hash = $14)
                      or (
                        $12::text is not null
                        and session_id = $1
                        and transcript_item_id = $12
                      )
                    )
                  order by
                    case
                      when $13::text is not null and idempotency_key = $13 then 0
                      when $14::text is not null and source_hash = $14 then 1
                      else 2
                    end,
                    created_at asc,
                    id asc
                  limit 1
                )
                returning id, false as inserted
              ),
              inserted as (
                insert into tool_events (
                  session_id, turn_id, owner_user_id, visibility,
                  tool_name, tool_input, tool_response, status, source_runtime,
                  capture_method, codex_transcript_path, transcript_item_id,
                  idempotency_key, source_hash, source_event_time, captured_at,
                  started_at, completed_at
                )
                select
                  $1, $2, $3, $4, $5, $6, $7,
                  $8, $9, $10, $11, $12, $13, $14, $15, $16,
                  case when $6::jsonb is not null then $15 else null end,
                  case when $7::jsonb is not null then $15 else null end
                where not exists (select 1 from existing)
                on conflict do nothing
                returning id, true as inserted
              ),
              fallback as (
                select id, false as inserted
                from tool_events
                where not exists (select 1 from existing)
                  and not exists (select 1 from inserted)
                  and owner_user_id = $3
                  and visibility = $4::visibility_scope
                  and (
                    ($13::text is not null and idempotency_key = $13)
                    or ($14::text is not null and source_hash = $14)
                    or (
                      $12::text is not null
                      and session_id = $1
                      and transcript_item_id = $12
                    )
                  )
                order by
                  case
                    when $13::text is not null and idempotency_key = $13 then 0
                    when $14::text is not null and source_hash = $14 then 1
                    else 2
                  end,
                  created_at asc,
                  id asc
                limit 1
              )
              select * from existing
              union all
              select * from inserted
              union all
              select * from fallback
              limit 1
            `,
                [
                  row.session_id,
                  row.turn_id,
                  ownerUserId,
                  row.visibility,
                  conversationItemToolName(
                    raw,
                    metadata,
                    toolCall,
                    linkedToolName
                  ),
                  jsonbParam(toolInputForStorage),
                  jsonbParam(toolResponseForStorage),
                  stringField(metadata, "status") ?? null,
                  row.source_kind === "codex-cli" ? "codex-cli" : "codex",
                  captureMethodForConversationItem({
                    sourceTransport: row.source_transport
                  }),
                  row.source_path,
                  projectionTranscriptItemId,
                  `tool:${toolEventIdentity}`,
                  `tool:${toolEventIdentity}`,
                  row.event_time,
                  row.observed_at
                ],
                async (client, toolEvent) => {
                  if (toolInput !== null && toolInput !== undefined) {
                    await upsertEncryptedFieldPayloadWithClient(
                      client,
                      { userId: ownerUserId },
                      options.envelopeEncryptionProvider!,
                      {
                        sourceTable: "tool_events",
                        sourceId: toolEvent.id,
                        sourceColumn: "tool_input",
                        plaintext: toolInput,
                        rowFamily: "tool_event",
                        scope: {
                          tenantId: ownerUserId,
                          workspaceId: row.session_workspace_id,
                          objectClass: "tool_event"
                        },
                        aad: {
                          sessionId: row.session_id,
                          transcriptItemId: projectionTranscriptItemId
                        }
                      }
                    );
                  }
                  if (toolResponse !== null && toolResponse !== undefined) {
                    await upsertEncryptedFieldPayloadWithClient(
                      client,
                      { userId: ownerUserId },
                      options.envelopeEncryptionProvider!,
                      {
                        sourceTable: "tool_events",
                        sourceId: toolEvent.id,
                        sourceColumn: "tool_response",
                        plaintext: toolResponse,
                        rowFamily: "tool_event",
                        scope: {
                          tenantId: ownerUserId,
                          workspaceId: row.session_workspace_id,
                          objectClass: "tool_event"
                        },
                        aad: {
                          sessionId: row.session_id,
                          transcriptItemId: projectionTranscriptItemId
                        }
                      }
                    );
                  }
                }
              );
              if (inserted.rows.some((toolEvent) => toolEvent.inserted)) {
                result.toolEventsCreated += 1;
              }
            }

            if (turnCompleteSealReason) {
              await flushAgentBundlesForScope(
                boundary.scopeKey,
                turnCompleteSealReason
              );
              await markProjected(sourceIds);
              continue;
            }

            switch (disposition) {
              case "ready_for_semantic_projection": {
                if (!semanticItem || semanticUnitType !== "user_turn") {
                  await markProjected(sourceIds);
                  break;
                }
                await flushAgentBundlesForScope(
                  boundary.scopeKey,
                  "next_user_turn"
                );
                await createSemanticMemoryUnit(
                  "user_turn",
                  [semanticItem],
                  "user_turn"
                );
                await markProjected(sourceIds);
                break;
              }
              case "waiting_for_agent_seal": {
                if (!semanticItem || semanticUnitType !== "agent_turn") {
                  await markProjected(sourceIds);
                  break;
                }
                const queueResult = await queueAgentSemanticItem(semanticItem);
                if (queueResult === "waiting_for_agent_seal") {
                  for (const sourceId of sourceIds) {
                    waitingForAgentSealSourceIds.add(sourceId);
                  }
                }
                break;
              }
              case "raw_only":
              default:
                await markProjected(sourceIds);
            }
          } catch (error) {
            if (
              isRecord(error) &&
              stringField(error, "code") === "projection_policy_changed"
            ) {
              throw error;
            }
            await markProjectionError(sourceIds, error);
          } finally {
            if (projectionLockAcquired) {
              await projectionLockClient.query(
                "select pg_advisory_unlock(hashtextextended($1, 0))",
                [projectionLockKey]
              );
            }
          }
        }
        await flushStaleAgentBundles();
        result.rawItemsWaitingForAgentSeal = [
          ...waitingForAgentSealSourceIds
        ].filter((sourceId) => !projectedStatusSourceIds.has(sourceId)).length;
        const finalPolicyState = await projectionCoordinatorClient.query<{
          revision: string;
        }>(
          "select revision::text as revision from projection_policy_state where id = 1"
        );
        if (
          Number(finalPolicyState.rows[0]?.revision ?? 0) !==
          projectionPolicySnapshot.revision
        ) {
          throw Object.assign(
            new Error(
              "Projection Policy changed during conversation projection"
            ),
            { statusCode: 409, code: "projection_policy_changed" }
          );
        }
        return result;
      } finally {
        if (projectionPolicyLockAcquired) {
          await projectionCoordinatorClient.query(
            "select pg_advisory_unlock_shared(hashtextextended($1, 0))",
            [projectionPolicyLockKey]
          );
        }
        for (const lockKey of [...acquiredProjectionResourceLocks].reverse()) {
          await projectionCoordinatorClient.query(
            "select pg_advisory_unlock(hashtextextended($1, 0))",
            [lockKey]
          );
        }
        projectionCoordinatorClient.release();
      }
    },

    async listPendingLcmDispatchScopes(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
      const pending = await pool.query<{
        owner_user_id: string;
        visibility: "personal";
        work_class: KoedWorkClass;
        pending_memory_event_ids: string[];
        pending_memory_event_generations: string[];
      }>(
        `
          with pending_events as (
            select
              me.owner_user_id,
              me.visibility,
              me.id,
              coalesce(
                processing.work_class,
                'normal_embedding_lcm'
              )::text as work_class,
              coalesce((
                select max(mn.invalidated_at)::text
                from memory_node_sources mns
                join memory_nodes mn on mn.id = mns.memory_node_id
                where mns.memory_event_id = me.id
                  and mn.kind = 'leaf'
                  and mn.invalidated_at is not null
              ), 'new') as dispatch_generation,
              row_number() over (
                partition by me.owner_user_id, me.visibility,
                  coalesce(processing.work_class, 'normal_embedding_lcm')
                order by me.captured_at asc, me.id asc
              ) as pending_rank
            from memory_events me
            left join conversation_projection_processing_outbox processing
              on processing.event_id = me.id
            where me.visibility = 'personal'
              and me.owner_user_id is not null
              and ($2::uuid is null or me.owner_user_id = $2)
              and ($3::text is null or coalesce(
                processing.work_class,
                'normal_embedding_lcm'
              ) = $3)
              and me.invalidated_at is null
              and me.personal_deleted_at is null
              and me.include_in_lcm = true
              and not exists (
                select 1
                from memory_node_sources mns
                join memory_nodes mn on mn.id = mns.memory_node_id
                where mns.memory_event_id = me.id
                  and mn.kind = 'leaf'
                  and mn.invalidated_at is null
                  and mn.personal_deleted_at is null
              )
          )
          select
            owner_user_id,
            visibility,
            work_class,
            array_agg(id order by id) as pending_memory_event_ids,
            array_agg(dispatch_generation order by id) as pending_memory_event_generations
          from pending_events
          where pending_rank <= $4
          group by owner_user_id, visibility, work_class
          order by
            case work_class
              when 'live_capture_projection' then 0
              when 'normal_embedding_lcm' then 1
              else 2
            end,
            min(pending_rank) asc, owner_user_id asc
          limit $1
        `,
        [
          limit,
          input.ownerUserId ?? null,
          input.workClass ?? null,
          lcmCompactionMaxEvents()
        ]
      );
      return pending.rows.map((row) => {
        const pendingMemoryEventIds = [...row.pending_memory_event_ids].sort();
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify(
              pendingMemoryEventIds.map((id, index) => ({
                id,
                generation: row.pending_memory_event_generations[index]
              }))
            )
          )
          .digest("hex");
        return {
          ownerUserId: row.owner_user_id,
          visibility: row.visibility,
          workClass: row.work_class,
          pendingMemoryEventIds,
          dispatchKey: `lcm-dispatch:${row.owner_user_id}:${row.visibility}:${row.work_class}:${fingerprint}`,
          jobId: lcmCompactionQueueJobId(
            row.owner_user_id,
            row.visibility,
            `lcm-dispatch:${row.owner_user_id}:${row.visibility}:${row.work_class}:${fingerprint}`
          )
        };
      });
    },

    async listConversationProjectionActors(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
      const workClass = input.workClass ?? null;
      const result = await pool.query<{ user_id: string }>(
        `
        select user_id
        from (
          select ci.owner_user_id as user_id, min(ci.observed_at) as oldest_at
          from conversation_items ci
          left join sessions s on s.id = ci.session_id
          where ci.projection_status in ('pending', 'error')
            and ci.memory_excluded_at is null
            and ci.personal_deleted_at is null
            and (
              ci.session_id is null
              or (
                s.id is not null
                and s.invalidated_at is null
                and s.personal_deleted_at is null
              )
            )
            and ci.visibility = 'personal'
            and ci.owner_user_id is not null
            and ($1::text is null or ci.projection_work_class = $1)
          group by ci.owner_user_id
        ) projection_actors
        order by oldest_at asc, user_id asc
        limit $2
      `,
        [workClass, limit]
      );
      return result.rows.map((row) => ({ userId: row.user_id }));
    },

    async getConversationProjectionBacklog() {
      const result = await pool.query<{
        live_projection_rows: string;
        historical_import_rows: string;
        historical_import_bytes: string;
        interactive_question_rows: string;
      }>(
        `
        select
          count(*) filter (
            where ci.projection_work_class = 'live_capture_projection'
          )::text as live_projection_rows,
          count(*) filter (
            where ci.projection_work_class = 'historical_import_backfill'
          )::text as historical_import_rows,
          coalesce(sum(
            octet_length(ci.raw_json::text)
            + octet_length(coalesce(ci.raw_text, ''))
            + octet_length(coalesce(ci.transport_chunk_text, ''))
          ) filter (
            where ci.projection_work_class = 'historical_import_backfill'
          ), 0)::text as historical_import_bytes,
          (
            select count(*)::text
            from memory_questions
            where visibility = 'personal' and status = 'pending'
          ) as interactive_question_rows
        from conversation_items ci
        left join sessions s on s.id = ci.session_id
        where ci.projection_status in ('pending', 'error')
          and ci.memory_excluded_at is null
          and ci.personal_deleted_at is null
          and (
            ci.session_id is null
            or (
              s.id is not null
              and s.invalidated_at is null
              and s.personal_deleted_at is null
            )
          )
      `
      );
      const row = result.rows[0];
      return {
        liveProjectionRows: Number(row?.live_projection_rows ?? 0),
        historicalImportRows: Number(row?.historical_import_rows ?? 0),
        historicalImportBytes: Number(row?.historical_import_bytes ?? 0),
        interactiveQuestionRows: Number(row?.interactive_question_rows ?? 0)
      } satisfies ConversationProjectionBacklog;
    },

    async tryAcquireHistoricalProjectionLease() {
      const client = await pool.connect();
      try {
        const acquired = await client.query<{ acquired: boolean }>(
          "select pg_try_advisory_lock($1::bigint) as acquired",
          [historicalProjectionAdvisoryLockId]
        );
        if (!acquired.rows[0]?.acquired) {
          client.release();
          return null;
        }
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            try {
              await client.query("select pg_advisory_unlock($1::bigint)", [
                historicalProjectionAdvisoryLockId
              ]);
            } finally {
              client.release();
            }
          }
        };
      } catch (error) {
        client.release(true);
        throw error;
      }
    },

    async listPendingConversationProjectionProcessing(limit = 1000) {
      const boundedLimit = Math.min(Math.max(limit, 1), 5000);
      const result = await pool.query<{
        event_id: string;
        owner_user_id: string;
        visibility: Visibility;
        work_class: KoedWorkClass;
        include_in_embedding: boolean;
        include_in_lcm: boolean;
        source_event_time: Date | null;
      }>(
        `
        select event_id, owner_user_id, visibility, work_class,
          include_in_embedding, include_in_lcm, source_event_time
        from conversation_projection_processing_outbox
        where dispatched_at is null
        order by
          case work_class
            when 'live_capture_projection' then 0
            when 'normal_embedding_lcm' then 1
            else 2
          end,
          case when work_class = 'historical_import_backfill'
            then source_event_time end desc nulls last,
          case when work_class <> 'historical_import_backfill'
            then created_at end asc,
          event_id asc
        limit $1
      `,
        [boundedLimit]
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        userId: row.owner_user_id,
        visibility: row.visibility,
        workClass: row.work_class,
        includeInEmbedding: row.include_in_embedding,
        includeInLcm: row.include_in_lcm,
        sourceEventTime: row.source_event_time?.toISOString() ?? null
      }));
    },

    async markConversationProjectionProcessingDispatched(eventIds) {
      if (eventIds.length === 0) {
        return 0;
      }
      const result = await pool.query(
        `
        update conversation_projection_processing_outbox
        set dispatched_at = now()
        where event_id = any($1::uuid[])
          and dispatched_at is null
      `,
        [eventIds]
      );
      return result.rowCount ?? 0;
    },

    async listSemanticMemoryRebuildActors(input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
      const result = await pool.query<{ user_id: string }>(
        `
        select owner_user_id as user_id
        from semantic_memory_rebuild_jobs
        where status in ('pending', 'error')
          and scheduled_after <= now()
          and visibility = 'personal'
          and (
            processing_lease_until is null
            or processing_lease_until < now()
          )
        group by owner_user_id
        order by min(scheduled_after) asc, owner_user_id asc
        limit $1
      `,
        [limit]
      );
      return result.rows.map((row) => ({ userId: row.user_id }));
    },

    async processDueSemanticMemoryRebuilds(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
      const leaseSeconds = Math.min(
        Math.max(input.leaseSeconds ?? 300, 30),
        3600
      );
      const result: SemanticMemoryRebuildResult = {
        jobsClaimed: 0,
        jobsCompleted: 0,
        jobsFailed: 0,
        memoryEventsCreated: 0,
        memoryEventIds: [],
        memoryEventScopes: []
      };
      const claimed = await pool.query<{
        id: string;
        memory_event_id: string;
      }>(
        `
        with candidates as (
          select id
          from semantic_memory_rebuild_jobs
          where owner_user_id = $1
            and visibility = 'personal'
            and status in ('pending', 'error')
            and scheduled_after <= now()
            and (
              processing_lease_until is null
              or processing_lease_until < now()
            )
          order by scheduled_after asc, id asc
          limit $2
          for update skip locked
        )
        update semantic_memory_rebuild_jobs job
        set
          status = 'processing',
          processing_started_at = now(),
          processing_lease_until = now() + ($3::int * interval '1 second'),
          attempt_count = attempt_count + 1,
          last_error_message = null,
          updated_at = now()
        from candidates
        where job.id = candidates.id
        returning job.id, job.memory_event_id
      `,
        [actor.userId, limit, leaseSeconds]
      );
      result.jobsClaimed = claimed.rows.length;

      for (const job of claimed.rows) {
        const projectionPolicyClient = await pool.connect();
        try {
          await projectionPolicyClient.query(
            "select pg_advisory_lock_shared(hashtextextended($1, 0))",
            ["conversation-projection-policy"]
          );
          const created = await rebuiltSemanticMemoryEventsFromSources(
            pool,
            options.envelopeEncryptionProvider,
            {
              actorUserId: actor.userId,
              memoryEventId: job.memory_event_id,
              createMemoryEvent: (eventActor, eventInput) =>
                this.createMemoryEvent(eventActor, eventInput)
            }
          );
          const eventIds = created.map((event) => event.eventId);
          await Promise.all(
            created.map((event) =>
              pool.query(
                `
                insert into conversation_projection_processing_outbox (
                  event_id, owner_user_id, visibility, work_class,
                  include_in_embedding, include_in_lcm
                )
                values ($1, $2, $3, 'normal_embedding_lcm', $4, $5)
                on conflict (event_id) do nothing
              `,
                [
                  event.eventId,
                  actor.userId,
                  event.visibility,
                  event.includeInEmbedding,
                  event.includeInLcm
                ]
              )
            )
          );
          await pool.query(
            `
            update semantic_memory_rebuild_jobs
            set
              status = 'completed',
              processing_lease_until = null,
              replacement_memory_event_ids = $2::uuid[],
              last_error_message = null,
              updated_at = now()
            where id = $1
          `,
            [job.id, eventIds]
          );
          result.jobsCompleted += 1;
          result.memoryEventsCreated += eventIds.length;
          result.memoryEventIds.push(...eventIds);
          result.memoryEventScopes.push(
            ...created.map((event) => ({
              eventId: event.eventId,
              visibility: event.visibility,
              includeInEmbedding: event.includeInEmbedding,
              includeInLcm: event.includeInLcm,
              workClass: "normal_embedding_lcm" as const,
              sourceEventTime: null
            }))
          );
        } catch (error) {
          await pool.query(
            `
            update semantic_memory_rebuild_jobs
            set
              status = 'error',
              scheduled_after = now() + interval '1 minute',
              processing_lease_until = null,
              last_error_message = $2,
              updated_at = now()
            where id = $1
          `,
            [job.id, error instanceof Error ? error.message : String(error)]
          );
          result.jobsFailed += 1;
        } finally {
          await projectionPolicyClient.query(
            "select pg_advisory_unlock_shared(hashtextextended($1, 0))",
            ["conversation-projection-policy"]
          );
          projectionPolicyClient.release();
        }
      }

      return result;
    },

    async getLcmGraphOverview(actor) {
      const [embeddingStatus, counts, embeddings] = await Promise.all([
        this.getLocalEmbeddingStatus(),
        pool.query<{
          captured_events: string;
          leaf_nodes: string;
          rollup_nodes: string;
          pending_summaries: string;
          oldest_pending_summary_created_at: Date | null;
          invalidated_records: string;
        }>(
          `
          with visible_nodes as (
            select *
            from memory_nodes mn
            where mn.visibility = 'personal'
              and mn.owner_user_id = $1
          ),
          visible_events as (
            select *
            from memory_events me
            where me.visibility = 'personal'
              and me.owner_user_id = $1
          )
          select
            (select count(*) from visible_events where invalidated_at is null)::text as captured_events,
            (select count(*) from visible_nodes where kind = 'leaf' and invalidated_at is null)::text as leaf_nodes,
            (select count(*) from visible_nodes where kind = 'rollup' and invalidated_at is null)::text as rollup_nodes,
            (select count(*) from visible_nodes where kind in ('leaf', 'rollup') and summary_model is null and invalidated_at is null)::text as pending_summaries,
            (select min(created_at) from visible_nodes where kind in ('leaf', 'rollup') and summary_model is null and invalidated_at is null) as oldest_pending_summary_created_at,
            (
              (select count(*) from visible_events where invalidated_at is not null)
              + (select count(*) from visible_nodes where invalidated_at is not null)
            )::text as invalidated_records
        `,
          [actor.userId]
        ),
        pool.query<{
          total: string;
          memory_nodes: string;
          memory_events: string;
          messages: string;
        }>(
          `
          select
            count(*)::text as total,
            count(*) filter (where memory_node_id is not null)::text as memory_nodes,
            count(*) filter (where memory_event_id is not null)::text as memory_events,
            count(*) filter (where message_id is not null)::text as messages
          from memory_embeddings me
          where me.invalidated_at is null and me.personal_deleted_at is null
            and (
              exists (
                select 1 from memory_nodes mn
                where mn.id = me.memory_node_id
                  and (
                    mn.visibility = 'personal' and mn.owner_user_id = $1
                  )
              )
              or exists (
                select 1 from memory_events ev
                where ev.id = me.memory_event_id
                  and (
                    ev.visibility = 'personal' and ev.owner_user_id = $1
                  )
              )
              or exists (
                select 1 from messages msg
                where msg.id = me.message_id
                  and (
                    msg.visibility = 'personal' and msg.owner_user_id = $1
                  )
              )
            )
        `,
          [actor.userId]
        )
      ]);
      const row = counts.rows[0]!;
      const embeddingRow = embeddings.rows[0]!;
      const pendingCount = Number(row.pending_summaries);
      const oldestPendingCreatedAt =
        row.oldest_pending_summary_created_at?.toISOString() ?? null;
      const staleThresholdMinutes = 15;
      const stale =
        oldestPendingCreatedAt !== null &&
        Date.now() - Date.parse(oldestPendingCreatedAt) >
          staleThresholdMinutes * 60_000;
      return {
        capturedEvents: Number(row.captured_events),
        leafNodes: Number(row.leaf_nodes),
        rollupNodes: Number(row.rollup_nodes),
        pendingSummaries: pendingCount,
        pendingLcmDiagnostics: {
          pendingCount,
          oldestPendingCreatedAt,
          staleThresholdMinutes,
          stale
        },
        invalidatedRecords: Number(row.invalidated_records),
        embeddings: {
          enabled: embeddingStatus.enabled,
          healthy: embeddingStatus.healthy,
          model: embeddingStatus.model,
          dimensions: embeddingStatus.dimensions,
          total: Number(embeddingRow.total),
          memoryNodes: Number(embeddingRow.memory_nodes),
          memoryEvents: Number(embeddingRow.memory_events),
          messages: Number(embeddingRow.messages)
        }
      };
    },

    async listLcmGraphNodes(actor, input = {}) {
      const teamWorkspaceAccess = input.teamWorkspaceId
        ? await this.getTeamWorkspaceAccess(actor, input.teamWorkspaceId)
        : null;
      const teamWorkspaceAuthorization = resolveTeamWorkspaceAuthorization({
        requesterUserId: actor.userId,
        teamWorkspaceId: input.teamWorkspaceId,
        access: teamWorkspaceAccess
      });
      if (
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        !teamWorkspaceAuthorization.authorized
      ) {
        return [];
      }
      const teamWorkspaceBoundary: TeamWorkspaceReadBoundary =
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        teamWorkspaceAuthorization.authorized
          ? {
              teamWorkspaceId: teamWorkspaceAuthorization.teamWorkspaceId,
              teamId: teamWorkspaceAuthorization.teamId
            }
          : null;
      const nodeIds = input.nodeIds?.filter(Boolean) ?? [];
      const limit = nodeIds.length
        ? Math.min(nodeIds.length, 500)
        : Math.min(Math.max(input.limit ?? 100, 1), 500);
      const result = await pool.query<Parameters<typeof mapLcmGraphNode>[0]>(
        `
        select
          mn.id, mn.owner_user_id, mn.visibility, mn.kind, mn.depth,
          mn.summary_text, mn.created_at, mn.updated_at, mn.invalidated_at,
          mn.invalidation_reason, mn.source_event_count, mn.source_token_estimate,
          mn.summary_token_estimate, mn.summary_model, mn.summary_prompt_version,
          mn.summary_structured_json, mn.summary_structured_schema_version,
          mn.lcm_algorithm_version, mn.summary_corrected_at,
          mn.summary_corrected_by_user_id,
          case
            when $9::uuid is null then coalesce(
              s.project_override_id,
              s.automatic_project_id,
              case when s.id is null then ev.payload ->> 'workspaceId' end,
              'unassigned'
            )
            else $9::text
          end as project_id,
          case
            when $9::uuid is null then coalesce(
              s.project_override_name,
              s.automatic_project_name,
              case when s.id is null then ev.payload #>> '{metadata,projectName}' end,
              'Unassigned'
            )
            else 'Team Workspace'
          end as project_name,
          case
            when $9::uuid is null then coalesce(
              s.project_override_path,
              s.automatic_project_path,
              case when s.id is null then ev.payload #>> '{metadata,projectPath}' end
            )
            else null::text
          end as project_path,
          s.id::text as session_id,
          coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) as thread_id,
          coalesce(s.metadata ->> 'threadName', ev.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text) as thread_name,
          count(me.id)::text as embedding_count
        from memory_nodes mn
        left join lateral (
          select mns.memory_event_id
          from memory_node_sources mns
          where mns.memory_node_id = mn.id and mns.memory_event_id is not null
          order by mns.source_order asc
          limit 1
        ) first_source on true
        left join memory_events ev on ev.id = first_source.memory_event_id
        left join sessions s on s.id = ev.session_id
        left join memory_embeddings me on me.memory_node_id = mn.id and me.invalidated_at is null and me.personal_deleted_at is null
        where mn.kind in ('leaf', 'rollup')
          and ($2::boolean = true or mn.invalidated_at is null)
          and ($3::visibility_scope is null or mn.visibility = $3::visibility_scope)
          and (
            $4::text is null
            or (
              $9::uuid is null
              and (
                coalesce(
                  s.project_override_id,
                  s.automatic_project_id,
                  case when s.id is null then ev.payload ->> 'workspaceId' end,
                  'unassigned'
                ) = $4
                or coalesce(s.project_override_path, s.automatic_project_path) = $4
              )
            )
            or ($9::uuid is not null and $9::text = $4)
          )
          and ($5::text is null or coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) = $5)
          and ($6::text is null or mn.summary_text ilike '%' || $6 || '%' or mn.id::text = $6)
          and ($7::uuid[] is null or mn.id = any($7::uuid[]))
          and mn.visibility = 'personal'
          and (
            ($9::uuid is null and mn.owner_user_id = $1 and ($2::boolean = true or mn.personal_deleted_at is null))
            or (
              $9::uuid is not null
              and exists (
                select 1
                from memory_node_sources auth_any_mns
                where auth_any_mns.memory_node_id = mn.id
              )
              and not exists (
                select 1
                from memory_node_sources auth_mns
                left join memory_events auth_ev on auth_ev.id = auth_mns.memory_event_id and auth_ev.invalidated_at is null
                left join messages auth_msg on auth_msg.id = auth_mns.message_id and auth_msg.invalidated_at is null
                where auth_mns.memory_node_id = mn.id
                  and not exists (
                    select 1
                    from team_session_share_grants auth_grant
                    where auth_grant.session_id = coalesce(auth_ev.session_id, auth_msg.session_id)
                      and auth_grant.team_workspace_id = $9::uuid
                      and auth_grant.team_id = $10::uuid
                      and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                  )
              )
            )
          )
        group by mn.id, ev.id, s.id
        order by mn.updated_at desc, mn.created_at desc
        limit $8
      `,
        [
          actor.userId,
          input.includeInvalidated ?? false,
          input.visibility ?? null,
          input.projectId ?? null,
          input.threadId ?? null,
          input.query?.trim() || null,
          nodeIds.length ? nodeIds : null,
          limit,
          teamWorkspaceBoundary?.teamWorkspaceId ?? null,
          teamWorkspaceBoundary?.teamId ?? null
        ]
      );
      const hydratedRows = await hydrateMemoryNodeRows(
        pool,
        options.envelopeEncryptionProvider,
        result.rows
      );
      return hydratedRows.map(mapLcmGraphNode);
    },

    async getLcmGraphNode(actor, nodeId, input = {}) {
      const nodes = await this.listLcmGraphNodes(actor, {
        includeInvalidated: input.includeInvalidated,
        teamWorkspaceId: input.teamWorkspaceId,
        nodeIds: [nodeId],
        limit: 1
      });
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return null;
      }
      const [fullNode, childRows, parentRows, sourceRows] = await Promise.all([
        pool.query<{
          id: string;
          owner_user_id: string | null;
          source_items_json: LcmSourceItem[];
        }>(
          "select id, owner_user_id, source_items_json from memory_nodes where id = $1",
          [nodeId]
        ),
        pool.query<{ child_memory_node_id: string }>(
          `
          select child_memory_node_id
          from memory_node_children
          where parent_memory_node_id = $1
          order by child_order asc
        `,
          [nodeId]
        ),
        pool.query<{ parent_memory_node_id: string }>(
          `
          select parent_memory_node_id
          from memory_node_children
          where child_memory_node_id = $1
          order by created_at asc
        `,
          [nodeId]
        ),
        pool.query<{ memory_event_id: string }>(
          `
          select memory_event_id
          from memory_node_sources
          where memory_node_id = $1 and memory_event_id is not null
          order by source_order asc
        `,
          [nodeId]
        )
      ]);
      const visibleNodes = await this.listLcmGraphNodes(actor, {
        includeInvalidated: true,
        teamWorkspaceId: input.teamWorkspaceId,
        limit: 500
      });
      const visibleNodeById = new Map(
        visibleNodes.map((item) => [item.id, item])
      );
      const [sources] = await Promise.all([
        Promise.all(
          sourceRows.rows.map((row) =>
            this.getLcmGraphEvent(actor, row.memory_event_id, {
              teamWorkspaceId: input.teamWorkspaceId,
              includeInvalidated: true,
              includeRaw: false
            })
          )
        )
      ]);
      const childNodes = childRows.rows
        .map((row) => visibleNodeById.get(row.child_memory_node_id))
        .filter((candidate): candidate is LcmGraphNode => Boolean(candidate));
      const parentNodes = parentRows.rows
        .map((row) => visibleNodeById.get(row.parent_memory_node_id))
        .filter((candidate): candidate is LcmGraphNode => Boolean(candidate));
      const hydratedFullNode = fullNode.rows[0]
        ? await hydrateMemoryNodeRow(
            pool,
            options.envelopeEncryptionProvider,
            fullNode.rows[0]
          )
        : null;
      return {
        ...node,
        sourceItems: Array.isArray(hydratedFullNode?.source_items_json)
          ? hydratedFullNode.source_items_json
          : [],
        childNodes,
        parentNodes,
        sources: sources.filter((candidate): candidate is LcmGraphEvent =>
          Boolean(candidate)
        )
      };
    },

    async updateLcmGraphNode(actor, nodeId, input) {
      const existing = await this.getLcmGraphNode(actor, nodeId, {
        includeInvalidated: false
      });
      if (!existing) {
        return null;
      }
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
      if (
        suppressPlaintextPayload &&
        input.summaryText !== undefined &&
        !options.envelopeEncryptionProvider
      ) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Node storage is disabled"
        );
      }
      const summaryTextForStorage =
        suppressPlaintextPayload && input.summaryText !== undefined
          ? ENCRYPTED_MEMORY_NODE_TEXT
          : input.summaryText;
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
          update memory_nodes
          set
            summary_text = coalesce($3, summary_text),
            body_text = case when $3::text is null then body_text else $3 end,
            summary_corrected_at = case when $3::text is null then summary_corrected_at else now() end,
            summary_corrected_by_user_id = case when $3::text is null then summary_corrected_by_user_id else $1 end,
            visibility = coalesce($4::visibility_scope, visibility),
            owner_user_id = case
              when $4::visibility_scope = 'personal' then $1
              else owner_user_id
            end,
            updated_at = now()
          where id = $2 and invalidated_at is null
        `,
          [
            actor.userId,
            nodeId,
            summaryTextForStorage ?? null,
            input.visibility ?? null
          ]
        );
        if (
          suppressPlaintextPayload &&
          input.summaryText !== undefined &&
          options.envelopeEncryptionProvider
        ) {
          await persistEncryptedMemoryNodeFields(
            client,
            options.envelopeEncryptionProvider,
            {
              ownerUserId: actor.userId,
              visibility: input.visibility ?? existing.visibility,
              nodeId,
              summaryText: input.summaryText,
              bodyText: input.summaryText
            }
          );
        }
        if (input.summaryText !== undefined) {
          await client.query(
            `
            update memory_embeddings
            set invalidated_at = now(), invalidation_reason = 'lcm_summary_corrected'
            where memory_node_id = $1 and invalidated_at is null
          `,
            [nodeId]
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return this.getLcmGraphNode(actor, nodeId, { includeInvalidated: false });
    },

    async invalidateLcmGraphNode(actor, nodeId) {
      return this.deleteMemory(actor, nodeId);
    },

    async listLcmGraphEvents(actor, input = {}) {
      const teamWorkspaceAccess = input.teamWorkspaceId
        ? await this.getTeamWorkspaceAccess(actor, input.teamWorkspaceId)
        : null;
      const teamWorkspaceAuthorization = resolveTeamWorkspaceAuthorization({
        requesterUserId: actor.userId,
        teamWorkspaceId: input.teamWorkspaceId,
        access: teamWorkspaceAccess
      });
      if (
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        !teamWorkspaceAuthorization.authorized
      ) {
        return [];
      }
      const teamWorkspaceBoundary: TeamWorkspaceReadBoundary =
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        teamWorkspaceAuthorization.authorized
          ? {
              teamWorkspaceId: teamWorkspaceAuthorization.teamWorkspaceId,
              teamId: teamWorkspaceAuthorization.teamId
            }
          : null;
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      const result = await pool.query<Parameters<typeof mapLcmGraphEvent>[0]>(
        `
        with cursor_order as (
          select coalesce(
            $9::bigint,
            (
              select cursor_event.source_sequence
              from (
                select me.id, me.source_sequence
                from memory_events me
                where me.visibility = 'personal'
                  and (
                    ($12::uuid is null and me.owner_user_id = $1)
                    or (
                      $12::uuid is not null
                      and exists (
                        select 1
                        from team_session_share_grants cursor_grant
                        where cursor_grant.session_id = me.session_id
                          and cursor_grant.team_workspace_id = $12::uuid
                          and cursor_grant.team_id = $13::uuid
                      and cursor_grant.revoked_at is null and sync_session_recall_ready(cursor_grant.session_id)
                      )
                    )
                  )
                union all
                select
                  msg.id,
                  case
                    when msg.transcript_item_id ~ '^[0-9]+$'
                      then msg.transcript_item_id::bigint
                    else null::bigint
                  end as source_sequence
                from messages msg
                where msg.visibility = 'personal'
                  and (
                    ($12::uuid is null and msg.owner_user_id = $1)
                    or (
                      $12::uuid is not null
                      and exists (
                        select 1
                        from team_session_share_grants cursor_grant
                        where cursor_grant.session_id = msg.session_id
                          and cursor_grant.team_workspace_id = $12::uuid
                          and cursor_grant.team_id = $13::uuid
                          and cursor_grant.revoked_at is null and sync_session_recall_ready(cursor_grant.session_id)
                      )
                    )
                  )
                union all
                select
                  te.id,
                  case
                    when te.transcript_item_id ~ '^[0-9]+$'
                      then te.transcript_item_id::bigint
                    else null::bigint
                  end as source_sequence
                from tool_events te
                where te.visibility = 'personal'
                  and (
                    ($12::uuid is null and te.owner_user_id = $1)
                    or (
                      $12::uuid is not null
                      and exists (
                        select 1
                        from team_session_share_grants cursor_grant
                        where cursor_grant.session_id = te.session_id
                          and cursor_grant.team_workspace_id = $12::uuid
                          and cursor_grant.team_id = $13::uuid
                          and cursor_grant.revoked_at is null and sync_session_recall_ready(cursor_grant.session_id)
                      )
                    )
                  )
              ) cursor_event
              where cursor_event.id = $10::uuid
              limit 1
            )
          ) as source_sequence
        ),
        visible_events as (
          select
            me.id,
            me.owner_user_id,
            case
              when coalesce(me.payload #>> '{metadata,threadKind}', s.metadata ->> 'threadKind') = 'subagent'
                and me.payload ->> 'actor' = 'assistant'
                then 'subagent'
              when coalesce(me.payload #>> '{metadata,threadKind}', s.metadata ->> 'threadKind') = 'subagent'
                and me.payload ->> 'actor' = 'user'
                then 'agent'
              when me.payload #>> '{metadata,transcriptType}' = 'agent_message'
                and me.payload ->> 'actor' = 'assistant'
                then 'agent'
              else me.payload ->> 'actor'
            end as actor,
            coalesce(me.payload ->> 'rawEventType', me.payload ->> 'eventType', me.event_type::text) as event_type,
            me.source_runtime,
            me.capture_method,
            s.model,
            case
              when $12::uuid is null then coalesce(
                case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end,
                s.workspace_id::text,
                s.cwd
              )
              else $12::text
            end as workspace_id,
            case
              when $12::uuid is null then coalesce(
                s.project_override_id,
                s.automatic_project_id,
                case when s.id is null then me.payload ->> 'workspaceId' end,
                'unassigned'
              )
              else $12::text
            end as project_id,
            case
              when $12::uuid is null then coalesce(
                s.project_override_name,
                s.automatic_project_name,
                case when s.id is null then me.payload #>> '{metadata,projectName}' end,
                'Unassigned'
              )
              else 'Team Workspace'
            end as project_name,
            case
              when $12::uuid is null then coalesce(
                s.project_override_path,
                s.automatic_project_path,
                case when s.id is null then me.payload #>> '{metadata,projectPath}' end
              )
              else null::text
            end as project_path,
            s.id::text as session_id,
            coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) as thread_id,
            coalesce(s.metadata ->> 'threadName', me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            me.source_event_time,
            me.source_sequence,
            me.captured_at,
            me.created_at,
            coalesce(me.source_event_time, me.captured_at) as order_at,
            me.visibility,
            me.invalidated_at,
            me.invalidation_reason,
            me.payload ->> 'content' as content,
            jsonb_build_object('sourceTable', 'memory_events') ||
              case
                when $12::uuid is null then coalesce(me.payload -> 'metadata', '{}'::jsonb)
                else coalesce(me.payload -> 'metadata', '{}'::jsonb)
                  - 'projectPath' - 'cwd' - 'localProjectId' - 'projectId'
              end as metadata
          from memory_events me
          cross join cursor_order co
          left join sessions s on s.id = me.session_id
          where ($2::boolean = true or me.invalidated_at is null)
            and (
              $6::uuid is not null
              or $12::uuid is not null
              or me.session_id is null
            )
            and ($3::visibility_scope is null or me.visibility = $3::visibility_scope)
            and (
              $4::text is null
              or (
                $12::uuid is null
                and (
                  coalesce(
                    s.project_override_id,
                    s.automatic_project_id,
                    case when s.id is null then me.payload ->> 'workspaceId' end,
                    'unassigned'
                  ) = $4
                  or coalesce(s.project_override_path, s.automatic_project_path) = $4
                )
              )
              or ($12::uuid is not null and $12::text = $4)
            )
            and ($5::text is null or coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) = $5)
            and ($6::uuid is null or me.id = $6)
            and ($7::text is null or me.payload ->> 'content' ilike '%' || $7 || '%' or me.id::text = $7)
            and (
              $8::timestamptz is null
              or coalesce(me.source_event_time, me.captured_at) < $8::timestamptz
              or (
                coalesce(me.source_event_time, me.captured_at) = $8::timestamptz
                and (
                  (
                    co.source_sequence is null
                    and me.source_sequence is null
                    and $10::uuid is not null
                    and me.id < $10::uuid
                  )
                  or (
                    co.source_sequence is not null
                    and me.source_sequence is not null
                    and me.source_sequence < co.source_sequence
                  )
                  or (
                    co.source_sequence is not null
                    and me.source_sequence = co.source_sequence
                    and $10::uuid is not null
                    and me.id < $10::uuid
                  )
                  or (
                    co.source_sequence is not null
                    and me.source_sequence is null
                  )
                )
              )
            )
            and me.visibility = 'personal'
            and (
              ($12::uuid is null and me.owner_user_id = $1 and ($2::boolean = true or me.personal_deleted_at is null))
              or (
                $12::uuid is not null
                and exists (
                  select 1
                  from team_session_share_grants auth_grant
                  where auth_grant.session_id = me.session_id
                    and auth_grant.team_workspace_id = $12::uuid
                    and auth_grant.team_id = $13::uuid
                    and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                )
              )
            )
          union all
          select
            msg.id,
            msg.owner_user_id,
            case
              when coalesce(s.metadata ->> 'threadKind') = 'subagent'
                and msg.role = 'assistant'
                then 'subagent'
              when coalesce(s.metadata ->> 'threadKind') = 'subagent'
                and msg.role = 'user'
                then 'agent'
              when msg.role = 'assistant'
                then 'agent'
              else msg.role
            end as actor,
            'message'::text as event_type,
            msg.source_runtime,
            msg.capture_method,
            s.model,
            case
              when $12::uuid is null then coalesce(s.metadata ->> 'workspaceId', s.workspace_id::text, s.cwd)
              else $12::text
            end as workspace_id,
            case
              when $12::uuid is null then coalesce(s.project_override_id, s.automatic_project_id, 'unassigned')
              else $12::text
            end as project_id,
            case
              when $12::uuid is null then coalesce(s.project_override_name, s.automatic_project_name, 'Unassigned')
              else 'Team Workspace'
            end as project_name,
            case
              when $12::uuid is null then coalesce(s.project_override_path, s.automatic_project_path)
              else null::text
            end as project_path,
            s.id::text as session_id,
            coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) as thread_id,
            coalesce(s.metadata ->> 'threadName', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            msg.source_event_time,
            case
              when msg.transcript_item_id ~ '^[0-9]+$'
                then msg.transcript_item_id::bigint
              else null::bigint
            end as source_sequence,
            msg.captured_at,
            msg.created_at,
            coalesce(msg.source_event_time, msg.captured_at) as order_at,
            msg.visibility,
            msg.invalidated_at,
            msg.invalidation_reason,
            msg.content,
            jsonb_build_object(
              'sourceTable', 'messages',
              'role', msg.role,
              'transcriptItemId', msg.transcript_item_id,
              'displaySource', 'message'
            ) as metadata
          from messages msg
          cross join cursor_order co
          join sessions s on s.id = msg.session_id
          where ($2::boolean = true or msg.invalidated_at is null)
            and msg.role <> 'tool'
            and ($3::visibility_scope is null or msg.visibility = $3::visibility_scope)
            and (
              $4::text is null
              or (
                $12::uuid is null
                and (
                  coalesce(s.project_override_id, s.automatic_project_id, 'unassigned') = $4
                  or coalesce(s.project_override_path, s.automatic_project_path) = $4
                )
              )
              or ($12::uuid is not null and $12::text = $4)
            )
            and ($5::text is null or coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) = $5)
            and ($6::uuid is null or msg.id = $6)
            and ($7::text is null or msg.content ilike '%' || $7 || '%' or msg.id::text = $7)
            and (
              $8::timestamptz is null
              or coalesce(msg.source_event_time, msg.captured_at) < $8::timestamptz
              or (
                coalesce(msg.source_event_time, msg.captured_at) = $8::timestamptz
                and (
                  (
                    co.source_sequence is null
                    and (
                      case
                        when msg.transcript_item_id ~ '^[0-9]+$'
                          then msg.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) is null
                    and $10::uuid is not null
                    and msg.id < $10::uuid
                  )
                  or (
                    co.source_sequence is not null
                    and (
                      case
                        when msg.transcript_item_id ~ '^[0-9]+$'
                          then msg.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) is not null
                    and (
                      case
                        when msg.transcript_item_id ~ '^[0-9]+$'
                          then msg.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) < co.source_sequence
                  )
                  or (
                    co.source_sequence is not null
                    and (
                      case
                        when msg.transcript_item_id ~ '^[0-9]+$'
                          then msg.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) = co.source_sequence
                    and $10::uuid is not null
                    and msg.id < $10::uuid
                  )
                  or (
                    co.source_sequence is not null
                    and (
                      case
                        when msg.transcript_item_id ~ '^[0-9]+$'
                          then msg.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) is null
                  )
                )
              )
            )
            and msg.visibility = 'personal'
            and (
              ($12::uuid is null and msg.owner_user_id = $1)
              or (
                $12::uuid is not null
                and exists (
                  select 1
                  from team_session_share_grants auth_grant
                  where auth_grant.session_id = msg.session_id
                    and auth_grant.team_workspace_id = $12::uuid
                    and auth_grant.team_id = $13::uuid
                    and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                )
              )
            )
          union all
          select
            te.id,
            te.owner_user_id,
            'tool'::text as actor,
            case
              when te.tool_response is not null then 'tool_result'
              else 'tool_call'
            end as event_type,
            te.source_runtime,
            te.capture_method,
            s.model,
            case
              when $12::uuid is null then coalesce(s.metadata ->> 'workspaceId', s.workspace_id::text, s.cwd)
              else $12::text
            end as workspace_id,
            case
              when $12::uuid is null then coalesce(s.project_override_id, s.automatic_project_id, 'unassigned')
              else $12::text
            end as project_id,
            case
              when $12::uuid is null then coalesce(s.project_override_name, s.automatic_project_name, 'Unassigned')
              else 'Team Workspace'
            end as project_name,
            case
              when $12::uuid is null then coalesce(s.project_override_path, s.automatic_project_path)
              else null::text
            end as project_path,
            s.id::text as session_id,
            coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) as thread_id,
            coalesce(s.metadata ->> 'threadName', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            te.source_event_time,
            case
              when te.transcript_item_id ~ '^[0-9]+$'
                then te.transcript_item_id::bigint
              else null::bigint
            end as source_sequence,
            te.captured_at,
            te.created_at,
            coalesce(te.source_event_time, te.captured_at) as order_at,
            te.visibility,
            te.invalidated_at,
            te.invalidation_reason,
            concat_ws(
              E'\n\n',
              'Tool call: ' || te.tool_name,
              case
                when te.tool_input is null then null
                else 'Input:' || E'\n' || regexp_replace(te.tool_input::text, '([,:]) ', '\\1', 'g')
              end,
              case
                when te.tool_response is null then null
                when jsonb_typeof(te.tool_response) = 'string' then 'Output:' || E'\n' || (te.tool_response #>> '{}')
                else 'Output:' || E'\n' || regexp_replace(te.tool_response::text, '([,:]) ', '\\1', 'g')
              end
            ) as content,
            jsonb_build_object(
              'sourceTable', 'tool_events',
              'toolName', te.tool_name,
              'toolCallId', te.transcript_item_id,
              'input', te.tool_input,
              'output', te.tool_response,
              'status', te.status,
              'displaySource', 'tool_event',
              'toolCall', jsonb_strip_nulls(jsonb_build_object(
                'id', te.transcript_item_id,
                'name', te.tool_name,
                'input', te.tool_input,
                'output', te.tool_response,
                'status', te.status
              ))
            ) as metadata
          from tool_events te
          cross join cursor_order co
          join sessions s on s.id = te.session_id
          where ($2::boolean = true or te.invalidated_at is null)
            and ($3::visibility_scope is null or te.visibility = $3::visibility_scope)
            and (
              $4::text is null
              or (
                $12::uuid is null
                and (
                  coalesce(s.project_override_id, s.automatic_project_id, 'unassigned') = $4
                  or coalesce(s.project_override_path, s.automatic_project_path) = $4
                )
              )
              or ($12::uuid is not null and $12::text = $4)
            )
            and ($5::text is null or coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) = $5)
            and ($6::uuid is null or te.id = $6)
            and (
              $7::text is null
              or te.tool_name ilike '%' || $7 || '%'
              or te.tool_input::text ilike '%' || $7 || '%'
              or te.tool_response::text ilike '%' || $7 || '%'
              or te.id::text = $7
            )
            and (
              $8::timestamptz is null
              or coalesce(te.source_event_time, te.captured_at) < $8::timestamptz
              or (
                coalesce(te.source_event_time, te.captured_at) = $8::timestamptz
                and (
                  (
                    co.source_sequence is null
                    and (
                      case
                        when te.transcript_item_id ~ '^[0-9]+$'
                          then te.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) is null
                    and $10::uuid is not null
                    and te.id < $10::uuid
                  )
                  or (
                    co.source_sequence is not null
                    and (
                      case
                        when te.transcript_item_id ~ '^[0-9]+$'
                          then te.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) is not null
                    and (
                      case
                        when te.transcript_item_id ~ '^[0-9]+$'
                          then te.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) < co.source_sequence
                  )
                  or (
                    co.source_sequence is not null
                    and (
                      case
                        when te.transcript_item_id ~ '^[0-9]+$'
                          then te.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) = co.source_sequence
                    and $10::uuid is not null
                    and te.id < $10::uuid
                  )
                  or (
                    co.source_sequence is not null
                    and (
                      case
                        when te.transcript_item_id ~ '^[0-9]+$'
                          then te.transcript_item_id::bigint
                        else null::bigint
                      end
                    ) is null
                  )
                )
              )
            )
            and te.visibility = 'personal'
            and (
              ($12::uuid is null and te.owner_user_id = $1)
              or (
                $12::uuid is not null
                and exists (
                  select 1
                  from team_session_share_grants auth_grant
                  where auth_grant.session_id = te.session_id
                    and auth_grant.team_workspace_id = $12::uuid
                    and auth_grant.team_id = $13::uuid
                    and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                )
              )
            )
        )
        select
          ve.*,
          coalesce(linked_node_ids.linked_node_ids, array[]::text[]) as linked_node_ids
        from visible_events ve
        left join lateral (
          select array_agg(mns.memory_node_id::text order by mns.source_order) as linked_node_ids
          from memory_node_sources mns
          where mns.memory_event_id = ve.id
            or mns.message_id = ve.id
            or mns.tool_event_id = ve.id
        ) linked_node_ids on true
        order by ve.order_at desc, ve.source_sequence desc nulls last, ve.id desc
        limit $11
	      `,
        [
          actor.userId,
          input.includeInvalidated ?? false,
          input.visibility ?? null,
          input.projectId ?? null,
          input.threadId ?? null,
          input.eventId ?? null,
          input.query?.trim() || null,
          input.cursorTimestamp ?? null,
          input.cursorSourceSequence ?? null,
          input.cursorId ?? null,
          limit,
          teamWorkspaceBoundary?.teamWorkspaceId ?? null,
          teamWorkspaceBoundary?.teamId ?? null
        ]
      );
      const hydratedRows = await Promise.all(
        result.rows.map(async (row) => {
          if (
            row.metadata?.sourceTable === "messages" &&
            row.content === ENCRYPTED_MESSAGE_CONTENT
          ) {
            if (!options.envelopeEncryptionProvider) {
              throw new Error(
                "Envelope encryption provider is required to expand encrypted messages"
              );
            }
            const content = await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id ?? null,
                sourceTable: "messages",
                sourceId: row.id,
                sourceColumn: "content"
              }
            );
            const contentJson = await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id ?? null,
                sourceTable: "messages",
                sourceId: row.id,
                sourceColumn: "content_json"
              }
            );
            if (typeof content !== "string" || contentJson === null) {
              throw new Error("Encrypted message source is missing");
            }
            return {
              ...row,
              content,
              metadata: {
                ...row.metadata,
                contentJson
              }
            };
          }
          if (row.metadata?.sourceTable === "tool_events") {
            const metadata = row.metadata ?? {};
            const encryptedInput = isEncryptedDisplayPayloadMarker(
              metadata.input,
              "tool_events"
            );
            const encryptedOutput = isEncryptedDisplayPayloadMarker(
              metadata.output,
              "tool_events"
            );
            if (encryptedInput || encryptedOutput) {
              if (!options.envelopeEncryptionProvider) {
                throw new Error(
                  "Envelope encryption provider is required to expand encrypted tool events"
                );
              }
              const inputPayload = encryptedInput
                ? await decryptAuthorizedEncryptedFieldPayload(
                    pool,
                    options.envelopeEncryptionProvider,
                    {
                      ownerUserId: row.owner_user_id ?? null,
                      sourceTable: "tool_events",
                      sourceId: row.id,
                      sourceColumn: "tool_input"
                    }
                  )
                : metadata.input;
              const outputPayload = encryptedOutput
                ? await decryptAuthorizedEncryptedFieldPayload(
                    pool,
                    options.envelopeEncryptionProvider,
                    {
                      ownerUserId: row.owner_user_id ?? null,
                      sourceTable: "tool_events",
                      sourceId: row.id,
                      sourceColumn: "tool_response"
                    }
                  )
                : metadata.output;
              if (
                (encryptedInput && inputPayload === null) ||
                (encryptedOutput && outputPayload === null)
              ) {
                throw new Error("Encrypted tool event source is missing");
              }
              const toolName =
                typeof metadata.toolName === "string"
                  ? metadata.toolName
                  : "tool";
              return {
                ...row,
                content: formatToolEventContent(
                  toolName,
                  inputPayload,
                  outputPayload
                ),
                metadata: {
                  ...metadata,
                  input: inputPayload,
                  output: outputPayload,
                  toolCall: {
                    ...(isRecord(metadata.toolCall) ? metadata.toolCall : {}),
                    input: inputPayload,
                    output: outputPayload
                  }
                }
              };
            }
          }
          if (
            row.metadata?.sourceTable !== "memory_events" ||
            (row.content && row.content !== ENCRYPTED_MEMORY_EVENT_TEXT) ||
            !options.envelopeEncryptionProvider
          ) {
            return row;
          }
          const payload = await decryptAuthorizedMemoryEventPayload(
            pool,
            options.envelopeEncryptionProvider,
            {
              ownerUserId: row.owner_user_id ?? null,
              memoryEventId: row.id
            }
          );
          return payload?.content
            ? {
                ...row,
                content: payload.content,
                actor: row.actor ?? payload.actor ?? null,
                metadata: {
                  ...row.metadata,
                  ...payload.metadata,
                  sourceTable: "memory_events"
                }
              }
            : row;
        })
      );
      return hydratedRows.map((row) =>
        mapLcmGraphEvent({
          ...row,
          metadata: teamWorkspaceBoundary
            ? redactLocalProjectMetadata(row.metadata)
            : row.metadata,
          includeContent: input.includeContent ?? false,
          includeRaw: input.includeRaw ?? false
        })
      );
    },

    async listLcmGraphThreads(actor, input = {}) {
      const teamWorkspaceAccess = input.teamWorkspaceId
        ? await this.getTeamWorkspaceAccess(actor, input.teamWorkspaceId)
        : null;
      const teamWorkspaceAuthorization = resolveTeamWorkspaceAuthorization({
        requesterUserId: actor.userId,
        teamWorkspaceId: input.teamWorkspaceId,
        access: teamWorkspaceAccess
      });
      if (
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        !teamWorkspaceAuthorization.authorized
      ) {
        return [];
      }
      const teamWorkspaceBoundary: TeamWorkspaceReadBoundary =
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        teamWorkspaceAuthorization.authorized
          ? {
              teamWorkspaceId: teamWorkspaceAuthorization.teamWorkspaceId,
              teamId: teamWorkspaceAuthorization.teamId
            }
          : null;
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
      const offset = Math.max(input.offset ?? 0, 0);
      const result = await pool.query<
        Parameters<typeof mapLcmGraphThreadRow>[0]
      >(
        `
        with visible_thread_rows as (
          select
            me.id::text as id,
            'event' as row_kind,
            case
              when $9::uuid is null then coalesce(
                s.project_override_id,
                s.automatic_project_id,
                case when s.id is null then me.payload ->> 'workspaceId' end,
                'unassigned'
              )
              else $9::text
            end as project_id,
            case
              when $9::uuid is null then coalesce(
                s.project_override_name,
                s.automatic_project_name,
                case when s.id is null then me.payload #>> '{metadata,projectName}' end,
                'Unassigned'
              )
              else 'Team Workspace'
            end as project_name,
            case
              when $9::uuid is null then coalesce(
                s.project_override_path,
                s.automatic_project_path,
                case when s.id is null then me.payload #>> '{metadata,projectPath}' end
              )
              else null::text
            end as project_path,
            case
              when $9::uuid is null and s.project_override_id is not null then 'user_override'
              when $9::uuid is null and s.automatic_project_id is not null then 'detected'
              else null
            end as project_assignment_source,
            case
              when $9::uuid is null then coalesce(s.captured_project_provenance, '{}'::jsonb)
              else '{}'::jsonb
            end as captured_project_provenance,
            coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) as thread_id,
            coalesce(s.metadata ->> 'threadName', me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            me.session_id,
            coalesce(s.source_runtime, me.source_runtime) as source_ai_client,
            case
              when coalesce(me.payload #>> '{metadata,threadKind}', s.metadata ->> 'threadKind') = 'subagent'
                then 'subagent'
              else 'conversation'
            end as thread_kind,
            coalesce(
              me.payload #>> '{metadata,parentThreadId}',
              me.payload #>> '{metadata,parentExternalSessionId}',
              s.metadata ->> 'parentThreadId',
              s.metadata ->> 'parentExternalSessionId'
            ) as parent_thread_id,
            coalesce(
              me.payload #>> '{metadata,parentSessionId}',
              s.metadata ->> 'parentSessionId'
            ) as parent_session_id,
            coalesce(me.source_event_time, me.captured_at) as event_order_at,
            me.captured_at,
            coalesce(me.source_event_time, me.captured_at) as order_at,
            me.source_sequence,
            me.invalidated_at,
            me.payload ->> 'content' as content
          from memory_events me
          left join sessions s on s.id = me.session_id
          where ($2::boolean = true or me.invalidated_at is null)
            and ($3::visibility_scope is null or me.visibility = $3::visibility_scope)
            and (
              $4::text is null
              or (
                $9::uuid is null
                and (
                  coalesce(
                    s.project_override_id,
                    s.automatic_project_id,
                    case when s.id is null then me.payload ->> 'workspaceId' end,
                    'unassigned'
                  ) = $4
                  or coalesce(s.project_override_path, s.automatic_project_path) = $4
                )
              )
              or ($9::uuid is not null and $9::text = $4)
            )
            and ($5::text is null or coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) = $5)
            and (
              $6::text is null
              or me.payload ->> 'content' ilike '%' || $6 || '%'
              or me.id::text = $6
              or coalesce(s.metadata ->> 'threadName', me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') ilike '%' || $6 || '%'
              or case
                when $9::uuid is null then coalesce(s.project_override_name, s.automatic_project_name, 'Unassigned')
                else 'Team Workspace'
              end ilike '%' || $6 || '%'
            )
            and me.visibility = 'personal'
            and (
              ($9::uuid is null and me.owner_user_id = $1 and ($2::boolean = true or me.personal_deleted_at is null))
              or (
                $9::uuid is not null
                and exists (
                  select 1
                  from team_session_share_grants auth_grant
                  where auth_grant.session_id = me.session_id
                    and auth_grant.team_workspace_id = $9::uuid
                    and auth_grant.team_id = $10::uuid
                    and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                )
              )
            )
          union all
          select
            s.id::text as id,
            'session' as row_kind,
            case
              when $9::uuid is null then coalesce(s.project_override_id, s.automatic_project_id, 'unassigned')
              else $9::text
            end as project_id,
            case
              when $9::uuid is null then coalesce(s.project_override_name, s.automatic_project_name, 'Unassigned')
              else 'Team Workspace'
            end as project_name,
            case
              when $9::uuid is null then coalesce(s.project_override_path, s.automatic_project_path)
              else null::text
            end as project_path,
            case
              when $9::uuid is null and s.project_override_id is not null then 'user_override'
              when $9::uuid is null and s.automatic_project_id is not null then 'detected'
              else null
            end as project_assignment_source,
            case
              when $9::uuid is null then s.captured_project_provenance
              else '{}'::jsonb
            end as captured_project_provenance,
            coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) as thread_id,
            coalesce(s.metadata ->> 'threadName', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            s.id as session_id,
            s.source_runtime as source_ai_client,
            case
              when s.metadata ->> 'threadKind' = 'subagent' then 'subagent'
              else 'conversation'
            end as thread_kind,
            coalesce(s.metadata ->> 'parentThreadId', s.metadata ->> 'parentExternalSessionId') as parent_thread_id,
            s.metadata ->> 'parentSessionId' as parent_session_id,
            null::timestamptz as event_order_at,
            s.created_at as captured_at,
            s.created_at as order_at,
            null::bigint as source_sequence,
            s.invalidated_at,
            null::text as content
          from sessions s
          where ($2::boolean = true or s.invalidated_at is null)
            and ($3::visibility_scope is null or s.visibility = $3::visibility_scope)
            and (
              $4::text is null
              or (
                $9::uuid is null
                and (
                  coalesce(s.project_override_id, s.automatic_project_id, 'unassigned') = $4
                  or coalesce(s.project_override_path, s.automatic_project_path) = $4
                )
              )
              or ($9::uuid is not null and $9::text = $4)
            )
            and ($5::text is null or coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) = $5)
            and (
              $6::text is null
              or s.id::text = $6
              or coalesce(s.metadata ->> 'threadName', s.external_session_id, s.id::text, 'Untitled conversation') ilike '%' || $6 || '%'
              or case
                when $9::uuid is null then coalesce(s.project_override_name, s.automatic_project_name, 'Unassigned')
                else 'Team Workspace'
              end ilike '%' || $6 || '%'
            )
            and s.visibility = 'personal'
            and (
              ($9::uuid is null and s.owner_user_id = $1)
              or (
                $9::uuid is not null
                and exists (
                  select 1
                  from team_session_share_grants auth_grant
                  where auth_grant.session_id = s.id
                    and auth_grant.team_workspace_id = $9::uuid
                    and auth_grant.team_id = $10::uuid
                    and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                )
              )
            )
        ),
        ranked_threads as (
          select
            project_id,
            (array_agg(project_name order by order_at desc, source_sequence desc nulls last, id desc))[1] as project_name,
            (array_agg(project_path order by order_at desc, source_sequence desc nulls last, id desc))[1] as project_path,
            (array_agg(project_assignment_source order by order_at desc, source_sequence desc nulls last, id desc))[1] as project_assignment_source,
            (array_agg(captured_project_provenance order by order_at desc, source_sequence desc nulls last, id desc))[1] as captured_project_provenance,
            thread_id,
            (array_agg(thread_name order by order_at desc, source_sequence desc nulls last, id desc))[1] as thread_name,
            (array_agg(session_id order by order_at desc, source_sequence desc nulls last, id desc) filter (where session_id is not null))[1] as session_id,
            (array_agg(source_ai_client order by order_at desc, source_sequence desc nulls last, id desc) filter (where session_id is not null and source_ai_client is not null))[1] as source_ai_client,
            (array_agg(thread_kind order by order_at desc, source_sequence desc nulls last, id desc))[1] as thread_kind,
            (array_agg(parent_thread_id order by order_at desc, source_sequence desc nulls last, id desc) filter (where parent_thread_id is not null))[1] as parent_thread_id,
            (array_agg(parent_session_id order by order_at desc, source_sequence desc nulls last, id desc) filter (where parent_session_id is not null))[1] as parent_session_id,
            count(*) filter (where row_kind = 'event')::text as event_count,
            count(*) filter (where row_kind = 'event' and invalidated_at is not null)::text as invalidated_count,
            coalesce(
              max(event_order_at) filter (where row_kind = 'event'),
              max(order_at)
            ) as latest_at,
            coalesce((array_agg(content order by order_at desc, source_sequence desc nulls last, id desc) filter (where content is not null))[1], '') as sample
          from visible_thread_rows
          group by project_id, thread_id
          order by coalesce(
            max(event_order_at) filter (where row_kind = 'event'),
            max(order_at)
          ) desc, thread_id desc
          limit $7 offset $8
        )
        select *
        from ranked_threads
        order by latest_at desc, thread_id desc
      `,
        [
          actor.userId,
          input.includeInvalidated ?? false,
          input.visibility ?? null,
          input.projectId ?? null,
          input.threadId ?? null,
          input.query?.trim() || null,
          limit,
          offset,
          teamWorkspaceBoundary?.teamWorkspaceId ?? null,
          teamWorkspaceBoundary?.teamId ?? null
        ]
      );

      const threadRows = await Promise.all(
        result.rows.map(async (row) => {
          if (row.sample && row.sample !== ENCRYPTED_MESSAGE_CONTENT) {
            return row;
          }
          const latestEvents = await this.listLcmGraphEvents(actor, {
            includeInvalidated: input.includeInvalidated,
            visibility: input.visibility,
            projectId: input.projectId,
            threadId: row.thread_id,
            query: input.query,
            includeContent: true,
            teamWorkspaceId: input.teamWorkspaceId,
            limit: 1
          });
          return {
            ...row,
            sample: latestEvents[0]?.content ?? row.sample
          };
        })
      );
      const projects = new Map<string, LcmGraphProjectThreads>();
      for (const thread of threadRows.map(mapLcmGraphThreadRow)) {
        const project = projects.get(thread.projectId) ?? {
          id: thread.projectId,
          name: thread.projectName,
          path: thread.projectPath,
          eventCount: 0,
          threads: []
        };
        project.eventCount += thread.eventCount;
        project.threads.push({
          id: thread.id,
          name: thread.name,
          sessionId: thread.sessionId,
          sourceAiClient: thread.sourceAiClient,
          projectId: thread.projectId,
          projectName: thread.projectName,
          projectPath: thread.projectPath,
          projectAssignmentSource: thread.projectAssignmentSource,
          capturedProjectProvenance: thread.capturedProjectProvenance,
          eventCount: thread.eventCount,
          invalidatedCount: thread.invalidatedCount,
          latestAt: thread.latestAt,
          sample: thread.sample,
          threadKind: thread.threadKind,
          parentThreadId: thread.parentThreadId,
          parentSessionId: thread.parentSessionId
        });
        projects.set(project.id, project);
      }

      return [...projects.values()];
    },

    async getLcmGraphEvent(actor, eventId, input = {}) {
      const events = await this.listLcmGraphEvents(actor, {
        eventId,
        teamWorkspaceId: input.teamWorkspaceId,
        includeInvalidated: input.includeInvalidated,
        includeRaw: input.includeRaw,
        limit: 1
      });
      const event = events.find((candidate) => candidate.id === eventId);
      return event
        ? {
            ...event,
            ...(input.includeRaw
              ? {
                  rawContent:
                    event.rawContent ??
                    (
                      await pool.query<{ content: string | null }>(
                        "select payload ->> 'content' as content from memory_events where id = $1",
                        [eventId]
                      )
                    ).rows[0]?.content ??
                    ""
                }
              : {})
          }
        : null;
    },

    async updateLcmGraphEvent(actor, eventId, input) {
      const existing = await this.getLcmGraphEvent(actor, eventId, {
        includeInvalidated: false
      });
      if (!existing) {
        return null;
      }
      const sourceTable =
        typeof existing.metadata.sourceTable === "string"
          ? existing.metadata.sourceTable
          : "memory_events";
      const updateTable =
        sourceTable === "messages" || sourceTable === "tool_events"
          ? sourceTable
          : "memory_events";
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
          update ${updateTable}
          set
            visibility = coalesce($3::visibility_scope, visibility),
            owner_user_id = case
              when $3::visibility_scope = 'personal' then $1
              else owner_user_id
            end,
            invalidated_at = case when $4::boolean = true then coalesce(invalidated_at, now()) else invalidated_at end,
            invalidation_reason = case when $4::boolean = true then coalesce(invalidation_reason, 'user_deleted') else invalidation_reason end
          where id = $2
        `,
          [
            actor.userId,
            eventId,
            input.visibility ?? null,
            input.invalidated ?? null
          ]
        );
        if (input.invalidated) {
          if (updateTable === "memory_events") {
            await client.query(
              `
              update memory_events
              set updated_at = now()
              where id = $1
            `,
              [eventId]
            );
          }
          await recordAuditEventWithClient(client, {
            actorUserId: actor.userId,
            ownerUserId: actor.userId,
            visibility: input.visibility ?? existing.visibility,
            action: "memory_event.invalidated",
            targetTable: "memory_events",
            targetId: eventId,
            metadata: {
              eventType: existing.eventType,
              projectId: existing.projectId,
              projectName: existing.projectName,
              sessionId: existing.sessionId,
              threadId: existing.threadId,
              threadName: existing.threadName,
              captureMethod: existing.captureMethod,
              sourceRuntime: existing.sourceRuntime
            }
          });
          await suppressCuratedMemoryWithoutActiveEvidenceWithClient(
            client,
            actor,
            options.envelopeEncryptionProvider
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      if (input.invalidated) {
        if (updateTable === "memory_events") {
          await invalidateDerivedMemoryForMemoryEvents(pool, [eventId]);
        } else {
          await invalidateSemanticMemoryForDisplayEvent(pool, {
            actorUserId: actor.userId,
            eventId,
            sourceTable: updateTable
          });
          if (updateTable === "messages") {
            await pool.query(
              `
              update memory_embeddings
              set invalidated_at = now(), invalidation_reason = 'source_event_deleted'
              where message_id = $1 and invalidated_at is null
            `,
              [eventId]
            );
          }
        }
      }
      return this.getLcmGraphEvent(actor, eventId, {
        includeInvalidated: Boolean(input.invalidated)
      });
    },

    async invalidateLcmGraphEvent(actor, eventId) {
      const updated = await this.updateLcmGraphEvent(actor, eventId, {
        invalidated: true
      });
      return Boolean(updated);
    },

    async exportMemoryRecords(actor) {
      const overview = await this.getLcmGraphOverview(actor);
      const nodes = await this.listLcmGraphNodes(actor, {
        includeInvalidated: true,
        limit: 500
      });
      const events = await this.listLcmGraphEvents(actor, {
        includeInvalidated: true,
        limit: 500
      });
      const curatedMemory =
        await curatedMemoryRepository.exportCuratedMemoryRecords(actor);
      return {
        exportedAt: new Date().toISOString(),
        overview,
        nodes: (
          await Promise.all(
            nodes.map((node) =>
              this.getLcmGraphNode(actor, node.id, { includeInvalidated: true })
            )
          )
        ).filter((node): node is LcmGraphNodeDetail => Boolean(node)),
        events,
        curatedMemory
      };
    },

    async listSourcesNeedingEmbeddings(limit = 100) {
      const embeddingTable = embeddingTableForDimensions(
        localEmbeddingDimensions()
      );
      const result = await pool.query<{
        source_type: EmbeddableSourceType;
        source_id: string;
        owner_user_id: string | null;
        visibility: Visibility;
        source_hash: string | null;
        text: string | null;
        work_class: KoedWorkClass;
        reconciliation_job_id: string | null;
      }>(
        `
        with sources as (
          select
            'memory_node'::text as source_type,
            mn.id as source_id,
            mn.owner_user_id,
            mn.visibility,
            mn.source_hash,
            mn.work_class,
            null::text as reconciliation_job_id,
            null::timestamptz as source_event_time,
            case
              when mn.body_text is null
                or btrim(mn.body_text) = ''
                or btrim(mn.body_text) = btrim(mn.summary_text)
              then btrim(mn.summary_text)
              else btrim(mn.summary_text || ' ' || mn.body_text)
            end as text,
            mn.created_at
          from memory_nodes mn
          where mn.invalidated_at is null and mn.personal_deleted_at is null

          union all

          select
            'memory_event'::text as source_type,
            me.id as source_id,
            me.owner_user_id,
            me.visibility,
            me.source_hash,
            coalesce(
              processing.work_class,
              'normal_embedding_lcm'
            )::text as work_class,
            case when processing.event_id is not null
              then 'projection-embed-' || me.id::text
              else null end as reconciliation_job_id,
            processing.source_event_time,
            case
              when me.include_in_embedding = false
                then ''
              else coalesce(
                me.payload #>> '{metadata,embeddingContent}',
                me.payload ->> 'content',
                ''
              )
            end as text,
            me.captured_at as created_at
          from memory_events me
          left join conversation_projection_processing_outbox processing
            on processing.event_id = me.id
          where me.invalidated_at is null and me.personal_deleted_at is null
        )
        select source_type, source_id, owner_user_id, visibility, source_hash,
          text, work_class, reconciliation_job_id
        from sources s
        where (
            length(trim(coalesce(s.text, ''))) > 0
            or (
              s.source_type = 'memory_event'
              and coalesce((
                select source_event.include_in_embedding::text
                from memory_events source_event
                where source_event.id = s.source_id
              ), 'true') <> 'false'
              and exists (
                select 1
                from encrypted_field_payloads encrypted
                where encrypted.owner_user_id = s.owner_user_id
                  and encrypted.source_table = 'memory_events'
                  and encrypted.source_id = s.source_id
                  and encrypted.source_column = 'payload'
                  and encrypted.invalidated_at is null
              )
            )
            or (
              s.source_type = 'memory_node'
              and exists (
                select 1
                from encrypted_field_payloads encrypted
                where encrypted.owner_user_id = s.owner_user_id
                  and encrypted.source_table = 'memory_nodes'
                  and encrypted.source_id = s.source_id
                  and encrypted.source_column = 'summary_text'
                  and encrypted.invalidated_at is null
              )
            )
          )
          and not exists (
            select 1
            from memory_embeddings me
            join ${embeddingTable} vectors on vectors.memory_embedding_id = me.id
            where me.invalidated_at is null and me.personal_deleted_at is null
              and me.embedding_model = $1
              and me.embedding_dimensions = $2
              and me.embedding_version = $3
              and me.source_hash = coalesce(
                s.source_hash,
                encode(
                  digest(
                    s.source_type || ':' || s.source_id::text || ':' || s.text,
                    'sha256'
                  ),
                  'hex'
                )
              )
              and (
                (s.source_type = 'memory_node' and me.memory_node_id = s.source_id)
                or (s.source_type = 'memory_event' and me.memory_event_id = s.source_id)
              )
            group by me.source_hash
            having count(*) = max(me.source_chunk_count)
              and count(distinct me.source_chunk_index) = max(me.source_chunk_count)
              and min(me.source_chunk_index) = 0
              and max(me.source_chunk_index) = max(me.source_chunk_count) - 1
              and min(me.source_chunk_count) = max(me.source_chunk_count)
          )
        order by
          case s.work_class
            when 'live_capture_projection' then 0
            when 'normal_embedding_lcm' then 1
            else 2
          end,
          case when s.work_class = 'historical_import_backfill'
            then s.source_event_time end desc nulls last,
          case when s.work_class <> 'historical_import_backfill'
            or s.source_event_time is null then s.created_at end asc,
          s.source_id asc
        limit $4
      `,
        [
          localEmbeddingModel(),
          localEmbeddingDimensions(),
          localEmbeddingVersion(),
          limit
        ]
      );

      const hydratedRows = await Promise.all(
        result.rows.map(async (row) => {
          if (row.source_type === "memory_node") {
            if (
              row.text !== ENCRYPTED_MEMORY_NODE_TEXT &&
              !row.text?.includes(ENCRYPTED_MEMORY_NODE_TEXT)
            ) {
              return row;
            }
            if (!options.envelopeEncryptionProvider) {
              throw new Error(
                "Envelope encryption provider is required to embed encrypted Memory Nodes"
              );
            }
            const summaryText = await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id,
                sourceTable: "memory_nodes",
                sourceId: row.source_id,
                sourceColumn: "summary_text"
              }
            );
            const bodyText = await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id,
                sourceTable: "memory_nodes",
                sourceId: row.source_id,
                sourceColumn: "body_text"
              }
            );
            const text =
              typeof bodyText === "string" &&
              bodyText.trim() &&
              bodyText.trim() !== String(summaryText).trim()
                ? `${summaryText} ${bodyText}`
                : summaryText;
            return {
              ...row,
              text: typeof text === "string" ? text : row.text
            };
          }
          if (
            row.source_type !== "memory_event" ||
            (row.text && row.text !== ENCRYPTED_MEMORY_EVENT_TEXT) ||
            !options.envelopeEncryptionProvider
          ) {
            return row;
          }
          const payload = await decryptAuthorizedMemoryEventPayload(
            pool,
            options.envelopeEncryptionProvider,
            {
              ownerUserId: row.owner_user_id,
              memoryEventId: row.source_id
            }
          );
          return {
            ...row,
            text: memoryEventEmbeddingContent(payload) ?? row.text
          };
        })
      );

      return hydratedRows
        .filter((row) => row.text && row.text.trim().length > 0)
        .map((row) => ({
          sourceType: row.source_type,
          sourceId: row.source_id,
          ownerUserId: row.owner_user_id,
          visibility: row.visibility,
          text: row.text!,
          sourceHash:
            row.source_hash ??
            sourceHash(row.source_type, row.source_id, row.text!),
          workClass: row.work_class,
          ...(row.reconciliation_job_id
            ? { reconciliationJobId: row.reconciliation_job_id }
            : {})
        }));
    },

    async getEmbeddableSource(sourceType, sourceId) {
      const result = await pool.query<{
        source_type: EmbeddableSourceType;
        source_id: string;
        owner_user_id: string | null;
        visibility: Visibility;
        source_hash: string | null;
        text: string | null;
      }>(
        `
        with sources as (
          select
            'memory_node'::text as source_type,
            mn.id as source_id,
            mn.owner_user_id,
            mn.visibility,
            mn.source_hash,
            case
              when mn.body_text is null
                or btrim(mn.body_text) = ''
                or btrim(mn.body_text) = btrim(mn.summary_text)
              then btrim(mn.summary_text)
              else btrim(mn.summary_text || ' ' || mn.body_text)
            end as text
          from memory_nodes mn
          where mn.invalidated_at is null and mn.personal_deleted_at is null

          union all

          select
            'memory_event'::text as source_type,
            me.id as source_id,
            me.owner_user_id,
            me.visibility,
            me.source_hash,
            case
              when me.include_in_embedding = false
                then ''
              else coalesce(
                me.payload #>> '{metadata,embeddingContent}',
                me.payload ->> 'content',
                ''
              )
            end as text
          from memory_events me
          where me.invalidated_at is null and me.personal_deleted_at is null
        )
        select source_type, source_id, owner_user_id, visibility, source_hash, text
        from sources
        where source_type = $1
          and source_id = $2
          and (
            length(trim(coalesce(text, ''))) > 0
            or (
              source_type = 'memory_event'
              and coalesce((
                select source_event.include_in_embedding::text
                from memory_events source_event
                where source_event.id = sources.source_id
              ), 'true') <> 'false'
              and exists (
                select 1
                from encrypted_field_payloads encrypted
                where encrypted.owner_user_id = sources.owner_user_id
                  and encrypted.source_table = 'memory_events'
                  and encrypted.source_id = sources.source_id
                  and encrypted.source_column = 'payload'
                  and encrypted.invalidated_at is null
              )
            )
            or (
              source_type = 'memory_node'
              and exists (
                select 1
                from encrypted_field_payloads encrypted
                where encrypted.owner_user_id = sources.owner_user_id
                  and encrypted.source_table = 'memory_nodes'
                  and encrypted.source_id = sources.source_id
                  and encrypted.source_column = 'summary_text'
                  and encrypted.invalidated_at is null
              )
            )
          )
        limit 1
      `,
        [sourceType, sourceId]
      );
      const rawRow = result.rows[0];
      const row =
        rawRow?.source_type === "memory_node" &&
        (rawRow.text === ENCRYPTED_MEMORY_NODE_TEXT ||
          rawRow.text?.includes(ENCRYPTED_MEMORY_NODE_TEXT))
          ? {
              ...rawRow,
              text: await (async () => {
                if (!options.envelopeEncryptionProvider) {
                  throw new Error(
                    "Envelope encryption provider is required to embed encrypted Memory Nodes"
                  );
                }
                const summaryText =
                  await decryptAuthorizedEncryptedFieldPayload(
                    pool,
                    options.envelopeEncryptionProvider,
                    {
                      ownerUserId: rawRow.owner_user_id,
                      sourceTable: "memory_nodes",
                      sourceId: rawRow.source_id,
                      sourceColumn: "summary_text"
                    }
                  );
                const bodyText = await decryptAuthorizedEncryptedFieldPayload(
                  pool,
                  options.envelopeEncryptionProvider,
                  {
                    ownerUserId: rawRow.owner_user_id,
                    sourceTable: "memory_nodes",
                    sourceId: rawRow.source_id,
                    sourceColumn: "body_text"
                  }
                );
                if (typeof summaryText !== "string") {
                  return rawRow.text;
                }
                return typeof bodyText === "string" &&
                  bodyText.trim() &&
                  bodyText.trim() !== summaryText.trim()
                  ? `${summaryText} ${bodyText}`
                  : summaryText;
              })()
            }
          : rawRow?.source_type === "memory_event" &&
              (!rawRow.text || rawRow.text === ENCRYPTED_MEMORY_EVENT_TEXT) &&
              options.envelopeEncryptionProvider
            ? {
                ...rawRow,
                text: await (async () => {
                  const payload = await decryptAuthorizedMemoryEventPayload(
                    pool,
                    options.envelopeEncryptionProvider,
                    {
                      ownerUserId: rawRow.owner_user_id,
                      memoryEventId: rawRow.source_id
                    }
                  );
                  return memoryEventEmbeddingContent(payload) ?? rawRow.text;
                })()
              }
            : rawRow;
      return row && row.text && row.text.trim().length > 0
        ? {
            sourceType: row.source_type,
            sourceId: row.source_id,
            ownerUserId: row.owner_user_id,
            visibility: row.visibility,
            text: row.text,
            sourceHash:
              row.source_hash ??
              sourceHash(row.source_type, row.source_id, row.text)
          }
        : null;
    },

    async getCurrentSourceEmbeddingChunkCount(input) {
      const embeddingTable = embeddingTableForDimensions(input.dimensions);
      const result = await pool.query<{ chunk_count: number }>(
        `
        select min(me.source_chunk_count)::integer as chunk_count
        from memory_embeddings me
        inner join ${embeddingTable} vectors
          on vectors.memory_embedding_id = me.id
        where me.invalidated_at is null
          and me.personal_deleted_at is null
          and me.embedding_model = $1
          and me.embedding_dimensions = $2
          and me.embedding_version = $3
          and me.source_hash = $4
          and (
            ($5 = 'memory_node' and me.memory_node_id = $6::uuid)
            or ($5 = 'memory_event' and me.memory_event_id = $6::uuid)
            or ($5 = 'message' and me.message_id = $6::uuid)
          )
        having min(me.source_chunk_count) = max(me.source_chunk_count)
          and count(*) = min(me.source_chunk_count)
          and count(distinct me.source_chunk_index) = min(me.source_chunk_count)
          and min(me.source_chunk_index) = 0
          and max(me.source_chunk_index) = min(me.source_chunk_count) - 1
      `,
        [
          input.model,
          input.dimensions,
          input.version,
          input.source.sourceHash,
          input.source.sourceType,
          input.source.sourceId
        ]
      );
      return result.rows[0]?.chunk_count ?? null;
    },

    async getLcmNodeForSummarization(nodeId) {
      const result = await pool.query<LcmNodeForSummarizationRow>(
        `
        select
          id,
          owner_user_id,
          visibility,
          kind,
          depth,
          summary_text,
          source_items_json,
          source_token_estimate,
          summary_token_estimate,
          summary_model,
          summary_prompt_version,
          summary_structured_json,
          summary_structured_schema_version,
          lcm_algorithm_version
        from memory_nodes
        where id = $1
          and invalidated_at is null
          and kind in ('leaf', 'rollup')
        limit 1
      `,
        [nodeId]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return mapLcmNodeForSummarization(
        pool,
        row,
        options.envelopeEncryptionProvider
      );
    },

    async listLcmNodesNeedingSummaries(actor, input = {}) {
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
      const result = await pool.query<LcmNodeForSummarizationRow>(
        `
        select
          mn.id,
          mn.owner_user_id,
          mn.visibility,
          mn.kind,
          mn.depth,
          mn.summary_text,
          mn.source_items_json,
          mn.source_token_estimate,
          mn.summary_token_estimate,
          mn.summary_model,
          mn.summary_prompt_version,
          mn.summary_structured_json,
          mn.summary_structured_schema_version,
          mn.lcm_algorithm_version
        from memory_nodes mn
        where mn.invalidated_at is null and mn.personal_deleted_at is null
          and mn.kind in ('leaf', 'rollup')
          and mn.summary_model is null
          and (
            mn.kind = 'leaf'
            or not exists (
              select 1
              from memory_node_children mnc
              join memory_nodes child on child.id = mnc.child_memory_node_id
              where mnc.parent_memory_node_id = mn.id
                and child.invalidated_at is null and child.personal_deleted_at is null
                and child.summary_model is null
            )
          )
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
        order by mn.depth asc, mn.created_at asc, mn.id asc
        limit $2
      `,
        [actor.userId, limit]
      );

      return Promise.all(
        result.rows.map((row) =>
          mapLcmNodeForSummarization(
            pool,
            row,
            options.envelopeEncryptionProvider
          )
        )
      );
    },

    async getVisibleLcmNodeForSummarization(actor, nodeId) {
      const result = await pool.query<LcmNodeForSummarizationRow>(
        `
        select
          mn.id,
          mn.owner_user_id,
          mn.visibility,
          mn.kind,
          mn.depth,
          mn.summary_text,
          mn.source_items_json,
          mn.source_token_estimate,
          mn.summary_token_estimate,
          mn.summary_model,
          mn.summary_prompt_version,
          mn.summary_structured_json,
          mn.summary_structured_schema_version,
          mn.lcm_algorithm_version
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null and mn.personal_deleted_at is null
          and mn.kind in ('leaf', 'rollup')
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
        limit 1
      `,
        [actor.userId, nodeId]
      );
      const row = result.rows[0];
      return row
        ? mapLcmNodeForSummarization(
            pool,
            row,
            options.envelopeEncryptionProvider
          )
        : null;
    },

    async updateLcmNodeSummary(input) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const current = await client.query<{
          id: string;
          owner_user_id: string | null;
          visibility: Visibility;
          kind: "leaf" | "rollup";
          summary_text: string;
          source_items_json: LcmSourceItem[] | null;
        }>(
          `
          select id, owner_user_id, visibility, kind, summary_text, source_items_json
          from memory_nodes
          where id = $1
            and invalidated_at is null
            and kind in ('leaf', 'rollup')
          for update
        `,
          [input.nodeId]
        );
        const currentNode = current.rows[0];
        if (!currentNode) {
          await client.query("commit");
          return;
        }
        const hydratedCurrentNode = await hydrateMemoryNodeRow(
          client,
          options.envelopeEncryptionProvider,
          currentNode
        );
        const previousSummary = hydratedCurrentNode.summary_text;
        const suppressPlaintextPayload =
          managedCloudPlaintextMemoryPayloadsDisabled();
        if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
          throw new Error(
            "Envelope encryption provider is required when plaintext Memory Node storage is disabled"
          );
        }
        const summaryStructuredJsonForStorage =
          suppressPlaintextPayload &&
          input.summaryStructuredJson !== undefined &&
          input.summaryStructuredJson !== null
            ? encryptedMemoryNodeJsonMarker()
            : input.summaryStructuredJson;

        await client.query(
          `
          update memory_nodes
          set
            summary_text = $2,
            body_text = $2,
            summary_model = $3,
            summary_prompt_version = $4,
            summary_token_estimate = $5,
            summary_structured_json = $6::jsonb,
            summary_structured_schema_version = $7,
            updated_at = now()
          where id = $1
        `,
          [
            input.nodeId,
            suppressPlaintextPayload
              ? ENCRYPTED_MEMORY_NODE_TEXT
              : input.summaryText,
            input.summaryModel,
            input.summaryPromptVersion,
            input.summaryTokenEstimate,
            summaryStructuredJsonForStorage === undefined
              ? null
              : JSON.stringify(summaryStructuredJsonForStorage),
            input.summaryStructuredSchemaVersion ?? null
          ]
        );
        if (suppressPlaintextPayload && options.envelopeEncryptionProvider) {
          await persistEncryptedMemoryNodeFields(
            client,
            options.envelopeEncryptionProvider,
            {
              ownerUserId: hydratedCurrentNode.owner_user_id!,
              visibility: hydratedCurrentNode.visibility,
              nodeId: input.nodeId,
              summaryText: input.summaryText,
              bodyText: input.summaryText,
              summaryStructuredJson: input.summaryStructuredJson
            }
          );
        }

        if (previousSummary !== input.summaryText) {
          await client.query(
            `
            update memory_embeddings
            set
              invalidated_at = now(),
              invalidation_reason = 'lcm_summary_updated'
            where memory_node_id = $1
              and invalidated_at is null
          `,
            [input.nodeId]
          );
        }

        const generatedTitle = normalizeSessionTitle(
          input.summaryStructuredJson?.title
        );
        const sourceItems = Array.isArray(hydratedCurrentNode.source_items_json)
          ? hydratedCurrentNode.source_items_json
          : [];
        const generatedTitleSessionId = generatedTitle
          ? singleSessionIdForLcmTitle(hydratedCurrentNode.kind, sourceItems)
          : null;
        if (
          generatedTitle &&
          generatedTitleSessionId &&
          hydratedCurrentNode.owner_user_id
        ) {
          await client.query(
            `
            update sessions
            set
              metadata = metadata || jsonb_build_object(
                'threadName', $4::text,
                'threadNameSource', 'lcm',
                'threadNameGeneratedAt', now()
              ),
              updated_at = now()
            where id = $1
              and owner_user_id = $2
              and visibility = $3
              and invalidated_at is null
              and coalesce(metadata ->> 'threadNameSource', '') <> 'manual'
              and (
                metadata ->> 'threadName' is null
                or btrim(metadata ->> 'threadName') = ''
                or metadata ->> 'threadName' = coalesce(external_session_id, '')
                or metadata ->> 'threadName' = id::text
                or metadata ->> 'threadNameSource' in ('generated', 'lcm', 'provisional')
              )
          `,
            [
              generatedTitleSessionId,
              hydratedCurrentNode.owner_user_id,
              hydratedCurrentNode.visibility,
              generatedTitle
            ]
          );
        }

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async upsertSourceEmbedding(input) {
      const embeddingTable = embeddingTableForDimensions(input.dimensions);
      if (input.vector.length !== input.dimensions) {
        throw new Error(
          `Expected ${input.dimensions} vector values, received ${input.vector.length}`
        );
      }
      const sourceText = input.sourceText ?? input.source.text;
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext embedding source text storage is disabled"
        );
      }
      if (suppressPlaintextPayload && !input.source.ownerUserId) {
        throw new Error(
          "Embedding source owner is required when plaintext embedding source text storage is disabled"
        );
      }
      const sourceTextForStorage = suppressPlaintextPayload
        ? ENCRYPTED_EMBEDDING_SOURCE_TEXT
        : sourceText;

      const client = await pool.connect();
      try {
        await client.query("begin");
        const embedding = await client.query<{ id: string; inserted: boolean }>(
          `
          insert into memory_embeddings (
            memory_node_id,
            memory_event_id,
            message_id,
            owner_user_id,
            visibility,
            embedding_model,
            embedding_dimensions,
            embedding_version,
            source_hash,
            source_chunk_index,
            source_chunk_count,
            source_text
          )
          values (
            case when $1 = 'memory_node' then $2::uuid else null end,
            case when $1 = 'memory_event' then $2::uuid else null end,
            case when $1 = 'message' then $2::uuid else null end,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11
          )
          on conflict do nothing
          returning id, true as inserted
        `,
          [
            input.source.sourceType,
            input.source.sourceId,
            input.source.ownerUserId,
            input.source.visibility,
            input.model,
            input.dimensions,
            input.version,
            input.source.sourceHash,
            input.chunkIndex ?? 0,
            input.chunkCount ?? 1,
            sourceTextForStorage
          ]
        );

        let id = embedding.rows[0]?.id;
        const inserted = Boolean(embedding.rows[0]?.inserted);
        if (!id) {
          const existing = await client.query<{ id: string }>(
            `
            select id
            from memory_embeddings
            where invalidated_at is null
              and embedding_model = $1
              and embedding_dimensions = $2
              and embedding_version = $3
              and source_hash = $4
              and source_chunk_index = $7
              and (
                ($5 = 'memory_node' and memory_node_id = $6::uuid)
                or ($5 = 'memory_event' and memory_event_id = $6::uuid)
                or ($5 = 'message' and message_id = $6::uuid)
              )
            limit 1
          `,
            [
              input.model,
              input.dimensions,
              input.version,
              input.source.sourceHash,
              input.source.sourceType,
              input.source.sourceId,
              input.chunkIndex ?? 0
            ]
          );
          id = existing.rows[0]?.id;
        }

        if (!id) {
          throw new Error("Could not create or locate embedding record");
        }
        if (suppressPlaintextPayload && options.envelopeEncryptionProvider) {
          await client.query(
            `
            update memory_embeddings
            set source_text = $2
            where id = $1
          `,
            [id, ENCRYPTED_EMBEDDING_SOURCE_TEXT]
          );
          await upsertEncryptedFieldPayloadWithClient(
            client,
            { userId: input.source.ownerUserId! },
            options.envelopeEncryptionProvider,
            {
              sourceTable: "memory_embeddings",
              sourceId: id,
              sourceColumn: "source_text",
              plaintext: sourceText,
              visibility: input.source.visibility,
              rowFamily: "memory_embedding",
              scope: {
                tenantId: input.source.ownerUserId!,
                objectClass: "memory_embedding"
              },
              aad: {
                sourceType: input.source.sourceType,
                sourceId: input.source.sourceId,
                chunkIndex: input.chunkIndex ?? 0
              }
            }
          );
        }

        await client.query(
          `
          insert into ${embeddingTable} (memory_embedding_id, embedding)
          values ($1, $2::vector)
          on conflict (memory_embedding_id) do nothing
        `,
          [id, vectorLiteral(input.vector)]
        );

        await client.query("commit");
        return { id, inserted };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async replaceSourceEmbeddings(input) {
      const embeddingTable = embeddingTableForDimensions(input.dimensions);
      const expectedCount = input.chunks[0]?.chunkCount ?? 0;
      if (
        expectedCount < 1 ||
        input.chunks.length !== expectedCount ||
        input.chunks.some(
          (chunk, index) =>
            chunk.chunkCount !== expectedCount ||
            chunk.chunkIndex !== index ||
            chunk.vector.length !== input.dimensions ||
            chunk.vector.some((value) => !Number.isFinite(value))
        )
      ) {
        throw new Error("Embedding chunks must form one complete ordered set");
      }
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext embedding source text storage is disabled"
        );
      }
      if (suppressPlaintextPayload && !input.source.ownerUserId) {
        throw new Error(
          "Embedding source owner is required when plaintext embedding source text storage is disabled"
        );
      }

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `embedding-set:${input.source.sourceType}:${input.source.sourceId}:${input.model}:${input.dimensions}:${input.version}`
          ]
        );
        const existing = await client.query<{ id: string }>(
          `
            select id
            from memory_embeddings
            where invalidated_at is null
              and embedding_model = $1
              and embedding_dimensions = $2
              and embedding_version = $3
              and source_hash = $4
              and source_chunk_count = $5
              and (
                ($6 = 'memory_node' and memory_node_id = $7::uuid)
                or ($6 = 'memory_event' and memory_event_id = $7::uuid)
                or ($6 = 'message' and message_id = $7::uuid)
              )
            order by source_chunk_index asc
          `,
          [
            input.model,
            input.dimensions,
            input.version,
            input.source.sourceHash,
            expectedCount,
            input.source.sourceType,
            input.source.sourceId
          ]
        );
        if (existing.rows.length === expectedCount) {
          await client.query("commit");
          return {
            ids: existing.rows.map((row) => row.id),
            inserted: false
          };
        }

        await client.query(
          `
            update memory_embeddings
            set invalidated_at = now(),
                invalidation_reason = 'embedding_set_replaced'
            where invalidated_at is null
              and embedding_model = $1
              and embedding_dimensions = $2
              and embedding_version = $3
              and (
                ($4 = 'memory_node' and memory_node_id = $5::uuid)
                or ($4 = 'memory_event' and memory_event_id = $5::uuid)
                or ($4 = 'message' and message_id = $5::uuid)
              )
          `,
          [
            input.model,
            input.dimensions,
            input.version,
            input.source.sourceType,
            input.source.sourceId
          ]
        );

        const ids: string[] = [];
        for (const chunk of input.chunks) {
          const sourceTextForStorage = suppressPlaintextPayload
            ? ENCRYPTED_EMBEDDING_SOURCE_TEXT
            : chunk.sourceText;
          const embedding = await client.query<{ id: string }>(
            `
              insert into memory_embeddings (
                memory_node_id,
                memory_event_id,
                message_id,
                owner_user_id,
                visibility,
                embedding_model,
                embedding_dimensions,
                embedding_version,
                source_hash,
                source_chunk_index,
                source_chunk_count,
                source_text
              )
              values (
                case when $1 = 'memory_node' then $2::uuid else null end,
                case when $1 = 'memory_event' then $2::uuid else null end,
                case when $1 = 'message' then $2::uuid else null end,
                $3, $4, $5, $6, $7, $8, $9, $10, $11
              )
              returning id
            `,
            [
              input.source.sourceType,
              input.source.sourceId,
              input.source.ownerUserId,
              input.source.visibility,
              input.model,
              input.dimensions,
              input.version,
              input.source.sourceHash,
              chunk.chunkIndex,
              chunk.chunkCount,
              sourceTextForStorage
            ]
          );
          const id = embedding.rows[0]?.id;
          if (!id) {
            throw new Error("Could not create embedding chunk");
          }
          ids.push(id);
          if (suppressPlaintextPayload && options.envelopeEncryptionProvider) {
            await upsertEncryptedFieldPayloadWithClient(
              client,
              { userId: input.source.ownerUserId! },
              options.envelopeEncryptionProvider,
              {
                sourceTable: "memory_embeddings",
                sourceId: id,
                sourceColumn: "source_text",
                plaintext: chunk.sourceText,
                visibility: input.source.visibility,
                rowFamily: "memory_embedding",
                scope: {
                  tenantId: input.source.ownerUserId!,
                  objectClass: "memory_embedding"
                },
                aad: {
                  sourceType: input.source.sourceType,
                  sourceId: input.source.sourceId,
                  chunkIndex: chunk.chunkIndex
                }
              }
            );
          }
          await client.query(
            `
              insert into ${embeddingTable} (memory_embedding_id, embedding)
              values ($1, $2::vector)
            `,
            [id, vectorLiteral(chunk.vector)]
          );
        }
        await client.query("commit");
        return { ids, inserted: true };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async createMemoryEvent(actor, input) {
      if (input.sessionId) {
        const visibleSession = await pool.query<{ id: string }>(
          `
          select s.id
          from sessions s
          where s.id = $2
            and s.invalidated_at is null
            and s.personal_deleted_at is null
            and s.visibility = 'personal'
            and s.owner_user_id = $1
            and coalesce((s.metadata->>'syncReplica')::boolean, false) = false
          limit 1
        `,
          [actor.userId, input.sessionId]
        );
        if (visibleSession.rowCount === 0) {
          throw new Error(
            "Session not found or not visible; synchronized replica is read-only"
          );
        }
      }

      const ownerUserId = actor.userId;
      const payload: MemoryEventPayload = {
        actor: input.actor,
        content: input.content,
        metadata: input.metadata ?? {},
        rawEventType: input.rawEventType,
        workspaceId: input.workspaceId
      };
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Event payload storage is disabled"
        );
      }
      const payloadForStorage = suppressPlaintextPayload
        ? redactMemoryEventPayloadForPlaintextStorage(payload)
        : payload;
      const rawConversationItemIds = rawConversationItemIdsFromMetadata(
        input.metadata
      );
      const capturedAt = input.capturedAt ? new Date(input.capturedAt) : null;
      if (capturedAt && Number.isNaN(capturedAt.getTime())) {
        throw new Error("capturedAt must be a valid timestamp");
      }
      const sourceEventTime = input.sourceEventTime
        ? new Date(input.sourceEventTime)
        : null;
      if (sourceEventTime && Number.isNaN(sourceEventTime.getTime())) {
        throw new Error("sourceEventTime must be a valid timestamp");
      }
      const tokenCount = estimateTokens(input.content, {
        model: input.tokenModel ?? "gpt-5.4-mini"
      });
      const includeInEmbedding = input.metadata?.includeInEmbedding !== false;
      const includeInLcm = input.metadata?.includeInLcm !== false;
      const projectionPolicyKey =
        stringField(input.metadata ?? {}, "projectionPolicyKey") ?? null;
      const projectionPolicyRevision =
        numberField(input.metadata ?? {}, "projectionPolicyRevision") ?? null;
      const previousProjection =
        input.idempotencyKey?.startsWith("projection:") === true
          ? (
              await pool.query<{ id: string; source_hash: string | null }>(
                `
                  select id, source_hash
                  from memory_events
                  where owner_user_id = $1
                    and visibility = $2::visibility_scope
                    and idempotency_key = $3
                    and invalidated_at is null
                  limit 1
                `,
                [ownerUserId, input.visibility, input.idempotencyKey]
              )
            ).rows[0]
          : undefined;

      type MemoryEventRow = {
        id: string;
        owner_user_id: string | null;
        visibility: Visibility;
        event_type: MemoryEventType;
        session_id: string | null;
        turn_id: string | null;
        token_count: number | null;
        seal_reason: string | null;
        payload: MemoryEventPayload;
        created_at: Date;
      };

      const persistMemoryEventEncryptedPayload = async (
        row: MemoryEventRow,
        plaintextPayload: MemoryEventPayload,
        client: pg.Pool | pg.PoolClient = pool
      ): Promise<void> => {
        if (!options.envelopeEncryptionProvider) {
          return;
        }
        await upsertEncryptedFieldPayloadWithClient(
          client,
          { userId: ownerUserId },
          options.envelopeEncryptionProvider,
          {
            sourceTable: "memory_events",
            sourceId: row.id,
            sourceColumn: "payload",
            plaintext: plaintextPayload,
            rowFamily: "memory_event",
            scope: {
              tenantId: ownerUserId,
              workspaceId:
                typeof plaintextPayload.workspaceId === "string"
                  ? plaintextPayload.workspaceId
                  : null,
              objectClass: "memory_event"
            },
            aad: {
              eventType: row.event_type,
              sessionId: row.session_id,
              turnId: row.turn_id,
              actor: plaintextPayload.actor
            }
          }
        );
      };

      const upsertMemoryEventSql = `
      with refreshed as (
        update memory_events
        set
          source_runtime = $5,
          capture_method = $6,
          codex_transcript_path = coalesce($7, memory_events.codex_transcript_path),
          session_id = coalesce($8, memory_events.session_id),
          turn_id = coalesce($9, memory_events.turn_id),
          source_hash = $11,
          payload = $12,
          include_in_embedding = $18,
          include_in_lcm = $19,
          projection_policy_key = $20,
          projection_policy_revision = $21,
          token_count = $13,
          seal_reason = coalesce($14, memory_events.seal_reason),
          captured_at = coalesce($15::timestamptz, now()),
          source_event_time = coalesce($16, memory_events.source_event_time),
          source_sequence = coalesce($17, memory_events.source_sequence),
          invalidated_at = null,
          invalidation_reason = null,
          updated_at = now()
        where $10::text like 'projection:%'
          and memory_events.idempotency_key = $10
          and memory_events.visibility = $3::visibility_scope
          and memory_events.owner_user_id = $2
        returning
          id, owner_user_id, visibility, event_type, session_id, turn_id,
          token_count, seal_reason, payload, created_at
      ),
      inserted as (
        insert into memory_events (
          actor_user_id,
          owner_user_id,
          visibility,
          event_type,
          source_runtime,
          capture_method,
          codex_transcript_path,
          session_id,
          turn_id,
          idempotency_key,
          source_hash,
          payload,
          include_in_embedding,
          include_in_lcm,
          projection_policy_key,
          projection_policy_revision,
          token_count,
          seal_reason,
          captured_at,
          source_event_time,
          source_sequence
        )
        select
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $18, $19, $20, $21, $13, $14,
          coalesce($15::timestamptz, now()), $16, $17
        where not exists (select 1 from refreshed)
        on conflict do nothing
        returning
          id, owner_user_id, visibility, event_type, session_id, turn_id,
          token_count, seal_reason, payload, created_at
      )
      select * from refreshed
      union all
      select * from inserted
    `;
      const upsertMemoryEventParams = [
        actor.userId,
        ownerUserId,
        input.visibility,
        input.eventType,
        input.sourceRuntime ?? null,
        input.captureMethod ?? "mcp",
        input.codexTranscriptPath ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.idempotencyKey ?? null,
        input.sourceHash ?? null,
        payloadForStorage,
        tokenCount,
        input.sealReason ?? null,
        capturedAt,
        sourceEventTime,
        input.sourceSequence ?? null,
        includeInEmbedding,
        includeInLcm,
        projectionPolicyKey,
        projectionPolicyRevision
      ];

      const upsertedRow = suppressPlaintextPayload
        ? await (async (): Promise<MemoryEventRow | undefined> => {
            const client = await pool.connect();
            try {
              await client.query("begin");
              const result = await client.query<MemoryEventRow>(
                upsertMemoryEventSql,
                upsertMemoryEventParams
              );
              const row = result.rows[0];
              if (row) {
                await persistMemoryEventEncryptedPayload(row, payload, client);
              }
              await client.query("commit");
              return row;
            } catch (error) {
              await client.query("rollback");
              throw error;
            } finally {
              client.release();
            }
          })()
        : await (async (): Promise<MemoryEventRow | undefined> => {
            const result = await pool.query<MemoryEventRow>(
              upsertMemoryEventSql,
              upsertMemoryEventParams
            );
            const row = result.rows[0];
            if (row) {
              await persistMemoryEventEncryptedPayload(row, payload);
            }
            return row;
          })();

      const insertedRow = upsertedRow;
      if (insertedRow) {
        if (
          previousProjection &&
          previousProjection.id === insertedRow.id &&
          previousProjection.source_hash !== (input.sourceHash ?? null)
        ) {
          await invalidateDerivedMemoryForMemoryEvents(pool, [insertedRow.id]);
        }
        const hydratedRow = {
          ...insertedRow,
          payload
        };
        await linkMemoryEventSources(
          pool,
          insertedRow.id,
          rawConversationItemIds
        );
        await applyProvisionalCapturedSessionTitle(pool, {
          ownerUserId,
          sessionId: insertedRow.session_id,
          actor: input.actor,
          content: input.content,
          metadata: input.metadata
        });
        return mapMemoryEvent(hydratedRow);
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const duplicate = await pool.query<MemoryEventRow>(
          `
          select
            me.id, me.owner_user_id, me.visibility, me.event_type,
            me.session_id, me.turn_id, me.token_count, me.seal_reason,
            me.payload, me.created_at
          from memory_events me
          where (
              ($2::text is not null and me.idempotency_key = $2)
              or ($3::text is not null and me.source_hash = $3)
            )
            and me.visibility = 'personal'
            and me.owner_user_id = $1
          order by
            case
              when $2::text is not null and me.idempotency_key = $2 then 0
              when $3::text is not null and me.source_hash = $3 then 1
              else 2
            end,
            me.created_at desc
          limit 1
        `,
          [actor.userId, input.idempotencyKey ?? null, input.sourceHash ?? null]
        );
        const duplicateRow = duplicate.rows[0];
        if (duplicateRow) {
          const duplicatePayload =
            duplicateRow.payload.contentEncrypted === true
              ? ((await decryptAuthorizedMemoryEventPayload(
                  pool,
                  options.envelopeEncryptionProvider,
                  {
                    ownerUserId: duplicateRow.owner_user_id,
                    memoryEventId: duplicateRow.id
                  }
                )) ?? payload)
              : duplicateRow.payload;
          await linkMemoryEventSources(
            pool,
            duplicateRow.id,
            rawConversationItemIds
          );
          await persistMemoryEventEncryptedPayload(
            duplicateRow,
            duplicatePayload
          );
          return mapMemoryEvent({
            ...duplicateRow,
            payload: duplicatePayload
          });
        }
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 10 * (attempt + 1))
          );
        }
      }

      throw Object.assign(
        new Error(
          "Duplicate memory event conflicts with memory outside caller visibility"
        ),
        { statusCode: 409 }
      );
    },

    async searchMemoryNodes(actor, input) {
      const visibility = input.scope;
      const searchDomain = input.searchDomain ?? "global";
      if (searchDomain === "session" && !input.sessionId) {
        throw new Error("Session-scoped memory search requires sessionId");
      }
      if (searchDomain === "project" && !input.workspaceId) {
        throw new Error("Project-scoped memory search requires workspaceId");
      }
      const teamWorkspaceAccess = input.teamWorkspaceId
        ? await this.getTeamWorkspaceAccess(actor, input.teamWorkspaceId)
        : null;
      const teamWorkspaceAuthorization = resolveTeamWorkspaceAuthorization({
        requesterUserId: actor.userId,
        teamWorkspaceId: input.teamWorkspaceId,
        access: teamWorkspaceAccess
      });
      if (
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        !teamWorkspaceAuthorization.authorized
      ) {
        return emptySearchResult();
      }
      const teamWorkspaceBoundary: TeamWorkspaceReadBoundary =
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        teamWorkspaceAuthorization.authorized
          ? {
              teamWorkspaceId: teamWorkspaceAuthorization.teamWorkspaceId,
              teamId: teamWorkspaceAuthorization.teamId
            }
          : null;
      const requestedParentNodeIds = input.parentNodeIds?.filter(Boolean) ?? [];
      const visibleParentNodeIds = requestedParentNodeIds.length
        ? (
            await this.listLcmGraphNodes(actor, {
              teamWorkspaceId: input.teamWorkspaceId,
              nodeIds: requestedParentNodeIds,
              limit: requestedParentNodeIds.length
            })
          ).map((node) => node.id)
        : [];
      const requestedLimit = input.limit ?? 10;
      const shouldRerank = rerankingEnabled();
      const now = new Date();
      const sourceAfter = input.recentDays
        ? new Date(now.getTime() - input.recentDays * 24 * 60 * 60 * 1000)
        : input.sourceAfter
          ? new Date(input.sourceAfter)
          : null;
      const sourceBefore = input.sourceBefore
        ? new Date(input.sourceBefore)
        : null;
      if (
        input.recentDays !== undefined &&
        (input.sourceAfter !== undefined || input.sourceBefore !== undefined)
      ) {
        throw new Error(
          "recentDays cannot be combined with explicit sourceAfter/sourceBefore bounds"
        );
      }
      if (sourceAfter && Number.isNaN(sourceAfter.getTime())) {
        throw new Error("sourceAfter must be a valid timestamp");
      }
      if (sourceBefore && Number.isNaN(sourceBefore.getTime())) {
        throw new Error("sourceBefore must be a valid timestamp");
      }
      if (sourceAfter && sourceBefore && sourceAfter >= sourceBefore) {
        throw new Error("sourceAfter must be earlier than sourceBefore");
      }
      const temporalFilter =
        input.recentDays || sourceAfter || sourceBefore
          ? {
              recentDays: input.recentDays,
              sourceAfter: sourceAfter?.toISOString(),
              sourceBefore: sourceBefore?.toISOString()
            }
          : undefined;
      let embeddingMetadata = defaultRetrievalMetadata({
        rerankingEnabled: shouldRerank,
        temporalFilter
      });

      type RetrievalStageName =
        | "rollup_search"
        | "scoped_leaf_search"
        | "leaf_search"
        | "curated_memory_search"
        | "fresh_pending_search"
        | "raw_fallback_search"
        | "lexical_search";
      type VectorRow = {
        id: string;
        embedding_id: string | null;
        source_type:
          | "memory_node"
          | "memory_event"
          | "message"
          | "curated_memory";
        source_id: string;
        owner_user_id: string | null;
        retrieval_stage: RetrievalStageName;
        parent_node_ids: string[] | null;
        has_out_of_window_sources: boolean;
        filtered_source_items: Array<{
          createdAt?: string;
          text?: string;
          projectName?: string | null;
          projectPath?: string | null;
        }> | null;
        visibility: Visibility;
        summary_text: string;
        rerank_text: string | null;
        lcm_summary_model: string | null;
        lcm_summary_pending: boolean;
        score: number;
        created_at: Date;
        embedding_model: string | null;
        embedding_dimensions: number | null;
        source_chunk_index: number;
        source_chunk_count: number;
      };
      type StageResult = {
        name: RetrievalStageName;
        rows: VectorRow[];
        durationMs: number;
        reranked: boolean;
        rerankedCount: number;
        rerankerModel?: string | null;
        rerankingUnavailable?: boolean;
        rerankingError?: string;
        parentNodeIds?: string[];
      };
      const stageDiagnostics: NonNullable<RetrievalMetadata["stages"]> = [];
      const stagePriority: Record<RetrievalStageName, number> = {
        rollup_search: 5,
        scoped_leaf_search: 4,
        leaf_search: 3,
        curated_memory_search: 3,
        fresh_pending_search: 2,
        raw_fallback_search: 1,
        lexical_search: 2
      };
      const stageWeight: Record<RetrievalStageName, number> = {
        rollup_search: 1.1,
        scoped_leaf_search: 1.05,
        leaf_search: 1,
        curated_memory_search: 1,
        fresh_pending_search: 0.95,
        raw_fallback_search: 0.7,
        lexical_search: 1.2
      };
      const stageCandidateLimit = (name: string, fallback: number): number =>
        positiveIntEnv(name, fallback);
      const rollupCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_ROLLUP_CANDIDATE_LIMIT",
        shouldRerank
          ? vectorCandidateLimit(requestedLimit)
          : Math.max(requestedLimit, 20)
      );
      const leafCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_LEAF_CANDIDATE_LIMIT",
        shouldRerank
          ? vectorCandidateLimit(requestedLimit * 2)
          : Math.max(requestedLimit * 2, 20)
      );
      const freshCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_FRESH_EVENT_CANDIDATE_LIMIT",
        Math.max(requestedLimit, 20)
      );
      const rawCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_RAW_FALLBACK_CANDIDATE_LIMIT",
        Math.max(requestedLimit, 20)
      );
      const lexicalCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_LEXICAL_CANDIDATE_LIMIT",
        Math.max(requestedLimit, 20)
      );
      const curatedMemoryCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_CURATED_MEMORY_CANDIDATE_LIMIT",
        Math.max(requestedLimit, 20)
      );
      const rollupResultLimit = stageCandidateLimit(
        "MEMORY_RAG_ROLLUP_RESULT_LIMIT",
        Math.max(1, Math.min(requestedLimit, 5))
      );
      const scopedLeafCandidateLimit = stageCandidateLimit(
        "MEMORY_RAG_SCOPED_LEAF_CANDIDATE_LIMIT",
        Math.max(requestedLimit * 2, 20)
      );
      const rawFallbackEnabled =
        process.env.MEMORY_RAG_RAW_FALLBACK_ENABLED?.trim().toLowerCase() !==
        "false";
      const scoreThresholds: Record<RetrievalStageName, number> = {
        rollup_search: nonNegativeFloatEnv("MEMORY_RAG_ROLLUP_MIN_SCORE", 0),
        scoped_leaf_search: nonNegativeFloatEnv(
          "MEMORY_RAG_SCOPED_LEAF_MIN_SCORE",
          nonNegativeFloatEnv("MEMORY_RAG_LEAF_MIN_SCORE", 0)
        ),
        leaf_search: nonNegativeFloatEnv("MEMORY_RAG_LEAF_MIN_SCORE", 0),
        curated_memory_search: nonNegativeFloatEnv(
          "MEMORY_RAG_CURATED_MEMORY_MIN_SCORE",
          0
        ),
        fresh_pending_search: nonNegativeFloatEnv(
          "MEMORY_RAG_FRESH_EVENT_MIN_SCORE",
          0
        ),
        raw_fallback_search: nonNegativeFloatEnv(
          "MEMORY_RAG_RAW_FALLBACK_MIN_SCORE",
          0
        ),
        lexical_search: 0
      };
      const stageMaxAllowed: Record<RetrievalStageName, number> = {
        rollup_search: rollupCandidateLimit,
        scoped_leaf_search: scopedLeafCandidateLimit,
        leaf_search: leafCandidateLimit,
        curated_memory_search: curatedMemoryCandidateLimit,
        fresh_pending_search: freshCandidateLimit,
        raw_fallback_search: rawCandidateLimit,
        lexical_search: lexicalCandidateLimit
      };
      const requestedStage =
        input.retrievalStage && input.retrievalStage !== "score_scan"
          ? input.retrievalStage
          : null;
      if (
        requestedStage === "lexical_search" &&
        !plaintextLexicalSearchEnabled()
      ) {
        throw Object.assign(
          new Error(
            "Plaintext lexical search is disabled for this deployment profile"
          ),
          {
            statusCode: 400,
            payload: {
              error: "plaintext_lexical_search_disabled",
              deploymentProfile: deploymentProfile() || null
            }
          }
        );
      }
      const scanOnly = input.retrievalStage === "score_scan";
      const vectorRows: VectorRow[] = [];
      const filteredNodeSourceText = (
        items: VectorRow["filtered_source_items"]
      ): string | null => {
        if (!Array.isArray(items) || items.length === 0) {
          return null;
        }
        const lines = items
          .map((item) => {
            const text = presentMemoryText(item.text ?? "", {
              project_name: item.projectName ?? null,
              project_path: item.projectPath ?? null
            });
            if (!text || text === "Captured memory.") {
              return null;
            }
            return item.createdAt ? `[${item.createdAt}] ${text}` : text;
          })
          .filter((line): line is string => Boolean(line));
        return lines.length > 0 ? lines.join("\n") : null;
      };
      const selectStageRowsForEvidence = (
        stage: RetrievalStageName,
        rows: VectorRow[]
      ): VectorRow[] => {
        if (stage === "rollup_search" && !requestedStage) {
          return rows.slice(0, rollupResultLimit);
        }
        return rows;
      };
      const lexicalStopWords = new Set([
        "about",
        "after",
        "again",
        "answer",
        "before",
        "being",
        "could",
        "does",
        "from",
        "have",
        "into",
        "that",
        "their",
        "there",
        "these",
        "this",
        "what",
        "when",
        "where",
        "which",
        "while",
        "with",
        "would"
      ]);
      const lexicalTerms = (query: string): string[] => {
        const quoted = [...query.matchAll(/"([^"]+)"/g)]
          .map((match) => match[1]?.trim())
          .filter((term): term is string => Boolean(term && term.length >= 2));
        const words = query
          .toLowerCase()
          .split(/[^a-z0-9_'-]+/i)
          .map((term) => term.trim())
          .filter((term) => term.length >= 3 && !lexicalStopWords.has(term));
        const terms = [...new Set([...quoted, ...words])]
          .filter(Boolean)
          .slice(0, 16);
        return terms.length > 0 ? terms : [query.trim()].filter(Boolean);
      };
      const hasCuratedMemoryIntent = (query: string): boolean =>
        /\b(remember|recall|preference|prefer|usually|decision|decid(?:e|ed|ing)|agreed?|plan|birthday|relationship|allerg(?:y|ic)|diet|travel|flight|hotel|address|phone|email|timezone|favou?rite|correction|personal fact)\b/i.test(
          query
        );
      const shouldRunCuratedMemoryStage =
        requestedStage === "curated_memory_search" ||
        (!requestedStage && hasCuratedMemoryIntent(input.query));
      const runCuratedMemoryStage = async (): Promise<StageResult> => {
        const started = Date.now();
        const terms = lexicalTerms(input.query);
        if (
          terms.length === 0 ||
          teamWorkspaceBoundary ||
          !shouldRunCuratedMemoryStage
        ) {
          return {
            name: "curated_memory_search",
            rows: [],
            durationMs: Date.now() - started,
            reranked: false,
            rerankedCount: 0,
            parentNodeIds: []
          };
        }
        const candidates =
          await curatedMemoryRepository.searchCuratedMemoryRetrievalCandidates(
            actor,
            {
              query: input.query,
              searchDomain,
              sessionId: input.sessionId,
              workspaceId: input.workspaceId,
              limit: curatedMemoryCandidateLimit,
              sourceAfter: sourceAfter?.toISOString(),
              sourceBefore: sourceBefore?.toISOString()
            }
          );
        const rows: VectorRow[] = candidates.map((candidate) => ({
          id: candidate.assertionId,
          embedding_id: null,
          source_type: "curated_memory",
          retrieval_stage: "curated_memory_search",
          source_id: candidate.assertionId,
          owner_user_id: candidate.ownerUserId,
          parent_node_ids: [],
          visibility: candidate.visibility,
          summary_text: candidate.summaryText,
          rerank_text: candidate.rerankText,
          has_out_of_window_sources: false,
          filtered_source_items: null,
          lcm_summary_model: null,
          lcm_summary_pending: false,
          created_at: new Date(candidate.updatedAt),
          embedding_model: null,
          embedding_dimensions: null,
          source_chunk_index: 0,
          source_chunk_count: 1,
          score: candidate.score
        }));
        return {
          name: "curated_memory_search",
          rows,
          durationMs: Date.now() - started,
          reranked: false,
          rerankedCount: 0,
          parentNodeIds: []
        };
      };
      const runLexicalStage = async (): Promise<StageResult> => {
        const started = Date.now();
        const terms = lexicalTerms(input.query);
        if (terms.length === 0) {
          return {
            name: "lexical_search",
            rows: [],
            durationMs: Date.now() - started,
            reranked: false,
            rerankedCount: 0,
            parentNodeIds: []
          };
        }
        const patterns = terms.map((term) => `%${term.toLowerCase()}%`);
        const exact = input.query.trim().toLowerCase();
        const result = await pool.query<VectorRow>(
          `
          with lexical_sources as (
            select
              mn.id,
              null::text as embedding_id,
              'memory_node'::text as source_type,
              mn.id as source_id,
              mn.owner_user_id,
              coalesce(
                (
                  select array_agg(parent.parent_memory_node_id::text order by parent.parent_memory_node_id::text)
                  from memory_node_children parent
                  join memory_nodes parent_node
                    on parent_node.id = parent.parent_memory_node_id
                    and parent_node.invalidated_at is null
                    and parent_node.personal_deleted_at is null
                  where parent.child_memory_node_id = mn.id
                    and parent_node.visibility = 'personal'
                    and (
                      ($13::uuid is null and parent_node.owner_user_id = $1)
                      or (
                        $13::uuid is not null
                        and exists (
                          select 1
                          from memory_node_sources parent_any_mns
                          where parent_any_mns.memory_node_id = parent_node.id
                        )
                        and not exists (
                          select 1
                          from memory_node_sources parent_mns
                          left join memory_events parent_ev on parent_ev.id = parent_mns.memory_event_id and parent_ev.invalidated_at is null
                          left join messages parent_msg on parent_msg.id = parent_mns.message_id and parent_msg.invalidated_at is null and parent_msg.recall_eligible = true
                          where parent_mns.memory_node_id = parent_node.id
                            and not exists (
                              select 1
                              from team_session_share_grants parent_grant
                              where parent_grant.session_id = coalesce(parent_ev.session_id, parent_msg.session_id)
                                and parent_grant.team_workspace_id = $13::uuid
                                and parent_grant.team_id = $14::uuid
                      and parent_grant.revoked_at is null and sync_session_recall_ready(parent_grant.session_id)
                            )
                        )
                      )
                    )
                ),
                array[]::text[]
              ) as parent_node_ids,
              mn.visibility,
              case
                when not lexical_boundaries.use_filtered_sources
                then node_text.full_text
                else coalesce(filtered_sources.filtered_source_text, '')
              end as summary_text,
              lexical_boundaries.use_filtered_sources as has_out_of_window_sources,
              case
                when lexical_boundaries.use_filtered_sources
                then filtered_sources.filtered_source_items
                else null::json
              end as filtered_source_items,
              coalesce(mn.summary_model, '') as lcm_summary_model,
              mn.summary_model is null as lcm_summary_pending,
              mn.created_at,
              0.15::double precision as source_rank
            from memory_nodes mn
            cross join lateral (
              select not (
                $5::text = 'global'
                and $8::timestamptz is null
                and $9::timestamptz is null
              ) as use_filtered_sources
            ) lexical_boundaries
            cross join lateral (
              select case
                when mn.body_text is null
                  or btrim(mn.body_text) = ''
                  or btrim(mn.body_text) = btrim(mn.summary_text)
                then btrim(mn.summary_text)
                else btrim(mn.summary_text || E'\n' || mn.body_text)
              end as full_text
            ) node_text
            left join lateral (
              select
                string_agg(source_row.source_text, E'\n' order by source_row.source_created_at asc, source_row.source_id asc) as filtered_source_text,
                json_agg(
                  json_build_object(
                    'createdAt', to_char(source_row.source_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'text', source_row.source_text,
                    'projectName', source_row.project_name,
                    'projectPath', source_row.project_path
                  )
                  order by source_row.source_created_at asc, source_row.source_id asc
                ) as filtered_source_items
              from (
                select
                  coalesce(source_ev.id, source_msg.id) as source_id,
                  coalesce(source_ev.captured_at, source_msg.captured_at) as source_created_at,
                  coalesce(source_ev.payload ->> 'content', source_msg.content, '') as source_text,
                  case
                    when $13::uuid is null then coalesce(source_session.project_override_name, source_session.automatic_project_name, 'Unassigned')
                    else 'Team Workspace'
                  end as project_name,
                  case
                    when $13::uuid is null then coalesce(source_session.project_override_path, source_session.automatic_project_path)
                    else null::text
                  end as project_path
                from memory_node_sources source_mns
                left join memory_events source_ev on source_ev.id = source_mns.memory_event_id and source_ev.invalidated_at is null and source_ev.personal_deleted_at is null
                left join messages source_msg on source_msg.id = source_mns.message_id and source_msg.invalidated_at is null and source_msg.recall_eligible = true
                left join sessions source_session on source_session.id = coalesce(source_ev.session_id, source_msg.session_id)
                where source_mns.memory_node_id = mn.id
                  and (
                    $5::text = 'global'
                    or (
                      $5::text = 'session'
                      and (source_ev.session_id = $6::uuid or source_msg.session_id = $6::uuid)
                    )
                    or (
                      $5::text = 'project'
                      and (
                        (
                          $13::uuid is null
                          and (
                            coalesce(
                              source_session.project_override_id,
                              source_session.automatic_project_id,
                              case when source_session.id is null then source_ev.payload ->> 'workspaceId' end,
                              'unassigned'
                            ) = $7
                            or coalesce(source_session.project_override_path, source_session.automatic_project_path) = $7
                          )
                        )
                        or $13::uuid is not null
                      )
                    )
                  )
                  and coalesce(source_ev.payload ->> 'content', source_msg.content, '') <> ''
                  and (
                    ($8::timestamptz is null and $9::timestamptz is null)
                    or coalesce(source_ev.captured_at, source_msg.captured_at) is not null
                  )
                  and ($8::timestamptz is null or coalesce(source_ev.captured_at, source_msg.captured_at) >= $8::timestamptz)
                  and ($9::timestamptz is null or coalesce(source_ev.captured_at, source_msg.captured_at) < $9::timestamptz)
              ) source_row
            ) filtered_sources on true
            where mn.invalidated_at is null and mn.personal_deleted_at is null
              and mn.visibility = 'personal'
              and not exists (
                select 1
                from memory_node_sources ready_mns
                left join memory_events ready_ev on ready_ev.id = ready_mns.memory_event_id
                left join messages ready_msg on ready_msg.id = ready_mns.message_id
                where ready_mns.memory_node_id = mn.id
                  and not sync_session_recall_ready(coalesce(ready_ev.session_id, ready_msg.session_id))
              )
              and (
                ($13::uuid is null and mn.owner_user_id = $1)
                or (
                  $13::uuid is not null
                  and exists (
                    select 1
                    from memory_node_sources auth_any_mns
                    where auth_any_mns.memory_node_id = mn.id
                  )
                  and not exists (
                    select 1
                    from memory_node_sources auth_mns
                    left join memory_events auth_ev on auth_ev.id = auth_mns.memory_event_id and auth_ev.invalidated_at is null
                    left join messages auth_msg on auth_msg.id = auth_mns.message_id and auth_msg.invalidated_at is null and auth_msg.recall_eligible = true
                    where auth_mns.memory_node_id = mn.id
                      and not exists (
                        select 1
                        from team_session_share_grants auth_grant
                        where auth_grant.session_id = coalesce(auth_ev.session_id, auth_msg.session_id)
                          and auth_grant.team_workspace_id = $13::uuid
                          and auth_grant.team_id = $14::uuid
                          and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                      )
                  )
                )
              )
              and ($2::visibility_scope is null or mn.visibility = $2::visibility_scope)
              and lower(
                case
                  when not lexical_boundaries.use_filtered_sources
                  then node_text.full_text
                  else coalesce(filtered_sources.filtered_source_text, '')
                end
              ) like any($3::text[])
              and (
                not lexical_boundaries.use_filtered_sources
                or filtered_sources.filtered_source_text is not null
              )

            union all

            select
              me.id,
              null::text as embedding_id,
              'memory_event'::text as source_type,
              me.id as source_id,
              me.owner_user_id,
              array[]::text[] as parent_node_ids,
              me.visibility,
              coalesce(me.payload ->> 'content', '') as summary_text,
              false as has_out_of_window_sources,
              null::json as filtered_source_items,
              null as lcm_summary_model,
              false as lcm_summary_pending,
              me.captured_at as created_at,
              case
                when coalesce(me.payload ->> 'actor', '') = 'tool' then -0.25
                when coalesce(me.payload ->> 'actor', '') in ('agent', 'assistant', 'subagent') then 0.2
                else 0.05
              end::double precision as source_rank
            from memory_events me
            left join sessions me_session on me_session.id = me.session_id
            where me.invalidated_at is null
              and me.visibility = 'personal'
              and sync_session_recall_ready(me.session_id)
              and (
                ($13::uuid is null and me.owner_user_id = $1 and me.personal_deleted_at is null)
                or (
                  $13::uuid is not null
                  and exists (
                    select 1
                    from team_session_share_grants auth_grant
                    where auth_grant.session_id = me.session_id
                      and auth_grant.team_workspace_id = $13::uuid
                      and auth_grant.team_id = $14::uuid
                      and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                  )
                )
              )
              and ($2::visibility_scope is null or me.visibility = $2::visibility_scope)
              and lower(coalesce(me.payload ->> 'content', '')) like any($3::text[])
              and (
                $5::text = 'global'
                or (
                  $5::text = 'session'
                  and me.session_id = $6::uuid
                )
                or (
                  $5::text = 'project'
                  and (
                    (
                      $13::uuid is null
                      and (
                        coalesce(
                          me_session.project_override_id,
                          me_session.automatic_project_id,
                          case when me_session.id is null then me.payload ->> 'workspaceId' end,
                          'unassigned'
                        ) = $7
                        or coalesce(me_session.project_override_path, me_session.automatic_project_path) = $7
                      )
                    )
                    or $13::uuid is not null
                  )
                )
              )
              and ($8::timestamptz is null or me.captured_at >= $8::timestamptz)
              and ($9::timestamptz is null or me.captured_at < $9::timestamptz)

            union all

            select
              msg.id,
              null::text as embedding_id,
              'message'::text as source_type,
              msg.id as source_id,
              msg.owner_user_id,
              array[]::text[] as parent_node_ids,
              msg.visibility,
              msg.content as summary_text,
              false as has_out_of_window_sources,
              null::json as filtered_source_items,
              null as lcm_summary_model,
              false as lcm_summary_pending,
              msg.captured_at as created_at,
              case
                when msg.role = 'tool' then -0.25
                else 0.05
              end::double precision as source_rank
            from messages msg
            left join sessions msg_session on msg_session.id = msg.session_id
            where msg.invalidated_at is null
              and msg.recall_eligible = true
              and msg.visibility = 'personal'
              and sync_session_recall_ready(msg.session_id)
              and (
                ($13::uuid is null and msg.owner_user_id = $1)
                or (
                  $13::uuid is not null
                  and exists (
                    select 1
                    from team_session_share_grants auth_grant
                    where auth_grant.session_id = msg.session_id
                      and auth_grant.team_workspace_id = $13::uuid
                      and auth_grant.team_id = $14::uuid
                      and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                  )
                )
              )
              and ($2::visibility_scope is null or msg.visibility = $2::visibility_scope)
              and lower(msg.content) like any($3::text[])
              and (
                $5::text = 'global'
                or (
                  $5::text = 'session'
                  and msg.session_id = $6::uuid
                )
                or (
                  $5::text = 'project'
                  and (
                    (
                      $13::uuid is null
                      and (
                        coalesce(msg_session.project_override_id, msg_session.automatic_project_id, 'unassigned') = $7
                        or coalesce(msg_session.project_override_path, msg_session.automatic_project_path) = $7
                      )
                    )
                    or $13::uuid is not null
                  )
                )
              )
              and ($8::timestamptz is null or msg.captured_at >= $8::timestamptz)
              and ($9::timestamptz is null or msg.captured_at < $9::timestamptz)
          )
          , scored as (
            select
              lexical_sources.*,
              (
                select count(*)::double precision
                from unnest($3::text[]) as term(pattern)
                where lower(summary_text) like term.pattern
              ) as matched_terms
            from lexical_sources
            where btrim(summary_text) <> ''
          )
          select
            id,
            embedding_id,
            source_type::text,
            source_id,
            owner_user_id,
            'lexical_search'::text as retrieval_stage,
            parent_node_ids,
            coalesce(has_out_of_window_sources, false) as has_out_of_window_sources,
            filtered_source_items,
            visibility,
            summary_text,
            summary_text as rerank_text,
            nullif(lcm_summary_model, '') as lcm_summary_model,
            lcm_summary_pending,
            (
              matched_terms
              / greatest(array_length($3::text[], 1), 1)::double precision
              + case
                  when $4 <> '' and lower(summary_text) like '%' || $4 || '%'
                  then 0.05
                  else 0
                end
              + source_rank
              + least(length(summary_text), 12000)::double precision / 120000
            ) as score,
            created_at,
            $10::text as embedding_model,
            $11::int as embedding_dimensions,
            0 as source_chunk_index,
            1 as source_chunk_count
          from scored
          where matched_terms > 0
          order by score desc, matched_terms desc, created_at desc, source_id
          limit $12
        `,
          [
            actor.userId,
            visibility,
            patterns,
            exact,
            searchDomain,
            input.sessionId ?? null,
            input.workspaceId ?? null,
            sourceAfter,
            sourceBefore,
            localEmbeddingModel(),
            localEmbeddingDimensions(),
            lexicalCandidateLimit,
            teamWorkspaceBoundary?.teamWorkspaceId ?? null,
            teamWorkspaceBoundary?.teamId ?? null
          ]
        );
        return {
          name: "lexical_search",
          rows: result.rows,
          durationMs: Date.now() - started,
          reranked: false,
          rerankedCount: 0,
          parentNodeIds: []
        };
      };

      const hydrateSearchRows = async (
        rows: VectorRow[]
      ): Promise<VectorRow[]> =>
        Promise.all(
          rows.map(async (row) => {
            if (
              row.summary_text === ENCRYPTED_EMBEDDING_SOURCE_TEXT ||
              row.summary_text.includes(ENCRYPTED_EMBEDDING_SOURCE_TEXT)
            ) {
              if (!row.embedding_id) {
                throw new Error(
                  "Encrypted embedding source text is missing its embedding id"
                );
              }
              if (!options.envelopeEncryptionProvider) {
                throw new Error(
                  "Envelope encryption provider is required to search encrypted embedding source text"
                );
              }
              const sourceText = await decryptAuthorizedEncryptedFieldPayload(
                pool,
                options.envelopeEncryptionProvider,
                {
                  ownerUserId: row.owner_user_id,
                  sourceTable: "memory_embeddings",
                  sourceId: row.embedding_id,
                  sourceColumn: "source_text"
                }
              );
              if (typeof sourceText !== "string") {
                throw new Error(
                  "Encrypted embedding source_text companion is invalid"
                );
              }
              return {
                ...row,
                summary_text: sourceText,
                rerank_text:
                  row.rerank_text === ENCRYPTED_EMBEDDING_SOURCE_TEXT ||
                  row.rerank_text?.includes(ENCRYPTED_EMBEDDING_SOURCE_TEXT)
                    ? sourceText
                    : row.rerank_text
              };
            }
            if (
              row.source_type !== "memory_node" ||
              (row.summary_text !== ENCRYPTED_MEMORY_NODE_TEXT &&
                !row.summary_text.includes(ENCRYPTED_MEMORY_NODE_TEXT))
            ) {
              return row;
            }
            if (!options.envelopeEncryptionProvider) {
              throw new Error(
                "Envelope encryption provider is required to search encrypted Memory Nodes"
              );
            }
            const summaryText = await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id,
                sourceTable: "memory_nodes",
                sourceId: row.source_id,
                sourceColumn: "summary_text"
              }
            );
            if (typeof summaryText !== "string") {
              throw new Error("Encrypted Memory Node summary_text is invalid");
            }
            return {
              ...row,
              summary_text: summaryText,
              rerank_text:
                row.rerank_text === ENCRYPTED_MEMORY_NODE_TEXT ||
                row.rerank_text?.includes(ENCRYPTED_MEMORY_NODE_TEXT)
                  ? summaryText
                  : row.rerank_text
            };
          })
        );

      const rerankStageRows = async (
        stage: RetrievalStageName,
        rows: VectorRow[]
      ): Promise<{
        rows: VectorRow[];
        reranked: boolean;
        rerankedCount: number;
        rerankerModel?: string | null;
        rerankingUnavailable?: boolean;
        rerankingError?: string;
      }> => {
        if (!shouldRerank || rows.length === 0) {
          return { rows, reranked: false, rerankedCount: 0 };
        }
        const rerankableRows = rows.filter((row) => row.rerank_text?.trim());
        if (rerankableRows.length === 0) {
          return {
            rows,
            reranked: false,
            rerankedCount: 0,
            rerankingUnavailable: true,
            rerankingError: `no completed summary nodes available for reranking in ${stage}`
          };
        }
        try {
          const reranked = await rerankTexts(
            input.query,
            rerankableRows.map((row) => prepareRerankDocument(row.rerank_text!))
          );
          const rerankedRows = rerankableRows.map((row, index) => ({
            ...row,
            score: reranked.scores[index] ?? row.score
          }));
          const rerankableKeys = new Set(
            rerankableRows.map(
              (row) =>
                `${row.source_type}:${row.source_id}:${
                  row.source_chunk_index ?? 0
                }`
            )
          );
          const nonRerankableRows = rows.filter(
            (row) =>
              !rerankableKeys.has(
                `${row.source_type}:${row.source_id}:${
                  row.source_chunk_index ?? 0
                }`
              )
          );
          return {
            rows: [...rerankedRows, ...nonRerankableRows].sort(
              (left, right) =>
                Number(right.score) - Number(left.score) ||
                right.created_at.getTime() - left.created_at.getTime() ||
                left.source_id.localeCompare(right.source_id)
            ),
            reranked: true,
            rerankedCount: reranked.scores.length,
            rerankerModel: reranked.model
          };
        } catch (error) {
          console.warn(
            `Local reranking failed for ${stage}; using vector order: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return {
            rows,
            reranked: false,
            rerankedCount: 0,
            rerankingUnavailable: true,
            rerankingError:
              error instanceof Error ? error.message : String(error)
          };
        }
      };

      try {
        if (requestedStage !== "lexical_search") {
          const embedded = await embedQueryTexts([input.query]);
          if (embedded.vectors[0]) {
            const queryVector = embedded.vectors[0];
            const embeddingTable = embeddingTableForDimensions(
              embedded.dimensions
            );
            const runStage = async (
              stage: RetrievalStageName,
              limit: number,
              parentNodeIds: string[] = []
            ): Promise<StageResult> => {
              const started = Date.now();
              const vectorResult = await pool.query<VectorRow>(
                `
              with candidates as (
                select
                  coalesce(mns.memory_node_id, me.memory_node_id, me.memory_event_id, me.message_id) as id,
                  me.id::text as embedding_id,
                  case
                    when me.memory_node_id is not null then 'memory_node'
                    when me.memory_event_id is not null then 'memory_event'
                    else 'message'
                  end as source_type,
                  coalesce(me.memory_node_id, me.memory_event_id, me.message_id) as source_id,
                  me.owner_user_id,
                  $11::text as retrieval_stage,
                  coalesce(
                    (
                      select array_agg(parent.parent_memory_node_id::text order by parent.parent_memory_node_id::text)
                      from memory_node_children parent
                      join memory_nodes parent_node
                        on parent_node.id = parent.parent_memory_node_id
                        and parent_node.invalidated_at is null
                        and parent_node.personal_deleted_at is null
                      where parent.child_memory_node_id = me.memory_node_id
                        and parent_node.visibility = 'personal'
                        and (
                          ($15::uuid is null and parent_node.owner_user_id = $1)
                          or (
                            $15::uuid is not null
                            and exists (
                              select 1
                              from memory_node_sources parent_any_mns
                              where parent_any_mns.memory_node_id = parent_node.id
                            )
                            and not exists (
                              select 1
                              from memory_node_sources parent_mns
                              left join memory_events parent_ev on parent_ev.id = parent_mns.memory_event_id and parent_ev.invalidated_at is null
                              left join messages parent_msg on parent_msg.id = parent_mns.message_id and parent_msg.invalidated_at is null and parent_msg.recall_eligible = true
                              where parent_mns.memory_node_id = parent_node.id
                                and not exists (
                                  select 1
                                  from team_session_share_grants parent_grant
                                  where parent_grant.session_id = coalesce(parent_ev.session_id, parent_msg.session_id)
                                    and parent_grant.team_workspace_id = $15::uuid
                                    and parent_grant.team_id = $16::uuid
                                    and parent_grant.revoked_at is null and sync_session_recall_ready(parent_grant.session_id)
                                )
                            )
                          )
                        )
                    ),
                    array[]::text[]
                  ) as parent_node_ids,
                  case
                    when me.memory_node_id is not null
                      and (
                        $8::text <> 'global'
                        or $12::timestamptz is not null
                        or $13::timestamptz is not null
                      )
                    then exists (
                      select 1
                      from memory_node_sources boundary_mns
                      left join memory_events boundary_ev on boundary_ev.id = boundary_mns.memory_event_id and boundary_ev.invalidated_at is null and boundary_ev.personal_deleted_at is null
                      left join messages boundary_msg on boundary_msg.id = boundary_mns.message_id and boundary_msg.invalidated_at is null and boundary_msg.recall_eligible = true
                      left join sessions boundary_session on boundary_session.id = coalesce(boundary_ev.session_id, boundary_msg.session_id)
                      where boundary_mns.memory_node_id = me.memory_node_id
                        and not (
                          (
                            $8::text = 'global'
                            or (
                              $8::text = 'session'
                              and (boundary_ev.session_id = $9::uuid or boundary_msg.session_id = $9::uuid)
                            )
                            or (
                              $8::text = 'project'
                              and (
                                (
                                  $15::uuid is null
                                  and (
                                    coalesce(
                                      boundary_session.project_override_id,
                                      boundary_session.automatic_project_id,
                                      case when boundary_session.id is null then boundary_ev.payload ->> 'workspaceId' end,
                                      'unassigned'
                                    ) = $10
                                    or coalesce(boundary_session.project_override_path, boundary_session.automatic_project_path) = $10
                                  )
                                )
                                or $15::uuid is not null
                              )
                            )
                          )
                          and (
                            ($12::timestamptz is null and $13::timestamptz is null)
                            or (
                              coalesce(boundary_ev.captured_at, boundary_msg.captured_at) is not null
                              and ($12::timestamptz is null or coalesce(boundary_ev.captured_at, boundary_msg.captured_at) >= $12::timestamptz)
                              and ($13::timestamptz is null or coalesce(boundary_ev.captured_at, boundary_msg.captured_at) < $13::timestamptz)
                            )
                          )
                        )
                    )
                    else false
                  end as has_out_of_window_sources,
                  case
                    when me.memory_node_id is not null
                      and (
                        $8::text <> 'global'
                        or $12::timestamptz is not null
                        or $13::timestamptz is not null
                      )
                    then (
                      select json_agg(
                        json_build_object(
                          'createdAt', to_char(source_row.source_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                          'text', source_row.source_text,
                          'projectName', source_row.project_name,
                          'projectPath', source_row.project_path
                        )
                        order by source_row.source_created_at asc, source_row.source_id asc
                      )
                      from (
                        select
                          coalesce(time_ev.id, time_msg.id) as source_id,
                          coalesce(time_ev.captured_at, time_msg.captured_at) as source_created_at,
                          coalesce(time_ev.payload ->> 'content', time_msg.content, '') as source_text,
                          case
                            when $15::uuid is null then coalesce(time_session.project_override_name, time_session.automatic_project_name, 'Unassigned')
                            else 'Team Workspace'
                          end as project_name,
                          case
                            when $15::uuid is null then coalesce(time_session.project_override_path, time_session.automatic_project_path)
                            else null::text
                          end as project_path
                        from memory_node_sources time_mns
                        left join memory_events time_ev on time_ev.id = time_mns.memory_event_id and time_ev.invalidated_at is null and time_ev.personal_deleted_at is null
                        left join messages time_msg on time_msg.id = time_mns.message_id and time_msg.invalidated_at is null and time_msg.recall_eligible = true
                        left join sessions time_session on time_session.id = coalesce(time_ev.session_id, time_msg.session_id)
                        where time_mns.memory_node_id = me.memory_node_id
                          and (
                            $8::text = 'global'
                            or (
                              $8::text = 'session'
                              and (time_ev.session_id = $9::uuid or time_msg.session_id = $9::uuid)
                            )
                            or (
                              $8::text = 'project'
                              and (
                                (
                                  $15::uuid is null
                                  and (
                                    coalesce(
                                      time_session.project_override_id,
                                      time_session.automatic_project_id,
                                      case when time_session.id is null then time_ev.payload ->> 'workspaceId' end,
                                      'unassigned'
                                    ) = $10
                                    or coalesce(time_session.project_override_path, time_session.automatic_project_path) = $10
                                  )
                                )
                                or $15::uuid is not null
                              )
                            )
                          )
                          and (
                            ($12::timestamptz is null and $13::timestamptz is null)
                            or coalesce(time_ev.captured_at, time_msg.captured_at) is not null
                          )
                          and coalesce(time_ev.payload ->> 'content', time_msg.content, '') <> ''
                          and ($12::timestamptz is null or coalesce(time_ev.captured_at, time_msg.captured_at) >= $12::timestamptz)
                          and ($13::timestamptz is null or coalesce(time_ev.captured_at, time_msg.captured_at) < $13::timestamptz)
                        order by coalesce(time_ev.captured_at, time_msg.captured_at) asc, coalesce(time_ev.id, time_msg.id) asc
                      ) source_row
                    )
                    else null
                  end as filtered_source_items,
                  me.visibility,
                  case
                    when me.memory_node_id is not null
                    then coalesce(mn.summary_text, me.source_text, '')
                    else coalesce(me.source_text, ev.payload ->> 'content', msg.content, '')
                  end as summary_text,
                  case
                    when mn.summary_model is not null then mn.summary_text
                    when linked_mn.summary_model is not null
                      and (
                        ($15::uuid is null and me.owner_user_id = $1)
                        or (
                          $15::uuid is not null
                          and exists (
                            select 1
                            from memory_node_sources rerank_any_mns
                            where rerank_any_mns.memory_node_id = linked_mn.id
                          )
                          and not exists (
                            select 1
                            from memory_node_sources rerank_mns
                            left join memory_events rerank_ev on rerank_ev.id = rerank_mns.memory_event_id and rerank_ev.invalidated_at is null
                            left join messages rerank_msg on rerank_msg.id = rerank_mns.message_id and rerank_msg.invalidated_at is null and rerank_msg.recall_eligible = true
                            where rerank_mns.memory_node_id = linked_mn.id
                              and not exists (
                                select 1
                                from team_session_share_grants rerank_grant
                                where rerank_grant.session_id = coalesce(rerank_ev.session_id, rerank_msg.session_id)
                                  and rerank_grant.team_workspace_id = $15::uuid
                                  and rerank_grant.team_id = $16::uuid
                      and rerank_grant.revoked_at is null and sync_session_recall_ready(rerank_grant.session_id)
                              )
                          )
                        )
                      )
                    then linked_mn.summary_text
                    else null
                  end as rerank_text,
                  coalesce(mn.summary_model, linked_mn.summary_model) as lcm_summary_model,
                  (
                    (mn.id is not null and mn.summary_model is null)
                    or
                    (linked_mn.id is not null and linked_mn.summary_model is null)
                  ) as lcm_summary_pending,
                  1 - (v.embedding <=> $3::vector) as score,
                  coalesce(
                    case
                      when me.memory_node_id is not null then (
                        select max(coalesce(source_ev.captured_at, source_msg.captured_at))
                        from memory_node_sources source_mns
                        left join memory_events source_ev on source_ev.id = source_mns.memory_event_id and source_ev.invalidated_at is null
                        left join messages source_msg on source_msg.id = source_mns.message_id and source_msg.invalidated_at is null and source_msg.recall_eligible = true
                        where source_mns.memory_node_id = me.memory_node_id
                      )
                      else null
                    end,
                    ev.captured_at,
                    msg.captured_at,
                    me.created_at
                  ) as created_at,
                  me.embedding_model,
                  me.embedding_dimensions,
                  me.source_chunk_index,
                  me.source_chunk_count
                from memory_embeddings me
                join ${embeddingTable} v on v.memory_embedding_id = me.id
                left join memory_nodes mn on mn.id = me.memory_node_id and mn.invalidated_at is null and mn.personal_deleted_at is null
                left join memory_events ev on ev.id = me.memory_event_id and ev.invalidated_at is null and ev.include_in_embedding = true
                left join messages msg on msg.id = me.message_id and msg.invalidated_at is null and msg.recall_eligible = true
                left join sessions ev_session on ev_session.id = ev.session_id
                left join sessions msg_session on msg_session.id = msg.session_id
                left join memory_node_sources mns on mns.memory_event_id = me.memory_event_id or mns.message_id = me.message_id
                left join memory_nodes linked_mn on linked_mn.id = mns.memory_node_id and linked_mn.invalidated_at is null and linked_mn.personal_deleted_at is null
                where me.invalidated_at is null
                  and me.embedding_model = $5
                  and me.embedding_dimensions = $6
                  and me.embedding_version = $7
                  and (
                    (
                      me.memory_node_id is not null
                      and mn.id is not null
                      and me.personal_deleted_at is null
                    )
                    or (
                      me.memory_event_id is not null
                      and ev.id is not null
                      and (
                        me.personal_deleted_at is null
                        or (
                          $15::uuid is not null
                          and exists (
                            select 1
                            from team_session_share_grants auth_grant
                            where auth_grant.session_id = ev.session_id
                              and auth_grant.team_workspace_id = $15::uuid
                              and auth_grant.team_id = $16::uuid
                              and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                          )
                        )
                      )
                    )
                    or (me.message_id is not null and msg.id is not null)
                  )
                  and me.visibility = 'personal'
                  and (me.memory_event_id is null or sync_session_recall_ready(ev.session_id))
                  and (me.message_id is null or sync_session_recall_ready(msg.session_id))
                  and (
                    me.memory_node_id is null
                    or not exists (
                      select 1
                      from memory_node_sources ready_mns
                      left join memory_events ready_ev on ready_ev.id = ready_mns.memory_event_id
                      left join messages ready_msg on ready_msg.id = ready_mns.message_id
                      where ready_mns.memory_node_id = me.memory_node_id
                        and not sync_session_recall_ready(coalesce(ready_ev.session_id, ready_msg.session_id))
                    )
                  )
                  and (
                    ($15::uuid is null and me.owner_user_id = $1)
                    or (
                      $15::uuid is not null
                      and (
                        (
                          me.memory_node_id is not null
                          and exists (
                            select 1
                            from memory_node_sources auth_any_mns
                            where auth_any_mns.memory_node_id = me.memory_node_id
                          )
                          and not exists (
                            select 1
                            from memory_node_sources auth_mns
                            left join memory_events auth_ev on auth_ev.id = auth_mns.memory_event_id and auth_ev.invalidated_at is null
                            left join messages auth_msg on auth_msg.id = auth_mns.message_id and auth_msg.invalidated_at is null and auth_msg.recall_eligible = true
                            where auth_mns.memory_node_id = me.memory_node_id
                              and not exists (
                                select 1
                                from team_session_share_grants auth_grant
                                where auth_grant.session_id = coalesce(auth_ev.session_id, auth_msg.session_id)
                                  and auth_grant.team_workspace_id = $15::uuid
                                  and auth_grant.team_id = $16::uuid
                                  and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                              )
                          )
                        )
                        or (
                          me.memory_event_id is not null
                          and exists (
                            select 1
                            from team_session_share_grants auth_grant
                            where auth_grant.session_id = ev.session_id
                              and auth_grant.team_workspace_id = $15::uuid
                              and auth_grant.team_id = $16::uuid
                              and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                          )
                        )
                        or (
                          me.message_id is not null
                          and exists (
                            select 1
                            from team_session_share_grants auth_grant
                            where auth_grant.session_id = msg.session_id
                              and auth_grant.team_workspace_id = $15::uuid
                              and auth_grant.team_id = $16::uuid
                              and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                          )
                        )
                      )
                    )
                  )
                  and ($2::visibility_scope is null or me.visibility = $2::visibility_scope)
                  and (
                    $8::text = 'global'
                    or (
                      $8::text = 'session'
                      and (
                        ev.session_id = $9::uuid
                        or msg.session_id = $9::uuid
                        or exists (
                          select 1
                          from memory_node_sources filter_mns
                          left join memory_events filter_ev on filter_ev.id = filter_mns.memory_event_id and filter_ev.invalidated_at is null and filter_ev.personal_deleted_at is null
                          left join messages filter_msg on filter_msg.id = filter_mns.message_id and filter_msg.invalidated_at is null and filter_msg.recall_eligible = true
                          where filter_mns.memory_node_id = me.memory_node_id
                            and (filter_ev.session_id = $9::uuid or filter_msg.session_id = $9::uuid)
                        )
                      )
                    )
                    or (
                      $8::text = 'project'
                      and (
                        (
                          $15::uuid is null
                          and (
                            (
                              ev.id is not null
                              and (
                                coalesce(
                                  ev_session.project_override_id,
                                  ev_session.automatic_project_id,
                                  case when ev_session.id is null then ev.payload ->> 'workspaceId' end,
                                  'unassigned'
                                ) = $10
                                or coalesce(ev_session.project_override_path, ev_session.automatic_project_path) = $10
                              )
                            )
                            or (
                              msg.id is not null
                              and (
                                coalesce(msg_session.project_override_id, msg_session.automatic_project_id, 'unassigned') = $10
                                or coalesce(msg_session.project_override_path, msg_session.automatic_project_path) = $10
                              )
                            )
                          )
                        )
                        or $15::uuid is not null
                        or exists (
                          select 1
                          from memory_node_sources filter_mns
                          left join memory_events filter_ev on filter_ev.id = filter_mns.memory_event_id and filter_ev.invalidated_at is null and filter_ev.personal_deleted_at is null
                          left join messages filter_msg on filter_msg.id = filter_mns.message_id and filter_msg.invalidated_at is null and filter_msg.recall_eligible = true
                          left join sessions filter_session on filter_session.id = coalesce(filter_ev.session_id, filter_msg.session_id)
                          where filter_mns.memory_node_id = me.memory_node_id
                            and (
                              (
                                $15::uuid is null
                                and (
                                  coalesce(
                                    filter_session.project_override_id,
                                    filter_session.automatic_project_id,
                                    case when filter_session.id is null then filter_ev.payload ->> 'workspaceId' end,
                                    'unassigned'
                                  ) = $10
                                  or coalesce(filter_session.project_override_path, filter_session.automatic_project_path) = $10
                                )
                              )
                              or $15::uuid is not null
                            )
                        )
                      )
                    )
                  )
                  and (
                    ($12::timestamptz is null and $13::timestamptz is null)
                    or (
                      me.memory_node_id is not null
                      and exists (
                        select 1
                        from memory_node_sources time_mns
                        left join memory_events time_ev on time_ev.id = time_mns.memory_event_id and time_ev.invalidated_at is null and time_ev.personal_deleted_at is null
                        left join messages time_msg on time_msg.id = time_mns.message_id and time_msg.invalidated_at is null and time_msg.recall_eligible = true
                        where time_mns.memory_node_id = me.memory_node_id
                          and ($12::timestamptz is null or coalesce(time_ev.captured_at, time_msg.captured_at) >= $12::timestamptz)
                          and ($13::timestamptz is null or coalesce(time_ev.captured_at, time_msg.captured_at) < $13::timestamptz)
                      )
                    )
                    or (
                      me.memory_event_id is not null
                      and ($12::timestamptz is null or ev.captured_at >= $12::timestamptz)
                      and ($13::timestamptz is null or ev.captured_at < $13::timestamptz)
                    )
                    or (
                      me.message_id is not null
                      and ($12::timestamptz is null or msg.captured_at >= $12::timestamptz)
                      and ($13::timestamptz is null or msg.captured_at < $13::timestamptz)
                    )
                  )
                  and (
                    me.memory_node_id is null
                    or exists (
                      select 1
                      from memory_node_sources source_mns
                      left join memory_events source_ev on source_ev.id = source_mns.memory_event_id and source_ev.invalidated_at is null and source_ev.personal_deleted_at is null
                      left join messages source_msg on source_msg.id = source_mns.message_id and source_msg.invalidated_at is null and source_msg.recall_eligible = true
                      left join sessions source_session on source_session.id = coalesce(source_ev.session_id, source_msg.session_id)
                      where source_mns.memory_node_id = me.memory_node_id
                        and (
                          $8::text = 'global'
                          or (
                            $8::text = 'session'
                            and (source_ev.session_id = $9::uuid or source_msg.session_id = $9::uuid)
                          )
                          or (
                            $8::text = 'project'
                            and (
                              (
                                $15::uuid is null
                                and (
                                  coalesce(
                                    source_session.project_override_id,
                                    source_session.automatic_project_id,
                                    case when source_session.id is null then source_ev.payload ->> 'workspaceId' end,
                                    'unassigned'
                                  ) = $10
                                  or coalesce(source_session.project_override_path, source_session.automatic_project_path) = $10
                                )
                              )
                              or $15::uuid is not null
                            )
                          )
                        )
                        and (
                          ($12::timestamptz is null and $13::timestamptz is null)
                          or (
                            coalesce(source_ev.captured_at, source_msg.captured_at) is not null
                            and ($12::timestamptz is null or coalesce(source_ev.captured_at, source_msg.captured_at) >= $12::timestamptz)
                            and ($13::timestamptz is null or coalesce(source_ev.captured_at, source_msg.captured_at) < $13::timestamptz)
                          )
                        )
                    )
                  )
                  and (
                    ($11::text = 'rollup_search' and me.memory_node_id is not null and mn.kind = 'rollup')
                    or ($11::text = 'leaf_search' and me.memory_node_id is not null and mn.kind = 'leaf')
                    or (
                      $11::text = 'scoped_leaf_search'
                      and me.memory_node_id is not null
                      and mn.kind = 'leaf'
                      and exists (
                        select 1
                        from memory_node_children scoped_parent
                        join memory_nodes scoped_parent_node
                          on scoped_parent_node.id = scoped_parent.parent_memory_node_id
                          and scoped_parent_node.invalidated_at is null
                          and scoped_parent_node.personal_deleted_at is null
                        where scoped_parent.child_memory_node_id = me.memory_node_id
                          and scoped_parent.parent_memory_node_id = any($14::uuid[])
                          and scoped_parent_node.visibility = 'personal'
                          and (
                            ($15::uuid is null and scoped_parent_node.owner_user_id = $1)
                            or (
                              $15::uuid is not null
                              and exists (
                                select 1
                                from memory_node_sources scoped_parent_any_mns
                                where scoped_parent_any_mns.memory_node_id = scoped_parent_node.id
                              )
                              and not exists (
                                select 1
                                from memory_node_sources scoped_parent_mns
                                left join memory_events scoped_parent_ev on scoped_parent_ev.id = scoped_parent_mns.memory_event_id and scoped_parent_ev.invalidated_at is null
                                left join messages scoped_parent_msg on scoped_parent_msg.id = scoped_parent_mns.message_id and scoped_parent_msg.invalidated_at is null and scoped_parent_msg.recall_eligible = true
                                where scoped_parent_mns.memory_node_id = scoped_parent_node.id
                                  and not exists (
                                    select 1
                                    from team_session_share_grants scoped_parent_grant
                                    where scoped_parent_grant.session_id = coalesce(scoped_parent_ev.session_id, scoped_parent_msg.session_id)
                                      and scoped_parent_grant.team_workspace_id = $15::uuid
                                      and scoped_parent_grant.team_id = $16::uuid
                      and scoped_parent_grant.revoked_at is null and sync_session_recall_ready(scoped_parent_grant.session_id)
                                  )
                              )
                            )
                          )
                      )
                    )
                    or (
                      $11::text = 'fresh_pending_search'
                      and me.memory_node_id is null
                      and coalesce(ev.payload ->> 'actor', msg.role, '') <> 'tool'
                      and (
                        (
                          me.memory_event_id is not null
                          and not exists (
                            select 1
                            from memory_node_sources linked_source
                            join memory_nodes linked_node on linked_node.id = linked_source.memory_node_id
                            where linked_source.memory_event_id = me.memory_event_id
                              and linked_node.invalidated_at is null and linked_node.personal_deleted_at is null
                              and linked_node.kind = 'leaf'
                          )
                        )
                        or (
                          me.message_id is not null
                          and not exists (
                            select 1
                            from memory_node_sources linked_source
                            join memory_nodes linked_node on linked_node.id = linked_source.memory_node_id
                            where linked_source.message_id = me.message_id
                              and linked_node.invalidated_at is null and linked_node.personal_deleted_at is null
                              and linked_node.kind = 'leaf'
                          )
                        )
                      )
                    )
                    or (
                      $11::text = 'raw_fallback_search'
                      and me.memory_node_id is null
                      and coalesce(ev.payload ->> 'actor', msg.role, '') <> 'tool'
                    )
                  )
              )
              select *
              from candidates
              order by score desc, created_at desc, source_id
              limit $4
            `,
                [
                  actor.userId,
                  visibility,
                  vectorLiteral(queryVector),
                  limit,
                  embedded.model,
                  embedded.dimensions,
                  localEmbeddingVersion(),
                  searchDomain,
                  input.sessionId ?? null,
                  input.workspaceId ?? null,
                  stage,
                  sourceAfter,
                  sourceBefore,
                  parentNodeIds,
                  teamWorkspaceBoundary?.teamWorkspaceId ?? null,
                  teamWorkspaceBoundary?.teamId ?? null
                ]
              );
              const rows = await hydrateSearchRows(
                vectorResult.rows.map((row) => {
                  const filteredSummary = row.has_out_of_window_sources
                    ? filteredNodeSourceText(row.filtered_source_items)
                    : null;
                  return filteredSummary
                    ? {
                        ...row,
                        summary_text: filteredSummary,
                        rerank_text: filteredSummary
                      }
                    : row;
                })
              );
              const reranked = await rerankStageRows(stage, rows);
              return {
                name: stage,
                rows: reranked.rows,
                durationMs: Date.now() - started,
                reranked: reranked.reranked,
                rerankedCount: reranked.rerankedCount,
                rerankerModel: reranked.rerankerModel,
                rerankingUnavailable: reranked.rerankingUnavailable,
                rerankingError: reranked.rerankingError,
                parentNodeIds
              };
            };

            const skippedRawFallback: StageResult = {
              name: "raw_fallback_search",
              rows: [],
              durationMs: 0,
              reranked: false,
              rerankedCount: 0,
              parentNodeIds: []
            };
            const emptyStage = (
              name: RetrievalStageName,
              parentNodeIds: string[] = []
            ): StageResult => ({
              name,
              rows: [],
              durationMs: 0,
              reranked: false,
              rerankedCount: 0,
              parentNodeIds
            });
            const runScopedLeaves = async (
              parentNodeIds: string[]
            ): Promise<StageResult> =>
              parentNodeIds.length > 0
                ? runStage(
                    "scoped_leaf_search",
                    scopedLeafCandidateLimit,
                    parentNodeIds
                  )
                : emptyStage("scoped_leaf_search", parentNodeIds);
            const runRequestedSemanticStage = async (): Promise<
              StageResult[]
            > => {
              if (!requestedStage) {
                return [];
              }
              if (requestedStage === "rollup_search") {
                return [await runStage("rollup_search", rollupCandidateLimit)];
              }
              if (requestedStage === "leaf_search") {
                return [await runStage("leaf_search", leafCandidateLimit)];
              }
              if (requestedStage === "curated_memory_search") {
                return [];
              }
              if (requestedStage === "fresh_pending_search") {
                return [
                  await runStage("fresh_pending_search", freshCandidateLimit)
                ];
              }
              if (requestedStage === "raw_fallback_search") {
                return [
                  rawFallbackEnabled
                    ? await runStage("raw_fallback_search", rawCandidateLimit)
                    : skippedRawFallback
                ];
              }
              return [
                await runScopedLeaves(
                  requestedParentNodeIds.length > 0 ? visibleParentNodeIds : []
                )
              ];
            };
            const runDefaultSemanticStages = async (): Promise<
              StageResult[]
            > => {
              const [rollups, leaves, fresh, rawFallback] = await Promise.all([
                runStage("rollup_search", rollupCandidateLimit),
                runStage("leaf_search", leafCandidateLimit),
                runStage("fresh_pending_search", freshCandidateLimit),
                rawFallbackEnabled
                  ? runStage("raw_fallback_search", rawCandidateLimit)
                  : Promise.resolve(skippedRawFallback)
              ]);
              const selectedRollupIds =
                requestedParentNodeIds.length > 0
                  ? visibleParentNodeIds
                  : rollups.rows
                      .slice(0, rollupResultLimit)
                      .map((row) => row.source_id);
              const scopedLeaves = await runScopedLeaves(selectedRollupIds);
              return [rollups, leaves, fresh, rawFallback, scopedLeaves];
            };
            const stages = requestedStage
              ? await runRequestedSemanticStage()
              : await runDefaultSemanticStages();
            if (stages.length > 0) {
              vectorRows.push(
                ...stages.flatMap((stage) =>
                  stage.rows.filter(
                    (row) => Number(row.score) >= scoreThresholds[stage.name]
                  )
                )
              );
              const anyReranked = stages.some((stage) => stage.reranked);
              const rerankingErrors = stages
                .map((stage) => stage.rerankingError)
                .filter((value): value is string => Boolean(value));
              embeddingMetadata = defaultRetrievalMetadata({
                retrievalMode: anyReranked
                  ? "semantic_vector_reranked"
                  : "semantic_vector",
                vectorHitsCount: vectorRows.length,
                vectorCandidateCount: vectorRows.length,
                embeddingModel: embedded.model,
                embeddingDimensions: embedded.dimensions,
                rerankedCount: stages.reduce(
                  (sum, stage) => sum + stage.rerankedCount,
                  0
                ),
                rerankerModel:
                  stages.find((stage) => stage.rerankerModel)?.rerankerModel ??
                  null,
                rerankingEnabled: shouldRerank,
                rerankingUnavailable:
                  shouldRerank &&
                  stages.some((stage) => stage.rerankingUnavailable),
                rerankingError:
                  rerankingErrors.length > 0
                    ? rerankingErrors.join("; ")
                    : undefined,
                temporalFilter
              });
              stageDiagnostics.push(
                ...stages.map((stage) => ({
                  name: stage.name,
                  ran:
                    stage.name !== "raw_fallback_search" || rawFallbackEnabled
                      ? true
                      : false,
                  used: false,
                  candidateCount: stage.rows.length,
                  selectedCount: 0,
                  durationMs: stage.durationMs,
                  parallelGroup:
                    stage.name === "scoped_leaf_search"
                      ? "post_rollup"
                      : "initial_candidates",
                  temporalFilterApplied: Boolean(temporalFilter),
                  reranked: stage.reranked,
                  parentNodeIds: stage.parentNodeIds,
                  topScore: stage.rows[0]?.score,
                  scoreThreshold: scoreThresholds[stage.name],
                  countAboveThreshold: stage.rows.filter(
                    (row) => Number(row.score) >= scoreThresholds[stage.name]
                  ).length,
                  maxAllowed: stageMaxAllowed[stage.name],
                  rejectedCount: stage.rows.filter(
                    (row) => Number(row.score) < scoreThresholds[stage.name]
                  ).length,
                  candidateIds: stage.rows
                    .filter(
                      (row) => Number(row.score) >= scoreThresholds[stage.name]
                    )
                    .slice(0, stageMaxAllowed[stage.name])
                    .map((row) => row.source_id)
                }))
              );
            }
          }
        }
      } catch (error) {
        console.warn(
          `Local embedding query failed; semantic retrieval unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (!requestedStage || requestedStage === "curated_memory_search") {
        const curated = await runCuratedMemoryStage();
        vectorRows.push(
          ...curated.rows.filter(
            (row) => Number(row.score) >= scoreThresholds.curated_memory_search
          )
        );
        stageDiagnostics.push({
          name: curated.name,
          ran: shouldRunCuratedMemoryStage && !teamWorkspaceBoundary,
          used: false,
          candidateCount: curated.rows.length,
          selectedCount: 0,
          durationMs: curated.durationMs,
          parallelGroup: "curated_memory_candidates",
          temporalFilterApplied: Boolean(temporalFilter),
          reranked: false,
          parentNodeIds: [],
          topScore: curated.rows[0]?.score,
          scoreThreshold: scoreThresholds.curated_memory_search,
          countAboveThreshold: curated.rows.filter(
            (row) => Number(row.score) >= scoreThresholds.curated_memory_search
          ).length,
          maxAllowed: stageMaxAllowed.curated_memory_search,
          rejectedCount: curated.rows.filter(
            (row) => Number(row.score) < scoreThresholds.curated_memory_search
          ).length,
          candidateIds: curated.rows
            .filter(
              (row) =>
                Number(row.score) >= scoreThresholds.curated_memory_search
            )
            .slice(0, stageMaxAllowed.curated_memory_search)
            .map((row) => row.source_id)
        });
      }
      if (requestedStage === "lexical_search") {
        const lexical = await runLexicalStage();
        vectorRows.push(
          ...lexical.rows.filter(
            (row) => Number(row.score) >= scoreThresholds.lexical_search
          )
        );
        stageDiagnostics.push({
          name: lexical.name,
          ran: true,
          used: false,
          candidateCount: lexical.rows.length,
          selectedCount: 0,
          durationMs: lexical.durationMs,
          parallelGroup: "lexical_candidates",
          temporalFilterApplied: Boolean(temporalFilter),
          reranked: false,
          parentNodeIds: [],
          topScore: lexical.rows[0]?.score,
          scoreThreshold: scoreThresholds.lexical_search,
          countAboveThreshold: lexical.rows.length,
          maxAllowed: stageMaxAllowed.lexical_search,
          rejectedCount: 0,
          candidateIds: lexical.rows
            .slice(0, stageMaxAllowed.lexical_search)
            .map((row) => row.source_id)
        });
      }

      const merged = new Map<
        string,
        MemorySearchResult & {
          createdAt: Date;
          stagePriority: number;
        }
      >();
      const addRow = (
        row: {
          id: string;
          source_type:
            | "memory_node"
            | "memory_event"
            | "message"
            | "curated_memory";
          source_id: string;
          retrieval_stage: RetrievalStageName;
          parent_node_ids?: string[] | null;
          visibility: Visibility;
          summary_text: string;
          lcm_summary_model?: string | null;
          lcm_summary_pending?: boolean;
          source_chunk_index?: number | null;
          source_chunk_count?: number | null;
          score: number;
          created_at: Date;
        },
        weight: number
      ) => {
        const summaryText = codexIdePromptUserText(row.summary_text).trim();
        const normalizedText = summaryText.toLowerCase();
        const key = normalizedText
          ? `${row.visibility}:${normalizedText}`
          : `${row.source_type}:${row.source_id}`;
        const score = Number(row.score) * weight;
        const priority = stagePriority[row.retrieval_stage];
        const existing = merged.get(key);
        if (
          !existing ||
          score > existing.score ||
          (score === existing.score && priority > existing.stagePriority)
        ) {
          merged.set(key, {
            nodeId: row.id,
            sourceType: row.source_type,
            sourceId: row.source_id,
            sourceChunkIndex: row.source_chunk_index ?? undefined,
            sourceChunkCount: row.source_chunk_count ?? undefined,
            retrievalStage: row.retrieval_stage,
            parentNodeIds: row.parent_node_ids ?? undefined,
            visibility: row.visibility,
            summaryText,
            lcmNodeSummaryStatus: row.lcm_summary_pending
              ? "pending"
              : row.lcm_summary_model
                ? "summarized"
                : undefined,
            lcmNodeSummaryModel: row.lcm_summary_model ?? undefined,
            score,
            citation: {
              nodeId: row.id,
              sourceType: row.source_type,
              sourceId: row.source_id,
              sourceChunkIndex: row.source_chunk_index ?? undefined,
              sourceChunkCount: row.source_chunk_count ?? undefined,
              retrievalStage: row.retrieval_stage,
              parentNodeIds: row.parent_node_ids ?? undefined,
              visibility: row.visibility
            },
            createdAt: row.created_at,
            stagePriority: priority
          });
        }
      };

      const rowsByStage = (stage: RetrievalStageName): VectorRow[] =>
        vectorRows.filter((row) => row.retrieval_stage === stage);
      const requestedStageDiagnostics = requestedStage
        ? stageDiagnostics.find((stage) => stage.name === requestedStage)
        : undefined;
      if (requestedStage && input.strictLimit) {
        const maxAllowed =
          requestedStageDiagnostics?.maxAllowed ??
          stageMaxAllowed[requestedStage];
        const countAboveThreshold =
          requestedStageDiagnostics?.countAboveThreshold ??
          rowsByStage(requestedStage).length;
        if (requestedLimit > maxAllowed) {
          throw Object.assign(
            new Error(
              `Requested ${requestedLimit} ${requestedStage} candidates but the configured stage maximum is ${maxAllowed}`
            ),
            {
              statusCode: 400,
              payload: {
                error: "limit_exceeds_stage_max",
                stage: requestedStage,
                requested: requestedLimit,
                maxAllowed
              }
            }
          );
        }
        if (requestedLimit > countAboveThreshold) {
          throw Object.assign(
            new Error(
              `Requested ${requestedLimit} ${requestedStage} candidates but only ${countAboveThreshold} are above threshold`
            ),
            {
              statusCode: 400,
              payload: {
                error: "limit_exceeds_available_candidates",
                stage: requestedStage,
                requested: requestedLimit,
                countAboveThreshold,
                maxAllowed
              }
            }
          );
        }
      }
      if (scanOnly) {
        return {
          results: [],
          metadata: {
            ...embeddingMetadata,
            vectorHitsCount: 0,
            textHitsCount: 0,
            vectorCandidateCount: vectorRows.length,
            stages: stageDiagnostics.map((stage) => ({
              ...stage,
              used: false,
              selectedCount: 0
            }))
          }
        };
      }
      for (const row of [
        ...selectStageRowsForEvidence(
          "rollup_search",
          rowsByStage("rollup_search")
        ),
        ...rowsByStage("scoped_leaf_search"),
        ...rowsByStage("leaf_search"),
        ...rowsByStage("curated_memory_search"),
        ...rowsByStage("fresh_pending_search"),
        ...rowsByStage("lexical_search")
      ]) {
        if (!requestedStage || row.retrieval_stage === requestedStage) {
          addRow(row, stageWeight[row.retrieval_stage]);
        }
      }

      if (!requestedStage && merged.size < requestedLimit) {
        for (const row of rowsByStage("raw_fallback_search")) {
          addRow(row, stageWeight.raw_fallback_search);
        }
      } else if (requestedStage === "raw_fallback_search") {
        for (const row of rowsByStage("raw_fallback_search")) {
          addRow(row, stageWeight.raw_fallback_search);
        }
      }

      const results = [...merged.values()]
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.stagePriority - left.stagePriority ||
            right.createdAt.getTime() - left.createdAt.getTime() ||
            (left.sourceId ?? left.nodeId).localeCompare(
              right.sourceId ?? right.nodeId
            )
        )
        .slice(0, requestedLimit)
        .map((result) => ({
          nodeId: result.nodeId,
          sourceType: result.sourceType,
          sourceId: result.sourceId,
          sourceChunkIndex: result.sourceChunkIndex,
          sourceChunkCount: result.sourceChunkCount,
          retrievalStage: result.retrievalStage,
          parentNodeIds: result.parentNodeIds,
          visibility: result.visibility,
          summaryText: result.summaryText,
          lcmNodeSummaryStatus: result.lcmNodeSummaryStatus,
          lcmNodeSummaryModel: result.lcmNodeSummaryModel,
          score: result.score,
          citation: result.citation
        }));

      for (const stage of stageDiagnostics) {
        const count = results.filter(
          (result) => result.retrievalStage === stage.name
        ).length;
        stage.selectedCount = count;
        stage.used = count > 0;
      }
      embeddingMetadata = {
        ...embeddingMetadata,
        vectorHitsCount: vectorRows.length,
        vectorCandidateCount: vectorRows.length,
        stages: stageDiagnostics
      };

      return { results, metadata: embeddingMetadata };
    },

    async createLcmNodes(actor, input) {
      const ownerUserId = actor.userId;
      const workClass = input.workClass ?? "normal_embedding_lcm";
      const suppressPlaintextPayload =
        managedCloudPlaintextMemoryPayloadsDisabled();
      if (suppressPlaintextPayload && !options.envelopeEncryptionProvider) {
        throw new Error(
          "Envelope encryption provider is required when plaintext Memory Node storage is disabled"
        );
      }
      const client = await pool.connect();

      try {
        await client.query("begin");
        const eventRows = await client.query<{
          id: string;
          visibility: Visibility;
          actor: MemoryActor | null;
          owner_user_id: string | null;
          session_id: string | null;
          turn_id: string | null;
          payload: MemoryEventPayload;
          captured_at: Date;
        }>(
          `
          select
            me.id,
            me.visibility,
            me.payload ->> 'actor' as actor,
            me.owner_user_id,
            me.session_id,
            me.turn_id,
            me.payload,
            me.captured_at
          from memory_events me
          left join conversation_projection_processing_outbox processing
            on processing.event_id = me.id
          where me.invalidated_at is null and me.personal_deleted_at is null
            and me.visibility = $1
            and me.owner_user_id = $2
            and coalesce(processing.work_class, 'normal_embedding_lcm') = $3
            and ($5::uuid is null or me.session_id = $5::uuid)
            and me.include_in_lcm = true
            and not exists (
              select 1
              from memory_node_sources mns
              join memory_nodes mn on mn.id = mns.memory_node_id
              where mns.memory_event_id = me.id
                and mn.kind = 'leaf'
                and mn.invalidated_at is null and mn.personal_deleted_at is null
            )
          order by me.captured_at asc, me.id asc
          limit $4
        `,
          [
            input.visibility,
            ownerUserId,
            workClass,
            lcmCompactionMaxEvents(),
            input.sessionId ?? null
          ]
        );

        const hydratedEventRows = await Promise.all(
          eventRows.rows.map(async (event) => {
            if (
              (event.payload.content &&
                event.payload.content !== ENCRYPTED_MEMORY_EVENT_TEXT) ||
              !options.envelopeEncryptionProvider ||
              event.payload.contentEncrypted !== true
            ) {
              return event;
            }
            const payload = await decryptAuthorizedMemoryEventPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: event.owner_user_id,
                memoryEventId: event.id
              }
            );
            return payload
              ? {
                  ...event,
                  actor: event.actor ?? payload.actor ?? null,
                  payload
                }
              : event;
          })
        );
        const freshTail = lcmFreshEventTail();
        const events = input.finalize
          ? hydratedEventRows
          : freshTail > 0 && hydratedEventRows.length > freshTail
            ? hydratedEventRows.slice(0, hydratedEventRows.length - freshTail)
            : freshTail === 0
              ? hydratedEventRows
              : [];
        const eventThreshold = lcmLeafEventThreshold();
        const tokenThreshold = lcmLeafTokenThreshold();
        const tokenModel = lcmSummaryModel();
        const leafNodeIds: string[] = [];

        const spans: (typeof events)[] = [];
        for (const sessionEvents of groupByLcmSessionKey(events)) {
          let currentSpan: typeof events = [];
          let currentTokens = 0;
          for (const event of sessionEvents) {
            const eventTokens = estimateTokens(
              memoryEventLcmContent(event.payload) ?? "",
              {
                model: tokenModel
              }
            );
            if (
              currentSpan.length > 0 &&
              currentTokens + eventTokens > tokenThreshold
            ) {
              spans.push(currentSpan);
              currentSpan = [];
              currentTokens = 0;
            }
            currentSpan.push(event);
            currentTokens += eventTokens;
            if (
              currentSpan.length >= eventThreshold ||
              currentTokens >= tokenThreshold
            ) {
              spans.push(currentSpan);
              currentSpan = [];
              currentTokens = 0;
            }
          }
          if (currentSpan.length > 0) {
            const remainingTokens = currentSpan.reduce(
              (sum, event) =>
                sum +
                estimateTokens(memoryEventLcmContent(event.payload) ?? "", {
                  model: tokenModel
                }),
              0
            );
            if (
              input.finalize ||
              currentSpan.length >= eventThreshold ||
              remainingTokens >= tokenThreshold
            ) {
              spans.push(currentSpan);
            }
          }
        }

        for (const span of spans) {
          if (span.length === 0) {
            continue;
          }
          const sourceItems: LcmSourceItem[] = span.map((event, position) => ({
            kind: "memory_event",
            sourceTable: "memory_events",
            sourceId: event.id,
            visibility: event.visibility,
            actor: event.actor ?? event.payload.actor,
            turnId: event.turn_id,
            createdAt: event.captured_at.toISOString(),
            text: memoryEventLcmContent(event.payload) ?? "",
            payload: lcmSourcePayloadForEvent(event),
            position
          }));
          const summaryText = leafSummaryText(sourceItems);
          const tokenEstimate = sourceItemsTokenEstimate(
            sourceItems,
            tokenModel
          );
          const sourceItemsForStorage = suppressPlaintextPayload
            ? encryptedMemoryNodeJsonMarker()
            : sourceItems;
          const summaryTextForStorage = suppressPlaintextPayload
            ? ENCRYPTED_MEMORY_NODE_TEXT
            : summaryText;
          const node = await client.query<{ id: string }>(
            `
            insert into memory_nodes (
              owner_user_id,
              created_by_user_id,
              visibility,
              kind,
              depth,
              summary_text,
              body_text,
              capture_method,
              lcm_algorithm_version,
              source_items_json,
              source_event_count,
              source_token_estimate,
              summary_token_estimate,
              source_span_start,
              source_span_end,
              source_hash,
              work_class
            )
            values ($1, $2, $3, 'leaf', 0, $4, $4, 'mcp', 'depth0-source-items-v1', $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
            on conflict (source_hash) where source_hash is not null
            do update set
              owner_user_id = excluded.owner_user_id,
              created_by_user_id = excluded.created_by_user_id,
              visibility = excluded.visibility,
              summary_text = excluded.summary_text,
              body_text = excluded.body_text,
              source_items_json = excluded.source_items_json,
              source_event_count = excluded.source_event_count,
              source_token_estimate = excluded.source_token_estimate,
              summary_token_estimate = excluded.summary_token_estimate,
              source_span_start = excluded.source_span_start,
              source_span_end = excluded.source_span_end,
              work_class = excluded.work_class,
              invalidated_at = null,
              invalidation_reason = null,
              updated_at = now()
            returning id
          `,
            [
              ownerUserId,
              actor.userId,
              input.visibility,
              summaryTextForStorage,
              JSON.stringify(sourceItemsForStorage),
              span.length,
              tokenEstimate,
              estimateTokens(summaryText, { model: tokenModel }),
              span[0]!.captured_at,
              span.at(-1)!.captured_at,
              sourceHash(
                "memory_event",
                span.map((event) => event.id).join(","),
                JSON.stringify(sourceItems)
              ),
              workClass
            ]
          );
          const nodeId =
            node.rows[0]?.id ??
            (
              await client.query<{ id: string }>(
                `
                select id
                from memory_nodes
                where source_hash = $1
                limit 1
              `,
                [
                  sourceHash(
                    "memory_event",
                    span.map((event) => event.id).join(","),
                    JSON.stringify(sourceItems)
                  )
                ]
              )
            ).rows[0]!.id;
          if (suppressPlaintextPayload && options.envelopeEncryptionProvider) {
            await client.query(
              `
              update memory_nodes
              set
                summary_text = $2,
                body_text = $2,
                source_items_json = $3::jsonb
              where id = $1
            `,
              [
                nodeId,
                ENCRYPTED_MEMORY_NODE_TEXT,
                JSON.stringify(encryptedMemoryNodeJsonMarker())
              ]
            );
            await persistEncryptedMemoryNodeFields(
              client,
              options.envelopeEncryptionProvider,
              {
                ownerUserId,
                visibility: input.visibility,
                nodeId,
                summaryText,
                bodyText: summaryText,
                sourceItems
              }
            );
          }
          leafNodeIds.push(nodeId);

          for (
            let sourceOrder = 0;
            sourceOrder < span.length;
            sourceOrder += 1
          ) {
            await client.query(
              `
              insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
              values ($1, $2, $3)
              on conflict do nothing
            `,
              [nodeId, span[sourceOrder]!.id, sourceOrder]
            );
          }
        }

        let rollupNodeId: string | null = null;
        const fanout = lcmDepthOneFanout();
        const unparented = await client.query<{
          id: string;
          owner_user_id: string | null;
          depth: number;
          summary_text: string;
          source_items_json: LcmSourceItem[];
        }>(
          `
          select mn.id, mn.owner_user_id, mn.depth, mn.summary_text, mn.source_items_json
          from memory_nodes mn
          left join memory_node_children mnc on mnc.child_memory_node_id = mn.id
          where mn.invalidated_at is null and mn.personal_deleted_at is null
            and mn.kind = 'leaf'
            and mn.depth = 0
            and mnc.parent_memory_node_id is null
            and mn.visibility = $1
            and mn.owner_user_id = $2
            and mn.work_class = $3
          order by mn.created_at asc, mn.id asc
        `,
          [input.visibility, ownerUserId, workClass]
        );
        const hydratedUnparentedRows = await hydrateMemoryNodeRows(
          client,
          options.envelopeEncryptionProvider,
          unparented.rows
        );
        const unparentedBySession = new Map<string, typeof unparented.rows>();
        for (const row of hydratedUnparentedRows) {
          const key = lcmSessionKeyForNodeRow(row);
          const group = unparentedBySession.get(key);
          if (group) {
            group.push(row);
          } else {
            unparentedBySession.set(key, [row]);
          }
        }
        const children = [...unparentedBySession.values()].find(
          (group) => group.length >= fanout
        );
        if (children) {
          const rollupChildren = children.slice(0, fanout);
          const rollupSummary = rollupSummaryText(rollupChildren);
          const childSourceItems: LcmSourceItem[] = rollupChildren.map(
            (child, position) => ({
              kind: "lcm_child",
              nodeId: child.id,
              position,
              text: child.summary_text,
              payload: {
                depth: child.depth,
                lcmSessionKey: lcmSessionKeyForNodeRow(child)
              }
            })
          );
          const eventSourceItems = rollupChildren.flatMap((child) =>
            Array.isArray(child.source_items_json)
              ? child.source_items_json
              : []
          );
          const childSourceItemsForStorage = suppressPlaintextPayload
            ? encryptedMemoryNodeJsonMarker()
            : childSourceItems;
          const rollupSummaryForStorage = suppressPlaintextPayload
            ? ENCRYPTED_MEMORY_NODE_TEXT
            : rollupSummary;
          const rollup = await client.query<{ id: string }>(
            `
            insert into memory_nodes (
              owner_user_id,
              created_by_user_id,
              visibility,
              kind,
              depth,
              summary_text,
              body_text,
              capture_method,
              lcm_algorithm_version,
              source_items_json,
              source_event_count,
              source_token_estimate,
              summary_token_estimate,
              source_hash,
              work_class
            )
            values ($1, $2, $3, 'rollup', 1, $4, $4, 'mcp', 'depth1-child-rollup-v1', $5::jsonb, $6, $7, $8, $9, $10)
            on conflict (source_hash) where source_hash is not null
            do update set
              owner_user_id = excluded.owner_user_id,
              created_by_user_id = excluded.created_by_user_id,
              visibility = excluded.visibility,
              summary_text = excluded.summary_text,
              body_text = excluded.body_text,
              source_items_json = excluded.source_items_json,
              source_event_count = excluded.source_event_count,
              source_token_estimate = excluded.source_token_estimate,
              summary_token_estimate = excluded.summary_token_estimate,
              work_class = excluded.work_class,
              invalidated_at = null,
              invalidation_reason = null,
              updated_at = now()
            returning id
          `,
            [
              ownerUserId,
              actor.userId,
              input.visibility,
              rollupSummaryForStorage,
              JSON.stringify(childSourceItemsForStorage),
              eventSourceItems.length,
              sourceItemsTokenEstimate(eventSourceItems, tokenModel),
              estimateTokens(rollupSummary, { model: tokenModel }),
              sourceHash(
                "memory_node",
                rollupChildren.map((child) => child.id).join(","),
                rollupSummary
              ),
              workClass
            ]
          );
          rollupNodeId =
            rollup.rows[0]?.id ??
            (
              await client.query<{ id: string }>(
                `
                select id
                from memory_nodes
                where source_hash = $1
                limit 1
              `,
                [
                  sourceHash(
                    "memory_node",
                    rollupChildren.map((child) => child.id).join(","),
                    rollupSummary
                  )
                ]
              )
            ).rows[0]!.id;
          if (suppressPlaintextPayload && options.envelopeEncryptionProvider) {
            await client.query(
              `
              update memory_nodes
              set
                summary_text = $2,
                body_text = $2,
                source_items_json = $3::jsonb
              where id = $1
            `,
              [
                rollupNodeId,
                ENCRYPTED_MEMORY_NODE_TEXT,
                JSON.stringify(encryptedMemoryNodeJsonMarker())
              ]
            );
            await persistEncryptedMemoryNodeFields(
              client,
              options.envelopeEncryptionProvider,
              {
                ownerUserId,
                visibility: input.visibility,
                nodeId: rollupNodeId,
                summaryText: rollupSummary,
                bodyText: rollupSummary,
                sourceItems: childSourceItems
              }
            );
          }
          for (
            let childOrder = 0;
            childOrder < rollupChildren.length;
            childOrder += 1
          ) {
            await client.query(
              `
              insert into memory_node_children (parent_memory_node_id, child_memory_node_id, child_order)
              values ($1, $2, $3)
              on conflict do nothing
            `,
              [rollupNodeId, rollupChildren[childOrder]!.id, childOrder]
            );
          }
          const sourceEventIds = eventSourceItems
            .filter((item) => item.kind === "memory_event" && item.sourceId)
            .map((item) => item.sourceId!);
          for (
            let sourceOrder = 0;
            sourceOrder < sourceEventIds.length;
            sourceOrder += 1
          ) {
            await client.query(
              `
              insert into memory_node_sources (memory_node_id, memory_event_id, source_order)
              values ($1, $2, $3)
              on conflict do nothing
            `,
              [rollupNodeId, sourceEventIds[sourceOrder]!, sourceOrder]
            );
          }
        }

        await client.query("commit");
        return { leafNodeIds, rollupNodeId } satisfies CompactionResult;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async expandMemoryNode(nodeId, actor, input = {}) {
      const searchDomain = input.searchDomain ?? "global";
      if (searchDomain === "session" && !input.sessionId) {
        throw new Error("Session-scoped memory expansion requires sessionId");
      }
      if (searchDomain === "project" && !input.workspaceId) {
        throw new Error("Project-scoped memory expansion requires workspaceId");
      }
      const now = new Date();
      const sourceAfter = input.recentDays
        ? new Date(now.getTime() - input.recentDays * 24 * 60 * 60 * 1000)
        : input.sourceAfter
          ? new Date(input.sourceAfter)
          : null;
      const sourceBefore = input.sourceBefore
        ? new Date(input.sourceBefore)
        : null;
      if (
        input.recentDays !== undefined &&
        (input.sourceAfter !== undefined || input.sourceBefore !== undefined)
      ) {
        throw new Error(
          "recentDays cannot be combined with explicit sourceAfter/sourceBefore bounds"
        );
      }
      if (sourceAfter && Number.isNaN(sourceAfter.getTime())) {
        throw new Error("sourceAfter must be a valid timestamp");
      }
      if (sourceBefore && Number.isNaN(sourceBefore.getTime())) {
        throw new Error("sourceBefore must be a valid timestamp");
      }
      if (sourceAfter && sourceBefore && sourceAfter >= sourceBefore) {
        throw new Error("sourceAfter must be earlier than sourceBefore");
      }
      const teamWorkspaceAccess = input.teamWorkspaceId
        ? await this.getTeamWorkspaceAccess(actor, input.teamWorkspaceId)
        : null;
      const teamWorkspaceAuthorization = resolveTeamWorkspaceAuthorization({
        requesterUserId: actor.userId,
        teamWorkspaceId: input.teamWorkspaceId,
        access: teamWorkspaceAccess
      });
      if (
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        !teamWorkspaceAuthorization.authorized
      ) {
        throw new Error("Memory node not found or not visible");
      }
      const teamWorkspaceBoundary: TeamWorkspaceReadBoundary =
        teamWorkspaceAuthorization.mode === "team_workspace" &&
        teamWorkspaceAuthorization.authorized
          ? {
              teamWorkspaceId: teamWorkspaceAuthorization.teamWorkspaceId,
              teamId: teamWorkspaceAuthorization.teamId
            }
          : null;
      const visibleNode = await pool.query<{
        id: string;
        owner_user_id: string | null;
        visibility: Visibility;
        source_items_json: LcmSourceItem[];
      }>(
        `
        select mn.id, mn.owner_user_id, mn.visibility, mn.source_items_json
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null
          and mn.visibility = 'personal'
          and (
            ($3::uuid is null and mn.owner_user_id = $1 and mn.personal_deleted_at is null)
            or (
              $3::uuid is not null
              and exists (
                select 1
                from memory_node_sources auth_any_mns
                where auth_any_mns.memory_node_id = mn.id
              )
              and not exists (
                select 1
                from memory_node_sources auth_mns
                left join memory_events auth_ev on auth_ev.id = auth_mns.memory_event_id and auth_ev.invalidated_at is null
                left join messages auth_msg on auth_msg.id = auth_mns.message_id and auth_msg.invalidated_at is null
                where auth_mns.memory_node_id = mn.id
                  and not exists (
                    select 1
                    from team_session_share_grants auth_grant
                    where auth_grant.session_id = coalesce(auth_ev.session_id, auth_msg.session_id)
                      and auth_grant.team_workspace_id = $3::uuid
                      and auth_grant.team_id = $4::uuid
                      and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
                  )
              )
            )
          )
        limit 1
      `,
        [
          actor.userId,
          nodeId,
          teamWorkspaceBoundary?.teamWorkspaceId ?? null,
          teamWorkspaceBoundary?.teamId ?? null
        ]
      );
      const node = visibleNode.rows[0];
      if (!node) {
        if (teamWorkspaceBoundary) {
          throw new Error("Memory node not found or not visible");
        }
        const curated =
          await curatedMemoryRepository.expandCuratedMemoryRetrieval(
            actor,
            nodeId
          );
        if (curated) {
          return curated;
        }
        throw new Error("Memory node not found or not visible");
      }
      const hydratedNode = await hydrateMemoryNodeRow(
        pool,
        options.envelopeEncryptionProvider,
        node
      );

      const sources = await pool.query<{
        id: string;
        owner_user_id: string | null;
        visibility: Visibility;
        event_type: MemoryEventType;
        session_id: string | null;
        turn_id: string | null;
        payload: {
          actor?: MemoryActor;
          content?: string;
          contentEncrypted?: boolean;
          metadata?: Record<string, unknown>;
          rawEventType?: string;
          workspaceId?: string;
        };
        created_at: Date;
        captured_at: Date;
      }>(
        `
        select me.id, me.owner_user_id, me.visibility, me.event_type, me.session_id, me.turn_id, me.payload, me.created_at, me.captured_at
        from memory_node_sources mns
        join memory_events me on me.id = mns.memory_event_id
        left join sessions source_session on source_session.id = me.session_id
        where mns.memory_node_id = $1
          and me.invalidated_at is null
          and me.visibility = 'personal'
          and (
            ($8::uuid is null and me.owner_user_id = $2 and me.personal_deleted_at is null)
            or (
              $8::uuid is not null
              and exists (
                select 1
                from team_session_share_grants auth_grant
                where auth_grant.session_id = me.session_id
                  and auth_grant.team_workspace_id = $8::uuid
                  and auth_grant.team_id = $9::uuid
                  and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
              )
            )
          )
          and ($3::timestamptz is null or me.captured_at >= $3::timestamptz)
          and ($4::timestamptz is null or me.captured_at < $4::timestamptz)
          and (
            $5::text = 'global'
            or ($5::text = 'session' and me.session_id = $6::uuid)
            or (
              $5::text = 'project'
              and (
                (
                  $8::uuid is null
                  and (
                    coalesce(
                      source_session.project_override_id,
                      source_session.automatic_project_id,
                      case when source_session.id is null then me.payload ->> 'workspaceId' end,
                      'unassigned'
                    ) = $7
                    or coalesce(source_session.project_override_path, source_session.automatic_project_path) = $7
                  )
                )
                or $8::uuid is not null
              )
            )
          )
        order by me.captured_at asc, me.id asc
      `,
        [
          nodeId,
          actor.userId,
          sourceAfter,
          sourceBefore,
          searchDomain,
          input.sessionId ?? null,
          input.workspaceId ?? null,
          teamWorkspaceBoundary?.teamWorkspaceId ?? null,
          teamWorkspaceBoundary?.teamId ?? null
        ]
      );
      const hydratedSources = await Promise.all(
        sources.rows.map(async (source) => {
          if (
            (source.payload.content &&
              source.payload.content !== ENCRYPTED_MEMORY_EVENT_TEXT) ||
            !options.envelopeEncryptionProvider ||
            source.payload.contentEncrypted !== true
          ) {
            return source;
          }
          const payload = await decryptAuthorizedMemoryEventPayload(
            pool,
            options.envelopeEncryptionProvider,
            {
              ownerUserId: source.owner_user_id,
              memoryEventId: source.id
            }
          );
          return payload
            ? {
                ...source,
                payload
              }
            : source;
        })
      );
      const supportingRows =
        hydratedSources.length > 0
          ? await pool.query<{
              memory_event_id: string;
              conversation_item_id: string;
              owner_user_id: string | null;
              source_role: string | null;
              source_event_type: string | null;
              source_record_type: string;
              raw_json: unknown;
              raw_text: string | null;
              metadata: Record<string, unknown> | null;
            }>(
              `
		              select
		                mes.memory_event_id,
		                ci.id as conversation_item_id,
		                ci.owner_user_id,
		                mes.source_role,
		                ci.source_event_type,
		                ci.source_record_type,
	                ci.raw_json,
	                ci.raw_text,
	                ci.metadata
	              from memory_event_sources mes
	              join conversation_items ci on ci.id = mes.conversation_item_id
	              where mes.memory_event_id = any($1::uuid[])
	                and mes.source_role = $2
	                and ci.visibility = 'personal'
	                and (
	                  ($4::uuid is null and ci.owner_user_id = $3)
	                  or (
	                    $4::uuid is not null
	                    and exists (
	                      select 1
	                      from team_session_share_grants auth_grant
	                      where auth_grant.session_id = ci.session_id
	                        and auth_grant.team_workspace_id = $4::uuid
	                        and auth_grant.team_id = $5::uuid
	                        and auth_grant.revoked_at is null and sync_session_recall_ready(auth_grant.session_id)
	                    )
	                  )
	                )
	              order by mes.memory_event_id, mes.source_order asc, ci.id asc
	            `,
              [
                hydratedSources.map((source) => source.id),
                SUPPORTING_CONTEXT_SOURCE_ROLE,
                actor.userId,
                teamWorkspaceBoundary?.teamWorkspaceId ?? null,
                teamWorkspaceBoundary?.teamId ?? null
              ]
            )
          : { rows: [] };
      const supportingContextByEventId = new Map<
        string,
        SupportingContextItem[]
      >();
      for (const row of supportingRows.rows) {
        const encryptedColumns = encryptedConversationItemSource(row).columns;
        if (encryptedColumns.size > 0 && !options.envelopeEncryptionProvider) {
          throw new Error(
            "Envelope encryption provider is required to expand encrypted supporting context"
          );
        }
        const decryptedRawJson = encryptedColumns.has("raw_json")
          ? await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id,
                sourceTable: "conversation_items",
                sourceId: row.conversation_item_id,
                sourceColumn: "raw_json"
              }
            )
          : row.raw_json;
        const decryptedRawText = encryptedColumns.has("raw_text")
          ? await decryptAuthorizedEncryptedFieldPayload(
              pool,
              options.envelopeEncryptionProvider,
              {
                ownerUserId: row.owner_user_id,
                sourceTable: "conversation_items",
                sourceId: row.conversation_item_id,
                sourceColumn: "raw_text"
              }
            )
          : row.raw_text;
        if (
          (encryptedColumns.has("raw_json") && decryptedRawJson === null) ||
          (encryptedColumns.has("raw_text") && decryptedRawText === null)
        ) {
          throw new Error("Encrypted supporting context source is missing");
        }
        const text =
          conversationItemContent({
            source_event_type: row.source_event_type,
            source_record_type: row.source_record_type,
            metadata: row.metadata,
            raw_json: decryptedRawJson ?? row.raw_json,
            raw_text:
              typeof decryptedRawText === "string"
                ? decryptedRawText
                : row.raw_text
          }) ?? "";
        if (!text.trim()) {
          continue;
        }
        const item: SupportingContextItem = {
          sourceId: row.conversation_item_id,
          sourceRole: SUPPORTING_CONTEXT_SOURCE_ROLE,
          contextKind: IDE_CLIENT_CONTEXT_KIND,
          label: "IDE/client context",
          text: text.trim()
        };
        supportingContextByEventId.set(row.memory_event_id, [
          ...(supportingContextByEventId.get(row.memory_event_id) ?? []),
          item
        ]);
      }
      const eventSourceItems: LcmSourceItem[] = hydratedSources.map(
        (source, position) => ({
          kind: "memory_event",
          sourceTable: "memory_events",
          sourceId: source.id,
          visibility: source.visibility,
          actor: source.payload.actor,
          turnId: source.turn_id,
          createdAt: source.captured_at.toISOString(),
          text: codexIdePromptUserText(
            memoryEventLcmContent(source.payload) ?? ""
          ),
          payload: lcmSourcePayloadForEvent(source),
          ...(supportingContextByEventId.has(source.id)
            ? {
                supportingContext: supportingContextByEventId.get(source.id)
              }
            : {}),
          position
        })
      );
      const nodeSourceItems = Array.isArray(hydratedNode.source_items_json)
        ? hydratedNode.source_items_json
        : [];
      const sourceItemInWindow = (item: LcmSourceItem): boolean => {
        if (!sourceAfter && !sourceBefore) {
          return true;
        }
        if (!item.createdAt) {
          return false;
        }
        const itemDate = new Date(item.createdAt);
        if (Number.isNaN(itemDate.getTime())) {
          return false;
        }
        return (
          (!sourceAfter || itemDate >= sourceAfter) &&
          (!sourceBefore || itemDate < sourceBefore)
        );
      };
      const sourceItemInBoundary = (item: LcmSourceItem): boolean => {
        if (searchDomain === "global") {
          return true;
        }
        if (item.kind === "lcm_child") {
          return false;
        }
        const payload =
          item.payload && typeof item.payload === "object"
            ? (item.payload as Record<string, unknown>)
            : {};
        if (searchDomain === "session") {
          return (
            typeof input.sessionId === "string" &&
            payload.sessionId === input.sessionId
          );
        }
        return (
          typeof input.workspaceId === "string" &&
          payload.workspaceId === input.workspaceId
        );
      };
      const filteredNodeSourceItems = nodeSourceItems.filter(
        (item) => sourceItemInWindow(item) && sourceItemInBoundary(item)
      );

      return {
        nodeId,
        visibility: hydratedNode.visibility,
        sourceItems:
          filteredNodeSourceItems.length > 0 &&
          filteredNodeSourceItems.some((item) => item.kind === "lcm_child")
            ? [...filteredNodeSourceItems, ...eventSourceItems]
            : eventSourceItems.length > 0
              ? eventSourceItems
              : filteredNodeSourceItems,
        sources: hydratedSources.map(mapMemoryEvent)
      } satisfies ExpandedMemoryNode;
    }
  };
};
