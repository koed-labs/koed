import type {
  AppData,
  GraphEvent,
  GraphNode,
  GraphThreadIndexResponse,
  LocalMemoryAgentFlowKey,
  LocalMemoryAgentFlowSettings,
  LocalMemoryAgentSettings,
  ManualMemoryQuestionWorkerConfig,
  MemoryQuestionRecord,
  RetrievalScope,
  SearchDomain,
  ThreadGroup
} from "./types";
import { koedDebug, koedDebugTimed } from "./debug";
import { selectedThreadEventPageSize } from "./threadDetailCache";

export const apiBaseUrl = (
  import.meta.env.VITE_KOED_API_BASE_URL ??
  import.meta.env.VITE_API_BASE_URL ??
  "http://localhost:3000"
).replace(/\/$/, "");

const includeInvalidated = false;
const threadShellPageSize = 500;
const questionShellPageSize = 500;
const linkedGraphNodeBatchSize = 100;

export function requestHeaders(apiToken: string) {
  const headers: Record<string, string> = {
    accept: "application/json"
  };
  if (apiToken.trim()) {
    headers.authorization = `Bearer ${apiToken.trim()}`;
  }
  return headers;
}

export async function requestJson<T>(
  path: string,
  apiToken: string,
  init?: RequestInit
): Promise<T> {
  return koedDebugTimed(
    "api.request",
    { path: path.slice(0, 240) },
    async () => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        ...init,
        credentials: "include",
        headers: {
          ...requestHeaders(apiToken),
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {})
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
    }
  );
}

export async function loadGraphData(apiToken: string): Promise<AppData> {
  const projectsById = new Map<string, AppData["projects"][number]>();
  let offset = 0;

  while (true) {
    const threadIndexResponse = await requestJson<GraphThreadIndexResponse>(
      `/v1/memory/graph/threads?limit=${threadShellPageSize}&offset=${offset}&includeInvalidated=${includeInvalidated}`,
      apiToken
    );
    const threadsLoaded = threadIndexResponse.projects.reduce(
      (count, project) => count + project.threads.length,
      0
    );

    for (const project of threadIndexResponse.projects) {
      const existing = projectsById.get(project.id);
      if (existing) {
        existing.eventCount += project.eventCount;
        existing.threads.push(...project.threads);
      } else {
        projectsById.set(project.id, {
          ...project,
          threads: [...project.threads]
        });
      }
    }

    if (threadsLoaded < threadShellPageSize) {
      break;
    }
    offset += threadsLoaded;
  }

  return {
    overview: null,
    projects: [...projectsById.values()],
    nodes: []
  };
}

export async function loadMemoryQuestionShells(
  apiToken: string,
  options: { query?: string } = {}
): Promise<MemoryQuestionRecord[]> {
  const questions: MemoryQuestionRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: String(questionShellPageSize),
      offset: String(offset)
    });
    if (options.query?.trim()) {
      params.set("query", options.query.trim());
    }
    const response = await requestJson<{ questions: MemoryQuestionRecord[] }>(
      `/v1/memory/questions?${params.toString()}`,
      apiToken
    );
    questions.push(...response.questions);
    if (response.questions.length < questionShellPageSize) {
      break;
    }
    offset += response.questions.length;
  }

  return questions;
}

export async function loadMemoryQuestionDetail(
  questionId: string,
  apiToken: string
): Promise<MemoryQuestionRecord> {
  const response = await requestJson<{ question: MemoryQuestionRecord }>(
    `/v1/memory/questions/${encodeURIComponent(questionId)}`,
    apiToken
  );
  return response.question;
}

export async function updateCapturedSessionTitle({
  apiToken,
  sessionId,
  title
}: {
  apiToken: string;
  sessionId: string;
  title: string;
}): Promise<void> {
  await requestJson<{ session: unknown }>(
    `/v1/memory/graph/sessions/${encodeURIComponent(sessionId)}/title`,
    apiToken,
    {
      method: "PATCH",
      body: JSON.stringify({ title })
    }
  );
}

export async function createMemoryQuestion({
  apiToken,
  input
}: {
  apiToken: string;
  input: {
    query: string;
    retrievalScope: RetrievalScope;
    searchDomain: SearchDomain;
    workspaceId?: string;
    projectName?: string;
    projectPath?: string;
    sessionId?: string;
    threadId?: string;
    threadName?: string;
    localMemoryWorkerConfig?: ManualMemoryQuestionWorkerConfig;
  };
}): Promise<MemoryQuestionRecord> {
  const response = await requestJson<{ question: MemoryQuestionRecord }>(
    "/v1/memory/questions",
    apiToken,
    {
      method: "POST",
      body: JSON.stringify({
        query: input.query,
        retrieval_scope: input.retrievalScope,
        search_domain: input.searchDomain,
        workspace_id: input.workspaceId,
        project_name: input.projectName,
        project_path: input.projectPath,
        session_id: input.sessionId,
        thread_id: input.threadId,
        thread_name: input.threadName,
        local_memory_worker_config: input.localMemoryWorkerConfig
          ? {
              provider: input.localMemoryWorkerConfig.provider,
              model: input.localMemoryWorkerConfig.model,
              reasoning_effort: input.localMemoryWorkerConfig.reasoningEffort,
              timeout_ms: input.localMemoryWorkerConfig.timeoutMs,
              max_attempts: input.localMemoryWorkerConfig.maxAttempts
            }
          : undefined
      })
    }
  );
  return response.question;
}

