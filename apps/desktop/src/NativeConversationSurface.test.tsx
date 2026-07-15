// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeConversationSurface } from "./NativeConversationSurface.js";
import type {
  DesktopConversationEvent,
  DesktopConversationTimelineItem
} from "./desktop-conversation.js";
import type { DesktopThreadGroup } from "./project-memory-ui.js";

vi.mock("@koed/memory-ui", () => ({
  threadSelectionKey: (thread: { id: string; projectId: string }) =>
    `${thread.projectId}:${thread.id}`,
  VirtualizedTimeline: ({
    events,
    hasOlderEvents,
    onLoadOlder,
    renderEvent
  }: {
    events: DesktopConversationTimelineItem[];
    hasOlderEvents: boolean;
    onLoadOlder: () => Promise<void> | void;
    renderEvent: (event: DesktopConversationTimelineItem) => ReactNode;
  }) => (
    <div data-testid="timeline">
      {events.map((event) => (
        <div key={event.id}>{renderEvent(event)}</div>
      ))}
      {hasOlderEvents ? (
        <button type="button" onClick={() => void onLoadOlder()}>
          Load older test page
        </button>
      ) : null}
    </div>
  )
}));

const thread: DesktopThreadGroup = {
  id: "thread-1",
  name: "Native Conversation",
  sessionId: "session-1",
  projectId: "project-1",
  projectName: "Koed",
  eventCount: 3,
  invalidatedCount: 0,
  latestAt: "2026-07-13T12:00:00.000Z",
  sample: "Hello"
};

function event(
  id: string,
  content: string,
  timestamp = "2026-07-13T12:00:00.000Z"
): DesktopConversationEvent {
  return {
    id,
    actor: "assistant",
    eventType: "message",
    timestamp,
    sourceEventTime: timestamp,
    sourceSequence: null,
    content,
    contentPreview: content,
    invalidatedAt: null,
    metadata: {}
  };
}

function jsonResponse(
  events: DesktopConversationEvent[],
  status = 200,
  error?: string
): Response {
  return new Response(JSON.stringify(error ? { error } : { events }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("NativeConversationSurface", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderSurface() {
    await act(async () => {
      root.render(
        <NativeConversationSurface
          apiBaseUrl="http://127.0.0.1:3300"
          apiToken="desktop-token"
          thread={thread}
        />
      );
    });
  }

  it("loads and renders the selected Captured Session directly", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse([event("event-1", "Hello from Koed")]));
    vi.stubGlobal("fetch", fetchMock);

    await renderSurface();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Hello from Koed")
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("projectId=project-1");
    expect(String(url)).toContain("threadId=thread-1");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer desktop-token"
    );
  });

  it("supports focus and interaction with a labelled tool activity disclosure", async () => {
    const tool = (id: string, toolName: string): DesktopConversationEvent => ({
      ...event(id, `Raw output from ${toolName}`),
      actor: "tool",
      metadata: { toolName }
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          jsonResponse([tool("tool-1", "exec"), tool("tool-2", "apply_patch")])
        )
    );

    await renderSurface();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("2 activity items")
    );

    const group =
      container.querySelector<HTMLDetailsElement>(".native-tool-group");
    const summary = group?.querySelector("summary");
    expect(group?.open).toBe(false);
    expect(summary?.textContent).toContain("Agent activity");
    expect(summary?.textContent).toContain("2 activity items");
    expect(summary?.tabIndex).toBe(0);
    expect(group?.textContent).toContain("exec, apply_patch");
    expect(group?.textContent).toContain("Raw output from exec");

    summary?.focus();
    expect(document.activeElement).toBe(summary);
    await act(async () => summary?.click());
    expect(group?.open).toBe(true);
  });

  it("offers Retry after an actionable HTTP error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([], 500, "Local API unavailable"))
      .mockResolvedValueOnce(jsonResponse([event("event-1", "Recovered")]));
    vi.stubGlobal("fetch", fetchMock);

    await renderSurface();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Local API unavailable")
    );
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry loading"
    );
    expect(retry).toBeDefined();

    await act(async () => retry?.click());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Recovered")
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops pagination when the API repeats the cursor page", async () => {
    const latest = event("event-latest", "Latest");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([latest]))
      .mockResolvedValueOnce(jsonResponse([latest]));
    vi.stubGlobal("fetch", fetchMock);

    await renderSurface();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Load older test page")
    );
    const loadOlder = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load older test page"
    );

    await act(async () => loadOlder?.click());
    await vi.waitFor(() =>
      expect(container.textContent).not.toContain("Load older test page")
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts an older-page request when the surface unmounts", async () => {
    let olderSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([event("event-latest", "Latest")]))
      .mockImplementationOnce((_url, init) => {
        olderSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          olderSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        });
      });
    vi.stubGlobal("fetch", fetchMock);

    await renderSurface();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Load older test page")
    );
    const loadOlder = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load older test page"
    );
    await act(async () => loadOlder?.click());

    await act(async () => root.unmount());
    expect(olderSignal?.aborted).toBe(true);
    root = createRoot(container);
  });
});
