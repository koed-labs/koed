import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  compareGraphEventChronology,
  loadEventDetail as requestEventDetail,
  loadGraphData,
  loadLinkedGraphNodes,
  loadThreadEvents,
  requestHeaders
} from "./api";
import { koedDebug, koedDebugTimed } from "./debug";
import { threadSelectionKey } from "./graph";
import {
  getCachedThreadEvents,
  isCompleteThreadDetail,
  isWarmThreadDetail,
  markThreadAccessed,
  prewarmConcurrency,
  prewarmQueueLimit,
  prewarmThreadEventLimit,
  pruneThreadDetailCache,
  selectedThreadEventPageSize,
  selectedThreadHeadEventLimit,
  threadKey,
  writeThreadError,
  writeThreadEvents,
  type ThreadDetailCache
} from "./threadDetailCache";
import {
  applyThreadEventShellUpdates,
  emptyThreadIndex,
  ingestThreadIndex,
  renameThreadShell,
  selectProjectGroups,
  selectThread,
  type ThreadIndexState
} from "./threadIndex";
import type {
  AppData,
  GraphEvent,
  GraphNode,
  ThreadGroup,
  ToastState
} from "./types";

const streamEventDetailConcurrency = 6;

const threadShellVersion = (thread: ThreadGroup | undefined) =>
  thread
    ? `${threadSelectionKey(thread)}:${thread.eventCount}:${thread.latestAt}`
    : "";

interface UseKoedMemoryGraphInput {
  apiToken: string;
  onMemoryQuestionUpdate?: (payload: GraphUpdatePayload) => void;
  selectedThreadId: string;
  setToast: (toast: ToastState | null) => void;
}

export interface GraphUpdatePayload {
  coalesced?: unknown;
  eventRefs?: unknown;
  eventIds?: unknown;
  id?: unknown;
  operation?: unknown;
  projectId?: unknown;
  questionIds?: unknown;
  table?: unknown;
  threadId?: unknown;
}

type StreamEventRefreshResult = "failed" | "merged" | "not-selected";

interface StreamEventRef {
  id: string;
  operation?: string | undefined;
  projectId: string;
  threadId: string;
}

function isStreamEventRef(value: unknown): value is StreamEventRef {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as StreamEventRef).id === "string" &&
    typeof (value as StreamEventRef).projectId === "string" &&
    typeof (value as StreamEventRef).threadId === "string"
  );
}

function parseGraphUpdateFrame(frame: string): GraphUpdatePayload | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (!data) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed && typeof parsed === "object"
      ? (parsed as GraphUpdatePayload)
      : null;
  } catch {
    return null;
  }
}

export function mergeEventDetail(
  existing: GraphEvent,
  detail: GraphEvent
): GraphEvent {
  const merged = {
    ...existing,
    ...detail
  };
  if (detail.content === undefined && existing.content !== undefined) {
    merged.content = existing.content;
  }
  if (detail.contentFull === undefined && existing.contentFull !== undefined) {
    merged.contentFull = existing.contentFull;
  }
  return merged;
}

export function mergeThreadEvents(
  existingEvents: GraphEvent[],
  nextEvents: GraphEvent[]
): GraphEvent[] {
  const merged = new Map(existingEvents.map((event) => [event.id, event]));
  for (const event of nextEvents) {
    const existing = merged.get(event.id);
    merged.set(event.id, existing ? mergeEventDetail(existing, event) : event);
  }
  return [...merged.values()].sort(compareGraphEventChronology);
}

