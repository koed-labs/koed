// @vitest-environment happy-dom

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadGraphData, loadLinkedGraphNodes, loadThreadEvents } from "./api";
import { KoedMessage, MemoryQuestionDetail } from "./components";
import {
  buildProjectGroups,
  eventActorLabel,
  eventDisplayText,
  threadSelectionKey
} from "./graph";
import {
  filterMemoryQuestions,
  groupMemoryQuestions
} from "./memoryQuestionIndex";
import { memoryQuestionPreview } from "./memory";
import {
  buildMemoryQuestionInput,
  selectedThreadSessionIdentifier
} from "./memoryQuestionInput";
import {
  isFinalQuestionDetail,
  useKoedMemoryQuestions
} from "./useKoedMemoryQuestions";
import type {
  GraphEvent,
  GraphNode,
  MemoryQuestionRecord,
  ProjectGroup,
  ThreadGroup,
  ToastState
} from "./types";
import {
  isWarmThreadDetail,
  markThreadAccessed,
  prewarmNearbyRadius,
  prewarmQueueLimit,
  prewarmThreadLimit,
  pruneThreadDetailCache,
  threadDetailCacheLimit,
  threadKey,
  writeThreadEvents,
  type ThreadDetailCache
} from "./threadDetailCache";
import {
  applyThreadEventShellUpdates,
  emptyThreadIndex,
  ingestThreadIndex,
  nearbyThreadCandidates,
  renameThreadShell,
  selectProjectGroups,
  selectThread,
  visiblePrewarmCandidates
} from "./threadIndex";
import {
  mergeEventDetail,
  mergeGraphNodes,
  mergeThreadEvents,
  useKoedMemoryGraph
} from "./useKoedMemoryGraph";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const makeThread = (project: ProjectGroup, index: number): ThreadGroup => ({
  eventCount: 8,
  id: `thread-${project.id}-${index}`,
  invalidatedCount: 0,
  latestAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  name: `Thread ${project.id} ${index}`,
  projectId: project.id,
  projectName: project.name,
  sample: `Thread ${index} sample`
});

const makeProjects = (projectCount: number, threadsPerProject: number) =>
  Array.from({ length: projectCount }, (_, projectIndex) => {
    const project: ProjectGroup = {
      eventCount: threadsPerProject * 8,
      id: `project-${projectIndex}`,
      name: `Project ${projectIndex}`,
      path: `/tmp/project-${projectIndex}`,
      threads: []
    };
    project.threads = Array.from({ length: threadsPerProject }, (_, index) =>
      makeThread(project, index)
    );
    return project;
  });

const makeEvent = (
  thread: ThreadGroup,
  index: number,
  overrides: Partial<GraphEvent> = {}
): GraphEvent => ({
  actor: index % 2 === 0 ? "user" : "assistant",
  captureMethod: "transcript",
  contentPreview: `event ${index}`,
  eventType: "captured",
  id: `${threadKey(thread)}-event-${index}`,
  invalidatedAt: null,
  invalidationReason: null,
  linkedNodeIds: [],
  metadata: {},
  model: "gpt-test",
  projectId: thread.projectId,
  projectName: thread.projectName,
  projectPath: `/tmp/${thread.projectId}`,
  rawContent: `full event ${index}`,
  sessionId: null,
  sourceRuntime: "codex-cli",
  threadId: thread.id,
  threadName: thread.name,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  sourceEventTime: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  sourceSequence: index,
  capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  visibility: "personal",
  ...overrides
});

const makeQuestion = (
  id: string,
  overrides: Partial<MemoryQuestionRecord>
): MemoryQuestionRecord => ({
  createdAt: "2026-01-01T00:00:00.000Z",
  id,
  query: `Question ${id}`,
  retrievalScope: "personal",
  searchDomain: "global",
  status: "answered",
  ...overrides
});

