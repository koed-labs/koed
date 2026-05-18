import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const apiBaseUrl = (
  import.meta.env.VITE_KOED_API_BASE_URL ??
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD ? window.location.origin : "http://localhost:3000")
).replace(/\/$/, "");

const tokenStorageKey = "koed.historyBrowser.token";
const selectedThreadStorageKey = "koed.historyBrowser.thread";
const includeInvalidated = false;

type Visibility = "personal" | "team";
type SummaryStatus = "pending" | "summarized";
type RetrievalScope = "personal" | "personal+team";
type SearchDomain = "session" | "project" | "global";
type SidebarMode = "chats" | "questions";
type QuestionStatus = "pending" | "answered" | "error";

interface GraphOverview {
  capturedEvents: number;
  leafNodes: number;
  rollupNodes: number;
  pendingSummaries: number;
  invalidatedRecords: number;
  embeddings?: {
    enabled: boolean;
    healthy: boolean;
    model: string | null;
    dimensions: number | null;
    total: number;
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
  invalidationReason?: string | null;
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
  projectPath?: string | null;
  sessionId: string | null;
  threadId: string | null;
  threadName: string | null;
  createdAt: string;
  updatedAt: string;
  invalidatedAt: string | null;
  invalidationReason?: string | null;
  sourceEventCount: number;
  embeddingCount: number;
  summaryModel?: string | null;
  summaryPromptVersion?: string | null;
}

interface ThreadGroup {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  eventCount: number;
  invalidatedCount: number;
  latestAt: string;
  sample: string;
}

interface ProjectGroup {
  id: string;
  name: string;
  path: string | null;
  eventCount: number;
  threads: ThreadGroup[];
}

interface MemoryEvidence {
  nodeId?: string;
  sourceId?: string;
  sourceType?: string;
  visibility?: Visibility;
  summaryText?: string;
  lcmNodeSummaryStatus?: SummaryStatus;
}

interface MemoryAnswer {
  markdown?: string;
  mode?: string;
  evidence?: MemoryEvidence[];
  evidenceBundle?: {
    evidence?: MemoryEvidence[];
    retrieval?: Record<string, unknown>;
  };
  retrieval?: Record<string, unknown>;
  localMemoryWorker?: Record<string, unknown>;
}

interface MemoryQuestion {
  id: string;
  query: string;
  searchDomain: SearchDomain;
  retrievalScope: RetrievalScope;
  projectName?: string;
  sessionName?: string;
  createdAt: string;
  status: QuestionStatus;
  response?: MemoryAnswer;
  error?: string;
}

interface ToastState {
  tone: "info" | "error";
  message: string;
}

const requestHeaders = (apiToken: string) => {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiToken.trim()) {
    headers.authorization = `Bearer ${apiToken.trim()}`;
  }
  return headers;
};

const requestJson = async <T,>(
  path: string,
  apiToken: string,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...requestHeaders(apiToken),
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {})
    }
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
};

const projectKey = (event: GraphEvent) =>
  event.projectId ?? event.projectPath ?? event.workspaceId ?? "unknown-project";

const projectLabel = (event: GraphEvent) =>
  event.projectName ?? event.projectPath ?? event.workspaceId ?? "Unknown project";

const threadKey = (event: Pick<GraphEvent, "threadId" | "sessionId" | "id">) =>
  event.threadId ?? event.sessionId ?? event.id;

const threadLabel = (event: Pick<GraphEvent, "threadName" | "threadId" | "sessionId">) =>
  event.threadName ?? event.threadId ?? event.sessionId ?? "Untitled conversation";

const firstLine = (value: string) => value.trim().split(/\n+/)[0] ?? "";

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
};

