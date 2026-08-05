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

vi.mock("@koed/memory-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@koed/memory-ui")>();
  return {
    ...actual,
    MemoryEventFrame: ({
      actions,
      children,
      className,
      header,
      metadata
    }: {
      actions?: ReactNode;
      children: ReactNode;
      className?: string;
      header: ReactNode;
      metadata?: ReactNode;
    }) => (
      <article className={className}>
        <header>{header}</header>
        {actions}
        {children}
        <footer>{metadata}</footer>
      </article>
    ),
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
  };
});

const markdownAdapters = {
  openExternal: vi.fn(async () => undefined),
  writeClipboard: vi.fn(async () => undefined)
};

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
    vi.clearAllMocks();
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
    >,
    onInspectEvent?: NonNullable<
      Parameters<typeof NativeConversationSurface>[0]["onInspectEvent"]
    >
  ) {
    await act(async () => {
      root.render(
        <NativeConversationSurface
          loadEventsPage={loadEventsPage}
          markdownAdapters={markdownAdapters}
          onInspectEvent={onInspectEvent}
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

  it("renders rich Markdown and copies fenced code through the Desktop adapter", async () => {
    const source = `# Captured decision

- Parent
  1. Nested
- [x] Verified

> Evidence remains attached.

| Surface | State |
| --- | --- |
| Desktop | Ready |

[Safe](https://koed.example/docs) [Unsafe](javascript:alert(1))

\`\`\`ts
const ready = true;
\`\`\``;
    const loadEventsPage = vi.fn().mockResolvedValue([event("rich", source)]);

    await renderSurface(loadEventsPage);
    await vi.waitFor(() =>
      expect(container.querySelector(".memory-markdown h1")).not.toBeNull()
    );

    expect(container.querySelector(".memory-markdown table")).not.toBeNull();
    expect(
      container.querySelector(".memory-markdown blockquote")
    ).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Open external link: Safe"]')
    ).not.toBeNull();
    expect(container.querySelector('button[aria-label*="Unsafe"]')).toBeNull();

    const copy = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]'
    );
    copy?.focus();
    expect(document.activeElement).toBe(copy);
    await act(async () => copy?.click());
    await vi.waitFor(() =>
      expect(markdownAdapters.writeClipboard).toHaveBeenCalledWith(
        "const ready = true;"
      )
    );
    expect(copy?.textContent).toBe("Copied");
  });

  it("renders Codex Auto Approval decisions as semantic status and rationale", async () => {
    const raw = JSON.stringify({
      risk_level: "medium",
      user_authorization: "high",
      outcome: "allow",
      rationale: "The requested command is bounded and local."
    });
    const approvalEvent: DesktopConversationEvent = {
      ...event("auto-approval", raw),
      actor: "agent",
      approvalDecisionDisplay: {
        kind: "auto_approval",
        version: 1,
        riskLevel: "medium",
        userAuthorization: "high",
        outcome: "allow",
        rationale: "The requested command is bounded and local."
      }
    };

    await renderSurface(vi.fn().mockResolvedValue([approvalEvent]), vi.fn());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Auto approval")
    );

    expect(
      container.querySelector(".native-approval-decision.allow")
    ).not.toBeNull();
    expect(container.querySelector(".native-approval-outcome")).toBeNull();
    expect(container.querySelector('[aria-label="Allowed"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Codex guardian decision");
    expect(container.textContent).toContain("Risk · Medium");
    expect(container.textContent).toContain("Authorization · High");
    const heading = container.querySelector(".native-approval-title");
    expect(heading?.querySelectorAll(".native-approval-signal")).toHaveLength(
      2
    );
    expect(container.textContent).toContain(
      "The requested command is bounded and local."
    );
    expect(container.textContent).not.toContain('"risk_level"');
    expect(
      container.querySelector(
        'button[aria-label="Inspect Auto approval event"]'
      )
    ).not.toBeNull();
  });

  it("renders approval-review transcript segments through the normal message and tool presentation", async () => {
    const source =
      "The following is the Codex agent history whose request action you are assessing. TRANSCRIPT START ... TRANSCRIPT END";
    const approvalEvent: DesktopConversationEvent = {
      ...event("approval-review", source),
      actor: "user",
      transcriptDisplay: {
        kind: "approval_review",
        version: 1,
        truncated: false,
        segments: [
          {
            kind: "message",
            sequence: 1,
            actor: "user",
            content: "## Requested change\n\n- Keep the formatting"
          },
          {
            kind: "message",
            sequence: 2,
            actor: "agent",
            content: "I will inspect the renderer."
          },
          {
            kind: "tool_call",
            sequence: 3,
            toolName: "exec",
            content: "pnpm test"
          },
          {
            kind: "tool_result",
            sequence: 4,
            toolName: "exec",
            content: "Tests passed"
          }
        ]
      }
    };

    await renderSurface(vi.fn().mockResolvedValue([approvalEvent]));
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Requested change")
    );

    expect(container.querySelector(".native-event-content h2")).not.toBeNull();
    expect(
      container.querySelector(".native-tool-group")?.textContent
    ).toContain("2 activity items");
    expect(container.textContent).not.toContain("Approval review transcript");
    expect(container.textContent).not.toContain(source);
  });

  it("supports focus and interaction with a labelled tool activity disclosure", async () => {
    const tool = (id: string, toolName: string): DesktopConversationEvent => ({
      ...event(id, `Raw output from ${toolName}`),
      actor: "tool",
      metadata: { toolName },
      toolDisplay: {
        kind: toolName === "exec" ? "command" : "file_change",
        label: toolName === "exec" ? "Ran command" : "Changed files",
        preview: `Preview from ${toolName}`,
        toolName
      }
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
    expect(group?.textContent).toContain("1 command · 1 file change");
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
          markdownAdapters={markdownAdapters}
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
