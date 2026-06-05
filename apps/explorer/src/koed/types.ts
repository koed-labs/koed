export type Visibility = "personal";
export type SummaryStatus = "pending" | "summarized";
export type RetrievalScope = "personal";
export type SearchDomain = "session" | "project" | "global";
export type SidebarMode = "chats" | "questions";
export type MemoryQuestionStatus = "pending" | "answered" | "error";
export type ThemePreference = "system" | "light" | "dark";
export type AiClient = "codex";

export const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" }
];

export const aiClientOptions: Array<{ value: AiClient; label: string }> = [
  { value: "codex", label: "Codex" }
];

export type LocalMemoryAgentProvider = "codex";
export type LocalMemoryAgentReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";
export type LocalMemoryAgentFlowKey = "mcp_memory_answer" | "lcm_summary";

export interface LocalMemoryAgentFlowSettings {
  provider: LocalMemoryAgentProvider;
  model: string;
  reasoningEffort: LocalMemoryAgentReasoningEffort | string;
  timeoutMs: number;
  maxAttempts: number;
  source?: "db" | "env";
  planningMode?: "planned" | "single_pass";
  maxSearches?: number;
  maxExpansions?: number;
  retryDelayMs?: number;
  concurrency?: number;
  maxPromptTokens?: number;
  appServerBinary: string;
}

export interface LocalMemoryAgentModelOption {
  provider: LocalMemoryAgentProvider;
  id: string;
  model: string;
  label: string;
  description?: string | null;
  isDefault?: boolean;
  defaultReasoningEffort?: string | null;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description?: string;
  }>;
}

export interface ManualMemoryQuestionWorkerConfig {
  provider: LocalMemoryAgentProvider;
  model: string;
  reasoningEffort: LocalMemoryAgentReasoningEffort;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface LocalMemoryAgentSettings {
  aiClients: Array<{
    id: LocalMemoryAgentProvider;
    label: string;
    status: "ready" | "unavailable";
    error: string | null;
  }>;
  modelOptions: LocalMemoryAgentModelOption[];
  modelListError?: string | null;
  flows: {
    mcpMemoryAnswer: LocalMemoryAgentFlowSettings;
    manualMemoryAnswer: LocalMemoryAgentFlowSettings;
    lcmSummary: LocalMemoryAgentFlowSettings;
  };
  precedence?: Record<string, string[]>;
}

export interface GraphOverview {
  capturedEvents: number;
  leafNodes: number;
  rollupNodes: number;
  pendingSummaries: number;
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

export interface GraphEvent {
  id: string;
  actor: string | null;
  eventType: string;
  sourceRuntime: string | null;
  captureMethod: string;
  model: string | null;
  workspaceId: string | null;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId?: string | null;
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
  content?: string;
  contentFull?: string;
  contentPreview: string;
  rawContent?: string;
  metadata: Record<string, unknown>;
  linkedNodeIds: string[];
}

export interface GraphNode {
  id: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  summaryStatus: SummaryStatus;
  visibility: Visibility;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId?: string | null;
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
}

export interface ProjectGroup {
  id: string;
  name: string;
  path: string | null;
  eventCount: number;
  threads: ThreadGroup[];
}

export interface ThreadGroup {
  id: string;
  name: string;
  sessionId?: string | null;
  projectId: string;
  projectName: string;
  projectPath?: string | null;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
}

export interface AppData {
  overview: GraphOverview | null;
  projects: ProjectGroup[];
  nodes: GraphNode[];
}

export interface GraphThreadIndexResponse {
  projects: ProjectGroup[];
}

export interface ToastState {
  tone: "default" | "destructive";
  message: string;
}

export interface MemoryEvidenceItem {
  nodeId?: string;
  sourceId?: string;
  sourceType?: string;
  visibility?: Visibility;
  summaryText?: string;
  lcmNodeSummaryStatus?: SummaryStatus;
}

export interface MemoryAnswerResponse {
  markdown: string;
  mode?: string;
  instructions?: string;
  evidence?: MemoryEvidenceItem[];
  evidenceBundle?: {
    query?: string;
    instructions?: string;
    evidence?: MemoryEvidenceItem[];
    retrieval?: {
      retrievalMode?: string;
      mode?: string;
      vectorHitsCount?: number;
      textHitsCount?: number;
      embeddingModel?: string | null;
    };
  };
  citations?: unknown[];
  retrieval?: {
    retrievalMode?: string;
    mode?: string;
    vectorHitsCount?: number;
    textHitsCount?: number;
    embeddingModel?: string | null;
  };
  localMemoryWorker?: {
    model?: string;
    planningMode?: string;
    memoryStatus?: string;
    searchCount?: number;
    expandCount?: number;
    usedFallback?: boolean;
    skippedReason?: string;
  };
}

export interface MemoryQuestionRecord {
  id: string;
  ownerUserId?: string;
  visibility?: Visibility;
  query: string;
  searchDomain: SearchDomain;
  retrievalScope: RetrievalScope;
  workspaceId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  threadName?: string | null;
  createdAt: string;
  updatedAt?: string;
  answeredAt?: string | null;
  answerPreview?: string | null;
  answerMarkdown?: string | null;
  evidenceCount?: number;
  status: MemoryQuestionStatus;
  response?: MemoryAnswerResponse;
  evidence?: MemoryEvidenceItem[] | null;
  citations?: unknown[] | null;
  retrieval?: MemoryAnswerResponse["retrieval"] | null;
  localMemoryWorker?: MemoryAnswerResponse["localMemoryWorker"] | null;
  localMemoryWorkerConfig?: Record<string, unknown> | null;
  error?: string;
  errorMessage?: string | null;
  lastErrorMessage?: string | null;
}

export interface MemoryQuestionSessionGroup {
  id: string;
  name: string;
  questions: MemoryQuestionRecord[];
}

export interface MemoryQuestionProjectGroup {
  id: string;
  name: string;
  projectQuestions: MemoryQuestionRecord[];
  sessions: MemoryQuestionSessionGroup[];
}

export interface GroupedMemoryQuestions {
  global: MemoryQuestionRecord[];
  projects: MemoryQuestionProjectGroup[];
}
