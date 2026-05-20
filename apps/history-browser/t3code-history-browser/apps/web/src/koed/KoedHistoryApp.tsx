import {
  BotIcon,
  CircleAlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  EyeIcon,
  FolderIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Button } from "../components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";

const apiBaseUrl = (
  import.meta.env.VITE_KOED_API_BASE_URL ??
  import.meta.env.VITE_API_BASE_URL ??
  "http://localhost:3000"
).replace(/\/$/, "");

const selectedThreadStorageKey = "koed_history_browser_thread_id";
const tokenStorageKey = "koed_history_browser_api_token";
const clientStorageKey = "koed_history_browser_ai_client";
const includeInvalidated = false;

type Visibility = "personal" | "team";
type SummaryStatus = "pending" | "summarized";
type RetrievalScope = "personal" | "personal+team";
type SearchDomain = "session" | "project" | "global";
type SidebarMode = "chats" | "questions";
type MemoryQuestionStatus = "pending" | "answered" | "error";
type ThemePreference = "system" | "light" | "dark";
type AiClient = "codex" | "claude" | "cursor";

const themeOptions: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const aiClientOptions: Array<{ value: AiClient; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "cursor", label: "Cursor" },
];

interface GraphOverview {
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

interface GraphEvent {
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
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  timestamp: string;
  visibility: Visibility;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  contentPreview: string;
  rawContent?: string;
  metadata: Record<string, unknown>;
  linkedNodeIds: string[];
}

interface GraphNode {
  id: string;
  kind: "leaf" | "rollup";
  depth: number;
  summaryText: string;
  summaryStatus: SummaryStatus;
  visibility: Visibility;
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
}

interface ProjectGroup {
  id: string;
  name: string;
  path: string | null;
  eventCount: number;
  threads: ThreadGroup[];
}

interface ThreadGroup {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
}

interface AppData {
  overview: GraphOverview | null;
  events: GraphEvent[];
  nodes: GraphNode[];
}

interface ToastState {
  tone: "default" | "destructive";
  message: string;
}

interface MemoryEvidenceItem {
  nodeId?: string;
  sourceId?: string;
  sourceType?: string;
  visibility?: Visibility;
  summaryText?: string;
  lcmNodeSummaryStatus?: SummaryStatus;
}

interface MemoryAnswerResponse {
  markdown: string;
  mode: string;
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
  };
}

interface MemoryQuestionRecord {
  id: string;
  query: string;
  searchDomain: SearchDomain;
  retrievalScope: RetrievalScope;
  workspaceId?: string;
  sessionId?: string;
  projectName?: string;
  sessionName?: string;
  createdAt: string;
  status: MemoryQuestionStatus;
  response?: MemoryAnswerResponse;
  error?: string;
}

function readConfiguredToken() {
  return (
    window.localStorage.getItem(tokenStorageKey) ??
    import.meta.env.VITE_KOED_API_TOKEN ??
    ""
  );
}

function readConfiguredClient(): AiClient {
  const value = window.localStorage.getItem(clientStorageKey);
  return value === "claude" || value === "cursor" || value === "codex" ? value : "codex";
}

function configSnippet(client: AiClient, apiToken: string) {
  const token = apiToken.trim() || "paste_token_here";
  const cliPath = "/absolute/path/to/koed-self-hosted/packages/mcp-server/dist/cli.js";
  const hookPath = "/absolute/path/to/koed-self-hosted/packages/mcp-server/dist/capture-hook.js";
  const clientName = aiClientOptions.find((option) => option.value === client)?.label ?? "AI client";

  return `# ${clientName}: add this Koed MCP + capture hook configuration.
[mcp_servers.koed]
command = "node"
args = ["${cliPath}"]
enabled = true

[mcp_servers.koed.env]
MEMORY_API_URL = "${apiBaseUrl}"
MEMORY_API_TOKEN = "${token}"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node ${hookPath}"
timeout = 10

[[hooks.PostToolUse]]
[[hooks.PostToolUse.hooks]]
type = "command"
command = "node ${hookPath}"
timeout = 10

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node ${hookPath}"
timeout = 30`;
}

function requestHeaders(apiToken: string) {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (apiToken.trim()) {
    headers.authorization = `Bearer ${apiToken.trim()}`;
  }
  return headers;
}

