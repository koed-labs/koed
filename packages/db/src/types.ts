import type {
  LcmSourceItem,
  MemoryActor,
  MemoryEngineRepository
} from "@koed/core";
import type { CapturedSessionRepository } from "./captured-session-repository.js";
import type { ConversationItemRepository } from "./conversation-item-repository.js";
import type { LocalEmbeddingStatusRepository } from "./local-embedding-status-repository.js";
import type { MemoryNodeRepository } from "./memory-node-repository.js";
import type { MemoryQuestionRepository } from "./memory-question-repository.js";
import type { WorkflowTokenUsageRepository } from "./workflow-token-usage-repository.js";

export type Visibility = "personal";

export type CaptureMethod = "hook" | "mcp" | "web" | "api";

export type SourceRuntime = "codex" | "codex-cli";

export type CaptureState = "enabled" | "disabled" | "ask";

export type CapturePolicyTarget = "global" | "project" | "thread";

export type MemoryQuestionStatus = "pending" | "answered" | "error";

export type MemoryQuestionSearchDomain = "global" | "project" | "session";

export type MemoryQuestionRetrievalScope = "personal";

export type LocalMemoryAgentSettingsFlowKey =
  | "mcp_memory_answer"
  | "lcm_summary";

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

export type AuditActorType = "user" | "local_operator_script";

export interface AuditActorInput {
  actorUserId?: string | null;
  actorType: AuditActorType;
}

export interface AuditEventRecord {
  id: string;
  actorUserId: string | null;
  ownerUserId: string | null;
  visibility: Visibility | null;
  action: string;
  targetTable: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RecordAuditEventInput {
  actorUserId?: string | null;
  ownerUserId?: string | null;
  visibility?: Visibility | null;
  action: string;
  targetTable?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ListAuditEventsInput {
  action?: string;
  limit?: number;
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
  sourceEventTime: string | null;
  sourceSequence: number | null;
  capturedAt: string;
  createdAt: string;
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

export interface CapturedSessionTitleCandidate {
  id: string;
  externalSessionId: string | null;
  projectName: string | null;
  projectPath: string | null;
  currentTitle: string | null;
  eventCount: number;
  sourceItems: Array<{
    id: string;
    actor: MemoryActor;
    content: string;
    capturedAt: string;
  }>;
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

export interface WorkflowTokenUsageInput {
  visibility?: Visibility;
  workflowType: string;
  workflowId?: string;
  sessionId?: string;
  turnId?: string;
  conversationItemId?: string;
  questionId?: string;
  answerJobId?: string;
  lcmNodeId?: string;
  messageId?: string;
  toolEventId?: string;
  memoryEventId?: string;
  sourceReferences?: WorkflowTokenUsageSourceReference[];
  sourceRuntime?: SourceRuntime;
  sourceKind?: string;
  sourceAdapterVersion?: string;
  usageSource?: string;
  usageAccuracy?: string;
  usageKind?: string;
  connectorClient?: string;
  tokenizerPackage?: string;
  tokenizerEncoding?: string;
  tokenizerModel?: string;
  tokenizerExactModelMatch?: boolean | null;
  tokenizerHeuristicFallback?: boolean | null;
  tokenizerVersion?: string;
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

export type WorkflowTokenUsageSourceReferenceType =
  | "question"
  | "answer_job"
  | "lcm_node"
  | "message"
  | "tool_event"
  | "memory_event";

export interface WorkflowTokenUsageSourceReference {
  type: WorkflowTokenUsageSourceReferenceType;
  id: string;
}

export interface WorkflowTokenUsageRecord {
  id: string;
  workflowType: string;
  workflowId: string | null;
  sessionId: string | null;
  turnId: string | null;
  conversationItemId: string | null;
  model: string | null;
  usageSource: string;
  usageAccuracy: string;
  usageKind: string;
  connectorClient: string | null;
  tokenizerPackage: string | null;
  tokenizerEncoding: string | null;
  tokenizerModel: string | null;
  tokenizerExactModelMatch: boolean | null;
  tokenizerHeuristicFallback: boolean | null;
  tokenizerVersion: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  usageScope: string;
  createdAt: string;
}

export interface WorkflowTokenUsageRollupInput {
  groupBy?: Array<
    | "workflow"
    | "model"
    | "owner"
    | "project"
    | "thread"
    | "connector"
    | "accuracy"
    | "date"
  >;
  includeEstimates?: boolean;
  from?: string;
  to?: string;
}

export interface WorkflowTokenUsageRollupRecord {
  group: Record<string, string | null>;
  rowCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
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

interface ConversationProjectionInput {
  limit?: number;
  conversationItemIds?: string[];
  visibility?: Visibility;
}

export type SemanticMemoryRebuildInput = {
  limit?: number;
  leaseSeconds?: number;
};

export interface SemanticMemoryRebuildResult {
  jobsClaimed: number;
  jobsCompleted: number;
  jobsFailed: number;
  memoryEventsCreated: number;
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
  localMemoryWorkerConfig: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
}

export interface LocalMemoryAgentSettingRecord {
  ownerUserId: string;
  flowKey: LocalMemoryAgentSettingsFlowKey;
  provider: "codex";
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySourceRepository
  extends
    MemoryEngineRepository,
    CapturedSessionRepository,
    ConversationItemRepository,
    LocalEmbeddingStatusRepository,
    MemoryNodeRepository,
    MemoryQuestionRepository,
    WorkflowTokenUsageRepository {
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
    audit?: AuditActorInput;
  }): Promise<ApiTokenRecord>;
  listApiTokens(userId: string): Promise<ApiTokenRecord[]>;
  revokeApiToken(
    userId: string,
    tokenId: string,
    audit?: AuditActorInput
  ): Promise<boolean>;
  getApiTokenUser(tokenHash: string): Promise<UserRecord | null>;
  recordAuditEvent(input: RecordAuditEventInput): Promise<AuditEventRecord>;
  listAuditEvents(
    actor: ActorContext,
    input?: ListAuditEventsInput
  ): Promise<AuditEventRecord[]>;
  projectPendingConversationItems(
    actor: ActorContext,
    input?: ConversationProjectionInput
  ): Promise<ConversationProjectionResult>;
  listConversationProjectionActors(input?: {
    limit?: number;
  }): Promise<ActorContext[]>;
  listSemanticMemoryRebuildActors(input?: {
    limit?: number;
  }): Promise<ActorContext[]>;
  processDueSemanticMemoryRebuilds(
    actor: ActorContext,
    input?: SemanticMemoryRebuildInput
  ): Promise<SemanticMemoryRebuildResult>;
  listLocalMemoryAgentSettings(
    actor: ActorContext
  ): Promise<LocalMemoryAgentSettingRecord[]>;
  upsertLocalMemoryAgentSetting(
    actor: ActorContext,
    input: {
      flowKey: LocalMemoryAgentSettingsFlowKey;
      provider: "codex";
      model: string;
      reasoningEffort: string;
      timeoutMs: number;
      maxAttempts: number;
    }
  ): Promise<LocalMemoryAgentSettingRecord>;
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
      cursorSourceSequence?: number;
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
      offset?: number;
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
