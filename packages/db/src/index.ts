import { createHash } from "node:crypto";
import pg from "pg";
import {
  chunkTextForModel,
  estimateTokens,
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
  env,
  resolveSupportedEmbeddingModelConfig,
  resolveSupportedRerankerModelConfig
} from "@koed/shared";

const { Pool } = pg;

export interface DbConfig {
  connectionString?: string;
}

export const createDbPool = (config: DbConfig = {}): pg.Pool =>
  new Pool({
    connectionString: config.connectionString ?? env("DATABASE_URL")
  });

export const checkDatabase = async (pool: pg.Pool): Promise<boolean> => {
  const result = await pool.query<{ ok: number }>("select 1 as ok");
  return result.rows[0]?.ok === 1;
};

export type Visibility = "personal";
export type CaptureMethod = "hook" | "mcp" | "web" | "api";
export type SourceRuntime = "codex" | "codex-cli";
export type CaptureState = "enabled" | "disabled" | "ask";
export type CapturePolicyTarget = "global" | "project" | "thread";
export type MemoryQuestionStatus = "pending" | "answered" | "error";
export type MemoryQuestionSearchDomain = "global" | "project" | "session";
export type MemoryQuestionRetrievalScope = "personal";

export interface ActorContext {
  userId: string;
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
  passwordHash?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
}