const questionId = () =>
  typeof window.crypto?.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `question-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const memoryEvidence = (response?: MemoryAnswer) =>
  response?.evidenceBundle?.evidence ?? response?.evidence ?? [];

const memoryRetrieval = (response?: MemoryAnswer) =>
  response?.evidenceBundle?.retrieval ?? response?.retrieval;

const buildProjectGroups = (events: GraphEvent[]) => {
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
        threads: []
      };
      projectMap.set(pKey, project);
    }

    const tKey = threadKey(event);
    const compoundThreadKey = `${pKey}:${tKey}`;
    let thread = threadMap.get(compoundThreadKey);
    if (!thread) {
      thread = {
        id: tKey,
        projectId: pKey,
        projectName: project.name,
        name: threadLabel(event),
        eventCount: 0,
        invalidatedCount: 0,
        latestAt: event.timestamp,
        sample: event.contentPreview
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
        right.latestAt.localeCompare(left.latestAt)
      )
    }))
    .sort((left, right) => {
      const leftLatest = left.threads[0]?.latestAt ?? "";
      const rightLatest = right.threads[0]?.latestAt ?? "";
      return rightLatest.localeCompare(leftLatest);
    });
};

const nodeThreadId = (node: GraphNode) =>
  node.threadId ?? node.sessionId ?? node.projectId ?? "unthreaded";

const plainMarkdown = (value: string) =>
  value
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

function App() {
  const [apiToken, setApiToken] = useState(
    () => localStorage.getItem(tokenStorageKey) ?? import.meta.env.VITE_KOED_API_TOKEN ?? ""
  );
  const [query, setQuery] = useState("");
  const [overview, setOverview] = useState<GraphOverview | null>(null);
  const [events, setEvents] = useState<GraphEvent[]>([]);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState(
    () => localStorage.getItem(selectedThreadStorageKey) ?? ""
  );
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [threadEvents, setThreadEvents] = useState<GraphEvent[]>([]);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("chats");
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(() => new Set());
  const [memoryQuestion, setMemoryQuestion] = useState("");
  const [memorySearchDomain, setMemorySearchDomain] = useState<SearchDomain>("project");
  const [memoryRetrievalScope, setMemoryRetrievalScope] =
    useState<RetrievalScope>("personal");
  const [memoryQuestions, setMemoryQuestions] = useState<MemoryQuestion[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);
  const [askingMemory, setAskingMemory] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const refreshInFlight = useRef(false);

  const groups = useMemo(() => buildProjectGroups(events), [events]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedThread = useMemo(
    () => groups.flatMap((group) => group.threads).find((thread) => thread.id === selectedThreadId),
    [groups, selectedThreadId]
  );
  const selectedEvent = useMemo(
    () => threadEvents.find((event) => event.id === selectedEventId) ?? threadEvents[0] ?? null,
    [selectedEventId, threadEvents]
  );
  const linkedNodes = useMemo(() => {
    const linkedIds = new Set(threadEvents.flatMap((event) => event.linkedNodeIds));
    const explicitThreadNodes = nodes.filter((node) => selectedThread && nodeThreadId(node) === selectedThread.id);
    return [
      ...[...linkedIds].flatMap((id) => nodesById.get(id) ?? []),
      ...explicitThreadNodes.filter((node) => !linkedIds.has(node.id))
    ];
  }, [nodes, nodesById, selectedThread, threadEvents]);
  const selectedEventLinkedNodes = useMemo(
    () => (selectedEvent?.linkedNodeIds ?? []).flatMap((id) => nodesById.get(id) ?? []),
    [nodesById, selectedEvent]
  );
  const selectedQuestion = useMemo(
    () => memoryQuestions.find((question) => question.id === selectedQuestionId) ?? null,
    [memoryQuestions, selectedQuestionId]
  );

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
            (group.path ?? "").toLowerCase().includes(needle)
        )
      }))
      .filter((group) => group.threads.length > 0);
  }, [groups, query]);

  const filteredQuestions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = needle
      ? memoryQuestions.filter(
          (question) =>
            question.query.toLowerCase().includes(needle) ||
            (question.response?.markdown ?? "").toLowerCase().includes(needle) ||
            (question.error ?? "").toLowerCase().includes(needle)
        )
      : memoryQuestions;
    return {
      project: visible.filter((question) => question.searchDomain === "project"),
      session: visible.filter((question) => question.searchDomain === "session"),
      global: visible.filter((question) => question.searchDomain === "global")
    } satisfies Record<SearchDomain, MemoryQuestion[]>;
  }, [memoryQuestions, query]);

  const loadGraph = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setLoading(true);
      }
      try {
        const [overviewResponse, eventsResponse, nodesResponse] = await Promise.all([
          requestJson<{ overview: GraphOverview }>("/v1/memory/graph/overview", apiToken),
          requestJson<{ events: GraphEvent[] }>(
            `/v1/memory/graph/events?limit=500&includeInvalidated=${includeInvalidated}`,
            apiToken
          ),
          requestJson<{ nodes: GraphNode[] }>(
            `/v1/memory/graph/nodes?limit=500&includeInvalidated=${includeInvalidated}`,
            apiToken
          )
        ]);
        setOverview(overviewResponse.overview);
        setEvents(eventsResponse.events);
        setNodes(nodesResponse.nodes);
        setToast(null);
      } catch (error) {
        setToast({
          tone: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [apiToken]
  );

  const loadThread = useCallback(
    async (threadId: string, options?: { silent?: boolean }) => {
      if (!threadId) {
        setThreadEvents([]);
        return;
      }
      if (!options?.silent) {
        setThreadLoading(true);
      }
      try {
        const eventsResponse = await requestJson<{ events: GraphEvent[] }>(
          `/v1/memory/graph/events?threadId=${encodeURIComponent(threadId)}&limit=250&includeInvalidated=${includeInvalidated}`,
          apiToken
        );
        const sorted = [...eventsResponse.events].sort((left, right) =>
          left.timestamp.localeCompare(right.timestamp)
        );
        setThreadEvents(sorted);
        setSelectedEventId((current) =>
          current && sorted.some((event) => event.id === current)
            ? current
            : (sorted[0]?.id ?? null)
        );
      } catch {
        const localEvents = events
          .filter((event) => threadKey(event) === threadId)
          .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
        setThreadEvents(localEvents);
        setSelectedEventId(localEvents[0]?.id ?? null);
      } finally {
        if (!options?.silent) {
          setThreadLoading(false);
        }
      }
    },
    [apiToken, events, includeInvalidated]
  );

  useEffect(() => {
    if (!selectedEvent || selectedEvent.rawContent) {
      return;
    }

    let cancelled = false;
    const loadSelectedEventDetail = async () => {
      try {
        const detail = await requestJson<{ event: GraphEvent }>(
          `/v1/memory/graph/events/${selectedEvent.id}?includeRaw=true&includeInvalidated=${includeInvalidated}`,
          apiToken
        );
        if (cancelled) {
          return;
        }
        setThreadEvents((current) =>
          current.map((event) =>
            event.id === selectedEvent.id ? { ...event, ...detail.event } : event
          )
        );
      } catch {
        // The preview remains usable if raw detail is unavailable or rate limited.
      }
    };

    void loadSelectedEventDetail();
    return () => {
      cancelled = true;
    };
  }, [apiToken, includeInvalidated, selectedEvent]);

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
    [loadGraph, loadThread, selectedThreadId]
  );

  useEffect(() => {
    localStorage.setItem(tokenStorageKey, apiToken);
  }, [apiToken]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    if (!selectedThreadId && groups[0]?.threads[0]) {
      setSelectedThreadId(groups[0].threads[0].id);
    }
  }, [groups, selectedThreadId]);

  useEffect(() => {
    localStorage.setItem(selectedThreadStorageKey, selectedThreadId);
    void loadThread(selectedThreadId);
  }, [loadThread, selectedThreadId]);

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
    const controller = new AbortController();
    let cancelled = false;
    let retryTimeout: number | null = null;

    const connect = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/v1/memory/graph/stream`, {
          credentials: "include",
          headers: requestHeaders(apiToken),
          signal: controller.signal
        });
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
          tone: "error",
          message: error instanceof Error ? error.message : String(error)
        });
        retryTimeout = window.setTimeout(() => void connect(), 2000);
      }
    };

    void connect();
    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimeout !== null) {
        window.clearTimeout(retryTimeout);
      }
    };
  }, [apiToken, refreshVisibleData]);

  const askMemory = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = memoryQuestion.trim();
    if (!trimmed || askingMemory) {
      return;
    }

    const nextQuestion: MemoryQuestion = {
      id: questionId(),
      query: trimmed,
      retrievalScope: memoryRetrievalScope,
      searchDomain: memorySearchDomain,
      ...(selectedThread?.projectName ? { projectName: selectedThread.projectName } : {}),
      ...(selectedThread?.name ? { sessionName: selectedThread.name } : {}),
      createdAt: new Date().toISOString(),
      status: "pending"
    };

    setMemoryQuestions((current) => [nextQuestion, ...current]);
    setSelectedQuestionId(nextQuestion.id);
    setSidebarMode("questions");
    setMemoryQuestion("");
    setAskingMemory(true);

    try {
      const response = await requestJson<MemoryAnswer>("/v1/memory/answer", apiToken, {
        method: "POST",
        body: JSON.stringify({
          query: trimmed,
          retrieval_scope: memoryRetrievalScope,
          search_domain: memorySearchDomain,
          ...(memorySearchDomain === "project" && selectedThread?.projectId
            ? { workspace_id: selectedThread.projectId }
            : {}),
          ...(memorySearchDomain === "session" && selectedThread?.id
            ? { session_id: selectedThread.id }
            : {}),
          limit: 10
        })
      });
      setMemoryQuestions((current) =>
        current.map((question) =>
          question.id === nextQuestion.id
            ? { ...question, response, status: "answered" }
            : question
        )
      );
      setToast(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMemoryQuestions((current) =>
        current.map((question) =>
          question.id === nextQuestion.id
            ? { ...question, error: message, status: "error" }
            : question
        )
      );
      setToast({ tone: "error", message });
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
    <main className="history-app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="brand-row">
            <div className="brand-mark">K</div>
            <div>
              <strong>Koed History</strong>
              <span>LCM graph browser</span>
            </div>
            <button type="button" className="icon-button" onClick={() => void loadGraph()}>
              {loading ? "..." : "R"}
            </button>
          </div>
          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={sidebarMode === "chats" ? "Search projects and sessions" : "Search memory questions"}
          />
          <div className="segmented">
            <button
              type="button"
              className={sidebarMode === "chats" ? "active" : ""}
              onClick={() => setSidebarMode("chats")}
            >
              Chats
            </button>
            <button
              type="button"
              className={sidebarMode === "questions" ? "active" : ""}
              onClick={() => setSidebarMode("questions")}
            >
              Questions
            </button>
          </div>
        </header>

        <div className="sidebar-scroll">
          {sidebarMode === "chats" ? (
            filteredGroups.length === 0 ? (
              <p className="empty">No captured sessions visible.</p>
            ) : (
              filteredGroups.map((group) => (
                <section className="project-group" key={group.id}>
                  <div className="group-label">
                    <span>{group.name}</span>
                    <small>{group.eventCount}</small>
                  </div>
                  {group.threads.map((thread) => (
                    <button
                      key={`${group.id}:${thread.id}`}
                      type="button"
                      className={`thread-button ${thread.id === selectedThreadId ? "active" : ""}`}
                      onClick={() => setSelectedThreadId(thread.id)}
                    >
                      <strong>{thread.name}</strong>
                      <span>{formatDate(thread.latestAt)} - {thread.eventCount} events</span>
                      <small>{firstLine(thread.sample)}</small>
                    </button>
                  ))}
                </section>
              ))
            )
          ) : (
            <QuestionSidebar
              groupedQuestions={filteredQuestions}
              selectedQuestionId={selectedQuestionId}
              onSelect={setSelectedQuestionId}
            />
          )}
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>
              {sidebarMode === "questions"
                ? selectedQuestion?.query ?? "Memory questions"
                : selectedThread?.name ?? "No conversation selected"}
            </h1>
            <p>
              {sidebarMode === "questions"
                ? selectedQuestion
                  ? `${selectedQuestion.searchDomain} - ${selectedQuestion.retrievalScope}`
                  : "Ask Koed memory from the composer"
                : selectedThread?.projectName ?? "Connect to Koed to browse captured sessions"}
            </p>
          </div>
          <div className="top-actions">
            <label>
              API token
              <input
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                placeholder="Optional bearer token"
                type="password"
              />
            </label>
            <button type="button" onClick={() => setInspectorOpen((value) => !value)}>
              {inspectorOpen ? "Hide LCM" : "Show LCM"}
            </button>
          </div>
        </header>

        {toast ? <div className={`toast ${toast.tone}`}>{toast.message}</div> : null}

        <div className={`content-grid ${inspectorOpen ? "with-inspector" : ""}`}>
          <section className="timeline">
            <div className="kpi-strip">
              <Metric label="Events" value={overview?.capturedEvents ?? events.length} />
              <Metric label="Nodes" value={(overview?.leafNodes ?? 0) + (overview?.rollupNodes ?? nodes.length)} />
              <Metric label="Pending" value={overview?.pendingSummaries ?? 0} />
              <Metric label="Embeddings" value={overview?.embeddings?.total ?? 0} />
            </div>

            <div className="scroll-panel">
              {sidebarMode === "questions" ? (
                selectedQuestion ? (
                  <QuestionDetail question={selectedQuestion} />
                ) : (
                  <EmptyState title="No memory questions yet" text="Ask from the composer to inspect a scoped memory answer." />
                )
              ) : (
                <>
                  {loading || threadLoading ? <div className="notice">Loading Koed graph...</div> : null}
                  {!loading && !threadLoading && threadEvents.length === 0 ? (
                    <EmptyState title="No captured events visible" text="Start the Koed API, paste a token if needed, then reload the graph." />
                  ) : null}
                  {threadEvents.map((event) => (
                    <EventMessage
                      event={event}
                      isSelected={event.id === selectedEvent?.id}
                      key={event.id}
                      onSelect={() => setSelectedEventId(event.id)}
                    />
                  ))}
                </>
              )}
            </div>

            <MemoryComposer
              disabled={askingMemory}
              memoryQuestion={memoryQuestion}
              memoryRetrievalScope={memoryRetrievalScope}
              memorySearchDomain={memorySearchDomain}
              onAsk={(event) => void askMemory(event)}
              selectedThread={selectedThread}
              setMemoryQuestion={setMemoryQuestion}
              setMemoryRetrievalScope={setMemoryRetrievalScope}
              setMemorySearchDomain={setMemorySearchDomain}
            />
          </section>

          {inspectorOpen ? (
            <aside className="inspector">
              <section>
                <h2>Event</h2>
                {selectedEvent ? (
                  <dl className="meta-list">
                    <dt>ID</dt>
                    <dd>{selectedEvent.id}</dd>
                    <dt>Actor</dt>
                    <dd>{selectedEvent.actor ?? selectedEvent.eventType}</dd>
                    <dt>Runtime</dt>
                    <dd>{selectedEvent.sourceRuntime ?? "unknown"}</dd>
                    <dt>Model</dt>
                    <dd>{selectedEvent.model ?? "unknown"}</dd>
                    <dt>Capture</dt>
                    <dd>{selectedEvent.captureMethod}</dd>
                    <dt>Visibility</dt>
                    <dd>{selectedEvent.visibility}</dd>
                  </dl>
                ) : (
                  <p className="empty">Select an event to inspect metadata.</p>
                )}
              </section>

              <section>
                <h2>Selected event links</h2>
                {selectedEventLinkedNodes.length === 0 ? (
                  <p className="empty">No LCM nodes linked to this event.</p>
                ) : (
                  selectedEventLinkedNodes.map((node) => (
                    <NodeCard
                      expanded={expandedNodeIds.has(node.id)}
                      key={node.id}
                      node={node}
                      onToggle={() => toggleNode(node.id)}
                    />
                  ))
                )}
              </section>

              <section>
                <h2>Conversation LCM</h2>
                {linkedNodes.length === 0 ? (
                  <p className="empty">No LCM summaries for this conversation.</p>
                ) : (
                  linkedNodes.map((node) => (
                    <NodeCard
                      expanded={expandedNodeIds.has(node.id)}
                      key={node.id}
                      node={node}
                      onToggle={() => toggleNode(node.id)}
                    />
                  ))
                )}
              </section>
            </aside>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EventMessage({
  event,
  isSelected,
  onSelect
}: {
  event: GraphEvent;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const text = plainMarkdown(event.rawContent ?? event.contentPreview);
  return (
    <article className={`event-message ${isSelected ? "selected" : ""}`} onClick={onSelect}>
      <div className={`avatar ${event.actor ?? "event"}`}>{(event.actor ?? event.eventType).slice(0, 1).toUpperCase()}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{event.actor ?? event.eventType}</strong>
          <span>{formatDate(event.timestamp)}</span>
          <span>{event.visibility}</span>
          {event.linkedNodeIds.length > 0 ? <span>{event.linkedNodeIds.length} LCM links</span> : null}
        </div>
        <p>{text}</p>
      </div>
    </article>
  );
}

function MemoryComposer({
  disabled,
  memoryQuestion,
  memoryRetrievalScope,
  memorySearchDomain,
  onAsk,
  selectedThread,
  setMemoryQuestion,
  setMemoryRetrievalScope,
  setMemorySearchDomain
}: {
  disabled: boolean;
  memoryQuestion: string;
  memoryRetrievalScope: RetrievalScope;
  memorySearchDomain: SearchDomain;
  onAsk: (event: FormEvent) => void;
  selectedThread: ThreadGroup | undefined;
  setMemoryQuestion: (value: string) => void;
  setMemoryRetrievalScope: (value: RetrievalScope) => void;
  setMemorySearchDomain: (value: SearchDomain) => void;
}) {
  return (
    <form className="memory-composer" onSubmit={onAsk}>
      <textarea
        disabled={disabled}
        onChange={(event) => setMemoryQuestion(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Ask memory about the selected project..."
        value={memoryQuestion}
      />
      <div className="composer-bar">
        <select
          onChange={(event) => setMemorySearchDomain(event.target.value as SearchDomain)}
          value={memorySearchDomain}
        >
          <option value="project">Project</option>
          <option disabled={!selectedThread} value="session">Session</option>
          <option value="global">Global</option>
        </select>
        <select
          onChange={(event) => setMemoryRetrievalScope(event.target.value as RetrievalScope)}
          value={memoryRetrievalScope}
        >
          <option value="personal">Personal</option>
          <option value="personal+team">Personal + team</option>
        </select>
        <span>
          {memorySearchDomain === "session"
            ? selectedThread?.name ?? "No session"
            : memorySearchDomain === "project"
              ? selectedThread?.projectName ?? "Selected project"
              : "All visible memory"}
        </span>
        <button disabled={disabled || !memoryQuestion.trim()} type="submit">
          {disabled ? "Asking" : "Ask"}
        </button>
      </div>
    </form>
  );
}

function QuestionSidebar({
  groupedQuestions,
  selectedQuestionId,
  onSelect
}: {
  groupedQuestions: Record<SearchDomain, MemoryQuestion[]>;
  selectedQuestionId: string | null;
  onSelect: (id: string) => void;
}) {
  const buckets: Array<{ domain: SearchDomain; label: string }> = [
    { domain: "project", label: "Project" },
    { domain: "session", label: "Session" },
    { domain: "global", label: "Global" }
  ];
  const total = buckets.reduce((count, bucket) => count + groupedQuestions[bucket.domain].length, 0);

  if (total === 0) {
    return <p className="empty">No memory questions yet.</p>;
  }

  return (
    <>
      {buckets.map((bucket) =>
        groupedQuestions[bucket.domain].length === 0 ? null : (
          <section className="project-group" key={bucket.domain}>
            <div className="group-label">
              <span>{bucket.label}</span>
              <small>{groupedQuestions[bucket.domain].length}</small>
            </div>
            {groupedQuestions[bucket.domain].map((question) => (
              <button
                className={`thread-button ${question.id === selectedQuestionId ? "active" : ""}`}
                key={question.id}
                onClick={() => onSelect(question.id)}
                type="button"
              >
                <strong>{question.query}</strong>
                <span>{formatDate(question.createdAt)} - {question.retrievalScope}</span>
                <small>{question.response?.markdown ?? question.error ?? question.status}</small>
              </button>
            ))}
          </section>
        )
      )}
    </>
  );
}

function QuestionDetail({ question }: { question: MemoryQuestion }) {
  const evidence = memoryEvidence(question.response);
  const retrieval = memoryRetrieval(question.response);
  return (
    <article className="question-detail">
      <div className="avatar question">Q</div>
      <div>
        <div className="message-meta">
          <strong>memory question</strong>
          <span>{question.searchDomain}</span>
          <span>{question.retrievalScope}</span>
          <span>{formatDate(question.createdAt)}</span>
        </div>
        <p className="question-text">{question.query}</p>
        {question.status === "pending" ? <div className="notice">Searching memory...</div> : null}
        {question.status === "error" ? <div className="notice error">{question.error}</div> : null}
        {question.status === "answered" && question.response?.markdown ? (
          <p className="answer-text">{plainMarkdown(question.response.markdown)}</p>
        ) : null}
        {retrieval ? <pre className="json-block">{JSON.stringify(retrieval, null, 2)}</pre> : null}
        {evidence.length > 0 ? (
          <details className="evidence">
            <summary>Evidence returned by Koed</summary>
            {evidence.slice(0, 10).map((item, index) => (
              <div key={`${item.nodeId ?? item.sourceId ?? index}`}>
                <span>#{index + 1} {item.visibility ?? ""}</span>
                <p>{item.summaryText ?? "No summary text"}</p>
              </div>
            ))}
          </details>
        ) : null}
      </div>
    </article>
  );
}

function NodeCard({
  expanded,
  node,
  onToggle
}: {
  expanded: boolean;
  node: GraphNode;
  onToggle: () => void;
}) {
  return (
    <article className="node-card">
      <button onClick={onToggle} type="button">
        <span>{expanded ? "v" : ">"}</span>
        <strong>{node.kind} depth {node.depth}</strong>
        <small>{node.summaryStatus}</small>
      </button>
      <p className={expanded ? "" : "clamped"}>{node.summaryText}</p>
      {expanded ? (
        <dl className="meta-list compact">
          <dt>Sources</dt>
          <dd>{node.sourceEventCount}</dd>
          <dt>Embeddings</dt>
          <dd>{node.embeddingCount}</dd>
          <dt>Model</dt>
          <dd>{node.summaryModel ?? "unknown"}</dd>
          <dt>ID</dt>
          <dd>{node.id}</dd>
        </dl>
      ) : null}
    </article>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
