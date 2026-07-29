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
  MemoryEventFrame: ({
    actions,
    children,
    header,
    metadata
  }: {
    actions?: ReactNode;
    children: ReactNode;
    header: ReactNode;
    metadata?: ReactNode;
  }) => (
    <article>
      <header>{header}</header>
      {actions}
      {children}
      <footer>{metadata}</footer>
    </article>
  ),
  SecureMarkdown: ({ source }: { source: string }) => <div>{source}</div>,
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

  async function renderSurface(
    loadEventsPage: NonNullable<
      Parameters<typeof NativeConversationSurface>[0]["loadEventsPage"]
    >
  ) {
    await act(async () => {
      root.render(
        <NativeConversationSurface
          loadEventsPage={loadEventsPage}
          thread={thread}
        />
      );
    });
  }

  it("loads and renders the selected Captured Session directly", async () => {
    const loadEventsPage = vi
      .fn()
      .mockResolvedValue([event("event-1", "Hello from Koed")]);

    await renderSurface(loadEventsPage);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Hello from Koed")
    );

    expect(loadEventsPage).toHaveBeenCalledWith({
      limit: 50,
      thread
    });
  });

  it("supports focus and interaction with a labelled tool activity disclosure", async () => {
    const tool = (id: string, toolName: string): DesktopConversationEvent => ({
      ...event(id, `Raw output from ${toolName}`),
      actor: "tool",
      metadata: { toolName }
    });
    const loadEventsPage = vi
      .fn()
      .mockResolvedValue([
        tool("tool-1", "exec"),
        tool("tool-2", "apply_patch")
      ]);

    await renderSurface(loadEventsPage);
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

  it("renders source diffs, visible invalidation labels, and Inspector callbacks", async () => {
    const onInspectEvent = vi.fn();
    const changed = {
      ...event(
        "event-patch",
        "*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch"
      ),
      actor: "tool",
      invalidatedAt: "2026-07-13T13:00:00.000Z",
      metadata: { toolName: "apply_patch" }
    } satisfies DesktopConversationEvent;

    await act(async () => {
      root.render(
        <NativeConversationSurface
          model={{
            error: "",
            events: [changed],
            hasOlderEvents: false,
            status: "ready"
          }}
          onInspectEvent={onInspectEvent}
          onLoadOlder={vi.fn()}
          onRetry={vi.fn()}
          thread={thread}
        />
      );
    });

    expect(container.textContent).toContain("1 file changed");
    expect(container.textContent).toContain(
      "Invalidated · excluded from current recall"
    );
    const inspect = container.querySelector<HTMLButtonElement>(
      '[aria-label="Inspect apply_patch event"]'
    );
    await act(async () => inspect?.click());
    expect(onInspectEvent).toHaveBeenCalledWith(changed);
  });

  it("offers Retry after an actionable loader error", async () => {
    const loadEventsPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Local API unavailable"))
      .mockResolvedValueOnce([event("event-1", "Recovered")]);

    await renderSurface(loadEventsPage);
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
    expect(loadEventsPage).toHaveBeenCalledTimes(2);
  });

  it("stops pagination when the API repeats the cursor page", async () => {
    const latest = event("event-latest", "Latest");
    const loadEventsPage = vi
      .fn()
      .mockResolvedValueOnce([latest])
      .mockResolvedValueOnce([latest]);

    await renderSurface(loadEventsPage);
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
    expect(loadEventsPage).toHaveBeenCalledTimes(2);
    expect(loadEventsPage.mock.calls[1]?.[0]).toEqual({
      cursor: {
        id: latest.id,
        sourceSequence: latest.sourceSequence,
        timestamp: latest.timestamp
      },
      limit: 500,
      thread
    });
  });

  it("ignores an older loader result after the surface unmounts", async () => {
    let resolveOlder: ((events: DesktopConversationEvent[]) => void) | null =
      null;
    const loadEventsPage = vi
      .fn()
      .mockResolvedValueOnce([event("event-latest", "Latest")])
      .mockImplementationOnce(
        () =>
          new Promise<DesktopConversationEvent[]>((resolve) => {
            resolveOlder = resolve;
          })
      );

    await renderSurface(loadEventsPage);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Load older test page")
    );
    const loadOlder = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Load older test page"
    );
    await act(async () => loadOlder?.click());

    await act(async () => root.unmount());
    await act(async () => resolveOlder?.([event("event-old", "Old")]));
    expect(loadEventsPage).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });
});