export interface ApiTokenRecord {
  id: string;
  ownerUserId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface CreateMemoryNodeInput {
  visibility: Visibility;
  summaryText: string;
  title?: string;
  bodyText?: string;
  captureMethod?: CaptureMethod;
  sourceRuntime?: SourceRuntime;
  codexTranscriptPath?: string;
  idempotencyKey?: string;
  sourceHash?: string;
  summaryModel?: string;
  summaryPromptVersion?: string;
  lcmAlgorithmVersion?: string;
}

export interface MemoryNodeRecord {
  id: string;
  ownerUserId: string | null;
  visibility: Visibility;
  title: string | null;
  summaryText: string;
  createdAt?: string;
  updatedAt?: string;
  summaryStructuredJson?: Record<string, unknown> | null;
  summaryStructuredSchemaVersion?: string | null;
  pinnedAt?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  threadId?: string | null;
  threadName?: string | null;
}

export interface CapturePolicyRecord {
  id: string;
  ownerUserId: string;
  targetType: CapturePolicyTarget;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  threadId: string | null;
  threadName: string | null;
  captureState: CaptureState | null;
  visibility: Visibility | null;
  pauseUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EffectiveCapturePolicy {
  captureState: CaptureState;
  visibility: Visibility;
  paused: boolean;
  pauseUntil: string | null;
  source: "default" | CapturePolicyTarget;
  policy: CapturePolicyRecord | null;
}

export interface UpsertCapturePolicyInput {
  targetType: CapturePolicyTarget;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  threadId?: string;
  threadName?: string;
  captureState?: CaptureState | null;
  visibility?: Visibility | null;
  pauseUntil?: Date | string | null;
}

export interface MemoryBrowserItem {
  id: string;
  clusterId: string;
  clusterLabel: string;
  text: string;
  title: string | null;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
  pinnedAt: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  threadId: string | null;
  threadName: string | null;
}

export interface MemoryClusterRecord {
  id: string;
  label: string;
  count: number;
  latestUpdatedAt: string;
  pinnedCount: number;
  items: MemoryBrowserItem[];
}

export interface LcmGraphOverview {
  capturedEvents: number;
  leafNodes: number;
  rollupNodes: number;
  pendingSummaries: number;
  pendingLcmDiagnostics: {
    pendingCount: number;
    oldestPendingCreatedAt: string | null;
    staleThresholdMinutes: 15;
    stale: boolean;
  };
  invalidatedRecords: number;
  embeddings: {
    enabled: boolean;
    healthy: boolean;
    model: string | null;
    dimensions: number | null;
    total: number;
    memoryNodes: number;
    memoryEvents: number;
    messages: number;
  };
}

export interface LcmGraphNode {
  id: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  summaryStatus: "pending" | "summarized";
  visibility: Visibility;
  ownerUserId: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  sourceEventCount: number;
  sourceTokenEstimate: number | null;
  summaryTokenEstimate: number | null;
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  summaryStructuredJson: Record<string, unknown> | null;
  summaryStructuredSchemaVersion: string | null;
  lcmAlgorithmVersion: string | null;
  embeddingCount: number;
  summaryCorrectedAt?: string | null;
  summaryCorrectedByUserId?: string | null;
}

export interface LcmGraphEvent {
  id: string;
  actor: string | null;
  eventType: string;
  sourceRuntime: SourceRuntime | null;
  captureMethod: CaptureMethod;
  model: string | null;
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  timestamp: string;
  visibility: Visibility;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  contentPreview: string;
  content?: string;
  rawContent?: string;
  metadata: Record<string, unknown>;
  linkedNodeIds: string[];
}

export interface LcmGraphThread {
  id: string;
  name: string;
  sessionId: string | null;
  projectId: string;
  projectName: string;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
  threadKind: "conversation" | "subagent";
  parentThreadId: string | null;
  parentSessionId: string | null;
}

export interface LcmGraphProjectThreads {
  id: string;
  name: string;
  path: string | null;
  eventCount: number;
  threads: LcmGraphThread[];
}

export interface LcmGraphNodeDetail extends LcmGraphNode {
  sourceItems: LcmSourceItem[];
  sources: LcmGraphEvent[];
  childNodes: LcmGraphNode[];
  parentNodes: LcmGraphNode[];
}

export interface LcmNodeForSummarization {
  id: string;
  ownerUserId: string | null;
  visibility: Visibility;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  sourceItems: LcmSourceItem[];
  sourceTokenEstimate: number | null;
  summaryTokenEstimate: number | null;
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  summaryStructuredJson: Record<string, unknown> | null;
  summaryStructuredSchemaVersion: string | null;
  lcmAlgorithmVersion: string | null;
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

export type EmbeddableSourceType = "memory_node" | "memory_event" | "message";

export interface EmbeddableSourceRecord {
  sourceType: EmbeddableSourceType;
  sourceId: string;
  ownerUserId: string | null;
  visibility: Visibility;
  text: string;
  sourceHash: string;
}

export interface LocalEmbeddingStatus {
  enabled: boolean;
  healthy: boolean;
  model: string | null;
  dimensions: number | null;
  error?: string;
}

interface RerankResult {
  model: string;
  scores: number[];
}

export interface CapturedSessionRecord {
  id: string;
  ownerUserId: string | null;
  visibility: Visibility;
  externalSessionId: string | null;
  workspaceId: string | null;
  sourceRuntime: SourceRuntime;
  captureMethod: CaptureMethod;
  model: string | null;
  cwd: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationItemInput {
  visibility?: Visibility;
  sessionId?: string;
  turnId?: string;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  externalSessionId?: string;
  externalThreadId?: string;
  externalTurnId?: string;
  externalItemId?: string;
  parentExternalItemId?: string;
  sourceRecordType: string;
  sourceEventType?: string;
  sourcePath?: string;
  sourceLineNumber?: number;
  sourceSequence?: number;
  eventTime?: string;
  rawJson: unknown;
  rawText?: string;
  logicalSourceId?: string;
  transportChunkIndex?: number;
  transportChunkCount?: number;
  transportChunkText?: string;
  transportChunkEncoding?: string;
  sourceHash: string;
  idempotencyKey: string;
  projectionStatus?: "pending" | "projected" | "error" | string;
  projectionVersion?: string;
  projectionError?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationItemRecord {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  sourceKind: string;
  sourceAdapterVersion: string;
  sourceTransport: string;
  externalSessionId: string | null;
  externalThreadId: string | null;
  externalTurnId: string | null;
  externalItemId: string | null;
  sourceRecordType: string;
  sourceEventType: string | null;
  sourceSequence: number | null;
  idempotencyKey: string;
  createdAt: string;
}

type ConversationProjectionRawRow = {
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
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
  session_workspace_id: string | null;
  session_cwd: string | null;
  session_metadata: Record<string, unknown> | null;
};

type LogicalConversationProjectionItem = {
  row: ConversationProjectionRawRow;
  sourceIds: string[];
  sourceIdentity: string;
  sourceHash: string;
};

type ConversationSemanticUnitType = "user_turn" | "agent_turn";

type ConversationSemanticProjectionItem = {
  row: ConversationProjectionRawRow;
  sourceIds: string[];
  sourceIdentity: string;
  sourceHash: string;
  actorType: MemoryActor;
  content: string;
  projectionMetadata: Record<string, unknown>;
};

type ConversationSemanticProjectionChunk = {
  content: string;
  chunkIndex: number;
  chunkCount: number;
  sourceIds: string[];
  sourceIdentities: string[];
  sourceHashes: string[];
};

type ConversationSemanticProjectionGroup = {
  unitType: ConversationSemanticUnitType;
  items: ConversationSemanticProjectionItem[];
};

export interface WorkflowTokenUsageInput {
  visibility?: Visibility;
  workflowType: string;
  workflowId?: string;
  sessionId?: string;
  turnId?: string;
  conversationItemId?: string;
  sourceRuntime?: SourceRuntime;
  sourceKind?: string;
  sourceAdapterVersion?: string;
  model?: string;
  modelContextWindow?: number | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  usageScope?: "last" | "total" | string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  sourceHash?: string;
}

type ConversationProjectionInput = {
  limit?: number;
  conversationItemIds?: string[];
  visibility?: Visibility;
};

export interface WorkflowTokenUsageRecord {
  id: string;
  workflowType: string;
  workflowId: string | null;
  sessionId: string | null;
  turnId: string | null;
  conversationItemId: string | null;
  model: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  usageScope: string;
  createdAt: string;
}

export interface ConversationProjectionResult {
  rawItemsScanned: number;
  rawItemsProjected: number;
  messagesCreated: number;
  toolEventsCreated: number;
  memoryEventsCreated: number;
  tokenUsageRowsCreated: number;
  memoryEventIds: string[];
  memoryEventScopes: Array<{
    eventId: string;
    visibility: Visibility;
  }>;
}

export interface MemoryQuestionShellRecord {
  id: string;
  ownerUserId: string;
  visibility: Visibility;
  retrievalScope: MemoryQuestionRetrievalScope;
  searchDomain: MemoryQuestionSearchDomain;
  workspaceId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  query: string;
  answerPreview: string | null;
  errorMessage: string | null;
  status: MemoryQuestionStatus;
  createdAt: string;
  updatedAt: string;
  answeredAt: string | null;
  processingStartedAt: string | null;
  processingLeaseUntil: string | null;
  attemptCount: number;
  lastErrorMessage: string | null;
  evidenceCount: number;
}

export interface MemoryQuestionDetailRecord extends MemoryQuestionShellRecord {
  answerMarkdown: string | null;
  evidence: unknown[] | null;
  citations: unknown[] | null;
  retrieval: Record<string, unknown> | null;
  localMemoryWorker: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
}

export interface MemorySourceRepository extends MemoryEngineRepository {
  health(): Promise<boolean>;
  countUsers(): Promise<number>;
  createUser(input: CreateUserInput): Promise<{ id: string }>;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  getUser(userId: string): Promise<UserRecord | null>;
  createSession(
    userId: string,
    sessionHash: string,
    expiresAt: Date
  ): Promise<void>;
  getSessionUser(sessionHash: string): Promise<UserRecord | null>;
  revokeSession(sessionHash: string): Promise<void>;
  createApiToken(input: {
    ownerUserId: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    scopes?: string[];
    expiresAt?: Date;
  }): Promise<ApiTokenRecord>;
  listApiTokens(userId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken(userId: string, tokenId: string): Promise<boolean>;
  getApiTokenUser(tokenHash: string): Promise<UserRecord | null>;
  createCapturedSession(
    actor: ActorContext,
    input: {
      workspaceId?: string;
      externalSessionId?: string;
      sourceRuntime?: SourceRuntime;
      captureMethod?: CaptureMethod;
      model?: string;
      cwd?: string;
      codexTranscriptPath?: string;
      idempotencyKey?: string;
      sourceHash?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<CapturedSessionRecord>;
  createConversationItems(
    actor: ActorContext,
    input: { items: ConversationItemInput[] }
  ): Promise<ConversationItemRecord[]>;
  recordWorkflowTokenUsage(
    actor: ActorContext,
    input: WorkflowTokenUsageInput
  ): Promise<WorkflowTokenUsageRecord>;
  projectPendingConversationItems(
    actor: ActorContext,
    input?: ConversationProjectionInput
  ): Promise<ConversationProjectionResult>;
  listConversationProjectionActors(input?: {
    limit?: number;
  }): Promise<ActorContext[]>;
  createMemoryQuestion(
    actor: ActorContext,
    input: {
      query: string;
      retrievalScope?: MemoryQuestionRetrievalScope;
      searchDomain: MemoryQuestionSearchDomain;
      workspaceId?: string;
      projectName?: string;
      projectPath?: string;
      sessionId?: string;
      threadId?: string;
      threadName?: string;
    }
  ): Promise<MemoryQuestionDetailRecord>;
  listMemoryQuestions(
    actor: ActorContext,
    input?: {
      query?: string;
      searchDomain?: MemoryQuestionSearchDomain;
      status?: MemoryQuestionStatus;
      workspaceId?: string;
      sessionId?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<MemoryQuestionShellRecord[]>;
  claimPendingMemoryQuestions(
    actor: ActorContext,
    input?: {
      questionId?: string;
      limit?: number;
      leaseSeconds?: number;
    }
  ): Promise<MemoryQuestionDetailRecord[]>;
  getMemoryQuestion(
    actor: ActorContext,
    questionId: string
  ): Promise<MemoryQuestionDetailRecord | null>;
  updateMemoryQuestion(
    actor: ActorContext,
    questionId: string,
    input:
      | {
          status: "answered";
          answerMarkdown: string;
          attemptCount?: number;
          response?: Record<string, unknown>;
          evidence?: unknown[];
          citations?: unknown[];
          retrieval?: Record<string, unknown>;
          localMemoryWorker?: Record<string, unknown>;
        }
      | {
          status: "error";
          errorMessage: string;
          attemptCount?: number;
          response?: Record<string, unknown>;
          retrieval?: Record<string, unknown>;
          localMemoryWorker?: Record<string, unknown>;
        }
      | {
          status: "pending";
          lastErrorMessage: string;
          attemptCount?: number;
          response?: Record<string, unknown>;
          evidence?: unknown[];
          citations?: unknown[];
          retrieval?: Record<string, unknown>;
          localMemoryWorker?: Record<string, unknown>;
        }
  ): Promise<MemoryQuestionDetailRecord | null>;
  createMemoryNode(
    actor: ActorContext,
    input: CreateMemoryNodeInput
  ): Promise<MemoryNodeRecord>;
  getEffectiveCapturePolicy(
    actor: ActorContext,
    input?: { projectId?: string; threadId?: string; sessionId?: string }
  ): Promise<EffectiveCapturePolicy>;
  listCapturePolicies(
    actor: ActorContext,
    targetType?: CapturePolicyTarget
  ): Promise<CapturePolicyRecord[]>;
  upsertCapturePolicy(
    actor: ActorContext,
    input: UpsertCapturePolicyInput
  ): Promise<CapturePolicyRecord>;
  deleteCapturePolicy(actor: ActorContext, policyId: string): Promise<boolean>;
  getVisibleMemoryNode(
    actor: ActorContext,
    nodeId: string
  ): Promise<MemoryNodeRecord | null>;
  listVisibleMemoryNodes(
    actor: ActorContext,
    visibility?: Visibility
  ): Promise<MemoryNodeRecord[]>;
  listMemoryBrowserItems(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      pinned?: boolean;
      limit?: number;
    }
  ): Promise<MemoryBrowserItem[]>;
  listMemoryClusters(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      limit?: number;
      itemsPerCluster?: number;
    }
  ): Promise<MemoryClusterRecord[]>;
  listMemoriesInCluster(
    actor: ActorContext,
    clusterId: string,
    input?: { limit?: number }
  ): Promise<MemoryBrowserItem[]>;
  updateMemoryPresentation(
    actor: ActorContext,
    nodeId: string,
    input: { summaryText?: string; pinned?: boolean; visibility?: Visibility }
  ): Promise<MemoryBrowserItem | null>;
  deleteMemory(actor: ActorContext, nodeId: string): Promise<boolean>;
  getLcmGraphOverview(actor: ActorContext): Promise<LcmGraphOverview>;
  listLcmGraphNodes(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      nodeIds?: string[];
      includeInvalidated?: boolean;
      limit?: number;
    }
  ): Promise<LcmGraphNode[]>;
  getLcmGraphNode(
    actor: ActorContext,
    nodeId: string,
    input?: { includeInvalidated?: boolean }
  ): Promise<LcmGraphNodeDetail | null>;
  updateLcmGraphNode(
    actor: ActorContext,
    nodeId: string,
    input: { summaryText?: string; visibility?: Visibility }
  ): Promise<LcmGraphNodeDetail | null>;
  invalidateLcmGraphNode(actor: ActorContext, nodeId: string): Promise<boolean>;
  listLcmGraphEvents(
    actor: ActorContext,
    input?: {
      eventId?: string;
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      cursorTimestamp?: string;
      cursorId?: string;
      includeInvalidated?: boolean;
      includeContent?: boolean;
      includeRaw?: boolean;
      limit?: number;
    }
  ): Promise<LcmGraphEvent[]>;
  listLcmGraphThreads(
    actor: ActorContext,
    input?: {
      query?: string;
      visibility?: Visibility;
      projectId?: string;
      threadId?: string;
      includeInvalidated?: boolean;
      limit?: number;
    }
  ): Promise<LcmGraphProjectThreads[]>;
  getLcmGraphEvent(
    actor: ActorContext,
    eventId: string,
    input?: { includeInvalidated?: boolean; includeRaw?: boolean }
  ): Promise<LcmGraphEvent | null>;
  updateLcmGraphEvent(
    actor: ActorContext,
    eventId: string,
    input: { visibility?: Visibility; invalidated?: boolean }
  ): Promise<LcmGraphEvent | null>;
  invalidateLcmGraphEvent(
    actor: ActorContext,
    eventId: string
  ): Promise<boolean>;
  exportMemoryRecords(actor: ActorContext): Promise<{
    exportedAt: string;
    overview: LcmGraphOverview;
    nodes: LcmGraphNodeDetail[];
    events: LcmGraphEvent[];
  }>;
  getLocalEmbeddingStatus(): Promise<LocalEmbeddingStatus>;
  listSourcesNeedingEmbeddings(
    limit?: number
  ): Promise<EmbeddableSourceRecord[]>;
  getEmbeddableSource(
    sourceType: EmbeddableSourceType,
    sourceId: string
  ): Promise<EmbeddableSourceRecord | null>;
  getLcmNodeForSummarization(
    nodeId: string
  ): Promise<LcmNodeForSummarization | null>;
  listLcmNodesNeedingSummaries(
    actor: ActorContext,
    input?: { limit?: number }
  ): Promise<LcmNodeForSummarization[]>;
  getVisibleLcmNodeForSummarization(
    actor: ActorContext,
    nodeId: string
  ): Promise<LcmNodeForSummarization | null>;
  updateLcmNodeSummary(input: {
    nodeId: string;
    summaryText: string;
    summaryModel: string;
    summaryPromptVersion: string;
    summaryTokenEstimate: number;
    summaryStructuredJson?: Record<string, unknown>;
    summaryStructuredSchemaVersion?: string;
  }): Promise<void>;
  upsertSourceEmbedding(input: {
    source: EmbeddableSourceRecord;
    model: string;
    dimensions: number;
    version: string;
    vector: number[];
    chunkIndex?: number;
    chunkCount?: number;
    sourceText?: string;
  }): Promise<{ id: string; inserted: boolean }>;
}

const mapMemoryNode = (row: {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  title: string | null;
  summary_text: string;
  created_at?: Date;
  updated_at?: Date;
  pinned_at?: Date | null;
  project_id?: string | null;
  project_name?: string | null;
  project_path?: string | null;
  thread_id?: string | null;
  thread_name?: string | null;
}): MemoryNodeRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  title: row.title,
  summaryText: row.summary_text,
  ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
  ...(row.updated_at ? { updatedAt: row.updated_at.toISOString() } : {}),
  ...(row.pinned_at !== undefined
    ? { pinnedAt: row.pinned_at?.toISOString() ?? null }
    : {}),
  ...(row.project_id !== undefined ? { projectId: row.project_id } : {}),
  ...(row.project_name !== undefined ? { projectName: row.project_name } : {}),
  ...(row.project_path !== undefined ? { projectPath: row.project_path } : {}),
  ...(row.thread_id !== undefined ? { threadId: row.thread_id } : {}),
  ...(row.thread_name !== undefined ? { threadName: row.thread_name } : {})
});

const mapCapturePolicy = (row: {
  id: string;
  owner_user_id: string;
  target_type: CapturePolicyTarget;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  thread_id: string | null;
  thread_name: string | null;
  capture_state: CaptureState | null;
  visibility: Visibility | null;
  pause_until: Date | null;
  created_at: Date;
  updated_at: Date;
}): CapturePolicyRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  targetType: row.target_type,
  projectId: row.project_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  threadId: row.thread_id,
  threadName: row.thread_name,
  captureState: row.capture_state,
  visibility: row.visibility,
  pauseUntil: row.pause_until?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString()
});

const commonTopicWords = new Set([
  "about",
  "after",
  "again",
  "alice",
  "assistant",
  "before",
  "can",
  "codex",
  "context",
  "could",
  "decided",
  "default",
  "did",
  "does",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "how",
  "installed",
  "let",
  "like",
  "memory",
  "needs",
  "new",
  "now",
  "please",
  "project",
  "running",
  "should",
  "summary",
  "that",
  "thanks",
  "their",
  "there",
  "these",
  "this",
  "thread",
  "user",
  "using",
  "version",
  "was",
  "with",
  "would"
]);

const titleCase = (value: string): string =>
  value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;

const clusterLabelForText = (text: string): string => {
  const words = text
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{2,}/g)
    ?.filter((word) => !commonTopicWords.has(word))
    .slice(0, 2);
  if (!words || words.length === 0) {
    return "General";
  }
  return words.map(titleCase).join(" ");
};

const clusterIdForLabel = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "general";

const normalizeDisplayText = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const truncateDisplayText = (value: string, maxLength = 280): string => {
  const normalized = normalizeDisplayText(value);
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}...`
    : normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonbParam = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

const getStringField = (
  value: Record<string, unknown>,
  key: string
): string | null => {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
};

const parseJsonObject = (value: string): Record<string, unknown> | null => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const looksLikeToolPayloadText = (value: string): boolean =>
  /"?toolInput"?\s*:/.test(value) ||
  /"?toolResponse"?\s*:/.test(value) ||
  /^\s*\{\s*"?command"?\s*:/.test(value);

const projectDisplayName = (row: {
  project_name: string | null;
  project_path: string | null;
}): string => {
  const candidate = row.project_name ?? row.project_path;
  if (!candidate) {
    return "this project";
  }
  const parts = candidate.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? candidate;
};

const developmentActivityText = (row: {
  project_name: string | null;
  project_path: string | null;
}): string => `Development activity captured in ${projectDisplayName(row)}.`;

const isGenericDevelopmentActivity = (
  text: string,
  row: { project_name: string | null; project_path: string | null }
): boolean => text === developmentActivityText(row);

const extractReadableJsonText = (
  parsed: Record<string, unknown>,
  row: { project_name: string | null; project_path: string | null }
): string | null => {
  if (isRecord(parsed.toolInput) || isRecord(parsed.toolResponse)) {
    return developmentActivityText(row);
  }
  if (getStringField(parsed, "command")) {
    return developmentActivityText(row);
  }
  const directText =
    getStringField(parsed, "summaryText") ??
    getStringField(parsed, "summary") ??
    getStringField(parsed, "text") ??
    getStringField(parsed, "content");
  if (directText) {
    return directText;
  }
  return null;
};

const extractLcmSourceCandidate = (value: string): string | null => {
  const lines = value.split("\n");
  for (const line of lines) {
    const match = line.match(/^\s*-\s+\[[^\]]+\]\s*[^:]*:\s*(.+)$/);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      return candidate;
    }
  }
  return null;
};

const isInternalMemorySummary = (value: string): boolean =>
  /^\s*LCM depth \d+/.test(value) ||
  value.includes("Exact ordered source outline:") ||
  value.includes("Child summaries:");

const extractCodexRequestText = (value: string): string | null => {
  const marker = "## My request for Codex:";
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  const requestText = value
    .slice(markerIndex + marker.length)
    .replace(/<image\b[\s\S]*?<\/image>/g, "")
    .trim();
  return requestText || null;
};

export const presentMemoryText = (
  summaryText: string,
  row: { project_name: string | null; project_path: string | null }
): string => {
  const normalized = normalizeDisplayText(summaryText);
  if (!normalized) {
    return "Captured memory.";
  }
  if (looksLikeToolPayloadText(normalized)) {
    return developmentActivityText(row);
  }

  const parsed = parseJsonObject(summaryText);
  if (parsed) {
    const readable = extractReadableJsonText(parsed, row);
    return readable
      ? presentMemoryText(readable, row)
      : developmentActivityText(row);
  }

  if (isInternalMemorySummary(summaryText)) {
    const candidate = extractLcmSourceCandidate(summaryText);
    return candidate
      ? presentMemoryText(candidate, row)
      : developmentActivityText(row);
  }

  const requestText = extractCodexRequestText(summaryText);
  if (requestText) {
    return presentMemoryText(requestText, row);
  }

  return truncateDisplayText(summaryText);
};

const clusterRules: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "Memory Presentation",
    pattern:
      /\b(memory browser|memory presentation|memories shown|raw json|clusters?|topic|entity|semantic|friendly cards?|pinned memories?)\b/i
  },
  {
    label: "Capture Control",
    pattern:
      /\b(capture policy|capture control|pause capture|capture enabled|capture disabled|visibility|personal|thread override|project override)\b/i
  },
  {
    label: "Codex Integration",
    pattern:
      /\b(codex|mcp|capture hook|memory answer|lcm summary|transcript|ai client)\b/i
  },
  {
    label: "Self-Hosting",
    pattern: /\b(self-host|docker|compose|postgres|redis|backup|restore)\b/i
  },
  {
    label: "Sports",
    pattern:
      /\b(sport|football|soccer|tennis|arsenal|barcelona|league|match)\b/i
  },
  {
    label: "Preferences",
    pattern:
      /\b(prefers?|likes?|dislikes?|wants?|favorite|favourite|style|tone)\b/i
  },
  {
    label: "People",
    pattern: /\b(friend|colleague|jacobo|user|person|people)\b/i
  },
  {
    label: "Decisions",
    pattern: /\b(decided|agreed|principle|strategy|recommendation|plan)\b/i
  }
];

const clusterLabelForMemoryText = (text: string): string => {
  const rule = clusterRules.find((candidate) => candidate.pattern.test(text));
  return rule?.label ?? clusterLabelForText(text);
};

const mapMemoryBrowserItem = (row: {
  id: string;
  title: string | null;
  summary_text: string;
  visibility: Visibility;
  created_at: Date;
  updated_at: Date;
  pinned_at: Date | null;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  thread_id: string | null;
  thread_name: string | null;
}): MemoryBrowserItem => {
  const text = presentMemoryText(row.summary_text, row);
  const label = isGenericDevelopmentActivity(text, row)
    ? "Development Activity"
    : clusterLabelForMemoryText(`${row.title ?? ""} ${text}`);
  return {
    id: row.id,
    clusterId: clusterIdForLabel(label),
    clusterLabel: label,
    text,
    title: row.title,
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    projectId: row.project_id,
    projectName: row.project_name,
    projectPath: row.project_path,
    threadId: row.thread_id,
    threadName: row.thread_name
  };
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

const mapLcmGraphEvent = (row: {
  id: string;
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
  captured_at: Date;
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
    timestamp: row.captured_at.toISOString(),
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
  thread_id: string;
  thread_name: string;
  session_id: string | null;
  event_count: string | number;
  invalidated_count: string | number;
  latest_at: Date;
  sample: string | null;
  thread_kind: "conversation" | "subagent" | null;
  parent_thread_id: string | null;
  parent_session_id: string | null;
}): LcmGraphThread & { projectPath: string | null } => ({
  id: row.thread_id,
  name: row.thread_name,
  sessionId: row.session_id,
  projectId: row.project_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  eventCount: Number(row.event_count),
  invalidatedCount: Number(row.invalidated_count),
  latestAt: row.latest_at.toISOString(),
  sample: truncateDisplayText(row.sample ?? "", 220),
  threadKind: row.thread_kind ?? "conversation",
  parentThreadId: row.parent_thread_id,
  parentSessionId: row.parent_session_id
});

const mapCapturedSession = (row: {
  id: string;
  owner_user_id: string | null;
  visibility: Visibility;
  external_session_id: string | null;
  workspace_id: string | null;
  source_runtime: SourceRuntime;
  capture_method: CaptureMethod;
  model: string | null;
  cwd: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}): CapturedSessionRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  externalSessionId: row.external_session_id,
  workspaceId: row.workspace_id,
  sourceRuntime: row.source_runtime,
  captureMethod: row.capture_method,
  model: row.model,
  cwd: row.cwd,
  metadata: row.metadata ?? {},
  createdAt: row.created_at.toISOString()
});

const mapConversationItem = (row: {
  id: string;
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
  source_sequence: number | null;
  idempotency_key: string;
  created_at: Date;
}): ConversationItemRecord => ({
  id: row.id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  sourceKind: row.source_kind,
  sourceAdapterVersion: row.source_adapter_version,
  sourceTransport: row.source_transport,
  externalSessionId: row.external_session_id,
  externalThreadId: row.external_thread_id,
  externalTurnId: row.external_turn_id,
  externalItemId: row.external_item_id,
  sourceRecordType: row.source_record_type,
  sourceEventType: row.source_event_type,
  sourceSequence: row.source_sequence,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at.toISOString()
});

const mapWorkflowTokenUsage = (row: {
  id: string;
  workflow_type: string;
  workflow_id: string | null;
  session_id: string | null;
  turn_id: string | null;
  conversation_item_id: string | null;
  model: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  total_tokens: number | null;
  usage_scope: string;
  created_at: Date;
}): WorkflowTokenUsageRecord => ({
  id: row.id,
  workflowType: row.workflow_type,
  workflowId: row.workflow_id,
  sessionId: row.session_id,
  turnId: row.turn_id,
  conversationItemId: row.conversation_item_id,
  model: row.model,
  inputTokens: row.input_tokens,
  cachedInputTokens: row.cached_input_tokens,
  outputTokens: row.output_tokens,
  reasoningOutputTokens: row.reasoning_output_tokens,
  totalTokens: row.total_tokens,
  usageScope: row.usage_scope,
  createdAt: row.created_at.toISOString()
});

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

const projectionIsReasoningSummaryLabel = (label: string): boolean =>
  projectionIsReasoningLabel(label) && !projectionIsRawReasoningLabel(label);

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
    return row.raw_text.trim();
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
        return value;
      }
    }
  }
  for (const key of ["message", "text", "content", "delta"]) {
    const value = stringField(payload, key);
    if (value) {
      return value;
    }
  }
  const nestedItem = isRecord(payload.item) ? payload.item : null;
  return nestedItem ? stringField(nestedItem, "text") : null;
};

const actorFromConversationItem = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
  raw_json?: unknown;
}): MemoryActor | null => {
  const metadata = row.metadata ?? {};
  const raw = isRecord(row.raw_json) ? row.raw_json : null;
  const payload = raw && isRecord(raw.payload) ? raw.payload : raw;
  const item = payload && isRecord(payload.item) ? payload.item : payload;
  const role =
    (item && stringField(item, "role")) ??
    (item && isRecord(item.message) ? stringField(item.message, "role") : null);
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
  if (/developer|system/i.test(role ?? "")) {
    return "system";
  }
  if (/subagent/i.test(transcriptType)) {
    return "subagent";
  }
  if (/agent|assistant|reasoning|thought/i.test(transcriptType)) {
    return "agent";
  }
  if (/tool|function_call|custom_tool/i.test(transcriptType)) {
    return "tool";
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

type ConversationProjectionPolicy = {
  createMessage: boolean;
  createSemanticEvent: boolean;
  createToolEvent: boolean;
  reason: string;
};

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

const projectionWorkflowIsInternal = (
  metadata: Record<string, unknown> | null
): boolean => {
  const workflow = stringField(metadata ?? {}, "workflow");
  return workflow === "lcm_summary" || workflow === "memory_question";
};

const projectionIsInfrastructureEvent = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
  raw_json: unknown;
}): boolean => {
  const label = projectionLabelForConversationItem(row);
  const raw = isRecord(row.raw_json) ? row.raw_json : null;
  return (
    /tokenUsage|session_meta|lifecycle|initialized|turn\/completed|error|agentMessage\/delta/i.test(
      label
    ) ||
    projectionIsRawReasoningLabel(label) ||
    raw?.method === "thread/tokenUsage/updated"
  );
};

const projectionIsSystemContext = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
  raw_json: unknown;
}): boolean => {
  const label = projectionLabelForConversationItem(row);
  const raw = isRecord(row.raw_json) ? row.raw_json : null;
  const payload = raw && isRecord(raw.payload) ? raw.payload : raw;
  const item = payload && isRecord(payload.item) ? payload.item : payload;
  const role =
    (item && stringField(item, "role")) ??
    (item && isRecord(item.message) ? stringField(item.message, "role") : null);
  return (
    /(^|[_/ -])(system|developer|instruction|rolling[_ -]?context|context[_ -]?summary)([_/ -]|$)/i.test(
      label
    ) || /^(system|developer)$/i.test(role ?? "")
  );
};

const projectionIsSemanticAllowlisted = (row: {
  source_event_type: string | null;
  source_record_type: string;
  metadata: Record<string, unknown> | null;
}): boolean => {
  const label = projectionLabelForConversationItem(row);
  return (
    /user_message|assistant_message|agent_message|agentMessage|subagent|function_call|custom_tool|codex_transcript_(user|agent|subagent|tool)|codex_tool_result/i.test(
      label
    ) || projectionIsReasoningSummaryLabel(label)
  );
};

const projectionIsHookSemanticFallback = (row: {
  source_record_type: string;
  raw_json: unknown;
}): boolean => {
  if (row.source_record_type !== "hook_payload" || !isRecord(row.raw_json)) {
    return false;
  }
  return (
    typeof row.raw_json.prompt === "string" ||
    typeof row.raw_json.last_assistant_message === "string" ||
    typeof row.raw_json.tool_name === "string"
  );
};

const classifyConversationItemProjection = (
  row: {
    source_event_type: string | null;
    source_record_type: string;
    metadata: Record<string, unknown> | null;
    raw_json: unknown;
  },
  input: { actorType: MemoryActor | null; content: string | null }
): ConversationProjectionPolicy => {
  const base = {
    createMessage: false,
    createSemanticEvent: false,
    createToolEvent: false,
    reason: "not-projectable"
  };
  if (!input.content || !input.actorType) {
    return { ...base, reason: "missing-content-or-actor" };
  }
  if (projectionWorkflowIsInternal(row.metadata)) {
    return { ...base, reason: "internal-worker-workflow" };
  }
  if (projectionIsInfrastructureEvent(row)) {
    return { ...base, reason: "infrastructure-event" };
  }
  if (projectionIsSystemContext(row)) {
    return { ...base, reason: "system-or-context-record" };
  }

  const createMessage = Boolean(messageRoleForActor(input.actorType));
  const createToolEvent = input.actorType === "tool";
  const createSemanticEvent =
    projectionIsSemanticAllowlisted(row) ||
    projectionIsHookSemanticFallback(row) ||
    input.actorType === "tool";
  return {
    createMessage,
    createSemanticEvent,
    createToolEvent,
    reason: createSemanticEvent ? "projectable" : "not-semantic-allowlisted"
  };
};

const previewMarkdown = (value: string | null): string | null =>
  value ? truncateDisplayText(value, 280) : null;

const projectionMaxTokens = (): number =>
  Math.min(
    Math.max(
      Number.parseInt(process.env.MEMORY_EVENT_MAX_TOKENS ?? "", 10) ||
        DEFAULT_MEMORY_EVENT_MAX_TOKENS,
      1
    ),
    QWEN_OPERATIONAL_MAX_TOKENS
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

const decodeTransportChunkEnvelope = (
  text: string,
  encoding: string | null
): { rawJson: unknown; rawText: string | null } => {
  const parsed = JSON.parse(text) as unknown;
  if (encoding === "conversation-item-json-v1") {
    if (!isRecord(parsed)) {
      throw new Error("Invalid conversation item transport chunk envelope");
    }
    return {
      rawJson: parsed.rawJson,
      rawText: typeof parsed.rawText === "string" ? parsed.rawText : null
    };
  }
  return { rawJson: parsed, rawText: null };
};

const loadLogicalConversationProjectionItem = async (
  pool: pg.Pool,
  row: ConversationProjectionRawRow
): Promise<LogicalConversationProjectionItem> => {
  if (!isTransportChunkRow(row)) {
    return {
      row,
      sourceIds: [row.id],
      sourceIdentity: row.id,
      sourceHash: row.source_hash
    };
  }

  if (!row.logical_source_id) {
    throw new Error("Transport chunk row is missing logical_source_id");
  }

  const chunks = await pool.query<ConversationProjectionRawRow>(
    `
      select
        ci.id, ci.owner_user_id, ci.visibility, ci.session_id,
        ci.turn_id, ci.source_kind, ci.source_adapter_version,
        ci.source_transport, ci.external_session_id, ci.external_thread_id,
        ci.external_turn_id, ci.external_item_id, ci.source_record_type,
        ci.source_event_type, ci.source_path, ci.source_sequence,
        ci.event_time, ci.raw_json, ci.raw_text, ci.logical_source_id,
        ci.transport_chunk_index, ci.transport_chunk_count,
        ci.transport_chunk_text, ci.transport_chunk_encoding,
        ci.source_hash, ci.idempotency_key, ci.metadata, ci.observed_at,
        s.workspace_id as session_workspace_id,
        s.cwd as session_cwd,
        s.metadata as session_metadata
      from conversation_items ci
      left join sessions s on s.id = ci.session_id
      where ci.logical_source_id = $1
        and ci.visibility = $2::visibility_scope
        and ci.owner_user_id = $3
      order by ci.transport_chunk_index asc, ci.id asc
    `,
    [row.logical_source_id, row.visibility, row.owner_user_id]
  );

  const expectedCount = row.transport_chunk_count;
  if (chunks.rowCount !== expectedCount) {
    throw new Error(
      `Incomplete transport chunk group: expected ${expectedCount}, found ${chunks.rowCount}`
    );
  }

  const seen = new Set<number>();
  for (const chunk of chunks.rows) {
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

  const sorted = [...chunks.rows].sort(
    (a, b) => a.transport_chunk_index - b.transport_chunk_index
  );
  const encoding = sorted[0]?.transport_chunk_encoding ?? null;
  const envelope = sorted
    .map((chunk) => chunk.transport_chunk_text ?? "")
    .join("");
  const decoded = decodeTransportChunkEnvelope(envelope, encoding);
  const representative =
    sorted.find((chunk) => chunk.transport_chunk_index === 0) ?? row;

  return {
    row: {
      ...representative,
      raw_json: decoded.rawJson,
      raw_text: decoded.rawText,
      metadata: row.metadata,
      source_hash: row.logical_source_id
    },
    sourceIds: sorted.map((chunk) => chunk.id),
    sourceIdentity: row.logical_source_id,
    sourceHash: row.logical_source_id
  };
};

const semanticProjectionChunks = (
  content: string,
  model?: string | null
): Array<{ content: string; chunkIndex: number; chunkCount: number }> => {
  const chunks = chunkTextForModel(content, {
    model: model ?? "gpt-5.4-mini",
    maxTokens: projectionMaxTokens()
  });
  const effectiveChunks = chunks.length > 0 ? chunks : [content];
  return effectiveChunks.map((chunk, index) => ({
    content: chunk,
    chunkIndex: index,
    chunkCount: effectiveChunks.length
  }));
};

const conversationSemanticUnitTypeForActor = (
  actorType: MemoryActor | null
): ConversationSemanticUnitType | null => {
  if (actorType === "user") {
    return "user_turn";
  }
  if (
    actorType === "agent" ||
    actorType === "assistant" ||
    actorType === "subagent" ||
    actorType === "tool"
  ) {
    return "agent_turn";
  }
  return null;
};

const uniqueOrderedStrings = (values: Iterable<string>): string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      ordered.push(value);
    }
  }
  return ordered;
};

const conversationSemanticBoundaryKey = (
  item: ConversationSemanticProjectionItem
): string =>
  [
    item.row.visibility,
    item.row.session_id ?? item.row.external_session_id ?? "sessionless",
    item.row.turn_id ?? item.row.external_turn_id ?? "turnless",
    item.row.external_thread_id ?? "threadless",
    canonicalWorkspaceId({
      metadata: item.row.metadata,
      sessionId: item.row.session_id,
      sessionWorkspaceId: item.row.session_workspace_id,
      sessionCwd: item.row.session_cwd
    })
  ].join(":");

const conversationSemanticUnitChunks = (
  items: ConversationSemanticProjectionItem[],
  unitType: ConversationSemanticUnitType,
  model?: string | null
): ConversationSemanticProjectionChunk[] => {
  type PendingSegment = {
    content: string;
    sourceIds: string[];
    sourceIdentity: string;
    sourceHash: string;
  };

  const maxTokens = projectionMaxTokens();
  const chunks: Omit<
    ConversationSemanticProjectionChunk,
    "chunkIndex" | "chunkCount"
  >[] = [];
  let pendingSegments: PendingSegment[] = [];
  let pendingTokens = 0;

  const flushPending = () => {
    if (pendingSegments.length === 0) {
      return;
    }
    chunks.push({
      content: pendingSegments.map((segment) => segment.content).join("\n\n"),
      sourceIds: uniqueOrderedStrings(
        pendingSegments.flatMap((segment) => segment.sourceIds)
      ),
      sourceIdentities: uniqueOrderedStrings(
        pendingSegments.map((segment) => segment.sourceIdentity)
      ),
      sourceHashes: uniqueOrderedStrings(
        pendingSegments.map((segment) => segment.sourceHash)
      )
    });
    pendingSegments = [];
    pendingTokens = 0;
  };

  for (const item of items) {
    const segment: PendingSegment = {
      content: item.content,
      sourceIds: item.sourceIds,
      sourceIdentity: item.sourceIdentity,
      sourceHash: item.sourceHash
    };
    const segmentTokens = estimateTokens(segment.content, {
      model: model ?? "gpt-5.4-mini"
    });

    if (segmentTokens > maxTokens) {
      flushPending();
      const splitChunks = semanticProjectionChunks(item.content, model);
      for (const split of splitChunks) {
        chunks.push({
          content: split.content,
          sourceIds: segment.sourceIds,
          sourceIdentities: [segment.sourceIdentity],
          sourceHashes: [segment.sourceHash]
        });
      }
      continue;
    }

    if (
      pendingSegments.length > 0 &&
      pendingTokens + segmentTokens > maxTokens
    ) {
      flushPending();
    }

    pendingSegments.push(segment);
    pendingTokens += segmentTokens;
  }

  flushPending();
  const effectiveChunks =
    chunks.length > 0
      ? chunks
      : [
          {
            content: "",
            sourceIds: [],
            sourceIdentities: [],
            sourceHashes: []
          }
        ];

  return effectiveChunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
    chunkCount: effectiveChunks.length
  }));
};

const conversationSemanticUnitActor = (
  unitType: ConversationSemanticUnitType,
  sourceActors: string[]
): MemoryActor => {
  if (unitType === "user_turn") {
    return "user";
  }
  if (sourceActors.length === 1 && sourceActors[0] === "tool") {
    return "tool";
  }
  if (sourceActors.length === 1 && sourceActors[0] === "subagent") {
    return "subagent";
  }
  return "agent";
};

const conversationSemanticProjectionGroups = (
  unitType: ConversationSemanticUnitType,
  items: ConversationSemanticProjectionItem[]
): ConversationSemanticProjectionGroup[] => {
  if (unitType === "user_turn") {
    return items.length > 0 ? [{ unitType, items }] : [];
  }

  const groups: ConversationSemanticProjectionGroup[] = [];
  let current: ConversationSemanticProjectionItem[] = [];
  let currentActor: MemoryActor | null = null;
  const actorClass = (item: ConversationSemanticProjectionItem): MemoryActor =>
    conversationSemanticUnitActor(unitType, [item.actorType]);

  for (const item of items) {
    const itemActor = actorClass(item);
    if (current.length > 0 && currentActor !== itemActor) {
      groups.push({ unitType, items: current });
      current = [];
    }
    current.push(item);
    currentActor = itemActor;
  }
  if (current.length > 0) {
    groups.push({ unitType, items: current });
  }
  return groups;
};

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

const mapMemoryQuestionShell = (row: {
  id: string;
  owner_user_id: string;
  visibility: Visibility;
  retrieval_scope: MemoryQuestionRetrievalScope;
  search_domain: MemoryQuestionSearchDomain;
  workspace_id: string | null;
  project_name: string | null;
  project_path: string | null;
  session_id: string | null;
  thread_id: string | null;
  thread_name: string | null;
  query: string;
  answer_markdown?: string | null;
  answer_preview?: string | null;
  error_message: string | null;
  status: MemoryQuestionStatus;
  created_at: Date;
  updated_at: Date;
  answered_at: Date | null;
  processing_started_at: Date | null;
  processing_lease_until: Date | null;
  attempt_count: string | number | null;
  last_error_message: string | null;
  evidence_count?: string | number | null;
}): MemoryQuestionShellRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  visibility: row.visibility,
  retrievalScope: row.retrieval_scope,
  searchDomain: row.search_domain,
  workspaceId: row.workspace_id,
  projectName: row.project_name,
  projectPath: row.project_path,
  sessionId: row.session_id,
  threadId: row.thread_id,
  threadName: row.thread_name,
  query: row.query,
  answerPreview:
    row.answer_preview ?? previewMarkdown(row.answer_markdown ?? null),
  errorMessage: row.error_message,
  status: row.status,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
  answeredAt: row.answered_at?.toISOString() ?? null,
  processingStartedAt: row.processing_started_at?.toISOString() ?? null,
  processingLeaseUntil: row.processing_lease_until?.toISOString() ?? null,
  attemptCount: Number(row.attempt_count ?? 0),
  lastErrorMessage: row.last_error_message,
  evidenceCount: Number(row.evidence_count ?? 0)
});

const mapMemoryQuestionDetail = (
  row: Parameters<typeof mapMemoryQuestionShell>[0] & {
    answer_markdown: string | null;
    evidence: unknown[] | null;
    citations: unknown[] | null;
    retrieval: Record<string, unknown> | null;
    local_memory_worker: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
  }
): MemoryQuestionDetailRecord => ({
  ...mapMemoryQuestionShell(row),
  answerMarkdown: row.answer_markdown,
  evidence: row.evidence,
  citations: row.citations,
  retrieval: row.retrieval,
  localMemoryWorker: row.local_memory_worker,
  response: row.response
});

const mapUser = (row: {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
}): UserRecord => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  passwordHash: row.password_hash
});

const mapApiToken = (row: {
  id: string;
  owner_user_id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}): ApiTokenRecord => ({
  id: row.id,
  ownerUserId: row.owner_user_id,
  name: row.name,
  tokenPrefix: row.token_prefix,
  scopes: row.scopes,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at?.toISOString() ?? null,
  expiresAt: row.expires_at?.toISOString() ?? null,
  revokedAt: row.revoked_at?.toISOString() ?? null
});

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

const rerankingEnabled = (): boolean =>
  resolveSupportedRerankerModelConfig(process.env.RERANKER_KEY) !== null;

const sourceHash = (
  sourceType: EmbeddableSourceType,
  sourceId: string,
  text: string
): string =>
  createHash("sha256")
    .update(`${sourceType}:${sourceId}:${text}`)
    .digest("hex");

const vectorLiteral = (vector: number[]): string => `[${vector.join(",")}]`;

const embeddingTableForDimensions = (dimensions: number): string => {
  if (dimensions === 384) {
    return "memory_embeddings_384";
  }
  if (dimensions === 1024) {
    return "memory_embeddings_1024";
  }
  if (dimensions === 1536) {
    return "memory_embeddings_1536";
  }
  if (dimensions === 3072) {
    return "memory_embeddings_3072";
  }
  throw new Error(`Unsupported local embedding dimensions: ${dimensions}`);
};

const positiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const nonNegativeFloatEnv = (name: string, fallback: number): number => {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const DEFAULT_MEMORY_EVENT_MAX_TOKENS = 2_048;
const QWEN_OPERATIONAL_MAX_TOKENS = 32_000;

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
  conversationItemIds: string[]
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
        select $1, ci.id, $3, 'derived_from'
        from conversation_items ci
        join memory_events me on me.id = $1
        where ci.id = $2
          and ci.visibility = me.visibility
          and ci.owner_user_id = me.owner_user_id
        on conflict do nothing
      `,
      [memoryEventId, conversationItemIds[index], index]
    );
  }
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

