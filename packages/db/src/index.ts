import { createHash } from "node:crypto";
import pg from "pg";
import { estimateTokens, type LcmSourceItem } from "@koed/core";
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
import { env } from "@koed/shared";

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

export type Visibility = "personal" | "team";
export type CaptureMethod = "hook" | "mcp" | "web" | "api";
export type SourceRuntime = "codex" | "codex-cli";
export type CaptureState = "enabled" | "disabled" | "ask";
export type CapturePolicyTarget = "global" | "project" | "thread";
export type MemoryQuestionStatus = "pending" | "answered" | "error";
export type MemoryQuestionSearchDomain = "global" | "project" | "session";
export type MemoryQuestionRetrievalScope = "personal" | "personal+team";

export interface ActorContext {
  userId: string;
}

export interface CreateUserInput {
  email: string;
  displayName?: string;
  passwordHash?: string;
}

export interface CreateTeamInput {
  name: string;
  createdByUserId: string;
  inviteCode?: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string | null;
}

export interface TeamRecord {
  id: string;
  name: string;
  inviteCode: string | null;
  role?: "owner" | "admin" | "member";
}

export interface TeamMemberRecord {
  userId: string;
  email: string;
  displayName: string | null;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface ApiTokenRecord {
  id: string;
  ownerUserId: string;
  teamId: string | null;
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
  teamId?: string;
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
  teamId: string | null;
  visibility: Visibility;
  title: string | null;
  summaryText: string;
  createdAt?: string;
  updatedAt?: string;
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
  teamId: string | null;
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
  teamId: string | null;
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
  teamId: string | null;
  visibility: Visibility;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  sourceItems: LcmSourceItem[];
  sourceTokenEstimate: number | null;
  summaryTokenEstimate: number | null;
  summaryModel: string | null;
  summaryPromptVersion: string | null;
  lcmAlgorithmVersion: string | null;
}

interface LcmNodeForSummarizationRow {
  id: string;
  owner_user_id: string | null;
  team_id: string | null;
  visibility: Visibility;
  kind: "leaf" | "rollup";
  depth: number;
  summary_text: string;
  source_items_json: LcmSourceItem[];
  source_token_estimate: number | null;
  summary_token_estimate: number | null;
  summary_model: string | null;
  summary_prompt_version: string | null;
  lcm_algorithm_version: string | null;
}

export type EmbeddableSourceType = "memory_node" | "memory_event" | "message";

export interface EmbeddableSourceRecord {
  sourceType: EmbeddableSourceType;
  sourceId: string;
  ownerUserId: string | null;
  teamId: string | null;
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
  teamId: string | null;
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

export interface MemoryQuestionShellRecord {
  id: string;
  ownerUserId: string;
  teamId: string | null;
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
  createTeam(input: CreateTeamInput): Promise<{ id: string }>;
  addTeamMember(
    teamId: string,
    userId: string,
    role?: "owner" | "admin" | "member"
  ): Promise<void>;
  joinTeamByInviteCode(userId: string, inviteCode: string): Promise<TeamRecord>;
  getCurrentTeam(userId: string): Promise<TeamRecord | null>;
  listTeamMembers(userId: string, teamId: string): Promise<TeamMemberRecord[]>;
  createApiToken(input: {
    ownerUserId: string;
    teamId?: string;
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

const requireTeamMembership = async (
  pool: pg.Pool,
  userId: string,
  teamId: string
): Promise<void> => {
  const result = await pool.query<{ ok: number }>(
    `
      select 1 as ok
      from team_members
      where user_id = $1
        and team_id = $2
        and removed_at is null
      limit 1
    `,
    [userId, teamId]
  );

  if (result.rowCount === 0) {
    throw new Error("User is not an active member of the requested team");
  }
};

const requireTeamMemoryWritePermission = async (
  pool: pg.Pool,
  userId: string,
  teamId: string
): Promise<void> => {
  const result = await pool.query<{ role: "owner" | "admin" | "member" }>(
    `
      select role
      from team_members
      where user_id = $1
        and team_id = $2
        and removed_at is null
      limit 1
    `,
    [userId, teamId]
  );
  const role = result.rows[0]?.role;
  if (role !== "owner" && role !== "admin") {
    throw new Error("User is not allowed to modify Team Memory");
  }
};

const mapMemoryNode = (row: {
  id: string;
  owner_user_id: string | null;
  team_id: string | null;
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
  teamId: row.team_id,
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
      /\b(capture policy|capture control|pause capture|capture enabled|capture disabled|visibility|personal|team shareable|thread override|project override)\b/i
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
      /\b(sport|football|soccer|tennis|arsenal|barcelona|team|league|match)\b/i
  },
  {
    label: "Preferences",
    pattern:
      /\b(prefers?|likes?|dislikes?|wants?|favorite|favourite|style|tone)\b/i
  },
  {
    label: "People",
    pattern: /\b(friend|colleague|teammate|jacobo|user|person|people)\b/i
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
  team_id: string | null;
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
  teamId: row.team_id,
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
  team_id: string | null;
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
    teamId: row.team_id,
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
  team_id: string | null;
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
  teamId: row.team_id,
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

const previewMarkdown = (value: string | null): string | null =>
  value ? truncateDisplayText(value, 280) : null;

const mapMemoryQuestionShell = (row: {
  id: string;
  owner_user_id: string;
  team_id: string | null;
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
  teamId: row.team_id,
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

const mapTeam = (row: {
  id: string;
  name: string;
  invite_code: string | null;
  role?: "owner" | "admin" | "member";
}): TeamRecord => ({
  id: row.id,
  name: row.name,
  inviteCode: row.invite_code,
  ...(row.role ? { role: row.role } : {})
});

const mapApiToken = (row: {
  id: string;
  owner_user_id: string;
  team_id: string | null;
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
  teamId: row.team_id,
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

const embeddingServiceHeaders = (): Record<string, string> => {
  const token = process.env.EMBEDDING_SERVICE_TOKEN?.trim();
  return token ? { "x-koed-embedding-token": token } : {};
};

const localEmbeddingModel = (): string =>
  process.env.EMBEDDING_MODEL ?? "Qwen/Qwen3-Embedding-0.6B-GGUF";

const localEmbeddingDimensions = (): number =>
  Number(process.env.EMBEDDING_DIMENSIONS ?? 1024);

const localEmbeddingVersion = (): string =>
  process.env.EMBEDDING_VERSION ?? "local-qwen3-embedding-0.6b-gguf-v1";

const rerankingEnabled = (): boolean =>
  (process.env.RERANKING_ENABLED ?? "false").trim().toLowerCase() === "true";

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
  positiveIntEnv("MEMORY_LCM_LEAF_TOKEN_THRESHOLD", 32_000);

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
  items.reduce((sum, item) => {
    const payloadTokens =
      item.payload === undefined
        ? 0
        : estimateTokens(JSON.stringify(item.payload), { model });
    return sum + estimateTokens(item.text ?? "", { model }) + payloadTokens;
  }, 0);

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
  team_id: string | null;
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
  teamId: row.team_id,
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
    teamId: row.team_id,
    visibility: row.visibility,
    kind: row.kind,
    depth: row.depth,
    summaryText: row.summary_text,
    sourceItems,
    sourceTokenEstimate: row.source_token_estimate,
    summaryTokenEstimate: row.summary_token_estimate,
    summaryModel: row.summary_model,
    summaryPromptVersion: row.summary_prompt_version,
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

  async createTeam(input) {
    const result = await pool.query<{ id: string }>(
      `
        insert into teams (name, created_by_user_id, invite_code)
        values ($1, $2, $3)
        returning id
      `,
      [input.name, input.createdByUserId, input.inviteCode ?? null]
    );

    await pool.query(
      `
        insert into team_members (team_id, user_id, role)
        values ($1, $2, 'owner')
        on conflict (team_id, user_id) do update
        set role = excluded.role,
            removed_at = null
      `,
      [result.rows[0]!.id, input.createdByUserId]
    );

    return { id: result.rows[0]!.id };
  },

  async addTeamMember(teamId, userId, role = "member") {
    await pool.query(
      `
        insert into team_members (team_id, user_id, role)
        values ($1, $2, $3)
        on conflict (team_id, user_id) do update
        set role = excluded.role,
            removed_at = null
      `,
      [teamId, userId, role]
    );
  },

  async joinTeamByInviteCode(userId, inviteCode) {
    const teamResult = await pool.query<{
      id: string;
      name: string;
      invite_code: string | null;
    }>(
      `
        select id, name, invite_code
        from teams
        where invite_code = $1 and archived_at is null
        limit 1
      `,
      [inviteCode]
    );

    const team = teamResult.rows[0];
    if (!team) {
      throw new Error("Invalid invite code");
    }

    await pool.query(
      `
        insert into team_members (team_id, user_id, role)
        values ($1, $2, 'member')
        on conflict (team_id, user_id) do update
        set role = excluded.role,
            removed_at = null
      `,
      [team.id, userId]
    );
    return mapTeam({ ...team, role: "member" });
  },

  async getCurrentTeam(userId) {
    const result = await pool.query<{
      id: string;
      name: string;
      invite_code: string | null;
      role: "owner" | "admin" | "member";
    }>(
      `
        select t.id, t.name, t.invite_code, tm.role
        from team_members tm
        join teams t on t.id = tm.team_id
        where tm.user_id = $1
          and tm.removed_at is null
          and t.archived_at is null
        order by tm.created_at desc
        limit 1
      `,
      [userId]
    );

    return result.rows[0] ? mapTeam(result.rows[0]) : null;
  },

  async listTeamMembers(userId, teamId) {
    await requireTeamMembership(pool, userId, teamId);
    const result = await pool.query<{
      user_id: string;
      email: string;
      display_name: string | null;
      role: "owner" | "admin" | "member";
      joined_at: Date;
    }>(
      `
        select u.id as user_id, u.email, u.display_name, tm.role, tm.created_at as joined_at
        from team_members tm
        join users u on u.id = tm.user_id
        where tm.team_id = $1
          and tm.removed_at is null
        order by tm.created_at asc
      `,
      [teamId]
    );

    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.joined_at.toISOString()
    }));
  },

  async createApiToken(input) {
    if (input.teamId) {
      await requireTeamMembership(pool, input.ownerUserId, input.teamId);
    }

    const result = await pool.query<{
      id: string;
      owner_user_id: string;
      team_id: string | null;
      name: string;
      token_prefix: string;
      scopes: string[];
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `
        insert into api_tokens (owner_user_id, team_id, name, token_hash, token_prefix, scopes, expires_at)
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id, owner_user_id, team_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
      `,
      [
        input.ownerUserId,
        input.teamId ?? null,
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
      team_id: string | null;
      name: string;
      token_prefix: string;
      scopes: string[];
      created_at: Date;
      last_used_at: Date | null;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `
        select id, owner_user_id, team_id, name, token_prefix, scopes, created_at, last_used_at, expires_at, revoked_at
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
    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      team_id: string | null;
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
          team_id,
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
          metadata
        )
        values ($1, null, $2, 'personal', $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (idempotency_key)
        where idempotency_key is not null
        do update set
          updated_at = now(),
          metadata = sessions.metadata || excluded.metadata
        returning id, owner_user_id, team_id, visibility, external_session_id, workspace_id, source_runtime, capture_method, model, cwd, metadata, created_at
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
        input.metadata ?? {}
      ]
    );

    return mapCapturedSession(result.rows[0]!);
  },

  async createMemoryQuestion(actor, input) {
    const result = await pool.query<
      Parameters<typeof mapMemoryQuestionDetail>[0]
    >(
      `
        insert into memory_questions (
          owner_user_id,
          team_id,
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
        values ($1, null, 'personal', $2, $3, $4, $5, $6, $7, $8, $9, $10)
        returning
          id, owner_user_id, team_id, visibility, retrieval_scope, search_domain,
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
          id, owner_user_id, team_id, visibility, retrieval_scope, search_domain,
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
          question.id, question.owner_user_id, question.team_id,
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
          id, owner_user_id, team_id, visibility, retrieval_scope, search_domain,
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
          id, owner_user_id, team_id, visibility, retrieval_scope, search_domain,
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
    if (input.visibility === "team") {
      if (!input.teamId) {
        throw new Error("Team visibility requires a teamId");
      }

      await requireTeamMembership(pool, actor.userId, input.teamId);
    }

    const ownerUserId = input.visibility === "personal" ? actor.userId : null;
    const teamId = input.visibility === "team" ? input.teamId! : null;

    const result = await pool.query<{
      id: string;
      owner_user_id: string | null;
      team_id: string | null;
      visibility: Visibility;
      title: string | null;
      summary_text: string;
    }>(
      `
        insert into memory_nodes (
          owner_user_id,
          team_id,
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
          $1, $2, $3, $4, 'leaf', 0, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
        )
        returning id, owner_user_id, team_id, visibility, title, summary_text
      `,
      [
        ownerUserId,
        teamId,
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
      team_id: string | null;
      visibility: Visibility;
      title: string | null;
      summary_text: string;
    }>(
      `
        select mn.id, mn.owner_user_id, mn.team_id, mn.visibility, mn.title, mn.summary_text
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
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
      team_id: string | null;
      visibility: Visibility;
      title: string | null;
      summary_text: string;
    }>(
      `
        select mn.id, mn.owner_user_id, mn.team_id, mn.visibility, mn.title, mn.summary_text
        from memory_nodes mn
        where mn.invalidated_at is null
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
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
          coalesce(ev.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) as project_id,
          coalesce(ev.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
          coalesce(ev.payload #>> '{metadata,projectPath}', s.cwd, ev.payload ->> 'workspaceId') as project_path,
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
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
          and ($2::visibility_scope is null or mn.visibility = $2::visibility_scope)
          and ($3::text is null or coalesce(ev.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) = $3)
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
    if (existing.visibility === "team" && existing.teamId) {
      await requireTeamMemoryWritePermission(
        pool,
        actor.userId,
        existing.teamId
      );
    }
    if (input.visibility === "team" && existing.visibility !== "team") {
      const currentTeam = await this.getCurrentTeam(actor.userId);
      if (!currentTeam) {
        throw new Error("Team visibility requires a teamId");
      }
      await requireTeamMembership(pool, actor.userId, currentTeam.id);
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
            when $5::visibility_scope = 'team' then null
            when $5::visibility_scope = 'personal' then $1
            else mn.owner_user_id
          end,
          team_id = case
            when $5::visibility_scope = 'team' then $6::uuid
            when $5::visibility_scope = 'personal' then null
            else mn.team_id
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
        input.visibility ?? null,
        input.visibility === "team"
          ? ((await this.getCurrentTeam(actor.userId))?.id ?? null)
          : null
      ]
    );
    return result.rows[0] ? mapMemoryBrowserItem(result.rows[0]) : null;
  },

  async deleteMemory(actor, nodeId) {
    const existing = await this.getVisibleMemoryNode(actor, nodeId);
    if (!existing) {
      return false;
    }
    if (existing.visibility === "team" && existing.teamId) {
      await requireTeamMemoryWritePermission(
        pool,
        actor.userId,
        existing.teamId
      );
    }
    const result = await pool.query(
      `
        update memory_nodes mn
        set invalidated_at = now(), invalidation_reason = 'user_deleted'
        where mn.id = $2
          and mn.invalidated_at is null
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
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
            where (
              (mn.visibility = 'personal' and mn.owner_user_id = $1)
              or (
                mn.visibility = 'team'
                and exists (
                  select 1 from team_members tm
                  where tm.team_id = mn.team_id
                    and tm.user_id = $1
                    and tm.removed_at is null
                )
              )
            )
          ),
          visible_events as (
            select *
            from memory_events me
            where (
              (me.visibility = 'personal' and me.owner_user_id = $1)
              or (
                me.visibility = 'team'
                and exists (
                  select 1 from team_members tm
                  where tm.team_id = me.team_id
                    and tm.user_id = $1
                    and tm.removed_at is null
                )
              )
            )
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
                    (mn.visibility = 'personal' and mn.owner_user_id = $1)
                    or exists (
                      select 1 from team_members tm
                      where tm.team_id = mn.team_id
                        and tm.user_id = $1
                        and tm.removed_at is null
                    )
                  )
              )
              or exists (
                select 1 from memory_events ev
                where ev.id = me.memory_event_id
                  and (
                    (ev.visibility = 'personal' and ev.owner_user_id = $1)
                    or exists (
                      select 1 from team_members tm
                      where tm.team_id = ev.team_id
                        and tm.user_id = $1
                        and tm.removed_at is null
                    )
                  )
              )
              or exists (
                select 1 from messages msg
                where msg.id = me.message_id
                  and (
                    (msg.visibility = 'personal' and msg.owner_user_id = $1)
                    or exists (
                      select 1 from team_members tm
                      where tm.team_id = msg.team_id
                        and tm.user_id = $1
                        and tm.removed_at is null
                    )
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
          mn.id, mn.owner_user_id, mn.team_id, mn.visibility, mn.kind, mn.depth,
          mn.summary_text, mn.created_at, mn.updated_at, mn.invalidated_at,
          mn.invalidation_reason, mn.source_event_count, mn.source_token_estimate,
          mn.summary_token_estimate, mn.summary_model, mn.summary_prompt_version,
          mn.lcm_algorithm_version, mn.summary_corrected_at,
          mn.summary_corrected_by_user_id,
          coalesce(ev.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) as project_id,
          coalesce(ev.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
          coalesce(ev.payload #>> '{metadata,projectPath}', s.cwd, ev.payload ->> 'workspaceId') as project_path,
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
          and ($4::text is null or coalesce(ev.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) = $4)
          and ($5::text is null or coalesce(ev.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) = $5)
          and ($6::text is null or mn.summary_text ilike '%' || $6 || '%' or mn.id::text = $6)
          and ($7::uuid[] is null or mn.id = any($7::uuid[]))
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or (
              mn.visibility = 'team'
              and exists (
                select 1 from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
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
    if (existing.visibility === "team" && existing.teamId) {
      await requireTeamMemoryWritePermission(
        pool,
        actor.userId,
        existing.teamId
      );
    }
    if (input.visibility === "team" && existing.visibility !== "team") {
      const currentTeam = await this.getCurrentTeam(actor.userId);
      if (!currentTeam) {
        throw new Error("Team visibility requires a teamId");
      }
      await requireTeamMembership(pool, actor.userId, currentTeam.id);
    }
    const teamId =
      input.visibility === "team"
        ? ((await this.getCurrentTeam(actor.userId))?.id ?? null)
        : null;
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
            when $4::visibility_scope = 'team' then null
            when $4::visibility_scope = 'personal' then $1
            else owner_user_id
          end,
          team_id = case
            when $4::visibility_scope = 'team' then $5::uuid
            when $4::visibility_scope = 'personal' then null
            else team_id
          end,
          updated_at = now()
        where id = $2 and invalidated_at is null
      `,
      [
        actor.userId,
        nodeId,
        input.summaryText ?? null,
        input.visibility ?? null,
        teamId
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
          coalesce(me.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) as workspace_id,
          coalesce(me.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) as project_id,
          coalesce(me.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd) as project_name,
          coalesce(me.payload #>> '{metadata,projectPath}', s.cwd, me.payload ->> 'workspaceId') as project_path,
          s.id::text as session_id,
          coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) as thread_id,
          coalesce(me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text) as thread_name,
          me.captured_at,
          me.visibility,
          me.team_id,
          me.invalidated_at,
          me.invalidation_reason,
          me.payload ->> 'content' as content,
          coalesce(me.payload -> 'metadata', '{}'::jsonb) as metadata,
          coalesce(array_agg(mns.memory_node_id::text order by mns.source_order) filter (where mns.memory_node_id is not null), array[]::text[]) as linked_node_ids
        from memory_events me
        left join sessions s on s.id = me.session_id
        left join memory_node_sources mns on mns.memory_event_id = me.id
	        where ($2::boolean = true or me.invalidated_at is null)
	          and ($3::visibility_scope is null or me.visibility = $3::visibility_scope)
	          and ($4::text is null or coalesce(me.payload ->> 'workspaceId', s.workspace_id::text, s.cwd) = $4)
	          and ($5::text is null or coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text) = $5)
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
          and (
            (me.visibility = 'personal' and me.owner_user_id = $1)
            or (
              me.visibility = 'team'
              and exists (
                select 1 from team_members tm
                where tm.team_id = me.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
	        group by me.id, s.id
	        order by me.captured_at desc, me.id desc
	        limit $10
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
            coalesce(me.payload ->> 'workspaceId', s.workspace_id::text, s.cwd, 'unknown-project') as project_id,
            coalesce(me.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd, 'Unknown project') as project_name,
            coalesce(me.payload #>> '{metadata,projectPath}', s.cwd, me.payload ->> 'workspaceId') as project_path,
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
            and ($4::text is null or coalesce(me.payload ->> 'workspaceId', s.workspace_id::text, s.cwd, 'unknown-project') = $4)
            and ($5::text is null or coalesce(me.payload #>> '{metadata,externalSessionId}', s.external_session_id, s.id::text, me.id::text) = $5)
            and (
              $6::text is null
              or me.payload ->> 'content' ilike '%' || $6 || '%'
              or me.id::text = $6
              or coalesce(me.payload #>> '{metadata,threadName}', s.external_session_id, s.id::text, 'Untitled conversation') ilike '%' || $6 || '%'
              or coalesce(me.payload #>> '{metadata,projectName}', s.workspace_id::text, s.cwd, 'Unknown project') ilike '%' || $6 || '%'
            )
            and (
              (me.visibility = 'personal' and me.owner_user_id = $1)
              or (
                me.visibility = 'team'
                and exists (
                  select 1 from team_members tm
                  where tm.team_id = me.team_id
                    and tm.user_id = $1
                    and tm.removed_at is null
                )
              )
            )
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
            and (
              (s.visibility = 'personal' and s.owner_user_id = $1)
              or (
                s.visibility = 'team'
                and exists (
                  select 1 from team_members tm
                  where tm.team_id = s.team_id
                    and tm.user_id = $1
                    and tm.removed_at is null
                )
              )
            )
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
    if (existing.visibility === "team" && existing.teamId) {
      await requireTeamMemoryWritePermission(
        pool,
        actor.userId,
        existing.teamId
      );
    }
    if (input.visibility === "team" && existing.visibility !== "team") {
      const currentTeam = await this.getCurrentTeam(actor.userId);
      if (!currentTeam) {
        throw new Error("Team visibility requires a teamId");
      }
      await requireTeamMembership(pool, actor.userId, currentTeam.id);
    }
    const teamId =
      input.visibility === "team"
        ? ((await this.getCurrentTeam(actor.userId))?.id ?? null)
        : null;
    await pool.query(
      `
        update memory_events
        set
          visibility = coalesce($3::visibility_scope, visibility),
          owner_user_id = case
            when $3::visibility_scope = 'team' then null
            when $3::visibility_scope = 'personal' then $1
            else owner_user_id
          end,
          team_id = case
            when $3::visibility_scope = 'team' then $4::uuid
            when $3::visibility_scope = 'personal' then null
            else team_id
          end,
          invalidated_at = case when $5::boolean = true then coalesce(invalidated_at, now()) else invalidated_at end,
          invalidation_reason = case when $5::boolean = true then coalesce(invalidation_reason, 'user_deleted') else invalidation_reason end,
          updated_at = now()
        where id = $2
      `,
      [
        actor.userId,
        eventId,
        input.visibility ?? null,
        teamId,
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
      team_id: string | null;
      visibility: Visibility;
      text: string;
    }>(
      `
        with sources as (
          select
            'memory_node'::text as source_type,
            mn.id as source_id,
            mn.owner_user_id,
            mn.team_id,
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
            me.team_id,
            me.visibility,
            coalesce(me.payload ->> 'content', '') as text,
            me.created_at
          from memory_events me
          where me.invalidated_at is null

          union all

          select
            'message'::text as source_type,
            m.id as source_id,
            m.owner_user_id,
            m.team_id,
            m.visibility,
            m.content as text,
            m.created_at
          from messages m
          where m.invalidated_at is null
        )
        select source_type, source_id, owner_user_id, team_id, visibility, text
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
                or (s.source_type = 'message' and me.message_id = s.source_id)
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
      teamId: row.team_id,
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
      team_id: string | null;
      visibility: Visibility;
      text: string;
    }>(
      `
        with sources as (
          select
            'memory_node'::text as source_type,
            mn.id as source_id,
            mn.owner_user_id,
            mn.team_id,
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
            me.team_id,
            me.visibility,
            coalesce(me.payload ->> 'content', '') as text
          from memory_events me
          where me.invalidated_at is null

          union all

          select
            'message'::text as source_type,
            m.id as source_id,
            m.owner_user_id,
            m.team_id,
            m.visibility,
            m.content as text
          from messages m
          where m.invalidated_at is null
        )
        select source_type, source_id, owner_user_id, team_id, visibility, text
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
          teamId: row.team_id,
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
          team_id,
          visibility,
          kind,
          depth,
          summary_text,
          source_items_json,
          source_token_estimate,
          summary_token_estimate,
          summary_model,
          summary_prompt_version,
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
          mn.team_id,
          mn.visibility,
          mn.kind,
          mn.depth,
          mn.summary_text,
          mn.source_items_json,
          mn.source_token_estimate,
          mn.summary_token_estimate,
          mn.summary_model,
          mn.summary_prompt_version,
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
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
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
          mn.team_id,
          mn.visibility,
          mn.kind,
          mn.depth,
          mn.summary_text,
          mn.source_items_json,
          mn.source_token_estimate,
          mn.summary_token_estimate,
          mn.summary_model,
          mn.summary_prompt_version,
          mn.lcm_algorithm_version
        from memory_nodes mn
        where mn.id = $2
          and mn.invalidated_at is null
          and mn.kind in ('leaf', 'rollup')
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
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
            updated_at = now()
          where id = $1
        `,
        [
          input.nodeId,
          input.summaryText,
          input.summaryModel,
          input.summaryPromptVersion,
          input.summaryTokenEstimate
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
            team_id,
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
            $11,
            $12
          )
          on conflict do nothing
          returning id, true as inserted
        `,
        [
          input.source.sourceType,
          input.source.sourceId,
          input.source.ownerUserId,
          input.source.teamId,
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
    if (input.visibility === "team") {
      if (!input.teamId) {
        throw new Error("Team visibility requires a teamId");
      }
      await requireTeamMembership(pool, actor.userId, input.teamId);
    }
    if (input.sessionId) {
      const visibleSession = await pool.query<{ id: string }>(
        `
          select s.id
          from sessions s
          where s.id = $2
            and s.invalidated_at is null
            and (
              (s.visibility = 'personal' and s.owner_user_id = $1)
              or
              (
                s.visibility = 'team'
                and exists (
                  select 1
                  from team_members tm
                  where tm.team_id = s.team_id
                    and tm.user_id = $1
                    and tm.removed_at is null
                )
              )
            )
          limit 1
        `,
        [actor.userId, input.sessionId]
      );
      if (visibleSession.rowCount === 0) {
        throw new Error("Session not found or not visible");
      }
    }

    const ownerUserId = input.visibility === "personal" ? actor.userId : null;
    const teamId = input.visibility === "team" ? input.teamId! : null;
    const payload = {
      actor: input.actor,
      content: input.content,
      metadata: input.metadata ?? {},
      rawEventType: input.rawEventType,
      workspaceId: input.workspaceId
    };

    type MemoryEventRow = {
      id: string;
      owner_user_id: string | null;
      team_id: string | null;
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
          team_id,
          visibility,
          event_type,
          source_runtime,
          capture_method,
          codex_transcript_path,
          session_id,
          turn_id,
          idempotency_key,
          source_hash,
          payload
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        on conflict do nothing
        returning id, owner_user_id, team_id, visibility, event_type, session_id, turn_id, payload, created_at
      `,
      [
        actor.userId,
        ownerUserId,
        teamId,
        input.visibility,
        input.eventType,
        input.sourceRuntime ?? null,
        input.captureMethod ?? "mcp",
        input.codexTranscriptPath ?? null,
        input.sessionId ?? null,
        input.turnId ?? null,
        input.idempotencyKey ?? null,
        input.sourceHash ?? null,
        payload
      ]
    );

    const insertedRow = result.rows[0];
    if (insertedRow) {
      return mapMemoryEvent(insertedRow);
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const duplicate = await pool.query<MemoryEventRow>(
        `
          select me.id, me.owner_user_id, me.team_id, me.visibility, me.event_type, me.session_id, me.turn_id, me.payload, me.created_at
          from memory_events me
          where (
              ($2::text is not null and me.idempotency_key = $2)
              or ($3::text is not null and me.source_hash = $3)
            )
            and (
              (me.visibility = 'personal' and me.owner_user_id = $1)
              or (
                me.visibility = 'team'
                and exists (
                  select 1
                  from team_members tm
                  where tm.team_id = me.team_id
                    and tm.user_id = $1
                    and tm.removed_at is null
                )
              )
            )
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
    const visibility = input.scope === "personal_and_team" ? null : input.scope;
    const searchDomain = input.searchDomain ?? "global";
    if (searchDomain === "session" && !input.sessionId) {
      throw new Error("Session-scoped memory search requires sessionId");
    }
    if (searchDomain === "project" && !input.workspaceId) {
      throw new Error("Project-scoped memory search requires workspaceId");
    }
    const requestedLimit = input.limit ?? 10;
    const shouldRerank = rerankingEnabled();
    let embeddingMetadata = defaultRetrievalMetadata({
      rerankingEnabled: shouldRerank
    });
    let vectorRows: Array<{
      id: string;
      source_type: "memory_node" | "memory_event" | "message";
      source_id: string;
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
    }> = [];

    try {
      const embedded = await embedTexts([input.query]);
      if (embedded.vectors[0]) {
        const embeddingTable = embeddingTableForDimensions(embedded.dimensions);
        const vectorResult = await pool.query<(typeof vectorRows)[number]>(
          `
            select
              coalesce(mns.memory_node_id, me.memory_node_id, me.memory_event_id, me.message_id) as id,
              case
                when me.memory_node_id is not null then 'memory_node'
                when me.memory_event_id is not null then 'memory_event'
                else 'message'
              end as source_type,
              coalesce(me.memory_node_id, me.memory_event_id, me.message_id) as source_id,
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
              coalesce(mn.created_at, ev.created_at, msg.created_at, me.created_at) as created_at,
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
              and (
                (me.visibility = 'personal' and me.owner_user_id = $1)
                or
                (
                  me.visibility = 'team'
                  and exists (
                    select 1
                    from team_members tm
                    where tm.team_id = me.team_id
                      and tm.user_id = $1
                      and tm.removed_at is null
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
                      join memory_events filter_ev on filter_ev.id = filter_mns.memory_event_id
                      where filter_mns.memory_node_id = me.memory_node_id
                        and filter_ev.invalidated_at is null
                        and filter_ev.session_id = $9::uuid
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
                      join memory_events filter_ev on filter_ev.id = filter_mns.memory_event_id
                      where filter_mns.memory_node_id = me.memory_node_id
                        and filter_ev.invalidated_at is null
                        and filter_ev.payload ->> 'workspaceId' = $10
                    )
                  )
                )
              )
            order by v.embedding <=> $3::vector, created_at desc
            limit $4
          `,
          [
            actor.userId,
            visibility,
            vectorLiteral(embedded.vectors[0]),
            shouldRerank
              ? vectorCandidateLimit(requestedLimit)
              : Math.max(requestedLimit, 20),
            embedded.model,
            embedded.dimensions,
            localEmbeddingVersion(),
            searchDomain,
            input.sessionId ?? null,
            input.workspaceId ?? null
          ]
        );
        vectorRows = vectorResult.rows;
        embeddingMetadata = defaultRetrievalMetadata({
          retrievalMode: "semantic_vector",
          vectorHitsCount: vectorRows.length,
          vectorCandidateCount: vectorRows.length,
          embeddingModel: embedded.model,
          embeddingDimensions: embedded.dimensions,
          rerankingEnabled: shouldRerank
        });
        if (shouldRerank && vectorRows.length > 0) {
          const rerankableRows = vectorRows.filter((row) =>
            row.rerank_text?.trim()
          );
          if (rerankableRows.length === 0) {
            embeddingMetadata = defaultRetrievalMetadata({
              retrievalMode: "semantic_vector",
              vectorHitsCount: vectorRows.length,
              vectorCandidateCount: vectorRows.length,
              embeddingModel: embedded.model,
              embeddingDimensions: embedded.dimensions,
              rerankingEnabled: true,
              rerankingUnavailable: true,
              rerankingError:
                "no completed summary nodes available for reranking"
            });
          } else {
            try {
              const reranked = await rerankTexts(
                input.query,
                rerankableRows.map((row) =>
                  prepareRerankDocument(row.rerank_text!)
                )
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
              const nonRerankableRows = vectorRows.filter(
                (row) =>
                  !rerankableKeys.has(
                    `${row.source_type}:${row.source_id}:${
                      row.source_chunk_index ?? 0
                    }`
                  )
              );
              vectorRows = [...rerankedRows, ...nonRerankableRows].sort(
                (left, right) =>
                  Number(right.score) - Number(left.score) ||
                  right.created_at.getTime() - left.created_at.getTime() ||
                  left.source_id.localeCompare(right.source_id)
              );
              embeddingMetadata = defaultRetrievalMetadata({
                retrievalMode: "semantic_vector_reranked",
                vectorHitsCount: vectorRows.length,
                vectorCandidateCount: vectorRows.length,
                rerankedCount: reranked.scores.length,
                rerankerModel: reranked.model,
                embeddingModel: embedded.model,
                embeddingDimensions: embedded.dimensions,
                rerankingEnabled: true
              });
            } catch (error) {
              embeddingMetadata = defaultRetrievalMetadata({
                retrievalMode: "semantic_vector",
                vectorHitsCount: vectorRows.length,
                vectorCandidateCount: vectorRows.length,
                embeddingModel: embedded.model,
                embeddingDimensions: embedded.dimensions,
                rerankingEnabled: true,
                rerankingUnavailable: true,
                rerankingError:
                  error instanceof Error ? error.message : String(error)
              });
              console.warn(
                `Local reranking failed; using vector order: ${
                  error instanceof Error ? error.message : String(error)
                }`
              );
            }
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

    const merged = new Map<string, MemorySearchResult & { createdAt: Date }>();
    const addRow = (
      row: {
        id: string;
        source_type: "memory_node" | "memory_event" | "message";
        source_id: string;
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
      const existing = merged.get(key);
      if (!existing || score > existing.score) {
        merged.set(key, {
          nodeId: row.id,
          sourceType: row.source_type,
          sourceId: row.source_id,
          sourceChunkIndex: row.source_chunk_index ?? undefined,
          sourceChunkCount: row.source_chunk_count ?? undefined,
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
            visibility: row.visibility
          },
          createdAt: row.created_at
        });
      }
    };

    for (const row of vectorRows) {
      addRow(row, 1);
    }

    const results = [...merged.values()]
      .sort(
        (left, right) =>
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
        visibility: result.visibility,
        summaryText: result.summaryText,
        lcmNodeSummaryStatus: result.lcmNodeSummaryStatus,
        lcmNodeSummaryModel: result.lcmNodeSummaryModel,
        score: result.score,
        citation: result.citation
      }));

    return { results, metadata: embeddingMetadata };
  },

  async createLcmNodes(actor, input) {
    if (input.visibility === "team") {
      if (!input.teamId) {
        throw new Error("Team visibility requires a teamId");
      }
      await requireTeamMembership(pool, actor.userId, input.teamId);
    }

    const ownerUserId = input.visibility === "personal" ? actor.userId : null;
    const teamId = input.visibility === "team" ? input.teamId! : null;
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
        created_at: Date;
      }>(
        `
          select
            me.id,
            me.visibility,
            me.payload ->> 'actor' as actor,
            me.session_id,
            me.turn_id,
            me.payload,
            me.created_at
          from memory_events me
          where me.invalidated_at is null
            and me.visibility = $1
            and (
              ($1 = 'personal' and me.owner_user_id = $2)
              or
              ($1 = 'team' and me.team_id = $3)
            )
            and not exists (
              select 1
              from memory_node_sources mns
              join memory_nodes mn on mn.id = mns.memory_node_id
              where mns.memory_event_id = me.id
                and mn.kind = 'leaf'
                and mn.invalidated_at is null
            )
          order by me.created_at asc, me.id asc
        `,
        [input.visibility, ownerUserId, teamId]
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
          createdAt: event.created_at.toISOString(),
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
              team_id,
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
            values ($1, $2, $3, $4, 'leaf', 0, $5, $5, 'mcp', 'depth0-source-items-v1', $6::jsonb, $7, $8, $9, $10, $11, $12)
            on conflict (source_hash) where source_hash is not null do nothing
            returning id
          `,
          [
            ownerUserId,
            teamId,
            actor.userId,
            input.visibility,
            summaryText,
            JSON.stringify(sourceItems),
            span.length,
            tokenEstimate,
            estimateTokens(summaryText, { model: tokenModel }),
            span[0]!.created_at,
            span.at(-1)!.created_at,
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
            and (
              ($1 = 'personal' and mn.owner_user_id = $2)
              or
              ($1 = 'team' and mn.team_id = $3)
            )
          order by mn.created_at asc, mn.id asc
        `,
        [input.visibility, ownerUserId, teamId]
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
              team_id,
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
            values ($1, $2, $3, $4, 'rollup', 1, $5, $5, 'mcp', 'depth1-child-rollup-v1', $6::jsonb, $7, $8, $9, $10)
            on conflict (source_hash) where source_hash is not null do nothing
            returning id
          `,
          [
            ownerUserId,
            teamId,
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

  async expandMemoryNode(nodeId, actor) {
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
          and (
            (mn.visibility = 'personal' and mn.owner_user_id = $1)
            or
            (
              mn.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = mn.team_id
                  and tm.user_id = $1
                  and tm.removed_at is null
              )
            )
          )
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
      team_id: string | null;
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
    }>(
      `
        select me.id, me.owner_user_id, me.team_id, me.visibility, me.event_type, me.session_id, me.turn_id, me.payload, me.created_at
        from memory_node_sources mns
        join memory_events me on me.id = mns.memory_event_id
        where mns.memory_node_id = $1
          and me.invalidated_at is null
          and (
            (me.visibility = 'personal' and me.owner_user_id = $2)
            or
            (
              me.visibility = 'team'
              and exists (
                select 1
                from team_members tm
                where tm.team_id = me.team_id
                  and tm.user_id = $2
                  and tm.removed_at is null
              )
            )
          )
        order by me.created_at asc, me.id asc
      `,
      [nodeId, actor.userId]
    );
    const eventSourceItems: LcmSourceItem[] = sources.rows.map(
      (source, position) => ({
        kind: "memory_event",
        sourceTable: "memory_events",
        sourceId: source.id,
        visibility: source.visibility,
        actor: source.payload.actor,
        turnId: source.turn_id,
        createdAt: source.created_at.toISOString(),
        text: source.payload.content ?? "",
        payload: source.payload,
        position
      })
    );
    const nodeSourceItems = Array.isArray(node.source_items_json)
      ? node.source_items_json
      : [];

    return {
      nodeId,
      visibility: node.visibility,
      sourceItems:
        nodeSourceItems.length > 0 &&
        nodeSourceItems.some((item) => item.kind === "lcm_child")
          ? [...nodeSourceItems, ...eventSourceItems]
          : eventSourceItems.length > 0
            ? eventSourceItems
            : nodeSourceItems,
      sources: sources.rows.map(mapMemoryEvent)
    } satisfies ExpandedMemoryNode;
  }
});