describe("KOE-103 performance architecture", () => {
  it("normalizes a large shell index without loading thread detail", () => {
    const projects = makeProjects(200, 50);
    const start = performance.now();
    const state = ingestThreadIndex(emptyThreadIndex(), projects);
    const duration = performance.now() - start;
    const selected = selectThread(state, "project-42:thread-project-42-25");
    const derived = selectProjectGroups(state);

    expect(duration).toBeLessThan(1000);
    expect(derived).toHaveLength(200);
    expect(derived[42]?.threads).toHaveLength(50);
    expect(selected?.projectId).toBe("project-42");
    expect(selected?.id).toBe("thread-project-42-25");
  });

  it("keeps derived thread references stable across unchanged shell refreshes", () => {
    const projects = makeProjects(5, 5);
    const state = ingestThreadIndex(emptyThreadIndex(), projects);
    const selected = selectThread(state, "project-2:thread-project-2-3");
    const derived = selectProjectGroups(state);
    const refreshed = ingestThreadIndex(state, structuredClone(projects));

    expect(refreshed).toBe(state);
    expect(selectThread(refreshed, "project-2:thread-project-2-3")).toBe(
      selected
    );
    expect(selectProjectGroups(refreshed)).toEqual(derived);
  });

  it("updates selected thread shell metadata locally for live events", () => {
    const [project] = makeProjects(1, 1);
    const thread = project!.threads[0]!;
    const state = ingestThreadIndex(emptyThreadIndex(), [project!]);
    const liveEvent = {
      ...makeEvent(thread, 9),
      contentPreview: "new live event",
      timestamp: "2026-01-01T00:00:09.000Z"
    };

    const updated = applyThreadEventShellUpdates(state, thread, [liveEvent]);
    const updatedThread = selectThread(updated, threadSelectionKey(thread));
    const [updatedProject] = selectProjectGroups(updated);

    expect(updated).not.toBe(state);
    expect(updatedThread?.eventCount).toBe(thread.eventCount + 1);
    expect(updatedThread?.latestAt).toBe(liveEvent.timestamp);
    expect(updatedThread?.sample).toBe("new live event");
    expect(updatedProject?.eventCount).toBe(project!.eventCount + 1);
  });

  it("reorders live-updated threads and ignores duplicate shell events", () => {
    const [project] = makeProjects(1, 2);
    const olderThread = project!.threads[0]!;
    const newerThread = project!.threads[1]!;
    const state = ingestThreadIndex(emptyThreadIndex(), [project!]);
    const liveEvent = {
      ...makeEvent(olderThread, 9),
      id: "live-duplicate",
      timestamp: "2026-01-01T00:02:00.000Z"
    };

    const updated = applyThreadEventShellUpdates(state, olderThread, [
      liveEvent,
      liveEvent
    ]);
    const [updatedProject] = selectProjectGroups(updated);
    const updatedThread = selectThread(
      updated,
      threadSelectionKey(olderThread)
    );

    expect(updatedProject?.threads.map((thread) => thread.id)).toEqual([
      olderThread.id,
      newerThread.id
    ]);
    expect(updatedThread?.eventCount).toBe(olderThread.eventCount + 1);
    expect(updatedProject?.eventCount).toBe(project!.eventCount + 1);
  });

  it("bounds visible and nearby prewarm candidates", () => {
    const projects = makeProjects(4, 20);
    const selected = projects[1]!.threads[10]!;
    const visible = visiblePrewarmCandidates(
      projects,
      selected,
      prewarmThreadLimit
    );
    const nearby = nearbyThreadCandidates(
      projects,
      selected,
      prewarmNearbyRadius
    );

    expect(visible).toHaveLength(10);
    expect(nearby.map((thread) => thread.id)).toEqual([
      "thread-project-1-8",
      "thread-project-1-9",
      "thread-project-1-11",
      "thread-project-1-12"
    ]);
    expect([...visible, ...nearby]).not.toContain(selected);
    expect([...visible, ...nearby]).toHaveLength(
      prewarmThreadLimit + prewarmNearbyRadius * 2
    );
    expect(prewarmQueueLimit).toBeGreaterThanOrEqual(
      prewarmThreadLimit + prewarmNearbyRadius * 2
    );
  });

  it("retains prewarmed detail but prunes to a bounded warm cache", () => {
    const [project] = makeProjects(1, threadDetailCacheLimit + 8);
    const cache: ThreadDetailCache = new Map();
    const protectedThread = project!.threads[5]!;

    for (const [index, thread] of project!.threads.entries()) {
      markThreadAccessed(cache, thread, index);
      writeThreadEvents(cache, thread, [makeEvent(thread, 0)], index);
    }

    pruneThreadDetailCache(cache, {
      now: 20 * 60 * 1000,
      protectedKeys: new Set([threadKey(protectedThread)])
    });

    expect(cache.size).toBeLessThanOrEqual(threadDetailCacheLimit);
    expect(cache.has(threadKey(protectedThread))).toBe(true);
  });

  it("groups persisted questions by global, project, and session scope", () => {
    const questions = [
      makeQuestion("global-1", { searchDomain: "global" }),
      makeQuestion("project-1", {
        searchDomain: "project",
        projectId: "workspace-1",
        projectName: "Project One"
      }),
      makeQuestion("session-1", {
        searchDomain: "session",
        projectId: "workspace-1",
        projectName: "Project One",
        sessionId: "11111111-1111-4111-8111-111111111111",
        threadName: "Session One"
      }),
      makeQuestion("session-2", {
        searchDomain: "session",
        projectId: "workspace-1",
        projectName: "Project One",
        sessionId: "11111111-1111-4111-8111-111111111111",
        threadName: "Session One"
      })
    ];

    const grouped = groupMemoryQuestions(questions);

    expect(grouped.global.map((question) => question.id)).toEqual(["global-1"]);
    expect(grouped.projects).toHaveLength(1);
    expect(grouped.projects[0]?.projectQuestions.map((q) => q.id)).toEqual([
      "project-1"
    ]);
    expect(grouped.projects[0]?.sessions).toHaveLength(1);
    expect(
      grouped.projects[0]?.sessions[0]?.questions.map((q) => q.id)
    ).toEqual(["session-1", "session-2"]);
  });

  it("filters question shells without loading hydrated detail", () => {
    const questions = [
      makeQuestion("rate-limit", {
        query: "How did we tune rate limits?",
        answerPreview: "Use the documented read and write limits."
      }),
      makeQuestion("other", {
        query: "Where is the browser?",
        answerPreview: "The explorer is in the web app."
      })
    ];

    expect(
      filterMemoryQuestions(questions, "documented").map(
        (question) => question.id
      )
    ).toEqual(["rate-limit"]);
  });

  it("does not treat pending question detail as a final warm cache entry", () => {
    expect(
      isFinalQuestionDetail(
        makeQuestion("pending", {
          answerMarkdown: null,
          status: "pending"
        })
      )
    ).toBe(false);
    expect(
      isFinalQuestionDetail(
        makeQuestion("error", {
          errorMessage: "Local MCP bridge failed.",
          status: "error"
        })
      )
    ).toBe(true);
  });

  it("accepts a final question detail over a newer pending refresh", async () => {
    const pendingQuestion = makeQuestion("question-1", {
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "pending",
      updatedAt: "2026-01-01T00:00:03.000Z"
    });
    const answeredQuestion = makeQuestion("question-1", {
      answerMarkdown: "The selected answer landed.",
      answerPreview: "The selected answer landed.",
      status: "answered",
      updatedAt: "2026-01-01T00:00:02.000Z"
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions?")) {
        return jsonResponse({ questions: [pendingQuestion] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryQuestions({
        apiToken: "token",
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => latestState?.questions[0]?.status === "pending");

      await act(async () => {
        latestState?.upsertQuestion(answeredQuestion);
      });

      expect(latestState?.questions[0]).toMatchObject({
        answerMarkdown: "The selected answer landed.",
        status: "answered"
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("keeps retryable question fallback evidence out of visible answer text", async () => {
    const fallbackText =
      "Evidence bundle returned for Codex synthesis, but Codex failed.";
    const question = makeQuestion("retry", {
      answerMarkdown: fallbackText,
      answerPreview: fallbackText,
      lastErrorMessage: "Codex unavailable",
      localMemoryWorker: {
        usedFallback: true,
        skippedReason: "codex_failed"
      },
      response: {
        markdown: fallbackText,
        localMemoryWorker: {
          usedFallback: true,
          skippedReason: "codex_failed"
        }
      },
      status: "pending"
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      expect(memoryQuestionPreview(question)).toBe("Still working...");
      await act(async () => {
        root.render(createElement(MemoryQuestionDetail, { question }));
      });

      expect(container.textContent).toContain("Searching memory");
      expect(container.textContent).not.toContain("local worker");
      expect(container.textContent).not.toContain("Retrying");
      expect(container.textContent).not.toContain(fallbackText);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("hydrates a streamed question update without reloading question shells", async () => {
    const pendingQuestion = makeQuestion("question-1", {
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "pending",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const answeredQuestion = makeQuestion("question-1", {
      answerMarkdown: "Use the local MCP bridge.",
      answerPreview: "Use the local MCP bridge.",
      status: "answered",
      updatedAt: "2026-01-01T00:00:02.000Z"
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.includes("/v1/memory/questions?")) {
          return jsonResponse({ questions: [pendingQuestion] });
        }
        if (url.includes("/v1/memory/questions/question-1")) {
          return jsonResponse({ question: answeredQuestion });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryQuestions({
        apiToken: "token",
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => latestState?.questions[0]?.status === "pending");
      fetchMock.mockClear();

      await act(async () => {
        latestState?.refreshQuestionFromStream({
          id: "question-1",
          operation: "UPDATE",
          table: "memory_questions"
        });
      });
      await waitFor(() => latestState?.questions[0]?.status === "answered");

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        urls.filter((url) => url.includes("/v1/memory/questions/question-1"))
      ).toHaveLength(1);
      expect(urls.some((url) => url.includes("/v1/memory/questions?"))).toBe(
        false
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("retries a streamed pending question detail until the answer is visible", async () => {
    const pendingQuestion = makeQuestion("question-1", {
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "pending",
      updatedAt: "2026-01-01T00:00:01.000Z"
    });
    const claimedQuestion = makeQuestion("question-1", {
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "pending",
      updatedAt: "2026-01-01T00:00:02.000Z"
    });
    const answeredQuestion = makeQuestion("question-1", {
      answerMarkdown: "The MCP answer is ready.",
      answerPreview: "The MCP answer is ready.",
      status: "answered",
      updatedAt: "2026-01-01T00:00:03.000Z"
    });
    let detailLoads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions?")) {
        return jsonResponse({ questions: [pendingQuestion] });
      }
      if (url.includes("/v1/memory/questions/question-1")) {
        detailLoads += 1;
        return jsonResponse({
          question: detailLoads === 1 ? claimedQuestion : answeredQuestion
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryQuestions({
        apiToken: "token",
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => latestState?.questions[0]?.status === "pending");
      fetchMock.mockClear();

      await act(async () => {
        latestState?.refreshQuestionFromStream({
          id: "question-1",
          operation: "UPDATE",
          table: "memory_questions"
        });
      });
      await waitFor(() => latestState?.questions[0]?.status === "answered");

      expect(detailLoads).toBe(2);
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/v1/memory/questions?")
        )
      ).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("uses only questionIds from coalesced event stream payloads", async () => {
    const pendingQuestion = makeQuestion("question-1", {
      status: "pending"
    });
    const updatedQuestion = makeQuestion("question-1", {
      answerMarkdown: "The related event update refreshed this question.",
      answerPreview: "The related event update refreshed this question.",
      status: "answered",
      updatedAt: "2026-01-01T00:00:02.000Z"
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions?")) {
        return jsonResponse({ questions: [pendingQuestion] });
      }
      if (url.includes("/v1/memory/questions/question-1")) {
        return jsonResponse({ question: updatedQuestion });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryQuestions({
        apiToken: "token",
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => latestState?.questions[0]?.status === "pending");
      fetchMock.mockClear();

      await act(async () => {
        latestState?.refreshQuestionFromStream({
          coalesced: true,
          id: "event-1",
          operation: "UPDATE",
          questionIds: ["question-1"],
          table: "memory_events"
        });
      });
      await waitFor(() => latestState?.questions[0]?.status === "answered");

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        urls.filter((url) => url.includes("/v1/memory/questions/question-1"))
      ).toHaveLength(1);
      expect(
        urls.some((url) => url.includes("/v1/memory/questions/event-1"))
      ).toBe(false);
      expect(urls.some((url) => url.includes("/v1/memory/questions?"))).toBe(
        false
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("falls back to shell refresh for coalesced question deletes", async () => {
    const questions = [
      makeQuestion("question-1", { status: "answered" }),
      makeQuestion("question-2", { status: "answered" })
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions?")) {
        return jsonResponse({ questions });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryQuestions({
        apiToken: "token",
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => latestState?.questions.length === 2);
      fetchMock.mockClear();

      await act(async () => {
        latestState?.refreshQuestionFromStream({
          coalesced: true,
          operation: "DELETE",
          questionIds: ["question-1", "question-2"],
          table: "memory_questions"
        });
      });
      await waitFor(() => fetchMock.mock.calls.length === 1);

      expect(latestState?.questions.map((question) => question.id)).toEqual([
        "question-1",
        "question-2"
      ]);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
        "/v1/memory/questions?"
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("does not apply stale question shell loads after token changes", async () => {
    const firstLoad = deferredResponse();
    const secondLoad = deferredResponse();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions?")) {
        return fetchMock.mock.calls.length === 1
          ? firstLoad.promise
          : secondLoad.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness({ token }: { token: string }) {
      const state = useKoedMemoryQuestions({ apiToken: token, setToast });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness, { token: "token-a" }));
      });
      await waitFor(() => fetchMock.mock.calls.length === 1);
      await act(async () => {
        root.render(createElement(Harness, { token: "token-b" }));
      });
      await waitFor(() => fetchMock.mock.calls.length === 2);

      await act(async () => {
        secondLoad.resolve(
          jsonResponse({ questions: [makeQuestion("new", {})] })
        );
        await secondLoad.promise;
      });
      await waitFor(() => latestState?.questions[0]?.id === "new");

      await act(async () => {
        firstLoad.resolve(
          jsonResponse({ questions: [makeQuestion("old", {})] })
        );
        await firstLoad.promise;
      });

      expect(latestState?.questions.map((question) => question.id)).toEqual([
        "new"
      ]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("clears question shells when the current token reload fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions?")) {
        return fetchMock.mock.calls.length === 1
          ? Promise.resolve(
              jsonResponse({ questions: [makeQuestion("loaded", {})] })
            )
          : Promise.reject(new Error("Unauthorized"));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryQuestions({
        apiToken: "token",
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => latestState?.questions[0]?.id === "loaded");

      await act(async () => {
        await latestState?.loadQuestions();
      });

      expect(latestState?.questions).toEqual([]);
      expect(setToast).toHaveBeenCalledWith({
        tone: "destructive",
        message: "Unauthorized"
      });
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("does not upsert stale question detail after token changes", async () => {
    const detailLoad = deferredResponse();
    let shellLoadCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/questions/question-1")) {
        return detailLoad.promise;
      }
      if (url.includes("/v1/memory/questions?")) {
        shellLoadCount += 1;
        return Promise.resolve(
          jsonResponse({
            questions: [
              makeQuestion(shellLoadCount === 1 ? "question-1" : "fresh", {
                status: "pending"
              })
            ]
          })
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryQuestions> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness({ token }: { token: string }) {
      const state = useKoedMemoryQuestions({ apiToken: token, setToast });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness, { token: "token-a" }));
      });
      await waitFor(() => latestState?.questions[0]?.id === "question-1");

      void latestState?.loadQuestionDetail("question-1");
      await waitFor(() =>
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/v1/memory/questions/question-1")
        )
      );

      await act(async () => {
        root.render(createElement(Harness, { token: "token-b" }));
      });
      await waitFor(() => latestState?.questions[0]?.id === "fresh");

      await act(async () => {
        detailLoad.resolve(
          jsonResponse({
            question: makeQuestion("question-1", {
              answerMarkdown: "Old token detail",
              status: "answered",
              updatedAt: "2026-01-01T00:00:02.000Z"
            })
          })
        );
        await detailLoad.promise;
      });

      expect(latestState?.questions.map((question) => question.id)).toEqual([
        "fresh"
      ]);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("preserves captured session ids on thread shells", () => {
    const thread = makeProjects(1, 1)[0]!.threads[0]!;
    const [group] = buildProjectGroups([
      {
        ...makeEvent(thread, 0),
        sessionId: "11111111-1111-4111-8111-111111111111",
        threadId: "codex-thread-1"
      }
    ]);

    expect(group?.threads[0]).toMatchObject({
      id: "codex-thread-1",
      sessionId: "11111111-1111-4111-8111-111111111111"
    });
  });

  it("renames thread shells without mutating the existing index", () => {
    const [project] = makeProjects(1, 2);
    const original = ingestThreadIndex(emptyThreadIndex(), [project!]);
    const thread = project!.threads[0]!;

    const renamed = renameThreadShell(original, thread, "Manual Rename Wins");

    expect(renamed).not.toBe(original);
    expect(selectThread(renamed, threadSelectionKey(thread))).toMatchObject({
      id: thread.id,
      name: "Manual Rename Wins"
    });
    expect(selectProjectGroups(renamed)[0]?.threads[0]).toMatchObject({
      id: thread.id,
      name: "Manual Rename Wins"
    });
    expect(selectThread(original, threadSelectionKey(thread))).toMatchObject({
      id: thread.id,
      name: thread.name
    });
  });

  it("keeps session-scoped question inputs anchored to their project", () => {
    const thread = {
      ...makeProjects(1, 1)[0]!.threads[0]!,
      projectId: "workspace-1",
      projectName: "Workspace One",
      projectPath: "/tmp/workspace-1",
      sessionId: null
    };
    const input = buildMemoryQuestionInput({
      query: "What changed in this session?",
      retrievalScope: "personal",
      searchDomain: "session",
      selectedThread: thread
    });

    expect(selectedThreadSessionIdentifier(thread)).toBe(thread.id);
    expect(input).toMatchObject({
      projectName: "Workspace One",
      projectPath: "/tmp/workspace-1",
      searchDomain: "session",
      sessionId: thread.id,
      threadId: thread.id,
      threadName: thread.name,
      projectId: "workspace-1"
    });
  });

  it("distinguishes partial prewarm detail from complete selected detail", () => {
    const [project] = makeProjects(1, 1);
    const thread = { ...project!.threads[0]!, eventCount: 120 };
    const cache: ThreadDetailCache = new Map();

    const prewarmEntry = writeThreadEvents(
      cache,
      thread,
      Array.from({ length: 80 }, (_, index) => makeEvent(thread, index)),
      Date.now(),
      "partial"
    );
    expect(isWarmThreadDetail(prewarmEntry)).toBe(true);
    expect(
      isWarmThreadDetail(prewarmEntry, Date.now(), { requireComplete: true })
    ).toBe(false);

    const completeEntry = writeThreadEvents(
      cache,
      thread,
      Array.from({ length: 120 }, (_, index) => makeEvent(thread, index)),
      Date.now(),
      "complete"
    );
    expect(
      isWarmThreadDetail(completeEntry, Date.now(), { requireComplete: true })
    ).toBe(true);
  });

  it("smokes shell paging and selected detail cursor loading without global detail fetches", async () => {
    const [project] = makeProjects(1, 501);
    const selectedThread = { ...project!.threads[0]!, eventCount: 3 };
    const firstEvent = makeEvent(selectedThread, 0);
    const secondEvent = makeEvent(selectedThread, 1);
    const thirdEvent = {
      ...makeEvent(selectedThread, 2),
      linkedNodeIds: ["node-1"]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return jsonResponse({ error: "stream disabled in test" }, 401);
      }
      if (url.includes("/v1/memory/graph/threads")) {
        const request = new URL(url);
        const offset = Number(request.searchParams.get("offset") ?? 0);
        const pageThreads = project!.threads.slice(offset, offset + 500);
        return jsonResponse({
          projects:
            pageThreads.length > 0
              ? [
                  {
                    ...project!,
                    eventCount: pageThreads.length,
                    threads: pageThreads
                  }
                ]
              : []
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        const request = new URL(url);
        const cursorId = request.searchParams.get("cursorId");
        if (request.searchParams.get("limit") === "3") {
          return jsonResponse({
            events: [firstEvent, secondEvent, thirdEvent]
          });
        }
        if (!cursorId) {
          return jsonResponse({ events: [firstEvent, secondEvent] });
        }
        if (cursorId === secondEvent.id) {
          return jsonResponse({ events: [thirdEvent] });
        }
        return jsonResponse({ events: [] });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        const request = new URL(url);
        expect(request.searchParams.get("ids")).toBe("node-1");
        return jsonResponse({
          nodes: [
            {
              createdAt: "2026-01-01T00:00:00.000Z",
              depth: 0,
              embeddingCount: 1,
              id: "node-1",
              invalidatedAt: null,
              invalidationReason: null,
              kind: "leaf",
              lcmAlgorithmVersion: null,
              projectId: selectedThread.projectId,
              projectName: selectedThread.projectName,
              projectPath: null,
              sessionId: null,
              sourceEventCount: 1,
              sourceTokenEstimate: null,
              summaryModel: null,
              summaryPromptVersion: null,
              summaryStatus: "summarized",
              summaryText: "Linked node",
              summaryTokenEstimate: null,
              threadId: selectedThread.id,
              threadName: selectedThread.name,
              updatedAt: "2026-01-01T00:00:00.000Z",
              visibility: "personal"
            }
          ]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const graph = await loadGraphData("token");
    const events = await loadThreadEvents(selectedThread, "token", {
      full: true,
      limit: 2
    });
    const nodes = await loadLinkedGraphNodes(events, "token");
    const urls = fetchMock.mock.calls.map(([input]) => String(input));

    expect(graph.projects.flatMap((item) => item.threads)).toHaveLength(501);
    expect(events.map((event) => event.id)).toEqual([
      firstEvent.id,
      secondEvent.id,
      thirdEvent.id
    ]);
    expect(urls.some((url) => url.includes("cursorSourceSequence=1"))).toBe(
      true
    );
    expect(nodes).toHaveLength(1);
    expect(urls.some((url) => url.includes("/v1/memory/graph/nodes?"))).toBe(
      true
    );
    expect(
      urls.some((url) => url.includes("/v1/memory/graph/nodes/node-1"))
    ).toBe(false);
    expect(
      urls.some(
        (url) =>
          url.includes("/v1/memory/graph/events?") &&
          url.includes(`cursorId=${encodeURIComponent(secondEvent.id)}`)
      )
    ).toBe(true);
  });

  it("connects the graph stream with browser credentials and bearer auth", async () => {
    const [project] = makeProjects(1, 1);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        const url = String(input);
        if (url.includes("/v1/memory/graph/stream")) {
          return jsonResponse({ error: "stream disabled in test" }, 401);
        }
        if (url.includes("/v1/memory/graph/threads")) {
          return jsonResponse({ projects: [project] });
        }
        if (url.includes("/v1/memory/questions")) {
          return jsonResponse({ questions: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId: "",
        setToast
      });
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() =>
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/v1/memory/graph/stream")
        )
      );

      const streamCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes("/v1/memory/graph/stream")
      );
      const init = streamCall?.[1] as RequestInit | undefined;
      expect(init?.credentials).toBe("include");
      expect((init?.headers as Record<string, string>)?.authorization).toBe(
        "Bearer token"
      );
      expect((init?.headers as Record<string, string>)?.accept).toBe(
        "text/event-stream"
      );
      await waitFor(() => {
        const streamCalls = fetchMock.mock.calls.filter(([input]) =>
          String(input).includes("/v1/memory/graph/stream")
        );
        return streamCalls.length === 2;
      });
      const fallbackInit = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/v1/memory/graph/stream")
      )[1]?.[1] as RequestInit | undefined;
      expect(fallbackInit?.credentials).toBe("include");
      expect(
        (fallbackInit?.headers as Record<string, string>)?.authorization
      ).toBeUndefined();
      expect((fallbackInit?.headers as Record<string, string>)?.accept).toBe(
        "text/event-stream"
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("publishes full cursor-loaded thread pages to explicit page listeners", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 4 };
    const firstEvent = makeEvent(selectedThread, 0);
    const secondEvent = makeEvent(selectedThread, 1);
    const thirdEvent = makeEvent(selectedThread, 2);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/events?")) {
        const request = new URL(url);
        const cursorId = request.searchParams.get("cursorId");
        if (!cursorId) {
          return jsonResponse({ events: [secondEvent, thirdEvent] });
        }
        if (cursorId === thirdEvent.id) {
          return jsonResponse({ events: [firstEvent] });
        }
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const pages: Array<{ complete: boolean; ids: string[] }> = [];

    const events = await loadThreadEvents(selectedThread, "token", {
      full: true,
      includeContent: true,
      limit: 2,
      onPage: (pageEvents, state) => {
        pages.push({
          complete: state.complete,
          ids: pageEvents.map((event) => event.id)
        });
      }
    });

    expect(pages).toEqual([
      { complete: false, ids: [secondEvent.id, thirdEvent.id] },
      { complete: true, ids: [firstEvent.id, secondEvent.id, thirdEvent.id] }
    ]);
    expect(events.map((event) => event.id)).toEqual([
      firstEvent.id,
      secondEvent.id,
      thirdEvent.id
    ]);
  });

  it("requests full display content only when the caller opts in", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({ events: [makeEvent(selectedThread, 0)] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await loadThreadEvents(selectedThread, "token", {
      full: false,
      limit: 1
    });
    await loadThreadEvents(selectedThread, "token", {
      full: true,
      includeContent: true,
      limit: 1
    });

    const eventUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/v1/memory/graph/events?"));
    expect(eventUrls[0]).not.toContain("includeContent=true");
    expect(eventUrls[1]).toContain("includeContent=true");
  });

  it("chunks linked node loading to the API ids limit", async () => {
    const [project] = makeProjects(1, 1);
    const thread = project!.threads[0]!;
    const nodeIds = Array.from(
      { length: 205 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
    );
    const event = {
      ...makeEvent(thread, 0),
      linkedNodeIds: [...nodeIds, nodeIds[0]!]
    };
    const requestedBatches: string[][] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = new URL(String(input));
      if (request.pathname.endsWith("/v1/memory/graph/nodes")) {
        const ids = request.searchParams.get("ids")?.split(",") ?? [];
        requestedBatches.push(ids);
        expect(ids.length).toBeLessThanOrEqual(100);
        return jsonResponse({
          nodes: ids.map((id) => makeGraphNode(id, thread))
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await loadLinkedGraphNodes([], "token")).toEqual([]);
    const nodes = await loadLinkedGraphNodes([event], "token");

    expect(nodes).toHaveLength(205);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(requestedBatches.map((batch) => batch.length)).toEqual([
      100, 100, 5
    ]);
    expect(new Set(nodes.map((node) => node.id))).toEqual(new Set(nodeIds));
  });

  it("renders full display content independently from raw inspector content", async () => {
    const [project] = makeProjects(1, 1);
    const event = {
      ...makeEvent(project!.threads[0]!, 0),
      actor: "subagent",
      content: "Expanded timeline message",
      contentPreview: "Preview timeline message",
      rawContent: '{"raw":"inspector only"}'
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(KoedMessage, {
            event,
            isSelected: false,
            onSelect: () => undefined
          })
        );
      });

      expect(eventDisplayText(event)).toBe("Expanded timeline message");
      expect(eventActorLabel(event)).toBe("Subagent");
      expect(container.textContent).toContain("Subagent");
      expect(container.textContent).toContain("Expanded timeline message");
      expect(container.textContent).not.toContain("Preview timeline message");
      expect(container.textContent).not.toContain("inspector only");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("renders tool calls collapsed and expands full text without raw JSON", async () => {
    const [project] = makeProjects(1, 1);
    const event = {
      ...makeEvent(project!.threads[0]!, 0),
      actor: "tool",
      contentFull: "Command output line 1\nCommand output line 2",
      contentPreview: "short command output",
      metadata: {
        toolCall: {
          id: "call-123",
          input: { command: "pnpm test" },
          name: "exec_command",
          status: "success"
        }
      },
      rawContent: '{"raw":"inspector only"}'
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          createElement(KoedMessage, {
            event,
            isSelected: false,
            onSelect: () => undefined
          })
        );
      });

      expect(container.textContent).toContain("Ran command");
      expect(container.textContent).toContain("exec_command");
      expect(container.textContent).toContain("pnpm test");
      expect(container.textContent).not.toContain("Command output line 2");
      expect(container.textContent).not.toContain("inspector only");

      const expand = container.querySelector(
        'button[aria-label="Expand tool call"]'
      );
      expect(expand).not.toBeNull();

      await act(async () => {
        expand!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(container.textContent).toContain("Command output line 1");
      expect(container.textContent).toContain("Command output line 2");
      expect(container.textContent).not.toContain("inspector only");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("preserves full timeline content when raw detail omits display content", () => {
    const [project] = makeProjects(1, 1);
    const thread = project!.threads[0]!;
    const existing = {
      ...makeEvent(thread, 0),
      content: "Full timeline content",
      contentFull: "Canonical full timeline content",
      contentPreview: "Preview before raw load"
    };
    const detail = {
      ...makeEvent(thread, 0),
      contentPreview: "Preview from raw detail",
      rawContent: '{"raw":"detail"}'
    };

    const merged = mergeEventDetail(existing, detail);

    expect(eventDisplayText(merged)).toBe("Canonical full timeline content");
    expect(merged.content).toBe("Full timeline content");
    expect(merged.contentFull).toBe("Canonical full timeline content");
    expect(merged.contentPreview).toBe("Preview from raw detail");
    expect(merged.rawContent).toBe('{"raw":"detail"}');
  });

  it("merges refreshed thread head events into an existing complete cache", () => {
    const [project] = makeProjects(1, 1);
    const thread = project!.threads[0]!;
    const first = {
      ...makeEvent(thread, 0),
      content: "Original first event",
      contentPreview: "First preview"
    };
    const second = makeEvent(thread, 1);
    const refreshedSecond = {
      ...second,
      content: "Refreshed second event"
    };
    const third = makeEvent(thread, 2);

    const merged = mergeThreadEvents([first, second], [refreshedSecond, third]);

    expect(merged.map((event) => event.id)).toEqual([
      first.id,
      second.id,
      third.id
    ]);
    expect(merged[0]?.content).toBe("Original first event");
    expect(merged[1]?.content).toBe("Refreshed second event");
  });

  it("keeps merged thread events in source chronology order", () => {
    const [project] = makeProjects(1, 1);
    const thread = project!.threads[0]!;
    const sameCapturedAt = "2026-01-01T12:00:00.000Z";
    const first = makeEvent(thread, 0, {
      id: "event-first",
      sourceEventTime: "2026-01-01T10:00:00.000Z",
      sourceSequence: 1,
      timestamp: sameCapturedAt
    });
    const second = makeEvent(thread, 1, {
      id: "event-second",
      sourceEventTime: "2026-01-01T10:00:00.000Z",
      sourceSequence: 2,
      timestamp: sameCapturedAt
    });
    const third = makeEvent(thread, 2, {
      id: "event-third",
      sourceEventTime: "2026-01-01T11:00:00.000Z",
      sourceSequence: 1,
      timestamp: "2026-01-01T09:00:00.000Z"
    });

    const merged = mergeThreadEvents([second], [third, first]);

    expect(merged.map((event) => event.id)).toEqual([
      first.id,
      second.id,
      third.id
    ]);
  });

  it("stops selected detail paging when the API returns a repeated cursor", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 4 };
    const firstEvent = makeEvent(selectedThread, 0);
    const secondEvent = makeEvent(selectedThread, 1);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({ events: [firstEvent, secondEvent] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const events = await loadThreadEvents(selectedThread, "token", {
      full: true,
      limit: 2
    });
    const eventUrls = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes("/v1/memory/graph/events?"));

    expect(events.map((event) => event.id)).toEqual([
      firstEvent.id,
      secondEvent.id
    ]);
    expect(eventUrls).toHaveLength(2);
  });

  it("smokes the selected-thread hook path without global node fetches", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 3 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const firstEvent = makeEvent(selectedThread, 0);
    const secondEvent = makeEvent(selectedThread, 1);
    const thirdEvent = {
      ...makeEvent(selectedThread, 2),
      linkedNodeIds: ["node-1"]
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return jsonResponse({ error: "stream disabled in test" }, 401);
      }
      if (url.includes("/v1/memory/graph/threads")) {
        const request = new URL(url);
        const offset = Number(request.searchParams.get("offset") ?? 0);
        return jsonResponse({
          projects:
            offset === 0 ? [{ ...project!, threads: [selectedThread] }] : []
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        const request = new URL(url);
        if (request.searchParams.get("cursorId")) {
          return jsonResponse({ events: [] });
        }
        return jsonResponse({ events: [firstEvent, secondEvent, thirdEvent] });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        const request = new URL(url);
        expect(request.searchParams.get("ids")).toBe("node-1");
        return jsonResponse({
          nodes: [makeGraphNode("node-1", selectedThread)]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 3);
      await waitFor(() =>
        latestState?.data.nodes.some((node) => node.id === "node-1")
      );

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(latestState?.selectedThread?.id).toBe(selectedThread.id);
      expect(
        urls.some(
          (url) =>
            url.includes("/v1/memory/graph/events?") &&
            url.includes("includeContent=true")
        )
      ).toBe(true);
      expect(urls.some((url) => url.includes("/v1/memory/graph/nodes?"))).toBe(
        true
      );
      expect(
        urls.some((url) => url.includes("/v1/memory/graph/nodes/node-1"))
      ).toBe(false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("renders selected thread events before linked node batches finish", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const event = {
      ...makeEvent(selectedThread, 0),
      linkedNodeIds: ["node-1"]
    };
    let resolveNodes: (() => void) | undefined;
    const nodesBlocked = new Promise<void>((resolve) => {
      resolveNodes = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return jsonResponse({ error: "stream disabled in test" }, 401);
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [{ ...project!, threads: [selectedThread] }]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({ events: [event] });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        await nodesBlocked;
        return jsonResponse({
          nodes: [makeGraphNode("node-1", selectedThread)]
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);

      expect(latestState?.threadEvents[0]?.id).toBe(event.id);
      expect(latestState?.data.nodes).toHaveLength(0);

      resolveNodes?.();
      await waitFor(() =>
        latestState?.data.nodes.some((node) => node.id === "node-1")
      );
    } finally {
      resolveNodes?.();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("refreshes selected stream events through the timeline endpoint", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const liveEvent = {
      ...makeEvent(selectedThread, 1),
      id: "live-event-1",
      contentPreview: "live event"
    };
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    let includeLiveEvent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              threads: [
                {
                  ...selectedThread,
                  eventCount: includeLiveEvent ? 2 : 1,
                  latestAt: includeLiveEvent
                    ? liveEvent.timestamp
                    : selectedThread.latestAt
                }
              ]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({
          events: includeLiveEvent ? [initialEvent, liveEvent] : [initialEvent]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);
      fetchMock.mockClear();
      includeLiveEvent = true;

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: liveEvent.id,
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: liveEvent.id,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });
      await waitFor(() =>
        latestState?.threadEvents.some((event) => event.id === liveEvent.id)
      );

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        urls.filter((url) =>
          url.includes(`/v1/memory/graph/events/${liveEvent.id}`)
        )
      ).toHaveLength(0);
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        true
      );
      expect(latestState?.selectedThread?.eventCount).toBe(2);

      fetchMock.mockClear();
      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: liveEvent.id,
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: liveEvent.id,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });
      await waitFor(
        () =>
          fetchMock.mock.calls.filter(([input]) =>
            String(input).includes("/v1/memory/graph/events?")
          ).length === 1
      );
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(`/v1/memory/graph/events/${liveEvent.id}`)
        )
      ).toBe(false);

      expect(latestState?.threadEvents).toHaveLength(2);
      expect(latestState?.selectedThread?.eventCount).toBe(2);
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("routes memory question stream updates without graph refresh", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = project!.threads[0]!;
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [{ ...project!, threads: [selectedThread] }]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({ events: [initialEvent] });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();
    const onMemoryQuestionUpdate = vi.fn();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        onMemoryQuestionUpdate,
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);
      await waitFor(() => onMemoryQuestionUpdate.mock.calls.length >= 1);
      fetchMock.mockClear();
      onMemoryQuestionUpdate.mockClear();

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: "question-1",
              operation: "UPDATE",
              questionIds: ["question-1"],
              table: "memory_questions"
            })}\n\n`
          )
        );
      });
      await waitFor(() => onMemoryQuestionUpdate.mock.calls.length === 1);

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(onMemoryQuestionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "question-1",
          table: "memory_questions"
        })
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        false
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        false
      );

      fetchMock.mockClear();
      onMemoryQuestionUpdate.mockClear();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: "question-hidden",
              operation: "UPDATE",
              table: "memory_questions"
            })}\n\n`
          )
        );
      });
      await waitFor(() => onMemoryQuestionUpdate.mock.calls.length === 1);
      expect(onMemoryQuestionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "question-hidden",
          table: "memory_questions"
        })
      );
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/v1/memory/graph/threads")
        )
      ).toBe(false);
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("processes coalesced question updates without dropping selected event refs", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = project!.threads[0]!;
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const liveEvent = {
      ...makeEvent(selectedThread, 1),
      id: "coalesced-live-event",
      contentPreview: "coalesced live event"
    };
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    let includeLiveEvent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              threads: [
                {
                  ...selectedThread,
                  latestAt: includeLiveEvent
                    ? liveEvent.timestamp
                    : selectedThread.latestAt
                }
              ]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({
          events: includeLiveEvent ? [initialEvent, liveEvent] : [initialEvent]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();
    const onMemoryQuestionUpdate = vi.fn();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        onMemoryQuestionUpdate,
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);
      await waitFor(() => onMemoryQuestionUpdate.mock.calls.length >= 1);
      fetchMock.mockClear();
      onMemoryQuestionUpdate.mockClear();
      includeLiveEvent = true;

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              coalesced: true,
              id: "question-1",
              operation: "UPDATE",
              questionIds: ["question-1"],
              table: "memory_questions",
              eventRefs: [
                {
                  id: liveEvent.id,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });

      await waitFor(() => onMemoryQuestionUpdate.mock.calls.length === 1);
      await waitFor(() =>
        latestState?.threadEvents.some((event) => event.id === liveEvent.id)
      );

      expect(onMemoryQuestionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          questionIds: ["question-1"],
          table: "memory_questions"
        })
      );
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes(`/v1/memory/graph/events/${liveEvent.id}`)
        )
      ).toBe(false);
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/v1/memory/graph/events?")
        )
      ).toBe(true);

      fetchMock.mockClear();
      onMemoryQuestionUpdate.mockClear();
      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              coalesced: true,
              id: liveEvent.id,
              operation: "UPDATE",
              questionIds: ["question-2"],
              table: "memory_events",
              eventRefs: [
                {
                  id: liveEvent.id,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });

      await waitFor(() => onMemoryQuestionUpdate.mock.calls.length === 1);
      expect(onMemoryQuestionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          questionIds: ["question-2"],
          table: "memory_events"
        })
      );
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("does not increment shell counts for selected stream updates", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 3 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const headEvents = [
      makeEvent(selectedThread, 1),
      makeEvent(selectedThread, 2)
    ];
    const olderUpdatedEvent = {
      ...headEvents[1]!,
      contentPreview: "head event updated from stream refresh"
    };
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    let includeUpdatedEvent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [{ ...project!, threads: [selectedThread] }]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({
          events: includeUpdatedEvent
            ? [headEvents[0]!, olderUpdatedEvent]
            : headEvents
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 2);
      fetchMock.mockClear();
      includeUpdatedEvent = true;

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: olderUpdatedEvent.id,
              table: "memory_events",
              operation: "UPDATE",
              eventRefs: [
                {
                  id: olderUpdatedEvent.id,
                  operation: "UPDATE",
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });
      await waitFor(() =>
        latestState?.threadEvents.some(
          (event) =>
            event.id === olderUpdatedEvent.id &&
            event.contentPreview === olderUpdatedEvent.contentPreview
        )
      );

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(latestState?.selectedThread?.eventCount).toBe(3);
      expect(
        urls.some((url) =>
          url.includes(`/v1/memory/graph/events/${olderUpdatedEvent.id}`)
        )
      ).toBe(false);
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        true
      );
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("refreshes shell metadata for mixed selected and non-selected stream refs", async () => {
    const [project] = makeProjects(1, 2);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const otherThread = { ...project!.threads[1]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const selectedLiveEvent = {
      ...makeEvent(selectedThread, 1),
      id: "selected-live-event"
    };
    const otherLiveEvent = {
      ...makeEvent(otherThread, 1),
      id: "other-live-event"
    };
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    let includeSelectedLiveEvent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              threads: [
                {
                  ...selectedThread,
                  eventCount: includeSelectedLiveEvent ? 2 : 1,
                  latestAt: includeSelectedLiveEvent
                    ? selectedLiveEvent.timestamp
                    : selectedThread.latestAt
                },
                {
                  ...otherThread,
                  eventCount: includeSelectedLiveEvent ? 2 : 1,
                  latestAt: includeSelectedLiveEvent
                    ? otherLiveEvent.timestamp
                    : otherThread.latestAt
                }
              ]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({
          events: includeSelectedLiveEvent
            ? [initialEvent, selectedLiveEvent]
            : [initialEvent]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);
      fetchMock.mockClear();
      includeSelectedLiveEvent = true;

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: selectedLiveEvent.id,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                },
                {
                  id: otherLiveEvent.id,
                  projectId: otherThread.projectId,
                  threadId: otherThread.id
                }
              ]
            })}\n\n`
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 850));
      });
      await waitFor(() =>
        latestState?.threadEvents.some(
          (event) => event.id === selectedLiveEvent.id
        )
      );

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        urls.filter((url) =>
          url.includes(`/v1/memory/graph/events/${selectedLiveEvent.id}`)
        )
      ).toHaveLength(0);
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        true
      );
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("upgrades pending shell refreshes when selected event refs arrive", async () => {
    const [project] = makeProjects(1, 2);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const otherThread = { ...project!.threads[1]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const fallbackEvent = {
      ...makeEvent(selectedThread, 1),
      id: "selected-fallback-event"
    };
    const selectedEventId = "selected-stream-event";
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [{ ...project!, threads: [selectedThread, otherThread] }]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({ events: [initialEvent, fallbackEvent] });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 2);
      fetchMock.mockClear();

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: "other-thread-event",
                  projectId: otherThread.projectId,
                  threadId: otherThread.id
                }
              ]
            })}\n\n`
          )
        );
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: selectedEventId,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 850));
      });

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(
        urls.some((url) =>
          url.includes(`/v1/memory/graph/events/${selectedEventId}`)
        )
      ).toBe(false);
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        true
      );
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("keeps partial selected threads eligible for older-page loading after live appends", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 4 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const olderEvent = makeEvent(selectedThread, 0);
    const headEvents = [
      makeEvent(selectedThread, 1),
      makeEvent(selectedThread, 2)
    ];
    const liveEvent = {
      ...makeEvent(selectedThread, 3),
      id: "live-event-partial",
      timestamp: "2026-01-01T00:00:03.000Z"
    };
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    let includeLiveEvent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [{ ...project!, threads: [selectedThread] }]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        const request = new URL(url);
        if (request.searchParams.get("cursorId")) {
          return jsonResponse({ events: [olderEvent] });
        }
        return jsonResponse({
          events: includeLiveEvent ? [...headEvents, liveEvent] : headEvents
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 2);
      includeLiveEvent = true;

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: liveEvent.id,
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: liveEvent.id,
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });
      await waitFor(() =>
        latestState?.threadEvents.some((event) => event.id === liveEvent.id)
      );

      expect(latestState?.threadEvents).toHaveLength(3);
      expect(latestState?.hasOlderThreadEvents).toBe(true);

      fetchMock.mockClear();
      await act(async () => {
        await latestState?.loadOlderThreadEvents();
      });
      await waitFor(() =>
        latestState?.threadEvents.some((event) => event.id === olderEvent.id)
      );

      const olderPageUrls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/v1/memory/graph/events?"));
      expect(olderPageUrls.some((url) => url.includes("cursorId="))).toBe(true);
      expect(
        olderPageUrls.some((url) => url.includes("cursorSourceSequence=1"))
      ).toBe(true);
      expect(latestState?.threadEvents).toHaveLength(4);
      expect(latestState?.hasOlderThreadEvents).toBe(false);
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("ignores embedding stream updates in the browser hot path", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [{ ...project!, threads: [selectedThread] }]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({ events: [initialEvent] });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);
      fetchMock.mockClear();

      await act(async () => {
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              id: null,
              table: "memory_embeddings",
              operation: "INSERT"
            })}\n\n`
          )
        );
        await new Promise((resolve) => setTimeout(resolve, 850));
      });

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        false
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        false
      );
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("refreshes a cached selected thread head after returning visible", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 501 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvents = Array.from({ length: 501 }, (_, index) =>
      makeEvent(selectedThread, index)
    );
    const newEvent = {
      ...makeEvent(selectedThread, 501),
      id: `${threadKey(selectedThread)}-event-new`
    };
    let eventCount = 501;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return jsonResponse({ error: "stream disabled in test" }, 401);
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              eventCount,
              threads: [{ ...selectedThread, eventCount }]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        const request = new URL(url);
        if (request.searchParams.get("cursorId")) {
          return jsonResponse({ events: initialEvents.slice(0, 1) });
        }
        return jsonResponse({
          events:
            eventCount === 501
              ? initialEvents.slice(1)
              : [newEvent, ...initialEvents.slice(2, 501)]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 500);
      expect(
        fetchMock.mock.calls
          .map(([input]) => String(input))
          .some((url) => url.includes("cursorId="))
      ).toBe(false);

      fetchMock.mockClear();
      eventCount = 502;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await new Promise((resolve) => setTimeout(resolve, 850));
      });

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      const refreshEventUrls = urls.filter((url) =>
        url.includes("/v1/memory/graph/events?")
      );
      expect(refreshEventUrls).toHaveLength(1);
      expect(refreshEventUrls[0]).toContain("limit=50");
      expect(
        latestState?.threadEvents.some((event) => event.id === newEvent.id)
      ).toBe(true);
      expect(latestState?.threadEvents).toHaveLength(501);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("reloads selected thread detail when the selected shell changes", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const refreshedEvent = {
      ...makeEvent(selectedThread, 1),
      id: `${threadKey(selectedThread)}-event-shell-refresh`
    };
    let eventCount = 1;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return jsonResponse({ error: "stream disabled in test" }, 401);
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              eventCount,
              threads: [{ ...selectedThread, eventCount }]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({
          events:
            eventCount === 1 ? [initialEvent] : [refreshedEvent, initialEvent]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);

      fetchMock.mockClear();
      eventCount = 2;
      await act(async () => {
        await latestState?.loadGraph({ silent: true });
      });
      await waitFor(() => {
        expect(
          latestState?.threadEvents.some(
            (event) => event.id === refreshedEvent.id
          )
        ).toBe(true);
        return true;
      });

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        true
      );
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("reconciles a cached selected thread after hidden stream updates", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 1 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvent = makeEvent(selectedThread, 0);
    const hiddenEvent = {
      ...makeEvent(selectedThread, 1),
      id: "hidden-selected-event"
    };
    let hiddenUpdateReceived = false;
    const streamControllerRef: {
      current: ReadableStreamDefaultController<Uint8Array> | null;
    } = { current: null };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamControllerRef.current = controller;
      }
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              eventCount: hiddenUpdateReceived ? 2 : 1,
              threads: [
                {
                  ...selectedThread,
                  eventCount: hiddenUpdateReceived ? 2 : 1
                }
              ]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        return jsonResponse({
          events: hiddenUpdateReceived
            ? [hiddenEvent, initialEvent]
            : [initialEvent]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 1);
      fetchMock.mockClear();
      const visibilitySpy = vi.spyOn(document, "visibilityState", "get");

      await act(async () => {
        visibilitySpy.mockReturnValue("hidden");
        hiddenUpdateReceived = true;
        streamControllerRef.current?.enqueue(
          new TextEncoder().encode(
            `event: graph_update\ndata: ${JSON.stringify({
              table: "memory_events",
              operation: "INSERT",
              eventRefs: [
                {
                  id: hiddenEvent.id,
                  operation: "INSERT",
                  projectId: selectedThread.projectId,
                  threadId: selectedThread.id
                }
              ]
            })}\n\n`
          )
        );
      });
      expect(fetchMock).not.toHaveBeenCalled();

      await act(async () => {
        visibilitySpy.mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => {
        expect(
          latestState?.threadEvents.some((event) => event.id === hiddenEvent.id)
        ).toBe(true);
        return true;
      });

      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls.some((url) => url.includes("/v1/memory/graph/threads"))).toBe(
        true
      );
      expect(urls.some((url) => url.includes("/v1/memory/graph/events?"))).toBe(
        true
      );
    } finally {
      streamControllerRef.current?.close();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("does not auto-backfill older selected thread pages", async () => {
    const [project] = makeProjects(1, 1);
    const selectedThread = { ...project!.threads[0]!, eventCount: 501 };
    const selectedThreadId = threadSelectionKey(selectedThread);
    const initialEvents = Array.from({ length: 501 }, (_, index) =>
      makeEvent(selectedThread, index)
    );
    const newEvent = {
      ...makeEvent(selectedThread, 501),
      id: `${threadKey(selectedThread)}-event-live`
    };
    let eventCount = 501;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/memory/graph/stream")) {
        return jsonResponse({ error: "stream disabled in test" }, 401);
      }
      if (url.includes("/v1/memory/graph/threads")) {
        return jsonResponse({
          projects: [
            {
              ...project!,
              eventCount,
              threads: [{ ...selectedThread, eventCount }]
            }
          ]
        });
      }
      if (url.includes("/v1/memory/graph/events?")) {
        const request = new URL(url);
        if (request.searchParams.get("cursorId")) {
          return jsonResponse({ events: initialEvents.slice(0, 1) });
        }
        return jsonResponse({
          events:
            eventCount === 501
              ? initialEvents.slice(1)
              : [newEvent, ...initialEvents.slice(2, 501)]
        });
      }
      if (url.includes("/v1/memory/graph/nodes?")) {
        return jsonResponse({ nodes: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestState: ReturnType<typeof useKoedMemoryGraph> | undefined;
    const setToast = vi.fn<(toast: ToastState | null) => void>();

    function Harness() {
      const state = useKoedMemoryGraph({
        apiToken: "token",
        selectedThreadId,
        setToast
      });
      useEffect(() => {
        latestState = state;
      }, [state]);
      return null;
    }

    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 500);

      fetchMock.mockClear();
      await act(async () => {
        await latestState?.loadOlderThreadEvents();
      });
      await waitFor(() => (latestState?.threadEvents.length ?? 0) === 501);
      const olderPageUrls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/v1/memory/graph/events?"));
      expect(olderPageUrls.some((url) => url.includes("cursorId="))).toBe(true);

      fetchMock.mockClear();
      eventCount = 502;
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => {
        expect(
          latestState?.threadEvents.some((event) => event.id === newEvent.id)
        ).toBe(true);
        return true;
      });
      expect(
        latestState?.threadEvents.some(
          (event) => event.id === initialEvents[0]?.id
        )
      ).toBe(true);
      expect(latestState?.threadEvents).toHaveLength(502);
      const refreshEventUrls = fetchMock.mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.includes("/v1/memory/graph/events?"));
      expect(refreshEventUrls).toHaveLength(1);
      expect(refreshEventUrls[0]).toContain("limit=50");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("preserves summarized LCM nodes when a refresh has no nodes or older placeholders", () => {
    const [project] = makeProjects(1, 1);
    const thread = project!.threads[0]!;
    const summarized: GraphNode = {
      ...makeGraphNode("node-1", thread),
      summaryModel: "codex:gpt-5.4-mini:medium",
      summaryPromptVersion: "lcm-codex-summary-v1",
      summaryStatus: "summarized",
      summaryText: "Completed LCM summary",
      updatedAt: "2026-01-01T00:00:10.000Z"
    };
    const olderPlaceholder: GraphNode = {
      ...makeGraphNode("node-1", thread),
      summaryModel: null,
      summaryPromptVersion: null,
      summaryStatus: "pending",
      summaryText: "LCM depth 0 leaf summary",
      updatedAt: "2026-01-01T00:00:00.000Z"
    };

    expect(mergeGraphNodes([summarized], [])).toEqual([summarized]);
    expect(mergeGraphNodes([summarized], [olderPlaceholder])).toEqual([
      summarized
    ]);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function makeGraphNode(id: string, thread: ThreadGroup): GraphNode {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    depth: 0,
    embeddingCount: 1,
    id,
    invalidatedAt: null,
    invalidationReason: null,
    kind: "leaf",
    lcmAlgorithmVersion: null,
    projectId: thread.projectId,
    projectName: thread.projectName,
    projectPath: null,
    sessionId: null,
    sourceEventCount: 1,
    sourceTokenEstimate: null,
    summaryModel: null,
    summaryPromptVersion: null,
    summaryStatus: "summarized",
    summaryText: "Linked node",
    summaryTokenEstimate: null,
    threadId: thread.id,
    threadName: thread.name,
    updatedAt: "2026-01-01T00:00:00.000Z",
    visibility: "personal"
  };
}

async function waitFor(assertion: () => boolean | undefined) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (assertion()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition");
}