const ensureConversationItemTurn = async (
  pool: pg.Pool,
  input: {
    ownerUserId: string | null;
    visibility: Visibility;
    item: ConversationItemInput;
  }
): Promise<string | null> => {
  const { item } = input;
  if (item.turnId) {
    const turn = await pool.query<{ id: string }>(
      `
        select id
        from turns
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          and ($4::uuid is null or session_id = $4)
        limit 1
      `,
      [item.turnId, input.visibility, input.ownerUserId, item.sessionId ?? null]
    );
    if (turn.rowCount === 0) {
      throw new Error("Turn not found or not visible");
    }
    return item.turnId;
  }
  if (!item.sessionId || !item.externalTurnId) {
    return null;
  }

  let result: pg.QueryResult<{ id: string }> | null = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      result = await pool.query<{ id: string }>(
        `
          insert into turns (
            session_id,
            owner_user_id,
            visibility,
            external_turn_id,
            source_runtime,
            capture_method,
            codex_transcript_path,
            idempotency_key,
            source_hash,
            turn_index,
            source_kind,
            source_adapter_version,
            external_thread_id,
            source_metadata
          )
          values (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9,
            coalesce(
              (select max(turn_index) + 1 from turns where session_id = $1),
              0
            ),
            $10, $11, $12, $13
          )
          on conflict (session_id, external_turn_id)
            where external_turn_id is not null
          do update set
            source_kind = coalesce(turns.source_kind, excluded.source_kind),
            source_adapter_version = coalesce(
              turns.source_adapter_version,
              excluded.source_adapter_version
            ),
            external_thread_id = coalesce(
              turns.external_thread_id,
              excluded.external_thread_id
            ),
            source_metadata = turns.source_metadata || excluded.source_metadata
          returning id
        `,
        [
          item.sessionId,
          input.ownerUserId,
          input.visibility,
          item.externalTurnId,
          item.sourceKind === "codex-cli" ? "codex-cli" : "codex",
          captureMethodForConversationItem(item),
          item.sourcePath ?? null,
          `turn:${item.sessionId}:${item.externalTurnId}`,
          `turn:${item.sessionId}:${item.externalTurnId}`,
          item.sourceKind,
          item.sourceAdapterVersion,
          item.externalThreadId ?? item.externalSessionId ?? null,
          {
            externalSessionId: item.externalSessionId,
            externalThreadId: item.externalThreadId ?? item.externalSessionId,
            sourceTransport: item.sourceTransport
          }
        ]
      );
      break;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
      const constraint =
        typeof error === "object" && error !== null && "constraint" in error
          ? String(error.constraint)
          : "";
      if (
        code === "23505" &&
        constraint === "turns_session_turn_index_unique" &&
        attempt < 4
      ) {
        continue;
      }
      throw error;
    }
  }

  return result?.rows[0]?.id ?? null;
};