async function requestJson<T>(path: string, apiToken: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...requestHeaders(apiToken),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function projectKey(event: Pick<GraphEvent, "projectId" | "projectPath" | "workspaceId">) {
  return event.projectId ?? event.projectPath ?? event.workspaceId ?? "unknown-project";
}

function projectLabel(event: Pick<GraphEvent, "projectName" | "projectPath" | "workspaceId">) {
  return event.projectName ?? event.projectPath ?? event.workspaceId ?? "Unknown project";
}

function threadKey(event: Pick<GraphEvent, "threadId" | "sessionId" | "id">) {
  return event.threadId ?? event.sessionId ?? event.id;
}

function threadLabel(event: Pick<GraphEvent, "threadName" | "threadId" | "sessionId">) {
  return event.threadName ?? event.threadId ?? event.sessionId ?? "Untitled conversation";
}

function buildProjectGroups(events: GraphEvent[]): ProjectGroup[] {
  const projectMap = new Map<string, ProjectGroup>();
  const threadMap = new Map<string, ThreadGroup>();

  for (const event of events) {
    const pKey = projectKey(event);
    let project = projectMap.get(pKey);
    if (!project) {
      project = {
        id: pKey,
        name: projectLabel(event),
        path: event.projectPath,
        eventCount: 0,
        threads: [],
      };
      projectMap.set(pKey, project);
    }

    const tKey = threadKey(event);
    const compoundThreadKey = `${pKey}:${tKey}`;
    let thread = threadMap.get(compoundThreadKey);
    if (!thread) {
      thread = {
        id: tKey,
        name: threadLabel(event),
        projectId: pKey,
        projectName: project.name,
        eventCount: 0,
        invalidatedCount: 0,
        latestAt: event.timestamp,
        sample: event.contentPreview,
      };
      threadMap.set(compoundThreadKey, thread);
      project.threads.push(thread);
    }

    project.eventCount += 1;
    thread.eventCount += 1;
    if (event.invalidatedAt) {
      thread.invalidatedCount += 1;
    }
    if (event.timestamp > thread.latestAt) {
      thread.latestAt = event.timestamp;
      thread.sample = event.contentPreview;
    }
  }

  return [...projectMap.values()]
    .map((project) => ({
      ...project,
      threads: [...project.threads].sort((left, right) =>
        right.latestAt.localeCompare(left.latestAt),
      ),
    }))
    .sort((left, right) => {
      const leftLatest = left.threads[0]?.latestAt ?? "";
      const rightLatest = right.threads[0]?.latestAt ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function eventIcon(actor: string | null) {
  if (actor === "assistant") return BotIcon;
  if (actor === "tool") return WrenchIcon;
  return UserIcon;
}

function eventTone(actor: string | null) {
  if (actor === "assistant") return "border-border/70 bg-card/80";
  if (actor === "tool") return "border-dashed border-info/30 bg-info/4";
  if (actor === "system") return "border-dashed border-warning/40 bg-warning/4";
  return "border-primary/20 bg-primary/4";
}

function firstLine(value: string) {
  return value.trim().split(/\n+/)[0] ?? "";
}

function uniqueNodeIds(events: GraphEvent[]) {
  return [...new Set(events.flatMap((event) => event.linkedNodeIds))];
}

function nodeMap(nodes: GraphNode[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

function memoryQuestionId() {
  return typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `question-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function memoryEvidence(response?: MemoryAnswerResponse): MemoryEvidenceItem[] {
  return response?.evidenceBundle?.evidence ?? response?.evidence ?? [];
}

function memoryRetrieval(response?: MemoryAnswerResponse) {
  return response?.evidenceBundle?.retrieval ?? response?.retrieval;
}

function memoryScopeLabel(question: Pick<MemoryQuestionRecord, "searchDomain" | "projectName" | "sessionName">) {
  if (question.searchDomain === "session") {
    return question.sessionName ?? "Selected session";
  }
  if (question.searchDomain === "project") {
    return question.projectName ?? "Selected project";
  }
  return "Global memory";
}

function memoryQuestionPreview(question: MemoryQuestionRecord) {
  if (question.status === "pending") {
    return "Waiting for local memory worker";
  }
  if (question.status === "error") {
    return question.error ?? "Memory answer failed";
  }
  return firstLine(question.response?.markdown ?? "");
}

export function KoedHistoryApp() {
  const { theme, setTheme } = useTheme();
  const [apiToken, setApiToken] = useState(readConfiguredToken);
  const [selectedClient, setSelectedClient] = useState<AiClient>(readConfiguredClient);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<AppData>({ overview: null, events: [], nodes: [] });
  const [selectedThreadId, setSelectedThreadId] = useState(
    () => window.localStorage.getItem(selectedThreadStorageKey) ?? "",
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [threadEvents, setThreadEvents] = useState<GraphEvent[]>([]);
  const [rawOpen, setRawOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("chats");
  const [memoryQuestion, setMemoryQuestion] = useState("");
  const [memorySearchDomain, setMemorySearchDomain] = useState<SearchDomain>("project");
  const memoryRetrievalScope: RetrievalScope = "personal";
  const [memoryQuestions, setMemoryQuestions] = useState<MemoryQuestionRecord[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [askingMemory, setAskingMemory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const refreshInFlight = useRef(false);

  useEffect(() => {
    window.localStorage.setItem(tokenStorageKey, apiToken);
  }, [apiToken]);

  useEffect(() => {
    window.localStorage.setItem(clientStorageKey, selectedClient);
  }, [selectedClient]);

  const groups = useMemo(() => buildProjectGroups(data.events), [data.events]);
  const nodesById = useMemo(() => nodeMap(data.nodes), [data.nodes]);
  const selectedThread = useMemo(
    () => groups.flatMap((group) => group.threads).find((thread) => thread.id === selectedThreadId),
    [groups, selectedThreadId],
  );
  const selectedEvent = useMemo(
    () => threadEvents.find((event) => event.id === selectedEventId) ?? threadEvents[0] ?? null,
    [selectedEventId, threadEvents],
  );
  const linkedNodes = useMemo(
    () => uniqueNodeIds(threadEvents).flatMap((id) => nodesById.get(id) ?? []),
    [nodesById, threadEvents],
  );
  const selectedEventLinkedNodes = useMemo(
    () => (selectedEvent?.linkedNodeIds ?? []).flatMap((id) => nodesById.get(id) ?? []),
    [nodesById, selectedEvent],
  );
  const selectedQuestion = useMemo(
    () => memoryQuestions.find((question) => question.id === selectedQuestionId) ?? null,
    [memoryQuestions, selectedQuestionId],
  );
  const filteredMemoryQuestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? memoryQuestions.filter(
          (question) =>
            question.query.toLowerCase().includes(needle) ||
            memoryQuestionPreview(question).toLowerCase().includes(needle) ||
            memoryScopeLabel(question).toLowerCase().includes(needle),
        )
      : memoryQuestions;
    return {
      project: visible.filter((question) => question.searchDomain === "project"),
      session: visible.filter((question) => question.searchDomain === "session"),
      global: visible.filter((question) => question.searchDomain === "global"),
    } satisfies Record<SearchDomain, MemoryQuestionRecord[]>;
  }, [memoryQuestions, query]);

  const loadGraph = useCallback(async (options?: { silent?: boolean }) => {
    if (!apiToken.trim()) {
      setData({ overview: null, events: [], nodes: [] });
      setToast({
        tone: "destructive",
        message: "Add a Koed API token in settings to load memory history.",
      });
      return;
    }
    if (!options?.silent) {
      setLoading(true);
    }
    try {
      const [overviewResponse, eventsResponse, nodesResponse] = await Promise.all([
        requestJson<{ overview: GraphOverview }>("/v1/memory/graph/overview", apiToken),
        requestJson<{ events: GraphEvent[] }>(
          `/v1/memory/graph/events?limit=500&includeInvalidated=${includeInvalidated}`,
          apiToken,
        ),
        requestJson<{ nodes: GraphNode[] }>(
          `/v1/memory/graph/nodes?limit=500&includeInvalidated=${includeInvalidated}`,
          apiToken,
        ),
      ]);
      setData({
        overview: overviewResponse.overview,
        events: eventsResponse.events,
        nodes: nodesResponse.nodes,
      });
      setToast(null);
    } catch (error) {
      setToast({
        tone: "destructive",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [apiToken]);

  const loadThread = useCallback(
    async (threadId: string, options?: { silent?: boolean }) => {
      if (!threadId || !apiToken.trim()) {
        setThreadEvents([]);
        return;
      }
      if (!options?.silent) {
        setThreadLoading(true);
      }
      try {
        const eventsResponse = await requestJson<{ events: GraphEvent[] }>(
          `/v1/memory/graph/events?threadId=${encodeURIComponent(threadId)}&limit=250&includeInvalidated=${includeInvalidated}`,
          apiToken,
        );
        const sorted = [...eventsResponse.events].sort((left, right) =>
          left.timestamp.localeCompare(right.timestamp),
        );
        const detailed = await Promise.all(
          sorted.map(async (event) => {
            try {
              const detail = await requestJson<{ event: GraphEvent }>(
                `/v1/memory/graph/events/${event.id}?includeRaw=true&includeInvalidated=${includeInvalidated}`,
                apiToken,
              );
              return detail.event;
            } catch {
              return event;
            }
          }),
        );
        setThreadEvents(detailed);
        setSelectedEventId((current) =>
          current && detailed.some((event) => event.id === current)
            ? current
            : (detailed[0]?.id ?? null),
        );
      } catch (error) {
        setToast({
          tone: "destructive",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!options?.silent) {
          setThreadLoading(false);
        }
      }
    },
    [apiToken],
  );

  const refreshVisibleData = useCallback(
    async (options?: { silent?: boolean }) => {
      if (refreshInFlight.current) {
        return;
      }
      refreshInFlight.current = true;
      try {
        await loadGraph(options);
        if (selectedThreadId) {
          await loadThread(selectedThreadId, options);
        }
      } finally {
        refreshInFlight.current = false;
      }
    },
    [loadGraph, loadThread, selectedThreadId],
  );

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    if (!selectedThreadId && groups[0]?.threads[0]) {
      setSelectedThreadId(groups[0].threads[0].id);
    }
  }, [groups, selectedThreadId]);

  useEffect(() => {
    if (
      sidebarMode === "questions" &&
      memoryQuestions.length > 0 &&
      (!selectedQuestionId || !memoryQuestions.some((question) => question.id === selectedQuestionId))
    ) {
      setSelectedQuestionId(memoryQuestions[0]?.id ?? null);
    }
  }, [memoryQuestions, selectedQuestionId, sidebarMode]);

  useEffect(() => {
    window.localStorage.setItem(selectedThreadStorageKey, selectedThreadId);
    void loadThread(selectedThreadId);
  }, [loadThread, selectedThreadId]);

  useEffect(() => {
    if (!apiToken.trim()) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    let retryTimeout: number | null = null;

    const connect = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/memory/graph/stream`, {
          headers: requestHeaders(apiToken),
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          setToast({
            tone: "destructive",
            message: "Koed API token is missing or invalid. Update it in settings.",
          });
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Graph stream failed with ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const eventName =
              frame
                .split("\n")
                .find((line) => line.startsWith("event:"))
                ?.slice("event:".length)
                .trim() ?? "message";
            if (eventName === "graph_update" && document.visibilityState === "visible") {
              void refreshVisibleData({ silent: true });
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setToast({
          tone: "destructive",
          message: error instanceof Error ? error.message : String(error),
        });
        retryTimeout = window.setTimeout(connect, 1500);
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshVisibleData({ silent: true });
      }
    };

    void connect();
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout);
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [apiToken, refreshVisibleData]);

  const filteredGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return groups;
    }
    return groups
      .map((group) => ({
        ...group,
        threads: group.threads.filter(
          (thread) =>
            thread.name.toLowerCase().includes(needle) ||
            thread.sample.toLowerCase().includes(needle) ||
            group.name.toLowerCase().includes(needle) ||
            (group.path ?? "").toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.threads.length > 0);
  }, [groups, query]);

  const askMemory = async () => {
    const trimmed = memoryQuestion.trim();
    if (!trimmed || askingMemory) {
      return;
    }

    const workspaceId = selectedThread?.projectId;
    const sessionId = selectedThread?.id;
    const questionId = memoryQuestionId();
    const questionRecord: MemoryQuestionRecord = {
      id: questionId,
      query: trimmed,
      retrievalScope: memoryRetrievalScope,
      searchDomain: memorySearchDomain,
      ...(memorySearchDomain === "project" && workspaceId ? { workspaceId } : {}),
      ...(memorySearchDomain === "session" && sessionId ? { sessionId } : {}),
      ...(selectedThread?.projectName ? { projectName: selectedThread.projectName } : {}),
      ...(selectedThread?.name ? { sessionName: selectedThread.name } : {}),
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const payload = {
      query: trimmed,
      retrieval_scope: memoryRetrievalScope,
      search_domain: memorySearchDomain,
      limit: 10,
    };
    const workerPayload = {
      ...payload,
      ...(memorySearchDomain === "project" && workspaceId ? { workspace_id: workspaceId } : {}),
      ...(memorySearchDomain === "session" && sessionId ? { session_id: sessionId } : {}),
    };

    setMemoryQuestions((current) => [questionRecord, ...current]);
    setSelectedQuestionId(questionId);
    setSidebarMode("questions");
    setMemoryQuestion("");
    setAskingMemory(true);
    try {
      if (!window.desktopBridge?.koedMemoryAnswer) {
        throw new Error(
          "Local Koed memory worker is not available. Run this browser through the Koed Electron app.",
        );
      }
      const response = (await window.desktopBridge.koedMemoryAnswer(
        workerPayload,
      )) as unknown as MemoryAnswerResponse;
      setMemoryQuestions((current) =>
        current.map((question) =>
          question.id === questionId
            ? {
                ...question,
                response,
                status: "answered",
              }
            : question,
        ),
      );
      setToast(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMemoryQuestions((current) =>
        current.map((question) =>
          question.id === questionId
            ? {
                ...question,
                error: message,
                status: "error",
              }
            : question,
        ),
      );
      setToast({
        tone: "destructive",
        message,
      });
    } finally {
      setAskingMemory(false);
    }
  };

  const toggleNode = (nodeId: string) => {
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border bg-card text-foreground"
        resizable={{
          minWidth: 13 * 16,
          storageKey: "koed_history_sidebar_width",
        }}
      >
        <SidebarHeader className="gap-2 border-border border-b px-3 py-3">
          <div
            className={cn(
              "drag-region -mx-3 -mt-3 flex h-[52px] items-center justify-between gap-2 border-border border-b px-3",
              isElectron && "pl-[90px] wco:h-[env(titlebar-area-height)] wco:pl-[calc(env(titlebar-area-x)+1em)]",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-primary">
                <DatabaseIcon className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-sm">Koed History</div>
                <div className="truncate text-muted-foreground text-xs">LCM graph browser</div>
              </div>
            </div>
            <Button size="icon-xs" variant="ghost" onClick={() => void loadGraph()}>
              <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>

          <div className="relative">
            <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
            <input
              className="h-8 w-full rounded-lg border border-input bg-background pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={sidebarMode === "chats" ? "Search projects and sessions" : "Search memory questions"}
            />
          </div>

          <div className="grid grid-cols-2 rounded-lg border border-border bg-background p-0.5">
            <button
              className={cn(
                "h-7 rounded-md px-2 text-xs transition-colors",
                sidebarMode === "chats"
                  ? "bg-secondary text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSidebarMode("chats")}
              type="button"
            >
              Chats
            </button>
            <button
              className={cn(
                "h-7 rounded-md px-2 text-xs transition-colors",
                sidebarMode === "questions"
                  ? "bg-secondary text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setSidebarMode("questions")}
              type="button"
            >
              Questions
            </button>
          </div>

        </SidebarHeader>

        <SidebarContent>
          {sidebarMode === "chats" ? (
            filteredGroups.map((group) => (
              <SidebarGroup key={group.id}>
                <SidebarGroupLabel className="gap-1.5">
                  <FolderIcon className="size-3.5" />
                  <span className="truncate">{group.name}</span>
                  <span className="ml-auto text-muted-foreground/70">{group.eventCount}</span>
                </SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.threads.map((thread) => (
                      <SidebarMenuItem key={`${group.id}:${thread.id}`}>
                        <SidebarMenuButton
                          className="h-auto items-start py-2"
                          isActive={thread.id === selectedThreadId}
                          onClick={() => setSelectedThreadId(thread.id)}
                        >
                          <GitBranchIcon className="mt-0.5 size-4" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm">{thread.name}</span>
                            <span className="block truncate text-muted-foreground text-xs">
                              {formatDate(thread.latestAt)} - {thread.eventCount} events
                            </span>
                            <span className="block truncate text-muted-foreground/75 text-xs">
                              {firstLine(thread.sample)}
                            </span>
                          </span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))
          ) : (
            <MemoryQuestionSidebar
              groupedQuestions={filteredMemoryQuestions}
              onSelectQuestion={setSelectedQuestionId}
              selectedQuestionId={selectedQuestionId}
            />
          )}
        </SidebarContent>
        <SidebarSeparator />
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
          <header
            className={cn(
              "border-border border-b",
              isElectron
                ? "drag-region flex h-[52px] items-center px-3 sm:px-5 wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
                : "px-3 py-2 sm:px-5 sm:py-3",
            )}
          >
            <div className="flex w-full min-w-0 items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <SidebarTrigger className="size-7 shrink-0 md:hidden" />
                <div className="min-w-0">
                  <h1 className="truncate font-medium text-foreground text-sm">
                    {sidebarMode === "questions"
                      ? selectedQuestion?.query ?? "Memory questions"
                      : selectedThread?.name ?? "No conversation selected"}
                  </h1>
                  <p className="truncate text-muted-foreground text-xs">
                    {sidebarMode === "questions"
                      ? selectedQuestion
                        ? `${memoryScopeLabel(selectedQuestion)} - ${selectedQuestion.retrievalScope}`
                        : "Ask Koed memory from the composer"
                      : selectedThread?.projectName ?? "Connect to Koed to browse captured sessions"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ThemeSelect
                  onChange={setTheme}
                  value={theme}
                />
                <Button
                  aria-label="Koed settings"
                  size="icon-xs"
                  variant={settingsOpen ? "secondary" : "ghost"}
                  onClick={() => setSettingsOpen((value) => !value)}
                >
                  <SettingsIcon className="size-3.5" />
                </Button>
                <Button size="xs" variant="outline" onClick={() => setInspectorOpen((value) => !value)}>
                  {inspectorOpen ? <PanelRightCloseIcon className="size-3.5" /> : <PanelRightOpenIcon className="size-3.5" />}
                  LCM
                </Button>
              </div>
            </div>
          </header>

          {toast ? (
            <div
              className={cn(
                "mx-3 mt-3 rounded-lg border px-3 py-2 text-sm sm:mx-5",
                toast.tone === "destructive"
                  ? "border-destructive/30 bg-destructive/8 text-destructive-foreground"
                  : "border-success/30 bg-success/8 text-success-foreground",
              )}
            >
              {toast.message}
            </div>
          ) : null}

          {settingsOpen ? (
            <SettingsPanel
              apiToken={apiToken}
              selectedClient={selectedClient}
              setApiToken={setApiToken}
              setSelectedClient={setSelectedClient}
            />
          ) : null}

          <div className="flex min-h-0 min-w-0 flex-1">
            <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-auto px-3 py-4 pb-40 sm:px-5">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
                  {sidebarMode === "questions" ? (
                    selectedQuestion ? (
                      <MemoryQuestionDetail question={selectedQuestion} />
                    ) : (
                      <div className="rounded-lg border border-border/60 bg-card/40 px-8 py-12 text-center">
                        <SparklesIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                        <div className="font-medium">No memory questions yet</div>
                        <p className="mt-1 text-muted-foreground text-sm">
                          Ask from the composer below to inspect a scoped memory answer.
                        </p>
                      </div>
                    )
                  ) : (
                    <>
                      {loading || threadLoading ? (
                        <div className="rounded-lg border border-border bg-card/60 px-4 py-3 text-muted-foreground text-sm">
                          Loading Koed graph...
                        </div>
                      ) : null}
                      {!loading && !threadLoading && threadEvents.length === 0 ? (
                        <div className="rounded-lg border border-border/60 bg-card/40 px-8 py-12 text-center">
                          <DatabaseIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
                          <div className="font-medium">No captured events visible</div>
                          <p className="mt-1 text-muted-foreground text-sm">
                            Start the Koed API, then reload the graph.
                          </p>
                        </div>
                      ) : null}
                      {threadEvents.map((event) => (
                        <KoedMessage
                          event={event}
                          isSelected={event.id === selectedEvent?.id}
                          key={event.id}
                          onSelect={() => setSelectedEventId(event.id)}
                        />
                      ))}
                    </>
                  )}
                </div>
              </div>

              <MemoryComposer
                disabled={askingMemory}
                onAsk={() => void askMemory()}
                question={memoryQuestion}
                searchDomain={memorySearchDomain}
                selectedThread={selectedThread}
                setQuestion={setMemoryQuestion}
                setSearchDomain={setMemorySearchDomain}
              />
            </section>

            <aside
              className={cn(
                "hidden shrink-0 border-border border-l bg-card/35 lg:min-h-0 lg:flex-col",
                inspectorOpen ? "lg:flex lg:w-[28rem]" : "lg:hidden",
              )}
            >
              <div className="border-border border-b px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-sm">LCM inspector</div>
                    <div className="text-muted-foreground text-xs">Selected event, summaries, and source links</div>
                  </div>
                  <Button size="icon-xs" variant="ghost" onClick={() => setInspectorOpen(false)}>
                    <PanelRightCloseIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
                {selectedEvent ? (
                  <section className="rounded-lg border border-border bg-background/80 p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="font-medium text-sm">Event</div>
                      <span className="rounded-md border border-border bg-secondary px-1.5 py-0.5 text-muted-foreground text-xs">
                        {selectedEvent.visibility}
                      </span>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">ID</dt>
                      <dd className="truncate">{selectedEvent.id}</dd>
                      <dt className="text-muted-foreground">Runtime</dt>
                      <dd>{selectedEvent.sourceRuntime ?? "unknown"}</dd>
                      <dt className="text-muted-foreground">Model</dt>
                      <dd>{selectedEvent.model ?? "unknown"}</dd>
                      <dt className="text-muted-foreground">Capture</dt>
                      <dd>{selectedEvent.captureMethod}</dd>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="xs" variant="outline" onClick={() => setRawOpen((value) => !value)}>
                        <EyeIcon className="size-3.5" />
                        {rawOpen ? "Hide raw" : "Show raw"}
                      </Button>
                    </div>
                    {rawOpen ? (
                      <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-secondary/50 p-2 text-[11px] leading-relaxed">
                        {JSON.stringify(selectedEvent, null, 2)}
                      </pre>
                    ) : null}
                  </section>
                ) : null}

                <section className="rounded-lg border border-border bg-background/80 p-3">
                  <div className="mb-3 flex items-center gap-2 font-medium text-sm">
                    <ShieldCheckIcon className="size-4 text-primary" />
                    Linked LCM nodes
                  </div>
                  {selectedEventLinkedNodes.length > 0 ? (
                    <div className="mb-4 space-y-2">
                      <div className="text-muted-foreground text-xs">Selected event</div>
                      {selectedEventLinkedNodes.map((node) => (
                        <LcmNodeCard
                          expanded={expandedNodeIds.has(node.id)}
                          key={node.id}
                          node={node}
                          onToggle={() => toggleNode(node.id)}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    {linkedNodes.length === 0 ? (
                      <p className="text-muted-foreground text-sm">
                        No linked LCM nodes for the loaded conversation.
                      </p>
                    ) : (
                      <>
                        <div className="text-muted-foreground text-xs">Conversation</div>
                        {linkedNodes.map((node) => (
                          <LcmNodeCard
                            expanded={expandedNodeIds.has(node.id)}
                            key={node.id}
                            node={node}
                            onToggle={() => toggleNode(node.id)}
                          />
                        ))}
                      </>
                    )}
                  </div>
                </section>
              </div>
            </aside>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function KoedMessage({
  event,
  isSelected,
  onSelect,
}: {
  event: GraphEvent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const Icon = eventIcon(event.actor);
  const text = event.rawContent ?? event.contentPreview;

  return (
    <article
      className={cn(
        "group grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-card/50",
        isSelected && "ring-2 ring-ring/45",
        event.invalidatedAt && "opacity-60",
      )}
      onClick={onSelect}
    >
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border",
          eventTone(event.actor),
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">
            {event.actor ?? event.eventType}
          </span>
          <span>{formatDate(event.timestamp)}</span>
          <span>{event.visibility}</span>
          {event.linkedNodeIds.length > 0 ? <span>{event.linkedNodeIds.length} LCM links</span> : null}
        </div>
        <div className="chat-markdown text-sm leading-relaxed">
          <ChatMarkdown cwd={event.projectPath ?? undefined} text={text} />
        </div>
      </div>
    </article>
  );
}

function ThemeSelect({
  onChange,
  value,
}: {
  onChange: (value: ThemePreference) => void;
  value: ThemePreference;
}) {
  return (
    <Select
      onValueChange={(next) => {
        if (next === "system" || next === "light" || next === "dark") {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label="Theme preference" className="w-28" size="xs">
        <SelectValue>
          {themeOptions.find((option) => option.value === value)?.label ?? "System"}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {themeOptions.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SettingsPanel({
  apiToken,
  selectedClient,
  setApiToken,
  setSelectedClient,
}: {
  apiToken: string;
  selectedClient: AiClient;
  setApiToken: (value: string) => void;
  setSelectedClient: (value: AiClient) => void;
}) {
  return (
    <section className="border-border border-b bg-card/55 px-3 py-3 sm:px-5">
      <div className="mx-auto grid w-full max-w-5xl gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="rounded-lg border border-border bg-background/80 p-3">
          <div className="mb-3 flex items-center gap-2 font-medium text-sm">
            <SettingsIcon className="size-4 text-primary" />
            Koed client settings
          </div>
          <label className="block text-muted-foreground text-xs" htmlFor="koed-ai-client">
            AI client
          </label>
          <select
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="koed-ai-client"
            onChange={(event) => {
              const next = event.target.value;
              if (next === "codex" || next === "claude" || next === "cursor") {
                setSelectedClient(next);
              }
            }}
            value={selectedClient}
          >
            {aiClientOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label className="mt-3 block text-muted-foreground text-xs" htmlFor="koed-api-token">
            API token
          </label>
          <input
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            id="koed-api-token"
            onChange={(event) => setApiToken(event.target.value)}
            placeholder="cmt_..."
            type="password"
            value={apiToken}
          />
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background/80 p-3">
          <div className="mb-2 font-medium text-sm">config.toml snippet</div>
          <pre className="max-h-64 overflow-auto rounded-md bg-secondary/45 p-3 text-[11px] leading-relaxed">
            {configSnippet(selectedClient, apiToken)}
          </pre>
        </div>
      </div>
    </section>
  );
}

function MemoryComposer({
  disabled,
  onAsk,
  question,
  searchDomain,
  selectedThread,
  setQuestion,
  setSearchDomain,
}: {
  disabled: boolean;
  onAsk: () => void;
  question: string;
  searchDomain: SearchDomain;
  selectedThread: ThreadGroup | undefined;
  setQuestion: (value: string) => void;
  setSearchDomain: (value: SearchDomain) => void;
}) {
  const sessionDisabled = !selectedThread;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 border-border border-t bg-background/90 px-3 py-3 backdrop-blur sm:px-5">
      <div className="pointer-events-auto mx-auto w-full max-w-3xl">
        <div className="rounded-xl border border-border bg-card shadow-lg">
          <Textarea
            aria-label="Ask Koed memory"
            className="border-0 bg-transparent shadow-none before:hidden has-focus-visible:ring-0"
            disabled={disabled}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onAsk();
              }
            }}
            placeholder="Ask memory about the selected project..."
            size="sm"
            value={question}
          />
          <div className="flex flex-wrap items-center gap-2 border-border border-t px-2.5 py-2">
            <SparklesIcon className="size-3.5 text-primary" />
            <select
              className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
              onChange={(event) => setSearchDomain(event.target.value as SearchDomain)}
              value={searchDomain}
            >
              <option value="project">Project</option>
              <option disabled={sessionDisabled} value="session">Session</option>
              <option value="global">Global</option>
            </select>
            <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
              {searchDomain === "session"
                ? selectedThread?.name ?? "No session selected"
                : searchDomain === "project"
                  ? selectedThread?.projectName ?? "Selected project"
                  : "All visible memory"}
            </span>
            <Button
              disabled={disabled || !question.trim()}
              onClick={onAsk}
              size="icon-sm"
              variant="default"
            >
              {disabled ? <LoaderCircleIcon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MemoryQuestionSidebar({
  groupedQuestions,
  onSelectQuestion,
  selectedQuestionId,
}: {
  groupedQuestions: Record<SearchDomain, MemoryQuestionRecord[]>;
  onSelectQuestion: (questionId: string) => void;
  selectedQuestionId: string | null;
}) {
  const buckets: Array<{ domain: SearchDomain; label: string }> = [
    { domain: "project", label: "Project" },
    { domain: "session", label: "Session" },
    { domain: "global", label: "Global" },
  ];
  const total = buckets.reduce((count, bucket) => count + groupedQuestions[bucket.domain].length, 0);

  return (
    <>
      {total === 0 ? (
        <SidebarGroup>
          <SidebarGroupContent>
            <div className="px-3 py-8 text-center text-muted-foreground text-sm">
              No memory questions yet.
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : null}
      {buckets.map((bucket) => {
        const questions = groupedQuestions[bucket.domain];
        if (questions.length === 0) {
          return null;
        }
        return (
          <SidebarGroup key={bucket.domain}>
            <SidebarGroupLabel className="gap-1.5">
              <SparklesIcon className="size-3.5" />
              <span>{bucket.label}</span>
              <span className="ml-auto text-muted-foreground/70">{questions.length}</span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {questions.map((question) => (
                  <SidebarMenuItem key={question.id}>
                    <SidebarMenuButton
                      className="h-auto items-start py-2"
                      isActive={question.id === selectedQuestionId}
                      onClick={() => onSelectQuestion(question.id)}
                    >
                      <MemoryQuestionStatusIcon status={question.status} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{question.query}</span>
                        <span className="block truncate text-muted-foreground text-xs">
                          {formatDate(question.createdAt)} - {question.retrievalScope}
                        </span>
                        <span className="block truncate text-muted-foreground/75 text-xs">
                          {memoryQuestionPreview(question)}
                        </span>
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </>
  );
}

function MemoryQuestionStatusIcon({ status }: { status: MemoryQuestionStatus }) {
  if (status === "pending") {
    return <Spinner className="mt-0.5 size-4 text-primary" aria-hidden />;
  }
  if (status === "error") {
    return <CircleAlertIcon className="mt-0.5 size-4 text-destructive" />;
  }
  return <SparklesIcon className="mt-0.5 size-4 text-primary" />;
}

function MemoryQuestionDetail({ question }: { question: MemoryQuestionRecord }) {
  const evidence = memoryEvidence(question.response);
  const retrieval = memoryRetrieval(question.response);

  return (
    <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/8 text-primary">
        <SparklesIcon className="size-3.5" />
      </div>
      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          <span className="font-medium text-foreground">memory question</span>
          <span>{question.searchDomain}</span>
          <span>{question.retrievalScope}</span>
          <span>{formatDate(question.createdAt)}</span>
          {evidence.length > 0 ? <span>{evidence.length} evidence items</span> : null}
        </div>
        <div className="mb-3 rounded-lg border border-border bg-card/60 px-3 py-2 text-muted-foreground text-sm">
          {question.query}
        </div>
        {question.status === "pending" ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2 text-muted-foreground text-sm">
            <Spinner className="size-4 text-primary" aria-hidden />
            <span>Searching memory with the local worker...</span>
          </div>
        ) : null}
        {question.status === "error" ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-destructive-foreground text-sm">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>{question.error ?? "Memory answer failed."}</span>
          </div>
        ) : null}
        {question.status === "answered" && question.response ? (
          <div className="chat-markdown text-sm leading-relaxed">
            <ChatMarkdown cwd={undefined} text={question.response.markdown} />
          </div>
        ) : null}
        {retrieval ? (
          <div className="mt-3 flex flex-wrap gap-2 text-muted-foreground text-xs">
            {"mode" in retrieval && retrieval.mode ? <span>{retrieval.mode}</span> : null}
            {"retrievalMode" in retrieval && retrieval.retrievalMode ? <span>{retrieval.retrievalMode}</span> : null}
            {"vectorHitsCount" in retrieval && typeof retrieval.vectorHitsCount === "number" ? (
              <span>{retrieval.vectorHitsCount} vector hits</span>
            ) : null}
            {"textHitsCount" in retrieval && typeof retrieval.textHitsCount === "number" ? (
              <span>{retrieval.textHitsCount} text hits</span>
            ) : null}
          </div>
        ) : null}
        {evidence.length > 0 ? (
          <details className="mt-3 rounded-lg border border-border bg-card/50 px-3 py-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Evidence returned by Koed</summary>
            <div className="mt-2 space-y-2">
              {evidence.slice(0, 10).map((item, index) => (
                <div className="rounded-md bg-secondary/40 p-2" key={`${item.nodeId ?? item.sourceId ?? index}`}>
                  <div className="mb-1 flex flex-wrap gap-2 text-muted-foreground">
                    <span>#{index + 1}</span>
                    {item.visibility ? <span>{item.visibility}</span> : null}
                    {item.lcmNodeSummaryStatus ? <span>{item.lcmNodeSummaryStatus}</span> : null}
                  </div>
                  <p className="whitespace-pre-wrap leading-relaxed">{item.summaryText ?? "No summary text"}</p>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function LcmNodeCard({
  expanded,
  node,
  onToggle,
}: {
  expanded: boolean;
  node: GraphNode;
  onToggle: () => void;
}) {
  const ToggleIcon = expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <article className="rounded-lg border border-border bg-card/60">
      <button
        className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
        onClick={onToggle}
        type="button"
      >
        <ToggleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2 text-xs">
            <strong>
              {node.kind} depth {node.depth}
            </strong>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5",
                node.summaryStatus === "pending"
                  ? "bg-warning/12 text-warning-foreground"
                  : "bg-success/12 text-success-foreground",
              )}
            >
              {node.summaryStatus}
            </span>
          </span>
          <span className={cn("mt-1 block text-muted-foreground text-xs leading-relaxed", !expanded && "line-clamp-3")}>
            {node.summaryText}
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="border-border border-t px-3 py-2 text-muted-foreground text-[11px]">
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
            <dt>Sources</dt>
            <dd>{node.sourceEventCount}</dd>
            <dt>Embeddings</dt>
            <dd>{node.embeddingCount}</dd>
            <dt>Model</dt>
            <dd className="truncate">{node.summaryModel ?? "placeholder"}</dd>
            <dt>Prompt</dt>
            <dd className="truncate">{node.summaryPromptVersion ?? "unknown"}</dd>
            <dt>ID</dt>
            <dd className="truncate">{node.id}</dd>
          </dl>
        </div>
      ) : null}
    </article>
  );
}