export function mergeGraphNodes(
  existingNodes: GraphNode[],
  nextNodes: GraphNode[]
): GraphNode[] {
  const merged = new Map(existingNodes.map((node) => [node.id, node]));
  for (const node of nextNodes) {
    const existing = merged.get(node.id);
    if (!existing) {
      merged.set(node.id, node);
      continue;
    }
    const existingUpdatedAt = Date.parse(existing.updatedAt);
    const nextUpdatedAt = Date.parse(node.updatedAt);
    const nextIsOlder =
      Number.isFinite(existingUpdatedAt) &&
      Number.isFinite(nextUpdatedAt) &&
      nextUpdatedAt < existingUpdatedAt;
    if (
      nextIsOlder ||
      (existing.summaryStatus === "summarized" &&
        node.summaryStatus === "pending")
    ) {
      continue;
    }
    merged.set(node.id, { ...existing, ...node });
  }
  return [...merged.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
}

function hasSelectedThreadContent(events: GraphEvent[]) {
  return events.some(
    (event) => event.content !== undefined || event.contentFull !== undefined
  );
}

export function useKoedMemoryGraph({
  apiToken,
  onMemoryQuestionUpdate,
  selectedThreadId,
  setToast
}: UseKoedMemoryGraphInput) {
  const [data, setData] = useState<AppData>({
    overview: null,
    projects: [],
    nodes: []
  });
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [cacheVersion, setCacheVersion] = useState(0);
  const refreshInFlight = useRef(false);
  const refreshPending = useRef(false);
  const refreshPendingSelectedThread = useRef(false);
  const detailCacheRef = useRef<ThreadDetailCache>(new Map());
  const prewarmQueueRef = useRef<ThreadGroup[]>([]);
  const activePrewarmRef = useRef(0);
  const activePrewarmKeysRef = useRef<Set<string>>(new Set());
  const olderPageInFlightKeysRef = useRef<Set<string>>(new Set());
  const selectedThreadKeyRef = useRef("");
  const selectedThreadDetailVersionRef = useRef("");
  const tokenScopeRef = useRef(apiToken.trim());
  const touchCache = useCallback(() => {
    setCacheVersion((version) => version + 1);
  }, []);

  const [threadIndex, setThreadIndex] = useState(emptyThreadIndex);
  const threadIndexRef = useRef<ThreadIndexState>(threadIndex);
  const projects = useMemo(
    () => selectProjectGroups(threadIndex),
    [threadIndex]
  );
  const selectedThread = useMemo(
    () => selectThread(threadIndex, selectedThreadId),
    [threadIndex, selectedThreadId]
  );
  const selectedCacheKey = selectedThread
    ? threadSelectionKey(selectedThread)
    : "";
  const selectedThreadShellVersion = threadShellVersion(selectedThread);
  const threadEvents = useMemo(
    () => getCachedThreadEvents(detailCacheRef.current, selectedThread),
    [cacheVersion, selectedThread]
  );
  const selectedCacheEntry = selectedThread
    ? detailCacheRef.current.get(selectedCacheKey)
    : undefined;
  const hasOlderThreadEvents = Boolean(
    selectedCacheEntry &&
    threadEvents.length > 0 &&
    !isCompleteThreadDetail(selectedCacheEntry)
  );
  const threadLoading =
    selectedCacheEntry?.status === "loading" && threadEvents.length === 0;

  useEffect(() => {
    selectedThreadKeyRef.current = selectedCacheKey;
  }, [selectedCacheKey]);

  useEffect(() => {
    threadIndexRef.current = threadIndex;
  }, [threadIndex]);

  useEffect(() => {
    setData((current) => ({ ...current, projects }));
  }, [projects]);

  useEffect(() => {
    const nextScope = apiToken.trim();
    if (tokenScopeRef.current === nextScope) {
      return;
    }
    tokenScopeRef.current = nextScope;
    detailCacheRef.current = new Map();
    prewarmQueueRef.current = [];
    activePrewarmKeysRef.current = new Set();
    olderPageInFlightKeysRef.current = new Set();
    selectedThreadKeyRef.current = "";
    selectedThreadDetailVersionRef.current = "";
    setSelectedEventId(null);
    const emptyIndex = emptyThreadIndex();
    threadIndexRef.current = emptyIndex;
    setThreadIndex(emptyIndex);
    setData({ overview: null, projects: [], nodes: [] });
    touchCache();
  }, [apiToken, touchCache]);

  const loadGraph = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!apiToken.trim()) {
        const emptyIndex = emptyThreadIndex();
        threadIndexRef.current = emptyIndex;
        setThreadIndex(emptyIndex);
        setData({ overview: null, projects: [], nodes: [] });
        setToast({
          tone: "destructive",
          message: "Add a Koed API token in settings to load memory history."
        });
        return;
      }
      if (!options?.silent) {
        setLoading(true);
      }
      const tokenScope = apiToken.trim();
      try {
        const nextData = await loadGraphData(apiToken);
        if (tokenScopeRef.current !== tokenScope) {
          return;
        }
        const nextIndex = ingestThreadIndex(
          threadIndexRef.current,
          nextData.projects
        );
        threadIndexRef.current = nextIndex;
        setThreadIndex(nextIndex);
        setData((current) => ({
          ...current,
          overview: nextData.overview,
          nodes:
            nextData.nodes.length > 0
              ? mergeGraphNodes(current.nodes, nextData.nodes)
              : current.nodes
        }));
        setToast(null);
        return nextIndex;
      } catch (error) {
        if (tokenScopeRef.current !== tokenScope) {
          return;
        }
        setToast({
          tone: "destructive",
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (!options?.silent) {
          setLoading(false);
        }
      }
    },
    [apiToken, setToast]
  );

  const writeSelectedThreadPage = useCallback(
    (
      thread: ThreadGroup,
      events: GraphEvent[],
      options: { complete: boolean; tokenScope: string }
    ) => {
      if (tokenScopeRef.current !== options.tokenScope) {
        return [];
      }
      const entry = markThreadAccessed(detailCacheRef.current, thread);
      const nextEvents = mergeThreadEvents(entry.events, events);
      koedDebug("thread.cache.writeSelectedPage", {
        threadId: thread.id,
        incomingEvents: events.length,
        previousEvents: entry.events.length,
        nextEvents: nextEvents.length,
        complete: options.complete,
        latestEventId: nextEvents.at(-1)?.id ?? null,
        latestTimestamp: nextEvents.at(-1)?.timestamp ?? null
      });
      writeThreadEvents(
        detailCacheRef.current,
        thread,
        nextEvents,
        Date.now(),
        options.complete ? "complete" : "partial",
        { inferComplete: options.complete }
      );
      setSelectedEventId((current) =>
        current && nextEvents.some((event) => event.id === current)
          ? current
          : (nextEvents.at(-1)?.id ?? null)
      );
      touchCache();
      return nextEvents;
    },
    [touchCache]
  );

  const applyLiveThreadShellEvents = useCallback(
    (thread: ThreadGroup, events: GraphEvent[]) => {
      if (events.length === 0) {
        return;
      }
      const nextIndex = applyThreadEventShellUpdates(
        threadIndexRef.current,
        thread,
        events
      );
      if (nextIndex === threadIndexRef.current) {
        return;
      }
      const key = threadKey(thread);
      const updatedThread = selectThread(nextIndex, key);
      const entry = detailCacheRef.current.get(key);
      if (updatedThread && entry) {
        entry.thread = updatedThread;
        if (key === selectedThreadKeyRef.current) {
          selectedThreadDetailVersionRef.current =
            threadShellVersion(updatedThread);
        }
      }
      threadIndexRef.current = nextIndex;
      setThreadIndex(nextIndex);
      koedDebug("stream.threadShellUpdated", {
        threadId: thread.id,
        events: events.length,
        latestEventId: events.at(-1)?.id ?? null
      });
    },
    []
  );

  const renameThread = useCallback((thread: ThreadGroup, name: string) => {
    const nextIndex = renameThreadShell(threadIndexRef.current, thread, name);
    if (nextIndex === threadIndexRef.current) {
      return;
    }
    const key = threadKey(thread);
    const updatedThread = selectThread(nextIndex, key);
    const entry = detailCacheRef.current.get(key);
    if (updatedThread && entry) {
      entry.thread = updatedThread;
      if (key === selectedThreadKeyRef.current) {
        selectedThreadDetailVersionRef.current =
          threadShellVersion(updatedThread);
      }
    }
    threadIndexRef.current = nextIndex;
    setThreadIndex(nextIndex);
  }, []);

  const ensureThreadDetail = useCallback(
    async (
      thread: ThreadGroup | undefined,
      options?: {
        force?: boolean;
        selected?: boolean;
        silent?: boolean;
        withNodes?: boolean;
      }
    ) => {
      if (!thread || !apiToken.trim()) {
        return [];
      }
      const now = Date.now();
      const tokenScope = tokenScopeRef.current;
      const requireComplete = false;
      const key = threadKey(thread);
      const entry = markThreadAccessed(detailCacheRef.current, thread, now);
      koedDebug("thread.ensure.start", {
        threadId: thread.id,
        selected: Boolean(options?.selected),
        force: Boolean(options?.force),
        withNodes: Boolean(options?.withNodes),
        status: entry.status,
        cachedEvents: entry.events.length,
        completeness: entry.completeness,
        inFlight: Boolean(entry.inFlight)
      });
      const selectedHasContent =
        !options?.selected || hasSelectedThreadContent(entry.events);
      if (
        !options?.force &&
        selectedHasContent &&
        isWarmThreadDetail(entry, now, { requireComplete })
      ) {
        if (options?.selected) {
          setSelectedEventId((current) =>
            current && entry.events.some((event) => event.id === current)
              ? current
              : (entry.events.at(-1)?.id ?? null)
          );
        }
        touchCache();
        koedDebug("thread.ensure.warmReturn", {
          threadId: thread.id,
          selected: Boolean(options?.selected),
          cachedEvents: entry.events.length
        });
        return entry.events;
      }

      if (entry.inFlight) {
        koedDebug("thread.ensure.awaitInFlight", {
          threadId: thread.id,
          selected: Boolean(options?.selected),
          inFlightCompleteness: entry.inFlightCompleteness
        });
        const inFlightCompleteness = entry.inFlightCompleteness;
        const events = await entry.inFlight;
        if (
          options?.selected
            ? hasSelectedThreadContent(events)
            : !requireComplete ||
              inFlightCompleteness === "complete" ||
              isCompleteThreadDetail(detailCacheRef.current.get(key))
        ) {
          return events;
        }
        if (tokenScopeRef.current !== tokenScope) {
          return events;
        }
      }

      const loadingEntry = markThreadAccessed(detailCacheRef.current, thread);
      const selectedLoadingHasContent =
        !options?.selected || hasSelectedThreadContent(loadingEntry.events);
      if (
        !options?.force &&
        selectedLoadingHasContent &&
        isWarmThreadDetail(loadingEntry, Date.now(), { requireComplete })
      ) {
        return loadingEntry.events;
      }

      loadingEntry.status = "loading";
      loadingEntry.error = undefined;
      loadingEntry.inFlightCompleteness = "partial";
      const preserveSelectedEvents =
        Boolean(options?.force && options?.selected) &&
        loadingEntry.events.length > 0;
      const existingEvents = preserveSelectedEvents
        ? [...loadingEntry.events]
        : [];
      const inFlight = loadThreadEvents(thread, apiToken, {
        full: false,
        ...(options?.selected ? { includeContent: true } : {}),
        ...(options?.selected ? { limit: selectedThreadHeadEventLimit } : {}),
        ...(!options?.selected ? { limit: prewarmThreadEventLimit } : {})
      })
        .then(async (events) => {
          if (tokenScopeRef.current !== tokenScope) {
            return events;
          }
          const nextEvents = preserveSelectedEvents
            ? mergeThreadEvents(existingEvents, events)
            : events;
          if (options?.selected) {
            writeSelectedThreadPage(thread, nextEvents, {
              complete: nextEvents.length >= thread.eventCount,
              tokenScope
            });
          } else {
            writeThreadEvents(
              detailCacheRef.current,
              thread,
              nextEvents,
              Date.now(),
              "partial"
            );
          }
          pruneThreadDetailCache(detailCacheRef.current, {
            protectedKeys: new Set([selectedThreadKeyRef.current])
          });
          touchCache();
          if (options?.withNodes) {
            void loadLinkedGraphNodes(events, apiToken)
              .then((nodes) => {
                if (
                  tokenScopeRef.current !== tokenScope ||
                  nodes.length === 0
                ) {
                  return;
                }
                setData((current) => ({
                  ...current,
                  nodes: mergeGraphNodes(current.nodes, nodes)
                }));
              })
              .catch(() => undefined);
          }
          return events;
        })
        .catch((error: unknown) => {
          if (tokenScopeRef.current !== tokenScope) {
            return [];
          }
          writeThreadError(detailCacheRef.current, thread, error);
          if (!options?.silent) {
            setToast({
              tone: "destructive",
              message: error instanceof Error ? error.message : String(error)
            });
          }
          return [];
        })
        .finally(() => {
          if (tokenScopeRef.current === tokenScope) {
            touchCache();
          }
        });
      loadingEntry.inFlight = inFlight;
      touchCache();
      return inFlight;
    },
    [apiToken, setToast, touchCache, writeSelectedThreadPage]
  );

  const loadOlderThreadEvents = useCallback(async () => {
    const selectedKey = selectedThreadKeyRef.current;
    if (!selectedKey || !apiToken.trim()) {
      return;
    }
    if (olderPageInFlightKeysRef.current.has(selectedKey)) {
      koedDebug("thread.olderPage.skipActive", {
        selectedThreadKey: selectedKey
      });
      return;
    }
    const entry = detailCacheRef.current.get(selectedKey);
    const selectedThread =
      selectThread(threadIndexRef.current, selectedKey) ?? entry?.thread;
    const oldestEvent = entry?.events.at(0);
    if (
      !selectedThread ||
      !entry ||
      !oldestEvent ||
      isCompleteThreadDetail(entry)
    ) {
      koedDebug("thread.olderPage.skipUnavailable", {
        selectedThreadKey: selectedKey,
        cachedEvents: entry?.events.length ?? 0,
        complete: isCompleteThreadDetail(entry)
      });
      return;
    }

    const tokenScope = tokenScopeRef.current;
    olderPageInFlightKeysRef.current.add(selectedKey);
    koedDebug("thread.olderPage.start", {
      threadId: selectedThread.id,
      beforeEventId: oldestEvent.id,
      cachedEvents: entry.events.length
    });
    try {
      const events = await loadThreadEvents(selectedThread, apiToken, {
        before: {
          id: oldestEvent.id,
          sourceSequence: oldestEvent.sourceSequence,
          timestamp: oldestEvent.timestamp
        },
        includeContent: true,
        limit: selectedThreadEventPageSize
      });
      if (tokenScopeRef.current !== tokenScope) {
        return;
      }
      const nextEvents = writeSelectedThreadPage(selectedThread, events, {
        complete: events.length === 0,
        tokenScope
      });
      koedDebug("thread.olderPage.end", {
        threadId: selectedThread.id,
        loadedEvents: events.length,
        cachedEvents: nextEvents.length
      });
      if (events.length > 0) {
        void loadLinkedGraphNodes(events, apiToken)
          .then((nodes) => {
            if (tokenScopeRef.current !== tokenScope || nodes.length === 0) {
              return;
            }
            setData((current) => ({
              ...current,
              nodes: mergeGraphNodes(current.nodes, nodes)
            }));
          })
          .catch(() => undefined);
      }
    } catch (error) {
      if (tokenScopeRef.current === tokenScope) {
        setToast({
          tone: "destructive",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      olderPageInFlightKeysRef.current.delete(selectedKey);
    }
  }, [apiToken, setToast, writeSelectedThreadPage]);

  const loadThread = useCallback(
    async (
      thread: ThreadGroup | undefined,
      options?: { force?: boolean; silent?: boolean }
    ) => {
      if (!thread || !apiToken.trim()) {
        setSelectedEventId(null);
        return;
      }
      await ensureThreadDetail(thread, {
        ...(options?.force === undefined ? {} : { force: options.force }),
        selected: true,
        ...(options?.silent === undefined ? {} : { silent: options.silent }),
        withNodes: true
      });
    },
    [apiToken, ensureThreadDetail]
  );

  const refreshStreamEvent = useCallback(
    async (
      eventId: string,
      options: { countShellEvent?: boolean } = {}
    ): Promise<StreamEventRefreshResult> => {
      if (!eventId || !apiToken.trim()) {
        return "failed";
      }
      const tokenScope = tokenScopeRef.current;
      try {
        const detail = await requestEventDetail(eventId, apiToken);
        if (tokenScopeRef.current !== tokenScope) {
          return "failed";
        }
        const event =
          detail.content === undefined && detail.rawContent !== undefined
            ? { ...detail, content: detail.rawContent }
            : detail;
        const eventProjectId = event.projectId ?? event.workspaceId;
        const eventThreadId = event.threadId ?? event.sessionId ?? event.id;
        if (!eventProjectId || !eventThreadId) {
          return "failed";
        }
        const eventThreadKey = threadSelectionKey({
          projectId: eventProjectId,
          id: eventThreadId
        });
        const selectedKey = selectedThreadKeyRef.current;
        if (!selectedKey || eventThreadKey !== selectedKey) {
          return "not-selected";
        }
        const entry = detailCacheRef.current.get(selectedKey);
        const selectedThread =
          selectThread(threadIndexRef.current, selectedKey) ?? entry?.thread;
        if (!selectedThread) {
          return "failed";
        }
        const existingEventIds = new Set(
          entry?.events.map((cachedEvent) => cachedEvent.id) ?? []
        );
        const liveShellEvents =
          options.countShellEvent === true && !existingEventIds.has(event.id)
            ? [event]
            : [];
        const wasComplete = isCompleteThreadDetail(entry);
        writeSelectedThreadPage(selectedThread, [event], {
          complete: wasComplete,
          tokenScope
        });
        applyLiveThreadShellEvents(selectedThread, liveShellEvents);
        koedDebug("stream.eventMerged", {
          eventId,
          selectedThreadKey: selectedKey,
          wasComplete
        });
        return "merged";
      } catch (error) {
        koedDebug("stream.eventMergeFailed", {
          eventId,
          error: error instanceof Error ? error.message : String(error)
        });
        return "failed";
      }
    },
    [apiToken, applyLiveThreadShellEvents, writeSelectedThreadPage]
  );

  const drainPrewarmQueue = useCallback(() => {
    while (
      activePrewarmRef.current < prewarmConcurrency &&
      prewarmQueueRef.current.length > 0
    ) {
      const thread = prewarmQueueRef.current.shift();
      if (!thread) {
        break;
      }
      const key = threadKey(thread);
      activePrewarmRef.current += 1;
      activePrewarmKeysRef.current.add(key);
      void ensureThreadDetail(thread, { silent: true })
        .catch(() => undefined)
        .finally(() => {
          activePrewarmRef.current -= 1;
          activePrewarmKeysRef.current.delete(key);
          drainPrewarmQueue();
        });
    }
  }, [ensureThreadDetail]);

  const prewarmThreads = useCallback(
    (threads: ThreadGroup[]) => {
      const nextQueue: ThreadGroup[] = [];
      const queuedKeys = new Set<string>();
      for (const thread of threads) {
        const key = threadKey(thread);
        const entry = detailCacheRef.current.get(key);
        if (
          key === selectedThreadKeyRef.current ||
          queuedKeys.has(key) ||
          activePrewarmKeysRef.current.has(key) ||
          entry?.inFlight ||
          isWarmThreadDetail(entry)
        ) {
          continue;
        }
        nextQueue.push(thread);
        queuedKeys.add(key);
        if (nextQueue.length >= prewarmQueueLimit) {
          break;
        }
      }
      prewarmQueueRef.current = nextQueue;
      drainPrewarmQueue();
    },
    [drainPrewarmQueue]
  );

  const loadEventDetail = useCallback(
    async (eventId: string) => {
      if (!eventId || !apiToken.trim()) {
        return;
      }
      const tokenScope = tokenScopeRef.current;
      const targetThreadKey = selectedThreadKeyRef.current;
      try {
        const detail = await requestEventDetail(eventId, apiToken);
        if (tokenScopeRef.current !== tokenScope) {
          return;
        }
        const entry = targetThreadKey
          ? detailCacheRef.current.get(targetThreadKey)
          : undefined;
        if (entry && entry.events.some((event) => event.id === detail.id)) {
          entry.events = entry.events.map((event) =>
            event.id === detail.id ? mergeEventDetail(event, detail) : event
          );
          entry.lastAccessedAt = Date.now();
          touchCache();
        }
      } catch (error) {
        if (tokenScopeRef.current !== tokenScope) {
          return;
        }
        setToast({
          tone: "destructive",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    },
    [apiToken, setToast, touchCache]
  );

  const refreshVisibleData = useCallback(
    async (options?: { refreshSelectedThread?: boolean; silent?: boolean }) => {
      if (refreshInFlight.current) {
        refreshPending.current = true;
        refreshPendingSelectedThread.current =
          refreshPendingSelectedThread.current ||
          options?.refreshSelectedThread !== false;
        koedDebug("refresh.queueInFlight", {
          selectedThreadKey: selectedThreadKeyRef.current,
          refreshSelectedThread: options?.refreshSelectedThread !== false
        });
        return;
      }
      refreshPending.current = false;
      refreshPendingSelectedThread.current = false;
      refreshInFlight.current = true;
      koedDebug("refresh.start", {
        selectedThreadKey: selectedThreadKeyRef.current,
        refreshSelectedThread: options?.refreshSelectedThread !== false,
        silent: Boolean(options?.silent)
      });
      try {
        const nextIndex = await koedDebugTimed(
          "refresh.loadGraph",
          { selectedThreadKey: selectedThreadKeyRef.current },
          () => loadGraph(options)
        );
        if (
          options?.refreshSelectedThread !== false &&
          selectedThreadKeyRef.current
        ) {
          const selected =
            selectThread(
              nextIndex ?? threadIndexRef.current,
              selectedThreadKeyRef.current
            ) ??
            detailCacheRef.current.get(selectedThreadKeyRef.current)?.thread;
          if (selected) {
            selectedThreadDetailVersionRef.current =
              threadShellVersion(selected);
            await koedDebugTimed(
              "refresh.ensureSelectedThread",
              {
                threadId: selected.id,
                eventCount: selected.eventCount
              },
              () =>
                ensureThreadDetail(selected, {
                  force: true,
                  selected: true,
                  silent: true,
                  withNodes: true
                })
            );
          }
        }
      } finally {
        koedDebug("refresh.end", {
          selectedThreadKey: selectedThreadKeyRef.current,
          queued: refreshPending.current,
          queuedRefreshSelectedThread: refreshPendingSelectedThread.current
        });
        refreshInFlight.current = false;
        if (refreshPending.current) {
          const queuedRefreshSelectedThread =
            refreshPendingSelectedThread.current;
          refreshPending.current = false;
          refreshPendingSelectedThread.current = false;
          koedDebug("refresh.runQueued", {
            selectedThreadKey: selectedThreadKeyRef.current,
            refreshSelectedThread: queuedRefreshSelectedThread
          });
          void refreshVisibleData({
            refreshSelectedThread: queuedRefreshSelectedThread,
            silent: true
          });
        }
      }
    },
    [ensureThreadDetail, loadGraph]
  );

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    if (selectedThreadDetailVersionRef.current === selectedThreadShellVersion) {
      return;
    }
    selectedThreadDetailVersionRef.current = selectedThreadShellVersion;
    void loadThread(selectedThread, { force: true });
  }, [loadThread, selectedThreadShellVersion]);

  useEffect(() => {
    if (!selectedThread) {
      setSelectedEventId(null);
    }
  }, [selectedThread]);

  useEffect(() => {
    return () => {
      prewarmQueueRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!apiToken.trim()) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    let retryTimeout: number | null = null;
    let refreshTimeout: number | null = null;
    const eventRetryTimeouts = new Set<number>();
    let scheduledRefreshSelectedThread = false;
    let scheduledRefreshReason = "shell";

    const runStreamEventBatch = async (
      events: Array<{ countShellEvent: boolean; id: string }>
    ): Promise<StreamEventRefreshResult[]> => {
      const results: StreamEventRefreshResult[] = [];
      for (
        let index = 0;
        index < events.length;
        index += streamEventDetailConcurrency
      ) {
        if (cancelled) {
          break;
        }
        const batch = events.slice(index, index + streamEventDetailConcurrency);
        results.push(
          ...(await Promise.all(
            batch.map((eventRef) =>
              refreshStreamEvent(eventRef.id, {
                countShellEvent: eventRef.countShellEvent
              })
            )
          ))
        );
      }
      return results;
    };

    const retryStreamEvents = (
      events: Array<{ countShellEvent: boolean; id: string }>,
      attempt = 1
    ) => {
      void runStreamEventBatch(events).then((results) => {
        if (cancelled) {
          return;
        }
        const failed = results.some((result) => result === "failed");
        const notSelected = results.some((result) => result === "not-selected");
        koedDebug("stream.eventsMerged", {
          attempt,
          eventIds: events.map((eventRef) => eventRef.id),
          results
        });
        if (failed && attempt < 3 && !cancelled) {
          const timeout = window.setTimeout(() => {
            eventRetryTimeouts.delete(timeout);
            if (!cancelled) {
              retryStreamEvents(events, attempt + 1);
            }
          }, 500 * attempt);
          eventRetryTimeouts.add(timeout);
          return;
        }
        if (failed) {
          scheduleRefresh({
            refreshSelectedThread: true,
            reason: "selected-event-fetch-failed"
          });
        } else if (notSelected) {
          scheduleRefresh({ reason: "legacy-event-not-selected" });
        }
      });
    };

    const scheduleRefresh = (options?: {
      delayMs?: number;
      refreshSelectedThread?: boolean;
      reason?: string;
    }) => {
      const refreshSelectedThread = options?.refreshSelectedThread ?? false;
      if (refreshTimeout !== null) {
        scheduledRefreshSelectedThread =
          scheduledRefreshSelectedThread || refreshSelectedThread;
        scheduledRefreshReason = [
          scheduledRefreshReason,
          options?.reason ?? "shell"
        ]
          .filter(Boolean)
          .join(",");
        koedDebug("stream.refreshAlreadyScheduled", {
          refreshSelectedThread: scheduledRefreshSelectedThread,
          reason: scheduledRefreshReason
        });
        return;
      }
      const delayMs = options?.delayMs ?? 750;
      scheduledRefreshSelectedThread = refreshSelectedThread;
      scheduledRefreshReason = options?.reason ?? "shell";
      koedDebug("stream.refreshScheduled", {
        delayMs,
        reason: scheduledRefreshReason,
        refreshSelectedThread: scheduledRefreshSelectedThread
      });
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        const refreshSelectedThread = scheduledRefreshSelectedThread;
        const reason = scheduledRefreshReason;
        scheduledRefreshSelectedThread = false;
        scheduledRefreshReason = "shell";
        koedDebug("stream.refreshTimerFired", {
          reason,
          refreshSelectedThread
        });
        void refreshVisibleData({
          refreshSelectedThread,
          silent: true
        });
      }, delayMs);
    };

    const connect = async () => {
      try {
        const streamUrl = `${apiBaseUrl}/v1/memory/graph/stream`;
        const streamHeaders = {
          ...requestHeaders(apiToken),
          accept: "text/event-stream"
        };
        let response = await fetch(streamUrl, {
          credentials: "include",
          headers: streamHeaders,
          signal: controller.signal
        });
        if (
          (response.status === 401 || response.status === 403) &&
          apiToken.trim()
        ) {
          response = await fetch(streamUrl, {
            credentials: "include",
            headers: { accept: "text/event-stream" },
            signal: controller.signal
          });
        }
        if (response.status === 401 || response.status === 403) {
          setToast({
            tone: "destructive",
            message:
              "Koed API token is missing or invalid. Update it in settings."
          });
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Graph stream failed with ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        onMemoryQuestionUpdate?.({ table: "memory_questions" });

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
            if (eventName === "graph_update") {
              const payload = parseGraphUpdateFrame(frame);
              koedDebug("stream.graphUpdate", { frame, payload });
              if (payload?.table === "memory_questions") {
                onMemoryQuestionUpdate?.(payload);
                boundary = buffer.indexOf("\n\n");
                continue;
              }
              const selectedKey = selectedThreadKeyRef.current;
              const eventRefs = Array.isArray(payload?.eventRefs)
                ? payload.eventRefs.filter(isStreamEventRef)
                : payload?.table === "memory_events" &&
                    typeof payload.id === "string" &&
                    typeof payload.projectId === "string" &&
                    typeof payload.threadId === "string" &&
                    payload.operation !== "DELETE"
                  ? [
                      {
                        id: payload.id,
                        operation:
                          typeof payload.operation === "string"
                            ? payload.operation
                            : undefined,
                        projectId: payload.projectId,
                        threadId: payload.threadId
                      }
                    ]
                  : [];
              if (document.visibilityState !== "visible") {
                boundary = buffer.indexOf("\n\n");
                continue;
              }
              const hasNonSelectedEventRefs = eventRefs.some(
                (eventRef) =>
                  !selectedKey ||
                  threadSelectionKey({
                    projectId: eventRef.projectId,
                    id: eventRef.threadId
                  }) !== selectedKey
              );
              const selectedEventIds = eventRefs
                .filter(
                  (eventRef) =>
                    selectedKey &&
                    threadSelectionKey({
                      projectId: eventRef.projectId,
                      id: eventRef.threadId
                    }) === selectedKey
                )
                .map((eventRef) => ({
                  countShellEvent:
                    (eventRef.operation ?? payload?.operation) === "INSERT",
                  id: eventRef.id
                }));
              const eventIds: Array<{
                countShellEvent: boolean;
                id: string;
              }> =
                selectedEventIds.length > 0
                  ? selectedEventIds
                  : !payload?.eventRefs &&
                      payload?.table === "memory_events" &&
                      typeof payload.id === "string" &&
                      payload.operation !== "DELETE"
                    ? [
                        {
                          countShellEvent: payload.operation === "INSERT",
                          id: payload.id
                        }
                      ]
                    : [];
              if (eventIds.length > 0) {
                retryStreamEvents(eventIds);
                if (hasNonSelectedEventRefs) {
                  scheduleRefresh({ reason: "mixed-event-refs" });
                }
              } else if (
                !payload?.eventRefs &&
                payload?.table === "memory_events" &&
                payload.operation !== "DELETE"
              ) {
                retryStreamEvents([
                  {
                    countShellEvent: payload.operation === "INSERT",
                    id: String(payload.id ?? "")
                  }
                ]);
              } else if (payload?.table === "memory_embeddings") {
                koedDebug("stream.graphUpdateIgnored", {
                  reason: "embedding-index-update"
                });
              } else {
                scheduleRefresh({
                  reason:
                    payload?.table === "memory_events"
                      ? "non-selected-event"
                      : "non-event-graph-update"
                });
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }
        if (!cancelled && !controller.signal.aborted) {
          retryTimeout = window.setTimeout(() => {
            void connect();
          }, 1500);
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) {
          return;
        }
        setToast({
          tone: "destructive",
          message: error instanceof Error ? error.message : String(error)
        });
        retryTimeout = window.setTimeout(() => {
          void connect();
        }, 1500);
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        const refreshSelectedThread = Boolean(selectedThreadKeyRef.current);
        const silent = true;
        void refreshVisibleData({
          refreshSelectedThread,
          silent
        });
        onMemoryQuestionUpdate?.({ table: "memory_questions" });
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
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      for (const timeout of eventRetryTimeouts) {
        window.clearTimeout(timeout);
      }
      eventRetryTimeouts.clear();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [
    apiToken,
    loadGraph,
    onMemoryQuestionUpdate,
    refreshStreamEvent,
    refreshVisibleData,
    setToast
  ]);

  return {
    data,
    loadEventDetail,
    loadGraph,
    hasOlderThreadEvents,
    loadOlderThreadEvents,
    loading,
    prewarmThreads,
    renameThread,
    selectedEventId,
    selectedThread,
    setSelectedEventId,
    threadEvents,
    threadLoading
  };
}