const validateWorkflowTokenUsageSources = async (
  pool: pg.Pool,
  input: {
    ownerUserId: string | null;
    visibility: Visibility;
    usage: WorkflowTokenUsageInput;
  }
): Promise<void> => {
  const { usage } = input;
  if (usage.sessionId) {
    const session = await pool.query<{ id: string }>(
      `
        select id
        from sessions
        where id = $1
          and invalidated_at is null
          and visibility = $2::visibility_scope
          and owner_user_id = $3
        limit 1
      `,
      [usage.sessionId, input.visibility, input.ownerUserId]
    );
    if (session.rowCount === 0) {
      throw new Error("Session not found or not visible");
    }
  }

  if (usage.turnId) {
    const turn = await pool.query<{ id: string }>(
      `
        select id
        from turns
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          and ($4::uuid is null or session_id = $4)
        limit 1
      `,
      [
        usage.turnId,
        input.visibility,
        input.ownerUserId,
        usage.sessionId ?? null
      ]
    );
    if (turn.rowCount === 0) {
      throw new Error("Turn not found or not visible");
    }
  }

  if (usage.conversationItemId) {
    const item = await pool.query<{ id: string }>(
      `
        select id
        from conversation_items
        where id = $1
          and visibility = $2::visibility_scope
          and owner_user_id = $3
          and ($4::uuid is null or session_id = $4)
          and ($5::uuid is null or turn_id = $5)
        limit 1
      `,
      [
        usage.conversationItemId,
        input.visibility,
        input.ownerUserId,
        usage.sessionId ?? null,
        usage.turnId ?? null
      ]
    );
    if (item.rowCount === 0) {
      throw new Error("Conversation item not found or not visible");
    }
  }
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
  visibility: row.visibility,
  ownerUserId: row.owner_user_id,
  createdAt: row.created_at.toISOString()
});