export async function markMemoryQuestionError({
  apiToken,
  errorMessage,
  questionId
}: {
  apiToken: string;
  errorMessage: string;
  questionId: string;
}): Promise<MemoryQuestionRecord> {
  const response = await requestJson<{ question: MemoryQuestionRecord }>(
    `/v1/memory/questions/${encodeURIComponent(questionId)}`,
    apiToken,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "error",
        error_message: errorMessage
      })
    }
  );
  return response.question;
}

export async function askLocalMemoryQuestion({
  apiToken,
  bridgeUrl,
  input
}: {
  apiToken: string;
  bridgeUrl: string;
  input: {
    query: string;
    questionId?: string;
    retrievalScope: RetrievalScope;
    searchDomain: SearchDomain;
    workspaceId?: string;
    projectName?: string;
    projectPath?: string;
    sessionId?: string;
    threadId?: string;
    threadName?: string;
    limit?: number;
    localMemoryWorkerConfig?: ManualMemoryQuestionWorkerConfig;
  };
}): Promise<{ ok: boolean; question: MemoryQuestionRecord; error?: string }> {
  const response = await fetch(
    `${bridgeUrl.replace(/\/$/, "")}/v1/memory/answer-local`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        ...requestHeaders(apiToken),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        query: input.query,
        question_id: input.questionId,
        retrieval_scope: input.retrievalScope,
        search_domain: input.searchDomain,
        workspace_id: input.workspaceId,
        project_name: input.projectName,
        project_path: input.projectPath,
        session_id: input.sessionId,
        thread_id: input.threadId,
        thread_name: input.threadName,
        limit: input.limit ?? 10,
        local_memory_worker_config: input.localMemoryWorkerConfig
          ? {
              provider: input.localMemoryWorkerConfig.provider,
              model: input.localMemoryWorkerConfig.model,
              reasoning_effort: input.localMemoryWorkerConfig.reasoningEffort,
              timeout_ms: input.localMemoryWorkerConfig.timeoutMs,
              max_attempts: input.localMemoryWorkerConfig.maxAttempts
            }
          : undefined
      })
    }
  );
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Local MCP bridge failed with ${response.status}`;
    throw new Error(message);
  }
  return body as {
    ok: boolean;
    question: MemoryQuestionRecord;
    error?: string;
  };
}

export async function loadLocalMemoryAgentSettings({
  apiToken,
  bridgeUrl
}: {
  apiToken: string;
  bridgeUrl: string;
}): Promise<LocalMemoryAgentSettings> {
  const response = await fetch(
    `${bridgeUrl.replace(/\/$/, "")}/v1/memory/local-agent-settings`,
    {
      credentials: "include",
      headers: requestHeaders(apiToken)
    }
  );
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Local agent settings failed with ${response.status}`;
    throw new Error(message);
  }
  return body as LocalMemoryAgentSettings;
}

export async function saveLocalMemoryAgentFlowSetting({
  apiToken,
  bridgeUrl,
  flowKey,
  setting
}: {
  apiToken: string;
  bridgeUrl: string;
  flowKey: LocalMemoryAgentFlowKey;
  setting: Pick<
    LocalMemoryAgentFlowSettings,
    "provider" | "model" | "reasoningEffort" | "timeoutMs" | "maxAttempts"
  >;
}): Promise<void> {
  const response = await fetch(
    `${bridgeUrl.replace(/\/$/, "")}/v1/memory/local-agent-settings/${encodeURIComponent(flowKey)}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        ...requestHeaders(apiToken),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        provider: setting.provider,
        model: setting.model,
        reasoning_effort: setting.reasoningEffort,
        timeout_ms: setting.timeoutMs,
        max_attempts: setting.maxAttempts
      })
    }
  );
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Local agent settings save failed with ${response.status}`;
    throw new Error(message);
  }
}

export async function loadThreadEvents(
  thread: Pick<ThreadGroup, "eventCount" | "id" | "projectId">,
  apiToken: string,
  options: {
    full?: boolean;
    before?: { id: string; sourceSequence?: number | null; timestamp: string };
    includeContent?: boolean;
    limit?: number;
    onPage?: (events: GraphEvent[], options: { complete: boolean }) => void;
  } = {}
): Promise<GraphEvent[]> {
  const pageSize = Math.max(
    1,
    Math.min(options.limit ?? thread.eventCount, selectedThreadEventPageSize)
  );
  const pages: GraphEvent[] = [];
  let cursorId: string | undefined = options.before?.id;
  let cursorTimestamp: string | undefined = options.before?.timestamp;
  let cursorSourceSequence: number | null | undefined =
    "sourceSequence" in (options.before ?? {})
      ? options.before?.sourceSequence
      : undefined;
  const seenCursors = new Set<string>();

  do {
    const cursorKey =
      cursorId && cursorTimestamp ? `${cursorTimestamp}:${cursorId}` : "";
    if (cursorKey) {
      if (seenCursors.has(cursorKey)) {
        break;
      }
      seenCursors.add(cursorKey);
    }
    const cursor =
      cursorId && cursorTimestamp
        ? `&cursorTimestamp=${encodeURIComponent(cursorTimestamp)}${typeof cursorSourceSequence === "number" ? `&cursorSourceSequence=${encodeURIComponent(String(cursorSourceSequence))}` : ""}&cursorId=${encodeURIComponent(cursorId)}`
        : "";
    const content = options.includeContent ? "&includeContent=true" : "";
    const eventsResponse = await requestJson<{ events: GraphEvent[] }>(
      `/v1/memory/graph/events?projectId=${encodeURIComponent(thread.projectId)}&threadId=${encodeURIComponent(thread.id)}&limit=${pageSize}${cursor}${content}&includeInvalidated=${includeInvalidated}`,
      apiToken
    );
    if (
      cursorId &&
      cursorTimestamp &&
      eventsResponse.events.some(
        (event) => event.id === cursorId && event.timestamp === cursorTimestamp
      )
    ) {
      koedDebug("threadEvents.repeatedCursor", {
        threadId: thread.id,
        cursorId,
        pageEvents: eventsResponse.events.length
      });
      break;
    }
    pages.push(...eventsResponse.events);
    koedDebug("threadEvents.page", {
      threadId: thread.id,
      full: Boolean(options.full),
      includeContent: Boolean(options.includeContent),
      pageEvents: eventsResponse.events.length,
      accumulatedEvents: pages.length,
      cursorId: cursorId ?? null
    });
    const lastEvent = eventsResponse.events.at(-1);
    cursorId = lastEvent?.id;
    cursorTimestamp = lastEvent?.timestamp;
    cursorSourceSequence = lastEvent?.sourceSequence;
    if (!options.full || eventsResponse.events.length < pageSize) {
      options.onPage?.(sortGraphEventsChronologically(pages), {
        complete: true
      });
      break;
    }
    options.onPage?.(sortGraphEventsChronologically(pages), {
      complete: false
    });
  } while (pageSize > 0);

  return sortGraphEventsChronologically(pages);
}

export function compareGraphEventChronology(
  left: Pick<
    GraphEvent,
    "id" | "sourceEventTime" | "sourceSequence" | "timestamp"
  >,
  right: Pick<
    GraphEvent,
    "id" | "sourceEventTime" | "sourceSequence" | "timestamp"
  >
) {
  const timestampDifference = (
    left.sourceEventTime ?? left.timestamp
  ).localeCompare(right.sourceEventTime ?? right.timestamp);
  if (timestampDifference !== 0) {
    return timestampDifference;
  }
  if (
    typeof left.sourceSequence === "number" &&
    typeof right.sourceSequence === "number" &&
    left.sourceSequence !== right.sourceSequence
  ) {
    return left.sourceSequence - right.sourceSequence;
  }
  if (typeof left.sourceSequence === "number") {
    return -1;
  }
  if (typeof right.sourceSequence === "number") {
    return 1;
  }
  return left.id.localeCompare(right.id);
}

export function sortGraphEventsChronologically(events: GraphEvent[]) {
  return [...events].sort(compareGraphEventChronology);
}

export async function loadLinkedGraphNodes(
  events: GraphEvent[],
  apiToken: string
): Promise<GraphNode[]> {
  const nodeIds = [...new Set(events.flatMap((event) => event.linkedNodeIds))];
  if (nodeIds.length === 0) {
    return [];
  }

  const nodes: GraphNode[] = [];
  for (
    let batchStart = 0;
    batchStart < nodeIds.length;
    batchStart += linkedGraphNodeBatchSize
  ) {
    const batch = nodeIds.slice(
      batchStart,
      batchStart + linkedGraphNodeBatchSize
    );
    const response = await requestJson<{ nodes: GraphNode[] }>(
      `/v1/memory/graph/nodes?ids=${encodeURIComponent(batch.join(","))}&includeInvalidated=${includeInvalidated}`,
      apiToken
    ).catch(() => ({ nodes: [] }));
    nodes.push(...response.nodes);
  }

  return nodes;
}

export async function loadEventDetail(
  eventId: string,
  apiToken: string
): Promise<GraphEvent> {
  const detail = await requestJson<{ event: GraphEvent }>(
    `/v1/memory/graph/events/${encodeURIComponent(eventId)}?includeRaw=true&includeInvalidated=${includeInvalidated}`,
    apiToken
  );

  return detail.event;
}