const mapLcmNodeForSummarization = async (
  pool: pg.Pool,
  row: LcmNodeForSummarizationRow
): Promise<LcmNodeForSummarization> => {
  let sourceItems = Array.isArray(row.source_items_json)
    ? row.source_items_json
    : [];

  if (
    row.kind === "rollup" &&
    sourceItems.some((item) => item.kind === "lcm_child")
  ) {
    const children = await pool.query<{
      id: string;
      depth: number;
      summary_text: string;
    }>(
      `
        select child.id, child.depth, child.summary_text
        from memory_node_children mnc
        join memory_nodes child on child.id = mnc.child_memory_node_id
        where mnc.parent_memory_node_id = $1
          and child.invalidated_at is null
        order by mnc.child_order asc
      `,
      [row.id]
    );
    const childSummaries = new Map(
      children.rows.map((child) => [
        child.id,
        { depth: child.depth, summaryText: child.summary_text }
      ])
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
    id: row.id,
    ownerUserId: row.owner_user_id,
    visibility: row.visibility,
    kind: row.kind,
    depth: row.depth,
    summaryText: row.summary_text,
    sourceItems,
    sourceTokenEstimate: row.source_token_estimate,
    summaryTokenEstimate: row.summary_token_estimate,
    summaryModel: row.summary_model,
    summaryPromptVersion: row.summary_prompt_version,
    summaryStructuredJson: row.summary_structured_json,
    summaryStructuredSchemaVersion: row.summary_structured_schema_version,
    lcmAlgorithmVersion: row.lcm_algorithm_version
  };
};

export const createMemorySourceRepository = (
  pool: pg.Pool
): MemorySourceRepository => ({
  health: () => checkDatabase(pool),

  async getLocalEmbeddingStatus() {
    const baseUrl = localEmbeddingServiceUrl();
    if (!baseUrl) {
      return {
        enabled: false,
        healthy: false,
        model: null,
        dimensions: null,
        error: "EMBEDDING_SERVICE_URL is not configured"
      };
    }

    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
        headers: embeddingServiceHeaders()
      });
      const payload = (await response.json().catch(() => ({}))) as {
        model?: string;
        dimensions?: number;
        authRequired?: boolean;
        authValid?: boolean;
      };
      const authHealthy = !payload.authRequired || payload.authValid === true;
      return {
        enabled: true,
        healthy: response.ok && authHealthy,
        model: payload.model ?? null,
        dimensions: payload.dimensions ?? null,
        ...(!response.ok
          ? { error: `HTTP ${response.status}` }
          : !authHealthy
            ? { error: "Embedding service token rejected" }
            : {})
      };
    } catch (error) {
      return {
        enabled: true,
        healthy: false,
        model: null,
        dimensions: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  async createUser(input) {
    const result = await pool.query<{ id: string }>(
      `
        insert into users (email, display_name, password_hash)
        values ($1, $2, $3)
        returning id
      `,
      [
        input.email.toLowerCase(),
        input.displayName ?? null,
        input.passwordHash ?? null
      ]
    );

    return { id: result.rows[0]!.id };
  },

  async countUsers() {
    const result = await pool.query<{ count: string }>(
      "select count(*) as count from users where disabled_at is null"
    );
    return Number(result.rows[0]?.count ?? 0);
  },

  async findUserByEmail(email) {
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string | null;
      password_hash: string | null;
    }>(
      `
        select id, email, display_name, password_hash
        from users
        where email = $1 and disabled_at is null
        limit 1
      `,
      [email.toLowerCase()]
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  },

  async getUser(userId) {
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string | null;
      password_hash: string | null;
    }>(
      `
        select id, email, display_name, password_hash
        from users
        where id = $1 and disabled_at is null
        limit 1
      `,
      [userId]
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  },

  async createSession(userId, sessionHash, expiresAt) {
    await pool.query(
      `
        insert into user_sessions (user_id, session_hash, expires_at)
        values ($1, $2, $3)
      `,
      [userId, sessionHash, expiresAt]
    );
  },

  async getSessionUser(sessionHash) {
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string | null;
      password_hash: string | null;
    }>(
      `
        select u.id, u.email, u.display_name, u.password_hash
        from user_sessions us
        join users u on u.id = us.user_id
        where us.session_hash = $1
          and us.revoked_at is null
          and us.expires_at > now()
          and u.disabled_at is null
        limit 1
      `,
      [sessionHash]
    );

    return result.rows[0] ? mapUser(result.rows[0]) : null;
  },

  async revokeSession(sessionHash) {
    await pool.query(
      `
        update user_sessions
        set revoked_at = now()
        where session_hash = $1 and revoked_at is null
      `,
      [sessionHash]
    );
  },

  async createApiToken(input) {
    const result = await pool.query<{
      id: string;
      owner_user_id: string;
      name: string;
      token_prefix: string;
      scopes: string[];
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `
        insert into api_tokens (owner_user_id, name, token_hash, token_prefix, scopes, expires_at)
        values ($1, $2, $3, $4, $5, $6)
        returning id, owner_user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
      `,
      [
        input.ownerUserId,
        input.name,
        input.tokenHash,
        input.tokenPrefix,
        input.scopes ?? [],
        input.expiresAt ?? null
      ]
    );

    return mapApiToken(result.rows[0]!);
  },

  async listApiTokens(userId) {
    const result = await pool.query<{
      id: string;
      owner_user_id: string;
      name: string;
      token_prefix: string;
      scopes: string[];
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `
        select id, owner_user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
        from api_tokens
        where owner_user_id = $1 and revoked_at is null
        order by created_at desc
      `,
      [userId]
    );

    return result.rows.map(mapApiToken);
  },

  async revokeApiToken(userId, tokenId) {
    const result = await pool.query(
      `
        update api_tokens
        set revoked_at = now()
        where id = $1 and owner_user_id = $2 and revoked_at is null
      `,
      [tokenId, userId]
    );

    return (result.rowCount ?? 0) > 0;
  },

  async getApiTokenUser(tokenHash) {
    const result = await pool.query<{ owner_user_id: string }>(
      `
        update api_tokens
        set last_used_at = now()
        where token_hash = $1
          and revoked_at is null
          and (expires_at is null or expires_at > now())
        returning owner_user_id
      `,
      [tokenHash]
    );

    const token = result.rows[0];
    if (!token) {
      return null;
    }

    const userResult = await pool.query<{
      id: string;
      email: string;
      display_name: string | null;
      password_hash: string | null;
    }>(
      `
        select id, email, display_name, password_hash
        from users
        where id = $1 and disabled_at is null
        limit 1
      `,
      [token.owner_user_id]
    );

    return userResult.rows[0] ? mapUser(userResult.rows[0]) : null;
  },

  async createCapturedSession(actor, input) {
    const metadata = input.metadata ?? {};
    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      external_session_id: string | null;
      workspace_id: string | null;
      source_runtime: SourceRuntime;
      capture_method: CaptureMethod;
      model: string | null;
      cwd: string | null;
      metadata: Record<string, unknown> | null;
      created_at: Date;
    }>(
      `
        insert into sessions (
          owner_user_id,
          workspace_id,
          visibility,
          external_session_id,
          source_runtime,
          capture_method,
          codex_transcript_path,
          idempotency_key,
          source_hash,
          model,
          cwd,
          metadata,
          source_kind,
          source_adapter_version,
          external_thread_id,
          forked_from_external_thread_id,
          parent_external_thread_id,
          parent_session_id,
          agent_nickname,
          agent_role,
          agent_path,
          thread_source,
          source_metadata
        )
        values (
          $1, $2, 'personal', $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16,
          (
            select id
            from sessions parent
            where parent.owner_user_id = $1
              and parent.visibility = 'personal'
              and (
                parent.external_thread_id = $16
                or parent.external_session_id = $16
                or parent.id::text = $16
              )
            order by parent.created_at desc
            limit 1
          ),
          $17, $18, $19, $20, $21
        )
        on conflict (idempotency_key)
        where idempotency_key is not null
        do update set
          updated_at = now(),
          metadata = sessions.metadata || excluded.metadata,
          parent_session_id = coalesce(sessions.parent_session_id, excluded.parent_session_id),
          source_metadata = sessions.source_metadata || excluded.source_metadata
        returning id, owner_user_id, visibility, external_session_id, workspace_id, source_runtime, capture_method, model, cwd, metadata, created_at
      `,
      [
        actor.userId,
        input.workspaceId ?? null,
        input.externalSessionId ?? null,
        input.sourceRuntime ?? "codex",
        input.captureMethod ?? "mcp",
        input.codexTranscriptPath ?? null,
        input.idempotencyKey ?? null,
        input.sourceHash ?? null,
        input.model ?? null,
        input.cwd ?? null,
        metadata,
        "codex",
        input.sourceRuntime === "codex-cli"
          ? "codex-cli-hook-v1"
          : "codex-app-server-v1",
        input.externalSessionId ?? null,
        typeof metadata.forked_from_id === "string"
          ? metadata.forked_from_id
          : null,
        typeof metadata.parentThreadId === "string"
          ? metadata.parentThreadId
          : typeof metadata.parentExternalSessionId === "string"
            ? metadata.parentExternalSessionId
            : null,
        typeof metadata.agent_nickname === "string"
          ? metadata.agent_nickname
          : typeof metadata.agentNickname === "string"
            ? metadata.agentNickname
            : null,
        typeof metadata.agent_role === "string"
          ? metadata.agent_role
          : typeof metadata.agentType === "string"
            ? metadata.agentType
            : null,
        typeof metadata.agent_path === "string" ? metadata.agent_path : null,
        typeof metadata.thread_source === "string"
          ? metadata.thread_source
          : typeof metadata.threadKind === "string"
            ? metadata.threadKind
            : null,
        metadata
      ]
    );

    return mapCapturedSession(result.rows[0]!);
  },

  async createConversationItems(actor, input) {
    const records: ConversationItemRecord[] = [];
    for (const item of input.items) {
      const visibility = item.visibility ?? "personal";
      const ownerUserId = actor.userId;
      if (item.sessionId) {
        const visibleSession = await pool.query<{ id: string }>(
          `
            select s.id
            from sessions s
            where s.id = $2
              and s.invalidated_at is null
              and s.visibility = $3::visibility_scope
              and s.owner_user_id = $1
            limit 1
          `,
          [actor.userId, item.sessionId, visibility]
        );
        if (visibleSession.rowCount === 0) {
          throw new Error("Session not found or not visible");
        }
      }

      const turnId = await ensureConversationItemTurn(pool, {
        ownerUserId,
        visibility,
        item
      });
      const result = await pool.query<{
        id: string;
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
        source_sequence: number | null;
        idempotency_key: string;
        created_at: Date;
      }>(
        `
          insert into conversation_items (
            owner_user_id,
            visibility,
            session_id,
            turn_id,
            source_kind,
            source_adapter_version,
            source_transport,
            external_session_id,
            external_thread_id,
            external_turn_id,
            external_item_id,
            parent_external_item_id,
            source_record_type,
            source_event_type,
            source_path,
            source_line_number,
            source_sequence,
            event_time,
            raw_json,
            raw_text,
            logical_source_id,
            transport_chunk_index,
            transport_chunk_count,
            transport_chunk_text,
            transport_chunk_encoding,
            source_hash,
            idempotency_key,
            projection_status,
            projection_version,
            projection_error,
            metadata
          )
          values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17, $18,
            $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
            $29, $30, $31
          )
          on conflict do nothing
          returning
            id, session_id, turn_id, source_kind, source_adapter_version,
            source_transport, external_session_id, external_thread_id,
            external_turn_id, external_item_id, source_record_type,
            source_event_type, source_sequence, idempotency_key, created_at
        `,
        [
          ownerUserId,
          visibility,
          item.sessionId ?? null,
          turnId,
          item.sourceKind,
          item.sourceAdapterVersion,
          item.sourceTransport,
          item.externalSessionId ?? null,
          item.externalThreadId ?? item.externalSessionId ?? null,
          item.externalTurnId ?? null,
          item.externalItemId ?? null,
          item.parentExternalItemId ?? null,
          item.sourceRecordType,
          item.sourceEventType ?? null,
          item.sourcePath ?? null,
          item.sourceLineNumber ?? null,
          item.sourceSequence ?? null,
          item.eventTime ?? null,
          JSON.stringify(item.rawJson),
          item.rawText ?? null,
          item.logicalSourceId ?? null,
          item.transportChunkIndex ?? 0,
          item.transportChunkCount ?? 1,
          item.transportChunkText ?? null,
          item.transportChunkEncoding ?? null,
          item.sourceHash,
          item.idempotencyKey,
          item.projectionStatus ?? "pending",
          item.projectionVersion ?? null,
          item.projectionError ?? null,
          item.metadata ?? {}
        ]
      );
      const row =
        result.rows[0] ??
        (
          await pool.query<{
            id: string;
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
            source_sequence: number | null;
            idempotency_key: string;
            created_at: Date;
          }>(
            `
              select
                id, session_id, turn_id, source_kind, source_adapter_version,
                source_transport, external_session_id, external_thread_id,
                external_turn_id, external_item_id, source_record_type,
                source_event_type, source_sequence, idempotency_key, created_at
              from conversation_items
              where idempotency_key = $1
                and visibility = $2::visibility_scope
                and owner_user_id = $3
              limit 1
            `,
            [item.idempotencyKey, visibility, ownerUserId]
          )
        ).rows[0];
      if (!row) {
        throw Object.assign(
          new Error(
            "Duplicate raw conversation item conflicts with data outside caller visibility"
          ),
          { statusCode: 409 }
        );
      }
      records.push(mapConversationItem(row));
    }
    return records;
  },

  async recordWorkflowTokenUsage(actor, input) {
    const visibility = input.visibility ?? "personal";
    const ownerUserId = actor.userId;
    await validateWorkflowTokenUsageSources(pool, {
      ownerUserId,
      visibility,
      usage: input
    });
    const idempotencyKey =
      input.idempotencyKey ??
      createHash("sha256")
        .update(
          JSON.stringify({
            workflowType: input.workflowType,
            workflowId: input.workflowId,
            sessionId: input.sessionId,
            turnId: input.turnId,
            conversationItemId: input.conversationItemId,
            usageScope: input.usageScope ?? "last",
            model: input.model,
            totalTokens: input.totalTokens,
            inputTokens: input.inputTokens,
            outputTokens: input.outputTokens,
            cachedInputTokens: input.cachedInputTokens,
            reasoningOutputTokens: input.reasoningOutputTokens
          })
        )
        .digest("hex");
    const result = await pool.query<{
      id: string;
      workflow_type: string;
      workflow_id: string | null;
      session_id: string | null;
      turn_id: string | null;
      conversation_item_id: string | null;
      model: string | null;
      input_tokens: number | null;
      cached_input_tokens: number | null;
      output_tokens: number | null;
      reasoning_output_tokens: number | null;
      total_tokens: number | null;
      usage_scope: string;
      created_at: Date;
    }>(
      `
        insert into workflow_token_usage (
          owner_user_id,
          visibility,
          workflow_type,
          workflow_id,
          session_id,
          turn_id,
          conversation_item_id,
          source_runtime,
          source_kind,
          source_adapter_version,
          model,
          model_context_window,
          input_tokens,
          cached_input_tokens,
          output_tokens,
          reasoning_output_tokens,
          total_tokens,
          usage_scope,
          metadata,
          idempotency_key,
          source_hash
        )
        values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18, $19, $20, $21
        )
        on conflict do nothing
        returning
          id, workflow_type, workflow_id, session_id, turn_id,
          conversation_item_id, model, input_tokens, cached_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens, usage_scope,
          created_at
      `,
      [
        ownerUserId,
        visibility,
        input.workflowType,
        input.workflowId ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.conversationItemId ?? null,
        input.sourceRuntime ?? null,
        input.sourceKind ?? null,
        input.sourceAdapterVersion ?? null,
        input.model ?? null,
        input.modelContextWindow ?? null,
        input.inputTokens ?? null,
        input.cachedInputTokens ?? null,
        input.outputTokens ?? null,
        input.reasoningOutputTokens ?? null,
        input.totalTokens ?? null,
        input.usageScope ?? "last",
        input.metadata ?? {},
        idempotencyKey,
        input.sourceHash ?? idempotencyKey
      ]
    );
    const row =
      result.rows[0] ??
      (
        await pool.query<(typeof result.rows)[number]>(
          `
            select
              id, workflow_type, workflow_id, session_id, turn_id,
              conversation_item_id, model, input_tokens, cached_input_tokens,
              output_tokens, reasoning_output_tokens, total_tokens,
              usage_scope, created_at
            from workflow_token_usage
            where idempotency_key = $1
              and visibility = $2::visibility_scope
              and owner_user_id = $3
            limit 1
          `,
          [idempotencyKey, visibility, ownerUserId]
        )
      ).rows[0];
    if (!row) {
      throw Object.assign(
        new Error(
          "Duplicate token usage conflicts with data outside caller visibility"
        ),
        { statusCode: 409 }
      );
    }
    return mapWorkflowTokenUsage(row);
  },

  async projectPendingConversationItems(actor, input = {}) {
    const conversationItemIds = input.conversationItemIds ?? null;
    const visibility = input.visibility ?? null;
    if (conversationItemIds && conversationItemIds.length === 0) {
      return {
        rawItemsScanned: 0,
        rawItemsProjected: 0,
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
      messagesCreated: 0,
      toolEventsCreated: 0,
      memoryEventsCreated: 0,
      tokenUsageRowsCreated: 0,
      memoryEventIds: [],
      memoryEventScopes: []
    };
    const rows = await pool.query<ConversationProjectionRawRow>(
      `
        with pending_items as (
          select
            ci.id, ci.owner_user_id, ci.visibility, ci.session_id,
            ci.turn_id, ci.source_kind, ci.source_adapter_version,
            ci.source_transport, ci.external_session_id, ci.external_thread_id,
            ci.external_turn_id, ci.external_item_id, ci.source_record_type,
            ci.source_event_type, ci.source_path, ci.source_sequence,
            ci.event_time, ci.raw_json, ci.raw_text, ci.logical_source_id,
            ci.transport_chunk_index, ci.transport_chunk_count,
            ci.transport_chunk_text, ci.transport_chunk_encoding,
            ci.source_hash, ci.idempotency_key, ci.metadata,
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
            coalesce(ci.event_time, ci.observed_at) as boundary_order_at
          from conversation_items ci
          left join sessions s on s.id = ci.session_id
          where ci.projection_status in ('pending', 'error')
            and ($4::visibility_scope is null or ci.visibility = $4)
            and (
              ci.transport_chunk_count = 1
              or ci.transport_chunk_index = 0
            )
            and ci.owner_user_id = $1
        ),
        selected_boundaries as (
          select
            boundary_session,
            boundary_turn,
            boundary_thread,
            boundary_workspace,
            min(boundary_order_at) as oldest_at,
            min(id::text) as oldest_id
          from pending_items
          where $3::uuid[] is null or id = any($3::uuid[])
          group by boundary_session, boundary_turn, boundary_thread, boundary_workspace
          order by min(boundary_order_at) asc, min(id::text) asc
          limit $2
        )
        select
          pi.id, pi.owner_user_id, pi.visibility, pi.session_id,
          pi.turn_id, pi.source_kind, pi.source_adapter_version,
          pi.source_transport, pi.external_session_id, pi.external_thread_id,
          pi.external_turn_id, pi.external_item_id, pi.source_record_type,
          pi.source_event_type, pi.source_path, pi.source_sequence,
          pi.event_time, pi.raw_json, pi.raw_text, pi.logical_source_id,
          pi.transport_chunk_index, pi.transport_chunk_count,
          pi.transport_chunk_text, pi.transport_chunk_encoding,
          pi.source_hash, pi.idempotency_key, pi.metadata, pi.observed_at,
          pi.session_workspace_id, pi.session_cwd, pi.session_metadata
        from pending_items pi
        join selected_boundaries sb
          on sb.boundary_session = pi.boundary_session
          and sb.boundary_turn = pi.boundary_turn
          and sb.boundary_thread = pi.boundary_thread
          and sb.boundary_workspace = pi.boundary_workspace
        order by
          sb.oldest_at asc,
          sb.oldest_id asc,
          pi.source_sequence asc nulls last,
          pi.boundary_order_at asc,
          pi.id asc
      `,
      [actor.userId, limit, conversationItemIds, visibility]
    );

    const processedSourceIdentities = new Set<string>();
    const projectedStatusSourceIds = new Set<string>();
    let pendingAgentItems: ConversationSemanticProjectionItem[] = [];
    let pendingAgentBoundaryKey: string | null = null;

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
              projection_error = null,
              projected_at = now()
          where id = any($1::uuid[])
        `,
        [pendingIds, CURRENT_CONVERSATION_PROJECTION_VERSION]
      );
      for (const sourceId of pendingIds) {
        projectedStatusSourceIds.add(sourceId);
      }
      result.rawItemsProjected += pendingIds.length;
    };

    const markProjectionError = async (sourceIds: string[], error: unknown) => {
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

    const createSemanticMemoryUnit = async (
      unitType: ConversationSemanticUnitType,
      items: ConversationSemanticProjectionItem[]
    ) => {
      if (items.length === 0) {
        return;
      }
      const first = items[0]!;
      const model = stringField(first.row.metadata ?? {}, "model");
      const chunks = conversationSemanticUnitChunks(items, unitType, model);
      const sourceCapturedAt =
        items
          .map((item) => item.row.event_time ?? item.row.observed_at)
          .filter((value): value is Date => value instanceof Date)
          .sort((left, right) => left.getTime() - right.getTime())[0] ??
        undefined;
      const sourceActors = uniqueOrderedStrings(
        items.map((item) => item.actorType)
      );
      const unitActor = conversationSemanticUnitActor(unitType, sourceActors);
      const allSourceIds = uniqueOrderedStrings(
        items.flatMap((item) => item.sourceIds)
      );

      for (const chunk of chunks) {
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
              ...first.projectionMetadata,
              rawConversationItemId: chunk.sourceIds[0] ?? allSourceIds[0],
              rawConversationItemIds: chunk.sourceIds,
              logicalSourceId: chunk.sourceIdentities[0],
              logicalSourceIds: chunk.sourceIdentities,
              projectionVersion: CURRENT_CONVERSATION_PROJECTION_VERSION,
              semanticUnitType: unitType,
              semanticSourceActors: sourceActors,
              sourceAdapterVersion: first.row.source_adapter_version,
              sourceChunkIndex: chunk.chunkIndex,
              sourceChunkCount: chunk.chunkCount,
              sourceItemCount: allSourceIds.length,
              externalSessionId: first.row.external_session_id,
              externalThreadId: first.row.external_thread_id,
              externalTurnId: first.row.external_turn_id
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
            capturedAt: sourceCapturedAt?.toISOString()
          }
        );
        if (event.id) {
          result.memoryEventsCreated += 1;
          result.memoryEventIds.push(event.id);
          result.memoryEventScopes.push({
            eventId: event.id,
            visibility: first.row.visibility
          });
        }
      }
    };

    const flushAgentBundle = async () => {
      if (pendingAgentItems.length === 0) {
        pendingAgentBoundaryKey = null;
        return;
      }
      const items = pendingAgentItems;
      pendingAgentItems = [];
      pendingAgentBoundaryKey = null;
      const sourceIds = uniqueOrderedStrings(
        items.flatMap((item) => item.sourceIds)
      );
      try {
        for (const group of conversationSemanticProjectionGroups(
          "agent_turn",
          items
        )) {
          await createSemanticMemoryUnit(group.unitType, group.items);
        }
        await markProjected(sourceIds);
      } catch (error) {
        await markProjectionError(sourceIds, error);
      }
    };

    for (const sourceRow of rows.rows) {
      result.rawItemsScanned += 1;
      let sourceIds = [sourceRow.id];
      try {
        const logicalItem = await loadLogicalConversationProjectionItem(
          pool,
          sourceRow
        );
        if (processedSourceIdentities.has(logicalItem.sourceIdentity)) {
          continue;
        }
        processedSourceIdentities.add(logicalItem.sourceIdentity);
        const row = logicalItem.row;
        sourceIds = logicalItem.sourceIds;
        const ownerUserId = actor.userId;
        const content = conversationItemContent(row);
        const actorType = actorFromConversationItem(row);
        const messageRole = messageRoleForActor(actorType);
        const tokenUsage = appServerTokenUsageFromRaw(row.raw_json);
        const projectionMetadata = canonicalProjectMetadata({
          metadata: row.metadata,
          sessionMetadata: row.session_metadata,
          sessionId: row.session_id,
          sessionWorkspaceId: row.session_workspace_id,
          sessionCwd: row.session_cwd
        });
        const projectionPolicy = classifyConversationItemProjection(row, {
          actorType,
          content
        });

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
                model: stringField(row.metadata ?? {}, "model") ?? undefined,
                modelContextWindow: tokenUsage.modelContextWindow,
                usageScope: scope,
                ...breakdown,
                metadata: {
                  rawConversationItemId: sourceIds[0],
                  rawConversationItemIds: sourceIds,
                  logicalSourceId: logicalItem.sourceIdentity
                },
                idempotencyKey: `token:${logicalItem.sourceIdentity}:${scope}`
              }
            );
            result.tokenUsageRowsCreated += 1;
          }
        }

        if (
          row.session_id &&
          messageRole &&
          content &&
          projectionPolicy.createMessage
        ) {
          const inserted = await pool.query<{ id: string }>(
            `
              insert into messages (
                session_id, turn_id, owner_user_id, visibility,
                role, content, content_json, source_runtime, capture_method,
                codex_transcript_path, transcript_item_id, idempotency_key,
                source_hash, token_count, captured_at
              )
              values (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14, $15
              )
              on conflict do nothing
              returning id
            `,
            [
              row.session_id,
              row.turn_id,
              ownerUserId,
              row.visibility,
              messageRole,
              content,
              row.raw_json,
              row.source_kind === "codex-cli" ? "codex-cli" : "codex",
              captureMethodForConversationItem({
                sourceTransport: row.source_transport
              }),
              row.source_path,
              row.source_sequence === null ? null : String(row.source_sequence),
              `message:${logicalItem.sourceIdentity}`,
              `message:${logicalItem.sourceHash}`,
              estimateTokens(content),
              row.event_time ?? row.observed_at
            ]
          );
          if ((inserted.rowCount ?? 0) > 0) {
            result.messagesCreated += 1;
          }
        }

        if (row.session_id && projectionPolicy.createToolEvent) {
          const raw = isRecord(row.raw_json) ? row.raw_json : {};
          const metadata = row.metadata ?? {};
          const toolCall = isRecord(metadata.toolCall) ? metadata.toolCall : {};
          const callId = conversationItemToolCallId(metadata, toolCall);
          const linkedToolName = await loadLinkedToolNameForCallId(
            pool,
            row,
            callId
          );
          const inserted = await pool.query<{ id: string }>(
            `
              insert into tool_events (
                session_id, turn_id, owner_user_id, visibility,
                tool_name, tool_input, tool_response, status, source_runtime,
                capture_method, codex_transcript_path, transcript_item_id,
                idempotency_key, source_hash
              )
              values (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14
              )
              on conflict do nothing
              returning id
            `,
            [
              row.session_id,
              row.turn_id,
              ownerUserId,
              row.visibility,
              conversationItemToolName(raw, metadata, toolCall, linkedToolName),
              jsonbParam(conversationItemToolInput(raw, toolCall)),
              jsonbParam(
                conversationItemToolResponse(raw, toolCall, content, {
                  allowContentFallback:
                    row.source_record_type !== "hook_payload"
                })
              ),
              stringField(metadata, "status") ?? null,
              row.source_kind === "codex-cli" ? "codex-cli" : "codex",
              captureMethodForConversationItem({
                sourceTransport: row.source_transport
              }),
              row.source_path,
              row.source_sequence === null ? null : String(row.source_sequence),
              `tool:${logicalItem.sourceIdentity}`,
              `tool:${logicalItem.sourceHash}`
            ]
          );
          if ((inserted.rowCount ?? 0) > 0) {
            result.toolEventsCreated += 1;
          }
        }

        if (content && actorType && projectionPolicy.createSemanticEvent) {
          const semanticUnitType =
            conversationSemanticUnitTypeForActor(actorType);
          const semanticItem: ConversationSemanticProjectionItem = {
            row,
            sourceIds,
            sourceIdentity: logicalItem.sourceIdentity,
            sourceHash: logicalItem.sourceHash,
            actorType,
            content,
            projectionMetadata
          };
          if (semanticUnitType === "user_turn") {
            await flushAgentBundle();
            await createSemanticMemoryUnit("user_turn", [semanticItem]);
            await markProjected(sourceIds);
          } else if (semanticUnitType === "agent_turn") {
            const boundaryKey = conversationSemanticBoundaryKey(semanticItem);
            if (
              pendingAgentBoundaryKey &&
              pendingAgentBoundaryKey !== boundaryKey
            ) {
              await flushAgentBundle();
            }
            pendingAgentBoundaryKey = boundaryKey;
            pendingAgentItems.push(semanticItem);
          } else {
            await markProjected(sourceIds);
          }
        } else {
          await markProjected(sourceIds);
        }
      } catch (error) {
        await markProjectionError(sourceIds, error);
      }
    }
    await flushAgentBundle();
    return result;
  },

  async listConversationProjectionActors(input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const result = await pool.query<{ user_id: string }>(
      `
        select user_id
        from (
          select ci.owner_user_id as user_id, min(ci.observed_at) as oldest_at
          from conversation_items ci
          where ci.projection_status in ('pending', 'error')
            and ci.visibility = 'personal'
            and ci.owner_user_id is not null
          group by ci.owner_user_id
        ) projection_actors
        order by oldest_at asc
        limit $1
      `,
      [limit]
    );
    return result.rows.map((row) => ({ userId: row.user_id }));
  },

  async createMemoryQuestion(actor, input) {
    const result = await pool.query<
      Parameters<typeof mapMemoryQuestionDetail>[0]
    >(
      `
        insert into memory_questions (
          owner_user_id,
          visibility,
          retrieval_scope,
          search_domain,
          workspace_id,
          project_name,
          project_path,
          session_id,
          thread_id,
          thread_name,
          query
        )
        values ($1, 'personal', $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, response, status,
          created_at, updated_at, answered_at, processing_started_at,
          processing_lease_until, attempt_count, last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
      `,
      [
        actor.userId,
        input.retrievalScope ?? "personal",
        input.searchDomain,
        input.workspaceId ?? null,
        input.projectName ?? null,
        input.projectPath ?? null,
        input.sessionId ?? null,
        input.threadId ?? null,
        input.threadName ?? null,
        input.query
      ]
    );

    return mapMemoryQuestionDetail(result.rows[0]!);
  },

  async listMemoryQuestions(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const result = await pool.query<
      Parameters<typeof mapMemoryQuestionShell>[0]
    >(
      `
        select
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, left(answer_markdown, 280) as answer_preview,
          error_message, status, created_at, updated_at, answered_at,
          processing_started_at, processing_lease_until, attempt_count,
          last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
        from memory_questions
        where owner_user_id = $1
          and visibility = 'personal'
          and ($2::memory_search_domain is null or search_domain = $2)
          and ($3::text is null or workspace_id = $3)
          and ($4::uuid is null or session_id = $4)
          and ($8::memory_question_status is null or status = $8)
          and (
            $5::text is null
            or query ilike '%' || $5 || '%'
            or coalesce(answer_markdown, '') ilike '%' || $5 || '%'
            or coalesce(error_message, '') ilike '%' || $5 || '%'
            or coalesce(project_name, '') ilike '%' || $5 || '%'
            or coalesce(thread_name, '') ilike '%' || $5 || '%'
          )
        order by created_at desc, id desc
        limit $6 offset $7
      `,
      [
        actor.userId,
        input.searchDomain ?? null,
        input.workspaceId ?? null,
        input.sessionId ?? null,
        input.query?.trim() || null,
        limit,
        offset,
        input.status ?? null
      ]
    );

    return result.rows.map(mapMemoryQuestionShell);
  },

  async claimPendingMemoryQuestions(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 1, 1), 10);
    const leaseSeconds = Math.min(
      Math.max(input.leaseSeconds ?? 180, 30),
      3600
    );
    const result = await pool.query<
      Parameters<typeof mapMemoryQuestionDetail>[0]
    >(
      `
        with candidates as (
          select id
          from memory_questions
          where owner_user_id = $1
            and visibility = 'personal'
            and status = 'pending'
            and ($2::uuid is null or id = $2)
            and (
              processing_lease_until is null
              or processing_lease_until < now()
            )
          order by created_at asc, id asc
          limit $3
          for update skip locked
        )
        update memory_questions question
        set
          processing_started_at = now(),
          processing_lease_until = now() + ($4::int * interval '1 second'),
          attempt_count = attempt_count + 1,
          last_error_message = null,
          updated_at = now()
        from candidates
        where question.id = candidates.id
        returning
          question.id, question.owner_user_id,
          question.visibility, question.retrieval_scope, question.search_domain,
          question.workspace_id, question.project_name, question.project_path,
          question.session_id, question.thread_id, question.thread_name,
          question.query, question.answer_markdown, question.error_message,
          question.evidence, question.citations, question.retrieval,
          question.local_memory_worker, question.response, question.status,
          question.created_at, question.updated_at, question.answered_at,
          question.processing_started_at, question.processing_lease_until,
          question.attempt_count, question.last_error_message,
          jsonb_array_length(coalesce(question.evidence, '[]'::jsonb)) as evidence_count
      `,
      [actor.userId, input.questionId ?? null, limit, leaseSeconds]
    );

    return result.rows.map(mapMemoryQuestionDetail);
  },

  async getMemoryQuestion(actor, questionId) {
    const result = await pool.query<
      Parameters<typeof mapMemoryQuestionDetail>[0]
    >(
      `
        select
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, response, status,
          created_at, updated_at, answered_at, processing_started_at,
          processing_lease_until, attempt_count, last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
        from memory_questions
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
        limit 1
      `,
      [actor.userId, questionId]
    );

    return result.rows[0] ? mapMemoryQuestionDetail(result.rows[0]) : null;
  },

  async updateMemoryQuestion(actor, questionId, input) {
    const result = await pool.query<
      Parameters<typeof mapMemoryQuestionDetail>[0]
    >(
      `
        update memory_questions
        set
          status = $3::memory_question_status,
          answer_markdown = case when $3::text = 'answered' then $4 else null end,
          error_message = case when $3::text = 'error' then $5 else null end,
          response = coalesce($6::jsonb, response),
          evidence = coalesce($7::jsonb, evidence),
          citations = coalesce($8::jsonb, citations),
          retrieval = coalesce($9::jsonb, retrieval),
          local_memory_worker = coalesce($10::jsonb, local_memory_worker),
          processing_lease_until = null,
          processing_started_at = case
            when $3::text = 'pending' then null
            else processing_started_at
          end,
          last_error_message = case
            when $3::text = 'error' then $5
            when $3::text = 'pending' then $12
            else null
          end,
          answered_at = case
            when $3::text in ('answered', 'error') then now()
            else null
          end,
          updated_at = now()
        where id = $2
          and owner_user_id = $1
          and visibility = 'personal'
          and status = 'pending'
          and (
            ($11::int is not null and attempt_count = $11)
            or ($11::int is null and processing_lease_until is null)
          )
        returning
          id, owner_user_id, visibility, retrieval_scope, search_domain,
          workspace_id, project_name, project_path, session_id, thread_id,
          thread_name, query, answer_markdown, error_message, evidence,
          citations, retrieval, local_memory_worker, response, status,
          created_at, updated_at, answered_at, processing_started_at,
          processing_lease_until, attempt_count, last_error_message,
          jsonb_array_length(coalesce(evidence, '[]'::jsonb)) as evidence_count
      `,
      [
        actor.userId,
        questionId,
        input.status,
        input.status === "answered" ? input.answerMarkdown : null,
        input.status === "error" ? input.errorMessage : null,
        input.response ? JSON.stringify(input.response) : null,
        "evidence" in input && input.evidence
          ? JSON.stringify(input.evidence)
          : null,
        "citations" in input && input.citations
          ? JSON.stringify(input.citations)
          : null,
        input.retrieval ? JSON.stringify(input.retrieval) : null,
        input.localMemoryWorker
          ? JSON.stringify(input.localMemoryWorker)
          : null,
        input.attemptCount ?? null,
        input.status === "pending" ? input.lastErrorMessage : null
      ]
    );

    return result.rows[0] ? mapMemoryQuestionDetail(result.rows[0]) : null;
  },

  async createMemoryNode(actor, input) {
    const ownerUserId = actor.userId;

    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      title: string | null;
      summary_text: string;
    }>(
      `
        insert into memory_nodes (
          owner_user_id,
          created_by_user_id,
          visibility,
          kind,
          depth,
          title,
          summary_text,
          body_text,
          source_runtime,
          capture_method,
          codex_transcript_path,
          idempotency_key,
          source_hash,
          summary_model,
          summary_prompt_version,
          lcm_algorithm_version
        )
        values (
          $1, $2, $3, 'leaf', 0, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
        returning id, owner_user_id, visibility, title, summary_text
      `,
      [
        ownerUserId,
        actor.userId,
        input.visibility,
        input.title ?? null,
        input.summaryText,
        input.bodyText ?? null,
        input.sourceRuntime ?? null,
        input.captureMethod ?? "mcp",
        input.codexTranscriptPath ?? null,
        input.idempotencyKey ?? null,
        input.sourceHash ?? null,
        input.summaryModel ?? null,
        input.summaryPromptVersion ?? null,
        input.lcmAlgorithmVersion ?? null
      ]
    );

    return mapMemoryNode(result.rows[0]!);
  },

  async getEffectiveCapturePolicy(actor, input = {}) {
    const sessionLookup = input.sessionId
      ? await pool.query<{
          id: string;
          external_session_id: string | null;
          workspace_id: string | null;
          cwd: string | null;
        }>(
          `
            select id, external_session_id, workspace_id::text, cwd
            from sessions
            where id = $2
              and owner_user_id = $1
              and invalidated_at is null
            limit 1
          `,
          [actor.userId, input.sessionId]
        )
      : null;
    const threadIds = [
      input.threadId,
      input.sessionId,
      sessionLookup?.rows[0]?.external_session_id ?? undefined
    ].filter((value): value is string => Boolean(value));
    const projectId =
      input.projectId ??
      sessionLookup?.rows[0]?.cwd ??
      sessionLookup?.rows[0]?.workspace_id ??
      null;
    const result = await pool.query<{
      id: string;
      owner_user_id: string;
      target_type: CapturePolicyTarget;
      project_id: string | null;
      project_name: string | null;
      project_path: string | null;
      thread_id: string | null;
      thread_name: string | null;
      capture_state: CaptureState | null;
      visibility: Visibility | null;
      pause_until: Date | null;
      created_at: Date;
      updated_at: Date;
      priority: number;
    }>(
      `
        select cp.*, case cp.target_type
          when 'thread' then 3
          when 'project' then 2
          else 1
        end as priority
        from capture_policies cp
        where cp.owner_user_id = $1
          and (
            cp.target_type = 'global'
            or (cp.target_type = 'project' and cp.project_id = $2)
            or (cp.target_type = 'thread' and cp.thread_id = any($3::text[]))
          )
        order by priority desc, cp.updated_at desc
      `,
      [actor.userId, projectId, threadIds]
    );
    const policies = result.rows.map(mapCapturePolicy);
    const global = policies.find((policy) => policy.targetType === "global");
    const effective = policies[0] ?? null;
    const pauseUntil = effective?.pauseUntil ?? global?.pauseUntil ?? null;
    const paused = pauseUntil
      ? new Date(pauseUntil).getTime() > Date.now()
      : false;
    return {
      captureState: paused
        ? "disabled"
        : (effective?.captureState ?? global?.captureState ?? "enabled"),
      visibility: effective?.visibility ?? global?.visibility ?? "personal",
      paused,
      pauseUntil,
      source: effective?.targetType ?? (global ? "global" : "default"),
      policy: effective
    };
  },

  async listCapturePolicies(actor, targetType) {
    const result = await pool.query<Parameters<typeof mapCapturePolicy>[0]>(
      `
        select *
        from capture_policies
        where owner_user_id = $1
          and ($2::capture_policy_target is null or target_type = $2::capture_policy_target)
        order by
          case target_type when 'global' then 0 when 'project' then 1 else 2 end,
          updated_at desc
      `,
      [actor.userId, targetType ?? null]
    );
    return result.rows.map(mapCapturePolicy);
  },

  async upsertCapturePolicy(actor, input) {
    if (input.targetType === "project" && !input.projectId) {
      throw new Error("Project capture policy requires projectId");
    }
    if (input.targetType === "thread" && !input.threadId) {
      throw new Error("Thread capture policy requires threadId");
    }
    const pauseUntil =
      input.pauseUntil instanceof Date
        ? input.pauseUntil
        : input.pauseUntil
          ? new Date(input.pauseUntil)
          : null;
    const result = await pool.query<Parameters<typeof mapCapturePolicy>[0]>(
      `
        insert into capture_policies (
          owner_user_id,
          target_type,
          project_id,
          project_name,
          project_path,
          thread_id,
          thread_name,
          capture_state,
          visibility,
          pause_until
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        on conflict (
          owner_user_id,
          target_type,
          (coalesce(project_id, '')),
          (coalesce(thread_id, ''))
        )
        do update set
          project_name = excluded.project_name,
          project_path = excluded.project_path,
          thread_name = excluded.thread_name,
          capture_state = excluded.capture_state,
          visibility = excluded.visibility,
          pause_until = excluded.pause_until,
          updated_at = now()
        returning *
      `,
      [
        actor.userId,
        input.targetType,
        input.targetType === "global" ? null : (input.projectId ?? null),
        input.projectName ?? null,
        input.projectPath ?? null,
        input.targetType === "thread" ? input.threadId! : null,
        input.threadName ?? null,
        input.captureState ?? null,
        input.visibility ?? null,
        pauseUntil
      ]
    );
    return mapCapturePolicy(result.rows[0]!);
  },

  async deleteCapturePolicy(actor, policyId) {
    const result = await pool.query(
      "delete from capture_policies where id = $2 and owner_user_id = $1",
      [actor.userId, policyId]
    );
    return (result.rowCount ?? 0) > 0;
  },

  async getVisibleMemoryNode(actor, nodeId) {
    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      title: string | null;
      summary_text: string;
    }>(
      `
        select mn.id, mn.owner_user_id, mn.visibility, mn.title, mn.summary_text
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
        limit 1
      `,
      [actor.userId, nodeId]
    );

    return result.rows[0] ? mapMemoryNode(result.rows[0]) : null;
  },

  async listVisibleMemoryNodes(actor, visibility) {
    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      title: string | null;
      summary_text: string;
    }>(
      `
        select mn.id, mn.owner_user_id, mn.visibility, mn.title, mn.summary_text
        from memory_nodes mn
        where mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
          and ($2::visibility_scope is null or mn.visibility = $2::visibility_scope)
        order by mn.created_at asc, mn.id asc
      `,
      [actor.userId, visibility ?? null]
    );

    return result.rows.map(mapMemoryNode);
  },

  async listMemoryBrowserItems(actor, input = {}) {
    const requestedLimit = input.limit ?? 100;
    const candidateLimit = Math.min(requestedLimit * 10, 500);
    const result = await pool.query<Parameters<typeof mapMemoryBrowserItem>[0]>(
      `
        select
          mn.id,
          mn.title,
          mn.summary_text,
          mn.visibility,
          mn.created_at,
          mn.updated_at,
          mn.pinned_at,
          coalesce(
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end,
            s.workspace_id::text,
            s.cwd
          ) as project_id,
          coalesce(ev.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
          coalesce(
            ev.payload #>> '{metadata,projectPath}',
            s.cwd,
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end
          ) as project_path,
          coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) as thread_id,
          coalesce(ev.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text) as thread_name
        from memory_nodes mn
        left join lateral (
          select mns.memory_event_id
          from memory_node_sources mns
          where mns.memory_node_id = mn.id
            and mns.memory_event_id is not null
          order by mns.source_order asc
          limit 1
        ) first_source on true
        left join memory_events ev on ev.id = first_source.memory_event_id
        left join sessions s on s.id = ev.session_id
        where mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
          and ($2::visibility_scope is null or mn.visibility = $2::visibility_scope)
          and ($3::text is null or coalesce(
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end,
            s.workspace_id::text,
            s.cwd
          ) = $3)
          and ($4::text is null or coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) = $4)
          and ($5::boolean is null or (($5::boolean = true and mn.pinned_at is not null) or ($5::boolean = false and mn.pinned_at is null)))
          and ($6::text is null or mn.summary_text ilike '%' || $6 || '%' or coalesce(mn.title, '') ilike '%' || $6 || '%')
        order by mn.pinned_at desc nulls last, mn.updated_at desc, mn.created_at desc
        limit $7
      `,
      [
        actor.userId,
        input.visibility ?? null,
        input.projectId ?? null,
        input.threadId ?? null,
        input.pinned ?? null,
        input.query?.trim() || null,
        candidateLimit
      ]
    );
    return result.rows
      .map(mapMemoryBrowserItem)
      .filter(
        (item) =>
          item.clusterLabel !== "Development Activity" ||
          Boolean(input.query?.trim())
      )
      .slice(0, requestedLimit);
  },

  async listMemoryClusters(actor, input = {}) {
    const items = await this.listMemoryBrowserItems(actor, {
      ...input,
      limit: input.limit ? input.limit * (input.itemsPerCluster ?? 4) : 200
    });
    const groups = new Map<string, MemoryClusterRecord>();
    for (const item of items) {
      const current = groups.get(item.clusterId);
      if (current) {
        current.count += 1;
        current.pinnedCount += item.pinnedAt ? 1 : 0;
        if (item.updatedAt > current.latestUpdatedAt) {
          current.latestUpdatedAt = item.updatedAt;
        }
        if (current.items.length < (input.itemsPerCluster ?? 4)) {
          current.items.push(item);
        }
      } else {
        groups.set(item.clusterId, {
          id: item.clusterId,
          label: item.clusterLabel,
          count: 1,
          latestUpdatedAt: item.updatedAt,
          pinnedCount: item.pinnedAt ? 1 : 0,
          items: [item]
        });
      }
    }
    return [...groups.values()]
      .sort((left, right) =>
        right.latestUpdatedAt.localeCompare(left.latestUpdatedAt)
      )
      .slice(0, input.limit ?? 50);
  },

  async listMemoriesInCluster(actor, clusterId, input = {}) {
    const items = await this.listMemoryBrowserItems(actor, {
      limit: Math.max(input.limit ?? 100, 100)
    });
    return items
      .filter((item) => item.clusterId === clusterId)
      .slice(0, input.limit ?? 100);
  },

  async updateMemoryPresentation(actor, nodeId, input) {
    const existing = await this.getVisibleMemoryNode(actor, nodeId);
    if (!existing) {
      return null;
    }
    const result = await pool.query<Parameters<typeof mapMemoryBrowserItem>[0]>(
      `
        update memory_nodes mn
        set
          summary_text = coalesce($3, mn.summary_text),
          pinned_at = case
            when $4::boolean is null then mn.pinned_at
            when $4::boolean = true then coalesce(mn.pinned_at, now())
            else null
          end,
          visibility = coalesce($5::visibility_scope, mn.visibility),
          owner_user_id = case
            when $5::visibility_scope = 'personal' then $1
            else mn.owner_user_id
          end,
          updated_at = now()
        where mn.id = $2
          and mn.invalidated_at is null
        returning
          mn.id,
          mn.title,
          mn.summary_text,
          mn.visibility,
          mn.created_at,
          mn.updated_at,
          mn.pinned_at,
          null::text as project_id,
          null::text as project_name,
          null::text as project_path,
          null::text as thread_id,
          null::text as thread_name
      `,
      [
        actor.userId,
        nodeId,
        input.summaryText ?? null,
        input.pinned ?? null,
        input.visibility ?? null
      ]
    );
    return result.rows[0] ? mapMemoryBrowserItem(result.rows[0]) : null;
  },

  async deleteMemory(actor, nodeId) {
    const existing = await this.getVisibleMemoryNode(actor, nodeId);
    if (!existing) {
      return false;
    }
    const result = await pool.query(
      `
        update memory_nodes mn
        set invalidated_at = now(), invalidation_reason = 'user_deleted'
        where mn.id = $2
          and mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
      `,
      [actor.userId, nodeId]
    );
    return (result.rowCount ?? 0) > 0;
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
          where me.invalidated_at is null
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
          coalesce(
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end,
            s.workspace_id::text,
            s.cwd
          ) as project_id,
          coalesce(ev.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
          coalesce(
            ev.payload #>> '{metadata,projectPath}',
            s.cwd,
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end
          ) as project_path,
          s.id::text as session_id,
          coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) as thread_id,
          coalesce(ev.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text) as thread_name,
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
        left join memory_embeddings me on me.memory_node_id = mn.id and me.invalidated_at is null
        where mn.kind in ('leaf', 'rollup')
          and ($2::boolean = true or mn.invalidated_at is null)
          and ($3::visibility_scope is null or mn.visibility = $3::visibility_scope)
          and ($4::text is null or coalesce(
            case when ev.payload ->> 'workspaceId' = s.id::text then null else ev.payload ->> 'workspaceId' end,
            s.workspace_id::text,
            s.cwd
          ) = $4)
          and ($5::text is null or coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) = $5)
          and ($6::text is null or mn.summary_text ilike '%' || $6 || '%' or mn.id::text = $6)
          and ($7::uuid[] is null or mn.id = any($7::uuid[]))
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
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
        limit
      ]
    );
    return result.rows.map(mapLcmGraphNode);
  },

  async getLcmGraphNode(actor, nodeId, input = {}) {
    const nodes = await this.listLcmGraphNodes(actor, {
      includeInvalidated: input.includeInvalidated,
      nodeIds: [nodeId],
      limit: 1
    });
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      return null;
    }
    const [fullNode, childRows, parentRows, sourceRows] = await Promise.all([
      pool.query<{ source_items_json: LcmSourceItem[] }>(
        "select source_items_json from memory_nodes where id = $1",
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
      limit: 500
    });
    const visibleNodeById = new Map(
      visibleNodes.map((item) => [item.id, item])
    );
    const [sources] = await Promise.all([
      Promise.all(
        sourceRows.rows.map((row) =>
          this.getLcmGraphEvent(actor, row.memory_event_id, {
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
    return {
      ...node,
      sourceItems: fullNode.rows[0]?.source_items_json ?? [],
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
    await pool.query(
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
        input.summaryText ?? null,
        input.visibility ?? null
      ]
    );
    if (input.summaryText !== undefined) {
      await pool.query(
        `
          update memory_embeddings
          set invalidated_at = now(), invalidation_reason = 'lcm_summary_corrected'
          where memory_node_id = $1 and invalidated_at is null
        `,
        [nodeId]
      );
    }
    return this.getLcmGraphNode(actor, nodeId, { includeInvalidated: false });
  },

  async invalidateLcmGraphNode(actor, nodeId) {
    return this.deleteMemory(actor, nodeId);
  },

  async listLcmGraphEvents(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const result = await pool.query<Parameters<typeof mapLcmGraphEvent>[0]>(
      `
        with visible_events as (
          select
            me.id,
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
            coalesce(
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end,
              s.workspace_id::text,
              s.cwd
            ) as workspace_id,
            coalesce(
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end,
              s.workspace_id::text,
              s.cwd
            ) as project_id,
            coalesce(me.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
            coalesce(
              me.payload #>> '{metadata,projectPath}',
              s.cwd,
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end
            ) as project_path,
            s.id::text as session_id,
            coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) as thread_id,
            coalesce(me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            me.captured_at,
            me.visibility,
            me.invalidated_at,
            me.invalidation_reason,
            me.payload ->> 'content' as content,
            coalesce(me.payload -> 'metadata', '{}'::jsonb) as metadata
          from memory_events me
          left join sessions s on s.id = me.session_id
          where ($2::boolean = true or me.invalidated_at is null)
            and ($3::visibility_scope is null or me.visibility = $3::visibility_scope)
            and ($4::text is null or coalesce(
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end,
              s.workspace_id::text,
              s.cwd
            ) = $4)
            and ($5::text is null or coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) = $5)
            and ($6::uuid is null or me.id = $6)
            and ($7::text is null or me.payload ->> 'content' ilike '%' || $7 || '%' or me.id::text = $7)
            and (
              $8::timestamptz is null
              or me.captured_at < $8::timestamptz
              or (
                $9::uuid is not null
                and me.captured_at = $8::timestamptz
                and me.id < $9::uuid
              )
            )
            and me.visibility = 'personal'
            and me.owner_user_id = $1
          order by me.captured_at desc, me.id desc
          limit $10
        )
        select
          ve.*,
          coalesce(linked_node_ids.linked_node_ids, array[]::text[]) as linked_node_ids
        from visible_events ve
        left join lateral (
          select array_agg(mns.memory_node_id::text order by mns.source_order) as linked_node_ids
          from memory_node_sources mns
          where mns.memory_event_id = ve.id
        ) linked_node_ids on true
        order by ve.captured_at desc, ve.id desc
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
        input.cursorId ?? null,
        limit
      ]
    );
    return result.rows.map((row) =>
      mapLcmGraphEvent({
        ...row,
        includeContent: input.includeContent ?? false,
        includeRaw: input.includeRaw ?? false
      })
    );
  },

  async listLcmGraphThreads(actor, input = {}) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const result = await pool.query<Parameters<typeof mapLcmGraphThreadRow>[0]>(
      `
        with visible_thread_rows as (
          select
            me.id::text as id,
            'event' as row_kind,
            coalesce(
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end,
              s.workspace_id::text,
              s.cwd,
              'unknown-project'
            ) as project_id,
            coalesce(me.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd, 'Unknown project') as project_name,
            coalesce(
              me.payload #>> '{metadata,projectPath}',
              s.cwd,
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end
            ) as project_path,
            coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) as thread_id,
            coalesce(me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            me.session_id,
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
            me.captured_at,
            me.invalidated_at,
            me.payload ->> 'content' as content
          from memory_events me
          left join sessions s on s.id = me.session_id
          where ($2::boolean = true or me.invalidated_at is null)
            and ($3::visibility_scope is null or me.visibility = $3::visibility_scope)
            and ($4::text is null or coalesce(
              case when me.payload ->> 'workspaceId' = s.id::text then null else me.payload ->> 'workspaceId' end,
              s.workspace_id::text,
              s.cwd,
              'unknown-project'
            ) = $4)
            and ($5::text is null or coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) = $5)
            and (
              $6::text is null
              or me.payload ->> 'content' ilike '%' || $6 || '%'
              or me.id::text = $6
              or coalesce(me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') ilike '%' || $6 || '%'
              or coalesce(me.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd, 'Unknown project') ilike '%' || $6 || '%'
            )
            and me.visibility = 'personal'
            and me.owner_user_id = $1
          union all
          select
            s.id::text as id,
            'session' as row_kind,
            coalesce(s.metadata ->> 'workspaceId', s.workspace_id::text, s.cwd, 'unknown-project') as project_id,
            coalesce(s.metadata ->> 'projectName', s.workspace_id::text, s.cwd, 'Unknown project') as project_name,
            coalesce(s.metadata ->> 'projectPath', s.cwd, s.workspace_id::text) as project_path,
            coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) as thread_id,
            coalesce(s.metadata ->> 'threadName', s.external_session_id, s.id::text, 'Untitled conversation') as thread_name,
            s.id as session_id,
            case
              when s.metadata ->> 'threadKind' = 'subagent' then 'subagent'
              else 'conversation'
            end as thread_kind,
            coalesce(s.metadata ->> 'parentThreadId', s.metadata ->> 'parentExternalSessionId') as parent_thread_id,
            s.metadata ->> 'parentSessionId' as parent_session_id,
            s.created_at as captured_at,
            s.invalidated_at,
            null::text as content
          from sessions s
          where ($2::boolean = true or s.invalidated_at is null)
            and ($3::visibility_scope is null or s.visibility = $3::visibility_scope)
            and ($4::text is null or coalesce(s.metadata ->> 'workspaceId', s.workspace_id::text, s.cwd, 'unknown-project') = $4)
            and ($5::text is null or coalesce(s.metadata ->> 'externalSessionId', s.external_session_id, s.id::text) = $5)
            and (
              $6::text is null
              or s.id::text = $6
              or coalesce(s.metadata ->> 'threadName', s.external_session_id, s.id::text, 'Untitled conversation') ilike '%' || $6 || '%'
              or coalesce(s.metadata ->> 'projectName', s.workspace_id::text, s.cwd, 'Unknown project') ilike '%' || $6 || '%'
            )
            and s.visibility = 'personal'
            and s.owner_user_id = $1
        ),
        ranked_threads as (
          select
            project_id,
            (array_agg(project_name order by captured_at desc, id desc))[1] as project_name,
            (array_agg(project_path order by captured_at desc, id desc))[1] as project_path,
            thread_id,
            (array_agg(thread_name order by captured_at desc, id desc))[1] as thread_name,
            (array_agg(session_id order by captured_at desc, id desc) filter (where session_id is not null))[1] as session_id,
            (array_agg(thread_kind order by captured_at desc, id desc))[1] as thread_kind,
            (array_agg(parent_thread_id order by captured_at desc, id desc) filter (where parent_thread_id is not null))[1] as parent_thread_id,
            (array_agg(parent_session_id order by captured_at desc, id desc) filter (where parent_session_id is not null))[1] as parent_session_id,
            count(*) filter (where row_kind = 'event')::text as event_count,
            count(*) filter (where row_kind = 'event' and invalidated_at is not null)::text as invalidated_count,
            max(captured_at) as latest_at,
            coalesce((array_agg(content order by captured_at desc, id desc) filter (where content is not null))[1], '') as sample
          from visible_thread_rows
          group by project_id, thread_id
          order by max(captured_at) desc, thread_id desc
          limit $7
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
        limit
      ]
    );

    const projects = new Map<string, LcmGraphProjectThreads>();
    for (const thread of result.rows.map(mapLcmGraphThreadRow)) {
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
        projectId: thread.projectId,
        projectName: thread.projectName,
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
    await pool.query(
      `
        update memory_events
        set
          visibility = coalesce($3::visibility_scope, visibility),
          owner_user_id = case
            when $3::visibility_scope = 'personal' then $1
            else owner_user_id
          end,
          invalidated_at = case when $4::boolean = true then coalesce(invalidated_at, now()) else invalidated_at end,
          invalidation_reason = case when $4::boolean = true then coalesce(invalidation_reason, 'user_deleted') else invalidation_reason end,
          updated_at = now()
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
      await pool.query(
        `
          update memory_embeddings
          set invalidated_at = now(), invalidation_reason = 'source_event_deleted'
          where memory_event_id = $1 and invalidated_at is null
        `,
        [eventId]
      );
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
      events
    };
  },

  async listSourcesNeedingEmbeddings(limit = 100) {
    const result = await pool.query<{
      source_type: EmbeddableSourceType;
      source_id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      text: string;
    }>(
      `
        with sources as (
          select
            'memory_node'::text as source_type,
            mn.id as source_id,
            mn.owner_user_id,
            mn.visibility,
            case
              when mn.body_text is null
                or btrim(mn.body_text) = ''
                or btrim(mn.body_text) = btrim(mn.summary_text)
              then btrim(mn.summary_text)
              else btrim(mn.summary_text || ' ' || mn.body_text)
            end as text,
            mn.created_at
          from memory_nodes mn
          where mn.invalidated_at is null

          union all

          select
            'memory_event'::text as source_type,
            me.id as source_id,
            me.owner_user_id,
            me.visibility,
            coalesce(me.payload ->> 'content', '') as text,
            me.captured_at as created_at
          from memory_events me
          where me.invalidated_at is null
        )
        select source_type, source_id, owner_user_id, visibility, text
        from sources s
        where length(trim(s.text)) > 0
          and not exists (
            select 1
            from memory_embeddings me
            where me.invalidated_at is null
              and me.embedding_model = $1
              and me.embedding_dimensions = $2
              and me.embedding_version = $3
              and (
                (s.source_type = 'memory_node' and me.memory_node_id = s.source_id)
                or (s.source_type = 'memory_event' and me.memory_event_id = s.source_id)
              )
          )
        order by s.created_at asc, s.source_id asc
        limit $4
      `,
      [
        localEmbeddingModel(),
        localEmbeddingDimensions(),
        localEmbeddingVersion(),
        limit
      ]
    );

    return result.rows.map((row) => ({
      sourceType: row.source_type,
      sourceId: row.source_id,
      ownerUserId: row.owner_user_id,
      visibility: row.visibility,
      text: row.text,
      sourceHash: sourceHash(row.source_type, row.source_id, row.text)
    }));
  },

  async getEmbeddableSource(sourceType, sourceId) {
    const result = await pool.query<{
      source_type: EmbeddableSourceType;
      source_id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      text: string;
    }>(
      `
        with sources as (
          select
            'memory_node'::text as source_type,
            mn.id as source_id,
            mn.owner_user_id,
            mn.visibility,
            case
              when mn.body_text is null
                or btrim(mn.body_text) = ''
                or btrim(mn.body_text) = btrim(mn.summary_text)
              then btrim(mn.summary_text)
              else btrim(mn.summary_text || ' ' || mn.body_text)
            end as text
          from memory_nodes mn
          where mn.invalidated_at is null

          union all

          select
            'memory_event'::text as source_type,
            me.id as source_id,
            me.owner_user_id,
            me.visibility,
            coalesce(me.payload ->> 'content', '') as text
          from memory_events me
          where me.invalidated_at is null
        )
        select source_type, source_id, owner_user_id, visibility, text
        from sources
        where source_type = $1 and source_id = $2 and length(trim(text)) > 0
        limit 1
      `,
      [sourceType, sourceId]
    );
    const row = result.rows[0];
    return row
      ? {
          sourceType: row.source_type,
          sourceId: row.source_id,
          ownerUserId: row.owner_user_id,
          visibility: row.visibility,
          text: row.text,
          sourceHash: sourceHash(row.source_type, row.source_id, row.text)
        }
      : null;
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
    return mapLcmNodeForSummarization(pool, row);
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
        where mn.invalidated_at is null
          and mn.kind in ('leaf', 'rollup')
          and mn.summary_model is null
          and (
            mn.kind = 'leaf'
            or not exists (
              select 1
              from memory_node_children mnc
              join memory_nodes child on child.id = mnc.child_memory_node_id
              where mnc.parent_memory_node_id = mn.id
                and child.invalidated_at is null
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
      result.rows.map((row) => mapLcmNodeForSummarization(pool, row))
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
          and mn.invalidated_at is null
          and mn.kind in ('leaf', 'rollup')
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
        limit 1
      `,
      [actor.userId, nodeId]
    );
    const row = result.rows[0];
    return row ? mapLcmNodeForSummarization(pool, row) : null;
  },

  async updateLcmNodeSummary(input) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const current = await client.query<{ summary_text: string }>(
        `
          select summary_text
          from memory_nodes
          where id = $1
            and invalidated_at is null
            and kind in ('leaf', 'rollup')
          for update
        `,
        [input.nodeId]
      );
      const previousSummary = current.rows[0]?.summary_text;
      if (previousSummary === undefined) {
        await client.query("commit");
        return;
      }

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
          input.summaryText,
          input.summaryModel,
          input.summaryPromptVersion,
          input.summaryTokenEstimate,
          input.summaryStructuredJson === undefined
            ? null
            : JSON.stringify(input.summaryStructuredJson),
          input.summaryStructuredSchemaVersion ?? null
        ]
      );

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
          input.sourceText ?? input.source.text
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

  async createMemoryEvent(actor, input) {
    if (input.sessionId) {
      const visibleSession = await pool.query<{ id: string }>(
        `
          select s.id
          from sessions s
          where s.id = $2
            and s.invalidated_at is null
            and s.visibility = 'personal'
            and s.owner_user_id = $1
          limit 1
        `,
        [actor.userId, input.sessionId]
      );
      if (visibleSession.rowCount === 0) {
        throw new Error("Session not found or not visible");
      }
    }

    const ownerUserId = actor.userId;
    const payload = {
      actor: input.actor,
      content: input.content,
      metadata: input.metadata ?? {},
      rawEventType: input.rawEventType,
      workspaceId: input.workspaceId
    };
    const rawConversationItemIds = rawConversationItemIdsFromMetadata(
      input.metadata
    );
    const capturedAt = input.capturedAt ? new Date(input.capturedAt) : null;
    if (capturedAt && Number.isNaN(capturedAt.getTime())) {
      throw new Error("capturedAt must be a valid timestamp");
    }

    type MemoryEventRow = {
      id: string;
      owner_user_id: string | null;
      visibility: Visibility;
      event_type: MemoryEventType;
      session_id: string | null;
      turn_id: string | null;
      payload: MemoryEventRecord["metadata"] & {
        actor?: MemoryActor;
        content?: string;
        metadata?: Record<string, unknown>;
        rawEventType?: string;
        workspaceId?: string;
      };
      created_at: Date;
    };

    const result = await pool.query<MemoryEventRow>(
      `
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
          captured_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13::timestamptz, now()))
        on conflict do nothing
        returning id, owner_user_id, visibility, event_type, session_id, turn_id, payload, created_at
      `,
      [
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
        payload,
        capturedAt
      ]
    );

    const insertedRow = result.rows[0];
    if (insertedRow) {
      await linkMemoryEventSources(
        pool,
        insertedRow.id,
        rawConversationItemIds
      );
      return mapMemoryEvent(insertedRow);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const duplicate = await pool.query<MemoryEventRow>(
        `
          select me.id, me.owner_user_id, me.visibility, me.event_type, me.session_id, me.turn_id, me.payload, me.created_at
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
        await linkMemoryEventSources(
          pool,
          duplicateRow.id,
          rawConversationItemIds
        );
        return mapMemoryEvent(duplicateRow);
      }
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
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
      | "fresh_pending_search"
      | "raw_fallback_search"
      | "lexical_search";
    type VectorRow = {
      id: string;
      source_type: "memory_node" | "memory_event" | "message";
      source_id: string;
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
      embedding_model: string;
      embedding_dimensions: number;
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
      fresh_pending_search: 2,
      raw_fallback_search: 1,
      lexical_search: 2
    };
    const stageWeight: Record<RetrievalStageName, number> = {
      rollup_search: 1.1,
      scoped_leaf_search: 1.05,
      leaf_search: 1,
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
      fresh_pending_search: freshCandidateLimit,
      raw_fallback_search: rawCandidateLimit,
      lexical_search: lexicalCandidateLimit
    };
    const requestedStage =
      input.retrievalStage && input.retrievalStage !== "score_scan"
        ? input.retrievalStage
        : null;
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
              'memory_node'::text as source_type,
              mn.id as source_id,
              coalesce(
                (
                  select array_agg(parent.parent_memory_node_id::text order by parent.parent_memory_node_id::text)
                  from memory_node_children parent
                  where parent.child_memory_node_id = mn.id
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
                  nullif(source_ev.payload ->> 'projectName', '') as project_name,
                  coalesce(nullif(source_ev.payload ->> 'projectPath', ''), nullif(source_ev.payload ->> 'workspaceId', ''), nullif(source_msg_session.cwd, '')) as project_path
                from memory_node_sources source_mns
                left join memory_events source_ev on source_ev.id = source_mns.memory_event_id and source_ev.invalidated_at is null
                left join messages source_msg on source_msg.id = source_mns.message_id and source_msg.invalidated_at is null
                left join sessions source_msg_session on source_msg_session.id = source_msg.session_id
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
                        source_ev.payload ->> 'workspaceId' = $7
                        or source_msg_session.cwd = $7
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
            where mn.invalidated_at is null
              and mn.visibility = 'personal'
              and mn.owner_user_id = $1
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
              'memory_event'::text as source_type,
              me.id as source_id,
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
            where me.invalidated_at is null
              and me.visibility = 'personal'
              and me.owner_user_id = $1
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
                  and me.payload ->> 'workspaceId' = $7
                )
              )
              and ($8::timestamptz is null or me.captured_at >= $8::timestamptz)
              and ($9::timestamptz is null or me.captured_at < $9::timestamptz)

            union all

            select
              msg.id,
              'message'::text as source_type,
              msg.id as source_id,
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
              and msg.visibility = 'personal'
              and msg.owner_user_id = $1
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
                  and msg_session.cwd = $7
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
            source_type::text,
            source_id,
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
          lexicalCandidateLimit
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
          rerankingError: error instanceof Error ? error.message : String(error)
        };
      }
    };

    try {
      if (requestedStage !== "lexical_search") {
        const embedded = await embedTexts([input.query]);
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
                  case
                    when me.memory_node_id is not null then 'memory_node'
                    when me.memory_event_id is not null then 'memory_event'
                    else 'message'
                  end as source_type,
                  coalesce(me.memory_node_id, me.memory_event_id, me.message_id) as source_id,
                  $11::text as retrieval_stage,
                  coalesce(
                    (
                      select array_agg(parent.parent_memory_node_id::text order by parent.parent_memory_node_id::text)
                      from memory_node_children parent
                      where parent.child_memory_node_id = me.memory_node_id
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
                      left join memory_events boundary_ev on boundary_ev.id = boundary_mns.memory_event_id and boundary_ev.invalidated_at is null
                      left join messages boundary_msg on boundary_msg.id = boundary_mns.message_id and boundary_msg.invalidated_at is null
                      left join sessions boundary_msg_session on boundary_msg_session.id = boundary_msg.session_id
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
                                boundary_ev.payload ->> 'workspaceId' = $10
                                or boundary_msg_session.cwd = $10
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
                          nullif(time_ev.payload ->> 'projectName', '') as project_name,
                          coalesce(nullif(time_ev.payload ->> 'projectPath', ''), nullif(time_ev.payload ->> 'workspaceId', ''), nullif(time_msg_session.cwd, '')) as project_path
                        from memory_node_sources time_mns
                        left join memory_events time_ev on time_ev.id = time_mns.memory_event_id and time_ev.invalidated_at is null
                        left join messages time_msg on time_msg.id = time_mns.message_id and time_msg.invalidated_at is null
                        left join sessions time_msg_session on time_msg_session.id = time_msg.session_id
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
                                time_ev.payload ->> 'workspaceId' = $10
                                or time_msg_session.cwd = $10
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
                  coalesce(me.source_text, mn.summary_text, ev.payload ->> 'content', msg.content, '') as summary_text,
                  case
                    when mn.summary_model is not null then mn.summary_text
                    when linked_mn.summary_model is not null then linked_mn.summary_text
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
                        left join messages source_msg on source_msg.id = source_mns.message_id and source_msg.invalidated_at is null
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
                left join memory_nodes mn on mn.id = me.memory_node_id and mn.invalidated_at is null
                left join memory_events ev on ev.id = me.memory_event_id and ev.invalidated_at is null
                left join messages msg on msg.id = me.message_id and msg.invalidated_at is null
                left join sessions msg_session on msg_session.id = msg.session_id
                left join memory_node_sources mns on mns.memory_event_id = me.memory_event_id or mns.message_id = me.message_id
                left join memory_nodes linked_mn on linked_mn.id = mns.memory_node_id and linked_mn.invalidated_at is null
                where me.invalidated_at is null
                  and me.embedding_model = $5
                  and me.embedding_dimensions = $6
                  and me.embedding_version = $7
                  and (
                    (me.memory_node_id is not null and mn.id is not null)
                    or (me.memory_event_id is not null and ev.id is not null)
                    or (me.message_id is not null and msg.id is not null)
                  )
                  and me.visibility = 'personal'
                  and me.owner_user_id = $1
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
                          left join memory_events filter_ev on filter_ev.id = filter_mns.memory_event_id and filter_ev.invalidated_at is null
                          left join messages filter_msg on filter_msg.id = filter_mns.message_id and filter_msg.invalidated_at is null
                          where filter_mns.memory_node_id = me.memory_node_id
                            and (filter_ev.session_id = $9::uuid or filter_msg.session_id = $9::uuid)
                        )
                      )
                    )
                    or (
                      $8::text = 'project'
                      and (
                        ev.payload ->> 'workspaceId' = $10
                        or msg_session.cwd = $10
                        or exists (
                          select 1
                          from memory_node_sources filter_mns
                          left join memory_events filter_ev on filter_ev.id = filter_mns.memory_event_id and filter_ev.invalidated_at is null
                          left join messages filter_msg on filter_msg.id = filter_mns.message_id and filter_msg.invalidated_at is null
                          left join sessions filter_msg_session on filter_msg_session.id = filter_msg.session_id
                          where filter_mns.memory_node_id = me.memory_node_id
                            and (
                              filter_ev.payload ->> 'workspaceId' = $10
                              or filter_msg_session.cwd = $10
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
                        left join memory_events time_ev on time_ev.id = time_mns.memory_event_id and time_ev.invalidated_at is null
                        left join messages time_msg on time_msg.id = time_mns.message_id and time_msg.invalidated_at is null
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
                      left join memory_events source_ev on source_ev.id = source_mns.memory_event_id and source_ev.invalidated_at is null
                      left join messages source_msg on source_msg.id = source_mns.message_id and source_msg.invalidated_at is null
                      left join sessions source_msg_session on source_msg_session.id = source_msg.session_id
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
                              source_ev.payload ->> 'workspaceId' = $10
                              or source_msg_session.cwd = $10
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
                        where scoped_parent.child_memory_node_id = me.memory_node_id
                          and scoped_parent.parent_memory_node_id = any($14::uuid[])
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
                              and linked_node.invalidated_at is null
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
                              and linked_node.invalidated_at is null
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
                parentNodeIds
              ]
            );
            const rows = vectorResult.rows.map((row) => {
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
            });
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
                input.parentNodeIds && input.parentNodeIds.length > 0
                  ? input.parentNodeIds
                  : []
              )
            ];
          };
          const runDefaultSemanticStages = async (): Promise<StageResult[]> => {
            const [rollups, leaves, fresh, rawFallback] = await Promise.all([
              runStage("rollup_search", rollupCandidateLimit),
              runStage("leaf_search", leafCandidateLimit),
              runStage("fresh_pending_search", freshCandidateLimit),
              rawFallbackEnabled
                ? runStage("raw_fallback_search", rawCandidateLimit)
                : Promise.resolve(skippedRawFallback)
            ]);
            const selectedRollupIds =
              input.parentNodeIds && input.parentNodeIds.length > 0
                ? input.parentNodeIds
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
        source_type: "memory_node" | "memory_event" | "message";
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
      const normalizedText = row.summary_text.trim().toLowerCase();
      const key = normalizedText
        ? `${row.visibility}:${normalizedText}`
        : `${row.source_type}:${row.source_id}`;
      const score = Number(row.score) * weight;
      const priority = stagePriority[row.retrieval_stage];
      const existing = merged.get(key);
      if (
        !existing ||
        priority > existing.stagePriority ||
        (priority === existing.stagePriority && score > existing.score)
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
          summaryText: row.summary_text,
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
          right.stagePriority - left.stagePriority ||
          right.score - left.score ||
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
      stages: stageDiagnostics
    };

    return { results, metadata: embeddingMetadata };
  },

  async createLcmNodes(actor, input) {
    const ownerUserId = actor.userId;
    const client = await pool.connect();

    try {
      await client.query("begin");
      const eventRows = await client.query<{
        id: string;
        visibility: Visibility;
        actor: MemoryActor | null;
        session_id: string | null;
        turn_id: string | null;
        payload: {
          actor?: MemoryActor;
          content?: string;
          metadata?: Record<string, unknown>;
          rawEventType?: string;
          workspaceId?: string;
        };
        captured_at: Date;
      }>(
        `
          select
            me.id,
            me.visibility,
            me.payload ->> 'actor' as actor,
            me.session_id,
            me.turn_id,
            me.payload,
            me.captured_at
          from memory_events me
          where me.invalidated_at is null
            and me.visibility = $1
            and me.owner_user_id = $2
            and not exists (
              select 1
              from memory_node_sources mns
              join memory_nodes mn on mn.id = mns.memory_node_id
              where mns.memory_event_id = me.id
                and mn.kind = 'leaf'
                and mn.invalidated_at is null
            )
          order by me.captured_at asc, me.id asc
        `,
        [input.visibility, ownerUserId]
      );

      const freshTail = lcmFreshEventTail();
      const events =
        freshTail > 0 && eventRows.rows.length > freshTail
          ? eventRows.rows.slice(0, eventRows.rows.length - freshTail)
          : freshTail === 0
            ? eventRows.rows
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
          const eventTokens = estimateTokens(event.payload.content ?? "", {
            model: tokenModel
          });
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
              estimateTokens(event.payload.content ?? "", {
                model: tokenModel
              }),
            0
          );
          if (
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
          text: event.payload.content ?? "",
          payload: lcmSourcePayloadForEvent(event),
          position
        }));
        const summaryText = leafSummaryText(sourceItems);
        const tokenEstimate = sourceItemsTokenEstimate(sourceItems, tokenModel);
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
              source_hash
            )
            values ($1, $2, $3, 'leaf', 0, $4, $4, 'mcp', 'depth0-source-items-v1', $5::jsonb, $6, $7, $8, $9, $10, $11)
            on conflict (source_hash) where source_hash is not null do nothing
            returning id
          `,
          [
            ownerUserId,
            actor.userId,
            input.visibility,
            summaryText,
            JSON.stringify(sourceItems),
            span.length,
            tokenEstimate,
            estimateTokens(summaryText, { model: tokenModel }),
            span[0]!.captured_at,
            span.at(-1)!.captured_at,
            sourceHash(
              "memory_event",
              span.map((event) => event.id).join(","),
              JSON.stringify(sourceItems)
            )
          ]
        );
        const nodeId =
          node.rows[0]?.id ??
          (
            await client.query<{ id: string }>(
              `
                select id
                from memory_nodes
                where source_hash = $1 and invalidated_at is null
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
        leafNodeIds.push(nodeId);

        for (let sourceOrder = 0; sourceOrder < span.length; sourceOrder += 1) {
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
        depth: number;
        summary_text: string;
        source_items_json: LcmSourceItem[];
      }>(
        `
          select mn.id, mn.depth, mn.summary_text, mn.source_items_json
          from memory_nodes mn
          left join memory_node_children mnc on mnc.child_memory_node_id = mn.id
          where mn.invalidated_at is null
            and mn.kind = 'leaf'
            and mn.depth = 0
            and mnc.parent_memory_node_id is null
            and mn.visibility = $1
            and mn.owner_user_id = $2
          order by mn.created_at asc, mn.id asc
        `,
        [input.visibility, ownerUserId]
      );
      const unparentedBySession = new Map<string, typeof unparented.rows>();
      for (const row of unparented.rows) {
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
          Array.isArray(child.source_items_json) ? child.source_items_json : []
        );
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
              source_hash
            )
            values ($1, $2, $3, 'rollup', 1, $4, $4, 'mcp', 'depth1-child-rollup-v1', $5::jsonb, $6, $7, $8, $9)
            on conflict (source_hash) where source_hash is not null do nothing
            returning id
          `,
          [
            ownerUserId,
            actor.userId,
            input.visibility,
            rollupSummary,
            JSON.stringify(childSourceItems),
            eventSourceItems.length,
            sourceItemsTokenEstimate(eventSourceItems, tokenModel),
            estimateTokens(rollupSummary, { model: tokenModel }),
            sourceHash(
              "memory_node",
              rollupChildren.map((child) => child.id).join(","),
              rollupSummary
            )
          ]
        );
        rollupNodeId =
          rollup.rows[0]?.id ??
          (
            await client.query<{ id: string }>(
              `
                select id
                from memory_nodes
                where source_hash = $1 and invalidated_at is null
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
    const visibleNode = await pool.query<{
      id: string;
      visibility: Visibility;
      source_items_json: LcmSourceItem[];
    }>(
      `
        select mn.id, mn.visibility, mn.source_items_json
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null
          and mn.visibility = 'personal'
          and mn.owner_user_id = $1
        limit 1
      `,
      [actor.userId, nodeId]
    );
    const node = visibleNode.rows[0];
    if (!node) {
      throw new Error("Memory node not found or not visible");
    }

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
        where mns.memory_node_id = $1
          and me.invalidated_at is null
          and me.visibility = 'personal'
          and me.owner_user_id = $2
          and ($3::timestamptz is null or me.captured_at >= $3::timestamptz)
          and ($4::timestamptz is null or me.captured_at < $4::timestamptz)
          and (
            $5::text = 'global'
            or ($5::text = 'session' and me.session_id = $6::uuid)
            or ($5::text = 'project' and me.payload ->> 'workspaceId' = $7)
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
        input.workspaceId ?? null
      ]
    );
    const eventSourceItems: LcmSourceItem[] = sources.rows.map(
      (source, position) => ({
        kind: "memory_event",
        sourceTable: "memory_events",
        sourceId: source.id,
        visibility: source.visibility,
        actor: source.payload.actor,
        turnId: source.turn_id,
        createdAt: source.captured_at.toISOString(),
        text: source.payload.content ?? "",
        payload: source.payload,
        position
      })
    );
    const nodeSourceItems = Array.isArray(node.source_items_json)
      ? node.source_items_json
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
      visibility: node.visibility,
      sourceItems:
        filteredNodeSourceItems.length > 0 &&
        filteredNodeSourceItems.some((item) => item.kind === "lcm_child")
          ? [...filteredNodeSourceItems, ...eventSourceItems]
          : eventSourceItems.length > 0
            ? eventSourceItems
            : filteredNodeSourceItems,
      sources: sources.rows.map(mapMemoryEvent)
    } satisfies ExpandedMemoryNode;
  }
});
